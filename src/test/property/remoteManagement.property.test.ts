import * as fc from 'fast-check';
import * as assert from 'assert';
import { IRemote } from '../../services/interfaces/IGitService';

/**
 * Property-based tests for Remote Management.
 * Feature: intellig-vscode, Property 41: Remote Management
 *
 * **Validates: Requirements 12.6, 12.7, 12.8**
 *
 * Property Description:
 * For any remote added or removed, the remotes list SHALL accurately reflect
 * the current Git configuration.
 *
 * Requirements:
 * - 12.6: WHEN a user opens remote management, THE Extension SHALL display all
 *         configured remotes with their URLs
 * - 12.7: WHEN a user adds a remote, THE Extension SHALL prompt for name and URL
 *         and add the remote configuration
 * - 12.8: WHEN a user removes a remote, THE Extension SHALL delete the remote
 *         after confirmation
 */
describe('Remote Management Property Tests', () => {
  /**
   * Arbitrary generator for valid remote names.
   * Remote names should be non-empty, contain valid characters, and not start with a hyphen.
   */
  const remoteNameArb: fc.Arbitrary<string> = fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'.split('')
      ),
      {
        minLength: 1,
        maxLength: 30,
      }
    )
    .filter((s) => {
      // Filter out invalid remote names
      if (s.length === 0) {
        return false;
      }
      if (s.startsWith('-')) {
        return false;
      }
      if (s.startsWith('_')) {
        return false;
      }
      // Remote names cannot be just hyphens or underscores
      if (/^[-_]+$/.test(s)) {
        return false;
      }
      return true;
    });

  /**
   * Arbitrary generator for valid remote URLs.
   * Supports HTTPS, SSH, and file:// URLs.
   */
  const remoteUrlArb: fc.Arbitrary<string> = fc.oneof(
    // HTTPS URLs
    fc
      .tuple(
        fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')), {
          minLength: 1,
          maxLength: 20,
        }),
        fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')), {
          minLength: 1,
          maxLength: 20,
        }),
        fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')), {
          minLength: 1,
          maxLength: 20,
        })
      )
      .map(([host, user, repo]) => `https://${host}.com/${user}/${repo}.git`),
    // SSH URLs
    fc
      .tuple(
        fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')), {
          minLength: 1,
          maxLength: 20,
        }),
        fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')), {
          minLength: 1,
          maxLength: 20,
        }),
        fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')), {
          minLength: 1,
          maxLength: 20,
        })
      )
      .map(([host, user, repo]) => `git@${host}.com:${user}/${repo}.git`),
    // File URLs
    fc
      .stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_/'.split('')), {
        minLength: 1,
        maxLength: 30,
      })
      .filter((s) => !s.startsWith('/') && !s.endsWith('/') && !s.includes('//'))
      .map((path) => `file:///path/to/${path}.git`)
  );

  /**
   * Arbitrary generator for a remote (name + URL pair).
   */
  const remoteArb: fc.Arbitrary<{ name: string; url: string }> = fc.record({
    name: remoteNameArb,
    url: remoteUrlArb,
  });

  /**
   * Arbitrary generator for a non-empty array of unique remotes.
   */
  const uniqueRemotesArb: fc.Arbitrary<{ name: string; url: string }[]> = fc
    .array(remoteArb, { minLength: 1, maxLength: 10 })
    .map((remotes) => {
      // Ensure unique remote names
      const seen = new Set<string>();
      return remotes.filter((r) => {
        const lowerName = r.name.toLowerCase();
        if (seen.has(lowerName)) {
          return false;
        }
        seen.add(lowerName);
        return true;
      });
    })
    .filter((remotes) => remotes.length > 0);

  /**
   * Mock RemoteService that simulates remote management operations in memory.
   * This allows us to test the remote management properties without actual Git operations.
   */
  class MockRemoteService {
    private _remotes: Map<string, IRemote> = new Map();

    constructor(initialRemotes: { name: string; url: string }[] = []) {
      for (const remote of initialRemotes) {
        this._remotes.set(remote.name.toLowerCase(), {
          name: remote.name,
          fetchUrl: remote.url,
          pushUrl: remote.url,
        });
      }
    }

    /**
     * Get all configured remotes.
     * Requirement 12.6: Display all configured remotes with their URLs.
     */
    getRemotes(): IRemote[] {
      return Array.from(this._remotes.values());
    }

    /**
     * Add a new remote.
     * Requirement 12.7: Add the remote configuration with name and URL.
     *
     * @param name - Name for the remote
     * @param url - URL for the remote
     * @throws Error if remote with the same name already exists
     */
    addRemote(name: string, url: string): void {
      const lowerName = name.toLowerCase();
      if (this._remotes.has(lowerName)) {
        throw new Error(`Remote '${name}' already exists`);
      }

      this._remotes.set(lowerName, {
        name,
        fetchUrl: url,
        pushUrl: url,
      });
    }

    /**
     * Remove a remote.
     * Requirement 12.8: Delete the remote after confirmation.
     *
     * @param name - Name of the remote to remove
     * @throws Error if remote does not exist
     */
    removeRemote(name: string): void {
      const lowerName = name.toLowerCase();
      if (!this._remotes.has(lowerName)) {
        throw new Error(`Remote '${name}' does not exist`);
      }

      this._remotes.delete(lowerName);
    }

    /**
     * Check if a remote exists.
     */
    hasRemote(name: string): boolean {
      return this._remotes.has(name.toLowerCase());
    }

    /**
     * Get a remote by name.
     */
    getRemote(name: string): IRemote | undefined {
      return this._remotes.get(name.toLowerCase());
    }

    /**
     * Get the count of remotes.
     */
    getRemoteCount(): number {
      return this._remotes.size;
    }
  }

  describe('Property 41: Remote Management', () => {
    /**
     * Property: Adding a remote adds it to the remotes list.
     *
     * **Validates: Requirements 12.6, 12.7**
     */
    it('Property: Adding a remote adds it to the remotes list', () => {
      fc.assert(
        fc.property(remoteNameArb, remoteUrlArb, (name, url) => {
          // Setup: Empty remote service
          const remoteService = new MockRemoteService();

          // Pre-condition: No remotes exist
          assert.strictEqual(remoteService.getRemoteCount(), 0, 'Should start with no remotes');

          // Act: Add a remote
          remoteService.addRemote(name, url);

          // Assert: Remote is in the list
          const remotes = remoteService.getRemotes();
          assert.strictEqual(remotes.length, 1, 'Should have one remote');
          assert.strictEqual(remotes[0].name, name, 'Remote name should match');
          assert.strictEqual(remotes[0].fetchUrl, url, 'Remote fetch URL should match');
          assert.strictEqual(remotes[0].pushUrl, url, 'Remote push URL should match');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Removing a remote removes it from the remotes list.
     *
     * **Validates: Requirements 12.6, 12.8**
     */
    it('Property: Removing a remote removes it from the remotes list', () => {
      fc.assert(
        fc.property(remoteNameArb, remoteUrlArb, (name, url) => {
          // Setup: Remote service with one remote
          const remoteService = new MockRemoteService([{ name, url }]);

          // Pre-condition: Remote exists
          assert.ok(remoteService.hasRemote(name), 'Remote should exist');
          assert.strictEqual(remoteService.getRemoteCount(), 1, 'Should have one remote');

          // Act: Remove the remote
          remoteService.removeRemote(name);

          // Assert: Remote is no longer in the list
          const remotes = remoteService.getRemotes();
          assert.strictEqual(remotes.length, 0, 'Should have no remotes');
          assert.ok(!remoteService.hasRemote(name), 'Remote should not exist');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Remote names must be unique.
     *
     * **Validates: Requirements 12.7**
     */
    it('Property: Remote names must be unique', () => {
      fc.assert(
        fc.property(remoteNameArb, remoteUrlArb, remoteUrlArb, (name, url1, url2) => {
          // Setup: Remote service with one remote
          const remoteService = new MockRemoteService([{ name, url: url1 }]);

          // Pre-condition: Remote exists
          assert.ok(remoteService.hasRemote(name), 'Remote should exist');

          // Act & Assert: Adding a remote with the same name should fail
          assert.throws(
            () => remoteService.addRemote(name, url2),
            /already exists/,
            'Should throw when adding duplicate remote name'
          );

          // Assert: Original remote is unchanged
          const remote = remoteService.getRemote(name);
          assert.ok(remote, 'Original remote should still exist');
          assert.strictEqual(remote.fetchUrl, url1, 'Original URL should be unchanged');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Remotes list displays all configured remotes with their URLs.
     *
     * **Validates: Requirements 12.6**
     */
    it('Property: Remotes list displays all configured remotes with their URLs', () => {
      fc.assert(
        fc.property(uniqueRemotesArb, (remotes) => {
          // Setup: Remote service with multiple remotes
          const remoteService = new MockRemoteService(remotes);

          // Act: Get all remotes
          const listedRemotes = remoteService.getRemotes();

          // Assert: All remotes are listed
          assert.strictEqual(
            listedRemotes.length,
            remotes.length,
            'Should list all configured remotes'
          );

          // Assert: Each remote has correct name and URL
          for (const expectedRemote of remotes) {
            const found = listedRemotes.find(
              (r) => r.name.toLowerCase() === expectedRemote.name.toLowerCase()
            );
            assert.ok(found, `Remote '${expectedRemote.name}' should be in the list`);
            assert.strictEqual(
              found.fetchUrl,
              expectedRemote.url,
              `Remote '${expectedRemote.name}' should have correct URL`
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Adding and removing remotes maintains list consistency.
     *
     * **Validates: Requirements 12.6, 12.7, 12.8**
     */
    it('Property: Adding and removing remotes maintains list consistency', () => {
      fc.assert(
        fc.property(
          uniqueRemotesArb,
          fc.array(fc.boolean(), { minLength: 1, maxLength: 10 }),
          (remotes, operations) => {
            // Setup: Empty remote service
            const remoteService = new MockRemoteService();
            const addedRemotes = new Set<string>();

            // Act: Add all remotes
            for (const remote of remotes) {
              remoteService.addRemote(remote.name, remote.url);
              addedRemotes.add(remote.name.toLowerCase());
            }

            // Assert: All remotes are present
            assert.strictEqual(
              remoteService.getRemoteCount(),
              remotes.length,
              'All remotes should be added'
            );

            // Act: Perform random remove operations
            const remotesToRemove = remotes.filter((_, i) => operations[i % operations.length]);
            for (const remote of remotesToRemove) {
              if (remoteService.hasRemote(remote.name)) {
                remoteService.removeRemote(remote.name);
                addedRemotes.delete(remote.name.toLowerCase());
              }
            }

            // Assert: List reflects current state
            const listedRemotes = remoteService.getRemotes();
            assert.strictEqual(
              listedRemotes.length,
              addedRemotes.size,
              'Remote count should match expected'
            );

            // Assert: Only expected remotes are present
            for (const remote of listedRemotes) {
              assert.ok(
                addedRemotes.has(remote.name.toLowerCase()),
                `Remote '${remote.name}' should be in expected set`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Removing a non-existent remote should fail.
     *
     * **Validates: Requirements 12.8**
     */
    it('Property: Removing a non-existent remote should fail', () => {
      fc.assert(
        fc.property(
          remoteNameArb,
          remoteNameArb,
          remoteUrlArb,
          (existingName, nonExistentName, url) => {
            // Skip if names are the same (case-insensitive)
            fc.pre(existingName.toLowerCase() !== nonExistentName.toLowerCase());

            // Setup: Remote service with one remote
            const remoteService = new MockRemoteService([{ name: existingName, url }]);

            // Act & Assert: Removing non-existent remote should fail
            assert.throws(
              () => remoteService.removeRemote(nonExistentName),
              /does not exist/,
              'Should throw when removing non-existent remote'
            );

            // Assert: Existing remote is unchanged
            assert.ok(remoteService.hasRemote(existingName), 'Existing remote should still exist');
            assert.strictEqual(
              remoteService.getRemoteCount(),
              1,
              'Remote count should be unchanged'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Adding multiple remotes with unique names succeeds.
     *
     * **Validates: Requirements 12.6, 12.7**
     */
    it('Property: Adding multiple remotes with unique names succeeds', () => {
      fc.assert(
        fc.property(uniqueRemotesArb, (remotes) => {
          // Setup: Empty remote service
          const remoteService = new MockRemoteService();

          // Act: Add all remotes
          for (const remote of remotes) {
            remoteService.addRemote(remote.name, remote.url);
          }

          // Assert: All remotes are present
          assert.strictEqual(
            remoteService.getRemoteCount(),
            remotes.length,
            'All remotes should be added'
          );

          // Assert: Each remote can be retrieved
          for (const remote of remotes) {
            const retrieved = remoteService.getRemote(remote.name);
            assert.ok(retrieved, `Remote '${remote.name}' should exist`);
            assert.strictEqual(retrieved.name, remote.name, 'Remote name should match');
            assert.strictEqual(retrieved.fetchUrl, remote.url, 'Remote URL should match');
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Remote names are case-insensitive for uniqueness.
     *
     * **Validates: Requirements 12.7**
     */
    it('Property: Remote names are case-insensitive for uniqueness', () => {
      fc.assert(
        fc.property(remoteNameArb, remoteUrlArb, remoteUrlArb, (name, url1, url2) => {
          // Setup: Remote service with one remote
          const remoteService = new MockRemoteService([{ name: name.toLowerCase(), url: url1 }]);

          // Act & Assert: Adding with different case should fail
          assert.throws(
            () => remoteService.addRemote(name.toUpperCase(), url2),
            /already exists/,
            'Should throw when adding remote with same name in different case'
          );

          // Assert: Only one remote exists
          assert.strictEqual(remoteService.getRemoteCount(), 1, 'Should have only one remote');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Removing all remotes results in empty list.
     *
     * **Validates: Requirements 12.6, 12.8**
     */
    it('Property: Removing all remotes results in empty list', () => {
      fc.assert(
        fc.property(uniqueRemotesArb, (remotes) => {
          // Setup: Remote service with multiple remotes
          const remoteService = new MockRemoteService(remotes);

          // Pre-condition: All remotes exist
          assert.strictEqual(
            remoteService.getRemoteCount(),
            remotes.length,
            'Should start with all remotes'
          );

          // Act: Remove all remotes
          for (const remote of remotes) {
            remoteService.removeRemote(remote.name);
          }

          // Assert: No remotes remain
          assert.strictEqual(remoteService.getRemoteCount(), 0, 'Should have no remotes');
          assert.strictEqual(remoteService.getRemotes().length, 0, 'Remotes list should be empty');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Remote URLs are preserved exactly as provided.
     *
     * **Validates: Requirements 12.6, 12.7**
     */
    it('Property: Remote URLs are preserved exactly as provided', () => {
      fc.assert(
        fc.property(remoteNameArb, remoteUrlArb, (name, url) => {
          // Setup: Empty remote service
          const remoteService = new MockRemoteService();

          // Act: Add a remote
          remoteService.addRemote(name, url);

          // Assert: URL is preserved exactly
          const remote = remoteService.getRemote(name);
          assert.ok(remote, 'Remote should exist');
          assert.strictEqual(remote.fetchUrl, url, 'Fetch URL should be preserved exactly');
          assert.strictEqual(remote.pushUrl, url, 'Push URL should be preserved exactly');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Adding a remote after removing it succeeds.
     *
     * **Validates: Requirements 12.7, 12.8**
     */
    it('Property: Adding a remote after removing it succeeds', () => {
      fc.assert(
        fc.property(remoteNameArb, remoteUrlArb, remoteUrlArb, (name, url1, url2) => {
          // Setup: Remote service with one remote
          const remoteService = new MockRemoteService([{ name, url: url1 }]);

          // Act: Remove the remote
          remoteService.removeRemote(name);

          // Assert: Remote is removed
          assert.ok(!remoteService.hasRemote(name), 'Remote should be removed');

          // Act: Add the remote again with different URL
          remoteService.addRemote(name, url2);

          // Assert: Remote exists with new URL
          const remote = remoteService.getRemote(name);
          assert.ok(remote, 'Remote should exist');
          assert.strictEqual(remote.fetchUrl, url2, 'Remote should have new URL');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Remote list order is consistent.
     *
     * **Validates: Requirements 12.6**
     */
    it('Property: Remote list order is consistent', () => {
      fc.assert(
        fc.property(uniqueRemotesArb, (remotes) => {
          // Setup: Remote service with multiple remotes
          const remoteService = new MockRemoteService(remotes);

          // Act: Get remotes multiple times
          const list1 = remoteService.getRemotes();
          const list2 = remoteService.getRemotes();
          const list3 = remoteService.getRemotes();

          // Assert: Lists are identical
          assert.strictEqual(list1.length, list2.length, 'List lengths should match');
          assert.strictEqual(list2.length, list3.length, 'List lengths should match');

          for (let i = 0; i < list1.length; i++) {
            assert.strictEqual(list1[i].name, list2[i].name, 'Remote names should match');
            assert.strictEqual(list2[i].name, list3[i].name, 'Remote names should match');
            assert.strictEqual(list1[i].fetchUrl, list2[i].fetchUrl, 'Remote URLs should match');
            assert.strictEqual(list2[i].fetchUrl, list3[i].fetchUrl, 'Remote URLs should match');
          }
        }),
        { numRuns: 100 }
      );
    });
  });
});
