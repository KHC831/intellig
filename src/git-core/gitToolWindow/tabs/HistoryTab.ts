/**
 * File History tab in the Git tool window.
 *
 * The tab renders the commit history for a single file and supports:
 *
 *   - **--follow for rename tracking** (toolbar checkbox)
 *   - **Branch filter** (toolbar dropdown)
 *   - **Open-at-revision** (click a commit row) — opens an editor tab on the
 *     file content at that commit via the `intellig-git:` URI scheme.
 *   - **Diff any two revisions** (select two commits, Ctrl/Cmd-click the
 *     second one) — opens a `vscode.diff` tab between the file at those two
 *     revisions.
 *   - **Compare with Local** (toolbar button, when a single commit is
 *     selected) — diffs the selected revision against the working copy.
 *
 * The tab is designed so all pure data paths (message → state → HTML) live
 * in exported helpers. The `HistoryTab` class glues those helpers to the
 * GitService and to the VS Code `showHistory` command.
 *
 * Inbound messages (from webview):
 *   - `history.loadFile`            { path: string, branch?: string }
 *   - `history.selectRevision`      { rev: string, additive?: boolean }
 *   - `history.openAtRevision`      { rev: string }
 *   - `history.compareWith`         { from: string, to: string }
 *   - `history.compareWithLocal`    { rev: string }
 *   - `history.toggleFollowRenames` { value: boolean }
 *   - `history.setBranchFilter`     { branch: string | undefined }
 *
 * Outbound messages (host → webview):
 *   - `history.updateState`         { state }  (full state refresh; used for
 *                                              initial load and after git
 *                                              operations)
 */

import * as vscode from 'vscode';
import type { IWebviewTabMessage, TabMessageHandler } from '../tabRouter';
import type { IBranch, ICommit, IGitService, IRepository } from '../../interfaces/IGitService';
import { sanitizeGitError } from '../../gitError';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shape of the state the tab owns, exposed so the provider / render layer
 * can serialise it back into the webview.
 */
export interface IHistoryTabState {
  /** Repo-relative path. `undefined` means no file has been loaded yet. */
  filePath: string | undefined;
  /** Commits for the current (filePath, branch, follow) triple. */
  commits: ICommit[];
  /** Selected commit hash (single-select) or the tail of a 2-commit selection. */
  selectedCommit: string | undefined;
  /** Second selection for diff-two-revisions. */
  compareCommit: string | undefined;
  /** Branch ref the history is scoped to. `undefined` = HEAD. */
  branchFilter: string | undefined;
  /** Whether `--follow` is enabled. */
  followRenames: boolean;
  /** List of branches to render in the branch-filter dropdown. */
  availableBranches: IBranch[];
  /**
   * Any error string to surface in the UI.
   *
   * **Kept as a state-sideband on purpose.** Per ADR-006
   * (`docs/adr/ADR-006-error-state-binding-by-view-type.md`),
   * HistoryTab is the canonical example of the HTML / template-rendering
   * pattern: the renderer in
   * `src/services/gitToolWindow/html/historyHtml.ts` is a synchronous
   * function over this state object and reads `state.error` directly
   * during HTML construction (`state.error ? renderError(...) : ''`).
   * Awaiting a refresh `Promise<{ error? }>` is the wrong shape there
   * because the renderer can't suspend mid-template, so the canonical-
   * channel pattern used by ShelfView / StashView / BranchComparisonView
   * does not apply.
   *
   * Do **not** "consolidate" this field into a refresh return value
   * without first refactoring the render shape — that is the trap this
   * cross-reference exists to prevent.
   */
  error: string | undefined;
  /** True while a load is in-flight (for a simple spinner / disabled UI). */
  loading: boolean;
}

export function createInitialHistoryTabState(): IHistoryTabState {
  return {
    filePath: undefined,
    commits: [],
    selectedCommit: undefined,
    compareCommit: undefined,
    branchFilter: undefined,
    followRenames: false,
    availableBranches: [],
    error: undefined,
    loading: false,
  };
}

/**
 * User-facing message shown when a command requires a loaded file but none is
 * set yet (e.g. the user invoked the History tab without first selecting a
 * file). Exported so tests can assert on the exact string.
 */
export const NO_FILE_LOADED_MESSAGE = 'Load a file first — use "Show History" on a file.';

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the `intellig-git:` URI for a file at a specific revision.
 * Mirrors the pattern used by branchShowDiff.
 */
export function buildFileAtRevisionUri(filePath: string, rev: string): vscode.Uri {
  return vscode.Uri.parse(`intellig-git:${filePath}?${encodeURIComponent(rev)}`);
}

/**
 * Format the `vscode.diff` tab title for a two-revision comparison.
 *
 *   `<basename> (<fromShort> ↔ <toShort>)`
 */
export function buildDiffAnyTwoTitle(filePath: string, from: string, to: string): string {
  const basename = filePath.substring(filePath.lastIndexOf('/') + 1);
  const fromShort = from.substring(0, 7);
  const toShort = to.substring(0, 7);
  return `${basename} (${fromShort} ↔ ${toShort})`;
}

