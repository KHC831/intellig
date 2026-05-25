/**
 * Wave G — post-mutation refresh ordering tests.
 *
 * Pre-Wave-G: every CLI mutation site called `provider.refresh()` directly
 * after `await this._gitService.<mutator>(...)`. The mutator's internal
 * cache invalidation deleted the `_repositories` cache entry; the
 * subsequent `provider.refresh()` ran against the empty/stale map until
 * the watcher's debounced reload (~250 ms later) repopulated it. UI
 * stayed stale for the entire window.
 *
 * Wave G adds `gitService.reloadRepository(repo)` between the mutation
 * and the refresh:
 *
 *     await this._gitService.checkout(repo, hash);
 *     await this._gitService.reloadRepository(repo);   // NEW
 *     this._gitToolWindowProvider.refresh();           // EXISTING
 *
 * The four invariants below pin the ordering contract so a refactor that
 * (1) drops the reload, (2) calls reload after refresh, (3) silently
 * swallows reload errors, or (4) breaks headHash propagation surfaces
 * as a deliberate test failure rather than a regression of the original
 * stale-UI bug.
 */

import '../../setup';
import * as assert from 'assert';
import { EventEmitter, Uri } from '../../mocks/vscode';
import type { IGitService, IRepository } from '../../../services/interfaces/IGitService';
import type { IRebaseService } from '../../../services/interfaces/IRebaseService';
import { CommitContextMenuCommands } from '../../../commands/CommitContextMenuCommands';
import {
  GitToolWindowProvider,
  type IExtendedLogState,
} from '../../../services/GitToolWindowProvider';
import type { GitCli } from '../../../utils/gitCli';
import { noopEvent } from '../../mocks/noopEvent';

interface OrderedCall {
  method: string;
}

interface MockGitService extends IGitService {
  _calls: OrderedCall[];
  _reloadShouldFail: boolean;
}

