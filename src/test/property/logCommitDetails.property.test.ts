import * as fc from 'fast-check';
import * as assert from 'assert';
import { ICommit, IAuthor, IDiff, FileStatus } from '../../git-core/interfaces/IGitService';

/**
 * Property-based tests for Log Commit Details.
 * Feature: intellig-vscode, Property 26: Log Commit Details
 *
 *
 * Property Description:
 * For any selected commit, the details view SHALL display the full commit message
 * and list of all changed files.
 *
 * - 9.3: WHEN a user selects a commit, THE Extension SHALL display the full commit
 *        details including changed files
 */
describe('Log Commit Details Property Tests', () => {
  /**
   * Arbitrary generator for commit hashes (40 character hex strings).
   */
  const commitHashArb: fc.Arbitrary<string> = fc.stringOf(
    fc.constantFrom(...'0123456789abcdef'.split('')),
    {
      minLength: 40,
      maxLength: 40,
    }
  );

  /**
   * Arbitrary generator for short commit hashes (7 character hex strings).
   */
  const shortHashArb: fc.Arbitrary<string> = fc.stringOf(
    fc.constantFrom(...'0123456789abcdef'.split('')),
    {
      minLength: 7,
      maxLength: 7,
    }
  );

  /**
   * Arbitrary generator for author information.
   */
  const authorArb: fc.Arbitrary<IAuthor> = fc.record({
    name: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
    email: fc.emailAddress(),
  });

  /**
   * Arbitrary generator for commit messages (single line).
   */
  const commitMessageArb: fc.Arbitrary<string> = fc
    .string({ minLength: 1, maxLength: 200 })
    .filter((s) => s.trim().length > 0);

  /**
   * Arbitrary generator for commit body (multi-line description).
   */
  const commitBodyArb: fc.Arbitrary<string | undefined> = fc.option(
    fc.string({ minLength: 1, maxLength: 500 }).filter((s) => s.trim().length > 0),
    { nil: undefined }
  );

  /**
   * Arbitrary generator for file paths.
   */
  const filePathArb: fc.Arbitrary<string> = fc
    .array(
      fc.stringOf(
        fc.constantFrom(
          ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.'.split('')
        ),
        { minLength: 1, maxLength: 20 }
      ),
      { minLength: 1, maxLength: 4 }
    )
    .map((parts) => parts.join('/'));

  /**
   * Arbitrary generator for file status.
   */
  const fileStatusArb: fc.Arbitrary<FileStatus> = fc.constantFrom(
    'modified',
    'added',
    'deleted',
    'renamed',
    'copied'
  );

  /**
   * Arbitrary generator for diff entries (changed files).
   */
  const diffArb: fc.Arbitrary<IDiff> = fc.record({
    path: filePathArb,
    oldPath: fc.option(filePathArb, { nil: undefined }),
    status: fileStatusArb,
    hunks: fc.constant([]), // Simplified for this test - hunks not needed for file list
    binary: fc.boolean(),
  });

  /**
   * Arbitrary generator for commits.
   */
  const commitArb: fc.Arbitrary<ICommit> = fc.record({
    hash: commitHashArb,
    shortHash: shortHashArb,
    message: commitMessageArb,
    body: commitBodyArb,
    author: authorArb,
    committer: authorArb,
    parents: fc.array(commitHashArb, { minLength: 0, maxLength: 2 }),
    authorDate: fc.date({ min: new Date('2000-01-01'), max: new Date() }),
    commitDate: fc.date({ min: new Date('2000-01-01'), max: new Date() }),
  });

  /**
   * Represents the commit details view data.
   */
  interface ICommitDetailsView {
    hash: string;
    shortHash: string;
    fullMessage: string;
    author: IAuthor;
    committer: IAuthor;
    authorDate: Date;
    commitDate: Date;
    parents: string[];
    changedFiles: IChangedFileEntry[];
  }

  /**
   * Represents a changed file entry in the commit details.
   */
  interface IChangedFileEntry {
    path: string;
    oldPath?: string;
    status: FileStatus;
    binary: boolean;
  }

  /**
   * Mock Commit Details Service that simulates the commit details view functionality.
   * This service retrieves and displays full commit details including changed files.
   */
  class MockCommitDetailsService {
    private _commits: Map<string, ICommit> = new Map();
    private _commitDiffs: Map<string, IDiff[]> = new Map();

    /**
     * Add a commit to the repository.
     */
    addCommit(commit: ICommit): void {
      this._commits.set(commit.hash, commit);
    }

    /**
     * Set the diffs (changed files) for a commit.
     */
    setCommitDiffs(commitHash: string, diffs: IDiff[]): void {
      this._commitDiffs.set(commitHash, diffs);
    }

    /**
     * Get a commit by hash.
     */
    getCommit(hash: string): ICommit | undefined {
      return this._commits.get(hash);
    }

    /**
     * Get the diffs for a commit.
     */
    getCommitDiffs(hash: string): IDiff[] {
      return this._commitDiffs.get(hash) || [];
    }

    /**
     * Get the full commit message (subject + body).
     *
     * @param commit - The commit
     * @returns The full commit message
     */
    getFullCommitMessage(commit: ICommit): string {
      if (commit.body && commit.body.trim().length > 0) {
        return `${commit.message}\n\n${commit.body}`;
      }
      return commit.message;
    }

    /**
     * Get the commit details view for a selected commit.
     *
     * @param commitHash - The hash of the selected commit
     * @returns The commit details view data, or undefined if commit not found
     */
    getCommitDetailsView(commitHash: string): ICommitDetailsView | undefined {
      const commit = this.getCommit(commitHash);
      if (!commit) {
        return undefined;
      }

      const diffs = this.getCommitDiffs(commitHash);
      const changedFiles: IChangedFileEntry[] = diffs.map((diff) => ({
        path: diff.path,
        oldPath: diff.oldPath,
        status: diff.status,
        binary: diff.binary,
      }));

      return {
        hash: commit.hash,
        shortHash: commit.shortHash,
        fullMessage: this.getFullCommitMessage(commit),
        author: commit.author,
        committer: commit.committer,
        authorDate: commit.authorDate,
        commitDate: commit.commitDate,
        parents: commit.parents,
        changedFiles,
      };
    }

    /**
     * Validate that the commit details view contains all required information.
     *
     * @param details - The commit details view to validate
     * @returns True if all required fields are present and valid
     */
    validateCommitDetailsView(details: ICommitDetailsView): boolean {
      // Hash must be present and valid
      if (!details.hash || details.hash.length !== 40) {
        return false;
      }
      if (!/^[0-9a-f]{40}$/.test(details.hash)) {
        return false;
      }

      // Short hash must be present and valid
      if (!details.shortHash || details.shortHash.length !== 7) {
        return false;
      }
      if (!/^[0-9a-f]{7}$/.test(details.shortHash)) {
        return false;
      }

      // Full message must be present and non-empty
      if (!details.fullMessage || details.fullMessage.trim().length === 0) {
        return false;
      }

      // Author must be present with valid name and email
      if (!details.author || !details.author.name || !details.author.email) {
        return false;
      }

      // Committer must be present with valid name and email
      if (!details.committer || !details.committer.name || !details.committer.email) {
        return false;
      }

      // Dates must be present and valid
      if (!details.authorDate || !(details.authorDate instanceof Date)) {
        return false;
      }
      if (isNaN(details.authorDate.getTime())) {
        return false;
      }
      if (!details.commitDate || !(details.commitDate instanceof Date)) {
        return false;
      }
      if (isNaN(details.commitDate.getTime())) {
        return false;
      }

      // Parents must be an array
      if (!Array.isArray(details.parents)) {
        return false;
      }

      // Changed files must be an array
      if (!Array.isArray(details.changedFiles)) {
        return false;
      }

      // Each changed file must have valid path and status
      for (const file of details.changedFiles) {
        if (!file.path || file.path.trim().length === 0) {
          return false;
        }
        if (!file.status) {
          return false;
        }
      }

      return true;
    }
  }

  describe('Property 26: Log Commit Details', () => {
    /**
     * Property: Commit details view displays the full commit message.
     */
    it('Property: Commit details view displays the full commit message', () => {
      fc.assert(
        fc.property(commitArb, (commit) => {
          // Setup
          const detailsService = new MockCommitDetailsService();
          detailsService.addCommit(commit);

          // Act
          const detailsView = detailsService.getCommitDetailsView(commit.hash);

          // Assert: Details view exists
          assert.ok(detailsView, 'Commit details view should exist');

          // Assert: Full message is present
          assert.ok(detailsView.fullMessage, 'Full message should be present');
          assert.ok(detailsView.fullMessage.trim().length > 0, 'Full message should not be empty');

          // Assert: Full message contains the commit subject
          assert.ok(
            detailsView.fullMessage.includes(commit.message),
            'Full message should contain the commit subject'
          );

          // Assert: If body exists, full message contains it
          if (commit.body && commit.body.trim().length > 0) {
            assert.ok(
              detailsView.fullMessage.includes(commit.body),
              'Full message should contain the commit body'
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Commit details view displays all changed files.
     */
    it('Property: Commit details view displays all changed files', () => {
      fc.assert(
        fc.property(
          commitArb,
          fc.array(diffArb, { minLength: 0, maxLength: 10 }).map((diffs) => {
            // Ensure unique file paths
            const seenPaths = new Set<string>();
            return diffs.filter((diff) => {
              if (seenPaths.has(diff.path)) {
                return false;
              }
              seenPaths.add(diff.path);
              return true;
            });
          }),
          (commit, diffs) => {
            // Setup
            const detailsService = new MockCommitDetailsService();
            detailsService.addCommit(commit);
            detailsService.setCommitDiffs(commit.hash, diffs);

            // Act
            const detailsView = detailsService.getCommitDetailsView(commit.hash);

            // Assert: Details view exists
            assert.ok(detailsView, 'Commit details view should exist');

            // Assert: Changed files array is present
            assert.ok(Array.isArray(detailsView.changedFiles), 'Changed files should be an array');

            // Assert: All diffs are represented in changed files
            assert.strictEqual(
              detailsView.changedFiles.length,
              diffs.length,
              'Should have correct number of changed files'
            );

            // Assert: Each diff path is in the changed files
            for (const diff of diffs) {
              const foundFile: IChangedFileEntry | undefined = detailsView.changedFiles.find(
                (f) => f.path === diff.path
              );
              assert.ok(foundFile, `Changed file '${diff.path}' should be in the list`);
              assert.strictEqual(
                foundFile.status,
                diff.status,
                `File '${diff.path}' should have correct status`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Commit details view includes file status for each changed file.
     */
    it('Property: Commit details view includes file status for each changed file', () => {
      fc.assert(
        fc.property(
          commitArb,
          fc.array(diffArb, { minLength: 1, maxLength: 10 }).map((diffs) => {
            // Ensure unique file paths
            const seenPaths = new Set<string>();
            return diffs.filter((diff) => {
              if (seenPaths.has(diff.path)) {
                return false;
              }
              seenPaths.add(diff.path);
              return true;
            });
          }),
          (commit, diffs) => {
            // Setup
            const detailsService = new MockCommitDetailsService();
            detailsService.addCommit(commit);
            detailsService.setCommitDiffs(commit.hash, diffs);

            // Act
            const detailsView = detailsService.getCommitDetailsView(commit.hash);

            // Assert: Details view exists
            assert.ok(detailsView, 'Commit details view should exist');

            // Assert: Each changed file has a valid status
            for (const file of detailsView.changedFiles) {
              assert.ok(file.status, `File '${file.path}' should have a status`);
              assert.ok(
                [
                  'modified',
                  'added',
                  'deleted',
                  'renamed',
                  'copied',
                  'untracked',
                  'ignored',
                  'conflicted',
                ].includes(file.status),
                `File '${file.path}' should have a valid status`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Commit details view preserves renamed file information.
     */
    it('Property: Commit details view preserves renamed file information', () => {
      fc.assert(
        fc.property(commitArb, filePathArb, filePathArb, (commit, oldPath, newPath) => {
          // Skip if paths are the same
          if (oldPath === newPath) {
            return true;
          }

          // Setup: Create a renamed file diff
          const renamedDiff: IDiff = {
            path: newPath,
            oldPath: oldPath,
            status: 'renamed',
            hunks: [],
            binary: false,
          };

          const detailsService = new MockCommitDetailsService();
          detailsService.addCommit(commit);
          detailsService.setCommitDiffs(commit.hash, [renamedDiff]);

          // Act
          const detailsView = detailsService.getCommitDetailsView(commit.hash);

          // Assert: Details view exists
          assert.ok(detailsView, 'Commit details view should exist');

          // Assert: Renamed file is in the list
          assert.strictEqual(detailsView.changedFiles.length, 1, 'Should have one changed file');

          const renamedFile = detailsView.changedFiles[0];
          assert.strictEqual(renamedFile.path, newPath, 'New path should be correct');
          assert.strictEqual(renamedFile.oldPath, oldPath, 'Old path should be preserved');
          assert.strictEqual(renamedFile.status, 'renamed', 'Status should be renamed');

          return true;
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Commit details view validation passes for all valid commits.
     */
    it('Property: Commit details view validation passes for all valid commits', () => {
      fc.assert(
        fc.property(
          commitArb,
          fc.array(diffArb, { minLength: 0, maxLength: 5 }),
          (commit, diffs) => {
            // Setup
            const detailsService = new MockCommitDetailsService();
            detailsService.addCommit(commit);
            detailsService.setCommitDiffs(commit.hash, diffs);

            // Act
            const detailsView = detailsService.getCommitDetailsView(commit.hash);

            // Assert: Details view exists and is valid
            assert.ok(detailsView, 'Commit details view should exist');
            assert.ok(
              detailsService.validateCommitDetailsView(detailsView),
              'Commit details view should pass validation'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Commit with no changed files shows empty file list.
     */
    it('Property: Commit with no changed files shows empty file list', () => {
      fc.assert(
        fc.property(commitArb, (commit) => {
          // Setup: Commit with no diffs
          const detailsService = new MockCommitDetailsService();
          detailsService.addCommit(commit);
          detailsService.setCommitDiffs(commit.hash, []);

          // Act
          const detailsView = detailsService.getCommitDetailsView(commit.hash);

          // Assert: Details view exists
          assert.ok(detailsView, 'Commit details view should exist');

          // Assert: Changed files is empty array
          assert.ok(Array.isArray(detailsView.changedFiles), 'Changed files should be an array');
          assert.strictEqual(detailsView.changedFiles.length, 0, 'Changed files should be empty');

          // Assert: Full message is still present
          assert.ok(
            detailsView.fullMessage.trim().length > 0,
            'Full message should still be present'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Commit details view includes author and committer information.
     */
    it('Property: Commit details view includes author and committer information', () => {
      fc.assert(
        fc.property(commitArb, (commit) => {
          // Setup
          const detailsService = new MockCommitDetailsService();
          detailsService.addCommit(commit);

          // Act
          const detailsView = detailsService.getCommitDetailsView(commit.hash);

          // Assert: Details view exists
          assert.ok(detailsView, 'Commit details view should exist');

          // Assert: Author information is present and matches
          assert.ok(detailsView.author, 'Author should be present');
          assert.strictEqual(
            detailsView.author.name,
            commit.author.name,
            'Author name should match'
          );
          assert.strictEqual(
            detailsView.author.email,
            commit.author.email,
            'Author email should match'
          );

          // Assert: Committer information is present and matches
          assert.ok(detailsView.committer, 'Committer should be present');
          assert.strictEqual(
            detailsView.committer.name,
            commit.committer.name,
            'Committer name should match'
          );
          assert.strictEqual(
            detailsView.committer.email,
            commit.committer.email,
            'Committer email should match'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Commit details view includes date information.
     */
    it('Property: Commit details view includes date information', () => {
      fc.assert(
        fc.property(commitArb, (commit) => {
          // Setup
          const detailsService = new MockCommitDetailsService();
          detailsService.addCommit(commit);

          // Act
          const detailsView = detailsService.getCommitDetailsView(commit.hash);

          // Assert: Details view exists
          assert.ok(detailsView, 'Commit details view should exist');

          // Assert: Author date is present and matches
          assert.ok(detailsView.authorDate, 'Author date should be present');
          assert.ok(detailsView.authorDate instanceof Date, 'Author date should be a Date');
          assert.strictEqual(
            detailsView.authorDate.getTime(),
            commit.authorDate.getTime(),
            'Author date should match'
          );

          // Assert: Commit date is present and matches
          assert.ok(detailsView.commitDate, 'Commit date should be present');
          assert.ok(detailsView.commitDate instanceof Date, 'Commit date should be a Date');
          assert.strictEqual(
            detailsView.commitDate.getTime(),
            commit.commitDate.getTime(),
            'Commit date should match'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Commit details view includes parent commit references.
     */
    it('Property: Commit details view includes parent commit references', () => {
      fc.assert(
        fc.property(commitArb, (commit) => {
          // Setup
          const detailsService = new MockCommitDetailsService();
          detailsService.addCommit(commit);

          // Act
          const detailsView = detailsService.getCommitDetailsView(commit.hash);

          // Assert: Details view exists
          assert.ok(detailsView, 'Commit details view should exist');

          // Assert: Parents array is present and matches
          assert.ok(Array.isArray(detailsView.parents), 'Parents should be an array');
          assert.strictEqual(
            detailsView.parents.length,
            commit.parents.length,
            'Parents count should match'
          );

          for (let i = 0; i < commit.parents.length; i++) {
            assert.strictEqual(
              detailsView.parents[i],
              commit.parents[i],
              `Parent ${i} should match`
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Multi-line commit messages are fully displayed.
     */
    it('Property: Multi-line commit messages are fully displayed', () => {
      fc.assert(
        fc.property(
          fc.tuple(
            fc
              .string({ minLength: 1, maxLength: 50 })
              .filter((s) => s.trim().length > 0 && !s.includes('\n')),
            fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0)
          ),
          commitArb,
          ([subject, body], baseCommit) => {
            // Create a commit with multi-line message
            const commit: ICommit = {
              ...baseCommit,
              message: subject,
              body: body,
            };

            // Setup
            const detailsService = new MockCommitDetailsService();
            detailsService.addCommit(commit);

            // Act
            const detailsView = detailsService.getCommitDetailsView(commit.hash);

            // Assert: Details view exists
            assert.ok(detailsView, 'Commit details view should exist');

            // Assert: Full message contains both subject and body
            assert.ok(
              detailsView.fullMessage.includes(subject),
              'Full message should contain subject'
            );
            assert.ok(detailsView.fullMessage.includes(body), 'Full message should contain body');

            // Assert: Full message is properly formatted (subject + separator + body)
            const expectedMessage = `${subject}\n\n${body}`;
            assert.strictEqual(
              detailsView.fullMessage,
              expectedMessage,
              'Full message should be properly formatted'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Binary file changes are indicated in the file list.
     */
    it('Property: Binary file changes are indicated in the file list', () => {
      fc.assert(
        fc.property(commitArb, filePathArb, fc.boolean(), (commit, filePath, isBinary) => {
          // Setup: Create a diff with binary flag
          const diff: IDiff = {
            path: filePath,
            status: 'modified',
            hunks: [],
            binary: isBinary,
          };

          const detailsService = new MockCommitDetailsService();
          detailsService.addCommit(commit);
          detailsService.setCommitDiffs(commit.hash, [diff]);

          // Act
          const detailsView = detailsService.getCommitDetailsView(commit.hash);

          // Assert: Details view exists
          assert.ok(detailsView, 'Commit details view should exist');

          // Assert: Binary flag is preserved
          assert.strictEqual(detailsView.changedFiles.length, 1, 'Should have one changed file');
          assert.strictEqual(
            detailsView.changedFiles[0].binary,
            isBinary,
            'Binary flag should be preserved'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Non-existent commit returns undefined details view.
     */
    it('Property: Non-existent commit returns undefined details view', () => {
      fc.assert(
        fc.property(commitHashArb, (nonExistentHash) => {
          // Setup: Empty service with no commits
          const detailsService = new MockCommitDetailsService();

          // Act
          const detailsView = detailsService.getCommitDetailsView(nonExistentHash);

          // Assert: Details view should be undefined
          assert.strictEqual(
            detailsView,
            undefined,
            'Details view should be undefined for non-existent commit'
          );
        }),
        { numRuns: 100 }
      );
    });
  });
});
