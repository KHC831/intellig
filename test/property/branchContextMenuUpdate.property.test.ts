/**
 * Property-based tests for Update and Push command handlers.
 *
 * Feature: branch-context-menu, Property 3: Update command fetches from correct upstream
 * Feature: branch-context-menu, Property 4: Push command targets correct branch
 */

/*
 * Stub factories synthesise IGitService implementations whose member
 * signatures return `Promise<T>`; no-await stub bodies are intentional here.
 */

import '../setup';
import * as fc from 'fast-check';
import * as assert from 'assert';
import { BranchContextMenuCommands } from '../../src/branches/BranchContextMenuCommands';
import { BranchTreeItem, BranchTreeProvider } from '../../src/branches/BranchTreeProvider';
import {
  IFetchOptions,
  IGitService,
  IRepository,
  IBranch,
  IPushOptions,
  IUpstream,
} from '../../src/git-core/interfaces/IGitService';
import { EventEmitter, Uri } from '../mocks/vscode';
import { invokePrivateHandler } from '../typed/privateHandler';

// ─── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid branch name segment (alphanumeric, hyphens, underscores, dots).
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

/**
 * Generate a valid remote name (e.g., "origin", "upstream", "my-remote").
 */
function arbitraryRemoteName(): fc.Arbitrary<string> {
  return fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'.split('')
      ),
      { minLength: 1, maxLength: 15 }
    )
    .filter((s) => s.length > 0 && !s.startsWith('-') && !s.startsWith('_'));
}

/**
 * Generate a valid upstream configuration.
 */
function arbitraryUpstream(): fc.Arbitrary<IUpstream> {
  return fc.record({
    remote: arbitraryRemoteName(),
    name: arbitraryBranchName(),
  });
}

// ─── Mock Helpers ─────────────────────────────────────────────────────────────

/**
 * Create a mock IGitService that tracks fetch and push calls.
 */
