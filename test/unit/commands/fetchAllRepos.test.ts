/**
 * `intellig.fetch` — GitFetch.java parity: one invocation fetches all remotes
 * of ALL repositories (no repo picker), refuses to stack while a manual fetch
 * is already running, and reports pruned refs.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { okAsync, errAsync, ResultAsync } from 'neverthrow';
import { registerCommitRepoCoreCommands } from '../../../src/commands/registration/commitRepoCoreCommands';
import type { ICommandContext } from '../../../src/commands/registration/CommandContext';
import type { IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';
import { SpawnFailedError } from '../../../src/git-core/errors';
import { Uri } from '../../mocks/vscode';
import { createMockGitService } from '../../mocks/mockGitService';
import { restoreMessageFunctions, writableWindow } from '../../typed/windowStub';

function makeRepo(root: string): IRepository {
  return {
    rootUri: Uri.file(root),
    state: 'idle',
    head: { name: 'main', commit: 'cafe', ahead: 0, behind: 0 },
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

function makeContext(gitService: IGitService): ICommandContext {
  return {
    context: { subscriptions: [] },
    services: { gitService, conflictResolutionService: undefined, hasService: () => false },
    gitToolWindowProvider: { refresh: (): void => {} },
    commitContextMenuCommands: undefined,
  } as unknown as ICommandContext;
}

type FetchImpl = (repo: IRepository, options?: unknown) => ReturnType<IGitService['fetch']>;

interface Harness {
  run: () => Promise<unknown>;
  fetches: Array<{ root: string; options?: unknown }>;
  infos: string[];
  errors: string[];
}

function setup(repos: IRepository[], fetchImpl?: FetchImpl): Harness {
  const fetches: Array<{ root: string; options?: unknown }> = [];
  const infos: string[] = [];
  const errors: string[] = [];
  const gitService = createMockGitService(repos[0] ?? makeRepo('/none'), {
    getRepositories: () => repos,
    fetch: (repo: IRepository, options?: unknown) => {
      fetches.push({ root: repo.rootUri.fsPath, options });
      return fetchImpl ? fetchImpl(repo, options) : okAsync({ updatedRefs: [], errors: [] });
    },
  });
  writableWindow().showInformationMessage = (message: string) => {
    infos.push(message);
    return Promise.resolve(undefined);
  };
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
    handler = patch.handlers.find((h) => h.id === 'intellig.fetch');
  } finally {
    patch.restore();
  }
  assert.ok(handler, 'intellig.fetch should be registered');
  return { run: () => Promise.resolve(handler.cb()), fetches, infos, errors };
}

describe('fetch command fetches all repositories (GitFetch parity)', () => {
  afterEach(() => {
    restoreMessageFunctions();
  });

  it('fetches every repository in the workspace, all remotes, with prune', async () => {
    const h = setup([makeRepo('/work/a'), makeRepo('/work/b'), makeRepo('/work/c')]);
    await h.run();

    assert.deepStrictEqual(
      h.fetches.map((f) => f.root).sort(),
      ['/work/a', '/work/b', '/work/c'],
      'one fetch per repository, no picker'
    );
    for (const f of h.fetches) {
      assert.deepStrictEqual(f.options, { all: true, prune: true });
    }
    assert.strictEqual(h.infos.length, 1);
  });

  it('refuses to stack a second manual fetch while one is running', async () => {
    let release: (() => void) | undefined;
    const gateOpen = new Promise<void>((r) => {
      release = r;
    });
    const h = setup(
      [makeRepo('/work/a')],
      () =>
        ResultAsync.fromSafePromise(
          gateOpen.then(() => ({ updatedRefs: [], errors: [] }))
        ) as ReturnType<IGitService['fetch']>
    );

    const first = h.run();
    const second = h.run();
    release?.();
    await Promise.all([first, second]);

    assert.strictEqual(h.fetches.length, 1, 'the second invocation must not start a fetch');
  });

  it('continues past a failing repository and reports the failure', async () => {
    const h = setup([makeRepo('/work/a'), makeRepo('/work/b')], (repo) =>
      repo.rootUri.fsPath === '/work/a'
        ? errAsync(new SpawnFailedError('fatal: could not read from remote repository'))
        : okAsync({ updatedRefs: [], errors: [] })
    );
    await h.run();

    assert.strictEqual(h.fetches.length, 2, 'the healthy repo is still fetched');
    assert.strictEqual(h.errors.length, 1, 'the failure surfaces');
    assert.ok(h.errors[0].includes('a'), `error names the failing repo: ${h.errors[0]}`);
  });

  it('reports pruned refs in the completion toast', async () => {
    const h = setup([makeRepo('/work/a')], () =>
      okAsync({
        updatedRefs: [
          { ref: 'refs/remotes/origin/gone', oldSha: 'a'.repeat(40), newSha: '0'.repeat(40) },
          { ref: 'refs/remotes/origin/main', oldSha: 'b'.repeat(40), newSha: 'c'.repeat(40) },
        ],
        errors: [],
      })
    );
    await h.run();

    assert.strictEqual(h.infos.length, 1);
    assert.ok(/pruned/i.test(h.infos[0]), `toast mentions pruning: ${h.infos[0]}`);
  });
});
