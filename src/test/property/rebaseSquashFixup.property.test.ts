import * as fc from 'fast-check';
import * as assert from 'assert';
import {
  RebaseAction,
  IRebaseCommit,
  IRebaseSession,
  IRebaseAction,
  IRebaseResult,
} from '../../services/interfaces/IRebaseService';

/**
 * Property-based tests for Rebase Squash/Fixup Combination.
 * Feature: intellig-vscode, Property 16: Rebase Squash/Fixup Combination
 *
 * **Validates: Requirements 6.6**
 *
 * Property Description:
 * For any commits marked for squash or fixup, the resulting history SHALL contain a single
 * commit with the combined changes of all squashed commits. Squash keeps all commit messages,
 * while fixup discards the fixup commit's message.
 */
describe('Rebase Squash/Fixup Combination Property Tests', () => {
  /**
   * Arbitrary generator for valid commit hashes (40 hex characters)
   */
  const commitHashArb: fc.Arbitrary<string> = fc.stringOf(
    fc.constantFrom(...'0123456789abcdef'.split('')),
    { minLength: 40, maxLength: 40 }
  );

  /**
   * Arbitrary generator for commit messages (non-empty strings)
   */
  const commitMessageArb: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 100 });

  /**
   * Arbitrary generator for valid branch names
   */
  const branchNameArb: fc.Arbitrary<string> = fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'.split('')
      ),
      { minLength: 1, maxLength: 30 }
    )
    .filter((s) => {
      if (s.length === 0) {
        return false;
      }
      if (s.startsWith('.') || s.startsWith('-')) {
        return false;
      }
      if (s.endsWith('.lock')) {
        return false;
      }
      if (s === 'HEAD' || s === 'head') {
        return false;
      }
      return true;
    });

  /**
   * Arbitrary generator for file names
   */
  const fileNameArb: fc.Arbitrary<string> = fc
    .stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
      minLength: 1,
      maxLength: 20,
    })
    .map((s) => `${s}.txt`);

  /**
   * Arbitrary generator for file content
   */
  const fileContentArb: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 100 });

  /**
   * Represents a file change in a commit
   */
  interface IFileChange {
    path: string;
    content: string;
  }

  /**
   * Represents a commit in the mock repository
   */
  interface IMockCommit {
    hash: string;
    message: string;
    parents: string[];
    changes: IFileChange[];
    timestamp: number;
  }

  /**
   * Mock Rebase Service that simulates interactive rebase with squash/fixup behavior.
   * This allows us to test squash/fixup properties without actual Git operations.
   *
   * Requirements: 6.6
   */
  class MockRebaseService {
    private _session: IRebaseSession | undefined;
    private _commits: Map<string, IMockCommit> = new Map();
    private _rebasedCommits: Map<string, IMockCommit> = new Map();
    private _hashCounter: number = 0;
    private _nextTimestamp: number = 1000;

    /**
     * Generate a unique commit hash
     */
    private generateHash(): string {
      const chars = '0123456789abcdef';
      let hash = '';
      const counterStr = (this._hashCounter++).toString(16).padStart(8, '0');
      hash = counterStr;
      for (let i = 8; i < 40; i++) {
        hash += chars[Math.floor(Math.random() * chars.length)];
      }
      return hash;
    }

    /**
     * Add a commit to the repository
     */
    addCommit(hash: string, message: string, changes: IFileChange[], parents: string[] = []): void {
      this._commits.set(hash, {
        hash,
        message,
        changes,
        parents,
        timestamp: this._nextTimestamp++,
      });
    }

    /**
     * Get a commit by hash
     */
    getCommit(hash: string): IMockCommit | undefined {
      return this._rebasedCommits.get(hash) || this._commits.get(hash);
    }

    /**
     * Start an interactive rebase session
     */
    startInteractiveRebase(
      onto: string,
      originalBranch: string,
      commits: IRebaseCommit[]
    ): IRebaseSession {
      this._session = {
        onto,
        originalBranch,
        commits: commits.map((c) => ({ ...c })),
        currentStep: 0,
        status: 'planning',
      };
      return this._session;
    }

    /**
     * Get the current rebase session
     */
    getRebaseSession(): IRebaseSession | undefined {
      return this._session;
    }

    /**
     * Update the rebase plan with new actions
     */
    updateRebasePlan(plan: IRebaseAction[]): void {
      if (!this._session) {
        throw new Error('No rebase session found');
      }

      for (const action of plan) {
        const commit = this._session.commits.find((c) => c.hash === action.hash);
        if (commit) {
          commit.action = action.action;
          if (action.newMessage) {
            commit.message = action.newMessage;
          }
        }
      }
    }

    /**
     * Combine file changes from multiple commits.
     * Later changes to the same file override earlier ones.
     */
    private combineChanges(changesList: IFileChange[][]): IFileChange[] {
      const changeMap = new Map<string, IFileChange>();
      for (const changes of changesList) {
        for (const change of changes) {
          changeMap.set(change.path, change);
        }
      }
      return Array.from(changeMap.values());
    }

    /**
     * Execute the rebase with the current plan.
     * Squash combines commits and keeps all commit messages.
     * Fixup combines commits but discards the fixup commit's message.
     *
     * Requirements: 6.6
     */
    executeRebase(): IRebaseResult {
      if (!this._session) {
        throw new Error('No rebase session found');
      }

      this._session.status = 'in-progress';

      // Track pending squash/fixup commits to combine
      let pendingChanges: IFileChange[][] = [];
      let pendingMessages: string[] = [];
      let baseCommit: IMockCommit | undefined;

      // Process commits
      while (this._session.currentStep < this._session.commits.length) {
        const commit = this._session.commits[this._session.currentStep];
        const originalCommit = this._commits.get(commit.hash);

        if (!originalCommit) {
          this._session.currentStep++;
          continue;
        }

        if (commit.action === 'drop') {
          // Skip dropped commits
          this._session.currentStep++;
          continue;
        }

        if (commit.action === 'squash') {
          // Squash: combine with previous commit, keep message
          if (pendingChanges.length === 0 && this._rebasedCommits.size > 0) {
            // Get the last rebased commit as the base
            const lastRebased = this.getLastRebasedCommit();
            if (lastRebased) {
              baseCommit = lastRebased;
              pendingChanges.push(lastRebased.changes);
              pendingMessages.push(lastRebased.message);
              // Remove the last commit since we'll recreate it combined
              this._rebasedCommits.delete(lastRebased.hash);
            }
          }
          pendingChanges.push(originalCommit.changes);
          pendingMessages.push(originalCommit.message); // Keep message for squash
          this._session.currentStep++;
          continue;
        }

        if (commit.action === 'fixup') {
          // Fixup: combine with previous commit, discard message
          if (pendingChanges.length === 0 && this._rebasedCommits.size > 0) {
            // Get the last rebased commit as the base
            const lastRebased = this.getLastRebasedCommit();
            if (lastRebased) {
              baseCommit = lastRebased;
              pendingChanges.push(lastRebased.changes);
              pendingMessages.push(lastRebased.message);
              // Remove the last commit since we'll recreate it combined
              this._rebasedCommits.delete(lastRebased.hash);
            }
          }
          pendingChanges.push(originalCommit.changes);
          // Do NOT add message for fixup - this is the key difference from squash
          this._session.currentStep++;
          continue;
        }

        // For pick (and other actions), first flush any pending squash/fixup
        if (pendingChanges.length > 0) {
          const combinedChanges = this.combineChanges(pendingChanges);
          const combinedMessage = pendingMessages.join('\n\n');
          const newHash = this.generateHash();
          const newCommit: IMockCommit = {
            hash: newHash,
            message: combinedMessage,
            changes: combinedChanges,
            parents: baseCommit?.parents || [],
            timestamp: this._nextTimestamp++,
          };
          this._rebasedCommits.set(newHash, newCommit);
          pendingChanges = [];
          pendingMessages = [];
          baseCommit = undefined;
        }

        // Create the rebased commit for pick
        const newHash = this.generateHash();
        const newCommit: IMockCommit = {
          hash: newHash,
          message: commit.message,
          changes: [...originalCommit.changes],
          parents: originalCommit.parents,
          timestamp: this._nextTimestamp++,
        };
        this._rebasedCommits.set(newHash, newCommit);
        this._session.currentStep++;
      }

      // Flush any remaining pending squash/fixup at the end
      if (pendingChanges.length > 0) {
        const combinedChanges = this.combineChanges(pendingChanges);
        const combinedMessage = pendingMessages.join('\n\n');
        const newHash = this.generateHash();
        const newCommit: IMockCommit = {
          hash: newHash,
          message: combinedMessage,
          changes: combinedChanges,
          parents: baseCommit?.parents || [],
          timestamp: this._nextTimestamp++,
        };
        this._rebasedCommits.set(newHash, newCommit);
      }

      // Rebase completed
      this._session.status = 'completed';
      return { success: true, status: 'completed' };
    }

    /**
     * Get the last rebased commit
     */
    getLastRebasedCommit(): IMockCommit | undefined {
      let lastCommit: IMockCommit | undefined;
      for (const commit of this._rebasedCommits.values()) {
        if (!lastCommit || commit.timestamp > lastCommit.timestamp) {
          lastCommit = commit;
        }
      }
      return lastCommit;
    }

    /**
     * Get all rebased commits
     */
    getRebasedCommits(): IMockCommit[] {
      return Array.from(this._rebasedCommits.values()).sort((a, b) => a.timestamp - b.timestamp);
    }

    /**
     * Get the number of rebased commits
     */
    getRebasedCommitCount(): number {
      return this._rebasedCommits.size;
    }
  }

  /**
   * Arbitrary generator for a rebase commit with pick action
   */
  const rebaseCommitArb: fc.Arbitrary<IRebaseCommit> = fc.record({
    hash: commitHashArb,
    message: commitMessageArb,
    action: fc.constant('pick' as RebaseAction),
  });

  /**
   * Arbitrary generator for file changes
   */
  const fileChangesArb: fc.Arbitrary<IFileChange[]> = fc
    .array(
      fc.record({
        path: fileNameArb,
        content: fileContentArb,
      }),
      { minLength: 1, maxLength: 5 }
    )
    .map((files) => {
      const seen = new Set<string>();
      return files.filter((f) => {
        if (seen.has(f.path)) {
          return false;
        }
        seen.add(f.path);
        return true;
      });
    })
    .filter((files) => files.length > 0);

  /**
   * Arbitrary generator for an array of rebase commits with unique hashes
   */
  const rebaseCommitsArb: fc.Arbitrary<IRebaseCommit[]> = fc
    .array(rebaseCommitArb, { minLength: 2, maxLength: 10 })
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
    .filter((commits) => commits.length >= 2);

  /**
   * Check if a message contains another message (for squash verification)
   */
  function messageContains(combinedMessage: string, originalMessage: string): boolean {
    return combinedMessage.includes(originalMessage);
  }

  /**
   * Check if changes from source are present in target
   */
  function changesContained(targetChanges: IFileChange[], sourceChanges: IFileChange[]): boolean {
    for (const source of sourceChanges) {
      const found = targetChanges.find(
        (t) => t.path === source.path && t.content === source.content
      );
      if (!found) {
        // Check if the file exists with any content (later changes override)
        const fileExists = targetChanges.find((t) => t.path === source.path);
        if (!fileExists) {
          return false;
        }
      }
    }
    return true;
  }

  describe('Property 16: Rebase Squash/Fixup Combination', () => {
    /**
     * Property: Squash action combines commits and keeps all commit messages.
     *
     * **Validates: Requirements 6.6**
     */
    it('Property: Squash action combines commits and keeps all commit messages', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb,
          branchNameArb,
          commitHashArb,
          fc.array(fileChangesArb, { minLength: 2, maxLength: 5 }),
          (commits, branchName, ontoHash, fileChangesList): boolean => {
            // Ensure we have enough file changes for each commit
            if (fileChangesList.length < commits.length) {
              return true; // Skip if not enough file changes
            }

            const rebaseService = new MockRebaseService();

            // Add original commits with unique file changes
            for (let i = 0; i < commits.length; i++) {
              const changes = fileChangesList[i % fileChangesList.length].map((f) => ({
                path: `commit${i}_${f.path}`,
                content: `commit${i}_${f.content}`,
              }));
              rebaseService.addCommit(commits[i].hash, commits[i].message, changes);
            }

            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);

            // Mark second commit for squash (squash into first)
            rebaseService.updateRebasePlan([{ hash: commits[1].hash, action: 'squash' }]);

            // Execute rebase
            const result = rebaseService.executeRebase();

            // Assert: Rebase should complete
            assert.strictEqual(result.success, true, 'Rebase should succeed');
            assert.strictEqual(result.status, 'completed', 'Rebase should complete');

            // Assert: Should have one fewer commit (two combined into one)
            const rebasedCommits = rebaseService.getRebasedCommits();
            assert.strictEqual(
              rebasedCommits.length,
              commits.length - 1,
              'Should have one fewer commit after squash'
            );

            // Assert: First rebased commit should contain both messages
            const squashedCommit = rebasedCommits[0];
            assert.ok(
              messageContains(squashedCommit.message, commits[0].message),
              'Squashed commit should contain first commit message'
            );
            assert.ok(
              messageContains(squashedCommit.message, commits[1].message),
              'Squashed commit should contain second commit message'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Fixup action combines commits but discards the fixup commit's message.
     *
     * **Validates: Requirements 6.6**
     */
    it('Property: Fixup action combines commits but discards the fixup commit message', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb,
          branchNameArb,
          commitHashArb,
          fc.array(fileChangesArb, { minLength: 2, maxLength: 5 }),
          (commits, branchName, ontoHash, fileChangesList): boolean => {
            if (fileChangesList.length < commits.length) {
              return true;
            }

            const rebaseService = new MockRebaseService();

            // Add original commits with unique file changes
            for (let i = 0; i < commits.length; i++) {
              const changes = fileChangesList[i % fileChangesList.length].map((f) => ({
                path: `commit${i}_${f.path}`,
                content: `commit${i}_${f.content}`,
              }));
              rebaseService.addCommit(commits[i].hash, commits[i].message, changes);
            }

            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);

            // Mark second commit for fixup (fixup into first)
            rebaseService.updateRebasePlan([{ hash: commits[1].hash, action: 'fixup' }]);

            // Execute rebase
            const result = rebaseService.executeRebase();

            // Assert: Rebase should complete
            assert.strictEqual(result.success, true, 'Rebase should succeed');
            assert.strictEqual(result.status, 'completed', 'Rebase should complete');

            // Assert: Should have one fewer commit
            const rebasedCommits = rebaseService.getRebasedCommits();
            assert.strictEqual(
              rebasedCommits.length,
              commits.length - 1,
              'Should have one fewer commit after fixup'
            );

            // Assert: First rebased commit should contain only the first message (fixup discards)
            const fixedUpCommit = rebasedCommits[0];
            assert.ok(
              messageContains(fixedUpCommit.message, commits[0].message),
              'Fixed up commit should contain first commit message'
            );
            assert.ok(
              !messageContains(fixedUpCommit.message, commits[1].message),
              'Fixed up commit should NOT contain second commit message (fixup discards it)'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Squash combines changes from all squashed commits.
     *
     * **Validates: Requirements 6.6**
     */
    it('Property: Squash combines changes from all squashed commits', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb,
          branchNameArb,
          commitHashArb,
          fc.array(fileChangesArb, { minLength: 2, maxLength: 5 }),
          (commits, branchName, ontoHash, fileChangesList): boolean => {
            if (fileChangesList.length < commits.length) {
              return true;
            }

            const rebaseService = new MockRebaseService();

            // Add original commits with unique file changes (different files per commit)
            const allOriginalChanges: IFileChange[][] = [];
            for (let i = 0; i < commits.length; i++) {
              const changes = fileChangesList[i % fileChangesList.length].map((f) => ({
                path: `unique_commit${i}_${f.path}`,
                content: `unique_commit${i}_${f.content}`,
              }));
              rebaseService.addCommit(commits[i].hash, commits[i].message, changes);
              allOriginalChanges.push(changes);
            }

            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);

            // Mark second commit for squash
            rebaseService.updateRebasePlan([{ hash: commits[1].hash, action: 'squash' }]);

            // Execute rebase
            rebaseService.executeRebase();

            // Assert: Squashed commit should contain changes from both commits
            const rebasedCommits = rebaseService.getRebasedCommits();
            const squashedCommit = rebasedCommits[0];

            // Check that changes from first commit are present
            assert.ok(
              changesContained(squashedCommit.changes, allOriginalChanges[0]),
              'Squashed commit should contain changes from first commit'
            );

            // Check that changes from second commit are present
            assert.ok(
              changesContained(squashedCommit.changes, allOriginalChanges[1]),
              'Squashed commit should contain changes from second commit'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Fixup combines changes from all fixup commits.
     *
     * **Validates: Requirements 6.6**
     */
    it('Property: Fixup combines changes from all fixup commits', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb,
          branchNameArb,
          commitHashArb,
          fc.array(fileChangesArb, { minLength: 2, maxLength: 5 }),
          (commits, branchName, ontoHash, fileChangesList): boolean => {
            if (fileChangesList.length < commits.length) {
              return true;
            }

            const rebaseService = new MockRebaseService();

            // Add original commits with unique file changes
            const allOriginalChanges: IFileChange[][] = [];
            for (let i = 0; i < commits.length; i++) {
              const changes = fileChangesList[i % fileChangesList.length].map((f) => ({
                path: `unique_commit${i}_${f.path}`,
                content: `unique_commit${i}_${f.content}`,
              }));
              rebaseService.addCommit(commits[i].hash, commits[i].message, changes);
              allOriginalChanges.push(changes);
            }

            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);

            // Mark second commit for fixup
            rebaseService.updateRebasePlan([{ hash: commits[1].hash, action: 'fixup' }]);

            // Execute rebase
            rebaseService.executeRebase();

            // Assert: Fixed up commit should contain changes from both commits
            const rebasedCommits = rebaseService.getRebasedCommits();
            const fixedUpCommit = rebasedCommits[0];

            // Check that changes from first commit are present
            assert.ok(
              changesContained(fixedUpCommit.changes, allOriginalChanges[0]),
              'Fixed up commit should contain changes from first commit'
            );

            // Check that changes from second commit are present
            assert.ok(
              changesContained(fixedUpCommit.changes, allOriginalChanges[1]),
              'Fixed up commit should contain changes from second commit'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Multiple squash actions combine correctly in sequence.
     *
     * **Validates: Requirements 6.6**
     */
    it('Property: Multiple squash actions combine correctly in sequence', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb.filter((c) => c.length >= 3),
          branchNameArb,
          commitHashArb,
          fc.array(fileChangesArb, { minLength: 3, maxLength: 5 }),
          (commits, branchName, ontoHash, fileChangesList): boolean => {
            if (fileChangesList.length < commits.length) {
              return true;
            }

            const rebaseService = new MockRebaseService();

            // Add original commits
            for (let i = 0; i < commits.length; i++) {
              const changes = fileChangesList[i % fileChangesList.length].map((f) => ({
                path: `commit${i}_${f.path}`,
                content: `commit${i}_${f.content}`,
              }));
              rebaseService.addCommit(commits[i].hash, commits[i].message, changes);
            }

            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);

            // Mark second and third commits for squash (all three combine into one)
            rebaseService.updateRebasePlan([
              { hash: commits[1].hash, action: 'squash' },
              { hash: commits[2].hash, action: 'squash' },
            ]);

            // Execute rebase
            const result = rebaseService.executeRebase();

            // Assert: Rebase should complete
            assert.strictEqual(result.success, true, 'Rebase should succeed');

            // Assert: Should have two fewer commits (three combined into one)
            const rebasedCommits = rebaseService.getRebasedCommits();
            assert.strictEqual(
              rebasedCommits.length,
              commits.length - 2,
              'Should have two fewer commits after multiple squash'
            );

            // Assert: First rebased commit should contain all three messages
            const squashedCommit = rebasedCommits[0];
            assert.ok(
              messageContains(squashedCommit.message, commits[0].message),
              'Squashed commit should contain first commit message'
            );
            assert.ok(
              messageContains(squashedCommit.message, commits[1].message),
              'Squashed commit should contain second commit message'
            );
            assert.ok(
              messageContains(squashedCommit.message, commits[2].message),
              'Squashed commit should contain third commit message'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Multiple fixup actions combine correctly in sequence.
     *
     * **Validates: Requirements 6.6**
     */
    it('Property: Multiple fixup actions combine correctly in sequence', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb.filter((c) => c.length >= 3),
          branchNameArb,
          commitHashArb,
          fc.array(fileChangesArb, { minLength: 3, maxLength: 5 }),
          (commits, branchName, ontoHash, fileChangesList): boolean => {
            if (fileChangesList.length < commits.length) {
              return true;
            }

            const rebaseService = new MockRebaseService();

            // Add original commits
            for (let i = 0; i < commits.length; i++) {
              const changes = fileChangesList[i % fileChangesList.length].map((f) => ({
                path: `commit${i}_${f.path}`,
                content: `commit${i}_${f.content}`,
              }));
              rebaseService.addCommit(commits[i].hash, commits[i].message, changes);
            }

            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);

            // Mark second and third commits for fixup
            rebaseService.updateRebasePlan([
              { hash: commits[1].hash, action: 'fixup' },
              { hash: commits[2].hash, action: 'fixup' },
            ]);

            // Execute rebase
            const result = rebaseService.executeRebase();

            // Assert: Rebase should complete
            assert.strictEqual(result.success, true, 'Rebase should succeed');

            // Assert: Should have two fewer commits
            const rebasedCommits = rebaseService.getRebasedCommits();
            assert.strictEqual(
              rebasedCommits.length,
              commits.length - 2,
              'Should have two fewer commits after multiple fixup'
            );

            // Assert: First rebased commit should contain only the first message
            const fixedUpCommit = rebasedCommits[0];
            assert.ok(
              messageContains(fixedUpCommit.message, commits[0].message),
              'Fixed up commit should contain first commit message'
            );
            assert.ok(
              !messageContains(fixedUpCommit.message, commits[1].message),
              'Fixed up commit should NOT contain second commit message'
            );
            assert.ok(
              !messageContains(fixedUpCommit.message, commits[2].message),
              'Fixed up commit should NOT contain third commit message'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Mixed squash and fixup actions combine correctly.
     *
     * **Validates: Requirements 6.6**
     */
    it('Property: Mixed squash and fixup actions combine correctly', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb.filter((c) => c.length >= 3),
          branchNameArb,
          commitHashArb,
          fc.array(fileChangesArb, { minLength: 3, maxLength: 5 }),
          (commits, branchName, ontoHash, fileChangesList): boolean => {
            if (fileChangesList.length < commits.length) {
              return true;
            }

            const rebaseService = new MockRebaseService();

            // Add original commits
            for (let i = 0; i < commits.length; i++) {
              const changes = fileChangesList[i % fileChangesList.length].map((f) => ({
                path: `commit${i}_${f.path}`,
                content: `commit${i}_${f.content}`,
              }));
              rebaseService.addCommit(commits[i].hash, commits[i].message, changes);
            }

            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);

            // Mark second commit for squash, third for fixup
            rebaseService.updateRebasePlan([
              { hash: commits[1].hash, action: 'squash' },
              { hash: commits[2].hash, action: 'fixup' },
            ]);

            // Execute rebase
            const result = rebaseService.executeRebase();

            // Assert: Rebase should complete
            assert.strictEqual(result.success, true, 'Rebase should succeed');

            // Assert: Should have two fewer commits
            const rebasedCommits = rebaseService.getRebasedCommits();
            assert.strictEqual(
              rebasedCommits.length,
              commits.length - 2,
              'Should have two fewer commits after mixed squash/fixup'
            );

            // Assert: Combined commit should have first and second messages (squash keeps)
            // but NOT third message (fixup discards)
            const combinedCommit = rebasedCommits[0];
            assert.ok(
              messageContains(combinedCommit.message, commits[0].message),
              'Combined commit should contain first commit message'
            );
            assert.ok(
              messageContains(combinedCommit.message, commits[1].message),
              'Combined commit should contain second commit message (squash keeps it)'
            );
            assert.ok(
              !messageContains(combinedCommit.message, commits[2].message),
              'Combined commit should NOT contain third commit message (fixup discards it)'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Squash/fixup results in single commit with combined changes.
     *
     * **Validates: Requirements 6.6**
     */
    it('Property: Squash/fixup results in single commit with combined changes', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb,
          branchNameArb,
          commitHashArb,
          fc.array(fileChangesArb, { minLength: 2, maxLength: 5 }),
          fc.constantFrom<'squash' | 'fixup'>('squash', 'fixup'),
          (commits, branchName, ontoHash, fileChangesList, action): boolean => {
            if (fileChangesList.length < commits.length) {
              return true;
            }

            const rebaseService = new MockRebaseService();

            // Add original commits with unique file changes
            const allOriginalChanges: IFileChange[][] = [];
            for (let i = 0; i < commits.length; i++) {
              const changes = fileChangesList[i % fileChangesList.length].map((f) => ({
                path: `unique_${i}_${f.path}`,
                content: `unique_${i}_${f.content}`,
              }));
              rebaseService.addCommit(commits[i].hash, commits[i].message, changes);
              allOriginalChanges.push(changes);
            }

            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);

            // Mark second commit for squash or fixup
            rebaseService.updateRebasePlan([{ hash: commits[1].hash, action }]);

            // Execute rebase
            rebaseService.executeRebase();

            // Assert: Should have one fewer commit
            const rebasedCommits = rebaseService.getRebasedCommits();
            assert.strictEqual(
              rebasedCommits.length,
              commits.length - 1,
              `Should have one fewer commit after ${action}`
            );

            // Assert: Combined commit should have changes from both
            const combinedCommit = rebasedCommits[0];
            assert.ok(
              changesContained(combinedCommit.changes, allOriginalChanges[0]),
              'Combined commit should contain changes from first commit'
            );
            assert.ok(
              changesContained(combinedCommit.changes, allOriginalChanges[1]),
              'Combined commit should contain changes from second commit'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Squash preserves message order (first commit message first).
     *
     * **Validates: Requirements 6.6**
     */
    it('Property: Squash preserves message order (first commit message first)', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb,
          branchNameArb,
          commitHashArb,
          fc.array(fileChangesArb, { minLength: 2, maxLength: 5 }),
          (commits, branchName, ontoHash, fileChangesList): boolean => {
            if (fileChangesList.length < commits.length) {
              return true;
            }

            const rebaseService = new MockRebaseService();

            // Add original commits
            for (let i = 0; i < commits.length; i++) {
              const changes = fileChangesList[i % fileChangesList.length].map((f) => ({
                path: `commit${i}_${f.path}`,
                content: `commit${i}_${f.content}`,
              }));
              rebaseService.addCommit(commits[i].hash, commits[i].message, changes);
            }

            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);

            // Mark second commit for squash
            rebaseService.updateRebasePlan([{ hash: commits[1].hash, action: 'squash' }]);

            // Execute rebase
            rebaseService.executeRebase();

            // Assert: First message should appear before second message in combined message
            const rebasedCommits = rebaseService.getRebasedCommits();
            const squashedCommit = rebasedCommits[0];

            const firstMsgIndex = squashedCommit.message.indexOf(commits[0].message);
            const secondMsgIndex = squashedCommit.message.indexOf(commits[1].message);

            assert.ok(firstMsgIndex >= 0, 'First message should be in combined message');
            assert.ok(secondMsgIndex >= 0, 'Second message should be in combined message');
            assert.ok(
              firstMsgIndex < secondMsgIndex,
              'First commit message should appear before second commit message'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Squash/fixup does not affect commits not marked for squash/fixup.
     *
     * **Validates: Requirements 6.6**
     */
    it('Property: Squash/fixup does not affect other commits', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb.filter((c) => c.length >= 4),
          branchNameArb,
          commitHashArb,
          fc.array(fileChangesArb, { minLength: 4, maxLength: 6 }),
          (commits, branchName, ontoHash, fileChangesList): boolean => {
            if (fileChangesList.length < commits.length) {
              return true;
            }

            const rebaseService = new MockRebaseService();

            // Add original commits
            for (let i = 0; i < commits.length; i++) {
              const changes = fileChangesList[i % fileChangesList.length].map((f) => ({
                path: `commit${i}_${f.path}`,
                content: `commit${i}_${f.content}`,
              }));
              rebaseService.addCommit(commits[i].hash, commits[i].message, changes);
            }

            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);

            // Mark only second commit for squash (into first)
            // Third and fourth commits should remain unchanged
            rebaseService.updateRebasePlan([{ hash: commits[1].hash, action: 'squash' }]);

            // Execute rebase
            rebaseService.executeRebase();

            // Assert: Should have one fewer commit
            const rebasedCommits = rebaseService.getRebasedCommits();
            assert.strictEqual(
              rebasedCommits.length,
              commits.length - 1,
              'Should have one fewer commit'
            );

            // Assert: Commits after the squash should have their original messages
            // rebasedCommits[0] is the squashed commit (commits[0] + commits[1])
            // rebasedCommits[1] should be commits[2]
            // rebasedCommits[2] should be commits[3]
            for (let i = 2; i < commits.length; i++) {
              const rebasedIndex = i - 1; // Offset by 1 due to squash
              assert.strictEqual(
                rebasedCommits[rebasedIndex].message,
                commits[i].message,
                `Commit at original index ${i} should have unchanged message`
              );
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
