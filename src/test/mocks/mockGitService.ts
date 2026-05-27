/**
 * Wave H — shared `IGitService` mock for tests that need to drive the
 * BranchTreeProvider, snapshot tests, or post-mutation refresh
 * invariants without spinning up a real GitService.
 *
 * Pre-Wave-H this mock was duplicated across:
 *   - `src/test/unit/utils/commitGraphSnapshots.test.ts:801-960` (snap-8b)
 *   - `src/test/unit/services/headChipRefresh.test.ts:57-120` (Wave G)
 *
 * Wave H's `BranchTreeProvider.test.ts` + `snap-10a` would have been
 * the 3rd and 4th sites. Rule-of-three crossed; the extraction
 * consolidates them.
 *
 * Default behavior:
 *   - Returns the supplied `mockRepo` from every read API
 *   - Returns empty arrays from getBranches/getTags
 *   - Resolves successfully (no error) from every mutator
 *   - `reloadRepository` returns the mockRepo (success path)
 *
 * Test files override individual methods via the `overrides` arg.
 */

import type {
  IGitService,
  IRepository,
  IFetchResult,
  ICommit,
} from '../../services/interfaces/IGitService';
import { EventEmitter } from './vscode';
import { noopEvent } from './noopEvent';

/**
 * Wave I H-3 — TestSurface for the dispose-test path. When tests need
 * to verify subscription teardown they need to fire the change event
 * AFTER setup; expose a hook to do that without violating the IGitService
 * encapsulation.
 */
export interface IGitServiceMockTestSurface {
  fireChangeRepository(repo: IRepository): void;
  /** Number of currently-active onDidChangeRepository subscribers. */
  changeRepositorySubscriberCount(): number;
}

export function createMockGitService(
  mockRepo: IRepository,
  overrides: Partial<IGitService> = {}
): IGitService & IGitServiceMockTestSurface {
  const repoChange = new EventEmitter<IRepository>();

  const base: IGitService = {
    onDidChangeRepository: repoChange.event,
    onDidRemoveRepository: noopEvent<IRepository>(),
    getRepositories: () => [mockRepo],
    getRepository: async () => mockRepo,
    reloadRepository: async () => mockRepo,
    getBranches: async () => [],
    getTags: async () => [],
    commit: async () => {},
    amend: async () => {},
    createBranch: async () => {},
    checkout: async () => {},
    deleteBranch: async () => {},
    renameBranch: async () => {},
    setBranchUpstream: async () => {}, // Wave K — WK-3
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
    fetch: async (): Promise<IFetchResult> => ({
      updatedRefs: [],
      ahead: 0,
      behind: 0,
      errors: [],
    }),
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
    getCommit: async () =>
      ({
        hash: '',
        shortHash: '',
        message: '',
        author: { name: '', email: '' },
        committer: { name: '', email: '' },
        parents: [],
        authorDate: new Date(),
        commitDate: new Date(),
      }) as ICommit,
    getFileHistory: async () => [],
    getDiff: async () => ({ path: '', status: 'modified' as const, hunks: [], binary: false }),
    getCommitDiff: async () => [],
    getMultiCommitDiff: async () => [],
    getBlame: async () => [],
    cherryPick: async () => ({ success: true }),
    cherryPickAbort: async () => {},
    cherryPickContinue: async () => ({ success: true }),
    revert: async () => ({ success: true }),
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
  } as IGitService;

  // Wave I H-3 — wrap with TestSurface helpers that expose the
  // EventEmitter without leaking it onto the public IGitService.
  const testSurface: IGitServiceMockTestSurface = {
    fireChangeRepository: (repo) => repoChange.fire(repo),
    changeRepositorySubscriberCount: (): number =>
      (repoChange as unknown as { listeners: unknown[] }).listeners.length,
  };

  return { ...base, ...overrides, ...testSurface };
}

/**
 * Wave H — convenience constructor for the canonical "attached HEAD"
 * repo state. `head.name` set, `head.commit` set.
 */
export function attachedRepo(branchName = 'main', commit = 'a'.repeat(40)): IRepository {
  return {
    rootUri: { fsPath: '/test', scheme: 'file' } as IRepository['rootUri'],
    state: 'idle',
    head: { name: `refs/heads/${branchName}`, commit, ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  };
}

/**
 * Wave H — convenience constructor for the canonical "detached HEAD"
 * repo state. `head.name` undefined (per Wave F: `git symbolic-ref HEAD`
 * exits non-zero in detached state), `head.commit` set.
 */
export function detachedRepo(commit = 'a'.repeat(40)): IRepository {
  return {
    rootUri: { fsPath: '/test', scheme: 'file' } as IRepository['rootUri'],
    state: 'idle',
    head: { commit, ahead: 0, behind: 0 } /* head.name undefined → detached */,
    remotes: [],
    submodules: [],
  };
}

/**
 * Wave H — convenience constructor for the canonical "empty repo"
 * state. `head` undefined entirely (no commits yet).
 */
export function emptyRepo(): IRepository {
  return {
    rootUri: { fsPath: '/test', scheme: 'file' } as IRepository['rootUri'],
    state: 'idle' /* head undefined → empty repo */,
    remotes: [],
    submodules: [],
  };
}

/**
 * Wave H — convenience constructor for the canonical "rebasing" state.
 * `head.name` STILL set (mid-rebase keeps the original branch ref);
 * `state: 'rebasing'`. The detached-row guard must NOT fire here.
 */
export function rebasingRepo(branchName = 'main', commit = 'a'.repeat(40)): IRepository {
  return {
    rootUri: { fsPath: '/test', scheme: 'file' } as IRepository['rootUri'],
    state: 'rebasing',
    head: { name: `refs/heads/${branchName}`, commit, ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  };
}

/**
 * Wave H R1 / SHL-1 — corrupt-repo state. `head` is set (so the empty-repo
 * fallback path in `_getLocalBranches` does NOT trigger), but `head.name`
 * is undefined AND `head.commit` is the empty string. This shape arises
 * when `parseHead` runs against a repo where both `git symbolic-ref HEAD`
 * and `git rev-parse HEAD` return nothing (e.g. a freshly-init'd repo
 * after a partial corruption, or a unit test fixture passing empty git
 * outputs through the parser).
 *
 * Pre-Wave-H-R1, the detached-row guard `head.commit !== undefined` was
 * trivially true and produced a `(HEAD detached at )` row with empty
 * SHA. R1 tightens the guard to require a non-empty `head.commit`;
 * `branchTree-detached-6` pins this state to ensure the row is NOT
 * rendered.
 */
export function corruptRepo(): IRepository {
  return {
    rootUri: { fsPath: '/test', scheme: 'file' } as IRepository['rootUri'],
    state: 'idle',
    head: { commit: '', ahead: 0, behind: 0 } /* head.name undefined, head.commit '' */,
    remotes: [],
    submodules: [],
  };
}
