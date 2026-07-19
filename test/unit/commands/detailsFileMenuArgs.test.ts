/**
 * The details-panel changed-file menu already knows WHICH file was clicked and
 * WHICH repo owns the commit. Show Diff / Open Repository Version must act on
 * that context instead of re-asking: no file QuickPick, and no repo prompt in a
 * multi-root workspace. The pickers remain for palette invocations that carry
 * no file.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { registerCommitMenuCommands } from '../../../src/commands/registration/commitMenuCommands';
import type { ICommandContext } from '../../../src/commands/registration/CommandContext';
import type { IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';
import { createMockGitService } from '../../mocks/mockGitService';
import { restoreMessageFunctions, writableWindow } from '../../typed/windowStub';
import { GitToolWindowProvider } from '../../../src/ui-shell/GitToolWindowProvider';

const ROOT_A = '/work/alpha';
const ROOT_B = '/work/beta';
const HASH = 'abc1234567890abcdef1234567890abcdef12345';
const CLICKED = 'src/app/main.ts';

function makeRepo(root: string): IRepository {
  return {
    rootUri: Uri.file(root),
    state: 'idle',
    head: { name: 'main', commit: 'cafe', ahead: 0, behind: 0, upstream: { remote: 'origin' } },
    remotes: [{ name: 'origin', fetchUrl: '', pushUrl: '' }],
    submodules: [],
  } as unknown as IRepository;
}

interface CapturedHandler {
  id: string;
  cb: (...args: unknown[]) => unknown;
}

function patchRegisterCommand(): { handlers: CapturedHandler[]; restore: () => void } {
  const cmds = vscode.commands as unknown as {
    registerCommand: (id: string, cb: (...a: unknown[]) => unknown) => { dispose: () => void };
  };
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

/** Two open repos; both "contain" the hash, so any re-resolution would prompt. */
function makeGitService(overrides: Partial<IGitService> = {}): IGitService {
  const repoA = makeRepo(ROOT_A);
  const repoB = makeRepo(ROOT_B);
  return createMockGitService(repoA, {
    getRepositories: () => [repoA, repoB],
    getRepository: async (uri: { fsPath: string }) =>
      uri.fsPath === ROOT_B ? repoB : uri.fsPath === ROOT_A ? repoA : undefined,
    getCommit: async () => ({ hash: HASH, parents: ['dad1234'], message: 'm' }),
    getCommitDiff: async () => [
      { path: CLICKED, status: 'modified' },
      { path: 'other/file.ts', status: 'added' },
    ],
    ...overrides,
  } as unknown as Partial<IGitService>);
}

function makeContext(gitService: IGitService): ICommandContext {
  return {
    context: { subscriptions: [] },
    services: { gitService, conflictResolutionService: undefined },
    gitToolWindowProvider: { refresh: (): void => {} },
    commitContextMenuCommands: undefined,
  } as unknown as ICommandContext;
}

/** Run a registered command with `arg`, recording pickers and opened URIs. */
async function runCommand(
  id: string,
  arg: unknown,
  gitService: IGitService
): Promise<{ quickPicks: number; opened: string[]; diffTitles: string[] }> {
  let quickPicks = 0;
  const opened: string[] = [];
  const diffTitles: string[] = [];
  writableWindow().showQuickPick = ((): Promise<undefined> => {
    quickPicks += 1;
    return Promise.resolve(undefined);
  }) as never;
  writableWindow().showErrorMessage = (() => Promise.resolve(undefined)) as never;
  writableWindow().showInformationMessage = (() => Promise.resolve(undefined)) as never;

  const cmds = vscode.commands as unknown as {
    executeCommand: (id: string, ...a: unknown[]) => Thenable<unknown>;
  };
  const originalExecute = cmds.executeCommand;
  cmds.executeCommand = ((cmd: string, ...a: unknown[]): Thenable<unknown> => {
    if (cmd === 'vscode.open') {
      opened.push(String((a[0] as { toString(): string }).toString()));
    }
    if (cmd === 'vscode.diff') {
      diffTitles.push(String(a[2] ?? ''));
      opened.push(String((a[0] as { toString(): string }).toString()));
      opened.push(String((a[1] as { toString(): string }).toString()));
    }
    return Promise.resolve(undefined);
  }) as typeof cmds.executeCommand;

  const patch = patchRegisterCommand();
  try {
    registerCommitMenuCommands(makeContext(gitService));
    const handler = patch.handlers.find((h) => h.id === id);
    assert.ok(handler, `command ${id} should be registered`);
    await handler.cb(arg);
  } finally {
    patch.restore();
    cmds.executeCommand = originalExecute;
  }
  return { quickPicks, opened, diffTitles };
}

