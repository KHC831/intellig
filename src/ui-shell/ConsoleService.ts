/**
 * Console Service implementation.
 * Captures and displays Git command output in the Console View and mirrors it
 * to a VS Code OutputChannel ("IntelliG Git Console"), the analog of IntelliJ's
 * Version Control Console (git4idea `GitVcsConsoleWriter`). Implements real-time
 * output streaming for Git operations.
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
import { sanitizeGitError } from '../git-core/gitError';

/**
 * Default maximum number of console entries to keep
 */
const DEFAULT_MAX_ENTRIES = 1000;

/**
 * Name of the VS Code OutputChannel that mirrors IntelliJ's Version Control
 * Console. Appears in the `Output` panel dropdown.
 */
const CONSOLE_CHANNEL_NAME = 'IntelliG Git Console';

/**
 * Per-entry output cap, matching IntelliJ
 * `GitVcsConsoleWriter.MAX_CONSOLE_OUTPUT_SIZE`. gitCli permits far more (its
 * own limit is in the MiB range), and the tool-window console renders every
 * stored byte into the DOM — one big `git diff` was enough to lock the webview.
 */
const MAX_ENTRY_OUTPUT = 10000;

/**
 * Head/tail split of the retained text, and the length past which eliding is
 * worth it. Both mirror IntelliJ's chunked `showMessage`: a 30% head and 70%
 * tail, and no elision until 1.2x the cap so a marginally-over output is kept
 * whole rather than losing content to save a few hundred characters.
 */
const HEAD_FRACTION = 0.3;
const ELISION_THRESHOLD = MAX_ENTRY_OUTPUT * 1.2;

/**
 * Cap one entry's output, keeping the head and the tail around a marker.
 *
 * The tail matters as much as the head: git puts the failure reason at the end
 * of a long run, so a head-only truncation would drop the very line the console
 * exists to show. Exported for the specs that pin the boundary behaviour.
 */
export function capConsoleOutput(output: string): string {
  if (output.length <= ELISION_THRESHOLD) {
    return output;
  }
  const headLength = Math.floor(MAX_ENTRY_OUTPUT * HEAD_FRACTION);
  const tailLength = MAX_ENTRY_OUTPUT - headLength;
  const elided = output.length - headLength - tailLength;
  return (
    `${output.slice(0, headLength)}\n… ${elided} characters truncated …\n` +
    `${output.slice(output.length - tailLength)}`
  );
}

/**
 * Console Service implementation.
 * Connects GitCli command execution to the Console View for real-time output display.
 */
export class ConsoleService implements IConsoleService {
  private _entries: IConsoleEntry[] = [];
  private _maxEntries: number;
  private _disposables: vscode.Disposable[] = [];
  private _gitToolWindowProvider: IGitToolWindowProvider | undefined;

  // VS Code OutputChannel surface (IntelliJ VCS Console analog). Created
  // lazily on first write/reveal unless one is injected (for tests). A
  // self-created channel is owned by this service and disposed with it; an
  // injected channel is owned by the caller and left alone on dispose.
  private _outputChannel: vscode.OutputChannel | undefined;
  private readonly _ownsChannel: boolean;

  // Event emitters
  private readonly _onDidAddEntry = new vscode.EventEmitter<IConsoleEntry>();
  private readonly _onDidClear = new vscode.EventEmitter<void>();

