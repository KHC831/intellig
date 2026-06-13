/**
 * Unit tests for new command handler error flows.
 *
 * Tests the uncommitted-changes dialog for Checkout, smart-stash parity
 * for Rebase onto (a dirty tree rebases via autostash rather than being
 * walled off), conflict warnings for merge/rebase results, and
 * missing-repository early-return behavior.
 */

/*
 * Stub factories synthesise IGitService implementations whose member
 * signatures return `Promise<T>`. No-await stub bodies are intentional here.
 */

import '../setup';
import * as assert from 'assert';
import { BranchContextMenuCommands } from '../../branches/BranchContextMenuCommands';
import { BranchTreeItem, BranchTreeProvider } from '../../branches/BranchTreeProvider';
import {
  IGitService,
  IRepository,
  IBranch,
  IBasicRebaseResult,
  ICheckoutOptions,
  IFetchResult,
  IPushOptions,
  IInProgressOperation,
  IFileStatus,
} from '../../git-core/interfaces/IGitService';
import { EventEmitter, Uri } from '../mocks/vscode';
import { writableWindow } from '../typed/windowStub';
import { invokePrivateHandler } from '../typed/privateHandler';

// ─── Mock Helpers ─────────────────────────────────────────────────────────────

interface MessageCall {
  message: string;
  items: string[];
}

interface MessageTracker {
  calls: MessageCall[];
  reset(): void;
}

/**
 * Create a base mock IGitService with all methods stubbed.
 */
function createMockGitService(overrides: Partial<IGitService> = {}): IGitService {
  const repoChangeEmitter = new EventEmitter<IRepository>();

  return {
    onDidChangeRepository: repoChangeEmitter.event,
    getRepositories: () => [],
    getRepository: async () => undefined,
    reloadRepository: async (repo) => repo,
    getBranches: async () => [],
    getTags: async () => [],
    commit: async () => {},
    amend: async () => {},
    createBranch: async () => {},
    checkout: async () => {},
    deleteBranch: async () => {},
    renameBranch: async () => {},
    mergeBranch: async () => ({ success: true }),
    rebaseBranch: async () => ({ success: true }),
    rebaseSkip: async () => ({ success: true }),
    rebaseAbort: async () => {},
    rebaseContinue: async () => ({ success: true }),
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
    getDiff: async () => ({
      path: '',
      status: 'modified' as const,
      hunks: [],
      binary: false,
    }),
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
    ...overrides,
  } as IGitService;
}

/**
 * Create a mock BranchTreeProvider with a configurable repository.
 */