describe('details-panel file menu consumes the clicked file and repo', () => {
  afterEach(() => {
    restoreMessageFunctions();
  });

  it('Show Diff opens the clicked file without asking which file', async () => {
    const gitService = makeGitService();

    const result = await runCommand(
      'intellig.commit.showDiff',
      { hash: HASH, path: CLICKED, repoRoot: ROOT_B },
      gitService
    );

    assert.strictEqual(result.quickPicks, 0, 'the clicked file must not be re-asked');
    assert.ok(
      result.opened.some((uri) => uri.includes(CLICKED)),
      `expected a diff of ${CLICKED}, opened: ${JSON.stringify(result.opened)}`
    );
  });

  it('Show Diff still offers the file picker when invoked without a file', async () => {
    const gitService = makeGitService();

    const result = await runCommand('intellig.commit.showDiff', { hash: HASH }, gitService);

    assert.strictEqual(result.quickPicks, 1, 'a palette invocation still picks a file');
  });

  it('Open Repository Version opens the clicked file at the revision directly', async () => {
    const gitService = makeGitService();

    const result = await runCommand(
      'intellig.commit.showFileInRevision',
      { hash: HASH, path: CLICKED, repoRoot: ROOT_B },
      gitService
    );

    assert.strictEqual(result.quickPicks, 0, 'the clicked file must not be re-asked');
    assert.ok(
      result.opened.some((uri) => uri.includes(CLICKED)),
      `expected ${CLICKED} opened at the revision, got: ${JSON.stringify(result.opened)}`
    );
  });

  it('Open Repository Version still offers the picker when invoked without a file', async () => {
    const gitService = makeGitService();

    const result = await runCommand(
      'intellig.commit.showFileInRevision',
      { hash: HASH },
      gitService
    );

    assert.strictEqual(result.quickPicks, 1, 'a palette invocation still picks a file');
  });

  it('resolves the repo from the supplied root instead of scanning every repo', async () => {
    const scanned: string[] = [];
    const gitService = makeGitService({
      getCommit: (async (repo: IRepository) => {
        scanned.push(repo.rootUri.fsPath);
        return { hash: HASH, parents: ['dad1234'], message: 'm' };
      }) as unknown as IGitService['getCommit'],
    });

    await runCommand(
      'intellig.commit.showDiff',
      { hash: HASH, path: CLICKED, repoRoot: ROOT_B },
      gitService
    );

    assert.ok(
      !scanned.includes(ROOT_A),
      'the pinned root must not trigger a probe of the other repository'
    );
  });
});

