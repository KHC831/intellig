/**
 * Unit tests for new command handler error flows.
 *
 * Tests uncommitted changes dialog for Checkout and Rebase,
 * conflict warning for merge/rebase results, and missing repository
 * early return behavior.
 *
 * Requirements: 8.1, 8.2, 8.3
 */

import '../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { BranchContextMenuCommands } from '../../commands/BranchContextMenuCommands';
import { BranchTreeItem, BranchTreeProvider } from '../../services/BranchTreeProvider';
import {
  IGitService,
  IRepository,
  IBranch,
  IBasicRebaseResult,
} from '../../services/interfaces/IGitService';
import { EventEmitter, Uri } from '../mocks/vscode';

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
    fetch: async () => {},
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
  const tracker: MessageTracker = { calls: [], reset() { this.calls = []; } };
  (vscode.window as any).showErrorMessage = async (
    message: string,
    ...items: string[]
  ): Promise<string | undefined> => {
    tracker.calls.push({ message, items });
    return undefined;
  };
  return tracker;
}

/**
 * Install a tracking stub on vscode.window.showWarningMessage.
 * Optionally returns a specific choice.
 */
function installWarningMessageTracker(returnChoice?: string): MessageTracker {
  const tracker: MessageTracker = { calls: [], reset() { this.calls = []; } };
  (vscode.window as any).showWarningMessage = async (
    message: string,
    ...items: any[]
  ): Promise<string | undefined> => {
    // Filter out option objects (like { modal: true })
    const stringItems = items.filter((i) => typeof i === 'string') as string[];
    tracker.calls.push({ message, items: stringItems });
    return returnChoice;
  };
  return tracker;
}

/**
 * Install a tracking stub on vscode.window.showInformationMessage.
 */
function installInfoMessageTracker(): MessageTracker {
  const tracker: MessageTracker = { calls: [], reset() { this.calls = []; } };
  (vscode.window as any).showInformationMessage = async (
    message: string,
    ...items: string[]
  ): Promise<string | undefined> => {
    tracker.calls.push({ message, items });
    return undefined;
  };
  return tracker;
}

/**
 * Restore original vscode.window message functions.
 */
