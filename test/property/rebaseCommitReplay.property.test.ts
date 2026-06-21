import * as fc from 'fast-check';
import * as assert from 'assert';

/**
 * Property-based tests for Rebase Commit Replay.
 * Feature: intellig-vscode, Property 11: Rebase Commit Replay
 *
 *
 * Property Description:
 * For any rebase operation, the rebased commits SHALL have the same diffs as the original
 * commits but with new commit hashes and updated parent references.
 */
describe('Rebase Commit Replay Property Tests', () => {
  /**
   * Arbitrary generator for valid branch names.
   */
  const validBranchNameArb: fc.Arbitrary<string> = fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'.split('')
      ),
      { minLength: 1, maxLength: 30 }
    )
    .filter((s) => {
      if (s.length === 0) {
        return false;
      }
      if (s.startsWith('.')) {
        return false;
      }
      if (s.startsWith('-')) {
        return false;
      }
      if (s.endsWith('.lock')) {
        return false;
      }
      if (s === 'HEAD' || s === 'head') {
        return false;
      }
      return true;
    });

  /**
   * Arbitrary generator for file names
   */
  const fileNameArb: fc.Arbitrary<string> = fc
    .stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
      minLength: 1,
      maxLength: 20,
    })
    .map((s) => `${s}.txt`);

  /**
   * Arbitrary generator for file content
   */
  const fileContentArb: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 100 });

  /**
   * Represents a file change in a commit
   */
  interface IFileChange {
    path: string;
    content: string;
  }

  /**
   * Represents a diff for a commit
   */
  interface ICommitDiff {
    path: string;
    oldContent: string | null;
    newContent: string | null;
  }

  /**
   * Represents a commit in the mock repository
   */
  interface IMockCommit {
    hash: string;
    message: string;
    parents: string[];
    changes: IFileChange[];
    timestamp: number;
  }

  /**
   * Represents a branch in the mock repository
   */
  interface IMockBranch {
    name: string;
    commit: string;
    isHead: boolean;
  }

  /**
   * Mock GitService that simulates rebase operations in memory.
   * This allows us to test rebase commit replay properties without actual Git operations.
   */
  class MockGitService {
    private _commits: Map<string, IMockCommit> = new Map();
    private _branches: Map<string, IMockBranch> = new Map();
    private _head: string | undefined;
    private _files: Map<string, string> = new Map();
    private _nextTimestamp: number = 1000;
    private _hashCounter: number = 0;

    constructor() {
      // Initialize with an empty repository
    }

    /**
     * Initialize the repository with an initial commit
     */
    init(initialFiles: IFileChange[]): string {
      const hash = this.generateHash();
      const commit: IMockCommit = {
        hash,
        message: 'Initial commit',
        parents: [],
        changes: initialFiles,
        timestamp: this._nextTimestamp++,
      };
      this._commits.set(hash, commit);

      this._branches.set('main', {
        name: 'main',
        commit: hash,
        isHead: true,
      });
      this._head = 'main';

      for (const file of initialFiles) {
        this._files.set(file.path, file.content);
      }

      return hash;
    }

    /**
     * Generate a unique commit hash
     */
    private generateHash(): string {
      const chars = '0123456789abcdef';
      let hash = '';
      // Use counter to ensure uniqueness
      const counterStr = (this._hashCounter++).toString(16).padStart(8, '0');
      hash = counterStr;
      for (let i = 8; i < 40; i++) {
        hash += chars[Math.floor(Math.random() * chars.length)];
      }
      return hash;
    }

    /**
     * Create a new branch from the current HEAD
     */
    createBranch(name: string): void {
      if (this._branches.has(name)) {
        throw new Error(`Branch '${name}' already exists`);
      }

      const currentBranch = this._branches.get(this._head!);
      if (!currentBranch) {
        throw new Error('No current branch');
      }

      this._branches.set(name, {
        name,
        commit: currentBranch.commit,
        isHead: false,
      });
    }

    /**
     * Checkout a branch
     */
    checkout(branchName: string): void {
      const branch = this._branches.get(branchName);
      if (!branch) {
        throw new Error(`Branch '${branchName}' not found`);
      }

      for (const [name, b] of this._branches) {
        this._branches.set(name, { ...b, isHead: name === branchName });
      }
      this._head = branchName;

      this._files.clear();
      const filesAtCommit = this.getFilesAtCommit(branch.commit);
      for (const [path, content] of filesAtCommit) {
        this._files.set(path, content);
      }
    }

    /**
     * Get all files at a specific commit by traversing history
     */
    private getFilesAtCommit(commitHash: string): Map<string, string> {
      const files = new Map<string, string>();
      const visited = new Set<string>();
      const stack = [commitHash];

      const commitsInOrder: IMockCommit[] = [];
      while (stack.length > 0) {
        const hash = stack.pop()!;
        if (visited.has(hash)) {
          continue;
        }
        visited.add(hash);

        const commit = this._commits.get(hash);
        if (commit) {
          commitsInOrder.unshift(commit);
          for (const parent of commit.parents) {
            stack.push(parent);
          }
        }
      }

      for (const commit of commitsInOrder) {
        for (const change of commit.changes) {
          files.set(change.path, change.content);
        }
      }

      return files;
    }

    /**
     * Create a commit on the current branch
     */
    commit(message: string, changes: IFileChange[]): string {
      const currentBranch = this._branches.get(this._head!);
      if (!currentBranch) {
        throw new Error('No current branch');
      }

      const hash = this.generateHash();
      const commit: IMockCommit = {
        hash,
        message,
        parents: [currentBranch.commit],
        changes,
        timestamp: this._nextTimestamp++,
      };
      this._commits.set(hash, commit);

      this._branches.set(this._head!, {
        ...currentBranch,
        commit: hash,
      });

      for (const change of changes) {
        this._files.set(change.path, change.content);
      }

      return hash;
    }

    /**
     * Get a commit by hash
     */
    getCommit(hash: string): IMockCommit | undefined {
      return this._commits.get(hash);
    }

    /**
     * Get the current HEAD commit hash
     */
    getHeadCommit(): string {
      const currentBranch = this._branches.get(this._head!);
      return currentBranch?.commit || '';
    }

    /**
     * Get a branch by name
     */
    getBranch(name: string): IMockBranch | undefined {
      return this._branches.get(name);
    }

    /**
     * Get the diff (changes) for a specific commit
     */
    getCommitDiff(hash: string): ICommitDiff[] {
      const commit = this._commits.get(hash);
      if (!commit) {
        return [];
      }

      const diffs: ICommitDiff[] = [];
      const parentFiles =
        commit.parents.length > 0
          ? this.getFilesAtCommit(commit.parents[0])
          : new Map<string, string>();

      for (const change of commit.changes) {
        diffs.push({
          path: change.path,
          oldContent: parentFiles.get(change.path) || null,
          newContent: change.content,
        });
      }

      return diffs;
    }

    /**
     * Get commits unique to branch1 that are not in branch2
     */
    private getCommitsUniqueTo(branch1: string, branch2: string): IMockCommit[] {
      const b1 = this._branches.get(branch1);
      const b2 = this._branches.get(branch2);
      if (!b1 || !b2) {
        return [];
      }

      // Get all commits reachable from branch2
      const branch2Commits = new Set<string>();
      const stack = [b2.commit];
      while (stack.length > 0) {
        const hash = stack.pop()!;
        if (branch2Commits.has(hash)) {
          continue;
        }
        branch2Commits.add(hash);
        const commit = this._commits.get(hash);
        if (commit) {
          for (const parent of commit.parents) {
            stack.push(parent);
          }
        }
      }

      // Get commits in branch1 not in branch2
      const uniqueCommits: IMockCommit[] = [];
      const visited = new Set<string>();
      const stack2 = [b1.commit];
      while (stack2.length > 0) {
        const hash = stack2.pop()!;
        if (visited.has(hash) || branch2Commits.has(hash)) {
          continue;
        }
        visited.add(hash);
        const commit = this._commits.get(hash);
        if (commit) {
          uniqueCommits.push(commit);
          for (const parent of commit.parents) {
            stack2.push(parent);
          }
        }
      }

      return uniqueCommits.sort((a, b) => a.timestamp - b.timestamp);
    }

    /**
     * Rebase the current branch onto another branch.
     * Returns the mapping of original commit hashes to new commit hashes.
     */
    rebaseBranch(onto: string): { success: boolean; commitMapping: Map<string, string> } {
      const currentBranch = this._branches.get(this._head!);
      const ontoBranch = this._branches.get(onto);

      if (!currentBranch || !ontoBranch) {
        return { success: false, commitMapping: new Map() };
      }

      // Get commits to replay (commits unique to current branch)
      const commitsToReplay = this.getCommitsUniqueTo(this._head!, onto);

      if (commitsToReplay.length === 0) {
        // Nothing to rebase - already up to date or fast-forward
        return { success: true, commitMapping: new Map() };
      }

      const commitMapping = new Map<string, string>();
      let currentParent = ontoBranch.commit;

      // Replay each commit onto the new base
      for (const originalCommit of commitsToReplay) {
        const newHash = this.generateHash();

        // Create new commit with same changes but new hash and updated parent
        const newCommit: IMockCommit = {
          hash: newHash,
          message: originalCommit.message,
          parents: [currentParent],
          changes: [...originalCommit.changes], // Same changes
          timestamp: this._nextTimestamp++,
        };

        this._commits.set(newHash, newCommit);
        commitMapping.set(originalCommit.hash, newHash);
        currentParent = newHash;
      }

      // Update the current branch to point to the last rebased commit
      this._branches.set(this._head!, {
        ...currentBranch,
        commit: currentParent,
      });

      // Update working directory
      this._files.clear();
      const filesAtCommit = this.getFilesAtCommit(currentParent);
      for (const [path, content] of filesAtCommit) {
        this._files.set(path, content);
      }

      return { success: true, commitMapping };
    }
  }

  /**
   * Arbitrary generator for initial file setup
   */
  const initialFilesArb: fc.Arbitrary<IFileChange[]> = fc
    .array(
      fc.record({
        path: fileNameArb,
        content: fileContentArb,
      }),
      { minLength: 1, maxLength: 5 }
    )
    .map((files) => {
      const seen = new Set<string>();
      return files.filter((f) => {
        if (seen.has(f.path)) {
          return false;
        }
        seen.add(f.path);
        return true;
      });
    })
    .filter((files) => files.length > 0);

  /**
   * Arbitrary generator for branch changes
   */
  const branchChangesArb: fc.Arbitrary<IFileChange[]> = fc
    .array(
      fc.record({
        path: fileNameArb,
        content: fileContentArb,
      }),
      { minLength: 1, maxLength: 3 }
    )
    .map((files) => {
      const seen = new Set<string>();
      return files.filter((f) => {
        if (seen.has(f.path)) {
          return false;
        }
        seen.add(f.path);
        return true;
      });
    })
    .filter((files) => files.length > 0);

  /**
   * Compare two diffs for equality (same changes regardless of order)
   */
  function diffsAreEqual(diff1: ICommitDiff[], diff2: ICommitDiff[]): boolean {
    if (diff1.length !== diff2.length) {
      return false;
    }

    const sortedDiff1 = [...diff1].sort((a, b) => a.path.localeCompare(b.path));
    const sortedDiff2 = [...diff2].sort((a, b) => a.path.localeCompare(b.path));

    for (let i = 0; i < sortedDiff1.length; i++) {
      const d1 = sortedDiff1[i];
      const d2 = sortedDiff2[i];
      if (d1.path !== d2.path) {
        return false;
      }
      if (d1.newContent !== d2.newContent) {
        return false;
      }
      // Note: oldContent may differ due to different base, but the change itself should be the same
    }

    return true;
  }

  describe('Property 11: Rebase Commit Replay', () => {
    /**
     * Property: Rebased commits have the same diffs as original commits.
     */
    it('Property: Rebased commits have the same diffs as original commits', () => {
      fc.assert(
        fc.property(
          initialFilesArb,
          branchChangesArb,
          branchChangesArb,
          validBranchNameArb,
          (initialFiles, mainChanges, featureChanges, featureBranchName): boolean => {
            if (featureBranchName === 'main') {
              return true;
            }

            // Setup: Create repository with initial commit
            const gitService = new MockGitService();
            gitService.init(initialFiles);

            // Create feature branch from initial commit
            gitService.createBranch(featureBranchName);

            // Make commits on main branch
            gitService.commit('Main branch commit', mainChanges);

            // Switch to feature branch and make commits
            gitService.checkout(featureBranchName);
            const featureCommitHash = gitService.commit('Feature branch commit', featureChanges);

            // Get the original diff before rebase
            const originalDiff = gitService.getCommitDiff(featureCommitHash);

            // Act: Rebase feature branch onto main
            const result = gitService.rebaseBranch('main');

            // Assert: Rebase succeeded
            assert.strictEqual(result.success, true, 'Rebase should succeed');

            // Assert: We have a mapping for the original commit
            assert.ok(
              result.commitMapping.has(featureCommitHash),
              'Should have mapping for original commit'
            );

            // Get the new commit hash
            const newCommitHash = result.commitMapping.get(featureCommitHash)!;

            // Get the diff of the rebased commit
            const rebasedDiff = gitService.getCommitDiff(newCommitHash);

            // Assert: The diffs have the same changes (same files modified with same new content)
            assert.strictEqual(
              originalDiff.length,
              rebasedDiff.length,
              'Rebased commit should have same number of file changes'
            );

            for (const origChange of originalDiff) {
              const rebasedChange = rebasedDiff.find((d) => d.path === origChange.path);
              assert.ok(rebasedChange, `Rebased commit should have change for ${origChange.path}`);
              assert.strictEqual(
                rebasedChange.newContent,
                origChange.newContent,
                `File ${origChange.path} should have same new content after rebase`
              );
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Rebased commits have new commit hashes.
     */
    it('Property: Rebased commits have new commit hashes', () => {
      fc.assert(
        fc.property(
          initialFilesArb,
          branchChangesArb,
          branchChangesArb,
          validBranchNameArb,
          (initialFiles, mainChanges, featureChanges, featureBranchName): boolean => {
            if (featureBranchName === 'main') {
              return true;
            }

            // Setup
            const gitService = new MockGitService();
            gitService.init(initialFiles);
            gitService.createBranch(featureBranchName);
            gitService.commit('Main branch commit', mainChanges);

            gitService.checkout(featureBranchName);
            const originalCommitHash = gitService.commit('Feature branch commit', featureChanges);

            // Act: Rebase
            const result = gitService.rebaseBranch('main');

            // Assert
            assert.strictEqual(result.success, true, 'Rebase should succeed');
            assert.ok(
              result.commitMapping.has(originalCommitHash),
              'Should have mapping for original commit'
            );

            const newCommitHash = result.commitMapping.get(originalCommitHash)!;

            // Assert: New hash is different from original
            assert.notStrictEqual(
              newCommitHash,
              originalCommitHash,
              'Rebased commit should have a new hash'
            );

            // Assert: New commit exists
            const newCommit = gitService.getCommit(newCommitHash);
            assert.ok(newCommit, 'New commit should exist in repository');

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Rebased commits have updated parent references.
     */
    it('Property: Rebased commits have updated parent references', () => {
      fc.assert(
        fc.property(
          initialFilesArb,
          branchChangesArb,
          branchChangesArb,
          validBranchNameArb,
          (initialFiles, mainChanges, featureChanges, featureBranchName): boolean => {
            if (featureBranchName === 'main') {
              return true;
            }

            // Setup
            const gitService = new MockGitService();
            const initialCommit = gitService.init(initialFiles);
            gitService.createBranch(featureBranchName);
            const mainCommit = gitService.commit('Main branch commit', mainChanges);

            gitService.checkout(featureBranchName);
            const originalCommitHash = gitService.commit('Feature branch commit', featureChanges);

            // Get original commit's parent (should be initial commit)
            const originalCommit = gitService.getCommit(originalCommitHash);
            assert.ok(originalCommit, 'Original commit should exist');
            assert.strictEqual(
              originalCommit.parents[0],
              initialCommit,
              'Original commit parent should be initial commit'
            );

            // Act: Rebase onto main
            const result = gitService.rebaseBranch('main');

            // Assert
            assert.strictEqual(result.success, true, 'Rebase should succeed');

            const newCommitHash = result.commitMapping.get(originalCommitHash)!;
            const newCommit = gitService.getCommit(newCommitHash);
            assert.ok(newCommit, 'New commit should exist');

            // Assert: New commit's parent is the main branch commit (not initial commit)
            assert.strictEqual(
              newCommit.parents.length,
              1,
              'Rebased commit should have exactly one parent'
            );
            assert.strictEqual(
              newCommit.parents[0],
              mainCommit,
              'Rebased commit parent should be the main branch commit'
            );

            // Assert: Parent is different from original
            assert.notStrictEqual(
              newCommit.parents[0],
              originalCommit.parents[0],
              'Rebased commit should have different parent than original'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Multiple commits are rebased in order with correct parent chain.
     */
    it('Property: Multiple commits are rebased in order with correct parent chain', () => {
      fc.assert(
        fc.property(
          initialFilesArb,
          branchChangesArb,
          branchChangesArb,
          branchChangesArb,
          validBranchNameArb,
          (
            initialFiles,
            mainChanges,
            featureChanges1,
            featureChanges2,
            featureBranchName
          ): boolean => {
            if (featureBranchName === 'main') {
              return true;
            }

            // Setup
            const gitService = new MockGitService();
            gitService.init(initialFiles);
            gitService.createBranch(featureBranchName);
            const mainCommit = gitService.commit('Main branch commit', mainChanges);

            // Make two commits on feature branch
            gitService.checkout(featureBranchName);
            const featureCommit1 = gitService.commit('Feature commit 1', featureChanges1);
            const featureCommit2 = gitService.commit('Feature commit 2', featureChanges2);

            // Get original diffs
            const originalDiff1 = gitService.getCommitDiff(featureCommit1);
            const originalDiff2 = gitService.getCommitDiff(featureCommit2);

            // Act: Rebase
            const result = gitService.rebaseBranch('main');

            // Assert
            assert.strictEqual(result.success, true, 'Rebase should succeed');
            assert.strictEqual(
              result.commitMapping.size,
              2,
              'Should have mappings for both commits'
            );

            const newCommit1Hash = result.commitMapping.get(featureCommit1)!;
            const newCommit2Hash = result.commitMapping.get(featureCommit2)!;

            const newCommit1 = gitService.getCommit(newCommit1Hash);
            const newCommit2 = gitService.getCommit(newCommit2Hash);

            assert.ok(newCommit1, 'First rebased commit should exist');
            assert.ok(newCommit2, 'Second rebased commit should exist');

            // Assert: First rebased commit's parent is main branch commit
            assert.strictEqual(
              newCommit1.parents[0],
              mainCommit,
              'First rebased commit parent should be main branch commit'
            );

            // Assert: Second rebased commit's parent is first rebased commit
            assert.strictEqual(
              newCommit2.parents[0],
              newCommit1Hash,
              'Second rebased commit parent should be first rebased commit'
            );

            // Assert: Diffs are preserved
            const rebasedDiff1 = gitService.getCommitDiff(newCommit1Hash);
            const rebasedDiff2 = gitService.getCommitDiff(newCommit2Hash);

            assert.ok(
              diffsAreEqual(originalDiff1, rebasedDiff1),
              'First commit diff should be preserved'
            );
            assert.ok(
              diffsAreEqual(originalDiff2, rebasedDiff2),
              'Second commit diff should be preserved'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Rebased commits preserve commit messages.
     */
    it('Property: Rebased commits preserve commit messages', () => {
      fc.assert(
        fc.property(
          initialFilesArb,
          branchChangesArb,
          branchChangesArb,
          validBranchNameArb,
          fc.string({ minLength: 1, maxLength: 100 }),
          (
            initialFiles,
            mainChanges,
            featureChanges,
            featureBranchName,
            commitMessage
          ): boolean => {
            if (featureBranchName === 'main') {
              return true;
            }

            // Setup
            const gitService = new MockGitService();
            gitService.init(initialFiles);
            gitService.createBranch(featureBranchName);
            gitService.commit('Main branch commit', mainChanges);

            gitService.checkout(featureBranchName);
            const originalCommitHash = gitService.commit(commitMessage, featureChanges);

            // Get original message
            const originalCommit = gitService.getCommit(originalCommitHash);
            assert.ok(originalCommit, 'Original commit should exist');

            // Act: Rebase
            const result = gitService.rebaseBranch('main');

            // Assert
            assert.strictEqual(result.success, true, 'Rebase should succeed');

            const newCommitHash = result.commitMapping.get(originalCommitHash)!;
            const newCommit = gitService.getCommit(newCommitHash);
            assert.ok(newCommit, 'New commit should exist');

            // Assert: Message is preserved
            assert.strictEqual(
              newCommit.message,
              originalCommit.message,
              'Rebased commit should preserve the original commit message'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Branch HEAD points to last rebased commit after rebase.
     */
    it('Property: Branch HEAD points to last rebased commit after rebase', () => {
      fc.assert(
        fc.property(
          initialFilesArb,
          branchChangesArb,
          branchChangesArb,
          branchChangesArb,
          validBranchNameArb,
          (
            initialFiles,
            mainChanges,
            featureChanges1,
            featureChanges2,
            featureBranchName
          ): boolean => {
            if (featureBranchName === 'main') {
              return true;
            }

            // Setup
            const gitService = new MockGitService();
            gitService.init(initialFiles);
            gitService.createBranch(featureBranchName);
            gitService.commit('Main branch commit', mainChanges);

            gitService.checkout(featureBranchName);
            gitService.commit('Feature commit 1', featureChanges1);
            const lastOriginalCommit = gitService.commit('Feature commit 2', featureChanges2);

            // Act: Rebase
            const result = gitService.rebaseBranch('main');

            // Assert
            assert.strictEqual(result.success, true, 'Rebase should succeed');

            // Get the new hash for the last commit
            const lastRebasedCommit = result.commitMapping.get(lastOriginalCommit)!;

            // Assert: HEAD points to the last rebased commit
            const headCommit = gitService.getHeadCommit();
            assert.strictEqual(
              headCommit,
              lastRebasedCommit,
              'HEAD should point to the last rebased commit'
            );

            // Assert: Branch points to the last rebased commit
            const branch = gitService.getBranch(featureBranchName);
            assert.ok(branch, 'Feature branch should exist');
            assert.strictEqual(
              branch.commit,
              lastRebasedCommit,
              'Branch should point to the last rebased commit'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