describe('no-picker fast paths carry the repo root in the revision URI', () => {
  afterEach(() => {
    restoreMessageFunctions();
  });

  // Without repoRoot the content provider guesses a root; a wrong-root
  // `git show` looks like an absent file and renders a blank document.
  it('Open Repository Version pins the repo on the opened URI', async () => {
    const gitService = makeGitService();

    const { opened, quickPicks } = await runCommand(
      'intellig.commit.showFileInRevision',
      { hash: HASH, path: CLICKED, repoRoot: ROOT_B },
      gitService
    );

    assert.strictEqual(quickPicks, 0, 'the clicked row needs no file picker');
    assert.strictEqual(opened.length, 1);
    assert.match(opened[0], /repoRoot=/, `URI lost the repo root: ${opened[0]}`);
    assert.ok(opened[0].includes(encodeURIComponent(ROOT_B)), 'the pinned root is repo B');
  });

  it('Show Diff pins the repo on both sides of the diff', async () => {
    const gitService = makeGitService();

    const { opened, quickPicks } = await runCommand(
      'intellig.commit.showDiff',
      { hash: HASH, path: CLICKED, repoRoot: ROOT_B },
      gitService
    );

    assert.strictEqual(quickPicks, 0, 'the clicked row needs no file picker');
    assert.strictEqual(opened.length, 2, 'left and right revisions');
    for (const uri of opened) {
      assert.match(uri, /repoRoot=/, `diff side lost the repo root: ${uri}`);
    }
  });
});

describe('the details panel relays the owning repository with the file action', () => {
  it('threads the selected repo root so the command need not re-resolve it', () => {
    const provider = new GitToolWindowProvider(Uri.file('/test/extension'));
    provider.setAvailableRepositories([
      { rootUri: Uri.file(ROOT_B), state: 'idle', remotes: [], submodules: [] },
    ] as unknown as Parameters<typeof provider.setAvailableRepositories>[0]);

    const relayed: Array<{ id: string; arg: unknown }> = [];
    const cmds = vscode.commands as unknown as {
      executeCommand: (id: string, ...a: unknown[]) => Thenable<unknown>;
    };
    const original = cmds.executeCommand;
    cmds.executeCommand = ((id: string, arg: unknown): Thenable<unknown> => {
      relayed.push({ id, arg });
      return Promise.resolve(undefined);
    }) as typeof cmds.executeCommand;

    try {
      (provider as unknown as { _handleWebviewMessage(m: unknown): void })._handleWebviewMessage({
        type: 'fileContextAction',
        action: 'showDiff',
        commitHash: HASH,
        path: CLICKED,
      });
    } finally {
      cmds.executeCommand = original;
      provider.dispose();
    }

    assert.deepStrictEqual(relayed[0]?.arg, {
      hash: HASH,
      path: CLICKED,
      repoRoot: Uri.file(ROOT_B).fsPath,
    });
  });
});

describe('the details panel relays the repository that owns the commit', () => {
  /** Drive one file action and return the argument the command received. */
  function relayedArg(
    setup: (provider: GitToolWindowProvider) => void,
    hash: string = HASH
  ): unknown {
    const provider = new GitToolWindowProvider(Uri.file('/test/extension'));
    setup(provider);

    const relayed: Array<{ id: string; arg: unknown }> = [];
    const cmds = vscode.commands as unknown as {
      executeCommand: (id: string, ...a: unknown[]) => Thenable<unknown>;
    };
    const original = cmds.executeCommand;
    cmds.executeCommand = ((id: string, arg: unknown): Thenable<unknown> => {
      relayed.push({ id, arg });
      return Promise.resolve(undefined);
    }) as typeof cmds.executeCommand;

    try {
      (provider as unknown as { _handleWebviewMessage(m: unknown): void })._handleWebviewMessage({
        type: 'fileContextAction',
        action: 'showDiff',
        commitHash: hash,
        path: CLICKED,
      });
    } finally {
      cmds.executeCommand = original;
      provider.dispose();
    }
    return relayed[0]?.arg;
  }

  function mkCommit(
    hash: string,
    repoRoot: string
  ): Parameters<GitToolWindowProvider['updateLogState']>[0][number] {
    return {
      hash,
      shortHash: hash.slice(0, 7),
      message: 'm',
      author: { name: 'a', email: 'a@x' },
      committer: { name: 'a', email: 'a@x' },
      parents: [],
      authorDate: new Date(0),
      commitDate: new Date(0),
      repoRoot,
    } as unknown as Parameters<GitToolWindowProvider['updateLogState']>[0][number];
  }

  it('pins the commit owner, not the arbitrarily-selected repo, in merged scope', () => {
    const arg = relayedArg((provider) => {
      // Merged scope: repo A is "selected", but the clicked commit is B's.
      provider.setAvailableRepositories([
        { rootUri: Uri.file(ROOT_A), state: 'idle', remotes: [], submodules: [] },
        { rootUri: Uri.file(ROOT_B), state: 'idle', remotes: [], submodules: [] },
      ] as unknown as Parameters<typeof provider.setAvailableRepositories>[0]);
      provider.updateLogState([mkCommit(HASH, Uri.file(ROOT_B).fsPath)]);
    });

    assert.deepStrictEqual(arg, {
      hash: HASH,
      path: CLICKED,
      repoRoot: Uri.file(ROOT_B).fsPath,
    });
  });

  it('leaves the pin to the selected repo when the commit owner is unknown', () => {
    const arg = relayedArg((provider) => {
      provider.setAvailableRepositories([
        { rootUri: Uri.file(ROOT_A), state: 'idle', remotes: [], submodules: [] },
      ] as unknown as Parameters<typeof provider.setAvailableRepositories>[0]);
    });

    assert.deepStrictEqual(arg, {
      hash: HASH,
      path: CLICKED,
      repoRoot: Uri.file(ROOT_A).fsPath,
    });
  });
});

