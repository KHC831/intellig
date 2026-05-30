import * as fc from 'fast-check';
import * as assert from 'assert';
import {
  ICommit,
  IAuthor,
  IDiff,
  IHunk,
  IDiffLine,
  ICherryPickResult,
  IFileStatus,
  StatusCode,
} from '../../git-core/interfaces/IGitService';

/**
 * Property-based tests for Cherry-Pick Abort Restoration.
 * Feature: intellig-vscode, Property 37: Cherry-Pick Abort Restoration
 *
 *
 * Property Description:
 * For any cherry-pick operation that is aborted, the working directory and
 * branch SHALL be restored to their pre-cherry-pick state.
 *
 * - 11.4: WHEN a user aborts a cherry-pick, THE Extension SHALL restore the
 *         working directory to its pre-cherry-pick state
 */
describe('Cherry-Pick Abort Restoration Property Tests', () => {
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
   * Arbitrary generator for short commit hashes (7 character hex strings).
   */
  const shortHashArb: fc.Arbitrary<string> = fc.stringOf(
    fc.constantFrom(...'0123456789abcdef'.split('')),
    {
      minLength: 7,
      maxLength: 7,
    }
  );

  /**
   * Arbitrary generator for author information.
   */
  const authorArb: fc.Arbitrary<IAuthor> = fc.record({
    name: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
    email: fc.emailAddress(),
  });

  /**
   * Arbitrary generator for commit messages.
   */
  const commitMessageArb: fc.Arbitrary<string> = fc
    .string({ minLength: 1, maxLength: 200 })
    .filter((s) => s.trim().length > 0);

  /**
   * Arbitrary generator for file paths.
   */
  const filePathArb: fc.Arbitrary<string> = fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_./'.split('')
      ),
      { minLength: 1, maxLength: 50 }
    )
    .filter((s) => {
      if (s.length === 0) {
        return false;
      }
      if (s.startsWith('/') || s.startsWith('.')) {
        return false;
      }
      if (s.includes('//') || s.includes('..')) {
        return false;
      }
      return true;
    });

  /**
   * Arbitrary generator for diff line content.
   */
  const lineContentArb: fc.Arbitrary<string> = fc
    .string({ minLength: 0, maxLength: 100 })
    .map((s) => s.replace(/[\r\n]/g, ''));

  /**
   * Arbitrary generator for diff lines.
   */
  const diffLineArb: fc.Arbitrary<IDiffLine> = fc.oneof(
    fc.record({
      type: fc.constant('context' as const),
      content: lineContentArb,
      oldLineNumber: fc.integer({ min: 1, max: 1000 }),
      newLineNumber: fc.integer({ min: 1, max: 1000 }),
    }),
    fc.record({
      type: fc.constant('add' as const),
      content: lineContentArb,
      oldLineNumber: fc.constant(undefined),
      newLineNumber: fc.integer({ min: 1, max: 1000 }),
    }),
    fc.record({
      type: fc.constant('delete' as const),
      content: lineContentArb,
      oldLineNumber: fc.integer({ min: 1, max: 1000 }),
      newLineNumber: fc.constant(undefined),
    })
  );

  /**
   * Arbitrary generator for hunks.
   */
  const hunkArb: fc.Arbitrary<IHunk> = fc
    .array(diffLineArb, { minLength: 1, maxLength: 10 })
    .map((lines) => ({
      oldStart: 1,
      oldLines: lines.filter((l) => l.type !== 'add').length,
      newStart: 1,
      newLines: lines.filter((l) => l.type !== 'delete').length,
      header: '@@ -1,10 +1,10 @@',
      lines,
    }));

  /**
   * Arbitrary generator for diffs.
   */
  const diffArb: fc.Arbitrary<IDiff> = fc.record({
    path: filePathArb,
    oldPath: fc.constant(undefined),
    status: fc.constant('modified' as const),
    hunks: fc.array(hunkArb, { minLength: 1, maxLength: 3 }),
    binary: fc.constant(false),
  });

  /**
   * Arbitrary generator for commits.
   */
  const commitArb: fc.Arbitrary<ICommit> = fc.record({
    hash: commitHashArb,
    shortHash: shortHashArb,
    message: commitMessageArb,
    body: fc.option(fc.string({ minLength: 0, maxLength: 500 }), { nil: undefined }),
    author: authorArb,
    committer: authorArb,
    parents: fc.array(commitHashArb, { minLength: 1, maxLength: 2 }),
    authorDate: fc.date({ min: new Date('2000-01-01'), max: new Date() }),
    commitDate: fc.date({ min: new Date('2000-01-01'), max: new Date() }),
  });

  /**
   * Arbitrary generator for branch names.
   */
  const branchNameArb: fc.Arbitrary<string> = fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_/'.split('')
      ),
      { minLength: 1, maxLength: 30 }
    )
    .filter((s) => {
      if (s.length === 0) {
        return false;
      }
      if (s.startsWith('-') || s.startsWith('/')) {
        return false;
      }
      if (s.endsWith('/') || s.endsWith('.lock')) {
        return false;
      }
      if (s.includes('..') || s.includes('//')) {
        return false;
      }
      return true;
    });

  /**
   * Arbitrary generator for file status.
   */
  const fileStatusArb: fc.Arbitrary<IFileStatus> = fc.record({
    path: filePathArb,
    indexStatus: fc.constantFrom<StatusCode>('M', 'A', 'D', ' '),
    workTreeStatus: fc.constantFrom<StatusCode>('M', 'A', 'D', ' '),
    renamed: fc.constant(undefined),
  });

  /**
   * Arbitrary generator for working directory state (list of file statuses).
   */
  const workingDirectoryStateArb: fc.Arbitrary<IFileStatus[]> = fc.array(fileStatusArb, {
    minLength: 0,
    maxLength: 5,
  });

  /**
   * Arbitrary generator for file content (simulating working directory files).
   */
  const fileContentArb: fc.Arbitrary<Map<string, string>> = fc
    .array(
      fc.tuple(
        filePathArb,
        fc.string({ minLength: 0, maxLength: 500 }).map((s) => s.replace(/[\r\n]/g, '\n'))
      ),
      { minLength: 0, maxLength: 5 }
    )
    .map((entries) => new Map(entries));

  /**
   * Arbitrary generator for a list of unique commits (1-3 commits).
   * Ensures all commits have unique hashes.
   */
  const uniqueCommitsArb: fc.Arbitrary<ICommit[]> = fc
    .array(commitArb, { minLength: 1, maxLength: 3 })
    .map((commits) => {
      const seenHashes = new Set<string>();
      return commits.map((commit, index) => {
        let hash = commit.hash;
        while (seenHashes.has(hash)) {
          const chars = hash.split('');
          chars[index % 40] = '0123456789abcdef'[(parseInt(chars[index % 40], 16) + 1) % 16];
          hash = chars.join('');
        }
        seenHashes.add(hash);
        return { ...commit, hash, shortHash: hash.substring(0, 7) };
      });
    });

  /**
   * Represents a snapshot of the repository state before cherry-pick.
   */
  interface IRepositorySnapshot {
    branchName: string;
    branchHead: string;
    workingDirectoryFiles: Map<string, string>;
    fileStatuses: IFileStatus[];
    commitHistory: string[];
  }

  /**
   * Mock Cherry-Pick Abort Service that simulates cherry-pick operations
   * with abort functionality that restores pre-cherry-pick state.
   */
  class MockCherryPickAbortService {
    private _commits: Map<string, ICommit> = new Map();
    private _commitDiffs: Map<string, IDiff[]> = new Map();
    private _currentBranch: string;
    private _currentBranchHead: string;
    private _workingDirectoryFiles: Map<string, string>;
    private _fileStatuses: IFileStatus[];
    private _commitHistory: string[];
    private _cherryPickInProgress: boolean = false;
    private _preCheryPickSnapshot: IRepositorySnapshot | null = null;
    private _cherryPickedCommits: ICommit[] = [];

    constructor(
      currentBranch: string,
      currentBranchHead: string,
      workingDirectoryFiles: Map<string, string>,
      fileStatuses: IFileStatus[],
      commitHistory: string[]
    ) {
      this._currentBranch = currentBranch;
      this._currentBranchHead = currentBranchHead;
      this._workingDirectoryFiles = new Map(workingDirectoryFiles);
      this._fileStatuses = [...fileStatuses];
      this._commitHistory = [...commitHistory];
    }

    /**
     * Add a commit to the repository.
     */
    addCommit(commit: ICommit, diffs: IDiff[]): void {
      this._commits.set(commit.hash, commit);
      this._commitDiffs.set(commit.hash, diffs);
    }

    /**
     * Get the current branch name.
     */
    getCurrentBranch(): string {
      return this._currentBranch;
    }

    /**
     * Get the current branch HEAD commit hash.
     */
    getCurrentBranchHead(): string {
      return this._currentBranchHead;
    }

    /**
     * Get the working directory files.
     */
    getWorkingDirectoryFiles(): Map<string, string> {
      return new Map(this._workingDirectoryFiles);
    }

    /**
     * Get the file statuses.
     */
    getFileStatuses(): IFileStatus[] {
      return [...this._fileStatuses];
    }

    /**
     * Get the commit history.
     */
    getCommitHistory(): string[] {
      return [...this._commitHistory];
    }

    /**
     * Check if cherry-pick is in progress.
     */
    isCherryPickInProgress(): boolean {
      return this._cherryPickInProgress;
    }

    /**
     * Take a snapshot of the current repository state.
     */
    private takeSnapshot(): IRepositorySnapshot {
      return {
        branchName: this._currentBranch,
        branchHead: this._currentBranchHead,
        workingDirectoryFiles: new Map(this._workingDirectoryFiles),
        fileStatuses: [...this._fileStatuses],
        commitHistory: [...this._commitHistory],
      };
    }

    /**
     * Restore repository state from a snapshot.
     */
    private restoreFromSnapshot(snapshot: IRepositorySnapshot): void {
      this._currentBranch = snapshot.branchName;
      this._currentBranchHead = snapshot.branchHead;
      this._workingDirectoryFiles = new Map(snapshot.workingDirectoryFiles);
      this._fileStatuses = [...snapshot.fileStatuses];
      this._commitHistory = [...snapshot.commitHistory];
    }

    /**
     * Cherry-pick commits with potential for conflicts.
     *
     * @param commitHashes - Array of commit hashes to cherry-pick
     * @param simulateConflict - Whether to simulate a conflict
     * @returns Cherry-pick result
     */
    cherryPick(commitHashes: string[], simulateConflict: boolean = false): ICherryPickResult {
      if (commitHashes.length === 0) {
        return { success: true };
      }

      // Take snapshot before starting cherry-pick
      this._preCheryPickSnapshot = this.takeSnapshot();
      this._cherryPickInProgress = true;
      this._cherryPickedCommits = [];

      for (let i = 0; i < commitHashes.length; i++) {
        const hash = commitHashes[i];
        const originalCommit = this._commits.get(hash);

        if (!originalCommit) {
          return { success: false, conflicts: [] };
        }

        const originalDiffs = this._commitDiffs.get(hash);
        if (!originalDiffs) {
          return { success: false, conflicts: [] };
        }

        // Simulate conflict on first commit if requested
        if (simulateConflict && i === 0) {
          // Modify working directory to simulate conflict state
          for (const diff of originalDiffs) {
            this._workingDirectoryFiles.set(
              diff.path,
              `<<<<<<< HEAD\nlocal content\n=======\ncherry-picked content\n>>>>>>> ${hash}`
            );
            this._fileStatuses.push({
              path: diff.path,
              indexStatus: 'U' as StatusCode,
              workTreeStatus: 'U' as StatusCode,
            });
          }
          return { success: false, conflicts: originalDiffs.map((d) => d.path) };
        }

        // Apply cherry-pick (simulate successful application)
        const newHash = this.generateNewHash(originalCommit.hash);
        const cherryPickedCommit: ICommit = {
          hash: newHash,
          shortHash: newHash.substring(0, 7),
          message: originalCommit.message,
          body: originalCommit.body,
          author: { ...originalCommit.author },
          committer: { ...originalCommit.committer },
          parents: [this._currentBranchHead],
          authorDate: originalCommit.authorDate,
          commitDate: new Date(),
        };

        this._cherryPickedCommits.push(cherryPickedCommit);
        this._commits.set(newHash, cherryPickedCommit);
        this._commitDiffs.set(newHash, originalDiffs);
        this._currentBranchHead = newHash;
        this._commitHistory.push(newHash);

        // Update working directory with cherry-picked changes
        for (const diff of originalDiffs) {
          const existingContent = this._workingDirectoryFiles.get(diff.path) || '';
          this._workingDirectoryFiles.set(diff.path, existingContent + '\n// cherry-picked');
        }
      }

      this._cherryPickInProgress = false;
      this._preCheryPickSnapshot = null;
      return { success: true };
    }

    /**
     * Abort an in-progress cherry-pick operation.
     */
    cherryPickAbort(): void {
      if (!this._cherryPickInProgress || !this._preCheryPickSnapshot) {
        throw new Error('No cherry-pick in progress');
      }

      // Restore from snapshot
      this.restoreFromSnapshot(this._preCheryPickSnapshot);

      // Clean up cherry-pick state
      this._cherryPickInProgress = false;
      this._preCheryPickSnapshot = null;
      this._cherryPickedCommits = [];
    }

    /**
     * Generate a new hash for a cherry-picked commit.
     */
    private generateNewHash(originalHash: string): string {
      const chars = originalHash.split('');
      chars.reverse();
      const firstChar = chars[0];
      const hexChars = '0123456789abcdef';
      const newFirstChar = hexChars[(hexChars.indexOf(firstChar) + 1) % 16];
      chars[0] = newFirstChar;
      return chars.join('');
    }
  }

  describe('Property 37: Cherry-Pick Abort Restoration', () => {
    /**
     * Property: Aborting cherry-pick restores the original branch HEAD.
     */
    it('Property: Aborting cherry-pick restores the original branch HEAD', () => {
      fc.assert(
        fc.property(
          uniqueCommitsArb,
          fc.array(diffArb, { minLength: 1, maxLength: 3 }),
          branchNameArb,
          commitHashArb,
          fileContentArb,
          workingDirectoryStateArb,
          fc.array(commitHashArb, { minLength: 1, maxLength: 5 }),
          (
            commits,
            diffs,
            currentBranch,
            currentBranchHead,
            workingFiles,
            fileStatuses,
            commitHistory
          ) => {
            // Setup: Create service with initial state
            const service = new MockCherryPickAbortService(
              currentBranch,
              currentBranchHead,
              workingFiles,
              fileStatuses,
              commitHistory
            );

            // Add commits to repository
            for (const commit of commits) {
              service.addCommit(commit, diffs);
            }

            // Record original state
            const originalBranchHead = service.getCurrentBranchHead();

            // Act: Start cherry-pick with conflict
            const commitHashes = commits.map((c) => c.hash);
            service.cherryPick(commitHashes, true); // Simulate conflict

            // Assert: Cherry-pick is in progress
            assert.strictEqual(
              service.isCherryPickInProgress(),
              true,
              'Cherry-pick should be in progress'
            );

            // Act: Abort cherry-pick
            service.cherryPickAbort();

            // Assert: Branch HEAD is restored
            assert.strictEqual(
              service.getCurrentBranchHead(),
              originalBranchHead,
              'Branch HEAD should be restored to original'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Aborting cherry-pick restores the original working directory files.
     */
    it('Property: Aborting cherry-pick restores the original working directory files', () => {
      fc.assert(
        fc.property(
          uniqueCommitsArb,
          fc.array(diffArb, { minLength: 1, maxLength: 3 }),
          branchNameArb,
          commitHashArb,
          fileContentArb,
          workingDirectoryStateArb,
          fc.array(commitHashArb, { minLength: 1, maxLength: 5 }),
          (
            commits,
            diffs,
            currentBranch,
            currentBranchHead,
            workingFiles,
            fileStatuses,
            commitHistory
          ) => {
            // Setup
            const service = new MockCherryPickAbortService(
              currentBranch,
              currentBranchHead,
              workingFiles,
              fileStatuses,
              commitHistory
            );

            for (const commit of commits) {
              service.addCommit(commit, diffs);
            }

            // Record original working directory state
            const originalWorkingFiles = service.getWorkingDirectoryFiles();

            // Act: Start cherry-pick with conflict
            const commitHashes = commits.map((c) => c.hash);
            service.cherryPick(commitHashes, true);

            // Act: Abort cherry-pick
            service.cherryPickAbort();

            // Assert: Working directory files are restored
            const restoredWorkingFiles = service.getWorkingDirectoryFiles();
            assert.strictEqual(
              restoredWorkingFiles.size,
              originalWorkingFiles.size,
              'Working directory should have same number of files'
            );

            for (const [path, content] of originalWorkingFiles) {
              assert.strictEqual(
                restoredWorkingFiles.get(path),
                content,
                `File ${path} content should be restored`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Aborting cherry-pick restores the original file statuses.
     */
    it('Property: Aborting cherry-pick restores the original file statuses', () => {
      fc.assert(
        fc.property(
          uniqueCommitsArb,
          fc.array(diffArb, { minLength: 1, maxLength: 3 }),
          branchNameArb,
          commitHashArb,
          fileContentArb,
          workingDirectoryStateArb,
          fc.array(commitHashArb, { minLength: 1, maxLength: 5 }),
          (
            commits,
            diffs,
            currentBranch,
            currentBranchHead,
            workingFiles,
            fileStatuses,
            commitHistory
          ) => {
            // Setup
            const service = new MockCherryPickAbortService(
              currentBranch,
              currentBranchHead,
              workingFiles,
              fileStatuses,
              commitHistory
            );

            for (const commit of commits) {
              service.addCommit(commit, diffs);
            }

            // Record original file statuses
            const originalFileStatuses = service.getFileStatuses();

            // Act: Start cherry-pick with conflict
            const commitHashes = commits.map((c) => c.hash);
            service.cherryPick(commitHashes, true);

            // Act: Abort cherry-pick
            service.cherryPickAbort();

            // Assert: File statuses are restored
            const restoredFileStatuses = service.getFileStatuses();
            assert.strictEqual(
              restoredFileStatuses.length,
              originalFileStatuses.length,
              'Should have same number of file statuses'
            );

            for (let i = 0; i < originalFileStatuses.length; i++) {
              assert.deepStrictEqual(
                restoredFileStatuses[i],
                originalFileStatuses[i],
                `File status at index ${i} should be restored`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Aborting cherry-pick restores the original commit history.
     */
    it('Property: Aborting cherry-pick restores the original commit history', () => {
      fc.assert(
        fc.property(
          uniqueCommitsArb,
          fc.array(diffArb, { minLength: 1, maxLength: 3 }),
          branchNameArb,
          commitHashArb,
          fileContentArb,
          workingDirectoryStateArb,
          fc.array(commitHashArb, { minLength: 1, maxLength: 5 }),
          (
            commits,
            diffs,
            currentBranch,
            currentBranchHead,
            workingFiles,
            fileStatuses,
            commitHistory
          ) => {
            // Setup
            const service = new MockCherryPickAbortService(
              currentBranch,
              currentBranchHead,
              workingFiles,
              fileStatuses,
              commitHistory
            );

            for (const commit of commits) {
              service.addCommit(commit, diffs);
            }

            // Record original commit history
            const originalCommitHistory = service.getCommitHistory();

            // Act: Start cherry-pick with conflict
            const commitHashes = commits.map((c) => c.hash);
            service.cherryPick(commitHashes, true);

            // Act: Abort cherry-pick
            service.cherryPickAbort();

            // Assert: Commit history is restored
            const restoredCommitHistory = service.getCommitHistory();
            assert.strictEqual(
              restoredCommitHistory.length,
              originalCommitHistory.length,
              'Commit history should have same length'
            );

            for (let i = 0; i < originalCommitHistory.length; i++) {
              assert.strictEqual(
                restoredCommitHistory[i],
                originalCommitHistory[i],
                `Commit at index ${i} should be restored`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Aborting cherry-pick clears the cherry-pick in progress state.
     */
    it('Property: Aborting cherry-pick clears the cherry-pick in progress state', () => {
      fc.assert(
        fc.property(
          uniqueCommitsArb,
          fc.array(diffArb, { minLength: 1, maxLength: 3 }),
          branchNameArb,
          commitHashArb,
          fileContentArb,
          workingDirectoryStateArb,
          fc.array(commitHashArb, { minLength: 1, maxLength: 5 }),
          (
            commits,
            diffs,
            currentBranch,
            currentBranchHead,
            workingFiles,
            fileStatuses,
            commitHistory
          ) => {
            // Setup
            const service = new MockCherryPickAbortService(
              currentBranch,
              currentBranchHead,
              workingFiles,
              fileStatuses,
              commitHistory
            );

            for (const commit of commits) {
              service.addCommit(commit, diffs);
            }

            // Act: Start cherry-pick with conflict
            const commitHashes = commits.map((c) => c.hash);
            service.cherryPick(commitHashes, true);

            // Assert: Cherry-pick is in progress
            assert.strictEqual(
              service.isCherryPickInProgress(),
              true,
              'Cherry-pick should be in progress'
            );

            // Act: Abort cherry-pick
            service.cherryPickAbort();

            // Assert: Cherry-pick is no longer in progress
            assert.strictEqual(
              service.isCherryPickInProgress(),
              false,
              'Cherry-pick should not be in progress after abort'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Aborting cherry-pick preserves the original branch name.
     */
    it('Property: Aborting cherry-pick preserves the original branch name', () => {
      fc.assert(
        fc.property(
          uniqueCommitsArb,
          fc.array(diffArb, { minLength: 1, maxLength: 3 }),
          branchNameArb,
          commitHashArb,
          fileContentArb,
          workingDirectoryStateArb,
          fc.array(commitHashArb, { minLength: 1, maxLength: 5 }),
          (
            commits,
            diffs,
            currentBranch,
            currentBranchHead,
            workingFiles,
            fileStatuses,
            commitHistory
          ) => {
            // Setup
            const service = new MockCherryPickAbortService(
              currentBranch,
              currentBranchHead,
              workingFiles,
              fileStatuses,
              commitHistory
            );

            for (const commit of commits) {
              service.addCommit(commit, diffs);
            }

            // Record original branch name
            const originalBranchName = service.getCurrentBranch();

            // Act: Start cherry-pick with conflict
            const commitHashes = commits.map((c) => c.hash);
            service.cherryPick(commitHashes, true);

            // Act: Abort cherry-pick
            service.cherryPickAbort();

            // Assert: Branch name is preserved
            assert.strictEqual(
              service.getCurrentBranch(),
              originalBranchName,
              'Branch name should be preserved after abort'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Aborting cherry-pick when no cherry-pick is in progress throws error.
     */
    it('Property: Aborting cherry-pick when no cherry-pick is in progress throws error', () => {
      fc.assert(
        fc.property(
          branchNameArb,
          commitHashArb,
          fileContentArb,
          workingDirectoryStateArb,
          fc.array(commitHashArb, { minLength: 1, maxLength: 5 }),
          (currentBranch, currentBranchHead, workingFiles, fileStatuses, commitHistory) => {
            // Setup: Create service without starting cherry-pick
            const service = new MockCherryPickAbortService(
              currentBranch,
              currentBranchHead,
              workingFiles,
              fileStatuses,
              commitHistory
            );

            // Assert: Aborting without cherry-pick in progress throws
            assert.throws(
              () => service.cherryPickAbort(),
              /No cherry-pick in progress/,
              'Should throw error when no cherry-pick is in progress'
            );
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
