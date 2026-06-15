/**
 * Incoming tab in the Git tool window.
 *
 * The tab lists the *incoming* commits — those on the current branch's
 * upstream that the local branch does not yet have (what a pull would bring
 * in). It is the IntelliG counterpart of IntelliJ git4idea's "Incoming"
 * view (`GitBranchIncomingOutgoingManager` feeds the same notion).
 *
 * The count + upstream resolution comes from the Phase-0a
 * `GitService.getIncomingOutgoing` collaborator (`git rev-list --left-right
 * --count <upstream>...HEAD`). The commit LIST is computed precisely as the
 * set-difference of the upstream's log and HEAD's log, using only the frozen
 * `IGitService.getLog` — so the tab needs no new git op (ADR-001 friendly).
 *
 * Layering (per the Wave-tabs design + the HistoryTab template):
 *   - This file owns the data + message handler (state machine, refresh,
 *     selection, jump-to-commit routing) and lives in the `tabs/` lane.
 *   - The HTML renderer (`html/incomingHtml.ts`) and the provider wiring
 *     (`GitToolWindowProvider.register('incoming', …)` / `attachGitService`-
 *     style swap-in) live in the Log/Graph workstream's directories and are
 *     deferred to that stream. The `onStateChange` hook is the seam the
 *     provider attaches to post `incoming.updateState` back to the webview,
 *     mirroring HistoryTab.
 *
 * Inbound messages (from webview):
 *   - `incoming.refresh`                 — recompute counts + commit list
 *   - `incoming.selectCommit`  { hash }  — mark a row selected
 *   - `incoming.jumpToCommit`  { hash }  — route to the Log tab's
 *                                          scroll-to-commit path
 *
 * Outbound messages (host → webview), posted by the provider via the
 * `onStateChange` hook:
 *   - `incoming.updateState`   { state } — full state refresh
 */

import type { IWebviewTabMessage, TabMessageHandler } from '../tabRouter';
import type { ICommit, ILogOptions, IRepository } from '../../interfaces/IGitService';
import type { IIncomingOutgoing } from '../../ops/IncomingOutgoingOps';
import { sanitizeGitError } from '../../gitError';

// ─────────────────────────────────────────────────────────────────────────────
// Collaborator role interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The narrow slice of `GitService` the Incoming tab depends on. `getLog` is on
 * the frozen `IGitService`; `getIncomingOutgoing` is the Phase-0a façade
 * method on the concrete `GitService` (ADR-001 — not on the composite). A
 * role interface keeps the tab decoupled from the full service and trivially
 * mockable in tests.
 */
