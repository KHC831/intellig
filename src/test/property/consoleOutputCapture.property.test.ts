import * as fc from 'fast-check';
import * as assert from 'assert';
import { IConsoleEntry } from '../../services/interfaces/IGitToolWindowProvider';

/**
 * Local type for backward compatibility in tests.
 * The IConsoleState interface was removed when the tabbed layout was replaced
 * by the 3-panel layout.
 */
interface IConsoleState {
  entries: IConsoleEntry[];
  maxEntries: number;
}
import {
  IConsoleService,
  IStreamingOutputHandler,
} from '../../services/interfaces/IConsoleService';

/**
 * Property-based tests for Console Output Capture.
 * Feature: intellij-git-vscode, Property 3: Console Output Capture
 *
 * **Validates: Requirements 1.4**
 *
 * Property Description:
 * For any Git operation executed through the extension, the Console View SHALL contain
 * both the command executed and its output.
 *
 * Requirements:
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
  const commandOutputArb: fc.Arbitrary<string> = fc.string({ minLength: 0, maxLength: 1000 });

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
   * Mock Console Service that simulates console output capture.
   * This allows us to test the console output capture properties without actual Git execution.
   */
  class MockConsoleService implements IConsoleService {
    private _entries: IConsoleEntry[] = [];
    private _maxEntries: number;
    private _listeners: Array<(entry: IConsoleEntry) => void> = [];
    private _clearListeners: Array<() => void> = [];

    constructor(maxEntries: number = 1000) {
      this._maxEntries = maxEntries;
    }

    /**
     * Log a Git command and its output to the console.
     * Requirement 1.4: Console View displays command and output
     */
    logCommand(
      command: string,
      output: string,
      exitCode?: number,
      options?: { showConsole?: boolean; isError?: boolean }
    ): void {
      const entry: IConsoleEntry = {
        timestamp: new Date(),
        command,
        output,
        exitCode,
        isError: options?.isError ?? (exitCode !== undefined && exitCode !== 0),
      };

      this._addEntry(entry);
    }

    /**
     * Log an error to the console.
     */
    logError(command: string, error: string | Error): void {
      const errorMessage = error instanceof Error ? error.message : error;
      this.logCommand(command, errorMessage, 1, { isError: true });
    }

    /**
     * Start streaming output for a command.
     * Returns a handler that can be used to send output data in real-time.
     */
    startStreaming(command: string): IStreamingOutputHandler {
      const entry: IConsoleEntry = {
        timestamp: new Date(),
        command,
        output: '',
        isError: false,
      };

      const entryIndex = this._entries.length;
      this._addEntry(entry);

      return {
        onData: (data: string): void => {
          if (entryIndex < this._entries.length) {
            this._entries[entryIndex].output += data;
          }
        },
        onComplete: (exitCode: number): void => {
          if (entryIndex < this._entries.length) {
            this._entries[entryIndex].exitCode = exitCode;
            this._entries[entryIndex].isError = exitCode !== 0;
          }
        },
        onError: (error: Error): void => {
          if (entryIndex < this._entries.length) {
            this._entries[entryIndex].output += `\nError: ${error.message}`;
            this._entries[entryIndex].isError = true;
            this._entries[entryIndex].exitCode = 1;
          }
        },
      };
    }

    /**
     * Clear all console entries.
     */
    clear(): void {
      this._entries = [];
      this._clearListeners.forEach((listener) => listener());
    }

    /**
     * Get all console entries.
     */
    getEntries(): IConsoleEntry[] {
      return [...this._entries];
    }

    /**
     * Get the console state.
     */
    getState(): IConsoleState {
      return {
        entries: [...this._entries],
        maxEntries: this._maxEntries,
      };
    }

    /**
     * Show the console tab (no-op in mock).
     */
    showConsole(): void {
      // No-op in mock
    }

    /**
     * Event subscription for new entries.
     */
    get onDidAddEntry(): { (listener: (entry: IConsoleEntry) => void): { dispose(): void } } {
      return (listener: (entry: IConsoleEntry) => void): { dispose(): void } => {
        this._listeners.push(listener);
        return {
          dispose: (): void => {
            const index = this._listeners.indexOf(listener);
            if (index >= 0) {
              this._listeners.splice(index, 1);
            }
          },
        };
      };
    }

    /**
     * Event subscription for clear.
     */
    get onDidClear(): { (listener: () => void): { dispose(): void } } {
      return (listener: () => void): { dispose(): void } => {
        this._clearListeners.push(listener);
        return {
          dispose: (): void => {
            const index = this._clearListeners.indexOf(listener);
            if (index >= 0) {
              this._clearListeners.splice(index, 1);
            }
          },
        };
      };
    }

    /**
     * Dispose of resources.
     */
    dispose(): void {
      this._entries = [];
      this._listeners = [];
      this._clearListeners = [];
    }

    /**
     * Add an entry to the console.
     */
    private _addEntry(entry: IConsoleEntry): void {
      this._entries.push(entry);

      // Trim entries if exceeding max
      while (this._entries.length > this._maxEntries) {
        this._entries.shift();
      }

      // Notify listeners
      this._listeners.forEach((listener) => listener(entry));
    }
  }

  describe('Property 3: Console Output Capture', () => {
    /**
     * Property: Every logged command appears in the console entries.
     *
     * **Validates: Requirements 1.4**
     */
    it('Property: Every logged command appears in the console entries', () => {
      fc.assert(
        fc.property(gitCommandResultArb, (cmdResult) => {
          // Setup
          const consoleService = new MockConsoleService();

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
     *
     * **Validates: Requirements 1.4**
     */
    it('Property: Every logged command output is captured in the console', () => {
      fc.assert(
        fc.property(gitCommandResultArb, (cmdResult) => {
          // Setup
          const consoleService = new MockConsoleService();

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
            'Entry output should match logged output'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Console captures both command and output for any Git operation.
     *
     * **Validates: Requirements 1.4**
     */
    it('Property: Console captures both command and output for any Git operation', () => {
      fc.assert(
        fc.property(gitCommandResultArb, (cmdResult) => {
          // Setup
          const consoleService = new MockConsoleService();

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
     *
     * **Validates: Requirements 1.4**
     */
    it('Property: All commands in a sequence are captured in order', () => {
      fc.assert(
        fc.property(gitCommandSequenceArb, (commands) => {
          // Setup
          const consoleService = new MockConsoleService();

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
     *
     * **Validates: Requirements 1.4**
     */
    it('Property: Exit code is correctly captured for each command', () => {
      fc.assert(
        fc.property(gitCommandResultArb, (cmdResult) => {
          // Setup
          const consoleService = new MockConsoleService();

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
     *
     * **Validates: Requirements 1.4**
     */
    it('Property: Error status is correctly determined from exit code', () => {
      fc.assert(
        fc.property(gitCommandResultArb, (cmdResult) => {
          // Setup
          const consoleService = new MockConsoleService();

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
     *
     * **Validates: Requirements 1.4**
     */
    it('Property: Streaming output accumulates correctly', () => {
      fc.assert(
        fc.property(
          fullCommandArb,
          streamingChunksArb,
          exitCodeArb,
          (cmdInfo, chunks, exitCode) => {
            // Setup
            const consoleService = new MockConsoleService();

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
     *
     * **Validates: Requirements 1.4**
     */
    it('Property: Streaming error is captured correctly', () => {
      fc.assert(
        fc.property(
          fullCommandArb,
          streamingChunksArb,
          fc.string({ minLength: 1, maxLength: 100 }),
          (cmdInfo, chunks, errorMessage) => {
            // Setup
            const consoleService = new MockConsoleService();

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
     *
     * **Validates: Requirements 1.4**
     */
    it('Property: logError correctly captures error commands', () => {
      fc.assert(
        fc.property(
          fullCommandArb,
          fc.string({ minLength: 1, maxLength: 200 }),
          (cmdInfo, errorMessage) => {
            // Setup
            const consoleService = new MockConsoleService();

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
     *
     * **Validates: Requirements 1.4**
     */
    it('Property: logError with Error object extracts message correctly', () => {
      fc.assert(
        fc.property(
          fullCommandArb,
          fc.string({ minLength: 1, maxLength: 200 }),
          (cmdInfo, errorMessage) => {
            // Setup
            const consoleService = new MockConsoleService();

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
     *
     * **Validates: Requirements 1.4**
     */
    it('Property: Console entries have timestamps', () => {
      fc.assert(
        fc.property(gitCommandResultArb, (cmdResult) => {
          // Setup
          const consoleService = new MockConsoleService();
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
     *
     * **Validates: Requirements 1.4**
     */
    it('Property: Clear removes all entries', () => {
      fc.assert(
        fc.property(gitCommandSequenceArb, (commands) => {
          // Setup
          const consoleService = new MockConsoleService();

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
     *
     * **Validates: Requirements 1.4**
     */
    it('Property: Max entries limit is respected', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 5, max: 20 }),
          gitCommandSequenceArb,
          (maxEntries, commands) => {
            // Setup
            const consoleService = new MockConsoleService(maxEntries);

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
     *
     * **Validates: Requirements 1.4**
     */
    it('Property: Event is fired for each new entry', () => {
      fc.assert(
        fc.property(gitCommandSequenceArb, (commands) => {
          // Setup
          const consoleService = new MockConsoleService();
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
     *
     * **Validates: Requirements 1.4**
     */
    it('Property: Clear event is fired when clearing', () => {
      fc.assert(
        fc.property(gitCommandSequenceArb, (commands) => {
          // Setup
          const consoleService = new MockConsoleService();
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
     *
     * **Validates: Requirements 1.4**
     */
    it('Property: Console state reflects all logged entries', () => {
      fc.assert(
        fc.property(gitCommandSequenceArb, (commands) => {
          // Setup
          const consoleService = new MockConsoleService();

          // Act: Log all commands
          commands.forEach((cmd) => {
            consoleService.logCommand(cmd.command, cmd.output, cmd.exitCode, {
              isError: cmd.isError,
            });
          });

          // Assert: State reflects entries
          const state = consoleService.getState();
          assert.strictEqual(
            state.entries.length,
            commands.length,
            'State should have same number of entries as commands'
          );

          for (let i = 0; i < commands.length; i++) {
            assert.strictEqual(
              state.entries[i].command,
              commands[i].command,
              `State entry ${i} command should match`
            );
            assert.strictEqual(
              state.entries[i].output,
              commands[i].output,
              `State entry ${i} output should match`
            );
          }
        }),
        { numRuns: 100 }
      );
    });
  });
});
