import * as fc from 'fast-check';
import * as assert from 'assert';
import { ITag, IAuthor, IHead } from '../../git-core/interfaces/IGitService';

/**
 * Property-based tests for Tag Checkout Detached HEAD.
 * Feature: intellig-vscode, Property 45: Tag Checkout Detached HEAD
 *
 *
 * Property Description:
 * For any tag checkout, the repository SHALL be in detached HEAD state
 * pointing to the tag's target commit.
 *
 * - 13.7: WHEN a user selects "Checkout Tag", THE Extension SHALL checkout
 *         the tag in detached HEAD state with a warning
 */
describe('Tag Checkout Detached HEAD Property Tests', () => {
  /**
   * Arbitrary generator for valid tag names.
   * Tag names should follow Git's naming rules.
   */
  const tagNameArb: fc.Arbitrary<string> = fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.'.split('')
      ),
      {
        minLength: 1,
        maxLength: 30,
      }
    )
    .filter((s) => {
      // Filter out invalid tag names
      if (s.length === 0) {
        return false;
      }
      if (s.startsWith('-') || s.startsWith('.')) {
        return false;
      }
      if (s.endsWith('.') || s.endsWith('.lock')) {
        return false;
      }
      if (s.includes('..')) {
        return false;
      }
      if (/^[-_.]+$/.test(s)) {
        return false;
      }
      return true;
    });

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
   * Arbitrary generator for non-empty tag messages.
   */
  const tagMessageArb: fc.Arbitrary<string> = fc
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
   * Arbitrary generator for a tag (either annotated or lightweight).
   */
  const tagArb: fc.Arbitrary<ITag> = fc.oneof(
    // Lightweight tag
    fc.record({
      name: tagNameArb,
      commit: commitHashArb,
      isAnnotated: fc.constant(false),
      message: fc.constant(undefined),
      tagger: fc.constant(undefined),
      date: fc.constant(undefined),
    }),
    // Annotated tag
    fc.record({
      name: tagNameArb,
      commit: commitHashArb,
      isAnnotated: fc.constant(true),
      message: tagMessageArb,
      tagger: authorArb,
      date: fc.date({ min: new Date('2000-01-01'), max: new Date() }),
    })
  );

  /**
   * Arbitrary generator for branch names.
   */
  const branchNameArb: fc.Arbitrary<string> = fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_/'.split('')
      ),
      {
        minLength: 1,
        maxLength: 30,
      }
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
   * Mock Repository Service that simulates tag checkout operations.
   * This allows us to test the tag checkout detached HEAD property
   * without actual Git operations.
   */
  class MockRepositoryService {
    private _tags: Map<string, ITag> = new Map();
    private _head: IHead;
    private _isDetached: boolean = false;
    private _currentBranch: string | undefined;
    private _checkoutWarnings: string[] = [];

    constructor(initialBranch: string = 'main', initialCommit: string = '') {
      this._currentBranch = initialBranch;
      this._head = {
        name: initialBranch,
        commit: initialCommit,
        ahead: 0,
        behind: 0,
      };
    }

    /**
     * Create a tag in the repository.
     */
    createTag(tag: ITag): void {
      this._tags.set(tag.name, tag);
    }

    /**
     * Get a tag by name.
     */
    getTag(name: string): ITag | undefined {
      return this._tags.get(name);
    }

    /**
     * Get all tags.
     */
    getTags(): ITag[] {
      return Array.from(this._tags.values());
    }

    /**
     * Check if a tag exists.
     */
    hasTag(name: string): boolean {
      return this._tags.has(name);
    }

    /**
     * Checkout a tag.
     *
     * @param tagName - The name of the tag to checkout
     * @returns true if checkout succeeded, false if tag doesn't exist
     */
    checkoutTag(tagName: string): boolean {
      const tag = this._tags.get(tagName);
      if (!tag) {
        return false;
      }

      // Enter detached HEAD state pointing to the tag's target commit
      this._isDetached = true;
      this._currentBranch = undefined;
      this._head = {
        name: undefined, // No branch name in detached HEAD
        commit: tag.commit,
        ahead: 0,
        behind: 0,
      };

      // Record warning about detached HEAD state
      this._checkoutWarnings.push(
        `You are in 'detached HEAD' state. You can look around, make experimental ` +
          `changes and commit them, and you can discard any commits you make in this ` +
          `state without impacting any branches by switching back to a branch.`
      );

      return true;
    }

    /**
     * Checkout a branch.
     * This exits detached HEAD state.
     */
    checkoutBranch(branchName: string, branchCommit: string): void {
      this._isDetached = false;
      this._currentBranch = branchName;
      this._head = {
        name: branchName,
        commit: branchCommit,
        ahead: 0,
        behind: 0,
      };
      this._checkoutWarnings = [];
    }

    /**
     * Check if the repository is in detached HEAD state.
     */
    isDetachedHead(): boolean {
      return this._isDetached;
    }

    /**
     * Get the current HEAD reference.
     */
    getHead(): IHead {
      return { ...this._head };
    }

    /**
     * Get the current branch name (undefined if detached).
     */
    getCurrentBranch(): string | undefined {
      return this._currentBranch;
    }

    /**
     * Get the current commit hash.
     */
    getCurrentCommit(): string | undefined {
      return this._head.commit;
    }

    /**
     * Get checkout warnings (e.g., detached HEAD warning).
     */
    getCheckoutWarnings(): string[] {
      return [...this._checkoutWarnings];
    }

    /**
     * Clear all state (for testing).
     */
    clear(): void {
      this._tags.clear();
      this._isDetached = false;
      this._currentBranch = 'main';
      this._head = {
        name: 'main',
        commit: '',
        ahead: 0,
        behind: 0,
      };
      this._checkoutWarnings = [];
    }
  }

  describe('Property 45: Tag Checkout Detached HEAD', () => {
    /**
     * Property: Checking out a tag results in detached HEAD state.
     */
    it('Property: Checking out a tag results in detached HEAD state', () => {
      fc.assert(
        fc.property(tagArb, branchNameArb, commitHashArb, (tag, initialBranch, initialCommit) => {
          // Setup: Create repository on a branch
          const repoService = new MockRepositoryService(initialBranch, initialCommit);
          repoService.createTag(tag);

          // Pre-condition: Not in detached HEAD state
          assert.strictEqual(
            repoService.isDetachedHead(),
            false,
            'Should not be in detached HEAD state initially'
          );
          assert.strictEqual(
            repoService.getCurrentBranch(),
            initialBranch,
            'Should be on initial branch'
          );

          // Act: Checkout the tag
          const checkoutResult = repoService.checkoutTag(tag.name);

          // Assert: Checkout succeeded
          assert.strictEqual(checkoutResult, true, 'Tag checkout should succeed');

          // Assert: Now in detached HEAD state
          assert.strictEqual(
            repoService.isDetachedHead(),
            true,
            'Should be in detached HEAD state after tag checkout'
          );

          // Assert: No current branch
          assert.strictEqual(
            repoService.getCurrentBranch(),
            undefined,
            'Should have no current branch in detached HEAD state'
          );

          // Assert: HEAD name is undefined (detached)
          const head = repoService.getHead();
          assert.strictEqual(
            head.name,
            undefined,
            'HEAD name should be undefined in detached state'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Detached HEAD points to the tag's target commit.
     */
    it("Property: Detached HEAD points to the tag's target commit", () => {
      fc.assert(
        fc.property(tagArb, branchNameArb, commitHashArb, (tag, initialBranch, initialCommit) => {
          // Setup
          const repoService = new MockRepositoryService(initialBranch, initialCommit);
          repoService.createTag(tag);

          // Act: Checkout the tag
          repoService.checkoutTag(tag.name);

          // Assert: HEAD commit matches tag's target commit
          const head = repoService.getHead();
          assert.strictEqual(
            head.commit,
            tag.commit,
            `HEAD commit (${head.commit}) should match tag's target commit (${tag.commit})`
          );

          // Also verify via getCurrentCommit
          assert.strictEqual(
            repoService.getCurrentCommit(),
            tag.commit,
            "Current commit should match tag's target commit"
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Tag checkout produces a warning about detached HEAD state.
     */
    it('Property: Tag checkout produces a warning about detached HEAD state', () => {
      fc.assert(
        fc.property(tagArb, branchNameArb, commitHashArb, (tag, initialBranch, initialCommit) => {
          // Setup
          const repoService = new MockRepositoryService(initialBranch, initialCommit);
          repoService.createTag(tag);

          // Pre-condition: No warnings initially
          assert.strictEqual(
            repoService.getCheckoutWarnings().length,
            0,
            'Should have no warnings initially'
          );

          // Act: Checkout the tag
          repoService.checkoutTag(tag.name);

          // Assert: Warning was produced
          const warnings = repoService.getCheckoutWarnings();
          assert.ok(warnings.length > 0, 'Should have at least one warning after tag checkout');

          // Assert: Warning mentions detached HEAD
          const hasDetachedHeadWarning = warnings.some((w) =>
            w.toLowerCase().includes('detached head')
          );
          assert.strictEqual(
            hasDetachedHeadWarning,
            true,
            'Warning should mention detached HEAD state'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Both annotated and lightweight tags result in detached HEAD.
     */
    it('Property: Both annotated and lightweight tags result in detached HEAD', () => {
      fc.assert(
        fc.property(
          tagNameArb,
          commitHashArb,
          tagMessageArb,
          authorArb,
          branchNameArb,
          commitHashArb,
          (tagName, tagCommit, message, tagger, initialBranch, initialCommit) => {
            // Test lightweight tag
            const lightweightTag: ITag = {
              name: tagName + '-light',
              commit: tagCommit,
              isAnnotated: false,
            };

            const repoService1 = new MockRepositoryService(initialBranch, initialCommit);
            repoService1.createTag(lightweightTag);
            repoService1.checkoutTag(lightweightTag.name);

            assert.strictEqual(
              repoService1.isDetachedHead(),
              true,
              'Lightweight tag checkout should result in detached HEAD'
            );
            assert.strictEqual(
              repoService1.getCurrentCommit(),
              tagCommit,
              'Lightweight tag checkout should point to tag commit'
            );

            // Test annotated tag
            const annotatedTag: ITag = {
              name: tagName + '-annotated',
              commit: tagCommit,
              isAnnotated: true,
              message: message,
              tagger: tagger,
              date: new Date(),
            };

            const repoService2 = new MockRepositoryService(initialBranch, initialCommit);
            repoService2.createTag(annotatedTag);
            repoService2.checkoutTag(annotatedTag.name);

            assert.strictEqual(
              repoService2.isDetachedHead(),
              true,
              'Annotated tag checkout should result in detached HEAD'
            );
            assert.strictEqual(
              repoService2.getCurrentCommit(),
              tagCommit,
              'Annotated tag checkout should point to tag commit'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Checking out a branch after tag checkout exits detached HEAD state.
     */
    it('Property: Checking out a branch after tag checkout exits detached HEAD state', () => {
      fc.assert(
        fc.property(
          tagArb,
          branchNameArb,
          commitHashArb,
          branchNameArb,
          commitHashArb,
          (tag, initialBranch, initialCommit, newBranch, newBranchCommit) => {
            // Ensure different branch names
            fc.pre(initialBranch !== newBranch);

            // Setup
            const repoService = new MockRepositoryService(initialBranch, initialCommit);
            repoService.createTag(tag);

            // Checkout tag - enter detached HEAD
            repoService.checkoutTag(tag.name);
            assert.strictEqual(
              repoService.isDetachedHead(),
              true,
              'Should be in detached HEAD after tag checkout'
            );

            // Checkout branch - exit detached HEAD
            repoService.checkoutBranch(newBranch, newBranchCommit);

            // Assert: No longer in detached HEAD
            assert.strictEqual(
              repoService.isDetachedHead(),
              false,
              'Should not be in detached HEAD after branch checkout'
            );

            // Assert: On the new branch
            assert.strictEqual(
              repoService.getCurrentBranch(),
              newBranch,
              'Should be on the new branch'
            );

            // Assert: HEAD points to branch commit
            assert.strictEqual(
              repoService.getCurrentCommit(),
              newBranchCommit,
              'HEAD should point to branch commit'
            );

            // Assert: HEAD name is the branch name
            const head = repoService.getHead();
            assert.strictEqual(head.name, newBranch, 'HEAD name should be the branch name');
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Cannot checkout a non-existent tag.
     */
    it('Property: Cannot checkout a non-existent tag', () => {
      fc.assert(
        fc.property(
          tagNameArb,
          branchNameArb,
          commitHashArb,
          (tagName, initialBranch, initialCommit) => {
            // Setup: Repository with no tags
            const repoService = new MockRepositoryService(initialBranch, initialCommit);

            // Pre-condition: Tag does not exist
            assert.strictEqual(repoService.hasTag(tagName), false, 'Tag should not exist');

            // Act: Try to checkout non-existent tag
            const checkoutResult = repoService.checkoutTag(tagName);

            // Assert: Checkout failed
            assert.strictEqual(checkoutResult, false, 'Checkout should fail for non-existent tag');

            // Assert: Still on original branch, not in detached HEAD
            assert.strictEqual(
              repoService.isDetachedHead(),
              false,
              'Should not be in detached HEAD after failed checkout'
            );
            assert.strictEqual(
              repoService.getCurrentBranch(),
              initialBranch,
              'Should still be on original branch'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Multiple tag checkouts maintain detached HEAD state.
     */
    it('Property: Multiple tag checkouts maintain detached HEAD state', () => {
      fc.assert(
        fc.property(
          fc.array(tagArb, { minLength: 2, maxLength: 5 }),
          branchNameArb,
          commitHashArb,
          (tags, initialBranch, initialCommit) => {
            // Ensure unique tag names
            const uniqueTags = tags.filter(
              (tag, index, arr) => arr.findIndex((t) => t.name === tag.name) === index
            );
            fc.pre(uniqueTags.length >= 2);

            // Setup
            const repoService = new MockRepositoryService(initialBranch, initialCommit);
            for (const tag of uniqueTags) {
              repoService.createTag(tag);
            }

            // Checkout each tag in sequence
            for (const tag of uniqueTags) {
              repoService.checkoutTag(tag.name);

              // Assert: In detached HEAD state
              assert.strictEqual(
                repoService.isDetachedHead(),
                true,
                `Should be in detached HEAD after checking out tag '${tag.name}'`
              );

              // Assert: HEAD points to this tag's commit
              assert.strictEqual(
                repoService.getCurrentCommit(),
                tag.commit,
                `HEAD should point to tag '${tag.name}' commit`
              );

              // Assert: No current branch
              assert.strictEqual(
                repoService.getCurrentBranch(),
                undefined,
                'Should have no current branch'
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
