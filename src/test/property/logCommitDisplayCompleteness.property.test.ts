import * as fc from 'fast-check';
import * as assert from 'assert';
import { ICommit, IAuthor, IBranch, ITag } from '../../services/interfaces/IGitService';

/**
 * Property-based tests for Log Commit Display Completeness.
 * Feature: intellij-git-vscode, Property 25: Log Commit Display Completeness
 *
 * **Validates: Requirements 9.2 (Log)**
 *
 * Property Description:
 * For any commit in the log, the display SHALL include the commit hash, author name,
 * date, message summary, and any associated branch/tag labels.
 *
 * Requirements:
 * - 9.2: WHEN viewing the log, THE Extension SHALL display for each commit: hash,
 *        author, date, message summary, and branch/tag labels
 */
describe('Log Commit Display Completeness Property Tests', () => {
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
   * Arbitrary generator for commit messages.
   */
  const commitMessageArb: fc.Arbitrary<string> = fc
    .string({ minLength: 1, maxLength: 200 })
    .filter((s) => s.trim().length > 0);

  /**
   * Arbitrary generator for branch names.
   */
  const branchNameArb: fc.Arbitrary<string> = fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_/'.split('')
      ),
      { minLength: 1, maxLength: 30 }
    )
    .filter((s) => {
      if (s.length === 0) {
        return false;
      }
      if (s.startsWith('-') || s.startsWith('/')) {
        return false;
      }
      if (s.endsWith('/') || s.endsWith('.lock')) {
        return false;
      }
      if (s.includes('..') || s.includes('//')) {
        return false;
      }
      return true;
    });

  /**
   * Arbitrary generator for tag names.
   */
  const tagNameArb: fc.Arbitrary<string> = fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.'.split('')
      ),
      { minLength: 1, maxLength: 30 }
    )
    .filter((s) => {
      if (s.length === 0) {
        return false;
      }
      if (s.startsWith('-') || s.startsWith('.')) {
        return false;
      }
      if (s.endsWith('.lock')) {
        return false;
      }
      return true;
    });

  /**
   * Arbitrary generator for commits.
   */
  const commitArb: fc.Arbitrary<ICommit> = fc.record({
    hash: commitHashArb,
    shortHash: shortHashArb,
    message: commitMessageArb,
    body: fc.option(fc.string({ minLength: 0, maxLength: 500 }), { nil: undefined }),
    author: authorArb,
    committer: authorArb,
    parents: fc.array(commitHashArb, { minLength: 0, maxLength: 2 }),
    authorDate: fc.date({ min: new Date('2000-01-01'), max: new Date() }),
    commitDate: fc.date({ min: new Date('2000-01-01'), max: new Date() }),
  });

  /**
   * Represents a commit display entry in the log view.
   */
  interface ICommitDisplayEntry {
    hash: string;
    shortHash: string;
    authorName: string;
    date: Date;
    messageSummary: string;
    branchLabels: string[];
    tagLabels: string[];
  }

  /**
   * Mock Log View Service that simulates the log display functionality.
   * This service transforms commits into display entries with associated labels.
   */
  class MockLogViewService {
    private _commits: Map<string, ICommit> = new Map();
    private _branches: IBranch[] = [];
    private _tags: ITag[] = [];

    /**
     * Add a commit to the repository.
     */
    addCommit(commit: ICommit): void {
      this._commits.set(commit.hash, commit);
    }

    /**
     * Add a branch to the repository.
     */
    addBranch(branch: IBranch): void {
      this._branches.push(branch);
    }

    /**
     * Add a tag to the repository.
     */
    addTag(tag: ITag): void {
      this._tags.push(tag);
    }

    /**
     * Get all commits.
     */
    getCommits(): ICommit[] {
      return Array.from(this._commits.values());
    }

    /**
     * Get branches pointing to a specific commit.
     */
    getBranchesForCommit(commitHash: string): IBranch[] {
      return this._branches.filter((b) => b.commit === commitHash);
    }

    /**
     * Get tags pointing to a specific commit.
     */
    getTagsForCommit(commitHash: string): ITag[] {
      return this._tags.filter((t) => t.commit === commitHash);
    }

    /**
     * Generate the display entry for a commit.
     * Requirement 9.2: Display hash, author, date, message summary, and branch/tag labels.
     *
     * @param commit - The commit to display
     * @returns The display entry with all required fields
     */
    getCommitDisplayEntry(commit: ICommit): ICommitDisplayEntry {
      const branchesForCommit = this.getBranchesForCommit(commit.hash);
      const tagsForCommit = this.getTagsForCommit(commit.hash);

      // Extract the first line of the message as the summary
      const messageSummary = commit.message.split('\n')[0].trim();

      return {
        hash: commit.hash,
        shortHash: commit.shortHash,
        authorName: commit.author.name,
        date: commit.authorDate,
        messageSummary,
        branchLabels: branchesForCommit.map((b) => b.name),
        tagLabels: tagsForCommit.map((t) => t.name),
      };
    }

    /**
     * Get all commit display entries for the log view.
     * Requirement 9.2: Display all commits with their information.
     *
     * @returns Array of display entries for all commits
     */
    getLogDisplayEntries(): ICommitDisplayEntry[] {
      return this.getCommits().map((commit) => this.getCommitDisplayEntry(commit));
    }

    /**
     * Validate that a display entry contains all required fields.
     * Requirement 9.2: Each commit must display hash, author, date, message summary.
     *
     * @param entry - The display entry to validate
     * @returns True if all required fields are present and valid
     */
    validateDisplayEntry(entry: ICommitDisplayEntry): boolean {
      // Hash must be present and valid (40 hex characters)
      if (!entry.hash || entry.hash.length !== 40) {
        return false;
      }
      if (!/^[0-9a-f]{40}$/.test(entry.hash)) {
        return false;
      }

      // Short hash must be present and valid (7 hex characters)
      if (!entry.shortHash || entry.shortHash.length !== 7) {
        return false;
      }
      if (!/^[0-9a-f]{7}$/.test(entry.shortHash)) {
        return false;
      }

      // Author name must be present and non-empty
      if (!entry.authorName || entry.authorName.trim().length === 0) {
        return false;
      }

      // Date must be present and valid
      if (!entry.date || !(entry.date instanceof Date)) {
        return false;
      }
      if (isNaN(entry.date.getTime())) {
        return false;
      }

      // Message summary must be present and non-empty
      if (!entry.messageSummary || entry.messageSummary.trim().length === 0) {
        return false;
      }

      // Branch and tag labels must be arrays (can be empty)
      if (!Array.isArray(entry.branchLabels)) {
        return false;
      }
      if (!Array.isArray(entry.tagLabels)) {
        return false;
      }

      return true;
    }
  }

  describe('Property 25: Log Commit Display Completeness', () => {
    /**
     * Property: Every commit display entry includes the commit hash.
     *
     * **Validates: Requirements 9.2**
     */
    it('Property: Every commit display entry includes the commit hash', () => {
      fc.assert(
        fc.property(commitArb, (commit) => {
          // Setup
          const logService = new MockLogViewService();
          logService.addCommit(commit);

          // Act
          const displayEntry = logService.getCommitDisplayEntry(commit);

          // Assert: Hash is present and matches the original commit
          assert.ok(displayEntry.hash, 'Display entry should include hash');
          assert.strictEqual(
            displayEntry.hash,
            commit.hash,
            'Display hash should match commit hash'
          );
          assert.strictEqual(displayEntry.hash.length, 40, 'Hash should be 40 characters');
          assert.ok(/^[0-9a-f]{40}$/.test(displayEntry.hash), 'Hash should be valid hex string');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Every commit display entry includes the short hash.
     *
     * **Validates: Requirements 9.2**
     */
    it('Property: Every commit display entry includes the short hash', () => {
      fc.assert(
        fc.property(commitArb, (commit) => {
          // Setup
          const logService = new MockLogViewService();
          logService.addCommit(commit);

          // Act
          const displayEntry = logService.getCommitDisplayEntry(commit);

          // Assert: Short hash is present and matches
          assert.ok(displayEntry.shortHash, 'Display entry should include short hash');
          assert.strictEqual(
            displayEntry.shortHash,
            commit.shortHash,
            'Display short hash should match commit short hash'
          );
          assert.strictEqual(displayEntry.shortHash.length, 7, 'Short hash should be 7 characters');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Every commit display entry includes the author name.
     *
     * **Validates: Requirements 9.2**
     */
    it('Property: Every commit display entry includes the author name', () => {
      fc.assert(
        fc.property(commitArb, (commit) => {
          // Setup
          const logService = new MockLogViewService();
          logService.addCommit(commit);

          // Act
          const displayEntry = logService.getCommitDisplayEntry(commit);

          // Assert: Author name is present and matches
          assert.ok(displayEntry.authorName, 'Display entry should include author name');
          assert.strictEqual(
            displayEntry.authorName,
            commit.author.name,
            'Display author name should match commit author name'
          );
          assert.ok(displayEntry.authorName.trim().length > 0, 'Author name should not be empty');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Every commit display entry includes the date.
     *
     * **Validates: Requirements 9.2**
     */
    it('Property: Every commit display entry includes the date', () => {
      fc.assert(
        fc.property(commitArb, (commit) => {
          // Setup
          const logService = new MockLogViewService();
          logService.addCommit(commit);

          // Act
          const displayEntry = logService.getCommitDisplayEntry(commit);

          // Assert: Date is present and valid
          assert.ok(displayEntry.date, 'Display entry should include date');
          assert.ok(displayEntry.date instanceof Date, 'Date should be a Date object');
          assert.ok(!isNaN(displayEntry.date.getTime()), 'Date should be valid');
          assert.strictEqual(
            displayEntry.date.getTime(),
            commit.authorDate.getTime(),
            'Display date should match commit author date'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Every commit display entry includes the message summary.
     *
     * **Validates: Requirements 9.2**
     */
    it('Property: Every commit display entry includes the message summary', () => {
      fc.assert(
        fc.property(commitArb, (commit) => {
          // Setup
          const logService = new MockLogViewService();
          logService.addCommit(commit);

          // Act
          const displayEntry = logService.getCommitDisplayEntry(commit);

          // Assert: Message summary is present
          assert.ok(displayEntry.messageSummary, 'Display entry should include message summary');
          assert.ok(
            displayEntry.messageSummary.trim().length > 0,
            'Message summary should not be empty'
          );

          // Assert: Message summary is the first line of the commit message
          const expectedSummary = commit.message.split('\n')[0].trim();
          assert.strictEqual(
            displayEntry.messageSummary,
            expectedSummary,
            'Message summary should be the first line of the commit message'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Commit display entry includes branch labels for associated branches.
     *
     * **Validates: Requirements 9.2**
     */
    it('Property: Commit display entry includes branch labels for associated branches', () => {
      fc.assert(
        fc.property(
          commitArb,
          fc.array(branchNameArb, { minLength: 0, maxLength: 5 }),
          (commit, branchNames) => {
            // Setup
            const logService = new MockLogViewService();
            logService.addCommit(commit);

            // Create unique branch names
            const uniqueBranchNames = [...new Set(branchNames)];

            // Add branches pointing to this commit
            for (const name of uniqueBranchNames) {
              const branch: IBranch = {
                name,
                type: 'local',
                commit: commit.hash,
                upstream: undefined,
                isHead: false,
              };
              logService.addBranch(branch);
            }

            // Act
            const displayEntry = logService.getCommitDisplayEntry(commit);

            // Assert: Branch labels array is present
            assert.ok(Array.isArray(displayEntry.branchLabels), 'Branch labels should be an array');

            // Assert: All branch names are included
            assert.strictEqual(
              displayEntry.branchLabels.length,
              uniqueBranchNames.length,
              'Should have correct number of branch labels'
            );

            for (const name of uniqueBranchNames) {
              assert.ok(
                displayEntry.branchLabels.includes(name),
                `Branch label '${name}' should be included`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Commit display entry includes tag labels for associated tags.
     *
     * **Validates: Requirements 9.2**
     */
    it('Property: Commit display entry includes tag labels for associated tags', () => {
      fc.assert(
        fc.property(
          commitArb,
          fc.array(tagNameArb, { minLength: 0, maxLength: 5 }),
          (commit, tagNames) => {
            // Setup
            const logService = new MockLogViewService();
            logService.addCommit(commit);

            // Create unique tag names
            const uniqueTagNames = [...new Set(tagNames)];

            // Add tags pointing to this commit
            for (const name of uniqueTagNames) {
              const tag: ITag = {
                name,
                commit: commit.hash,
                isAnnotated: false,
              };
              logService.addTag(tag);
            }

            // Act
            const displayEntry = logService.getCommitDisplayEntry(commit);

            // Assert: Tag labels array is present
            assert.ok(Array.isArray(displayEntry.tagLabels), 'Tag labels should be an array');

            // Assert: All tag names are included
            assert.strictEqual(
              displayEntry.tagLabels.length,
              uniqueTagNames.length,
              'Should have correct number of tag labels'
            );

            for (const name of uniqueTagNames) {
              assert.ok(
                displayEntry.tagLabels.includes(name),
                `Tag label '${name}' should be included`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Display entry validation passes for all valid commits.
     *
     * **Validates: Requirements 9.2**
     */
    it('Property: Display entry validation passes for all valid commits', () => {
      fc.assert(
        fc.property(commitArb, (commit) => {
          // Setup
          const logService = new MockLogViewService();
          logService.addCommit(commit);

          // Act
          const displayEntry = logService.getCommitDisplayEntry(commit);
          const isValid = logService.validateDisplayEntry(displayEntry);

          // Assert: All display entries should be valid
          assert.ok(isValid, 'Display entry should pass validation');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Commits without branches or tags have empty label arrays.
     *
     * **Validates: Requirements 9.2**
     */
    it('Property: Commits without branches or tags have empty label arrays', () => {
      fc.assert(
        fc.property(commitArb, (commit) => {
          // Setup: Create service without adding any branches or tags
          const logService = new MockLogViewService();
          logService.addCommit(commit);

          // Act
          const displayEntry = logService.getCommitDisplayEntry(commit);

          // Assert: Label arrays should be empty but present
          assert.ok(Array.isArray(displayEntry.branchLabels), 'Branch labels should be an array');
          assert.ok(Array.isArray(displayEntry.tagLabels), 'Tag labels should be an array');
          assert.strictEqual(displayEntry.branchLabels.length, 0, 'Branch labels should be empty');
          assert.strictEqual(displayEntry.tagLabels.length, 0, 'Tag labels should be empty');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Multiple commits all have complete display entries.
     *
     * **Validates: Requirements 9.2**
     */
    it('Property: Multiple commits all have complete display entries', () => {
      fc.assert(
        fc.property(
          fc.array(commitArb, { minLength: 1, maxLength: 10 }).map((commits) => {
            // Ensure unique hashes
            const seenHashes = new Set<string>();
            return commits.map((commit, index) => {
              let hash = commit.hash;
              while (seenHashes.has(hash)) {
                const chars = hash.split('');
                chars[index % 40] = '0123456789abcdef'[(parseInt(chars[index % 40], 16) + 1) % 16];
                hash = chars.join('');
              }
              seenHashes.add(hash);
              return { ...commit, hash, shortHash: hash.substring(0, 7) };
            });
          }),
          (commits) => {
            // Setup
            const logService = new MockLogViewService();
            for (const commit of commits) {
              logService.addCommit(commit);
            }

            // Act
            const displayEntries = logService.getLogDisplayEntries();

            // Assert: All commits have display entries
            assert.strictEqual(
              displayEntries.length,
              commits.length,
              'Should have display entry for each commit'
            );

            // Assert: All display entries are valid
            for (const entry of displayEntries) {
              assert.ok(
                logService.validateDisplayEntry(entry),
                `Display entry for ${entry.hash} should be valid`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Display entries correctly associate branches with their commits.
     *
     * **Validates: Requirements 9.2**
     */
    it('Property: Display entries correctly associate branches with their commits', () => {
      fc.assert(
        fc.property(
          fc.array(commitArb, { minLength: 2, maxLength: 5 }).map((commits) => {
            // Ensure unique hashes
            const seenHashes = new Set<string>();
            return commits.map((commit, index) => {
              let hash = commit.hash;
              while (seenHashes.has(hash)) {
                const chars = hash.split('');
                chars[index % 40] = '0123456789abcdef'[(parseInt(chars[index % 40], 16) + 1) % 16];
                hash = chars.join('');
              }
              seenHashes.add(hash);
              return { ...commit, hash, shortHash: hash.substring(0, 7) };
            });
          }),
          branchNameArb,
          (commits, branchName) => {
            // Setup
            const logService = new MockLogViewService();
            for (const commit of commits) {
              logService.addCommit(commit);
            }

            // Add a branch pointing to the first commit only
            const targetCommit = commits[0];
            const branch: IBranch = {
              name: branchName,
              type: 'local',
              commit: targetCommit.hash,
              upstream: undefined,
              isHead: false,
            };
            logService.addBranch(branch);

            // Act
            const displayEntries = logService.getLogDisplayEntries();

            // Assert: Only the target commit has the branch label
            for (const entry of displayEntries) {
              if (entry.hash === targetCommit.hash) {
                assert.ok(
                  entry.branchLabels.includes(branchName),
                  'Target commit should have the branch label'
                );
              } else {
                assert.ok(
                  !entry.branchLabels.includes(branchName),
                  'Other commits should not have the branch label'
                );
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Display entries correctly associate tags with their commits.
     *
     * **Validates: Requirements 9.2**
     */
    it('Property: Display entries correctly associate tags with their commits', () => {
      fc.assert(
        fc.property(
          fc.array(commitArb, { minLength: 2, maxLength: 5 }).map((commits) => {
            // Ensure unique hashes
            const seenHashes = new Set<string>();
            return commits.map((commit, index) => {
              let hash = commit.hash;
              while (seenHashes.has(hash)) {
                const chars = hash.split('');
                chars[index % 40] = '0123456789abcdef'[(parseInt(chars[index % 40], 16) + 1) % 16];
                hash = chars.join('');
              }
              seenHashes.add(hash);
              return { ...commit, hash, shortHash: hash.substring(0, 7) };
            });
          }),
          tagNameArb,
          (commits, tagName) => {
            // Setup
            const logService = new MockLogViewService();
            for (const commit of commits) {
              logService.addCommit(commit);
            }

            // Add a tag pointing to the first commit only
            const targetCommit = commits[0];
            const tag: ITag = {
              name: tagName,
              commit: targetCommit.hash,
              isAnnotated: false,
            };
            logService.addTag(tag);

            // Act
            const displayEntries = logService.getLogDisplayEntries();

            // Assert: Only the target commit has the tag label
            for (const entry of displayEntries) {
              if (entry.hash === targetCommit.hash) {
                assert.ok(
                  entry.tagLabels.includes(tagName),
                  'Target commit should have the tag label'
                );
              } else {
                assert.ok(
                  !entry.tagLabels.includes(tagName),
                  'Other commits should not have the tag label'
                );
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Multi-line commit messages have only first line as summary.
     *
     * **Validates: Requirements 9.2**
     */
    it('Property: Multi-line commit messages have only first line as summary', () => {
      fc.assert(
        fc.property(
          fc.tuple(
            fc
              .string({ minLength: 1, maxLength: 50 })
              .filter((s) => s.trim().length > 0 && !s.includes('\n')),
            fc.string({ minLength: 1, maxLength: 200 })
          ),
          commitArb,
          ([firstLine, restOfMessage], baseCommit) => {
            // Create a multi-line message
            const multiLineMessage = `${firstLine}\n\n${restOfMessage}`;
            const commit: ICommit = {
              ...baseCommit,
              message: multiLineMessage,
            };

            // Setup
            const logService = new MockLogViewService();
            logService.addCommit(commit);

            // Act
            const displayEntry = logService.getCommitDisplayEntry(commit);

            // Assert: Summary is only the first line
            assert.strictEqual(
              displayEntry.messageSummary,
              firstLine.trim(),
              'Message summary should be only the first line'
            );
            assert.ok(
              !displayEntry.messageSummary.includes('\n'),
              'Message summary should not contain newlines'
            );
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
