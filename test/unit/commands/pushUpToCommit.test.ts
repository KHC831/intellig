/**
 * `intellig.pushUpToCommit` must push the clicked commit onto the branch that
 * CONTAINS it — mirroring GitPushUpToCommitAction: the current branch when the
 * commit is on HEAD, else the first containing local branch — never blindly
 * onto the current branch's remote ref (which would move that ref to a
 * foreign-branch commit).
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { okAsync } from 'neverthrow';
import { registerCommitRepoCoreCommands } from '../../../src/commands/registration/commitRepoCoreCommands';
import type { ICommandContext } from '../../../src/commands/registration/CommandContext';
import type {
  IBranch,
  IGitService,
  IPushOptions,
  IRepository,
} from '../../../src/git-core/interfaces/IGitService';
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

function makeContext(gitService: IGitService): ICommandContext {
  return {
    context: { subscriptions: [] },
    services: { gitService, conflictResolutionService: undefined },
    gitToolWindowProvider: { refresh: (): void => {} },
    commitContextMenuCommands: undefined,
  } as unknown as ICommandContext;
}

interface PushLog {
  repo: IRepository;
  options?: IPushOptions;
}

function setup(
  repo: IRepository,
  containing: string[],
  branches: IBranch[]
): { runPush: (...args: unknown[]) => Promise<unknown>; pushes: PushLog[]; errors: string[] } {
  const pushes: PushLog[] = [];
  const errors: string[] = [];
  const gitService = createMockGitService(repo, {
    getRepository: async () => repo,
    getContainingBranches: async () => containing,
    getBranches: async () => branches,
    push: (r: IRepository, options?: IPushOptions) => {
      pushes.push({ repo: r, options });
      return okAsync(undefined);
    },
  });
  writableWindow().showInformationMessage = () => Promise.resolve(undefined);
  writableWindow().showErrorMessage = (message: string) => {
    errors.push(message);
    return Promise.resolve(undefined);
  };
  (
    vscode.window as unknown as { withProgress: (opts: unknown, task: () => unknown) => unknown }
  ).withProgress = (_opts, task) => task();

  const patch = patchRegisterCommand();
  let handler: CapturedHandler | undefined;
  try {
    registerCommitRepoCoreCommands(makeContext(gitService));
    handler = patch.handlers.find((h) => h.id === 'intellig.pushUpToCommit');
  } finally {
    patch.restore();
  }
  assert.ok(handler, 'intellig.pushUpToCommit should be registered');
  return { runPush: (...args) => Promise.resolve(handler.cb(...args)), pushes, errors };
}

describe('pushUpToCommit resolves the branch containing the commit', () => {
  afterEach(() => {
    restoreMessageFunctions();
  });

  it('pushes onto the containing branch, not the current branch, when the commit is elsewhere', async () => {
    // HEAD = main; the clicked commit sits on feature (tracked). Pushing it
    // as refs/heads/main would move origin/main to a foreign-branch commit.
    const repo = makeRepo({ name: 'main', upstream: { remote: 'origin', name: 'main' } });
    const { runPush, pushes } = setup(
      repo,
      ['feature', 'origin/feature'],
      [
        localBranch('main', { remote: 'origin', name: 'main' }),
        localBranch('feature', { remote: 'origin', name: 'feature' }),
      ]
    );
    await runPush(HASH, ROOT);

    assert.strictEqual(pushes.length, 1, 'push runs once');
    assert.strictEqual(pushes[0].options?.refspec, `${HASH}:refs/heads/feature`);
    assert.strictEqual(pushes[0].options?.remote, 'origin');
  });

  it('pushes onto the current branch when the commit is on HEAD', async () => {
    const repo = makeRepo({ name: 'main', upstream: { remote: 'origin', name: 'main' } });
    const { runPush, pushes } = setup(
      repo,
      ['feature', 'main', 'origin/main'],
      [
        localBranch('main', { remote: 'origin', name: 'main' }),
        localBranch('feature', { remote: 'origin', name: 'feature' }),
      ]
    );
    await runPush(HASH, ROOT);

    assert.strictEqual(pushes.length, 1);
    assert.strictEqual(pushes[0].options?.refspec, `${HASH}:refs/heads/main`);
    assert.strictEqual(pushes[0].options?.remote, 'origin');
  });

  it('detached HEAD still pushes when a local branch contains the commit', async () => {
    const repo = makeRepo({ name: undefined });
    const { runPush, pushes, errors } = setup(
      repo,
      ['feature'],
      [localBranch('feature', { remote: 'origin', name: 'feature' })]
    );
    await runPush(HASH, ROOT);

    assert.deepStrictEqual(errors, [], 'no detached-HEAD hard error');
    assert.strictEqual(pushes.length, 1);
    assert.strictEqual(pushes[0].options?.refspec, `${HASH}:refs/heads/feature`);
  });

  it('errors without pushing when no local branch contains the commit', async () => {
    const repo = makeRepo({ name: 'main', upstream: { remote: 'origin', name: 'main' } });
    const { runPush, pushes, errors } = setup(
      repo,
      ['origin/gone'],
      [localBranch('main', { remote: 'origin', name: 'main' })]
    );
    await runPush(HASH, ROOT);

    assert.strictEqual(pushes.length, 0, 'nothing is pushed');
    assert.strictEqual(errors.length, 1);
    assert.ok(/not on any local branch/i.test(errors[0]), errors[0]);
  });

  it('pushes to the containing branch tracked target name when it differs from the local name', async () => {
    const repo = makeRepo({ name: 'main', upstream: { remote: 'origin', name: 'main' } });
    const { runPush, pushes } = setup(
      repo,
      ['feature'],
      [
        localBranch('main', { remote: 'origin', name: 'main' }),
        localBranch('feature', { remote: 'fork', name: 'renamed-feature' }),
      ]
    );
    await runPush(HASH, ROOT);

    assert.strictEqual(pushes.length, 1);
    assert.strictEqual(pushes[0].options?.remote, 'fork');
    assert.strictEqual(pushes[0].options?.refspec, `${HASH}:refs/heads/renamed-feature`);
  });
});
