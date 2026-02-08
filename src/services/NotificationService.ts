/**
 * Notification Service implementation.
 * Provides notification functionality for Git operations including progress,
 * success, and error notifications.
 *
 * Requirements: 17.8, Error handling scenarios
 */

import * as vscode from 'vscode';
import {
  INotificationService,
  IProgressOptions,
  IProgressReport,
  NotificationAction,
  GitOperationType,
} from './interfaces/INotificationService';
import {
  categorizeGitError,
  formatErrorForLogging,
  GitErrorCategory,
  IGitError,
  IRecoveryAction,
} from '../utils/errorHandler';

/**
 * Default timeout for status bar messages in milliseconds
 */
const DEFAULT_STATUS_MESSAGE_TIMEOUT = 5000;

/**
 * Operation-specific titles for progress notifications
 */
const OPERATION_TITLES: Record<GitOperationType, string> = {
  fetch: 'Fetching from remote...',
  pull: 'Pulling changes...',
  push: 'Pushing changes...',
  clone: 'Cloning repository...',
  checkout: 'Checking out...',
  merge: 'Merging branches...',
  rebase: 'Rebasing...',
  stash: 'Stashing changes...',
  commit: 'Committing changes...',
  'cherry-pick': 'Cherry-picking commits...',
  revert: 'Reverting commits...',
  tag: 'Managing tags...',
  branch: 'Managing branches...',
  other: 'Git operation in progress...',
};

/**
 * Operation-specific success messages
 */
const OPERATION_SUCCESS_MESSAGES: Record<GitOperationType, string> = {
  fetch: 'Successfully fetched from remote',
  pull: 'Successfully pulled changes',
  push: 'Successfully pushed changes',
  clone: 'Successfully cloned repository',
  checkout: 'Successfully checked out',
  merge: 'Successfully merged branches',
  rebase: 'Successfully rebased',
  stash: 'Successfully stashed changes',
  commit: 'Successfully committed changes',
  'cherry-pick': 'Successfully cherry-picked commits',
  revert: 'Successfully reverted commits',
  tag: 'Tag operation completed successfully',
  branch: 'Branch operation completed successfully',
  other: 'Operation completed successfully',
};

/**
 * Operation-specific error message prefixes
 */
const OPERATION_ERROR_PREFIXES: Record<GitOperationType, string> = {
  fetch: 'Failed to fetch',
  pull: 'Failed to pull',
  push: 'Failed to push',
  clone: 'Failed to clone',
  checkout: 'Failed to checkout',
  merge: 'Failed to merge',
  rebase: 'Failed to rebase',
  stash: 'Failed to stash',
  commit: 'Failed to commit',
  'cherry-pick': 'Failed to cherry-pick',
  revert: 'Failed to revert',
  tag: 'Tag operation failed',
  branch: 'Branch operation failed',
  other: 'Operation failed',
};

/**
 * Notification Service implementation.
 * Manages notifications for Git operations including progress, success, and error messages.
 *
 * Requirements:
 * - 17.8: Display progress and status notifications similar to IntelliJ
 * - Error handling: Provide user-friendly error messages with recovery suggestions
 */
export class NotificationService implements INotificationService {
  private _disposables: vscode.Disposable[] = [];
  private _outputChannel: vscode.OutputChannel;

  constructor() {
    this._outputChannel = vscode.window.createOutputChannel('IntelliG');
    this._disposables.push(this._outputChannel);
  }

  /**
   * Show an information notification.
   *
   * @param message - The message to display
   * @param actions - Optional action buttons
   * @returns Promise resolving to the selected action or undefined
   */
  async showInfo(message: string, ...actions: string[]): Promise<NotificationAction> {
    return vscode.window.showInformationMessage(message, ...actions);
  }

  /**
   * Show a warning notification.
   *
   * @param message - The message to display
   * @param actions - Optional action buttons
   * @returns Promise resolving to the selected action or undefined
   */
  async showWarning(message: string, ...actions: string[]): Promise<NotificationAction> {
    return vscode.window.showWarningMessage(message, ...actions);
  }

  /**
   * Show an error notification.
   *
   * @param message - The message to display
   * @param actions - Optional action buttons
   * @returns Promise resolving to the selected action or undefined
   */
  async showError(message: string, ...actions: string[]): Promise<NotificationAction> {
    return vscode.window.showErrorMessage(message, ...actions);
  }

