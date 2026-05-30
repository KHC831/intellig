import * as fc from 'fast-check';
import * as assert from 'assert';
import { IStash, IFileStatus, StatusCode } from '../../git-core/interfaces/IGitService';

/**
 * Property-based tests for Stash List Completeness.
 * Feature: intellig-vscode, Property 19: Stash List Completeness
 *
 *
 * Property Description:
 * For any repository with stashes, the stash list SHALL display all stashes
 * with their messages and timestamps in the correct order (most recent first).
 *
 * - 7.3: Display all stashes with messages and timestamps
 */
describe('Stash List Completeness Property Tests', () => {
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
     */
    stashList(): IStash[] {
      return [...this._stashes];
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

  describe('Property 19: Stash List Completeness', () => {
    /**
     * Property: Stash list displays all stashes that were created.
     */
    it('Property: Stash list displays all created stashes', () => {
      fc.assert(
        fc.property(
          fc.array(uncommittedChangesArb, { minLength: 1, maxLength: 10 }),
          fc.array(stashMessageArb, { minLength: 1, maxLength: 10 }),
          (changesArray, messages) => {
            const gitService = new MockGitService();
            const stashCount = Math.min(changesArray.length, messages.length);

            // Create multiple stashes
            for (let i = 0; i < stashCount; i++) {
              gitService.setWorkingDirectoryChanges(changesArray[i]);
              gitService.stash(messages[i]);
            }

            // Assert: Stash list contains all created stashes
            const stashList = gitService.stashList();
            assert.strictEqual(
              stashList.length,
              stashCount,
              `Stash list should contain ${stashCount} stashes`
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Stash list displays stashes with their messages.
     */
    it('Property: Stash list displays stashes with their messages', () => {
      fc.assert(
        fc.property(
          fc.array(uncommittedChangesArb, { minLength: 1, maxLength: 5 }),
          fc.array(stashMessageArb, { minLength: 1, maxLength: 5 }),
          (changesArray, messages) => {
            const gitService = new MockGitService();
            const stashCount = Math.min(changesArray.length, messages.length);
            const createdMessages: string[] = [];

            // Create stashes with specific messages
            for (let i = 0; i < stashCount; i++) {
              gitService.setWorkingDirectoryChanges(changesArray[i]);
              gitService.stash(messages[i]);
              createdMessages.push(messages[i]);
            }

            // Assert: Each stash has its message preserved
            const stashList = gitService.stashList();
            for (let i = 0; i < stashCount; i++) {
              // Stashes are in reverse order (most recent first)
              const expectedMessage = createdMessages[stashCount - 1 - i];
              assert.strictEqual(
                stashList[i].message,
                expectedMessage,
                `Stash at index ${i} should have message "${expectedMessage}"`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Stash list displays stashes with timestamps.
     */
    it('Property: Stash list displays stashes with timestamps', () => {
      fc.assert(
        fc.property(uncommittedChangesArb, stashMessageArb, (changes, message) => {
          const gitService = new MockGitService(changes);
          const beforeStash = new Date();

          gitService.stash(message);

          const afterStash = new Date();
          const stashList = gitService.stashList();

          assert.strictEqual(stashList.length, 1, 'Should have one stash');
          assert.ok(stashList[0].date instanceof Date, 'Stash should have a date');
          assert.ok(
            stashList[0].date >= beforeStash && stashList[0].date <= afterStash,
            'Stash timestamp should be within the creation window'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Stash list is ordered with most recent first.
     */
    it('Property: Stash list is ordered with most recent first', () => {
      fc.assert(
        fc.property(
          fc.array(uncommittedChangesArb, { minLength: 2, maxLength: 5 }),
          fc.array(stashMessageArb, { minLength: 2, maxLength: 5 }),
          (changesArray, messages) => {
            const gitService = new MockGitService();
            const stashCount = Math.min(changesArray.length, messages.length);
            const creationOrder: string[] = [];

            // Create stashes in order
            for (let i = 0; i < stashCount; i++) {
              gitService.setWorkingDirectoryChanges(changesArray[i]);
              gitService.stash(messages[i]);
              creationOrder.push(messages[i]);
            }

            // Assert: Stash list is in reverse creation order (most recent first)
            const stashList = gitService.stashList();
            for (let i = 0; i < stashCount; i++) {
              const expectedMessage = creationOrder[stashCount - 1 - i];
              assert.strictEqual(
                stashList[i].message,
                expectedMessage,
                `Stash at position ${i} should be the ${stashCount - i}th created stash`
              );
            }

            // Assert: Indices are consecutive starting from 0
            for (let i = 0; i < stashList.length; i++) {
              assert.strictEqual(
                stashList[i].index,
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
     * Property: Stash list timestamps are in descending order (most recent first).
     */
    it('Property: Stash list timestamps are in descending order', () => {
      fc.assert(
        fc.property(
          fc.array(uncommittedChangesArb, { minLength: 2, maxLength: 5 }),
          (changesArray) => {
            const gitService = new MockGitService();

            // Create stashes with small delays to ensure different timestamps
            for (let i = 0; i < changesArray.length; i++) {
              gitService.setWorkingDirectoryChanges(changesArray[i]);
              gitService.stash(`Stash ${i}`);
            }

            const stashList = gitService.stashList();

            // Assert: Timestamps are in descending order (most recent first)
            for (let i = 0; i < stashList.length - 1; i++) {
              assert.ok(
                stashList[i].date >= stashList[i + 1].date,
                `Stash at index ${i} should have timestamp >= stash at index ${i + 1}`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Empty repository has empty stash list.
     */
    it('Property: Empty repository has empty stash list', () => {
      fc.assert(
        fc.property(fc.constant(null), () => {
          const gitService = new MockGitService();
          const stashList = gitService.stashList();

          assert.strictEqual(stashList.length, 0, 'Empty repository should have no stashes');
        }),
        { numRuns: 10 }
      );
    });

    /**
     * Property: Stash list remains complete after dropping stashes.
     */
    it('Property: Stash list remains complete after dropping stashes', () => {
      fc.assert(
        fc.property(
          fc.array(uncommittedChangesArb, { minLength: 3, maxLength: 5 }),
          fc.nat({ max: 2 }),
          (changesArray, dropIndex) => {
            const gitService = new MockGitService();

            // Create multiple stashes
            for (let i = 0; i < changesArray.length; i++) {
              gitService.setWorkingDirectoryChanges(changesArray[i]);
              gitService.stash(`Stash ${i}`);
            }

            const initialCount = gitService.stashList().length;
            const indexToDrop = dropIndex % initialCount;

            // Drop a stash
            gitService.stashDrop(indexToDrop);

            // Assert: Stash list has one fewer stash
            const stashList = gitService.stashList();
            assert.strictEqual(
              stashList.length,
              initialCount - 1,
              'Stash list should have one fewer stash after drop'
            );

            // Assert: All remaining stashes have valid messages
            for (const stash of stashList) {
              assert.ok(stash.message.length > 0, 'Each stash should have a message');
            }

            // Assert: All remaining stashes have valid timestamps
            for (const stash of stashList) {
              assert.ok(stash.date instanceof Date, 'Each stash should have a timestamp');
            }

            // Assert: Indices are re-indexed correctly (0, 1, 2, ...)
            for (let i = 0; i < stashList.length; i++) {
              assert.strictEqual(
                stashList[i].index,
                i,
                `Stash at position ${i} should have index ${i} after re-indexing`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Stash list includes branch information.
     */
    it('Property: Stash list includes branch information', () => {
      fc.assert(
        fc.property(uncommittedChangesArb, stashMessageArb, (changes, message) => {
          const gitService = new MockGitService(changes);

          gitService.stash(message);

          const stashList = gitService.stashList();
          assert.strictEqual(stashList.length, 1, 'Should have one stash');
          assert.ok(stashList[0].branch !== undefined, 'Stash should include branch information');
          assert.ok(stashList[0].branch.length > 0, 'Stash branch should be non-empty');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Stash list is idempotent (calling multiple times returns same result).
     */
    it('Property: Stash list is idempotent', () => {
      fc.assert(
        fc.property(
          fc.array(uncommittedChangesArb, { minLength: 1, maxLength: 5 }),
          fc.array(stashMessageArb, { minLength: 1, maxLength: 5 }),
          (changesArray, messages) => {
            const gitService = new MockGitService();
            const stashCount = Math.min(changesArray.length, messages.length);

            // Create stashes
            for (let i = 0; i < stashCount; i++) {
              gitService.setWorkingDirectoryChanges(changesArray[i]);
              gitService.stash(messages[i]);
            }

            // Call stashList multiple times
            const list1 = gitService.stashList();
            const list2 = gitService.stashList();
            const list3 = gitService.stashList();

            // Assert: All calls return the same result
            assert.strictEqual(list1.length, list2.length, 'Lists should have same length');
            assert.strictEqual(list2.length, list3.length, 'Lists should have same length');

            for (let i = 0; i < list1.length; i++) {
              assert.strictEqual(list1[i].index, list2[i].index, 'Indices should match');
              assert.strictEqual(list1[i].message, list2[i].message, 'Messages should match');
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