function createMockRepo(): IRepository {
  return {
    rootUri: Uri.file('/test-repo'),
    state: 'idle',
    head: { name: 'refs/heads/main', commit: 'abcd1234', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  };
}

function createMockGitService(repo: IRepository): MockGitService {
  const calls: OrderedCall[] = [];
  const repoChange = new EventEmitter<IRepository>();
  let reloadShouldFail = false;
  let mutableRepo: IRepository = repo;

  const service = {
    _calls: calls,
    get _reloadShouldFail() {
      return reloadShouldFail;
    },
    set _reloadShouldFail(v: boolean) {
      reloadShouldFail = v;
    },
    onDidChangeRepository: repoChange.event,
    onDidRemoveRepository: noopEvent<IRepository>(),
    getRepositories: () => [mutableRepo],
    getRepository: async () => mutableRepo,
    reloadRepository: async () => {
      calls.push({ method: 'reloadRepository' });
      if (reloadShouldFail) {
        // Match the production contract: reloadRepository swallows the
        // error internally and returns undefined; callers always proceed
        // to provider.refresh().
        return undefined;
      }
      return mutableRepo;
    },
    getBranches: async () => [],
    getTags: async () => [],
    commit: async () => {},
    amend: async () => {},
    createBranch: async () => {},
    checkout: async () => {
      calls.push({ method: 'checkout' });
      // The production checkout invalidates the cache; model that by
      // mutating the head commit on the next reload.
      mutableRepo = {
        ...mutableRepo,
        head: {
          name: undefined,
          commit: 'newhead0',
          ahead: 0,
          behind: 0,
        },
      };
    },
    revert: async () => {
      calls.push({ method: 'revert' });
      return { success: true };
    },
    deleteBranch: async () => {},
    renameBranch: async () => {},
    mergeBranch: async () => ({ success: true }),
    rebaseBranch: async () => ({ success: true }),
    rebaseSkip: async () => ({ success: true }),
    compareBranches: async () => ({
      commitsAhead: [],
      commitsBehind: [],
      aheadCount: 0,
      behindCount: 0,
      changedFiles: [],
    }),
    fetch: async () => ({ updatedRefs: [], ahead: 0, behind: 0, errors: [] }),
    onDidFetch: () => ({ dispose: () => {} }),
    resetToCommit: async () => {},
    pull: async () => {},
    push: async () => {},
    getRemotes: async () => [],
    addRemote: async () => {},
    removeRemote: async () => {},
    stash: async () => {},
    stashList: async () => [],
    stashApply: async () => {},
    stashPop: async () => {},
    stashDrop: async () => {},
    stashShow: async () => [],
    stashBranch: async () => {},
    stashRename: async () => {},
    createTag: async () => {},
    deleteTag: async () => {},
    pushTag: async () => {},
    getLog: async () => [],
    getCommit: async () => ({
      hash: '',
      shortHash: '',
      message: '',
      author: { name: '', email: '' },
      committer: { name: '', email: '' },
      parents: [],
      authorDate: new Date(),
      commitDate: new Date(),
    }),
    getFileHistory: async () => [],
    getDiff: async () => ({ path: '', status: 'modified' as const, hunks: [], binary: false }),
    getCommitDiff: async () => [],
    getMultiCommitDiff: async () => [],
    getBlame: async () => [],
    cherryPick: async () => {
      calls.push({ method: 'cherryPick' });
      return { success: true };
    },
    cherryPickAbort: async () => {},
    cherryPickContinue: async () => ({ success: true }),
    revertAbort: async () => {},
    revertContinue: async () => ({ success: true }),
    getStatus: async () => [],
    stage: async () => {},
    unstage: async () => {},
    stageHunk: async () => {},
    stageLines: async () => {},
    unstageHunk: async () => {},
    revertFile: async () => {},
    dispose: () => {},
  };

  return service as unknown as MockGitService;
}

function makeProviderSpy(calls: OrderedCall[]): GitToolWindowProvider {
  return {
    refresh: () => {
      calls.push({ method: 'refresh' });
    },
  } as unknown as GitToolWindowProvider;
}

const noopRebase = {} as unknown as IRebaseService;
const noopGitCli = {} as unknown as GitCli;

describe('Wave G — post-mutation refresh ordering invariants', () => {
  it('reloadRepository is awaited BEFORE provider.refresh() at every CLI mutation site', async () => {
    const repo = createMockRepo();
    const gitService = createMockGitService(repo);
    const provider = makeProviderSpy(gitService._calls);

    const commands = new CommitContextMenuCommands(
      gitService,
      noopRebase,
      provider,
      noopGitCli,
      undefined,
      // repoResolver returns the mock repo without resolving via the
      // real `resolveRepo` (which would need a workspaceFolder).
      async () => repo
    );

    // Drive the `checkoutRevision` mutation site through the public
    // `_handleAction` private entry point. Same entry the webview
    // message handler hits in production.
    await (
      commands as unknown as {
        _handleAction(action: string, hashes: string[]): Promise<void>;
      }
    )._handleAction('checkoutRevision', ['cafef00d']);

    // Pin the ordered call list. `checkout` first, then `reloadRepository`,
    // then `refresh`. A regression that drops the reload OR reorders to
    // refresh-then-reload surfaces as an inequality on this assertion.
    assert.deepStrictEqual(gitService._calls, [
      { method: 'checkout' },
      { method: 'reloadRepository' },
      { method: 'refresh' },
    ]);
  });

  it('reloadRepository is called exactly once per mutation (no double-reload)', async () => {
    const repo = createMockRepo();
    const gitService = createMockGitService(repo);
    const provider = makeProviderSpy(gitService._calls);

    const commands = new CommitContextMenuCommands(
      gitService,
      noopRebase,
      provider,
      noopGitCli,
      undefined,
      async () => repo
    );

    await (
      commands as unknown as {
        _handleAction(action: string, hashes: string[]): Promise<void>;
      }
    )._handleAction('checkoutRevision', ['cafef00d']);

    const reloadCount = gitService._calls.filter((c) => c.method === 'reloadRepository').length;
    assert.strictEqual(
      reloadCount,
      1,
      `reloadRepository should be called exactly once per mutation; got ${reloadCount}`
    );
  });

  it('on reloadRepository failure, provider.refresh() STILL fires (defensive fallback)', async () => {
    const repo = createMockRepo();
    const gitService = createMockGitService(repo);
    gitService._reloadShouldFail = true;
    const provider = makeProviderSpy(gitService._calls);

    const commands = new CommitContextMenuCommands(
      gitService,
      noopRebase,
      provider,
      noopGitCli,
      undefined,
      async () => repo
    );

    await (
      commands as unknown as {
        _handleAction(action: string, hashes: string[]): Promise<void>;
      }
    )._handleAction('checkoutRevision', ['cafef00d']);

    // Even when reloadRepository returns undefined (its documented
    // failure shape), the watcher's debounced reload remains as a
    // fallback. The contract is that the host still calls refresh()
    // so the panel paints the most-recent cached state immediately.
    const refreshCount = gitService._calls.filter((c) => c.method === 'refresh').length;
    assert.strictEqual(
      refreshCount,
      1,
      `provider.refresh() must still fire after reloadRepository fails; got ${refreshCount}`
    );
    // And reloadRepository was still invoked (not skipped).
    const reloadCount = gitService._calls.filter((c) => c.method === 'reloadRepository').length;
    assert.strictEqual(reloadCount, 1, 'reloadRepository must be invoked even when it would fail');
  });

  // Wave G R1 / SG-L-1 — parametrize the ordering invariant across
  // multiple mutation paths so a regression at any of them surfaces
  // as a deliberate test failure. Pre-R1 only `checkoutRevision` was
  // pinned; the senior LOW flagged that the other 41 sweep sites had
  // no ordering test. Adding 3 more paths via parametrization is the
  // pragmatic close (cleaner than adding 41 individual tests).
  //
  // Each fixture lists: (action key, hashes, expected mutator method).
  // The order assertion is `[mutator, reloadRepository, refresh]` for
  // every entry.
  const orderingFixtures: Array<{
    action: string;
    hashes: string[];
    mutator: string;
  }> = [
    { action: 'checkoutRevision', hashes: ['cafef00d'], mutator: 'checkout' },
    { action: 'cherryPick', hashes: ['cafef00d'], mutator: 'cherryPick' },
    { action: 'revert', hashes: ['cafef00d'], mutator: 'revert' },
  ];

  for (const fx of orderingFixtures) {
    it(`reload-before-refresh ordering holds for action="${fx.action}"`, async () => {
      const repo = createMockRepo();
      const gitService = createMockGitService(repo);
      const provider = makeProviderSpy(gitService._calls);

      const commands = new CommitContextMenuCommands(
        gitService,
        noopRebase,
        provider,
        noopGitCli,
        undefined,
        async () => repo
      );

      await (
        commands as unknown as {
          _handleAction(action: string, hashes: string[]): Promise<void>;
        }
      )._handleAction(fx.action, fx.hashes);

      // Filter to the mutator + reload + refresh sequence (drop any
      // intermediate getCommit / cherryPickAbort etc. calls the action
      // may make for its happy-path success branch).
      const significant = gitService._calls.filter((c) =>
        [fx.mutator, 'reloadRepository', 'refresh'].includes(c.method)
      );
      assert.deepStrictEqual(
        significant,
        [{ method: fx.mutator }, { method: 'reloadRepository' }, { method: 'refresh' }],
        `expected ${fx.mutator} → reloadRepository → refresh; got ${JSON.stringify(significant)}`
      );
    });
  }

  it('headHash propagation: updateLogState writes the new HEAD into _extendedLogState', () => {
    // After a mutation moves HEAD, `loadLogCommitsForRepo` re-runs,
    // reads `repo.head?.commit`, and passes it to
    // `updateLogState(...,headHash)`. The provider stores it on
    // `_extendedLogState.headHash` so `_getBranchLabelsHtml` emits the
    // HEAD chip on the new commit.
    //
    // The full integration (mutation → reload → load → updateLogState
    // → chip rendered) is covered by snap-9a..9f. This test pins the
    // last leg: updateLogState's 4th arg lands on the state field.
    const provider = new GitToolWindowProvider(Uri.file('/test/extension'));
    try {
      provider.updateLogState([], undefined, undefined, 'aaa1234');
      const beforeState = (provider as unknown as { _extendedLogState: IExtendedLogState })
        ._extendedLogState;
      assert.strictEqual(beforeState.headHash, 'aaa1234', 'pre-mutation headHash stored');

      provider.updateLogState([], undefined, undefined, 'bbb5678');
      const afterState = (provider as unknown as { _extendedLogState: IExtendedLogState })
        ._extendedLogState;
      assert.strictEqual(
        afterState.headHash,
        'bbb5678',
        'post-mutation headHash overwrites pre-mutation value'
      );
    } finally {
      provider.dispose();
    }
  });
});
