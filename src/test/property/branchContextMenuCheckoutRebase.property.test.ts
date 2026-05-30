/**
 * Property-based tests for Checkout and Rebase command handler.
 *
 * Feature: branch-context-menu, Property 6: Checkout and Rebase executes operations in correct order
 */

/*
 * Stub factories synthesise IGitService implementations whose member
 * signatures return `Promise<T>`; no-await stub bodies are intentional here.
 */

import '../setup';
import * as fc from 'fast-check';
import * as assert from 'assert';
import { BranchContextMenuCommands } from '../../branches/BranchContextMenuCommands';
import { BranchTreeItem, BranchTreeProvider } from '../../branches/BranchTreeProvider';
import { IGitService, IRepository, IBranch } from '../../git-core/interfaces/IGitService';
import { EventEmitter, Uri } from '../mocks/vscode';
import { invokePrivateHandler } from '../typed/privateHandler';

// ─── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid branch name segment (alphanumeric, hyphens, underscores).
 */
function arbitraryBranchSegment(): fc.Arbitrary<string> {
  return fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'.split('')
      ),
      { minLength: 1, maxLength: 15 }
    )
    .filter((s) => !s.startsWith('-') && !s.startsWith('_'));
}

/**
 * Generate a valid branch name with optional path segments (e.g., "feature/my-branch").
 */
function arbitraryBranchName(): fc.Arbitrary<string> {
  return fc
    .array(arbitraryBranchSegment(), { minLength: 1, maxLength: 3 })
    .map((segments) => segments.join('/'))
    .filter((s) => s.length > 0 && !s.endsWith('/') && !s.includes('//'));
}

// ─── Mock Helpers ─────────────────────────────────────────────────────────────

/**
 * Operation call record for tracking the order and arguments of git operations.
 */
interface OperationCall {
  operation: 'checkout' | 'rebaseBranch';
  args: unknown[];
  order: number;
}

/**
 * Create a mock IGitService that tracks checkout and rebaseBranch calls in order.
 */
function createTrackingMockGitService(
  _currentBranchName: string
): IGitService & { operationCalls: OperationCall[] } {
  const repoChangeEmitter = new EventEmitter<IRepository>();
  const operationCalls: OperationCall[] = [];
  let callOrder = 0;

  const service = {
    operationCalls,
    onDidChangeRepository: repoChangeEmitter.event,
    getRepositories: () => [],
    getRepository: async () => undefined,
    getBranches: async () => [],
    getTags: async () => [],
    commit: async () => {},
    amend: async () => {},
    createBranch: async () => {},
    checkout: async (_repo: IRepository, branchName: string) => {
      operationCalls.push({
        operation: 'checkout',
        args: [branchName],
        order: callOrder++,
      });
    },
    deleteBranch: async () => {},
    renameBranch: async () => {},
    mergeBranch: async () => ({ success: true }),
    rebaseBranch: async (_repo: IRepository, ontoBranch: string) => {
      operationCalls.push({
        operation: 'rebaseBranch',
        args: [ontoBranch],
        order: callOrder++,
      });
      return { success: true };
    },
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
  } as unknown as IGitService & { operationCalls: OperationCall[] };

  return service;
}

/**
 * Create a mock BranchTreeProvider that returns a mock repository with the given current branch.
 */
