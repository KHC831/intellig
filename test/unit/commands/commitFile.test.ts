/**
 * Unit specs for the explorer "Commit File…" parity action
 * (`intellig.explorer.commitFile`) and the SCM commit-on-accept wiring that
 * lets the staged file be committed from the native IntelliG SourceControl
 * input.
 *
 * Three surfaces:
 *
 *   1. **package.json contract** — the command is declared (IntelliG category,
 *      Unicode-ellipsis title) and sits at the very top of the explorer Git
 *      submenu, matching git4idea's `Git.FileActions` (CheckinFiles leads).
 *   2. **Command handler** — invoking it stages the resolved file and reveals
 *      the SCM view; the no-file / no-repo paths surface a toast and never
 *      stage. Driven through the captured `registerCommand` callback with a
 *      mock gitService.
 *   3. **SCM accept** — `GitScmProvider.commitFromInput` commits the staged
 *      changes with the SourceControl input message (and no-ops on empty).
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { registerExplorerCommands } from '../../../src/commands/registration/explorerCommands';
import type { ICommandContext } from '../../../src/commands/registration/CommandContext';
import { GitScmProvider, type IScmApi } from '../../../src/scm/GitScmProvider';
import type { IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';
import { createMockGitService } from '../../mocks/mockGitService';
import { Uri } from '../../mocks/vscode';
import {
  installErrorMessageTracker,
  installInfoMessageTracker,
  restoreMessageFunctions,
  writableCommands,
  type MessageTracker,
} from '../../typed/windowStub';

// ─── package.json contract ───────────────────────────────────────────────────

describe('Commit File — package.json contract', () => {
  interface MenuEntry {
    command?: string;
    submenu?: string;
    group?: string;
    when?: string;
  }
  interface CommandEntry {
    command: string;
    title: string;
    category?: string;
  }

  const packageJsonPath = path.resolve(__dirname, '../../../package.json');
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
    contributes: {
      commands: CommandEntry[];
      menus: Record<string, MenuEntry[]>;
    };
  };

  function hasCommand(id: string): CommandEntry | undefined {
    return pkg.contributes.commands.find((c) => c.command === id);
  }

  /** Parse group string "2_add@1" → [2, 1] for stable sort. */
  function groupOrder(group: string | undefined): [number, number] {
    if (!group) {
      return [Infinity, Infinity];
    }
    const m = /^(\d+)_[^@]+@(\d+)$/.exec(group);
    return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : [Infinity, Infinity];
  }

  function submenuCommandsInOrder(): string[] {
    const entries = pkg.contributes.menus['intellig.explorerSubmenu'] ?? [];
    return [...entries]
      .sort((a, b) => {
        const [ag, ao] = groupOrder(a.group);
        const [bg, bo] = groupOrder(b.group);
        return ag !== bg ? ag - bg : ao - bo;
      })
      .map((e) => e.command)
      .filter((c): c is string => Boolean(c));
  }

  it('declares intellig.explorer.commitFile in the IntelliG category', () => {
    const cmd = hasCommand('intellig.explorer.commitFile');
    assert.ok(cmd, 'intellig.explorer.commitFile should be declared in package.json');
    assert.strictEqual(cmd?.category, 'IntelliG');
  });

  it('titles the command "Commit File…" with a Unicode ellipsis', () => {
    const cmd = hasCommand('intellig.explorer.commitFile');
    assert.strictEqual(cmd?.title, 'Commit File…');
    assert.ok(cmd?.title.endsWith('…'), 'title must end with the Unicode ellipsis');
    assert.ok(!cmd?.title.includes('...'), 'title must not use ASCII "..."');
  });

  it('places Commit File as the FIRST item in the explorer submenu (before Add to VCS)', () => {
    const commands = submenuCommandsInOrder();
    const commitIdx = commands.indexOf('intellig.explorer.commitFile');
    const addIdx = commands.indexOf('intellig.explorer.addToVcs');
    assert.strictEqual(
      commitIdx,
      0,
      `Commit File must be first — actual order: ${commands.join(' → ')}`
    );
    assert.ok(
      commitIdx < addIdx,
      `Commit File (pos ${commitIdx}) must precede Add to VCS (pos ${addIdx})`
    );
  });

  it('leaves the established submenu order intact below Commit File', () => {
    const commands = submenuCommandsInOrder();
    const expectedTail = [
      'intellig.explorer.addToVcs',
      'intellig.explorer.stage',
      'intellig.explorer.unstage',
      'intellig.explorer.addToGitignore',
      'intellig.explorer.revert',
      'intellig.toggleBlame',
      'intellig.explorer.compareWithRepoVersion',
      'intellig.explorer.showDiff',
      'intellig.explorer.compareWithBranch',
      'intellig.explorer.showHistory',
      'intellig.explorer.createPatchFromFile',
    ];
    // Drop the patch.apply trailer (gated by `when`) and Commit File head.
    const withoutPatch = commands.filter((c) => c !== 'intellig.patch.apply');
    assert.deepStrictEqual(withoutPatch.slice(1), expectedTail);
  });
});

