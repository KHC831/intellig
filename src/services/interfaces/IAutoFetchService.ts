import * as vscode from 'vscode';

/**
 * Reason a pending auto-fetch schedule was cancelled. Surfaced for logging
 * and tests; not consumed by user-visible UI.
 */
export type AutoFetchPauseReason = 'disabled' | 'no-repos' | 'auth-failure' | 'user';

/**
 * Auto-fetch service interface.
 *
 * Periodically fetches all configured remotes across every open repository
 * while the user is working, matching IntelliJ's background-refresh behavior.
 *
 * The scheduler honors `intellig.autoFetchEnabled` and
 * `intellig.autoFetchInterval`, pauses when no repositories are open, and
 * backs off exponentially on transient failures.
 */
export interface IAutoFetchService extends vscode.Disposable {
  /**
   * Begin the scheduling loop. Idempotent — calling `start` multiple times is
   * safe; only one timer is active at a time.
   */
  start(): void;

  /**
   * Stop the scheduling loop immediately. Does not dispose the service.
   */
  stop(reason?: AutoFetchPauseReason): void;

  /**
   * Force a reschedule using the current configuration. Called when settings
   * or workspace-folder membership change.
   */
  reschedule(): void;

  /**
   * Reset the backoff multiplier and reschedule. Called after a manual fetch
   * or when the user re-enables auto-fetch after an auth failure.
   */
  resetBackoff(): void;

  /**
   * Whether the scheduler currently has a pending timer.
   */
  readonly isRunning: boolean;

  /**
   * Whether the scheduler is paused because of an auth failure. The pause
   * lifts when the user invokes `resetBackoff` or toggles the config flag.
   */
  readonly isPausedForAuth: boolean;
}
