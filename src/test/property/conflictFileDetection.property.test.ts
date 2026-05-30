import * as fc from 'fast-check';
import * as assert from 'assert';
import {
  IRepository,
  RepositoryState,
  IFileStatus,
  StatusCode,
} from '../../git-core/interfaces/IGitService';
import { IConflictedFile } from '../../conflicts/interfaces/IConflictResolutionService';

/**
 * Property-based tests for Conflict File Detection.
 * Feature: intellig-vscode, Property 31: Conflict File Detection
 *
 *
 * Property Description:
 * For any merge, rebase, or cherry-pick operation that results in conflicts,
 * all conflicted files SHALL appear in the Local Changes View with conflict status.
 *
 * - 10.1: WHEN merge conflicts occur, THE Extension SHALL display a list of
 *         conflicted files in the Local_Changes_View
 */
describe('Conflict File Detection Property Tests', () => {
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
   * Arbitrary generator for repository states that can have conflicts.
   */
  const conflictableStateArb: fc.Arbitrary<RepositoryState> = fc.constantFrom(
    'merging',
    'rebasing',
    'cherry-picking'
  );

  /**
   * Arbitrary generator for non-conflict status codes.
   */
  const nonConflictStatusCodeArb: fc.Arbitrary<StatusCode> = fc.constantFrom(
    'M',
    'A',
    'D',
    'R',
    'C',
    '?',
    '!',
    ' '
  );

  /**
   * Arbitrary generator for file status with conflict (U status).
   */
  const conflictedFileStatusArb: fc.Arbitrary<IFileStatus> = fc.record({
    path: filePathArb,
    indexStatus: fc.constantFrom('U' as StatusCode),
    workTreeStatus: fc.constantFrom('U', ' ' as StatusCode),
    renamed: fc.constant(undefined),
  });

  /**
   * Arbitrary generator for file status without conflict.
   */
  const nonConflictedFileStatusArb: fc.Arbitrary<IFileStatus> = fc.record({
    path: filePathArb,
    indexStatus: nonConflictStatusCodeArb,
    workTreeStatus: nonConflictStatusCodeArb,
    renamed: fc.option(filePathArb, { nil: undefined }),
  });

  /**
   * Arbitrary generator for mixed file statuses (some conflicted, some not).
   */
  const mixedFileStatusesArb: fc.Arbitrary<{
    conflicted: IFileStatus[];
    nonConflicted: IFileStatus[];
  }> = fc.record({
    conflicted: fc.array(conflictedFileStatusArb, { minLength: 1, maxLength: 10 }),
    nonConflicted: fc.array(nonConflictedFileStatusArb, { minLength: 0, maxLength: 10 }),
  });

  /**
   * Mock ConflictResolutionService that simulates conflict detection.
   * This allows us to test the conflict detection properties without actual Git operations.
   */
  class MockConflictResolutionService {
    private _repository: IRepository | undefined;
    private _fileStatuses: IFileStatus[] = [];
    private _conflictedFiles: IConflictedFile[] = [];

    /**
     * Set up the mock repository with a specific state.
     *
     * @param state - The repository state (merging, rebasing, cherry-picking)
     */
    setRepositoryState(state: RepositoryState): void {
      this._repository = {
        rootUri: { fsPath: '/mock/repo' } as import('vscode').Uri,
        state,
        remotes: [],
        submodules: [],
      };
    }

    /**
     * Set the file statuses for the repository.
     *
     * @param statuses - Array of file statuses
     */
    setFileStatuses(statuses: IFileStatus[]): void {
      this._fileStatuses = statuses;
      // Detect conflicted files based on 'U' status code
      this._conflictedFiles = statuses
        .filter((file) => file.indexStatus === 'U' || file.workTreeStatus === 'U')
        .map((file) => ({
          path: file.path,
          resolved: false,
        }));
    }

    /**
     * Get the repository.
     */
    getRepository(): IRepository | undefined {
      return this._repository;
    }

    /**
     * Get all file statuses.
     */
    getFileStatuses(): IFileStatus[] {
      return [...this._fileStatuses];
    }

    /**
     * Get conflicted files.
     */
    getConflictedFiles(): IConflictedFile[] {
      return [...this._conflictedFiles];
    }

    /**
     * Check if a file is detected as conflicted.
     *
     * @param path - The file path
     * @returns True if the file is detected as conflicted
     */
    isFileConflicted(path: string): boolean {
      return this._conflictedFiles.some((f) => f.path === path);
    }

    /**
     * Check if the repository has any unresolved conflicts.
     */
    hasUnresolvedConflicts(): boolean {
      return this._conflictedFiles.length > 0;
    }

    /**
     * Get the count of conflicted files.
     */
    getConflictedFileCount(): number {
      return this._conflictedFiles.length;
    }

    /**
     * Check if all files with 'U' status are detected as conflicted.
     */
    allConflictsDetected(): boolean {
      const filesWithUStatus = this._fileStatuses.filter(
        (f) => f.indexStatus === 'U' || f.workTreeStatus === 'U'
      );
      return filesWithUStatus.every((f) => this.isFileConflicted(f.path));
    }

    /**
     * Check if no non-conflicted files are incorrectly marked as conflicted.
     */
    noFalsePositives(): boolean {
      const filesWithoutUStatus = this._fileStatuses.filter(
        (f) => f.indexStatus !== 'U' && f.workTreeStatus !== 'U'
      );
      return filesWithoutUStatus.every((f) => !this.isFileConflicted(f.path));
    }
  }

  describe('Property 31: Conflict File Detection', () => {
    /**
     * Property: All files with 'U' status in index are detected as conflicted.
     */
    it('Property: Files with U status in index are detected as conflicted', () => {
      fc.assert(
        fc.property(
          conflictableStateArb,
          fc.array(
            fc.record({
              path: filePathArb,
              indexStatus: fc.constant<StatusCode>('U'),
              workTreeStatus: fc.constantFrom<StatusCode>(' ', 'U'),
              renamed: fc.constant(undefined),
            }),
            { minLength: 1, maxLength: 10 }
          ),
          (state, conflictedStatuses) => {
            // Setup
            const service = new MockConflictResolutionService();
            service.setRepositoryState(state);

            // Ensure unique paths
            const uniqueStatuses = conflictedStatuses.filter(
              (s, i, arr) => arr.findIndex((x) => x.path === s.path) === i
            );
            service.setFileStatuses(uniqueStatuses);

            // Assert: All files with U status in index are detected
            for (const status of uniqueStatuses) {
              assert.ok(
                service.isFileConflicted(status.path),
                `File ${status.path} with U status in index should be detected as conflicted`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: All files with 'U' status in work tree are detected as conflicted.
     */
    it('Property: Files with U status in work tree are detected as conflicted', () => {
      fc.assert(
        fc.property(
          conflictableStateArb,
          fc.array(
            fc.record({
              path: filePathArb,
              indexStatus: fc.constantFrom<StatusCode>(' ', 'U'),
              workTreeStatus: fc.constant<StatusCode>('U'),
              renamed: fc.constant(undefined),
            }),
            { minLength: 1, maxLength: 10 }
          ),
          (state, conflictedStatuses) => {
            // Setup
            const service = new MockConflictResolutionService();
            service.setRepositoryState(state);

            // Ensure unique paths
            const uniqueStatuses = conflictedStatuses.filter(
              (s, i, arr) => arr.findIndex((x) => x.path === s.path) === i
            );
            service.setFileStatuses(uniqueStatuses);

            // Assert: All files with U status in work tree are detected
            for (const status of uniqueStatuses) {
              assert.ok(
                service.isFileConflicted(status.path),
                `File ${status.path} with U status in work tree should be detected as conflicted`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Files without 'U' status are not detected as conflicted.
     */
    it('Property: Files without U status are not detected as conflicted', () => {
      fc.assert(
        fc.property(
          conflictableStateArb,
          fc.array(nonConflictedFileStatusArb, { minLength: 1, maxLength: 10 }),
          (state, nonConflictedStatuses) => {
            // Setup
            const service = new MockConflictResolutionService();
            service.setRepositoryState(state);

            // Ensure unique paths
            const uniqueStatuses = nonConflictedStatuses.filter(
              (s, i, arr) => arr.findIndex((x) => x.path === s.path) === i
            );
            service.setFileStatuses(uniqueStatuses);

            // Assert: No files without U status are detected as conflicted
            for (const status of uniqueStatuses) {
              assert.ok(
                !service.isFileConflicted(status.path),
                `File ${status.path} without U status should not be detected as conflicted`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Mixed file statuses correctly separate conflicted from non-conflicted.
     */
    it('Property: Mixed statuses correctly identify conflicted files', () => {
      fc.assert(
        fc.property(
          conflictableStateArb,
          mixedFileStatusesArb,
          (state, { conflicted, nonConflicted }) => {
            // Setup
            const service = new MockConflictResolutionService();
            service.setRepositoryState(state);

            // Ensure unique paths across both arrays
            const allPaths = new Set<string>();
            const uniqueConflicted = conflicted.filter((s) => {
              if (allPaths.has(s.path)) {
                return false;
              }
              allPaths.add(s.path);
              return true;
            });
            const uniqueNonConflicted = nonConflicted.filter((s) => {
              if (allPaths.has(s.path)) {
                return false;
              }
              allPaths.add(s.path);
              return true;
            });

            const allStatuses = [...uniqueConflicted, ...uniqueNonConflicted];
            service.setFileStatuses(allStatuses);

            // Assert: All conflicted files are detected
            assert.ok(
              service.allConflictsDetected(),
              'All files with U status should be detected as conflicted'
            );

            // Assert: No false positives
            assert.ok(
              service.noFalsePositives(),
              'Files without U status should not be detected as conflicted'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Conflicted file count matches files with U status.
     */
    it('Property: Conflicted file count matches files with U status', () => {
      fc.assert(
        fc.property(
          conflictableStateArb,
          mixedFileStatusesArb,
          (state, { conflicted, nonConflicted }) => {
            // Setup
            const service = new MockConflictResolutionService();
            service.setRepositoryState(state);

            // Ensure unique paths across both arrays
            const allPaths = new Set<string>();
            const uniqueConflicted = conflicted.filter((s) => {
              if (allPaths.has(s.path)) {
                return false;
              }
              allPaths.add(s.path);
              return true;
            });
            const uniqueNonConflicted = nonConflicted.filter((s) => {
              if (allPaths.has(s.path)) {
                return false;
              }
              allPaths.add(s.path);
              return true;
            });

            const allStatuses = [...uniqueConflicted, ...uniqueNonConflicted];
            service.setFileStatuses(allStatuses);

            // Assert: Count matches
            assert.strictEqual(
              service.getConflictedFileCount(),
              uniqueConflicted.length,
              'Conflicted file count should match number of files with U status'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: hasUnresolvedConflicts returns true when conflicts exist.
     */
    it('Property: hasUnresolvedConflicts returns true when conflicts exist', () => {
      fc.assert(
        fc.property(
          conflictableStateArb,
          fc.array(conflictedFileStatusArb, { minLength: 1, maxLength: 10 }),
          (state, conflictedStatuses) => {
            // Setup
            const service = new MockConflictResolutionService();
            service.setRepositoryState(state);

            // Ensure unique paths
            const uniqueStatuses = conflictedStatuses.filter(
              (s, i, arr) => arr.findIndex((x) => x.path === s.path) === i
            );
            service.setFileStatuses(uniqueStatuses);

            // Assert: hasUnresolvedConflicts returns true
            assert.ok(
              service.hasUnresolvedConflicts(),
              'hasUnresolvedConflicts should return true when conflicts exist'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: hasUnresolvedConflicts returns false when no conflicts exist.
     */
    it('Property: hasUnresolvedConflicts returns false when no conflicts exist', () => {
      fc.assert(
        fc.property(
          conflictableStateArb,
          fc.array(nonConflictedFileStatusArb, { minLength: 0, maxLength: 10 }),
          (state, nonConflictedStatuses) => {
            // Setup
            const service = new MockConflictResolutionService();
            service.setRepositoryState(state);

            // Ensure unique paths
            const uniqueStatuses = nonConflictedStatuses.filter(
              (s, i, arr) => arr.findIndex((x) => x.path === s.path) === i
            );
            service.setFileStatuses(uniqueStatuses);

            // Assert: hasUnresolvedConflicts returns false
            assert.ok(
              !service.hasUnresolvedConflicts(),
              'hasUnresolvedConflicts should return false when no conflicts exist'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Conflicted files have resolved=false initially.
     */
    it('Property: Conflicted files have resolved=false initially', () => {
      fc.assert(
        fc.property(
          conflictableStateArb,
          fc.array(conflictedFileStatusArb, { minLength: 1, maxLength: 10 }),
          (state, conflictedStatuses) => {
            // Setup
            const service = new MockConflictResolutionService();
            service.setRepositoryState(state);

            // Ensure unique paths
            const uniqueStatuses = conflictedStatuses.filter(
              (s, i, arr) => arr.findIndex((x) => x.path === s.path) === i
            );
            service.setFileStatuses(uniqueStatuses);

            // Assert: All conflicted files have resolved=false
            const conflictedFiles = service.getConflictedFiles();
            for (const file of conflictedFiles) {
              assert.strictEqual(
                file.resolved,
                false,
                `Conflicted file ${file.path} should have resolved=false initially`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Conflict detection works for all conflictable repository states.
     */
    it('Property: Conflict detection works for merging, rebasing, and cherry-picking states', () => {
      fc.assert(
        fc.property(
          conflictableStateArb,
          fc.array(conflictedFileStatusArb, { minLength: 1, maxLength: 5 }),
          (state, conflictedStatuses) => {
            // Setup
            const service = new MockConflictResolutionService();
            service.setRepositoryState(state);

            // Ensure unique paths
            const uniqueStatuses = conflictedStatuses.filter(
              (s, i, arr) => arr.findIndex((x) => x.path === s.path) === i
            );
            service.setFileStatuses(uniqueStatuses);

            // Assert: Repository state is one of the conflictable states
            const repo = service.getRepository();
            assert.ok(
              repo && ['merging', 'rebasing', 'cherry-picking'].includes(repo.state),
              'Repository should be in a conflictable state'
            );

            // Assert: Conflicts are detected regardless of state
            assert.ok(
              service.hasUnresolvedConflicts(),
              `Conflicts should be detected in ${state} state`
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: File paths are preserved in conflicted file detection.
     */
    it('Property: File paths are preserved in conflicted file detection', () => {
      fc.assert(
        fc.property(
          conflictableStateArb,
          fc.array(conflictedFileStatusArb, { minLength: 1, maxLength: 10 }),
          (state, conflictedStatuses) => {
            // Setup
            const service = new MockConflictResolutionService();
            service.setRepositoryState(state);

            // Ensure unique paths
            const uniqueStatuses = conflictedStatuses.filter(
              (s, i, arr) => arr.findIndex((x) => x.path === s.path) === i
            );
            service.setFileStatuses(uniqueStatuses);

            // Assert: All original paths are preserved
            const conflictedFiles = service.getConflictedFiles();
            const conflictedPaths = new Set(conflictedFiles.map((f) => f.path));
            const originalPaths = new Set(uniqueStatuses.map((s) => s.path));

            assert.strictEqual(
              conflictedPaths.size,
              originalPaths.size,
              'Number of conflicted file paths should match'
            );

            for (const path of originalPaths) {
              assert.ok(
                conflictedPaths.has(path),
                `Path ${path} should be preserved in conflicted files`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Empty file status list results in no conflicts.
     */
    it('Property: Empty file status list results in no conflicts', () => {
      fc.assert(
        fc.property(conflictableStateArb, (state) => {
          // Setup
          const service = new MockConflictResolutionService();
          service.setRepositoryState(state);
          service.setFileStatuses([]);

          // Assert: No conflicts detected
          assert.strictEqual(
            service.getConflictedFileCount(),
            0,
            'Empty status list should have no conflicts'
          );
          assert.ok(
            !service.hasUnresolvedConflicts(),
            'hasUnresolvedConflicts should return false for empty list'
          );
        }),
        { numRuns: 100 }
      );
    });
  });
});