// ─── Command handler ─────────────────────────────────────────────────────────

interface CapturedHandler {
  id: string;
  cb: (...args: unknown[]) => unknown;
}

/** Patch vscode.commands.registerCommand to capture (id, cb) pairs. */
function patchRegisterCommand(): { handlers: CapturedHandler[]; restore: () => void } {
  const cmds = writableCommands();
  const original = cmds.registerCommand;
  const handlers: CapturedHandler[] = [];
  cmds.registerCommand = (id, cb) => {
    handlers.push({ id, cb });
    return { dispose: (): void => {} };
  };
  return {
    handlers,
    restore: (): void => {
      cmds.registerCommand = original;
    },
  };
}

function repoAt(
  fsPath: string,
  head: { name: string } | undefined = { name: 'main' }
): IRepository {
  return {
    rootUri: Uri.file(fsPath) as unknown as IRepository['rootUri'],
    state: 'idle',
    remotes: [],
    submodules: [],
    head,
  } as unknown as IRepository;
}

function makeContext(gitService: IGitService): ICommandContext {
  return {
    context: { subscriptions: [], extensionUri: Uri.file('/ext') },
    services: { gitService },
    gitToolWindowProvider: { refresh: (): void => {} },
  } as unknown as ICommandContext;
}

describe('intellig.explorer.commitFile — handler', () => {
  let patch: ReturnType<typeof patchRegisterCommand>;
  let errorTracker: MessageTracker;
  let executed: string[];
  const originalExecute = writableCommands().executeCommand;

  beforeEach(() => {
    executed = [];
    writableCommands().executeCommand = (command: string): Promise<unknown> => {
      executed.push(command);
      return Promise.resolve(undefined);
    };
    errorTracker = installErrorMessageTracker();
    installInfoMessageTracker();
  });

  afterEach(() => {
    if (patch) {
      patch.restore();
    }
    writableCommands().executeCommand = originalExecute;
    restoreMessageFunctions();
  });

  /** Register explorer commands and return the commitFile handler. */
  function commitFileHandler(gitService: IGitService): (...args: unknown[]) => unknown {
    patch = patchRegisterCommand();
    registerExplorerCommands(makeContext(gitService));
    const found = patch.handlers.find((h) => h.id === 'intellig.explorer.commitFile');
    assert.ok(found, 'intellig.explorer.commitFile should be registered');
    return found.cb;
  }

  it('stages the resolved file then reveals the SCM view', async () => {
    const repo = repoAt('/repo');
    let staged: string[] | undefined;
    const git = createMockGitService(repo, {
      getRepositories: () => [repo],
      stage: async (_r: IRepository, files: string[]): Promise<void> => {
        staged = files;
      },
    });

    const handler = commitFileHandler(git);
    await handler(Uri.file('/repo/src/foo.ts'));

    assert.ok(staged, 'stage should have been called');
    assert.ok(
      staged?.some((f) => f.endsWith('foo.ts')),
      `expected the selected file to be staged, got: ${JSON.stringify(staged)}`
    );
    assert.ok(
      executed.includes('workbench.view.scm'),
      `expected the SCM view to be revealed, executed: ${JSON.stringify(executed)}`
    );
  });

  it('shows a "no file" toast and does NOT stage when no file is resolvable', async () => {
    let stageCalled = false;
    const repo = repoAt('/repo');
    const git = createMockGitService(repo, {
      getRepositories: () => [repo],
      stage: async (): Promise<void> => {
        stageCalled = true;
      },
    });

    const handler = commitFileHandler(git);
    await handler(undefined); // no fileUri, no active editor in the mock

    assert.strictEqual(stageCalled, false, 'must not stage without a file');
    assert.ok(
      errorTracker.calls.some((c) => /no file/i.test(c.message)),
      `expected a no-file error toast, got: ${JSON.stringify(errorTracker.calls)}`
    );
    assert.ok(!executed.includes('workbench.view.scm'), 'must not reveal SCM without a file');
  });

  it('does NOT stage when no repository is found', async () => {
    let stageCalled = false;
    const repo = repoAt('/repo');
    const git = createMockGitService(repo, {
      getRepositories: () => [],
      stage: async (): Promise<void> => {
        stageCalled = true;
      },
    });

    const handler = commitFileHandler(git);
    await handler(Uri.file('/repo/src/foo.ts'));

    assert.strictEqual(stageCalled, false, 'must not stage when there is no repo');
    assert.ok(!executed.includes('workbench.view.scm'), 'must not reveal SCM without a repo');
  });
});

