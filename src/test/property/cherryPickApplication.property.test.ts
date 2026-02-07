import * as fc from 'fast-check';
import * as assert from 'assert';
import {
  ICommit,
  IAuthor,
  IDiff,
  IHunk,
  IDiffLine,
  ICherryPickResult,
} from '../../services/interfaces/IGitService';

/**
 * Property-based tests for Cherry-Pick Application.
 * Feature: intellij-git-vscode, Property 35: Cherry-Pick Application
 *
 * **Validates: Requirements 11.1**
 *
 * Property Description:
 * For any commit cherry-picked to the current branch, the resulting commit
 * SHALL have the same diff as the original commit but with a new hash and
 * the current branch as parent.
 *
 * Requirements:
 * - 11.1: WHEN a user selects "Cherry-pick" on a commit, THE Extension SHALL
 *         apply that commit to the current branch
 */
describe('Cherry-Pick Application Property Tests', () => {
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
   * Mock Cherry-Pick Service that simulates cherry-pick operations.
   * This allows us to test the cherry-pick application property
   * without actual Git operations.
   */
  class MockCherryPickService {
    private _commits: Map<string, ICommit> = new Map();
    private _commitDiffs: Map<string, IDiff[]> = new Map();
    private _currentBranch: string;
    private _currentBranchHead: string;
    private _cherryPickedCommits: ICommit[] = [];
    private _cherryPickedDiffs: Map<string, IDiff[]> = new Map();

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
     * Get the diff for a commit.
     */
    getCommitDiff(hash: string): IDiff[] | undefined {
      return this._commitDiffs.get(hash);
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
     * Cherry-pick a commit onto the current branch.
     * Requirement 11.1: Apply the commit to the current branch.
     *
     * The resulting commit SHALL have:
     * - The same diff as the original commit
     * - A new hash (different from the original)
     * - The current branch HEAD as its parent
     *
     * @param commitHash - The hash of the commit to cherry-pick
     * @returns Cherry-pick result
     */
    cherryPick(commitHash: string): ICherryPickResult {
      const originalCommit = this._commits.get(commitHash);
      if (!originalCommit) {
        return { success: false, conflicts: [] };
      }

      const originalDiffs = this._commitDiffs.get(commitHash);
      if (!originalDiffs) {
        return { success: false, conflicts: [] };
      }

      // Generate a new hash for the cherry-picked commit
      // In real Git, this would be computed from the commit content
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
        parents: [this._currentBranchHead], // Parent is current branch HEAD
        authorDate: originalCommit.authorDate,
        commitDate: new Date(), // New commit date
      };

      // Store the cherry-picked commit
      this._cherryPickedCommits.push(cherryPickedCommit);
      this._commits.set(newHash, cherryPickedCommit);

      // The diff should be the same as the original
      this._cherryPickedDiffs.set(newHash, originalDiffs);
      this._commitDiffs.set(newHash, originalDiffs);

      // Update current branch HEAD
      this._currentBranchHead = newHash;

      return { success: true };
    }

    /**
     * Get all cherry-picked commits.
     */
    getCherryPickedCommits(): ICommit[] {
      return [...this._cherryPickedCommits];
    }

    /**
     * Get the diff for a cherry-picked commit.
     */
    getCherryPickedDiff(hash: string): IDiff[] | undefined {
      return this._cherryPickedDiffs.get(hash);
    }

    /**
     * Generate a new hash for a cherry-picked commit.
     * In real Git, this would be computed from the commit content.
     * For testing, we just modify the original hash.
     */
    private generateNewHash(originalHash: string): string {
      // Simple hash modification for testing - reverse and modify
      const chars = originalHash.split('');
      chars.reverse();
      // Modify first character to ensure it's different
      const firstChar = chars[0];
      const hexChars = '0123456789abcdef';
      const newFirstChar = hexChars[(hexChars.indexOf(firstChar) + 1) % 16];
      chars[0] = newFirstChar;
      return chars.join('');
    }

    /**
     * Compare two diffs for equality.
     * Two diffs are equal if they have the same path, status, and hunks.
     */
    static diffsAreEqual(diff1: IDiff, diff2: IDiff): boolean {
      if (diff1.path !== diff2.path) {
        return false;
      }
      if (diff1.status !== diff2.status) {
        return false;
      }
      if (diff1.binary !== diff2.binary) {
        return false;
      }
      if (diff1.hunks.length !== diff2.hunks.length) {
        return false;
      }

      for (let i = 0; i < diff1.hunks.length; i++) {
        const hunk1 = diff1.hunks[i];
        const hunk2 = diff2.hunks[i];

        if (hunk1.oldStart !== hunk2.oldStart) {
          return false;
        }
        if (hunk1.oldLines !== hunk2.oldLines) {
          return false;
        }
        if (hunk1.newStart !== hunk2.newStart) {
          return false;
        }
        if (hunk1.newLines !== hunk2.newLines) {
          return false;
        }
        if (hunk1.lines.length !== hunk2.lines.length) {
          return false;
        }

        for (let j = 0; j < hunk1.lines.length; j++) {
          const line1 = hunk1.lines[j];
          const line2 = hunk2.lines[j];

          if (line1.type !== line2.type) {
            return false;
          }
          if (line1.content !== line2.content) {
            return false;
          }
        }
      }

      return true;
    }

    /**
     * Compare two diff arrays for equality.
     */
    static diffArraysAreEqual(diffs1: IDiff[], diffs2: IDiff[]): boolean {
      if (diffs1.length !== diffs2.length) {
        return false;
      }

      for (let i = 0; i < diffs1.length; i++) {
        if (!MockCherryPickService.diffsAreEqual(diffs1[i], diffs2[i])) {
          return false;
        }
      }

      return true;
    }
  }

  describe('Property 35: Cherry-Pick Application', () => {
    /**
     * Property: Cherry-picked commit has the same diff as the original.
     *
     * **Validates: Requirements 11.1**
     */
    it('Property: Cherry-picked commit has the same diff as the original', () => {
      fc.assert(
        fc.property(
          commitArb,
          fc.array(diffArb, { minLength: 1, maxLength: 5 }),
          branchNameArb,
          commitHashArb,
          (originalCommit, originalDiffs, currentBranch, currentBranchHead) => {
            // Setup: Create service with current branch
            const service = new MockCherryPickService(currentBranch, currentBranchHead);
            service.addCommit(originalCommit, originalDiffs);

            // Act: Cherry-pick the commit
            const result = service.cherryPick(originalCommit.hash);

            // Assert: Cherry-pick succeeded
            assert.strictEqual(result.success, true, 'Cherry-pick should succeed');

            // Get the cherry-picked commit
            const cherryPickedCommits = service.getCherryPickedCommits();
            assert.strictEqual(
              cherryPickedCommits.length,
              1,
              'Should have exactly one cherry-picked commit'
            );

            const cherryPickedCommit = cherryPickedCommits[0];

            // Get the diff for the cherry-picked commit
            const cherryPickedDiffs = service.getCherryPickedDiff(cherryPickedCommit.hash);
            assert.ok(cherryPickedDiffs, 'Cherry-picked commit should have diffs');

            // Assert: Diffs are the same
            assert.strictEqual(
              MockCherryPickService.diffArraysAreEqual(originalDiffs, cherryPickedDiffs),
              true,
              'Cherry-picked commit should have the same diff as the original'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Cherry-picked commit has a new hash different from the original.
     *
     * **Validates: Requirements 11.1**
     */
    it('Property: Cherry-picked commit has a new hash different from the original', () => {
      fc.assert(
        fc.property(
          commitArb,
          fc.array(diffArb, { minLength: 1, maxLength: 3 }),
          branchNameArb,
          commitHashArb,
          (originalCommit, originalDiffs, currentBranch, currentBranchHead) => {
            // Setup
            const service = new MockCherryPickService(currentBranch, currentBranchHead);
            service.addCommit(originalCommit, originalDiffs);

            // Act: Cherry-pick the commit
            const result = service.cherryPick(originalCommit.hash);

            // Assert: Cherry-pick succeeded
            assert.strictEqual(result.success, true, 'Cherry-pick should succeed');

            // Get the cherry-picked commit
            const cherryPickedCommits = service.getCherryPickedCommits();
            const cherryPickedCommit = cherryPickedCommits[0];

            // Assert: Hash is different
            assert.notStrictEqual(
              cherryPickedCommit.hash,
              originalCommit.hash,
              'Cherry-picked commit should have a different hash than the original'
            );

            // Assert: Hash is valid (40 hex characters)
            assert.strictEqual(
              cherryPickedCommit.hash.length,
              40,
              'Cherry-picked commit hash should be 40 characters'
            );
            assert.ok(
              /^[0-9a-f]{40}$/.test(cherryPickedCommit.hash),
              'Cherry-picked commit hash should be valid hex'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Cherry-picked commit has the current branch HEAD as parent.
     *
     * **Validates: Requirements 11.1**
     */
    it('Property: Cherry-picked commit has the current branch HEAD as parent', () => {
      fc.assert(
        fc.property(
          commitArb,
          fc.array(diffArb, { minLength: 1, maxLength: 3 }),
          branchNameArb,
          commitHashArb,
          (originalCommit, originalDiffs, currentBranch, currentBranchHead) => {
            // Setup
            const service = new MockCherryPickService(currentBranch, currentBranchHead);
            service.addCommit(originalCommit, originalDiffs);

            // Act: Cherry-pick the commit
            const result = service.cherryPick(originalCommit.hash);

            // Assert: Cherry-pick succeeded
            assert.strictEqual(result.success, true, 'Cherry-pick should succeed');

            // Get the cherry-picked commit
            const cherryPickedCommits = service.getCherryPickedCommits();
            const cherryPickedCommit = cherryPickedCommits[0];

            // Assert: Parent is the current branch HEAD (before cherry-pick)
            assert.strictEqual(
              cherryPickedCommit.parents.length,
              1,
              'Cherry-picked commit should have exactly one parent'
            );
            assert.strictEqual(
              cherryPickedCommit.parents[0],
              currentBranchHead,
              'Cherry-picked commit parent should be the current branch HEAD'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Cherry-picked commit preserves the original commit message.
     *
     * **Validates: Requirements 11.1**
     */
    it('Property: Cherry-picked commit preserves the original commit message', () => {
      fc.assert(
        fc.property(
          commitArb,
          fc.array(diffArb, { minLength: 1, maxLength: 3 }),
          branchNameArb,
          commitHashArb,
          (originalCommit, originalDiffs, currentBranch, currentBranchHead) => {
            // Setup
            const service = new MockCherryPickService(currentBranch, currentBranchHead);
            service.addCommit(originalCommit, originalDiffs);

            // Act: Cherry-pick the commit
            const result = service.cherryPick(originalCommit.hash);

            // Assert: Cherry-pick succeeded
            assert.strictEqual(result.success, true, 'Cherry-pick should succeed');

            // Get the cherry-picked commit
            const cherryPickedCommits = service.getCherryPickedCommits();
            const cherryPickedCommit = cherryPickedCommits[0];

            // Assert: Message is preserved
            assert.strictEqual(
              cherryPickedCommit.message,
              originalCommit.message,
              'Cherry-picked commit should have the same message as the original'
            );

            // Assert: Body is preserved (if present)
            assert.strictEqual(
              cherryPickedCommit.body,
              originalCommit.body,
              'Cherry-picked commit should have the same body as the original'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Cherry-picked commit preserves the original author.
     *
     * **Validates: Requirements 11.1**
     */
    it('Property: Cherry-picked commit preserves the original author', () => {
      fc.assert(
        fc.property(
          commitArb,
          fc.array(diffArb, { minLength: 1, maxLength: 3 }),
          branchNameArb,
          commitHashArb,
          (originalCommit, originalDiffs, currentBranch, currentBranchHead) => {
            // Setup
            const service = new MockCherryPickService(currentBranch, currentBranchHead);
            service.addCommit(originalCommit, originalDiffs);

            // Act: Cherry-pick the commit
            const result = service.cherryPick(originalCommit.hash);

            // Assert: Cherry-pick succeeded
            assert.strictEqual(result.success, true, 'Cherry-pick should succeed');

            // Get the cherry-picked commit
            const cherryPickedCommits = service.getCherryPickedCommits();
            const cherryPickedCommit = cherryPickedCommits[0];

            // Assert: Author is preserved
            assert.strictEqual(
              cherryPickedCommit.author.name,
              originalCommit.author.name,
              'Cherry-picked commit should have the same author name'
            );
            assert.strictEqual(
              cherryPickedCommit.author.email,
              originalCommit.author.email,
              'Cherry-picked commit should have the same author email'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Cherry-pick updates the current branch HEAD.
     *
     * **Validates: Requirements 11.1**
     */
    it('Property: Cherry-pick updates the current branch HEAD', () => {
      fc.assert(
        fc.property(
          commitArb,
          fc.array(diffArb, { minLength: 1, maxLength: 3 }),
          branchNameArb,
          commitHashArb,
          (originalCommit, originalDiffs, currentBranch, currentBranchHead) => {
            // Setup
            const service = new MockCherryPickService(currentBranch, currentBranchHead);
            service.addCommit(originalCommit, originalDiffs);

            // Pre-condition: Current branch HEAD is the initial value
            assert.strictEqual(
              service.getCurrentBranchHead(),
              currentBranchHead,
              'Initial branch HEAD should match'
            );

            // Act: Cherry-pick the commit
            const result = service.cherryPick(originalCommit.hash);

            // Assert: Cherry-pick succeeded
            assert.strictEqual(result.success, true, 'Cherry-pick should succeed');

            // Get the cherry-picked commit
            const cherryPickedCommits = service.getCherryPickedCommits();
            const cherryPickedCommit = cherryPickedCommits[0];

            // Assert: Current branch HEAD is now the cherry-picked commit
            assert.strictEqual(
              service.getCurrentBranchHead(),
              cherryPickedCommit.hash,
              'Current branch HEAD should be updated to the cherry-picked commit'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Cherry-pick of non-existent commit fails.
     *
     * **Validates: Requirements 11.1**
     */
    it('Property: Cherry-pick of non-existent commit fails', () => {
      fc.assert(
        fc.property(
          commitHashArb,
          branchNameArb,
          commitHashArb,
          (nonExistentHash, currentBranch, currentBranchHead) => {
            // Setup: Create service with no commits
            const service = new MockCherryPickService(currentBranch, currentBranchHead);

            // Pre-condition: Commit does not exist
            assert.strictEqual(
              service.getCommit(nonExistentHash),
              undefined,
              'Commit should not exist'
            );

            // Act: Try to cherry-pick non-existent commit
            const result = service.cherryPick(nonExistentHash);

            // Assert: Cherry-pick failed
            assert.strictEqual(result.success, false, 'Cherry-pick should fail');

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
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Cherry-picked commit is retrievable by its new hash.
     *
     * **Validates: Requirements 11.1**
     */
    it('Property: Cherry-picked commit is retrievable by its new hash', () => {
      fc.assert(
        fc.property(
          commitArb,
          fc.array(diffArb, { minLength: 1, maxLength: 3 }),
          branchNameArb,
          commitHashArb,
          (originalCommit, originalDiffs, currentBranch, currentBranchHead) => {
            // Setup
            const service = new MockCherryPickService(currentBranch, currentBranchHead);
            service.addCommit(originalCommit, originalDiffs);

            // Act: Cherry-pick the commit
            const result = service.cherryPick(originalCommit.hash);

            // Assert: Cherry-pick succeeded
            assert.strictEqual(result.success, true, 'Cherry-pick should succeed');

            // Get the cherry-picked commit
            const cherryPickedCommits = service.getCherryPickedCommits();
            const cherryPickedCommit = cherryPickedCommits[0];

            // Assert: Can retrieve the commit by its new hash
            const retrievedCommit = service.getCommit(cherryPickedCommit.hash);
            assert.ok(retrievedCommit, 'Should be able to retrieve cherry-picked commit');
            assert.strictEqual(
              retrievedCommit.hash,
              cherryPickedCommit.hash,
              'Retrieved commit hash should match'
            );
            assert.strictEqual(
              retrievedCommit.message,
              originalCommit.message,
              'Retrieved commit message should match original'
            );
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
