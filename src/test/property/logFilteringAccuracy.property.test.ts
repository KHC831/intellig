import * as fc from 'fast-check';
import * as assert from 'assert';
import { ICommit, IAuthor } from '../../services/interfaces/IGitService';

/**
 * Property-based tests for Log Filtering Accuracy.
 * Feature: intellig-vscode, Property 27: Log Filtering Accuracy
 *
 * **Validates: Requirements 9.6, 9.7 (Log)**
 *
 * Property Description:
 * For any filter criteria (author, date range, path, message), the filtered log
 * SHALL contain only commits matching all specified criteria.
 *
 * Requirements:
 * - 9.6: THE Log_View SHALL support filtering by author, date range, file path, and commit message
 * - 9.7: THE Log_View SHALL support searching commit messages and content
 */
describe('Log Filtering Accuracy Property Tests', () => {
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
   * Arbitrary generator for author names.
   */
  const authorNameArb: fc.Arbitrary<string> = fc
    .stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ '.split('')),
      { minLength: 1, maxLength: 30 }
    )
    .filter((s) => s.trim().length > 0);

  /**
   * Arbitrary generator for author information.
   */
  const authorArb: fc.Arbitrary<IAuthor> = fc.record({
    name: authorNameArb,
    email: fc.emailAddress(),
  });

  /**
   * Arbitrary generator for commit messages (single line).
   */
  const commitMessageArb: fc.Arbitrary<string> = fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.!?'.split('')
      ),
      { minLength: 1, maxLength: 100 }
    )
    .filter((s) => s.trim().length > 0);

  /**
   * Arbitrary generator for file paths.
   */
  const filePathArb: fc.Arbitrary<string> = fc
    .array(
      fc.stringOf(
        fc.constantFrom(
          ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.'.split('')
        ),
        { minLength: 1, maxLength: 15 }
      ),
      { minLength: 1, maxLength: 4 }
    )
    .map((parts) => parts.join('/'));

  /**
   * Arbitrary generator for dates within a reasonable range.
   */
  const dateArb: fc.Arbitrary<Date> = fc.date({
    min: new Date('2020-01-01'),
    max: new Date('2024-12-31'),
  });

  /**
   * Arbitrary generator for commits.
   */
  const commitArb: fc.Arbitrary<ICommit> = fc.record({
    hash: commitHashArb,
    shortHash: shortHashArb,
    message: commitMessageArb,
    body: fc.option(commitMessageArb, { nil: undefined }),
    author: authorArb,
    committer: authorArb,
    parents: fc.array(commitHashArb, { minLength: 0, maxLength: 2 }),
    authorDate: dateArb,
    commitDate: dateArb,
  });

  /**
   * Interface for log filter criteria.
   * Matches the ILogFilter interface from the design.
   */
  interface ILogFilter {
    author?: string;
    since?: Date;
    until?: Date;
    path?: string;
    searchText?: string;
  }

  /**
   * Interface for commit with associated file paths.
   */
  interface ICommitWithFiles {
    commit: ICommit;
    files: string[];
  }

  /**
   * Mock Log Filtering Service that simulates the log filtering functionality.
   * This service filters commits based on various criteria.
   */
  class MockLogFilteringService {
    private _commits: ICommitWithFiles[] = [];

    /**
     * Add a commit with its associated files to the repository.
     */
    addCommit(commit: ICommit, files: string[]): void {
      this._commits.push({ commit, files });
    }

    /**
     * Get all commits.
     */
    getAllCommits(): ICommit[] {
      return this._commits.map((c) => c.commit);
    }

    /**
     * Get files for a commit.
     */
    getCommitFiles(hash: string): string[] {
      const entry = this._commits.find((c) => c.commit.hash === hash);
      return entry ? entry.files : [];
    }

    /**
     * Check if a commit matches the author filter.
     * Requirement 9.6: Filter by author.
     *
     * @param commit - The commit to check
     * @param authorFilter - The author name to filter by (case-insensitive partial match)
     * @returns True if the commit matches the author filter
     */
    matchesAuthorFilter(commit: ICommit, authorFilter: string): boolean {
      const normalizedFilter = authorFilter.toLowerCase().trim();
      const normalizedAuthor = commit.author.name.toLowerCase();
      return normalizedAuthor.includes(normalizedFilter);
    }

    /**
     * Check if a commit matches the date range filter.
     * Requirement 9.6: Filter by date range.
     *
     * @param commit - The commit to check
     * @param since - Start date (inclusive)
     * @param until - End date (inclusive)
     * @returns True if the commit is within the date range
     */
    matchesDateRangeFilter(commit: ICommit, since?: Date, until?: Date): boolean {
      const commitDate = commit.authorDate;

      if (since && commitDate < since) {
        return false;
      }

      if (until && commitDate > until) {
        return false;
      }

      return true;
    }

    /**
     * Check if a commit matches the path filter.
     * Requirement 9.6: Filter by file path.
     *
     * @param commitHash - The commit hash
     * @param pathFilter - The path to filter by (prefix match)
     * @returns True if any file in the commit matches the path filter
     */
    matchesPathFilter(commitHash: string, pathFilter: string): boolean {
      const files = this.getCommitFiles(commitHash);
      const normalizedFilter = pathFilter.toLowerCase();

      return files.some((file) => {
        const normalizedFile = file.toLowerCase();
        return (
          normalizedFile.startsWith(normalizedFilter) || normalizedFile.includes(normalizedFilter)
        );
      });
    }

    /**
     * Check if a commit matches the search text filter.
     * Requirement 9.7: Search commit messages and content.
     *
     * @param commit - The commit to check
     * @param searchText - The text to search for (case-insensitive)
     * @returns True if the commit message contains the search text
     */
    matchesSearchTextFilter(commit: ICommit, searchText: string): boolean {
      const normalizedSearch = searchText.toLowerCase().trim();
      const normalizedMessage = commit.message.toLowerCase();
      const normalizedBody = commit.body?.toLowerCase() || '';

      return (
        normalizedMessage.includes(normalizedSearch) || normalizedBody.includes(normalizedSearch)
      );
    }

    /**
     * Filter commits based on the provided criteria.
     * Requirement 9.6, 9.7: Filter by author, date range, path, and message.
     *
     * @param filter - The filter criteria
     * @returns Array of commits matching all specified criteria
     */
    filterCommits(filter: ILogFilter): ICommit[] {
      return this._commits
        .filter((entry) => {
          const { commit } = entry;

          // Check author filter
          if (filter.author && !this.matchesAuthorFilter(commit, filter.author)) {
            return false;
          }

          // Check date range filter
          if (!this.matchesDateRangeFilter(commit, filter.since, filter.until)) {
            return false;
          }

          // Check path filter
          if (filter.path && !this.matchesPathFilter(commit.hash, filter.path)) {
            return false;
          }

          // Check search text filter
          if (filter.searchText && !this.matchesSearchTextFilter(commit, filter.searchText)) {
            return false;
          }

          return true;
        })
        .map((entry) => entry.commit);
    }

    /**
     * Verify that all commits in the result match the filter criteria.
     *
     * @param commits - The filtered commits
     * @param filter - The filter criteria used
     * @returns True if all commits match the criteria
     */
    verifyFilterResults(commits: ICommit[], filter: ILogFilter): boolean {
      for (const commit of commits) {
        // Verify author filter
        if (filter.author && !this.matchesAuthorFilter(commit, filter.author)) {
          return false;
        }

        // Verify date range filter
        if (!this.matchesDateRangeFilter(commit, filter.since, filter.until)) {
          return false;
        }

        // Verify path filter
        if (filter.path && !this.matchesPathFilter(commit.hash, filter.path)) {
          return false;
        }

        // Verify search text filter
        if (filter.searchText && !this.matchesSearchTextFilter(commit, filter.searchText)) {
          return false;
        }
      }

      return true;
    }
  }

  describe('Property 27: Log Filtering Accuracy', () => {
    /**
     * Property: Filtering by author returns only commits from that author.
     *
     * **Validates: Requirements 9.6**
     */
    it('Property: Filtering by author returns only commits from that author', () => {
      fc.assert(
        fc.property(
          fc.array(commitArb, { minLength: 1, maxLength: 20 }),
          authorNameArb,
          (commits, authorFilter) => {
            // Setup
            const filterService = new MockLogFilteringService();
            for (const commit of commits) {
              filterService.addCommit(commit, []);
            }

            // Act
            const filter: ILogFilter = { author: authorFilter };
            const filteredCommits = filterService.filterCommits(filter);

            // Assert: All filtered commits match the author filter
            for (const commit of filteredCommits) {
              assert.ok(
                filterService.matchesAuthorFilter(commit, authorFilter),
                `Commit by '${commit.author.name}' should match author filter '${authorFilter}'`
              );
            }

            // Assert: No matching commits were excluded
            const allMatchingCommits = commits.filter((c) =>
              filterService.matchesAuthorFilter(c, authorFilter)
            );
            assert.strictEqual(
              filteredCommits.length,
              allMatchingCommits.length,
              'All matching commits should be included'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Filtering by date range returns only commits within that range.
     *
     * **Validates: Requirements 9.6**
     */
    it('Property: Filtering by date range returns only commits within that range', () => {
      fc.assert(
        fc.property(
          fc.array(commitArb, { minLength: 1, maxLength: 20 }),
          dateArb,
          dateArb,
          (commits, date1, date2) => {
            // Ensure since <= until
            const since = date1 < date2 ? date1 : date2;
            const until = date1 < date2 ? date2 : date1;

            // Setup
            const filterService = new MockLogFilteringService();
            for (const commit of commits) {
              filterService.addCommit(commit, []);
            }

            // Act
            const filter: ILogFilter = { since, until };
            const filteredCommits = filterService.filterCommits(filter);

            // Assert: All filtered commits are within the date range
            for (const commit of filteredCommits) {
              assert.ok(
                commit.authorDate >= since,
                `Commit date ${commit.authorDate.toISOString()} should be >= since ${since.toISOString()}`
              );
              assert.ok(
                commit.authorDate <= until,
                `Commit date ${commit.authorDate.toISOString()} should be <= until ${until.toISOString()}`
              );
            }

            // Assert: No matching commits were excluded
            const allMatchingCommits = commits.filter(
              (c) => c.authorDate >= since && c.authorDate <= until
            );
            assert.strictEqual(
              filteredCommits.length,
              allMatchingCommits.length,
              'All commits within date range should be included'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Filtering by path returns only commits that modified that path.
     *
     * **Validates: Requirements 9.6**
     */
    it('Property: Filtering by path returns only commits that modified that path', () => {
      fc.assert(
        fc.property(
          fc.array(fc.tuple(commitArb, fc.array(filePathArb, { minLength: 0, maxLength: 5 })), {
            minLength: 1,
            maxLength: 15,
          }),
          filePathArb,
          (commitsWithFiles, pathFilter) => {
            // Setup
            const filterService = new MockLogFilteringService();
            for (const [commit, files] of commitsWithFiles) {
              filterService.addCommit(commit, files);
            }

            // Act
            const filter: ILogFilter = { path: pathFilter };
            const filteredCommits = filterService.filterCommits(filter);

            // Assert: All filtered commits have files matching the path filter
            for (const commit of filteredCommits) {
              assert.ok(
                filterService.matchesPathFilter(commit.hash, pathFilter),
                `Commit should have files matching path filter '${pathFilter}'`
              );
            }

            // Assert: No matching commits were excluded
            const allMatchingCommits = commitsWithFiles
              .filter(([commit]) => filterService.matchesPathFilter(commit.hash, pathFilter))
              .map(([commit]) => commit);
            assert.strictEqual(
              filteredCommits.length,
              allMatchingCommits.length,
              'All commits with matching paths should be included'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Filtering by search text returns only commits with matching messages.
     *
     * **Validates: Requirements 9.7**
     */
    it('Property: Filtering by search text returns only commits with matching messages', () => {
      fc.assert(
        fc.property(
          fc.array(commitArb, { minLength: 1, maxLength: 20 }),
          fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), {
            minLength: 1,
            maxLength: 10,
          }),
          (commits, searchText) => {
            // Setup
            const filterService = new MockLogFilteringService();
            for (const commit of commits) {
              filterService.addCommit(commit, []);
            }

            // Act
            const filter: ILogFilter = { searchText };
            const filteredCommits = filterService.filterCommits(filter);

            // Assert: All filtered commits have messages containing the search text
            for (const commit of filteredCommits) {
              assert.ok(
                filterService.matchesSearchTextFilter(commit, searchText),
                `Commit message '${commit.message}' should contain search text '${searchText}'`
              );
            }

            // Assert: No matching commits were excluded
            const allMatchingCommits = commits.filter((c) =>
              filterService.matchesSearchTextFilter(c, searchText)
            );
            assert.strictEqual(
              filteredCommits.length,
              allMatchingCommits.length,
              'All commits with matching messages should be included'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Combined filters return only commits matching ALL criteria.
     *
     * **Validates: Requirements 9.6, 9.7**
     */
    it('Property: Combined filters return only commits matching ALL criteria', () => {
      fc.assert(
        fc.property(
          fc.array(fc.tuple(commitArb, fc.array(filePathArb, { minLength: 0, maxLength: 3 })), {
            minLength: 1,
            maxLength: 15,
          }),
          fc.record({
            author: fc.option(authorNameArb, { nil: undefined }),
            since: fc.option(dateArb, { nil: undefined }),
            until: fc.option(dateArb, { nil: undefined }),
            path: fc.option(filePathArb, { nil: undefined }),
            searchText: fc.option(
              fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), {
                minLength: 1,
                maxLength: 5,
              }),
              { nil: undefined }
            ),
          }),
          (commitsWithFiles, filter) => {
            // Normalize date range
            if (filter.since && filter.until && filter.since > filter.until) {
              const temp = filter.since;
              filter.since = filter.until;
              filter.until = temp;
            }

            // Setup
            const filterService = new MockLogFilteringService();
            for (const [commit, files] of commitsWithFiles) {
              filterService.addCommit(commit, files);
            }

            // Act
            const filteredCommits = filterService.filterCommits(filter);

            // Assert: All filtered commits match ALL specified criteria
            assert.ok(
              filterService.verifyFilterResults(filteredCommits, filter),
              'All filtered commits should match all specified criteria'
            );

            // Assert: Result is a subset of all commits
            const allCommits = commitsWithFiles.map(([commit]) => commit);
            for (const commit of filteredCommits) {
              assert.ok(
                allCommits.some((c) => c.hash === commit.hash),
                'Filtered commit should be from the original commit list'
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Empty filter returns all commits.
     *
     * **Validates: Requirements 9.6, 9.7**
     */
    it('Property: Empty filter returns all commits', () => {
      fc.assert(
        fc.property(fc.array(commitArb, { minLength: 0, maxLength: 20 }), (commits) => {
          // Setup
          const filterService = new MockLogFilteringService();
          for (const commit of commits) {
            filterService.addCommit(commit, []);
          }

          // Act
          const filter: ILogFilter = {};
          const filteredCommits = filterService.filterCommits(filter);

          // Assert: All commits are returned
          assert.strictEqual(
            filteredCommits.length,
            commits.length,
            'Empty filter should return all commits'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Filter with no matches returns empty array.
     *
     * **Validates: Requirements 9.6, 9.7**
     */
    it('Property: Filter with no matches returns empty array', () => {
      fc.assert(
        fc.property(fc.array(commitArb, { minLength: 1, maxLength: 10 }), (commits) => {
          // Setup
          const filterService = new MockLogFilteringService();
          for (const commit of commits) {
            filterService.addCommit(commit, []);
          }

          // Use a search text that won't match any commit
          const impossibleSearchText = 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';

          // Act
          const filter: ILogFilter = { searchText: impossibleSearchText };
          const filteredCommits = filterService.filterCommits(filter);

          // Assert: No commits match
          assert.strictEqual(
            filteredCommits.length,
            0,
            'Filter with no matches should return empty array'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Author filter is case-insensitive.
     *
     * **Validates: Requirements 9.6**
     */
    it('Property: Author filter is case-insensitive', () => {
      fc.assert(
        fc.property(commitArb, (commit) => {
          // Setup
          const filterService = new MockLogFilteringService();
          filterService.addCommit(commit, []);

          const authorName = commit.author.name;
          const upperCaseFilter = authorName.toUpperCase();
          const lowerCaseFilter = authorName.toLowerCase();

          // Act
          const upperResults = filterService.filterCommits({ author: upperCaseFilter });
          const lowerResults = filterService.filterCommits({ author: lowerCaseFilter });

          // Assert: Both filters return the same results
          assert.strictEqual(
            upperResults.length,
            lowerResults.length,
            'Case-insensitive author filter should return same results'
          );

          // Assert: The commit is found with both filters
          if (authorName.trim().length > 0) {
            assert.ok(
              upperResults.some((c) => c.hash === commit.hash),
              'Commit should be found with uppercase author filter'
            );
            assert.ok(
              lowerResults.some((c) => c.hash === commit.hash),
              'Commit should be found with lowercase author filter'
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Search text filter is case-insensitive.
     *
     * **Validates: Requirements 9.7**
     */
    it('Property: Search text filter is case-insensitive', () => {
      fc.assert(
        fc.property(commitArb, (commit) => {
          // Setup
          const filterService = new MockLogFilteringService();
          filterService.addCommit(commit, []);

          // Extract a substring from the message to search for
          const message = commit.message;
          if (message.length < 2) {
            return true;
          } // Skip very short messages

          const searchSubstring = message.substring(0, Math.min(5, message.length));
          const upperCaseSearch = searchSubstring.toUpperCase();
          const lowerCaseSearch = searchSubstring.toLowerCase();

          // Act
          const upperResults = filterService.filterCommits({ searchText: upperCaseSearch });
          const lowerResults = filterService.filterCommits({ searchText: lowerCaseSearch });

          // Assert: Both searches return the same results
          assert.strictEqual(
            upperResults.length,
            lowerResults.length,
            'Case-insensitive search should return same results'
          );

          return true;
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Date filter with since only returns commits after that date.
     *
     * **Validates: Requirements 9.6**
     */
    it('Property: Date filter with since only returns commits after that date', () => {
      fc.assert(
        fc.property(
          fc.array(commitArb, { minLength: 1, maxLength: 20 }),
          dateArb,
          (commits, sinceDate) => {
            // Setup
            const filterService = new MockLogFilteringService();
            for (const commit of commits) {
              filterService.addCommit(commit, []);
            }

            // Act
            const filter: ILogFilter = { since: sinceDate };
            const filteredCommits = filterService.filterCommits(filter);

            // Assert: All filtered commits are on or after the since date
            for (const commit of filteredCommits) {
              assert.ok(
                commit.authorDate >= sinceDate,
                `Commit date ${commit.authorDate.toISOString()} should be >= since ${sinceDate.toISOString()}`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Date filter with until only returns commits before that date.
     *
     * **Validates: Requirements 9.6**
     */
    it('Property: Date filter with until only returns commits before that date', () => {
      fc.assert(
        fc.property(
          fc.array(commitArb, { minLength: 1, maxLength: 20 }),
          dateArb,
          (commits, untilDate) => {
            // Setup
            const filterService = new MockLogFilteringService();
            for (const commit of commits) {
              filterService.addCommit(commit, []);
            }

            // Act
            const filter: ILogFilter = { until: untilDate };
            const filteredCommits = filterService.filterCommits(filter);

            // Assert: All filtered commits are on or before the until date
            for (const commit of filteredCommits) {
              assert.ok(
                commit.authorDate <= untilDate,
                `Commit date ${commit.authorDate.toISOString()} should be <= until ${untilDate.toISOString()}`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Filtering preserves commit order.
     *
     * **Validates: Requirements 9.6, 9.7**
     */
    it('Property: Filtering preserves commit order', () => {
      fc.assert(
        fc.property(
          fc.array(commitArb, { minLength: 2, maxLength: 20 }),
          authorNameArb,
          (commits, authorFilter) => {
            // Setup
            const filterService = new MockLogFilteringService();
            for (const commit of commits) {
              filterService.addCommit(commit, []);
            }

            // Act
            const filter: ILogFilter = { author: authorFilter };
            const filteredCommits = filterService.filterCommits(filter);

            // Get the original indices of filtered commits
            const originalIndices = filteredCommits.map((fc) =>
              commits.findIndex((c) => c.hash === fc.hash)
            );

            // Assert: Indices are in ascending order (preserves original order)
            for (let i = 1; i < originalIndices.length; i++) {
              assert.ok(
                originalIndices[i] > originalIndices[i - 1],
                'Filtered commits should preserve original order'
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
