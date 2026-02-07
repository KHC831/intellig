import * as fc from 'fast-check';
import * as assert from 'assert';
import { IChangelist, IFileChange } from '../../services/interfaces/IChangelistService';
import {
  FileStatus,
  ICommit,
  IAuthor,
  ICommitOptions,
} from '../../services/interfaces/IGitService';
import { ILocalChangesState, ILogState } from '../../services/interfaces/IGitToolWindowProvider';

/**
 * Property-based tests for Commit State Update.
 * Feature: intellij-git-vscode, Property 7: Commit State Update
 *
 * **Validates: Requirements 3.8**
 *
 * Property Description:
 * For any successful commit operation, the committed files SHALL no longer appear
 * in the Local Changes View, and the Log View SHALL contain the new commit.
 *
 * Requirements:
 * - 3.8: WHEN a commit succeeds, THE Commit_Dialog SHALL close and THE Local_Changes_View
 *        SHALL update to reflect the committed changes
 */
describe('Commit State Update Property Tests', () => {
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
   * Arbitrary generator for file status.
   */
  const fileStatusArb: fc.Arbitrary<FileStatus> = fc.constantFrom(
    'modified',
    'added',
    'deleted',
    'renamed',
    'untracked'
  );

  /**
   * Arbitrary generator for file changes.
   */
  const fileChangeArb: fc.Arbitrary<IFileChange> = fc.record({
    path: filePathArb,
    status: fileStatusArb,
    staged: fc.boolean(),
    hunks: fc.constant(undefined),
  });

  /**
   * Arbitrary generator for non-empty arrays of file changes with unique paths.
   */
  const fileChangesArb: fc.Arbitrary<IFileChange[]> = fc
    .array(fileChangeArb, { minLength: 1, maxLength: 10 })
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

  /**
   * Arbitrary generator for commit messages.
   */
  const commitMessageArb: fc.Arbitrary<string> = fc
    .string({ minLength: 1, maxLength: 200 })
    .filter((s) => s.trim().length > 0);

  /**
   * Arbitrary generator for author information.
   */
  const authorArb: fc.Arbitrary<IAuthor> = fc.record({
    name: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
    email: fc.emailAddress(),
  });

  /**
   * Arbitrary generator for commit hashes.
   */
  const commitHashArb: fc.Arbitrary<string> = fc
    .hexaString({ minLength: 40, maxLength: 40 })
    .map((s) => s.toLowerCase());

  /**
   * Arbitrary generator for short commit hashes.
   */
  const shortHashArb: fc.Arbitrary<string> = fc
    .hexaString({ minLength: 7, maxLength: 7 })
    .map((s) => s.toLowerCase());

  /**
   * Arbitrary generator for commits.
   */
  const commitArb: fc.Arbitrary<ICommit> = fc
    .tuple(
      commitHashArb,
      shortHashArb,
      commitMessageArb,
      authorArb,
      fc.date({ min: new Date('2020-01-01'), max: new Date() }),
      fc.array(commitHashArb, { minLength: 0, maxLength: 2 })
    )
    .map(([hash, shortHash, message, author, date, parents]) => ({
      hash,
      shortHash,
      message,
      author,
      committer: author,
      parents,
      authorDate: date,
      commitDate: date,
    }));

  /**
   * Mock service that simulates commit state management.
   * This allows us to test the commit state update properties without actual Git operations.
   */
  class MockCommitStateService {
    private _changelists: Map<string, IChangelist> = new Map();
    private _commits: ICommit[] = [];
    private _defaultChangelistId: string = 'default';

    constructor(initialChangelists: IChangelist[] = [], initialCommits: ICommit[] = []) {
      // Ensure there's always a default changelist
      let hasDefault = false;
      for (const cl of initialChangelists) {
        this._changelists.set(cl.id, { ...cl, files: [...cl.files] });
        if (cl.isDefault) {
          hasDefault = true;
          this._defaultChangelistId = cl.id;
        }
      }

      if (!hasDefault) {
        const defaultChangelist: IChangelist = {
          id: 'default',
          name: 'Default Changelist',
          isDefault: true,
          files: [],
        };
        this._changelists.set(defaultChangelist.id, defaultChangelist);
      }

      this._commits = [...initialCommits];
    }

    /**
     * Get the Local Changes state.
     */
    getLocalChangesState(): ILocalChangesState {
      return {
        changelists: Array.from(this._changelists.values()).map((cl) => ({
          ...cl,
          files: [...cl.files],
        })),
        expandedChangelists: new Set(),
        selectedFiles: new Set(),
      };
    }

    /**
     * Get the Log state.
     */
    getLogState(): ILogState {
      return {
        selectedCommits: new Set(),
        expandedCommit: undefined,
        filter: undefined,
      };
    }

    /**
     * Get all commits in the log.
     */
    getCommits(): ICommit[] {
      return [...this._commits];
    }

    /**
     * Get all files in all changelists.
     */
    getAllFiles(): IFileChange[] {
      const files: IFileChange[] = [];
      for (const cl of this._changelists.values()) {
        files.push(...cl.files);
      }
      return files;
    }

    /**
     * Get staged files from all changelists.
     */
    getStagedFiles(): IFileChange[] {
      return this.getAllFiles().filter((f) => f.staged);
    }

    /**
     * Stage files for commit.
     */
    stageFiles(paths: string[]): void {
      const pathSet = new Set(paths);
      for (const cl of this._changelists.values()) {
        for (const file of cl.files) {
          if (pathSet.has(file.path)) {
            file.staged = true;
          }
        }
      }
    }

    /**
     * Perform a commit operation.
     * Requirement 3.8: After commit, committed files should no longer appear in Local Changes View,
     * and the Log View should contain the new commit.
     *
     * @param message - Commit message
     * @param options - Commit options
     * @returns The created commit
     */
    commit(message: string, options?: ICommitOptions): ICommit {
      // Get staged files
      const stagedFiles = this.getStagedFiles();

      if (stagedFiles.length === 0 && !options?.allowEmpty) {
        throw new Error('No staged files to commit');
      }

      if (!message.trim() && !options?.amend) {
        throw new Error('Commit message cannot be empty');
      }

      // Generate a new commit
      const hash = this._generateHash();
      const shortHash = hash.substring(0, 7);
      const now = new Date();
      const author: IAuthor = { name: 'Test User', email: 'test@example.com' };

      // For amend, use the previous commit's parent
      const parents: string[] = [];
      if (options?.amend && this._commits.length > 0) {
        const lastCommit = this._commits[this._commits.length - 1];
        parents.push(...lastCommit.parents);
        // Remove the last commit (we're amending it)
        this._commits.pop();
      } else if (this._commits.length > 0) {
        parents.push(this._commits[this._commits.length - 1].hash);
      }

      const newCommit: ICommit = {
        hash,
        shortHash,
        message: message.trim(),
        author,
        committer: author,
        parents,
        authorDate: now,
        commitDate: now,
      };

      // Add the new commit to the log
      this._commits.push(newCommit);

      // Remove committed files from changelists
      const committedPaths = new Set(stagedFiles.map((f) => f.path));
      for (const cl of this._changelists.values()) {
        cl.files = cl.files.filter((f) => !committedPaths.has(f.path) || !f.staged);
      }

      return newCommit;
    }

    /**
     * Check if a file exists in the Local Changes View.
     */
    fileExistsInLocalChanges(path: string): boolean {
      for (const cl of this._changelists.values()) {
        if (cl.files.some((f) => f.path === path)) {
          return true;
        }
      }
      return false;
    }

    /**
     * Check if a commit exists in the Log View.
     */
    commitExistsInLog(hash: string): boolean {
      return this._commits.some((c) => c.hash === hash);
    }

    /**
     * Add files to the default changelist.
     */
    addFilesToDefaultChangelist(files: IFileChange[]): void {
      const defaultCl = this._changelists.get(this._defaultChangelistId);
      if (defaultCl) {
        defaultCl.files.push(...files);
      }
    }

    /**
     * Generate a random commit hash.
     */
    private _generateHash(): string {
      const chars = '0123456789abcdef';
      let hash = '';
      for (let i = 0; i < 40; i++) {
        hash += chars[Math.floor(Math.random() * chars.length)];
      }
      return hash;
    }
  }

  describe('Property 7: Commit State Update', () => {
    /**
     * Property: After a successful commit, committed files no longer appear in Local Changes View.
     *
     * **Validates: Requirements 3.8**
     */
    it('Property: Committed files are removed from Local Changes View', () => {
      fc.assert(
        fc.property(fileChangesArb, commitMessageArb, (files, message) => {
          // Setup: Create service with files
          const stagedFiles = files.map((f) => ({ ...f, staged: true }));
          const service = new MockCommitStateService();
          service.addFilesToDefaultChangelist(stagedFiles);

          // Pre-condition: Files exist in Local Changes View
          const committedPaths = stagedFiles.map((f) => f.path);
          for (const path of committedPaths) {
            assert.ok(
              service.fileExistsInLocalChanges(path),
              `File '${path}' should exist before commit`
            );
          }

          // Act: Perform commit
          service.commit(message);

          // Assert: Committed files no longer appear in Local Changes View
          for (const path of committedPaths) {
            assert.ok(
              !service.fileExistsInLocalChanges(path),
              `File '${path}' should not exist in Local Changes View after commit`
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: After a successful commit, the Log View contains the new commit.
     *
     * **Validates: Requirements 3.8**
     */
    it('Property: New commit appears in Log View after successful commit', () => {
      fc.assert(
        fc.property(fileChangesArb, commitMessageArb, (files, message) => {
          // Setup: Create service with staged files
          const stagedFiles = files.map((f) => ({ ...f, staged: true }));
          const service = new MockCommitStateService();
          service.addFilesToDefaultChangelist(stagedFiles);

          // Pre-condition: Get initial commit count
          const initialCommitCount = service.getCommits().length;

          // Act: Perform commit
          const newCommit = service.commit(message);

          // Assert: Log View contains the new commit
          assert.ok(
            service.commitExistsInLog(newCommit.hash),
            'New commit should appear in Log View'
          );

          // Assert: Commit count increased by 1
          assert.strictEqual(
            service.getCommits().length,
            initialCommitCount + 1,
            'Commit count should increase by 1'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Commit message is preserved in the new commit.
     *
     * **Validates: Requirements 3.8**
     */
    it('Property: Commit message is preserved in the new commit', () => {
      fc.assert(
        fc.property(fileChangesArb, commitMessageArb, (files, message) => {
          // Setup: Create service with staged files
          const stagedFiles = files.map((f) => ({ ...f, staged: true }));
          const service = new MockCommitStateService();
          service.addFilesToDefaultChangelist(stagedFiles);

          // Act: Perform commit
          const newCommit = service.commit(message);

          // Assert: Commit message is preserved
          assert.strictEqual(
            newCommit.message,
            message.trim(),
            'Commit message should be preserved'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Only staged files are removed from Local Changes View.
     *
     * **Validates: Requirements 3.8**
     */
    it('Property: Only staged files are removed, unstaged files remain', () => {
      fc.assert(
        fc.property(
          fileChangesArb,
          fileChangesArb,
          commitMessageArb,
          (stagedFiles, unstagedFiles, message) => {
            // Setup: Create service with both staged and unstaged files
            const staged = stagedFiles.map((f) => ({ ...f, staged: true }));
            const unstaged = unstagedFiles
              .filter((f) => !stagedFiles.some((sf) => sf.path === f.path))
              .map((f) => ({ ...f, staged: false }));

            if (unstaged.length === 0) {
              // Skip if no unstaged files after filtering
              return true;
            }

            const service = new MockCommitStateService();
            service.addFilesToDefaultChangelist([...staged, ...unstaged]);

            // Pre-condition: All files exist
            for (const file of [...staged, ...unstaged]) {
              assert.ok(
                service.fileExistsInLocalChanges(file.path),
                `File '${file.path}' should exist before commit`
              );
            }

            // Act: Perform commit
            service.commit(message);

            // Assert: Staged files are removed
            for (const file of staged) {
              assert.ok(
                !service.fileExistsInLocalChanges(file.path),
                `Staged file '${file.path}' should be removed after commit`
              );
            }

            // Assert: Unstaged files remain
            for (const file of unstaged) {
              assert.ok(
                service.fileExistsInLocalChanges(file.path),
                `Unstaged file '${file.path}' should remain after commit`
              );
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: New commit has correct parent reference.
     *
     * **Validates: Requirements 3.8**
     */
    it('Property: New commit has correct parent reference', () => {
      fc.assert(
        fc.property(
          fc.array(commitArb, { minLength: 1, maxLength: 5 }),
          fileChangesArb,
          commitMessageArb,
          (existingCommits, files, message) => {
            // Setup: Create service with existing commits and staged files
            const stagedFiles = files.map((f) => ({ ...f, staged: true }));
            const service = new MockCommitStateService([], existingCommits);
            service.addFilesToDefaultChangelist(stagedFiles);

            // Get the last commit hash before new commit
            const lastCommitHash = existingCommits[existingCommits.length - 1].hash;

            // Act: Perform commit
            const newCommit = service.commit(message);

            // Assert: New commit's parent is the previous HEAD
            assert.ok(
              newCommit.parents.includes(lastCommitHash),
              'New commit should have previous HEAD as parent'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Commit with no staged files fails (unless allowEmpty).
     *
     * **Validates: Requirements 3.8**
     */
    it('Property: Commit with no staged files fails unless allowEmpty', () => {
      fc.assert(
        fc.property(commitMessageArb, (message) => {
          // Setup: Create service with no files
          const service = new MockCommitStateService();

          // Act & Assert: Commit should fail
          assert.throws(
            () => service.commit(message),
            /No staged files to commit/,
            'Commit with no staged files should fail'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Commit with allowEmpty option succeeds even with no staged files.
     *
     * **Validates: Requirements 3.8**
     */
    it('Property: Commit with allowEmpty succeeds with no staged files', () => {
      fc.assert(
        fc.property(commitMessageArb, (message) => {
          // Setup: Create service with no files
          const service = new MockCommitStateService();

          // Act: Perform commit with allowEmpty
          const newCommit = service.commit(message, { allowEmpty: true });

          // Assert: Commit was created
          assert.ok(newCommit, 'Commit should be created');
          assert.ok(
            service.commitExistsInLog(newCommit.hash),
            'Empty commit should appear in Log View'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Amend commit replaces the previous commit in Log View.
     *
     * **Validates: Requirements 3.8**
     */
    it('Property: Amend commit replaces previous commit in Log View', () => {
      fc.assert(
        fc.property(
          commitArb,
          fileChangesArb,
          commitMessageArb,
          (existingCommit, files, newMessage) => {
            // Setup: Create service with one existing commit and staged files
            const stagedFiles = files.map((f) => ({ ...f, staged: true }));
            const service = new MockCommitStateService([], [existingCommit]);
            service.addFilesToDefaultChangelist(stagedFiles);

            // Pre-condition: Original commit exists
            assert.ok(
              service.commitExistsInLog(existingCommit.hash),
              'Original commit should exist'
            );
            assert.strictEqual(service.getCommits().length, 1, 'Should have 1 commit');

            // Act: Perform amend commit
            const amendedCommit = service.commit(newMessage, { amend: true });

            // Assert: Original commit is replaced
            assert.ok(
              !service.commitExistsInLog(existingCommit.hash),
              'Original commit should be removed'
            );
            assert.ok(service.commitExistsInLog(amendedCommit.hash), 'Amended commit should exist');
            assert.strictEqual(
              service.getCommits().length,
              1,
              'Should still have 1 commit after amend'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Multiple sequential commits maintain correct order in Log View.
     *
     * **Validates: Requirements 3.8**
     */
    it('Property: Multiple sequential commits maintain correct order', () => {
      fc.assert(
        fc.property(
          fc.array(fc.tuple(fileChangesArb, commitMessageArb), { minLength: 2, maxLength: 5 }),
          (commitData) => {
            // Setup: Create service
            const service = new MockCommitStateService();
            const createdCommits: ICommit[] = [];

            // Act: Perform multiple commits
            for (const [files, message] of commitData) {
              const stagedFiles = files.map((f) => ({ ...f, staged: true }));
              service.addFilesToDefaultChangelist(stagedFiles);
              const commit = service.commit(message);
              createdCommits.push(commit);
            }

            // Assert: All commits exist in Log View
            for (const commit of createdCommits) {
              assert.ok(
                service.commitExistsInLog(commit.hash),
                `Commit ${commit.shortHash} should exist in Log View`
              );
            }

            // Assert: Commits are in correct order (newest last)
            const logCommits = service.getCommits();
            assert.strictEqual(
              logCommits.length,
              createdCommits.length,
              'Log should have all commits'
            );

            for (let i = 0; i < createdCommits.length; i++) {
              assert.strictEqual(
                logCommits[i].hash,
                createdCommits[i].hash,
                `Commit at index ${i} should match`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Local Changes View is empty after committing all staged files.
     *
     * **Validates: Requirements 3.8**
     */
    it('Property: Local Changes View is empty after committing all files', () => {
      fc.assert(
        fc.property(fileChangesArb, commitMessageArb, (files, message) => {
          // Setup: Create service with all files staged
          const stagedFiles = files.map((f) => ({ ...f, staged: true }));
          const service = new MockCommitStateService();
          service.addFilesToDefaultChangelist(stagedFiles);

          // Pre-condition: Files exist
          assert.ok(service.getAllFiles().length > 0, 'Should have files before commit');

          // Act: Perform commit
          service.commit(message);

          // Assert: Local Changes View is empty
          assert.strictEqual(
            service.getAllFiles().length,
            0,
            'Local Changes View should be empty after committing all files'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: New commit has valid timestamp.
     *
     * **Validates: Requirements 3.8**
     */
    it('Property: New commit has valid timestamp', () => {
      fc.assert(
        fc.property(fileChangesArb, commitMessageArb, (files, message) => {
          // Setup
          const stagedFiles = files.map((f) => ({ ...f, staged: true }));
          const service = new MockCommitStateService();
          service.addFilesToDefaultChangelist(stagedFiles);

          const beforeCommit = new Date();

          // Act
          const newCommit = service.commit(message);

          const afterCommit = new Date();

          // Assert: Timestamp is valid
          assert.ok(newCommit.authorDate instanceof Date, 'Author date should be a Date');
          assert.ok(newCommit.commitDate instanceof Date, 'Commit date should be a Date');
          assert.ok(
            newCommit.authorDate >= beforeCommit && newCommit.authorDate <= afterCommit,
            'Author date should be within commit window'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: New commit has valid hash format.
     *
     * **Validates: Requirements 3.8**
     */
    it('Property: New commit has valid hash format', () => {
      fc.assert(
        fc.property(fileChangesArb, commitMessageArb, (files, message) => {
          // Setup
          const stagedFiles = files.map((f) => ({ ...f, staged: true }));
          const service = new MockCommitStateService();
          service.addFilesToDefaultChangelist(stagedFiles);

          // Act
          const newCommit = service.commit(message);

          // Assert: Hash format is valid
          assert.ok(/^[0-9a-f]{40}$/.test(newCommit.hash), 'Full hash should be 40 hex characters');
          assert.ok(
            /^[0-9a-f]{7}$/.test(newCommit.shortHash),
            'Short hash should be 7 hex characters'
          );
          assert.strictEqual(
            newCommit.shortHash,
            newCommit.hash.substring(0, 7),
            'Short hash should be prefix of full hash'
          );
        }),
        { numRuns: 100 }
      );
    });
  });
});
