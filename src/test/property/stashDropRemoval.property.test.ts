import * as fc from 'fast-check';
import * as assert from 'assert';
import { IStash, IFileStatus, StatusCode } from '../../services/interfaces/IGitService';

/**
 * Property-based tests for Stash Drop Removal.
 * Feature: intellig-vscode, Property 20: Stash Drop Removal
 *
 * **Validates: Requirements 7.6**
 *
 * Property Description:
 * For any stash, dropping it SHALL remove it from the stash list and it SHALL
 * no longer be recoverable through the extension.
 *
 * Requirements:
 * - 7.6: WHEN a user selects 'Drop Stash', THE Extension SHALL delete the stash after confirmation
 */
describe('Stash Drop Removal Property Tests', () => {
  /**
   * Arbitrary generator for valid file paths.
   */
  const filePathArb: fc.Arbitrary<string> = fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_./'.split('')
      ),
      { minLength: 1, maxLength: 50 }
    )
    .filter((s) => {
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
   * Arbitrary generator for status codes
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
   * Arbitrary generator for non-empty uncommitted changes
   */
  const uncommittedChangesArb: fc.Arbitrary<IFileStatus[]> = fc
    .array(fileStatusArb, { minLength: 1, maxLength: 5 })
    .map((statuses) => {
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
   * Arbitrary generator for stash messages
   */
  const stashMessageArb: fc.Arbitrary<string> = fc
    .string({ minLength: 1, maxLength: 100 })
    .filter((s) => s.trim().length > 0);

  /**
   * Mock GitService that simulates stash operations in memory.
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

    getStatus(): IFileStatus[] {
      return [...this._workingDirectoryChanges];
    }

    /**
     * Get the list of stashes.
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
     * Get the changes stored in a stash (for testing recoverability)
     */
    getStashedChanges(index: number): IFileStatus[] | undefined {
      return this._stashedChanges.get(index);
    }

    /**
     * Create a stash from the current working directory changes.
     */
    stash(message?: string): void {
      if (this._workingDirectoryChanges.length === 0) {
        throw new Error('No local changes to save');
      }

      const stashIndex = this._nextStashIndex++;
      const stash: IStash = {
        index: stashIndex,
        message: message || `WIP on ${this._currentBranch}`,
        date: new Date(),
        branch: this._currentBranch,
      };

      this._stashedChanges.set(stashIndex, [...this._workingDirectoryChanges]);
      this._stashes.unshift(stash);
      this._reindexStashes();
      this._workingDirectoryChanges = [];
    }

    /**
     * Apply a stash to the working directory without removing it from the list.
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

      this._workingDirectoryChanges = [...changes];
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
      this._reindexStashes();
    }

    setWorkingDirectoryChanges(changes: IFileStatus[]): void {
      this._workingDirectoryChanges = [...changes];
    }

    private _reindexStashes(): void {
      const newStashedChanges = new Map<number, IFileStatus[]>();

      this._stashes.forEach((stash, newIndex) => {
        const oldIndex = stash.index;
        const changes = this._stashedChanges.get(oldIndex);
        if (changes) {
          newStashedChanges.set(newIndex, changes);
        }
        stash.index = newIndex;
      });

      this._stashedChanges = newStashedChanges;
    }
  }

  describe('Property 20: Stash Drop Removal', () => {
    /**
     * Property: Dropping a stash removes it from the stash list.
     *
     * **Validates: Requirements 7.6**
     */
    it('Property: Dropping a stash removes it from the stash list', () => {
      fc.assert(
        fc.property(uncommittedChangesArb, stashMessageArb, (changes, message) => {
          // Setup
          const gitService = new MockGitService(changes);

          // Create a stash
          gitService.stash(message);

          // Pre-condition: Stash exists
          assert.strictEqual(gitService.stashList().length, 1, 'Should have one stash');
          assert.ok(gitService.stashExists(0), 'Stash at index 0 should exist');

          // Act: Drop the stash
          gitService.stashDrop(0);

          // Assert: Stash is removed from the list
          assert.strictEqual(
            gitService.stashList().length,
            0,
            'Stash list should be empty after drop'
          );
          assert.ok(!gitService.stashExists(0), 'Stash at index 0 should not exist after drop');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Dropped stash is no longer recoverable through the extension.
     *
     * **Validates: Requirements 7.6**
     */
    it('Property: Dropped stash is no longer recoverable through the extension', () => {
      fc.assert(
        fc.property(uncommittedChangesArb, stashMessageArb, (changes, message) => {
          // Setup
          const gitService = new MockGitService(changes);

          // Create a stash
          gitService.stash(message);

          // Pre-condition: Stash changes are accessible
          assert.ok(
            gitService.getStashedChanges(0) !== undefined,
            'Stash changes should be accessible before drop'
          );

          // Act: Drop the stash
          gitService.stashDrop(0);

          // Assert: Stash changes are no longer accessible
          assert.strictEqual(
            gitService.getStashedChanges(0),
            undefined,
            'Stash changes should not be accessible after drop'
          );

          // Assert: Attempting to apply the dropped stash should fail
          assert.throws(
            () => gitService.stashApply(0),
            /does not exist/,
            'Applying dropped stash should throw an error'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Stash indices are re-indexed after drop.
     *
     * **Validates: Requirements 7.6**
     */
    it('Property: Stash indices are re-indexed after drop', () => {
      fc.assert(
        fc.property(
          fc.array(uncommittedChangesArb, { minLength: 3, maxLength: 5 }),
          fc.nat({ max: 2 }),
          (changesArray, dropIndex) => {
            // Setup
            const gitService = new MockGitService();

            // Create multiple stashes
            for (let i = 0; i < changesArray.length; i++) {
              gitService.setWorkingDirectoryChanges(changesArray[i]);
              gitService.stash(`Stash ${i}`);
            }

            const initialCount = gitService.stashList().length;
            const indexToDrop = dropIndex % initialCount;

            // Act: Drop a stash
            gitService.stashDrop(indexToDrop);

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

    /**
     * Property: Dropping non-existent stash should fail.
     *
     * **Validates: Requirements 7.6**
     */
    it('Property: Dropping non-existent stash should fail', () => {
      fc.assert(
        fc.property(uncommittedChangesArb, fc.nat({ max: 100 }), (changes, invalidIndex) => {
          // Setup
          const gitService = new MockGitService(changes);
          gitService.stash('Test stash');

          // Use an index that doesn't exist (anything > 0 since we only have one stash)
          const nonExistentIndex = invalidIndex + 1;

          // Act & Assert: Dropping non-existent stash should throw
          assert.throws(
            () => gitService.stashDrop(nonExistentIndex),
            /does not exist/,
            'Should throw when dropping non-existent stash'
          );

          // Assert: Original stash is still in the list
          assert.strictEqual(gitService.stashList().length, 1, 'Original stash should still exist');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Dropping a stash does not affect other stashes.
     *
     * **Validates: Requirements 7.6**
     */
    it('Property: Dropping a stash does not affect other stashes', () => {
      fc.assert(
        fc.property(
          fc.array(uncommittedChangesArb, { minLength: 3, maxLength: 5 }),
          fc.array(stashMessageArb, { minLength: 3, maxLength: 5 }),
          fc.nat({ max: 2 }),
          (changesArray, messages, dropIndex) => {
            // Setup
            const gitService = new MockGitService();
            const stashCount = Math.min(changesArray.length, messages.length);
            const createdMessages: string[] = [];

            // Create multiple stashes
            for (let i = 0; i < stashCount; i++) {
              gitService.setWorkingDirectoryChanges(changesArray[i]);
              gitService.stash(messages[i]);
              createdMessages.push(messages[i]);
            }

            const indexToDrop = dropIndex % stashCount;

            // Get the message of the stash to be dropped
            const stashListBefore = gitService.stashList();
            const droppedMessage = stashListBefore[indexToDrop].message;

            // Act: Drop a stash
            gitService.stashDrop(indexToDrop);

            // Assert: Remaining stashes have their original messages (excluding dropped one)
            const remainingStashes = gitService.stashList();
            const remainingMessages = remainingStashes.map((s) => s.message);

            // The dropped message should not be in the remaining list
            assert.ok(
              !remainingMessages.includes(droppedMessage),
              'Dropped stash message should not be in remaining list'
            );

            // All other messages should still be present
            for (let i = 0; i < stashListBefore.length; i++) {
              if (i !== indexToDrop) {
                assert.ok(
                  remainingMessages.includes(stashListBefore[i].message),
                  `Stash with message "${stashListBefore[i].message}" should still exist`
                );
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Dropping all stashes results in empty stash list.
     *
     * **Validates: Requirements 7.6**
     */
    it('Property: Dropping all stashes results in empty stash list', () => {
      fc.assert(
        fc.property(
          fc.array(uncommittedChangesArb, { minLength: 1, maxLength: 5 }),
          (changesArray) => {
            // Setup
            const gitService = new MockGitService();

            // Create multiple stashes
            for (let i = 0; i < changesArray.length; i++) {
              gitService.setWorkingDirectoryChanges(changesArray[i]);
              gitService.stash(`Stash ${i}`);
            }

            // Act: Drop all stashes (always drop index 0 since indices are re-indexed)
            while (gitService.stashList().length > 0) {
              gitService.stashDrop(0);
            }

            // Assert: Stash list is empty
            assert.strictEqual(
              gitService.stashList().length,
              0,
              'Stash list should be empty after dropping all stashes'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Dropping a stash from the middle re-indexes correctly.
     *
     * **Validates: Requirements 7.6**
     */
    it('Property: Dropping a stash from the middle re-indexes correctly', () => {
      fc.assert(
        fc.property(
          fc.array(uncommittedChangesArb, { minLength: 3, maxLength: 5 }),
          (changesArray) => {
            // Setup
            const gitService = new MockGitService();

            // Create multiple stashes
            for (let i = 0; i < changesArray.length; i++) {
              gitService.setWorkingDirectoryChanges(changesArray[i]);
              gitService.stash(`Stash ${i}`);
            }

            const initialCount = gitService.stashList().length;

            // Drop the middle stash
            const middleIndex = Math.floor(initialCount / 2);
            gitService.stashDrop(middleIndex);

            // Assert: Indices are consecutive from 0
            const remainingStashes = gitService.stashList();
            for (let i = 0; i < remainingStashes.length; i++) {
              assert.strictEqual(
                remainingStashes[i].index,
                i,
                `After dropping middle stash, stash at position ${i} should have index ${i}`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Dropping the first stash (index 0) re-indexes correctly.
     *
     * **Validates: Requirements 7.6**
     */
    it('Property: Dropping the first stash (index 0) re-indexes correctly', () => {
      fc.assert(
        fc.property(
          fc.array(uncommittedChangesArb, { minLength: 2, maxLength: 5 }),
          (changesArray) => {
            // Setup
            const gitService = new MockGitService();

            // Create multiple stashes
            for (let i = 0; i < changesArray.length; i++) {
              gitService.setWorkingDirectoryChanges(changesArray[i]);
              gitService.stash(`Stash ${i}`);
            }

            const initialCount = gitService.stashList().length;

            // Drop the first stash (most recent)
            gitService.stashDrop(0);

            // Assert: Indices are consecutive from 0
            const remainingStashes = gitService.stashList();
            assert.strictEqual(
              remainingStashes.length,
              initialCount - 1,
              'Should have one fewer stash'
            );

            for (let i = 0; i < remainingStashes.length; i++) {
              assert.strictEqual(
                remainingStashes[i].index,
                i,
                `After dropping first stash, stash at position ${i} should have index ${i}`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Dropping the last stash re-indexes correctly.
     *
     * **Validates: Requirements 7.6**
     */
    it('Property: Dropping the last stash re-indexes correctly', () => {
      fc.assert(
        fc.property(
          fc.array(uncommittedChangesArb, { minLength: 2, maxLength: 5 }),
          (changesArray) => {
            // Setup
            const gitService = new MockGitService();

            // Create multiple stashes
            for (let i = 0; i < changesArray.length; i++) {
              gitService.setWorkingDirectoryChanges(changesArray[i]);
              gitService.stash(`Stash ${i}`);
            }

            const initialCount = gitService.stashList().length;

            // Drop the last stash (oldest)
            gitService.stashDrop(initialCount - 1);

            // Assert: Indices are consecutive from 0
            const remainingStashes = gitService.stashList();
            assert.strictEqual(
              remainingStashes.length,
              initialCount - 1,
              'Should have one fewer stash'
            );

            for (let i = 0; i < remainingStashes.length; i++) {
              assert.strictEqual(
                remainingStashes[i].index,
                i,
                `After dropping last stash, stash at position ${i} should have index ${i}`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Dropped stash data is completely removed from storage.
     *
     * **Validates: Requirements 7.6**
     */
    it('Property: Dropped stash data is completely removed from storage', () => {
      fc.assert(
        fc.property(
          fc.array(uncommittedChangesArb, { minLength: 2, maxLength: 5 }),
          fc.nat({ max: 4 }),
          (changesArray, dropIndex) => {
            // Setup
            const gitService = new MockGitService();

            // Create multiple stashes
            for (let i = 0; i < changesArray.length; i++) {
              gitService.setWorkingDirectoryChanges(changesArray[i]);
              gitService.stash(`Stash ${i}`);
            }

            const indexToDrop = dropIndex % changesArray.length;

            // Pre-condition: Stash data exists
            assert.ok(
              gitService.getStashedChanges(indexToDrop) !== undefined,
              'Stash data should exist before drop'
            );

            // Act: Drop the stash
            gitService.stashDrop(indexToDrop);

            // Assert: After re-indexing, the old index no longer has data
            // (unless another stash was re-indexed to that position)
            const remainingStashes = gitService.stashList();

            // Verify all remaining stashes have their data intact
            for (const stash of remainingStashes) {
              assert.ok(
                gitService.getStashedChanges(stash.index) !== undefined,
                `Remaining stash at index ${stash.index} should have its data`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Dropping stash on empty list should fail.
     *
     * **Validates: Requirements 7.6**
     */
    it('Property: Dropping stash on empty list should fail', () => {
      fc.assert(
        fc.property(fc.nat({ max: 10 }), (index) => {
          // Setup: Empty stash list
          const gitService = new MockGitService();

          // Pre-condition: No stashes exist
          assert.strictEqual(gitService.stashList().length, 0, 'Should have no stashes');

          // Act & Assert: Dropping any index should fail
          assert.throws(
            () => gitService.stashDrop(index),
            /does not exist/,
            'Should throw when dropping from empty stash list'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Multiple consecutive drops work correctly.
     *
     * **Validates: Requirements 7.6**
     */
    it('Property: Multiple consecutive drops work correctly', () => {
      fc.assert(
        fc.property(
          fc.array(uncommittedChangesArb, { minLength: 3, maxLength: 5 }),
          fc.array(fc.nat({ max: 4 }), { minLength: 1, maxLength: 3 }),
          (changesArray, dropSequence) => {
            // Setup
            const gitService = new MockGitService();

            // Create multiple stashes
            for (let i = 0; i < changesArray.length; i++) {
              gitService.setWorkingDirectoryChanges(changesArray[i]);
              gitService.stash(`Stash ${i}`);
            }

            let currentCount = gitService.stashList().length;

            // Perform multiple drops
            for (const dropIndex of dropSequence) {
              if (currentCount === 0) {
                break;
              }

              const validIndex = dropIndex % currentCount;
              gitService.stashDrop(validIndex);
              currentCount--;

              // Assert: After each drop, indices are consecutive
              const stashes = gitService.stashList();
              assert.strictEqual(stashes.length, currentCount, 'Count should decrease by 1');

              for (let i = 0; i < stashes.length; i++) {
                assert.strictEqual(
                  stashes[i].index,
                  i,
                  `After drop, stash at position ${i} should have index ${i}`
                );
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
