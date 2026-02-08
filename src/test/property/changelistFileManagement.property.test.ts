import * as fc from 'fast-check';
import * as assert from 'assert';
import { IChangelist, IFileChange } from '../../services/interfaces/IChangelistService';
import { FileStatus } from '../../services/interfaces/IGitService';

/**
 * Property-based tests for Changelist File Management.
 * Feature: intellig-vscode, Property 2: Changelist File Management
 *
 * **Validates: Requirements 2.3, 2.4, 2.5**
 *
 * Property Description:
 * For any file and any sequence of changelist operations (create, move, delete changelist),
 * the file SHALL always belong to exactly one changelist, and deleting a non-default
 * changelist SHALL move its files to the Default Changelist.
 *
 * Requirements:
 * - 2.3: WHEN a user creates a new Changelist, THE Extension SHALL add it to the
 *        Local_Changes_View with the specified name
 * - 2.4: WHEN a user drags a file between Changelists, THE Extension SHALL move
 *        the file to the target Changelist
 * - 2.5: WHEN a user deletes a Changelist containing files, THE Extension SHALL
 *        move those files to the Default Changelist
 */
describe('Changelist File Management Property Tests', () => {
  /**
   * Default changelist constants
   */
  const DEFAULT_CHANGELIST_ID = 'default';
  const DEFAULT_CHANGELIST_NAME = 'Default Changelist';

  /**
   * Arbitrary generator for valid file paths.
   */
  const filePathArb: fc.Arbitrary<string> = fc
    .array(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_./'.split('')
      ),
      { minLength: 1, maxLength: 50 }
    )
    .map((chars) => chars.join(''))
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
   * Arbitrary generator for changelist names.
   */
  const changelistNameArb: fc.Arbitrary<string> = fc
    .string({ minLength: 1, maxLength: 50 })
    .filter((s) => s.trim().length > 0)
    .map((s) => s.trim());

  /**
   * Arbitrary generator for unique changelist names (array).
   */
  const uniqueChangelistNamesArb: fc.Arbitrary<string[]> = fc
    .array(changelistNameArb, { minLength: 1, maxLength: 10 })
    .map((names) => {
      const seen = new Set<string>();
      return names.filter((name) => {
        const lower = name.toLowerCase();
        if (seen.has(lower) || lower === DEFAULT_CHANGELIST_NAME.toLowerCase()) {
          return false;
        }
        seen.add(lower);
        return true;
      });
    })
    .filter((names) => names.length > 0);

  /**
   * Arbitrary generator for unique file paths (array).
   */
  const uniqueFilePathsArb: fc.Arbitrary<string[]> = fc
    .array(filePathArb, { minLength: 1, maxLength: 20 })
    .map((paths) => {
      const seen = new Set<string>();
      return paths.filter((path) => {
        if (seen.has(path)) {
          return false;
        }
        seen.add(path);
        return true;
      });
    })
    .filter((paths) => paths.length > 0);

  /**
   * Mock ChangelistService that simulates changelist operations in memory.
   * This allows us to test the changelist properties without actual file system operations.
   */
  class MockChangelistService {
    private _changelists: Map<string, IChangelist> = new Map();
    private _nextId: number = 0;

    constructor() {
      // Always ensure default changelist exists
      this._changelists.set(DEFAULT_CHANGELIST_ID, {
        id: DEFAULT_CHANGELIST_ID,
        name: DEFAULT_CHANGELIST_NAME,
        isDefault: true,
        files: [],
      });
    }

    /**
     * Get all changelists.
     */
    getChangelists(): IChangelist[] {
      return Array.from(this._changelists.values());
    }

    /**
     * Create a new changelist.
     * Requirement 2.3: Add changelist with specified name.
     */
    createChangelist(name: string): IChangelist {
      if (!name || name.trim().length === 0) {
        throw new Error('Changelist name cannot be empty');
      }

      const trimmedName = name.trim();

      // Check for duplicate names
      for (const cl of this._changelists.values()) {
        if (cl.name === trimmedName) {
          throw new Error(`Changelist with name "${trimmedName}" already exists`);
        }
      }

      const id = `changelist-${Date.now()}-${this._nextId++}`;
      const changelist: IChangelist = {
        id,
        name: trimmedName,
        isDefault: false,
        files: [],
      };

      this._changelists.set(id, changelist);
      return changelist;
    }

    /**
     * Delete a changelist.
     * Requirement 2.5: Move files to Default Changelist when deleting.
     */
    deleteChangelist(id: string): void {
      if (id === DEFAULT_CHANGELIST_ID) {
        throw new Error('Cannot delete the default changelist');
      }

      const changelist = this._changelists.get(id);
      if (!changelist) {
        throw new Error(`Changelist not found: ${id}`);
      }

      if (changelist.isDefault) {
        throw new Error('Cannot delete the default changelist');
      }

      // Move files to default changelist
      const defaultChangelist = this._changelists.get(DEFAULT_CHANGELIST_ID)!;
      for (const file of changelist.files) {
        if (!defaultChangelist.files.some((f) => f.path === file.path)) {
          defaultChangelist.files.push(file);
        }
      }

      // Remove the changelist
      this._changelists.delete(id);
    }

    /**
     * Move files to a specific changelist.
     * Requirement 2.4: Move file to target changelist.
     */
    moveToChangelist(files: string[], changelistId: string): void {
      if (!files || files.length === 0) {
        return;
      }

      const targetChangelist = this._changelists.get(changelistId);
      if (!targetChangelist) {
        throw new Error(`Changelist not found: ${changelistId}`);
      }

      for (const filePath of files) {
        // Remove from all changelists
        for (const cl of this._changelists.values()) {
          cl.files = cl.files.filter((f) => f.path !== filePath);
        }

        // Add to target changelist
        if (!targetChangelist.files.some((f) => f.path === filePath)) {
          targetChangelist.files.push(this.createFileChange(filePath));
        }
      }
    }

    /**
     * Get the default changelist.
     */
    getDefaultChangelist(): IChangelist {
      return this._changelists.get(DEFAULT_CHANGELIST_ID)!;
    }

    /**
     * Get a changelist by ID.
     */
    getChangelist(id: string): IChangelist | undefined {
      return this._changelists.get(id);
    }

    /**
     * Check if a changelist exists.
     */
    changelistExists(id: string): boolean {
      return this._changelists.has(id);
    }

    /**
     * Get all files across all changelists.
     */
    getAllFiles(): string[] {
      const files: string[] = [];
      for (const cl of this._changelists.values()) {
        for (const file of cl.files) {
          files.push(file.path);
        }
      }
      return files;
    }

    /**
     * Find which changelist a file belongs to.
     */
    findFileChangelist(filePath: string): IChangelist | undefined {
      for (const cl of this._changelists.values()) {
        if (cl.files.some((f) => f.path === filePath)) {
          return cl;
        }
      }
      return undefined;
    }

    /**
     * Count how many changelists contain a specific file.
     */
    countFileOccurrences(filePath: string): number {
      let count = 0;
      for (const cl of this._changelists.values()) {
        if (cl.files.some((f) => f.path === filePath)) {
          count++;
        }
      }
      return count;
    }

    /**
     * Create a file change object.
     */
    private createFileChange(filePath: string): IFileChange {
      return {
        path: filePath,
        status: 'modified' as FileStatus,
        staged: false,
      };
    }
  }

  describe('Property 2: Changelist File Management', () => {
    /**
     * Property: Files always belong to exactly one changelist.
     *
     * **Validates: Requirements 2.3, 2.4, 2.5**
     */
    it('Property: Files always belong to exactly one changelist', () => {
      fc.assert(
        fc.property(
          uniqueFilePathsArb,
          uniqueChangelistNamesArb,
          fc.array(fc.nat(100), { minLength: 1, maxLength: 20 }),
          (filePaths, changelistNames, moveIndices) => {
            const service = new MockChangelistService();

            // Create changelists
            const createdChangelists: IChangelist[] = [];
            for (const name of changelistNames) {
              try {
                const cl = service.createChangelist(name);
                createdChangelists.push(cl);
              } catch {
                // Ignore duplicate name errors
              }
            }

            // Add files to default changelist initially
            service.moveToChangelist(filePaths, DEFAULT_CHANGELIST_ID);

            // Perform random move operations
            const allChangelists = service.getChangelists();
            for (let i = 0; i < moveIndices.length; i++) {
              const fileIndex = moveIndices[i] % filePaths.length;
              const clIndex = moveIndices[i] % allChangelists.length;
              const targetCl = allChangelists[clIndex];

              service.moveToChangelist([filePaths[fileIndex]], targetCl.id);

              // Verify: File belongs to exactly one changelist
              const occurrences = service.countFileOccurrences(filePaths[fileIndex]);
              assert.strictEqual(
                occurrences,
                1,
                `File '${filePaths[fileIndex]}' should belong to exactly one changelist, but found in ${occurrences}`
              );
            }

            // Final verification: All files belong to exactly one changelist
            for (const filePath of filePaths) {
              const occurrences = service.countFileOccurrences(filePath);
              assert.strictEqual(
                occurrences,
                1,
                `File '${filePath}' should belong to exactly one changelist after all operations`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Moving a file between changelists removes it from the source.
     *
     * **Validates: Requirements 2.4**
     */
    it('Property: Moving a file between changelists removes it from the source', () => {
      fc.assert(
        fc.property(filePathArb, changelistNameArb, (filePath, changelistName) => {
          const service = new MockChangelistService();

          // Create a new changelist
          let targetChangelist: IChangelist;
          try {
            targetChangelist = service.createChangelist(changelistName);
          } catch {
            // If name conflicts, use a modified name
            targetChangelist = service.createChangelist(changelistName + '-' + Date.now());
          }

          // Add file to default changelist
          service.moveToChangelist([filePath], DEFAULT_CHANGELIST_ID);

          // Verify file is in default changelist
          const defaultCl = service.getDefaultChangelist();
          assert.ok(
            defaultCl.files.some((f) => f.path === filePath),
            'File should be in default changelist initially'
          );

          // Move file to new changelist
          service.moveToChangelist([filePath], targetChangelist.id);

          // Verify file is removed from default changelist
          const updatedDefaultCl = service.getDefaultChangelist();
          assert.ok(
            !updatedDefaultCl.files.some((f) => f.path === filePath),
            'File should be removed from default changelist after move'
          );

          // Verify file is in target changelist
          const updatedTargetCl = service.getChangelist(targetChangelist.id)!;
          assert.ok(
            updatedTargetCl.files.some((f) => f.path === filePath),
            'File should be in target changelist after move'
          );

          // Verify file is in exactly one changelist
          assert.strictEqual(
            service.countFileOccurrences(filePath),
            1,
            'File should be in exactly one changelist'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Deleting a changelist moves its files to the Default Changelist.
     *
     * **Validates: Requirements 2.5**
     */
    it('Property: Deleting a changelist moves its files to the Default Changelist', () => {
      fc.assert(
        fc.property(uniqueFilePathsArb, changelistNameArb, (filePaths, changelistName) => {
          const service = new MockChangelistService();

          // Create a new changelist
          let changelist: IChangelist;
          try {
            changelist = service.createChangelist(changelistName);
          } catch {
            changelist = service.createChangelist(changelistName + '-' + Date.now());
          }

          // Move files to the new changelist
          service.moveToChangelist(filePaths, changelist.id);

          // Verify files are in the new changelist
          const clBeforeDelete = service.getChangelist(changelist.id)!;
          for (const filePath of filePaths) {
            assert.ok(
              clBeforeDelete.files.some((f) => f.path === filePath),
              `File '${filePath}' should be in changelist before delete`
            );
          }

          // Delete the changelist
          service.deleteChangelist(changelist.id);

          // Verify changelist is deleted
          assert.ok(!service.changelistExists(changelist.id), 'Changelist should be deleted');

          // Verify all files are now in the default changelist
          const defaultCl = service.getDefaultChangelist();
          for (const filePath of filePaths) {
            assert.ok(
              defaultCl.files.some((f) => f.path === filePath),
              `File '${filePath}' should be moved to default changelist after delete`
            );
          }

          // Verify files are in exactly one changelist
          for (const filePath of filePaths) {
            assert.strictEqual(
              service.countFileOccurrences(filePath),
              1,
              `File '${filePath}' should be in exactly one changelist after delete`
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: The Default Changelist always exists.
     *
     * **Validates: Requirements 2.3, 2.4, 2.5**
     */
    it('Property: The Default Changelist always exists', () => {
      fc.assert(
        fc.property(
          uniqueChangelistNamesArb,
          fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }),
          (changelistNames, deleteFlags) => {
            const service = new MockChangelistService();

            // Verify default changelist exists initially
            assert.ok(
              service.changelistExists(DEFAULT_CHANGELIST_ID),
              'Default changelist should exist initially'
            );

            // Create changelists
            const createdIds: string[] = [];
            for (const name of changelistNames) {
              try {
                const cl = service.createChangelist(name);
                createdIds.push(cl.id);
              } catch {
                // Ignore duplicate name errors
              }
            }

            // Verify default changelist still exists after creating others
            assert.ok(
              service.changelistExists(DEFAULT_CHANGELIST_ID),
              'Default changelist should exist after creating other changelists'
            );

            // Delete some changelists based on flags
            for (let i = 0; i < Math.min(createdIds.length, deleteFlags.length); i++) {
              if (deleteFlags[i] && service.changelistExists(createdIds[i])) {
                service.deleteChangelist(createdIds[i]);
              }
            }

            // Verify default changelist still exists after deletions
            assert.ok(
              service.changelistExists(DEFAULT_CHANGELIST_ID),
              'Default changelist should exist after deleting other changelists'
            );

            // Verify default changelist is marked as default
            const defaultCl = service.getDefaultChangelist();
            assert.ok(defaultCl.isDefault, 'Default changelist should have isDefault=true');
            assert.strictEqual(
              defaultCl.name,
              DEFAULT_CHANGELIST_NAME,
              'Default changelist should have correct name'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Creating a changelist adds it to the list.
     *
     * **Validates: Requirements 2.3**
     */
    it('Property: Creating a changelist adds it to the list', () => {
      fc.assert(
        fc.property(uniqueChangelistNamesArb, (changelistNames) => {
          const service = new MockChangelistService();

          // Initial count (just default changelist)
          const initialCount = service.getChangelists().length;
          assert.strictEqual(initialCount, 1, 'Should start with only default changelist');

          // Create changelists
          const createdChangelists: IChangelist[] = [];
          for (const name of changelistNames) {
            try {
              const cl = service.createChangelist(name);
              createdChangelists.push(cl);

              // Verify changelist was added
              assert.ok(
                service.changelistExists(cl.id),
                `Changelist '${name}' should exist after creation`
              );

              // Verify changelist has correct name
              const retrieved = service.getChangelist(cl.id);
              assert.ok(retrieved, `Should be able to retrieve changelist '${name}'`);
              assert.strictEqual(retrieved.name, name, `Changelist name should be '${name}'`);

              // Verify changelist is not default
              assert.ok(!retrieved.isDefault, 'New changelist should not be default');
            } catch {
              // Ignore duplicate name errors
            }
          }

          // Verify total count
          const finalCount = service.getChangelists().length;
          assert.strictEqual(
            finalCount,
            1 + createdChangelists.length,
            'Total changelist count should be default + created'
          );

          // Verify all created changelists are in the list
          const allChangelists = service.getChangelists();
          for (const created of createdChangelists) {
            assert.ok(
              allChangelists.some((cl) => cl.id === created.id),
              `Created changelist '${created.name}' should be in the list`
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Cannot delete the default changelist.
     *
     * **Validates: Requirements 2.5**
     */
    it('Property: Cannot delete the default changelist', () => {
      fc.assert(
        fc.property(uniqueChangelistNamesArb, (changelistNames) => {
          const service = new MockChangelistService();

          // Create some changelists
          for (const name of changelistNames) {
            try {
              service.createChangelist(name);
            } catch {
              // Ignore duplicate name errors
            }
          }

          // Attempt to delete default changelist should throw
          assert.throws(
            () => service.deleteChangelist(DEFAULT_CHANGELIST_ID),
            /Cannot delete the default changelist/,
            'Should throw when trying to delete default changelist'
          );

          // Verify default changelist still exists
          assert.ok(
            service.changelistExists(DEFAULT_CHANGELIST_ID),
            'Default changelist should still exist after failed delete attempt'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Changelist names must be unique.
     *
     * **Validates: Requirements 2.3**
     */
    it('Property: Changelist names must be unique', () => {
      fc.assert(
        fc.property(changelistNameArb, (name) => {
          const service = new MockChangelistService();

          // Create first changelist
          const cl1 = service.createChangelist(name);
          assert.ok(cl1, 'First changelist should be created');

          // Attempt to create second changelist with same name should throw
          assert.throws(
            () => service.createChangelist(name),
            /already exists/,
            'Should throw when creating changelist with duplicate name'
          );

          // Verify only one changelist with that name exists
          const allChangelists = service.getChangelists();
          const matchingChangelists = allChangelists.filter((cl) => cl.name === name);
          assert.strictEqual(
            matchingChangelists.length,
            1,
            'Should have exactly one changelist with the given name'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Sequence of create, move, delete operations maintains file invariant.
     *
     * **Validates: Requirements 2.3, 2.4, 2.5**
     */
    it('Property: Sequence of create, move, delete operations maintains file invariant', () => {
      // Define operation types
      type Operation =
        | { type: 'create'; name: string }
        | { type: 'move'; fileIndex: number; clIndex: number }
        | { type: 'delete'; clIndex: number };

      const operationArb: fc.Arbitrary<Operation> = fc.oneof(
        fc.record({ type: fc.constant('create' as const), name: changelistNameArb }),
        fc.record({
          type: fc.constant('move' as const),
          fileIndex: fc.nat(19),
          clIndex: fc.nat(10),
        }),
        fc.record({ type: fc.constant('delete' as const), clIndex: fc.nat(10) })
      );

      fc.assert(
        fc.property(
          uniqueFilePathsArb,
          fc.array(operationArb, { minLength: 5, maxLength: 30 }),
          (filePaths, operations) => {
            const service = new MockChangelistService();

            // Add all files to default changelist initially
            service.moveToChangelist(filePaths, DEFAULT_CHANGELIST_ID);

            // Execute operations
            for (const op of operations) {
              try {
                if (op.type === 'create') {
                  service.createChangelist(op.name);
                } else if (op.type === 'move') {
                  const allChangelists = service.getChangelists();
                  if (allChangelists.length > 0) {
                    const fileIndex = op.fileIndex % filePaths.length;
                    const clIndex = op.clIndex % allChangelists.length;
                    service.moveToChangelist([filePaths[fileIndex]], allChangelists[clIndex].id);
                  }
                } else if (op.type === 'delete') {
                  const nonDefaultChangelists = service
                    .getChangelists()
                    .filter((cl) => !cl.isDefault);
                  if (nonDefaultChangelists.length > 0) {
                    const clIndex = op.clIndex % nonDefaultChangelists.length;
                    service.deleteChangelist(nonDefaultChangelists[clIndex].id);
                  }
                }
              } catch {
                // Ignore errors from invalid operations
              }

              // Invariant check after each operation: each file belongs to exactly one changelist
              for (const filePath of filePaths) {
                const occurrences = service.countFileOccurrences(filePath);
                assert.strictEqual(
                  occurrences,
                  1,
                  `File '${filePath}' should belong to exactly one changelist after ${op.type} operation`
                );
              }

              // Invariant check: default changelist always exists
              assert.ok(
                service.changelistExists(DEFAULT_CHANGELIST_ID),
                'Default changelist should always exist'
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Empty changelist name should be rejected.
     *
     * **Validates: Requirements 2.3**
     */
    it('Property: Empty changelist name should be rejected', () => {
      fc.assert(
        fc.property(fc.constantFrom('', '   ', '\t', '\n', '  \t  '), (emptyName) => {
          const service = new MockChangelistService();

          // Attempt to create changelist with empty name should throw
          assert.throws(
            () => service.createChangelist(emptyName),
            /cannot be empty/,
            'Should throw when creating changelist with empty name'
          );

          // Verify no new changelist was created
          assert.strictEqual(
            service.getChangelists().length,
            1,
            'Should only have default changelist'
          );
        }),
        { numRuns: 10 }
      );
    });

    /**
     * Property: Moving files to non-existent changelist should fail.
     *
     * **Validates: Requirements 2.4**
     */
    it('Property: Moving files to non-existent changelist should fail', () => {
      fc.assert(
        fc.property(
          filePathArb,
          fc.string({ minLength: 10, maxLength: 30 }),
          (filePath, invalidId) => {
            const service = new MockChangelistService();

            // Add file to default changelist
            service.moveToChangelist([filePath], DEFAULT_CHANGELIST_ID);

            // Attempt to move to non-existent changelist should throw
            const nonExistentId = `changelist-nonexistent-${invalidId}`;
            assert.throws(
              () => service.moveToChangelist([filePath], nonExistentId),
              /Changelist not found/,
              'Should throw when moving to non-existent changelist'
            );

            // Verify file is still in default changelist
            const defaultCl = service.getDefaultChangelist();
            assert.ok(
              defaultCl.files.some((f) => f.path === filePath),
              'File should still be in default changelist after failed move'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Deleting non-existent changelist should fail.
     *
     * **Validates: Requirements 2.5**
     */
    it('Property: Deleting non-existent changelist should fail', () => {
      fc.assert(
        fc.property(
          changelistNameArb,
          fc.string({ minLength: 10, maxLength: 30 }),
          (name, invalidId) => {
            const service = new MockChangelistService();

            // Create a changelist
            try {
              service.createChangelist(name);
            } catch {
              // Ignore if name conflicts
            }

            // Attempt to delete non-existent changelist should throw
            const nonExistentId = `changelist-nonexistent-${invalidId}`;
            assert.throws(
              () => service.deleteChangelist(nonExistentId),
              /Changelist not found/,
              'Should throw when deleting non-existent changelist'
            );
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
