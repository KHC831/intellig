/**
 * Property-based tests for Pull Using Rebase and Pull Using Merge command handlers.
 *
 * Feature: branch-context-menu, Property 7: Pull strategy selection
 */

/*
 * Stub factories synthesise IGitService implementations whose member
 * signatures return `Promise<T>`; no-await stub bodies are intentional here.
 */

import '../setup';
import { okAsync } from 'neverthrow';
import * as fc from 'fast-check';
import * as assert from 'assert';
import { BranchContextMenuCommands } from '../../src/branches/BranchContextMenuCommands';
import { BranchTreeItem, BranchTreeProvider } from '../../src/branches/BranchTreeProvider';
import {
  IGitService,
  IRepository,
  IBranch,
  IPullOptions,
} from '../../src/git-core/interfaces/IGitService';
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
 * Generate a valid remote name (e.g., "origin", "upstream", "my-remote").
 */
function arbitraryRemoteName(): fc.Arbitrary<string> {
  return fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'.split('')
      ),
      { minLength: 1, maxLength: 10 }
    )
    .filter((s) => s.length > 0 && !s.startsWith('-') && !s.startsWith('_'));
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

/**
 * Generate a valid remote branch reference in the format "remote/branch".
 * The remote is a single segment, and the branch can have path separators.
 */
function arbitraryRemoteBranchRef(): fc.Arbitrary<{
  remote: string;
  branch: string;
  fullRef: string;
}> {
  return fc.tuple(arbitraryRemoteName(), arbitraryBranchName()).map(([remote, branch]) => ({
    remote,
    branch,
    fullRef: `${remote}/${branch}`,
  }));
}

// ─── Mock Helpers ─────────────────────────────────────────────────────────────

/**
 * Create a mock IGitService that tracks pull calls.
 */
function createTrackingMockGitService(): IGitService & {
  pullCalls: Array<{ repo: IRepository; options?: IPullOptions }>;
} {
  const repoChangeEmitter = new EventEmitter<IRepository>();
  const pullCalls: Array<{ repo: IRepository; options?: IPullOptions }> = [];

  const service = {
    pullCalls,
    onDidChangeRepository: repoChangeEmitter.event,
    getRepositories: () => [],
    getRepository: async () => undefined,
    getBranches: async () => [],
    getTags: async () => [],
    commit: () => okAsync(undefined),
    amend: () => okAsync(undefined),
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
    fetch: () => {
      return okAsync(undefined);
    },
    pull: (repo: IRepository, options?: IPullOptions) => {
      pullCalls.push({ repo, options });
      return okAsync(undefined);
    },
    push: () => okAsync(undefined),
    getRemotes: () => okAsync([]),
    addRemote: () => okAsync(undefined),
    removeRemote: () => okAsync(undefined),
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
    stage: () => okAsync(undefined),
    unstage: () => okAsync(undefined),
    stageHunk: () => okAsync(undefined),
    stageLines: () => okAsync(undefined),
    unstageHunk: () => okAsync(undefined),
    revertFile: () => okAsync(undefined),
    dispose: () => {},
  } as unknown as IGitService & {
    pullCalls: Array<{ repo: IRepository; options?: IPullOptions }>;
  };

  return service;
}

/**
 * Create a mock BranchTreeProvider that returns a mock repository.
 */
function createMockBranchTreeProvider(gitService: IGitService): BranchTreeProvider {
  const provider = new BranchTreeProvider(gitService);

  const mockRepo: IRepository = {
    rootUri: Uri.file('/test-repo'),
    state: 'idle',
    head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  };

  provider.getRepository = () => mockRepo;
  return provider;
}

/**
 * Create a BranchTreeItem for a remote branch with the given full ref.
 */