// ─── SCM commit-on-accept ────────────────────────────────────────────────────

/** Minimal fakes mirroring the SourceControl surface the provider touches. */
class FakeGroup {
  resourceStates: vscode.SourceControlResourceState[] = [];
  hideWhenEmpty = false;
  constructor(
    public readonly id: string,
    public readonly label: string
  ) {}
  dispose(): void {}
}

class FakeSourceControl {
  readonly groups: FakeGroup[] = [];
  readonly inputBox = { value: '', visible: true, placeholder: '' };
  acceptInputCommand?: vscode.Command;
  constructor(
    public readonly id: string,
    public readonly label: string,
    public readonly rootUri?: vscode.Uri
  ) {}
  createResourceGroup(id: string, label: string): vscode.SourceControlResourceGroup {
    const g = new FakeGroup(id, label);
    this.groups.push(g);
    return g as unknown as vscode.SourceControlResourceGroup;
  }
  dispose(): void {}
}

function fakeScmApi(): { api: IScmApi; created: FakeSourceControl[] } {
  const created: FakeSourceControl[] = [];
  const api: IScmApi = {
    createSourceControl: (id, label, rootUri): vscode.SourceControl => {
      const sc = new FakeSourceControl(id, label, rootUri);
      created.push(sc);
      return sc as unknown as vscode.SourceControl;
    },
  };
  return { api, created };
}