function createTrackingMockGitService(): IGitService & {
  fetchCalls: Array<{ repo: IRepository; remote?: string }>;
  pushCalls: Array<{ repo: IRepository; options?: IPushOptions }>;
} {
  const repoChangeEmitter = new EventEmitter<IRepository>();
  const fetchCalls: Array<{ repo: IRepository; remote?: string }> = [];
  const pushCalls: Array<{ repo: IRepository; options?: IPushOptions }> = [];

  const service = {
    fetchCalls,
    pushCalls,
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
    fetch: async (repo: IRepository, optionsOrRemote?: IFetchOptions | string) => {
      // Accept both IFetchOptions and the legacy string form so the asserted
      // `remote` field is populated either way.
      const remote =
        typeof optionsOrRemote === 'string' ? optionsOrRemote : optionsOrRemote?.remote;
      fetchCalls.push({ repo, remote });
    },
    pull: async () => {},
    push: async (repo: IRepository, options?: IPushOptions) => {
      pushCalls.push({ repo, options });
    },
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
  } as unknown as IGitService & {
    fetchCalls: Array<{ repo: IRepository; remote?: string }>;
    pushCalls: Array<{ repo: IRepository; options?: IPushOptions }>;
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
 * Create a BranchTreeItem with the given branch name and optional upstream.
 */
function createBranchTreeItem(branchName: string, upstream?: IUpstream): BranchTreeItem {
  const branch: IBranch = {
    name: branchName,
    type: 'local',
    commit: 'abc1234567890abcdef1234567890abcdef123456',
    isHead: false,
    upstream,
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

describe('Feature: branch-context-menu - Update and Push Command Property Tests', () => {
  describe('Property 3: Update command fetches from correct upstream', () => {
    /**
     *
     * For any local branch with an upstream remote, when the Update command
     * handler is invoked, the handler SHALL call fetch on the git service
     * with the correct remote name derived from the branch's upstream.
     */

    it('Update handler calls fetch with the correct upstream remote name', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryBranchName(),
          arbitraryUpstream(),
          async (branchName, upstream) => {
            // Setup: Create tracking mock git service
            const gitService = createTrackingMockGitService();
            const branchTreeProvider = createMockBranchTreeProvider(gitService);
            const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

            // Create a branch tree item with the upstream config
            const item = createBranchTreeItem(branchName, upstream);

            // Act: Call the _handleUpdate handler via bracket notation
            await invokePrivateHandler(commands, '_handleUpdate', item);

            // Assert: fetch was called exactly once
            assert.strictEqual(
              gitService.fetchCalls.length,
              1,
              `Expected fetch to be called once, but was called ${gitService.fetchCalls.length} times`
            );

            // Assert: fetch was called with the correct remote name from upstream
            assert.strictEqual(
              gitService.fetchCalls[0].remote,
              upstream.remote,
              `Expected fetch to be called with remote "${upstream.remote}", ` +
                `but was called with "${gitService.fetchCalls[0].remote}"`
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Update handler does not call fetch when branch has no upstream', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryBranchName(), async (branchName) => {
          // Setup: Create tracking mock git service
          const gitService = createTrackingMockGitService();
          const branchTreeProvider = createMockBranchTreeProvider(gitService);
          const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

          // Create a branch tree item WITHOUT upstream
          const item = createBranchTreeItem(branchName, undefined);

          // Act: Call the _handleUpdate handler
          await invokePrivateHandler(commands, '_handleUpdate', item);

          // Assert: fetch was NOT called (no upstream configured)
          assert.strictEqual(
            gitService.fetchCalls.length,
            0,
            `Expected fetch NOT to be called when no upstream is configured, ` +
              `but it was called ${gitService.fetchCalls.length} times`
          );
        }),
        { numRuns: 100 }
      );
    });

    it('Update handler passes the repository to fetch', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryBranchName(),
          arbitraryUpstream(),
          async (branchName, upstream) => {
            // Setup
            const gitService = createTrackingMockGitService();
            const branchTreeProvider = createMockBranchTreeProvider(gitService);
            const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);
            const item = createBranchTreeItem(branchName, upstream);

            // Act
            await invokePrivateHandler(commands, '_handleUpdate', item);

            // Assert: fetch was called with a valid repository object
            assert.strictEqual(gitService.fetchCalls.length, 1);
            const calledRepo = gitService.fetchCalls[0].repo;
            assert.ok(calledRepo, 'fetch should be called with a repository');
            assert.ok(calledRepo.rootUri, 'Repository should have a rootUri');
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 4: Push command targets correct branch', () => {
    /**
     *
     * For any local branch, when the Push command handler is invoked,
     * the handler SHALL call push on the git service with the branch name
     * and its upstream remote.
     */

    it('Push handler calls push with correct branch name and upstream remote', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryBranchName(),
          arbitraryUpstream(),
          async (branchName, upstream) => {
            // Setup: Create tracking mock git service
            const gitService = createTrackingMockGitService();
            const branchTreeProvider = createMockBranchTreeProvider(gitService);
            const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

            // Create a branch tree item with upstream config
            const item = createBranchTreeItem(branchName, upstream);

            // Act: Call the _handlePush handler via bracket notation
            await invokePrivateHandler(commands, '_handlePush', item);

            // Assert: push was called exactly once
            assert.strictEqual(
              gitService.pushCalls.length,
              1,
              `Expected push to be called once, but was called ${gitService.pushCalls.length} times`
            );

            // Assert: push was called with the correct remote from upstream
            assert.strictEqual(
              gitService.pushCalls[0].options?.remote,
              upstream.remote,
              `Expected push remote to be "${upstream.remote}", ` +
                `but was "${String(gitService.pushCalls[0].options?.remote)}"`
            );

            // Assert: push was called with the correct branch name
            assert.strictEqual(
              gitService.pushCalls[0].options?.branch,
              branchName,
              `Expected push branch to be "${branchName}", ` +
                `but was "${String(gitService.pushCalls[0].options?.branch)}"`
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Push handler sets upstream when branch has no upstream configured', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryBranchName(), async (branchName) => {
          // Setup: Create tracking mock git service
          const gitService = createTrackingMockGitService();
          const branchTreeProvider = createMockBranchTreeProvider(gitService);
          const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);

          // Create a branch tree item WITHOUT upstream
          const item = createBranchTreeItem(branchName, undefined);

          // Act: Call the _handlePush handler
          await invokePrivateHandler(commands, '_handlePush', item);

          // Assert: push was called exactly once
          assert.strictEqual(
            gitService.pushCalls.length,
            1,
            `Expected push to be called once, but was called ${gitService.pushCalls.length} times`
          );

          // Assert: push was called with setUpstream: true
          assert.strictEqual(
            gitService.pushCalls[0].options?.setUpstream,
            true,
            `Expected push to be called with setUpstream: true when no upstream is configured`
          );

          // Assert: push was called with the correct branch name
          assert.strictEqual(
            gitService.pushCalls[0].options.branch,
            branchName,
            `Expected push branch to be "${branchName}", ` +
              `but was "${gitService.pushCalls[0].options.branch}"`
          );
        }),
        { numRuns: 100 }
      );
    });

    it('Push handler does not set upstream when branch already has upstream', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryBranchName(),
          arbitraryUpstream(),
          async (branchName, upstream) => {
            // Setup
            const gitService = createTrackingMockGitService();
            const branchTreeProvider = createMockBranchTreeProvider(gitService);
            const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);
            const item = createBranchTreeItem(branchName, upstream);

            // Act
            await invokePrivateHandler(commands, '_handlePush', item);

            // Assert: push was called without setUpstream
            assert.strictEqual(gitService.pushCalls.length, 1);
            assert.strictEqual(
              gitService.pushCalls[0].options?.setUpstream,
              undefined,
              `Expected push NOT to have setUpstream when upstream is already configured`
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Push handler passes the repository to push', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryBranchName(),
          arbitraryUpstream(),
          async (branchName, upstream) => {
            // Setup
            const gitService = createTrackingMockGitService();
            const branchTreeProvider = createMockBranchTreeProvider(gitService);
            const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);
            const item = createBranchTreeItem(branchName, upstream);

            // Act
            await invokePrivateHandler(commands, '_handlePush', item);

            // Assert: push was called with a valid repository object
            assert.strictEqual(gitService.pushCalls.length, 1);
            const calledRepo = gitService.pushCalls[0].repo;
            assert.ok(calledRepo, 'push should be called with a repository');
            assert.ok(calledRepo.rootUri, 'Repository should have a rootUri');
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