function createRemoteBranchTreeItem(fullRef: string): BranchTreeItem {
  const branch: IBranch = {
    name: fullRef,
    type: 'remote',
    commit: 'abc1234567890abcdef1234567890abcdef123456',
    isHead: false,
  };

  return new BranchTreeItem(
    fullRef,
    0, // TreeItemCollapsibleState.None
    'remote-branch',
    branch,
    undefined,
    false
  );
}

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: branch-context-menu - Pull Strategy Property Tests', () => {
  describe('Property 7: Pull strategy selection', () => {
    /**
     *
     * For any remote branch, when a Pull command handler is invoked,
     * the handler SHALL call pull with rebase: true for the "Using Rebase"
     * variant and rebase: false for the "Using Merge" variant, using the
     * correct remote and branch name parsed from the remote branch reference.
     */

    it('Pull Using Rebase calls pull with rebase: true and correct remote/branch', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryRemoteBranchRef(), async ({ remote, branch, fullRef }) => {
          // Setup: Create tracking mock git service
          const gitService = createTrackingMockGitService();
          const branchTreeProvider = createMockBranchTreeProvider(gitService);
          const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

          // Create a remote branch tree item
          const item = createRemoteBranchTreeItem(fullRef);

          // Act: Call the _handlePullUsingRebase handler
          await invokePrivateHandler(commands, '_handlePullUsingRebase', item);

          // Assert: pull was called exactly once
          assert.strictEqual(
            gitService.pullCalls.length,
            1,
            `Expected pull to be called once, but was called ${gitService.pullCalls.length} times`
          );

          const pullOptions = gitService.pullCalls[0].options;
          assert.ok(pullOptions, 'Pull options should be provided');

          // Assert: rebase is true
          assert.strictEqual(
            pullOptions.rebase,
            true,
            `Expected pull to be called with rebase: true, but got rebase: ${pullOptions.rebase}`
          );

          // Assert: remote name is correctly parsed (everything before first /)
          assert.strictEqual(
            pullOptions.remote,
            remote,
            `Expected remote to be "${remote}", but got "${pullOptions.remote}"`
          );

          // Assert: branch name is correctly parsed (everything after first /)
          assert.strictEqual(
            pullOptions.branch,
            branch,
            `Expected branch to be "${branch}", but got "${pullOptions.branch}"`
          );
        }),
        { numRuns: 100 }
      );
    });

    it('Pull Using Merge calls pull with rebase: false and correct remote/branch', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryRemoteBranchRef(), async ({ remote, branch, fullRef }) => {
          // Setup: Create tracking mock git service
          const gitService = createTrackingMockGitService();
          const branchTreeProvider = createMockBranchTreeProvider(gitService);
          const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

          // Create a remote branch tree item
          const item = createRemoteBranchTreeItem(fullRef);

          // Act: Call the _handlePullUsingMerge handler
          await invokePrivateHandler(commands, '_handlePullUsingMerge', item);

          // Assert: pull was called exactly once
          assert.strictEqual(
            gitService.pullCalls.length,
            1,
            `Expected pull to be called once, but was called ${gitService.pullCalls.length} times`
          );

          const pullOptions = gitService.pullCalls[0].options;
          assert.ok(pullOptions, 'Pull options should be provided');

          // Assert: rebase is false
          assert.strictEqual(
            pullOptions.rebase,
            false,
            `Expected pull to be called with rebase: false, but got rebase: ${pullOptions.rebase}`
          );

          // Assert: remote name is correctly parsed (everything before first /)
          assert.strictEqual(
            pullOptions.remote,
            remote,
            `Expected remote to be "${remote}", but got "${pullOptions.remote}"`
          );

          // Assert: branch name is correctly parsed (everything after first /)
          assert.strictEqual(
            pullOptions.branch,
            branch,
            `Expected branch to be "${branch}", but got "${pullOptions.branch}"`
          );
        }),
        { numRuns: 100 }
      );
    });

    it('Pull correctly parses remote/branch when branch name contains slashes', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryRemoteName(),
          fc.tuple(arbitraryBranchSegment(), arbitraryBranchSegment()).map(([a, b]) => `${a}/${b}`),
          async (remote, branchWithSlash) => {
            const fullRef = `${remote}/${branchWithSlash}`;

            // Setup
            const gitService = createTrackingMockGitService();
            const branchTreeProvider = createMockBranchTreeProvider(gitService);
            const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);
            const item = createRemoteBranchTreeItem(fullRef);

            // Act: Test with rebase
            await invokePrivateHandler(commands, '_handlePullUsingRebase', item);

            // Assert: pull was called once
            assert.strictEqual(gitService.pullCalls.length, 1);

            const pullOptions = gitService.pullCalls[0].options;
            assert.ok(pullOptions, 'Pull options should be provided');

            // Assert: remote is the first segment only
            assert.strictEqual(
              pullOptions.remote,
              remote,
              `Expected remote to be "${remote}" (first segment), but got "${pullOptions.remote}"`
            );

            // Assert: branch is everything after the first /
            assert.strictEqual(
              pullOptions.branch,
              branchWithSlash,
              `Expected branch to be "${branchWithSlash}" (after first /), but got "${pullOptions.branch}"`
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Pull passes the repository to the pull operation', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryRemoteBranchRef(), async ({ fullRef }) => {
          // Setup
          const gitService = createTrackingMockGitService();
          const branchTreeProvider = createMockBranchTreeProvider(gitService);
          const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);
          const item = createRemoteBranchTreeItem(fullRef);

          // Act
          await invokePrivateHandler(commands, '_handlePullUsingRebase', item);

          // Assert: pull was called with a valid repository
          assert.strictEqual(gitService.pullCalls.length, 1);
          const calledRepo = gitService.pullCalls[0].repo;
          assert.ok(calledRepo, 'pull should be called with a repository');
          assert.ok(calledRepo.rootUri, 'Repository should have a rootUri');
        }),
        { numRuns: 100 }
      );
    });
  });
});
