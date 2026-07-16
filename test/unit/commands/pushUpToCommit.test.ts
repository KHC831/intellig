/**
 * `intellig.pushUpToCommit` must resolve the branch CONTAINING the clicked
 * commit — mirroring GitPushUpToCommitAction: the current branch when the
 * commit is on HEAD, else the first containing local branch, else a detached
 * push source — and open the PUSH DIALOG with that revision source for
 * preview. It never pushes directly: protected-target and force rules apply
 * through the normal dialog path.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { okAsync } from 'neverthrow';
import { registerCommitRepoCoreCommands } from '../../../src/commands/registration/commitRepoCoreCommands';
import type { ICommandContext } from '../../../src/commands/registration/CommandContext';
import type {
  IBranch,
  IBranchComparison,
  IGitService,
  IPushOptions,
  IRepository,
} from '../../../src/git-core/interfaces/IGitService';
import type { IPushPreselect } from '../../../src/sync/PushDialog';
import { Uri } from '../../mocks/vscode';
import { createMockGitService } from '../../mocks/mockGitService';
import { restoreMessageFunctions, writableWindow } from '../../typed/windowStub';

const ROOT = '/work/repo';
const HASH = 'beebeebeebeebeebeebeebeebeebeebeebeebeeb';

function makeRepo(head: {
  name?: string;
  upstream?: { remote: string; name: string };
}): IRepository {
  return {
    rootUri: Uri.file(ROOT),
    state: 'idle',
    head: { name: head.name, commit: 'cafe', ahead: 0, behind: 0, upstream: head.upstream },
    remotes: [{ name: 'origin', fetchUrl: '', pushUrl: '' }],
    submodules: [],
  } as unknown as IRepository;
}

function localBranch(name: string, upstream?: { remote: string; name: string }): IBranch {
  return { name, type: 'local', commit: 'cafe', upstream, isHead: false };
}

function emptyComparison(aheadCount = 0): IBranchComparison {
  return { commitsAhead: [], commitsBehind: [], aheadCount, behindCount: 0, changedFiles: [] };
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

function makeContext(gitService: IGitService, opened: IPushPreselect[]): ICommandContext {
  return {
    context: { subscriptions: [] },
    services: { gitService, conflictResolutionService: undefined },
    gitToolWindowProvider: { refresh: (): void => {} },
    commitContextMenuCommands: undefined,
    openPushDialog: (preselect?: IPushPreselect): undefined => {
      if (preselect) {
        opened.push(preselect);
      }
      return undefined;
    },
  } as unknown as ICommandContext;
}

interface PushLog {
  repo: IRepository;
  options?: IPushOptions;
}

function setup(
  repo: IRepository,
  containing: string[],
  branches: IBranch[],
  overrides: Partial<IGitService> = {}
): {
  runPush: (...args: unknown[]) => Promise<unknown>;
  pushes: PushLog[];
  errors: string[];
  opened: IPushPreselect[];
} {
  const pushes: PushLog[] = [];
  const errors: string[] = [];
  const opened: IPushPreselect[] = [];
  const gitService = createMockGitService(repo, {
    getRepository: async () => repo,
    getContainingBranches: async () => containing,
    getBranches: async () => branches,
    compareBranches: async () => emptyComparison(),
    push: (r: IRepository, options?: IPushOptions) => {
      pushes.push({ repo: r, options });
      return okAsync(undefined);
    },
    ...overrides,
  });
  writableWindow().showInformationMessage = () => Promise.resolve(undefined);
  writableWindow().showErrorMessage = (message: string) => {
    errors.push(message);
    return Promise.resolve(undefined);
  };

  const patch = patchRegisterCommand();
  let handler: CapturedHandler | undefined;
  try {
    registerCommitRepoCoreCommands(makeContext(gitService, opened));
    handler = patch.handlers.find((h) => h.id === 'intellig.pushUpToCommit');
  } finally {
    patch.restore();
  }
  assert.ok(handler, 'intellig.pushUpToCommit should be registered');
  return { runPush: (...args) => Promise.resolve(handler.cb(...args)), pushes, errors, opened };
}

describe('pushUpToCommit opens the push dialog with a revision source', () => {
  afterEach(() => {
    restoreMessageFunctions();
  });

  it('previews via the dialog with the containing branch, not the current branch, when the commit is elsewhere', async () => {
    // HEAD = main; the clicked commit sits on feature (tracked). The dialog
    // row must carry feature + the hash — never main.
    const repo = makeRepo({ name: 'main', upstream: { remote: 'origin', name: 'main' } });
    const { runPush, pushes, opened } = setup(
      repo,
      ['feature', 'origin/feature'],
      [
        localBranch('main', { remote: 'origin', name: 'main' }),
        localBranch('feature', { remote: 'origin', name: 'feature' }),
      ]
    );
    await runPush(HASH, ROOT);

    assert.strictEqual(pushes.length, 0, 'no direct push — the dialog owns the submit');
    assert.strictEqual(opened.length, 1, 'the push dialog opens once');
    assert.strictEqual(opened[0].branch, 'feature');
    assert.deepStrictEqual(opened[0].upstream, { remote: 'origin', name: 'feature' });
    assert.deepStrictEqual(opened[0].pushSource, { hash: HASH, detached: false });
  });

  it('uses the current branch when the commit is on HEAD', async () => {
    const repo = makeRepo({ name: 'main', upstream: { remote: 'origin', name: 'main' } });
    const { runPush, opened } = setup(
      repo,
      ['feature', 'main', 'origin/main'],
      [
        localBranch('main', { remote: 'origin', name: 'main' }),
        localBranch('feature', { remote: 'origin', name: 'feature' }),
      ]
    );
    await runPush(HASH, ROOT);

    assert.strictEqual(opened.length, 1);
    assert.strictEqual(opened[0].branch, 'main');
    assert.deepStrictEqual(opened[0].pushSource, { hash: HASH, detached: false });
  });

  it('detached HEAD still previews when a local branch contains the commit', async () => {
    const repo = makeRepo({ name: undefined });
    const { runPush, opened, errors } = setup(
      repo,
      ['feature'],
      [localBranch('feature', { remote: 'origin', name: 'feature' })]
    );
    await runPush(HASH, ROOT);

    assert.deepStrictEqual(errors, [], 'no detached-HEAD hard error');
    assert.strictEqual(opened.length, 1);
    assert.strictEqual(opened[0].branch, 'feature');
    assert.deepStrictEqual(opened[0].pushSource, { hash: HASH, detached: false });
  });

  it('opens a DETACHED revision source when no local branch contains the commit', async () => {
    // Reference: GitPushSource.createDetached — no error, the dialog previews
    // the raw hash and the user confirms the target.
    const repo = makeRepo({ name: 'main', upstream: { remote: 'origin', name: 'main' } });
    const { runPush, pushes, errors, opened } = setup(
      repo,
      ['origin/gone'],
      [localBranch('main', { remote: 'origin', name: 'main' })]
    );
    await runPush(HASH, ROOT);

    assert.strictEqual(pushes.length, 0);
    assert.deepStrictEqual(errors, [], 'a detached source is not an error');
    assert.strictEqual(opened.length, 1);
    assert.strictEqual(opened[0].branch, undefined, 'no containing branch on the row');
    assert.deepStrictEqual(opened[0].pushSource, { hash: HASH, detached: true });
  });

  it('threads the containing branch tracked target when it differs from the local name', async () => {
    const repo = makeRepo({ name: 'main', upstream: { remote: 'origin', name: 'main' } });
    const { runPush, opened } = setup(
      repo,
      ['feature'],
      [
        localBranch('main', { remote: 'origin', name: 'main' }),
        localBranch('feature', { remote: 'fork', name: 'renamed-feature' }),
      ]
    );
    await runPush(HASH, ROOT);

    assert.strictEqual(opened.length, 1);
    assert.deepStrictEqual(opened[0].upstream, { remote: 'fork', name: 'renamed-feature' });
  });

  it("threads the hash's own ahead-of-target count for the commits badge", async () => {
    const repo = makeRepo({ name: 'main', upstream: { remote: 'origin', name: 'main' } });
    const compared: Array<[string, string]> = [];
    const { runPush, opened } = setup(
      repo,
      ['feature'],
      [localBranch('feature', { remote: 'origin', name: 'feature' })],
      {
        compareBranches: async (_repo, a, b) => {
          compared.push([a, b]);
          return emptyComparison(3);
        },
      }
    );
    await runPush(HASH, ROOT);

    assert.strictEqual(opened.length, 1);
    assert.strictEqual(opened[0].ahead, 3);
    assert.deepStrictEqual(compared, [[HASH, 'origin/feature']], 'hash vs the target ref');
  });

  it('rejects an invalid hash without opening the dialog', async () => {
    const repo = makeRepo({ name: 'main', upstream: { remote: 'origin', name: 'main' } });
    const { runPush, errors, opened } = setup(repo, [], []);
    await runPush('--upload-pack=evil', ROOT);

    assert.strictEqual(opened.length, 0);
    assert.strictEqual(errors.length, 1);
    assert.ok(/invalid commit hash/i.test(errors[0]), errors[0]);
  });
});
