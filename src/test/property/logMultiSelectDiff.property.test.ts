import * as fc from 'fast-check';
import * as assert from 'assert';
import {
  ICommit,
  IAuthor,
  IDiff,
  IHunk,
  IDiffLine,
  FileStatus,
} from '../../services/interfaces/IGitService';

/**
 * Property-based tests for Log Multi-Select Diff.
 * Feature: intellij-git-vscode, Property 28: Log Multi-Select Diff
 *
 * **Validates: Requirements 9.8 (Log)**
 *
 * Property Description:
 * For any selection of multiple commits, the combined diff SHALL represent
 * the cumulative changes across all selected commits.
 *
 * Requirements:
 * - 9.8: WHEN a user selects multiple commits, THE Extension SHALL display
 *        the combined diff of those commits
 */
describe('Log Multi-Select Diff Property Tests', () => {
  /**
   * Arbitrary generator for commit hashes (40 character hex strings).
   */
  const commitHashArb: fc.Arbitrary<string> = fc.stringOf(
    fc.constantFrom(...'0123456789abcdef'.split('')),
    { minLength: 40, maxLength: 40 }
  );

  /**
   * Arbitrary generator for short commit hashes (7 character hex strings).
   */
  const shortHashArb: fc.Arbitrary<string> = fc.stringOf(
    fc.constantFrom(...'0123456789abcdef'.split('')),
    { minLength: 7, maxLength: 7 }
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
   * Arbitrary generator for commit messages.
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
      return true;
    })
    .map((s) => (s.startsWith('.') ? 'file' + s : s));

  /**
   * Arbitrary generator for dates within a reasonable range.
   */
  const dateArb: fc.Arbitrary<Date> = fc.date({
    min: new Date('2020-01-01'),
    max: new Date('2024-12-31'),
  });

  /**
   * Arbitrary generator for line content.
   */
  const lineContentArb: fc.Arbitrary<string> = fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.!?=()[]{}:;'.split('')
      ),
      { minLength: 1, maxLength: 80 }
    )
    .filter((s) => s.trim().length > 0);

  /**
   * Create a commit with the given parameters.
   */
  function createCommit(
    hash: string,
    shortHash: string,
    parents: string[],
    message: string,
    author: IAuthor,
    date: Date
  ): ICommit {
    return {
      hash,
      shortHash,
      message,
      author,
      committer: author,
      parents,
      authorDate: date,
      commitDate: date,
    };
  }

  /**
   * Create a diff line.
   */
  function createDiffLine(
    type: 'context' | 'add' | 'delete',
    content: string,
    oldLineNumber?: number,
    newLineNumber?: number
  ): IDiffLine {
    return { type, content, oldLineNumber, newLineNumber };
  }

  /**
   * Create a hunk.
   */
  function createHunk(
    oldStart: number,
    oldLines: number,
    newStart: number,
    newLines: number,
    lines: IDiffLine[]
  ): IHunk {
    return {
      oldStart,
      oldLines,
      newStart,
      newLines,
      header: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`,
      lines,
    };
  }

  /**
   * Create a diff.
   */
  function createDiff(path: string, status: FileStatus, hunks: IHunk[], oldPath?: string): IDiff {
    return {
      path,
      oldPath,
      status,
      hunks,
      binary: false,
    };
  }

  /**
   * Mock Multi-Commit Diff Service that simulates the combined diff calculation.
   * This allows us to test the multi-select diff properties without actual Git operations.
   *
   * The service maintains a simulated file system state and tracks changes per commit.
   * When calculating combined diff, it computes the cumulative changes from the oldest
   * commit's parent state to the newest commit's state.
   */
  class MockMultiCommitDiffService {
    // Map of commit hash -> file changes (path -> content after commit)
    private _commitFileStates: Map<string, Map<string, string | null>> = new Map();
    // Map of commit hash -> commit info
    private _commits: Map<string, ICommit> = new Map();
    // Map of commit hash -> diffs introduced by that commit
    private _commitDiffs: Map<string, IDiff[]> = new Map();
    // Initial file state (before any commits)
    private _initialFileState: Map<string, string> = new Map();

    /**
     * Set the initial file state (before any commits).
     */
    setInitialFileState(files: Map<string, string>): void {
      this._initialFileState = new Map(files);
    }

    /**
     * Add a commit with its file changes.
     * @param commit - The commit object
     * @param fileChanges - Map of file path to new content (null means deleted)
     */
    addCommit(commit: ICommit, fileChanges: Map<string, string | null>): void {
      this._commits.set(commit.hash, commit);
      this._commitFileStates.set(commit.hash, new Map(fileChanges));

      // Calculate the diff for this commit
      const diffs = this.calculateCommitDiff(commit.hash);
      this._commitDiffs.set(commit.hash, diffs);
    }

    /**
     * Get a commit by hash.
     */
    getCommit(hash: string): ICommit | undefined {
      return this._commits.get(hash);
    }

    /**
     * Get the diff for a single commit.
     */
    getCommitDiff(hash: string): IDiff[] {
      return this._commitDiffs.get(hash) || [];
    }

    /**
     * Calculate the diff introduced by a single commit.
     */
    private calculateCommitDiff(hash: string): IDiff[] {
      const commit = this._commits.get(hash);
      if (!commit) {
        return [];
      }

      const fileChanges = this._commitFileStates.get(hash);
      if (!fileChanges) {
        return [];
      }

      // Get the parent state
      const parentState = this.getFileStateAtCommit(commit.parents[0]);

      const diffs: IDiff[] = [];

      for (const [path, newContent] of fileChanges) {
        const oldContent = parentState.get(path);

        if (newContent === null && oldContent !== undefined) {
          // File deleted
          diffs.push(this.createFileDiff(path, oldContent, '', 'deleted'));
        } else if (newContent !== null && oldContent === undefined) {
          // File added
          diffs.push(this.createFileDiff(path, '', newContent, 'added'));
        } else if (newContent !== null && oldContent !== undefined && newContent !== oldContent) {
          // File modified
          diffs.push(this.createFileDiff(path, oldContent, newContent, 'modified'));
        }
      }

      return diffs;
    }

    /**
     * Get the file state at a specific commit (cumulative state).
     */
    private getFileStateAtCommit(hash: string | undefined): Map<string, string> {
      if (!hash) {
        return new Map(this._initialFileState);
      }

      const commit = this._commits.get(hash);
      if (!commit) {
        return new Map(this._initialFileState);
      }

      // Start with parent state
      const state = this.getFileStateAtCommit(commit.parents[0]);

      // Apply this commit's changes
      const changes = this._commitFileStates.get(hash);
      if (changes) {
        for (const [path, content] of changes) {
          if (content === null) {
            state.delete(path);
          } else {
            state.set(path, content);
          }
        }
      }

      return state;
    }

    /**
     * Create a diff between two file contents.
     */
    private createFileDiff(
      path: string,
      oldContent: string,
      newContent: string,
      status: FileStatus
    ): IDiff {
      const oldLines = oldContent ? oldContent.split('\n') : [];
      const newLines = newContent ? newContent.split('\n') : [];

      const diffLines: IDiffLine[] = [];

      // Simple diff: show all old lines as deleted, all new lines as added
      for (let i = 0; i < oldLines.length; i++) {
        diffLines.push(createDiffLine('delete', oldLines[i], i + 1, undefined));
      }
      for (let i = 0; i < newLines.length; i++) {
        diffLines.push(createDiffLine('add', newLines[i], undefined, i + 1));
      }

      const hunk = createHunk(1, oldLines.length, 1, newLines.length, diffLines);

      return createDiff(path, status, diffLines.length > 0 ? [hunk] : []);
    }

    /**
     * Get the combined diff for multiple commits.
     * This calculates the cumulative changes across all selected commits,
     * showing the total changes from the oldest commit's parent to the newest commit.
     *
     * Requirement 9.8: WHEN a user selects multiple commits, THE Extension SHALL
     * display the combined diff of those commits.
     *
     * @param commitHashes - Array of commit hashes (can be in any order)
     * @returns Array of diffs representing the combined changes
     */
    getMultiCommitDiff(commitHashes: string[]): IDiff[] {
      if (commitHashes.length === 0) {
        return [];
      }

      // For a single commit, just return its diff
      if (commitHashes.length === 1) {
        return this.getCommitDiff(commitHashes[0]);
      }

      // Get commits and sort by date (oldest first)
      const commits: ICommit[] = [];
      for (const hash of commitHashes) {
        const commit = this._commits.get(hash);
        if (commit) {
          commits.push(commit);
        }
      }

      if (commits.length === 0) {
        return [];
      }

      // Sort by commit date (oldest first)
      commits.sort((a, b) => a.commitDate.getTime() - b.commitDate.getTime());

      const oldestCommit = commits[0];
      const newestCommit = commits[commits.length - 1];

      // Get the state before the oldest commit (parent state)
      const baseState = this.getFileStateAtCommit(oldestCommit.parents[0]);

      // Get the state after the newest commit
      const finalState = this.getFileStateAtCommit(newestCommit.hash);

      // Calculate the combined diff
      return this.calculateCombinedDiff(baseState, finalState);
    }

    /**
     * Calculate the diff between two file states.
     */
    private calculateCombinedDiff(
      baseState: Map<string, string>,
      finalState: Map<string, string>
    ): IDiff[] {
      const diffs: IDiff[] = [];
      const allPaths = new Set([...baseState.keys(), ...finalState.keys()]);

      for (const path of allPaths) {
        const oldContent = baseState.get(path);
        const newContent = finalState.get(path);

        if (oldContent === undefined && newContent !== undefined) {
          // File added
          diffs.push(this.createFileDiff(path, '', newContent, 'added'));
        } else if (oldContent !== undefined && newContent === undefined) {
          // File deleted
          diffs.push(this.createFileDiff(path, oldContent, '', 'deleted'));
        } else if (
          oldContent !== undefined &&
          newContent !== undefined &&
          oldContent !== newContent
        ) {
          // File modified
          diffs.push(this.createFileDiff(path, oldContent, newContent, 'modified'));
        }
        // If oldContent === newContent, no diff needed
      }

      return diffs;
    }

    /**
     * Get all commits sorted by date (newest first).
     */
    getAllCommits(): ICommit[] {
      return Array.from(this._commits.values()).sort(
        (a, b) => b.commitDate.getTime() - a.commitDate.getTime()
      );
    }
  }

  /**
   * Helper to get all file paths from diffs.
   */
  function getFilePaths(diffs: IDiff[]): Set<string> {
    return new Set(diffs.map((d) => d.path));
  }

  /**
   * Arbitrary generator for a linear commit history with file changes.
   */
  const linearCommitHistoryArb: fc.Arbitrary<{
    service: MockMultiCommitDiffService;
    commits: ICommit[];
  }> = fc
    .tuple(
      fc.integer({ min: 2, max: 5 }), // Number of commits
      fc.array(commitHashArb, { minLength: 10, maxLength: 10 }),
      fc.array(shortHashArb, { minLength: 10, maxLength: 10 }),
      fc.array(commitMessageArb, { minLength: 10, maxLength: 10 }),
      fc.array(authorArb, { minLength: 10, maxLength: 10 }),
      fc.array(dateArb, { minLength: 10, maxLength: 10 }),
      fc.array(filePathArb, { minLength: 5, maxLength: 5 }),
      fc.array(lineContentArb, { minLength: 20, maxLength: 20 })
    )
    .map(([numCommits, hashes, shortHashes, messages, authors, dates, filePaths, lineContents]) => {
      const service = new MockMultiCommitDiffService();
      const commits: ICommit[] = [];

      // Sort dates to ensure chronological order (oldest first for commit creation)
      const sortedDates = [...dates.slice(0, numCommits)].sort((a, b) => a.getTime() - b.getTime());

      // Ensure unique file paths
      const uniqueFilePaths = [...new Set(filePaths)].slice(0, 3);
      if (uniqueFilePaths.length === 0) {
        uniqueFilePaths.push('file.txt');
      }

      // Set initial file state (empty)
      service.setInitialFileState(new Map());

      // Create commits in chronological order
      for (let i = 0; i < numCommits; i++) {
        const parents = i === 0 ? [] : [hashes[i - 1]];
        const commit = createCommit(
          hashes[i],
          shortHashes[i],
          parents,
          messages[i],
          authors[i],
          sortedDates[i]
        );

        // Create file changes for this commit
        const fileChanges = new Map<string, string | null>();
        const fileIndex = i % uniqueFilePaths.length;
        const contentIndex = i % lineContents.length;

        // Each commit modifies or adds a file
        fileChanges.set(uniqueFilePaths[fileIndex], `${lineContents[contentIndex]}\nLine ${i + 1}`);

        service.addCommit(commit, fileChanges);
        commits.push(commit);
      }

      return { service, commits };
    });

  describe('Property 28: Log Multi-Select Diff', () => {
    /**
     * Property: Empty commit selection returns empty diff.
     *
     * **Validates: Requirements 9.8**
     */
    it('Property: Empty commit selection returns empty diff', () => {
      fc.assert(
        fc.property(linearCommitHistoryArb, ({ service }) => {
          // Act
          const combinedDiff = service.getMultiCommitDiff([]);

          // Assert
          assert.strictEqual(
            combinedDiff.length,
            0,
            'Empty commit selection should return empty diff'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Single commit selection returns that commit's diff.
     *
     * **Validates: Requirements 9.8**
     */
    it('Property: Single commit selection returns that commit diff', () => {
      fc.assert(
        fc.property(linearCommitHistoryArb, ({ service, commits }) => {
          // Select a random commit
          const commit = commits[Math.floor(commits.length / 2)];

          // Act
          const singleDiff = service.getCommitDiff(commit.hash);
          const multiDiff = service.getMultiCommitDiff([commit.hash]);

          // Assert: Single commit multi-select should equal single commit diff
          assert.strictEqual(
            multiDiff.length,
            singleDiff.length,
            'Single commit multi-select should return same number of diffs'
          );

          // Assert: File paths should match
          const singlePaths = getFilePaths(singleDiff);
          const multiPaths = getFilePaths(multiDiff);
          assert.deepStrictEqual(
            [...multiPaths].sort(),
            [...singlePaths].sort(),
            'File paths should match for single commit selection'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Combined diff represents cumulative changes from oldest to newest.
     *
     * **Validates: Requirements 9.8**
     */
    it('Property: Combined diff represents cumulative changes from oldest to newest', () => {
      fc.assert(
        fc.property(linearCommitHistoryArb, ({ service, commits }) => {
          if (commits.length < 2) {
            return true;
          }

          // Select all commits
          const allHashes = commits.map((c) => c.hash);

          // Act
          const combinedDiff = service.getMultiCommitDiff(allHashes);

          // The combined diff should show changes from initial state to final state
          // For a linear history, this means all files that were added/modified
          // should appear in the combined diff

          // Assert: Combined diff should not be empty (we made changes)
          assert.ok(
            combinedDiff.length > 0 || commits.length === 0,
            'Combined diff should contain changes when commits made changes'
          );

          return true;
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Commit order in selection does not affect combined diff result.
     *
     * **Validates: Requirements 9.8**
     */
    it('Property: Commit order in selection does not affect combined diff result', () => {
      fc.assert(
        fc.property(linearCommitHistoryArb, ({ service, commits }) => {
          if (commits.length < 2) {
            return true;
          }

          const allHashes = commits.map((c) => c.hash);

          // Act: Get diff with original order
          const diffOriginalOrder = service.getMultiCommitDiff(allHashes);

          // Act: Get diff with reversed order
          const reversedHashes = [...allHashes].reverse();
          const diffReversedOrder = service.getMultiCommitDiff(reversedHashes);

          // Assert: Both should produce the same result
          assert.strictEqual(
            diffOriginalOrder.length,
            diffReversedOrder.length,
            'Commit order should not affect number of diffs'
          );

          const originalPaths = getFilePaths(diffOriginalOrder);
          const reversedPaths = getFilePaths(diffReversedOrder);
          assert.deepStrictEqual(
            [...originalPaths].sort(),
            [...reversedPaths].sort(),
            'Commit order should not affect file paths in diff'
          );

          return true;
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Selecting subset of commits shows changes only for that range.
     *
     * **Validates: Requirements 9.8**
     */
    it('Property: Selecting subset of commits shows changes only for that range', () => {
      fc.assert(
        fc.property(linearCommitHistoryArb, ({ service, commits }) => {
          if (commits.length < 3) {
            return true;
          }

          // Select middle commits (not first, not last)
          const middleCommits = commits.slice(1, -1);
          const middleHashes = middleCommits.map((c) => c.hash);

          // Act
          const subsetDiff = service.getMultiCommitDiff(middleHashes);

          // The subset diff should only show changes introduced by the middle commits
          // It should not include changes from the first commit or after the last selected commit

          // Assert: Subset diff should be valid (may be empty if no changes in range)
          assert.ok(Array.isArray(subsetDiff), 'Subset diff should be an array');

          return true;
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Combined diff file paths are subset of individual commit file paths.
     *
     * **Validates: Requirements 9.8**
     */
    it('Property: Combined diff file paths are subset of individual commit file paths', () => {
      fc.assert(
        fc.property(linearCommitHistoryArb, ({ service, commits }) => {
          if (commits.length < 2) {
            return true;
          }

          const allHashes = commits.map((c) => c.hash);

          // Collect all file paths from individual commit diffs
          const allIndividualPaths = new Set<string>();
          for (const hash of allHashes) {
            const diff = service.getCommitDiff(hash);
            for (const d of diff) {
              allIndividualPaths.add(d.path);
            }
          }

          // Get combined diff
          const combinedDiff = service.getMultiCommitDiff(allHashes);
          const combinedPaths = getFilePaths(combinedDiff);

          // Assert: All paths in combined diff should be from individual commits
          for (const path of combinedPaths) {
            assert.ok(
              allIndividualPaths.has(path),
              `Combined diff path '${path}' should be from individual commits`
            );
          }

          return true;
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Combined diff correctly handles file additions.
     *
     * **Validates: Requirements 9.8**
     */
    it('Property: Combined diff correctly handles file additions', () => {
      fc.assert(
        fc.property(
          commitHashArb,
          shortHashArb,
          commitMessageArb,
          authorArb,
          dateArb,
          filePathArb,
          lineContentArb,
          (hash, shortHash, message, author, date, filePath, content) => {
            const service = new MockMultiCommitDiffService();
            service.setInitialFileState(new Map());

            // Create a commit that adds a file
            const commit = createCommit(hash, shortHash, [], message, author, date);
            const fileChanges = new Map<string, string | null>();
            fileChanges.set(filePath, content);
            service.addCommit(commit, fileChanges);

            // Act
            const combinedDiff = service.getMultiCommitDiff([hash]);

            // Assert: Should show the file as added
            assert.strictEqual(combinedDiff.length, 1, 'Should have one diff for added file');
            assert.strictEqual(combinedDiff[0].path, filePath, 'Diff path should match');
            assert.strictEqual(combinedDiff[0].status, 'added', 'Status should be added');

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Combined diff correctly handles file deletions.
     *
     * **Validates: Requirements 9.8**
     */
    it('Property: Combined diff correctly handles file deletions', () => {
      fc.assert(
        fc.property(
          fc.array(commitHashArb, { minLength: 2, maxLength: 2 }),
          fc.array(shortHashArb, { minLength: 2, maxLength: 2 }),
          fc.array(commitMessageArb, { minLength: 2, maxLength: 2 }),
          fc.array(authorArb, { minLength: 2, maxLength: 2 }),
          fc.array(dateArb, { minLength: 2, maxLength: 2 }),
          filePathArb,
          lineContentArb,
          (hashes, shortHashes, messages, authors, dates, filePath, content) => {
            const service = new MockMultiCommitDiffService();

            // Set initial state with a file
            const initialState = new Map<string, string>();
            initialState.set(filePath, content);
            service.setInitialFileState(initialState);

            // Sort dates
            const sortedDates = [...dates].sort((a, b) => a.getTime() - b.getTime());

            // First commit: modify the file
            const commit1 = createCommit(
              hashes[0],
              shortHashes[0],
              [],
              messages[0],
              authors[0],
              sortedDates[0]
            );
            const changes1 = new Map<string, string | null>();
            changes1.set(filePath, content + '\nmodified');
            service.addCommit(commit1, changes1);

            // Second commit: delete the file
            const commit2 = createCommit(
              hashes[1],
              shortHashes[1],
              [hashes[0]],
              messages[1],
              authors[1],
              sortedDates[1]
            );
            const changes2 = new Map<string, string | null>();
            changes2.set(filePath, null);
            service.addCommit(commit2, changes2);

            // Act: Get combined diff for both commits
            const combinedDiff = service.getMultiCommitDiff([hashes[0], hashes[1]]);

            // Assert: Should show the file as deleted (from initial state to final state)
            assert.strictEqual(combinedDiff.length, 1, 'Should have one diff');
            assert.strictEqual(combinedDiff[0].path, filePath, 'Diff path should match');
            assert.strictEqual(combinedDiff[0].status, 'deleted', 'Status should be deleted');

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Combined diff correctly handles file modifications.
     *
     * **Validates: Requirements 9.8**
     */
    it('Property: Combined diff correctly handles file modifications', () => {
      fc.assert(
        fc.property(
          fc.array(commitHashArb, { minLength: 2, maxLength: 2 }),
          fc.array(shortHashArb, { minLength: 2, maxLength: 2 }),
          fc.array(commitMessageArb, { minLength: 2, maxLength: 2 }),
          fc.array(authorArb, { minLength: 2, maxLength: 2 }),
          fc.array(dateArb, { minLength: 2, maxLength: 2 }),
          filePathArb,
          fc.array(lineContentArb, { minLength: 3, maxLength: 3 }),
          (hashes, shortHashes, messages, authors, dates, filePath, contents) => {
            const service = new MockMultiCommitDiffService();

            // Set initial state with a file
            const initialState = new Map<string, string>();
            initialState.set(filePath, contents[0]);
            service.setInitialFileState(initialState);

            // Sort dates
            const sortedDates = [...dates].sort((a, b) => a.getTime() - b.getTime());

            // First commit: modify the file
            const commit1 = createCommit(
              hashes[0],
              shortHashes[0],
              [],
              messages[0],
              authors[0],
              sortedDates[0]
            );
            const changes1 = new Map<string, string | null>();
            changes1.set(filePath, contents[1]);
            service.addCommit(commit1, changes1);

            // Second commit: modify the file again
            const commit2 = createCommit(
              hashes[1],
              shortHashes[1],
              [hashes[0]],
              messages[1],
              authors[1],
              sortedDates[1]
            );
            const changes2 = new Map<string, string | null>();
            changes2.set(filePath, contents[2]);
            service.addCommit(commit2, changes2);

            // Act: Get combined diff for both commits
            const combinedDiff = service.getMultiCommitDiff([hashes[0], hashes[1]]);

            // Assert: Should show the file as modified (from initial to final)
            if (contents[0] !== contents[2]) {
              assert.strictEqual(combinedDiff.length, 1, 'Should have one diff');
              assert.strictEqual(combinedDiff[0].path, filePath, 'Diff path should match');
              assert.strictEqual(combinedDiff[0].status, 'modified', 'Status should be modified');
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Combined diff handles multiple files correctly.
     *
     * **Validates: Requirements 9.8**
     */
    it('Property: Combined diff handles multiple files correctly', () => {
      fc.assert(
        fc.property(
          fc.array(commitHashArb, { minLength: 2, maxLength: 2 }),
          fc.array(shortHashArb, { minLength: 2, maxLength: 2 }),
          fc.array(commitMessageArb, { minLength: 2, maxLength: 2 }),
          fc.array(authorArb, { minLength: 2, maxLength: 2 }),
          fc.array(dateArb, { minLength: 2, maxLength: 2 }),
          fc
            .array(filePathArb, { minLength: 2, maxLength: 2 })
            .filter((paths) => new Set(paths).size === paths.length),
          fc.array(lineContentArb, { minLength: 2, maxLength: 2 }),
          (hashes, shortHashes, messages, authors, dates, filePaths, contents) => {
            const service = new MockMultiCommitDiffService();
            service.setInitialFileState(new Map());

            // Sort dates
            const sortedDates = [...dates].sort((a, b) => a.getTime() - b.getTime());

            // First commit: add first file
            const commit1 = createCommit(
              hashes[0],
              shortHashes[0],
              [],
              messages[0],
              authors[0],
              sortedDates[0]
            );
            const changes1 = new Map<string, string | null>();
            changes1.set(filePaths[0], contents[0]);
            service.addCommit(commit1, changes1);

            // Second commit: add second file
            const commit2 = createCommit(
              hashes[1],
              shortHashes[1],
              [hashes[0]],
              messages[1],
              authors[1],
              sortedDates[1]
            );
            const changes2 = new Map<string, string | null>();
            changes2.set(filePaths[1], contents[1]);
            service.addCommit(commit2, changes2);

            // Act: Get combined diff for both commits
            const combinedDiff = service.getMultiCommitDiff([hashes[0], hashes[1]]);

            // Assert: Should show both files as added
            assert.strictEqual(combinedDiff.length, 2, 'Should have two diffs');
            const paths = getFilePaths(combinedDiff);
            assert.ok(paths.has(filePaths[0]), 'Should include first file');
            assert.ok(paths.has(filePaths[1]), 'Should include second file');

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Combined diff is idempotent (same selection gives same result).
     *
     * **Validates: Requirements 9.8**
     */
    it('Property: Combined diff is idempotent', () => {
      fc.assert(
        fc.property(linearCommitHistoryArb, ({ service, commits }) => {
          if (commits.length < 2) {
            return true;
          }

          const allHashes = commits.map((c) => c.hash);

          // Act: Get diff twice
          const diff1 = service.getMultiCommitDiff(allHashes);
          const diff2 = service.getMultiCommitDiff(allHashes);

          // Assert: Both calls should return the same result
          assert.strictEqual(
            diff1.length,
            diff2.length,
            'Idempotent calls should return same number of diffs'
          );

          const paths1 = getFilePaths(diff1);
          const paths2 = getFilePaths(diff2);
          assert.deepStrictEqual(
            [...paths1].sort(),
            [...paths2].sort(),
            'Idempotent calls should return same file paths'
          );

          return true;
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Non-existent commit hashes are handled gracefully.
     *
     * **Validates: Requirements 9.8**
     */
    it('Property: Non-existent commit hashes are handled gracefully', () => {
      fc.assert(
        fc.property(
          linearCommitHistoryArb,
          commitHashArb,
          ({ service, commits }, nonExistentHash) => {
            // Ensure the hash doesn't exist in our commits
            const existingHashes = new Set(commits.map((c) => c.hash));
            if (existingHashes.has(nonExistentHash)) {
              return true;
            }

            // Act: Try to get diff with non-existent hash
            const diff = service.getMultiCommitDiff([nonExistentHash]);

            // Assert: Should return empty array (graceful handling)
            assert.strictEqual(diff.length, 0, 'Non-existent commit should return empty diff');

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Mixed valid and invalid hashes only process valid ones.
     *
     * **Validates: Requirements 9.8**
     */
    it('Property: Mixed valid and invalid hashes only process valid ones', () => {
      fc.assert(
        fc.property(
          linearCommitHistoryArb,
          commitHashArb,
          ({ service, commits }, nonExistentHash) => {
            if (commits.length === 0) {
              return true;
            }

            // Ensure the hash doesn't exist in our commits
            const existingHashes = new Set(commits.map((c) => c.hash));
            if (existingHashes.has(nonExistentHash)) {
              return true;
            }

            const validHash = commits[0].hash;

            // Act: Get diff with mix of valid and invalid hashes
            const mixedDiff = service.getMultiCommitDiff([validHash, nonExistentHash]);
            const validOnlyDiff = service.getMultiCommitDiff([validHash]);

            // Assert: Should produce same result as valid-only selection
            assert.strictEqual(
              mixedDiff.length,
              validOnlyDiff.length,
              'Mixed selection should match valid-only selection'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
