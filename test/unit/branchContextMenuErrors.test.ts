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
import { driveBranchMenuCommand } from '../typed/branchMenuDriver';
import { SpawnFailedError, CommandFailedError, GitError } from '../../src/git-core/errors';
import * as assert from 'assert';
import { okAsync, errAsync, ResultAsync } from 'neverthrow';
import { BranchContextMenuCommands } from '../../src/branches/BranchContextMenuCommands';
import { IConflictResolutionService } from '../../src/conflicts/interfaces/IConflictResolutionService';
import { BranchTreeItem, BranchTreeProvider } from '../../src/branches/BranchTreeProvider';
import {
  IGitService,
  IRepository,
  IBranch,
  IBasicRebaseResult,
  ICheckoutOptions,
  IPushOptions,
  IInProgressOperation,
  IFileStatus,
} from '../../src/git-core/interfaces/IGitService';
import { EventEmitter, Uri } from '../mocks/vscode';
import { writableWindow } from '../typed/windowStub';

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
    commit: () => okAsync(undefined),
    amend: () => okAsync(undefined),
    commitFixup: () => okAsync({ success: true }),
    createBranch: () => okAsync(undefined),
    checkout: () => okAsync(undefined),
    deleteBranch: () => okAsync(undefined),
    renameBranch: () => okAsync(undefined),
    mergeBranch: async () => ({ success: true }),
    rebaseBranch: async () => ({ success: true }),
    rebaseSkip: async () => ({ success: true }),
    rebaseAbort: () => okAsync(undefined),
    rebaseContinue: async () => ({ success: true }),
    compareBranches: async () => ({
      commitsAhead: [],
      commitsBehind: [],
      aheadCount: 0,
      behindCount: 0,
      changedFiles: [],
    }),
    fetch: () =>
      okAsync({
        updatedRefs: [],
        ahead: 0,
        behind: 0,
        errors: [],
      }),
    onDidFetch: () => ({ dispose: () => {} }),
    resetToCommit: () => okAsync(undefined),
    pull: () => okAsync(undefined),
    push: () => okAsync(undefined),
    getRemotes: () => okAsync([]),
    addRemote: () => okAsync(undefined),
    removeRemote: () => okAsync(undefined),
    stash: () => okAsync(undefined),
    stashList: async () => [],
    stashApply: () => okAsync(undefined),
    stashPop: () => okAsync(undefined),
    stashDrop: () => okAsync(undefined),
    stashShow: async () => [],
    createTag: () => okAsync(undefined),
    deleteTag: () => okAsync(undefined),
    pushTag: () => okAsync(undefined),
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
    stage: () => okAsync(undefined),
    unstage: () => okAsync(undefined),
    stageHunk: () => okAsync(undefined),
    stageLines: () => okAsync(undefined),
    unstageHunk: () => okAsync(undefined),
    revertFile: () => okAsync(undefined),
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
  upstream?: { remote: string; name: string },
  isHead = false
): BranchTreeItem {
  const branch: IBranch = {
    name: branchName,
    type: 'local',
    commit: 'abc1234',
    isHead,
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
 * Create a BranchTreeItem for a tag.
 */
function createTagTreeItem(tagName: string): BranchTreeItem {
  const tag = {
    name: tagName,
    commit: 'abc1234',
    isAnnotated: false,
  };
  return new BranchTreeItem(tagName, 0, 'tag', undefined, tag, false);
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
        fetch: () => {
          fetchCalled = true;
          return okAsync({ updatedRefs: [], ahead: 0, behind: 0, errors: [] });
        },
      });
      const branchTreeProvider = createMockBranchTreeProviderNoRepo(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/test', {
        remote: 'origin',
        name: 'feature/test',
      });
      await driveBranchMenuCommand(commands, 'intellig.branch.update', item);

      assert.strictEqual(fetchCalled, false, 'fetch should not be called when repo is undefined');
    });

    it('_handlePush should return early when repository is undefined', async () => {
      let pushCalled = false;
      const gitService = createMockGitService({
        push: () => {
          pushCalled = true;
          return okAsync(undefined);
        },
      });
      const branchTreeProvider = createMockBranchTreeProviderNoRepo(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/test', {
        remote: 'origin',
        name: 'feature/test',
      });
      await driveBranchMenuCommand(commands, 'intellig.branch.push', item);

      assert.strictEqual(pushCalled, false, 'push should not be called when repo is undefined');
    });

    it('_handleCheckoutAndRebase should return early when repository is undefined', async () => {
      let checkoutCalled = false;
      const gitService = createMockGitService({
        checkout: () => {
          checkoutCalled = true;
          return okAsync(undefined);
        },
      });
      const branchTreeProvider = createMockBranchTreeProviderNoRepo(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/test');
      await driveBranchMenuCommand(commands, 'intellig.branch.checkoutAndRebase', item);

      assert.strictEqual(
        checkoutCalled,
        false,
        'checkout should not be called when repo is undefined'
      );
    });

    it('_handlePullUsingRebase should return early when repository is undefined', async () => {
      let pullCalled = false;
      const gitService = createMockGitService({
        pull: () => {
          pullCalled = true;
          return okAsync(undefined);
        },
      });
      const branchTreeProvider = createMockBranchTreeProviderNoRepo(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createRemoteBranchTreeItem('origin/main');
      await driveBranchMenuCommand(commands, 'intellig.remoteBranch.pullUsingRebase', item);

      assert.strictEqual(pullCalled, false, 'pull should not be called when repo is undefined');
    });

    it('_handlePullUsingMerge should return early when repository is undefined', async () => {
      let pullCalled = false;
      const gitService = createMockGitService({
        pull: () => {
          pullCalled = true;
          return okAsync(undefined);
        },
      });
      const branchTreeProvider = createMockBranchTreeProviderNoRepo(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createRemoteBranchTreeItem('origin/main');
      await driveBranchMenuCommand(commands, 'intellig.remoteBranch.pullUsingMerge', item);

      assert.strictEqual(pullCalled, false, 'pull should not be called when repo is undefined');
    });
  });

  // ─── Uncommitted Changes Dialog ────────────────────────

  describe('Uncommitted changes dialog for Checkout and Rebase', () => {
    it('should show warning dialog with Stash/Force/Cancel options when checkout fails due to uncommitted changes', async () => {
      const warningTracker = installWarningMessageTracker(undefined); // user cancels

      const gitService = createMockGitService({
        checkout: () =>
          errAsync(
            new CommandFailedError(
              1,
              '',
              'error: Your local changes to the following files would be overwritten by checkout'
            )
          ),
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/test');
      await driveBranchMenuCommand(commands, 'intellig.branch.checkoutAndRebase', item);

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
        checkout: () =>
          errAsync(
            new CommandFailedError(
              1,
              '',
              'Please commit your changes or stash them before you switch branches'
            )
          ),
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/test');
      await driveBranchMenuCommand(commands, 'intellig.branch.checkoutAndRebase', item);

      assert.ok(
        warningTracker.calls.length > 0,
        'showWarningMessage should have been called for "Please commit" error'
      );
    });

    it('restores the stash after a successful Stash & Switch (smart-checkout parity)', async () => {
      // git4idea's Smart Checkout is stash -> checkout -> UNSTASH; stopping
      // after the checkout silently parks the user's changes in the stash.
      const calls: string[] = [];
      installWarningMessageTracker('Stash & Switch');
      installInfoMessageTracker();

      let checkoutCallCount = 0;
      const gitService = createMockGitService({
        checkout: () => {
          checkoutCallCount++;
          return checkoutCallCount === 1
            ? errAsync(
                new CommandFailedError(1, '', 'Your local changes would be overwritten by checkout')
              )
            : okAsync(undefined);
        },
        stash: () => {
          calls.push('stash');
          return okAsync(undefined);
        },
        stashPop: () => {
          calls.push('pop');
          return okAsync(undefined);
        },
      });
      const commands = new BranchContextMenuCommands(
        gitService,
        createMockBranchTreeProvider(gitService)
      );

      await driveBranchMenuCommand(
        commands,
        'intellig.branch.checkout',
        createLocalBranchTreeItem('feature/x')
      );

      assert.deepStrictEqual(
        calls,
        ['stash', 'pop'],
        'the stash must be POPPED after the switch, not left parked'
      );
    });

    it('pops the stash it CREATED even when another stash landed on top (pinned pop)', async () => {
      // Between our `stash push` and the post-checkout pop, an autostash /
      // concurrent flow / the user can push another entry — stash@{0} is then
      // the WRONG stash. The restore must find our entry by sha and pop ITS
      // current index.
      const ourSha = 'a'.repeat(40);
      const otherSha = 'b'.repeat(40);
      installWarningMessageTracker('Stash & Switch');
      installInfoMessageTracker();

      let checkoutCallCount = 0;
      let stashed = false;
      const poppedIndexes: number[] = [];
      const gitService = createMockGitService({
        checkout: () => {
          checkoutCallCount++;
          return checkoutCallCount === 1
            ? errAsync(
                new CommandFailedError(1, '', 'Your local changes would be overwritten by checkout')
              )
            : okAsync(undefined);
        },
        stash: () => {
          stashed = true;
          return okAsync(undefined);
        },
        stashList: async () => {
          if (!stashed) {
            return [];
          }
          // After our push the entry is at index 0; by pop time another
          // stash sits on top and ours moved to index 1.
          if (poppedIndexes.length === 0 && checkoutCallCount >= 2) {
            return [
              { index: 0, message: 'other', date: new Date(), hash: otherSha },
              { index: 1, message: 'ours', date: new Date(), hash: ourSha },
            ];
          }
          return [{ index: 0, message: 'ours', date: new Date(), hash: ourSha }];
        },
        stashPop: (_repo: IRepository, index: number) => {
          poppedIndexes.push(index);
          return okAsync(undefined);
        },
      });
      const commands = new BranchContextMenuCommands(
        gitService,
        createMockBranchTreeProvider(gitService)
      );

      await driveBranchMenuCommand(
        commands,
        'intellig.branch.checkout',
        createLocalBranchTreeItem('feature/x')
      );

      assert.deepStrictEqual(
        poppedIndexes,
        [1],
        'must pop OUR entry at its current index, not stash@{0}'
      );
    });

    it('routes a stash-restore conflict into the Resolve Conflicts flow (operation: unstash)', async () => {
      installWarningMessageTracker('Stash & Switch');
      installInfoMessageTracker();

      let checkoutCallCount = 0;
      const gitService = createMockGitService({
        checkout: () => {
          checkoutCallCount++;
          return checkoutCallCount === 1
            ? errAsync(
                new CommandFailedError(1, '', 'Your local changes would be overwritten by checkout')
              )
            : okAsync(undefined);
        },
        stash: () => okAsync(undefined),
        stashPop: () =>
          errAsync(new CommandFailedError(1, 'CONFLICT (content): merge conflict in a.ts')),
      });
      const dialogOpens: Array<{ operation: string }> = [];
      const conflictService = {
        getConflictedFiles: async () => [{ path: 'a.ts', resolved: false }],
        openResolveConflictsDialog: async (
          _repo: unknown,
          _conflicts: unknown,
          opContext: { operation: string }
        ) => {
          dialogOpens.push({ operation: opContext.operation });
        },
      } as unknown as IConflictResolutionService;
      const commands = new BranchContextMenuCommands(
        gitService,
        createMockBranchTreeProvider(gitService),
        conflictService
      );

      await driveBranchMenuCommand(
        commands,
        'intellig.branch.checkout',
        createLocalBranchTreeItem('feature/x')
      );

      assert.deepStrictEqual(
        dialogOpens,
        [{ operation: 'unstash' }],
        'a conflicting pop must open the Resolve Conflicts dialog as an unstash'
      );
    });

    it('should stash and retry checkout when user selects "Stash & Switch"', async () => {
      const stashCalls: string[] = [];
      const checkoutCalls: string[] = [];
      let checkoutCallCount = 0;

      installWarningMessageTracker('Stash & Switch');
      installInfoMessageTracker();

      const gitService = createMockGitService({
        checkout: (_repo: IRepository, branchName: string) => {
          checkoutCallCount++;
          checkoutCalls.push(branchName);
          if (checkoutCallCount === 1) {
            return errAsync(
              new CommandFailedError(1, '', 'Your local changes would be overwritten by checkout')
            );
          }
          // Second call succeeds
          return okAsync(undefined);
        },
        stash: (_repo: IRepository, message?: string) => {
          stashCalls.push(message ?? '');
          return okAsync(undefined);
        },
        rebaseBranch: async (): Promise<IBasicRebaseResult> => ({ success: true }),
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/test');
      await driveBranchMenuCommand(commands, 'intellig.branch.checkoutAndRebase', item);

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
        checkout: (_repo: IRepository, _branchName: string, options?: ICheckoutOptions) => {
          checkoutCallCount++;
          if (checkoutCallCount === 1) {
            return errAsync(
              new CommandFailedError(1, '', 'Your local changes would be overwritten by checkout')
            );
          }
          if (options?.force) {
            forceUsed = true;
          }
          return okAsync(undefined);
        },
        rebaseBranch: async (): Promise<IBasicRebaseResult> => ({ success: true }),
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/test');
      await driveBranchMenuCommand(commands, 'intellig.branch.checkoutAndRebase', item);

      assert.ok(forceUsed, 'Force checkout should have been used');
    });

    it('rebases onto the prior COMMIT sha (not literal HEAD) when the prior HEAD was detached', async () => {
      installInfoMessageTracker();
      const rebaseTargets: string[] = [];
      const priorSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
      const gitService = createMockGitService({
        checkout: () => okAsync(undefined),
        rebaseBranch: async (_repo: IRepository, onto: string): Promise<IBasicRebaseResult> => {
          rebaseTargets.push(onto);
          return { success: true };
        },
      });
      const provider = new BranchTreeProvider(gitService);
      const detachedRepo = {
        rootUri: Uri.file('/test-repo'),
        state: 'idle',
        // Detached: no branch name, only a commit sha.
        head: { commit: priorSha, ahead: 0, behind: 0 },
        remotes: [],
        submodules: [],
      } as unknown as IRepository;
      provider.getRepository = (): IRepository => detachedRepo;
      const commands = new BranchContextMenuCommands(gitService, provider);

      await driveBranchMenuCommand(
        commands,
        'intellig.branch.checkoutAndRebase',
        createLocalBranchTreeItem('feature/x')
      );

      assert.deepStrictEqual(
        rebaseTargets,
        [priorSha],
        'must rebase onto the prior commit sha, not the literal HEAD (a no-op)'
      );
    });
  });

  // ─── Remote-branch checkout-and-rebase: avoid detached HEAD ──────────────
  //
  // Failure mode: right-clicking a remote branch (e.g. `origin/main`) and
  // choosing "Checkout and Rebase onto '{current}'" leaves the working copy at
  // a DETACHED HEAD if the handler runs `git checkout origin/main` directly. A
  // remote-tracking ref isn't a local branch — git resolves it and detaches
  // HEAD at the target commit.
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
      checkout: (
        repo: IRepository,
        ref: string,
        options?: ICheckoutOptions
      ) => ResultAsync<void, GitError>;
    } {
      const calls: CheckoutCall[] = [];
      return {
        calls,
        checkout: (_repo, ref, options) => {
          calls.push({ ref, options });
          return okAsync(undefined);
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
      await driveBranchMenuCommand(commands, 'intellig.branch.checkoutAndRebase', item);

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
      await driveBranchMenuCommand(commands, 'intellig.branch.checkoutAndRebase', item);

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
      await driveBranchMenuCommand(commands, 'intellig.branch.checkoutAndRebase', item);

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
        checkout: (_repo, ref, options) => {
          // First call (the entry-point checkout) fails "would be
          // overwritten"; subsequent calls (after stash) succeed and
          // record their args so we can verify the local-tracking form.
          if (throwOnce) {
            throwOnce = false;
            return errAsync(
              new CommandFailedError(
                1,
                '',
                'error: Your local changes to the following files would be overwritten by checkout'
              )
            );
          }
          calls.push({ ref, options });
          return okAsync(undefined);
        },
        rebaseBranch: async (): Promise<IBasicRebaseResult> => ({ success: true }),
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService, 'feature/test');
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createRemoteBranchTreeItem('origin/main');
      await driveBranchMenuCommand(commands, 'intellig.branch.checkoutAndRebase', item);

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
        checkout: (_repo, ref, options) => {
          if (throwOnce) {
            throwOnce = false;
            return errAsync(
              new CommandFailedError(
                1,
                '',
                'error: Your local changes to the following files would be overwritten by checkout'
              )
            );
          }
          calls.push({ ref, options });
          return okAsync(undefined);
        },
        rebaseBranch: async (): Promise<IBasicRebaseResult> => ({ success: true }),
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService, 'feature/test');
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createRemoteBranchTreeItem('origin/main');
      await driveBranchMenuCommand(commands, 'intellig.branch.checkoutAndRebase', item);

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
        checkout: () => okAsync(undefined),
        rebaseBranch: async (): Promise<IBasicRebaseResult> => ({
          success: false,
          conflicts: ['file1.ts', 'file2.ts', 'file3.ts'],
          rebaseInProgress: true,
        }),
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/test');
      await driveBranchMenuCommand(commands, 'intellig.branch.checkoutAndRebase', item);

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
      await driveBranchMenuCommand(commands, 'intellig.branch.mergeIntoCurrent', item);

      assert.ok(
        warningTracker.calls.length > 0,
        'showWarningMessage should have been called for merge conflicts'
      );
      const msg = warningTracker.calls[0].message;
      assert.ok(msg.includes('2'), `Warning should contain conflict count 2, got: "${msg}"`);
    });

    it('_handleTagMergeIntoCurrent should merge using the tag ref as the source', async () => {
      const infoTracker = installInfoMessageTracker();
      let mergedRef: string | undefined;

      const gitService = createMockGitService({
        mergeBranch: async (_repo, ref) => {
          mergedRef = ref;
          return { success: true };
        },
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      // No merge-dialog opener wired → exercises the direct-merge fallback,
      // which is where the tag ref reaches `mergeBranch`.
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createTagTreeItem('v1.2.0');
      await driveBranchMenuCommand(commands, 'intellig.tag.mergeIntoCurrent', item);

      assert.strictEqual(mergedRef, 'v1.2.0', 'merge source should be the tag ref');
      assert.ok(
        infoTracker.calls.some((c) => c.message.includes('v1.2.0')),
        'success toast should mention the tag'
      );
    });

    it('_handleTagMergeIntoCurrent should show warning with conflict count', async () => {
      const warningTracker = installWarningMessageTracker();

      const gitService = createMockGitService({
        mergeBranch: async () => ({
          success: false,
          conflicts: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
        }),
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createTagTreeItem('v2.0.0');
      await driveBranchMenuCommand(commands, 'intellig.tag.mergeIntoCurrent', item);

      assert.ok(
        warningTracker.calls.length > 0,
        'showWarningMessage should have been called for tag merge conflicts'
      );
      const msg = warningTracker.calls[0].message;
      assert.ok(msg.includes('3'), `Warning should contain conflict count 3, got: "${msg}"`);
    });

    it('_handleTagCherryPick cherry-picks the tag commit and toasts success', async () => {
      const infoTracker = installInfoMessageTracker();
      let pickedHashes: string[] | undefined;
      const gitService = createMockGitService({
        cherryPick: (_repo, hashes) => {
          pickedHashes = hashes;
          return okAsync({ success: true });
        },
      });
      const commands = new BranchContextMenuCommands(
        gitService,
        createMockBranchTreeProvider(gitService)
      );

      await driveBranchMenuCommand(
        commands,
        'intellig.tag.cherryPick',
        createTagTreeItem('v3.0.0')
      );

      assert.deepStrictEqual(pickedHashes, ['abc1234'], 'cherry-pick targets the tag commit');
      assert.ok(
        infoTracker.calls.some((c) => c.message.includes('v3.0.0')),
        'success toast should mention the tag'
      );
    });

    it('_handleTagCherryPick routes conflicts into the Resolve Conflicts dialog (operation: cherryPick)', async () => {
      const dialogOpens: Array<{ operation: string; target?: string }> = [];
      const conflictService = {
        getConflictedFiles: async () => [{ path: 'a.ts', resolved: false }],
        openResolveConflictsDialog: async (
          _repo: unknown,
          _conflicts: unknown,
          opContext: { operation: string; target?: string }
        ) => {
          dialogOpens.push({ operation: opContext.operation, target: opContext.target });
        },
      } as unknown as IConflictResolutionService;
      const gitService = createMockGitService({
        cherryPick: () => okAsync({ success: false, conflicts: ['a.ts', 'b.ts'] }),
      });
      const commands = new BranchContextMenuCommands(
        gitService,
        createMockBranchTreeProvider(gitService),
        conflictService
      );

      await driveBranchMenuCommand(
        commands,
        'intellig.tag.cherryPick',
        createTagTreeItem('v3.1.0')
      );

      assert.deepStrictEqual(dialogOpens, [{ operation: 'cherryPick', target: 'v3.1.0' }]);
    });

    it('_handleTagCherryPick warns with the conflict count when no conflict dialog is wired', async () => {
      const warningTracker = installWarningMessageTracker();
      const gitService = createMockGitService({
        cherryPick: () => okAsync({ success: false, conflicts: ['a.ts', 'b.ts'] }),
      });
      const commands = new BranchContextMenuCommands(
        gitService,
        createMockBranchTreeProvider(gitService)
      );

      await driveBranchMenuCommand(
        commands,
        'intellig.tag.cherryPick',
        createTagTreeItem('v3.2.0')
      );

      assert.ok(warningTracker.calls.length > 0, 'a conflict without a dialog must warn');
      assert.ok(
        warningTracker.calls[0].message.includes('2'),
        `warning should carry the conflict count 2, got: "${warningTracker.calls[0].message}"`
      );
    });

    it('_handleTagMergeIntoCurrent routes conflicts into the Resolve Conflicts dialog (operation: merge)', async () => {
      const dialogOpens: Array<{ operation: string; target?: string }> = [];
      const conflictService = {
        getConflictedFiles: async () => [{ path: 'a.ts', resolved: false }],
        openResolveConflictsDialog: async (
          _repo: unknown,
          _conflicts: unknown,
          opContext: { operation: string; target?: string }
        ) => {
          dialogOpens.push({ operation: opContext.operation, target: opContext.target });
        },
      } as unknown as IConflictResolutionService;
      const gitService = createMockGitService({
        mergeBranch: async () => ({ success: false, conflicts: ['a.ts'] }),
      });
      const commands = new BranchContextMenuCommands(
        gitService,
        createMockBranchTreeProvider(gitService),
        conflictService
      );

      await driveBranchMenuCommand(
        commands,
        'intellig.tag.mergeIntoCurrent',
        createTagTreeItem('v4.0.0')
      );

      assert.deepStrictEqual(dialogOpens, [{ operation: 'merge', target: 'v4.0.0' }]);
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
      await driveBranchMenuCommand(commands, 'intellig.branch.rebaseCurrentOnto', item);

      assert.ok(
        warningTracker.calls.length > 0,
        'showWarningMessage should have been called for rebase conflicts'
      );
      const msg = warningTracker.calls[0].message;
      assert.ok(msg.includes('1'), `Warning should contain conflict count 1, got: "${msg}"`);
    });

    // ─── #25: branch-menu rebase routes through the unified dialog ────────
    //
    // When a rebase-dialog opener is wired (production), the branch-menu
    // "Rebase Current onto X" must DELEGATE to it (onto = the clicked
    // branch, Interactive unchecked) and NOT run the inline rebaseBranch
    // path. The inline path remains only as the no-opener fallback the
    // other tests in this file exercise.
    it('_handleRebaseCurrentOnto delegates to the rebase dialog opener when wired (no direct rebaseBranch)', async () => {
      const gitService = createMockGitService({
        rebaseBranch: async (): Promise<IBasicRebaseResult> => {
          throw new Error('rebaseBranch must NOT run when the dialog opener is wired');
        },
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const openerCalls: Array<{ onto?: string; interactiveDefault?: boolean }> = [];
      const commands = new BranchContextMenuCommands(
        gitService,
        branchTreeProvider,
        undefined, // conflictResolutionService
        undefined, // pullDialogAccessor
        undefined, // pushDialogOpener
        undefined, // mergeDialogOpener
        undefined, // newBranchDialogOpener
        async (preselect: { onto?: string; interactiveDefault?: boolean }) => {
          openerCalls.push(preselect);
          return undefined;
        }
      );

      const item = createLocalBranchTreeItem('feature/rebase-test');
      await driveBranchMenuCommand(commands, 'intellig.branch.rebaseCurrentOnto', item);

      assert.strictEqual(openerCalls.length, 1, 'rebase dialog opener invoked exactly once');
      assert.strictEqual(
        openerCalls[0].onto,
        'feature/rebase-test',
        'preselects the clicked branch as the onto target'
      );
      assert.strictEqual(
        openerCalls[0].interactiveDefault,
        false,
        'branch-menu rebase defaults to non-interactive'
      );
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
        // Dirty working tree.
        getStatus: async () => dirtyStatus,
        rebaseBranch: async (): Promise<IBasicRebaseResult> => {
          rebaseCalls++;
          return { success: true };
        },
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/rebase-target');
      await driveBranchMenuCommand(commands, 'intellig.branch.rebaseCurrentOnto', item);

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
      await driveBranchMenuCommand(commands, 'intellig.branch.rebaseCurrentOnto', item);

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
      await driveBranchMenuCommand(commands, 'intellig.branch.mergeIntoCurrent', item);

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
          cherryPick: () =>
            okAsync({
              success: false,
              conflicts: [],
              failureReason: 'fatal: bad object abc1234',
            }),
        });
        const branchTreeProvider = createMockBranchTreeProvider(gitService);
        const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

        const item = createRemoteBranchTreeItem('origin/feature/x');
        await driveBranchMenuCommand(commands, 'intellig.remoteBranch.cherryPickCommits', item);

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

    it('_handleCherryPickCommits routes conflicts into the Resolve Conflicts dialog (operation: cherryPick)', async () => {
      const w = writableWindow();
      const originalQuickPick = w.showQuickPick;
      w.showQuickPick = (items: unknown): Promise<unknown> =>
        Array.isArray(items) && items.length > 0
          ? Promise.resolve(items.slice(0, 1))
          : Promise.resolve(undefined);
      try {
        const dialogOpens: Array<{ operation: string; target?: string }> = [];
        const conflictService = {
          getConflictedFiles: async () => [{ path: 'a.ts', resolved: false }],
          openResolveConflictsDialog: async (
            _repo: unknown,
            _conflicts: unknown,
            opContext: { operation: string; target?: string }
          ) => {
            dialogOpens.push({ operation: opContext.operation, target: opContext.target });
          },
        } as unknown as IConflictResolutionService;
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
          cherryPick: () => okAsync({ success: false, conflicts: ['a.ts', 'b.ts'] }),
        });
        const commands = new BranchContextMenuCommands(
          gitService,
          createMockBranchTreeProvider(gitService),
          conflictService
        );

        await driveBranchMenuCommand(
          commands,
          'intellig.remoteBranch.cherryPickCommits',
          createRemoteBranchTreeItem('origin/feature/x')
        );

        assert.deepStrictEqual(dialogOpens, [
          { operation: 'cherryPick', target: 'origin/feature/x' },
        ]);
      } finally {
        w.showQuickPick = originalQuickPick;
      }
    });

    it('_handleCherryPickCommits warns with the conflict count when no conflict dialog is wired', async () => {
      const warningTracker = installWarningMessageTracker();
      const w = writableWindow();
      const originalQuickPick = w.showQuickPick;
      w.showQuickPick = (items: unknown): Promise<unknown> =>
        Array.isArray(items) && items.length > 0
          ? Promise.resolve(items.slice(0, 1))
          : Promise.resolve(undefined);
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
          cherryPick: () => okAsync({ success: false, conflicts: ['a.ts', 'b.ts'] }),
        });
        const commands = new BranchContextMenuCommands(
          gitService,
          createMockBranchTreeProvider(gitService)
        );

        await driveBranchMenuCommand(
          commands,
          'intellig.remoteBranch.cherryPickCommits',
          createRemoteBranchTreeItem('origin/feature/x')
        );

        assert.ok(warningTracker.calls.length > 0, 'a conflict without a dialog must warn');
        assert.ok(
          warningTracker.calls[0].message.includes('2'),
          `warning should carry the conflict count 2, got: "${warningTracker.calls[0].message}"`
        );
      } finally {
        w.showQuickPick = originalQuickPick;
      }
    });

    // There is no `_parseConflictCount` fallback to test: the
    // pull-throws-with-CONFLICT-markers branch does not stringify a
    // count out of the error text. When `_conflictResolutionService` is
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
        checkout: () => errAsync(new CommandFailedError(1, '', WORKTREE_FATAL)),
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/test');
      await driveBranchMenuCommand(commands, 'intellig.branch.checkout', item);

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
        checkout: () => errAsync(new CommandFailedError(1, '', WORKTREE_FATAL)),
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/test');
      await driveBranchMenuCommand(commands, 'intellig.branch.checkoutAndRebase', item);

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
        checkout: () =>
          errAsync(
            new CommandFailedError(
              1,
              '',
              "fatal: 'main' is already used by worktree at '/repos/proj-feature'"
            )
          ),
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createRemoteBranchTreeItem('origin/main');
      await driveBranchMenuCommand(commands, 'intellig.remoteBranch.checkoutAsLocal', item);

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
        checkout: () =>
          errAsync(new CommandFailedError(1, '', 'fatal: invalid reference: nonexistent-branch')),
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('nonexistent-branch');
      await driveBranchMenuCommand(commands, 'intellig.branch.checkout', item);

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

  // ─── _handleCheckout dirty-tree Stash/Force paths ────────────────────────
  //
  // Characterization tests that pin the Stash & Switch and Force Checkout
  // paths for _handleCheckout and _handleCheckoutAsLocal. These paths existed
  // before the _handleDirtyTreeError refactor and must continue to behave
  // identically after it.

  describe('_handleCheckout: dirty-tree Stash & Switch and Force Checkout paths', () => {
    it('Stash & Switch calls stash then checkout and shows success toast', async () => {
      const stashCalls: string[] = [];
      let checkoutCount = 0;
      const infoTracker = installInfoMessageTracker();
      installWarningMessageTracker('Stash & Switch');

      const gitService = createMockGitService({
        checkout: (_repo: IRepository, _ref: string) => {
          checkoutCount++;
          if (checkoutCount === 1) {
            return errAsync(
              new CommandFailedError(1, '', 'Your local changes would be overwritten by checkout')
            );
          }
          return okAsync(undefined);
        },
        stash: (_repo: IRepository, message?: string) => {
          stashCalls.push(message ?? '');
          return okAsync(undefined);
        },
      });
      const provider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, provider);

      await driveBranchMenuCommand(
        commands,
        'intellig.branch.checkout',
        createLocalBranchTreeItem('feat/x')
      );

      assert.strictEqual(stashCalls.length, 1, 'stash must be called once');
      assert.ok(stashCalls[0].includes('feat/x'), 'stash label references the branch');
      assert.strictEqual(checkoutCount, 2, 'checkout called twice (fail + retry)');
      assert.strictEqual(infoTracker.calls.length, 1, 'success toast shown');
      assert.ok(
        infoTracker.calls[0].message.includes('feat/x'),
        `success toast references branch; got: "${infoTracker.calls[0].message}"`
      );
    });

    it('Force Checkout calls checkout with force option and shows success toast', async () => {
      let checkoutCount = 0;
      let forceUsed = false;
      const infoTracker = installInfoMessageTracker();
      installWarningMessageTracker('Force Checkout');

      const gitService = createMockGitService({
        checkout: (_repo: IRepository, _ref: string, options?: ICheckoutOptions) => {
          checkoutCount++;
          if (checkoutCount === 1) {
            return errAsync(
              new CommandFailedError(1, '', 'Your local changes would be overwritten by checkout')
            );
          }
          if (options?.force) {
            forceUsed = true;
          }
          return okAsync(undefined);
        },
      });
      const provider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, provider);

      await driveBranchMenuCommand(
        commands,
        'intellig.branch.checkout',
        createLocalBranchTreeItem('feat/x')
      );

      assert.ok(forceUsed, 'second checkout must use force option');
      assert.strictEqual(infoTracker.calls.length, 1, 'success toast shown');
    });
  });

  describe('_handleCheckoutAsLocal: dirty-tree Stash & Switch and Force Checkout paths', () => {
    it('Stash & Switch calls stash then forceCreate checkout and shows success toast', async () => {
      const stashCalls: string[] = [];
      let checkoutCount = 0;
      let forceCreateUsed = false;
      const infoTracker = installInfoMessageTracker();
      installWarningMessageTracker('Stash & Switch');

      const gitService = createMockGitService({
        getBranches: async () => [],
        checkout: (_repo: IRepository, _ref: string, options?: ICheckoutOptions) => {
          checkoutCount++;
          if (checkoutCount === 1) {
            return errAsync(
              new CommandFailedError(1, '', 'Your local changes would be overwritten by checkout')
            );
          }
          if (options?.forceCreate) {
            forceCreateUsed = true;
          }
          return okAsync(undefined);
        },
        stash: (_repo: IRepository, message?: string) => {
          stashCalls.push(message ?? '');
          return okAsync(undefined);
        },
      });
      const provider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, provider);

      await driveBranchMenuCommand(
        commands,
        'intellig.remoteBranch.checkoutAsLocal',
        createRemoteBranchTreeItem('origin/feat-y')
      );

      assert.strictEqual(stashCalls.length, 1, 'stash must be called once');
      assert.ok(stashCalls[0].includes('feat-y'), 'stash label references the branch name');
      assert.ok(forceCreateUsed, 'stash+checkout must use forceCreate');
      assert.strictEqual(infoTracker.calls.length, 1, 'success toast shown');
    });

    it('Force Checkout calls checkout with force + forceCreate and shows success toast', async () => {
      let checkoutCount = 0;
      let forceUsed = false;
      let forceCreateUsed = false;
      const infoTracker = installInfoMessageTracker();
      installWarningMessageTracker('Force Checkout');

      const gitService = createMockGitService({
        getBranches: async () => [],
        checkout: (_repo: IRepository, _ref: string, options?: ICheckoutOptions) => {
          checkoutCount++;
          if (checkoutCount === 1) {
            return errAsync(
              new CommandFailedError(1, '', 'Your local changes would be overwritten by checkout')
            );
          }
          if (options?.force) {
            forceUsed = true;
          }
          if (options?.forceCreate) {
            forceCreateUsed = true;
          }
          return okAsync(undefined);
        },
      });
      const provider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, provider);

      await driveBranchMenuCommand(
        commands,
        'intellig.remoteBranch.checkoutAsLocal',
        createRemoteBranchTreeItem('origin/feat-y')
      );

      assert.ok(forceUsed, 'second checkout must use force option');
      assert.ok(forceCreateUsed, 'second checkout must use forceCreate option');
      assert.strictEqual(infoTracker.calls.length, 1, 'success toast shown');
    });
  });

  // ─── General Error Handling ─────────────────────────────

  describe('General error handling', () => {
    it('_handleUpdate should show error message when fetch fails (current branch)', async () => {
      const errorTracker = installErrorMessageTracker();

      const gitService = createMockGitService({
        fetch: () => {
          return errAsync(new SpawnFailedError('Network error: could not resolve host'));
        },
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      // The current branch keeps the plain prune-fetch path whose failure is
      // an error toast; a non-current branch routes through align-local where
      // a failed FF fetch is reported as a skip warning (covered in
      // branchAlignLocal.test.ts).
      const item = createLocalBranchTreeItem('main', { remote: 'origin', name: 'main' }, true);
      await driveBranchMenuCommand(commands, 'intellig.branch.update', item);

      assert.ok(errorTracker.calls.length > 0, 'showErrorMessage should have been called');
      assert.ok(
        errorTracker.calls[0].message.includes('Network error'),
        `Error message should contain the error text, got: "${errorTracker.calls[0].message}"`
      );
    });

    it('_handlePush should show error message when push fails', async () => {
      const errorTracker = installErrorMessageTracker();

      const gitService = createMockGitService({
        push: () => {
          return errAsync(new SpawnFailedError('rejected: non-fast-forward'));
        },
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('main', { remote: 'origin', name: 'main' });
      await driveBranchMenuCommand(commands, 'intellig.branch.push', item);

      assert.ok(errorTracker.calls.length > 0, 'showErrorMessage should have been called');
      assert.ok(
        errorTracker.calls[0].message.includes('rejected'),
        `Error message should contain the error text, got: "${errorTracker.calls[0].message}"`
      );
    });

    it('_handleCheckoutAndRebase should show error for non-uncommitted-changes errors', async () => {
      const errorTracker = installErrorMessageTracker();

      const gitService = createMockGitService({
        checkout: () =>
          errAsync(new CommandFailedError(1, '', 'fatal: invalid reference: nonexistent-branch')),
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('nonexistent-branch');
      await driveBranchMenuCommand(commands, 'intellig.branch.checkoutAndRebase', item);

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
      await driveBranchMenuCommand(commands, 'intellig.branch.update', item);

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
        push: (_repo: IRepository, options?: IPushOptions) => {
          pushOptions = options;
          return okAsync(undefined);
        },
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      // Create branch without upstream
      const item = createLocalBranchTreeItem('feature/no-upstream');
      await driveBranchMenuCommand(commands, 'intellig.branch.push', item);

      assert.ok(pushOptions !== undefined, 'push should have been called');
      assert.strictEqual(
        pushOptions?.setUpstream,
        true,
        'push should be called with setUpstream: true when no upstream'
      );
    });
  });

  // Every BranchContextMenuCommands action-path catch
  // block must run the raw git stderr through `sanitizeGitError`. This
  // file has 21 such sites (checkout / merge / rebase / push / pull /
  // delete / rename / create / etc.) — instead of a per-site spec we
  // pin the bug class on a representative call (`_handlePush` reaches
  // the ${errorMessage} template at line 648). The other 20 sites
  // share the identical pattern; a CI grep audit (post-publish backlog)
  // would catch any future regression that drops the sanitiser.
  describe('error toast sanitization (representative)', () => {
    it('_handlePush sanitizes credentialed URL + home path in error toast', async () => {
      const RAW = 'fail: https://alice:secret@example.com/repo.git\n/Users/alice/project';
      const EXPECTED = 'fail: https://<redacted>@example.com/repo.git\n~/project';
      const errorTracker = installErrorMessageTracker();

      const gitService = createMockGitService({
        push: () => {
          return errAsync(new SpawnFailedError(RAW));
        },
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('main', { remote: 'origin', name: 'main' });
      await driveBranchMenuCommand(commands, 'intellig.branch.push', item);

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
        deleteBranch: (_repo, name, force) => {
          deleteCalls.push({ name, force });
          if (force === true) {
            return okAsync(undefined); // success
          }
          return errAsync(
            new CommandFailedError(
              1,
              '',
              "error: the branch 'test-branch' is not fully merged.\n" +
                "If you are sure you want to delete it, run 'git branch -D test-branch'."
            )
          );
        },
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const warnTracker = installSequencedWarningTracker(['Delete', 'Force Delete']);
      const infoTracker = installInfoMessageTracker();
      const errTracker = installErrorMessageTracker();

      const item = createLocalBranchTreeItem('test-branch');
      await driveBranchMenuCommand(commands, 'intellig.branch.delete', item);

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
        deleteBranch: (_repo, _name, force) => {
          deleteCalls.push({ force });
          return errAsync(
            new CommandFailedError(1, '', "error: the branch 'test-branch' is not fully merged.")
          );
        },
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      installSequencedWarningTracker(['Delete', undefined]); // user dismisses force prompt
      const errTracker = installErrorMessageTracker();
      const infoTracker = installInfoMessageTracker();

      const item = createLocalBranchTreeItem('test-branch');
      await driveBranchMenuCommand(commands, 'intellig.branch.delete', item);

      assert.strictEqual(deleteCalls.length, 1, 'no retry attempted on cancel');
      assert.strictEqual(infoTracker.calls.length, 0, 'no success toast on cancel');
      assert.strictEqual(
        errTracker.calls.length,
        0,
        'no error toast either — cancel is a quiet no-op'
      );
    });

    it('deletes nothing when the initial confirm is dismissed', async () => {
      const deleteCalls: Array<{ force?: boolean }> = [];
      const gitService = createMockGitService({
        getRepositories: () => [repo],
        getRepository: async () => repo,
        deleteBranch: (_repo, _name, force) => {
          deleteCalls.push({ force });
          return okAsync(undefined);
        },
      });
      const commands = new BranchContextMenuCommands(
        gitService,
        createMockBranchTreeProvider(gitService)
      );
      installSequencedWarningTracker([undefined]); // user dismisses the delete confirm

      const item = createLocalBranchTreeItem('test-branch');
      await driveBranchMenuCommand(commands, 'intellig.branch.delete', item);

      assert.strictEqual(deleteCalls.length, 0, 'a dismissed confirm must not delete the branch');
    });

    it('shows the original error toast for non-merge failures (no force prompt)', async () => {
      const gitService = createMockGitService({
        getRepositories: () => [repo],
        getRepository: async () => repo,
        deleteBranch: () =>
          errAsync(new CommandFailedError(1, '', "error: branch 'test-branch' not found.")),
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const warnTracker = installSequencedWarningTracker(['Delete']);
      const errTracker = installErrorMessageTracker();

      const item = createLocalBranchTreeItem('test-branch');
      await driveBranchMenuCommand(commands, 'intellig.branch.delete', item);

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
      await driveBranchMenuCommand(commands, 'intellig.branch.rebaseCurrentOnto', item);

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
      await driveBranchMenuCommand(commands, 'intellig.branch.rebaseCurrentOnto', item);

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
        rebaseAbort: () => {
          abortCalled = true;
          events.push('rebaseAbort');
          return okAsync(undefined);
        },
      });
      // before.inProgress is absent → our call created the rebasing state.
      const branchTreeProvider = providerWithInProgress(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/rebase-target');
      await driveBranchMenuCommand(commands, 'intellig.branch.rebaseCurrentOnto', item);

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
        rebaseAbort: () => {
          abortCalled = true;
          return okAsync(undefined);
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
      await driveBranchMenuCommand(commands, 'intellig.branch.rebaseCurrentOnto', item);

      assert.strictEqual(
        abortCalled,
        false,
        'rebaseAbort MUST NOT run when the user already had a rebase in progress before clicking'
      );
    });
  });
});

describe('Branch Context Menu - multi-select delete batches', () => {
  const repo: IRepository = {
    rootUri: Uri.file('/test/repo'),
    state: 'idle',
    head: undefined,
    remotes: [],
    submodules: [],
  } as unknown as IRepository;

  function installSequencedWarningTracker(responses: Array<string | undefined>): {
    calls: MessageCall[];
  } {
    const calls: MessageCall[] = [];
    let i = 0;
    writableWindow().showWarningMessage = (
      message: string,
      ...items: unknown[]
    ): Promise<string | undefined> => {
      const stringItems = items.filter((it): it is string => typeof it === 'string');
      calls.push({ message, items: stringItems });
      const reply = responses[i] ?? undefined;
      i += 1;
      return Promise.resolve(reply);
    };
    return { calls };
  }

  it('deletes every selected branch after ONE batch confirm naming them all', async () => {
    const deleted: string[] = [];
    const gitService = createMockGitService({
      getRepositories: () => [repo],
      getRepository: async () => repo,
      deleteBranch: (_repo, name) => {
        deleted.push(name);
        return okAsync(undefined);
      },
    });
    const branchTreeProvider = createMockBranchTreeProvider(gitService);
    const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

    const warnTracker = installSequencedWarningTracker(['Delete']);
    const infoTracker = installInfoMessageTracker();
    const errTracker = installErrorMessageTracker();

    const a = createLocalBranchTreeItem('feature/a');
    const b = createLocalBranchTreeItem('feature/b');
    const c = createLocalBranchTreeItem('feature/c');
    await driveBranchMenuCommand(commands, 'intellig.branch.delete', a, [a, b, c]);

    assert.deepStrictEqual(deleted, ['feature/a', 'feature/b', 'feature/c']);
    assert.strictEqual(warnTracker.calls.length, 1, 'exactly one batch confirm');
    assert.ok(
      warnTracker.calls[0].message.includes('3 branches'),
      `confirm must state the count; got "${warnTracker.calls[0].message}"`
    );
    for (const name of ['feature/a', 'feature/b', 'feature/c']) {
      assert.ok(
        warnTracker.calls[0].message.includes(name),
        `confirm must name ${name}; got "${warnTracker.calls[0].message}"`
      );
    }
    assert.strictEqual(infoTracker.calls.length, 1, 'one summary toast');
    assert.ok(
      infoTracker.calls[0].message.includes('3'),
      `summary states the count; got "${infoTracker.calls[0].message}"`
    );
    assert.strictEqual(errTracker.calls.length, 0);
  });

  it('a cancelled batch confirm deletes nothing', async () => {
    const deleted: string[] = [];
    const gitService = createMockGitService({
      getRepositories: () => [repo],
      getRepository: async () => repo,
      deleteBranch: (_repo, name) => {
        deleted.push(name);
        return okAsync(undefined);
      },
    });
    const branchTreeProvider = createMockBranchTreeProvider(gitService);
    const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

    installSequencedWarningTracker([undefined]);
    const a = createLocalBranchTreeItem('feature/a');
    const b = createLocalBranchTreeItem('feature/b');
    await driveBranchMenuCommand(commands, 'intellig.branch.delete', a, [a, b]);

    assert.deepStrictEqual(deleted, []);
  });

  it('collects not-fully-merged branches into ONE force prompt after the batch', async () => {
    const deleteCalls: Array<{ name: string; force?: boolean }> = [];
    const gitService = createMockGitService({
      getRepositories: () => [repo],
      getRepository: async () => repo,
      deleteBranch: (_repo, name, force) => {
        deleteCalls.push({ name, force });
        if (name === 'feature/unmerged' && force !== true) {
          return errAsync(
            new CommandFailedError(
              1,
              '',
              "error: the branch 'feature/unmerged' is not fully merged."
            )
          );
        }
        return okAsync(undefined);
      },
    });
    const branchTreeProvider = createMockBranchTreeProvider(gitService);
    const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

    const warnTracker = installSequencedWarningTracker(['Delete', 'Force Delete']);
    const infoTracker = installInfoMessageTracker();
    const errTracker = installErrorMessageTracker();

    const a = createLocalBranchTreeItem('feature/a');
    const u = createLocalBranchTreeItem('feature/unmerged');
    await driveBranchMenuCommand(commands, 'intellig.branch.delete', a, [a, u]);

    assert.deepStrictEqual(deleteCalls, [
      { name: 'feature/a', force: undefined },
      { name: 'feature/unmerged', force: undefined },
      { name: 'feature/unmerged', force: true },
    ]);
    assert.strictEqual(warnTracker.calls.length, 2, 'batch confirm + one force prompt');
    assert.ok(
      warnTracker.calls[1].message.includes('feature/unmerged'),
      `force prompt names the unmerged branch; got "${warnTracker.calls[1].message}"`
    );
    assert.ok(warnTracker.calls[1].items.includes('Force Delete'));
    assert.strictEqual(errTracker.calls.length, 0);
    assert.ok(infoTracker.calls.length >= 1, 'summary toast after the batch');
  });

  it('declining the batch force prompt keeps the merged deletions and skips the rest quietly', async () => {
    const deleteCalls: Array<{ name: string; force?: boolean }> = [];
    const gitService = createMockGitService({
      getRepositories: () => [repo],
      getRepository: async () => repo,
      deleteBranch: (_repo, name, force) => {
        deleteCalls.push({ name, force });
        if (name === 'feature/unmerged' && force !== true) {
          return errAsync(
            new CommandFailedError(
              1,
              '',
              "error: the branch 'feature/unmerged' is not fully merged."
            )
          );
        }
        return okAsync(undefined);
      },
    });
    const branchTreeProvider = createMockBranchTreeProvider(gitService);
    const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

    installSequencedWarningTracker(['Delete', undefined]);
    const errTracker = installErrorMessageTracker();

    const a = createLocalBranchTreeItem('feature/a');
    const u = createLocalBranchTreeItem('feature/unmerged');
    await driveBranchMenuCommand(commands, 'intellig.branch.delete', a, [a, u]);

    assert.deepStrictEqual(deleteCalls, [
      { name: 'feature/a', force: undefined },
      { name: 'feature/unmerged', force: undefined },
    ]);
    assert.strictEqual(errTracker.calls.length, 0, 'declining force is a quiet skip');
  });

  it('a non-merge failure mid-batch is collected into one error toast; the rest still delete', async () => {
    const deleted: string[] = [];
    const gitService = createMockGitService({
      getRepositories: () => [repo],
      getRepository: async () => repo,
      deleteBranch: (_repo, name) => {
        if (name === 'feature/current') {
          return errAsync(
            new CommandFailedError(
              1,
              '',
              "error: Cannot delete branch 'feature/current' checked out at '/test/repo'"
            )
          );
        }
        deleted.push(name);
        return okAsync(undefined);
      },
    });
    const branchTreeProvider = createMockBranchTreeProvider(gitService);
    const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

    installSequencedWarningTracker(['Delete']);
    const errTracker = installErrorMessageTracker();

    const a = createLocalBranchTreeItem('feature/a');
    const cur = createLocalBranchTreeItem('feature/current');
    const b = createLocalBranchTreeItem('feature/b');
    await driveBranchMenuCommand(commands, 'intellig.branch.delete', a, [a, cur, b]);

    assert.deepStrictEqual(deleted, ['feature/a', 'feature/b'], 'others still delete');
    assert.strictEqual(errTracker.calls.length, 1, 'one collected error toast');
    assert.ok(
      errTracker.calls[0].message.includes('feature/current'),
      `error toast names the failed branch; got "${errTracker.calls[0].message}"`
    );
  });

  it('single-branch click keeps the existing single-delete wording', async () => {
    const gitService = createMockGitService({
      getRepositories: () => [repo],
      getRepository: async () => repo,
      deleteBranch: () => okAsync(undefined),
    });
    const branchTreeProvider = createMockBranchTreeProvider(gitService);
    const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

    const warnTracker = installSequencedWarningTracker(['Delete']);
    const infoTracker = installInfoMessageTracker();

    const a = createLocalBranchTreeItem('feature/solo');
    await driveBranchMenuCommand(commands, 'intellig.branch.delete', a, [a]);

    assert.ok(
      warnTracker.calls[0].message.includes("the branch 'feature/solo'"),
      `single wording preserved; got "${warnTracker.calls[0].message}"`
    );
    assert.ok(infoTracker.calls[0].message.includes("Deleted branch 'feature/solo'"));
  });

  it('deletes every selected tag after ONE batch confirm', async () => {
    const deleted: string[] = [];
    const gitService = createMockGitService({
      getRepositories: () => [repo],
      getRepository: async () => repo,
      deleteTag: (_repo, name) => {
        deleted.push(name);
        return okAsync(undefined);
      },
    });
    const branchTreeProvider = createMockBranchTreeProvider(gitService);
    const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

    const warnTracker = installSequencedWarningTracker(['Delete']);
    const infoTracker = installInfoMessageTracker();

    const t1 = createTagTreeItem('v1.0.0');
    const t2 = createTagTreeItem('v1.1.0');
    await driveBranchMenuCommand(commands, 'intellig.tag.delete', t1, [t1, t2]);

    assert.deepStrictEqual(deleted, ['v1.0.0', 'v1.1.0']);
    assert.strictEqual(warnTracker.calls.length, 1);
    assert.ok(
      warnTracker.calls[0].message.includes('2 tags'),
      `tag confirm states the count; got "${warnTracker.calls[0].message}"`
    );
    assert.strictEqual(infoTracker.calls.length, 1, 'one summary toast');
  });
});

describe('Tag delete — remote-delete affordance (IntelliJ GitDeleteTagOperation parity)', () => {
  const repoWithRemote: IRepository = {
    rootUri: Uri.file('/test/repo'),
    state: 'idle',
    head: undefined,
    remotes: [{ name: 'origin' }],
    submodules: [],
  };
  const repoNoRemote: IRepository = { ...repoWithRemote, remotes: [] };

  // The success toast + remote-delete offer is fired-and-forgotten by the
  // command so it never holds the command (and its tree refresh) pending on a
  // toast; drain the microtask queue so the async offer chain settles.
  async function flush(): Promise<void> {
    for (let i = 0; i < 5; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  function installInfoTracker(choice?: string): { calls: { message: string; items: string[] }[] } {
    const calls: { message: string; items: string[] }[] = [];
    writableWindow().showInformationMessage = (
      message: string,
      ...items: string[]
    ): Promise<string | undefined> => {
      calls.push({ message, items });
      return Promise.resolve(choice);
    };
    return { calls };
  }

  afterEach(() => {
    restoreMessageFunctions();
  });

  it('offers "Delete on Remote" after a local tag delete when the repo has a remote', async () => {
    const deleteRemoteCalls: { name: string; remote: string }[] = [];
    const gitService = createMockGitService({
      getRepositories: () => [repoWithRemote],
      getRepository: async () => repoWithRemote,
      deleteTag: () => okAsync(undefined),
      getRemotes: () => okAsync([{ name: 'origin' }]),
      deleteRemoteTag: (_repo, name, remote) => {
        deleteRemoteCalls.push({ name, remote: remote ?? 'origin' });
        return okAsync(undefined);
      },
    });
    const btp = createMockBranchTreeProvider(gitService);
    btp.getRepository = () => repoWithRemote; // repo is resolved via the tree provider
    const commands = new BranchContextMenuCommands(gitService, btp);
    installWarningMessageTracker('Delete'); // confirm the local delete
    const info = installInfoTracker(undefined); // user dismisses the offer

    const t = createTagTreeItem('v1.0.0');
    await driveBranchMenuCommand(commands, 'intellig.tag.delete', t, [t]);
    await flush();

    assert.strictEqual(info.calls.length, 1, 'one success toast');
    assert.ok(
      info.calls[0].items.includes('Delete on Remote'),
      `success toast offers "Delete on Remote"; got items ${JSON.stringify(info.calls[0].items)}`
    );
    assert.strictEqual(deleteRemoteCalls.length, 0, 'no remote delete unless the offer is clicked');
  });

  it('deletes the tag on the remote when the user clicks the offer', async () => {
    const deleteRemoteCalls: { name: string; remote: string }[] = [];
    const gitService = createMockGitService({
      getRepositories: () => [repoWithRemote],
      getRepository: async () => repoWithRemote,
      deleteTag: () => okAsync(undefined),
      getRemotes: () => okAsync([{ name: 'origin' }]),
      deleteRemoteTag: (_repo, name, remote) => {
        deleteRemoteCalls.push({ name, remote: remote ?? 'origin' });
        return okAsync(undefined);
      },
    });
    const btp = createMockBranchTreeProvider(gitService);
    btp.getRepository = () => repoWithRemote;
    const commands = new BranchContextMenuCommands(gitService, btp);
    installWarningMessageTracker('Delete');
    installInfoTracker('Delete on Remote'); // user clicks the offer

    const t = createTagTreeItem('v1.0.0');
    await driveBranchMenuCommand(commands, 'intellig.tag.delete', t, [t]);
    await flush();

    assert.deepStrictEqual(
      deleteRemoteCalls,
      [{ name: 'v1.0.0', remote: 'origin' }],
      'clicking the offer deletes the tag on origin'
    );
  });

  it('does not offer remote delete when the repo has no remote', async () => {
    let remoteDeleteCalled = false;
    const gitService = createMockGitService({
      getRepositories: () => [repoNoRemote],
      getRepository: async () => repoNoRemote,
      deleteTag: () => okAsync(undefined),
      deleteRemoteTag: () => {
        remoteDeleteCalled = true;
        return okAsync(undefined);
      },
    });
    const btp = createMockBranchTreeProvider(gitService);
    btp.getRepository = () => repoNoRemote;
    const commands = new BranchContextMenuCommands(gitService, btp);
    installWarningMessageTracker('Delete');
    const info = installInfoTracker(undefined);

    const t = createTagTreeItem('v1.0.0');
    await driveBranchMenuCommand(commands, 'intellig.tag.delete', t, [t]);
    await flush();

    assert.strictEqual(info.calls.length, 1);
    assert.ok(
      !info.calls[0].items.includes('Delete on Remote'),
      'no remote offer when there is no remote'
    );
    assert.strictEqual(info.calls[0].message, "Deleted tag 'v1.0.0' locally");
    assert.strictEqual(remoteDeleteCalled, false);
  });
});

describe('Tag "Delete on Remote" — offer to delete the still-present local tag', () => {
  const repoWithRemote: IRepository = {
    rootUri: Uri.file('/test/repo'),
    state: 'idle',
    head: undefined,
    remotes: [{ name: 'origin' }],
    submodules: [],
  };

  async function flush(): Promise<void> {
    for (let i = 0; i < 5; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  function installInfoTracker(choice?: string): { calls: { message: string; items: string[] }[] } {
    const calls: { message: string; items: string[] }[] = [];
    writableWindow().showInformationMessage = (
      message: string,
      ...items: string[]
    ): Promise<string | undefined> => {
      calls.push({ message, items });
      return Promise.resolve(choice);
    };
    return { calls };
  }

  afterEach(() => {
    restoreMessageFunctions();
  });

  it('refreshes and offers "Delete Locally" after a successful remote delete', async () => {
    const localDeletes: string[] = [];
    const gitService = createMockGitService({
      getRepositories: () => [repoWithRemote],
      getRepository: async () => repoWithRemote,
      getRemotes: () => okAsync([{ name: 'origin' }]),
      deleteRemoteTag: () => okAsync(undefined),
      deleteTag: (_repo, name) => {
        localDeletes.push(name);
        return okAsync(undefined);
      },
    });
    const btp = createMockBranchTreeProvider(gitService);
    btp.getRepository = () => repoWithRemote;
    let refreshed = 0;
    btp.refresh = () => {
      refreshed += 1;
    };
    const commands = new BranchContextMenuCommands(gitService, btp);
    installWarningMessageTracker('Delete from Remote'); // confirm the remote delete
    const info = installInfoTracker(undefined); // dismiss the local-delete offer

    const t = createTagTreeItem('v1.0.0');
    await driveBranchMenuCommand(commands, 'intellig.tag.deleteRemote', t, [t]);
    await flush();

    assert.ok(refreshed >= 1, 'the tree is refreshed after a remote tag delete');
    assert.strictEqual(info.calls.length, 1, 'one success toast');
    assert.ok(
      info.calls[0].items.includes('Delete Locally'),
      `toast offers "Delete Locally"; got items ${JSON.stringify(info.calls[0].items)}`
    );
    assert.strictEqual(localDeletes.length, 0, 'local tag not deleted unless the offer is clicked');
  });

  it('deletes the local tag when the user clicks "Delete Locally"', async () => {
    const localDeletes: string[] = [];
    let reloaded = 0;
    const gitService = createMockGitService({
      getRepositories: () => [repoWithRemote],
      getRepository: async () => repoWithRemote,
      getRemotes: () => okAsync([{ name: 'origin' }]),
      deleteRemoteTag: () => okAsync(undefined),
      deleteTag: (_repo, name) => {
        localDeletes.push(name);
        return okAsync(undefined);
      },
      reloadRepository: async (repo) => {
        reloaded += 1;
        return repo;
      },
    });
    const btp = createMockBranchTreeProvider(gitService);
    btp.getRepository = () => repoWithRemote;
    btp.refresh = () => {};
    const commands = new BranchContextMenuCommands(gitService, btp);
    installWarningMessageTracker('Delete from Remote');
    installInfoTracker('Delete Locally'); // user clicks the offer

    const t = createTagTreeItem('v1.0.0');
    await driveBranchMenuCommand(commands, 'intellig.tag.deleteRemote', t, [t]);
    await flush();

    assert.deepStrictEqual(localDeletes, ['v1.0.0'], 'clicking the offer deletes the local tag');
    assert.ok(reloaded >= 1, 'reloads the repo so the tree drops the tag');
  });

  it('does not offer a local delete when the remote delete fails', async () => {
    let localDeleteCalled = false;
    const gitService = createMockGitService({
      getRepositories: () => [repoWithRemote],
      getRepository: async () => repoWithRemote,
      getRemotes: () => okAsync([{ name: 'origin' }]),
      deleteRemoteTag: () => errAsync(new CommandFailedError(1, '', 'remote rejected')),
      deleteTag: () => {
        localDeleteCalled = true;
        return okAsync(undefined);
      },
    });
    const btp = createMockBranchTreeProvider(gitService);
    btp.getRepository = () => repoWithRemote;
    btp.refresh = () => {};
    const commands = new BranchContextMenuCommands(gitService, btp);
    installWarningMessageTracker('Delete from Remote');
    const info = installInfoTracker(undefined);
    const err = installErrorMessageTracker();

    const t = createTagTreeItem('v1.0.0');
    await driveBranchMenuCommand(commands, 'intellig.tag.deleteRemote', t, [t]);
    await flush();

    assert.strictEqual(info.calls.length, 0, 'no local-delete offer when the remote delete failed');
    assert.ok(err.calls.length >= 1, 'the remote failure is toasted');
    assert.strictEqual(localDeleteCalled, false);
  });
});
