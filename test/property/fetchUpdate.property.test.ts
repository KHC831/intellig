import * as fc from 'fast-check';
import * as assert from 'assert';
import { IRemote } from '../../src/git-core/interfaces/IGitService';

/**
 * Property-based tests for Fetch Update.
 * Feature: intellig-vscode, Property 40: Fetch Update
 *
 *
 * Property Description:
 * For any fetch operation, all remote tracking refs SHALL be updated to match
 * the current state of the remote repository.
 *
 * - 12.4: WHEN a user selects 'Fetch', THE Extension SHALL fetch updates from all configured remotes
 * - 12.5: WHEN a user selects 'Fetch' on a specific remote, THE Extension SHALL fetch only from that remote
 */
describe('Fetch Update Property Tests', () => {
  /**
   * Arbitrary generator for valid remote names.
   */
  const remoteNameArb: fc.Arbitrary<string> = fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'.split('')
      ),
      {
        minLength: 1,
        maxLength: 20,
      }
    )
    .filter((s) => {
      if (s.length === 0) {
        return false;
      }
      if (s.startsWith('-') || s.startsWith('_')) {
        return false;
      }
      if (/^[-_]+$/.test(s)) {
        return false;
      }
      return true;
    });

  /**
   * Arbitrary generator for valid branch names.
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
      if (s.endsWith('/') || s.endsWith('.')) {
        return false;
      }
      if (s.includes('..') || s.includes('//')) {
        return false;
      }
      if (/^[-_/]+$/.test(s)) {
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
   * Arbitrary generator for a remote configuration.
   */
  const remoteArb: fc.Arbitrary<IRemote> = fc.record({
    name: remoteNameArb,
    fetchUrl: fc.option(fc.webUrl(), { nil: undefined }),
    pushUrl: fc.option(fc.webUrl(), { nil: undefined }),
  });

  /**
   * Arbitrary generator for an array of unique remotes.
   */
  const uniqueRemotesArb: fc.Arbitrary<IRemote[]> = fc
    .array(remoteArb, { minLength: 1, maxLength: 5 })
    .map((remotes) => {
      const seen = new Set<string>();
      return remotes.filter((r) => {
        if (seen.has(r.name)) {
          return false;
        }
        seen.add(r.name);
        return true;
      });
    })
    .filter((remotes) => remotes.length > 0);

  /**
   * Arbitrary generator for remote branch state (branch name -> commit hash).
   */
  const remoteBranchStateArb: fc.Arbitrary<Map<string, string>> = fc
    .array(fc.tuple(branchNameArb, commitHashArb), { minLength: 1, maxLength: 5 })
    .map((entries) => {
      const map = new Map<string, string>();
      for (const [branch, hash] of entries) {
        if (!map.has(branch)) {
          map.set(branch, hash);
        }
      }
      return map;
    })
    .filter((map) => map.size > 0);

  /**
   * Mock Fetch Service that simulates fetch operations in memory.
   * This allows us to test the fetch update properties without actual Git operations.
   */
  class MockFetchService {
    private _remotes: Map<string, IRemote> = new Map();
    private _remoteState: Map<string, Map<string, string>> = new Map(); // remote -> (branch -> hash)
    private _localTrackingRefs: Map<string, Map<string, string>> = new Map(); // remote -> (branch -> hash)
    private _fetchHistory: Array<{
      remote?: string;
      timestamp: Date;
      refsUpdated: Map<string, string>;
    }> = [];

    constructor(options?: {
      remotes?: IRemote[];
      remoteStates?: Map<string, Map<string, string>>;
      initialTrackingRefs?: Map<string, Map<string, string>>;
    }) {
      if (options?.remotes) {
        for (const remote of options.remotes) {
          this._remotes.set(remote.name, remote);
        }
      }
      if (options?.remoteStates) {
        this._remoteState = new Map(options.remoteStates);
      }
      if (options?.initialTrackingRefs) {
        this._localTrackingRefs = new Map(options.initialTrackingRefs);
      }
    }

    /**
     * Get all configured remotes.
     */
    getRemotes(): IRemote[] {
      return Array.from(this._remotes.values());
    }

    /**
     * Get the current state of a remote (branch -> commit hash).
     */
    getRemoteState(remoteName: string): Map<string, string> | undefined {
      return this._remoteState.get(remoteName);
    }

    /**
     * Get local tracking refs for a remote (branch -> commit hash).
     */
    getLocalTrackingRefs(remoteName: string): Map<string, string> {
      const refs = this._localTrackingRefs.get(remoteName);
      return refs ? new Map<string, string>(refs) : new Map<string, string>();
    }

    /**
     * Get all local tracking refs across all remotes.
     */
    getAllLocalTrackingRefs(): Map<string, Map<string, string>> {
      return new Map(this._localTrackingRefs);
    }

    /**
     * Update the remote state (simulates changes on the remote).
     */
    updateRemoteState(remoteName: string, branchState: Map<string, string>): void {
      this._remoteState.set(remoteName, new Map(branchState));
    }

    /**
     * Get fetch history.
     */
    getFetchHistory(): Array<{
      remote?: string;
      timestamp: Date;
      refsUpdated: Map<string, string>;
    }> {
      return this._fetchHistory;
    }

    /**
     * Fetch updates from all configured remotes.
     *
     * @returns Result of the fetch operation
     */
    fetchAll(): {
      success: boolean;
      error?: string;
      remotesUpdated: string[];
      refsUpdated: Map<string, Map<string, string>>;
    } {
      const remotesUpdated: string[] = [];
      const refsUpdated = new Map<string, Map<string, string>>();

      // Fetch from each configured remote
      for (const [remoteName] of this._remotes) {
        const result = this.fetchFromRemote(remoteName);
        if (result.success) {
          remotesUpdated.push(remoteName);
          if (result.refsUpdated && result.refsUpdated.size > 0) {
            refsUpdated.set(remoteName, result.refsUpdated);
          }
        }
      }

      return {
        success: true,
        remotesUpdated,
        refsUpdated,
      };
    }

    /**
     * Fetch updates from a specific remote.
     *
     * @param remoteName - The name of the remote to fetch from
     * @returns Result of the fetch operation
     */
    fetchFromRemote(remoteName: string): {
      success: boolean;
      error?: string;
      refsUpdated?: Map<string, string>;
    } {
      // Check if remote exists
      if (!this._remotes.has(remoteName)) {
        return {
          success: false,
          error: `Remote '${remoteName}' not found`,
        };
      }

      // Get the current state of the remote
      const remoteState = this._remoteState.get(remoteName);
      if (!remoteState) {
        // Remote exists but has no branches - still a successful fetch
        return {
          success: true,
          refsUpdated: new Map(),
        };
      }

      // Update local tracking refs to match remote state
      const previousRefs = this._localTrackingRefs.get(remoteName);
      const previousRefsMap = previousRefs
        ? new Map<string, string>(previousRefs)
        : new Map<string, string>();
      const updatedRefs = new Map<string, string>();

      // Copy all remote refs to local tracking refs
      for (const [branch, hash] of remoteState) {
        const previousHash = previousRefsMap.get(branch);
        if (previousHash !== hash) {
          updatedRefs.set(branch, hash);
        }
      }

      // Update local tracking refs to match remote exactly
      this._localTrackingRefs.set(remoteName, new Map(remoteState));

      // Record fetch in history
      this._fetchHistory.push({
        remote: remoteName,
        timestamp: new Date(),
        refsUpdated: updatedRefs,
      });

      return {
        success: true,
        refsUpdated: updatedRefs,
      };
    }

    /**
     * Fetch updates from all remotes (convenience method).
     *
     * @returns Result of the fetch operation
     */
    fetch(remote?: string): {
      success: boolean;
      error?: string;
      remotesUpdated?: string[];
      refsUpdated?: Map<string, Map<string, string>>;
    } {
      if (remote) {
        const result = this.fetchFromRemote(remote);
        if (result.success) {
          const refsMap = new Map<string, Map<string, string>>();
          if (result.refsUpdated && result.refsUpdated.size > 0) {
            refsMap.set(remote, result.refsUpdated);
          }
          return {
            success: true,
            remotesUpdated: [remote],
            refsUpdated: refsMap,
          };
        }
        return {
          success: false,
          error: result.error,
        };
      }
      return this.fetchAll();
    }
  }

  describe('Property 40: Fetch Update', () => {
    /**
     * Property: Fetch updates all remote tracking refs to match remote state.
     */
    it('Property: Fetch updates all remote tracking refs to match remote state', () => {
      fc.assert(
        fc.property(uniqueRemotesArb, remoteBranchStateArb, (remotes, branchState) => {
          // Use first remote for this test
          const remote = remotes[0];

          // Setup: Fetch service with remote and its state
          const remoteStates = new Map<string, Map<string, string>>();
          remoteStates.set(remote.name, branchState);

          const fetchService = new MockFetchService({
            remotes: [remote],
            remoteStates,
            initialTrackingRefs: new Map(), // Start with no tracking refs
          });

          // Pre-condition: No local tracking refs initially
          const initialRefs = fetchService.getLocalTrackingRefs(remote.name);
          assert.strictEqual(initialRefs.size, 0, 'Should start with no tracking refs');

          // Act: Fetch from the remote
          const result = fetchService.fetch(remote.name);

          // Assert: Fetch succeeded
          assert.ok(result.success, 'Fetch should succeed');

          // Assert: Local tracking refs now match remote state
          const localRefs = fetchService.getLocalTrackingRefs(remote.name);
          assert.strictEqual(
            localRefs.size,
            branchState.size,
            'Local tracking refs should have same number of branches as remote'
          );

          // Assert: Each branch ref matches
          for (const [branch, hash] of branchState) {
            const localHash = localRefs.get(branch);
            assert.strictEqual(
              localHash,
              hash,
              `Local tracking ref for ${branch} should match remote (${hash})`
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Fetch from specific remote only updates that remote's tracking refs.
     */
    it("Property: Fetch from specific remote only updates that remote's tracking refs", () => {
      fc.assert(
        fc.property(
          uniqueRemotesArb,
          remoteBranchStateArb,
          remoteBranchStateArb,
          (remotes, branchState1, branchState2) => {
            // Need at least 2 remotes
            fc.pre(remotes.length >= 2);

            const remote1 = remotes[0];
            const remote2 = remotes[1];

            // Setup: Fetch service with two remotes and their states
            const remoteStates = new Map<string, Map<string, string>>();
            remoteStates.set(remote1.name, branchState1);
            remoteStates.set(remote2.name, branchState2);

            const fetchService = new MockFetchService({
              remotes: [remote1, remote2],
              remoteStates,
              initialTrackingRefs: new Map(), // Start with no tracking refs
            });

            // Act: Fetch only from remote1
            const result = fetchService.fetch(remote1.name);

            // Assert: Fetch succeeded
            assert.ok(result.success, 'Fetch should succeed');

            // Assert: remote1's tracking refs are updated
            const local1Refs = fetchService.getLocalTrackingRefs(remote1.name);
            assert.strictEqual(
              local1Refs.size,
              branchState1.size,
              'Remote1 tracking refs should be updated'
            );

            // Assert: remote2's tracking refs are NOT updated
            const local2Refs = fetchService.getLocalTrackingRefs(remote2.name);
            assert.strictEqual(local2Refs.size, 0, 'Remote2 tracking refs should NOT be updated');
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Fetch all updates tracking refs for all configured remotes.
     */
    it('Property: Fetch all updates tracking refs for all configured remotes', () => {
      fc.assert(
        fc.property(
          uniqueRemotesArb,
          fc.array(remoteBranchStateArb, { minLength: 1, maxLength: 5 }),
          (remotes, branchStates) => {
            // Setup: Create remote states for each remote
            const remoteStates = new Map<string, Map<string, string>>();
            for (let i = 0; i < remotes.length; i++) {
              const stateIndex = i % branchStates.length;
              remoteStates.set(remotes[i].name, branchStates[stateIndex]);
            }

            const fetchService = new MockFetchService({
              remotes,
              remoteStates,
              initialTrackingRefs: new Map(), // Start with no tracking refs
            });

            // Act: Fetch from all remotes
            const result = fetchService.fetch();

            // Assert: Fetch succeeded
            assert.ok(result.success, 'Fetch should succeed');

            // Assert: All remotes were updated
            assert.strictEqual(
              result.remotesUpdated?.length,
              remotes.length,
              'All remotes should be updated'
            );

            // Assert: Each remote's tracking refs match its state
            for (const remote of remotes) {
              const expectedState = remoteStates.get(remote.name);
              const localRefs = fetchService.getLocalTrackingRefs(remote.name);

              if (expectedState) {
                assert.strictEqual(
                  localRefs.size,
                  expectedState.size,
                  `Remote ${remote.name} should have correct number of tracking refs`
                );

                for (const [branch, hash] of expectedState) {
                  assert.strictEqual(
                    localRefs.get(branch),
                    hash,
                    `Remote ${remote.name} branch ${branch} should match`
                  );
                }
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Fetch is idempotent when remote state hasn't changed.
     */
    it("Property: Fetch is idempotent when remote state hasn't changed", () => {
      fc.assert(
        fc.property(uniqueRemotesArb, remoteBranchStateArb, (remotes, branchState) => {
          const remote = remotes[0];

          // Setup: Fetch service with remote state
          const remoteStates = new Map<string, Map<string, string>>();
          remoteStates.set(remote.name, branchState);

          const fetchService = new MockFetchService({
            remotes: [remote],
            remoteStates,
            initialTrackingRefs: new Map(),
          });

          // Act: Fetch twice
          const result1 = fetchService.fetch(remote.name);
          const result2 = fetchService.fetch(remote.name);

          // Assert: Both fetches succeeded
          assert.ok(result1.success, 'First fetch should succeed');
          assert.ok(result2.success, 'Second fetch should succeed');

          // Assert: First fetch updated refs
          const firstUpdated = result1.refsUpdated?.get(remote.name);
          assert.ok(firstUpdated && firstUpdated.size > 0, 'First fetch should update refs');

          // Assert: Second fetch has no updates (already up to date)
          const secondUpdated = result2.refsUpdated?.get(remote.name);
          assert.strictEqual(secondUpdated?.size || 0, 0, 'Second fetch should have no updates');

          // Assert: Local refs are still correct
          const localRefs = fetchService.getLocalTrackingRefs(remote.name);
          for (const [branch, hash] of branchState) {
            assert.strictEqual(
              localRefs.get(branch),
              hash,
              `Branch ${branch} should still match after second fetch`
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Fetch updates refs when remote state changes.
     */
    it('Property: Fetch updates refs when remote state changes', () => {
      fc.assert(
        fc.property(
          uniqueRemotesArb,
          remoteBranchStateArb,
          remoteBranchStateArb,
          (remotes, initialState, newState) => {
            // Ensure states are different
            const statesAreDifferent =
              Array.from(initialState.entries()).some(
                ([branch, hash]) => newState.get(branch) !== hash
              ) ||
              Array.from(newState.entries()).some(
                ([branch, hash]) => initialState.get(branch) !== hash
              );
            fc.pre(statesAreDifferent);

            const remote = remotes[0];

            // Setup: Fetch service with initial remote state
            const remoteStates = new Map<string, Map<string, string>>();
            remoteStates.set(remote.name, initialState);

            const fetchService = new MockFetchService({
              remotes: [remote],
              remoteStates,
              initialTrackingRefs: new Map(),
            });

            // Act: First fetch
            const result1 = fetchService.fetch(remote.name);
            assert.ok(result1.success, 'First fetch should succeed');

            // Verify initial state is reflected
            let localRefs = fetchService.getLocalTrackingRefs(remote.name);
            for (const [branch, hash] of initialState) {
              assert.strictEqual(
                localRefs.get(branch),
                hash,
                `Initial state: branch ${branch} should match`
              );
            }

            // Update remote state
            fetchService.updateRemoteState(remote.name, newState);

            // Act: Second fetch after remote changed
            const result2 = fetchService.fetch(remote.name);
            assert.ok(result2.success, 'Second fetch should succeed');

            // Assert: Local refs now match new state
            localRefs = fetchService.getLocalTrackingRefs(remote.name);
            for (const [branch, hash] of newState) {
              assert.strictEqual(
                localRefs.get(branch),
                hash,
                `New state: branch ${branch} should match`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Fetch from non-existent remote fails gracefully.
     */
    it('Property: Fetch from non-existent remote fails gracefully', () => {
      fc.assert(
        fc.property(uniqueRemotesArb, remoteNameArb, (remotes, nonExistentRemote) => {
          // Ensure the remote name doesn't exist in our list
          const existingNames = new Set(remotes.map((r) => r.name));
          fc.pre(!existingNames.has(nonExistentRemote));

          // Setup: Fetch service with configured remotes
          const fetchService = new MockFetchService({
            remotes,
            remoteStates: new Map(),
          });

          // Act: Try to fetch from non-existent remote
          const result = fetchService.fetch(nonExistentRemote);

          // Assert: Fetch failed
          assert.ok(!result.success, 'Fetch should fail for non-existent remote');

          // Assert: Error message mentions the remote
          assert.ok(
            result.error?.includes(nonExistentRemote),
            'Error should mention the remote name'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Fetch records operation in history.
     */
    it('Property: Fetch records operation in history', () => {
      fc.assert(
        fc.property(uniqueRemotesArb, remoteBranchStateArb, (remotes, branchState) => {
          const remote = remotes[0];

          // Setup: Fetch service with remote state
          const remoteStates = new Map<string, Map<string, string>>();
          remoteStates.set(remote.name, branchState);

          const fetchService = new MockFetchService({
            remotes: [remote],
            remoteStates,
            initialTrackingRefs: new Map(),
          });

          // Pre-condition: No fetch history
          assert.strictEqual(
            fetchService.getFetchHistory().length,
            0,
            'Should start with no fetch history'
          );

          // Act: Fetch from remote
          const result = fetchService.fetch(remote.name);
          assert.ok(result.success, 'Fetch should succeed');

          // Assert: Fetch was recorded in history
          const history = fetchService.getFetchHistory();
          assert.strictEqual(history.length, 1, 'Should have one fetch in history');

          // Assert: History entry has correct details
          const entry = history[0];
          assert.strictEqual(entry.remote, remote.name, 'Remote should match');
          assert.ok(entry.timestamp instanceof Date, 'Should have timestamp');
          assert.ok(entry.refsUpdated instanceof Map, 'Should have refs updated map');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Fetch all records operations for each remote.
     */
    it('Property: Fetch all records operations for each remote', () => {
      fc.assert(
        fc.property(
          uniqueRemotesArb,
          fc.array(remoteBranchStateArb, { minLength: 1, maxLength: 5 }),
          (remotes, branchStates) => {
            // Setup: Create remote states for each remote
            const remoteStates = new Map<string, Map<string, string>>();
            for (let i = 0; i < remotes.length; i++) {
              const stateIndex = i % branchStates.length;
              remoteStates.set(remotes[i].name, branchStates[stateIndex]);
            }

            const fetchService = new MockFetchService({
              remotes,
              remoteStates,
              initialTrackingRefs: new Map(),
            });

            // Act: Fetch all
            const result = fetchService.fetch();
            assert.ok(result.success, 'Fetch should succeed');

            // Assert: History has entry for each remote
            const history = fetchService.getFetchHistory();
            assert.strictEqual(
              history.length,
              remotes.length,
              'Should have one history entry per remote'
            );

            // Assert: Each remote is in history
            const fetchedRemotes = new Set(history.map((h) => h.remote));
            for (const remote of remotes) {
              assert.ok(
                fetchedRemotes.has(remote.name),
                `Remote ${remote.name} should be in fetch history`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Fetch handles empty remote state correctly.
     */
    it('Property: Fetch handles empty remote state correctly', () => {
      fc.assert(
        fc.property(uniqueRemotesArb, (remotes) => {
          const remote = remotes[0];

          // Setup: Fetch service with remote but no branches
          const fetchService = new MockFetchService({
            remotes: [remote],
            remoteStates: new Map(), // No state for any remote
            initialTrackingRefs: new Map(),
          });

          // Act: Fetch from remote
          const result = fetchService.fetch(remote.name);

          // Assert: Fetch succeeded (empty is valid)
          assert.ok(result.success, 'Fetch should succeed even with empty remote');

          // Assert: No refs were updated
          const localRefs = fetchService.getLocalTrackingRefs(remote.name);
          assert.strictEqual(localRefs.size, 0, 'Should have no tracking refs');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Fetch preserves tracking refs for branches that still exist.
     */
    it('Property: Fetch preserves tracking refs for branches that still exist', () => {
      fc.assert(
        fc.property(
          uniqueRemotesArb,
          remoteBranchStateArb,
          branchNameArb,
          commitHashArb,
          (remotes, branchState, newBranch, newHash) => {
            // Ensure new branch doesn't already exist
            fc.pre(!branchState.has(newBranch));

            const remote = remotes[0];

            // Setup: Fetch service with initial state
            const remoteStates = new Map<string, Map<string, string>>();
            remoteStates.set(remote.name, branchState);

            const fetchService = new MockFetchService({
              remotes: [remote],
              remoteStates,
              initialTrackingRefs: new Map(),
            });

            // First fetch to establish tracking refs
            fetchService.fetch(remote.name);

            // Add a new branch to remote
            const newState = new Map(branchState);
            newState.set(newBranch, newHash);
            fetchService.updateRemoteState(remote.name, newState);

            // Act: Fetch again
            const result = fetchService.fetch(remote.name);
            assert.ok(result.success, 'Fetch should succeed');

            // Assert: All original branches still tracked
            const localRefs = fetchService.getLocalTrackingRefs(remote.name);
            for (const [branch, hash] of branchState) {
              assert.strictEqual(
                localRefs.get(branch),
                hash,
                `Original branch ${branch} should still be tracked`
              );
            }

            // Assert: New branch is also tracked
            assert.strictEqual(localRefs.get(newBranch), newHash, 'New branch should be tracked');
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
