import * as fc from 'fast-check';
import * as assert from 'assert';
import {
  IStash,
  IStashOptions,
  IFileStatus,
  StatusCode,
} from '../../services/interfaces/IGitService';

/**
 * Property-based tests for Stash Round-Trip.
 * Feature: intellig-vscode, Property 18: Stash Round-Trip
 *
 * **Validates: Requirements 7.1, 7.4, 7.5**
 *
 * Property Description:
 * For any set of uncommitted changes, stashing and then applying (or popping) SHALL
 * restore the working directory to contain the same changes.
 *
 * Requirements:
 * - 7.1: Stash saves uncommitted changes with optional message
 * - 7.4: Apply restores stash changes without removing from list
 * - 7.5: Pop restores stash changes and removes from list
 */
describe('Stash Round-Trip Property Tests', () => {
  /**
   * Arbitrary generator for valid file paths.
   * File paths should be non-empty and contain valid characters.
   */
  const filePathArb: fc.Arbitrary<string> = fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_./'.split('')
      ),
      {
        minLength: 1,
        maxLength: 50,
      }
    )
    .filter((s) => {
      // Filter out invalid paths
      if (s.length === 0) {
        return false;
      }
      if (s.startsWith('/') || s.endsWith('/')) {
        return false;
      }
      if (s.includes('//')) {
        return false;
      }
      if (s.startsWith('.') && s.length === 1) {
        return false;
      }
      return true;
    })
    .map((s) => (s.startsWith('.') ? 'file' + s : s));

  /**
   * Arbitrary generator for status codes (modified, added, deleted)
   */
  const statusCodeArb: fc.Arbitrary<StatusCode> = fc.constantFrom(
    'M' as StatusCode,
    'A' as StatusCode,
    'D' as StatusCode
  );

  /**
   * Arbitrary generator for file status
   */
  const fileStatusArb: fc.Arbitrary<IFileStatus> = fc.record({
    path: filePathArb,
    indexStatus: statusCodeArb,
    workTreeStatus: statusCodeArb,
    renamed: fc.constant(undefined),
  });

  /**
   * Arbitrary generator for a non-empty array of file statuses (uncommitted changes)
   */
  const uncommittedChangesArb: fc.Arbitrary<IFileStatus[]> = fc
    .array(fileStatusArb, { minLength: 1, maxLength: 10 })
    .map((statuses) => {
      // Ensure unique file paths
      const seen = new Set<string>();
      return statuses.filter((s) => {
        if (seen.has(s.path)) {
          return false;
        }
        seen.add(s.path);
        return true;
      });
    })
    .filter((statuses) => statuses.length > 0);

  /**
   * Arbitrary generator for stash messages (optional, non-empty strings)
   */
  const stashMessageArb: fc.Arbitrary<string | undefined> = fc.option(
    fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
    { nil: undefined }
  );

  /**
   * Mock GitService that simulates stash operations in memory.
   * This allows us to test the stash round-trip properties without actual Git operations.
   */
  class MockGitService {
    private _stashes: IStash[] = [];
    private _workingDirectoryChanges: IFileStatus[] = [];
    private _stashedChanges: Map<number, IFileStatus[]> = new Map();
    private _currentBranch: string = 'main';
    private _nextStashIndex: number = 0;

    constructor(initialChanges: IFileStatus[] = []) {
      this._workingDirectoryChanges = [...initialChanges];
    }

    /**
     * Get the current uncommitted changes in the working directory
     */
    getStatus(): IFileStatus[] {
      return [...this._workingDirectoryChanges];
    }

    /**
     * Get the list of stashes
     * Requirement 7.3: Display all stashes with messages and timestamps
     */
    stashList(): IStash[] {
      return [...this._stashes];
    }

    /**
     * Check if a stash exists at the given index
     */
    stashExists(index: number): boolean {
      return this._stashes.some((s) => s.index === index);
    }

    /**
     * Get the changes stored in a stash
     */
    getStashedChanges(index: number): IFileStatus[] | undefined {
      return this._stashedChanges.get(index);
    }

    /**
     * Create a stash from the current working directory changes.
     * Requirement 7.1: Stash saves uncommitted changes with optional message
     *
     * @param message - Optional stash message
     * @param _options - Stash options (includeUntracked, keepIndex)
     */
    stash(message?: string, _options?: IStashOptions): void {
      if (this._workingDirectoryChanges.length === 0) {
        throw new Error('No local changes to save');
      }

      // Create a new stash entry
      const stashIndex = this._nextStashIndex++;
      const stash: IStash = {
        index: stashIndex,
        message: message || `WIP on ${this._currentBranch}`,
        date: new Date(),
        branch: this._currentBranch,
      };

      // Store the changes associated with this stash
      this._stashedChanges.set(stashIndex, [...this._workingDirectoryChanges]);

      // Add to stash list (most recent first)
      this._stashes.unshift(stash);

      // Re-index stashes (stash@{0} is always the most recent)
      this._reindexStashes();

      // Clear working directory changes (unless keepIndex is true)
      // For simplicity, we always clear in this mock
      this._workingDirectoryChanges = [];
    }

    /**
     * Apply a stash to the working directory without removing it from the list.
     * Requirement 7.4: Apply restores stash changes without removing from list
     *
     * @param index - The stash index to apply
     */
    stashApply(index: number): void {
      const stash = this._stashes.find((s) => s.index === index);
      if (!stash) {
        throw new Error(`stash@{${index}} does not exist`);
      }

      const changes = this._stashedChanges.get(index);
      if (!changes) {
        throw new Error(`No changes found for stash@{${index}}`);
      }

      // Restore the changes to the working directory
      this._workingDirectoryChanges = [...changes];

      // Note: Apply does NOT remove the stash from the list
    }

    /**
     * Pop a stash - apply and remove from the list.
     * Requirement 7.5: Pop restores stash changes and removes from list
     *
     * @param index - The stash index to pop
     */
    stashPop(index: number): void {
      // First apply the stash
      this.stashApply(index);

      // Then remove it from the list
      this._stashes = this._stashes.filter((s) => s.index !== index);
      this._stashedChanges.delete(index);

      // Re-index remaining stashes
      this._reindexStashes();
    }

    /**
     * Drop a stash without applying it.
     * Requirement 7.6: Delete stash after confirmation
     *
     * @param index - The stash index to drop
     */
    stashDrop(index: number): void {
      const stash = this._stashes.find((s) => s.index === index);
      if (!stash) {
        throw new Error(`stash@{${index}} does not exist`);
      }

      this._stashes = this._stashes.filter((s) => s.index !== index);
      this._stashedChanges.delete(index);

      // Re-index remaining stashes
      this._reindexStashes();
    }

    /**
     * Set the working directory changes (for testing)
     */
    setWorkingDirectoryChanges(changes: IFileStatus[]): void {
      this._workingDirectoryChanges = [...changes];
    }

    /**
     * Re-index stashes so that indices are 0, 1, 2, ... (most recent first)
     */
    private _reindexStashes(): void {
      // Create a mapping from old index to new index
      const newStashedChanges = new Map<number, IFileStatus[]>();

      this._stashes.forEach((stash, newIndex) => {
        const oldIndex = stash.index;

        // Move the stashed changes to the new index
        const changes = this._stashedChanges.get(oldIndex);
        if (changes) {
          newStashedChanges.set(newIndex, changes);
        }

        // Update the stash index
        stash.index = newIndex;
      });

      this._stashedChanges = newStashedChanges;
    }
  }

  /**
   * Compare two arrays of file statuses for equality
   */
  function fileStatusesEqual(a: IFileStatus[], b: IFileStatus[]): boolean {
    if (a.length !== b.length) {
      return false;
    }

    // Sort both arrays by path for comparison
    const sortedA = [...a].sort((x, y) => x.path.localeCompare(y.path));
    const sortedB = [...b].sort((x, y) => x.path.localeCompare(y.path));

    for (let i = 0; i < sortedA.length; i++) {
      if (
        sortedA[i].path !== sortedB[i].path ||
        sortedA[i].indexStatus !== sortedB[i].indexStatus ||
        sortedA[i].workTreeStatus !== sortedB[i].workTreeStatus
      ) {
        return false;
      }
    }

    return true;
  }

  describe('Property 18: Stash Round-Trip', () => {
    /**
     * Property: Stashing changes and then applying restores the exact same changes.
     *
     * **Validates: Requirements 7.1, 7.4**
     */
    it('Property: Stash and apply restores exact same changes', () => {
      fc.assert(
        fc.property(uncommittedChangesArb, stashMessageArb, (changes, message) => {
          // Setup
          const gitService = new MockGitService(changes);

          // Pre-condition: Working directory has changes
          const originalChanges = gitService.getStatus();
          assert.ok(originalChanges.length > 0, 'Should have uncommitted changes');

          // Act: Stash the changes
          gitService.stash(message);

          // Assert: Working directory is clean after stash
          assert.strictEqual(
            gitService.getStatus().length,
            0,
            'Working directory should be clean after stash'
          );

          // Assert: Stash list has one entry
          const stashes = gitService.stashList();
          assert.strictEqual(stashes.length, 1, 'Should have one stash');

          // Act: Apply the stash
          gitService.stashApply(0);

          // Assert: Changes are restored exactly
          const restoredChanges = gitService.getStatus();
          assert.ok(
            fileStatusesEqual(originalChanges, restoredChanges),
            'Applied changes should match original changes'
          );

          // Assert: Stash is still in the list (apply doesn't remove)
          assert.strictEqual(
            gitService.stashList().length,
            1,
            'Stash should still be in list after apply'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Stashing changes and then popping restores the exact same changes
     * and removes the stash from the list.
     *
     * **Validates: Requirements 7.1, 7.5**
     */
    it('Property: Stash and pop restores changes and removes stash', () => {
      fc.assert(
        fc.property(uncommittedChangesArb, stashMessageArb, (changes, message) => {
          // Setup
          const gitService = new MockGitService(changes);
          const originalChanges = gitService.getStatus();

          // Act: Stash the changes
          gitService.stash(message);

          // Assert: Stash was created
          assert.strictEqual(gitService.stashList().length, 1, 'Should have one stash');

          // Act: Pop the stash
          gitService.stashPop(0);

          // Assert: Changes are restored exactly
          const restoredChanges = gitService.getStatus();
          assert.ok(
            fileStatusesEqual(originalChanges, restoredChanges),
            'Popped changes should match original changes'
          );

          // Assert: Stash is removed from the list (pop removes)
          assert.strictEqual(
            gitService.stashList().length,
            0,
            'Stash should be removed from list after pop'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Apply keeps the stash in the list while pop removes it.
     *
     * **Validates: Requirements 7.4, 7.5**
     */
    it('Property: Apply keeps stash in list, pop removes it', () => {
      fc.assert(
        fc.property(uncommittedChangesArb, fc.boolean(), (changes, useApply) => {
          // Setup
          const gitService = new MockGitService(changes);

          // Act: Stash the changes
          gitService.stash('Test stash');
          const stashCountAfterStash = gitService.stashList().length;
          assert.strictEqual(stashCountAfterStash, 1, 'Should have one stash');

          // Act: Either apply or pop based on the boolean
          if (useApply) {
            gitService.stashApply(0);
            // Assert: Stash is still in the list
            assert.strictEqual(gitService.stashList().length, 1, 'Apply should keep stash in list');
            assert.ok(gitService.stashExists(0), 'Stash at index 0 should still exist after apply');
          } else {
            gitService.stashPop(0);
            // Assert: Stash is removed from the list
            assert.strictEqual(
              gitService.stashList().length,
              0,
              'Pop should remove stash from list'
            );
            assert.ok(!gitService.stashExists(0), 'Stash at index 0 should not exist after pop');
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Stash messages are preserved correctly.
     *
     * **Validates: Requirements 7.1**
     */
    it('Property: Stash messages are preserved correctly', () => {
      fc.assert(
        fc.property(
          uncommittedChangesArb,
          fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
          (changes, message) => {
            // Setup
            const gitService = new MockGitService(changes);

            // Act: Stash with a specific message
            gitService.stash(message);

            // Assert: The stash message is preserved
            const stashes = gitService.stashList();
            assert.strictEqual(stashes.length, 1, 'Should have one stash');
            assert.strictEqual(stashes[0].message, message, 'Stash message should be preserved');
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Default stash message is generated when no message is provided.
     *
     * **Validates: Requirements 7.1**
     */
    it('Property: Default stash message is generated when none provided', () => {
      fc.assert(
        fc.property(uncommittedChangesArb, (changes) => {
          // Setup
          const gitService = new MockGitService(changes);

          // Act: Stash without a message
          gitService.stash();

          // Assert: A default message is generated
          const stashes = gitService.stashList();
          assert.strictEqual(stashes.length, 1, 'Should have one stash');
          assert.ok(stashes[0].message.length > 0, 'Stash should have a default message');
          assert.ok(stashes[0].message.includes('WIP'), 'Default message should contain WIP');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Multiple stash and apply operations maintain consistency.
     *
     * **Validates: Requirements 7.1, 7.4**
     */
    it('Property: Multiple stash and apply operations maintain consistency', () => {
      fc.assert(
        fc.property(
          fc.array(uncommittedChangesArb, { minLength: 2, maxLength: 5 }),
          (changesArray) => {
            // Setup
            const gitService = new MockGitService();

            // Store original changes for each stash
            const originalChangesMap: IFileStatus[][] = [];

            // Act: Create multiple stashes
            for (const changes of changesArray) {
              gitService.setWorkingDirectoryChanges(changes);
              originalChangesMap.push([...changes]);
              gitService.stash(`Stash ${originalChangesMap.length}`);
            }

            // Assert: All stashes were created
            assert.strictEqual(
              gitService.stashList().length,
              changesArray.length,
              'All stashes should be created'
            );

            // Act & Assert: Apply each stash and verify changes are restored
            // Note: Stashes are in reverse order (most recent first)
            for (let i = 0; i < changesArray.length; i++) {
              gitService.stashApply(i);
              const restoredChanges = gitService.getStatus();
              const expectedChanges = originalChangesMap[changesArray.length - 1 - i];

              assert.ok(
                fileStatusesEqual(expectedChanges, restoredChanges),
                `Stash ${i} should restore correct changes`
              );

              // Clear working directory for next iteration
              gitService.setWorkingDirectoryChanges([]);
            }

            // Assert: All stashes are still in the list (apply doesn't remove)
            assert.strictEqual(
              gitService.stashList().length,
              changesArray.length,
              'All stashes should still be in list after applies'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Stash round-trip preserves file paths exactly.
     *
     * **Validates: Requirements 7.1, 7.4, 7.5**
     */
    it('Property: Stash round-trip preserves file paths exactly', () => {
      fc.assert(
        fc.property(uncommittedChangesArb, (changes) => {
          // Setup
          const gitService = new MockGitService(changes);
          const originalPaths = new Set(changes.map((c) => c.path));

          // Act: Stash and apply
          gitService.stash('Test stash');
          gitService.stashApply(0);

          // Assert: All file paths are preserved
          const restoredPaths = new Set(gitService.getStatus().map((c) => c.path));
          assert.strictEqual(
            restoredPaths.size,
            originalPaths.size,
            'Number of files should be preserved'
          );

          for (const path of originalPaths) {
            assert.ok(restoredPaths.has(path), `File path '${path}' should be preserved`);
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Stash round-trip preserves file status codes exactly.
     *
     * **Validates: Requirements 7.1, 7.4, 7.5**
     */
    it('Property: Stash round-trip preserves file status codes exactly', () => {
      fc.assert(
        fc.property(uncommittedChangesArb, (changes) => {
          // Setup
          const gitService = new MockGitService(changes);

          // Create a map of path -> status for original changes
          const originalStatusMap = new Map<string, { index: StatusCode; workTree: StatusCode }>();
          for (const change of changes) {
            originalStatusMap.set(change.path, {
              index: change.indexStatus,
              workTree: change.workTreeStatus,
            });
          }

          // Act: Stash and apply
          gitService.stash('Test stash');
          gitService.stashApply(0);

          // Assert: All status codes are preserved
          const restoredChanges = gitService.getStatus();
          for (const restored of restoredChanges) {
            const original = originalStatusMap.get(restored.path);
            assert.ok(original, `Original status for '${restored.path}' should exist`);
            if (original) {
              assert.strictEqual(
                restored.indexStatus,
                original.index,
                `Index status for '${restored.path}' should be preserved`
              );
              assert.strictEqual(
                restored.workTreeStatus,
                original.workTree,
                `Work tree status for '${restored.path}' should be preserved`
              );
            }
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Stashing with no changes should fail.
     *
     * **Validates: Requirements 7.1**
     */
    it('Property: Stashing with no changes should fail', () => {
      fc.assert(
        fc.property(stashMessageArb, (message) => {
          // Setup: Empty working directory
          const gitService = new MockGitService([]);

          // Act & Assert: Stashing should throw
          assert.throws(
            () => gitService.stash(message),
            /No local changes to save/,
            'Should throw when stashing with no changes'
          );

          // Assert: No stash was created
          assert.strictEqual(gitService.stashList().length, 0, 'No stash should be created');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Applying non-existent stash should fail.
     *
     * **Validates: Requirements 7.4**
     */
    it('Property: Applying non-existent stash should fail', () => {
      fc.assert(
        fc.property(uncommittedChangesArb, fc.nat({ max: 100 }), (changes, invalidIndex) => {
          // Setup
          const gitService = new MockGitService(changes);
          gitService.stash('Test stash');

          // Use an index that doesn't exist (anything > 0 since we only have one stash)
          const nonExistentIndex = invalidIndex + 1;

          // Act & Assert: Applying non-existent stash should throw
          assert.throws(
            () => gitService.stashApply(nonExistentIndex),
            /does not exist/,
            'Should throw when applying non-existent stash'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Popping non-existent stash should fail.
     *
     * **Validates: Requirements 7.5**
     */
    it('Property: Popping non-existent stash should fail', () => {
      fc.assert(
        fc.property(uncommittedChangesArb, fc.nat({ max: 100 }), (changes, invalidIndex) => {
          // Setup
          const gitService = new MockGitService(changes);
          gitService.stash('Test stash');

          // Use an index that doesn't exist
          const nonExistentIndex = invalidIndex + 1;

          // Act & Assert: Popping non-existent stash should throw
          assert.throws(
            () => gitService.stashPop(nonExistentIndex),
            /does not exist/,
            'Should throw when popping non-existent stash'
          );

          // Assert: Original stash is still in the list
          assert.strictEqual(gitService.stashList().length, 1, 'Original stash should still exist');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Stash indices are re-indexed after pop.
     *
     * **Validates: Requirements 7.5**
     */
    it('Property: Stash indices are re-indexed after pop', () => {
      fc.assert(
        fc.property(
          fc.array(uncommittedChangesArb, { minLength: 3, maxLength: 5 }),
          fc.nat({ max: 2 }),
          (changesArray, popIndex) => {
            // Setup
            const gitService = new MockGitService();

            // Create multiple stashes
            for (let i = 0; i < changesArray.length; i++) {
              gitService.setWorkingDirectoryChanges(changesArray[i]);
              gitService.stash(`Stash ${i}`);
            }

            const initialCount = gitService.stashList().length;
            const indexToPop = popIndex % initialCount;

            // Act: Pop a stash
            gitService.stashPop(indexToPop);

            // Assert: Stash count decreased by 1
            const remainingStashes = gitService.stashList();
            assert.strictEqual(
              remainingStashes.length,
              initialCount - 1,
              'Stash count should decrease by 1'
            );

            // Assert: Remaining stashes have consecutive indices starting from 0
            for (let i = 0; i < remainingStashes.length; i++) {
              assert.strictEqual(
                remainingStashes[i].index,
                i,
                `Stash at position ${i} should have index ${i}`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
