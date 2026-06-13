/**
 * Unit tests for AutoFetchService.
 *
 * Covers: scheduling, disabled config, backoff, auth-failure pause,
 * workspace-folder reactions, and clean disposal.
 */

import '../../setup';
import * as assert from 'assert';
import { IGitService, IRepository, IFetchResult } from '../../../git-core/interfaces/IGitService';
import { AutoFetchService } from '../../../sync/AutoFetchService';
import { EventEmitter, Uri } from '../../mocks/vscode';

/** Create a minimal mock git service whose fetch tracks invocations. */
function createMockGitService(
  fetchImpl: (repo: IRepository) => Promise<IFetchResult>,
  initialRepos: IRepository[] = []
): IGitService & {
  fetchCalls: IRepository[];
  setRepos: (repos: IRepository[]) => void;
} {
  const changeEmitter = new EventEmitter<IRepository>();
  const fetchEmitter = new EventEmitter<{ repo: IRepository; result: IFetchResult }>();
  const fetchCalls: IRepository[] = [];
  let repos = initialRepos;

  return {
    fetchCalls,
    setRepos: (next: IRepository[]) => {
      repos = next;
    },
    onDidChangeRepository: changeEmitter.event,
    onDidFetch: fetchEmitter.event,
    getRepositories: () => repos,
    getRepository: () => Promise.resolve(undefined),
    getBranches: () => Promise.resolve([]),
    getTags: () => Promise.resolve([]),
    commit: () => Promise.resolve(),
    amend: () => Promise.resolve(),
    createBranch: () => Promise.resolve(),
    checkout: () => Promise.resolve(),
    deleteBranch: () => Promise.resolve(),
    renameBranch: () => Promise.resolve(),
    mergeBranch: () => Promise.resolve({ success: true }),
    rebaseBranch: () => Promise.resolve({ success: true }),
    compareBranches: () =>
      Promise.resolve({
        commitsAhead: [],
        commitsBehind: [],
        aheadCount: 0,
        behindCount: 0,
        changedFiles: [],
      }),
    fetch: async (repo: IRepository) => {
      fetchCalls.push(repo);
      return fetchImpl(repo);
    },
    pull: () => Promise.resolve(),
    push: () => Promise.resolve(),
    getRemotes: () => Promise.resolve([]),
    addRemote: () => Promise.resolve(),
    removeRemote: () => Promise.resolve(),
    stash: () => Promise.resolve(),
    stashList: () => Promise.resolve([]),
    stashApply: () => Promise.resolve(),
    stashPop: () => Promise.resolve(),
    stashDrop: () => Promise.resolve(),
    stashShow: () => Promise.resolve([]),
    createTag: () => Promise.resolve(),
    deleteTag: () => Promise.resolve(),
    pushTag: () => Promise.resolve(),
    getLog: () => Promise.resolve([]),
    getCommit: () =>
      Promise.resolve({
        hash: '',
        shortHash: '',
        message: '',
        author: { name: '', email: '' },
        committer: { name: '', email: '' },
        parents: [],
        authorDate: new Date(),
        commitDate: new Date(),
      }),
    getFileHistory: () => Promise.resolve([]),
    getDiff: () =>
      Promise.resolve({ path: '', status: 'modified' as const, hunks: [], binary: false }),
    getCommitDiff: () => Promise.resolve([]),
    getMultiCommitDiff: () => Promise.resolve([]),
    getBlame: () => Promise.resolve([]),
    cherryPick: () => Promise.resolve({ success: true }),
    cherryPickAbort: () => Promise.resolve(),
    cherryPickContinue: () => Promise.resolve({ success: true }),
    revert: () => Promise.resolve({ success: true }),
    revertAbort: () => Promise.resolve(),
    revertContinue: () => Promise.resolve({ success: true }),
    getStatus: () => Promise.resolve([]),
    stage: () => Promise.resolve(),
    unstage: () => Promise.resolve(),
    stageHunk: () => Promise.resolve(),
    stageLines: () => Promise.resolve(),
    unstageHunk: () => Promise.resolve(),
    revertFile: () => Promise.resolve(),
    resetToCommit: () => Promise.resolve(),
    dispose: () => {},
  } as unknown as IGitService & {
    fetchCalls: IRepository[];
    setRepos: (repos: IRepository[]) => void;
  };
}

