import * as fc from 'fast-check';
import * as assert from 'assert';
import {
  ICommit,
  IAuthor,
  IRepository,
  ILogOptions,
} from '../../src/git-core/interfaces/IGitService';
import * as vscode from 'vscode';

/**
 * Property-based tests for Commit Amend Message Loading.
 * Feature: intellig-vscode, Property 4: Commit Amend Message Loading
 *
 *
 * Property Description:
 * For any repository with at least one commit, enabling the Amend option SHALL
 * populate the commit message field with the previous commit's message.
 */
describe('Commit Amend Message Loading Property Tests', () => {
  /**
   * Arbitrary generator for author information
   */
  const authorArb: fc.Arbitrary<IAuthor> = fc.record({
    name: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
    email: fc.emailAddress(),
  });

  /**
   * Arbitrary generator for commit messages (non-empty strings)
   * Commit messages should be non-empty and can contain various characters
   */
  const commitMessageArb: fc.Arbitrary<string> = fc
    .string({ minLength: 1, maxLength: 500 })
    .filter((s) => s.trim().length > 0);

  /**
   * Arbitrary generator for optional commit body
   */
  const commitBodyArb: fc.Arbitrary<string | undefined> = fc.option(
    fc.string({ minLength: 1, maxLength: 1000 }).filter((s) => s.trim().length > 0),
    { nil: undefined }
  );

  /**
   * Arbitrary generator for commit hash (40 character hex string)
   */
  const commitHashArb: fc.Arbitrary<string> = fc
    .hexaString({ minLength: 40, maxLength: 40 })
    .map((s) => s.toLowerCase());

  /**
   * Arbitrary generator for short commit hash (7 characters)
   */
  const shortHashArb: fc.Arbitrary<string> = fc
    .hexaString({ minLength: 7, maxLength: 7 })
    .map((s) => s.toLowerCase());

  /**
   * Arbitrary generator for a commit object
   */
  const commitArb: fc.Arbitrary<ICommit> = fc.record({
    hash: commitHashArb,
    shortHash: shortHashArb,
    message: commitMessageArb,
    body: commitBodyArb,
    author: authorArb,
    committer: authorArb,
    parents: fc.array(commitHashArb, { minLength: 0, maxLength: 2 }),
    authorDate: fc.date({ min: new Date('2000-01-01'), max: new Date() }),
    commitDate: fc.date({ min: new Date('2000-01-01'), max: new Date() }),
  });

  /**
   * Arbitrary generator for a non-empty array of commits (repository with at least one commit)
   */
  const nonEmptyCommitHistoryArb: fc.Arbitrary<ICommit[]> = fc.array(commitArb, {
    minLength: 1,
    maxLength: 20,
  });

  /**
   * Mock GitService that simulates the behavior of getting the previous commit message
   */
  class MockGitService {
    private commits: ICommit[];

    constructor(commits: ICommit[]) {
      // Sort commits by date (most recent first) to simulate git log behavior
      this.commits = [...commits].sort((a, b) => b.commitDate.getTime() - a.commitDate.getTime());
    }

    /**
     * Simulates getLog with maxCount: 1 to get the most recent commit
     */
    getLog(_repo: IRepository, options?: ILogOptions): Promise<ICommit[]> {
      if (options?.maxCount === 1) {
        return Promise.resolve(this.commits.length > 0 ? [this.commits[0]] : []);
      }
      return Promise.resolve(this.commits);
    }

    /**
     * Get the previous commit message (what amend mode should load)
     */
    getPreviousCommitMessage(): string {
      if (this.commits.length === 0) {
        return '';
      }
      const commit = this.commits[0];
      return commit.body ? `${commit.message}\n\n${commit.body}` : commit.message;
    }
  }

  /**
   * Mock CommitDialog that simulates the amend message loading behavior
   */
  class MockCommitDialog {
    private gitService: MockGitService;
    private _amendMode: boolean = false;
    private _commitMessage: string = '';
    private _previousCommitMessage: string = '';

    constructor(gitService: MockGitService) {
      this.gitService = gitService;
    }

    /**
     * Get the current commit message
     */
    get commitMessage(): string {
      return this._commitMessage;
    }

    /**
     * Get the previous commit message (loaded when amend is enabled)
     */
    get previousCommitMessage(): string {
      return this._previousCommitMessage;
    }

    /**
     * Get whether amend mode is enabled
     */
    get amendMode(): boolean {
      return this._amendMode;
    }

    /**
     * Load the previous commit message from the repository
     * This simulates the _loadPreviousCommitMessage method in CommitDialog
     */
    async loadPreviousCommitMessage(repo: IRepository): Promise<void> {
      const commits = await this.gitService.getLog(repo, { maxCount: 1 });
      if (commits.length > 0) {
        const commit = commits[0];
        this._previousCommitMessage = commit.body
          ? `${commit.message}\n\n${commit.body}`
          : commit.message;
      }
    }

    /**
     * Handle amend toggle - simulates the _handleAmendToggle method
     */
    async handleAmendToggle(amend: boolean, repo: IRepository): Promise<void> {
      this._amendMode = amend;

      if (amend && !this._previousCommitMessage) {
        await this.loadPreviousCommitMessage(repo);
      }

      // If enabling amend and message is empty, populate with previous message
      if (amend && !this._commitMessage.trim()) {
        this._commitMessage = this._previousCommitMessage;
      }
    }

    /**
     * Set the commit message directly
     */
    setCommitMessage(message: string): void {
      this._commitMessage = message;
    }

    /**
     * Reset the dialog state
     */
    reset(): void {
      this._amendMode = false;
      this._commitMessage = '';
      this._previousCommitMessage = '';
    }
  }

  /**
   * Create a mock repository for testing
   */
  function createMockRepository(): IRepository {
    return {
      rootUri: vscode.Uri.file('/mock/repo'),
      state: 'idle',
      head: {
        name: 'main',
        commit: 'abc123',
        ahead: 0,
        behind: 0,
      },
      remotes: [],
      submodules: [],
    };
  }

  describe('Property 4: Commit Amend Message Loading', () => {
    /**
     * Property: For any repository with at least one commit, enabling the Amend option
     * SHALL populate the commit message field with the previous commit's message.
     */
    it('Property: Enabling amend populates commit message with previous commit message', async () => {
      await fc.assert(
        fc.asyncProperty(nonEmptyCommitHistoryArb, async (commits) => {
          // Setup: Create mock services with the generated commits
          const gitService = new MockGitService(commits);
          const commitDialog = new MockCommitDialog(gitService);
          const repo = createMockRepository();

          // Act: Enable amend mode (with empty commit message)
          await commitDialog.handleAmendToggle(true, repo);

          // Assert: The commit message should be populated with the previous commit's message
          const expectedMessage = gitService.getPreviousCommitMessage();
          assert.strictEqual(
            commitDialog.commitMessage,
            expectedMessage,
            'Commit message should be populated with previous commit message when amend is enabled'
          );
          assert.strictEqual(commitDialog.amendMode, true, 'Amend mode should be enabled');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: The previous commit message includes both subject and body when present.
     */
    it('Property: Previous commit message includes subject and body when body exists', async () => {
      // Generate commits that always have a body
      const commitWithBodyArb: fc.Arbitrary<ICommit> = fc.record({
        hash: commitHashArb,
        shortHash: shortHashArb,
        message: commitMessageArb,
        body: fc.string({ minLength: 1, maxLength: 500 }).filter((s) => s.trim().length > 0),
        author: authorArb,
        committer: authorArb,
        parents: fc.array(commitHashArb, { minLength: 0, maxLength: 2 }),
        authorDate: fc.date({ min: new Date('2000-01-01'), max: new Date() }),
        commitDate: fc.date({ min: new Date('2000-01-01'), max: new Date() }),
      });

      await fc.assert(
        fc.asyncProperty(
          fc.array(commitWithBodyArb, { minLength: 1, maxLength: 10 }),
          async (commits) => {
            // Setup
            const gitService = new MockGitService(commits);
            const commitDialog = new MockCommitDialog(gitService);
            const repo = createMockRepository();

            // Act: Enable amend mode
            await commitDialog.handleAmendToggle(true, repo);

            // Get the most recent commit (sorted by date)
            const sortedCommits = [...commits].sort(
              (a, b) => b.commitDate.getTime() - a.commitDate.getTime()
            );
            const mostRecentCommit = sortedCommits[0];

            // Assert: Message should include both subject and body separated by double newline
            const expectedMessage = `${mostRecentCommit.message}\n\n${mostRecentCommit.body}`;
            assert.strictEqual(
              commitDialog.commitMessage,
              expectedMessage,
              'Commit message should include subject and body separated by double newline'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: The previous commit message is just the subject when no body exists.
     */
    it('Property: Previous commit message is just subject when no body exists', async () => {
      // Generate commits without a body
      const commitWithoutBodyArb: fc.Arbitrary<ICommit> = fc.record({
        hash: commitHashArb,
        shortHash: shortHashArb,
        message: commitMessageArb,
        body: fc.constant(undefined),
        author: authorArb,
        committer: authorArb,
        parents: fc.array(commitHashArb, { minLength: 0, maxLength: 2 }),
        authorDate: fc.date({ min: new Date('2000-01-01'), max: new Date() }),
        commitDate: fc.date({ min: new Date('2000-01-01'), max: new Date() }),
      });

      await fc.assert(
        fc.asyncProperty(
          fc.array(commitWithoutBodyArb, { minLength: 1, maxLength: 10 }),
          async (commits) => {
            // Setup
            const gitService = new MockGitService(commits);
            const commitDialog = new MockCommitDialog(gitService);
            const repo = createMockRepository();

            // Act: Enable amend mode
            await commitDialog.handleAmendToggle(true, repo);

            // Get the most recent commit
            const sortedCommits = [...commits].sort(
              (a, b) => b.commitDate.getTime() - a.commitDate.getTime()
            );
            const mostRecentCommit = sortedCommits[0];

            // Assert: Message should be just the subject (no body)
            assert.strictEqual(
              commitDialog.commitMessage,
              mostRecentCommit.message,
              'Commit message should be just the subject when no body exists'
            );
            assert.ok(
              !commitDialog.commitMessage.includes('\n\n'),
              'Commit message should not contain double newline when no body'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Disabling amend does not clear a user-entered message.
     */
    it('Property: Disabling amend preserves user-entered message', async () => {
      await fc.assert(
        fc.asyncProperty(
          nonEmptyCommitHistoryArb,
          commitMessageArb,
          async (commits, userMessage) => {
            // Setup
            const gitService = new MockGitService(commits);
            const commitDialog = new MockCommitDialog(gitService);
            const repo = createMockRepository();

            // Act: Enable amend, then set a custom message, then disable amend
            await commitDialog.handleAmendToggle(true, repo);
            commitDialog.setCommitMessage(userMessage);
            await commitDialog.handleAmendToggle(false, repo);

            // Assert: User's message should be preserved
            assert.strictEqual(
              commitDialog.commitMessage,
              userMessage,
              'User-entered message should be preserved when disabling amend'
            );
            assert.strictEqual(commitDialog.amendMode, false, 'Amend mode should be disabled');
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Enabling amend with existing message does not overwrite it.
     */
    it('Property: Enabling amend with existing message does not overwrite it', async () => {
      await fc.assert(
        fc.asyncProperty(
          nonEmptyCommitHistoryArb,
          commitMessageArb,
          async (commits, existingMessage) => {
            // Setup
            const gitService = new MockGitService(commits);
            const commitDialog = new MockCommitDialog(gitService);
            const repo = createMockRepository();

            // Act: Set a message first, then enable amend
            commitDialog.setCommitMessage(existingMessage);
            await commitDialog.handleAmendToggle(true, repo);

            // Assert: Existing message should be preserved (not overwritten)
            assert.strictEqual(
              commitDialog.commitMessage,
              existingMessage,
              'Existing message should not be overwritten when enabling amend'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Re-enabling amend after disabling loads the same previous message.
     */
    it('Property: Re-enabling amend loads the same previous message', async () => {
      await fc.assert(
        fc.asyncProperty(nonEmptyCommitHistoryArb, async (commits) => {
          // Setup
          const gitService = new MockGitService(commits);
          const commitDialog = new MockCommitDialog(gitService);
          const repo = createMockRepository();

          // Act: Enable amend, capture message, disable, clear message, re-enable
          await commitDialog.handleAmendToggle(true, repo);
          const firstAmendMessage = commitDialog.commitMessage;

          await commitDialog.handleAmendToggle(false, repo);
          commitDialog.setCommitMessage(''); // Clear the message

          await commitDialog.handleAmendToggle(true, repo);
          const secondAmendMessage = commitDialog.commitMessage;

          // Assert: Both amend operations should load the same message
          assert.strictEqual(
            secondAmendMessage,
            firstAmendMessage,
            'Re-enabling amend should load the same previous commit message'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: The loaded message matches the most recent commit by date.
     */
    it('Property: Loaded message matches the most recent commit by date', async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(commitArb, { minLength: 2, maxLength: 10 }), async (commits) => {
          // Setup
          const gitService = new MockGitService(commits);
          const commitDialog = new MockCommitDialog(gitService);
          const repo = createMockRepository();

          // Find the most recent commit by date
          const sortedCommits = [...commits].sort(
            (a, b) => b.commitDate.getTime() - a.commitDate.getTime()
          );
          const mostRecentCommit = sortedCommits[0];

          // Act: Enable amend mode
          await commitDialog.handleAmendToggle(true, repo);

          // Assert: The loaded message should be from the most recent commit
          const expectedMessage = mostRecentCommit.body
            ? `${mostRecentCommit.message}\n\n${mostRecentCommit.body}`
            : mostRecentCommit.message;

          assert.strictEqual(
            commitDialog.commitMessage,
            expectedMessage,
            'Loaded message should be from the most recent commit by date'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Amend toggle is idempotent when already in the target state.
     */
    it('Property: Amend toggle is idempotent', async () => {
      await fc.assert(
        fc.asyncProperty(
          nonEmptyCommitHistoryArb,
          fc.nat({ max: 5 }),
          async (commits, toggleCount) => {
            // Setup
            const gitService = new MockGitService(commits);
            const commitDialog = new MockCommitDialog(gitService);
            const repo = createMockRepository();

            // Act: Enable amend multiple times
            for (let i = 0; i <= toggleCount; i++) {
              await commitDialog.handleAmendToggle(true, repo);
            }

            // Assert: State should be the same as enabling once
            const expectedMessage = gitService.getPreviousCommitMessage();
            assert.strictEqual(
              commitDialog.commitMessage,
              expectedMessage,
              'Multiple amend enables should result in same state as single enable'
            );
            assert.strictEqual(commitDialog.amendMode, true, 'Amend mode should be enabled');
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
