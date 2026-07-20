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
const HEAD_LENGTH = Math.floor(MAX_ENTRY_OUTPUT * HEAD_FRACTION);
const TAIL_LENGTH = MAX_ENTRY_OUTPUT - HEAD_LENGTH;

/** Render the elision marker for a given dropped-character count. */
function elisionMarker(elided: number): string {
  return `\n… ${elided} characters truncated …\n`;
}

/**
 * Slice helpers that never split a surrogate pair. `slice` counts UTF-16 code
 * units, so cutting mid-pair leaves a lone surrogate that renders as U+FFFD;
 * git output carrying emoji or non-BMP text hits this readily.
 */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function headSlice(value: string, length: number): string {
  const cut = value.slice(0, length);
  return cut.length > 0 && isHighSurrogate(cut.charCodeAt(cut.length - 1)) ? cut.slice(0, -1) : cut;
}

function tailSlice(value: string, length: number): string {
  const cut = value.slice(Math.max(0, value.length - length));
  return cut.length > 0 && isLowSurrogate(cut.charCodeAt(0)) ? cut.slice(1) : cut;
}

/**
 * Trailing-edge window for coalescing streaming refreshes. Long enough that a
 * burst of chunks collapses into one re-render, short enough to still read as
 * real-time output.
 */
const STREAM_REFRESH_INTERVAL_MS = 16;

/** Handler returned by startStreaming after dispose: accepts and drops. */
const INERT_STREAMING_HANDLER: IStreamingOutputHandler = {
  onData: () => undefined,
  onComplete: () => undefined,
  onError: () => undefined,
};

/** Sink used after dispose so late writers cannot resurrect a real channel. */
const INERT_OUTPUT_CHANNEL: vscode.OutputChannel = {
  name: CONSOLE_CHANNEL_NAME,
  append: () => undefined,
  appendLine: () => undefined,
  replace: () => undefined,
  clear: () => undefined,
  show: () => undefined,
  hide: () => undefined,
  dispose: () => undefined,
} as unknown as vscode.OutputChannel;

/**
 * Cap one entry's output, keeping the head and the tail around a marker.
 *
 * The tail matters as much as the head: git puts the failure reason at the end
 * of a long run, so a head-only truncation would drop the very line the console
 * exists to show. Applied on every write that grows an entry, including each
 * streamed chunk, so a long-running clone cannot grow the entry without bound.
 */
export function capConsoleOutput(output: string): string {
  if (output.length <= ELISION_THRESHOLD) {
    return output;
  }
  const head = headSlice(output, HEAD_LENGTH);
  const tail = tailSlice(output, TAIL_LENGTH);
  return `${head}${elisionMarker(output.length - head.length - tail.length)}${tail}`;
}

/**
 * Accumulator for a streaming entry's output.
 *
 * Capping each append against the previous CAPPED value would make the marker
 * count only the newest growth, so a 5 MB clone reported a few thousand
 * characters truncated. This keeps a fixed head, a rolling tail, and a running
 * total of everything dropped, so the marker stays true for the whole stream.
 */
class StreamingOutputBuffer {
  private _raw = '';
  private _head = '';
  private _tail = '';
  private _elided = 0;
  private _eliding = false;

  append(text: string): string {
    if (!this._eliding) {
      this._raw += text;
      if (this._raw.length <= ELISION_THRESHOLD) {
        return this._raw;
      }
      this._head = headSlice(this._raw, HEAD_LENGTH);
      this._tail = tailSlice(this._raw, TAIL_LENGTH);
      this._elided = this._raw.length - this._head.length - this._tail.length;
      this._eliding = true;
      this._raw = '';
      return this._render();
    }
    const combined = this._tail + text;
    if (combined.length > TAIL_LENGTH) {
      const kept = tailSlice(combined, TAIL_LENGTH);
      this._elided += combined.length - kept.length;
      this._tail = kept;
    } else {
      this._tail = combined;
    }
    return this._render();
  }

  private _render(): string {
    return `${this._head}${elisionMarker(this._elided)}${this._tail}`;
  }
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
  private _pendingRefresh: ReturnType<typeof setTimeout> | undefined;
  private _disposed = false;
  private _streamSequence = 0;
  private readonly _pendingStreamUpdates = new Map<string, IConsoleEntry>();

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
    // A disposed service must never build a channel: dispose() clears
    // `_outputChannel` even when the channel was INJECTED, so a late write
    // would create a self-made one that `_ownsChannel === false` guarantees is
    // never disposed. Every writer routes through here, so this is the choke
    // point rather than a check repeated per call site.
    if (this._disposed) {
      return INERT_OUTPUT_CHANNEL;
    }
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
    // _disposables has already been drained, so a subscription pushed now
    // would never be unregistered and would pin this service to the emitter.
    if (this._disposed) {
      return;
    }
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
    if (this._disposed) {
      return;
    }
    this._gitToolWindowProvider = provider;