function createMockBranchTreeProvider(
  gitService: IGitService,
  currentBranchName: string = 'main'
): BranchTreeProvider {
  const provider = new BranchTreeProvider(gitService);

  const mockRepo: IRepository = {
    rootUri: Uri.file('/test-repo'),
    state: 'idle',
    head: { name: `refs/heads/${currentBranchName}`, ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  };

  provider.getRepository = () => mockRepo;
  return provider;
}

/**
 * Create a mock BranchTreeProvider with no repository (returns undefined).
 */
function createMockBranchTreeProviderNoRepo(gitService: IGitService): BranchTreeProvider {
  const provider = new BranchTreeProvider(gitService);
  provider.getRepository = () => undefined as unknown as IRepository;
  return provider;
}

/**
 * Create a BranchTreeItem for a local branch.
 */
function createLocalBranchTreeItem(
  branchName: string,
  upstream?: { remote: string; name: string }
): BranchTreeItem {
  const branch: IBranch = {
    name: branchName,
    type: 'local',
    commit: 'abc1234',
    isHead: false,
    upstream,
  };
  return new BranchTreeItem(branchName, 0, 'local-branch', branch, undefined, false);
}

/**
 * Create a BranchTreeItem for a remote branch.
 */
function createRemoteBranchTreeItem(fullRef: string): BranchTreeItem {
  const branch: IBranch = {
    name: fullRef,
    type: 'remote',
    commit: 'abc1234',
    isHead: false,
  };
  return new BranchTreeItem(fullRef, 0, 'remote-branch', branch, undefined, false);
}

/**
 * Install a tracking stub on vscode.window.showErrorMessage.
 */
function installErrorMessageTracker(): MessageTracker {
  const tracker: MessageTracker = {
    calls: [],
    reset() {
      this.calls = [];
    },
  };
  writableWindow().showErrorMessage = (
    message: string,
    ...items: string[]
  ): Promise<string | undefined> => {
    tracker.calls.push({ message, items });
    return Promise.resolve(undefined);
  };
  return tracker;
}

/**
 * Install a tracking stub on vscode.window.showWarningMessage.
 * Optionally returns a specific choice.
 */
function installWarningMessageTracker(returnChoice?: string): MessageTracker {
  const tracker: MessageTracker = {
    calls: [],
    reset() {
      this.calls = [];
    },
  };
  writableWindow().showWarningMessage = (
    message: string,
    ...items: unknown[]
  ): Promise<string | undefined> => {
    // Filter out option objects (like { modal: true })
    const stringItems = items.filter((i): i is string => typeof i === 'string');
    tracker.calls.push({ message, items: stringItems });
    return Promise.resolve(returnChoice);
  };
  return tracker;
}

/**
 * Install a tracking stub on vscode.window.showInformationMessage.
 */
function installInfoMessageTracker(): MessageTracker {
  const tracker: MessageTracker = {
    calls: [],
    reset() {
      this.calls = [];
    },
  };
  writableWindow().showInformationMessage = (
    message: string,
    ...items: string[]
  ): Promise<string | undefined> => {
    tracker.calls.push({ message, items });
    return Promise.resolve(undefined);
  };
  return tracker;
}

/**
 * Restore original vscode.window message functions.
 */
function restoreMessageFunctions(): void {
  const w = writableWindow();
  w.showErrorMessage = (): Promise<string | undefined> => Promise.resolve(undefined);
  w.showWarningMessage = (): Promise<string | undefined> => Promise.resolve(undefined);
  w.showInformationMessage = (): Promise<string | undefined> => Promise.resolve(undefined);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Branch Context Menu - Command Handler Error Flows', () => {
  afterEach(() => {
    restoreMessageFunctions();
  });

  // ─── Missing Repository Early Return ───────────────────

  describe('Missing repository early return', () => {
    it('_handleUpdate should return early when repository is undefined', async () => {
      let fetchCalled = false;
      const gitService = createMockGitService({
        fetch: async () => {
          fetchCalled = true;
          return { updatedRefs: [], ahead: 0, behind: 0, errors: [] };
        },
      });
      const branchTreeProvider = createMockBranchTreeProviderNoRepo(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/test', {
        remote: 'origin',
        name: 'feature/test',
      });
      await invokePrivateHandler(commands, '_handleUpdate', item);

      assert.strictEqual(fetchCalled, false, 'fetch should not be called when repo is undefined');
    });

    it('_handlePush should return early when repository is undefined', async () => {
      let pushCalled = false;
      const gitService = createMockGitService({
        push: async () => {
          pushCalled = true;
        },
      });
      const branchTreeProvider = createMockBranchTreeProviderNoRepo(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/test', {
        remote: 'origin',
        name: 'feature/test',
      });
      await invokePrivateHandler(commands, '_handlePush', item);

      assert.strictEqual(pushCalled, false, 'push should not be called when repo is undefined');
    });

    it('_handleCheckoutAndRebase should return early when repository is undefined', async () => {
      let checkoutCalled = false;
      const gitService = createMockGitService({
        checkout: async () => {
          checkoutCalled = true;
        },
      });
      const branchTreeProvider = createMockBranchTreeProviderNoRepo(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/test');
      await invokePrivateHandler(commands, '_handleCheckoutAndRebase', item);

      assert.strictEqual(
        checkoutCalled,
        false,
        'checkout should not be called when repo is undefined'
      );
    });

    it('_handlePullUsingRebase should return early when repository is undefined', async () => {
      let pullCalled = false;
      const gitService = createMockGitService({
        pull: async () => {
          pullCalled = true;
        },
      });
      const branchTreeProvider = createMockBranchTreeProviderNoRepo(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createRemoteBranchTreeItem('origin/main');
      await invokePrivateHandler(commands, '_handlePullUsingRebase', item);

      assert.strictEqual(pullCalled, false, 'pull should not be called when repo is undefined');
    });

    it('_handlePullUsingMerge should return early when repository is undefined', async () => {
      let pullCalled = false;
      const gitService = createMockGitService({
        pull: async () => {
          pullCalled = true;
        },
      });
      const branchTreeProvider = createMockBranchTreeProviderNoRepo(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createRemoteBranchTreeItem('origin/main');
      await invokePrivateHandler(commands, '_handlePullUsingMerge', item);

      assert.strictEqual(pullCalled, false, 'pull should not be called when repo is undefined');
    });
  });

  // ─── Uncommitted Changes Dialog ────────────────────────

  describe('Uncommitted changes dialog for Checkout and Rebase', () => {
    it('should show warning dialog with Stash/Force/Cancel options when checkout fails due to uncommitted changes', async () => {
      const warningTracker = installWarningMessageTracker(undefined); // user cancels

      const gitService = createMockGitService({
        checkout: async () => {
          throw new Error(
            'error: Your local changes to the following files would be overwritten by checkout'
          );
        },
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/test');
      await invokePrivateHandler(commands, '_handleCheckoutAndRebase', item);

      assert.ok(warningTracker.calls.length > 0, 'showWarningMessage should have been called');
      const call = warningTracker.calls[0];
      assert.ok(
        call.message.includes('would be overwritten'),
        `Warning message should mention overwritten changes, got: "${call.message}"`
      );
      assert.ok(call.items.includes('Stash & Switch'), 'Should offer Stash & Switch option');
      assert.ok(call.items.includes('Force Checkout'), 'Should offer Force Checkout option');
      assert.ok(call.items.includes('Cancel'), 'Should offer Cancel option');
    });

    it('should show warning dialog when checkout fails with "Please commit your changes" message', async () => {
      const warningTracker = installWarningMessageTracker(undefined);

      const gitService = createMockGitService({
        checkout: async () => {
          throw new Error('Please commit your changes or stash them before you switch branches');
        },
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/test');
      await invokePrivateHandler(commands, '_handleCheckoutAndRebase', item);

      assert.ok(
        warningTracker.calls.length > 0,
        'showWarningMessage should have been called for "Please commit" error'
      );
    });

    it('should stash and retry checkout when user selects "Stash & Switch"', async () => {
      const stashCalls: string[] = [];
      const checkoutCalls: string[] = [];
      let checkoutCallCount = 0;

      installWarningMessageTracker('Stash & Switch');
      installInfoMessageTracker();

      const gitService = createMockGitService({
        checkout: async (_repo: IRepository, branchName: string) => {
          checkoutCallCount++;
          checkoutCalls.push(branchName);
          if (checkoutCallCount === 1) {
            throw new Error('Your local changes would be overwritten by checkout');
          }
          // Second call succeeds
        },
        stash: async (_repo: IRepository, message?: string) => {
          stashCalls.push(message ?? '');
        },
        rebaseBranch: async (): Promise<IBasicRebaseResult> => ({ success: true }),
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/test');
      await invokePrivateHandler(commands, '_handleCheckoutAndRebase', item);

      assert.ok(stashCalls.length > 0, 'stash should have been called');
      assert.ok(
        stashCalls[0].includes('feature/test'),
        `Stash message should reference the branch name, got: "${stashCalls[0]}"`
      );
      // Checkout should be called twice: first fails, second succeeds after stash
      assert.strictEqual(checkoutCalls.length, 2, 'checkout should be called twice');
    });

    it('should force checkout when user selects "Force Checkout"', async () => {
      let checkoutCallCount = 0;
      let forceUsed = false;

      installWarningMessageTracker('Force Checkout');
      installInfoMessageTracker();

      const gitService = createMockGitService({
        checkout: async (_repo: IRepository, _branchName: string, options?: ICheckoutOptions) => {
          checkoutCallCount++;
          if (checkoutCallCount === 1) {
            throw new Error('Your local changes would be overwritten by checkout');
          }
          if (options?.force) {
            forceUsed = true;
          }
        },
        rebaseBranch: async (): Promise<IBasicRebaseResult> => ({ success: true }),
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/test');
      await invokePrivateHandler(commands, '_handleCheckoutAndRebase', item);

      assert.ok(forceUsed, 'Force checkout should have been used');
    });
  });

  // ─── Remote-branch checkout-and-rebase: avoid detached HEAD ──────────────
  //
  // Symptom: right-clicking a remote branch (e.g. `origin/main`) and choosing
  // "Checkout and Rebase onto '{current}'" left the working copy at a
  // DETACHED HEAD, because the handler used to run
  // `git checkout origin/main` directly. A remote-tracking ref isn't a local
  // branch — git resolves it and detaches HEAD at the target commit.
  //
  // IntelliJ-parity fix: when the click target is a remote branch, create or
  // fast-forward a LOCAL tracking branch of the same leaf name and check
  // THAT out (`git checkout -B main --track origin/main`). HEAD stays
  // attached, the local branch tracks the remote, and the subsequent rebase
  // operates on the local branch (so the rebase actually advances a real
  // ref, not a detached pointer).
  //
  // The four tests below pin: success path, dirty-tree → Stash & Switch
  // path, dirty-tree → Force Checkout path, and that the local-branch path
  // (the regression-free baseline) is unaffected.
  describe('Remote-branch checkout-and-rebase: avoid detached HEAD (regression for IntelliJ parity)', () => {
    type CheckoutCall = { ref: string; options?: ICheckoutOptions };

    function createCheckoutTracker(): {
      calls: CheckoutCall[];
      checkout: (repo: IRepository, ref: string, options?: ICheckoutOptions) => Promise<void>;
    } {
      const calls: CheckoutCall[] = [];
      return {
        calls,
        checkout: async (_repo, ref, options) => {
          calls.push({ ref, options });
        },
      };
    }

    it('uses checkout -B <leaf> --track <remote> instead of detaching HEAD on origin/main', async () => {
      const tracker = createCheckoutTracker();
      const gitService = createMockGitService({
        checkout: tracker.checkout,
        rebaseBranch: async (): Promise<IBasicRebaseResult> => ({ success: true }),
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService, 'feature/test');
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createRemoteBranchTreeItem('origin/main');
      await invokePrivateHandler(commands, '_handleCheckoutAndRebase', item);

      assert.strictEqual(
        tracker.calls.length,
        1,
        `checkout should be called once; got ${tracker.calls.length}`
      );
      const call = tracker.calls[0];
      // The ref MUST be the local leaf name, NOT the full remote ref.
      // `git checkout origin/main` is the buggy form — it detaches HEAD.
      assert.strictEqual(
        call.ref,
        'main',
        `checkout ref must be the local leaf name "main", not "${call.ref}" (would detach HEAD)`
      );
      // The options MUST request forceCreate + track to create-or-fast-
      // forward the local tracking branch. Without forceCreate, a stale
      // local "main" pointing at an older commit blocks the checkout.
      assert.strictEqual(call.options?.forceCreate, true, 'forceCreate must be true');
      assert.strictEqual(
        call.options?.track,
        'origin/main',
        `track must be "origin/main"; got "${call.options?.track}"`
      );
      // Force is NOT set on the success path — it's only added when the
      // user opted into Force Checkout from the dirty-tree warning.
      assert.notStrictEqual(call.options?.force, true);
    });

    it('handles a multi-segment remote ref (origin/feature/x → local "feature/x")', async () => {
      // Defensive: branch names can contain slashes ("feature/auth/login").
      // The leaf is everything AFTER the first slash, NOT just the last
      // segment. Without this, "origin/feature/login" would create a local
      // "login" instead of "feature/login" and silently lose the namespace.
      const tracker = createCheckoutTracker();
      const gitService = createMockGitService({
        checkout: tracker.checkout,
        rebaseBranch: async (): Promise<IBasicRebaseResult> => ({ success: true }),
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService, 'main');
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createRemoteBranchTreeItem('origin/feature/auth/login');
      await invokePrivateHandler(commands, '_handleCheckoutAndRebase', item);

      assert.strictEqual(tracker.calls.length, 1);
      const call = tracker.calls[0];
      assert.strictEqual(
        call.ref,
        'feature/auth/login',
        `multi-segment leaf must be preserved; got "${call.ref}"`
      );
      assert.strictEqual(call.options?.track, 'origin/feature/auth/login');
    });

    it('LOCAL-branch path still uses plain checkout (no forceCreate, no track) — regression baseline', async () => {
      // The local case must NOT regress: a local-branch click should
      // still produce `git checkout <name>` with no `-B` / no `--track`.
      // Verifying this guards against an over-broad fix that would
      // unconditionally force-reset local branches.
      const tracker = createCheckoutTracker();
      const gitService = createMockGitService({
        checkout: tracker.checkout,
        rebaseBranch: async (): Promise<IBasicRebaseResult> => ({ success: true }),
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService, 'feature/test');
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('main');
      await invokePrivateHandler(commands, '_handleCheckoutAndRebase', item);

      assert.strictEqual(tracker.calls.length, 1);
      const call = tracker.calls[0];
      assert.strictEqual(call.ref, 'main');
      // Local path: no forceCreate, no track.
      assert.notStrictEqual(call.options?.forceCreate, true, 'local path must NOT set forceCreate');
      assert.strictEqual(call.options?.track, undefined, 'local path must NOT set track');
    });

    it('Stash & Switch fallback on dirty tree also uses the local-tracking checkout for remote refs', async () => {
      // The dirty-tree branch went through `this._gitService.checkout(repo,
      // item.branch.name)` — the EXACT bug that detaches HEAD. The fix
      // routes Stash & Switch through the same `checkout()` helper that
      // knows about the remote-vs-local distinction.
      installWarningMessageTracker('Stash & Switch');
      const calls: CheckoutCall[] = [];
      let throwOnce = true;
      const gitService = createMockGitService({
        checkout: async (_repo, ref, options) => {
          // First call (the entry-point checkout) throws "would be
          // overwritten"; subsequent calls (after stash) succeed and
          // record their args so we can verify the local-tracking form.
          if (throwOnce) {
            throwOnce = false;
            throw new Error(
              'error: Your local changes to the following files would be overwritten by checkout'
            );
          }
          calls.push({ ref, options });
        },
        rebaseBranch: async (): Promise<IBasicRebaseResult> => ({ success: true }),
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService, 'feature/test');
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createRemoteBranchTreeItem('origin/main');
      await invokePrivateHandler(commands, '_handleCheckoutAndRebase', item);

      assert.strictEqual(
        calls.length,
        1,
        `expected one post-stash checkout call; got ${calls.length}`
      );
      const call = calls[0];
      assert.strictEqual(call.ref, 'main', 'post-stash checkout must use local leaf name');
      assert.strictEqual(call.options?.forceCreate, true);
      assert.strictEqual(call.options?.track, 'origin/main');
    });

    it('Force Checkout fallback on dirty tree also uses the local-tracking checkout for remote refs', async () => {
      installWarningMessageTracker('Force Checkout');
      const calls: CheckoutCall[] = [];
      let throwOnce = true;
      const gitService = createMockGitService({
        checkout: async (_repo, ref, options) => {
          if (throwOnce) {
            throwOnce = false;
            throw new Error(
              'error: Your local changes to the following files would be overwritten by checkout'
            );
          }
          calls.push({ ref, options });
        },
        rebaseBranch: async (): Promise<IBasicRebaseResult> => ({ success: true }),
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService, 'feature/test');
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createRemoteBranchTreeItem('origin/main');
      await invokePrivateHandler(commands, '_handleCheckoutAndRebase', item);

      assert.strictEqual(calls.length, 1, `expected one force-checkout call; got ${calls.length}`);
      const call = calls[0];
      assert.strictEqual(call.ref, 'main');
      assert.strictEqual(call.options?.force, true, 'force flag must be set');
      assert.strictEqual(call.options?.forceCreate, true);
      assert.strictEqual(call.options?.track, 'origin/main');
    });
  });

  // ─── Conflict Warning ──────────────────────────────────

  describe('Conflict warning for merge/rebase results', () => {
    it('_handleCheckoutAndRebase should show warning with conflict count when rebase has conflicts', async () => {
      const warningTracker = installWarningMessageTracker();
      installInfoMessageTracker();

      const gitService = createMockGitService({
        checkout: async () => {},
        rebaseBranch: async (): Promise<IBasicRebaseResult> => ({
          success: false,
          conflicts: ['file1.ts', 'file2.ts', 'file3.ts'],
          rebaseInProgress: true,
        }),
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/test');
      await invokePrivateHandler(commands, '_handleCheckoutAndRebase', item);

      assert.ok(
        warningTracker.calls.length > 0,
        'showWarningMessage should have been called for conflicts'
      );
      const msg = warningTracker.calls[0].message;
      assert.ok(msg.includes('3'), `Warning should contain conflict count 3, got: "${msg}"`);
      assert.ok(
        msg.toLowerCase().includes('conflict'),
        `Warning should mention conflicts, got: "${msg}"`
      );
    });

    it('_handleMergeIntoCurrent should show warning with conflict count', async () => {
      const warningTracker = installWarningMessageTracker();

      const gitService = createMockGitService({
        mergeBranch: async () => ({
          success: false,
          conflicts: ['src/a.ts', 'src/b.ts'],
        }),
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/merge-test');
      await invokePrivateHandler(commands, '_handleMergeIntoCurrent', item);

      assert.ok(
        warningTracker.calls.length > 0,
        'showWarningMessage should have been called for merge conflicts'
      );
      const msg = warningTracker.calls[0].message;
      assert.ok(msg.includes('2'), `Warning should contain conflict count 2, got: "${msg}"`);
    });

    it('_handleRebaseCurrentOnto should show warning with conflict count', async () => {
      const warningTracker = installWarningMessageTracker();

      const gitService = createMockGitService({
        rebaseBranch: async (): Promise<IBasicRebaseResult> => ({
          success: false,
          conflicts: ['file.ts'],
          rebaseInProgress: true,
        }),
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/rebase-test');
      await invokePrivateHandler(commands, '_handleRebaseCurrentOnto', item);

      assert.ok(
        warningTracker.calls.length > 0,
        'showWarningMessage should have been called for rebase conflicts'
      );
      const msg = warningTracker.calls[0].message;
      assert.ok(msg.includes('1'), `Warning should contain conflict count 1, got: "${msg}"`);
    });

    // ─── Smart-stash parity: a dirty tree must NOT block rebase-onto ──────
    //
    // IntelliJ rebases a dirty tree silently (auto-stash → rebase →
    // auto-restore); only a genuine conflict surfaces a dialog. Our handler
    // must NOT short-circuit with a "commit or stash first" wall — rebaseBranch
    // already passes --autostash. These pin the parity contract.

    it('_handleRebaseCurrentOnto runs the rebase on a DIRTY tree (no commit-or-stash wall)', async () => {
      const warningTracker = installWarningMessageTracker();
      const infoTracker = installInfoMessageTracker();

      let rebaseCalls = 0;
      const dirtyStatus: IFileStatus[] = [
        { path: 'wip.ts', indexStatus: ' ', workTreeStatus: 'M' } as IFileStatus,
      ];
      const gitService = createMockGitService({
        // Dirty working tree — the old pre-check short-circuited here.
        getStatus: async () => dirtyStatus,
        rebaseBranch: async (): Promise<IBasicRebaseResult> => {
          rebaseCalls++;
          return { success: true };
        },
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/rebase-target');
      await invokePrivateHandler(commands, '_handleRebaseCurrentOnto', item);

      assert.strictEqual(
        rebaseCalls,
        1,
        'rebaseBranch MUST run on a dirty tree (autostash handles it); the handler must not short-circuit'
      );
      // No "commit or stash" wall.
      const stashWall = warningTracker.calls.find((c) =>
        /commit or stash|uncommitted changes/i.test(c.message)
      );
      assert.strictEqual(stashWall, undefined, 'must NOT show the commit-or-stash warning');
      // Success toast fired.
      assert.ok(
        infoTracker.calls.some((c) => /rebased onto .* successfully/i.test(c.message)),
        'should show the "Rebased onto X successfully" toast'
      );
    });

    it('_handleRebaseCurrentOnto surfaces an autostash-pop conflict on a dirty tree', async () => {
      const warningTracker = installWarningMessageTracker();

      const dirtyStatus: IFileStatus[] = [
        { path: 'wip.ts', indexStatus: ' ', workTreeStatus: 'M' } as IFileStatus,
      ];
      const gitService = createMockGitService({
        getStatus: async () => dirtyStatus,
        // Autostash pop conflicted after the rebase completed — not continuable.
        rebaseBranch: async (): Promise<IBasicRebaseResult> => ({
          success: false,
          conflicts: ['wip.ts'],
          rebaseInProgress: false,
        }),
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/rebase-target');
      await invokePrivateHandler(commands, '_handleRebaseCurrentOnto', item);

      // No commit-or-stash wall; the conflict is surfaced instead.
      const stashWall = warningTracker.calls.find((c) =>
        /commit or stash|uncommitted changes/i.test(c.message)
      );
      assert.strictEqual(
        stashWall,
        undefined,
        'must NOT short-circuit with the commit-or-stash wall'
      );
      assert.ok(
        warningTracker.calls.some((c) => /\b1\b/.test(c.message)),
        'should surface the conflict (no ConflictResolutionService wired → fallback warning with file count)'
      );
    });

    // ─── Non-conflict failure surfacing (regression: silent no-op) ────────
    //
    // PR1 (fix/silent-rebase-error-surfacing) pinned the rebase handler's
    // non-conflict failure surfacing + fallback path. Those tests are merged
    // on main. PR3 keeps its two unique tests covering the same regression for
    // `_handleMergeIntoCurrent` and `_handleCherryPickCommits` — handlers PR1
    // didn't touch.

    it('_handleMergeIntoCurrent surfaces failureReason on non-conflict failure', async () => {
      const errorTracker = installErrorMessageTracker();

      const gitService = createMockGitService({
        mergeBranch: async () => ({
          success: false,
          conflicts: [],
          failureReason: 'fatal: refusing to merge unrelated histories',
        }),
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/merge-test');
      await invokePrivateHandler(commands, '_handleMergeIntoCurrent', item);

      assert.ok(
        errorTracker.calls.length > 0,
        'showErrorMessage MUST be called for non-conflict merge failure (regression: was silent no-op)'
      );
      assert.ok(
        errorTracker.calls[0].message.includes('unrelated histories'),
        `error message should include the underlying git reason, got: "${errorTracker.calls[0].message}"`
      );
    });

    it('_handleCherryPickCommits surfaces failureReason on non-conflict failure', async () => {
      const errorTracker = installErrorMessageTracker();

      // The QuickPick prompts for which commits to pick — pre-resolve it.
      const w = writableWindow();
      const originalQuickPick = w.showQuickPick;
      w.showQuickPick = (items: unknown): Promise<unknown> => {
        if (Array.isArray(items)) {
          return Promise.resolve(items.length > 0 ? items.slice(0, 1) : undefined);
        }
        return Promise.resolve(undefined);
      };

      try {
        const gitService = createMockGitService({
          getLog: async () => [
            {
              hash: 'abc1234',
              shortHash: 'abc1234',
              message: 'Commit msg',
              author: { name: 'A', email: 'a@a' },
              committer: { name: 'A', email: 'a@a' },
              parents: [],
              authorDate: new Date(0),
              commitDate: new Date(0),
            },
          ],
          cherryPick: async () => ({
            success: false,
            conflicts: [],
            failureReason: 'fatal: bad object abc1234',
          }),
        });
        const branchTreeProvider = createMockBranchTreeProvider(gitService);
        const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

        const item = createRemoteBranchTreeItem('origin/feature/x');
        await invokePrivateHandler(commands, '_handleCherryPickCommits', item);

        assert.ok(
          errorTracker.calls.length > 0,
          'showErrorMessage MUST be called for non-conflict cherry-pick failure'
        );
        assert.ok(
          errorTracker.calls[0].message.toLowerCase().includes('bad object') ||
            errorTracker.calls[0].message.toLowerCase().includes('cherry-pick'),
          `error message should reference the failure, got: "${errorTracker.calls[0].message}"`
        );
      } finally {
        w.showQuickPick = originalQuickPick;
      }
    });

    // TL-33: tests for the `_parseConflictCount` fallback path were removed.
    // The pull-throws-with-CONFLICT-markers branch no longer stringifies a
    // count out of the error text; when `_conflictResolutionService` is
    // wired (always true in production — see `ExtensionServices.initialize`)
    // conflict detection probes the working tree via `getConflictedFiles`,
    // and when the service is absent (test-only constructor shape) the code
    // falls through to the generic "Failed to pull …" error message. The
    // positive probe path is covered in `branchContextMenu.fixes.test.ts`.
  });

  // ─── Worktree-conflict checkout: actionable message, not raw fatal ──────
  //
  // Checking out a branch that is already checked out in ANOTHER git
  // worktree makes git refuse atomically:
  //
  //   fatal: 'feature' is already used by worktree at '/path/to/wt'
  //
  // git won't proceed even with --force, so there's nothing to stash or
  // retry around (unlike the "would be overwritten" dirty-tree flow). The
  // handler must translate this dead-end into an actionable message that
  // names the worktree path — NOT leak the raw "Failed to checkout branch:
  // ...fatal..." dump. Covers all three checkout entry points.
  describe('Worktree-conflict checkout surfaces an actionable message (not the raw fatal)', () => {
    const WORKTREE_FATAL =
      "fatal: 'feature/test' is already used by worktree at '/repos/proj-feature'";

    function assertActionable(message: string): void {
      assert.ok(
        !message.includes('fatal:'),
        `toast must NOT surface the raw git fatal; got: "${message}"`
      );
      assert.ok(
        /another worktree|other worktree/i.test(message),
        `toast should explain the branch is checked out in another worktree; got: "${message}"`
      );
      assert.ok(
        message.includes('/repos/proj-feature'),
        `toast should name the worktree path; got: "${message}"`
      );
    }

    it('_handleCheckout: shows an actionable error (no Stash/Force prompt)', async () => {
      const errorTracker = installErrorMessageTracker();
      const warningTracker = installWarningMessageTracker(undefined);

      const gitService = createMockGitService({
        checkout: async () => {
          throw new Error(WORKTREE_FATAL);
        },
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/test');
      await invokePrivateHandler(commands, '_handleCheckout', item);

      // git refuses worktree conflicts atomically — Force won't help, so
      // we must NOT offer the Stash & Switch / Force Checkout warning.
      assert.strictEqual(
        warningTracker.calls.length,
        0,
        'must NOT show the Stash/Force warning for a worktree conflict'
      );
      assert.strictEqual(errorTracker.calls.length, 1, 'expected one error toast');
      assertActionable(errorTracker.calls[0].message);
    });

    it('_handleCheckoutAndRebase: shows an actionable error (no Stash/Force prompt)', async () => {
      const errorTracker = installErrorMessageTracker();
      const warningTracker = installWarningMessageTracker(undefined);

      const gitService = createMockGitService({
        checkout: async () => {
          throw new Error(WORKTREE_FATAL);
        },
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/test');
      await invokePrivateHandler(commands, '_handleCheckoutAndRebase', item);

      assert.strictEqual(
        warningTracker.calls.length,
        0,
        'must NOT show the Stash/Force warning for a worktree conflict'
      );
      assert.strictEqual(errorTracker.calls.length, 1, 'expected one error toast');
      assertActionable(errorTracker.calls[0].message);
    });

    it('_handleCheckoutAsLocal: shows an actionable error (no Stash/Force prompt)', async () => {
      const errorTracker = installErrorMessageTracker();
      const warningTracker = installWarningMessageTracker(undefined);

      const gitService = createMockGitService({
        getBranches: async () => [],
        checkout: async () => {
          throw new Error("fatal: 'main' is already used by worktree at '/repos/proj-feature'");
        },
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createRemoteBranchTreeItem('origin/main');
      await invokePrivateHandler(commands, '_handleCheckoutAsLocal', item);

      assert.strictEqual(
        warningTracker.calls.length,
        0,
        'must NOT show the Stash/Force warning for a worktree conflict'
      );
      assert.strictEqual(errorTracker.calls.length, 1, 'expected one error toast');
      const msg = errorTracker.calls[0].message;
      assert.ok(!msg.includes('fatal:'), `must not surface raw fatal; got: "${msg}"`);
      assert.ok(
        /another worktree|other worktree/i.test(msg),
        `should mention another worktree; got: "${msg}"`
      );
    });

    it('_handleCheckout: a bad-ref failure still shows the generic error (no over-broad match)', async () => {
      const errorTracker = installErrorMessageTracker();

      const gitService = createMockGitService({
        checkout: async () => {
          throw new Error('fatal: invalid reference: nonexistent-branch');
        },
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('nonexistent-branch');
      await invokePrivateHandler(commands, '_handleCheckout', item);

      assert.strictEqual(errorTracker.calls.length, 1, 'expected one error toast');
      assert.ok(
        errorTracker.calls[0].message.includes('Failed to checkout branch'),
        `bad-ref must keep the generic handling; got: "${errorTracker.calls[0].message}"`
      );
      assert.ok(
        errorTracker.calls[0].message.includes('invalid reference'),
        'generic toast keeps the underlying git reason'
      );
    });
  });

  // ─── General Error Handling ─────────────────────────────

  describe('General error handling', () => {
    it('_handleUpdate should show error message when fetch fails', async () => {
      const errorTracker = installErrorMessageTracker();

      const gitService = createMockGitService({
        fetch: async () => {
          throw new Error('Network error: could not resolve host');
        },
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('main', { remote: 'origin', name: 'main' });
      await invokePrivateHandler(commands, '_handleUpdate', item);

      assert.ok(errorTracker.calls.length > 0, 'showErrorMessage should have been called');
      assert.ok(
        errorTracker.calls[0].message.includes('Network error'),
        `Error message should contain the error text, got: "${errorTracker.calls[0].message}"`
      );
    });

    it('_handlePush should show error message when push fails', async () => {
      const errorTracker = installErrorMessageTracker();

      const gitService = createMockGitService({
        push: async () => {
          throw new Error('rejected: non-fast-forward');
        },
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('main', { remote: 'origin', name: 'main' });
      await invokePrivateHandler(commands, '_handlePush', item);

      assert.ok(errorTracker.calls.length > 0, 'showErrorMessage should have been called');
      assert.ok(
        errorTracker.calls[0].message.includes('rejected'),
        `Error message should contain the error text, got: "${errorTracker.calls[0].message}"`
      );
    });

    it('_handleCheckoutAndRebase should show error for non-uncommitted-changes errors', async () => {
      const errorTracker = installErrorMessageTracker();

      const gitService = createMockGitService({
        checkout: async () => {
          throw new Error('fatal: invalid reference: nonexistent-branch');
        },
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('nonexistent-branch');
      await invokePrivateHandler(commands, '_handleCheckoutAndRebase', item);

      assert.ok(errorTracker.calls.length > 0, 'showErrorMessage should have been called');
      assert.ok(
        errorTracker.calls[0].message.includes('invalid reference'),
        `Error message should contain the error text, got: "${errorTracker.calls[0].message}"`
      );
    });
  });

  // ─── Missing Upstream Handling ────────────────────────────────────────────

  describe('Missing upstream handling for Update/Push', () => {
    it('_handleUpdate should show informational message when branch has no upstream', async () => {
      const infoTracker = installInfoMessageTracker();

      const gitService = createMockGitService();
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      // Create branch without upstream
      const item = createLocalBranchTreeItem('feature/no-upstream');
      await invokePrivateHandler(commands, '_handleUpdate', item);

      assert.ok(
        infoTracker.calls.length > 0,
        'showInformationMessage should have been called for missing upstream'
      );
      assert.ok(
        infoTracker.calls[0].message.includes('no upstream'),
        `Info message should mention no upstream, got: "${infoTracker.calls[0].message}"`
      );
    });

    it('_handlePush should push with setUpstream when branch has no upstream', async () => {
      let pushOptions: IPushOptions | undefined;
      installInfoMessageTracker();

      const gitService = createMockGitService({
        push: async (_repo: IRepository, options?: IPushOptions) => {
          pushOptions = options;
        },
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      // Create branch without upstream
      const item = createLocalBranchTreeItem('feature/no-upstream');
      await invokePrivateHandler(commands, '_handlePush', item);

      assert.ok(pushOptions !== undefined, 'push should have been called');
      assert.strictEqual(
        pushOptions?.setUpstream,
        true,
        'push should be called with setUpstream: true when no upstream'
      );
    });
  });

  // TL-72 (Wave 9) — every BranchContextMenuCommands action-path catch
  // block must run the raw git stderr through `sanitizeGitError`. This
  // file has 21 such sites (checkout / merge / rebase / push / pull /
  // delete / rename / create / etc.) — instead of a per-site spec we
  // pin the bug class on a representative call (`_handlePush` reaches
  // the ${errorMessage} template at line 648). The other 20 sites
  // share the identical pattern; a CI grep audit (post-publish backlog)
  // would catch any future regression that drops the sanitiser.
  describe('TL-72 — error toast sanitization (representative)', () => {
    it('_handlePush sanitizes credentialed URL + home path in error toast', async () => {
      const RAW = 'fail: https://alice:secret@example.com/repo.git\n/Users/alice/project';
      const EXPECTED = 'fail: https://<redacted>@example.com/repo.git\n~/project';
      const errorTracker = installErrorMessageTracker();

      const gitService = createMockGitService({
        push: async () => {
          throw new Error(RAW);
        },
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('main', { remote: 'origin', name: 'main' });
      await invokePrivateHandler(commands, '_handlePush', item);

      assert.strictEqual(errorTracker.calls.length, 1, 'expected one error toast');
      assert.strictEqual(errorTracker.calls[0].message, `Failed to push branch: ${EXPECTED}`);
      assert.ok(
        !errorTracker.calls[0].message.includes('alice:secret'),
        'toast must not leak credentials'
      );
      assert.ok(
        !errorTracker.calls[0].message.includes('/Users/alice'),
        'toast must not leak home path'
      );
    });
  });

  // ─── Branch delete: not-fully-merged → force-delete prompt ─────────────

  describe('_handleDelete — not-fully-merged → force-delete prompt', () => {
    /**
     * Stub `showWarningMessage` so the first call (confirm Delete) and the
     * second call (confirm Force Delete) can return different choices and
     * be inspected by the test. The shared `installWarningMessageTracker`
     * helper only supports a single returnChoice across all calls.
     */
    function installSequencedWarningTracker(responses: Array<string | undefined>): {
      calls: MessageCall[];
    } {
      const calls: MessageCall[] = [];
      let i = 0;
      writableWindow().showWarningMessage = (
        message: string,
        ...items: unknown[]
      ): Promise<string | undefined> => {
        const stringItems = items.filter((i): i is string => typeof i === 'string');
        calls.push({ message, items: stringItems });
        const reply = responses[i] ?? undefined;
        i += 1;
        return Promise.resolve(reply);
      };
      return { calls };
    }

    const repo: IRepository = {
      rootUri: Uri.file('/test/repo'),
      state: 'idle',
      head: undefined,
      remotes: [],
      submodules: [],
    };

    it('retries with force=true after the user confirms force delete', async () => {
      const deleteCalls: Array<{ name: string; force?: boolean }> = [];
      const gitService = createMockGitService({
        getRepositories: () => [repo],
        getRepository: async () => repo,
        deleteBranch: async (_repo, name, force) => {
          deleteCalls.push({ name, force });
          if (force === true) {
            return; // success
          }
          throw new Error(
            "error: the branch 'test-branch' is not fully merged.\n" +
              "If you are sure you want to delete it, run 'git branch -D test-branch'."
          );
        },
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const warnTracker = installSequencedWarningTracker(['Delete', 'Force Delete']);
      const infoTracker = installInfoMessageTracker();
      const errTracker = installErrorMessageTracker();

      const item = createLocalBranchTreeItem('test-branch');
      await invokePrivateHandler(commands, '_handleDelete', item);

      assert.strictEqual(deleteCalls.length, 2, 'expected one safe + one force attempt');
      assert.strictEqual(deleteCalls[0].force, undefined, 'first attempt is unforced');
      assert.strictEqual(deleteCalls[1].force, true, 'second attempt forces');

      assert.strictEqual(warnTracker.calls.length, 2, 'expected two warning prompts');
      assert.ok(
        warnTracker.calls[1].message.includes('not fully merged'),
        `expected 'not fully merged' phrasing in second prompt; got "${warnTracker.calls[1].message}"`
      );
      assert.ok(
        warnTracker.calls[1].items.includes('Force Delete'),
        'second prompt must offer Force Delete'
      );

      assert.strictEqual(infoTracker.calls.length, 1, 'expected success toast');
      assert.ok(
        infoTracker.calls[0].message.includes('Force-deleted'),
        `expected 'Force-deleted' in info toast; got "${infoTracker.calls[0].message}"`
      );

      assert.strictEqual(
        errTracker.calls.length,
        0,
        'no error toast when the force-delete succeeds'
      );
    });

    it('does NOT retry when the user cancels the force-delete prompt', async () => {
      const deleteCalls: Array<{ force?: boolean }> = [];
      const gitService = createMockGitService({
        getRepositories: () => [repo],
        getRepository: async () => repo,
        deleteBranch: async (_repo, _name, force) => {
          deleteCalls.push({ force });
          throw new Error("error: the branch 'test-branch' is not fully merged.");
        },
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      installSequencedWarningTracker(['Delete', undefined]); // user dismisses force prompt
      const errTracker = installErrorMessageTracker();
      const infoTracker = installInfoMessageTracker();

      const item = createLocalBranchTreeItem('test-branch');
      await invokePrivateHandler(commands, '_handleDelete', item);

      assert.strictEqual(deleteCalls.length, 1, 'no retry attempted on cancel');
      assert.strictEqual(infoTracker.calls.length, 0, 'no success toast on cancel');
      assert.strictEqual(
        errTracker.calls.length,
        0,
        'no error toast either — cancel is a quiet no-op'
      );
    });

    it('shows the original error toast for non-merge failures (no force prompt)', async () => {
      const gitService = createMockGitService({
        getRepositories: () => [repo],
        getRepository: async () => repo,
        deleteBranch: async () => {
          throw new Error("error: branch 'test-branch' not found.");
        },
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const warnTracker = installSequencedWarningTracker(['Delete']);
      const errTracker = installErrorMessageTracker();

      const item = createLocalBranchTreeItem('test-branch');
      await invokePrivateHandler(commands, '_handleDelete', item);

      assert.strictEqual(warnTracker.calls.length, 1, 'only the initial confirm is shown');
      assert.strictEqual(errTracker.calls.length, 1, 'expected one error toast');
      assert.ok(
        errTracker.calls[0].message.includes('Failed to delete branch'),
        `expected 'Failed to delete branch' in toast; got "${errTracker.calls[0].message}"`
      );
    });
  });

  // ─── Bug C — in-progress rebase surfacing + orphaned-rebase auto-abort ──
  //
  // C.1: after `_handleRebaseCurrentOnto` runs, the handler reloads the repo
  //      and, if `inProgress.kind === 'rebasing'` remains (and no Resolve
  //      Conflicts dialog was opened), surfaces an actionable "rebase paused"
  //      warning toast.
  // C.2: when a NON-conflict failure left an orphaned rebasing state that
  //      OUR call created (before.kind !== 'rebasing' && after.kind ===
  //      'rebasing'), the handler auto-runs `git rebase --abort` AFTER the
  //      error toast. The auto-abort must NOT fire when the user already had
  //      a rebase in progress before they clicked.
  describe('Bug C — in-progress rebase warning + auto-abort', () => {
    /**
     * Build a BranchTreeProvider whose repo carries the given `before`
     * in-progress state. The handler reads this as its pre-rebase snapshot.
     */
    function providerWithInProgress(
      gitService: IGitService,
      before?: IInProgressOperation
    ): BranchTreeProvider {
      const provider = new BranchTreeProvider(gitService);
      const mockRepo: IRepository = {
        rootUri: Uri.file('/test-repo'),
        state: before ? before.kind : 'idle',
        head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
        remotes: [],
        submodules: [],
        ...(before ? { inProgress: before } : {}),
      };
      provider.getRepository = () => mockRepo;
      return provider;
    }

    /** A repo snapshot that reports an in-progress rebase. */
    function rebasingRepoSnapshot(): IRepository {
      return {
        rootUri: Uri.file('/test-repo'),
        state: 'rebasing',
        head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
        remotes: [],
        submodules: [],
        inProgress: { kind: 'rebasing', target: 'main' },
      };
    }

    it('C.1: surfaces a "rebase paused" warning when a rebasing state remains after the call', async () => {
      const warningTracker = installWarningMessageTracker();
      installInfoMessageTracker();

      // rebaseBranch reports success, but reloadRepository shows the repo is
      // still mid-rebase (paused/interrupted). before.inProgress is absent.
      const gitService = createMockGitService({
        getStatus: async () => [],
        rebaseBranch: async (): Promise<IBasicRebaseResult> => ({ success: true }),
        reloadRepository: async () => rebasingRepoSnapshot(),
      });
      const branchTreeProvider = providerWithInProgress(gitService /* no before state */);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/rebase-target');
      await invokePrivateHandler(commands, '_handleRebaseCurrentOnto', item);

      assert.ok(
        warningTracker.calls.length > 0,
        'showWarningMessage MUST be called when a rebasing state remains after the rebase'
      );
      const msg = warningTracker.calls[warningTracker.calls.length - 1].message.toLowerCase();
      assert.ok(
        msg.includes('rebase paused'),
        `warning should mention "rebase paused", got: "${msg}"`
      );
      assert.ok(
        msg.includes('continue') && msg.includes('abort'),
        `warning should mention continue/abort, got: "${msg}"`
      );
    });

    it('C.1: does NOT warn when the repo is clean after the rebase', async () => {
      const warningTracker = installWarningMessageTracker();
      installInfoMessageTracker();

      const gitService = createMockGitService({
        getStatus: async () => [],
        rebaseBranch: async (): Promise<IBasicRebaseResult> => ({ success: true }),
        // reloadRepository returns an idle repo (no inProgress).
        reloadRepository: async (repo) => repo,
      });
      const branchTreeProvider = providerWithInProgress(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/rebase-target');
      await invokePrivateHandler(commands, '_handleRebaseCurrentOnto', item);

      const pausedWarnings = warningTracker.calls.filter((c) =>
        c.message.toLowerCase().includes('rebase paused')
      );
      assert.strictEqual(
        pausedWarnings.length,
        0,
        'no "rebase paused" warning should fire when the repo is clean afterwards'
      );
    });

    it('C.2: auto-aborts an orphaned rebase AFTER the error toast on non-conflict failure', async () => {
      const events: string[] = [];

      // Custom error tracker that records ordering relative to rebaseAbort.
      writableWindow().showErrorMessage = (message: string): Promise<string | undefined> => {
        events.push(`error-toast:${message}`);
        return Promise.resolve(undefined);
      };

      let abortCalled = false;
      const gitService = createMockGitService({
        getStatus: async () => [],
        rebaseBranch: async (): Promise<IBasicRebaseResult> => ({
          success: false,
          conflicts: [],
          failureReason: 'error: cannot rebase: You have unstaged changes.',
        }),
        // reloadRepository reports the orphaned rebasing state our call left.
        reloadRepository: async () => rebasingRepoSnapshot(),
        rebaseAbort: async () => {
          abortCalled = true;
          events.push('rebaseAbort');
        },
      });
      // before.inProgress is absent → our call created the rebasing state.
      const branchTreeProvider = providerWithInProgress(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/rebase-target');
      await invokePrivateHandler(commands, '_handleRebaseCurrentOnto', item);

      assert.ok(abortCalled, 'rebaseAbort MUST be invoked to clean up the orphaned rebase');

      const errorIdx = events.findIndex((e) => e.startsWith('error-toast:'));
      const abortIdx = events.indexOf('rebaseAbort');
      assert.ok(errorIdx >= 0, 'an error toast MUST be shown for the non-conflict failure');
      assert.ok(abortIdx >= 0, 'rebaseAbort MUST run');
      assert.ok(
        abortIdx > errorIdx,
        `rebaseAbort must run AFTER the error toast (toast idx ${errorIdx}, abort idx ${abortIdx})`
      );
    });

    it('C.2: does NOT auto-abort when the user already had a rebase in progress before clicking', async () => {
      installErrorMessageTracker();

      let abortCalled = false;
      const gitService = createMockGitService({
        getStatus: async () => [],
        rebaseBranch: async (): Promise<IBasicRebaseResult> => ({
          success: false,
          conflicts: [],
          failureReason: 'error: it seems that there is already a rebase-merge directory',
        }),
        reloadRepository: async () => rebasingRepoSnapshot(),
        rebaseAbort: async () => {
          abortCalled = true;
        },
      });
      // before.inProgress.kind === 'rebasing' → the user already had a rebase
      // paused; our call must NOT clobber it.
      const branchTreeProvider = providerWithInProgress(gitService, {
        kind: 'rebasing',
        target: 'someother',
      });
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/rebase-target');
      await invokePrivateHandler(commands, '_handleRebaseCurrentOnto', item);

      assert.strictEqual(
        abortCalled,
        false,
        'rebaseAbort MUST NOT run when the user already had a rebase in progress before clicking'
      );
    });
  });
});
