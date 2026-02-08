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
 * Property-based tests for Rebase Reword Behavior.
 * Feature: intellig-vscode, Property 14: Rebase Reword Behavior
 *
 *
 * Property Description:
 * For any commit marked for reword in interactive rebase, the rebase SHALL pause to prompt
 * for a new message, and the resulting commit SHALL have the new message with the same diff.
 */
describe('Rebase Reword Behavior Property Tests', () => {
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
   * Arbitrary generator for new reword messages (non-empty strings)
   */
  const newMessageArb: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 200 });

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
   * Represents a diff for a commit
   */
  interface ICommitDiff {
    path: string;
    oldContent: string | null;
    newContent: string | null;
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
   * Mock Rebase Service that simulates interactive rebase with reword behavior.
   * This allows us to test reword properties without actual Git operations.
   */
  class MockRebaseService {
    private _session: IRebaseSession | undefined;
    private _commits: Map<string, IMockCommit> = new Map();
    private _rebasedCommits: Map<string, IMockCommit> = new Map();
    private _hashCounter: number = 0;
    private _nextTimestamp: number = 1000;
    private _pausedForReword: boolean = false;
    private _currentRewordCommit: IRebaseCommit | undefined;

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
     * Get the diff for a commit
     */
    getCommitDiff(hash: string): ICommitDiff[] {
      const commit = this.getCommit(hash);
      if (!commit) {
        return [];
      }

      return commit.changes.map((change) => ({
        path: change.path,
        oldContent: null,
        newContent: change.content,
      }));
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
      this._pausedForReword = false;
      this._currentRewordCommit = undefined;
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
     * Check if the rebase is paused for reword
     */
    isPausedForReword(): boolean {
      return this._pausedForReword;
    }

    /**
     * Get the commit currently waiting for reword
     */
    getCurrentRewordCommit(): IRebaseCommit | undefined {
      return this._currentRewordCommit;
    }

    /**
     * Execute the rebase with the current plan.
     * When a commit is marked for reword, the rebase SHALL pause.
     */
    executeRebase(): IRebaseResult {
      if (!this._session) {
        throw new Error('No rebase session found');
      }

      this._session.status = 'in-progress';

      // Process commits until we hit a reword or complete
      while (this._session.currentStep < this._session.commits.length) {
        const commit = this._session.commits[this._session.currentStep];
        const originalCommit = this._commits.get(commit.hash);

        if (!originalCommit) {
          this._session.currentStep++;
          continue;
        }

        if (commit.action === 'reword') {
          // Pause for reword
          this._pausedForReword = true;
          this._currentRewordCommit = commit;
          this._session.status = 'paused';
          return { success: true, status: 'paused' };
        }

        if (commit.action === 'drop') {
          // Skip dropped commits
          this._session.currentStep++;
          continue;
        }

        // For pick and other actions, create the rebased commit
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

      // Rebase completed
      this._session.status = 'completed';
      return { success: true, status: 'completed' };
    }

    /**
     * Provide a new message for a reword action.
     * The resulting commit SHALL have the new message with the same diff.
     */
    provideRewordMessage(newMessage: string): IRebaseResult {
      if (!this._session) {
        throw new Error('No rebase session found');
      }

      if (!this._pausedForReword || !this._currentRewordCommit) {
        throw new Error('Not paused for reword');
      }

      const originalCommit = this._commits.get(this._currentRewordCommit.hash);
      if (!originalCommit) {
        throw new Error('Original commit not found');
      }

      // Create the rebased commit with the NEW message but SAME diff
      const newHash = this.generateHash();
      const newCommit: IMockCommit = {
        hash: newHash,
        message: newMessage, // New message provided by user
        changes: [...originalCommit.changes], // Same diff as original
        parents: originalCommit.parents,
        timestamp: this._nextTimestamp++,
      };
      this._rebasedCommits.set(newHash, newCommit);

      // Clear reword state and continue
      this._pausedForReword = false;
      this._currentRewordCommit = undefined;
      this._session.currentStep++;

      // Continue processing remaining commits
      return this.executeRebase();
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
    .array(rebaseCommitArb, { minLength: 1, maxLength: 10 })
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
   * Compare two diffs for equality
   */
  function diffsAreEqual(diff1: ICommitDiff[], diff2: ICommitDiff[]): boolean {
    if (diff1.length !== diff2.length) {
      return false;
    }

    const sortedDiff1 = [...diff1].sort((a, b) => a.path.localeCompare(b.path));
    const sortedDiff2 = [...diff2].sort((a, b) => a.path.localeCompare(b.path));

    for (let i = 0; i < sortedDiff1.length; i++) {
      const d1 = sortedDiff1[i];
      const d2 = sortedDiff2[i];
      if (d1.path !== d2.path) {
        return false;
      }
      if (d1.newContent !== d2.newContent) {
        return false;
      }
    }

    return true;
  }

  describe('Property 14: Rebase Reword Behavior', () => {
    /**
     * Property: Rebase pauses when encountering a commit marked for reword.
     */
    it('Property: Rebase pauses when encountering a commit marked for reword', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb,
          branchNameArb,
          commitHashArb,
          fileChangesArb,
          (commits, branchName, ontoHash, fileChanges): boolean => {
            // Setup: Create a rebase session
            const rebaseService = new MockRebaseService();

            // Add original commits to the repository
            for (const commit of commits) {
              rebaseService.addCommit(commit.hash, commit.message, fileChanges);
            }

            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);

            // Mark the first commit for reword
            rebaseService.updateRebasePlan([{ hash: commits[0].hash, action: 'reword' }]);

            // Act: Execute the rebase
            const result = rebaseService.executeRebase();

            // Assert: Rebase should pause
            assert.strictEqual(
              result.status,
              'paused',
              'Rebase should pause when encountering a reword commit'
            );
            assert.strictEqual(
              result.success,
              true,
              'Rebase pause should be a successful operation'
            );

            // Assert: Service should indicate it's paused for reword
            assert.strictEqual(
              rebaseService.isPausedForReword(),
              true,
              'Service should indicate it is paused for reword'
            );

            // Assert: The current reword commit should be set
            const currentRewordCommit = rebaseService.getCurrentRewordCommit();
            assert.ok(currentRewordCommit, 'Current reword commit should be set');
            assert.strictEqual(
              currentRewordCommit.hash,
              commits[0].hash,
              'Current reword commit should be the first commit'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Resulting commit has the new message after reword.
     */
    it('Property: Resulting commit has the new message after reword', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb,
          branchNameArb,
          commitHashArb,
          fileChangesArb,
          newMessageArb,
          (commits, branchName, ontoHash, fileChanges, newMessage): boolean => {
            // Setup
            const rebaseService = new MockRebaseService();

            for (const commit of commits) {
              rebaseService.addCommit(commit.hash, commit.message, fileChanges);
            }

            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);

            // Mark the first commit for reword
            rebaseService.updateRebasePlan([{ hash: commits[0].hash, action: 'reword' }]);

            // Execute rebase (will pause at reword)
            rebaseService.executeRebase();

            // Act: Provide the new message
            const result = rebaseService.provideRewordMessage(newMessage);

            // Assert: Rebase should complete (or continue to next commit)
            assert.ok(
              result.status === 'completed' ||
                result.status === 'in-progress' ||
                result.status === 'paused',
              'Rebase should continue after providing reword message'
            );

            // Assert: The rebased commit should have the new message
            const rebasedCommits = rebaseService.getRebasedCommits();
            assert.ok(rebasedCommits.length > 0, 'Should have at least one rebased commit');

            // Find the commit that was reworded (first one)
            const rewordedCommit = rebasedCommits[0];
            assert.strictEqual(
              rewordedCommit.message,
              newMessage,
              'Reworded commit should have the new message'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Resulting commit has the same diff after reword.
     */
    it('Property: Resulting commit has the same diff after reword', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb,
          branchNameArb,
          commitHashArb,
          fileChangesArb,
          newMessageArb,
          (commits, branchName, ontoHash, fileChanges, newMessage): boolean => {
            // Setup
            const rebaseService = new MockRebaseService();

            for (const commit of commits) {
              rebaseService.addCommit(commit.hash, commit.message, fileChanges);
            }

            // Get the original diff before rebase
            const originalDiff = rebaseService.getCommitDiff(commits[0].hash);

            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);

            // Mark the first commit for reword
            rebaseService.updateRebasePlan([{ hash: commits[0].hash, action: 'reword' }]);

            // Execute rebase (will pause at reword)
            rebaseService.executeRebase();

            // Provide the new message
            rebaseService.provideRewordMessage(newMessage);

            // Assert: The rebased commit should have the same diff
            const rebasedCommits = rebaseService.getRebasedCommits();
            assert.ok(rebasedCommits.length > 0, 'Should have at least one rebased commit');

            const rewordedCommit = rebasedCommits[0];
            const rebasedDiff = rebaseService.getCommitDiff(rewordedCommit.hash);

            assert.ok(
              diffsAreEqual(originalDiff, rebasedDiff),
              'Reworded commit should have the same diff as the original'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Multiple reword commits pause at each one in sequence.
     */
    it('Property: Multiple reword commits pause at each one in sequence', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb.filter((c) => c.length >= 2),
          branchNameArb,
          commitHashArb,
          fileChangesArb,
          newMessageArb,
          newMessageArb,
          (commits, branchName, ontoHash, fileChanges, newMessage1, newMessage2): boolean => {
            // Setup
            const rebaseService = new MockRebaseService();

            for (const commit of commits) {
              rebaseService.addCommit(commit.hash, commit.message, fileChanges);
            }

            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);

            // Mark first two commits for reword
            rebaseService.updateRebasePlan([
              { hash: commits[0].hash, action: 'reword' },
              { hash: commits[1].hash, action: 'reword' },
            ]);

            // Execute rebase - should pause at first reword
            let result = rebaseService.executeRebase();
            assert.strictEqual(result.status, 'paused', 'Should pause at first reword');

            let currentReword = rebaseService.getCurrentRewordCommit();
            assert.ok(currentReword, 'Should have current reword commit');
            assert.strictEqual(
              currentReword.hash,
              commits[0].hash,
              'Should be paused at first commit'
            );

            // Provide message for first reword - should pause at second
            result = rebaseService.provideRewordMessage(newMessage1);
            assert.strictEqual(result.status, 'paused', 'Should pause at second reword');

            currentReword = rebaseService.getCurrentRewordCommit();
            assert.ok(currentReword, 'Should have current reword commit');
            assert.strictEqual(
              currentReword.hash,
              commits[1].hash,
              'Should be paused at second commit'
            );

            // Provide message for second reword
            result = rebaseService.provideRewordMessage(newMessage2);

            // Verify both commits have correct messages
            const rebasedCommits = rebaseService.getRebasedCommits();
            assert.ok(rebasedCommits.length >= 2, 'Should have at least two rebased commits');

            assert.strictEqual(
              rebasedCommits[0].message,
              newMessage1,
              'First reworded commit should have first new message'
            );
            assert.strictEqual(
              rebasedCommits[1].message,
              newMessage2,
              'Second reworded commit should have second new message'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Reword preserves diff while changing message for any valid message.
     */
    it('Property: Reword preserves diff while changing message for any valid message', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb,
          branchNameArb,
          commitHashArb,
          fileChangesArb,
          fc.array(newMessageArb, { minLength: 1, maxLength: 5 }),
          (commits, branchName, ontoHash, fileChanges, newMessages): boolean => {
            // Test with various message types
            for (const newMessage of newMessages) {
              const rebaseService = new MockRebaseService();

              for (const commit of commits) {
                rebaseService.addCommit(commit.hash, commit.message, fileChanges);
              }

              const originalDiff = rebaseService.getCommitDiff(commits[0].hash);

              rebaseService.startInteractiveRebase(ontoHash, branchName, commits);
              rebaseService.updateRebasePlan([{ hash: commits[0].hash, action: 'reword' }]);

              rebaseService.executeRebase();
              rebaseService.provideRewordMessage(newMessage);

              const rebasedCommits = rebaseService.getRebasedCommits();
              const rewordedCommit = rebasedCommits[0];

              // Assert: Message changed
              assert.strictEqual(
                rewordedCommit.message,
                newMessage,
                'Message should be updated to new message'
              );

              // Assert: Diff preserved
              const rebasedDiff = rebaseService.getCommitDiff(rewordedCommit.hash);
              assert.ok(
                diffsAreEqual(originalDiff, rebasedDiff),
                'Diff should be preserved after reword'
              );
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Session status is 'paused' when waiting for reword message.
     */
    it('Property: Session status is paused when waiting for reword message', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb,
          branchNameArb,
          commitHashArb,
          fileChangesArb,
          (commits, branchName, ontoHash, fileChanges): boolean => {
            const rebaseService = new MockRebaseService();

            for (const commit of commits) {
              rebaseService.addCommit(commit.hash, commit.message, fileChanges);
            }

            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);
            rebaseService.updateRebasePlan([{ hash: commits[0].hash, action: 'reword' }]);

            // Execute rebase
            rebaseService.executeRebase();

            // Assert: Session status should be 'paused'
            const session = rebaseService.getRebaseSession();
            assert.ok(session, 'Session should exist');
            assert.strictEqual(
              session.status,
              'paused',
              'Session status should be paused when waiting for reword message'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Reword does not affect commits before or after the reworded commit.
     */
    it('Property: Reword does not affect other commits in the rebase', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb.filter((c) => c.length >= 3),
          branchNameArb,
          commitHashArb,
          fileChangesArb,
          newMessageArb,
          (commits, branchName, ontoHash, fileChanges, newMessage): boolean => {
            const rebaseService = new MockRebaseService();

            // Add commits with different file changes for each
            for (let i = 0; i < commits.length; i++) {
              const uniqueChanges = fileChanges.map((f) => ({
                path: `${i}_${f.path}`,
                content: `${i}_${f.content}`,
              }));
              rebaseService.addCommit(commits[i].hash, commits[i].message, uniqueChanges);
            }

            // Get original messages
            const originalMessages = commits.map((c) => c.message);

            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);

            // Only reword the middle commit
            const middleIndex = Math.floor(commits.length / 2);
            rebaseService.updateRebasePlan([{ hash: commits[middleIndex].hash, action: 'reword' }]);

            // Execute rebase until pause
            rebaseService.executeRebase();

            // Provide new message
            rebaseService.provideRewordMessage(newMessage);

            // Get rebased commits
            const rebasedCommits = rebaseService.getRebasedCommits();

            // Assert: Only the middle commit's message changed
            for (let i = 0; i < rebasedCommits.length; i++) {
              if (i === middleIndex) {
                assert.strictEqual(
                  rebasedCommits[i].message,
                  newMessage,
                  `Reworded commit at index ${i} should have new message`
                );
              } else {
                assert.strictEqual(
                  rebasedCommits[i].message,
                  originalMessages[i],
                  `Non-reworded commit at index ${i} should keep original message`
                );
              }
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