/**
 * A hash that exists in more than one open root cannot say which root was
 * meant. Pinning the selected repo there hands the command a root that never
 * held the commit — and because a pin suppresses the command's own probing,
 * the diff resolves against the wrong repo instead of the right one.
 */
describe('an ambiguous commit hash pins no repository', () => {
  function mkCommitIn(
    hash: string,
    repoRoot: string
  ): Parameters<GitToolWindowProvider['updateLogState']>[0][number] {
    return {
      hash,
      shortHash: hash.slice(0, 7),
      message: 'm',
      author: { name: 'a', email: 'a@x' },
      committer: { name: 'a', email: 'a@x' },
      parents: [],
      authorDate: new Date(0),
      commitDate: new Date(0),
      repoRoot,
    } as unknown as Parameters<GitToolWindowProvider['updateLogState']>[0][number];
  }

  it('leaves repoRoot unset when the hash lives in two roots', () => {
    const provider = new GitToolWindowProvider(Uri.file('/test/extension'));
    provider.setAvailableRepositories([
      { rootUri: Uri.file(ROOT_A), state: 'idle', remotes: [], submodules: [] },
      { rootUri: Uri.file(ROOT_B), state: 'idle', remotes: [], submodules: [] },
    ] as unknown as Parameters<typeof provider.setAvailableRepositories>[0]);
    // Two checkouts of the same repo carry identical hashes.
    provider.updateLogState([
      mkCommitIn(HASH, Uri.file(ROOT_B).fsPath),
      mkCommitIn(HASH, Uri.file(ROOT_A).fsPath),
    ]);

    const relayed: Array<{ arg: unknown }> = [];
    const cmds = vscode.commands as unknown as {
      executeCommand: (id: string, ...a: unknown[]) => Thenable<unknown>;
    };
    const original = cmds.executeCommand;
    cmds.executeCommand = ((_id: string, arg: unknown): Thenable<unknown> => {
      relayed.push({ arg });
      return Promise.resolve(undefined);
    }) as typeof cmds.executeCommand;

    try {
      (provider as unknown as { _handleWebviewMessage(m: unknown): void })._handleWebviewMessage({
        type: 'fileContextAction',
        action: 'showDiff',
        commitHash: HASH,
        path: CLICKED,
      });
    } finally {
      cmds.executeCommand = original;
      provider.dispose();
    }

    assert.strictEqual(
      (relayed[0]?.arg as { repoRoot?: string }).repoRoot,
      undefined,
      'an ambiguous hash must dispatch with no pin so the command probes'
    );
  });
});
