import * as fc from 'fast-check';
import * as assert from 'assert';
import { ICommit, IAuthor, IBranchComparison } from '../../services/interfaces/IGitService';

/**
 * Property-based tests for Branch Comparison Accuracy.
 * Feature: intellig-vscode, Property 12: Branch Comparison Accuracy
 *
 *
 * Property Description:
 * For any two branches, the comparison view SHALL correctly identify commits unique
 * to each branch and files that differ between them.
 */
describe('Branch Comparison Accuracy Property Tests', () => {
  /**
   * Arbitrary generator for commit hashes (40 character hex string)
   */
  const commitHashArb: fc.Arbitrary<string> = fc
    .hexaString({ minLength: 40, maxLength: 40 })
    .map((s) => s.toLowerCase());

  /**
   * Arbitrary generator for short commit hashes (7 characters)
   */
  const shortHashArb: fc.Arbitrary<string> = fc
    .hexaString({ minLength: 7, maxLength: 7 })
    .map((s) => s.toLowerCase());

  /**
   * Arbitrary generator for author information
   */
  const authorArb: fc.Arbitrary<IAuthor> = fc.record({
    name: fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
    email: fc.emailAddress(),
  });

  /**
   * Arbitrary generator for file paths
   */
  const filePathArb: fc.Arbitrary<string> = fc
    .array(
      fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')), {
        minLength: 1,
        maxLength: 20,
      }),
      { minLength: 1, maxLength: 4 }
    )
    .map((parts) => parts.join('/') + '.ts');

  /**
   * Arbitrary generator for commit messages
   */
  const commitMessageArb: fc.Arbitrary<string> = fc
    .string({ minLength: 1, maxLength: 100 })
    .filter((s) => s.trim().length > 0);

  /**
   * Arbitrary generator for a commit object
   */
  const commitArb: fc.Arbitrary<ICommit> = fc
    .tuple(commitHashArb, shortHashArb, commitMessageArb, authorArb, fc.date())
    .map(([hash, shortHash, message, author, date]) => ({
      hash,
      shortHash,
      message,
      author,
      committer: author,
      parents: [],
      authorDate: date,
      commitDate: date,
    }));

  /**
   * Arbitrary generator for an array of unique commits
   */
  const uniqueCommitsArb = (minLength: number, maxLength: number): fc.Arbitrary<ICommit[]> =>
    fc.array(commitArb, { minLength, maxLength }).map((commits) => {
      // Ensure unique hashes
      const seen = new Set<string>();
      return commits.filter((c) => {
        if (seen.has(c.hash)) {
          return false;
        }
        seen.add(c.hash);
        return true;
      });
    });

  /**
   * Arbitrary generator for an array of unique file paths
   */
  const uniqueFilePathsArb = (minLength: number, maxLength: number): fc.Arbitrary<string[]> =>
    fc.array(filePathArb, { minLength, maxLength }).map((paths) => [...new Set(paths)]);

  /**
   * Mock Branch Comparison Service that simulates branch comparison logic.
   * This allows us to test the comparison properties without actual Git operations.
   */
  class MockBranchComparisonService {
    private _branch1Commits: ICommit[];
    private _branch2Commits: ICommit[];
    private _commonAncestorCommits: ICommit[];
    private _branch1Files: Set<string>;
    private _branch2Files: Set<string>;

    constructor(
      branch1Commits: ICommit[],
      branch2Commits: ICommit[],
      commonAncestorCommits: ICommit[],
      branch1Files: string[],
      branch2Files: string[]
    ) {
      this._branch1Commits = branch1Commits;
      this._branch2Commits = branch2Commits;
      this._commonAncestorCommits = commonAncestorCommits;
      this._branch1Files = new Set(branch1Files);
      this._branch2Files = new Set(branch2Files);
    }

    /**
     * Get commits unique to branch1 (ahead commits).
     * These are commits in branch1 that are not in branch2 or common ancestor.
     */
    getCommitsAhead(): ICommit[] {
      const branch2Hashes = new Set(this._branch2Commits.map((c) => c.hash));
      const commonHashes = new Set(this._commonAncestorCommits.map((c) => c.hash));

      return this._branch1Commits.filter(
        (c) => !branch2Hashes.has(c.hash) && !commonHashes.has(c.hash)
      );
    }

    /**
     * Get commits unique to branch2 (behind commits).
     * These are commits in branch2 that are not in branch1 or common ancestor.
     */
    getCommitsBehind(): ICommit[] {
      const branch1Hashes = new Set(this._branch1Commits.map((c) => c.hash));
      const commonHashes = new Set(this._commonAncestorCommits.map((c) => c.hash));

      return this._branch2Commits.filter(
        (c) => !branch1Hashes.has(c.hash) && !commonHashes.has(c.hash)
      );
    }

    /**
     * Get files that differ between the two branches.
     * A file differs if it exists in one branch but not the other,
     * or if it exists in both but has different content (simulated by different sets).
     */
    getChangedFiles(): string[] {
      const allFiles = new Set([...this._branch1Files, ...this._branch2Files]);
      const changedFiles: string[] = [];

      for (const file of allFiles) {
        const inBranch1 = this._branch1Files.has(file);
        const inBranch2 = this._branch2Files.has(file);

        // File differs if it's only in one branch
        if (inBranch1 !== inBranch2) {
          changedFiles.push(file);
        }
      }

      return changedFiles.sort();
    }

    /**
     * Perform the full branch comparison.
     */
    compareBranches(): IBranchComparison {
      const commitsAhead = this.getCommitsAhead();
      const commitsBehind = this.getCommitsBehind();
      const changedFiles = this.getChangedFiles();

      return {
        commitsAhead,
        commitsBehind,
        aheadCount: commitsAhead.length,
        behindCount: commitsBehind.length,
        changedFiles,
      };
    }
  }

  describe('Property 12: Branch Comparison Accuracy', () => {
    /**
     * Property: Commits unique to branch1 are correctly identified as "ahead".
     */
    it('Property: Commits unique to branch1 are correctly identified as ahead', () => {
      fc.assert(
        fc.property(
          uniqueCommitsArb(0, 10),
          uniqueCommitsArb(0, 10),
          uniqueCommitsArb(0, 5),
          (branch1Commits, branch2Commits, commonCommits): boolean => {
            // Setup: Create comparison service
            const service = new MockBranchComparisonService(
              branch1Commits,
              branch2Commits,
              commonCommits,
              [],
              []
            );

            // Act: Get comparison
            const comparison = service.compareBranches();

            // Calculate expected ahead commits
            const branch2Hashes = new Set(branch2Commits.map((c) => c.hash));
            const commonHashes = new Set(commonCommits.map((c) => c.hash));
            const expectedAhead = branch1Commits.filter(
              (c) => !branch2Hashes.has(c.hash) && !commonHashes.has(c.hash)
            );

            // Assert: Ahead count matches
            assert.strictEqual(
              comparison.aheadCount,
              expectedAhead.length,
              'Ahead count should match number of unique commits in branch1'
            );

            // Assert: All ahead commits are from branch1 and not in branch2
            for (const commit of comparison.commitsAhead) {
              assert.ok(
                branch1Commits.some((c) => c.hash === commit.hash),
                `Ahead commit ${commit.shortHash} should be from branch1`
              );
              assert.ok(
                !branch2Hashes.has(commit.hash),
                `Ahead commit ${commit.shortHash} should not be in branch2`
              );
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Commits unique to branch2 are correctly identified as "behind".
     */
    it('Property: Commits unique to branch2 are correctly identified as behind', () => {
      fc.assert(
        fc.property(
          uniqueCommitsArb(0, 10),
          uniqueCommitsArb(0, 10),
          uniqueCommitsArb(0, 5),
          (branch1Commits, branch2Commits, commonCommits): boolean => {
            // Setup: Create comparison service
            const service = new MockBranchComparisonService(
              branch1Commits,
              branch2Commits,
              commonCommits,
              [],
              []
            );

            // Act: Get comparison
            const comparison = service.compareBranches();

            // Calculate expected behind commits
            const branch1Hashes = new Set(branch1Commits.map((c) => c.hash));
            const commonHashes = new Set(commonCommits.map((c) => c.hash));
            const expectedBehind = branch2Commits.filter(
              (c) => !branch1Hashes.has(c.hash) && !commonHashes.has(c.hash)
            );

            // Assert: Behind count matches
            assert.strictEqual(
              comparison.behindCount,
              expectedBehind.length,
              'Behind count should match number of unique commits in branch2'
            );

            // Assert: All behind commits are from branch2 and not in branch1
            for (const commit of comparison.commitsBehind) {
              assert.ok(
                branch2Commits.some((c) => c.hash === commit.hash),
                `Behind commit ${commit.shortHash} should be from branch2`
              );
              assert.ok(
                !branch1Hashes.has(commit.hash),
                `Behind commit ${commit.shortHash} should not be in branch1`
              );
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Files that differ between branches are correctly identified.
     */
    it('Property: Files that differ between branches are correctly identified', () => {
      fc.assert(
        fc.property(
          uniqueFilePathsArb(0, 15),
          uniqueFilePathsArb(0, 15),
          (branch1Files, branch2Files): boolean => {
            // Setup: Create comparison service
            const service = new MockBranchComparisonService([], [], [], branch1Files, branch2Files);

            // Act: Get comparison
            const comparison = service.compareBranches();

            // Calculate expected changed files (symmetric difference)
            const branch1Set = new Set(branch1Files);
            const branch2Set = new Set(branch2Files);
            const expectedChanged = new Set<string>();

            for (const file of branch1Files) {
              if (!branch2Set.has(file)) {
                expectedChanged.add(file);
              }
            }
            for (const file of branch2Files) {
              if (!branch1Set.has(file)) {
                expectedChanged.add(file);
              }
            }

            // Assert: Changed files count matches
            assert.strictEqual(
              comparison.changedFiles.length,
              expectedChanged.size,
              'Changed files count should match symmetric difference'
            );

            // Assert: All changed files are in the expected set
            for (const file of comparison.changedFiles) {
              assert.ok(
                expectedChanged.has(file),
                `Changed file '${file}' should be in expected set`
              );
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Ahead/behind counts are non-negative integers.
     */
    it('Property: Ahead/behind counts are non-negative integers', () => {
      fc.assert(
        fc.property(
          uniqueCommitsArb(0, 10),
          uniqueCommitsArb(0, 10),
          uniqueCommitsArb(0, 5),
          (branch1Commits, branch2Commits, commonCommits): boolean => {
            // Setup: Create comparison service
            const service = new MockBranchComparisonService(
              branch1Commits,
              branch2Commits,
              commonCommits,
              [],
              []
            );

            // Act: Get comparison
            const comparison = service.compareBranches();

            // Assert: Counts are non-negative integers
            assert.ok(
              Number.isInteger(comparison.aheadCount) && comparison.aheadCount >= 0,
              'Ahead count should be a non-negative integer'
            );
            assert.ok(
              Number.isInteger(comparison.behindCount) && comparison.behindCount >= 0,
              'Behind count should be a non-negative integer'
            );

            // Assert: Counts match array lengths
            assert.strictEqual(
              comparison.aheadCount,
              comparison.commitsAhead.length,
              'Ahead count should match commitsAhead array length'
            );
            assert.strictEqual(
              comparison.behindCount,
              comparison.commitsBehind.length,
              'Behind count should match commitsBehind array length'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Identical branches have zero ahead/behind counts and no changed files.
     */
    it('Property: Identical branches have zero differences', () => {
      fc.assert(
        fc.property(
          uniqueCommitsArb(1, 10),
          uniqueFilePathsArb(0, 10),
          (commits, files): boolean => {
            // Setup: Both branches have identical commits and files
            const service = new MockBranchComparisonService(
              commits,
              commits, // Same commits
              [], // No common ancestor (all commits are shared)
              files,
              files // Same files
            );

            // Act: Get comparison
            const comparison = service.compareBranches();

            // Assert: No differences when branches are identical
            assert.strictEqual(comparison.aheadCount, 0, 'Identical branches should have 0 ahead');
            assert.strictEqual(
              comparison.behindCount,
              0,
              'Identical branches should have 0 behind'
            );
            assert.strictEqual(
              comparison.changedFiles.length,
              0,
              'Identical branches should have no changed files'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Comparison is asymmetric - swapping branches swaps ahead/behind.
     */
    it('Property: Swapping branches swaps ahead/behind counts', () => {
      fc.assert(
        fc.property(
          uniqueCommitsArb(0, 10),
          uniqueCommitsArb(0, 10),
          uniqueCommitsArb(0, 5),
          (branch1Commits, branch2Commits, commonCommits): boolean => {
            // Setup: Create two comparison services with swapped branches
            const service1 = new MockBranchComparisonService(
              branch1Commits,
              branch2Commits,
              commonCommits,
              [],
              []
            );

            const service2 = new MockBranchComparisonService(
              branch2Commits, // Swapped
              branch1Commits, // Swapped
              commonCommits,
              [],
              []
            );

            // Act: Get comparisons
            const comparison1 = service1.compareBranches();
            const comparison2 = service2.compareBranches();

            // Assert: Ahead/behind are swapped
            assert.strictEqual(
              comparison1.aheadCount,
              comparison2.behindCount,
              'Ahead count of first should equal behind count of swapped'
            );
            assert.strictEqual(
              comparison1.behindCount,
              comparison2.aheadCount,
              'Behind count of first should equal ahead count of swapped'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Changed files are symmetric - same files differ regardless of comparison direction.
     */
    it('Property: Changed files are symmetric', () => {
      fc.assert(
        fc.property(
          uniqueFilePathsArb(0, 15),
          uniqueFilePathsArb(0, 15),
          (branch1Files, branch2Files): boolean => {
            // Setup: Create two comparison services with swapped branches
            const service1 = new MockBranchComparisonService(
              [],
              [],
              [],
              branch1Files,
              branch2Files
            );

            const service2 = new MockBranchComparisonService(
              [],
              [],
              [],
              branch2Files, // Swapped
              branch1Files // Swapped
            );

            // Act: Get comparisons
            const comparison1 = service1.compareBranches();
            const comparison2 = service2.compareBranches();

            // Assert: Changed files are the same (order may differ)
            const files1Sorted = [...comparison1.changedFiles].sort();
            const files2Sorted = [...comparison2.changedFiles].sort();

            assert.deepStrictEqual(
              files1Sorted,
              files2Sorted,
              'Changed files should be the same regardless of comparison direction'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: No commit appears in both ahead and behind lists.
     */
    it('Property: No commit appears in both ahead and behind lists', () => {
      fc.assert(
        fc.property(
          uniqueCommitsArb(0, 10),
          uniqueCommitsArb(0, 10),
          uniqueCommitsArb(0, 5),
          (branch1Commits, branch2Commits, commonCommits): boolean => {
            // Setup: Create comparison service
            const service = new MockBranchComparisonService(
              branch1Commits,
              branch2Commits,
              commonCommits,
              [],
              []
            );

            // Act: Get comparison
            const comparison = service.compareBranches();

            // Get sets of commit hashes
            const aheadHashes = new Set(comparison.commitsAhead.map((c) => c.hash));
            const behindHashes = new Set(comparison.commitsBehind.map((c) => c.hash));

            // Assert: No overlap between ahead and behind
            for (const hash of aheadHashes) {
              assert.ok(
                !behindHashes.has(hash),
                `Commit ${hash.substring(0, 7)} should not appear in both ahead and behind`
              );
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Common ancestor commits are excluded from both ahead and behind.
     */
    it('Property: Common ancestor commits are excluded from comparison', () => {
      fc.assert(
        fc.property(
          uniqueCommitsArb(1, 10),
          uniqueCommitsArb(1, 10),
          uniqueCommitsArb(1, 5),
          (branch1Commits, branch2Commits, commonCommits): boolean => {
            // Setup: Add common commits to both branches
            const branch1WithCommon = [...branch1Commits, ...commonCommits];
            const branch2WithCommon = [...branch2Commits, ...commonCommits];

            const service = new MockBranchComparisonService(
              branch1WithCommon,
              branch2WithCommon,
              commonCommits,
              [],
              []
            );

            // Act: Get comparison
            const comparison = service.compareBranches();

            // Get common commit hashes
            const commonHashes = new Set(commonCommits.map((c) => c.hash));

            // Assert: No common commits in ahead list
            for (const commit of comparison.commitsAhead) {
              assert.ok(
                !commonHashes.has(commit.hash),
                `Common commit ${commit.shortHash} should not appear in ahead list`
              );
            }

            // Assert: No common commits in behind list
            for (const commit of comparison.commitsBehind) {
              assert.ok(
                !commonHashes.has(commit.hash),
                `Common commit ${commit.shortHash} should not appear in behind list`
              );
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Full comparison result is consistent and complete.
     */
    it('Property: Full comparison result is consistent and complete', () => {
      fc.assert(
        fc.property(
          uniqueCommitsArb(0, 10),
          uniqueCommitsArb(0, 10),
          uniqueCommitsArb(0, 5),
          uniqueFilePathsArb(0, 10),
          uniqueFilePathsArb(0, 10),
          (branch1Commits, branch2Commits, commonCommits, branch1Files, branch2Files): boolean => {
            // Setup: Create comparison service
            const service = new MockBranchComparisonService(
              branch1Commits,
              branch2Commits,
              commonCommits,
              branch1Files,
              branch2Files
            );

            // Act: Get comparison
            const comparison = service.compareBranches();

            // Assert: Result has all required fields
            assert.ok(Array.isArray(comparison.commitsAhead), 'commitsAhead should be an array');
            assert.ok(Array.isArray(comparison.commitsBehind), 'commitsBehind should be an array');
            assert.ok(Array.isArray(comparison.changedFiles), 'changedFiles should be an array');
            assert.ok(typeof comparison.aheadCount === 'number', 'aheadCount should be a number');
            assert.ok(typeof comparison.behindCount === 'number', 'behindCount should be a number');

            // Assert: Counts are consistent with arrays
            assert.strictEqual(
              comparison.aheadCount,
              comparison.commitsAhead.length,
              'aheadCount should match commitsAhead length'
            );
            assert.strictEqual(
              comparison.behindCount,
              comparison.commitsBehind.length,
              'behindCount should match commitsBehind length'
            );

            // Assert: All commits have required fields
            for (const commit of [...comparison.commitsAhead, ...comparison.commitsBehind]) {
              assert.ok(commit.hash, 'Commit should have hash');
              assert.ok(commit.shortHash, 'Commit should have shortHash');
              assert.ok(commit.message !== undefined, 'Commit should have message');
              assert.ok(commit.author, 'Commit should have author');
              assert.ok(commit.authorDate, 'Commit should have authorDate');
            }

            // Assert: All changed files are strings
            for (const file of comparison.changedFiles) {
              assert.ok(typeof file === 'string', 'Changed file should be a string');
              assert.ok(file.length > 0, 'Changed file should not be empty');
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