function createMockBranchTreeProvider(
  gitService: IGitService,
  currentBranchName: string
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
 * Create a BranchTreeItem with the given branch name.
 */
function createBranchTreeItem(branchName: string): BranchTreeItem {
  const branch: IBranch = {
    name: branchName,
    type: 'local',
    commit: 'abc1234567890abcdef1234567890abcdef123456',
    isHead: false,
  };

  return new BranchTreeItem(
    branchName,
    0, // TreeItemCollapsibleState.None
    'local-branch',
    branch,
    undefined,
    false
  );
}

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: branch-context-menu - Checkout and Rebase Property Tests', () => {
  describe('Property 6: Checkout and Rebase executes operations in correct order', () => {
    /**
     *
     * For any non-current branch, when the Checkout and Rebase command handler
     * is invoked, the handler SHALL first call checkout for the right-clicked
     * branch, then call rebaseBranch with the previously current branch as
     * the onto target.
     */

    it('Checkout is called first with the right-clicked branch, then rebaseBranch with the previously current branch', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryBranchName(),
          arbitraryBranchName(),
          async (rightClickedBranch, currentBranch) => {
            // Ensure the branches are different
            fc.pre(rightClickedBranch !== currentBranch);

            // Setup: Create tracking mock git service
            const gitService = createTrackingMockGitService(currentBranch);
            const branchTreeProvider = createMockBranchTreeProvider(gitService, currentBranch);
            const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

            // Create a branch tree item for the right-clicked branch
            const item = createBranchTreeItem(rightClickedBranch);

            // Act: Call the _handleCheckoutAndRebase handler
            await invokePrivateHandler(commands, '_handleCheckoutAndRebase', item);

            // Assert: Exactly 2 operations were called
            assert.strictEqual(
              gitService.operationCalls.length,
              2,
              `Expected exactly 2 operations, but got ${gitService.operationCalls.length}: ${JSON.stringify(gitService.operationCalls.map((c) => c.operation))}`
            );

            // Assert: First operation is checkout
            const firstOp = gitService.operationCalls[0];
            assert.strictEqual(
              firstOp.operation,
              'checkout',
              `Expected first operation to be "checkout", but was "${firstOp.operation}"`
            );

            // Assert: Checkout is called with the right-clicked branch name
            assert.strictEqual(
              firstOp.args[0],
              rightClickedBranch,
              `Expected checkout to be called with "${rightClickedBranch}", but was called with "${String(firstOp.args[0])}"`
            );

            // Assert: Second operation is rebaseBranch
            const secondOp = gitService.operationCalls[1];
            assert.strictEqual(
              secondOp.operation,
              'rebaseBranch',
              `Expected second operation to be "rebaseBranch", but was "${secondOp.operation}"`
            );

            // Assert: rebaseBranch is called with the previously current branch
            assert.strictEqual(
              secondOp.args[0],
              currentBranch,
              `Expected rebaseBranch to be called with "${currentBranch}", but was called with "${String(secondOp.args[0])}"`
            );

            // Assert: checkout happens before rebaseBranch (order check)
            assert.ok(
              firstOp.order < secondOp.order,
              `Expected checkout (order ${firstOp.order}) to happen before rebaseBranch (order ${secondOp.order})`
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Checkout and Rebase uses HEAD as previous branch when in detached HEAD state', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryBranchName(), async (rightClickedBranch) => {
          // Setup: Create tracking mock git service with detached HEAD
          const gitService = createTrackingMockGitService('HEAD');
          const provider = new BranchTreeProvider(gitService);

          // Mock repository with no head name (detached HEAD)
          const mockRepo: IRepository = {
            rootUri: Uri.file('/test-repo'),
            state: 'idle',
            head: { name: undefined, ahead: 0, behind: 0 },
            remotes: [],
            submodules: [],
          };
          provider.getRepository = () => mockRepo;

          const commands = new BranchContextMenuCommands(gitService, provider);
          const item = createBranchTreeItem(rightClickedBranch);

          // Act
          await invokePrivateHandler(commands, '_handleCheckoutAndRebase', item);

          // Assert: Exactly 2 operations were called
          assert.strictEqual(gitService.operationCalls.length, 2);

          // Assert: First operation is checkout with the right-clicked branch
          assert.strictEqual(gitService.operationCalls[0].operation, 'checkout');
          assert.strictEqual(gitService.operationCalls[0].args[0], rightClickedBranch);

          // Assert: Second operation is rebaseBranch with "HEAD" (fallback)
          assert.strictEqual(gitService.operationCalls[1].operation, 'rebaseBranch');
          assert.strictEqual(
            gitService.operationCalls[1].args[0],
            'HEAD',
            `Expected rebaseBranch to be called with "HEAD" for detached state, but was called with "${String(gitService.operationCalls[1].args[0])}"`
          );
        }),
        { numRuns: 100 }
      );
    });

    it('Checkout and Rebase passes the repository to both operations', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryBranchName(),
          arbitraryBranchName(),
          async (rightClickedBranch, currentBranch) => {
            fc.pre(rightClickedBranch !== currentBranch);

            // Setup
            const gitService = createTrackingMockGitService(currentBranch);
            const branchTreeProvider = createMockBranchTreeProvider(gitService, currentBranch);
            const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);
            const item = createBranchTreeItem(rightClickedBranch);

            // Act
            await invokePrivateHandler(commands, '_handleCheckoutAndRebase', item);

            // Assert: Both operations were called
            assert.strictEqual(gitService.operationCalls.length, 2);

            // Assert: Operations are in the correct order
            assert.strictEqual(gitService.operationCalls[0].operation, 'checkout');
            assert.strictEqual(gitService.operationCalls[1].operation, 'rebaseBranch');
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
