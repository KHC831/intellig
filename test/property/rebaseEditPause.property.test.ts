import * as fc from 'fast-check';
import * as assert from 'assert';
import {
  RebaseAction,
  IRebaseCommit,
  IRebaseSession,
  IRebaseAction,
  IRebaseResult,
} from '../../src/git-core/interfaces/IRebaseService';

/**
 * Property-based tests for Rebase Edit Pause.
 * Feature: intellig-vscode, Property 15: Rebase Edit Pause
 *
 *
 * Property Description:
 * For any commit marked for edit in interactive rebase, the rebase SHALL pause at that commit
 * with the repository in a state allowing amendments.
 */
describe('Rebase Edit Pause Property Tests', () => {
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
   * Mock Rebase Service that simulates interactive rebase with edit pause behavior.
   * This allows us to test edit pause properties without actual Git operations.
   */
  class MockRebaseService {
    private _session: IRebaseSession | undefined;
    private _commits: Map<string, IMockCommit> = new Map();
    private _rebasedCommits: Map<string, IMockCommit> = new Map();
    private _hashCounter: number = 0;
    private _nextTimestamp: number = 1000;
    private _pausedForEdit: boolean = false;
    private _currentEditCommit: IRebaseCommit | undefined;
    private _amendAllowed: boolean = false;
    private _workingDirectoryChanges: IFileChange[] = [];

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
      this._pausedForEdit = false;
      this._currentEditCommit = undefined;
      this._amendAllowed = false;
      this._workingDirectoryChanges = [];
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
     * Check if the rebase is paused for edit
     */
    isPausedForEdit(): boolean {
      return this._pausedForEdit;
    }

    /**
     * Get the commit currently paused for edit
     */
    getCurrentEditCommit(): IRebaseCommit | undefined {
      return this._currentEditCommit;
    }

    /**
     * Check if amendments are allowed (repository is in a state allowing amendments)
     */
    isAmendAllowed(): boolean {
      return this._amendAllowed;
    }

    /**
     * Get the current working directory changes
     */
    getWorkingDirectoryChanges(): IFileChange[] {
      return this._workingDirectoryChanges;
    }

    /**
     * Execute the rebase with the current plan.
     * When a commit is marked for edit, the rebase SHALL pause at that commit
     * with the repository in a state allowing amendments.
     */
    executeRebase(): IRebaseResult {
      if (!this._session) {
        throw new Error('No rebase session found');
      }

      this._session.status = 'in-progress';

      // Process commits until we hit an edit or complete
      while (this._session.currentStep < this._session.commits.length) {
        const commit = this._session.commits[this._session.currentStep];
        const originalCommit = this._commits.get(commit.hash);

        if (!originalCommit) {
          this._session.currentStep++;
          continue;
        }

        if (commit.action === 'edit') {
          // Pause for edit - the repository should be in a state allowing amendments
          // The repository should be in a state allowing amendments
          this._pausedForEdit = true;
          this._currentEditCommit = commit;
          this._amendAllowed = true;
          // Set working directory to the commit's changes (simulating the edit pause state)
          this._workingDirectoryChanges = [...originalCommit.changes];
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
     * Add changes to the working directory during an edit pause.
     * This simulates making manual changes while paused for edit.
     */
    addWorkingDirectoryChange(change: IFileChange): void {
      if (!this._pausedForEdit || !this._amendAllowed) {
        throw new Error('Cannot add changes - not paused for edit');
      }
      this._workingDirectoryChanges.push(change);
    }

    /**
     * Modify an existing file in the working directory during an edit pause.
     */
    modifyWorkingDirectoryFile(path: string, newContent: string): void {
      if (!this._pausedForEdit || !this._amendAllowed) {
        throw new Error('Cannot modify files - not paused for edit');
      }
      const existingIndex = this._workingDirectoryChanges.findIndex((c) => c.path === path);
      if (existingIndex >= 0) {
        this._workingDirectoryChanges[existingIndex].content = newContent;
      } else {
        this._workingDirectoryChanges.push({ path, content: newContent });
      }
    }

    /**
     * Amend the current commit during an edit pause.
     * This should be called when the rebase is paused for edit.
     * The amended commit will include any working directory changes.
     */
    amendEditCommit(message?: string): IRebaseResult {
      if (!this._session) {
        throw new Error('No rebase session found');
      }

      if (!this._pausedForEdit || !this._currentEditCommit) {
        throw new Error('Not paused for edit');
      }

      if (!this._amendAllowed) {
        throw new Error('Amendments not allowed in current state');
      }

      const originalCommit = this._commits.get(this._currentEditCommit.hash);
      if (!originalCommit) {
        throw new Error('Original commit not found');
      }

      // Create the amended commit with working directory changes
      const newHash = this.generateHash();
      const newCommit: IMockCommit = {
        hash: newHash,
        message: message || originalCommit.message,
        changes: [...this._workingDirectoryChanges], // Include all working directory changes
        parents: originalCommit.parents,
        timestamp: this._nextTimestamp++,
      };
      this._rebasedCommits.set(newHash, newCommit);

      // Amend succeeded, still paused for further edits
      return { success: true, status: 'paused' };
    }

    /**
     * Continue the rebase after an edit pause.
     * This finalizes the edit and continues to the next commit.
     */
    continueRebase(): IRebaseResult {
      if (!this._session) {
        throw new Error('No rebase session found');
      }

      if (this._pausedForEdit && this._currentEditCommit) {
        // If we haven't amended yet, create the commit with current working directory state
        const originalCommit = this._commits.get(this._currentEditCommit.hash);
        if (originalCommit) {
          const existingRebased = Array.from(this._rebasedCommits.values()).find(
            (c) => c.timestamp > originalCommit.timestamp
          );
          if (!existingRebased) {
            // No amend was done, create commit with current state
            const newHash = this.generateHash();
            const newCommit: IMockCommit = {
              hash: newHash,
              message: originalCommit.message,
              changes: [...this._workingDirectoryChanges],
              parents: originalCommit.parents,
              timestamp: this._nextTimestamp++,
            };
            this._rebasedCommits.set(newHash, newCommit);
          }
        }
      }

      // Clear edit state and continue
      this._pausedForEdit = false;
      this._currentEditCommit = undefined;
      this._amendAllowed = false;
      this._workingDirectoryChanges = [];
      this._session.currentStep++;

      // Continue processing remaining commits
      return this.executeRebase();
    }

    /**
     * Get all rebased commits
     */
    getRebasedCommits(): IMockCommit[] {
      return Array.from(this._rebasedCommits.values()).sort((a, b) => a.timestamp - b.timestamp);
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

  describe('Property 15: Rebase Edit Pause', () => {
    /**
     * Property: Rebase pauses when encountering a commit marked for edit.
     */
    it('Property: Rebase pauses when encountering a commit marked for edit', () => {
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

            // Mark the first commit for edit
            rebaseService.updateRebasePlan([{ hash: commits[0].hash, action: 'edit' }]);

            // Act: Execute the rebase
            const result = rebaseService.executeRebase();

            // Assert: Rebase should pause
            assert.strictEqual(
              result.status,
              'paused',
              'Rebase should pause when encountering an edit commit'
            );
            assert.strictEqual(
              result.success,
              true,
              'Rebase pause should be a successful operation'
            );

            // Assert: Service should indicate it's paused for edit
            assert.strictEqual(
              rebaseService.isPausedForEdit(),
              true,
              'Service should indicate it is paused for edit'
            );

            // Assert: The current edit commit should be set
            const currentEditCommit = rebaseService.getCurrentEditCommit();
            assert.ok(currentEditCommit, 'Current edit commit should be set');
            assert.strictEqual(
              currentEditCommit.hash,
              commits[0].hash,
              'Current edit commit should be the first commit'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Repository is in a state allowing amendments when paused for edit.
     */
    it('Property: Repository is in a state allowing amendments when paused for edit', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb,
          branchNameArb,
          commitHashArb,
          fileChangesArb,
          (commits, branchName, ontoHash, fileChanges): boolean => {
            // Setup
            const rebaseService = new MockRebaseService();

            for (const commit of commits) {
              rebaseService.addCommit(commit.hash, commit.message, fileChanges);
            }

            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);

            // Mark the first commit for edit
            rebaseService.updateRebasePlan([{ hash: commits[0].hash, action: 'edit' }]);

            // Execute rebase (will pause at edit)
            rebaseService.executeRebase();

            // Assert: Amendments should be allowed
            assert.strictEqual(
              rebaseService.isAmendAllowed(),
              true,
              'Amendments should be allowed when paused for edit'
            );

            // Assert: Working directory should contain the commit's changes
            const workingChanges = rebaseService.getWorkingDirectoryChanges();
            assert.ok(
              workingChanges.length > 0,
              'Working directory should contain the commit changes'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Manual changes can be made during edit pause.
     */
    it('Property: Manual changes can be made during edit pause', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb,
          branchNameArb,
          commitHashArb,
          fileChangesArb,
          fileNameArb,
          fileContentArb,
          (commits, branchName, ontoHash, fileChanges, newFileName, newContent): boolean => {
            // Setup
            const rebaseService = new MockRebaseService();

            for (const commit of commits) {
              rebaseService.addCommit(commit.hash, commit.message, fileChanges);
            }

            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);
            rebaseService.updateRebasePlan([{ hash: commits[0].hash, action: 'edit' }]);

            // Execute rebase (will pause at edit)
            rebaseService.executeRebase();

            // Act: Add a new file during edit pause
            const newChange: IFileChange = { path: newFileName, content: newContent };
            rebaseService.addWorkingDirectoryChange(newChange);

            // Assert: The new change should be in the working directory.
            // Search from the tail so a shrinker-generated collision between
            // `newFileName` and a path already seeded in the commit's setup
            // fileChanges (which the mock keeps by reference in the working
            // directory on pause) picks up the append we just made rather
            // than the stale seed entry. Equivalent to `.findLast`, written
            // as a manual reverse loop because the project targets ES2022
            // and `Array.prototype.findLast` is an ES2023 addition.
            const workingChanges = rebaseService.getWorkingDirectoryChanges();
            let addedChange: IFileChange | undefined;
            for (let i = workingChanges.length - 1; i >= 0; i--) {
              if (workingChanges[i].path === newFileName) {
                addedChange = workingChanges[i];
                break;
              }
            }
            assert.ok(addedChange, 'New change should be in working directory');
            assert.strictEqual(
              addedChange.content,
              newContent,
              'New change should have correct content'
            );

            return true;
          }
        ),
        // Include a stable replay seed for the case that shrank to a
        // (newFileName, pre-existing-file) collision. Keeping
        // it here guards against regressions if the mock's aliasing
        // behaviour is revisited.
        { numRuns: 100, seed: -214908735 }
      );
    });

    /**
     * Property: Amend during edit pause includes working directory changes.
     */
    it('Property: Amend during edit pause includes working directory changes', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb,
          branchNameArb,
          commitHashArb,
          fileChangesArb,
          fileNameArb,
          fileContentArb,
          commitMessageArb,
          (
            commits,
            branchName,
            ontoHash,
            fileChanges,
            newFileName,
            newContent,
            newMessage
          ): boolean => {
            // Setup
            const rebaseService = new MockRebaseService();

            for (const commit of commits) {
              rebaseService.addCommit(commit.hash, commit.message, fileChanges);
            }

            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);
            rebaseService.updateRebasePlan([{ hash: commits[0].hash, action: 'edit' }]);

            // Execute rebase (will pause at edit)
            rebaseService.executeRebase();

            // Add a new file during edit pause
            const newChange: IFileChange = { path: newFileName, content: newContent };
            rebaseService.addWorkingDirectoryChange(newChange);

            // Act: Amend the commit with a new message
            const result = rebaseService.amendEditCommit(newMessage);

            // Assert: Amend should succeed
            assert.strictEqual(result.success, true, 'Amend should succeed');
            assert.strictEqual(result.status, 'paused', 'Should still be paused after amend');

            // Assert: The amended commit should include the new change
            const lastCommit = rebaseService.getLastRebasedCommit();
            assert.ok(lastCommit, 'Should have a rebased commit');
            assert.strictEqual(lastCommit.message, newMessage, 'Commit should have new message');

            const hasNewChange = lastCommit.changes.some(
              (c) => c.path === newFileName && c.content === newContent
            );
            assert.ok(hasNewChange, 'Amended commit should include the new change');

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Session status is 'paused' when stopped for edit.
     */
    it('Property: Session status is paused when stopped for edit', () => {
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
            rebaseService.updateRebasePlan([{ hash: commits[0].hash, action: 'edit' }]);

            // Execute rebase
            rebaseService.executeRebase();

            // Assert: Session status should be 'paused'
            const session = rebaseService.getRebaseSession();
            assert.ok(session, 'Session should exist');
            assert.strictEqual(
              session.status,
              'paused',
              'Session status should be paused when stopped for edit'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Multiple edit commits pause at each one in sequence.
     */
    it('Property: Multiple edit commits pause at each one in sequence', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb.filter((c) => c.length >= 2),
          branchNameArb,
          commitHashArb,
          fileChangesArb,
          (commits, branchName, ontoHash, fileChanges): boolean => {
            // Setup
            const rebaseService = new MockRebaseService();

            for (const commit of commits) {
              rebaseService.addCommit(commit.hash, commit.message, fileChanges);
            }

            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);

            // Mark first two commits for edit
            rebaseService.updateRebasePlan([
              { hash: commits[0].hash, action: 'edit' },
              { hash: commits[1].hash, action: 'edit' },
            ]);

            // Execute rebase - should pause at first edit
            let result = rebaseService.executeRebase();
            assert.strictEqual(result.status, 'paused', 'Should pause at first edit');

            let currentEdit = rebaseService.getCurrentEditCommit();
            assert.ok(currentEdit, 'Should have current edit commit');
            assert.strictEqual(
              currentEdit.hash,
              commits[0].hash,
              'Should be paused at first commit'
            );

            // Continue rebase - should pause at second edit
            result = rebaseService.continueRebase();
            assert.strictEqual(result.status, 'paused', 'Should pause at second edit');

            currentEdit = rebaseService.getCurrentEditCommit();
            assert.ok(currentEdit, 'Should have current edit commit');
            assert.strictEqual(
              currentEdit.hash,
              commits[1].hash,
              'Should be paused at second commit'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Continue after edit pause proceeds to next commit.
     */
    it('Property: Continue after edit pause proceeds to next commit', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb.filter((c) => c.length >= 2),
          branchNameArb,
          commitHashArb,
          fileChangesArb,
          (commits, branchName, ontoHash, fileChanges): boolean => {
            // Setup
            const rebaseService = new MockRebaseService();

            for (const commit of commits) {
              rebaseService.addCommit(commit.hash, commit.message, fileChanges);
            }

            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);

            // Mark only the first commit for edit
            rebaseService.updateRebasePlan([{ hash: commits[0].hash, action: 'edit' }]);

            // Execute rebase - should pause at first edit
            rebaseService.executeRebase();

            // Get session before continue
            const sessionBefore = rebaseService.getRebaseSession();
            const stepBefore = sessionBefore?.currentStep || 0;

            // Continue rebase
            const result = rebaseService.continueRebase();

            // Assert: Should have progressed
            const sessionAfter = rebaseService.getRebaseSession();
            if (sessionAfter && result.status !== 'completed') {
              assert.ok(
                sessionAfter.currentStep > stepBefore,
                'Current step should have advanced after continue'
              );
            }

            // Assert: Should no longer be paused for edit
            assert.strictEqual(
              rebaseService.isPausedForEdit(),
              result.status === 'paused',
              'Should only be paused for edit if another edit commit is encountered'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Edit pause allows modifying existing files.
     */
    it('Property: Edit pause allows modifying existing files', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb,
          branchNameArb,
          commitHashArb,
          fileChangesArb,
          fileContentArb,
          (commits, branchName, ontoHash, fileChanges, newContent): boolean => {
            // Setup
            const rebaseService = new MockRebaseService();

            for (const commit of commits) {
              rebaseService.addCommit(commit.hash, commit.message, fileChanges);
            }

            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);
            rebaseService.updateRebasePlan([{ hash: commits[0].hash, action: 'edit' }]);

            // Execute rebase (will pause at edit)
            rebaseService.executeRebase();

            // Get an existing file from the working directory
            const workingChanges = rebaseService.getWorkingDirectoryChanges();
            if (workingChanges.length === 0) {
              return true; // Skip if no files
            }

            const existingFile = workingChanges[0];

            // Act: Modify the existing file
            rebaseService.modifyWorkingDirectoryFile(existingFile.path, newContent);

            // Assert: The file should have the new content
            const updatedChanges = rebaseService.getWorkingDirectoryChanges();
            const modifiedFile = updatedChanges.find((c) => c.path === existingFile.path);
            assert.ok(modifiedFile, 'Modified file should exist');
            assert.strictEqual(modifiedFile.content, newContent, 'File should have new content');

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Edit does not affect commits before or after the edited commit.
     */
    it('Property: Edit does not affect other commits in the rebase', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb.filter((c) => c.length >= 3),
          branchNameArb,
          commitHashArb,
          fileChangesArb,
          fileNameArb,
          fileContentArb,
          (commits, branchName, ontoHash, fileChanges, newFileName, newContent): boolean => {
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

            // Only edit the middle commit
            const middleIndex = Math.floor(commits.length / 2);
            rebaseService.updateRebasePlan([{ hash: commits[middleIndex].hash, action: 'edit' }]);

            // Execute rebase until pause
            rebaseService.executeRebase();

            // Add a new file during edit
            rebaseService.addWorkingDirectoryChange({ path: newFileName, content: newContent });

            // Amend and continue
            rebaseService.amendEditCommit();
            rebaseService.continueRebase();

            // Get rebased commits
            const rebasedCommits = rebaseService.getRebasedCommits();

            // Assert: Only the middle commit should have the new file
            for (let i = 0; i < rebasedCommits.length; i++) {
              const hasNewFile = rebasedCommits[i].changes.some((c) => c.path === newFileName);
              if (i === middleIndex) {
                assert.ok(hasNewFile, `Edited commit at index ${i} should have the new file`);
              } else {
                assert.ok(
                  !hasNewFile,
                  `Non-edited commit at index ${i} should not have the new file`
                );
              }

              // Messages should be preserved
              assert.strictEqual(
                rebasedCommits[i].message,
                originalMessages[i],
                `Commit at index ${i} should keep original message`
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
