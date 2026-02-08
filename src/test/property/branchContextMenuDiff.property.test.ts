/**
 * Property-based tests for Show Diff with Working Tree command handler.
 *
 * Feature: branch-context-menu, Property 5: Show Diff uses correct branch reference
 *
 * **Validates: Requirements 7.3**
 */

import '../setup';
import * as fc from 'fast-check';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { BranchContextMenuCommands } from '../../commands/BranchContextMenuCommands';
import { BranchTreeItem, BranchTreeProvider } from '../../services/BranchTreeProvider';
import { IGitService, IRepository, IBranch } from '../../services/interfaces/IGitService';
import { EventEmitter, Uri } from '../mocks/vscode';

// ─── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid branch name segment (alphanumeric, hyphens, underscores, dots).
 */
function arbitraryBranchSegment(): fc.Arbitrary<string> {
  return fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.'.split('')
      ),
      { minLength: 1, maxLength: 15 }
    )
    .filter((s) => !s.startsWith('-') && !s.startsWith('.') && !s.endsWith('.'));
}

/**
 * Generate a valid local branch name (e.g., "feature/my-branch", "main").
 */
function arbitraryLocalBranchName(): fc.Arbitrary<string> {
  return fc
    .array(arbitraryBranchSegment(), { minLength: 1, maxLength: 3 })
    .map((segments) => segments.join('/'))
    .filter((s) => s.length > 0 && !s.endsWith('/') && !s.includes('//'));
}

/**
 * Generate a valid remote name (e.g., "origin", "upstream").
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
 * Generate a valid remote branch ref (e.g., "origin/main", "upstream/feature/branch").
 */
function arbitraryRemoteBranchRef(): fc.Arbitrary<string> {
  return fc
    .tuple(arbitraryRemoteName(), arbitraryLocalBranchName())
    .map(([remote, branch]) => `${remote}/${branch}`);
}

// ─── Mock Helpers ─────────────────────────────────────────────────────────────

/**
 * Create a mock IGitService that tracks executeCommand calls via vscode.commands.
 */
function createMockGitService(): IGitService {
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
  } as IGitService;
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
 * Create a BranchTreeItem with the given branch name and type.
 */
