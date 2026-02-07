/**
 * Console Service interface.
 * Captures and displays Git command output in the Console View.
 * Implements real-time output streaming for Git operations.
 *
 * Requirement 1.4: Console View displays command and output in real-time
 */

import * as vscode from 'vscode';
import { IConsoleEntry } from './IGitToolWindowProvider';

/**
 * Options for logging a command to the console
 */
export interface IConsoleLogOptions {
  /** Whether to show the console tab after logging */
  showConsole?: boolean;
  /** Whether this is an error output */
  isError?: boolean;
}

/**
 * Streaming output handler for real-time output display
 */
export interface IStreamingOutputHandler {
  /** Called when new output data is received */
  onData(data: string): void;
  /** Called when the command completes */
  onComplete(exitCode: number): void;
  /** Called when an error occurs */
  onError(error: Error): void;
}

/**
 * Console Service interface.
 * Provides functionality for capturing and displaying Git command output.
 */
export interface IConsoleService {
  /**
   * Log a Git command and its output to the console.
   *
   * @param command - The Git command that was executed (e.g., 'git status')
   * @param output - The command output
   * @param exitCode - The exit code of the command (optional)
   * @param options - Additional logging options
   */
  logCommand(
    command: string,
    output: string,
    exitCode?: number,
    options?: IConsoleLogOptions
  ): void;

  /**
   * Log an error to the console.
   *
   * @param command - The Git command that failed
   * @param error - The error message or Error object
   */
  logError(command: string, error: string | Error): void;

  /**
   * Start streaming output for a command.
   * Returns a handler that can be used to send output data in real-time.
   *
   * @param command - The Git command being executed
   * @returns A streaming output handler
   */
  startStreaming(command: string): IStreamingOutputHandler;

  /**
   * Clear all console entries.
   */
  clear(): void;

  /**
   * Get all console entries.
   *
   * @returns Array of console entries
   */
  getEntries(): IConsoleEntry[];

  /**
   * Show the console tab in the Git Tool Window.
   */
  showConsole(): void;

  /**
   * Event fired when a new entry is added to the console.
   */
  onDidAddEntry: vscode.Event<IConsoleEntry>;

  /**
   * Event fired when the console is cleared.
   */
  onDidClear: vscode.Event<void>;

  /**
   * Dispose of resources.
   */
  dispose(): void;
}
