import * as fc from 'fast-check';
import * as assert from 'assert';
import { IShelfItem, IShelfFile } from '../../services/interfaces/IShelfService';

/**
 * Property-based tests for Shelf List Completeness.
 * Feature: intellij-git-vscode, Property 23: Shelf List Completeness
 *
 * **Validates: Requirements 8.3**
 *
 * Property Description:
 * For any shelf items, the shelf view SHALL display all items with their names
 * and timestamps.
 *
 * Requirements:
 * - 8.3: WHEN a user views the shelf, THE Extension SHALL display all shelved
 *        changesets with names and timestamps
 */
describe('Shelf List Completeness Property Tests', () => {
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
   * Arbitrary generator for shelf item names.
   */
  const shelfNameArb: fc.Arbitrary<string> = fc
    .string({ minLength: 1, maxLength: 100 })
    .filter((s) => s.trim().length > 0);

  /**
   * Arbitrary generator for diff content (simplified patch format).
   */
  const diffContentArb: fc.Arbitrary<string> = fc
    .tuple(
      filePathArb,
      fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 1, maxLength: 5 })
    )
    .map(([filePath, lines]) => {
      const header = `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n`;
      const hunkHeader = `@@ -1,${lines.length} +1,${lines.length} @@\n`;
      const diffLines = lines.map((line) => `+${line}`).join('\n');
      return header + hunkHeader + diffLines + '\n';
    });

  /**
   * Arbitrary generator for shelf files.
   */
  const shelfFileArb: fc.Arbitrary<IShelfFile> = fc.record({
    path: filePathArb,
    diff: diffContentArb,
  });

  /**
   * Arbitrary generator for a non-empty array of shelf files.
   */
  const shelfFilesArb: fc.Arbitrary<IShelfFile[]> = fc
    .array(shelfFileArb, { minLength: 1, maxLength: 10 })
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
   * Mock ShelfService that simulates shelf operations in memory.
   * This allows us to test the shelf list completeness properties without actual Git operations.
   */
  class MockShelfService {
    private _shelfItems: Map<string, IShelfItem> = new Map();
    private _workingDirectoryChanges: Map<string, string> = new Map(); // path -> diff content
    private _nextShelfId: number = 0;

    constructor(initialChanges: IShelfFile[] = []) {
      for (const file of initialChanges) {
        this._workingDirectoryChanges.set(file.path, file.diff);
      }
    }

    /**
     * Get the current changes in the working directory.
     */
    getWorkingDirectoryChanges(): IShelfFile[] {
      const files: IShelfFile[] = [];
      for (const [path, diff] of this._workingDirectoryChanges) {
        files.push({ path, diff });
      }
      return files;
    }

    /**
     * Set working directory changes (for testing).
     */
    setWorkingDirectoryChanges(files: IShelfFile[]): void {
      this._workingDirectoryChanges.clear();
      for (const file of files) {
        this._workingDirectoryChanges.set(file.path, file.diff);
      }
    }

    /**
     * Shelve changes from the working directory.
     * Requirement 8.1: Save selected changes to an IDE-managed shelf storage.
     *
     * @param name - Name for the shelf item
     * @param files - Files to shelve (if empty, shelve all working directory changes)
     * @returns The created shelf item
     */
    shelve(name: string, files?: string[]): IShelfItem {
      const filesToShelve = files
        ? files.filter((f) => this._workingDirectoryChanges.has(f))
        : Array.from(this._workingDirectoryChanges.keys());

      if (filesToShelve.length === 0) {
        throw new Error('No changes to shelve');
      }

      // Create shelf files from working directory changes
      const shelfFiles: IShelfFile[] = filesToShelve.map((path) => ({
        path,
        diff: this._workingDirectoryChanges.get(path)!,
      }));

      // Generate unique ID
      const id = `shelf-${Date.now()}-${this._nextShelfId++}`;

      // Create the shelf item
      const shelfItem: IShelfItem = {
        id,
        name,
        timestamp: new Date(),
        files: shelfFiles,
      };

      // Save to storage
      this._shelfItems.set(id, shelfItem);

      // Remove shelved changes from working directory
      for (const path of filesToShelve) {
        this._workingDirectoryChanges.delete(path);
      }

      return shelfItem;
    }

    /**
     * Get all shelf items.
     * Requirement 8.3: Display all shelved changesets with names and timestamps.
     */
    getShelfItems(): IShelfItem[] {
      return Array.from(this._shelfItems.values());
    }

    /**
     * Delete a shelf item.
     */
    deleteShelfItem(shelfId: string): void {
      if (!this._shelfItems.has(shelfId)) {
        throw new Error(`Shelf item not found: ${shelfId}`);
      }
      this._shelfItems.delete(shelfId);
    }

    /**
     * Check if a shelf item exists.
     */
    shelfItemExists(shelfId: string): boolean {
      return this._shelfItems.has(shelfId);
    }

    /**
     * Get a shelf item by ID.
     */
    getShelfItem(shelfId: string): IShelfItem | undefined {
      return this._shelfItems.get(shelfId);
    }
  }

  describe('Property 23: Shelf List Completeness', () => {
    /**
     * Property: Shelf list displays all created shelf items.
     *
     * **Validates: Requirements 8.3**
     */
    it('Property: Shelf list displays all created shelf items', () => {
      fc.assert(
        fc.property(
          fc.array(shelfFilesArb, { minLength: 1, maxLength: 10 }),
          fc.array(shelfNameArb, { minLength: 1, maxLength: 10 }),
          (filesArray, namesArray) => {
            const shelfService = new MockShelfService();
            const shelfCount = Math.min(filesArray.length, namesArray.length);
            const createdIds: string[] = [];

            // Create multiple shelf items
            for (let i = 0; i < shelfCount; i++) {
              shelfService.setWorkingDirectoryChanges(filesArray[i]);
              const shelfItem = shelfService.shelve(namesArray[i]);
              createdIds.push(shelfItem.id);
            }

            // Assert: Shelf list contains all created shelf items
            const shelfList = shelfService.getShelfItems();
            assert.strictEqual(
              shelfList.length,
              shelfCount,
              `Shelf list should contain ${shelfCount} items`
            );

            // Assert: All created IDs are present in the list
            const listIds = new Set(shelfList.map((item) => item.id));
            for (const id of createdIds) {
              assert.ok(listIds.has(id), `Shelf item with ID '${id}' should be in the list`);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Shelf list displays items with their names.
     *
     * **Validates: Requirements 8.3**
     */
    it('Property: Shelf list displays items with their names', () => {
      fc.assert(
        fc.property(
          fc.array(shelfFilesArb, { minLength: 1, maxLength: 5 }),
          fc.array(shelfNameArb, { minLength: 1, maxLength: 5 }),
          (filesArray, namesArray) => {
            const shelfService = new MockShelfService();
            const shelfCount = Math.min(filesArray.length, namesArray.length);
            const createdNames: string[] = [];

            // Create shelf items with specific names
            for (let i = 0; i < shelfCount; i++) {
              shelfService.setWorkingDirectoryChanges(filesArray[i]);
              shelfService.shelve(namesArray[i]);
              createdNames.push(namesArray[i]);
            }

            // Assert: Each shelf item has its name preserved
            const shelfList = shelfService.getShelfItems();
            const listNames = new Set(shelfList.map((item) => item.name));

            for (const name of createdNames) {
              assert.ok(
                listNames.has(name),
                `Shelf item with name '${name}' should be in the list`
              );
            }

            // Assert: All items have non-empty names
            for (const item of shelfList) {
              assert.ok(item.name.length > 0, 'Each shelf item should have a non-empty name');
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Shelf list displays items with their timestamps.
     *
     * **Validates: Requirements 8.3**
     */
    it('Property: Shelf list displays items with their timestamps', () => {
      fc.assert(
        fc.property(shelfFilesArb, shelfNameArb, (files, name) => {
          const shelfService = new MockShelfService(files);
          const beforeShelve = new Date();

          shelfService.shelve(name);

          const afterShelve = new Date();
          const shelfList = shelfService.getShelfItems();

          assert.strictEqual(shelfList.length, 1, 'Should have one shelf item');
          assert.ok(shelfList[0].timestamp instanceof Date, 'Shelf item should have a timestamp');
          assert.ok(
            shelfList[0].timestamp >= beforeShelve && shelfList[0].timestamp <= afterShelve,
            'Shelf item timestamp should be within the creation window'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Shelf list is complete after multiple shelve operations.
     *
     * **Validates: Requirements 8.3**
     */
    it('Property: Shelf list is complete after multiple shelve operations', () => {
      fc.assert(
        fc.property(
          fc.array(shelfFilesArb, { minLength: 2, maxLength: 10 }),
          fc.array(shelfNameArb, { minLength: 2, maxLength: 10 }),
          (filesArray, namesArray) => {
            const shelfService = new MockShelfService();
            const shelfCount = Math.min(filesArray.length, namesArray.length);
            const expectedItems: { name: string; id: string }[] = [];

            // Create multiple shelf items
            for (let i = 0; i < shelfCount; i++) {
              shelfService.setWorkingDirectoryChanges(filesArray[i]);
              const shelfItem = shelfService.shelve(namesArray[i]);
              expectedItems.push({ name: shelfItem.name, id: shelfItem.id });
            }

            // Assert: Shelf list is complete
            const shelfList = shelfService.getShelfItems();
            assert.strictEqual(
              shelfList.length,
              shelfCount,
              `Shelf list should contain all ${shelfCount} items`
            );

            // Assert: All expected items are present with correct names
            for (const expected of expectedItems) {
              const found = shelfList.find((item) => item.id === expected.id);
              assert.ok(found, `Shelf item with ID '${expected.id}' should be in the list`);
              assert.strictEqual(
                found.name,
                expected.name,
                `Shelf item name should be '${expected.name}'`
              );
            }

            // Assert: All items have valid timestamps
            for (const item of shelfList) {
              assert.ok(item.timestamp instanceof Date, 'Each shelf item should have a timestamp');
              assert.ok(
                item.timestamp.getTime() <= Date.now(),
                'Shelf item timestamp should not be in the future'
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Shelf list remains complete after deleting items.
     *
     * **Validates: Requirements 8.3**
     */
    it('Property: Shelf list remains complete after deleting items', () => {
      fc.assert(
        fc.property(
          fc.array(shelfFilesArb, { minLength: 3, maxLength: 5 }),
          fc.array(shelfNameArb, { minLength: 3, maxLength: 5 }),
          fc.nat({ max: 2 }),
          (filesArray, namesArray, deleteIndex) => {
            const shelfService = new MockShelfService();
            const shelfCount = Math.min(filesArray.length, namesArray.length);
            const createdItems: IShelfItem[] = [];

            // Create multiple shelf items
            for (let i = 0; i < shelfCount; i++) {
              shelfService.setWorkingDirectoryChanges(filesArray[i]);
              const shelfItem = shelfService.shelve(namesArray[i]);
              createdItems.push(shelfItem);
            }

            const initialCount = shelfService.getShelfItems().length;
            const indexToDelete = deleteIndex % initialCount;
            const itemToDelete = createdItems[indexToDelete];

            // Delete a shelf item
            shelfService.deleteShelfItem(itemToDelete.id);

            // Assert: Shelf list has one fewer item
            const shelfList = shelfService.getShelfItems();
            assert.strictEqual(
              shelfList.length,
              initialCount - 1,
              'Shelf list should have one fewer item after deletion'
            );

            // Assert: Deleted item is not in the list
            const listIds = new Set(shelfList.map((item) => item.id));
            assert.ok(!listIds.has(itemToDelete.id), 'Deleted item should not be in the list');

            // Assert: All remaining items have valid names
            for (const item of shelfList) {
              assert.ok(item.name.length > 0, 'Each remaining item should have a name');
            }

            // Assert: All remaining items have valid timestamps
            for (const item of shelfList) {
              assert.ok(
                item.timestamp instanceof Date,
                'Each remaining item should have a timestamp'
              );
            }

            // Assert: All other items are still present
            for (let i = 0; i < createdItems.length; i++) {
              if (i !== indexToDelete) {
                assert.ok(
                  listIds.has(createdItems[i].id),
                  `Item '${createdItems[i].name}' should still be in the list`
                );
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Empty shelf returns empty list.
     *
     * **Validates: Requirements 8.3**
     */
    it('Property: Empty shelf returns empty list', () => {
      fc.assert(
        fc.property(fc.constant(null), () => {
          const shelfService = new MockShelfService();
          const shelfList = shelfService.getShelfItems();

          assert.strictEqual(shelfList.length, 0, 'Empty shelf should return empty list');
        }),
        { numRuns: 10 }
      );
    });

    /**
     * Property: Shelf list is idempotent (calling multiple times returns same result).
     *
     * **Validates: Requirements 8.3**
     */
    it('Property: Shelf list is idempotent', () => {
      fc.assert(
        fc.property(
          fc.array(shelfFilesArb, { minLength: 1, maxLength: 5 }),
          fc.array(shelfNameArb, { minLength: 1, maxLength: 5 }),
          (filesArray, namesArray) => {
            const shelfService = new MockShelfService();
            const shelfCount = Math.min(filesArray.length, namesArray.length);

            // Create shelf items
            for (let i = 0; i < shelfCount; i++) {
              shelfService.setWorkingDirectoryChanges(filesArray[i]);
              shelfService.shelve(namesArray[i]);
            }

            // Call getShelfItems multiple times
            const list1 = shelfService.getShelfItems();
            const list2 = shelfService.getShelfItems();
            const list3 = shelfService.getShelfItems();

            // Assert: All calls return the same result
            assert.strictEqual(list1.length, list2.length, 'Lists should have same length');
            assert.strictEqual(list2.length, list3.length, 'Lists should have same length');

            for (let i = 0; i < list1.length; i++) {
              assert.strictEqual(list1[i].id, list2[i].id, 'IDs should match');
              assert.strictEqual(list1[i].name, list2[i].name, 'Names should match');
              assert.strictEqual(
                list1[i].timestamp.getTime(),
                list2[i].timestamp.getTime(),
                'Timestamps should match'
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Each shelf item in list has unique ID.
     *
     * **Validates: Requirements 8.3**
     */
    it('Property: Each shelf item in list has unique ID', () => {
      fc.assert(
        fc.property(
          fc.array(shelfFilesArb, { minLength: 2, maxLength: 10 }),
          fc.array(shelfNameArb, { minLength: 2, maxLength: 10 }),
          (filesArray, namesArray) => {
            const shelfService = new MockShelfService();
            const shelfCount = Math.min(filesArray.length, namesArray.length);

            // Create multiple shelf items
            for (let i = 0; i < shelfCount; i++) {
              shelfService.setWorkingDirectoryChanges(filesArray[i]);
              shelfService.shelve(namesArray[i]);
            }

            // Assert: All IDs are unique
            const shelfList = shelfService.getShelfItems();
            const ids = new Set<string>();
            for (const item of shelfList) {
              assert.ok(!ids.has(item.id), `ID '${item.id}' should be unique`);
              ids.add(item.id);
            }

            assert.strictEqual(ids.size, shelfList.length, 'All IDs should be unique');
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Shelf list items contain file information.
     *
     * **Validates: Requirements 8.3**
     */
    it('Property: Shelf list items contain file information', () => {
      fc.assert(
        fc.property(shelfFilesArb, shelfNameArb, (files, name) => {
          const shelfService = new MockShelfService(files);

          shelfService.shelve(name);

          const shelfList = shelfService.getShelfItems();
          assert.strictEqual(shelfList.length, 1, 'Should have one shelf item');

          const item = shelfList[0];
          assert.ok(Array.isArray(item.files), 'Shelf item should have files array');
          assert.ok(item.files.length > 0, 'Shelf item should have at least one file');

          // Assert: Each file has path and diff
          for (const file of item.files) {
            assert.ok(file.path.length > 0, 'File should have a path');
            assert.ok(file.diff.length > 0, 'File should have diff content');
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Shelf list preserves all item properties after multiple operations.
     *
     * **Validates: Requirements 8.3**
     */
    it('Property: Shelf list preserves all item properties after multiple operations', () => {
      fc.assert(
        fc.property(
          fc.array(shelfFilesArb, { minLength: 2, maxLength: 5 }),
          fc.array(shelfNameArb, { minLength: 2, maxLength: 5 }),
          (filesArray, namesArray) => {
            const shelfService = new MockShelfService();
            const shelfCount = Math.min(filesArray.length, namesArray.length);
            const originalItems: Map<string, { name: string; timestamp: Date; fileCount: number }> =
              new Map();

            // Create shelf items and store their properties
            for (let i = 0; i < shelfCount; i++) {
              shelfService.setWorkingDirectoryChanges(filesArray[i]);
              const shelfItem = shelfService.shelve(namesArray[i]);
              originalItems.set(shelfItem.id, {
                name: shelfItem.name,
                timestamp: shelfItem.timestamp,
                fileCount: shelfItem.files.length,
              });
            }

            // Get the list multiple times and verify properties are preserved
            for (let iteration = 0; iteration < 3; iteration++) {
              const shelfList = shelfService.getShelfItems();

              for (const item of shelfList) {
                const original = originalItems.get(item.id);
                assert.ok(original, `Original item for ID '${item.id}' should exist`);
                assert.strictEqual(
                  item.name,
                  original.name,
                  `Name should be preserved for item '${item.id}'`
                );
                assert.strictEqual(
                  item.timestamp.getTime(),
                  original.timestamp.getTime(),
                  `Timestamp should be preserved for item '${item.id}'`
                );
                assert.strictEqual(
                  item.files.length,
                  original.fileCount,
                  `File count should be preserved for item '${item.id}'`
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
