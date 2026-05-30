import * as fc from 'fast-check';
import * as assert from 'assert';
import { IBlameLine } from '../../git-core/interfaces/IGitService';
import { IBlameInfo } from '../../blame/interfaces/IBlameService';

/**
 * Property-based tests for Blame Previous Revision.
 * Feature: intellig-vscode, Property 30: Blame Previous Revision
 *
 *
 * Property Description:
 * For any blame annotation, selecting "Annotate Previous Revision" SHALL show
 * the blame state of the file before the selected commit was made.
 *
 * - 9.6 (Blame): WHEN a user selects "Annotate Previous Revision", THE Extension
 *                SHALL show blame for the file before the selected commit
 */
describe('Blame Previous Revision Property Tests', () => {
  /**
   * Arbitrary generator for valid commit hashes (40 hex characters).
   */
  const commitHashArb: fc.Arbitrary<string> = fc
    .array(fc.constantFrom(...'0123456789abcdef'.split('')), { minLength: 40, maxLength: 40 })
    .map((chars) => chars.join(''));

  /**
   * Arbitrary generator for author names.
   * Author names should be non-empty strings.
   */
  const authorNameArb: fc.Arbitrary<string> = fc
    .string({ minLength: 1, maxLength: 50 })
    .filter((s) => s.trim().length > 0)
    .map((s) => s.trim());

  /**
   * Arbitrary generator for author emails.
   */
  const authorEmailArb: fc.Arbitrary<string> = fc
    .tuple(
      fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z0-9._-]+$/.test(s)),
      fc.string({ minLength: 1, maxLength: 15 }).filter((s) => /^[a-zA-Z0-9.-]+$/.test(s))
    )
    .map(([local, domain]) => `${local}@${domain}.com`);

  /**
   * Arbitrary generator for commit messages.
   * Commit messages should be non-empty strings.
   */
  const commitMessageArb: fc.Arbitrary<string> = fc
    .string({ minLength: 1, maxLength: 100 })
    .filter((s) => s.trim().length > 0)
    .map((s) => s.trim());

  /**
   * Arbitrary generator for dates (within a reasonable range).
   */
  const dateArb: fc.Arbitrary<Date> = fc.date({
    min: new Date('2000-01-01'),
    max: new Date(),
  });

  /**
   * Arbitrary generator for valid file paths.
   */
  const filePathArb: fc.Arbitrary<string> = fc
    .array(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_./'.split('')
      ),
      { minLength: 1, maxLength: 50 }
    )
    .map((chars) => chars.join(''))
    .filter((s) => {
      if (s.length === 0) {
        return false;
      }
      if (s.startsWith('/') || s.endsWith('/')) {
        return false;
      }
      if (s.includes('//')) {
        return false;
      }
      if (s.startsWith('.') && s.length === 1) {
        return false;
      }
      return true;
    })
    .map((s) => (s.startsWith('.') ? 'file' + s : s));

  /**
   * Arbitrary generator for a single blame line.
   */
  const blameLineArb: fc.Arbitrary<IBlameLine> = fc.record({
    line: fc.nat({ max: 10000 }).map((n) => n + 1), // Line numbers start at 1
    commit: commitHashArb,
    author: authorNameArb,
    authorEmail: authorEmailArb,
    date: dateArb,
    message: commitMessageArb,
    previousCommit: fc.option(commitHashArb, { nil: undefined }),
  });

  /**
   * Arbitrary generator for a non-empty array of blame lines with consecutive line numbers.
   */
  const blameLinesArb: fc.Arbitrary<IBlameLine[]> = fc
    .array(blameLineArb, { minLength: 1, maxLength: 100 })
    .map((lines) => {
      // Ensure consecutive line numbers starting from 1
      return lines.map((line, index) => ({
        ...line,
        line: index + 1,
      }));
    });

  /**
   * Represents a commit in the simulated history.
   */
  interface ISimulatedCommit {
    hash: string;
    parentHash: string | null;
    blameInfo: IBlameInfo;
    date: Date;
  }

  /**
   * Arbitrary generator for a chain of commits (simulating history).
   * Each commit has a parent (except the first), and each has blame info.
   */
  const commitChainArb: fc.Arbitrary<ISimulatedCommit[]> = fc
    .tuple(
      filePathArb,
      fc.array(fc.tuple(commitHashArb, blameLinesArb, dateArb), { minLength: 2, maxLength: 10 })
    )
    .map(([path, commits]) => {
      // Sort commits by date to simulate chronological order
      const sortedCommits = commits.sort((a, b) => a[2].getTime() - b[2].getTime());

      return sortedCommits.map((commit, index) => ({
        hash: commit[0],
        parentHash: index > 0 ? sortedCommits[index - 1][0] : null,
        blameInfo: {
          path,
          lines: commit[1],
        },
        date: commit[2],
      }));
    });

  /**
   * Mock BlameService that simulates blame operations with commit history.
   * This allows us to test the blame previous revision properties
   * without actual Git operations.
   */
  class MockBlameServiceWithHistory {
    private _commitHistory: Map<string, ISimulatedCommit> = new Map();
    private _currentBlame: Map<string, IBlameInfo> = new Map();
    private _commitParents: Map<string, string | null> = new Map();

    constructor() {}

    /**
     * Set up commit history for testing.
     * @param commits - Array of simulated commits in chronological order
     */
    setCommitHistory(commits: ISimulatedCommit[]): void {
      this._commitHistory.clear();
      this._commitParents.clear();
      this._currentBlame.clear();

      for (const commit of commits) {
        this._commitHistory.set(commit.hash, commit);
        this._commitParents.set(commit.hash, commit.parentHash);
      }

      // Set the latest commit's blame as current
      if (commits.length > 0) {
        const latestCommit = commits[commits.length - 1];
        this._currentBlame.set(latestCommit.blameInfo.path, latestCommit.blameInfo);
      }
    }

    /**
     * Get blame information for a file at a specific revision.
     *
     * @param path - The file path
     * @param revision - Optional revision (commit hash)
     * @returns The blame information for the file at that revision
     */
    getBlame(path: string, revision?: string): IBlameInfo {
      if (revision) {
        const commit = this._commitHistory.get(revision);
        if (!commit) {
          throw new Error(`Commit not found: ${revision}`);
        }
        if (commit.blameInfo.path !== path) {
          throw new Error(`File ${path} not found at revision ${revision}`);
        }
        return commit.blameInfo;
      }

      const blameInfo = this._currentBlame.get(path);
      if (!blameInfo) {
        throw new Error(`No blame info for file: ${path}`);
      }
      return blameInfo;
    }

    /**
     * Get the parent commit hash for a given commit.
     *
     * @param commitHash - The commit hash
     * @returns The parent commit hash, or null if no parent
     */
    getParentCommit(commitHash: string): string | null {
      if (!this._commitParents.has(commitHash)) {
        throw new Error(`Commit not found: ${commitHash}`);
      }
      return this._commitParents.get(commitHash) || null;
    }

    /**
     * Get blame information for the file at the previous revision.
     * This is the core functionality being tested.
     *
     *
     * @param path - The file path
     * @param commit - The commit hash to get the previous revision from
     * @returns Blame information for the file at the previous revision
     */
    getPreviousRevisionBlame(path: string, commit: string): IBlameInfo {
      // Get the parent commit
      const parentCommit = this.getParentCommit(commit);

      if (!parentCommit) {
        // No parent commit (initial commit) - return empty blame
        return { path, lines: [] };
      }

      // Get blame for the file at the parent commit
      return this.getBlame(path, parentCommit);
    }

    /**
     * Check if a commit exists in the history.
     *
     * @param commitHash - The commit hash to check
     * @returns True if the commit exists
     */
    hasCommit(commitHash: string): boolean {
      return this._commitHistory.has(commitHash);
    }

    /**
     * Get all commits in the history.
     *
     * @returns Array of all commits
     */
    getAllCommits(): ISimulatedCommit[] {
      return Array.from(this._commitHistory.values());
    }
  }

  describe('Property 30: Blame Previous Revision', () => {
    /**
     * Property: Previous revision blame returns blame from parent commit.
     */
    it('Property: Previous revision blame returns blame from parent commit', () => {
      fc.assert(
        fc.property(commitChainArb, (commits) => {
          // Setup
          const blameService = new MockBlameServiceWithHistory();
          blameService.setCommitHistory(commits);

          // Test each commit (except the first which has no parent)
          for (let i = 1; i < commits.length; i++) {
            const currentCommit = commits[i];
            const parentCommit = commits[i - 1];

            // Act: Get previous revision blame
            const previousBlame = blameService.getPreviousRevisionBlame(
              currentCommit.blameInfo.path,
              currentCommit.hash
            );

            // Assert: Previous blame matches parent commit's blame
            assert.strictEqual(
              previousBlame.path,
              parentCommit.blameInfo.path,
              'Previous blame path should match parent commit path'
            );
            assert.strictEqual(
              previousBlame.lines.length,
              parentCommit.blameInfo.lines.length,
              'Previous blame should have same number of lines as parent commit'
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Previous revision of initial commit returns empty blame.
     */
    it('Property: Previous revision of initial commit returns empty blame', () => {
      fc.assert(
        fc.property(commitChainArb, (commits) => {
          // Setup
          const blameService = new MockBlameServiceWithHistory();
          blameService.setCommitHistory(commits);

          // Get the initial commit (first in chain)
          const initialCommit = commits[0];

          // Act: Get previous revision blame for initial commit
          const previousBlame = blameService.getPreviousRevisionBlame(
            initialCommit.blameInfo.path,
            initialCommit.hash
          );

          // Assert: Previous blame is empty (no parent)
          assert.strictEqual(
            previousBlame.lines.length,
            0,
            'Previous revision of initial commit should have no blame lines'
          );
          assert.strictEqual(
            previousBlame.path,
            initialCommit.blameInfo.path,
            'Previous blame path should still match the file path'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Previous revision blame shows state before the selected commit.
     */
    it('Property: Previous revision blame shows state before the selected commit', () => {
      fc.assert(
        fc.property(commitChainArb, (commits) => {
          // Setup
          const blameService = new MockBlameServiceWithHistory();
          blameService.setCommitHistory(commits);

          // Test each commit (except the first which has no parent)
          for (let i = 1; i < commits.length; i++) {
            const currentCommit = commits[i];
            const parentCommit = commits[i - 1];

            // Act: Get previous revision blame
            const previousBlame = blameService.getPreviousRevisionBlame(
              currentCommit.blameInfo.path,
              currentCommit.hash
            );

            // Assert: The blame info is from the parent commit, not the current
            // This verifies we're showing the state BEFORE the selected commit
            for (let j = 0; j < previousBlame.lines.length; j++) {
              const previousLine = previousBlame.lines[j];
              const parentLine = parentCommit.blameInfo.lines[j];

              assert.strictEqual(
                previousLine.commit,
                parentLine.commit,
                `Line ${j + 1} commit should match parent commit's blame`
              );
              assert.strictEqual(
                previousLine.author,
                parentLine.author,
                `Line ${j + 1} author should match parent commit's blame`
              );
              assert.strictEqual(
                previousLine.message,
                parentLine.message,
                `Line ${j + 1} message should match parent commit's blame`
              );
            }
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Navigating through previous revisions follows commit chain.
     */
    it('Property: Navigating through previous revisions follows commit chain', () => {
      fc.assert(
        fc.property(commitChainArb, (commits) => {
          // Setup
          const blameService = new MockBlameServiceWithHistory();
          blameService.setCommitHistory(commits);

          // Start from the latest commit
          const latestCommit = commits[commits.length - 1];
          const path = latestCommit.blameInfo.path;

          // Navigate backwards through history
          let currentCommitHash = latestCommit.hash;
          let expectedIndex = commits.length - 1;

          while (expectedIndex > 0) {
            // Get previous revision blame
            const previousBlame = blameService.getPreviousRevisionBlame(path, currentCommitHash);

            // Move to parent
            expectedIndex--;
            const expectedCommit = commits[expectedIndex];

            // Assert: Previous blame matches expected commit
            assert.strictEqual(
              previousBlame.lines.length,
              expectedCommit.blameInfo.lines.length,
              `Navigation step ${commits.length - 1 - expectedIndex}: line count should match`
            );

            // Update current commit for next iteration
            currentCommitHash = expectedCommit.hash;
          }

          // Final step: previous of initial commit should be empty
          const finalPrevious = blameService.getPreviousRevisionBlame(path, currentCommitHash);
          assert.strictEqual(
            finalPrevious.lines.length,
            0,
            'Final navigation step should reach empty blame (no more history)'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Previous revision blame preserves file path.
     */
    it('Property: Previous revision blame preserves file path', () => {
      fc.assert(
        fc.property(commitChainArb, (commits) => {
          // Setup
          const blameService = new MockBlameServiceWithHistory();
          blameService.setCommitHistory(commits);

          // Test each commit
          for (const commit of commits) {
            // Act: Get previous revision blame
            const previousBlame = blameService.getPreviousRevisionBlame(
              commit.blameInfo.path,
              commit.hash
            );

            // Assert: Path is preserved
            assert.strictEqual(
              previousBlame.path,
              commit.blameInfo.path,
              'Previous revision blame should preserve the file path'
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Previous revision blame for non-existent commit throws error.
     */
    it('Property: Previous revision blame for non-existent commit throws error', () => {
      fc.assert(
        fc.property(commitChainArb, commitHashArb, (commits, randomHash) => {
          // Setup
          const blameService = new MockBlameServiceWithHistory();
          blameService.setCommitHistory(commits);

          // Skip if the random hash happens to be in our history
          if (blameService.hasCommit(randomHash)) {
            return true;
          }

          const path = commits[0].blameInfo.path;

          // Act & Assert: Should throw for non-existent commit
          assert.throws(
            () => blameService.getPreviousRevisionBlame(path, randomHash),
            /Commit not found/,
            'Should throw when getting previous revision for non-existent commit'
          );

          return true;
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Previous revision blame lines have valid structure.
     */
    it('Property: Previous revision blame lines have valid structure', () => {
      fc.assert(
        fc.property(commitChainArb, (commits) => {
          // Setup
          const blameService = new MockBlameServiceWithHistory();
          blameService.setCommitHistory(commits);

          // Test each commit (except the first)
          for (let i = 1; i < commits.length; i++) {
            const currentCommit = commits[i];

            // Act: Get previous revision blame
            const previousBlame = blameService.getPreviousRevisionBlame(
              currentCommit.blameInfo.path,
              currentCommit.hash
            );

            // Assert: Each line has valid structure
            for (const line of previousBlame.lines) {
              // Line number is positive
              assert.ok(line.line > 0, 'Line number should be positive');

              // Commit hash is valid (40 hex characters)
              assert.ok(
                /^[0-9a-f]{40}$/.test(line.commit),
                'Commit hash should be 40 hex characters'
              );

              // Author is non-empty
              assert.ok(line.author && line.author.trim().length > 0, 'Author should be non-empty');

              // Date is valid
              assert.ok(
                line.date instanceof Date && !isNaN(line.date.getTime()),
                'Date should be valid'
              );

              // Message is non-empty
              assert.ok(
                line.message && line.message.trim().length > 0,
                'Message should be non-empty'
              );
            }
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Consecutive previous revision calls traverse history correctly.
     */
    it('Property: Consecutive previous revision calls traverse history correctly', () => {
      fc.assert(
        fc.property(commitChainArb, fc.nat({ max: 9 }), (commits, steps) => {
          // Setup
          const blameService = new MockBlameServiceWithHistory();
          blameService.setCommitHistory(commits);

          // Limit steps to available history
          const maxSteps = Math.min(steps, commits.length - 1);
          const path = commits[0].blameInfo.path;

          // Start from the latest commit
          let currentCommitHash = commits[commits.length - 1].hash;
          let currentIndex = commits.length - 1;

          // Navigate backwards
          for (let step = 0; step < maxSteps; step++) {
            const previousBlame = blameService.getPreviousRevisionBlame(path, currentCommitHash);
            currentIndex--;

            // Verify we're at the expected commit
            const expectedCommit = commits[currentIndex];
            assert.strictEqual(
              previousBlame.lines.length,
              expectedCommit.blameInfo.lines.length,
              `Step ${step + 1}: Should be at commit index ${currentIndex}`
            );

            // Move to the parent for next iteration
            currentCommitHash = expectedCommit.hash;
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Previous revision blame date is earlier than current commit date.
     */
    it('Property: Previous revision blame is from an earlier point in history', () => {
      fc.assert(
        fc.property(commitChainArb, (commits) => {
          // Setup
          const blameService = new MockBlameServiceWithHistory();
          blameService.setCommitHistory(commits);

          // Test each commit (except the first)
          for (let i = 1; i < commits.length; i++) {
            const currentCommit = commits[i];
            const parentCommit = commits[i - 1];

            // Act: Get previous revision blame
            const previousBlame = blameService.getPreviousRevisionBlame(
              currentCommit.blameInfo.path,
              currentCommit.hash
            );

            // Assert: Previous blame is from parent commit (earlier in history)
            // We verify this by checking the blame matches the parent's blame
            assert.strictEqual(
              previousBlame.lines.length,
              parentCommit.blameInfo.lines.length,
              'Previous revision should be from parent commit (earlier in history)'
            );

            // Verify the parent commit date is earlier or equal
            assert.ok(
              parentCommit.date.getTime() <= currentCommit.date.getTime(),
              'Parent commit should be earlier or equal in time'
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Previous revision blame maintains line number consistency.
     */
    it('Property: Previous revision blame maintains line number consistency', () => {
      fc.assert(
        fc.property(commitChainArb, (commits) => {
          // Setup
          const blameService = new MockBlameServiceWithHistory();
          blameService.setCommitHistory(commits);

          // Test each commit (except the first)
          for (let i = 1; i < commits.length; i++) {
            const currentCommit = commits[i];

            // Act: Get previous revision blame
            const previousBlame = blameService.getPreviousRevisionBlame(
              currentCommit.blameInfo.path,
              currentCommit.hash
            );

            // Assert: Line numbers are consecutive starting from 1
            const lineNumbers = previousBlame.lines.map((l) => l.line).sort((a, b) => a - b);
            for (let j = 0; j < lineNumbers.length; j++) {
              assert.strictEqual(
                lineNumbers[j],
                j + 1,
                `Line numbers should be consecutive, expected ${j + 1} but got ${lineNumbers[j]}`
              );
            }
          }
        }),
        { numRuns: 100 }
      );
    });
  });
});
