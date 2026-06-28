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
 *   - `history.loadFile`            { path: string, branch?: string,
 *                                     startLine?: number, endLine?: number }
 *                                    (startLine/endLine scope history to a line
 *                                    range via `git log -L` — "Show History for
 *                                    Selection"; omit for whole-file history)
 *   - `history.selectRevision`      { rev: string, additive?: boolean }
 *   - `history.openAtRevision`      { rev: string }
 *   - `history.getVersion`          { rev: string }  ("Get version" — open the
 *                                                     file's content at `rev`)
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
import type {
  FileStatus,
  IBranch,
  ICommit,
  IDiff,
  IGitService,
  IRepository,
} from '../../interfaces/IGitService';
import { sanitizeGitError } from '../../gitError';
import { openRevisionDiff } from '../../diff/openRevisionDiff';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single file changed by the selected revision — the "affected paths" view.
 *
 * A lightweight projection of {@link IDiff} (path + status, plus the pre-rename
 * path) without the hunk/binary payload, since the affected-paths pane only
 * lists the changed files; it does not render their contents. Mirrors the
 * changed-files list IntelliJ shows for a selected commit
 * (`VcsLogChangesBrowser` / the file-history details pane).
 */
export interface IAffectedPath {
  /** Path of the file at the selected revision, relative to the repo root. */
  path: string;
  /** Change kind for the file in this commit. */
  status: FileStatus;
  /** Original path when the file was renamed/copied (status renamed/copied). */
  oldPath?: string;
}

/**
 * Project the full {@link IDiff} list of a commit down to the affected-paths
 * shape the pane renders.
 */
export function mapDiffsToAffectedPaths(diffs: readonly IDiff[]): IAffectedPath[] {
  return diffs.map((d) => ({ path: d.path, status: d.status, oldPath: d.oldPath }));
}

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
  /**
   * Inclusive 1-based line range the history is scoped to (the "Show History
   * for Selection" path, `git log -L`). `undefined` = whole-file history.
   */
  lineRange: { start: number; end: number } | undefined;
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
  /** Files changed by {@link selectedCommit} — the affected-paths pane. */
  affectedPaths: IAffectedPath[];
  /** True while the affected paths for the selected revision are loading. */
  affectedPathsLoading: boolean;
  /** Error string for a failed affected-paths fetch, surfaced in the pane. */
  affectedPathsError: string | undefined;
  /** Branches that contain {@link selectedCommit}; `undefined` while loading. */
  containingBranches: string[] | undefined;
}

export function createInitialHistoryTabState(): IHistoryTabState {
  return {
    filePath: undefined,
    commits: [],
    selectedCommit: undefined,
    compareCommit: undefined,
    branchFilter: undefined,
    lineRange: undefined,
    followRenames: false,
    availableBranches: [],
    error: undefined,
    loading: false,
    affectedPaths: [],
    affectedPathsLoading: false,
    affectedPathsError: undefined,
    containingBranches: undefined,
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
 * Extract an inclusive 1-based line range from a `history.loadFile` message,
 * for the "Show History for Selection" (`git log -L`) path.
 *
 * Returns `undefined` unless both `startLine` and `endLine` are positive
 * integers with `startLine <= endLine`; a malformed or partial range degrades
 * to whole-file history rather than throwing here (the op layer is the
 * authoritative validator).
 */
export function parseLineRange(
  message: IWebviewTabMessage
): { start: number; end: number } | undefined {
  const start = message.startLine;
  const end = message.endLine;
  if (
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 1 ||
    end < start
  ) {
    return undefined;
  }
  return { start, end };
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
        await this.loadFile(path, branch, parseLineRange(message));
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
          } else if (
            message.type === 'history.selectRevision' &&
            this._state.selectedCommit &&
            this._state.selectedCommit !== before.selectedCommit
          ) {
            // A new revision is selected — refresh its affected paths and the
            // containing-branches list.
            await this._loadAffectedPaths(this._state.selectedCommit);
            await this._loadContainingBranches(this._state.selectedCommit);
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
      case 'history.getVersion': {
        const rev = typeof message.rev === 'string' ? message.rev : undefined;
        if (rev) {
          await this.getVersion(rev);
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
   *
   * When `lineRange` is supplied (the "Show History for Selection" path) and
   * the service implements `getLineHistory`, history is scoped to that inclusive
   * 1-based line range via `git log -L`; otherwise it falls back to whole-file
   * history.
   */
  public async loadFile(
    filePath: string,
    branch?: string,
    lineRange?: { start: number; end: number }
  ): Promise<void> {
    const repo = this._getRepo();
    if (!repo) {
      this._state = {
        ...this._state,
        filePath,
        commits: [],
        selectedCommit: undefined,
        compareCommit: undefined,
        lineRange,
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
      lineRange,
      loading: true,
      error: undefined,
    };
    this._emit();

    try {
      const [commits, branches] = await Promise.all([
        this._fetchHistory(repo, filePath, lineRange),
        this._safeGetBranches(repo),
      ]);

      const selectedCommit = commits.length > 0 ? commits[0].hash : undefined;
      this._state = {
        ...this._state,
        commits,
        availableBranches: branches,
        selectedCommit,
        compareCommit: undefined,
        loading: false,
        error: undefined,
        // Reset the affected-paths pane; it is repopulated below for the
        // freshly auto-selected revision (or stays empty when there are none).
        affectedPaths: [],
        affectedPathsLoading: false,
        affectedPathsError: undefined,
        containingBranches: undefined,
      };
      this._emit();
      if (selectedCommit) {
        await this._loadAffectedPaths(selectedCommit);
        await this._loadContainingBranches(selectedCommit);
      }
    } catch (err) {
      this._state = {
        ...this._state,
        commits: [],
        selectedCommit: undefined,
        compareCommit: undefined,
        loading: false,
        error: err instanceof Error ? err.message : 'Unknown error',
        affectedPaths: [],
        affectedPathsLoading: false,
        affectedPathsError: undefined,
      };
      this._emit();
    }
  }

  /**
   * Choose the history source: line-scoped (`git log -L`, "Show History for
   * Selection") when a range is supplied and the service supports it; otherwise
   * whole-file history. Degrading to whole-file history keeps the tab working
   * against narrow mocks / older service builds that omit `getLineHistory`.
   */
  private _fetchHistory(
    repo: IRepository,
    filePath: string,
    lineRange: { start: number; end: number } | undefined
  ): Promise<ICommit[]> {
    const getLineHistory = this._gitService.getLineHistory?.bind(this._gitService);
    if (lineRange && getLineHistory) {
      return getLineHistory(repo, filePath, lineRange.start, lineRange.end, {
        branch: this._state.branchFilter,
      });
    }
    return this._gitService.getFileHistory(repo, filePath, {
      follow: this._state.followRenames,
      branch: this._state.branchFilter,
    });
  }

  /**
   * Fetch the files changed by `rev` and store them as the affected-paths
   * pane content. Backed by the existing `getCommitDiff` op (no new git
   * surface). Guarded for the optional-method shape used by narrow mocks.
   */
  private async _loadAffectedPaths(rev: string): Promise<void> {
    const repo = this._getRepo();
    const getCommitDiff = this._gitService.getCommitDiff?.bind(this._gitService);
    if (!repo || !getCommitDiff) {
      this._state = {
        ...this._state,
        affectedPaths: [],
        affectedPathsLoading: false,
        affectedPathsError: undefined,
      };
      this._emit();
      return;
    }
    this._state = { ...this._state, affectedPathsLoading: true, affectedPathsError: undefined };
    this._emit();
    try {
      const diffs = await getCommitDiff(repo, rev);
      // A later selection may have superseded this fetch; only apply the
      // result if `rev` is still the selected revision.
      if (this._state.selectedCommit !== rev) {
        return;
      }
      this._state = {
        ...this._state,
        affectedPaths: mapDiffsToAffectedPaths(diffs),
        affectedPathsLoading: false,
        affectedPathsError: undefined,
      };
      this._emit();
    } catch (err) {
      if (this._state.selectedCommit !== rev) {
        return;
      }
      this._state = {
        ...this._state,
        affectedPaths: [],
        affectedPathsLoading: false,
        affectedPathsError: err instanceof Error ? err.message : 'Unknown error',
      };
      this._emit();
    }
  }

  /**
   * Fetch the branches that contain `rev` for the details panel's "In branches"
   * line, mirroring {@link _loadAffectedPaths}. `containingBranches` stays
   * `undefined` (rendered as "loading…") until this resolves; an error or a
   * missing service falls back to `[]` ("not in any branch") rather than a
   * stuck spinner. The stale-guard drops a result superseded by a newer select.
   */
  private async _loadContainingBranches(rev: string): Promise<void> {
    const repo = this._getRepo();
    const getContainingBranches = this._gitService.getContainingBranches?.bind(this._gitService);
    if (!repo || !getContainingBranches) {
      this._state = { ...this._state, containingBranches: [] };
      this._emit();
      return;
    }
    this._state = { ...this._state, containingBranches: undefined };
    this._emit();
    try {
      const branches = await getContainingBranches(repo, rev);
      if (this._state.selectedCommit !== rev) {
        return;
      }
      this._state = { ...this._state, containingBranches: branches };
      this._emit();
    } catch {
      if (this._state.selectedCommit !== rev) {
        return;
      }
      this._state = { ...this._state, containingBranches: [] };
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
   * "Get version": load the file's content as of `rev` and open it read-only
   * in an editor. Mirrors IntelliJ's file-history "Get"/open-revision path
   * (`GitFileRevision.loadContent` → `GitFileUtils.getFileContent`), but takes
   * the non-destructive route the slice allows — opening the historical content
   * for inspection / save-as rather than overwriting the working-tree file.
   *
   * The content is fetched through the injection-safe `getFileAtRevision` op
   * (`git show <rev>:<path>`). The fetch is async, so the loaded `filePath` is
   * captured up front and re-checked before opening: if the user loaded a
   * different file mid-flight, the stale result is discarded.
   */
  public async getVersion(rev: string): Promise<void> {
    const filePath = this._state.filePath;
    if (!filePath) {
      void vscode.window.showInformationMessage(NO_FILE_LOADED_MESSAGE);
      return;
    }
    const repo = this._getRepo();
    const getFileAtRevision = this._gitService.getFileAtRevision?.bind(this._gitService);
    if (!repo || !getFileAtRevision) {
      return;
    }
    try {
      const content = await getFileAtRevision(repo, filePath, rev);
      // A newer load may have superseded this fetch — only open if the file
      // we fetched is still the one the tab is showing.
      if (this._state.filePath !== filePath) {
        return;
      }
      const doc = await vscode.workspace.openTextDocument({ content });
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (err) {
      this._surfaceError(err, `Failed to get ${filePath} at ${rev}`);
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
      // Bare (re-throws) so the tab-scoped `_surfaceError` keeps owning the UX.
      await openRevisionDiff({ leftUri, rightUri, title });
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
      // Bare (re-throws) so the tab-scoped `_surfaceError` keeps owning the UX.
      await openRevisionDiff({ leftUri, rightUri, title });
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