function makeRepo(path: string = '/r1'): IRepository {
  return {
    rootUri: Uri.file(path),
    state: 'idle',
    head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
}

const EMPTY_RESULT: IFetchResult = {
  updatedRefs: [],
  ahead: 0,
  behind: 0,
  errors: [],
};

function flush(ms: number = 0): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Private-member accessor typed shape for tests. */
type AutoFetchPrivate = {
  _timer: NodeJS.Timeout | undefined;
  _backoffMultiplier: number;
  _tick: () => Promise<void>;
  _getIntervalMs: () => number;
};

function priv(svc: AutoFetchService): AutoFetchPrivate {
  return svc as unknown as AutoFetchPrivate;
}

describe('AutoFetchService', () => {
  describe('scheduling', () => {
    it('arms a timer when enabled and repositories exist', () => {
      const gs = createMockGitService(() => Promise.resolve(EMPTY_RESULT), [makeRepo()]);
      const svc = new AutoFetchService(gs, {
        readEnabled: () => true,
        readIntervalSec: () => 60,
        skipWorkspaceListeners: true,
      });
      svc.start();
      assert.strictEqual(svc.isRunning, true, 'Should be running after start()');
      svc.dispose();
    });

    it('does not arm a timer when disabled', () => {
      const gs = createMockGitService(() => Promise.resolve(EMPTY_RESULT), [makeRepo()]);
      const svc = new AutoFetchService(gs, {
        readEnabled: () => false,
        readIntervalSec: () => 60,
        skipWorkspaceListeners: true,
      });
      svc.start();
      assert.strictEqual(svc.isRunning, false, 'Timer must not be set when disabled');
      svc.dispose();
    });

    it('does not arm a timer when no repositories are open', () => {
      const gs = createMockGitService(() => Promise.resolve(EMPTY_RESULT), []);
      const svc = new AutoFetchService(gs, {
        readEnabled: () => true,
        readIntervalSec: () => 60,
        skipWorkspaceListeners: true,
      });
      svc.start();
      assert.strictEqual(svc.isRunning, false);
      svc.dispose();
    });

    it('reschedules after a workspace folder becomes available', () => {
      const gs = createMockGitService(() => Promise.resolve(EMPTY_RESULT), []);
      const svc = new AutoFetchService(gs, {
        readEnabled: () => true,
        readIntervalSec: () => 60,
        skipWorkspaceListeners: true,
      });
      svc.start();
      assert.strictEqual(svc.isRunning, false);
      gs.setRepos([makeRepo()]);
      svc.reschedule();
      assert.strictEqual(svc.isRunning, true);
      svc.dispose();
    });
  });

  describe('tick behavior', () => {
    it('invokes fetch on every open repository', async () => {
      const gs = createMockGitService(
        () => Promise.resolve(EMPTY_RESULT),
        [makeRepo('/r1'), makeRepo('/r2')]
      );
      const svc = new AutoFetchService(gs, {
        readEnabled: () => true,
        readIntervalSec: () => 60,
        skipWorkspaceListeners: true,
      });
      await priv(svc)._tick();
      assert.strictEqual(gs.fetchCalls.length, 2);
      svc.dispose();
    });

    it('doubles backoff on transient failure and resets on success', async () => {
      let failNext = true;
      const gs = createMockGitService(
        (_r) => {
          if (failNext) {
            failNext = false;
            return Promise.reject(new Error('temporary network blip'));
          }
          return Promise.resolve(EMPTY_RESULT);
        },
        [makeRepo()]
      );
      const svc = new AutoFetchService(gs, {
        readEnabled: () => true,
        readIntervalSec: () => 60,
        skipWorkspaceListeners: true,
      });
      assert.strictEqual(priv(svc)._backoffMultiplier, 1);
      await priv(svc)._tick();
      assert.strictEqual(priv(svc)._backoffMultiplier, 2, 'Backoff doubles after failure');
      await priv(svc)._tick();
      assert.strictEqual(priv(svc)._backoffMultiplier, 1, 'Backoff resets after success');
      svc.dispose();
    });

    it('caps backoff at the maximum multiplier', async () => {
      const gs = createMockGitService(() => Promise.reject(new Error('still down')), [makeRepo()]);
      const svc = new AutoFetchService(gs, {
        readEnabled: () => true,
        readIntervalSec: () => 60,
        skipWorkspaceListeners: true,
      });
      for (let i = 0; i < 10; i++) {
        await priv(svc)._tick();
      }
      assert.strictEqual(priv(svc)._backoffMultiplier, 16);
      svc.dispose();
    });

    it('pauses the scheduler on auth failure', async () => {
      const gs = createMockGitService(
        () => Promise.reject(new Error('fatal: Authentication failed for https://example.com')),
        [makeRepo()]
      );
      const svc = new AutoFetchService(gs, {
        readEnabled: () => true,
        readIntervalSec: () => 60,
        skipWorkspaceListeners: true,
      });
      await priv(svc)._tick();
      assert.strictEqual(svc.isPausedForAuth, true);
      assert.strictEqual(svc.isRunning, false);
      svc.dispose();
    });

    it('resetBackoff clears backoff and resumes scheduling', async () => {
      const gs = createMockGitService(
        () => Promise.reject(new Error('Permission denied')),
        [makeRepo()]
      );
      const svc = new AutoFetchService(gs, {
        readEnabled: () => true,
        readIntervalSec: () => 60,
        skipWorkspaceListeners: true,
      });
      await priv(svc)._tick();
      assert.strictEqual(svc.isPausedForAuth, true);

      // After the user re-enables and fetch starts succeeding.
      gs.setRepos([makeRepo()]);
      svc.resetBackoff();
      assert.strictEqual(svc.isPausedForAuth, false);
      assert.strictEqual(priv(svc)._backoffMultiplier, 1);
      svc.dispose();
    });
  });

  describe('interval clamping', () => {
    it('clamps values below 60 seconds to the minimum', () => {
      const gs = createMockGitService(() => Promise.resolve(EMPTY_RESULT), [makeRepo()]);
      const svc = new AutoFetchService(gs, {
        readEnabled: () => true,
        readIntervalSec: () => 5,
        skipWorkspaceListeners: true,
      });
      assert.strictEqual(priv(svc)._getIntervalMs(), 60 * 1000);
      svc.dispose();
    });

    it('honors values above the minimum', () => {
      const gs = createMockGitService(() => Promise.resolve(EMPTY_RESULT), [makeRepo()]);
      const svc = new AutoFetchService(gs, {
        readEnabled: () => true,
        readIntervalSec: () => 180,
        skipWorkspaceListeners: true,
      });
      assert.strictEqual(priv(svc)._getIntervalMs(), 180 * 1000);
      svc.dispose();
    });
  });

  describe('disposal', () => {
    it('stops the scheduler and prevents late callbacks', async () => {
      const gs = createMockGitService(() => Promise.resolve(EMPTY_RESULT), [makeRepo()]);
      const svc = new AutoFetchService(gs, {
        readEnabled: () => true,
        readIntervalSec: () => 60,
        skipWorkspaceListeners: true,
      });
      svc.start();
      svc.dispose();
      assert.strictEqual(svc.isRunning, false);
      await flush(5);
      // Tick should do nothing post-dispose.
      await priv(svc)._tick();
      assert.strictEqual(gs.fetchCalls.length, 0, 'No fetches after dispose');
    });
  });
});
