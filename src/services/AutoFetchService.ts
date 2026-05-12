/**
 * Auto-Fetch Service implementation (T1-03).
 *
 * Runs `git fetch --all --prune` periodically in every open repository while
 * the user works, matching IntelliJ's background-refresh behavior. The
 * scheduler honors `intellig.autoFetchEnabled` + `intellig.autoFetchInterval`,
 * pauses when no repositories are open, backs off exponentially on transient
 * failures, and pauses on authentication failures until the user re-enables it.
 */

import * as vscode from 'vscode';
import { IAutoFetchService, AutoFetchPauseReason } from './interfaces/IAutoFetchService';
import { IGitService, IRepository } from './interfaces/IGitService';
import { safeFireAndForget } from '../utils/safeFireAndForget';

/**
 * Minimum polling interval in seconds. Values below this are clamped to
 * avoid hammering remotes.
 */
const MIN_INTERVAL_SECONDS = 60;

/**
 * Maximum backoff multiplier (exponential: 1x → 2x → 4x → 8x → 16x cap).
 */
const MAX_BACKOFF_MULTIPLIER = 16;

/**
 * Patterns that identify an authentication failure on stderr. When any of
 * these match, the scheduler pauses until the user re-enables it.
 */
const AUTH_FAILURE_PATTERNS: readonly RegExp[] = [
  /authentication failed/i,
  /could not read username/i,
  /could not read password/i,
  /permission denied/i,
  /fatal: repository .* not found/i,
  /ssh: connect to host .* port \d+: permission denied/i,
];

/**
 * Options object used by the AutoFetchService constructor. Exposed so tests
 * can inject config readers and skip VS Code listener installation.
 */
export interface IAutoFetchServiceOptions {
  /** Override the enabled reader (primarily for tests). */
  readEnabled?: () => boolean;
  /** Override the interval (seconds) reader (primarily for tests). */
  readIntervalSec?: () => number;
  /** Skip attaching VS Code workspace/config listeners (primarily for tests). */
  skipWorkspaceListeners?: boolean;
}

export class AutoFetchService implements IAutoFetchService {
  private readonly _gitService: IGitService;
  private readonly _readEnabled: () => boolean;
  private readonly _readIntervalSec: () => number;

  /** Active pending tick; `undefined` when the scheduler is stopped. */
  private _timer: NodeJS.Timeout | undefined;

  /** Current backoff multiplier (1 = no backoff). */
  private _backoffMultiplier = 1;

  /** Whether a tick is currently in flight; prevents reentrancy. */
  private _tickInFlight = false;

  /** Set to true when an auth failure paused the scheduler. */
  private _pausedForAuth = false;

  /**
   * Whether the auth-failure toast has already been surfaced in this pause
   * session. Reset on successful resume (resetBackoff) so a later failure
   * can reprompt. Prevents N repos failing simultaneously from stacking N
   * duplicate toasts.
   */
  private _authFailureToastShownForSession = false;

  /**
   * Number of consecutive auth failures observed since the last successful
   * resume. Bumped each time `_pauseForAuth` runs; reset by `resetBackoff`.
   * Used by LOW-7 to escalate a quiet re-pause into a visible toast.
   */
  private _consecutiveAuthFailures = 0;

  /** VS Code subscriptions cleaned up on dispose. */
  private _subscriptions: vscode.Disposable[] = [];

  /** Whether the service has been disposed. */
  private _disposed = false;

