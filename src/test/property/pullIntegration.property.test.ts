import * as fc from 'fast-check';
import * as assert from 'assert';
import { ICommit, IPullOptions, IUpstream } from '../../services/interfaces/IGitService';

/**
 * Property-based tests for Pull Integration.
 * Feature: intellig-vscode, Property 39: Pull Integration
 *
 * **Validates: Requirements 12.3**
 *
 * Property Description:
 * For any branch with upstream changes, pulling SHALL fetch and integrate those changes
 * into the local branch (via merge or rebase based on configuration).
 *
 * Requirements:
 * - 12.3: WHEN a user selects 'Pull', THE Extension SHALL fetch and merge (or rebase
 *         based on configuration) from the upstream remote
 */
describe('Pull Integration Property Tests', () => {
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
   * Arbitrary generator for a commit.
   */
  const commitArb: fc.Arbitrary<ICommit> = fc.record({
    hash: commitHashArb,
    shortHash: commitHashArb.map((h) => h.substring(0, 7)),
    message: fc.string({ minLength: 1, maxLength: 100 }),
    body: fc.option(fc.string({ maxLength: 200 }), { nil: undefined }),
    author: fc.record({
      name: fc.string({ minLength: 1, maxLength: 50 }),
      email: fc.emailAddress(),
    }),
    committer: fc.record({
      name: fc.string({ minLength: 1, maxLength: 50 }),
      email: fc.emailAddress(),
    }),
    parents: fc.array(commitHashArb, { minLength: 0, maxLength: 2 }),
    authorDate: fc.date(),
    commitDate: fc.date(),
  });

  /**
   * Arbitrary generator for an array of unique commits.
   */
  const uniqueCommitsArb: fc.Arbitrary<ICommit[]> = fc
    .array(commitArb, { minLength: 1, maxLength: 10 })
    .map((commits) => {
      const seen = new Set<string>();
      return commits.filter((c) => {
        if (seen.has(c.hash)) {
          return false;
        }
        seen.add(c.hash);
        return true;
      });
    })
    .filter((commits) => commits.length > 0);

  /**
   * Arbitrary generator for upstream configuration.
   */
  const upstreamArb: fc.Arbitrary<IUpstream> = fc.record({
    remote: remoteNameArb,
    name: branchNameArb,
  });

  /**
   * Mock Pull Service that simulates pull operations in memory.
   * This allows us to test the pull integration properties without actual Git operations.
   */
  class MockPullService {
    private _localCommits: Map<string, ICommit[]> = new Map();
    private _remoteCommits: Map<string, ICommit[]> = new Map();
    private _upstreams: Map<string, IUpstream | undefined> = new Map();
    private _currentBranch: string = 'main';
    private _pullHistory: Array<{
      branch: string;
      remote: string;
      commits: ICommit[];
      options?: IPullOptions;
      method: 'merge' | 'rebase';
    }> = [];
    private _defaultPullRebase: boolean = false;
    private _fetchedRemotes: Set<string> = new Set();

    constructor(options?: {
      currentBranch?: string;
      localCommits?: ICommit[];
      remoteCommits?: ICommit[];
      upstream?: IUpstream;
      defaultPullRebase?: boolean;
    }) {
      this._currentBranch = options?.currentBranch || 'main';
      this._defaultPullRebase = options?.defaultPullRebase || false;
      if (options?.localCommits) {
        this._localCommits.set(this._currentBranch, [...options.localCommits]);
      }
      if (options?.remoteCommits && options?.upstream) {
        const remoteBranch = `${options.upstream.remote}/${options.upstream.name}`;
        this._remoteCommits.set(remoteBranch, [...options.remoteCommits]);
      }
      if (options?.upstream) {
        this._upstreams.set(this._currentBranch, options.upstream);
      }
    }

    /**
     * Get the current branch name.
     */
    getCurrentBranch(): string {
      return this._currentBranch;
    }

    /**
     * Get the upstream configuration for a branch.
     */
    getUpstream(branch: string): IUpstream | undefined {
      return this._upstreams.get(branch);
    }

    /**
     * Get local commits for a branch.
     */
    getLocalCommits(branch: string): ICommit[] {
      return this._localCommits.get(branch) || [];
    }

    /**
     * Get remote commits for a remote branch.
     */
    getRemoteCommits(remoteBranch: string): ICommit[] {
      return this._remoteCommits.get(remoteBranch) || [];
    }

    /**
     * Add remote commits to a remote branch (simulates remote changes).
     */
    addRemoteCommits(remoteBranch: string, commits: ICommit[]): void {
      const existing = this._remoteCommits.get(remoteBranch) || [];
      this._remoteCommits.set(remoteBranch, [...existing, ...commits]);
    }

    /**
     * Get pull history.
     */
    getPullHistory(): Array<{
      branch: string;
      remote: string;
      commits: ICommit[];
      options?: IPullOptions;
      method: 'merge' | 'rebase';
    }> {
      return this._pullHistory;
    }

    /**
     * Check if a remote was fetched.
     */
    wasFetched(remote: string): boolean {
      return this._fetchedRemotes.has(remote);
    }

    /**
     * Get commits that are on remote but not local.
     */
    getCommitsToIntegrate(branch: string): ICommit[] {
      const upstream = this._upstreams.get(branch);
      if (!upstream) {
        return [];
      }

      const localCommits = this._localCommits.get(branch) || [];
      const remoteBranch = `${upstream.remote}/${upstream.name}`;
      const remoteCommits = this._remoteCommits.get(remoteBranch) || [];
      const localHashes = new Set(localCommits.map((c) => c.hash));

      return remoteCommits.filter((c) => !localHashes.has(c.hash));
    }

    /**
     * Fetch updates from a remote.
     * This simulates fetching remote refs.
     *
     * @param remote - Optional specific remote to fetch from
     */
    fetch(remote?: string): void {
      if (remote) {
        this._fetchedRemotes.add(remote);
      } else {
        // Fetch all remotes
        for (const [, upstreamConfig] of this._upstreams.entries()) {
          if (upstreamConfig) {
            this._fetchedRemotes.add(upstreamConfig.remote);
          }
        }
      }
    }

    /**
     * Pull changes from the upstream branch.
     * Requirement 12.3: Fetch and merge (or rebase based on configuration) from upstream.
     *
     * @param options - Pull options
     * @returns Result of the pull operation
     */
    pull(options?: IPullOptions): {
      success: boolean;
      error?: string;
      commitsIntegrated?: ICommit[];
      method?: 'merge' | 'rebase';
    } {
      const branch = this._currentBranch;
      const upstream = this._upstreams.get(branch);

      // Check if upstream is configured
      if (!upstream) {
        return {
          success: false,
          error: 'No upstream configured for current branch.',
        };
      }

      // Determine the remote and branch to pull from
      const pullRemote = options?.remote || upstream.remote;
      const pullBranch = options?.branch || upstream.name;
      const remoteBranch = `${pullRemote}/${pullBranch}`;

      // Fetch first (pull always fetches)
      this.fetch(pullRemote);

      // Get commits to integrate
      const remoteCommits = this._remoteCommits.get(remoteBranch) || [];
      const localCommits = this._localCommits.get(branch) || [];
      const localHashes = new Set(localCommits.map((c) => c.hash));
      const commitsToIntegrate = remoteCommits.filter((c) => !localHashes.has(c.hash));

      // If no commits to integrate, nothing to do
      if (commitsToIntegrate.length === 0) {
        return {
          success: true,
          commitsIntegrated: [],
          method: 'merge',
        };
      }

      // Determine integration method (rebase or merge)
      const useRebase = options?.rebase ?? this._defaultPullRebase;
      const method: 'merge' | 'rebase' = useRebase ? 'rebase' : 'merge';

      // Integrate the commits
      if (useRebase) {
        // Rebase: replay local commits on top of remote
        // For simplicity, we just add remote commits first, then local-only commits
        const remoteHashes = new Set(remoteCommits.map((c) => c.hash));
        const localOnlyCommits = localCommits.filter((c) => !remoteHashes.has(c.hash));
        this._localCommits.set(branch, [...remoteCommits, ...localOnlyCommits]);
      } else {
        // Merge: add remote commits to local
        this._localCommits.set(branch, [...localCommits, ...commitsToIntegrate]);
      }

      // Record pull in history
      this._pullHistory.push({
        branch,
        remote: pullRemote,
        commits: commitsToIntegrate,
        options,
        method,
      });

      return {
        success: true,
        commitsIntegrated: commitsToIntegrate,
        method,
      };
    }
  }

  describe('Property 39: Pull Integration', () => {
    /**
     * Property: Pull fetches and integrates upstream changes into local branch.
     *
     * **Validates: Requirements 12.3**
     */
    it('Property: Pull fetches and integrates upstream changes into local branch', () => {
      fc.assert(
        fc.property(
          branchNameArb,
          upstreamArb,
          uniqueCommitsArb,
          (branchName, upstream, remoteCommits) => {
            // Setup: Pull service with remote commits but no local commits
            const pullService = new MockPullService({
              currentBranch: branchName,
              localCommits: [],
              remoteCommits,
              upstream,
            });

            // Pre-condition: Upstream is configured
            assert.ok(pullService.getUpstream(branchName), 'Upstream should be configured');

            // Pre-condition: Remote has commits to integrate
            const commitsToIntegrate = pullService.getCommitsToIntegrate(branchName);
            assert.strictEqual(
              commitsToIntegrate.length,
              remoteCommits.length,
              'All remote commits should be pending integration'
            );

            // Act: Pull from upstream
            const result = pullService.pull();

            // Assert: Pull succeeded
            assert.ok(result.success, 'Pull should succeed');

            // Assert: All remote commits were integrated
            assert.strictEqual(
              result.commitsIntegrated?.length,
              remoteCommits.length,
              'All remote commits should be integrated'
            );

            // Assert: Local branch now has all remote commits
            const localCommits = pullService.getLocalCommits(branchName);
            for (const commit of remoteCommits) {
              const found = localCommits.find((c) => c.hash === commit.hash);
              assert.ok(found, `Commit ${commit.shortHash} should be in local branch`);
            }

            // Assert: Remote was fetched
            assert.ok(pullService.wasFetched(upstream.remote), 'Remote should have been fetched');
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Pull with rebase option rebases local commits on top of remote.
     *
     * **Validates: Requirements 12.3**
     */
    it('Property: Pull with rebase option rebases local commits on top of remote', () => {
      fc.assert(
        fc.property(
          branchNameArb,
          upstreamArb,
          uniqueCommitsArb,
          uniqueCommitsArb,
          (branchName, upstream, localCommits, remoteCommits) => {
            // Ensure local and remote commits are different
            const localHashes = new Set(localCommits.map((c) => c.hash));
            const filteredRemote = remoteCommits.filter((c) => !localHashes.has(c.hash));
            fc.pre(filteredRemote.length > 0);

            // Setup: Pull service with both local and remote commits
            const pullService = new MockPullService({
              currentBranch: branchName,
              localCommits,
              remoteCommits: filteredRemote,
              upstream,
            });

            // Act: Pull with rebase option
            const result = pullService.pull({ rebase: true });

            // Assert: Pull succeeded
            assert.ok(result.success, 'Pull with rebase should succeed');

            // Assert: Method was rebase
            assert.strictEqual(result.method, 'rebase', 'Integration method should be rebase');

            // Assert: Local branch has all commits (remote + local)
            const finalLocalCommits = pullService.getLocalCommits(branchName);

            // All remote commits should be present
            for (const commit of filteredRemote) {
              const found = finalLocalCommits.find((c) => c.hash === commit.hash);
              assert.ok(found, `Remote commit ${commit.shortHash} should be in local branch`);
            }

            // All original local commits should be present
            for (const commit of localCommits) {
              const found = finalLocalCommits.find((c) => c.hash === commit.hash);
              assert.ok(found, `Local commit ${commit.shortHash} should be in local branch`);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Pull with merge option merges remote commits into local.
     *
     * **Validates: Requirements 12.3**
     */
    it('Property: Pull with merge option merges remote commits into local', () => {
      fc.assert(
        fc.property(
          branchNameArb,
          upstreamArb,
          uniqueCommitsArb,
          uniqueCommitsArb,
          (branchName, upstream, localCommits, remoteCommits) => {
            // Ensure local and remote commits are different
            const localHashes = new Set(localCommits.map((c) => c.hash));
            const filteredRemote = remoteCommits.filter((c) => !localHashes.has(c.hash));
            fc.pre(filteredRemote.length > 0);

            // Setup: Pull service with both local and remote commits
            const pullService = new MockPullService({
              currentBranch: branchName,
              localCommits,
              remoteCommits: filteredRemote,
              upstream,
            });

            // Act: Pull with merge option (rebase: false)
            const result = pullService.pull({ rebase: false });

            // Assert: Pull succeeded
            assert.ok(result.success, 'Pull with merge should succeed');

            // Assert: Method was merge
            assert.strictEqual(result.method, 'merge', 'Integration method should be merge');

            // Assert: Local branch has all commits
            const finalLocalCommits = pullService.getLocalCommits(branchName);

            // All remote commits should be present
            for (const commit of filteredRemote) {
              const found = finalLocalCommits.find((c) => c.hash === commit.hash);
              assert.ok(found, `Remote commit ${commit.shortHash} should be in local branch`);
            }

            // All original local commits should be present
            for (const commit of localCommits) {
              const found = finalLocalCommits.find((c) => c.hash === commit.hash);
              assert.ok(found, `Local commit ${commit.shortHash} should be in local branch`);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Pull uses default configuration when no option specified.
     *
     * **Validates: Requirements 12.3**
     */
    it('Property: Pull uses default configuration when no option specified', () => {
      fc.assert(
        fc.property(
          branchNameArb,
          upstreamArb,
          uniqueCommitsArb,
          fc.boolean(),
          (branchName, upstream, remoteCommits, defaultRebase) => {
            // Setup: Pull service with default rebase configuration
            const pullService = new MockPullService({
              currentBranch: branchName,
              localCommits: [],
              remoteCommits,
              upstream,
              defaultPullRebase: defaultRebase,
            });

            // Act: Pull without specifying rebase option
            const result = pullService.pull();

            // Assert: Pull succeeded
            assert.ok(result.success, 'Pull should succeed');

            // Assert: Method matches default configuration
            const expectedMethod = defaultRebase ? 'rebase' : 'merge';
            assert.strictEqual(
              result.method,
              expectedMethod,
              `Integration method should match default (${expectedMethod})`
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Pull without upstream fails gracefully.
     *
     * **Validates: Requirements 12.3**
     */
    it('Property: Pull without upstream fails gracefully', () => {
      fc.assert(
        fc.property(branchNameArb, uniqueCommitsArb, (branchName, localCommits) => {
          // Setup: Pull service with NO upstream configured
          const pullService = new MockPullService({
            currentBranch: branchName,
            localCommits,
            // No upstream configured
          });

          // Pre-condition: No upstream is configured
          assert.strictEqual(
            pullService.getUpstream(branchName),
            undefined,
            'Upstream should not be configured'
          );

          // Act: Attempt to pull
          const result = pullService.pull();

          // Assert: Pull failed
          assert.ok(!result.success, 'Pull should fail without upstream');

          // Assert: Error message indicates upstream issue
          assert.ok(
            result.error?.toLowerCase().includes('upstream'),
            'Error should mention upstream'
          );

          // Assert: Local commits unchanged
          const finalLocalCommits = pullService.getLocalCommits(branchName);
          assert.strictEqual(
            finalLocalCommits.length,
            localCommits.length,
            'Local commits should be unchanged'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Pull with no new remote commits is a no-op.
     *
     * **Validates: Requirements 12.3**
     */
    it('Property: Pull with no new remote commits is a no-op', () => {
      fc.assert(
        fc.property(
          branchNameArb,
          upstreamArb,
          uniqueCommitsArb,
          (branchName, upstream, sharedCommits) => {
            // Setup: Pull service where local and remote have same commits
            const pullService = new MockPullService({
              currentBranch: branchName,
              localCommits: sharedCommits,
              remoteCommits: sharedCommits,
              upstream,
            });

            // Pre-condition: No commits to integrate
            const commitsToIntegrate = pullService.getCommitsToIntegrate(branchName);
            assert.strictEqual(commitsToIntegrate.length, 0, 'Should have no commits to integrate');

            // Act: Pull from upstream
            const result = pullService.pull();

            // Assert: Pull succeeded
            assert.ok(result.success, 'Pull should succeed');

            // Assert: No commits were integrated
            assert.strictEqual(
              result.commitsIntegrated?.length,
              0,
              'No commits should be integrated'
            );

            // Assert: Local commits unchanged
            const finalLocalCommits = pullService.getLocalCommits(branchName);
            assert.strictEqual(
              finalLocalCommits.length,
              sharedCommits.length,
              'Local commits should be unchanged'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Pull records operation in history.
     *
     * **Validates: Requirements 12.3**
     */
    it('Property: Pull records operation in history', () => {
      fc.assert(
        fc.property(
          branchNameArb,
          upstreamArb,
          uniqueCommitsArb,
          fc.option(fc.boolean(), { nil: undefined }),
          (branchName, upstream, remoteCommits, rebaseOption) => {
            // Setup: Pull service with remote commits
            const pullService = new MockPullService({
              currentBranch: branchName,
              localCommits: [],
              remoteCommits,
              upstream,
            });

            // Pre-condition: No pull history
            assert.strictEqual(
              pullService.getPullHistory().length,
              0,
              'Should start with no pull history'
            );

            // Act: Pull from upstream (only use rebase option, not remote/branch)
            const result = pullService.pull({ rebase: rebaseOption });

            // Assert: Pull succeeded
            assert.ok(result.success, 'Pull should succeed');

            // Assert: Pull was recorded in history
            const history = pullService.getPullHistory();
            assert.strictEqual(history.length, 1, 'Should have one pull in history');

            // Assert: History entry has correct details
            const entry = history[0];
            assert.strictEqual(entry.branch, branchName, 'Branch should match');
            assert.strictEqual(
              entry.commits.length,
              remoteCommits.length,
              'Commits count should match'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Pull from specific remote and branch works correctly.
     *
     * **Validates: Requirements 12.3**
     */
    it('Property: Pull from specific remote and branch works correctly', () => {
      fc.assert(
        fc.property(
          branchNameArb,
          upstreamArb,
          remoteNameArb,
          branchNameArb,
          uniqueCommitsArb,
          (branchName, defaultUpstream, targetRemote, targetBranch, remoteCommits) => {
            // Setup: Pull service with default upstream
            const pullService = new MockPullService({
              currentBranch: branchName,
              localCommits: [],
              upstream: defaultUpstream,
            });

            // Add commits to the target remote branch
            const targetRemoteBranch = `${targetRemote}/${targetBranch}`;
            pullService.addRemoteCommits(targetRemoteBranch, remoteCommits);

            // Act: Pull from specific remote and branch
            const result = pullService.pull({
              remote: targetRemote,
              branch: targetBranch,
            });

            // Assert: Pull succeeded
            assert.ok(result.success, 'Pull should succeed');

            // Assert: Commits from target remote were integrated
            assert.strictEqual(
              result.commitsIntegrated?.length,
              remoteCommits.length,
              'All commits from target remote should be integrated'
            );

            // Assert: Target remote was fetched
            assert.ok(
              pullService.wasFetched(targetRemote),
              'Target remote should have been fetched'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Multiple pulls are idempotent when no new remote commits.
     *
     * **Validates: Requirements 12.3**
     */
    it('Property: Multiple pulls are idempotent when no new remote commits', () => {
      fc.assert(
        fc.property(
          branchNameArb,
          upstreamArb,
          uniqueCommitsArb,
          (branchName, upstream, remoteCommits) => {
            // Setup: Pull service with remote commits
            const pullService = new MockPullService({
              currentBranch: branchName,
              localCommits: [],
              remoteCommits,
              upstream,
            });

            // Act: Pull twice
            const result1 = pullService.pull();
            const result2 = pullService.pull();

            // Assert: Both pulls succeeded
            assert.ok(result1.success, 'First pull should succeed');
            assert.ok(result2.success, 'Second pull should succeed');

            // Assert: First pull integrated all commits
            assert.strictEqual(
              result1.commitsIntegrated?.length,
              remoteCommits.length,
              'First pull should integrate all commits'
            );

            // Assert: Second pull integrated no commits (already integrated)
            assert.strictEqual(
              result2.commitsIntegrated?.length,
              0,
              'Second pull should integrate no commits'
            );

            // Assert: Local has exactly the remote commits
            const localCommits = pullService.getLocalCommits(branchName);
            assert.strictEqual(
              localCommits.length,
              remoteCommits.length,
              'Local should have same number of commits as remote'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Pull always fetches before integrating.
     *
     * **Validates: Requirements 12.3**
     */
    it('Property: Pull always fetches before integrating', () => {
      fc.assert(
        fc.property(
          branchNameArb,
          upstreamArb,
          uniqueCommitsArb,
          (branchName, upstream, remoteCommits) => {
            // Setup: Pull service with remote commits
            const pullService = new MockPullService({
              currentBranch: branchName,
              localCommits: [],
              remoteCommits,
              upstream,
            });

            // Pre-condition: Remote not yet fetched
            assert.ok(
              !pullService.wasFetched(upstream.remote),
              'Remote should not be fetched initially'
            );

            // Act: Pull from upstream
            const result = pullService.pull();

            // Assert: Pull succeeded
            assert.ok(result.success, 'Pull should succeed');

            // Assert: Remote was fetched
            assert.ok(
              pullService.wasFetched(upstream.remote),
              'Remote should have been fetched during pull'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Pull preserves commit order.
     *
     * **Validates: Requirements 12.3**
     */
    it('Property: Pull preserves commit order', () => {
      fc.assert(
        fc.property(
          branchNameArb,
          upstreamArb,
          uniqueCommitsArb,
          (branchName, upstream, remoteCommits) => {
            // Skip if less than 2 commits (order doesn't matter)
            fc.pre(remoteCommits.length >= 2);

            // Setup: Pull service with remote commits
            const pullService = new MockPullService({
              currentBranch: branchName,
              localCommits: [],
              remoteCommits,
              upstream,
            });

            // Act: Pull from upstream
            const result = pullService.pull();

            // Assert: Pull succeeded
            assert.ok(result.success, 'Pull should succeed');

            // Assert: Commits are in the same order
            const localCommits = pullService.getLocalCommits(branchName);

            // Find the indices of our commits in local
            const remoteHashes = remoteCommits.map((c) => c.hash);
            const localIndices: number[] = [];
            for (const hash of remoteHashes) {
              const idx = localCommits.findIndex((c) => c.hash === hash);
              if (idx !== -1) {
                localIndices.push(idx);
              }
            }

            // Assert: All commits were found
            assert.strictEqual(
              localIndices.length,
              remoteCommits.length,
              'All commits should be in local'
            );

            // Assert: Indices are in ascending order (preserves order)
            for (let i = 1; i < localIndices.length; i++) {
              assert.ok(
                localIndices[i] > localIndices[i - 1],
                `Commit order should be preserved: index ${i} (${localIndices[i]}) should be > index ${i - 1} (${localIndices[i - 1]})`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