    // Replay the retained entries. The provider is cleared first so a
    // re-registration (tool-window reload) rebuilds the console rather than
    // appending a second copy of every entry.
    provider.clearConsole();
    this._entries.forEach((entry) => {
      provider.addConsoleEntry({
        command: entry.command,
        output: entry.output,
        exitCode: entry.exitCode,
        isError: entry.isError,
        id: entry.id,
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
    this._streamSequence++;
    const entry: IConsoleEntry = {
      timestamp: new Date(),
      command: sanitizeGitError(command),
      output: '',
      isError: false,
      id: `stream-${this._streamSequence}`,
    };

    if (this._disposed) {
      return INERT_STREAMING_HANDLER;
    }
    const buffer = new StreamingOutputBuffer();
    this._addEntry(entry);

    // The handler holds the entry OBJECT, not its index: `_addEntry` trims via
    // shift() and `clear()` empties the array, so any index captured here goes
    // stale and would address an unrelated command's entry.
    //
    // A stream can outlive the service, so each callback also checks
    // `_disposed` — that keeps a late chunk from mutating a retired entry or
    // scheduling a refresh. It is NOT what protects the OutputChannel: every
    // writer reaches the channel through `_getOutputChannel()`, which is where
    // that guard lives.
    return {
      onData: (data: string): void => {
        if (this._disposed) {
          return;
        }
        // Update the entry with new data. Scrubbed per-chunk: a credential
        // split across two chunks can evade the regex, so streaming callers
        // should prefer whole-command logging — this is defense-in-depth.
        const safe = sanitizeGitError(data);
        entry.output = buffer.append(safe);
        this._getOutputChannel().append(safe);
        this._updateToolWindowEntry(entry);
      },
      onComplete: (exitCode: number): void => {
        if (this._disposed) {
          return;
        }
        entry.exitCode = exitCode;
        entry.isError = exitCode !== 0;
        this._updateToolWindowEntry(entry);
      },
      onError: (error: Error): void => {
        if (this._disposed) {
          return;
        }
        const message = `\nError: ${sanitizeGitError(error.message)}`;
        entry.output = buffer.append(message);
        entry.isError = true;
        entry.exitCode = 1;
        this._getOutputChannel().append(message);
        this._updateToolWindowEntry(entry);
      },
    };
  }

  /**
   * Clear all console entries.
   */
  public clear(): void {
    this._entries = [];
    this._cancelPendingRefresh();

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
    if (this._disposed) {
      return;
    }
    this._getOutputChannel().show();
  }

  /**
   * Add an entry to the console.
   */
  private _addEntry(entry: IConsoleEntry): void {
    if (this._disposed) {
      return;
    }
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
        id: entry.id,
      });
    }

    this._onDidAddEntry.fire(entry);
  }

  /**
   * Refresh the tool window for a streaming update. The provider has no
   * per-entry update, so this is a full re-render; a chatty `git clone` emits
   * thousands of chunks, so refreshes are coalesced onto one trailing tick
   * rather than fired per chunk.
   */
  private _updateToolWindowEntry(entry: IConsoleEntry): void {
    if (!this._gitToolWindowProvider || this._disposed) {
      return;
    }
    // Coalesce per entry: the provider stores a COPY, so a bare refresh()
    // would re-render the snapshot taken when the stream started (empty) and
    // the streamed bytes would never appear. Push the current output instead.
    this._pendingStreamUpdates.set(entry.id ?? '', entry);
    if (this._pendingRefresh) {
      return;
    }
    this._pendingRefresh = setTimeout(() => {
      this._pendingRefresh = undefined;
      const pending = [...this._pendingStreamUpdates.values()];
      this._pendingStreamUpdates.clear();
      for (const pendingEntry of pending) {
        if (pendingEntry.id) {
          this._gitToolWindowProvider?.updateConsoleEntry({
            id: pendingEntry.id,
            output: pendingEntry.output,
            exitCode: pendingEntry.exitCode,
            isError: pendingEntry.isError,
          });
        }
      }
    }, STREAM_REFRESH_INTERVAL_MS);
  }

  /** Drop any refresh queued by a streaming update. */
  private _cancelPendingRefresh(): void {
    this._pendingStreamUpdates.clear();
    if (this._pendingRefresh) {
      clearTimeout(this._pendingRefresh);
      this._pendingRefresh = undefined;
    }
  }

  /**
   * Dispose of resources.
   */
  public dispose(): void {
    this._disposed = true;
    this._cancelPendingRefresh();
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
