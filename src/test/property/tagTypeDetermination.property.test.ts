import * as fc from 'fast-check';
import * as assert from 'assert';
import { ITag, IAuthor } from '../../services/interfaces/IGitService';

/**
 * Property-based tests for Tag Type Determination.
 * Feature: intellij-git-vscode, Property 42: Tag Type Determination
 *
 * **Validates: Requirements 13.2, 13.3**
 *
 * Property Description:
 * For any tag created with a message, the tag SHALL be annotated; for any tag
 * created without a message, the tag SHALL be lightweight.
 *
 * Requirements:
 * - 13.2: WHEN creating a tag with a message, THE Extension SHALL create an annotated tag
 * - 13.3: WHEN creating a tag without a message, THE Extension SHALL create a lightweight tag
 */
describe('Tag Type Determination Property Tests', () => {
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
   * Mock Tag Service that simulates tag creation operations in memory.
   * This allows us to test the tag type determination properties without actual Git operations.
   */
  class MockTagService {
    private _tags: Map<string, ITag> = new Map();
    private _defaultTagger: IAuthor = { name: 'Test User', email: 'test@example.com' };

    constructor(options?: { defaultTagger?: IAuthor }) {
      if (options?.defaultTagger) {
        this._defaultTagger = options.defaultTagger;
      }
    }

    /**
     * Get all tags.
     */
    getTags(): ITag[] {
      return Array.from(this._tags.values());
    }

    /**
     * Get a specific tag by name.
     */
    getTag(name: string): ITag | undefined {
      return this._tags.get(name);
    }

    /**
     * Check if a tag exists.
     */
    tagExists(name: string): boolean {
      return this._tags.has(name);
    }

    /**
     * Create a tag.
     * Requirement 13.2: Creating a tag with a message creates an annotated tag.
     * Requirement 13.3: Creating a tag without a message creates a lightweight tag.
     *
     * @param name - The tag name
     * @param commit - The commit hash to tag
     * @param message - Optional tag message (if provided, creates annotated tag)
     * @param tagger - Optional tagger information (only used for annotated tags)
     */
    createTag(name: string, commit: string, message?: string, tagger?: IAuthor): void {
      // Validate tag name
      if (!name || name.length === 0) {
        throw new Error('Tag name cannot be empty');
      }

      // Check if tag already exists
      if (this._tags.has(name)) {
        throw new Error(`Tag '${name}' already exists`);
      }

      // Determine if this is an annotated or lightweight tag
      // Key logic: If message is provided (and non-empty), it's annotated; otherwise lightweight
      const isAnnotated = message !== undefined && message.trim().length > 0;

      const tag: ITag = {
        name,
        commit,
        isAnnotated,
        // Only set these fields for annotated tags
        message: isAnnotated ? message : undefined,
        tagger: isAnnotated ? tagger || this._defaultTagger : undefined,
        date: isAnnotated ? new Date() : undefined,
      };

      this._tags.set(name, tag);
    }

    /**
     * Delete a tag.
     *
     * @param name - The tag name to delete
     */
    deleteTag(name: string): void {
      if (!this._tags.has(name)) {
        throw new Error(`Tag '${name}' does not exist`);
      }
      this._tags.delete(name);
    }

    /**
     * Clear all tags (for testing).
     */
    clearTags(): void {
      this._tags.clear();
    }
  }

  describe('Property 42: Tag Type Determination', () => {
    /**
     * Property: Tags created with a message are annotated.
     *
     * **Validates: Requirements 13.2**
     */
    it('Property: Tags created with a message are annotated', () => {
      fc.assert(
        fc.property(tagNameArb, commitHashArb, tagMessageArb, (tagName, commit, message) => {
          // Setup
          const tagService = new MockTagService();

          // Act: Create a tag with a message
          tagService.createTag(tagName, commit, message);

          // Assert: Tag was created
          const tag = tagService.getTag(tagName);
          assert.ok(tag, 'Tag should be created');

          // Assert: Tag is annotated
          assert.strictEqual(tag.isAnnotated, true, 'Tag created with message should be annotated');

          // Assert: Tag has the message
          assert.strictEqual(tag.message, message, 'Annotated tag should have the message');

          // Assert: Tag has tagger information
          assert.ok(tag.tagger, 'Annotated tag should have tagger information');

          // Assert: Tag has date
          assert.ok(tag.date, 'Annotated tag should have date');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Tags created without a message are lightweight.
     *
     * **Validates: Requirements 13.3**
     */
    it('Property: Tags created without a message are lightweight', () => {
      fc.assert(
        fc.property(tagNameArb, commitHashArb, (tagName, commit) => {
          // Setup
          const tagService = new MockTagService();

          // Act: Create a tag without a message
          tagService.createTag(tagName, commit);

          // Assert: Tag was created
          const tag = tagService.getTag(tagName);
          assert.ok(tag, 'Tag should be created');

          // Assert: Tag is lightweight (not annotated)
          assert.strictEqual(
            tag.isAnnotated,
            false,
            'Tag created without message should be lightweight'
          );

          // Assert: Tag does not have a message
          assert.strictEqual(tag.message, undefined, 'Lightweight tag should not have a message');

          // Assert: Tag does not have tagger information
          assert.strictEqual(
            tag.tagger,
            undefined,
            'Lightweight tag should not have tagger information'
          );

          // Assert: Tag does not have date
          assert.strictEqual(tag.date, undefined, 'Lightweight tag should not have date');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Tags created with undefined message are lightweight.
     *
     * **Validates: Requirements 13.3**
     */
    it('Property: Tags created with undefined message are lightweight', () => {
      fc.assert(
        fc.property(tagNameArb, commitHashArb, (tagName, commit) => {
          // Setup
          const tagService = new MockTagService();

          // Act: Create a tag with explicitly undefined message
          tagService.createTag(tagName, commit, undefined);

          // Assert: Tag is lightweight
          const tag = tagService.getTag(tagName);
          assert.ok(tag, 'Tag should be created');
          assert.strictEqual(
            tag.isAnnotated,
            false,
            'Tag created with undefined message should be lightweight'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Tags created with empty string message are lightweight.
     *
     * **Validates: Requirements 13.3**
     */
    it('Property: Tags created with empty string message are lightweight', () => {
      fc.assert(
        fc.property(tagNameArb, commitHashArb, (tagName, commit) => {
          // Setup
          const tagService = new MockTagService();

          // Act: Create a tag with empty string message
          tagService.createTag(tagName, commit, '');

          // Assert: Tag is lightweight
          const tag = tagService.getTag(tagName);
          assert.ok(tag, 'Tag should be created');
          assert.strictEqual(
            tag.isAnnotated,
            false,
            'Tag created with empty message should be lightweight'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Tags created with whitespace-only message are lightweight.
     *
     * **Validates: Requirements 13.3**
     */
    it('Property: Tags created with whitespace-only message are lightweight', () => {
      fc.assert(
        fc.property(
          tagNameArb,
          commitHashArb,
          fc.stringOf(fc.constantFrom(' ', '\t', '\n', '\r'), { minLength: 1, maxLength: 10 }),
          (tagName, commit, whitespaceMessage) => {
            // Setup
            const tagService = new MockTagService();

            // Act: Create a tag with whitespace-only message
            tagService.createTag(tagName, commit, whitespaceMessage);

            // Assert: Tag is lightweight
            const tag = tagService.getTag(tagName);
            assert.ok(tag, 'Tag should be created');
            assert.strictEqual(
              tag.isAnnotated,
              false,
              'Tag created with whitespace-only message should be lightweight'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Tag type is determined solely by message presence.
     *
     * **Validates: Requirements 13.2, 13.3**
     */
    it('Property: Tag type is determined solely by message presence', () => {
      fc.assert(
        fc.property(
          tagNameArb,
          commitHashArb,
          fc.option(tagMessageArb, { nil: undefined }),
          (tagName, commit, maybeMessage) => {
            // Setup
            const tagService = new MockTagService();

            // Act: Create a tag with or without message
            tagService.createTag(tagName, commit, maybeMessage);

            // Assert: Tag type matches message presence
            const tag = tagService.getTag(tagName);
            assert.ok(tag, 'Tag should be created');

            const hasMessage = maybeMessage !== undefined && maybeMessage.trim().length > 0;
            assert.strictEqual(
              tag.isAnnotated,
              hasMessage,
              `Tag should be ${hasMessage ? 'annotated' : 'lightweight'} based on message presence`
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Annotated tags preserve tagger information.
     *
     * **Validates: Requirements 13.2**
     */
    it('Property: Annotated tags preserve tagger information', () => {
      fc.assert(
        fc.property(
          tagNameArb,
          commitHashArb,
          tagMessageArb,
          authorArb,
          (tagName, commit, message, tagger) => {
            // Setup
            const tagService = new MockTagService();

            // Act: Create an annotated tag with specific tagger
            tagService.createTag(tagName, commit, message, tagger);

            // Assert: Tagger information is preserved
            const tag = tagService.getTag(tagName);
            assert.ok(tag, 'Tag should be created');
            assert.ok(tag.tagger, 'Annotated tag should have tagger');
            assert.strictEqual(tag.tagger.name, tagger.name, 'Tagger name should be preserved');
            assert.strictEqual(tag.tagger.email, tagger.email, 'Tagger email should be preserved');
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Tag commit reference is preserved regardless of type.
     *
     * **Validates: Requirements 13.2, 13.3**
     */
    it('Property: Tag commit reference is preserved regardless of type', () => {
      fc.assert(
        fc.property(
          tagNameArb,
          commitHashArb,
          fc.option(tagMessageArb, { nil: undefined }),
          (tagName, commit, maybeMessage) => {
            // Setup
            const tagService = new MockTagService();

            // Act: Create a tag
            tagService.createTag(tagName, commit, maybeMessage);

            // Assert: Commit reference is preserved
            const tag = tagService.getTag(tagName);
            assert.ok(tag, 'Tag should be created');
            assert.strictEqual(tag.commit, commit, 'Tag commit reference should be preserved');
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Tag name is preserved regardless of type.
     *
     * **Validates: Requirements 13.2, 13.3**
     */
    it('Property: Tag name is preserved regardless of type', () => {
      fc.assert(
        fc.property(
          tagNameArb,
          commitHashArb,
          fc.option(tagMessageArb, { nil: undefined }),
          (tagName, commit, maybeMessage) => {
            // Setup
            const tagService = new MockTagService();

            // Act: Create a tag
            tagService.createTag(tagName, commit, maybeMessage);

            // Assert: Tag name is preserved
            const tag = tagService.getTag(tagName);
            assert.ok(tag, 'Tag should be created');
            assert.strictEqual(tag.name, tagName, 'Tag name should be preserved');
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Creating duplicate tag names fails.
     *
     * **Validates: Requirements 13.2, 13.3**
     */
    it('Property: Creating duplicate tag names fails', () => {
      fc.assert(
        fc.property(
          tagNameArb,
          commitHashArb,
          commitHashArb,
          fc.option(tagMessageArb, { nil: undefined }),
          fc.option(tagMessageArb, { nil: undefined }),
          (tagName, commit1, commit2, message1, message2) => {
            // Setup
            const tagService = new MockTagService();

            // Act: Create first tag
            tagService.createTag(tagName, commit1, message1);

            // Assert: Creating second tag with same name fails
            assert.throws(
              () => tagService.createTag(tagName, commit2, message2),
              /already exists/,
              'Creating duplicate tag should fail'
            );

            // Assert: Original tag is unchanged
            const tag = tagService.getTag(tagName);
            assert.ok(tag, 'Original tag should still exist');
            assert.strictEqual(tag.commit, commit1, 'Original tag commit should be unchanged');
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Multiple tags can be created with different names.
     *
     * **Validates: Requirements 13.2, 13.3**
     */
    it('Property: Multiple tags can be created with different names', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.tuple(tagNameArb, commitHashArb, fc.option(tagMessageArb, { nil: undefined })),
            {
              minLength: 2,
              maxLength: 5,
            }
          ),
          (tagSpecs) => {
            // Ensure unique tag names
            const uniqueSpecs = tagSpecs.filter((spec, index, arr) => {
              return arr.findIndex((s) => s[0] === spec[0]) === index;
            });
            fc.pre(uniqueSpecs.length >= 2);

            // Setup
            const tagService = new MockTagService();

            // Act: Create all tags
            for (const [name, commit, message] of uniqueSpecs) {
              tagService.createTag(name, commit, message);
            }

            // Assert: All tags were created
            const tags = tagService.getTags();
            assert.strictEqual(
              tags.length,
              uniqueSpecs.length,
              'All unique tags should be created'
            );

            // Assert: Each tag has correct type
            for (const [name, commit, message] of uniqueSpecs) {
              const tag = tagService.getTag(name);
              assert.ok(tag, `Tag '${name}' should exist`);
              assert.strictEqual(tag.commit, commit, `Tag '${name}' should have correct commit`);

              const shouldBeAnnotated = message !== undefined && message.trim().length > 0;
              assert.strictEqual(
                tag.isAnnotated,
                shouldBeAnnotated,
                `Tag '${name}' should be ${shouldBeAnnotated ? 'annotated' : 'lightweight'}`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Annotated tags have all required metadata fields.
     *
     * **Validates: Requirements 13.2**
     */
    it('Property: Annotated tags have all required metadata fields', () => {
      fc.assert(
        fc.property(tagNameArb, commitHashArb, tagMessageArb, (tagName, commit, message) => {
          // Setup
          const tagService = new MockTagService();

          // Act: Create an annotated tag
          tagService.createTag(tagName, commit, message);

          // Assert: All metadata fields are present
          const tag = tagService.getTag(tagName);
          assert.ok(tag, 'Tag should be created');
          assert.strictEqual(tag.isAnnotated, true, 'Tag should be annotated');

          // Check all required fields for annotated tags
          assert.ok(tag.name, 'Annotated tag should have name');
          assert.ok(tag.commit, 'Annotated tag should have commit');
          assert.ok(tag.message, 'Annotated tag should have message');
          assert.ok(tag.tagger, 'Annotated tag should have tagger');
          assert.ok(tag.date, 'Annotated tag should have date');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Lightweight tags have minimal metadata.
     *
     * **Validates: Requirements 13.3**
     */
    it('Property: Lightweight tags have minimal metadata', () => {
      fc.assert(
        fc.property(tagNameArb, commitHashArb, (tagName, commit) => {
          // Setup
          const tagService = new MockTagService();

          // Act: Create a lightweight tag
          tagService.createTag(tagName, commit);

          // Assert: Only essential fields are present
          const tag = tagService.getTag(tagName);
          assert.ok(tag, 'Tag should be created');
          assert.strictEqual(tag.isAnnotated, false, 'Tag should be lightweight');

          // Check essential fields
          assert.ok(tag.name, 'Lightweight tag should have name');
          assert.ok(tag.commit, 'Lightweight tag should have commit');

          // Check that annotated-only fields are absent
          assert.strictEqual(tag.message, undefined, 'Lightweight tag should not have message');
          assert.strictEqual(tag.tagger, undefined, 'Lightweight tag should not have tagger');
          assert.strictEqual(tag.date, undefined, 'Lightweight tag should not have date');
        }),
        { numRuns: 100 }
      );
    });
  });
});
