/**
 * Tab router for the Git Tool Window webview.
 *
 * The tabbed layout (Log / Console / Incoming / Update Info / History) sits
 * behind the `intellig.useTabbedGitToolWindow` configuration flag. This
 * module owns:
 *
 *   - the canonical list of tab IDs
 *   - the active-tab state
 *   - dispatch of inbound webview messages to per-tab handlers
 *   - publication of the `intellig.toolWindow.activeTab` context key
 *
 * All messages may optionally carry a `tab` field; messages without one are
 * treated as implicit `tab: 'log'` (preserving every existing `log.*` /
 * `selectCommit` / `toggleCommitSelection` / filter message shape).
 *
 * This router is the sole host-side entry point for tab routing — the
 * existing monolithic `onDidReceiveMessage` switch continues to own per-case
 * business logic. The router prepends tab discrimination and dispatches
 * non-log messages to stub handlers that display "Coming soon" placeholders.
 */

import { CONTEXT_KEYS, setContextKey } from '../../utils/contextKeys';

export const TAB_IDS = ['log', 'console', 'incoming', 'updateInfo', 'history'] as const;

/** Union of valid tab IDs. */
export type TabId = (typeof TAB_IDS)[number];

/** Default tab — preserves pre-refactor behavior (Log panel is what users see today). */
export const DEFAULT_TAB: TabId = 'log';

/** Name of the VS Code context key that reflects the currently active tab. */
export const ACTIVE_TAB_CONTEXT_KEY = CONTEXT_KEYS.toolWindowActiveTab;

/**
 * Shape of the messages the router recognises. Non-router messages (everything
 * under `log.*` plus legacy types like `selectCommit`) just flow through the
 * router unchanged and are handled by the existing provider switch.
 */
export interface IWebviewTabMessage {
  readonly type: string;
  readonly tab?: TabId;
  readonly [key: string]: unknown;
}

/**
 * Per-tab handler signature. Only the Log handler is wired up today; the other
 * four tabs use stub handlers.
 */
export type TabMessageHandler = (message: IWebviewTabMessage) => Promise<void> | void;

/**
 * Hooks the router offers to its owner (the provider). Kept intentionally small
 * so the provider can evolve independently.
 */
export interface ITabRouterHooks {
  /**
   * Called whenever the active tab changes. The provider uses this to
   * re-render the webview HTML and, in future, to lazy-load
   * tab-specific state.
   */
  onActiveTabChanged?(tab: TabId): void;
  /** Optional override for the setContext publisher (for testability). */
  setContext?(key: string, value: unknown): Promise<void> | void;
}

/**
 * Infer the target tab for a message that omits `tab` explicitly.
 *
 * Historical messages (`selectCommit`, `toggleCommitSelection`, `loadMoreCommits`,
 * `setLogFilter`, `panelResize`, `doubleClickFile`, etc.) are all implicit
 * `tab: 'log'`.
 *
 * Messages whose type starts with a known `<tab>.` prefix (`console.`,
 * `incoming.`, `updateInfo.`, `history.`) are dispatched by prefix.
 *
 * Anything else falls back to the currently active tab.
 */
export function inferTabForMessage(message: IWebviewTabMessage, activeTab: TabId): TabId {
  if (message.tab && isTabId(message.tab)) {
    return message.tab;
  }
  const type = typeof message.type === 'string' ? message.type : '';
  if (type.startsWith('console.')) {
    return 'console';
  }
  if (type.startsWith('incoming.')) {
    return 'incoming';
  }
  if (type.startsWith('updateInfo.')) {
    return 'updateInfo';
  }
  if (type.startsWith('history.')) {
    return 'history';
  }
  // `log.*`, `selectCommit`, `toggleCommitSelection`, `loadMoreCommits`,
  // filters, divider resize, etc. — all implicit `tab: 'log'`.
  if (type.startsWith('log.')) {
    return 'log';
  }
  // Fall back to the active tab so stray malformed-but-type-less messages
  // land somewhere sensible.
  return activeTab;
}

/** Type guard for {@link TabId}. */
export function isTabId(value: unknown): value is TabId {
  return typeof value === 'string' && (TAB_IDS as readonly string[]).includes(value);
}

/**
 * Minimal in-memory router. Owns active-tab state and dispatches messages.
 *
 * Intentionally does NOT touch the webview or the provider's HTML template —
 * the provider wires those via the `onActiveTabChanged` hook.
 */
export class TabRouter {
  private _activeTab: TabId = DEFAULT_TAB;
  private readonly _handlers = new Map<TabId, TabMessageHandler>();
  private readonly _hooks: ITabRouterHooks;

  constructor(hooks: ITabRouterHooks = {}) {
    this._hooks = hooks;
    // Publish the initial tab immediately: setActiveTab early-returns on the
    // default tab, so without this the context key stays unset until the
    // first tab switch and keybinding when-clauses testing it never match.
    void this._publishContextKey(this._activeTab);
  }

  /** Current active tab. */
  public getActiveTab(): TabId {
    return this._activeTab;
  }

  /** Register or replace the handler for a given tab. */
  public register(tab: TabId, handler: TabMessageHandler): void {
    this._handlers.set(tab, handler);
  }

  /**
   * Set the active tab programmatically (e.g. via `intellig.toolWindow.focusTab`).
   * Fires the `onActiveTabChanged` hook and publishes the context key.
   */
  public async setActiveTab(tab: TabId): Promise<void> {
    if (!isTabId(tab)) {
      return;
    }
    if (tab === this._activeTab) {
      return;
    }
    this._activeTab = tab;
    await this._publishContextKey(tab);
    this._hooks.onActiveTabChanged?.(tab);
  }

  /**
   * Dispatch an inbound webview message. Handles the `tabChange` meta-message
   * itself; other messages are routed to the owning tab's handler (if any).
   *
   * Returns `true` if the message was a router-owned `tabChange` message, so
   * the caller can skip its own switch. Returns `false` for everything else.
   * The caller is expected to continue its own per-type processing for the
   * `log` tab (the existing provider switch still handles it).
   */
  public async dispatch(message: IWebviewTabMessage): Promise<boolean> {
    // Defensive: malformed messages (non-object / missing type) are dropped.
    if (!message || typeof message !== 'object') {
      return true; // consumed — nothing to do
    }
    if (typeof message.type !== 'string' || message.type.length === 0) {
      return true;
    }

    // The one meta-message the router owns outright.
    if (message.type === 'tabChange') {
      const tab = message.tab;
      if (isTabId(tab)) {
        await this.setActiveTab(tab);
      }
      return true;
    }

    const targetTab = inferTabForMessage(message, this._activeTab);
    const handler = this._handlers.get(targetTab);
    if (handler) {
      await handler(message);
    }
    // The Log tab continues to be handled by the provider's existing switch;
    // return false so the caller knows to keep processing.
    return targetTab !== 'log' ? true : false;
  }

  private async _publishContextKey(tab: TabId): Promise<void> {
    if (this._hooks.setContext) {
      await this._hooks.setContext(ACTIVE_TAB_CONTEXT_KEY, tab);
      return;
    }
    await setContextKey(CONTEXT_KEYS.toolWindowActiveTab, tab);
  }
}