function createBranchTreeItem(
  branchName: string,
  type: 'local' | 'remote' = 'local'
): BranchTreeItem {
  const branch: IBranch = {
    name: branchName,
    type,
    commit: 'abc1234567890abcdef1234567890abcdef123456',
    isHead: false,
  };

  const itemType = type === 'local' ? 'local-branch' : 'remote-branch';

  return new BranchTreeItem(
    branchName,
    0, // TreeItemCollapsibleState.None
    itemType,
    branch,
    undefined,
    false
  );
}

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: branch-context-menu - Show Diff Property Tests', () => {
  describe('Property 5: Show Diff uses correct branch reference', () => {
    /**
     * **Validates: Requirements 7.3**
     *
     * For any branch (local or remote), when the Show Diff with Working Tree
     * command handler is invoked, the handler SHALL open a diff comparison
     * using the right-clicked branch's ref as the comparison base.
     */

    let originalExecuteCommand: typeof vscode.commands.executeCommand;

    beforeEach(() => {
      originalExecuteCommand = vscode.commands.executeCommand;
    });

    afterEach(() => {
      (vscode.commands as any).executeCommand = originalExecuteCommand;
    });

    it('Show Diff handler opens diff with correct local branch ref', () => {
      fc.assert(
        fc.asyncProperty(arbitraryLocalBranchName(), async (branchName) => {
          // Track executeCommand calls
          const executeCommandCalls: Array<{ command: string; args: unknown[] }> = [];
          (vscode.commands as any).executeCommand = async (
            command: string,
            ...args: unknown[]
          ): Promise<undefined> => {
            executeCommandCalls.push({ command, args });
            return undefined;
          };

          // Setup
          const gitService = createMockGitService();
          const branchTreeProvider = createMockBranchTreeProvider(gitService);
          const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);
          const item = createBranchTreeItem(branchName, 'local');

          // Act
          await (commands as any)._handleShowDiffWithWorkingTree(item);

          // Assert: executeCommand was called with 'vscode.diff'
          const diffCalls = executeCommandCalls.filter((c) => c.command === 'vscode.diff');
          assert.strictEqual(
            diffCalls.length,
            1,
            `Expected vscode.diff to be called once, but was called ${diffCalls.length} times`
          );

          // Assert: The left URI contains the correct branch ref
          const leftUri = diffCalls[0].args[0] as Uri;
          assert.ok(leftUri, 'Left URI should be provided');
          assert.ok(
            leftUri.path.includes(branchName),
            `Left URI path "${leftUri.path}" should contain branch ref "${branchName}"`
          );

          // Assert: The title contains the branch ref
          const title = diffCalls[0].args[2] as string;
          assert.ok(title, 'Diff title should be provided');
          assert.ok(
            title.includes(branchName),
            `Diff title "${title}" should contain branch ref "${branchName}"`
          );
        }),
        { numRuns: 100 }
      );
    });

    it('Show Diff handler opens diff with correct remote branch ref', () => {
      fc.assert(
        fc.asyncProperty(arbitraryRemoteBranchRef(), async (remoteBranchRef) => {
          // Track executeCommand calls
          const executeCommandCalls: Array<{ command: string; args: unknown[] }> = [];
          (vscode.commands as any).executeCommand = async (
            command: string,
            ...args: unknown[]
          ): Promise<undefined> => {
            executeCommandCalls.push({ command, args });
            return undefined;
          };

          // Setup
          const gitService = createMockGitService();
          const branchTreeProvider = createMockBranchTreeProvider(gitService);
          const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);
          const item = createBranchTreeItem(remoteBranchRef, 'remote');

          // Act
          await (commands as any)._handleShowDiffWithWorkingTree(item);

          // Assert: executeCommand was called with 'vscode.diff'
          const diffCalls = executeCommandCalls.filter((c) => c.command === 'vscode.diff');
          assert.strictEqual(
            diffCalls.length,
            1,
            `Expected vscode.diff to be called once, but was called ${diffCalls.length} times`
          );

          // Assert: The left URI contains the correct remote branch ref
          const leftUri = diffCalls[0].args[0] as Uri;
          assert.ok(leftUri, 'Left URI should be provided');
          assert.ok(
            leftUri.path.includes(remoteBranchRef),
            `Left URI path "${leftUri.path}" should contain remote branch ref "${remoteBranchRef}"`
          );

          // Assert: The title contains the remote branch ref
          const title = diffCalls[0].args[2] as string;
          assert.ok(title, 'Diff title should be provided');
          assert.ok(
            title.includes(remoteBranchRef),
            `Diff title "${title}" should contain remote branch ref "${remoteBranchRef}"`
          );
        }),
        { numRuns: 100 }
      );
    });

    it('Show Diff handler constructs URI with git-branch scheme', () => {
      fc.assert(
        fc.asyncProperty(arbitraryLocalBranchName(), async (branchName) => {
          // Track executeCommand calls
          const executeCommandCalls: Array<{ command: string; args: unknown[] }> = [];
          (vscode.commands as any).executeCommand = async (
            command: string,
            ...args: unknown[]
          ): Promise<undefined> => {
            executeCommandCalls.push({ command, args });
            return undefined;
          };

          // Setup
          const gitService = createMockGitService();
          const branchTreeProvider = createMockBranchTreeProvider(gitService);
          const commands = new BranchContextMenuCommands(gitService, branchTreeProvider);
          const item = createBranchTreeItem(branchName, 'local');

          // Act
          await (commands as any)._handleShowDiffWithWorkingTree(item);

          // Assert: The left URI was constructed using Uri.parse with git-branch scheme
          const diffCalls = executeCommandCalls.filter((c) => c.command === 'vscode.diff');
          assert.strictEqual(diffCalls.length, 1);

          const leftUri = diffCalls[0].args[0] as Uri;
          // The URI is created via Uri.parse(`git-branch://${branchRef}`)
          // Our mock Uri.parse stores the full string in the path
          assert.ok(
            leftUri.path.includes(`git-branch://${branchName}`),
            `Left URI should be constructed with git-branch scheme for ref "${branchName}", got path: "${leftUri.path}"`
          );
        }),
        { numRuns: 100 }
      );
    });
  });
});