  /**
   * Show a success notification for a completed Git operation.
   *
   * @param operation - The type of Git operation that completed
   * @param message - Optional custom message (defaults to operation-specific message)
   */
  showSuccess(operation: GitOperationType, message?: string): void {
    const displayMessage = message || OPERATION_SUCCESS_MESSAGES[operation];
    void vscode.window.showInformationMessage(displayMessage);
  }

  /**
   * Show an error notification for a failed Git operation.
   * Uses the centralized error handler to categorize errors and provide recovery suggestions.
   *
   * @param operation - The type of Git operation that failed
   * @param error - The error that occurred
   * @param actions - Optional action buttons
   * @returns Promise resolving to the selected action or undefined
   */
  async showOperationError(
    operation: GitOperationType,
    error: Error | string,
    ...actions: string[]
  ): Promise<NotificationAction> {
    // Categorize the error for better messaging
    const gitError = categorizeGitError(error);

    // Log the error for debugging
    this.logError(error);

    // Build the error message
    const prefix = OPERATION_ERROR_PREFIXES[operation];
    const fullMessage = `${prefix}: ${gitError.message}`;

    // Add recovery actions to the action buttons if not already provided
    const allActions = [...actions];
    if (gitError.recoveryActions && gitError.recoveryActions.length > 0) {
      for (const action of gitError.recoveryActions) {
        if (!allActions.includes(action.label)) {
          allActions.push(action.label);
        }
      }
    }

    // Always add "Show Details" option for debugging
    if (!allActions.includes('Show Details')) {
      allActions.push('Show Details');
    }

    const result = await vscode.window.showErrorMessage(fullMessage, ...allActions);

    // Handle special actions
    if (result === 'Show Details') {
      this.showErrorDetails(gitError);
      return result;
    }

    // Execute command if the selected action has one
    if (result && gitError.recoveryActions) {
      const selectedAction = gitError.recoveryActions.find((a) => a.label === result);
      if (selectedAction?.commandId) {
        await vscode.commands.executeCommand(
          selectedAction.commandId,
          ...(selectedAction.commandArgs || [])
        );
      }
    }

    return result;
  }

  /**
   * Show a categorized Git error with appropriate recovery suggestions.
   * This is a more detailed error display method that shows the full error context.
   *
   * @param error - The error to display
   * @param operation - Optional operation type for context
   * @returns Promise resolving to the selected action or undefined
   */
  async showGitError(
    error: Error | string,
    _operation?: GitOperationType
  ): Promise<NotificationAction> {
    const gitError = categorizeGitError(error);

    // Log the error
    this.logError(error);

    // Build action buttons based on error category
    const actions = this.getActionsForCategory(gitError.category, gitError.recoveryActions);

    // Show the error with appropriate severity
    let result: NotificationAction;
    if (
      gitError.category === GitErrorCategory.Conflict ||
      gitError.category === GitErrorCategory.UncommittedChanges
    ) {
      // These are warnings that require user action but aren't critical errors
      result = await vscode.window.showWarningMessage(gitError.message, ...actions);
    } else {
      result = await vscode.window.showErrorMessage(gitError.message, ...actions);
    }

    // Handle the selected action
    await this.handleErrorAction(result, gitError);

    return result;
  }

  /**
   * Log an error to the output channel for debugging.
   *
   * @param error - The error to log
   */
  logError(error: Error | string): void {
    const formattedError = formatErrorForLogging(error);
    const timestamp = new Date().toISOString();
    this._outputChannel.appendLine(`[${timestamp}] ${formattedError}`);
    this._outputChannel.appendLine('---');
  }

  /**
   * Show detailed error information in the output channel.
   *
   * @param gitError - The categorized Git error
   */
  private showErrorDetails(gitError: IGitError): void {
    this._outputChannel.show();
    this._outputChannel.appendLine('=== Error Details ===');
    this._outputChannel.appendLine(`Category: ${gitError.category}`);
    this._outputChannel.appendLine(`Message: ${gitError.message}`);
    if (gitError.details) {
      this._outputChannel.appendLine(`Details: ${gitError.details}`);
    }
    if (gitError.recoveryActions && gitError.recoveryActions.length > 0) {
      this._outputChannel.appendLine('Recovery Suggestions:');
      for (const action of gitError.recoveryActions) {
        this._outputChannel.appendLine(`  - ${action.label}: ${action.description || ''}`);
      }
    }
    this._outputChannel.appendLine('=====================');
  }

