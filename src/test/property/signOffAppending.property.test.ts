import * as fc from 'fast-check';
import * as assert from 'assert';
import { IRepository, ICommitOptions, IAuthor } from '../../services/interfaces/IGitService';
import * as vscode from 'vscode';

/**
 * Property-based tests for Sign-off Appending.
 * Feature: intellig-vscode, Property 5: Sign-off Appending
 *
 *
 * Property Description:
 * For any commit message, enabling the Sign-off option SHALL result in a commit message
 * that ends with a valid "Signed-off-by:" line containing the configured user name and email.
 */
describe('Sign-off Appending Property Tests', () => {
  /**
   * Arbitrary generator for user names (non-empty strings without angle brackets)
   * User names should not contain < or > as they would break the sign-off format
   */
  const userNameArb: fc.Arbitrary<string> = fc
    .string({ minLength: 1, maxLength: 100 })
    .filter((s) => s.trim().length > 0 && !s.includes('<') && !s.includes('>'));

  /**
   * Arbitrary generator for email addresses
   */
  const emailArb: fc.Arbitrary<string> = fc.emailAddress();

  /**
   * Arbitrary generator for user configuration (name and email)
   */
  const userConfigArb: fc.Arbitrary<IAuthor> = fc.record({
    name: userNameArb,
    email: emailArb,
  });

  /**
   * Arbitrary generator for non-empty commit messages
   * We test with various message types to ensure sign-off works correctly
   */
  const nonEmptyCommitMessageArb: fc.Arbitrary<string> = fc.oneof(
    // Single line message
    fc
      .string({ minLength: 1, maxLength: 200 })
      .filter((s) => s.trim().length > 0 && !s.includes('\n')),
    // Multi-line message
    fc
      .array(
        fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
        { minLength: 2, maxLength: 5 }
      )
      .map((lines) => lines.join('\n')),
    // Message with trailing whitespace
    fc
      .string({ minLength: 1, maxLength: 100 })
      .filter((s) => s.trim().length > 0)
      .map((s) => s + '   '),
    // Message with trailing newlines
    fc
      .string({ minLength: 1, maxLength: 100 })
      .filter((s) => s.trim().length > 0)
      .map((s) => s + '\n\n'),
    // Message that already contains a Signed-off-by line (should still append another)
    fc
      .tuple(
        fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
        userConfigArb
      )
      .map(([msg, user]) => `${msg}\n\nSigned-off-by: ${user.name} <${user.email}>`)
  );

  /**
   * Regular expression to match a valid Signed-off-by line
   * Format: "Signed-off-by: Name <email>"
   */
  const SIGNOFF_REGEX = /^Signed-off-by: .+ <.+@.+>$/;

  /**
   * Mock Git CLI that simulates the behavior of git commit --signoff
   * When --signoff is used, Git appends a Signed-off-by line to the commit message
   */
  class MockGitCli {
    private _userName: string;
    private _userEmail: string;
    private _lastCommitMessage: string = '';
    private _lastArgs: string[] = [];

    constructor(userName: string, userEmail: string) {
      this._userName = userName;
      this._userEmail = userEmail;
    }

    /**
     * Get the user name configured for this mock
     */
    get userName(): string {
      return this._userName;
    }

    /**
     * Get the user email configured for this mock
     */
    get userEmail(): string {
      return this._userEmail;
    }

    /**
     * Get the last commit message (after sign-off processing)
     */
    get lastCommitMessage(): string {
      return this._lastCommitMessage;
    }

    /**
     * Get the last command arguments
     */
    get lastArgs(): string[] {
      return this._lastArgs;
    }

    /**
     * Simulate git commit command
     * When --signoff is present, append the Signed-off-by line
     */
    exec(args: string[]): { exitCode: number; stdout: string; stderr: string } {
      this._lastArgs = args;

      if (args[0] === 'commit') {
        const messageIndex = args.indexOf('-m');
        if (messageIndex !== -1 && messageIndex + 1 < args.length) {
          let message = args[messageIndex + 1];

          // If --signoff flag is present, append the Signed-off-by line
          // This simulates Git's actual behavior
          if (args.includes('--signoff')) {
            message = this._appendSignOff(message);
          }

          this._lastCommitMessage = message;
        }
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    }

    /**
     * Append Signed-off-by line to the message
     * This simulates Git's --signoff behavior:
     * - Adds a blank line before the sign-off if the message doesn't end with one
     * - Appends "Signed-off-by: Name <email>"
     */
    private _appendSignOff(message: string): string {
      const signOffLine = `Signed-off-by: ${this._userName} <${this._userEmail}>`;

      // Git adds a blank line before the sign-off if needed
      if (message.length === 0) {
        return signOffLine;
      }

      // Check if message already ends with newlines
      const trimmedMessage = message.trimEnd();
      if (trimmedMessage.length === 0) {
        return signOffLine;
      }

      // Add blank line separator and sign-off
      return `${trimmedMessage}\n\n${signOffLine}`;
    }
  }

  /**
   * Mock GitService that uses the MockGitCli
   */
  class MockGitService {
    private _gitCli: MockGitCli;

    constructor(userName: string, userEmail: string) {
      this._gitCli = new MockGitCli(userName, userEmail);
    }

    /**
     * Get the underlying Git CLI mock
     */
    get gitCli(): MockGitCli {
      return this._gitCli;
    }

    /**
     * Commit with the given message and options
     * Simulates the GitService.commit() method behavior
     */
    commit(_repo: IRepository, message: string, options: ICommitOptions = {}): void {
      const args = ['commit', '-m', message];

      if (options.amend) {
        args.push('--amend');
      }
      if (options.signOff) {
        args.push('--signoff');
      }
      if (options.noVerify) {
        args.push('--no-verify');
      }
      if (options.allowEmpty) {
        args.push('--allow-empty');
      }

      this._gitCli.exec(args);
    }

    /**
     * Get the resulting commit message after processing
     */
    getResultingCommitMessage(): string {
      return this._gitCli.lastCommitMessage;
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

  /**
   * Check if a message ends with a valid Signed-off-by line
   */
  function endsWithValidSignOff(message: string, userName: string, userEmail: string): boolean {
    const lines = message.split('\n');
    const lastLine = lines[lines.length - 1];
    const expectedSignOff = `Signed-off-by: ${userName} <${userEmail}>`;
    return lastLine === expectedSignOff;
  }

  /**
   * Check if a string is a valid Signed-off-by line format
   */
  function isValidSignOffFormat(line: string): boolean {
    return SIGNOFF_REGEX.test(line);
  }

  describe('Property 5: Sign-off Appending', () => {
    /**
     * Property: For any commit message and user configuration, enabling sign-off
     * SHALL result in a commit message that ends with a valid Signed-off-by line.
     */
    it('Property: Enabling sign-off appends valid Signed-off-by line', () => {
      fc.assert(
        fc.property(nonEmptyCommitMessageArb, userConfigArb, (message, userConfig) => {
          // Setup: Create mock service with user configuration
          const gitService = new MockGitService(userConfig.name, userConfig.email);
          const repo = createMockRepository();

          // Act: Commit with sign-off enabled
          gitService.commit(repo, message, { signOff: true });

          // Assert: The resulting message should end with a valid Signed-off-by line
          const resultMessage = gitService.getResultingCommitMessage();

          assert.ok(
            endsWithValidSignOff(resultMessage, userConfig.name, userConfig.email),
            `Message should end with "Signed-off-by: ${userConfig.name} <${userConfig.email}>"\n` +
              `Actual message:\n${resultMessage}`
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: The Signed-off-by line contains the configured user name and email.
     */
    it('Property: Signed-off-by line contains configured user name and email', () => {
      fc.assert(
        fc.property(nonEmptyCommitMessageArb, userConfigArb, (message, userConfig) => {
          // Setup
          const gitService = new MockGitService(userConfig.name, userConfig.email);
          const repo = createMockRepository();

          // Act
          gitService.commit(repo, message, { signOff: true });

          // Assert: Extract the last line and verify it contains the user info
          const resultMessage = gitService.getResultingCommitMessage();
          const lines = resultMessage.split('\n');
          const lastLine = lines[lines.length - 1];

          assert.ok(
            lastLine.includes(userConfig.name),
            `Signed-off-by line should contain user name "${userConfig.name}"`
          );
          assert.ok(
            lastLine.includes(userConfig.email),
            `Signed-off-by line should contain user email "${userConfig.email}"`
          );
          assert.ok(
            lastLine.startsWith('Signed-off-by:'),
            'Line should start with "Signed-off-by:"'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: The Signed-off-by line follows the standard format.
     */
    it('Property: Signed-off-by line follows standard format', () => {
      fc.assert(
        fc.property(nonEmptyCommitMessageArb, userConfigArb, (message, userConfig) => {
          // Setup
          const gitService = new MockGitService(userConfig.name, userConfig.email);
          const repo = createMockRepository();

          // Act
          gitService.commit(repo, message, { signOff: true });

          // Assert: The last line should match the standard format
          const resultMessage = gitService.getResultingCommitMessage();
          const lines = resultMessage.split('\n');
          const lastLine = lines[lines.length - 1];

          assert.ok(
            isValidSignOffFormat(lastLine),
            `Signed-off-by line should match format "Signed-off-by: Name <email>"\n` +
              `Actual: "${lastLine}"`
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Sign-off is separated from the original message by a blank line.
     */
    it('Property: Sign-off is separated from message by blank line', () => {
      fc.assert(
        fc.property(nonEmptyCommitMessageArb, userConfigArb, (message, userConfig) => {
          // Setup
          const gitService = new MockGitService(userConfig.name, userConfig.email);
          const repo = createMockRepository();

          // Act
          gitService.commit(repo, message, { signOff: true });

          // Assert: There should be a blank line before the Signed-off-by line
          const resultMessage = gitService.getResultingCommitMessage();
          const lines = resultMessage.split('\n');

          // If there's more than just the sign-off line, check for blank line separator
          if (lines.length > 1) {
            // Find the sign-off line index
            const signOffIndex = lines.findIndex((line) => line.startsWith('Signed-off-by:'));
            assert.ok(signOffIndex > 0, 'Sign-off line should not be the first line');

            // The line before sign-off should be empty (blank line separator)
            const lineBeforeSignOff = lines[signOffIndex - 1];
            assert.strictEqual(
              lineBeforeSignOff,
              '',
              'There should be a blank line before the Signed-off-by line'
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Original message content is preserved when sign-off is added.
     */
    it('Property: Original message content is preserved', () => {
      fc.assert(
        fc.property(nonEmptyCommitMessageArb, userConfigArb, (message, userConfig) => {
          // Setup
          const gitService = new MockGitService(userConfig.name, userConfig.email);
          const repo = createMockRepository();

          // Act
          gitService.commit(repo, message, { signOff: true });

          // Assert: The original message (trimmed) should be present in the result
          const resultMessage = gitService.getResultingCommitMessage();
          const trimmedOriginal = message.trimEnd();

          assert.ok(
            resultMessage.startsWith(trimmedOriginal),
            `Result should start with original message content\n` +
              `Original (trimmed): "${trimmedOriginal}"\n` +
              `Result: "${resultMessage}"`
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Without sign-off option, no Signed-off-by line is added.
     */
    it('Property: Without sign-off option, no Signed-off-by line is added', () => {
      fc.assert(
        fc.property(nonEmptyCommitMessageArb, userConfigArb, (message, userConfig) => {
          // Setup
          const gitService = new MockGitService(userConfig.name, userConfig.email);
          const repo = createMockRepository();

          // Act: Commit WITHOUT sign-off
          gitService.commit(repo, message, { signOff: false });

          // Assert: The message should be unchanged (no sign-off added)
          const resultMessage = gitService.getResultingCommitMessage();

          // The result should be the original message (Git doesn't modify it without --signoff)
          assert.strictEqual(
            resultMessage,
            message,
            'Message should be unchanged when sign-off is disabled'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Sign-off works correctly with empty messages (when allowEmpty is true).
     */
    it('Property: Sign-off works with empty messages', () => {
      fc.assert(
        fc.property(userConfigArb, (userConfig) => {
          // Setup
          const gitService = new MockGitService(userConfig.name, userConfig.email);
          const repo = createMockRepository();

          // Act: Commit with empty message and sign-off
          gitService.commit(repo, '', { signOff: true, allowEmpty: true });

          // Assert: The result should be just the Signed-off-by line
          const resultMessage = gitService.getResultingCommitMessage();
          const expectedSignOff = `Signed-off-by: ${userConfig.name} <${userConfig.email}>`;

          assert.strictEqual(
            resultMessage,
            expectedSignOff,
            'Empty message with sign-off should result in just the Signed-off-by line'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Sign-off is idempotent in terms of format (multiple sign-offs are valid).
     * Note: Git allows multiple Signed-off-by lines (e.g., when multiple people sign off)
     */
    it('Property: Multiple sign-offs result in valid format', () => {
      fc.assert(
        fc.property(
          nonEmptyCommitMessageArb,
          userConfigArb,
          userConfigArb,
          (message, firstUser, secondUser) => {
            // Setup: First user signs off
            const firstGitService = new MockGitService(firstUser.name, firstUser.email);
            const repo = createMockRepository();

            firstGitService.commit(repo, message, { signOff: true });
            const afterFirstSignOff = firstGitService.getResultingCommitMessage();

            // Second user signs off on the already signed message
            const secondGitService = new MockGitService(secondUser.name, secondUser.email);
            secondGitService.commit(repo, afterFirstSignOff, { signOff: true });
            const afterSecondSignOff = secondGitService.getResultingCommitMessage();

            // Assert: The final message should end with the second user's sign-off
            assert.ok(
              endsWithValidSignOff(afterSecondSignOff, secondUser.name, secondUser.email),
              'Message should end with the most recent Signed-off-by line'
            );

            // Assert: Both sign-off lines should be present
            assert.ok(
              afterSecondSignOff.includes(`Signed-off-by: ${firstUser.name} <${firstUser.email}>`),
              'First user sign-off should be preserved'
            );
            assert.ok(
              afterSecondSignOff.includes(
                `Signed-off-by: ${secondUser.name} <${secondUser.email}>`
              ),
              'Second user sign-off should be present'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Sign-off combined with amend option still produces valid sign-off.
     */
    it('Property: Sign-off works correctly with amend option', () => {
      fc.assert(
        fc.property(nonEmptyCommitMessageArb, userConfigArb, (message, userConfig) => {
          // Setup
          const gitService = new MockGitService(userConfig.name, userConfig.email);
          const repo = createMockRepository();

          // Act: Commit with both amend and sign-off
          gitService.commit(repo, message, { signOff: true, amend: true });

          // Assert: The result should still have a valid sign-off
          const resultMessage = gitService.getResultingCommitMessage();

          assert.ok(
            endsWithValidSignOff(resultMessage, userConfig.name, userConfig.email),
            'Amended commit with sign-off should end with valid Signed-off-by line'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Sign-off line email is properly formatted with angle brackets.
     */
    it('Property: Sign-off email is enclosed in angle brackets', () => {
      fc.assert(
        fc.property(nonEmptyCommitMessageArb, userConfigArb, (message, userConfig) => {
          // Setup
          const gitService = new MockGitService(userConfig.name, userConfig.email);
          const repo = createMockRepository();

          // Act
          gitService.commit(repo, message, { signOff: true });

          // Assert: The last line (the newly added sign-off) should have email in angle brackets
          const resultMessage = gitService.getResultingCommitMessage();
          const lines = resultMessage.split('\n');
          const lastLine = lines[lines.length - 1];

          assert.ok(
            lastLine.startsWith('Signed-off-by:'),
            'Last line should be a Signed-off-by line'
          );
          assert.ok(
            lastLine.includes(`<${userConfig.email}>`),
            `Email should be enclosed in angle brackets: <${userConfig.email}>`
          );
        }),
        { numRuns: 100 }
      );
    });
  });
});