/**
 * Format the `vscode.diff` tab title for a compare-with-local.
 *
 *   `<basename> (<revShort> ↔ Working Tree)`
 */
export function buildCompareWithLocalTitle(filePath: string, rev: string): string {
  const basename = filePath.substring(filePath.lastIndexOf('/') + 1);
  const revShort = rev.substring(0, 7);
  return `${basename} (${revShort} ↔ Working Tree)`;
}

/**
 * Apply a webview message to state. Pure reducer — returns a new state
 * without mutating the input. Kept separate from `HistoryTab.dispatch` so
 * unit tests can exercise state transitions without side effects.
 *
 * Only local-state transitions are covered here (selection, toggles). Load
 * operations are handled by the owning `HistoryTab` which talks to the
 * GitService.
 */
export function reduceHistoryState(
  state: IHistoryTabState,
  message: IWebviewTabMessage
): IHistoryTabState {
  const type = message.type;
  switch (type) {
    case 'history.selectRevision': {
      const rev = typeof message.rev === 'string' ? message.rev : undefined;
      if (!rev) {
        return state;
      }
      // `additive` = ctrl/cmd-click — retain the prior selection as the
      // "compare" anchor and mark `rev` as the new selection.
      if (message.additive && state.selectedCommit && state.selectedCommit !== rev) {
        return {
          ...state,
          compareCommit: state.selectedCommit,
          selectedCommit: rev,
        };
      }
      return {
        ...state,
        selectedCommit: rev,
        compareCommit: undefined,
      };
    }
    case 'history.toggleFollowRenames': {
      const value = typeof message.value === 'boolean' ? message.value : !state.followRenames;
      return { ...state, followRenames: value };
    }
    case 'history.setBranchFilter': {
      const branch =
        typeof message.branch === 'string' && message.branch.length > 0
          ? message.branch
          : undefined;
      return { ...state, branchFilter: branch };
    }
    default:
      return state;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HistoryTab
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hooks the {@link HistoryTab} exposes to its owner (the provider).
 */
export interface IHistoryTabHooks {
  /** Called whenever state changes. Provider uses this to post the update. */
  onStateChange?: (state: IHistoryTabState) => void;
  /** Current repo resolver — returns the repo this tab should query. */
  getRepo?: () => IRepository | undefined;
}

/**
 * Stateful host-side handler for the History tab.
 *
 * The class owns the per-tab state and talks to the GitService. The tab
 * router invokes `handleMessage` for each inbound webview message; the
 * owning provider is notified of state changes via `onStateChange` so it
 * can post updates back to the webview.
 */
export class HistoryTab {
  private _state: IHistoryTabState = createInitialHistoryTabState();
  private readonly _gitService: IGitService;
  private readonly _hooks: IHistoryTabHooks;

  constructor(gitService: IGitService, hooks: IHistoryTabHooks = {}) {
    this._gitService = gitService;
    this._hooks = hooks;
  }

  public getState(): IHistoryTabState {
    return this._state;
  }

  /**
   * Expose a handler compatible with the {@link TabRouter} protocol.
   */
  public asTabHandler(): TabMessageHandler {
    return async (message: IWebviewTabMessage): Promise<void> => {
      await this.handleMessage(message);
    };
  }

  /**
   * Main dispatch. Each case calls into a small async helper; all helpers
   * update `_state` and fire `onStateChange` on mutation.
   */
  public async handleMessage(message: IWebviewTabMessage): Promise<void> {
    if (!message || typeof message.type !== 'string') {
      return;
    }
    switch (message.type) {
      case 'history.loadFile': {
        const path = typeof message.path === 'string' ? message.path : undefined;
        if (!path) {
          return;
        }
        const branch =
          typeof message.branch === 'string' && message.branch.length > 0
            ? message.branch
            : this._state.branchFilter;
        await this.loadFile(path, branch);
        return;
      }
      case 'history.selectRevision':
      case 'history.toggleFollowRenames':
      case 'history.setBranchFilter': {
        const before = this._state;
        this._state = reduceHistoryState(this._state, message);
        if (this._state !== before) {
          this._emit();
          // Branch-filter + follow-renames changes require a reload.
          if (
            message.type === 'history.toggleFollowRenames' ||
            message.type === 'history.setBranchFilter'
          ) {
            if (this._state.filePath) {
              await this.loadFile(this._state.filePath, this._state.branchFilter);
            }
          }
        }
        return;
      }
      case 'history.openAtRevision': {
        const rev = typeof message.rev === 'string' ? message.rev : undefined;
        if (rev) {
          await this.openAtRevision(rev);
        }
        return;
      }
      case 'history.compareWith': {
        const from = typeof message.from === 'string' ? message.from : undefined;
        const to = typeof message.to === 'string' ? message.to : undefined;
        if (from && to) {
          await this.compareWith(from, to);
        }
        return;
      }
      case 'history.compareWithLocal': {
        const rev = typeof message.rev === 'string' ? message.rev : undefined;
        if (rev) {
          await this.compareWithLocal(rev);
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * Programmatic entry point — used by `intellig.showHistory` when the tabbed
   * Git tool window is active. Loads history for `filePath`.
   */
  public async loadFile(filePath: string, branch?: string): Promise<void> {
    const repo = this._getRepo();
    if (!repo) {
      this._state = {
        ...this._state,
        filePath,
        commits: [],
        selectedCommit: undefined,
        compareCommit: undefined,
        error: 'No Git repository found',
        loading: false,
      };
      this._emit();
      return;
    }

    // Set loading state and advertise the path immediately so the UI reflects
    // the intent even before the log call returns.
    this._state = {
      ...this._state,
      filePath,
      branchFilter: branch ?? this._state.branchFilter,
      loading: true,
      error: undefined,
    };
    this._emit();

    try {
      const [commits, branches] = await Promise.all([
        this._gitService.getFileHistory(repo, filePath, {
          follow: this._state.followRenames,
          branch: this._state.branchFilter,
        }),
        this._safeGetBranches(repo),
      ]);

      this._state = {
        ...this._state,
        commits,
        availableBranches: branches,
        selectedCommit: commits.length > 0 ? commits[0].hash : undefined,
        compareCommit: undefined,
        loading: false,
        error: undefined,
      };
      this._emit();
    } catch (err) {
      this._state = {
        ...this._state,
        commits: [],
        selectedCommit: undefined,
        compareCommit: undefined,
        loading: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
      this._emit();
    }
  }

  /**
   * Open the file at the given revision in a read-only editor tab.
   */
  public async openAtRevision(rev: string): Promise<void> {
    if (!this._state.filePath) {
      void vscode.window.showInformationMessage(NO_FILE_LOADED_MESSAGE);
      return;
    }
    const uri = buildFileAtRevisionUri(this._state.filePath, rev);
    try {
      await vscode.commands.executeCommand('vscode.open', uri);
    } catch (err) {
      this._surfaceError(err, `Failed to open ${this._state.filePath} at ${rev}`);
    }
  }

  /**
   * Diff the file at revision `from` against the file at revision `to`.
   */
  public async compareWith(from: string, to: string): Promise<void> {
    if (!this._state.filePath) {
      void vscode.window.showInformationMessage(NO_FILE_LOADED_MESSAGE);
      return;
    }
    const filePath = this._state.filePath;
    const leftUri = buildFileAtRevisionUri(filePath, from);
    const rightUri = buildFileAtRevisionUri(filePath, to);
    const title = buildDiffAnyTwoTitle(filePath, from, to);
    try {
      await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
    } catch (err) {
      this._surfaceError(err, 'Failed to open diff tab');
    }
  }

  /**
   * Diff the file at revision `rev` against the working-copy version.
   */
  public async compareWithLocal(rev: string): Promise<void> {
    if (!this._state.filePath) {
      void vscode.window.showInformationMessage(NO_FILE_LOADED_MESSAGE);
      return;
    }
    const repo = this._getRepo();
    if (!repo) {
      return;
    }
    const filePath = this._state.filePath;
    const leftUri = buildFileAtRevisionUri(filePath, rev);
    // Use `vscode.Uri.joinPath` so the join is always performed against the
    // repo root URI with correct path semantics (POSIX vs Windows), matching
    // the pattern used elsewhere (e.g. CommitContextMenuCommands).
    const rightUri = vscode.Uri.joinPath(repo.rootUri, filePath);
    const title = buildCompareWithLocalTitle(filePath, rev);
    try {
      await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
    } catch (err) {
      this._surfaceError(err, 'Failed to open diff against local');
    }
  }

  private _emit(): void {
    this._hooks.onStateChange?.(this._state);
  }

  private _getRepo(): IRepository | undefined {
    if (this._hooks.getRepo) {
      return this._hooks.getRepo();
    }
    const repos = this._gitService.getRepositories();
    return repos.length > 0 ? repos[0] : undefined;
  }

  private async _safeGetBranches(repo: IRepository): Promise<IBranch[]> {
    try {
      return await this._gitService.getBranches(repo);
    } catch {
      return [];
    }
  }

  private _surfaceError(err: unknown, fallback: string): void {
    const msg = err instanceof Error ? err.message : fallback;
    this._state = { ...this._state, error: msg };
    this._emit();
    void vscode.window.showErrorMessage(sanitizeGitError(msg));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Backwards-compatible factory. Earlier call sites use
 * `createHistoryTabHandler()` with no arguments; that continues to compile
 * because both parameters here are optional. Callers who can supply a
 * GitService + hooks get a fully functional tab.
 */
export function createHistoryTabHandler(
  gitService?: IGitService,
  hooks?: IHistoryTabHooks
): TabMessageHandler {
  if (!gitService) {
    // Safety net for early-boot invocations. Messages are dropped until the
    // provider re-wires the handler with a real gitService.
    return (_message: IWebviewTabMessage): void => {
      /* no-op */
    };
  }
  const tab = new HistoryTab(gitService, hooks ?? {});
  return tab.asTabHandler();
}