  // Public events
  public readonly onDidAddEntry = this._onDidAddEntry.event;
  public readonly onDidClear = this._onDidClear.event;

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES, outputChannel?: vscode.OutputChannel) {
    this._maxEntries = maxEntries;
    this._outputChannel = outputChannel;
    this._ownsChannel = outputChannel === undefined;

    // Register event emitters for disposal
    this._disposables.push(this._onDidAddEntry, this._onDidClear);
  }

  /**
   * Lazily obtain the OutputChannel surface. A self-created channel is
   * created on first access (creating it eagerly would add an empty entry
   * to the `Output` dropdown even when no git command ever runs).
   */
  private _getOutputChannel(): vscode.OutputChannel {
    if (!this._outputChannel) {
      this._outputChannel = vscode.window.createOutputChannel(CONSOLE_CHANNEL_NAME);
    }
    return this._outputChannel;
  }

  /**
   * Format a timestamp as `HH:mm:ss.SSS`, matching IntelliJ
   * `GitVcsConsoleWriter.showCommandLine`.
   */
  private _formatTimestamp(date: Date): string {
    const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
    return (
      `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
      `.${pad(date.getMilliseconds(), 3)}`
    );
  }

  /**
   * Write the executed command line to the OutputChannel, mirroring
   * IntelliJ's SYSTEM_OUTPUT command-line category (`timestamp: command`).
   */
  private _writeCommandLine(timestamp: Date, command: string): void {
    this._getOutputChannel().appendLine(`${this._formatTimestamp(timestamp)}: ${command}`);
  }

  /**
   * Write command output to the OutputChannel. VS Code OutputChannels are
   * plain-text and cannot colour lines, so IntelliJ's NORMAL_OUTPUT and
   * ERROR_OUTPUT categories both render as plain lines here; the error/normal
   * distinction is preserved on the entry's `isError` flag (see getEntries).
   */
  private _writeOutput(output: string): void {
    if (!output) {
      return;
    }
    // Strip a single trailing newline so appendLine doesn't add a blank gap
    // between entries when git output already ends in "\n".
    this._getOutputChannel().appendLine(output.replace(/\n$/, ''));
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
   *
   * Both the command line and the output are scrubbed through
   * `sanitizeGitError` before they are stored or mirrored. git embeds
   * credentials in remote URLs that surface in the command args and in
   * stderr on auth failure; the console event fires for every exit code
   * (including unattended auto-fetch failures), so this is the single
   * sink-side seam that keeps a PAT out of the OutputChannel, the
   * tool-window console, and the stored entries.
   */
  public logCommand(
    command: string,
    output: string,
    exitCode?: number,
    options: IConsoleLogOptions = {}
  ): void {
    const entry: IConsoleEntry = {
      timestamp: new Date(),
      command: sanitizeGitError(command),
      output: capConsoleOutput(sanitizeGitError(output)),
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
    // Create a placeholder entry that will be updated as output streams in.
    // Scrub the command line at entry — same sink-side guarantee as
    // logCommand: _addEntry mirrors it to the OutputChannel + tool window and
    // stores it, so a credential-bearing remote URL must never land raw.
    const entry: IConsoleEntry = {
      timestamp: new Date(),
      command: sanitizeGitError(command),
      output: '',
      isError: false,
    };

    const entryIndex = this._entries.length;
    this._addEntry(entry);

    return {
      onData: (data: string): void => {
        // Update the entry with new data. Scrubbed per-chunk: a credential
        // split across two chunks can evade the regex, so streaming callers
        // should prefer whole-command logging — this is defense-in-depth.
        if (entryIndex < this._entries.length) {
          const safe = sanitizeGitError(data);
          this._entries[entryIndex].output += safe;
          this._getOutputChannel().append(safe);
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
          const message = `\nError: ${sanitizeGitError(error.message)}`;
          this._entries[entryIndex].output += message;
          this._entries[entryIndex].isError = true;
          this._entries[entryIndex].exitCode = 1;
          this._getOutputChannel().append(message);
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
   * Reveal the Git Console OutputChannel, mirroring IntelliJ's "open the VCS
   * Console" action. Brings the `Output` panel forward focused on this
   * service's channel.
   */
  public showConsole(): void {
    this._getOutputChannel().show();
  }

  /**
   * Add an entry to the console.
   */
  private _addEntry(entry: IConsoleEntry): void {
    this._entries.push(entry);

    // Mirror to the OutputChannel surface: the command line, then any output
    // already captured. Streaming entries start with empty output and append
    // their chunks later via the streaming handler, so nothing is duplicated.
    this._writeCommandLine(entry.timestamp, entry.command);
    this._writeOutput(entry.output);

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

    // Only dispose a channel we created; an injected channel is owned by the
    // caller and may outlive this service.
    if (this._ownsChannel) {
      this._outputChannel?.dispose();
    }
    this._outputChannel = undefined;
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
