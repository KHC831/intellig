import * as fc from 'fast-check';
import * as assert from 'assert';
import { IBranch, IHead, BranchType } from '../../services/interfaces/IGitService';

/**
 * Property-based tests for Branch Lifecycle Consistency.
 * Feature: intellig-vscode, Property 8: Branch Lifecycle Consistency
 *
 * **Validates: Requirements 4.3, 4.4, 4.5, 4.9, 4.10**
 *
 * Property Description:
 * For any valid branch name and source ref, creating a branch SHALL add it to the branch list,
 * checking out SHALL update HEAD, renaming SHALL preserve the branch's commit history,
 * and deleting SHALL remove it from the branch list.
 */
describe('Branch Lifecycle Consistency Property Tests', () => {
  /**
   * Arbitrary generator for valid branch names.
   * Git branch names have specific rules:
   * - Cannot start with a dot
   * - Cannot contain consecutive dots
   * - Cannot contain spaces, ~, ^, :, ?, *, [, \, or control characters
   * - Cannot end with .lock
   * - Cannot be empty
   */
  const validBranchNameArb: fc.Arbitrary<string> = fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_/'.split('')
      ),
      { minLength: 1, maxLength: 50 }
    )
    .filter((s) => {
      // Filter out invalid branch names
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
      if (s.includes('..')) {
        return false;
      }
      if (s.startsWith('/') || s.endsWith('/')) {
        return false;
      }
      if (s.includes('//')) {
        return false;
      }
      // Avoid reserved names
      if (s === 'HEAD' || s === 'head') {
        return false;
      }
      return true;
    });

  /**
   * Arbitrary generator for commit hashes (40 character hex string)
   */
  const commitHashArb: fc.Arbitrary<string> = fc
    .hexaString({ minLength: 40, maxLength: 40 })
    .map((s) => s.toLowerCase());

  /**
   * Arbitrary generator for a branch object
   */
  const branchArb: fc.Arbitrary<IBranch> = fc.record({
    name: validBranchNameArb,
    type: fc.constant('local' as BranchType),
    commit: commitHashArb,
    upstream: fc.constant(undefined),
    isHead: fc.boolean(),
    ahead: fc.option(fc.nat({ max: 100 }), { nil: undefined }),
    behind: fc.option(fc.nat({ max: 100 }), { nil: undefined }),
  });

  /**
   * Arbitrary generator for an array of branches (simulating existing branches)
   */
  const existingBranchesArb: fc.Arbitrary<IBranch[]> = fc
    .array(branchArb, { minLength: 1, maxLength: 10 })
    .map((branches) => {
      // Ensure unique branch names
      const seen = new Set<string>();
      const uniqueBranches: IBranch[] = [];
      for (const branch of branches) {
        if (!seen.has(branch.name)) {
          seen.add(branch.name);
          uniqueBranches.push(branch);
        }
      }
      // Ensure exactly one branch is HEAD
      let hasHead = false;
      return uniqueBranches.map((b, i) => {
        if (i === 0 && !hasHead) {
          hasHead = true;
          return { ...b, isHead: true };
        }
        return { ...b, isHead: false };
      });
    });

  /**
   * Mock GitService that simulates branch operations in memory.
   * This allows us to test the branch lifecycle properties without actual Git operations.
   */
  class MockGitService {
    private _branches: Map<string, IBranch> = new Map();
    private _head: IHead;
    private _commitHistory: Map<string, string[]> = new Map(); // branch name -> commit hashes

    constructor(initialBranches: IBranch[]) {
      // Initialize branches
      for (const branch of initialBranches) {
        this._branches.set(branch.name, { ...branch });
        // Initialize commit history for each branch
        this._commitHistory.set(branch.name, [branch.commit]);
      }

      // Set HEAD to the first branch marked as head, or the first branch
      const headBranch = initialBranches.find((b) => b.isHead) || initialBranches[0];
      this._head = {
        name: headBranch?.name,
        commit: headBranch?.commit,
        ahead: 0,
        behind: 0,
      };
    }

    /**
     * Get all branches
     */
    getBranches(): IBranch[] {
      return Array.from(this._branches.values());
    }

    /**
     * Get the current HEAD
     */
    getHead(): IHead {
      return { ...this._head };
    }

    /**
     * Check if a branch exists
     */
    branchExists(name: string): boolean {
      return this._branches.has(name);
    }

    /**
     * Get a branch by name
     */
    getBranch(name: string): IBranch | undefined {
      return this._branches.get(name);
    }

    /**
     * Get the commit history for a branch
     */
    getCommitHistory(branchName: string): string[] {
      return this._commitHistory.get(branchName) || [];
    }

    /**
     * Create a new branch from the current HEAD or a specified start point.
     * Requirement 4.3: Create branch from current HEAD
     * Requirement 4.4: Create branch from specified source
     */
    createBranch(name: string, startPoint?: string): void {
      if (this._branches.has(name)) {
        throw new Error(`Branch '${name}' already exists`);
      }

      // Determine the commit to branch from
      let commit: string;
      let sourceHistory: string[];

      if (startPoint) {
        // Check if startPoint is a branch name
        const sourceBranch = this._branches.get(startPoint);
        if (sourceBranch) {
          commit = sourceBranch.commit;
          sourceHistory = this._commitHistory.get(startPoint) || [commit];
        } else {
          // Assume startPoint is a commit hash
          commit = startPoint;
          sourceHistory = [commit];
        }
      } else {
        // Use current HEAD
        commit = this._head.commit || '';
        sourceHistory = this._head.name
          ? this._commitHistory.get(this._head.name) || [commit]
          : [commit];
      }

      const newBranch: IBranch = {
        name,
        type: 'local',
        commit,
        isHead: false,
        upstream: undefined,
      };

      this._branches.set(name, newBranch);
      // Copy the commit history from the source
      this._commitHistory.set(name, [...sourceHistory]);
    }

    /**
     * Checkout a branch, updating HEAD.
     * Requirement 4.5: Checkout updates HEAD and working directory
     */
    checkout(ref: string): void {
      const branch = this._branches.get(ref);
      if (!branch) {
        throw new Error(`Branch '${ref}' not found`);
      }

      // Update isHead flags
      for (const [name, b] of this._branches) {
        this._branches.set(name, { ...b, isHead: name === ref });
      }

      // Update HEAD
      this._head = {
        name: branch.name,
        commit: branch.commit,
        ahead: branch.ahead || 0,
        behind: branch.behind || 0,
        upstream: branch.upstream,
      };
    }

    /**
     * Delete a branch.
     * Requirement 4.9: Delete branch removes it from the list
     */
    deleteBranch(name: string, _force?: boolean): void {
      const branch = this._branches.get(name);
      if (!branch) {
        throw new Error(`Branch '${name}' not found`);
      }

      if (branch.isHead) {
        throw new Error(`Cannot delete the currently checked out branch '${name}'`);
      }

      // In real Git, -d fails if branch is not fully merged, -D forces deletion
      // For this mock, we just delete it
      this._branches.delete(name);
      this._commitHistory.delete(name);
    }

    /**
     * Rename a branch.
     * Requirement 4.10: Rename preserves commit history
     */
    renameBranch(oldName: string, newName: string): void {
      const branch = this._branches.get(oldName);
      if (!branch) {
        throw new Error(`Branch '${oldName}' not found`);
      }

      if (this._branches.has(newName)) {
        throw new Error(`Branch '${newName}' already exists`);
      }

      // Get the commit history before renaming
      const history = this._commitHistory.get(oldName) || [];

      // Create the renamed branch with the same commit
      const renamedBranch: IBranch = {
        ...branch,
        name: newName,
      };

      // Remove old branch and add renamed one
      this._branches.delete(oldName);
      this._branches.set(newName, renamedBranch);

      // Preserve commit history under new name
      this._commitHistory.delete(oldName);
      this._commitHistory.set(newName, history);

      // Update HEAD if the renamed branch was checked out
      if (this._head.name === oldName) {
        this._head = {
          ...this._head,
          name: newName,
        };
      }
    }

    /**
     * Add a commit to the current branch (for testing history preservation)
     */
    addCommit(commitHash: string): void {
      if (!this._head.name) {
        throw new Error('Not on any branch');
      }

      const headName = this._head.name;
      const branch = this._branches.get(headName);
      if (!branch) {
        throw new Error('Current branch not found');
      }

      // Update branch commit
      this._branches.set(headName, { ...branch, commit: commitHash });

      // Update HEAD commit
      this._head = { ...this._head, commit: commitHash };

      // Add to commit history
      const history = this._commitHistory.get(headName) || [];
      history.push(commitHash);
      this._commitHistory.set(headName, history);
    }
  }

  describe('Property 8: Branch Lifecycle Consistency', () => {
    /**
     * Property: Creating a branch SHALL add it to the branch list.
     *
     * **Validates: Requirements 4.3, 4.4**
     */
    it('Property: Creating a branch adds it to the branch list', () => {
      fc.assert(
        fc.property(
          existingBranchesArb,
          validBranchNameArb,
          (initialBranches, newBranchName): boolean => {
            // Skip if the new branch name already exists
            if (initialBranches.some((b) => b.name === newBranchName)) {
              return true; // Skip this test case
            }

            // Setup
            const gitService = new MockGitService(initialBranches);
            const initialBranchCount = gitService.getBranches().length;

            // Pre-condition: branch does not exist
            assert.strictEqual(
              gitService.branchExists(newBranchName),
              false,
              'Branch should not exist before creation'
            );

            // Act: Create the branch
            gitService.createBranch(newBranchName);

            // Assert: Branch now exists in the list
            assert.strictEqual(
              gitService.branchExists(newBranchName),
              true,
              'Branch should exist after creation'
            );

            // Assert: Branch count increased by 1
            assert.strictEqual(
              gitService.getBranches().length,
              initialBranchCount + 1,
              'Branch count should increase by 1'
            );

            // Assert: The new branch has the correct commit (from HEAD)
            const newBranch = gitService.getBranch(newBranchName);
            assert.ok(newBranch, 'New branch should be retrievable');
            assert.strictEqual(
              newBranch.commit,
              gitService.getHead().commit,
              'New branch should point to HEAD commit'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Creating a branch from a specific start point uses that commit.
     *
     * **Validates: Requirements 4.4**
     */
    it('Property: Creating a branch from start point uses that commit', () => {
      fc.assert(
        fc.property(
          existingBranchesArb,
          validBranchNameArb,
          (initialBranches, newBranchName): boolean => {
            // Skip if the new branch name already exists
            if (initialBranches.some((b) => b.name === newBranchName)) {
              return true;
            }

            // Pick a random existing branch as the start point
            const sourceBranch = initialBranches[0];

            // Setup
            const gitService = new MockGitService(initialBranches);

            // Act: Create branch from the source branch
            gitService.createBranch(newBranchName, sourceBranch.name);

            // Assert: New branch points to the source branch's commit
            const newBranch = gitService.getBranch(newBranchName);
            assert.ok(newBranch, 'New branch should be retrievable');
            assert.strictEqual(
              newBranch.commit,
              sourceBranch.commit,
              'New branch should point to source branch commit'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Checking out a branch SHALL update HEAD.
     *
     * **Validates: Requirements 4.5**
     */
    it('Property: Checking out a branch updates HEAD', () => {
      fc.assert(
        fc.property(
          existingBranchesArb.filter((branches) => branches.length >= 2),
          (initialBranches): boolean => {
            // Setup
            const gitService = new MockGitService(initialBranches);

            // Find a branch that is not currently HEAD
            const currentHead = gitService.getHead();
            const targetBranch = initialBranches.find((b) => b.name !== currentHead.name);

            if (!targetBranch) {
              return true; // Skip if no other branch available
            }

            // Pre-condition: HEAD is not on target branch
            assert.notStrictEqual(
              gitService.getHead().name,
              targetBranch.name,
              'HEAD should not be on target branch before checkout'
            );

            // Act: Checkout the target branch
            gitService.checkout(targetBranch.name);

            // Assert: HEAD is now on the target branch
            const newHead = gitService.getHead();
            assert.strictEqual(
              newHead.name,
              targetBranch.name,
              'HEAD name should be updated to target branch'
            );
            assert.strictEqual(
              newHead.commit,
              targetBranch.commit,
              'HEAD commit should be updated to target branch commit'
            );

            // Assert: The target branch is now marked as HEAD
            const checkedOutBranch = gitService.getBranch(targetBranch.name);
            assert.ok(checkedOutBranch, 'Target branch should exist');
            assert.strictEqual(
              checkedOutBranch.isHead,
              true,
              'Target branch should be marked as HEAD'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Renaming a branch SHALL preserve the branch's commit history.
     *
     * **Validates: Requirements 4.10**
     */
    it('Property: Renaming a branch preserves commit history', () => {
      fc.assert(
        fc.property(
          existingBranchesArb,
          validBranchNameArb,
          fc.array(commitHashArb, { minLength: 1, maxLength: 5 }),
          (initialBranches, newName, additionalCommits): boolean => {
            // Find a branch that is not HEAD (can be renamed)
            const branchToRename = initialBranches.find((b) => !b.isHead);
            if (!branchToRename) {
              return true; // Skip if no non-HEAD branch
            }

            // Skip if new name already exists or is the same
            if (
              initialBranches.some((b) => b.name === newName) ||
              branchToRename.name === newName
            ) {
              return true;
            }

            // Setup
            const gitService = new MockGitService(initialBranches);
            const oldName = branchToRename.name;

            // Add some commits to the branch to build history
            gitService.checkout(oldName);
            for (const commit of additionalCommits) {
              gitService.addCommit(commit);
            }

            // Get the commit history before renaming
            const historyBeforeRename = gitService.getCommitHistory(oldName);
            const commitBeforeRename = gitService.getBranch(oldName)?.commit;

            // Checkout another branch before renaming (can't rename current branch in some scenarios)
            const otherBranch = initialBranches.find((b) => b.name !== oldName);
            if (otherBranch) {
              gitService.checkout(otherBranch.name);
            }

            // Act: Rename the branch
            gitService.renameBranch(oldName, newName);

            // Assert: Old branch name no longer exists
            assert.strictEqual(
              gitService.branchExists(oldName),
              false,
              'Old branch name should not exist after rename'
            );

            // Assert: New branch name exists
            assert.strictEqual(
              gitService.branchExists(newName),
              true,
              'New branch name should exist after rename'
            );

            // Assert: Commit is preserved
            const renamedBranch = gitService.getBranch(newName);
            assert.ok(renamedBranch, 'Renamed branch should be retrievable');
            assert.strictEqual(
              renamedBranch.commit,
              commitBeforeRename,
              'Commit should be preserved after rename'
            );

            // Assert: Commit history is preserved
            const historyAfterRename = gitService.getCommitHistory(newName);
            assert.deepStrictEqual(
              historyAfterRename,
              historyBeforeRename,
              'Commit history should be preserved after rename'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Deleting a branch SHALL remove it from the branch list.
     *
     * **Validates: Requirements 4.9**
     */
    it('Property: Deleting a branch removes it from the branch list', () => {
      fc.assert(
        fc.property(
          existingBranchesArb.filter((branches) => branches.length >= 2),
          (initialBranches): boolean => {
            // Setup
            const gitService = new MockGitService(initialBranches);

            // Find a branch that is not HEAD (can be deleted)
            const branchToDelete = initialBranches.find((b) => !b.isHead);
            if (!branchToDelete) {
              return true; // Skip if no non-HEAD branch
            }

            const branchName = branchToDelete.name;
            const initialBranchCount = gitService.getBranches().length;

            // Pre-condition: Branch exists
            assert.strictEqual(
              gitService.branchExists(branchName),
              true,
              'Branch should exist before deletion'
            );

            // Act: Delete the branch
            gitService.deleteBranch(branchName);

            // Assert: Branch no longer exists
            assert.strictEqual(
              gitService.branchExists(branchName),
              false,
              'Branch should not exist after deletion'
            );

            // Assert: Branch count decreased by 1
            assert.strictEqual(
              gitService.getBranches().length,
              initialBranchCount - 1,
              'Branch count should decrease by 1'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Full branch lifecycle - create, checkout, rename, delete.
     *
     * **Validates: Requirements 4.3, 4.4, 4.5, 4.9, 4.10**
     */
    it('Property: Full branch lifecycle maintains consistency', () => {
      fc.assert(
        fc.property(
          existingBranchesArb,
          validBranchNameArb,
          validBranchNameArb,
          (initialBranches, branchName, renamedName): boolean => {
            // Skip if names conflict
            if (
              initialBranches.some((b) => b.name === branchName || b.name === renamedName) ||
              branchName === renamedName
            ) {
              return true;
            }

            // Setup
            const gitService = new MockGitService(initialBranches);
            const initialBranchCount = gitService.getBranches().length;

            // Step 1: Create branch
            gitService.createBranch(branchName);
            assert.strictEqual(
              gitService.branchExists(branchName),
              true,
              'Branch should exist after creation'
            );
            assert.strictEqual(
              gitService.getBranches().length,
              initialBranchCount + 1,
              'Branch count should increase after creation'
            );

            // Step 2: Checkout the new branch
            gitService.checkout(branchName);
            assert.strictEqual(
              gitService.getHead().name,
              branchName,
              'HEAD should be on new branch after checkout'
            );

            // Step 3: Checkout back to original branch (so we can rename)
            const originalHead = initialBranches.find((b) => b.isHead);
            if (originalHead) {
              gitService.checkout(originalHead.name);
            }

            // Step 4: Rename the branch
            const commitBeforeRename = gitService.getBranch(branchName)?.commit;
            gitService.renameBranch(branchName, renamedName);
            assert.strictEqual(
              gitService.branchExists(branchName),
              false,
              'Old name should not exist after rename'
            );
            assert.strictEqual(
              gitService.branchExists(renamedName),
              true,
              'New name should exist after rename'
            );
            assert.strictEqual(
              gitService.getBranch(renamedName)?.commit,
              commitBeforeRename,
              'Commit should be preserved after rename'
            );

            // Step 5: Delete the renamed branch
            gitService.deleteBranch(renamedName);
            assert.strictEqual(
              gitService.branchExists(renamedName),
              false,
              'Branch should not exist after deletion'
            );
            assert.strictEqual(
              gitService.getBranches().length,
              initialBranchCount,
              'Branch count should return to initial after full lifecycle'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Cannot delete the currently checked out branch.
     *
     * **Validates: Requirements 4.9**
     */
    it('Property: Cannot delete currently checked out branch', () => {
      fc.assert(
        fc.property(existingBranchesArb, (initialBranches): boolean => {
          // Setup
          const gitService = new MockGitService(initialBranches);
          const currentHead = gitService.getHead();

          if (!currentHead.name) {
            return true; // Skip if no HEAD
          }

          // Act & Assert: Attempting to delete HEAD branch should throw
          assert.throws(
            () => gitService.deleteBranch(currentHead.name!),
            /Cannot delete the currently checked out branch/,
            'Should throw when trying to delete HEAD branch'
          );

          // Assert: Branch still exists
          assert.strictEqual(
            gitService.branchExists(currentHead.name),
            true,
            'HEAD branch should still exist after failed deletion'
          );

          return true;
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Creating a branch with an existing name should fail.
     *
     * **Validates: Requirements 4.3**
     */
    it('Property: Creating branch with existing name fails', () => {
      fc.assert(
        fc.property(existingBranchesArb, (initialBranches): boolean => {
          // Setup
          const gitService = new MockGitService(initialBranches);
          const existingBranch = initialBranches[0];

          // Act & Assert: Attempting to create branch with existing name should throw
          assert.throws(
            () => gitService.createBranch(existingBranch.name),
            /already exists/,
            'Should throw when creating branch with existing name'
          );

          // Assert: Branch count unchanged
          assert.strictEqual(
            gitService.getBranches().length,
            initialBranches.length,
            'Branch count should be unchanged after failed creation'
          );

          return true;
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Renaming to an existing branch name should fail.
     *
     * **Validates: Requirements 4.10**
     */
    it('Property: Renaming to existing branch name fails', () => {
      fc.assert(
        fc.property(
          existingBranchesArb.filter((branches) => branches.length >= 2),
          (initialBranches): boolean => {
            // Setup
            const gitService = new MockGitService(initialBranches);

            // Find two different branches
            const branchToRename = initialBranches.find((b) => !b.isHead);
            const targetName = initialBranches.find((b) => b.name !== branchToRename?.name);

            if (!branchToRename || !targetName) {
              return true; // Skip if not enough branches
            }

            // Act & Assert: Attempting to rename to existing name should throw
            assert.throws(
              () => gitService.renameBranch(branchToRename.name, targetName.name),
              /already exists/,
              'Should throw when renaming to existing branch name'
            );

            // Assert: Original branch still exists
            assert.strictEqual(
              gitService.branchExists(branchToRename.name),
              true,
              'Original branch should still exist after failed rename'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Branch operations are consistent across multiple operations.
     *
     * **Validates: Requirements 4.3, 4.4, 4.5, 4.9, 4.10**
     */
    it('Property: Multiple branch operations maintain consistency', () => {
      fc.assert(
        fc.property(
          existingBranchesArb,
          fc.array(validBranchNameArb, { minLength: 2, maxLength: 5 }),
          (initialBranches, newBranchNames): boolean => {
            // Ensure unique names that don't conflict with existing branches
            const existingNames = new Set(initialBranches.map((b) => b.name));
            const uniqueNewNames = [...new Set(newBranchNames)].filter(
              (name) => !existingNames.has(name)
            );

            if (uniqueNewNames.length < 2) {
              return true; // Skip if not enough unique names
            }

            // Setup
            const gitService = new MockGitService(initialBranches);
            const initialCount = gitService.getBranches().length;

            // Create multiple branches
            for (const name of uniqueNewNames) {
              gitService.createBranch(name);
            }

            // Assert: All branches were created
            assert.strictEqual(
              gitService.getBranches().length,
              initialCount + uniqueNewNames.length,
              'All branches should be created'
            );

            for (const name of uniqueNewNames) {
              assert.strictEqual(
                gitService.branchExists(name),
                true,
                `Branch '${name}' should exist`
              );
            }

            // Delete all created branches (except if any became HEAD)
            const currentHead = gitService.getHead().name;
            let deletedCount = 0;
            for (const name of uniqueNewNames) {
              if (name !== currentHead) {
                gitService.deleteBranch(name);
                deletedCount++;
              }
            }

            // Assert: Deleted branches are gone
            assert.strictEqual(
              gitService.getBranches().length,
              initialCount + uniqueNewNames.length - deletedCount,
              'Branch count should reflect deletions'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
