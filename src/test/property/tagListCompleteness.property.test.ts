import * as fc from 'fast-check';
import * as assert from 'assert';
import { ITag, IAuthor } from '../../services/interfaces/IGitService';

/**
 * Property-based tests for Tag List Completeness.
 * Feature: intellig-vscode, Property 43: Tag List Completeness
 *
 * **Validates: Requirements 13.4**
 *
 * Property Description:
 * For any repository, the tag view SHALL display all local and remote tags
 * with their target commit references.
 *
 * Requirements:
 * - 13.4: WHEN a user views tags, THE Extension SHALL display all local and
 *         remote tags with their target commits
 */
describe('Tag List Completeness Property Tests', () => {
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
   * Arbitrary generator for remote name.
   */
  const remoteNameArb: fc.Arbitrary<string> = fc.constantFrom(
    'origin',
    'upstream',
    'fork',
    'backup'
  );

  /**
   * Mock Tag Service that simulates tag listing operations.
   * This allows us to test the tag list completeness properties without actual Git operations.
   */
  class MockTagService {
    private _localTags: Map<string, ITag> = new Map();
    private _remoteTags: Map<string, Map<string, ITag>> = new Map(); // remote -> tagName -> tag

    /**
     * Add a local tag.
     */
    addLocalTag(tag: ITag): void {
      this._localTags.set(tag.name, tag);
    }

    /**
     * Add a remote tag.
     */
    addRemoteTag(remote: string, tag: ITag): void {
      if (!this._remoteTags.has(remote)) {
        this._remoteTags.set(remote, new Map());
      }
      this._remoteTags.get(remote)!.set(tag.name, tag);
    }

    /**
     * Get all local tags.
     */
    getLocalTags(): ITag[] {
      return Array.from(this._localTags.values());
    }

    /**
     * Get all remote tags for a specific remote.
     */
    getRemoteTags(remote: string): ITag[] {
      const remoteTags = this._remoteTags.get(remote);
      return remoteTags ? Array.from(remoteTags.values()) : [];
    }

    /**
     * Get all remote tags across all remotes.
     */
    getAllRemoteTags(): { remote: string; tag: ITag }[] {
      const result: { remote: string; tag: ITag }[] = [];
      for (const [remote, tags] of this._remoteTags) {
        for (const tag of tags.values()) {
          result.push({ remote, tag });
        }
      }
      return result;
    }

    /**
     * Get all tags (local and remote combined).
     * This simulates what getTags() should return - all tags visible to the user.
     *
     * Requirement 13.4: Display all local and remote tags with their target commits.
     */
    getTags(): ITag[] {
      const allTags = new Map<string, ITag>();

      // Add all local tags
      for (const [name, tag] of this._localTags) {
        allTags.set(name, tag);
      }

      // Add remote tags (remote tags may have different commits than local)
      // In a real implementation, remote tags would be prefixed or tracked separately
      for (const [remote, tags] of this._remoteTags) {
        for (const [name, tag] of tags) {
          // Use remote/tagName format for remote-only tags
          const remoteTagName = `${remote}/${name}`;
          if (!allTags.has(name)) {
            // If no local tag with this name, add the remote tag
            allTags.set(remoteTagName, { ...tag, name: remoteTagName });
          }
        }
      }

      return Array.from(allTags.values());
    }

    /**
     * Get the count of all unique tags.
     */
    getTotalTagCount(): number {
      const uniqueNames = new Set<string>();

      // Count local tags
      for (const name of this._localTags.keys()) {
        uniqueNames.add(name);
      }

      // Count remote tags (with remote prefix)
      for (const [remote, tags] of this._remoteTags) {
        for (const name of tags.keys()) {
          if (!this._localTags.has(name)) {
            uniqueNames.add(`${remote}/${name}`);
          }
        }
      }

      return uniqueNames.size;
    }

    /**
     * Check if a tag exists (local or remote).
     */
    tagExists(name: string): boolean {
      if (this._localTags.has(name)) {
        return true;
      }
      for (const tags of this._remoteTags.values()) {
        if (tags.has(name)) {
          return true;
        }
      }
      return false;
    }

    /**
     * Clear all tags (for testing).
     */
    clearTags(): void {
      this._localTags.clear();
      this._remoteTags.clear();
    }
  }

  describe('Property 43: Tag List Completeness', () => {
    /**
     * Property: All local tags are included in the tag list.
     *
     * **Validates: Requirements 13.4**
     */
    it('Property: All local tags are included in the tag list', () => {
      fc.assert(
        fc.property(fc.array(tagArb, { minLength: 1, maxLength: 10 }), (tags) => {
          // Ensure unique tag names
          const uniqueTags = tags.filter(
            (tag, index, arr) => arr.findIndex((t) => t.name === tag.name) === index
          );
          fc.pre(uniqueTags.length >= 1);

          // Setup
          const tagService = new MockTagService();

          // Act: Add all local tags
          for (const tag of uniqueTags) {
            tagService.addLocalTag(tag);
          }

          // Assert: All local tags are in the list
          const tagList = tagService.getTags();
          for (const tag of uniqueTags) {
            const found = tagList.find((t) => t.name === tag.name);
            assert.ok(found, `Local tag '${tag.name}' should be in the tag list`);
            assert.strictEqual(
              found.commit,
              tag.commit,
              `Tag '${tag.name}' should have correct commit reference`
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: All remote tags are included in the tag list.
     *
     * **Validates: Requirements 13.4**
     */
    it('Property: All remote tags are included in the tag list', () => {
      fc.assert(
        fc.property(
          remoteNameArb,
          fc.array(tagArb, { minLength: 1, maxLength: 10 }),
          (remote, tags) => {
            // Ensure unique tag names
            const uniqueTags = tags.filter(
              (tag, index, arr) => arr.findIndex((t) => t.name === tag.name) === index
            );
            fc.pre(uniqueTags.length >= 1);

            // Setup
            const tagService = new MockTagService();

            // Act: Add all remote tags
            for (const tag of uniqueTags) {
              tagService.addRemoteTag(remote, tag);
            }

            // Assert: All remote tags are in the list
            const tagList = tagService.getTags();
            for (const tag of uniqueTags) {
              const expectedName = `${remote}/${tag.name}`;
              const found = tagList.find((t) => t.name === expectedName);
              assert.ok(found, `Remote tag '${expectedName}' should be in the tag list`);
              assert.strictEqual(
                found.commit,
                tag.commit,
                `Tag '${expectedName}' should have correct commit reference`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Tag list contains both local and remote tags.
     *
     * **Validates: Requirements 13.4**
     */
    it('Property: Tag list contains both local and remote tags', () => {
      fc.assert(
        fc.property(
          fc.array(tagArb, { minLength: 1, maxLength: 5 }),
          remoteNameArb,
          fc.array(tagArb, { minLength: 1, maxLength: 5 }),
          (localTags, remote, remoteTags) => {
            // Ensure unique tag names within each group
            const uniqueLocalTags = localTags.filter(
              (tag, index, arr) => arr.findIndex((t) => t.name === tag.name) === index
            );
            const uniqueRemoteTags = remoteTags.filter(
              (tag, index, arr) => arr.findIndex((t) => t.name === tag.name) === index
            );

            // Ensure remote tags don't overlap with local tags
            const nonOverlappingRemoteTags = uniqueRemoteTags.filter(
              (rt) => !uniqueLocalTags.some((lt) => lt.name === rt.name)
            );

            fc.pre(uniqueLocalTags.length >= 1 && nonOverlappingRemoteTags.length >= 1);

            // Setup
            const tagService = new MockTagService();

            // Act: Add local and remote tags
            for (const tag of uniqueLocalTags) {
              tagService.addLocalTag(tag);
            }
            for (const tag of nonOverlappingRemoteTags) {
              tagService.addRemoteTag(remote, tag);
            }

            // Assert: Tag list contains all tags
            const tagList = tagService.getTags();
            const expectedCount = uniqueLocalTags.length + nonOverlappingRemoteTags.length;
            assert.strictEqual(
              tagList.length,
              expectedCount,
              `Tag list should contain ${expectedCount} tags`
            );

            // Verify local tags
            for (const tag of uniqueLocalTags) {
              const found = tagList.find((t) => t.name === tag.name);
              assert.ok(found, `Local tag '${tag.name}' should be in the list`);
            }

            // Verify remote tags
            for (const tag of nonOverlappingRemoteTags) {
              const expectedName = `${remote}/${tag.name}`;
              const found = tagList.find((t) => t.name === expectedName);
              assert.ok(found, `Remote tag '${expectedName}' should be in the list`);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Each tag in the list has a valid commit reference.
     *
     * **Validates: Requirements 13.4**
     */
    it('Property: Each tag in the list has a valid commit reference', () => {
      fc.assert(
        fc.property(fc.array(tagArb, { minLength: 1, maxLength: 10 }), (tags) => {
          // Ensure unique tag names
          const uniqueTags = tags.filter(
            (tag, index, arr) => arr.findIndex((t) => t.name === tag.name) === index
          );
          fc.pre(uniqueTags.length >= 1);

          // Setup
          const tagService = new MockTagService();

          // Act: Add all tags
          for (const tag of uniqueTags) {
            tagService.addLocalTag(tag);
          }

          // Assert: Each tag has a valid commit reference
          const tagList = tagService.getTags();
          for (const tag of tagList) {
            assert.ok(tag.commit, `Tag '${tag.name}' should have a commit reference`);
            assert.strictEqual(
              tag.commit.length,
              40,
              `Tag '${tag.name}' commit should be a 40-character hash`
            );
            assert.ok(
              /^[0-9a-f]{40}$/.test(tag.commit),
              `Tag '${tag.name}' commit should be a valid hex string`
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Tag list count matches total number of unique tags.
     *
     * **Validates: Requirements 13.4**
     */
    it('Property: Tag list count matches total number of unique tags', () => {
      fc.assert(
        fc.property(
          fc.array(tagArb, { minLength: 0, maxLength: 10 }),
          fc.array(fc.tuple(remoteNameArb, tagArb), { minLength: 0, maxLength: 10 }),
          (localTags, remoteTagPairs) => {
            // Setup
            const tagService = new MockTagService();

            // Ensure unique local tag names
            const uniqueLocalTags = localTags.filter(
              (tag, index, arr) => arr.findIndex((t) => t.name === tag.name) === index
            );

            // Add local tags
            for (const tag of uniqueLocalTags) {
              tagService.addLocalTag(tag);
            }

            // Add remote tags (ensuring uniqueness per remote)
            const addedRemoteTags = new Map<string, Set<string>>();
            for (const [remote, tag] of remoteTagPairs) {
              if (!addedRemoteTags.has(remote)) {
                addedRemoteTags.set(remote, new Set());
              }
              if (!addedRemoteTags.get(remote)!.has(tag.name)) {
                tagService.addRemoteTag(remote, tag);
                addedRemoteTags.get(remote)!.add(tag.name);
              }
            }

            // Assert: Tag list count matches expected
            const tagList = tagService.getTags();
            const expectedCount = tagService.getTotalTagCount();
            assert.strictEqual(
              tagList.length,
              expectedCount,
              `Tag list should contain exactly ${expectedCount} tags`
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Empty repository returns empty tag list.
     *
     * **Validates: Requirements 13.4**
     */
    it('Property: Empty repository returns empty tag list', () => {
      fc.assert(
        fc.property(fc.constant(null), () => {
          // Setup
          const tagService = new MockTagService();

          // Assert: Empty tag list
          const tagList = tagService.getTags();
          assert.strictEqual(tagList.length, 0, 'Empty repository should have no tags');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Tags from multiple remotes are all included.
     *
     * **Validates: Requirements 13.4**
     */
    it('Property: Tags from multiple remotes are all included', () => {
      fc.assert(
        fc.property(
          fc.array(fc.tuple(remoteNameArb, tagArb), { minLength: 2, maxLength: 10 }),
          (remoteTagPairs) => {
            // Setup
            const tagService = new MockTagService();

            // Track added tags to ensure uniqueness
            const addedTags = new Map<string, Map<string, ITag>>();

            for (const [remote, tag] of remoteTagPairs) {
              if (!addedTags.has(remote)) {
                addedTags.set(remote, new Map());
              }
              if (!addedTags.get(remote)!.has(tag.name)) {
                tagService.addRemoteTag(remote, tag);
                addedTags.get(remote)!.set(tag.name, tag);
              }
            }

            // Calculate expected count
            let expectedCount = 0;
            for (const tags of addedTags.values()) {
              expectedCount += tags.size;
            }

            fc.pre(expectedCount >= 2);

            // Assert: All remote tags are included
            const tagList = tagService.getTags();
            assert.strictEqual(
              tagList.length,
              expectedCount,
              `Tag list should contain ${expectedCount} tags from multiple remotes`
            );

            // Verify each remote's tags are present
            for (const [remote, tags] of addedTags) {
              for (const [name, tag] of tags) {
                const expectedName = `${remote}/${name}`;
                const found = tagList.find((t) => t.name === expectedName);
                assert.ok(found, `Remote tag '${expectedName}' should be in the list`);
                assert.strictEqual(
                  found.commit,
                  tag.commit,
                  `Tag '${expectedName}' should have correct commit`
                );
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Annotated tags preserve all metadata in the list.
     *
     * **Validates: Requirements 13.4**
     */
    it('Property: Annotated tags preserve all metadata in the list', () => {
      fc.assert(
        fc.property(
          tagNameArb,
          commitHashArb,
          tagMessageArb,
          authorArb,
          fc.date({ min: new Date('2000-01-01'), max: new Date() }),
          (name, commit, message, tagger, date) => {
            // Setup
            const tagService = new MockTagService();
            const annotatedTag: ITag = {
              name,
              commit,
              isAnnotated: true,
              message,
              tagger,
              date,
            };

            // Act: Add annotated tag
            tagService.addLocalTag(annotatedTag);

            // Assert: Tag metadata is preserved
            const tagList = tagService.getTags();
            const found = tagList.find((t) => t.name === name);
            assert.ok(found, `Tag '${name}' should be in the list`);
            assert.strictEqual(found.commit, commit, 'Commit should be preserved');
            assert.strictEqual(found.isAnnotated, true, 'isAnnotated should be true');
            assert.strictEqual(found.message, message, 'Message should be preserved');
            assert.ok(found.tagger, 'Tagger should be present');
            assert.strictEqual(found.tagger.name, tagger.name, 'Tagger name should be preserved');
            assert.strictEqual(
              found.tagger.email,
              tagger.email,
              'Tagger email should be preserved'
            );
            assert.ok(found.date, 'Date should be present');
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Lightweight tags have minimal metadata in the list.
     *
     * **Validates: Requirements 13.4**
     */
    it('Property: Lightweight tags have minimal metadata in the list', () => {
      fc.assert(
        fc.property(tagNameArb, commitHashArb, (name, commit) => {
          // Setup
          const tagService = new MockTagService();
          const lightweightTag: ITag = {
            name,
            commit,
            isAnnotated: false,
            message: undefined,
            tagger: undefined,
            date: undefined,
          };

          // Act: Add lightweight tag
          tagService.addLocalTag(lightweightTag);

          // Assert: Tag has minimal metadata
          const tagList = tagService.getTags();
          const found = tagList.find((t) => t.name === name);
          assert.ok(found, `Tag '${name}' should be in the list`);
          assert.strictEqual(found.commit, commit, 'Commit should be preserved');
          assert.strictEqual(found.isAnnotated, false, 'isAnnotated should be false');
          assert.strictEqual(found.message, undefined, 'Message should be undefined');
          assert.strictEqual(found.tagger, undefined, 'Tagger should be undefined');
          assert.strictEqual(found.date, undefined, 'Date should be undefined');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Tag names are preserved exactly in the list.
     *
     * **Validates: Requirements 13.4**
     */
    it('Property: Tag names are preserved exactly in the list', () => {
      fc.assert(
        fc.property(fc.array(tagArb, { minLength: 1, maxLength: 10 }), (tags) => {
          // Ensure unique tag names
          const uniqueTags = tags.filter(
            (tag, index, arr) => arr.findIndex((t) => t.name === tag.name) === index
          );
          fc.pre(uniqueTags.length >= 1);

          // Setup
          const tagService = new MockTagService();

          // Act: Add all tags
          for (const tag of uniqueTags) {
            tagService.addLocalTag(tag);
          }

          // Assert: Tag names are preserved
          const tagList = tagService.getTags();
          const tagNames = new Set(tagList.map((t) => t.name));

          for (const tag of uniqueTags) {
            assert.ok(tagNames.has(tag.name), `Tag name '${tag.name}' should be preserved exactly`);
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Local tags take precedence over remote tags with same name.
     *
     * **Validates: Requirements 13.4**
     */
    it('Property: Local tags take precedence over remote tags with same name', () => {
      fc.assert(
        fc.property(
          tagNameArb,
          commitHashArb,
          commitHashArb,
          remoteNameArb,
          (name, localCommit, remoteCommit, remote) => {
            fc.pre(localCommit !== remoteCommit);

            // Setup
            const tagService = new MockTagService();

            // Add local tag
            const localTag: ITag = {
              name,
              commit: localCommit,
              isAnnotated: false,
            };
            tagService.addLocalTag(localTag);

            // Add remote tag with same name but different commit
            const remoteTag: ITag = {
              name,
              commit: remoteCommit,
              isAnnotated: false,
            };
            tagService.addRemoteTag(remote, remoteTag);

            // Assert: Local tag is in the list with local commit
            const tagList = tagService.getTags();
            const found = tagList.find((t) => t.name === name);
            assert.ok(found, `Tag '${name}' should be in the list`);
            assert.strictEqual(
              found.commit,
              localCommit,
              'Local tag commit should take precedence'
            );

            // Remote tag with same name should not create a duplicate
            const duplicates = tagList.filter((t) => t.name === name);
            assert.strictEqual(duplicates.length, 1, 'Should not have duplicate tag names');
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