  constructor(gitService: IGitService, options?: IAutoFetchServiceOptions) {
    this._gitService = gitService;
    this._readEnabled =
      options?.readEnabled ??
      ((): boolean =>
        vscode.workspace.getConfiguration('intellig').get<boolean>('autoFetchEnabled', true));
    this._readIntervalSec =
      options?.readIntervalSec ??
      ((): number =>
        vscode.workspace.getConfiguration('intellig').get<number>('autoFetchInterval', 180));

    if (!options?.skipWorkspaceListeners) {
      this._subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
          this.reschedule();
        })
      );
      this._subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
          if (e.affectsConfiguration('intellig.autoFetchEnabled')) {
            this._pausedForAuth = false;
            this.reschedule();
          } else if (e.affectsConfiguration('intellig.autoFetchInterval')) {
            this.reschedule();
          }
        })
      );
    }
  }

  get isRunning(): boolean {
    return this._timer !== undefined;
  }

  get isPausedForAuth(): boolean {
    return this._pausedForAuth;
  }

  start(): void {
    if (this._disposed) {
      return;
    }
    this.reschedule();
  }

  stop(_reason: AutoFetchPauseReason = 'user'): void {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }
  }

  reschedule(): void {
    if (this._disposed) {
      return;
    }

    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }

    if (!this._readEnabled()) {
      return;
    }
    if (this._pausedForAuth) {
      return;
    }
    if (this._gitService.getRepositories().length === 0) {
      return;
    }

    const baseMs = this._getIntervalMs();
    const delay = baseMs * this._backoffMultiplier;
    this._timer = setTimeout(() => {
      this._timer = undefined;
      // Bucket C: timer tick is a watcher-style callback; `_tick`
      // internalises its own auth/backoff toasts. Log+suppress keeps the
      // schedule alive on transient rejections.
      safeFireAndForget(this._tick(), 'AutoFetchService.reschedule: timer tick');
    }, delay);
  }

  resetBackoff(): void {
    this._backoffMultiplier = 1;
    this._pausedForAuth = false;
    this._authFailureToastShownForSession = false;
    // Leave _consecutiveAuthFailures alone — it resets when a fetch actually
    // succeeds (see _tick). Keeping it here lets LOW-7 detect an immediate
    // re-pause after the user tapped "Re-enable" (resume + re-fail).
    this.reschedule();
  }

  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    this.stop('user');
    for (const sub of this._subscriptions) {
      try {
        sub.dispose();
      } catch {
        // ignore
      }
    }
    this._subscriptions = [];
  }

  /**
   * Run one fetch cycle across all open repositories.
   */
  private async _tick(): Promise<void> {
    if (this._disposed || this._tickInFlight) {
      return;
    }
    this._tickInFlight = true;

    try {
      const repos = this._gitService.getRepositories();
      if (repos.length === 0) {
        return;
      }

      const results = await Promise.allSettled(
        repos.map((repo) => this._gitService.fetch(repo, { all: true, prune: true }))
      );

      let sawAuthFailure = false;
      let sawTransientFailure = false;

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === 'rejected') {
          const message = this._extractErrorMessage(r.reason);
          if (this._isAuthFailure(message)) {
            sawAuthFailure = true;
            this._pauseForAuth(repos[i]);
            break;
          }
          sawTransientFailure = true;
        }
      }

      if (sawAuthFailure) {
        return;
      }

      if (sawTransientFailure) {
        this._backoffMultiplier = Math.min(
          this._backoffMultiplier > 0 ? this._backoffMultiplier * 2 : 2,
          MAX_BACKOFF_MULTIPLIER
        );
      } else {
        // All repos fetched cleanly — auth is working. Clear the auth-loop
        // escalation counter so the next (unrelated) auth failure starts
        // fresh with the quiet toast.
        this._backoffMultiplier = 1;
        this._consecutiveAuthFailures = 0;
      }
    } finally {
      this._tickInFlight = false;
      if (!this._disposed && !this._pausedForAuth) {
        this.reschedule();
      }
    }
  }

  /**
   * Pause the scheduler on an auth failure and prompt the user to re-enable.
   *
   * Toast de-duplication (MEDIUM-4): if multiple repos fail to auth in the
   * same tick (e.g. expired PAT shared across three repos), only the first
   * one surfaces a toast; the rest are logged silently. Reset when the user
   * acts on the re-enable prompt via `resetBackoff`.
   *
   * LOW-7 escalation: a silent re-pause within the same session (re-enable
   * resumed, then immediately auth-failed again) promotes the toast back to
   * visible so the user sees "still failing — credentials likely bad".
   */
  private _pauseForAuth(repo: IRepository): void {
    const wasAlreadyPaused = this._pausedForAuth;
    this._pausedForAuth = true;
    this._consecutiveAuthFailures += 1;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }

    const repoLabel = this._repoLabel(repo);

    // LOW-7: second (or later) failure within the same resume-session after
    // the user hit "Re-enable" surfaces a louder error so silent auth loops
    // don't hide behind the first toast.
    if (this._consecutiveAuthFailures >= 2 && !wasAlreadyPaused) {
      // This is the first pause after a resume that re-failed. Surface an
      // error toast with the repo; ignore the session-dedup flag so the
      // user isn't left wondering.
      void vscode.window.showErrorMessage(
        `Auto-fetch still failing for "${repoLabel}" — credentials likely invalid.`
      );
      this._authFailureToastShownForSession = true;
      return;
    }

    if (this._authFailureToastShownForSession) {
      // Another repo already surfaced a toast this session; log-only.
      console.log(
        `[intellig] auto-fetch suppressed duplicate auth-failure toast for "${repoLabel}"`
      );
      return;
    }

    this._authFailureToastShownForSession = true;
    void vscode.window
      .showWarningMessage(
        `Auto-fetch paused for "${repoLabel}" — authentication failed.`,
        'Re-enable auto-fetch'
      )
      .then((choice) => {
        if (choice === 'Re-enable auto-fetch') {
          this.resetBackoff();
        }
      });
  }

  private _repoLabel(repo: IRepository): string {
    const fsPath = repo.rootUri.fsPath;
    const segments = fsPath.split(/[\\/]/).filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : fsPath;
  }

  private _extractErrorMessage(reason: unknown): string {
    if (reason instanceof Error) {
      return reason.message;
    }
    if (typeof reason === 'string') {
      return reason;
    }
    try {
      return JSON.stringify(reason);
    } catch {
      return '';
    }
  }

  private _isAuthFailure(message: string): boolean {
    if (!message) {
      return false;
    }
    return AUTH_FAILURE_PATTERNS.some((re) => re.test(message));
  }

  private _getIntervalMs(): number {
    const raw = this._readIntervalSec();
    const seconds =
      Number.isFinite(raw) && raw > 0 ? Math.max(raw, MIN_INTERVAL_SECONDS) : MIN_INTERVAL_SECONDS;
    return Math.floor(seconds * 1000);
  }
}

/**
 * Factory for AutoFetchService, matching the project's `create*` convention.
 */
export function createAutoFetchService(
  gitService: IGitService,
  options?: IAutoFetchServiceOptions
): AutoFetchService {
  return new AutoFetchService(gitService, options);
}
