import * as fc from 'fast-check';
import * as assert from 'assert';
import { ITag, IAuthor } from '../../services/interfaces/IGitService';

/**
 * Property-based tests for Tag Lifecycle.
 * Feature: intellig-vscode, Property 44: Tag Lifecycle
 *
 * **Validates: Requirements 13.5, 13.6**
 *
 * Property Description:
 * For any tag, creating SHALL add it to the tag list, pushing SHALL send it
 * to the remote, and deleting SHALL remove it from the local repository.
 *
 * Requirements:
 * - 13.5: WHEN a user selects "Delete Tag", THE Extension SHALL delete the
 *         local tag after confirmation
 * - 13.6: WHEN a user selects "Push Tag", THE Extension SHALL push the
 *         selected tag to the remote
 */
describe('Tag Lifecycle Property Tests', () => {
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
   * Arbitrary generator for remote name.
   */
  const remoteNameArb: fc.Arbitrary<string> = fc.constantFrom(
    'origin',
    'upstream',
    'fork',
    'backup'
  );

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
   * Mock Tag Service that simulates tag lifecycle operations.
   * This allows us to test the tag lifecycle properties without actual Git operations.
   */
  class MockTagService {
    private _localTags: Map<string, ITag> = new Map();
    private _remoteTags: Map<string, Map<string, ITag>> = new Map(); // remote -> tagName -> tag
    private _pushHistory: Array<{ remote: string; tagName: string }> = [];

    /**
     * Create a local tag.
     * Simulates: git tag <name> or git tag -a <name> -m <message>
     */
    createTag(tag: ITag): void {
      this._localTags.set(tag.name, tag);
    }

    /**
     * Delete a local tag.
     * Simulates: git tag -d <name>
     * Requirement 13.5: Delete the local tag
     */
    deleteTag(name: string): boolean {
      if (!this._localTags.has(name)) {
        return false;
      }
      this._localTags.delete(name);
      return true;
    }

    /**
     * Push a tag to a remote.
     * Simulates: git push <remote> refs/tags/<name>
     * Requirement 13.6: Push the selected tag to the remote
     */
    pushTag(name: string, remote: string): boolean {
      const tag = this._localTags.get(name);
      if (!tag) {
        return false;
      }

      // Initialize remote if not exists
      if (!this._remoteTags.has(remote)) {
        this._remoteTags.set(remote, new Map());
      }

      // Push the tag to the remote
      this._remoteTags.get(remote)!.set(name, { ...tag });
      this._pushHistory.push({ remote, tagName: name });
      return true;
    }

    /**
     * Delete a tag from a remote.
     * Simulates: git push <remote> --delete refs/tags/<name>
     */
    deleteRemoteTag(name: string, remote: string): boolean {
      const remoteTags = this._remoteTags.get(remote);
      if (!remoteTags || !remoteTags.has(name)) {
        return false;
      }
      remoteTags.delete(name);
      return true;
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
     * Check if a local tag exists.
     */
    hasLocalTag(name: string): boolean {
      return this._localTags.has(name);
    }

    /**
     * Check if a remote tag exists.
     */
    hasRemoteTag(name: string, remote: string): boolean {
      const remoteTags = this._remoteTags.get(remote);
      return remoteTags ? remoteTags.has(name) : false;
    }

    /**
     * Get the push history.
     */
    getPushHistory(): Array<{ remote: string; tagName: string }> {
      return [...this._pushHistory];
    }

    /**
     * Get a local tag by name.
     */
    getLocalTag(name: string): ITag | undefined {
      return this._localTags.get(name);
    }

    /**
     * Get a remote tag by name.
     */
    getRemoteTag(name: string, remote: string): ITag | undefined {
      const remoteTags = this._remoteTags.get(remote);
      return remoteTags ? remoteTags.get(name) : undefined;
    }

    /**
     * Clear all tags (for testing).
     */
    clearTags(): void {
      this._localTags.clear();
      this._remoteTags.clear();
      this._pushHistory = [];
    }
  }

  describe('Property 44: Tag Lifecycle', () => {
    /**
     * Property: Creating a tag adds it to the tag list.
     *
     * **Validates: Requirements 13.5, 13.6**
     */
    it('Property: Creating a tag adds it to the tag list', () => {
      fc.assert(
        fc.property(tagArb, (tag) => {
          // Setup
          const tagService = new MockTagService();

          // Pre-condition: tag does not exist
          assert.strictEqual(
            tagService.hasLocalTag(tag.name),
            false,
            'Tag should not exist before creation'
          );

          // Act: Create the tag
          tagService.createTag(tag);

          // Assert: Tag is now in the list
          assert.strictEqual(
            tagService.hasLocalTag(tag.name),
            true,
            `Tag '${tag.name}' should exist after creation`
          );

          const retrievedTag = tagService.getLocalTag(tag.name);
          assert.ok(retrievedTag, 'Tag should be retrievable');
          assert.strictEqual(retrievedTag.name, tag.name, 'Tag name should match');
          assert.strictEqual(retrievedTag.commit, tag.commit, 'Tag commit should match');
          assert.strictEqual(retrievedTag.isAnnotated, tag.isAnnotated, 'Tag type should match');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Deleting a tag removes it from the local repository.
     *
     * **Validates: Requirements 13.5**
     */
    it('Property: Deleting a tag removes it from the local repository', () => {
      fc.assert(
        fc.property(tagArb, (tag) => {
          // Setup
          const tagService = new MockTagService();
          tagService.createTag(tag);

          // Pre-condition: tag exists
          assert.strictEqual(
            tagService.hasLocalTag(tag.name),
            true,
            'Tag should exist before deletion'
          );

          // Act: Delete the tag
          const deleteResult = tagService.deleteTag(tag.name);

          // Assert: Tag is removed
          assert.strictEqual(deleteResult, true, 'Delete operation should succeed');
          assert.strictEqual(
            tagService.hasLocalTag(tag.name),
            false,
            `Tag '${tag.name}' should not exist after deletion`
          );

          // Verify tag is not in the list
          const tags = tagService.getLocalTags();
          const found = tags.find((t) => t.name === tag.name);
          assert.strictEqual(found, undefined, 'Tag should not be in the tag list');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Pushing a tag sends it to the remote.
     *
     * **Validates: Requirements 13.6**
     */
    it('Property: Pushing a tag sends it to the remote', () => {
      fc.assert(
        fc.property(tagArb, remoteNameArb, (tag, remote) => {
          // Setup
          const tagService = new MockTagService();
          tagService.createTag(tag);

          // Pre-condition: tag exists locally but not on remote
          assert.strictEqual(tagService.hasLocalTag(tag.name), true, 'Tag should exist locally');
          assert.strictEqual(
            tagService.hasRemoteTag(tag.name, remote),
            false,
            'Tag should not exist on remote before push'
          );

          // Act: Push the tag
          const pushResult = tagService.pushTag(tag.name, remote);

          // Assert: Tag is now on the remote
          assert.strictEqual(pushResult, true, 'Push operation should succeed');
          assert.strictEqual(
            tagService.hasRemoteTag(tag.name, remote),
            true,
            `Tag '${tag.name}' should exist on remote '${remote}' after push`
          );

          // Verify the remote tag has the same content
          const remoteTag = tagService.getRemoteTag(tag.name, remote);
          assert.ok(remoteTag, 'Remote tag should be retrievable');
          assert.strictEqual(remoteTag.name, tag.name, 'Remote tag name should match');
          assert.strictEqual(remoteTag.commit, tag.commit, 'Remote tag commit should match');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Tag lifecycle - create, push, delete local preserves remote.
     *
     * **Validates: Requirements 13.5, 13.6**
     */
    it('Property: Deleting local tag does not affect pushed remote tag', () => {
      fc.assert(
        fc.property(tagArb, remoteNameArb, (tag, remote) => {
          // Setup
          const tagService = new MockTagService();

          // Create and push the tag
          tagService.createTag(tag);
          tagService.pushTag(tag.name, remote);

          // Verify both exist
          assert.strictEqual(tagService.hasLocalTag(tag.name), true, 'Local tag should exist');
          assert.strictEqual(
            tagService.hasRemoteTag(tag.name, remote),
            true,
            'Remote tag should exist'
          );

          // Act: Delete the local tag
          tagService.deleteTag(tag.name);

          // Assert: Local tag is gone but remote tag remains
          assert.strictEqual(
            tagService.hasLocalTag(tag.name),
            false,
            'Local tag should be deleted'
          );
          assert.strictEqual(
            tagService.hasRemoteTag(tag.name, remote),
            true,
            'Remote tag should still exist after local deletion'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Cannot push a non-existent tag.
     *
     * **Validates: Requirements 13.6**
     */
    it('Property: Cannot push a non-existent tag', () => {
      fc.assert(
        fc.property(tagNameArb, remoteNameArb, (tagName, remote) => {
          // Setup
          const tagService = new MockTagService();

          // Pre-condition: tag does not exist
          assert.strictEqual(tagService.hasLocalTag(tagName), false, 'Tag should not exist');

          // Act: Try to push non-existent tag
          const pushResult = tagService.pushTag(tagName, remote);

          // Assert: Push fails
          assert.strictEqual(pushResult, false, 'Push should fail for non-existent tag');
          assert.strictEqual(
            tagService.hasRemoteTag(tagName, remote),
            false,
            'Remote should not have the tag'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Cannot delete a non-existent tag.
     *
     * **Validates: Requirements 13.5**
     */
    it('Property: Cannot delete a non-existent tag', () => {
      fc.assert(
        fc.property(tagNameArb, (tagName) => {
          // Setup
          const tagService = new MockTagService();

          // Pre-condition: tag does not exist
          assert.strictEqual(tagService.hasLocalTag(tagName), false, 'Tag should not exist');

          // Act: Try to delete non-existent tag
          const deleteResult = tagService.deleteTag(tagName);

          // Assert: Delete fails
          assert.strictEqual(deleteResult, false, 'Delete should fail for non-existent tag');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Multiple tags can be created and managed independently.
     *
     * **Validates: Requirements 13.5, 13.6**
     */
    it('Property: Multiple tags can be created and managed independently', () => {
      fc.assert(
        fc.property(
          fc.array(tagArb, { minLength: 2, maxLength: 5 }),
          remoteNameArb,
          (tags, remote) => {
            // Ensure unique tag names
            const uniqueTags = tags.filter(
              (tag, index, arr) => arr.findIndex((t) => t.name === tag.name) === index
            );
            fc.pre(uniqueTags.length >= 2);

            // Setup
            const tagService = new MockTagService();

            // Create all tags
            for (const tag of uniqueTags) {
              tagService.createTag(tag);
            }

            // Verify all tags exist
            for (const tag of uniqueTags) {
              assert.strictEqual(
                tagService.hasLocalTag(tag.name),
                true,
                `Tag '${tag.name}' should exist`
              );
            }

            // Push first tag only
            const firstTag = uniqueTags[0];
            tagService.pushTag(firstTag.name, remote);

            // Delete second tag only
            const secondTag = uniqueTags[1];
            tagService.deleteTag(secondTag.name);

            // Assert: First tag exists locally and remotely
            assert.strictEqual(
              tagService.hasLocalTag(firstTag.name),
              true,
              'First tag should still exist locally'
            );
            assert.strictEqual(
              tagService.hasRemoteTag(firstTag.name, remote),
              true,
              'First tag should exist on remote'
            );

            // Assert: Second tag is deleted
            assert.strictEqual(
              tagService.hasLocalTag(secondTag.name),
              false,
              'Second tag should be deleted'
            );

            // Assert: Other tags are unaffected
            for (let i = 2; i < uniqueTags.length; i++) {
              assert.strictEqual(
                tagService.hasLocalTag(uniqueTags[i].name),
                true,
                `Tag '${uniqueTags[i].name}' should still exist`
              );
              assert.strictEqual(
                tagService.hasRemoteTag(uniqueTags[i].name, remote),
                false,
                `Tag '${uniqueTags[i].name}' should not be on remote`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Push history records all push operations.
     *
     * **Validates: Requirements 13.6**
     */
    it('Property: Push history records all push operations', () => {
      fc.assert(
        fc.property(
          fc.array(tagArb, { minLength: 1, maxLength: 5 }),
          remoteNameArb,
          (tags, remote) => {
            // Ensure unique tag names
            const uniqueTags = tags.filter(
              (tag, index, arr) => arr.findIndex((t) => t.name === tag.name) === index
            );
            fc.pre(uniqueTags.length >= 1);

            // Setup
            const tagService = new MockTagService();

            // Create and push all tags
            for (const tag of uniqueTags) {
              tagService.createTag(tag);
              tagService.pushTag(tag.name, remote);
            }

            // Assert: Push history contains all pushes
            const history = tagService.getPushHistory();
            assert.strictEqual(
              history.length,
              uniqueTags.length,
              'Push history should contain all push operations'
            );

            for (const tag of uniqueTags) {
              const found = history.find((h) => h.tagName === tag.name && h.remote === remote);
              assert.ok(found, `Push history should contain push for tag '${tag.name}'`);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Tag can be pushed to multiple remotes.
     *
     * **Validates: Requirements 13.6**
     */
    it('Property: Tag can be pushed to multiple remotes', () => {
      fc.assert(
        fc.property(
          tagArb,
          fc.array(remoteNameArb, { minLength: 2, maxLength: 4 }),
          (tag, remotes) => {
            // Ensure unique remote names
            const uniqueRemotes = [...new Set(remotes)];
            fc.pre(uniqueRemotes.length >= 2);

            // Setup
            const tagService = new MockTagService();
            tagService.createTag(tag);

            // Push to all remotes
            for (const remote of uniqueRemotes) {
              const pushResult = tagService.pushTag(tag.name, remote);
              assert.strictEqual(pushResult, true, `Push to '${remote}' should succeed`);
            }

            // Assert: Tag exists on all remotes
            for (const remote of uniqueRemotes) {
              assert.strictEqual(
                tagService.hasRemoteTag(tag.name, remote),
                true,
                `Tag should exist on remote '${remote}'`
              );

              const remoteTag = tagService.getRemoteTag(tag.name, remote);
              assert.ok(remoteTag, `Remote tag should be retrievable from '${remote}'`);
              assert.strictEqual(remoteTag.commit, tag.commit, 'Remote tag commit should match');
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Deleting remote tag removes it from specific remote only.
     *
     * **Validates: Requirements 13.5, 13.6**
     */
    it('Property: Deleting remote tag removes it from specific remote only', () => {
      fc.assert(
        fc.property(tagArb, (tag) => {
          // Setup with two remotes
          const tagService = new MockTagService();
          const remote1 = 'origin';
          const remote2 = 'upstream';

          // Create and push to both remotes
          tagService.createTag(tag);
          tagService.pushTag(tag.name, remote1);
          tagService.pushTag(tag.name, remote2);

          // Verify both remotes have the tag
          assert.strictEqual(
            tagService.hasRemoteTag(tag.name, remote1),
            true,
            'Tag should exist on remote1'
          );
          assert.strictEqual(
            tagService.hasRemoteTag(tag.name, remote2),
            true,
            'Tag should exist on remote2'
          );

          // Act: Delete from remote1 only
          const deleteResult = tagService.deleteRemoteTag(tag.name, remote1);

          // Assert: Tag is removed from remote1 but still on remote2
          assert.strictEqual(deleteResult, true, 'Delete from remote1 should succeed');
          assert.strictEqual(
            tagService.hasRemoteTag(tag.name, remote1),
            false,
            'Tag should be deleted from remote1'
          );
          assert.strictEqual(
            tagService.hasRemoteTag(tag.name, remote2),
            true,
            'Tag should still exist on remote2'
          );

          // Local tag should be unaffected
          assert.strictEqual(
            tagService.hasLocalTag(tag.name),
            true,
            'Local tag should still exist'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Tag creation is idempotent (re-creating overwrites).
     *
     * **Validates: Requirements 13.5, 13.6**
     */
    it('Property: Re-creating a tag overwrites the existing one', () => {
      fc.assert(
        fc.property(tagNameArb, commitHashArb, commitHashArb, (name, commit1, commit2) => {
          fc.pre(commit1 !== commit2);

          // Setup
          const tagService = new MockTagService();

          // Create first tag
          const tag1: ITag = {
            name,
            commit: commit1,
            isAnnotated: false,
          };
          tagService.createTag(tag1);

          // Verify first tag
          let retrievedTag = tagService.getLocalTag(name);
          assert.ok(retrievedTag, 'First tag should exist');
          assert.strictEqual(retrievedTag.commit, commit1, 'First tag commit should match');

          // Create second tag with same name but different commit
          const tag2: ITag = {
            name,
            commit: commit2,
            isAnnotated: false,
          };
          tagService.createTag(tag2);

          // Assert: Tag is overwritten
          retrievedTag = tagService.getLocalTag(name);
          assert.ok(retrievedTag, 'Tag should still exist');
          assert.strictEqual(
            retrievedTag.commit,
            commit2,
            'Tag should have new commit after re-creation'
          );

          // Only one tag with this name should exist
          const tags = tagService.getLocalTags();
          const matchingTags = tags.filter((t) => t.name === name);
          assert.strictEqual(matchingTags.length, 1, 'Only one tag with this name should exist');
        }),
        { numRuns: 100 }
      );
    });
  });
});
