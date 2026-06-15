/**
 * Unit tests for CommandTitleProvider and resolveLabel.
 *
 * Tests the pure label resolution function and the CommandTitleProvider class
 * behavior including selection handling, title updates, and disposal.
 */

/*
 * Stub factories synthesise IGitService implementations whose member
 * signatures return `Promise<T>`; no-await stub bodies are intentional here.
 */

import '../setup';
import * as assert from 'assert';
import { resolveLabel, CommandTitleProvider } from '../../commits/CommandTitleProvider';
import { EventEmitter } from '../mocks/vscode';
import { noopEvent } from '../mocks/noopEvent';
import {
  IGitService,
  IRepository,
  IBranch,
  IFetchResult,
} from '../../git-core/interfaces/IGitService';
import { BranchTreeItem, BranchTreeProvider } from '../../branches/BranchTreeProvider';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a minimal mock IGitService for testing.
 */
function createMockGitService(): IGitService {
  const repoChangeEmitter = new EventEmitter<IRepository>();
  return {
    onDidChangeRepository: repoChangeEmitter.event,
    onDidRemoveRepository: noopEvent<IRepository>(),
    getRepositories: () => [],
    getRepository: async () => undefined,
    reloadRepository: async () => undefined,
    getBranches: async () => [],
    getTags: async () => [],
    commit: async () => {},
    amend: async () => {},
    createBranch: async () => {},
    checkout: async () => {},
    deleteBranch: async () => {},
    renameBranch: async () => {},
    setBranchUpstream: async () => {},
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
    stashBranch: async () => {},
    stashRename: async () => {},
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
    revertHunk: async () => {},
    revertFile: async () => {},
    dispose: () => {},
  } as IGitService;
}

/**
 * Create a minimal mock BranchTreeProvider with a configurable repository.
 */
function createMockBranchTreeProvider(headName?: string): BranchTreeProvider {
  const mockGitService = createMockGitService();
  const provider = new BranchTreeProvider(mockGitService);

  // Override getRepository to return a mock repo with the specified head
  const mockRepo: IRepository = {
    rootUri: {
      scheme: 'file',
      authority: '',
      path: '/test',
      query: '',
      fragment: '',
      fsPath: '/test',
    } as unknown as IRepository['rootUri'],
    state: 'idle',
    head: headName ? { name: headName, ahead: 0, behind: 0 } : undefined,
    remotes: [],
    submodules: [],
  };

  provider.getRepository = () => mockRepo;
  return provider;
}

/**
 * Create a mock BranchTreeItem for testing.
 */
