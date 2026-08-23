/**
 * Unit specs for the explorer "Commit File…" parity action
 * (`intellig.explorer.commitFile`).
 *
 * Two surfaces:
 *
 *   1. **package.json contract** — the command is declared (IntelliG category,
 *      Unicode-ellipsis title) and sits at the very top of the explorer Git
 *      submenu, matching git4idea's `Git.FileActions` (CheckinFiles leads).
 *   2. **Command handler** — invoking it opens the CommitDialog scoped to the
 *      resolved selection (no pre-staging, no whole-index SCM accept); the
 *      no-file / no-repo paths surface a toast and never open the dialog.
 *      Driven through the captured `registerCommand` callback with a mock
 *      gitService. */

import '../../setup';
import * as assert from 'assert';
import { okAsync } from 'neverthrow';
import * as fs from 'fs';
import * as path from 'path';

import { registerExplorerCommands } from '../../../src/commands/registration/explorerCommands';
import type { ICommandContext } from '../../../src/commands/registration/CommandContext';
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
      'intellig.shelve',
      'intellig.conflict.unresolve',
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

describe('intellig.explorer.showDiff — conflicted files', () => {
  let patch: ReturnType<typeof patchRegisterCommand>;
  let executed: Array<{ command: string; args: unknown[] }>;
  const originalExecute = writableCommands().executeCommand;

  beforeEach(() => {
    executed = [];
    writableCommands().executeCommand = (command: string, ...args: unknown[]): Promise<unknown> => {
      executed.push({ command, args });
      return Promise.resolve(undefined);
    };
    installErrorMessageTracker();
    installInfoMessageTracker();
  });

  afterEach(() => {
    if (patch) {
      patch.restore();
    }
    writableCommands().executeCommand = originalExecute;
    restoreMessageFunctions();
  });

  function showDiffHandler(gitService: IGitService): (...args: unknown[]) => unknown {
    patch = patchRegisterCommand();
    registerExplorerCommands(makeContext(gitService));
    const found = patch.handlers.find((h) => h.id === 'intellig.explorer.showDiff');
    assert.ok(found, 'intellig.explorer.showDiff should be registered');
    return found.cb;
  }

  // An unmerged file's working tree holds the raw conflict markers, so the
  // HEAD-vs-working-tree diff renders them as ordinary added lines. IntelliJ
  // decides this inside the single request producer every Show Diff funnels
  // through (ChangeDiffRequestProducer.createRequest -> createMergeRequest),
  // so the explorer entry point must reach the same surface as the Commit
  // window's row.
  it('opens the merge view instead of a two-sided diff', async () => {
    const repo = repoAt('/repo');
    const git = createMockGitService(repo, {
      getRepositories: () => [repo],
      getStatus: async () => [{ path: 'src/foo.ts', indexStatus: 'U', workTreeStatus: 'U' }],
    });
    await showDiffHandler(git)(Uri.file('/repo/src/foo.ts'));

    const ids = executed.map((e) => e.command);
    assert.ok(
      ids.includes('intellig.merge.openMergeView'),
      `expected the merge view to open; got: ${ids.join(', ') || '(none)'}`
    );
    assert.ok(
      !ids.includes('vscode.diff'),
      'a conflicted file must not open the HEAD-vs-working-tree diff'
    );
  });

  it('still opens a two-sided diff for a modified file', async () => {
    const repo = repoAt('/repo');
    const git = createMockGitService(repo, {
      getRepositories: () => [repo],
      getStatus: async () => [{ path: 'src/foo.ts', indexStatus: ' ', workTreeStatus: 'M' }],
    });
    await showDiffHandler(git)(Uri.file('/repo/src/foo.ts'));

    const ids = executed.map((e) => e.command);
    assert.ok(ids.includes('vscode.diff'), `expected a diff; got: ${ids.join(', ') || '(none)'}`);
    assert.ok(!ids.includes('intellig.merge.openMergeView'), 'no merge view for a modified file');
  });

  // A status read that fails must not strand the user with nothing; the
  // two-sided diff is the safe degrade.
  it('falls back to the diff when the status read fails', async () => {
    const repo = repoAt('/repo');
    const git = createMockGitService(repo, {
      getRepositories: () => [repo],
      getStatus: async () => {
        throw new Error('git exploded');
      },
    });
    await showDiffHandler(git)(Uri.file('/repo/src/foo.ts'));
    assert.ok(
      executed.map((e) => e.command).includes('vscode.diff'),
      'a failed status read degrades to the plain diff'
    );
  });
});

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

  it('opens the CommitDialog scoped to the clicked file (no pre-staging, no SCM reveal)', async () => {
    // Reference: "Commit File…" opens the commit dialog with exactly that
    // change preselected (CommitChangeListDialog scoped invocation) — it
    // must NOT stage up front and reveal the whole-index SCM accept, which
    // can commit other already-staged files.
    const repo = repoAt('/repo');
    let stageCalled = false;
    const git = createMockGitService(repo, {
      getRepositories: () => [repo],
      stage: () => {
        stageCalled = true;
        return okAsync(undefined);
      },
    });

    const ctx = makeContext(git);
    const shown: Array<{ repo: IRepository; options?: { preSelectedFiles?: string[] } }> = [];
    (ctx as { commitDialog?: unknown }).commitDialog = {
      show: async (r: IRepository, options?: { preSelectedFiles?: string[] }): Promise<unknown> => {
        shown.push({ repo: r, options });
        return { committed: false };
      },
    };

    patch = patchRegisterCommand();
    registerExplorerCommands(ctx);
    const found = patch.handlers.find((h) => h.id === 'intellig.explorer.commitFile');
    assert.ok(found, 'intellig.explorer.commitFile should be registered');
    await found.cb(Uri.file('/repo/src/foo.ts'));

    assert.strictEqual(shown.length, 1, 'the CommitDialog opens');
    assert.deepStrictEqual(
      shown[0].options?.preSelectedFiles,
      ['src/foo.ts'],
      'the clicked file is preselected (repo-relative)'
    );
    assert.strictEqual(stageCalled, false, 'must not stage before the dialog');
    assert.ok(
      !executed.includes('workbench.view.scm'),
      'must not reveal the whole-index SCM accept'
    );
  });

  it('shows a "no file" toast and does NOT open the dialog when no file is resolvable', async () => {
    const repo = repoAt('/repo');
    const git = createMockGitService(repo, {
      getRepositories: () => [repo],
    });

    const handler = commitFileHandler(git);
    await handler(undefined); // no fileUri, no active editor in the mock

    assert.ok(
      errorTracker.calls.some((c) => /no file/i.test(c.message)),
      `expected a no-file error toast, got: ${JSON.stringify(errorTracker.calls)}`
    );
    assert.ok(!executed.includes('workbench.view.scm'), 'must not reveal SCM without a file');
  });

  it('does nothing when no repository is found', async () => {
    const repo = repoAt('/repo');
    const git = createMockGitService(repo, {
      getRepositories: () => [],
    });

    const ctx = makeContext(git);
    let dialogShown = false;
    (ctx as { commitDialog?: unknown }).commitDialog = {
      show: async (): Promise<unknown> => {
        dialogShown = true;
        return { committed: false };
      },
    };
    patch = patchRegisterCommand();
    registerExplorerCommands(ctx);
    const found = patch.handlers.find((h) => h.id === 'intellig.explorer.commitFile');
    await found!.cb(Uri.file('/repo/src/foo.ts'));

    assert.strictEqual(dialogShown, false, 'must not open the dialog when there is no repo');
  });
});