function restoreMessageFunctions(): void {
  (vscode.window as any).showErrorMessage = async (
    _message: string,
    ..._items: string[]
  ): Promise<string | undefined> => undefined;
  (vscode.window as any).showWarningMessage = async (
    _message: string,
    ..._items: string[]
  ): Promise<string | undefined> => undefined;
  (vscode.window as any).showInformationMessage = async (
    _message: string,
    ..._items: string[]
  ): Promise<string | undefined> => undefined;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Branch Context Menu - Command Handler Error Flows', () => {
  afterEach(() => {
    restoreMessageFunctions();
  });

  // ─── Missing Repository Early Return (Requirement 8.1) ───────────────────

  describe('Missing repository early return', () => {
    it('_handleUpdate should return early when repository is undefined', async () => {
      let fetchCalled = false;
      const gitService = createMockGitService({
        fetch: async () => { fetchCalled = true; },
      });
      const branchTreeProvider = createMockBranchTreeProviderNoRepo(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/test', { remote: 'origin', name: 'feature/test' });
      await (commands as any)._handleUpdate(item);

      assert.strictEqual(fetchCalled, false, 'fetch should not be called when repo is undefined');
    });

    it('_handlePush should return early when repository is undefined', async () => {
      let pushCalled = false;
      const gitService = createMockGitService({
        push: async () => { pushCalled = true; },
      });
      const branchTreeProvider = createMockBranchTreeProviderNoRepo(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/test', { remote: 'origin', name: 'feature/test' });
      await (commands as any)._handlePush(item);

      assert.strictEqual(pushCalled, false, 'push should not be called when repo is undefined');
    });

    it('_handleCheckoutAndRebase should return early when repository is undefined', async () => {
      let checkoutCalled = false;
      const gitService = createMockGitService({
        checkout: async () => { checkoutCalled = true; },
      });
      const branchTreeProvider = createMockBranchTreeProviderNoRepo(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/test');
      await (commands as any)._handleCheckoutAndRebase(item);

      assert.strictEqual(checkoutCalled, false, 'checkout should not be called when repo is undefined');
    });

    it('_handlePullUsingRebase should return early when repository is undefined', async () => {
      let pullCalled = false;
      const gitService = createMockGitService({
        pull: async () => { pullCalled = true; },
      });
      const branchTreeProvider = createMockBranchTreeProviderNoRepo(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createRemoteBranchTreeItem('origin/main');
      await (commands as any)._handlePullUsingRebase(item);

      assert.strictEqual(pullCalled, false, 'pull should not be called when repo is undefined');
    });

    it('_handlePullUsingMerge should return early when repository is undefined', async () => {
      let pullCalled = false;
      const gitService = createMockGitService({
        pull: async () => { pullCalled = true; },
      });
      const branchTreeProvider = createMockBranchTreeProviderNoRepo(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createRemoteBranchTreeItem('origin/main');
      await (commands as any)._handlePullUsingMerge(item);

      assert.strictEqual(pullCalled, false, 'pull should not be called when repo is undefined');
    });
  });

  // ─── Uncommitted Changes Dialog (Requirement 8.2) ────────────────────────

  describe('Uncommitted changes dialog for Checkout and Rebase', () => {
    it('should show warning dialog with Stash/Force/Cancel options when checkout fails due to uncommitted changes', async () => {
      const warningTracker = installWarningMessageTracker(undefined); // user cancels

      const gitService = createMockGitService({
        checkout: async () => {
          throw new Error('error: Your local changes to the following files would be overwritten by checkout');
        },
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/test');
      await (commands as any)._handleCheckoutAndRebase(item);

      assert.ok(
        warningTracker.calls.length > 0,
        'showWarningMessage should have been called'
      );
      const call = warningTracker.calls[0];
      assert.ok(
        call.message.includes('would be overwritten'),
        `Warning message should mention overwritten changes, got: "${call.message}"`
      );
      assert.ok(
        call.items.includes('Stash & Switch'),
        'Should offer Stash & Switch option'
      );
      assert.ok(
        call.items.includes('Force Checkout'),
        'Should offer Force Checkout option'
      );
      assert.ok(
        call.items.includes('Cancel'),
        'Should offer Cancel option'
      );
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
      await (commands as any)._handleCheckoutAndRebase(item);

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
        checkout: async (_repo: any, branchName: string) => {
          checkoutCallCount++;
          checkoutCalls.push(branchName);
          if (checkoutCallCount === 1) {
            throw new Error('Your local changes would be overwritten by checkout');
          }
          // Second call succeeds
        },
        stash: async (_repo: any, message: string) => {
          stashCalls.push(message);
        },
        rebaseBranch: async (): Promise<IBasicRebaseResult> => ({ success: true }),
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createLocalBranchTreeItem('feature/test');
      await (commands as any)._handleCheckoutAndRebase(item);

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
        checkout: async (_repo: any, _branchName: string, options?: any) => {
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
      await (commands as any)._handleCheckoutAndRebase(item);

      assert.ok(forceUsed, 'Force checkout should have been used');
    });
  });

  // ─── Conflict Warning (Requirement 8.3) ──────────────────────────────────

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
      await (commands as any)._handleCheckoutAndRebase(item);

      assert.ok(
        warningTracker.calls.length > 0,
        'showWarningMessage should have been called for conflicts'
      );
      const msg = warningTracker.calls[0].message;
      assert.ok(
        msg.includes('3'),
        `Warning should contain conflict count 3, got: "${msg}"`
      );
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
      await (commands as any)._handleMergeIntoCurrent(item);

      assert.ok(
        warningTracker.calls.length > 0,
        'showWarningMessage should have been called for merge conflicts'
      );
      const msg = warningTracker.calls[0].message;
      assert.ok(
        msg.includes('2'),
        `Warning should contain conflict count 2, got: "${msg}"`
      );
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
      await (commands as any)._handleRebaseCurrentOnto(item);

      assert.ok(
        warningTracker.calls.length > 0,
        'showWarningMessage should have been called for rebase conflicts'
      );
      const msg = warningTracker.calls[0].message;
      assert.ok(
        msg.includes('1'),
        `Warning should contain conflict count 1, got: "${msg}"`
      );
    });

    it('_handlePullUsingRebase should show warning when pull throws with CONFLICT markers', async () => {
      const warningTracker = installWarningMessageTracker();

      const gitService = createMockGitService({
        pull: async () => {
          throw new Error(
            'CONFLICT (content): Merge issue in file1.ts\nCONFLICT (content): Merge issue in file2.ts'
          );
        },
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createRemoteBranchTreeItem('origin/feature');
      await (commands as any)._handlePullUsingRebase(item);

      assert.ok(
        warningTracker.calls.length > 0,
        'showWarningMessage should have been called for pull rebase conflicts'
      );
      const msg = warningTracker.calls[0].message;
      assert.ok(
        msg.includes('2'),
        `Warning should contain conflict count 2, got: "${msg}"`
      );
    });

    it('_handlePullUsingMerge should show warning when pull throws with CONFLICT markers', async () => {
      const warningTracker = installWarningMessageTracker();

      const gitService = createMockGitService({
        pull: async () => {
          throw new Error('CONFLICT (content): Merge issue in src/index.ts');
        },
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      const item = createRemoteBranchTreeItem('origin/main');
      await (commands as any)._handlePullUsingMerge(item);

      assert.ok(
        warningTracker.calls.length > 0,
        'showWarningMessage should have been called for pull merge conflicts'
      );
      const msg = warningTracker.calls[0].message;
      assert.ok(
        msg.includes('1'),
        `Warning should contain conflict count 1, got: "${msg}"`
      );
    });
  });

  // ─── General Error Handling (Requirement 8.1) ─────────────────────────────

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
      await (commands as any)._handleUpdate(item);

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
      await (commands as any)._handlePush(item);

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
      await (commands as any)._handleCheckoutAndRebase(item);

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
      await (commands as any)._handleUpdate(item);

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
      let pushOptions: any = null;
      installInfoMessageTracker();

      const gitService = createMockGitService({
        push: async (_repo: any, options: any) => {
          pushOptions = options;
        },
      });
      const branchTreeProvider = createMockBranchTreeProvider(gitService);
      const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

      // Create branch without upstream
      const item = createLocalBranchTreeItem('feature/no-upstream');
      await (commands as any)._handlePush(item);

      assert.ok(pushOptions !== null, 'push should have been called');
      assert.strictEqual(
        pushOptions.setUpstream,
        true,
        'push should be called with setUpstream: true when no upstream'
      );
    });
  });
});