function createMockBranchTreeItem(branchName: string): BranchTreeItem {
  const branch: IBranch = {
    name: branchName,
    type: 'local',
    commit: 'abc1234',
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

// ─── resolveLabel Tests ───────────────────────────────────────────────────────

describe('resolveLabel', () => {
  it('should substitute {branch} placeholder with the branch name', () => {
    const result = resolveLabel("New Branch from '{branch}'", 'feature/login', 'main');
    assert.strictEqual(result, "New Branch from 'feature/login'");
  });

  it('should substitute {current} placeholder with the current branch name', () => {
    const result = resolveLabel("Compare with '{current}'", 'feature/login', 'main');
    assert.strictEqual(result, "Compare with 'main'");
  });

  it('should substitute both {branch} and {current} placeholders', () => {
    const result = resolveLabel("Rebase '{current}' onto '{branch}'", 'develop', 'main');
    assert.strictEqual(result, "Rebase 'main' onto 'develop'");
  });

  it('should substitute {branch} in merge template', () => {
    const result = resolveLabel("Merge '{branch}' into '{current}'", 'feature/auth', 'develop');
    assert.strictEqual(result, "Merge 'feature/auth' into 'develop'");
  });

  it('should handle branch names with slashes', () => {
    const result = resolveLabel("New Branch from '{branch}'", 'feature/deep/nested/branch', 'main');
    assert.strictEqual(result, "New Branch from 'feature/deep/nested/branch'");
  });

  it('should handle branch names with dots', () => {
    const result = resolveLabel("Compare with '{current}'", 'release/1.0', 'release/2.0.1');
    assert.strictEqual(result, "Compare with 'release/2.0.1'");
  });

  it('should handle branch names with special characters', () => {
    const result = resolveLabel(
      "Merge '{branch}' into '{current}'",
      'fix/issue-123_hotfix',
      'main'
    );
    assert.strictEqual(result, "Merge 'fix/issue-123_hotfix' into 'main'");
  });

  it('should handle "HEAD" as current branch name for detached state', () => {
    const result = resolveLabel("Compare with '{current}'", 'feature/test', 'HEAD');
    assert.strictEqual(result, "Compare with 'HEAD'");
  });

  it('should handle templates with only {current} placeholder', () => {
    const result = resolveLabel("Checkout and Rebase onto '{current}'", 'feature/test', 'main');
    assert.strictEqual(result, "Checkout and Rebase onto 'main'");
  });

  it('should handle pull templates with only {current} placeholder', () => {
    const result = resolveLabel("Pull into '{current}' Using Rebase", 'origin/main', 'develop');
    assert.strictEqual(result, "Pull into 'develop' Using Rebase");
  });

  it('should handle pull merge template', () => {
    const result = resolveLabel("Pull into '{current}' Using Merge", 'origin/main', 'develop');
    assert.strictEqual(result, "Pull into 'develop' Using Merge");
  });

  it('should return template unchanged when no placeholders present', () => {
    const result = resolveLabel('Checkout', 'feature/test', 'main');
    assert.strictEqual(result, 'Checkout');
  });

  it('should handle empty branch names', () => {
    const result = resolveLabel("New Branch from '{branch}'", '', 'main');
    assert.strictEqual(result, "New Branch from ''");
  });

  it('should handle multiple occurrences of the same placeholder', () => {
    const result = resolveLabel('{branch} and {branch}', 'test', 'main');
    assert.strictEqual(result, 'test and test');
  });
});

// ─── CommandTitleProvider Tests ───────────────────────────────────────────────

describe('CommandTitleProvider', () => {
  describe('_getCurrentBranchName', () => {
    it('should return branch name stripped of refs/heads/ prefix', () => {
      const branchTreeProvider = createMockBranchTreeProvider('refs/heads/main');
      const gitService = createMockGitService();
      const provider = new CommandTitleProvider(gitService, branchTreeProvider);

      const result = provider._getCurrentBranchName();
      assert.strictEqual(result, 'main');
    });

    it('should return branch name as-is when no refs/heads/ prefix', () => {
      const branchTreeProvider = createMockBranchTreeProvider('develop');
      const gitService = createMockGitService();
      const provider = new CommandTitleProvider(gitService, branchTreeProvider);

      const result = provider._getCurrentBranchName();
      assert.strictEqual(result, 'develop');
    });

    it('should return "HEAD" when head name is undefined (detached state)', () => {
      const branchTreeProvider = createMockBranchTreeProvider(undefined);
      const gitService = createMockGitService();
      const provider = new CommandTitleProvider(gitService, branchTreeProvider);

      const result = provider._getCurrentBranchName();
      assert.strictEqual(result, 'HEAD');
    });

    it('should return "HEAD" when repository is undefined', () => {
      const mockGitService = createMockGitService();
      const branchTreeProvider = new BranchTreeProvider(mockGitService);
      // Don't set a repository — getRepository() returns undefined
      const provider = new CommandTitleProvider(mockGitService, branchTreeProvider);

      const result = provider._getCurrentBranchName();
      assert.strictEqual(result, 'HEAD');
    });

    it('should strip refs/heads/ from nested branch names', () => {
      const branchTreeProvider = createMockBranchTreeProvider('refs/heads/feature/deep/branch');
      const gitService = createMockGitService();
      const provider = new CommandTitleProvider(gitService, branchTreeProvider);

      const result = provider._getCurrentBranchName();
      assert.strictEqual(result, 'feature/deep/branch');
    });
  });

  describe('_updateTitles', () => {
    it('should not throw when called with undefined', () => {
      const branchTreeProvider = createMockBranchTreeProvider('main');
      const gitService = createMockGitService();
      const provider = new CommandTitleProvider(gitService, branchTreeProvider);

      assert.doesNotThrow(() => {
        provider._updateTitles(undefined);
      });
    });

    it('should not throw when called with a valid branch item', () => {
      const branchTreeProvider = createMockBranchTreeProvider('main');
      const gitService = createMockGitService();
      const provider = new CommandTitleProvider(gitService, branchTreeProvider);
      const item = createMockBranchTreeItem('feature/test');

      assert.doesNotThrow(() => {
        provider._updateTitles(item);
      });
    });

    it('should not throw when called with an item without a branch', () => {
      const branchTreeProvider = createMockBranchTreeProvider('main');
      const gitService = createMockGitService();
      const provider = new CommandTitleProvider(gitService, branchTreeProvider);

      // Create a category item (no branch)
      const item = new BranchTreeItem(
        'Local',
        1, // TreeItemCollapsibleState.Expanded
        'category'
      );

      assert.doesNotThrow(() => {
        provider._updateTitles(item);
      });
    });
  });

  describe('dispose', () => {
    it('should not throw when disposing without registration', () => {
      const branchTreeProvider = createMockBranchTreeProvider('main');
      const gitService = createMockGitService();
      const provider = new CommandTitleProvider(gitService, branchTreeProvider);

      assert.doesNotThrow(() => {
        provider.dispose();
      });
    });

    it('should clean up after updating titles and disposing', () => {
      const branchTreeProvider = createMockBranchTreeProvider('main');
      const gitService = createMockGitService();
      const provider = new CommandTitleProvider(gitService, branchTreeProvider);
      const item = createMockBranchTreeItem('feature/test');

      // Update titles to create disposables
      provider._updateTitles(item);

      // Dispose should clean up
      assert.doesNotThrow(() => {
        provider.dispose();
      });
    });
  });

  describe('gitService getter', () => {
    it('should return the git service passed to constructor', () => {
      const branchTreeProvider = createMockBranchTreeProvider('main');
      const gitService = createMockGitService();
      const provider = new CommandTitleProvider(gitService, branchTreeProvider);

      assert.strictEqual(provider.gitService, gitService);
    });
  });

  describe('edge cases', () => {
    it('should return "HEAD" when head object exists but name is empty string', () => {
      const branchTreeProvider = createMockBranchTreeProvider('');
      const gitService = createMockGitService();
      const provider = new CommandTitleProvider(gitService, branchTreeProvider);

      // Empty string is falsy, so should fall back to "HEAD"
      const result = provider._getCurrentBranchName();
      assert.strictEqual(result, 'HEAD');
    });

    it('should dispose title disposables when _updateTitles is called multiple times', () => {
      const branchTreeProvider = createMockBranchTreeProvider('main');
      const gitService = createMockGitService();
      const provider = new CommandTitleProvider(gitService, branchTreeProvider);

      const item1 = createMockBranchTreeItem('feature/first');
      const item2 = createMockBranchTreeItem('feature/second');

      // First update creates disposables
      provider._updateTitles(item1);
      // Second update should dispose previous and create new ones
      provider._updateTitles(item2);

      // Final dispose should clean up the second set
      assert.doesNotThrow(() => {
        provider.dispose();
      });
    });

    it('should clear title disposables when _updateTitles is called with undefined after a valid item', () => {
      const branchTreeProvider = createMockBranchTreeProvider('main');
      const gitService = createMockGitService();
      const provider = new CommandTitleProvider(gitService, branchTreeProvider);

      const item = createMockBranchTreeItem('feature/test');

      // First update creates disposables
      provider._updateTitles(item);
      // Calling with undefined should dispose and clear
      provider._updateTitles(undefined);

      // Dispose should be safe (nothing to clean up)
      assert.doesNotThrow(() => {
        provider.dispose();
      });
    });

    it('should handle dispose being called multiple times safely', () => {
      const branchTreeProvider = createMockBranchTreeProvider('main');
      const gitService = createMockGitService();
      const provider = new CommandTitleProvider(gitService, branchTreeProvider);

      const item = createMockBranchTreeItem('feature/test');
      provider._updateTitles(item);

      // Dispose twice should not throw
      assert.doesNotThrow(() => {
        provider.dispose();
        provider.dispose();
      });
    });
  });
});