  /**
   * Get action buttons appropriate for the error category.
   *
   * @param category - The error category
   * @param recoveryActions - Recovery actions from the error
   * @returns Array of action button labels
   */
  private getActionsForCategory(
    category: GitErrorCategory,
    recoveryActions?: IRecoveryAction[]
  ): string[] {
    const actions: string[] = [];

    // Add recovery actions
    if (recoveryActions) {
      for (const action of recoveryActions.slice(0, 3)) {
        // Limit to 3 actions
        actions.push(action.label);
      }
    }

    // Add category-specific default actions
    switch (category) {
      case GitErrorCategory.Network:
        if (!actions.includes('Retry')) {
          actions.push('Retry');
        }
        break;
      case GitErrorCategory.Authentication:
        if (!actions.includes('Configure Credentials')) {
          actions.push('Configure Credentials');
        }
        break;
      case GitErrorCategory.Conflict:
        if (!actions.includes('Open Merge Tool')) {
          actions.push('Open Merge Tool');
        }
        break;
      case GitErrorCategory.UncommittedChanges:
        if (!actions.includes('Stash Changes')) {
          actions.push('Stash Changes');
        }
        break;
    }

    // Always add Show Details
    if (!actions.includes('Show Details')) {
      actions.push('Show Details');
    }

    return actions;
  }

  /**
   * Handle the user's selected action from an error notification.
   *
   * @param action - The selected action
   * @param gitError - The Git error
   */
  private async handleErrorAction(action: NotificationAction, gitError: IGitError): Promise<void> {
    if (!action) {
      return;
    }

    if (action === 'Show Details') {
      this.showErrorDetails(gitError);
      return;
    }

    // Find and execute the recovery action command
    if (gitError.recoveryActions) {
      const selectedAction = gitError.recoveryActions.find((a) => a.label === action);
      if (selectedAction?.commandId) {
        try {
          await vscode.commands.executeCommand(
            selectedAction.commandId,
            ...(selectedAction.commandArgs || [])
          );
        } catch (cmdError) {
          // Log command execution errors
          this.logError(cmdError instanceof Error ? cmdError : new Error(String(cmdError)));
        }
      }
    }
  }

  /**
   * Show a progress notification for a long-running operation.
   * The operation runs within the progress context and can report progress updates.
   *
   * @param options - Progress notification options
   * @param task - The async task to run with progress reporting
   * @returns Promise resolving to the task result
   */
  async withProgress<T>(
    options: IProgressOptions,
    task: (
      progress: vscode.Progress<IProgressReport>,
      token: vscode.CancellationToken
    ) => Promise<T>
  ): Promise<T> {
    const progressOptions: vscode.ProgressOptions = {
      title: options.title,
      cancellable: options.cancellable ?? false,
      location: options.location ?? vscode.ProgressLocation.Notification,
    };

    return vscode.window.withProgress(progressOptions, task);
  }

  /**
   * Show a progress notification for a Git operation.
   * Provides a simplified interface for common Git operations.
   *
   * @param operation - The type of Git operation
   * @param task - The async task to run
   * @param cancellable - Whether the operation can be cancelled (default: false)
   * @returns Promise resolving to the task result
   */
  async withOperationProgress<T>(
    operation: GitOperationType,
    task: (
      progress: vscode.Progress<IProgressReport>,
      token: vscode.CancellationToken
    ) => Promise<T>,
    cancellable: boolean = false
  ): Promise<T> {
    const title = OPERATION_TITLES[operation];

    return this.withProgress(
      {
        title,
        cancellable,
        location: vscode.ProgressLocation.Notification,
      },
      task
    );
  }

  /**
   * Show a status bar message that auto-hides after a timeout.
   *
   * @param message - The message to display
   * @param timeout - Timeout in milliseconds (default: 5000)
   * @returns Disposable to hide the message early
   */
  showStatusMessage(
    message: string,
    timeout: number = DEFAULT_STATUS_MESSAGE_TIMEOUT
  ): vscode.Disposable {
    return vscode.window.setStatusBarMessage(message, timeout);
  }

  /**
   * Dispose of the notification service and its resources.
   */
  dispose(): void {
    for (const disposable of this._disposables) {
      disposable.dispose();
    }
    this._disposables = [];
  }
}

/**
 * Create a new NotificationService instance.
 *
 * @returns A new NotificationService instance
 */
export function createNotificationService(): NotificationService {
  return new NotificationService();
}
