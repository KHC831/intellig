/**
 * Update Info tab in the Git tool window.
 *
 * Renders the post-Update-Project summary — git4idea's "Update Info" tree:
 * which repos were updated, the strategy used, how many commits came in, and
 * any conflict / error. The summary is produced by
 * {@link runUpdateProject} in `src/sync/updateProject.ts`; this tab simply
 * holds the latest summary and exposes it to the render layer.
 *
 * Layering mirrors {@link IncomingTab} / HistoryTab:
 *   - This file (in the `tabs/` lane) owns the state + message handler.
 *   - The HTML renderer (`html/updateInfoHtml.ts`) and the provider wiring
 *     (registering this handler, calling `setSummary` after an update) live in
 *     the Log/Graph workstream and are the deferred cross-cutting change. The
 *     `onStateChange` hook is the seam the provider posts `updateInfo.updateState`
 *     through.
 *
 * Inbound messages (from webview):
 *   - `updateInfo.refresh`             — re-emit the current summary
 *   - `updateInfo.jumpToCommit { hash }` — (future) route to the Log tab
 *
 * Outbound (host → webview), via the `onStateChange` hook:
 *   - `updateInfo.updateState { state }`
 */

import type { IWebviewTabMessage, TabMessageHandler } from '../tabRouter';
import type { IUpdateInfoSummary } from '../../../sync/updateProject';

/** State the Update Info tab owns. */
export interface IUpdateInfoTabState {
  /** The most recent Update Project summary, or undefined before any run. */
  summary: IUpdateInfoSummary | undefined;
}

export function createInitialUpdateInfoTabState(): IUpdateInfoTabState {
  return { summary: undefined };
}

/** Hooks the {@link UpdateInfoTab} exposes to its owner (the provider). */
export interface IUpdateInfoTabHooks {
  /** Fired whenever the summary changes; provider posts `updateInfo.updateState`. */
  onStateChange?: (state: IUpdateInfoTabState) => void;
  /** Routes a jump-to-commit to the Log tab's scroll-to-commit path. */
  jumpToCommit?: (hash: string) => void;
}

/**
 * One-line human-readable summary headline for the tab header / a toast.
 * Pure — exported for tests and reuse by the structured update notification.
 */
export function updateInfoHeadline(summary: IUpdateInfoSummary): string {
  const repoCount = summary.repos.length;
  const updated = summary.repos.filter((r) => r.status === 'updated').length;
  const conflicts = summary.repos.filter((r) => r.status === 'conflict').length;
  const errors = summary.repos.filter((r) => r.status === 'error').length;

  if (conflicts > 0) {
    return `Update finished with ${conflicts} conflict(s) — resolve to continue.`;
  }
  if (errors > 0) {
    return `Update failed in ${errors} of ${repoCount} repo(s).`;
  }
  if (summary.totalIncoming === 0) {
    return repoCount === 1 ? 'Already up to date.' : 'All repositories already up to date.';
  }
  const repoLabel = updated === 1 ? 'repository' : 'repositories';
  return `Updated ${updated} ${repoLabel}; ${summary.totalIncoming} commit(s) pulled.`;
}

/**
 * Stateful host-side handler for the Update Info tab.
 */
export class UpdateInfoTab {
  private _state: IUpdateInfoTabState = createInitialUpdateInfoTabState();
  private readonly _hooks: IUpdateInfoTabHooks;

  constructor(hooks: IUpdateInfoTabHooks = {}) {
    this._hooks = hooks;
  }

  public getState(): IUpdateInfoTabState {
    return this._state;
  }

  /**
   * Install a new summary after an Update Project run and notify the provider.
   * Called by the `intellig.updateProject` command path (via the provider).
   */
  public setSummary(summary: IUpdateInfoSummary): void {
    this._state = { summary };
    this._emit();
  }

  public asTabHandler(): TabMessageHandler {
    return (message: IWebviewTabMessage): void => {
      this.handleMessage(message);
    };
  }

  public handleMessage(message: IWebviewTabMessage): void {
    if (!message || typeof message.type !== 'string') {
      return;
    }
    switch (message.type) {
      case 'updateInfo.refresh':
        this._emit();
        return;
      case 'updateInfo.jumpToCommit': {
        const hash = typeof message.hash === 'string' ? message.hash : undefined;
        if (hash) {
          this._hooks.jumpToCommit?.(hash);
        }
        return;
      }
      default:
        return;
    }
  }

  private _emit(): void {
    this._hooks.onStateChange?.(this._state);
  }
}

/**
 * No-arg handler used for the provider's constructor-time registration
 * (`_tabRouter.register('updateInfo', …)`). Currently a no-op sink; the
 * provider can swap in a real `new UpdateInfoTab(...).asTabHandler()` once the
 * Update-Info tab is wired (deferred Log/Graph workstream change).
 */
export function createUpdateInfoTabHandler(): TabMessageHandler {
  return (message: IWebviewTabMessage): void => {
    // No-op until the provider attaches a real UpdateInfoTab.
    void message;
  };
}
