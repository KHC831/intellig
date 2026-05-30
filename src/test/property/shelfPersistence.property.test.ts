import * as fc from 'fast-check';
import * as assert from 'assert';
import { IShelfItem, IShelfFile } from '../../shelf/interfaces/IShelfService';

/**
 * Property-based tests for Shelf Persistence.
 * Feature: intellig-vscode, Property 22: Shelf Persistence
 *
 *
 * Property Description:
 * For any shelved changes, closing and reopening VS Code SHALL preserve the shelf items
 * with their names, timestamps, and content intact.
 *
 * - 8.8: THE Extension SHALL persist shelf data across VS Code sessions
 */
describe('Shelf Persistence Property Tests', () => {
  /**
   * Arbitrary generator for valid file paths.
   * File paths should be non-empty and contain valid characters.
   */
  const filePathArb: fc.Arbitrary<string> = fc
    .stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9_\-./]{0,48}[a-zA-Z0-9]$/)
    .filter((s) => {
      // Filter out invalid paths
      if (s.length < 2) {
        return false;
      }
      if (s.includes('//')) {
        return false;
      }
      return true;
    });

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
   * Arbitrary generator for timestamps (within reasonable range).
   */
  const timestampArb: fc.Arbitrary<number> = fc.integer({
    min: Date.now() - 365 * 24 * 60 * 60 * 1000, // 1 year ago
    max: Date.now(),
  });

  /**
   * Shelf storage file format version.
   */
  const SHELF_STORAGE_VERSION = 1;

  /**
   * Shelf storage model for JSON persistence.
   */
  interface IShelfStorage {
    version: number;
    items: IShelfStorageItem[];
  }

  /**
   * Shelf storage item model.
   */
  interface IShelfStorageItem {
    id: string;
    name: string;
    timestamp: number;
    files: IShelfStorageFile[];
  }

  /**
   * Shelf storage file model.
   */
  interface IShelfStorageFile {
    path: string;
    originalContent: string;
    patchContent: string;
  }

  /**
   * Mock ShelfService that simulates shelf persistence across VS Code sessions.
   * This allows us to test the shelf persistence properties without actual file system operations.
   */
  class MockPersistentShelfService {
    private _shelfItems: Map<string, IShelfItem> = new Map();
    private _persistedStorage: string | null = null; // Simulates the JSON file content
    private _nextShelfId: number = 0;

    /**
     * Shelve changes and persist to storage.
     *
     * @param name - Name for the shelf item
     * @param files - Files to shelve
     * @param timestamp - Optional timestamp (defaults to now)
     * @returns The created shelf item
     */
    shelve(name: string, files: IShelfFile[], timestamp?: Date): IShelfItem {
      if (files.length === 0) {
        throw new Error('No changes to shelve');
      }

      // Generate unique ID
      const id = `shelf-${Date.now()}-${this._nextShelfId++}`;

      // Create the shelf item
      const shelfItem: IShelfItem = {
        id,
        name,
        timestamp: timestamp || new Date(),
        files: [...files],
      };

      // Save to in-memory storage
      this._shelfItems.set(id, shelfItem);

      // Persist to storage
      this.persistToStorage();

      return shelfItem;
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
      this.persistToStorage();
    }

    /**
     * Simulate VS Code restart by clearing in-memory state and reloading from persisted storage.
     * This tests that shelf data persists across sessions.
     */
    simulateRestart(): void {
      // Clear in-memory state (simulating VS Code closing)
      this._shelfItems.clear();

      // Reload from persisted storage (simulating VS Code reopening)
      if (this._persistedStorage) {
        this.loadFromStorage();
      }
    }

    /**
     * Get the raw persisted storage content (for testing).
     */
    getPersistedStorageContent(): string | null {
      return this._persistedStorage;
    }

    /**
     * Persist current shelf items to storage (simulates writing to JSON file).
     */
    private persistToStorage(): void {
      const storage: IShelfStorage = {
        version: SHELF_STORAGE_VERSION,
        items: Array.from(this._shelfItems.values()).map((item) => ({
          id: item.id,
          name: item.name,
          timestamp: item.timestamp.getTime(),
          files: item.files.map((file) => ({
            path: file.path,
            originalContent: '',
            patchContent: file.diff,
          })),
        })),
      };

      this._persistedStorage = JSON.stringify(storage, null, 2);
    }

    /**
     * Load shelf items from persisted storage (simulates reading from JSON file).
     */
    private loadFromStorage(): void {
      if (!this._persistedStorage) {
        return;
      }

      try {
        const storage = JSON.parse(this._persistedStorage) as IShelfStorage;

        // Validate version
        if (storage.version !== SHELF_STORAGE_VERSION) {
          console.warn(
            `Shelf storage version mismatch: expected ${SHELF_STORAGE_VERSION}, got ${storage.version}`
          );
        }

        // Convert storage items to shelf items
        for (const storageItem of storage.items) {
          const shelfItem: IShelfItem = {
            id: storageItem.id,
            name: storageItem.name,
            timestamp: new Date(storageItem.timestamp),
            files: storageItem.files.map((file) => ({
              path: file.path,
              diff: file.patchContent,
            })),
          };
          this._shelfItems.set(shelfItem.id, shelfItem);
        }
      } catch (error) {
        console.error('Failed to load shelf storage:', error);
      }
    }
  }

  /**
   * Compare two shelf items for equality (excluding ID which may differ).
   */
  function shelfItemsContentEqual(a: IShelfItem, b: IShelfItem): boolean {
    if (a.name !== b.name) {
      return false;
    }
    if (a.timestamp.getTime() !== b.timestamp.getTime()) {
      return false;
    }
    if (a.files.length !== b.files.length) {
      return false;
    }

    // Sort files by path for comparison
    const sortedA = [...a.files].sort((x, y) => x.path.localeCompare(y.path));
    const sortedB = [...b.files].sort((x, y) => x.path.localeCompare(y.path));

    for (let i = 0; i < sortedA.length; i++) {
      if (sortedA[i].path !== sortedB[i].path || sortedA[i].diff !== sortedB[i].diff) {
        return false;
      }
    }
    return true;
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

  describe('Property 22: Shelf Persistence', () => {
    /**
     * Property: Shelf items persist across service instances (simulating VS Code restart).
     */
    it('Property: Shelf items persist across service instances (simulating VS Code restart)', () => {
      fc.assert(
        fc.property(shelfFilesArb, shelfNameArb, (files, name) => {
          // Setup
          const shelfService = new MockPersistentShelfService();

          // Act: Shelve the changes
          const originalShelfItem = shelfService.shelve(name, files);

          // Assert: Shelf item exists before restart
          assert.strictEqual(
            shelfService.getShelfItems().length,
            1,
            'Should have one shelf item before restart'
          );

          // Act: Simulate VS Code restart
          shelfService.simulateRestart();

          // Assert: Shelf item persists after restart
          const itemsAfterRestart = shelfService.getShelfItems();
          assert.strictEqual(
            itemsAfterRestart.length,
            1,
            'Should have one shelf item after restart'
          );

          // Assert: The shelf item content is preserved
          const restoredItem = itemsAfterRestart[0];
          assert.ok(
            shelfItemsContentEqual(originalShelfItem, restoredItem),
            'Shelf item content should be preserved after restart'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Shelf item names are preserved after persistence.
     */
    it('Property: Shelf item names are preserved after persistence', () => {
      fc.assert(
        fc.property(shelfFilesArb, shelfNameArb, (files, name) => {
          // Setup
          const shelfService = new MockPersistentShelfService();

          // Act: Shelve the changes
          shelfService.shelve(name, files);

          // Act: Simulate VS Code restart
          shelfService.simulateRestart();

          // Assert: Shelf item name is preserved
          const itemsAfterRestart = shelfService.getShelfItems();
          assert.strictEqual(
            itemsAfterRestart.length,
            1,
            'Should have one shelf item after restart'
          );
          assert.strictEqual(
            itemsAfterRestart[0].name,
            name,
            'Shelf item name should be preserved after restart'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Shelf item timestamps are preserved after persistence.
     */
    it('Property: Shelf item timestamps are preserved after persistence', () => {
      fc.assert(
        fc.property(shelfFilesArb, shelfNameArb, timestampArb, (files, name, timestamp) => {
          // Setup
          const shelfService = new MockPersistentShelfService();
          const originalTimestamp = new Date(timestamp);

          // Act: Shelve the changes with a specific timestamp
          shelfService.shelve(name, files, originalTimestamp);

          // Act: Simulate VS Code restart
          shelfService.simulateRestart();

          // Assert: Shelf item timestamp is preserved
          const itemsAfterRestart = shelfService.getShelfItems();
          assert.strictEqual(
            itemsAfterRestart.length,
            1,
            'Should have one shelf item after restart'
          );
          assert.strictEqual(
            itemsAfterRestart[0].timestamp.getTime(),
            originalTimestamp.getTime(),
            'Shelf item timestamp should be preserved after restart'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Shelf item content (files and diffs) are preserved after persistence.
     */
    it('Property: Shelf item content (files and diffs) are preserved after persistence', () => {
      fc.assert(
        fc.property(shelfFilesArb, shelfNameArb, (files, name) => {
          // Setup
          const shelfService = new MockPersistentShelfService();

          // Act: Shelve the changes
          const originalShelfItem = shelfService.shelve(name, files);

          // Act: Simulate VS Code restart
          shelfService.simulateRestart();

          // Assert: Shelf item files are preserved
          const itemsAfterRestart = shelfService.getShelfItems();
          assert.strictEqual(
            itemsAfterRestart.length,
            1,
            'Should have one shelf item after restart'
          );
          assert.ok(
            shelfFilesEqual(originalShelfItem.files, itemsAfterRestart[0].files),
            'Shelf item files should be preserved after restart'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Multiple shelf items persist across service instances.
     */
    it('Property: Multiple shelf items persist across service instances', () => {
      fc.assert(
        fc.property(
          fc.array(shelfFilesArb, { minLength: 2, maxLength: 5 }),
          fc.array(shelfNameArb, { minLength: 2, maxLength: 5 }),
          (filesArray, namesArray) => {
            // Setup
            const shelfService = new MockPersistentShelfService();
            const originalItems: IShelfItem[] = [];

            // Act: Create multiple shelf items
            const count = Math.min(filesArray.length, namesArray.length);
            for (let i = 0; i < count; i++) {
              const item = shelfService.shelve(namesArray[i], filesArray[i]);
              originalItems.push(item);
            }

            // Assert: All shelf items exist before restart
            assert.strictEqual(
              shelfService.getShelfItems().length,
              count,
              'Should have all shelf items before restart'
            );

            // Act: Simulate VS Code restart
            shelfService.simulateRestart();

            // Assert: All shelf items persist after restart
            const itemsAfterRestart = shelfService.getShelfItems();
            assert.strictEqual(
              itemsAfterRestart.length,
              count,
              'Should have all shelf items after restart'
            );

            // Assert: Each original item has a matching item after restart
            for (const originalItem of originalItems) {
              const matchingItem = itemsAfterRestart.find((item) => item.id === originalItem.id);
              assert.ok(
                matchingItem,
                `Shelf item with ID '${originalItem.id}' should exist after restart`
              );
              assert.ok(
                shelfItemsContentEqual(originalItem, matchingItem),
                `Shelf item '${originalItem.name}' content should be preserved after restart`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Shelf item IDs are preserved after persistence.
     */
    it('Property: Shelf item IDs are preserved after persistence', () => {
      fc.assert(
        fc.property(shelfFilesArb, shelfNameArb, (files, name) => {
          // Setup
          const shelfService = new MockPersistentShelfService();

          // Act: Shelve the changes
          const originalShelfItem = shelfService.shelve(name, files);
          const originalId = originalShelfItem.id;

          // Act: Simulate VS Code restart
          shelfService.simulateRestart();

          // Assert: Shelf item ID is preserved
          const itemsAfterRestart = shelfService.getShelfItems();
          assert.strictEqual(
            itemsAfterRestart.length,
            1,
            'Should have one shelf item after restart'
          );
          assert.strictEqual(
            itemsAfterRestart[0].id,
            originalId,
            'Shelf item ID should be preserved after restart'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Deleted shelf items do not persist after restart.
     */
    it('Property: Deleted shelf items do not persist after restart', () => {
      fc.assert(
        fc.property(shelfFilesArb, shelfNameArb, (files, name) => {
          // Setup
          const shelfService = new MockPersistentShelfService();

          // Act: Shelve the changes
          const shelfItem = shelfService.shelve(name, files);

          // Act: Delete the shelf item
          shelfService.deleteShelfItem(shelfItem.id);

          // Assert: Shelf is empty before restart
          assert.strictEqual(
            shelfService.getShelfItems().length,
            0,
            'Shelf should be empty after deletion'
          );

          // Act: Simulate VS Code restart
          shelfService.simulateRestart();

          // Assert: Shelf is still empty after restart
          assert.strictEqual(
            shelfService.getShelfItems().length,
            0,
            'Shelf should still be empty after restart'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Persistence survives multiple restarts.
     */
    it('Property: Persistence survives multiple restarts', () => {
      fc.assert(
        fc.property(
          shelfFilesArb,
          shelfNameArb,
          fc.integer({ min: 2, max: 5 }),
          (files, name, restartCount) => {
            // Setup
            const shelfService = new MockPersistentShelfService();

            // Act: Shelve the changes
            const originalShelfItem = shelfService.shelve(name, files);

            // Act: Simulate multiple VS Code restarts
            for (let i = 0; i < restartCount; i++) {
              shelfService.simulateRestart();

              // Assert: Shelf item persists after each restart
              const itemsAfterRestart = shelfService.getShelfItems();
              assert.strictEqual(
                itemsAfterRestart.length,
                1,
                `Should have one shelf item after restart ${i + 1}`
              );
              assert.ok(
                shelfItemsContentEqual(originalShelfItem, itemsAfterRestart[0]),
                `Shelf item content should be preserved after restart ${i + 1}`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: File paths with special characters are preserved after persistence.
     */
    it('Property: File paths with special characters are preserved after persistence', () => {
      // Use a more specific arbitrary for paths with special characters
      const specialPathArb = fc.constantFrom(
        'src/file.ts',
        'path/to/deep/file.js',
        'file-with-dashes.txt',
        'file_with_underscores.py',
        'CamelCaseFile.java',
        'file.multiple.dots.ts',
        'a/b/c/d/e/f.txt'
      );

      const specialFilesArb = fc
        .array(
          fc.record({
            path: specialPathArb,
            diff: diffContentArb,
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

      fc.assert(
        fc.property(specialFilesArb, shelfNameArb, (files, name) => {
          // Setup
          const shelfService = new MockPersistentShelfService();

          // Act: Shelve the changes
          const originalShelfItem = shelfService.shelve(name, files);

          // Act: Simulate VS Code restart
          shelfService.simulateRestart();

          // Assert: File paths are preserved
          const itemsAfterRestart = shelfService.getShelfItems();
          assert.strictEqual(
            itemsAfterRestart.length,
            1,
            'Should have one shelf item after restart'
          );

          const originalPaths = new Set(originalShelfItem.files.map((f) => f.path));
          const restoredPaths = new Set(itemsAfterRestart[0].files.map((f) => f.path));

          assert.strictEqual(
            restoredPaths.size,
            originalPaths.size,
            'Number of files should be preserved'
          );

          for (const path of originalPaths) {
            assert.ok(
              restoredPaths.has(path),
              `File path '${path}' should be preserved after restart`
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Persisted storage is valid JSON.
     */
    it('Property: Persisted storage is valid JSON', () => {
      fc.assert(
        fc.property(shelfFilesArb, shelfNameArb, (files, name) => {
          // Setup
          const shelfService = new MockPersistentShelfService();

          // Act: Shelve the changes
          shelfService.shelve(name, files);

          // Assert: Persisted storage is valid JSON
          const storageContent = shelfService.getPersistedStorageContent();
          assert.ok(storageContent, 'Storage content should exist');

          // This should not throw
          const parsed = JSON.parse(storageContent) as {
            version: number;
            items: unknown[];
          };
          assert.ok(parsed, 'Storage content should be valid JSON');
          assert.strictEqual(
            parsed.version,
            SHELF_STORAGE_VERSION,
            'Storage version should be correct'
          );
          assert.ok(Array.isArray(parsed.items), 'Storage items should be an array');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Empty shelf persists correctly (no items after restart).
     */
    it('Property: Empty shelf persists correctly (no items after restart)', () => {
      fc.assert(
        fc.property(shelfFilesArb, shelfNameArb, (files, name) => {
          // Setup
          const shelfService = new MockPersistentShelfService();

          // Act: Shelve and then delete
          const shelfItem = shelfService.shelve(name, files);
          shelfService.deleteShelfItem(shelfItem.id);

          // Act: Simulate VS Code restart
          shelfService.simulateRestart();

          // Assert: Shelf is empty after restart
          assert.strictEqual(
            shelfService.getShelfItems().length,
            0,
            'Shelf should be empty after restart when all items were deleted'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Shelf items with large diff content persist correctly.
     */
    it('Property: Shelf items with large diff content persist correctly', () => {
      // Generate larger diff content
      const largeDiffContentArb: fc.Arbitrary<string> = fc
        .tuple(
          filePathArb,
          fc.array(fc.string({ minLength: 10, maxLength: 100 }), { minLength: 10, maxLength: 50 })
        )
        .map(([filePath, lines]) => {
          const header = `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n`;
          const hunkHeader = `@@ -1,${lines.length} +1,${lines.length} @@\n`;
          const diffLines = lines.map((line) => `+${line}`).join('\n');
          return header + hunkHeader + diffLines + '\n';
        });

      const largeShelfFileArb: fc.Arbitrary<IShelfFile> = fc.record({
        path: filePathArb,
        diff: largeDiffContentArb,
      });

      const largeShelfFilesArb: fc.Arbitrary<IShelfFile[]> = fc
        .array(largeShelfFileArb, { minLength: 1, maxLength: 5 })
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

      fc.assert(
        fc.property(largeShelfFilesArb, shelfNameArb, (files, name) => {
          // Setup
          const shelfService = new MockPersistentShelfService();

          // Act: Shelve the changes
          const originalShelfItem = shelfService.shelve(name, files);

          // Act: Simulate VS Code restart
          shelfService.simulateRestart();

          // Assert: Large diff content is preserved
          const itemsAfterRestart = shelfService.getShelfItems();
          assert.strictEqual(
            itemsAfterRestart.length,
            1,
            'Should have one shelf item after restart'
          );
          assert.ok(
            shelfFilesEqual(originalShelfItem.files, itemsAfterRestart[0].files),
            'Large diff content should be preserved after restart'
          );
        }),
        { numRuns: 50 } // Fewer runs due to larger data
      );
    });
  });
});
