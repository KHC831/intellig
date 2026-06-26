import * as fc from 'fast-check';
import * as assert from 'assert';
import { IShelfItem, IShelfFile, IUnshelveOptions } from '../../src/shelf/interfaces/IShelfService';

/**
 * Property-based tests for Shelf Round-Trip.
 * Feature: intellig-vscode, Property 21: Shelf Round-Trip
 *
 *
 * Property Description:
 * For any set of changes shelved, unshelving SHALL restore those exact changes
 * to the working directory.
 *
 * - 8.1: WHEN a user selects "Shelve Changes", THE Extension SHALL save selected
 *        changes to an IDE-managed shelf storage
 * - 8.4: WHEN a user selects "Unshelve", THE Extension SHALL restore the shelved
 *        changes to the working directory
 */
describe('Shelf Round-Trip Property Tests', () => {
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
   * This allows us to test the shelf round-trip properties without actual Git operations.
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
     * Unshelve changes back to working directory.
     *
     * @param shelfId - ID of the shelf item to unshelve
     * @param options - Unshelve options
     * @returns Result of the unshelve operation
     */
    unshelve(
      shelfId: string,
      options?: IUnshelveOptions
    ): { success: boolean; conflicts?: string[] } {
      const shelfItem = this._shelfItems.get(shelfId);
      if (!shelfItem) {
        throw new Error(`Shelf item not found: ${shelfId}`);
      }

      const conflicts: string[] = [];

      // Apply each file's changes to the working directory
      for (const file of shelfItem.files) {
        // Check for conflicts (file already has different changes)
        if (this._workingDirectoryChanges.has(file.path)) {
          const existingDiff = this._workingDirectoryChanges.get(file.path);
          if (existingDiff !== file.diff) {
            conflicts.push(file.path);
            continue;
          }
        }
        // Restore the change to working directory
        this._workingDirectoryChanges.set(file.path, file.diff);
      }

      // Remove from shelf if requested (default is true)
      const removeFromShelf = options?.removeFromShelf !== false;
      if (removeFromShelf && conflicts.length === 0) {
        this._shelfItems.delete(shelfId);
      }

      return {
        success: conflicts.length === 0,
        conflicts: conflicts.length > 0 ? conflicts : undefined,
      };
    }

    /**
     * Get all shelf items.
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

  /**
   * Compare two arrays of shelf files for equality.
   */
  function shelfFilesEqual(a: IShelfFile[], b: IShelfFile[]): boolean {
    if (a.length !== b.length) {
      return false;
    }

    // Sort both arrays by path for comparison
    const sortedA = [...a].sort((x, y) => x.path.localeCompare(y.path));
    const sortedB = [...b].sort((x, y) => x.path.localeCompare(y.path));

    for (let i = 0; i < sortedA.length; i++) {
      if (sortedA[i].path !== sortedB[i].path || sortedA[i].diff !== sortedB[i].diff) {
        return false;
      }
    }
    return true;
  }

  describe('Property 21: Shelf Round-Trip', () => {
    /**
     * Property: Shelving changes and then unshelving restores the exact same changes.
     */
    it('Property: Shelve and unshelve restores exact same changes', () => {
      fc.assert(
        fc.property(shelfFilesArb, shelfNameArb, (files, name) => {
          // Setup
          const shelfService = new MockShelfService(files);

          // Pre-condition: Working directory has changes
          const originalChanges = shelfService.getWorkingDirectoryChanges();
          assert.ok(originalChanges.length > 0, 'Should have changes to shelve');

          // Act: Shelve the changes
          const shelfItem = shelfService.shelve(name);

          // Assert: Working directory is clean after shelve
          assert.strictEqual(
            shelfService.getWorkingDirectoryChanges().length,
            0,
            'Working directory should be clean after shelve'
          );

          // Assert: Shelf has one item
          const shelfItems = shelfService.getShelfItems();
          assert.strictEqual(shelfItems.length, 1, 'Should have one shelf item');

          // Act: Unshelve the changes (with removeFromShelf: false to keep the item)
          const result = shelfService.unshelve(shelfItem.id, { removeFromShelf: false });

          // Assert: Unshelve succeeded
          assert.ok(result.success, 'Unshelve should succeed');

          // Assert: Changes are restored exactly
          const restoredChanges = shelfService.getWorkingDirectoryChanges();
          assert.ok(
            shelfFilesEqual(originalChanges, restoredChanges),
            'Unshelved changes should match original changes'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Shelf items preserve their names and content.
     */
    it('Property: Shelf items preserve their names and content', () => {
      fc.assert(
        fc.property(shelfFilesArb, shelfNameArb, (files, name) => {
          // Setup
          const shelfService = new MockShelfService(files);
          const originalChanges = shelfService.getWorkingDirectoryChanges();

          // Act: Shelve the changes
          const shelfItem = shelfService.shelve(name);

          // Assert: Shelf item has the correct name
          assert.strictEqual(shelfItem.name, name, 'Shelf item name should be preserved');

          // Assert: Shelf item has the correct files
          assert.ok(
            shelfFilesEqual(originalChanges, shelfItem.files),
            'Shelf item files should match original changes'
          );

          // Assert: Shelf item has a valid timestamp
          assert.ok(shelfItem.timestamp instanceof Date, 'Shelf item should have a timestamp');
          assert.ok(
            shelfItem.timestamp.getTime() <= Date.now(),
            'Shelf item timestamp should not be in the future'
          );

          // Assert: Shelf item has a valid ID
          assert.ok(shelfItem.id.length > 0, 'Shelf item should have an ID');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Unshelving with removeFromShelf option removes the item.
     */
    it('Property: Unshelving with removeFromShelf removes the item', () => {
      fc.assert(
        fc.property(shelfFilesArb, shelfNameArb, (files, name) => {
          // Setup
          const shelfService = new MockShelfService(files);

          // Act: Shelve the changes
          const shelfItem = shelfService.shelve(name);
          const shelfId = shelfItem.id;

          // Assert: Shelf item exists
          assert.ok(shelfService.shelfItemExists(shelfId), 'Shelf item should exist');

          // Act: Unshelve with removeFromShelf: true (default)
          const result = shelfService.unshelve(shelfId, { removeFromShelf: true });

          // Assert: Unshelve succeeded
          assert.ok(result.success, 'Unshelve should succeed');

          // Assert: Shelf item is removed
          assert.ok(!shelfService.shelfItemExists(shelfId), 'Shelf item should be removed');
          assert.strictEqual(shelfService.getShelfItems().length, 0, 'Shelf should be empty');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Unshelving with keepCopy option keeps the item.
     */
    it('Property: Unshelving with keepCopy (removeFromShelf: false) keeps the item', () => {
      fc.assert(
        fc.property(shelfFilesArb, shelfNameArb, (files, name) => {
          // Setup
          const shelfService = new MockShelfService(files);

          // Act: Shelve the changes
          const shelfItem = shelfService.shelve(name);
          const shelfId = shelfItem.id;

          // Assert: Shelf item exists
          assert.ok(shelfService.shelfItemExists(shelfId), 'Shelf item should exist');

          // Act: Unshelve with removeFromShelf: false (keep copy)
          const result = shelfService.unshelve(shelfId, { removeFromShelf: false });

          // Assert: Unshelve succeeded
          assert.ok(result.success, 'Unshelve should succeed');

          // Assert: Shelf item is still present
          assert.ok(shelfService.shelfItemExists(shelfId), 'Shelf item should still exist');
          assert.strictEqual(
            shelfService.getShelfItems().length,
            1,
            'Shelf should still have one item'
          );

          // Assert: The shelf item content is unchanged
          const retrievedItem = shelfService.getShelfItem(shelfId);
          assert.ok(retrievedItem, 'Should be able to retrieve shelf item');
          assert.strictEqual(retrievedItem.name, name, 'Shelf item name should be unchanged');
          assert.ok(
            shelfFilesEqual(shelfItem.files, retrievedItem.files),
            'Shelf item files should be unchanged'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Shelf round-trip preserves file paths exactly.
     */
    it('Property: Shelf round-trip preserves file paths exactly', () => {
      fc.assert(
        fc.property(shelfFilesArb, shelfNameArb, (files, name) => {
          // Setup
          const shelfService = new MockShelfService(files);
          const originalPaths = new Set(files.map((f) => f.path));

          // Act: Shelve and unshelve
          const shelfItem = shelfService.shelve(name);
          shelfService.unshelve(shelfItem.id, { removeFromShelf: false });

          // Assert: All file paths are preserved
          const restoredPaths = new Set(
            shelfService.getWorkingDirectoryChanges().map((f) => f.path)
          );
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
     * Property: Shelf round-trip preserves diff content exactly.
     */
    it('Property: Shelf round-trip preserves diff content exactly', () => {
      fc.assert(
        fc.property(shelfFilesArb, shelfNameArb, (files, name) => {
          // Setup
          const shelfService = new MockShelfService(files);

          // Create a map of path -> diff for original changes
          const originalDiffMap = new Map<string, string>();
          for (const file of files) {
            originalDiffMap.set(file.path, file.diff);
          }

          // Act: Shelve and unshelve
          const shelfItem = shelfService.shelve(name);
          shelfService.unshelve(shelfItem.id, { removeFromShelf: false });

          // Assert: All diff content is preserved
          const restoredChanges = shelfService.getWorkingDirectoryChanges();
          for (const restored of restoredChanges) {
            const originalDiff = originalDiffMap.get(restored.path);
            assert.ok(originalDiff, `Original diff for '${restored.path}' should exist`);
            assert.strictEqual(
              restored.diff,
              originalDiff,
              `Diff content for '${restored.path}' should be preserved`
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Multiple shelf and unshelve operations maintain consistency.
     *
     * Regression (seed -836909896): keying `originalChangesMap` by
     * `namesArray[i]` collapses duplicate names into a single entry. When the
     * fast-check generator produces two entries with the same name (e.g.
     * `namesArray = ['!','! ','_','_']`), the later shelve overwrites the
     * earlier map entry, so comparing the earlier unshelve against
     * `originalChangesMap.get(namesArray[i])` uses the wrong expected
     * contents — a map-key-collision class.
     *
     * Track original changes by array index, not by name. This is
     * seed-independent; no synthetic block needed because the change is
     * purely in the bookkeeping, not the SUT.
     */
    it('Property: Multiple shelf and unshelve operations maintain consistency', () => {
      fc.assert(
        fc.property(
          fc.array(shelfFilesArb, { minLength: 2, maxLength: 5 }),
          fc.array(shelfNameArb, { minLength: 2, maxLength: 5 }),
          (filesArray, namesArray) => {
            // Setup
            const shelfService = new MockShelfService();

            // Key by array index (unique), not by name (can collide).
            const originalChangesList: IShelfFile[][] = [];

            // Act: Create multiple shelf items
            const shelfIds: string[] = [];
            const pairCount = Math.min(filesArray.length, namesArray.length);
            for (let i = 0; i < pairCount; i++) {
              shelfService.setWorkingDirectoryChanges(filesArray[i]);
              originalChangesList.push([...filesArray[i]]);
              const shelfItem = shelfService.shelve(namesArray[i]);
              shelfIds.push(shelfItem.id);
            }

            // Assert: All shelf items were created
            assert.strictEqual(
              shelfService.getShelfItems().length,
              shelfIds.length,
              'All shelf items should be created'
            );

            // Act & Assert: Unshelve each item and verify changes are restored
            for (let i = 0; i < shelfIds.length; i++) {
              // Clear working directory first
              shelfService.setWorkingDirectoryChanges([]);

              // Unshelve
              const result = shelfService.unshelve(shelfIds[i], { removeFromShelf: false });
              assert.ok(result.success, `Unshelve ${i} should succeed`);

              // Verify changes match
              const restoredChanges = shelfService.getWorkingDirectoryChanges();
              const expectedChanges = originalChangesList[i];
              assert.ok(
                shelfFilesEqual(expectedChanges, restoredChanges),
                `Shelf item ${i} should restore correct changes`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Regression: seed -836909896 shrank to
     * `namesArray = ['!','! ','_','_']` — two duplicated shelf names
     * collapsing the earlier entries in the map-keyed bookkeeping. Keying
     * by index (not name) avoids it; this pinned block catches any
     * re-introduction of name-keyed bookkeeping.
     *
     * See `test/property/pinnedSeeds.md` for the full catalog.
     */
    it('TR-9 regression: seed -836909896 does not flake multi-shelf consistency property', () => {
      fc.assert(
        fc.property(
          fc.array(shelfFilesArb, { minLength: 2, maxLength: 5 }),
          fc.array(shelfNameArb, { minLength: 2, maxLength: 5 }),
          (filesArray, namesArray) => {
            const shelfService = new MockShelfService();
            const originalChangesList: IShelfFile[][] = [];
            const shelfIds: string[] = [];
            const pairCount = Math.min(filesArray.length, namesArray.length);
            for (let i = 0; i < pairCount; i++) {
              shelfService.setWorkingDirectoryChanges(filesArray[i]);
              originalChangesList.push([...filesArray[i]]);
              shelfIds.push(shelfService.shelve(namesArray[i]).id);
            }

            for (let i = 0; i < shelfIds.length; i++) {
              shelfService.setWorkingDirectoryChanges([]);
              const result = shelfService.unshelve(shelfIds[i], { removeFromShelf: false });
              assert.ok(result.success);
              assert.ok(
                shelfFilesEqual(originalChangesList[i], shelfService.getWorkingDirectoryChanges())
              );
            }
          }
        ),
        { seed: -836909896, numRuns: 100 }
      );
    });

    /**
     * Regression (synthetic): duplicate shelf names must not collapse
     * the expected-changes bookkeeping.
     */
    it('TR-9 regression (synthetic): duplicate shelf names do not collapse restore bookkeeping', () => {
      const shelfService = new MockShelfService();
      const duplicateName = 'dup';
      const filesA: IShelfFile[] = [
        {
          path: 'a.txt',
          diff: 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n+A\n',
        },
      ];
      const filesB: IShelfFile[] = [
        {
          path: 'b.txt',
          diff: 'diff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n+B\n',
        },
      ];

      shelfService.setWorkingDirectoryChanges(filesA);
      const idA = shelfService.shelve(duplicateName).id;
      shelfService.setWorkingDirectoryChanges(filesB);
      const idB = shelfService.shelve(duplicateName).id;

      shelfService.setWorkingDirectoryChanges([]);
      assert.ok(shelfService.unshelve(idA, { removeFromShelf: false }).success);
      assert.ok(
        shelfFilesEqual(filesA, shelfService.getWorkingDirectoryChanges()),
        'Unshelving the first of two same-named shelves must restore the first shelf, not the second'
      );

      shelfService.setWorkingDirectoryChanges([]);
      assert.ok(shelfService.unshelve(idB, { removeFromShelf: false }).success);
      assert.ok(
        shelfFilesEqual(filesB, shelfService.getWorkingDirectoryChanges()),
        'Unshelving the second of two same-named shelves must restore the second shelf'
      );
    });

    /**
     * Property: Shelving with no changes should fail.
     */
    it('Property: Shelving with no changes should fail', () => {
      fc.assert(
        fc.property(shelfNameArb, (name) => {
          // Setup: Empty working directory
          const shelfService = new MockShelfService([]);

          // Act & Assert: Shelving should throw
          assert.throws(
            () => shelfService.shelve(name),
            /No changes to shelve/,
            'Should throw when shelving with no changes'
          );

          // Assert: No shelf item was created
          assert.strictEqual(
            shelfService.getShelfItems().length,
            0,
            'No shelf item should be created'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Unshelving non-existent shelf item should fail.
     */
    it('Property: Unshelving non-existent shelf item should fail', () => {
      fc.assert(
        fc.property(
          shelfFilesArb,
          shelfNameArb,
          fc.string({ minLength: 10, maxLength: 30 }),
          (files, name, invalidId) => {
            // Setup
            const shelfService = new MockShelfService(files);
            shelfService.shelve(name);

            // Use an ID that doesn't exist
            const nonExistentId = `shelf-nonexistent-${invalidId}`;

            // Act & Assert: Unshelving non-existent item should throw
            assert.throws(
              () => shelfService.unshelve(nonExistentId),
              /Shelf item not found/,
              'Should throw when unshelving non-existent item'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Deleting a shelf item removes it from the list.
     */
    it('Property: Deleting a shelf item removes it from the list', () => {
      fc.assert(
        fc.property(shelfFilesArb, shelfNameArb, (files, name) => {
          // Setup
          const shelfService = new MockShelfService(files);

          // Act: Shelve the changes
          const shelfItem = shelfService.shelve(name);
          const shelfId = shelfItem.id;

          // Assert: Shelf item exists
          assert.ok(shelfService.shelfItemExists(shelfId), 'Shelf item should exist');
          assert.strictEqual(shelfService.getShelfItems().length, 1, 'Should have one shelf item');

          // Act: Delete the shelf item
          shelfService.deleteShelfItem(shelfId);

          // Assert: Shelf item is removed
          assert.ok(!shelfService.shelfItemExists(shelfId), 'Shelf item should be removed');
          assert.strictEqual(shelfService.getShelfItems().length, 0, 'Shelf should be empty');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Deleting non-existent shelf item should fail.
     */
    it('Property: Deleting non-existent shelf item should fail', () => {
      fc.assert(
        fc.property(
          shelfFilesArb,
          shelfNameArb,
          fc.string({ minLength: 10, maxLength: 30 }),
          (files, name, invalidId) => {
            // Setup
            const shelfService = new MockShelfService(files);
            shelfService.shelve(name);

            // Use an ID that doesn't exist
            const nonExistentId = `shelf-nonexistent-${invalidId}`;

            // Act & Assert: Deleting non-existent item should throw
            assert.throws(
              () => shelfService.deleteShelfItem(nonExistentId),
              /Shelf item not found/,
              'Should throw when deleting non-existent item'
            );

            // Assert: Original shelf item is still present
            assert.strictEqual(
              shelfService.getShelfItems().length,
              1,
              'Original shelf item should still exist'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Unshelve default behavior removes from shelf.
     */
    it('Property: Unshelve default behavior removes from shelf', () => {
      fc.assert(
        fc.property(shelfFilesArb, shelfNameArb, (files, name) => {
          // Setup
          const shelfService = new MockShelfService(files);

          // Act: Shelve the changes
          const shelfItem = shelfService.shelve(name);
          const shelfId = shelfItem.id;

          // Assert: Shelf item exists
          assert.ok(shelfService.shelfItemExists(shelfId), 'Shelf item should exist');

          // Act: Unshelve without specifying options (default should remove)
          const result = shelfService.unshelve(shelfId);

          // Assert: Unshelve succeeded
          assert.ok(result.success, 'Unshelve should succeed');

          // Assert: Shelf item is removed (default behavior)
          assert.ok(
            !shelfService.shelfItemExists(shelfId),
            'Shelf item should be removed by default'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Shelf item IDs are unique.
     */
    it('Property: Shelf item IDs are unique', () => {
      fc.assert(
        fc.property(
          fc.array(shelfFilesArb, { minLength: 2, maxLength: 10 }),
          fc.array(shelfNameArb, { minLength: 2, maxLength: 10 }),
          (filesArray, namesArray) => {
            // Setup
            const shelfService = new MockShelfService();
            const shelfIds = new Set<string>();

            // Act: Create multiple shelf items
            const count = Math.min(filesArray.length, namesArray.length);
            for (let i = 0; i < count; i++) {
              shelfService.setWorkingDirectoryChanges(filesArray[i]);
              const shelfItem = shelfService.shelve(namesArray[i]);

              // Assert: ID is unique
              assert.ok(
                !shelfIds.has(shelfItem.id),
                `Shelf item ID '${shelfItem.id}' should be unique`
              );
              shelfIds.add(shelfItem.id);
            }

            // Assert: All IDs are unique
            assert.strictEqual(shelfIds.size, count, 'All shelf item IDs should be unique');
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
