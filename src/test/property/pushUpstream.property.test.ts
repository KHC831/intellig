import * as fc from 'fast-check';
import * as assert from 'assert';
import { IPushOptions, ICommit, IUpstream } from '../../services/interfaces/IGitService';

/**
 * Property-based tests for Push Upstream.
 * Feature: intellij-git-vscode, Property 38: Push Upstream
 *
 * **Validates: Requirements 12.1**
 *
 * Property Description:
 * For any branch with a configured upstream, pushing SHALL send all local commits
 * not present on the remote to the upstream branch.
 *
 * Requirements:
 * - 12.1: WHEN a user selects 'Push', THE Extension SHALL push the current branch
 *         to its configured upstream remote
 * - 12.2: WHEN pushing with no upstream configured, THE Extension SHALL prompt to
 *         set the upstream branch
 */
describe('Push Upstream Property Tests', () => {
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
   * Arbitrary generator for push options.
   */
  const pushOptionsArb: fc.Arbitrary<IPushOptions> = fc.record({
    force: fc.option(fc.boolean(), { nil: undefined }),
    forceWithLease: fc.option(fc.boolean(), { nil: undefined }),
    setUpstream: fc.option(fc.boolean(), { nil: undefined }),
    remote: fc.option(remoteNameArb, { nil: undefined }),
    branch: fc.option(branchNameArb, { nil: undefined }),
    tags: fc.option(fc.boolean(), { nil: undefined }),
  });

  /**
   * Mock Push Service that simulates push operations in memory.
   * This allows us to test the push upstream properties without actual Git operations.
   */
  class MockPushService {
    private _localCommits: Map<string, ICommit[]> = new Map();
    private _remoteCommits: Map<string, ICommit[]> = new Map();
    private _upstreams: Map<string, IUpstream | undefined> = new Map();
    private _currentBranch: string = 'main';
    private _pushHistory: Array<{
      branch: string;
      remote: string;
      commits: ICommit[];
      options?: IPushOptions;
    }> = [];
    private _upstreamPromptShown: boolean = false;

    constructor(options?: {
      currentBranch?: string;
      localCommits?: ICommit[];
      remoteCommits?: ICommit[];
      upstream?: IUpstream;
    }) {
      this._currentBranch = options?.currentBranch || 'main';
      if (options?.localCommits) {
        this._localCommits.set(this._currentBranch, [...options.localCommits]);
      }
      if (options?.remoteCommits) {
        const remoteBranch = options?.upstream
          ? `${options.upstream.remote}/${options.upstream.name}`
          : `origin/${this._currentBranch}`;
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
     * Set the upstream configuration for a branch.
     */
    setUpstream(branch: string, upstream: IUpstream): void {
      this._upstreams.set(branch, upstream);
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
     * Add local commits to a branch.
     */
    addLocalCommits(branch: string, commits: ICommit[]): void {
      const existing = this._localCommits.get(branch) || [];
      this._localCommits.set(branch, [...existing, ...commits]);
    }

    /**
     * Check if upstream prompt was shown.
     */
    wasUpstreamPromptShown(): boolean {
      return this._upstreamPromptShown;
    }

    /**
     * Get push history.
     */
    getPushHistory(): Array<{
      branch: string;
      remote: string;
      commits: ICommit[];
      options?: IPushOptions;
    }> {
      return this._pushHistory;
    }

    /**
     * Get commits that are local but not on remote.
     */
    getCommitsToSend(branch: string): ICommit[] {
      const upstream = this._upstreams.get(branch);
      if (!upstream) {
        return [];
      }

      const localCommits = this._localCommits.get(branch) || [];
      const remoteBranch = `${upstream.remote}/${upstream.name}`;
      const remoteCommits = this._remoteCommits.get(remoteBranch) || [];
      const remoteHashes = new Set(remoteCommits.map((c) => c.hash));

      return localCommits.filter((c) => !remoteHashes.has(c.hash));
    }

    /**
     * Push the current branch to its upstream.
     * Requirement 12.1: Push the current branch to its configured upstream remote.
     * Requirement 12.2: Prompt to set upstream if not configured.
     *
     * @param options - Push options
     * @returns Result of the push operation
     */
    push(options?: IPushOptions): { success: boolean; error?: string; commitsPushed?: ICommit[] } {
      const branch = this._currentBranch;
      let upstream = this._upstreams.get(branch);

      // If no upstream and setUpstream option is provided, configure it
      if (!upstream && options?.setUpstream && options?.remote && options?.branch) {
        upstream = { remote: options.remote, name: options.branch };
        this._upstreams.set(branch, upstream);
      }

      // If still no upstream, prompt to set it
      if (!upstream) {
        this._upstreamPromptShown = true;
        return {
          success: false,
          error: 'No upstream configured. Please set upstream branch.',
        };
      }

      // Get commits to push
      const commitsToSend = this.getCommitsToSend(branch);
      const remoteBranch = `${upstream.remote}/${upstream.name}`;

      // Simulate push - add local commits to remote
      const existingRemote = this._remoteCommits.get(remoteBranch) || [];

      // Check for force push scenarios
      const localHashes = new Set((this._localCommits.get(branch) || []).map((c) => c.hash));
      const remoteOnlyCommits = existingRemote.filter((c) => !localHashes.has(c.hash));

      if (remoteOnlyCommits.length > 0 && !options?.force && !options?.forceWithLease) {
        return {
          success: false,
          error:
            'Push rejected. Remote has commits not present locally. Pull first or use force push.',
        };
      }

      // Perform the push
      if (options?.force || options?.forceWithLease) {
        // Force push replaces remote with local
        this._remoteCommits.set(remoteBranch, [...(this._localCommits.get(branch) || [])]);
      } else {
        // Normal push adds commits
        this._remoteCommits.set(remoteBranch, [...existingRemote, ...commitsToSend]);
      }

      // Record push in history
      this._pushHistory.push({
        branch,
        remote: upstream.remote,
        commits: commitsToSend,
        options,
      });

      return {
        success: true,
        commitsPushed: commitsToSend,
      };
    }
  }

  describe('Property 38: Push Upstream', () => {
    /**
     * Property: Push sends local commits to the upstream branch.
     *
     * **Validates: Requirements 12.1**
     */
    it('Property: Push sends local commits to the upstream branch', () => {
      fc.assert(
        fc.property(
          branchNameArb,
          upstreamArb,
          uniqueCommitsArb,
          (branchName, upstream, localCommits) => {
            // Setup: Push service with local commits and configured upstream
            const pushService = new MockPushService({
              currentBranch: branchName,
              localCommits,
              upstream,
            });

            // Pre-condition: Upstream is configured
            assert.ok(pushService.getUpstream(branchName), 'Upstream should be configured');

            // Pre-condition: Local commits exist
            const commitsToSend = pushService.getCommitsToSend(branchName);
            assert.strictEqual(
              commitsToSend.length,
              localCommits.length,
              'All local commits should be pending'
            );

            // Act: Push to upstream
            const result = pushService.push();

            // Assert: Push succeeded
            assert.ok(result.success, 'Push should succeed');

            // Assert: All local commits were sent
            assert.strictEqual(
              result.commitsPushed?.length,
              localCommits.length,
              'All local commits should be pushed'
            );

            // Assert: Remote now has all local commits
            const remoteBranch = `${upstream.remote}/${upstream.name}`;
            const remoteCommits = pushService.getRemoteCommits(remoteBranch);
            for (const commit of localCommits) {
              const found = remoteCommits.find((c) => c.hash === commit.hash);
              assert.ok(found, `Commit ${commit.shortHash} should be on remote`);
            }

            // Assert: No more commits to send
            const remainingCommits = pushService.getCommitsToSend(branchName);
            assert.strictEqual(remainingCommits.length, 0, 'No commits should remain to push');
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Push with no upstream prompts to set upstream.
     *
     * **Validates: Requirements 12.1, 12.2**
     */
    it('Property: Push with no upstream prompts to set upstream', () => {
      fc.assert(
        fc.property(branchNameArb, uniqueCommitsArb, (branchName, localCommits) => {
          // Setup: Push service with local commits but NO upstream
          const pushService = new MockPushService({
            currentBranch: branchName,
            localCommits,
            // No upstream configured
          });

          // Pre-condition: No upstream is configured
          assert.strictEqual(
            pushService.getUpstream(branchName),
            undefined,
            'Upstream should not be configured'
          );

          // Act: Attempt to push
          const result = pushService.push();

          // Assert: Push failed
          assert.ok(!result.success, 'Push should fail without upstream');

          // Assert: Upstream prompt was shown
          assert.ok(pushService.wasUpstreamPromptShown(), 'Should prompt to set upstream');

          // Assert: Error message indicates upstream issue
          assert.ok(
            result.error?.toLowerCase().includes('upstream'),
            'Error should mention upstream'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Push with setUpstream option configures the upstream.
     *
     * **Validates: Requirements 12.1, 12.2**
     */
    it('Property: Push with setUpstream option configures the upstream', () => {
      fc.assert(
        fc.property(
          branchNameArb,
          remoteNameArb,
          branchNameArb,
          uniqueCommitsArb,
          (branchName, remoteName, remoteBranchName, localCommits) => {
            // Setup: Push service with local commits but NO upstream
            const pushService = new MockPushService({
              currentBranch: branchName,
              localCommits,
              // No upstream configured
            });

            // Pre-condition: No upstream is configured
            assert.strictEqual(
              pushService.getUpstream(branchName),
              undefined,
              'Upstream should not be configured initially'
            );

            // Act: Push with setUpstream option
            const result = pushService.push({
              setUpstream: true,
              remote: remoteName,
              branch: remoteBranchName,
            });

            // Assert: Push succeeded
            assert.ok(result.success, 'Push should succeed with setUpstream');

            // Assert: Upstream is now configured
            const upstream = pushService.getUpstream(branchName);
            assert.ok(upstream, 'Upstream should be configured after push');
            assert.strictEqual(upstream.remote, remoteName, 'Remote should match');
            assert.strictEqual(upstream.name, remoteBranchName, 'Branch name should match');
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Push preserves commit order.
     *
     * **Validates: Requirements 12.1**
     */
    it('Property: Push preserves commit order', () => {
      fc.assert(
        fc.property(
          branchNameArb,
          upstreamArb,
          uniqueCommitsArb,
          (branchName, upstream, localCommits) => {
            // Skip if less than 2 commits (order doesn't matter)
            fc.pre(localCommits.length >= 2);

            // Setup: Push service with local commits and configured upstream
            const pushService = new MockPushService({
              currentBranch: branchName,
              localCommits,
              upstream,
            });

            // Act: Push to upstream
            const result = pushService.push();

            // Assert: Push succeeded
            assert.ok(result.success, 'Push should succeed');

            // Assert: Commits are in the same order
            const remoteBranch = `${upstream.remote}/${upstream.name}`;
            const remoteCommits = pushService.getRemoteCommits(remoteBranch);

            // Find the indices of our commits in the remote
            const localHashes = localCommits.map((c) => c.hash);
            const remoteIndices: number[] = [];
            for (const hash of localHashes) {
              const idx = remoteCommits.findIndex((c) => c.hash === hash);
              if (idx !== -1) {
                remoteIndices.push(idx);
              }
            }

            // Assert: All commits were found
            assert.strictEqual(
              remoteIndices.length,
              localCommits.length,
              'All commits should be on remote'
            );

            // Assert: Indices are in ascending order (preserves order)
            for (let i = 1; i < remoteIndices.length; i++) {
              assert.ok(
                remoteIndices[i] > remoteIndices[i - 1],
                `Commit order should be preserved: index ${i} (${remoteIndices[i]}) should be > index ${i - 1} (${remoteIndices[i - 1]})`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Push with force option works correctly.
     *
     * **Validates: Requirements 12.1, 12.9**
     */
    it('Property: Push with force option works correctly', () => {
      fc.assert(
        fc.property(
          branchNameArb,
          upstreamArb,
          uniqueCommitsArb,
          uniqueCommitsArb,
          (branchName, upstream, localCommits, remoteOnlyCommits) => {
            // Ensure remote-only commits are different from local commits
            const localHashes = new Set(localCommits.map((c) => c.hash));
            const filteredRemoteOnly = remoteOnlyCommits.filter((c) => !localHashes.has(c.hash));
            fc.pre(filteredRemoteOnly.length > 0);

            // Setup: Push service with diverged history
            const pushService = new MockPushService({
              currentBranch: branchName,
              localCommits,
              remoteCommits: filteredRemoteOnly,
              upstream,
            });

            // Pre-condition: Remote has commits not in local
            const remoteBranch = `${upstream.remote}/${upstream.name}`;
            const initialRemoteCommits = pushService.getRemoteCommits(remoteBranch);
            assert.ok(initialRemoteCommits.length > 0, 'Remote should have commits');

            // Act: Normal push should fail
            const normalResult = pushService.push();
            assert.ok(!normalResult.success, 'Normal push should fail with diverged history');

            // Act: Force push should succeed
            const forceResult = pushService.push({ force: true });

            // Assert: Force push succeeded
            assert.ok(forceResult.success, 'Force push should succeed');

            // Assert: Remote now matches local (remote-only commits are gone)
            const finalRemoteCommits = pushService.getRemoteCommits(remoteBranch);
            for (const commit of localCommits) {
              const found = finalRemoteCommits.find((c) => c.hash === commit.hash);
              assert.ok(found, `Local commit ${commit.shortHash} should be on remote`);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Push only sends commits not already on remote.
     *
     * **Validates: Requirements 12.1**
     */
    it('Property: Push only sends commits not already on remote', () => {
      fc.assert(
        fc.property(
          branchNameArb,
          upstreamArb,
          uniqueCommitsArb,
          uniqueCommitsArb,
          (branchName, upstream, sharedCommits, newLocalCommits) => {
            // Ensure new local commits are different from shared commits
            const sharedHashes = new Set(sharedCommits.map((c) => c.hash));
            const filteredNewLocal = newLocalCommits.filter((c) => !sharedHashes.has(c.hash));
            fc.pre(filteredNewLocal.length > 0);

            // Setup: Push service with some commits already on remote
            const allLocalCommits = [...sharedCommits, ...filteredNewLocal];
            const pushService = new MockPushService({
              currentBranch: branchName,
              localCommits: allLocalCommits,
              remoteCommits: sharedCommits,
              upstream,
            });

            // Pre-condition: Some commits are already on remote
            const remoteBranch = `${upstream.remote}/${upstream.name}`;
            const initialRemoteCommits = pushService.getRemoteCommits(remoteBranch);
            assert.strictEqual(
              initialRemoteCommits.length,
              sharedCommits.length,
              'Remote should have shared commits'
            );

            // Act: Push to upstream
            const result = pushService.push();

            // Assert: Push succeeded
            assert.ok(result.success, 'Push should succeed');

            // Assert: Only new commits were pushed
            assert.strictEqual(
              result.commitsPushed?.length,
              filteredNewLocal.length,
              'Only new commits should be pushed'
            );

            // Assert: Pushed commits are the new local commits
            const pushedHashes = new Set(result.commitsPushed?.map((c) => c.hash) || []);
            for (const commit of filteredNewLocal) {
              assert.ok(
                pushedHashes.has(commit.hash),
                `New commit ${commit.shortHash} should be in pushed commits`
              );
            }

            // Assert: Shared commits were not re-pushed
            for (const commit of sharedCommits) {
              assert.ok(
                !pushedHashes.has(commit.hash),
                `Shared commit ${commit.shortHash} should not be re-pushed`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Push with forceWithLease option works correctly.
     *
     * **Validates: Requirements 12.1, 12.9**
     */
    it('Property: Push with forceWithLease option works correctly', () => {
      fc.assert(
        fc.property(
          branchNameArb,
          upstreamArb,
          uniqueCommitsArb,
          uniqueCommitsArb,
          (branchName, upstream, localCommits, remoteOnlyCommits) => {
            // Ensure remote-only commits are different from local commits
            const localHashes = new Set(localCommits.map((c) => c.hash));
            const filteredRemoteOnly = remoteOnlyCommits.filter((c) => !localHashes.has(c.hash));
            fc.pre(filteredRemoteOnly.length > 0);

            // Setup: Push service with diverged history
            const pushService = new MockPushService({
              currentBranch: branchName,
              localCommits,
              remoteCommits: filteredRemoteOnly,
              upstream,
            });

            // Act: Force with lease push should succeed
            const result = pushService.push({ forceWithLease: true });

            // Assert: Push succeeded
            assert.ok(result.success, 'Force with lease push should succeed');

            // Assert: Remote now has local commits
            const remoteBranch = `${upstream.remote}/${upstream.name}`;
            const finalRemoteCommits = pushService.getRemoteCommits(remoteBranch);
            for (const commit of localCommits) {
              const found = finalRemoteCommits.find((c) => c.hash === commit.hash);
              assert.ok(found, `Local commit ${commit.shortHash} should be on remote`);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Multiple pushes are idempotent when no new commits.
     *
     * **Validates: Requirements 12.1**
     */
    it('Property: Multiple pushes are idempotent when no new commits', () => {
      fc.assert(
        fc.property(
          branchNameArb,
          upstreamArb,
          uniqueCommitsArb,
          (branchName, upstream, localCommits) => {
            // Setup: Push service with local commits and configured upstream
            const pushService = new MockPushService({
              currentBranch: branchName,
              localCommits,
              upstream,
            });

            // Act: Push twice
            const result1 = pushService.push();
            const result2 = pushService.push();

            // Assert: Both pushes succeeded
            assert.ok(result1.success, 'First push should succeed');
            assert.ok(result2.success, 'Second push should succeed');

            // Assert: First push sent all commits
            assert.strictEqual(
              result1.commitsPushed?.length,
              localCommits.length,
              'First push should send all commits'
            );

            // Assert: Second push sent no commits (already on remote)
            assert.strictEqual(
              result2.commitsPushed?.length,
              0,
              'Second push should send no commits'
            );

            // Assert: Remote has exactly the local commits
            const remoteBranch = `${upstream.remote}/${upstream.name}`;
            const remoteCommits = pushService.getRemoteCommits(remoteBranch);
            assert.strictEqual(
              remoteCommits.length,
              localCommits.length,
              'Remote should have same number of commits as local'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Push records operation in history.
     *
     * **Validates: Requirements 12.1**
     */
    it('Property: Push records operation in history', () => {
      fc.assert(
        fc.property(
          branchNameArb,
          upstreamArb,
          uniqueCommitsArb,
          pushOptionsArb,
          (branchName, upstream, localCommits, options) => {
            // Setup: Push service with local commits and configured upstream
            const pushService = new MockPushService({
              currentBranch: branchName,
              localCommits,
              upstream,
            });

            // Pre-condition: No push history
            assert.strictEqual(
              pushService.getPushHistory().length,
              0,
              'Should start with no push history'
            );

            // Act: Push to upstream
            const result = pushService.push(options);

            // Assert: Push succeeded
            assert.ok(result.success, 'Push should succeed');

            // Assert: Push was recorded in history
            const history = pushService.getPushHistory();
            assert.strictEqual(history.length, 1, 'Should have one push in history');

            // Assert: History entry has correct details
            const entry = history[0];
            assert.strictEqual(entry.branch, branchName, 'Branch should match');
            assert.strictEqual(entry.remote, upstream.remote, 'Remote should match');
            assert.strictEqual(
              entry.commits.length,
              localCommits.length,
              'Commits count should match'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Push to specific remote and branch works correctly.
     *
     * **Validates: Requirements 12.1**
     */
    it('Property: Push to specific remote and branch works correctly', () => {
      fc.assert(
        fc.property(
          branchNameArb,
          remoteNameArb,
          branchNameArb,
          uniqueCommitsArb,
          (branchName, targetRemote, targetBranch, localCommits) => {
            // Setup: Push service with local commits and NO upstream
            const pushService = new MockPushService({
              currentBranch: branchName,
              localCommits,
            });

            // Act: Push with specific remote and branch, setting upstream
            const result = pushService.push({
              setUpstream: true,
              remote: targetRemote,
              branch: targetBranch,
            });

            // Assert: Push succeeded
            assert.ok(result.success, 'Push should succeed');

            // Assert: Upstream was set to specified remote/branch
            const upstream = pushService.getUpstream(branchName);
            assert.ok(upstream, 'Upstream should be configured');
            assert.strictEqual(upstream.remote, targetRemote, 'Remote should match target');
            assert.strictEqual(upstream.name, targetBranch, 'Branch should match target');

            // Assert: Commits are on the target remote branch
            const remoteBranch = `${targetRemote}/${targetBranch}`;
            const remoteCommits = pushService.getRemoteCommits(remoteBranch);
            assert.strictEqual(
              remoteCommits.length,
              localCommits.length,
              'Remote should have all local commits'
            );
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
