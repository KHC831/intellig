import '../setup';
import * as fc from 'fast-check';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { IConsoleEntry } from '../../src/git-core/interfaces/IGitToolWindowProvider';
import { ConsoleService } from '../../src/ui-shell/ConsoleService';

/**
 * Property-based tests for Console Output Capture.
 * Feature: intellig-vscode, Property 3: Console Output Capture
 *
 *
 * Property Description:
 * For any Git operation executed through the extension, the Console View SHALL contain
 * both the command executed and its output.
 *
 * - 1.4: WHEN Git operations produce output, THE Console_View SHALL display the command
 *        and its output in real-time
 */
describe('Console Output Capture Property Tests', () => {
  /**
   * Arbitrary generator for Git command names
   */
  const gitCommandArb: fc.Arbitrary<string> = fc.constantFrom(
    'git status',
    'git log',
    'git diff',
    'git branch',
    'git checkout',
    'git commit',
    'git push',
    'git pull',
    'git fetch',
    'git merge',
    'git rebase',
    'git stash',
    'git tag',
    'git remote',
    'git add',
    'git reset',
    'git cherry-pick',
    'git revert',
    'git blame'
  );

  /**
   * Arbitrary generator for command arguments
   */
  const commandArgsArb: fc.Arbitrary<string[]> = fc.array(
    fc.stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_./'.split('')
      ),
      { minLength: 1, maxLength: 30 }
    ),
    { minLength: 0, maxLength: 5 }
  );

  /**
   * Arbitrary generator for command output
   */
  const commandOutputArb: fc.Arbitrary<string> = fc.stringOf(
    fc.constantFrom(
      ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,-_()[]{}!?*+=#\n\t'.split(
        ''
      )
    ),
    { minLength: 0, maxLength: 1000 }
  );

  /**
   * Arbitrary generator for exit codes
   */
  const exitCodeArb: fc.Arbitrary<number> = fc.integer({ min: 0, max: 255 });

  /**
   * Arbitrary generator for full Git commands with arguments
   */
  const fullCommandArb: fc.Arbitrary<{ command: string; args: string[]; fullCommand: string }> = fc
    .tuple(gitCommandArb, commandArgsArb)
    .map(([command, args]) => ({
      command,
      args,
      fullCommand: args.length > 0 ? `${command} ${args.join(' ')}` : command,
    }));

  /**
   * Arbitrary generator for Git command execution results
   */
  const gitCommandResultArb: fc.Arbitrary<{
    command: string;
    output: string;
    exitCode: number;
    isError: boolean;
  }> = fc
    .tuple(fullCommandArb, commandOutputArb, exitCodeArb)
    .map(([cmdInfo, output, exitCode]) => ({
      command: cmdInfo.fullCommand,
      output,
      exitCode,
      isError: exitCode !== 0,
    }));

  /**
   * Arbitrary generator for a sequence of Git commands
   */
  const gitCommandSequenceArb: fc.Arbitrary<
    Array<{
      command: string;
      output: string;
      exitCode: number;
      isError: boolean;
    }>
  > = fc.array(gitCommandResultArb, { minLength: 1, maxLength: 20 });

  /**
   * Arbitrary generator for streaming output chunks
   */
  const streamingChunksArb: fc.Arbitrary<string[]> = fc.array(
    fc.string({ minLength: 1, maxLength: 200 }),
    { minLength: 1, maxLength: 10 }
  );

  /**
   * Build the shipped ConsoleService with an inert OutputChannel, so the
   * properties below exercise production code rather than a re-implementation.
   */
  const makeConsoleService = (maxEntries?: number): ConsoleService => {
    const channel = {
      name: 'test',
      append: (): void => {},
      appendLine: (): void => {},
      replace: (): void => {},
      clear: (): void => {},
      show: (): void => {},
      hide: (): void => {},
      dispose: (): void => {},
    } as unknown as vscode.OutputChannel;
    return new ConsoleService(maxEntries ?? 1000, channel);
  };

  /** Secrets the console must never retain verbatim. */
  const credentialUrlArb: fc.Arbitrary<{ raw: string; secret: string }> = fc
    .tuple(
      fc.constantFrom('https', 'http'),
      fc.stringOf(fc.constantFrom(...'abcdefghij0123456789'.split('')), {
        minLength: 8,
        maxLength: 20,
      })
    )
    .map(([scheme, secret]) => ({
      raw: `fatal: could not read from ${scheme}://user:${secret}@example.com/r.git`,
      secret,
    }));

  describe('Property 3: Console Output Capture', () => {
    /**
     * Property: a credential in the output never survives into a stored entry.
     * This is the assertion the sanitize pipeline actually owes us — comparing
     * the stored value against a recomputation of that same pipeline would
     * hold even if sanitizeGitError returned the empty string.
     */
    it('Property: credentials are redacted out of stored output', () => {
      fc.assert(
        fc.property(fullCommandArb, credentialUrlArb, (cmdInfo, cred) => {
          const consoleService = makeConsoleService();

          consoleService.logCommand(cmdInfo.fullCommand, cred.raw, 128, { isError: true });

          const stored = consoleService.getEntries()[0].output;
          assert.ok(!stored.includes(cred.secret), 'the secret must not be retained');
          assert.ok(stored.includes('<redacted>'), 'the redaction marker must be present');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: a home path in the output is collapsed to `~`. Covers the
     * three POSIX/Windows home-path replacements, which the credential
     * property alone leaves free to be deleted with the suite still green.
     */
    it('Property: home paths are collapsed out of stored output', () => {
      fc.assert(
        fc.property(
          fullCommandArb,
          fc.stringOf(fc.constantFrom(...'abcdefghijklmnop'.split('')), {
            minLength: 3,
            maxLength: 10,
          }),
          (cmdInfo, user) => {
            const consoleService = makeConsoleService();
            const raw = `error: cannot open /Users/${user}/work/repo/.git/config`;

            consoleService.logCommand(cmdInfo.fullCommand, raw, 1, { isError: true });

            const stored = consoleService.getEntries()[0].output;
            assert.ok(!stored.includes(`/Users/${user}`), 'the home path must not be retained');
            assert.ok(stored.includes('~'), 'it is collapsed to ~');
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Every logged command appears in the console entries.
     */
    it('Property: Every logged command appears in the console entries', () => {
      fc.assert(
        fc.property(gitCommandResultArb, (cmdResult) => {
          // Setup
          const consoleService = makeConsoleService();

          // Act: Log the command
          consoleService.logCommand(cmdResult.command, cmdResult.output, cmdResult.exitCode, {
            isError: cmdResult.isError,
          });

          // Assert: The command appears in the entries
          const entries = consoleService.getEntries();
          assert.strictEqual(entries.length, 1, 'Should have exactly one entry');
          assert.strictEqual(
            entries[0].command,
            cmdResult.command,
            'Entry command should match logged command'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Every logged command's output is captured in the console.
     */
    it('Property: Every logged command output is captured in the console', () => {
      fc.assert(
        fc.property(gitCommandResultArb, (cmdResult) => {
          // Setup
          const consoleService = makeConsoleService();

          // Act: Log the command
          consoleService.logCommand(cmdResult.command, cmdResult.output, cmdResult.exitCode, {
            isError: cmdResult.isError,
          });

          // Assert: The output is captured
          const entries = consoleService.getEntries();
          assert.strictEqual(entries.length, 1, 'Should have exactly one entry');
          assert.strictEqual(
            entries[0].output,
            cmdResult.output,
            'Entry output should be stored verbatim for sanitize-invariant text'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Console captures both command and output for any Git operation.
     */
    it('Property: Console captures both command and output for any Git operation', () => {
      fc.assert(
        fc.property(gitCommandResultArb, (cmdResult) => {
          // Setup
          const consoleService = makeConsoleService();

          // Act: Log the command
          consoleService.logCommand(cmdResult.command, cmdResult.output, cmdResult.exitCode, {
            isError: cmdResult.isError,
          });

          // Assert: Both command and output are captured
          const entries = consoleService.getEntries();
          assert.strictEqual(entries.length, 1, 'Should have exactly one entry');

          const entry = entries[0];
          assert.ok(
            entry.command === cmdResult.command && entry.output === cmdResult.output,
            'Entry should contain both the command and its output'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: All commands in a sequence are captured in order.
     */
    it('Property: All commands in a sequence are captured in order', () => {
      fc.assert(
        fc.property(gitCommandSequenceArb, (commands) => {
          // Setup
          const consoleService = makeConsoleService();

          // Act: Log all commands
          commands.forEach((cmd) => {
            consoleService.logCommand(cmd.command, cmd.output, cmd.exitCode, {
              isError: cmd.isError,
            });
          });

          // Assert: All commands are captured in order
          const entries = consoleService.getEntries();
          assert.strictEqual(
            entries.length,
            commands.length,
            'Should have same number of entries as commands'
          );

          for (let i = 0; i < commands.length; i++) {
            assert.strictEqual(
              entries[i].command,
              commands[i].command,
              `Entry ${i} command should match`
            );
            assert.strictEqual(
              entries[i].output,
              commands[i].output,
              `Entry ${i} output should match`
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Exit code is correctly captured for each command.
     */
    it('Property: Exit code is correctly captured for each command', () => {
      fc.assert(
        fc.property(gitCommandResultArb, (cmdResult) => {
          // Setup
          const consoleService = makeConsoleService();

          // Act: Log the command
          consoleService.logCommand(cmdResult.command, cmdResult.output, cmdResult.exitCode, {
            isError: cmdResult.isError,
          });

          // Assert: Exit code is captured
          const entries = consoleService.getEntries();
          assert.strictEqual(entries.length, 1, 'Should have exactly one entry');
          assert.strictEqual(
            entries[0].exitCode,
            cmdResult.exitCode,
            'Entry exit code should match logged exit code'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Error status is correctly determined from exit code.
     */
    it('Property: Error status is correctly determined from exit code', () => {
      fc.assert(
        fc.property(gitCommandResultArb, (cmdResult) => {
          // Setup
          const consoleService = makeConsoleService();

          // Act: Log the command (let the service determine isError from exitCode)
          consoleService.logCommand(cmdResult.command, cmdResult.output, cmdResult.exitCode);

          // Assert: isError is correctly set based on exit code
          const entries = consoleService.getEntries();
          assert.strictEqual(entries.length, 1, 'Should have exactly one entry');

          const expectedIsError = cmdResult.exitCode !== 0;
          assert.strictEqual(
            entries[0].isError,
            expectedIsError,
            `isError should be ${expectedIsError} for exit code ${cmdResult.exitCode}`
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Streaming output accumulates correctly.
     */
    it('Property: Streaming output accumulates correctly', () => {
      fc.assert(
        fc.property(
          fullCommandArb,
          streamingChunksArb,
          exitCodeArb,
          (cmdInfo, chunks, exitCode) => {
            // Setup
            const consoleService = makeConsoleService();

            // Act: Start streaming and send chunks
            const handler = consoleService.startStreaming(cmdInfo.fullCommand);

            chunks.forEach((chunk) => {
              handler.onData(chunk);
            });

            handler.onComplete(exitCode);

            // Assert: All chunks are accumulated
            const entries = consoleService.getEntries();
            assert.strictEqual(entries.length, 1, 'Should have exactly one entry');

            const expectedOutput = chunks.join('');
            assert.strictEqual(
              entries[0].output,
              expectedOutput,
              'Streaming output should accumulate all chunks'
            );
            assert.strictEqual(
              entries[0].command,
              cmdInfo.fullCommand,
              'Command should be captured'
            );
            assert.strictEqual(
              entries[0].exitCode,
              exitCode,
              'Exit code should be set on complete'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Streaming error is captured correctly.
     */
    it('Property: Streaming error is captured correctly', () => {
      fc.assert(
        fc.property(
          fullCommandArb,
          streamingChunksArb,
          fc.string({ minLength: 1, maxLength: 100 }),
          (cmdInfo, chunks, errorMessage) => {
            // Setup
            const consoleService = makeConsoleService();

            // Act: Start streaming, send some chunks, then error
            const handler = consoleService.startStreaming(cmdInfo.fullCommand);

            chunks.forEach((chunk) => {
              handler.onData(chunk);
            });

            handler.onError(new Error(errorMessage));

            // Assert: Error is captured
            const entries = consoleService.getEntries();
            assert.strictEqual(entries.length, 1, 'Should have exactly one entry');

            const entry = entries[0];
            assert.ok(entry.isError, 'Entry should be marked as error');
            assert.strictEqual(entry.exitCode, 1, 'Exit code should be 1 for error');
            assert.ok(entry.output.includes(errorMessage), 'Output should contain error message');
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: logError correctly captures error commands.
     */
    it('Property: logError correctly captures error commands', () => {
      fc.assert(
        fc.property(
          fullCommandArb,
          fc.string({ minLength: 1, maxLength: 200 }),
          (cmdInfo, errorMessage) => {
            // Setup
            const consoleService = makeConsoleService();

            // Act: Log an error
            consoleService.logError(cmdInfo.fullCommand, errorMessage);

            // Assert: Error is captured correctly
            const entries = consoleService.getEntries();
            assert.strictEqual(entries.length, 1, 'Should have exactly one entry');

            const entry = entries[0];
            assert.strictEqual(entry.command, cmdInfo.fullCommand, 'Command should be captured');
            assert.strictEqual(entry.output, errorMessage, 'Error message should be in output');
            assert.ok(entry.isError, 'Entry should be marked as error');
            assert.strictEqual(entry.exitCode, 1, 'Exit code should be 1');
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: logError with Error object extracts message correctly.
     */
    it('Property: logError with Error object extracts message correctly', () => {
      fc.assert(
        fc.property(
          fullCommandArb,
          fc.string({ minLength: 1, maxLength: 200 }),
          (cmdInfo, errorMessage) => {
            // Setup
            const consoleService = makeConsoleService();

            // Act: Log an error with Error object
            consoleService.logError(cmdInfo.fullCommand, new Error(errorMessage));

            // Assert: Error message is extracted
            const entries = consoleService.getEntries();
            assert.strictEqual(entries.length, 1, 'Should have exactly one entry');

            const entry = entries[0];
            assert.strictEqual(entry.output, errorMessage, 'Error message should be extracted');
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Console entries have timestamps.
     */
    it('Property: Console entries have timestamps', () => {
      fc.assert(
        fc.property(gitCommandResultArb, (cmdResult) => {
          // Setup
          const consoleService = makeConsoleService();
          const beforeTime = new Date();

          // Act: Log the command
          consoleService.logCommand(cmdResult.command, cmdResult.output, cmdResult.exitCode, {
            isError: cmdResult.isError,
          });

          const afterTime = new Date();

          // Assert: Timestamp is present and reasonable
          const entries = consoleService.getEntries();
          assert.strictEqual(entries.length, 1, 'Should have exactly one entry');

          const entry = entries[0];
          assert.ok(entry.timestamp instanceof Date, 'Timestamp should be a Date');
          assert.ok(
            entry.timestamp >= beforeTime && entry.timestamp <= afterTime,
            'Timestamp should be within execution window'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Clear removes all entries.
     */
    it('Property: Clear removes all entries', () => {
      fc.assert(
        fc.property(gitCommandSequenceArb, (commands) => {
          // Setup
          const consoleService = makeConsoleService();

          // Act: Log all commands
          commands.forEach((cmd) => {
            consoleService.logCommand(cmd.command, cmd.output, cmd.exitCode, {
              isError: cmd.isError,
            });
          });

          // Verify entries exist
          assert.strictEqual(
            consoleService.getEntries().length,
            commands.length,
            'Should have entries before clear'
          );

          // Act: Clear
          consoleService.clear();

          // Assert: All entries are removed
          assert.strictEqual(
            consoleService.getEntries().length,
            0,
            'Should have no entries after clear'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Max entries limit is respected.
     */
    it('Property: Max entries limit is respected', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 5, max: 20 }),
          gitCommandSequenceArb,
          (maxEntries, commands) => {
            // Setup
            const consoleService = makeConsoleService(maxEntries);

            // Act: Log all commands
            commands.forEach((cmd) => {
              consoleService.logCommand(cmd.command, cmd.output, cmd.exitCode, {
                isError: cmd.isError,
              });
            });

            // Assert: Entries don't exceed max
            const entries = consoleService.getEntries();
            assert.ok(
              entries.length <= maxEntries,
              `Entries (${entries.length}) should not exceed max (${maxEntries})`
            );

            // If we logged more than max, oldest entries should be removed
            if (commands.length > maxEntries) {
              const expectedFirstCommand = commands[commands.length - maxEntries].command;
              assert.strictEqual(
                entries[0].command,
                expectedFirstCommand,
                'Oldest entries should be removed when exceeding max'
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Event is fired for each new entry.
     */
    it('Property: Event is fired for each new entry', () => {
      fc.assert(
        fc.property(gitCommandSequenceArb, (commands) => {
          // Setup
          const consoleService = makeConsoleService();
          const receivedEntries: IConsoleEntry[] = [];

          // Subscribe to events
          const subscription = consoleService.onDidAddEntry((entry) => {
            receivedEntries.push(entry);
          });

          // Act: Log all commands
          commands.forEach((cmd) => {
            consoleService.logCommand(cmd.command, cmd.output, cmd.exitCode, {
              isError: cmd.isError,
            });
          });

          // Assert: Event was fired for each entry
          assert.strictEqual(
            receivedEntries.length,
            commands.length,
            'Should receive event for each logged command'
          );

          for (let i = 0; i < commands.length; i++) {
            assert.strictEqual(
              receivedEntries[i].command,
              commands[i].command,
              `Event ${i} should have correct command`
            );
          }

          // Cleanup
          subscription.dispose();
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Clear event is fired when clearing.
     */
    it('Property: Clear event is fired when clearing', () => {
      fc.assert(
        fc.property(gitCommandSequenceArb, (commands) => {
          // Setup
          const consoleService = makeConsoleService();
          let clearEventFired = false;

          // Subscribe to clear event
          const subscription = consoleService.onDidClear(() => {
            clearEventFired = true;
          });

          // Log some commands
          commands.forEach((cmd) => {
            consoleService.logCommand(cmd.command, cmd.output, cmd.exitCode, {
              isError: cmd.isError,
            });
          });

          // Act: Clear
          consoleService.clear();

          // Assert: Clear event was fired
          assert.ok(clearEventFired, 'Clear event should be fired');

          // Cleanup
          subscription.dispose();
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Console state reflects all logged entries.
     */
    it('Property: Retained entries reflect all logged commands', () => {
      fc.assert(
        fc.property(gitCommandSequenceArb, (commands) => {
          // Setup
          const consoleService = makeConsoleService();

          // Act: Log all commands
          commands.forEach((cmd) => {
            consoleService.logCommand(cmd.command, cmd.output, cmd.exitCode, {
              isError: cmd.isError,
            });
          });

          // Assert: the retained entries reflect every logged command
          const entries = consoleService.getEntries();
          assert.strictEqual(
            entries.length,
            commands.length,
            'Should retain one entry per logged command'
          );

          for (let i = 0; i < commands.length; i++) {
            assert.strictEqual(
              entries[i].command,
              commands[i].command,
              `Entry ${i} command should match`
            );
            assert.strictEqual(
              entries[i].output,
              commands[i].output,
              `Entry ${i} output should match`
            );
          }
        }),
        { numRuns: 100 }
      );
    });
  });
});
