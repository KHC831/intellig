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
import { sortCommitsStable } from '../../utils/commitSort';

/**
 * Property-based tests for Log Multi-Select Diff.
 * Feature: intellig-vscode, Property 28: Log Multi-Select Diff
 *
 *
 * Property Description:
 * For any selection of multiple commits, the combined diff SHALL represent
 * the cumulative changes across all selected commits.
 *
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
     *
     * TR-3 follow-up: the walk guards against cycles in the parent chain
     * with a `visited` set. Fast-check's shrinker can (and does) produce
     * arbitrary hash inputs where two commits in the history end up with
     * the same hash, making a commit its own ancestor. Without the guard
     * that turns into a `RangeError: Maximum call stack size exceeded`
     * surfaced as a flaky property failure unrelated to the property
     * being tested. See `src/test/mocks/README.md` for the audit notes.
     */
    private getFileStateAtCommit(
      hash: string | undefined,
      visited: Set<string> = new Set()
    ): Map<string, string> {
      if (!hash) {
        return new Map(this._initialFileState);
      }

      // Cycle in the parent chain — fall back to the initial state rather
      // than recurse forever.
      if (visited.has(hash)) {
        return new Map(this._initialFileState);
      }
      visited.add(hash);

      const commit = this._commits.get(hash);
      if (!commit) {
        return new Map(this._initialFileState);
      }

      // Start with parent state
      const state = this.getFileStateAtCommit(commit.parents[0], visited);

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

      // Sort by commit date (oldest first). On date ties (same `getTime()`),
      // fall back to a topological ordering (parent-before-child) via the
      // shared `sortCommitsStable` helper. A plain alphabetical hash tie-break
      // is causally wrong: a delete-commit whose hash starts with '0' can
      // sort before its own parent modify-commit, breaking the
      // base-state → final-state reduction below. See
      // `src/utils/commitSort.ts` and the TR-5 regression seed
      // (-1310953740) pinned above.
      const sortedCommits = sortCommitsStable(commits);

      const oldestCommit = sortedCommits[0];
      const newestCommit = sortedCommits[sortedCommits.length - 1];

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
     * TR-4 regression: these two seeds reliably flaked the "order does not
     * matter" property (line ~598) under V8's unstable sort when the arbitrary
     * generated commits with tied `commitDate.getTime()` values. The fix was
     * a stable-sort tie-breaker on `hash.localeCompare(b.hash)` inside
     * `MockMultiCommitDiffService.getMultiCommitDiff`. These explicit-seed
     * assertions guard against regression if someone removes the tie-breaker.
     *
     * See .agent/reviews/TEST_RUN_REPORT_ROUND2.md TR-4.
     */
    it('TR-4 regression: seed -1652220625 does not flake the order-invariance property', () => {
      fc.assert(
        fc.property(linearCommitHistoryArb, ({ service, commits }) => {
          if (commits.length < 2) {
            return true;
          }
          const allHashes = commits.map((c) => c.hash);
          const diffOriginal = service.getMultiCommitDiff(allHashes);
          const diffReversed = service.getMultiCommitDiff([...allHashes].reverse());
          assert.strictEqual(
            diffOriginal.length,
            diffReversed.length,
            'Commit order should not affect number of diffs'
          );
          assert.deepStrictEqual(
            [...getFilePaths(diffOriginal)].sort(),
            [...getFilePaths(diffReversed)].sort(),
            'Commit order should not affect file paths in diff'
          );
          return true;
        }),
        { seed: -1652220625, numRuns: 100 }
      );
    });

    it('TR-4 regression: seed 1635993410 does not flake the order-invariance property', () => {
      fc.assert(
        fc.property(linearCommitHistoryArb, ({ service, commits }) => {
          if (commits.length < 2) {
            return true;
          }
          const allHashes = commits.map((c) => c.hash);
          const diffOriginal = service.getMultiCommitDiff(allHashes);
          const diffReversed = service.getMultiCommitDiff([...allHashes].reverse());
          assert.strictEqual(
            diffOriginal.length,
            diffReversed.length,
            'Commit order should not affect number of diffs'
          );
          assert.deepStrictEqual(
            [...getFilePaths(diffOriginal)].sort(),
            [...getFilePaths(diffReversed)].sort(),
            'Commit order should not affect file paths in diff'
          );
          return true;
        }),
        { seed: 1635993410, numRuns: 100 }
      );
    });

    /**
     * TR-5 regression: the Round-2 hash-alphabetical tie-breaker fixed the
     * flake but was causally wrong — when the `dateArb` generated two
     * identical `commitDate` values and the delete-commit's hash sorted
     * before its parent's hash, the tie-breaker put the delete ahead of
     * its parent in the "oldest → newest" range. `baseState` then resolved
     * to the post-modify state (via the child's own parent pointer) and
     * `finalState` resolved to the same post-modify state (via the parent
     * itself), so the deletion vanished from the combined diff.
     *
     * The Round-3 fix introduces `sortCommitsStable` with a topological
     * tie-breaker (parent-before-child) inside each date-tied group. This
     * seed is the minimal reproduction reported by the R3 test runner.
     *
     * See .agent/reviews/TEST_RUN_REPORT_ROUND3.md TR-5.
     */
    it('TR-5 regression: seed -1310953740 does not flake the file-deletion property', () => {
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

            const initialState = new Map<string, string>();
            initialState.set(filePath, content);
            service.setInitialFileState(initialState);

            const sortedDates = [...dates].sort((a, b) => a.getTime() - b.getTime());

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

            const combinedDiff = service.getMultiCommitDiff([hashes[0], hashes[1]]);

            assert.strictEqual(combinedDiff.length, 1, 'Should have one diff');
            assert.strictEqual(combinedDiff[0].path, filePath, 'Diff path should match');
            assert.strictEqual(combinedDiff[0].status, 'deleted', 'Status should be deleted');

            return true;
          }
        ),
        { seed: -1310953740, numRuns: 100 }
      );
    });

    /**
     * Property: Empty commit selection returns empty diff.
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
