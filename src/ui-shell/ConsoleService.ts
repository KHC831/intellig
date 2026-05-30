/**
 * Console Service implementation.
 * Captures and displays Git command output in the Console View.
 * Implements real-time output streaming for Git operations.
 */

import * as vscode from 'vscode';
import {
  IConsoleService,
  IConsoleLogOptions,
  IStreamingOutputHandler,
  IConsoleEntry,
  IGitToolWindowProvider,
} from '../services/interfaces';
import { GitCli, IGitCommandResult } from '../git-core/gitCli';

/**
 * Default maximum number of console entries to keep
 */
const DEFAULT_MAX_ENTRIES = 1000;

/**
 * Console Service implementation.
 * Connects GitCli command execution to the Console View for real-time output display.
 */
export class ConsoleService implements IConsoleService {
  private _entries: IConsoleEntry[] = [];
  private _maxEntries: number;
  private _disposables: vscode.Disposable[] = [];
  private _gitToolWindowProvider: IGitToolWindowProvider | undefined;

  // Event emitters
  private readonly _onDidAddEntry = new vscode.EventEmitter<IConsoleEntry>();
  private readonly _onDidClear = new vscode.EventEmitter<void>();

  // Public events
  public readonly onDidAddEntry = this._onDidAddEntry.event;
  public readonly onDidClear = this._onDidClear.event;

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this._maxEntries = maxEntries;

    // Register event emitters for disposal
    this._disposables.push(this._onDidAddEntry, this._onDidClear);
  }

  /**
   * Connect to a GitCli instance to capture command output.
   * This sets up automatic logging of all Git commands executed through the CLI.
   *
   * @param gitCli - The GitCli instance to connect to
   */
  public connectToGitCli(gitCli: GitCli): void {
    const subscription = gitCli.onCommandExecuted((event) => {
      this._handleGitCommandExecuted(event.command, event.args, event.result);
    });
    this._disposables.push(subscription);
  }

  /**
   * Connect to a GitToolWindowProvider to update the Console View.
   *
   * @param provider - The GitToolWindowProvider instance
   */
  public connectToToolWindow(provider: IGitToolWindowProvider): void {
    this._gitToolWindowProvider = provider;

    // Sync existing entries to the provider
    this._entries.forEach((entry) => {
      provider.addConsoleEntry({
        command: entry.command,
        output: entry.output,
        exitCode: entry.exitCode,
        isError: entry.isError,
      });
    });
  }

  /**
   * Handle Git command execution event from GitCli.
   */
  private _handleGitCommandExecuted(
    command: string,
    args: string[],
    result: IGitCommandResult
  ): void {
    const fullCommand = `${command} ${args.join(' ')}`;
    const isError = result.exitCode !== 0;
    const output = result.combined || result.stdout || result.stderr || '';

    this.logCommand(fullCommand, output, result.exitCode, { isError });
  }

  /**
   * Log a Git command and its output to the console.
   */
  public logCommand(
    command: string,
    output: string,
    exitCode?: number,
    options: IConsoleLogOptions = {}
  ): void {
    const entry: IConsoleEntry = {
      timestamp: new Date(),
      command,
      output,
      exitCode,
      isError: options.isError ?? (exitCode !== undefined && exitCode !== 0),
    };

    this._addEntry(entry);

    if (options.showConsole) {
      this.showConsole();
    }
  }

  /**
   * Log an error to the console.
   */
  public logError(command: string, error: string | Error): void {
    const errorMessage = error instanceof Error ? error.message : error;

    this.logCommand(command, errorMessage, 1, { isError: true, showConsole: true });
  }

  /**
   * Start streaming output for a command.
   * Returns a handler that can be used to send output data in real-time.
   */
  public startStreaming(command: string): IStreamingOutputHandler {
    // Create a placeholder entry that will be updated as output streams in
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
        // Update the entry with new data
        if (entryIndex < this._entries.length) {
          this._entries[entryIndex].output += data;
          this._updateToolWindowEntry(this._entries[entryIndex]);
        }
      },
      onComplete: (exitCode: number): void => {
        if (entryIndex < this._entries.length) {
          this._entries[entryIndex].exitCode = exitCode;
          this._entries[entryIndex].isError = exitCode !== 0;
          this._updateToolWindowEntry(this._entries[entryIndex]);
        }
      },
      onError: (error: Error): void => {
        if (entryIndex < this._entries.length) {
          this._entries[entryIndex].output += `\nError: ${error.message}`;
          this._entries[entryIndex].isError = true;
          this._entries[entryIndex].exitCode = 1;
          this._updateToolWindowEntry(this._entries[entryIndex]);
        }
      },
    };
  }

  /**
   * Clear all console entries.
   */
  public clear(): void {
    this._entries = [];

    if (this._gitToolWindowProvider) {
      this._gitToolWindowProvider.clearConsole();
    }

    this._onDidClear.fire();
  }

  /**
   * Get all console entries.
   */
  public getEntries(): IConsoleEntry[] {
    return [...this._entries];
  }

  /**
   * Show the console tab in the Git Tool Window.
   * Note: In the 2-panel layout, the console is no longer a separate tab.
   * This method is preserved for backward compatibility but is a no-op.
   */
  public showConsole(): void {
    // No-op: console tab removed in 2-panel layout migration
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

    // Update the tool window provider
    if (this._gitToolWindowProvider) {
      this._gitToolWindowProvider.addConsoleEntry({
        command: entry.command,
        output: entry.output,
        exitCode: entry.exitCode,
        isError: entry.isError,
      });
    }

    this._onDidAddEntry.fire(entry);
  }

  /**
   * Update an entry in the tool window (for streaming updates).
   * Note: This triggers a full refresh since we can't update individual entries.
   */
  private _updateToolWindowEntry(_entry: IConsoleEntry): void {
    if (this._gitToolWindowProvider) {
      // For streaming updates, we need to refresh the view
      // The provider will re-render with the updated entries
      this._gitToolWindowProvider.refresh();
    }
  }

  /**
   * Dispose of resources.
   */
  public dispose(): void {
    this._disposables.forEach((d: vscode.Disposable) => {
      d.dispose();
    });
    this._disposables = [];
    this._entries = [];
    this._gitToolWindowProvider = undefined;
  }
}

/**
 * Create a new ConsoleService instance.
 *
 * @param maxEntries - Maximum number of entries to keep (default: 1000)
 * @returns A new ConsoleService instance
 */
export function createConsoleService(maxEntries?: number): ConsoleService {
  return new ConsoleService(maxEntries);
}