describe('GitScmProvider — commit-on-accept', () => {
  beforeEach(() => {
    installInfoMessageTracker();
  });

  afterEach(() => {
    restoreMessageFunctions();
  });

  it('wires an acceptInputCommand on the created SourceControl', async () => {
    const repo = repoAt('/repo');
    const git = createMockGitService(repo, {
      getRepositories: () => [repo],
      getStatus: async () => [],
    });
    const { api, created } = fakeScmApi();

    const provider = new GitScmProvider(git, api);
    await provider.initialize();

    assert.ok(
      created[0].acceptInputCommand,
      'the SourceControl should carry an acceptInputCommand so the input commits on accept'
    );
    provider.dispose();
  });

  it('commits the staged changes with the input message on accept', async () => {
    const repo = repoAt('/repo');
    let committedWith: string | undefined;
    const git = createMockGitService(repo, {
      getRepositories: () => [repo],
      getStatus: async () => [],
      commit: async (_r: IRepository, message: string): Promise<void> => {
        committedWith = message;
      },
    });
    const { api, created } = fakeScmApi();

    const provider = new GitScmProvider(git, api);
    await provider.initialize();

    const sc = created[0];
    sc.inputBox.value = 'Fix the thing';
    await provider.commitFromInput(sc as unknown as vscode.SourceControl);

    assert.strictEqual(committedWith, 'Fix the thing', 'commit should use the input-box message');
    assert.strictEqual(sc.inputBox.value, '', 'the input box should be cleared after a commit');
    provider.dispose();
  });

  it('does not double-commit on a rapid second accept (re-entrancy guard)', async () => {
    const repo = repoAt('/repo');
    let commitCount = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const git = createMockGitService(repo, {
      getRepositories: () => [repo],
      getStatus: async () => [],
      commit: async (): Promise<void> => {
        commitCount += 1;
        await gate; // hold the first commit in flight
      },
    });
    const { api, created } = fakeScmApi();

    const provider = new GitScmProvider(git, api);
    await provider.initialize();
    const sc = created[0];
    sc.inputBox.value = 'Commit once, not twice';

    const first = provider.commitFromInput(sc as unknown as vscode.SourceControl);
    // Rapid second accept while the first is still in flight — must be ignored.
    const second = provider.commitFromInput(sc as unknown as vscode.SourceControl);
    release();
    await Promise.all([first, second]);

    assert.strictEqual(commitCount, 1, 'a rapid second accept must not produce a second commit');
    provider.dispose();
  });

  it('runs before-commit checks and aborts when the user declines', async () => {
    // Detached HEAD (no head.name) makes the before-commit chain surface a
    // warning, so the SCM accept path must present the modal and honor a
    // dismissal — the native Ctrl+Enter commit must not bypass the checks.
    const repo = repoAt('/repo');
    (repo as { head?: unknown }).head = undefined; // detached → before-commit warning
    let commitCalled = false;
    const git = createMockGitService(repo, {
      getRepositories: () => [repo],
      getStatus: async () => [],
      commit: async (): Promise<void> => {
        commitCalled = true;
      },
    });
    const { api, created } = fakeScmApi();
    const win = vscode.window as unknown as {
      showWarningMessage: (...a: unknown[]) => Promise<string | undefined>;
    };
    const originalWarn = win.showWarningMessage;
    win.showWarningMessage = () => Promise.resolve(undefined); // user dismisses

    const provider = new GitScmProvider(git, api);
    await provider.initialize();
    const sc = created[0];
    sc.inputBox.value = 'Commit on detached HEAD';
    await provider.commitFromInput(sc as unknown as vscode.SourceControl);

    assert.strictEqual(commitCalled, false, 'declining the modal must abort the commit');
    win.showWarningMessage = originalWarn;
    provider.dispose();
  });

  it('commits when the user accepts the before-commit warning', async () => {
    const repo = repoAt('/repo');
    (repo as { head?: unknown }).head = undefined; // detached → before-commit warning
    let commitCalled = false;
    const git = createMockGitService(repo, {
      getRepositories: () => [repo],
      getStatus: async () => [],
      commit: async (): Promise<void> => {
        commitCalled = true;
      },
    });
    const { api, created } = fakeScmApi();
    const win = vscode.window as unknown as {
      showWarningMessage: (...a: unknown[]) => Promise<string | undefined>;
    };
    const originalWarn = win.showWarningMessage;
    // A detached-HEAD problem is a warning → the proceed label is 'Commit'.
    win.showWarningMessage = () => Promise.resolve('Commit');

    const provider = new GitScmProvider(git, api);
    await provider.initialize();
    const sc = created[0];
    sc.inputBox.value = 'Commit on detached HEAD';
    await provider.commitFromInput(sc as unknown as vscode.SourceControl);

    assert.strictEqual(commitCalled, true, 'accepting the modal must let the commit proceed');
    win.showWarningMessage = originalWarn;
    provider.dispose();
  });

  it('does NOT commit when the input message is empty/whitespace', async () => {
    const repo = repoAt('/repo');
    let commitCalled = false;
    const git = createMockGitService(repo, {
      getRepositories: () => [repo],
      getStatus: async () => [],
      commit: async (): Promise<void> => {
        commitCalled = true;
      },
    });
    const { api, created } = fakeScmApi();

    const provider = new GitScmProvider(git, api);
    await provider.initialize();

    const sc = created[0];
    sc.inputBox.value = '   ';
    await provider.commitFromInput(sc as unknown as vscode.SourceControl);

    assert.strictEqual(commitCalled, false, 'an empty message must not produce a commit');
    provider.dispose();
  });

  it('surfaces an error toast, preserves the message, and does not follow through when commit fails', async () => {
    const repo = repoAt('/repo');
    // Count getStatus calls. The before-commit checks read status before the
    // commit; the success follow-through (syncRepo) reads it again AFTER. A
    // failed commit must skip that follow-through, so the count must not grow
    // past the value captured at the moment commit() was invoked.
    let getStatusCalls = 0;
    let statusCallsAtCommit = -1;
    const git = createMockGitService(repo, {
      getRepositories: () => [repo],
      getStatus: async () => {
        getStatusCalls += 1;
        return [];
      },
      commit: async (): Promise<void> => {
        statusCallsAtCommit = getStatusCalls;
        throw new Error('fatal: unable to write commit object');
      },
    });
    const { api, created } = fakeScmApi();

    const errorTracker = installErrorMessageTracker();
    const infoTracker = installInfoMessageTracker();

    const provider = new GitScmProvider(git, api);
    await provider.initialize();

    const sc = created[0];
    sc.inputBox.value = 'Message that should survive a failed commit';
    await provider.commitFromInput(sc as unknown as vscode.SourceControl);

    // (a) the failure surfaces as an error toast.
    assert.ok(
      errorTracker.calls.some((c) => /failed to commit/i.test(c.message)),
      `expected a commit-failure error toast, got: ${JSON.stringify(errorTracker.calls)}`
    );
    // (b) the user's message is NOT cleared, so they can retry.
    assert.strictEqual(
      sc.inputBox.value,
      'Message that should survive a failed commit',
      'a failed commit must not clear the input box'
    );
    // (c) no success follow-through: no extra re-sync, no false success toast.
    assert.notStrictEqual(statusCallsAtCommit, -1, 'the commit should have been attempted');
    assert.strictEqual(
      getStatusCalls,
      statusCallsAtCommit,
      'a failed commit must not trigger a success re-sync (no getStatus after commit)'
    );
    assert.strictEqual(
      infoTracker.calls.length,
      0,
      `a failed commit must not show an info/success toast, got: ${JSON.stringify(infoTracker.calls)}`
    );
    provider.dispose();
  });
});
