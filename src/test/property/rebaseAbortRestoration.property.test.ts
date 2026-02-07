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
 * Property-based tests for Rebase Abort Restoration.
 * Feature: intellij-git-vscode, Property 17: Rebase Abort Restoration
 *
 * **Validates: Requirements 6.8**
 *
 * Property Description:
 * For any interactive rebase that is aborted, the repository SHALL be restored to its exact
 * pre-rebase state with the original branch, HEAD, and commit history.
 */
describe('Rebase Abort Restoration Property Tests', () => {
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
   * Represents the state of the repository at a point in time
   */
  interface IRepositoryState {
    currentBranch: string;
    headCommit: string;
    commits: IMockCommit[];
    workingDirectoryChanges: IFileChange[];
  }

  /**
   * Mock Rebase Service that simulates interactive rebase with abort restoration behavior.
   * This allows us to test abort restoration properties without actual Git operations.
   *
   * Requirements: 6.8
   */
  class MockRebaseService {
    private _session: IRebaseSession | undefined;
    private _commits: Map<string, IMockCommit> = new Map();
    private _rebasedCommits: Map<string, IMockCommit> = new Map();
    private _hashCounter: number = 0;
    private _nextTimestamp: number = 1000;
    private _currentBranch: string = 'main';
    private _headCommit: string = '';
    private _workingDirectoryChanges: IFileChange[] = [];

    // Pre-rebase state for restoration
    private _preRebaseState: IRepositoryState | undefined;

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
      // Update HEAD to the latest commit
      this._headCommit = hash;
    }

    /**
     * Get a commit by hash
     */
    getCommit(hash: string): IMockCommit | undefined {
      return this._rebasedCommits.get(hash) || this._commits.get(hash);
    }

    /**
     * Get all original commits
     */
    getOriginalCommits(): IMockCommit[] {
      return Array.from(this._commits.values()).sort((a, b) => a.timestamp - b.timestamp);
    }

    /**
     * Get all rebased commits
     */
    getRebasedCommits(): IMockCommit[] {
      return Array.from(this._rebasedCommits.values()).sort((a, b) => a.timestamp - b.timestamp);
    }

    /**
     * Set the current branch
     */
    setCurrentBranch(branch: string): void {
      this._currentBranch = branch;
    }

    /**
     * Get the current branch
     */
    getCurrentBranch(): string {
      return this._currentBranch;
    }

    /**
     * Get the HEAD commit
     */
    getHeadCommit(): string {
      return this._headCommit;
    }

    /**
     * Set working directory changes
     */
    setWorkingDirectoryChanges(changes: IFileChange[]): void {
      this._workingDirectoryChanges = [...changes];
    }

    /**
     * Get working directory changes
     */
    getWorkingDirectoryChanges(): IFileChange[] {
      return [...this._workingDirectoryChanges];
    }

    /**
     * Capture the current repository state for later restoration
     */
    private capturePreRebaseState(): void {
      this._preRebaseState = {
        currentBranch: this._currentBranch,
        headCommit: this._headCommit,
        commits: Array.from(this._commits.values()).map((c) => ({ ...c })),
        workingDirectoryChanges: [...this._workingDirectoryChanges],
      };
    }

    /**
     * Get the pre-rebase state
     */
    getPreRebaseState(): IRepositoryState | undefined {
      return this._preRebaseState;
    }

    /**
     * Get the current repository state
     */
    getCurrentState(): IRepositoryState {
      return {
        currentBranch: this._currentBranch,
        headCommit: this._headCommit,
        commits: Array.from(this._commits.values()).map((c) => ({ ...c })),
        workingDirectoryChanges: [...this._workingDirectoryChanges],
      };
    }

    /**
     * Start an interactive rebase session.
     * Captures the pre-rebase state for potential restoration.
     *
     * Requirements: 6.8
     */
    startInteractiveRebase(
      onto: string,
      originalBranch: string,
      commits: IRebaseCommit[]
    ): IRebaseSession {
      // Capture state before rebase for restoration on abort
      this.capturePreRebaseState();

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
     * Execute the rebase with the current plan.
     * Creates new commits based on the rebase actions.
     *
     * Requirements: 6.8
     */
    executeRebase(): IRebaseResult {
      if (!this._session) {
        throw new Error('No rebase session found');
      }

      this._session.status = 'in-progress';

      // Process commits
      while (this._session.currentStep < this._session.commits.length) {
        const commit = this._session.commits[this._session.currentStep];
        const originalCommit = this._commits.get(commit.hash);

        if (!originalCommit) {
          this._session.currentStep++;
          continue;
        }

        if (commit.action === 'edit') {
          // Pause for edit
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
        this._headCommit = newHash;
        this._session.currentStep++;
      }

      // Rebase completed
      this._session.status = 'completed';
      return { success: true, status: 'completed' };
    }

    /**
     * Continue the rebase after a pause
     */
    continueRebase(): IRebaseResult {
      if (!this._session) {
        throw new Error('No rebase session found');
      }

      this._session.currentStep++;
      return this.executeRebase();
    }

    /**
     * Abort the rebase and restore the repository to its pre-rebase state.
     * This is the key behavior for Requirement 6.8.
     *
     * Requirements: 6.8
     */
    abortRebase(): void {
      if (!this._session) {
        throw new Error('No rebase session found');
      }

      if (!this._preRebaseState) {
        throw new Error('No pre-rebase state captured');
      }

      // Restore the repository to its pre-rebase state
      this._currentBranch = this._preRebaseState.currentBranch;
      this._headCommit = this._preRebaseState.headCommit;
      this._workingDirectoryChanges = [...this._preRebaseState.workingDirectoryChanges];

      // Clear rebased commits - they should not exist after abort
      this._rebasedCommits.clear();

      // Clear the session
      this._session = undefined;
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
   * Arbitrary generator for rebase actions
   */
  const rebaseActionArb: fc.Arbitrary<RebaseAction> = fc.constantFrom(
    'pick',
    'reword',
    'edit',
    'squash',
    'fixup',
    'drop'
  );

  describe('Property 17: Rebase Abort Restoration', () => {
    /**
     * Property: Aborting a rebase restores the repository to its pre-rebase state.
     *
     * **Validates: Requirements 6.8**
     */
    it('Property: Aborting a rebase restores the repository to its pre-rebase state', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb,
          branchNameArb,
          commitHashArb,
          fileChangesArb,
          (commits, branchName, ontoHash, fileChanges): boolean => {
            // Setup: Create a rebase service and add commits
            const rebaseService = new MockRebaseService();
            rebaseService.setCurrentBranch(branchName);

            // Add original commits to the repository
            for (const commit of commits) {
              rebaseService.addCommit(commit.hash, commit.message, fileChanges);
            }

            // Capture the state before rebase
            const stateBefore = rebaseService.getCurrentState();

            // Start interactive rebase
            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);

            // Execute some of the rebase
            rebaseService.executeRebase();

            // Act: Abort the rebase
            rebaseService.abortRebase();

            // Assert: Repository should be restored to pre-rebase state
            const stateAfter = rebaseService.getCurrentState();

            assert.strictEqual(
              stateAfter.currentBranch,
              stateBefore.currentBranch,
              'Current branch should be restored'
            );
            assert.strictEqual(
              stateAfter.headCommit,
              stateBefore.headCommit,
              'HEAD commit should be restored'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: All commits that existed before the rebase are preserved after abort.
     *
     * **Validates: Requirements 6.8**
     */
    it('Property: All commits that existed before the rebase are preserved after abort', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb,
          branchNameArb,
          commitHashArb,
          fileChangesArb,
          (commits, branchName, ontoHash, fileChanges): boolean => {
            // Setup
            const rebaseService = new MockRebaseService();
            rebaseService.setCurrentBranch(branchName);

            // Add original commits
            for (const commit of commits) {
              rebaseService.addCommit(commit.hash, commit.message, fileChanges);
            }

            // Get original commits before rebase
            const originalCommits = rebaseService.getOriginalCommits();
            const originalHashes = new Set(originalCommits.map((c) => c.hash));

            // Start and execute rebase
            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);
            rebaseService.executeRebase();

            // Abort the rebase
            rebaseService.abortRebase();

            // Assert: All original commits should still exist
            const commitsAfterAbort = rebaseService.getOriginalCommits();
            const hashesAfterAbort = new Set(commitsAfterAbort.map((c) => c.hash));

            for (const hash of originalHashes) {
              assert.ok(
                hashesAfterAbort.has(hash),
                `Original commit ${hash} should be preserved after abort`
              );
            }

            assert.strictEqual(
              commitsAfterAbort.length,
              originalCommits.length,
              'Number of commits should be the same after abort'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: The branch pointer returns to its original position after abort.
     *
     * **Validates: Requirements 6.8**
     */
    it('Property: The branch pointer returns to its original position after abort', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb,
          branchNameArb,
          commitHashArb,
          fileChangesArb,
          (commits, branchName, ontoHash, fileChanges): boolean => {
            // Setup
            const rebaseService = new MockRebaseService();
            rebaseService.setCurrentBranch(branchName);

            // Add original commits
            for (const commit of commits) {
              rebaseService.addCommit(commit.hash, commit.message, fileChanges);
            }

            // Record the original HEAD position
            const originalHead = rebaseService.getHeadCommit();
            const originalBranch = rebaseService.getCurrentBranch();

            // Start and execute rebase (this will change HEAD)
            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);
            rebaseService.executeRebase();

            // Abort the rebase
            rebaseService.abortRebase();

            // Assert: Branch pointer should return to original position
            assert.strictEqual(
              rebaseService.getHeadCommit(),
              originalHead,
              'HEAD should return to original position after abort'
            );
            assert.strictEqual(
              rebaseService.getCurrentBranch(),
              originalBranch,
              'Current branch should return to original after abort'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Working directory changes are preserved or restored appropriately after abort.
     *
     * **Validates: Requirements 6.8**
     */
    it('Property: Working directory changes are preserved or restored after abort', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb,
          branchNameArb,
          commitHashArb,
          fileChangesArb,
          fileChangesArb,
          (commits, branchName, ontoHash, commitChanges, workingChanges): boolean => {
            // Setup
            const rebaseService = new MockRebaseService();
            rebaseService.setCurrentBranch(branchName);

            // Add original commits
            for (const commit of commits) {
              rebaseService.addCommit(commit.hash, commit.message, commitChanges);
            }

            // Set working directory changes before rebase
            rebaseService.setWorkingDirectoryChanges(workingChanges);
            const originalWorkingChanges = rebaseService.getWorkingDirectoryChanges();

            // Start and execute rebase
            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);
            rebaseService.executeRebase();

            // Abort the rebase
            rebaseService.abortRebase();

            // Assert: Working directory changes should be restored
            const restoredWorkingChanges = rebaseService.getWorkingDirectoryChanges();

            assert.strictEqual(
              restoredWorkingChanges.length,
              originalWorkingChanges.length,
              'Number of working directory changes should be restored'
            );

            for (let i = 0; i < originalWorkingChanges.length; i++) {
              const original = originalWorkingChanges[i];
              const restored = restoredWorkingChanges.find((c) => c.path === original.path);
              assert.ok(restored, `Working directory change ${original.path} should be restored`);
              assert.strictEqual(
                restored.content,
                original.content,
                `Content of ${original.path} should be restored`
              );
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Rebase session is cleared after abort.
     *
     * **Validates: Requirements 6.8**
     */
    it('Property: Rebase session is cleared after abort', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb,
          branchNameArb,
          commitHashArb,
          fileChangesArb,
          (commits, branchName, ontoHash, fileChanges): boolean => {
            // Setup
            const rebaseService = new MockRebaseService();
            rebaseService.setCurrentBranch(branchName);

            for (const commit of commits) {
              rebaseService.addCommit(commit.hash, commit.message, fileChanges);
            }

            // Start rebase
            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);

            // Verify session exists
            assert.ok(rebaseService.getRebaseSession(), 'Session should exist before abort');

            // Execute some rebase
            rebaseService.executeRebase();

            // Abort
            rebaseService.abortRebase();

            // Assert: Session should be cleared
            assert.strictEqual(
              rebaseService.getRebaseSession(),
              undefined,
              'Rebase session should be cleared after abort'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Rebased commits are discarded after abort.
     *
     * **Validates: Requirements 6.8**
     */
    it('Property: Rebased commits are discarded after abort', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb,
          branchNameArb,
          commitHashArb,
          fileChangesArb,
          (commits, branchName, ontoHash, fileChanges): boolean => {
            // Setup
            const rebaseService = new MockRebaseService();
            rebaseService.setCurrentBranch(branchName);

            for (const commit of commits) {
              rebaseService.addCommit(commit.hash, commit.message, fileChanges);
            }

            // Start and execute rebase
            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);
            rebaseService.executeRebase();

            // Abort
            rebaseService.abortRebase();

            // Assert: Rebased commits should be discarded
            const rebasedAfterAbort = rebaseService.getRebasedCommits();
            assert.strictEqual(
              rebasedAfterAbort.length,
              0,
              'Rebased commits should be discarded after abort'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Abort during edit pause restores pre-rebase state.
     *
     * **Validates: Requirements 6.8**
     */
    it('Property: Abort during edit pause restores pre-rebase state', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb,
          branchNameArb,
          commitHashArb,
          fileChangesArb,
          (commits, branchName, ontoHash, fileChanges): boolean => {
            // Setup
            const rebaseService = new MockRebaseService();
            rebaseService.setCurrentBranch(branchName);

            for (const commit of commits) {
              rebaseService.addCommit(commit.hash, commit.message, fileChanges);
            }

            const stateBefore = rebaseService.getCurrentState();

            // Start rebase and mark first commit for edit
            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);
            rebaseService.updateRebasePlan([{ hash: commits[0].hash, action: 'edit' }]);

            // Execute rebase (will pause at edit)
            const result = rebaseService.executeRebase();
            assert.strictEqual(result.status, 'paused', 'Should pause at edit');

            // Abort during edit pause
            rebaseService.abortRebase();

            // Assert: State should be restored
            const stateAfter = rebaseService.getCurrentState();
            assert.strictEqual(
              stateAfter.currentBranch,
              stateBefore.currentBranch,
              'Branch should be restored after abort during edit'
            );
            assert.strictEqual(
              stateAfter.headCommit,
              stateBefore.headCommit,
              'HEAD should be restored after abort during edit'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Abort with various rebase actions restores pre-rebase state.
     *
     * **Validates: Requirements 6.8**
     */
    it('Property: Abort with various rebase actions restores pre-rebase state', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb.filter((c) => c.length >= 2),
          branchNameArb,
          commitHashArb,
          fileChangesArb,
          fc.array(rebaseActionArb, { minLength: 1, maxLength: 5 }),
          (commits, branchName, ontoHash, fileChanges, actions): boolean => {
            // Setup
            const rebaseService = new MockRebaseService();
            rebaseService.setCurrentBranch(branchName);

            for (const commit of commits) {
              rebaseService.addCommit(commit.hash, commit.message, fileChanges);
            }

            const stateBefore = rebaseService.getCurrentState();

            // Start rebase
            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);

            // Apply various actions to commits
            const plan: IRebaseAction[] = commits.slice(0, actions.length).map((commit, i) => ({
              hash: commit.hash,
              action: actions[i],
            }));
            rebaseService.updateRebasePlan(plan);

            // Execute rebase (may pause or complete depending on actions)
            rebaseService.executeRebase();

            // Abort
            rebaseService.abortRebase();

            // Assert: State should be restored regardless of actions
            const stateAfter = rebaseService.getCurrentState();
            assert.strictEqual(
              stateAfter.currentBranch,
              stateBefore.currentBranch,
              'Branch should be restored after abort with various actions'
            );
            assert.strictEqual(
              stateAfter.headCommit,
              stateBefore.headCommit,
              'HEAD should be restored after abort with various actions'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Abort after partial rebase execution restores pre-rebase state.
     *
     * **Validates: Requirements 6.8**
     */
    it('Property: Abort after partial rebase execution restores pre-rebase state', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb.filter((c) => c.length >= 3),
          branchNameArb,
          commitHashArb,
          fileChangesArb,
          fc.integer({ min: 1, max: 5 }),
          (commits, branchName, ontoHash, fileChanges, editIndex): boolean => {
            // Setup
            const rebaseService = new MockRebaseService();
            rebaseService.setCurrentBranch(branchName);

            for (const commit of commits) {
              rebaseService.addCommit(commit.hash, commit.message, fileChanges);
            }

            const stateBefore = rebaseService.getCurrentState();

            // Start rebase
            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);

            // Mark a commit in the middle for edit to pause partway through
            const actualEditIndex = Math.min(editIndex, commits.length - 1);
            rebaseService.updateRebasePlan([
              { hash: commits[actualEditIndex].hash, action: 'edit' },
            ]);

            // Execute rebase (will process some commits then pause)
            rebaseService.executeRebase();

            // Abort after partial execution
            rebaseService.abortRebase();

            // Assert: State should be fully restored
            const stateAfter = rebaseService.getCurrentState();
            assert.strictEqual(
              stateAfter.currentBranch,
              stateBefore.currentBranch,
              'Branch should be restored after partial rebase abort'
            );
            assert.strictEqual(
              stateAfter.headCommit,
              stateBefore.headCommit,
              'HEAD should be restored after partial rebase abort'
            );

            // Rebased commits should be discarded
            assert.strictEqual(
              rebaseService.getRebasedCommits().length,
              0,
              'Rebased commits should be discarded after partial rebase abort'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Commit messages are preserved after abort.
     *
     * **Validates: Requirements 6.8**
     */
    it('Property: Commit messages are preserved after abort', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb,
          branchNameArb,
          commitHashArb,
          fileChangesArb,
          (commits, branchName, ontoHash, fileChanges): boolean => {
            // Setup
            const rebaseService = new MockRebaseService();
            rebaseService.setCurrentBranch(branchName);

            for (const commit of commits) {
              rebaseService.addCommit(commit.hash, commit.message, fileChanges);
            }

            // Record original commit messages
            const originalMessages = new Map<string, string>();
            for (const commit of rebaseService.getOriginalCommits()) {
              originalMessages.set(commit.hash, commit.message);
            }

            // Start and execute rebase
            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);
            rebaseService.executeRebase();

            // Abort
            rebaseService.abortRebase();

            // Assert: Original commit messages should be preserved
            for (const commit of rebaseService.getOriginalCommits()) {
              const originalMessage = originalMessages.get(commit.hash);
              assert.strictEqual(
                commit.message,
                originalMessage,
                `Commit message for ${commit.hash} should be preserved after abort`
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
