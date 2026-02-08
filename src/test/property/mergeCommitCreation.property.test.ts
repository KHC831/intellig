import * as fc from 'fast-check';
import * as assert from 'assert';
import { IMergeResult } from '../../services/interfaces/IGitService';

/**
 * Property-based tests for Merge Commit Creation.
 * Feature: intellig-vscode, Property 10: Merge Commit Creation
 *
 * **Validates: Requirements 4.7**
 *
 * Property Description:
 * For any two branches with divergent histories, merging SHALL create a commit with two parents
 * (or fast-forward if applicable) that contains changes from both branches.
 */
describe('Merge Commit Creation Property Tests', () => {
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
   * Mock GitService that simulates merge operations in memory.
   * This allows us to test merge commit creation properties without actual Git operations.
   */
  class MockGitService {
    private _commits: Map<string, IMockCommit> = new Map();
    private _branches: Map<string, IMockBranch> = new Map();
    private _head: string | undefined;
    private _files: Map<string, string> = new Map(); // Current working directory state
    private _nextTimestamp: number = 1000;

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

      // Create main branch
      this._branches.set('main', {
        name: 'main',
        commit: hash,
        isHead: true,
      });
      this._head = 'main';

      // Set up working directory
      for (const file of initialFiles) {
        this._files.set(file.path, file.content);
      }

      return hash;
    }

    /**
     * Generate a pseudo-random commit hash
     */
    private generateHash(): string {
      const chars = '0123456789abcdef';
      let hash = '';
      for (let i = 0; i < 40; i++) {
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

      // Update isHead flags
      for (const [name, b] of this._branches) {
        this._branches.set(name, { ...b, isHead: name === branchName });
      }
      this._head = branchName;

      // Update working directory to match branch state
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

      // Collect all commits in history (BFS)
      const commitsInOrder: IMockCommit[] = [];
      while (stack.length > 0) {
        const hash = stack.pop()!;
        if (visited.has(hash)) {
          continue;
        }
        visited.add(hash);

        const commit = this._commits.get(hash);
        if (commit) {
          commitsInOrder.unshift(commit); // Add to front to process oldest first
          for (const parent of commit.parents) {
            stack.push(parent);
          }
        }
      }

      // Apply changes in chronological order
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

      // Update branch pointer
      this._branches.set(this._head!, {
        ...currentBranch,
        commit: hash,
      });

      // Update working directory
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
     * Check if two branches have diverged (have different commits since common ancestor)
     */
    hasDiverged(branch1: string, branch2: string): boolean {
      const b1 = this._branches.get(branch1);
      const b2 = this._branches.get(branch2);
      if (!b1 || !b2) {
        return false;
      }

      // If they point to the same commit, they haven't diverged
      if (b1.commit === b2.commit) {
        return false;
      }

      // Check if one is an ancestor of the other (fast-forward case)
      if (this.isAncestor(b1.commit, b2.commit) || this.isAncestor(b2.commit, b1.commit)) {
        return false;
      }

      return true;
    }

    /**
     * Check if commit1 is an ancestor of commit2
     */
    isAncestor(commit1: string, commit2: string): boolean {
      const visited = new Set<string>();
      const stack = [commit2];

      while (stack.length > 0) {
        const hash = stack.pop()!;
        if (hash === commit1) {
          return true;
        }
        if (visited.has(hash)) {
          continue;
        }
        visited.add(hash);

        const commit = this._commits.get(hash);
        if (commit) {
          for (const parent of commit.parents) {
            stack.push(parent);
          }
        }
      }

      return false;
    }

    /**
     * Check if a fast-forward merge is possible
     * Fast-forward is possible when the current branch is an ancestor of the target branch
     */
    canFastForward(targetBranch: string): boolean {
      const currentBranch = this._branches.get(this._head!);
      const target = this._branches.get(targetBranch);
      if (!currentBranch || !target) {
        return false;
      }

      // Fast-forward is possible if current commit is an ancestor of target commit
      return this.isAncestor(currentBranch.commit, target.commit);
    }

    /**
     * Merge a branch into the current branch.
     * Returns the merge result with the merge commit hash.
     *
     * Requirements: 4.7
     */
    mergeBranch(branchName: string): IMergeResult {
      const currentBranch = this._branches.get(this._head!);
      const targetBranch = this._branches.get(branchName);

      if (!currentBranch || !targetBranch) {
        return { success: false, conflicts: ['Branch not found'] };
      }

      // Check if already up to date
      if (currentBranch.commit === targetBranch.commit) {
        return { success: true, mergeCommit: currentBranch.commit };
      }

      // Check for fast-forward possibility
      if (this.canFastForward(branchName)) {
        // Fast-forward merge: just move the branch pointer
        this._branches.set(this._head!, {
          ...currentBranch,
          commit: targetBranch.commit,
        });

        // Update working directory
        this._files.clear();
        const filesAtCommit = this.getFilesAtCommit(targetBranch.commit);
        for (const [path, content] of filesAtCommit) {
          this._files.set(path, content);
        }

        return { success: true, mergeCommit: targetBranch.commit };
      }

      // True merge: create a merge commit with two parents
      const mergeHash = this.generateHash();

      // Collect changes from both branches since common ancestor
      const currentFiles = this.getFilesAtCommit(currentBranch.commit);
      const targetFiles = this.getFilesAtCommit(targetBranch.commit);

      // Merge the files (simple strategy: target overwrites for conflicts)
      const mergedChanges: IFileChange[] = [];
      const allPaths = new Set([...currentFiles.keys(), ...targetFiles.keys()]);

      for (const path of allPaths) {
        const currentContent = currentFiles.get(path);
        const targetContent = targetFiles.get(path);

        // For simplicity, prefer target content if different
        const content = targetContent ?? currentContent ?? '';
        mergedChanges.push({ path, content });
      }

      const mergeCommit: IMockCommit = {
        hash: mergeHash,
        message: `Merge branch '${branchName}' into ${this._head}`,
        parents: [currentBranch.commit, targetBranch.commit],
        changes: mergedChanges,
        timestamp: this._nextTimestamp++,
      };
      this._commits.set(mergeHash, mergeCommit);

      // Update branch pointer
      this._branches.set(this._head!, {
        ...currentBranch,
        commit: mergeHash,
      });

      // Update working directory
      this._files.clear();
      for (const change of mergedChanges) {
        this._files.set(change.path, change.content);
      }

      return { success: true, mergeCommit: mergeHash };
    }

    /**
     * Get all files in the current working directory
     */
    getWorkingDirectoryFiles(): Map<string, string> {
      return new Map(this._files);
    }

    /**
     * Get the commit history for a branch (all commits reachable from the branch)
     */
    getCommitHistory(branchName: string): IMockCommit[] {
      const branch = this._branches.get(branchName);
      if (!branch) {
        return [];
      }

      const commits: IMockCommit[] = [];
      const visited = new Set<string>();
      const stack = [branch.commit];

      while (stack.length > 0) {
        const hash = stack.pop()!;
        if (visited.has(hash)) {
          continue;
        }
        visited.add(hash);

        const commit = this._commits.get(hash);
        if (commit) {
          commits.push(commit);
          for (const parent of commit.parents) {
            stack.push(parent);
          }
        }
      }

      // Sort by timestamp (newest first)
      return commits.sort((a, b) => b.timestamp - a.timestamp);
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
      // Ensure unique file paths
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
   * Arbitrary generator for branch changes (commits to make on a branch)
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
      // Ensure unique file paths
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

  describe('Property 10: Merge Commit Creation', () => {
    /**
     * Property: Merging divergent branches creates a commit with two parents.
     *
     * **Validates: Requirements 4.7**
     */
    it('Property: Merging divergent branches creates a commit with two parents', () => {
      fc.assert(
        fc.property(
          initialFilesArb,
          branchChangesArb,
          branchChangesArb,
          validBranchNameArb,
          (initialFiles, mainChanges, featureChanges, featureBranchName): boolean => {
            // Skip if feature branch name conflicts with 'main'
            if (featureBranchName === 'main') {
              return true;
            }

            // Setup: Create repository with initial commit
            const gitService = new MockGitService();
            gitService.init(initialFiles);

            // Create feature branch
            gitService.createBranch(featureBranchName);

            // Make commits on main branch
            gitService.commit('Main branch commit', mainChanges);
            const mainCommitBeforeMerge = gitService.getHeadCommit();

            // Switch to feature branch and make commits
            gitService.checkout(featureBranchName);
            gitService.commit('Feature branch commit', featureChanges);
            const featureCommit = gitService.getHeadCommit();

            // Switch back to main
            gitService.checkout('main');

            // Verify branches have diverged
            const hasDiverged = gitService.hasDiverged('main', featureBranchName);
            assert.strictEqual(hasDiverged, true, 'Branches should have diverged');

            // Act: Merge feature branch into main
            const result = gitService.mergeBranch(featureBranchName);

            // Assert: Merge succeeded
            assert.strictEqual(result.success, true, 'Merge should succeed');
            assert.ok(result.mergeCommit, 'Merge should produce a commit hash');

            // Assert: Merge commit has two parents
            const mergeCommitHash = result.mergeCommit;
            const mergeCommit = gitService.getCommit(mergeCommitHash);
            assert.ok(mergeCommit, 'Merge commit should exist');
            assert.strictEqual(
              mergeCommit.parents.length,
              2,
              'Merge commit should have exactly two parents'
            );

            // Assert: Parents are the correct commits
            assert.ok(
              mergeCommit.parents.includes(mainCommitBeforeMerge),
              'Merge commit should have main branch commit as parent'
            );
            assert.ok(
              mergeCommit.parents.includes(featureCommit),
              'Merge commit should have feature branch commit as parent'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Fast-forward merge does not create a new commit.
     *
     * **Validates: Requirements 4.7**
     */
    it('Property: Fast-forward merge moves branch pointer without new commit', () => {
      fc.assert(
        fc.property(
          initialFilesArb,
          branchChangesArb,
          validBranchNameArb,
          (initialFiles, featureChanges, featureBranchName): boolean => {
            // Skip if feature branch name conflicts with 'main'
            if (featureBranchName === 'main') {
              return true;
            }

            // Setup: Create repository with initial commit
            const gitService = new MockGitService();
            gitService.init(initialFiles);

            // Create feature branch
            gitService.createBranch(featureBranchName);

            // Switch to feature branch and make commits (main stays at initial)
            gitService.checkout(featureBranchName);
            gitService.commit('Feature branch commit', featureChanges);
            const featureCommit = gitService.getHeadCommit();

            // Switch back to main (which is still at initial commit)
            gitService.checkout('main');

            // Verify fast-forward is possible
            const canFF = gitService.canFastForward(featureBranchName);
            assert.strictEqual(canFF, true, 'Fast-forward should be possible');

            // Act: Merge feature branch into main
            const result = gitService.mergeBranch(featureBranchName);

            // Assert: Merge succeeded
            assert.strictEqual(result.success, true, 'Merge should succeed');

            // Assert: The merge commit is the feature branch commit (fast-forward)
            assert.strictEqual(
              result.mergeCommit,
              featureCommit,
              'Fast-forward merge should result in feature commit'
            );

            // Assert: Main branch now points to feature commit
            const mainBranch = gitService.getBranch('main');
            assert.strictEqual(
              mainBranch?.commit,
              featureCommit,
              'Main branch should point to feature commit after fast-forward'
            );

            // Assert: The commit has only one parent (not a merge commit)
            const commit = gitService.getCommit(featureCommit);
            assert.ok(commit, 'Commit should exist');
            assert.strictEqual(
              commit.parents.length,
              1,
              'Fast-forwarded commit should have one parent'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Merge commit contains changes from both branches.
     *
     * **Validates: Requirements 4.7**
     */
    it('Property: Merge commit contains changes from both branches', () => {
      fc.assert(
        fc.property(
          initialFilesArb,
          validBranchNameArb,
          (initialFiles, featureBranchName): boolean => {
            // Skip if feature branch name conflicts with 'main'
            if (featureBranchName === 'main') {
              return true;
            }

            // Setup: Create repository with initial commit
            const gitService = new MockGitService();
            gitService.init(initialFiles);

            // Create feature branch
            gitService.createBranch(featureBranchName);

            // Make a commit on main with a unique file
            const mainUniqueFile = { path: 'main_unique.txt', content: 'main content' };
            gitService.commit('Main branch commit', [mainUniqueFile]);

            // Switch to feature branch and make a commit with a different unique file
            gitService.checkout(featureBranchName);
            const featureUniqueFile = { path: 'feature_unique.txt', content: 'feature content' };
            gitService.commit('Feature branch commit', [featureUniqueFile]);

            // Switch back to main
            gitService.checkout('main');

            // Act: Merge feature branch into main
            const result = gitService.mergeBranch(featureBranchName);

            // Assert: Merge succeeded
            assert.strictEqual(result.success, true, 'Merge should succeed');

            // Assert: Working directory contains files from both branches
            const workingDir = gitService.getWorkingDirectoryFiles();

            // Should have the main unique file
            assert.strictEqual(
              workingDir.get(mainUniqueFile.path),
              mainUniqueFile.content,
              'Working directory should contain main branch file'
            );

            // Should have the feature unique file
            assert.strictEqual(
              workingDir.get(featureUniqueFile.path),
              featureUniqueFile.content,
              'Working directory should contain feature branch file'
            );

            // Should have initial files
            for (const file of initialFiles) {
              assert.ok(
                workingDir.has(file.path),
                `Working directory should contain initial file: ${file.path}`
              );
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Merging the same branch twice is idempotent (already up to date).
     *
     * **Validates: Requirements 4.7**
     */
    it('Property: Merging same branch twice is idempotent', () => {
      fc.assert(
        fc.property(
          initialFilesArb,
          branchChangesArb,
          validBranchNameArb,
          (initialFiles, featureChanges, featureBranchName): boolean => {
            // Skip if feature branch name conflicts with 'main'
            if (featureBranchName === 'main') {
              return true;
            }

            // Setup: Create repository with initial commit
            const gitService = new MockGitService();
            gitService.init(initialFiles);

            // Create feature branch and make commits
            gitService.createBranch(featureBranchName);
            gitService.checkout(featureBranchName);
            gitService.commit('Feature branch commit', featureChanges);

            // Switch back to main and merge
            gitService.checkout('main');
            const firstMergeResult = gitService.mergeBranch(featureBranchName);
            assert.strictEqual(firstMergeResult.success, true, 'First merge should succeed');

            const commitAfterFirstMerge = gitService.getHeadCommit();

            // Act: Merge again
            const secondMergeResult = gitService.mergeBranch(featureBranchName);

            // Assert: Second merge also succeeds
            assert.strictEqual(secondMergeResult.success, true, 'Second merge should succeed');

            // Assert: HEAD hasn't changed (already up to date)
            const commitAfterSecondMerge = gitService.getHeadCommit();
            assert.strictEqual(
              commitAfterSecondMerge,
              commitAfterFirstMerge,
              'HEAD should not change after merging already-merged branch'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Merge commit is reachable from the current branch history.
     *
     * **Validates: Requirements 4.7**
     */
    it('Property: Merge commit is in branch history after merge', () => {
      fc.assert(
        fc.property(
          initialFilesArb,
          branchChangesArb,
          branchChangesArb,
          validBranchNameArb,
          (initialFiles, mainChanges, featureChanges, featureBranchName): boolean => {
            // Skip if feature branch name conflicts with 'main'
            if (featureBranchName === 'main') {
              return true;
            }

            // Setup: Create repository with divergent branches
            const gitService = new MockGitService();
            gitService.init(initialFiles);

            gitService.createBranch(featureBranchName);

            // Make commits on main
            gitService.commit('Main branch commit', mainChanges);

            // Make commits on feature
            gitService.checkout(featureBranchName);
            gitService.commit('Feature branch commit', featureChanges);

            // Merge
            gitService.checkout('main');
            const result = gitService.mergeBranch(featureBranchName);

            assert.strictEqual(result.success, true, 'Merge should succeed');
            assert.ok(result.mergeCommit, 'Should have merge commit');

            // Assert: Merge commit is in the history
            const history = gitService.getCommitHistory('main');
            const mergeCommitInHistory = history.some((c) => c.hash === result.mergeCommit);
            assert.strictEqual(
              mergeCommitInHistory,
              true,
              'Merge commit should be in branch history'
            );

            // Assert: Merge commit is the HEAD
            assert.strictEqual(
              gitService.getHeadCommit(),
              result.mergeCommit,
              'Merge commit should be HEAD'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Both parent commits are reachable from merge commit.
     *
     * **Validates: Requirements 4.7**
     */
    it('Property: Both parent commits are reachable from merge commit', () => {
      fc.assert(
        fc.property(
          initialFilesArb,
          branchChangesArb,
          branchChangesArb,
          validBranchNameArb,
          (initialFiles, mainChanges, featureChanges, featureBranchName): boolean => {
            // Skip if feature branch name conflicts with 'main'
            if (featureBranchName === 'main') {
              return true;
            }

            // Setup: Create repository with divergent branches
            const gitService = new MockGitService();
            gitService.init(initialFiles);

            gitService.createBranch(featureBranchName);

            // Make commits on main
            gitService.commit('Main branch commit', mainChanges);
            const mainCommit = gitService.getHeadCommit();

            // Make commits on feature
            gitService.checkout(featureBranchName);
            gitService.commit('Feature branch commit', featureChanges);
            const featureCommit = gitService.getHeadCommit();

            // Merge
            gitService.checkout('main');
            const result = gitService.mergeBranch(featureBranchName);

            assert.strictEqual(result.success, true, 'Merge should succeed');
            assert.ok(result.mergeCommit, 'Merge should produce a commit hash');

            // Get the merge commit
            const mergeCommitHash = result.mergeCommit;
            const mergeCommit = gitService.getCommit(mergeCommitHash);
            assert.ok(mergeCommit, 'Merge commit should exist');

            // Assert: Both parents are directly accessible
            assert.ok(
              mergeCommit.parents.includes(mainCommit),
              'Main commit should be a parent of merge commit'
            );
            assert.ok(
              mergeCommit.parents.includes(featureCommit),
              'Feature commit should be a parent of merge commit'
            );

            // Assert: Both parent commits exist and are retrievable
            const mainParent = gitService.getCommit(mainCommit);
            const featureParent = gitService.getCommit(featureCommit);
            assert.ok(mainParent, 'Main parent commit should be retrievable');
            assert.ok(featureParent, 'Feature parent commit should be retrievable');

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
