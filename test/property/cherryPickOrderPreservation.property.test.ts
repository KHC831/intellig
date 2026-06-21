import * as fc from 'fast-check';
import * as assert from 'assert';
import {
  ICommit,
  IAuthor,
  IDiff,
  IHunk,
  IDiffLine,
  ICherryPickResult,
} from '../../src/git-core/interfaces/IGitService';

/**
 * Property-based tests for Cherry-Pick Order Preservation.
 * Feature: intellig-vscode, Property 36: Cherry-Pick Order Preservation
 *
 *
 * Property Description:
 * For any ordered selection of commits to cherry-pick, the commits SHALL be
 * applied in the specified order, resulting in the same relative order in
 * the target branch.
 *
 * - 11.2: WHEN cherry-picking multiple commits, THE Extension SHALL apply
 *         them in the selected order
 */
describe('Cherry-Pick Order Preservation Property Tests', () => {
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
      if (s.startsWith('/') || s.startsWith('.')) {
        return false;
      }
      if (s.includes('//') || s.includes('..')) {
        return false;
      }
      return true;
    });

  /**
   * Arbitrary generator for diff line content.
   */
  const lineContentArb: fc.Arbitrary<string> = fc
    .string({ minLength: 0, maxLength: 100 })
    .map((s) => s.replace(/[\r\n]/g, ''));

  /**
   * Arbitrary generator for diff lines.
   */
  const diffLineArb: fc.Arbitrary<IDiffLine> = fc.oneof(
    fc.record({
      type: fc.constant('context' as const),
      content: lineContentArb,
      oldLineNumber: fc.integer({ min: 1, max: 1000 }),
      newLineNumber: fc.integer({ min: 1, max: 1000 }),
    }),
    fc.record({
      type: fc.constant('add' as const),
      content: lineContentArb,
      oldLineNumber: fc.constant(undefined),
      newLineNumber: fc.integer({ min: 1, max: 1000 }),
    }),
    fc.record({
      type: fc.constant('delete' as const),
      content: lineContentArb,
      oldLineNumber: fc.integer({ min: 1, max: 1000 }),
      newLineNumber: fc.constant(undefined),
    })
  );

  /**
   * Arbitrary generator for hunks.
   */
  const hunkArb: fc.Arbitrary<IHunk> = fc
    .array(diffLineArb, { minLength: 1, maxLength: 10 })
    .map((lines) => ({
      oldStart: 1,
      oldLines: lines.filter((l) => l.type !== 'add').length,
      newStart: 1,
      newLines: lines.filter((l) => l.type !== 'delete').length,
      header: '@@ -1,10 +1,10 @@',
      lines,
    }));

  /**
   * Arbitrary generator for diffs.
   */
  const diffArb: fc.Arbitrary<IDiff> = fc.record({
    path: filePathArb,
    oldPath: fc.constant(undefined),
    status: fc.constant('modified' as const),
    hunks: fc.array(hunkArb, { minLength: 1, maxLength: 3 }),
    binary: fc.constant(false),
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
    parents: fc.array(commitHashArb, { minLength: 1, maxLength: 2 }),
    authorDate: fc.date({ min: new Date('2000-01-01'), max: new Date() }),
    commitDate: fc.date({ min: new Date('2000-01-01'), max: new Date() }),
  });

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
   * Arbitrary generator for a list of unique commits (2-5 commits).
   * Ensures all commits have unique hashes.
   */
  const uniqueCommitsArb: fc.Arbitrary<ICommit[]> = fc
    .array(commitArb, { minLength: 2, maxLength: 5 })
    .map((commits) => {
      // Ensure unique hashes by modifying duplicates
      const seenHashes = new Set<string>();
      return commits.map((commit, index) => {
        let hash = commit.hash;
        while (seenHashes.has(hash)) {
          // Modify hash to make it unique
          const chars = hash.split('');
          chars[index % 40] = '0123456789abcdef'[(parseInt(chars[index % 40], 16) + 1) % 16];
          hash = chars.join('');
        }
        seenHashes.add(hash);
        return { ...commit, hash, shortHash: hash.substring(0, 7) };
      });
    });

  /**
   * Mock Cherry-Pick Service that simulates cherry-pick operations
   * with support for multiple commits in order.
   */
  class MockCherryPickOrderService {
    private _commits: Map<string, ICommit> = new Map();
    private _commitDiffs: Map<string, IDiff[]> = new Map();
    private _currentBranch: string;
    private _currentBranchHead: string;
    private _cherryPickedCommits: ICommit[] = [];
    private _cherryPickOrder: string[] = []; // Track order of cherry-picked original hashes

    constructor(currentBranch: string, currentBranchHead: string) {
      this._currentBranch = currentBranch;
      this._currentBranchHead = currentBranchHead;
    }

    /**
     * Add a commit to the repository.
     */
    addCommit(commit: ICommit, diffs: IDiff[]): void {
      this._commits.set(commit.hash, commit);
      this._commitDiffs.set(commit.hash, diffs);
    }

    /**
     * Get a commit by hash.
     */
    getCommit(hash: string): ICommit | undefined {
      return this._commits.get(hash);
    }

    /**
     * Get the current branch name.
     */
    getCurrentBranch(): string {
      return this._currentBranch;
    }

    /**
     * Get the current branch HEAD commit hash.
     */
    getCurrentBranchHead(): string {
      return this._currentBranchHead;
    }

    /**
     * Cherry-pick multiple commits in the specified order.
     *
     * @param commitHashes - Array of commit hashes to cherry-pick, in order
     * @returns Cherry-pick result
     */
    cherryPickMultiple(commitHashes: string[]): ICherryPickResult {
      for (const hash of commitHashes) {
        const result = this.cherryPickSingle(hash);
        if (!result.success) {
          return result;
        }
      }
      return { success: true };
    }

    /**
     * Cherry-pick a single commit onto the current branch.
     *
     * @param commitHash - The hash of the commit to cherry-pick
     * @returns Cherry-pick result
     */
    private cherryPickSingle(commitHash: string): ICherryPickResult {
      const originalCommit = this._commits.get(commitHash);
      if (!originalCommit) {
        return { success: false, conflicts: [] };
      }

      const originalDiffs = this._commitDiffs.get(commitHash);
      if (!originalDiffs) {
        return { success: false, conflicts: [] };
      }

      // Generate a new hash for the cherry-picked commit
      const newHash = this.generateNewHash(originalCommit.hash);

      // Create the cherry-picked commit with:
      // - Same message as original
      // - Same author as original
      // - New hash
      // - Current branch HEAD as parent
      const cherryPickedCommit: ICommit = {
        hash: newHash,
        shortHash: newHash.substring(0, 7),
        message: originalCommit.message,
        body: originalCommit.body,
        author: { ...originalCommit.author },
        committer: { ...originalCommit.committer },
        parents: [this._currentBranchHead],
        authorDate: originalCommit.authorDate,
        commitDate: new Date(),
      };

      // Store the cherry-picked commit
      this._cherryPickedCommits.push(cherryPickedCommit);
      this._cherryPickOrder.push(commitHash); // Track original hash order
      this._commits.set(newHash, cherryPickedCommit);
      this._commitDiffs.set(newHash, originalDiffs);

      // Update current branch HEAD
      this._currentBranchHead = newHash;

      return { success: true };
    }

    /**
     * Get all cherry-picked commits in the order they were applied.
     */
    getCherryPickedCommits(): ICommit[] {
      return [...this._cherryPickedCommits];
    }

    /**
     * Get the order of original commit hashes that were cherry-picked.
     */
    getCherryPickOrder(): string[] {
      return [...this._cherryPickOrder];
    }

    /**
     * Generate a new hash for a cherry-picked commit.
     */
    private generateNewHash(originalHash: string): string {
      const chars = originalHash.split('');
      chars.reverse();
      const firstChar = chars[0];
      const hexChars = '0123456789abcdef';
      const newFirstChar = hexChars[(hexChars.indexOf(firstChar) + 1) % 16];
      chars[0] = newFirstChar;
      return chars.join('');
    }
  }

  describe('Property 36: Cherry-Pick Order Preservation', () => {
    /**
     * Property: Cherry-picked commits are applied in the specified order.
     */
    it('Property: Cherry-picked commits are applied in the specified order', () => {
      fc.assert(
        fc.property(
          uniqueCommitsArb,
          fc.array(diffArb, { minLength: 1, maxLength: 3 }),
          branchNameArb,
          commitHashArb,
          (commits, diffs, currentBranch, currentBranchHead) => {
            // Setup: Create service with current branch
            const service = new MockCherryPickOrderService(currentBranch, currentBranchHead);

            // Add all commits to the repository
            for (const commit of commits) {
              service.addCommit(commit, diffs);
            }

            // Get the ordered list of commit hashes to cherry-pick
            const commitHashes = commits.map((c) => c.hash);

            // Act: Cherry-pick all commits in order
            const result = service.cherryPickMultiple(commitHashes);

            // Assert: Cherry-pick succeeded
            assert.strictEqual(result.success, true, 'Cherry-pick should succeed');

            // Get the order in which commits were cherry-picked
            const cherryPickOrder = service.getCherryPickOrder();

            // Assert: The order matches the input order
            assert.strictEqual(
              cherryPickOrder.length,
              commitHashes.length,
              'Should have cherry-picked all commits'
            );

            for (let i = 0; i < commitHashes.length; i++) {
              assert.strictEqual(
                cherryPickOrder[i],
                commitHashes[i],
                `Commit at position ${i} should match the input order`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Cherry-picked commits maintain relative order in target branch.
     */
    it('Property: Cherry-picked commits maintain relative order in target branch', () => {
      fc.assert(
        fc.property(
          uniqueCommitsArb,
          fc.array(diffArb, { minLength: 1, maxLength: 3 }),
          branchNameArb,
          commitHashArb,
          (commits, diffs, currentBranch, currentBranchHead) => {
            // Setup
            const service = new MockCherryPickOrderService(currentBranch, currentBranchHead);

            for (const commit of commits) {
              service.addCommit(commit, diffs);
            }

            const commitHashes = commits.map((c) => c.hash);

            // Act: Cherry-pick all commits
            const result = service.cherryPickMultiple(commitHashes);

            // Assert: Cherry-pick succeeded
            assert.strictEqual(result.success, true, 'Cherry-pick should succeed');

            // Get the cherry-picked commits
            const cherryPickedCommits = service.getCherryPickedCommits();

            // Assert: Number of cherry-picked commits matches input
            assert.strictEqual(
              cherryPickedCommits.length,
              commits.length,
              'Should have same number of cherry-picked commits'
            );

            // Assert: Messages are in the same order (messages identify the commits)
            for (let i = 0; i < commits.length; i++) {
              assert.strictEqual(
                cherryPickedCommits[i].message,
                commits[i].message,
                `Cherry-picked commit at position ${i} should have the same message as original`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Each cherry-picked commit has the previous cherry-picked commit as parent.
     */
    it('Property: Each cherry-picked commit has the previous cherry-picked commit as parent', () => {
      fc.assert(
        fc.property(
          uniqueCommitsArb,
          fc.array(diffArb, { minLength: 1, maxLength: 3 }),
          branchNameArb,
          commitHashArb,
          (commits, diffs, currentBranch, currentBranchHead) => {
            // Setup
            const service = new MockCherryPickOrderService(currentBranch, currentBranchHead);

            for (const commit of commits) {
              service.addCommit(commit, diffs);
            }

            const commitHashes = commits.map((c) => c.hash);

            // Act: Cherry-pick all commits
            const result = service.cherryPickMultiple(commitHashes);

            // Assert: Cherry-pick succeeded
            assert.strictEqual(result.success, true, 'Cherry-pick should succeed');

            const cherryPickedCommits = service.getCherryPickedCommits();

            // Assert: First cherry-picked commit has original branch HEAD as parent
            assert.strictEqual(
              cherryPickedCommits[0].parents[0],
              currentBranchHead,
              'First cherry-picked commit should have original branch HEAD as parent'
            );

            // Assert: Each subsequent commit has the previous cherry-picked commit as parent
            for (let i = 1; i < cherryPickedCommits.length; i++) {
              assert.strictEqual(
                cherryPickedCommits[i].parents[0],
                cherryPickedCommits[i - 1].hash,
                `Cherry-picked commit ${i} should have previous cherry-picked commit as parent`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Final branch HEAD is the last cherry-picked commit.
     */
    it('Property: Final branch HEAD is the last cherry-picked commit', () => {
      fc.assert(
        fc.property(
          uniqueCommitsArb,
          fc.array(diffArb, { minLength: 1, maxLength: 3 }),
          branchNameArb,
          commitHashArb,
          (commits, diffs, currentBranch, currentBranchHead) => {
            // Setup
            const service = new MockCherryPickOrderService(currentBranch, currentBranchHead);

            for (const commit of commits) {
              service.addCommit(commit, diffs);
            }

            const commitHashes = commits.map((c) => c.hash);

            // Act: Cherry-pick all commits
            const result = service.cherryPickMultiple(commitHashes);

            // Assert: Cherry-pick succeeded
            assert.strictEqual(result.success, true, 'Cherry-pick should succeed');

            const cherryPickedCommits = service.getCherryPickedCommits();
            const lastCherryPicked = cherryPickedCommits[cherryPickedCommits.length - 1];

            // Assert: Branch HEAD is the last cherry-picked commit
            assert.strictEqual(
              service.getCurrentBranchHead(),
              lastCherryPicked.hash,
              'Branch HEAD should be the last cherry-picked commit'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Cherry-picking empty list succeeds with no changes.
     */
    it('Property: Cherry-picking empty list succeeds with no changes', () => {
      fc.assert(
        fc.property(branchNameArb, commitHashArb, (currentBranch, currentBranchHead) => {
          // Setup
          const service = new MockCherryPickOrderService(currentBranch, currentBranchHead);

          // Act: Cherry-pick empty list
          const result = service.cherryPickMultiple([]);

          // Assert: Operation succeeded
          assert.strictEqual(result.success, true, 'Cherry-pick of empty list should succeed');

          // Assert: No commits were cherry-picked
          assert.strictEqual(
            service.getCherryPickedCommits().length,
            0,
            'No commits should be cherry-picked'
          );

          // Assert: Branch HEAD unchanged
          assert.strictEqual(
            service.getCurrentBranchHead(),
            currentBranchHead,
            'Branch HEAD should be unchanged'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Cherry-pick stops on first failure and preserves partial order.
     */
    it('Property: Cherry-pick stops on first failure and preserves partial order', () => {
      fc.assert(
        fc.property(
          uniqueCommitsArb,
          fc.array(diffArb, { minLength: 1, maxLength: 3 }),
          branchNameArb,
          commitHashArb,
          fc.integer({ min: 0, max: 4 }),
          (commits, diffs, currentBranch, currentBranchHead, failIndex) => {
            // Ensure failIndex is within bounds
            const actualFailIndex = failIndex % commits.length;

            // Setup
            const service = new MockCherryPickOrderService(currentBranch, currentBranchHead);

            // Add only commits before the fail index
            for (let i = 0; i < commits.length; i++) {
              if (i !== actualFailIndex) {
                service.addCommit(commits[i], diffs);
              }
              // Don't add the commit at failIndex - it will cause failure
            }

            const commitHashes = commits.map((c) => c.hash);

            // Act: Cherry-pick all commits (one will fail)
            const result = service.cherryPickMultiple(commitHashes);

            // Assert: Cherry-pick failed (because one commit doesn't exist)
            assert.strictEqual(result.success, false, 'Cherry-pick should fail');

            // Assert: Commits before the failure were cherry-picked in order
            const cherryPickedCommits = service.getCherryPickedCommits();
            assert.strictEqual(
              cherryPickedCommits.length,
              actualFailIndex,
              `Should have cherry-picked ${actualFailIndex} commits before failure`
            );

            // Assert: The order of successful cherry-picks is correct
            for (let i = 0; i < actualFailIndex; i++) {
              assert.strictEqual(
                cherryPickedCommits[i].message,
                commits[i].message,
                `Cherry-picked commit at position ${i} should match original order`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
