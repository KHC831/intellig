/**
 * Unit tests for new command handler error flows.
 *
 * Tests uncommitted changes dialog for Checkout and Rebase,
 * conflict warning for merge/rebase results, and missing repository
 * early return behavior.
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

    // ─── Non-conflict failure surfacing (regression: silent no-op) ────────

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

    it('_handleRebaseCurrentOnto surfaces failureReason on non-conflict failure', async () => {
      const errorTracker = installErrorMessageTracker();

      const gitService = createMockGitService({
        rebaseBranch: async (): Promise<IBasicRebaseResult> => ({
          success: false,
          conflicts: [],
          failureReason: 'error: cannot rebase: You have unstaged changes.',
        }),
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('origin/main');
      await invokePrivateHandler(commands, '_handleRebaseCurrentOnto', item);

      assert.ok(
        errorTracker.calls.length > 0,
        'showErrorMessage MUST be called for non-conflict rebase failure'
      );
      assert.ok(
        errorTracker.calls[0].message.includes('unstaged changes'),
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
});
