/**
 * Notification Service interface.
 * Provides notification functionality for Git operations.
 */

import * as vscode from 'vscode';

/**
 * Notification types for different message severities
 */
export type NotificationType = 'info' | 'warning' | 'error';

/**
 * Progress notification options
 */
export interface IProgressOptions {
  /** Title displayed in the progress notification */
  title: string;
  /** Whether the operation can be cancelled */
  cancellable?: boolean;
  /** Location of the progress notification */
  location?: vscode.ProgressLocation;
}

/**
 * Progress report for updating progress notifications
 */
export interface IProgressReport {
  /** Message to display (optional) */
  message?: string;
  /** Progress increment (0-100, optional) */
  increment?: number;
}

/**
 * Result of a notification with action buttons
 */
export type NotificationAction = string | undefined;

/**
 * Git operation types for progress notifications
 */
export type GitOperationType =
  | 'fetch'
  | 'pull'
  | 'push'
  | 'clone'
  | 'checkout'
  | 'merge'
  | 'rebase'
  | 'stash'
  | 'commit'
  | 'cherry-pick'
  | 'revert'
  | 'tag'
  | 'branch'
  | 'other';

/**
 * Notification Service interface.
 * Manages notifications for Git operations including progress, success, and error messages.
 *
 * - Display progress and status notifications similar to IntelliJ
 * - Error handling: Provide user-friendly error messages with recovery suggestions
 */
export interface INotificationService {
  /**
   * Show an information notification.
   *
   * @param message - The message to display
   * @param actions - Optional action buttons
   * @returns Promise resolving to the selected action or undefined
   */
  showInfo(message: string, ...actions: string[]): Promise<NotificationAction>;

  /**
   * Show a warning notification.
   *
   * @param message - The message to display
   * @param actions - Optional action buttons
   * @returns Promise resolving to the selected action or undefined
   */
  showWarning(message: string, ...actions: string[]): Promise<NotificationAction>;

  /**
   * Show an error notification.
   *
   * @param message - The message to display
   * @param actions - Optional action buttons
   * @returns Promise resolving to the selected action or undefined
   */
  showError(message: string, ...actions: string[]): Promise<NotificationAction>;

  /**
   * Show a success notification for a completed Git operation.
   *
   * @param operation - The type of Git operation that completed
   * @param message - Optional custom message (defaults to operation-specific message)
   */
  showSuccess(operation: GitOperationType, message?: string): void;

  /**
   * Show an error notification for a failed Git operation.
   * Uses the centralized error handler to categorize errors and provide recovery suggestions.
   *
   * @param operation - The type of Git operation that failed
   * @param error - The error that occurred
   * @param actions - Optional action buttons
   * @returns Promise resolving to the selected action or undefined
   */
  showOperationError(
    operation: GitOperationType,
    error: Error | string,
    ...actions: string[]
  ): Promise<NotificationAction>;

  /**
   * Show a categorized Git error with appropriate recovery suggestions.
   * This is a more detailed error display method that shows the full error context.
   *
   * @param error - The error to display
   * @param operation - Optional operation type for context
   * @returns Promise resolving to the selected action or undefined
   */
  showGitError(error: Error | string, operation?: GitOperationType): Promise<NotificationAction>;

  /**
   * Log an error to the output channel for debugging.
   *
   * @param error - The error to log
   */
  logError(error: Error | string): void;

  /**
   * Show a progress notification for a long-running operation.
   * The operation runs within the progress context and can report progress updates.
   *
   * @param options - Progress notification options
   * @param task - The async task to run with progress reporting
   * @returns Promise resolving to the task result
   */
  withProgress<T>(
    options: IProgressOptions,
    task: (
      progress: vscode.Progress<IProgressReport>,
      token: vscode.CancellationToken
    ) => Promise<T>
  ): Promise<T>;

  /**
   * Show a progress notification for a Git operation.
   * Provides a simplified interface for common Git operations.
   *
   * @param operation - The type of Git operation
   * @param task - The async task to run
   * @param cancellable - Whether the operation can be cancelled (default: false)
   * @returns Promise resolving to the task result
   */
  withOperationProgress<T>(
    operation: GitOperationType,
    task: (
      progress: vscode.Progress<IProgressReport>,
      token: vscode.CancellationToken
    ) => Promise<T>,
    cancellable?: boolean
  ): Promise<T>;

  /**
   * Show a status bar message that auto-hides after a timeout.
   *
   * @param message - The message to display
   * @param timeout - Timeout in milliseconds (default: 5000)
   * @returns Disposable to hide the message early
   */
  showStatusMessage(message: string, timeout?: number): vscode.Disposable;
}