export interface IIncomingDataSource {
  getIncomingOutgoing(repo: IRepository): Promise<IIncomingOutgoing>;
  getLog(repo: IRepository, options?: ILogOptions): Promise<ICommit[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

/**
 * State the Incoming tab owns, exposed so the render layer can serialise it
 * back into the webview.
 */
export interface IIncomingTabState {
  /** Current branch name (e.g. `main`), or `HEAD` when detached. */
  branch: string | undefined;
  /** Resolved upstream tracking ref (e.g. `origin/main`), or undefined. */
  upstream: string | undefined;
  /** Number of incoming commits (== git's "behind"). */
  incomingCount: number;
  /** Number of outgoing commits (== git's "ahead") — shown as context. */
  outgoingCount: number;
  /** True when the branch has no configured upstream. */
  noUpstream: boolean;
  /** The incoming commits, newest first. Empty when in sync / no upstream. */
  commits: ICommit[];
  /** Hash of the row the user has selected, if any. */
  selectedCommit: string | undefined;
  /** Error string to surface in the UI (see HistoryTab for the state-sideband rationale). */
  error: string | undefined;
  /** True while a refresh is in flight. */
  loading: boolean;
}

export function createInitialIncomingTabState(): IIncomingTabState {
  return {
    branch: undefined,
    upstream: undefined,
    incomingCount: 0,
    outgoingCount: 0,
    noUpstream: false,
    commits: [],
    selectedCommit: undefined,
    error: undefined,
    loading: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Precisely select the incoming commits: those reachable from the upstream
 * that are NOT reachable from HEAD. Computed as a set-difference of two logs
 * keyed on commit hash, so it is exact even when the branch and upstream have
 * diverged (a plain "top N of upstream" slice would be wrong in that case).
 *
 * @param upstreamLog commits on the upstream ref (newest first)
 * @param headHashes  set of commit hashes reachable from HEAD
 * @returns the upstream commits absent from HEAD, preserving upstream order
 */
export function selectIncomingCommits(
  upstreamLog: ReadonlyArray<ICommit>,
  headHashes: ReadonlySet<string>
): ICommit[] {
  return upstreamLog.filter((c) => !headHashes.has(c.hash));
}

/**
 * Build the set of commit hashes reachable from HEAD from a HEAD log slice.
 * Exported for focused testing.
 */
export function headHashSet(headLog: ReadonlyArray<ICommit>): Set<string> {
  return new Set(headLog.map((c) => c.hash));
}

// ─────────────────────────────────────────────────────────────────────────────
// IncomingTab
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hooks the {@link IncomingTab} exposes to its owner (the provider).
 */
export interface IIncomingTabHooks {
  /** Fired whenever state changes; the provider posts `incoming.updateState`. */
  onStateChange?: (state: IIncomingTabState) => void;
  /** Resolver for the repo the tab should query (the tool-window selection). */
  getRepo?: () => IRepository | undefined;
  /**
   * Routes a jump-to-commit to the Log tab's scroll-to-commit path. The
   * provider wires this (it owns the Log graph state); when unset, a jump is a
   * no-op. Kept as a hook so the tab never reaches across to the provider /
   * Log workstream directly.
   */
  jumpToCommit?: (hash: string) => void;
}

/**
 * Upper bound on commits pulled per ref when computing the incoming set. Even a
 * very stale branch rarely exceeds this; it caps the work for pathological
 * repos. Mirrors the conservative caps used elsewhere in the tool window.
 */
const MAX_LOG = 500;

/**
 * Stateful host-side handler for the Incoming tab.
 *
 * The class owns per-tab state and talks to the data source. The tab router
 * invokes `handleMessage` for each inbound webview message; the owning
 * provider is notified via `onStateChange` so it can post updates back to the
 * webview. Mirrors the {@link HistoryTab} shape so the provider can wire it
 * with the same `attachGitService`-style swap-in.
 */
export class IncomingTab {
  private _state: IIncomingTabState = createInitialIncomingTabState();
  private readonly _data: IIncomingDataSource;
  private readonly _hooks: IIncomingTabHooks;

  constructor(data: IIncomingDataSource, hooks: IIncomingTabHooks = {}) {
    this._data = data;
    this._hooks = hooks;
  }

  public getState(): IIncomingTabState {
    return this._state;
  }

  /** Expose a handler compatible with the {@link TabRouter} protocol. */
  public asTabHandler(): TabMessageHandler {
    return async (message: IWebviewTabMessage): Promise<void> => {
      await this.handleMessage(message);
    };
  }

  public async handleMessage(message: IWebviewTabMessage): Promise<void> {
    if (!message || typeof message.type !== 'string') {
      return;
    }
    switch (message.type) {
      case 'incoming.refresh': {
        await this.refresh();
        return;
      }
      case 'incoming.selectCommit': {
        const hash = typeof message.hash === 'string' ? message.hash : undefined;
        if (hash && hash !== this._state.selectedCommit) {
          this._state = { ...this._state, selectedCommit: hash };
          this._emit();
        }
        return;
      }
      case 'incoming.jumpToCommit': {
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

  /**
   * Recompute the incoming counts + commit list for the current repo.
   *
   * 1. `getIncomingOutgoing` resolves the branch, upstream, and behind/ahead
   *    counts (Phase 0a).
   * 2. When there are incoming commits, the precise list is the set-difference
   *    of the upstream's log and HEAD's log (see {@link selectIncomingCommits}).
   *
   * Errors are captured into `state.error` rather than thrown — the renderer
   * reads it synchronously (HistoryTab pattern).
   */
  public async refresh(): Promise<void> {
    const repo = this._hooks.getRepo?.();
    if (!repo) {
      this._state = {
        ...createInitialIncomingTabState(),
        error: 'No repository selected.',
      };
      this._emit();
      return;
    }

    this._state = { ...this._state, loading: true, error: undefined };
    this._emit();

    try {
      const io = await this._data.getIncomingOutgoing(repo);

      if (io.noUpstream || !io.upstream) {
        this._state = {
          ...createInitialIncomingTabState(),
          branch: io.branch,
          noUpstream: true,
        };
        this._emit();
        return;
      }

      let commits: ICommit[] = [];
      if (io.incoming > 0) {
        // Pull enough of each ref to cover the incoming span. The HEAD slice is
        // the exclusion set; the upstream slice is the candidate set. The
        // set-difference yields exactly the commits a pull would bring in,
        // even when the branch and upstream have diverged.
        const [upstreamLog, headLog] = await Promise.all([
          this._data.getLog(repo, { ref: io.upstream, maxCount: MAX_LOG }),
          this._data.getLog(repo, { maxCount: MAX_LOG }),
        ]);
        commits = selectIncomingCommits(upstreamLog, headHashSet(headLog));
      }

      this._state = {
        branch: io.branch,
        upstream: io.upstream,
        incomingCount: io.incoming,
        outgoingCount: io.outgoing,
        noUpstream: false,
        commits,
        // Drop a stale selection that's no longer in the list.
        selectedCommit: commits.some((c) => c.hash === this._state.selectedCommit)
          ? this._state.selectedCommit
          : undefined,
        error: undefined,
        loading: false,
      };
      this._emit();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this._state = {
        ...this._state,
        loading: false,
        error: sanitizeGitError(message),
      };
      this._emit();
    }
  }

  private _emit(): void {
    this._hooks.onStateChange?.(this._state);
  }
}

/**
 * Factory mirroring the rest of the tab layer. Returns a fully-wired
 * {@link IncomingTab} bound to a data source + hooks.
 *
 * The provider should call this and register `tab.asTabHandler()` once its
 * data source is attached, exactly as it does for HistoryTab. That swap-in
 * wiring is the deferred cross-cutting change in the Log/Graph workstream.
 */
export function createIncomingTab(
  data: IIncomingDataSource,
  hooks?: IIncomingTabHooks
): IncomingTab {
  return new IncomingTab(data, hooks);
}

/**
 * Backwards-compatible no-arg handler retained for the provider's constructor-
 * time registration (before the data source is wired). It accepts and ignores
 * `incoming.*` messages so a refresh fired before attach is a safe no-op.
 *
 * Once the Log/Graph workstream wires `attachGitService`, the provider should
 * replace this with `createIncomingTab(gitService, hooks).asTabHandler()`.
 */
export function createIncomingTabHandler(): TabMessageHandler {
  return (message: IWebviewTabMessage): void => {
    // No-op until the provider attaches a real IncomingTab (see createIncomingTab).
    void message;
  };
}
