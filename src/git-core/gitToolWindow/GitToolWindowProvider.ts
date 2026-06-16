/**
 * Git Tool Window Provider implementation.
 * Provides the main Git tool window with a 2-panel layout (Graph Panel, Details Panel).
 * Implements VS Code's WebviewViewProvider interface.
 */

import * as vscode from 'vscode';
import {
  IGitToolWindowProvider,
  ILogState,
  IConsoleEntry,
  ILogFilter,
  ICommitDetails,
  IChangedFile,
} from '../../services/interfaces';
import { FileStatus, ICommit, IGitService, IRepository } from '../interfaces/IGitService';
import {
  ICommitNode,
  IBranchRef,
  generateCommitGraph,
  computeTerminalNodes,
  computeChildCountMap,
  computeChildLanesMap,
  computeIncomingBendsMap,
} from '../commitGraph';
import {
  computeActiveLanes,
  computeGraphWidth,
  DEFAULT_GRAPH_CONFIG,
} from '../../utils/graphRenderer';
import { savePanelWidths, loadPanelWidths, DEFAULT_PANEL_WIDTHS } from '../../utils/panelLayout';
import {
  saveColumnWidths,
  loadColumnWidths,
  clampColumnWidths,
  DEFAULT_COLUMN_WIDTHS,
} from '../../utils/columnLayout';
import { TabRouter, type TabId } from './tabRouter';
import { isTabbedGitToolWindowEnabled } from './config';
import { tabStripStyles, wrapTabbedBody } from './html/commonHtml';
import { renderConsoleTabBody } from './html/consoleHtml';
import { renderIncomingTabBody } from './html/incomingHtml';
import { renderUpdateInfoTabBody } from './html/updateInfoHtml';
import {
  renderHistoryTabBody,
  historyTabStyles,
  historyTabBehaviorScript,
} from './html/historyHtml';
import { createLogTabHandler } from './tabs/LogTab';
import { createConsoleTabHandler } from './tabs/ConsoleTab';
import { createIncomingTabHandler } from './tabs/IncomingTab';
import { createUpdateInfoTabHandler } from './tabs/UpdateInfoTab';
import { HistoryTab } from './tabs/HistoryTab';
import { buildInlineScript } from './provider/scriptBuilder';
import { buildCommitRows } from './provider/graphClusterBuilder';
import {
  buildInlineStyles,
  buildThreePanelStyles,
  buildCodiconFontFaceCss,
} from './provider/stylesBuilder';
import type { IGtwControllerContext } from './provider/IGtwControllerContext';
import {
  buildLoadingHtml,
  buildNoRepositoryHtml,
  buildCommitContextMenuHtml,
  buildDetailsPanelPlaceholderHtml,
  buildDetailsPanelHtml,
  buildMultiCommitDetailsPanelHtml,
  escapeHtml,
  getFileStatusColor,
} from './provider/htmlBuilders';
import {
  handleLoadMoreCommits,
  handlePanelResize,
  selectIfNotSelected as handleSelectIfNotSelected,
  toggleCommitSelection as handleToggleCommitSelection,
  selectCommits as handleSelectCommits,
  rangeSelectCommit as handleRangeSelectCommit,
  addRangeSelectCommit as handleAddRangeSelectCommit,
  selectCommit as handleSelectCommit,
} from './provider/messageHandlers';
import { parseRemoteUrl, type IRemoteUrl } from '../../utils/remoteUrl';
import { normalizeRepoPath } from '../../utils/normalizeRepoPath';
import { BaseWebviewView } from '../../utils/BaseWebviewView';
import { getLogger } from '../../utils/logger';
import {
  computeMenuState,
  type IMenuItemState,
  type IMenuStateNode,
  type MultiSelectMenuAction,
} from './multiSelect';

/**
 * View ID for the Git Tool Window
 */
export const GIT_TOOL_WINDOW_VIEW_ID = 'intellig.toolWindow';

/**
 * Default maximum number of console entries to keep
 */
const DEFAULT_MAX_CONSOLE_ENTRIES = 1000;

/**
 * Initial number of commits to load when the Graph Panel is first displayed.
 */
export const INITIAL_COMMIT_LOAD_COUNT = 200;

/**
 * Number of additional commits to load when the user scrolls near the bottom.
 */
export const INCREMENTAL_COMMIT_LOAD_COUNT = 100;

/**
 * IntelliJ-style file status colors
 */
export const INTELLIJ_FILE_STATUS_COLORS: Record<FileStatus, string> = {
  modified: '#6897BB', // Blue for modified files
  added: '#629755', // Green for added files
  deleted: '#6C6C6C', // Gray for deleted files
  renamed: '#6897BB', // Blue for renamed (similar to modified)
  copied: '#629755', // Green for copied (similar to added)
  untracked: '#CC7832', // Orange/brown for untracked files
  ignored: '#848504', // Dark yellow for ignored files
  conflicted: '#FF0000', // Red for conflicted files
};

/**
 * VS Code theme-variable mapping for file statuses. Each
 * status maps to its semantically-correct `gitDecoration-*` token,
 * which themes (especially high-contrast) use to render their own
 * file-status colors. {@link GitToolWindowProvider._getFileStatusColor}
 * wraps this in a `var(...)` expression with
 * {@link INTELLIJ_FILE_STATUS_COLORS} as the fallback.
 *
 * `copied` aliases to `addedResourceForeground` per VS Code's own
 * convention (their built-in git extension applies the same alias).
 *
 * Pinned by `fileStatusTheme-1..8` in detailsPanel.test.ts.
 */
export const FILE_STATUS_THEME_VARS: Record<FileStatus, string> = {
  modified: '--vscode-gitDecoration-modifiedResourceForeground',
  added: '--vscode-gitDecoration-addedResourceForeground',
  deleted: '--vscode-gitDecoration-deletedResourceForeground',
  renamed: '--vscode-gitDecoration-renamedResourceForeground',
  copied: '--vscode-gitDecoration-addedResourceForeground',
  untracked: '--vscode-gitDecoration-untrackedResourceForeground',
  ignored: '--vscode-gitDecoration-ignoredResourceForeground',
  conflicted: '--vscode-gitDecoration-conflictingResourceForeground',
};

/**
 * Context menu action types for Local Changes View
 */
export type LocalChangesContextAction =
  | 'stage'
  | 'unstage'
  | 'revert'
  | 'showDiff'
  | 'moveToChangelist'
  | 'shelve'
  | 'delete';

/**
 * Context menu action types for Log View.
 *
 * MUST be a superset of `MultiSelectMenuAction` from
 * `./multiSelect.ts`. Every menu `data-action` rendered in the webview
 * resolves to a `LogContextAction` arm, and the multi-select gating
 * (visibility / enable / reason) is computed from the
 * `MultiSelectMenuAction` projection. If a new action ONLY participates
 * in multi-select gating, add it to BOTH unions; if it ONLY ships
 * outside the menu (e.g., a keyboard-only action), add it here only.
 *
 * Drift between the two unions is caught at runtime by
 * `multiSelect.test.ts` "every rendered data-action has a matching
 * case in CommitContextMenuCommands._handleAction".
 */
export type LogContextAction =
  | 'copyHash'
  | 'copyCommitMessage'
  | 'createPatch'
  | 'cherryPick'
  | 'checkoutRevision'
  | 'showRepoAtRevision'
  | 'compareWithLocal'
  | 'resetToHere'
  | 'revert'
  | 'undoCommit'
  | 'dropCommit'
  | 'editCommitMessage'
  | 'mergeIntoCurrent'
  | 'interactiveRebase'
  // multi-select-only actions. Stub handlers in
  // CommitContextMenuCommands surface a "lands in " toast until
  // the real implementations land. Adding them to the union (C-2) makes
  // the cast in `_handleCommitContextMenu` truthful again.
  | 'squashCommits'
  | 'compareVersions'
  // IntelliJ-parity additions. Single-only entries
  // that route through dedicated handlers in CommitContextMenuCommands.
  // squashWithPrevious / fixupWithPrevious synthesise a 2-commit selection
  // and reuse `_handleSquashCommits` (single source of truth for the
  // squash plan). compareWithBranch opens a QuickPick listing local +
  // remote branches + tags and routes through BranchComparisonView.
  | 'squashWithPrevious'
  | 'fixupWithPrevious'
  | 'compareWithBranch';

/**
 * Extended Log state with commit nodes for graph visualization
 */
export interface IExtendedLogState extends ILogState {
  commitNodes: ICommitNode[];
  branchMap: Map<string, IBranchRef[]>;
  tagMap: Map<string, string[]>;
  /**
   * Set of commit hashes marked `=` by `git log --cherry-mark`
   * (i.e. equivalent to a commit already on the other side — already
   * cherry-picked). Populated when the extension host fetches marks; the
   * Log tab renders a dim row + ✓ badge for each.
   */
  cherryPickedHashes?: Set<string>;
  /**
   * The base ref used when computing {@link cherryPickedHashes}
   * (typically the upstream branch). Surfaced in the tooltip so users know
   * *which* branch the commit has already been cherry-picked to.
   */
  cherryPickBaseRef?: string;
  /** User-set cherry-compare base ref; overrides the auto-upstream when present. */
  manualCherryCompareRef?: string;
  /**
   * IntelliJ-parity multi-select anchor.
   *
   * The "anchor" is the last single-clicked commit; shift-click ranges
   * are computed inclusively from the anchor to the click target. Plain
   * click sets the anchor to the clicked hash; ctrl/cmd-click also moves
   * the anchor (matches IntelliJ); shift-click leaves the anchor
   * unchanged so the user can extend the range repeatedly.
   *
   * `null` means "no anchor yet" — the first user click of any kind
   * promotes itself to the anchor.
   */
  anchorHash: string | null;
  /**
   * IntelliJ-parity branch focus.
   *
   * The currently-focused branch name. Set by
   * {@link GitToolWindowProvider.setFocusedBranch} when the user invokes
   * the "Focus on Graph" inline action on a branch in the BRANCHES tree
   * view. The chip for this branch is rendered with `branch-label-focused`
   * (outline + bold), and (when is wired) every commit on the path
   * from the branch tip back to its merge-base with HEAD is brightened
   * while every other commit is dimmed.
   *
   * `null` means "no branch focused" — the graph renders at baseline
   * opacity / stroke and no chip carries the focus class. Reset on
   * {@link updateLogState} when the focused branch is no longer present
   * in the new branch list (mirrors the {@link anchorHash} lifecycle).
   */
  focusedBranchName: string | null;
  /**
   * HEAD commit hash sourced from `repo.head?.commit` at
   * `loadLogCommitsForRepo` time. Drives the HEAD chip prepended in
   * {@link GitToolWindowProvider._getBranchLabelsHtml} when a node's
   * hash matches.
   *
   * `undefined` means "no HEAD info available" — chip doesn't render
   * anywhere. Set to a 40-char SHA in the common case (attached or
   * detached HEAD both have a commit). When HEAD is at a commit
   * outside the loaded log window, the chip simply doesn't appear on
   * any visible row.
   */
  headHash?: string;
  /**
   * Name of the branch HEAD points to (the "current branch"), without
   * the `refs/heads/` prefix. Used by
   * {@link GitToolWindowProvider._getBranchLabelsHtml} to keep the
   * current branch's chip inline even when other branch chips on the
   * same commit collapse into the `+N more` summary chip.
   *
   * `undefined` means detached HEAD or unknown — the inline-keep
   * behaviour falls back to the focused-branch tiebreak.
   */
  headBranchName?: string;
}

/**
 * Git Tool Window Provider implementation.
 */
export class GitToolWindowProvider
  extends BaseWebviewView
  implements IGitToolWindowProvider, IGtwControllerContext
{
  private _extendedLogState: IExtendedLogState;
  /**
   * Set of commit hashes on the BFS path from the focused
   * branch tip back to its merge-base with HEAD. Recomputed every time
   * {@link setFocusedBranch} runs; cleared (set to empty) by
   * {@link updateLogState} whenever the focused branch is no longer
   * present in the new branch list. Passed into
   * {@link generateCommitGraph}'s 4th argument so each ICommitNode is
   * tagged with `onFocusedBranchPath`.
   *
   * Initialized as an empty Set (not undefined) so `size` checks are
   * always safe.
   */
  private _focusedPathHashes: Set<string> = new Set();
  private _panelWidths: [number, number];
  /** Fixed-column pixel widths for the log rows: [author, date]. The title
   * column is the flex absorber, so it has no stored width. Persisted to
   * workspace state so a user's drag survives re-render and commit-switch. */
  private _columnWidths: [number, number];
  private readonly _workspaceState: vscode.Memento | undefined;
  private _hasRepository: boolean = false;
  private _isLoading: boolean = true;
  private _scrollToCommitHash: string | undefined;
  private _pendingChangedFiles: IChangedFile[] | undefined;
  private _pendingChangedFilesError: unknown;
  private _consoleEntries: IConsoleEntry[] = [];
  private _maxConsoleEntries: number = DEFAULT_MAX_CONSOLE_ENTRIES;
  private _availableRepositories: IRepository[] = [];
  private _selectedRepositoryIndex: number = 0;

  /**
   * Parsed remote URL for the current repository, cached by repo key.
   * Populated by {@link _setParsedRemoteForSelectedRepo}. Used by
   * {@link _getDetailsPanelHtml} to turn issue/PR refs in commit messages
   * into clickable links.
   *
   * Kept as a map (rather than a single cached value) so repository-selector
   * changes don't thrash the cache when the user flips between repos.
   */
  private readonly _parsedRemoteCache: Map<string, IRemoteUrl | undefined> = new Map();

  /**
   * Host-side tab router.
   *
   * Responsibilities:
   *   - Own active-tab state (default: `log`).
   *   - Handle the `tabChange` meta-message from the webview.
   *   - Publish the `intellig.toolWindow.activeTab` context key on change.
   *   - Dispatch `console.*` / `incoming.*` / `updateInfo.*` / `history.*`
   *     messages to per-tab stub handlers so they don't fall through to the
   *     Log switch.
   *
   * The router is wired even when the tabbed-layout feature flag is off, so
   * tests / callers that post a `tabChange` message while the flag is off
   * still get a sane (no-op) response rather than a TypeError.
   */
  private readonly _tabRouter: TabRouter;

  /**
   * Stateful handler for the History tab. Constructed lazily via
   * `attachGitService()` because the provider predates the service registry.
   */
  private _historyTab: HistoryTab | undefined;

  /**
   * Reference to the GitService set by
   * {@link attachGitService}. Used by {@link setFocusedBranch} to call
   * `getMergeBase` when computing the path-to-merge-base for a focused
   * branch. Optional — when missing (no service attached, or attached
   * service lacks `getMergeBase`), focus still works at the chip-only
   * level but the path treatment is a no-op.
   */
  private _attachedGitService: IGitService | undefined;

  /**
   * Async-race generation
   * counter. {@link setFocusedBranch} bumps this on entry and captures
   * the value as `myGen`; after `await getMergeBase`, the method
   * compares `myGen` to the live counter and bails (no state mutation,
   * no post, no render) when a later focus call has already started.
   * Defends against rapid focus(A) → focus(B) where A's getMergeBase
   * resolves last and would otherwise overwrite B's state.
   *
   * Also covers the parallel race with {@link updateLogState}: a
   * refresh that lands while focus(A) is awaiting bumps the counter,
   * so A's continuation sees the bump and bails — preserving the
   * (possibly cleared) post-refresh focus state.
   */
  private _focusGeneration = 0;

  /**
   * Disposable for the `onDidChangeRepository` subscription wired by
   * {@link attachGitService}. Held so a second `attachGitService` call (e.g.
   * in tests) can dispose the prior subscription before wiring a new one.
   */
  private _remoteCacheSubscription: vscode.Disposable | undefined;

  // Event emitters
  private readonly _onDidChangeState = new vscode.EventEmitter<void>();
  private readonly _onDidRequestContextAction = new vscode.EventEmitter<{
    action: LocalChangesContextAction;
    files: string[];
    targetChangelistId?: string;
  }>();
  private readonly _onDidRequestFileDrop = new vscode.EventEmitter<{
    files: string[];
    targetChangelistId: string;
  }>();
  private readonly _onDidRequestLogContextAction = new vscode.EventEmitter<{
    action: LogContextAction;
    commitHashes: string[];
    /**
     * NEWEST-FIRST commit-node
     * projection at dispatch time. Each entry is the slim
     * `IMenuStateNode { hash, parentCount }` (already used by the menu
     * helper). Handlers derive `displayOrder` via
     * `commitNodes.map(n => n.hash)` and look up parents via
     * `commitNodes.find(n => n.hash === oldestHash)?.parentCount`.
     *
     * Collapsed the prior parallel records (`displayOrder: string[]`
     * and `parentCounts: Record<string, number>`) to this single
     * structurally-typed list — one source of truth, one lookup, one
     * test fixture shape. ADR-009 §6 covers the
     * chronological-replay direction conventions.
     */
    commitNodes: readonly IMenuStateNode[];
  }>();
  private readonly _onDidSelectCommit = new vscode.EventEmitter<string>();
  private readonly _onDidRequestCommitDiff = new vscode.EventEmitter<{
    commitHash: string;
    filePath: string;
  }>();
  private readonly _onDidRequestLogFilter = new vscode.EventEmitter<ILogFilter | undefined>();

  /**
   * Event emitter that fires when the user sets (or clears) the manual
   * cherry-compare base ref. A ref string overrides the auto-upstream used
   * for `git log --cherry-mark`; `undefined` reverts to auto-upstream.
   */
  private readonly _onDidRequestCherryCompareRef = new vscode.EventEmitter<string | undefined>();

  /**
   * Event emitter for requesting more commits to be loaded incrementally.
   */
  private readonly _onDidRequestLoadMoreCommits = new vscode.EventEmitter<void>();

  /**
   * Event emitter that fires when the webview is first resolved, signaling
   * the extension host to fetch initial branch and commit data.
   */
  private readonly _onDidRequestInitialData = new vscode.EventEmitter<void>();

  /**
   * Event emitter that fires when the repository changes and all panels
   * should be refreshed with the latest data.
   */
  private readonly _onDidRequestRefresh = new vscode.EventEmitter<void>();

  /**
   * Event emitter that fires when the user selects a different repository
   * from the repository selector in the webview.
   */
  private readonly _onDidSelectRepository = new vscode.EventEmitter<IRepository>();

  // Public events
  public readonly onDidChangeState = this._onDidChangeState.event;
  public readonly onDidRequestContextAction = this._onDidRequestContextAction.event;
  public readonly onDidRequestFileDrop = this._onDidRequestFileDrop.event;
  public readonly onDidRequestLogContextAction = this._onDidRequestLogContextAction.event;
  public readonly onDidSelectCommit = this._onDidSelectCommit.event;
  public readonly onDidRequestLogFilter = this._onDidRequestLogFilter.event;
  public readonly onDidRequestCherryCompareRef = this._onDidRequestCherryCompareRef.event;

  /**
   * Event fired when the webview requests more commits to be loaded.
   */
  public readonly onDidRequestLoadMoreCommits = this._onDidRequestLoadMoreCommits.event;
  public readonly onDidRequestCommitDiff = this._onDidRequestCommitDiff.event;

  /**
   * Event fired when the webview is first resolved, signaling the extension host
   * to fetch initial branch and commit data.
   */
  public readonly onDidRequestInitialData = this._onDidRequestInitialData.event;

  /**
   * Event fired when the repository changes and all panels should be refreshed.
   */
  public readonly onDidRequestRefresh = this._onDidRequestRefresh.event;

  /**
   * Event fired when the user selects a different repository from the
   * repository selector in the webview.
   */
  public readonly onDidSelectRepository = this._onDidSelectRepository.event;

  constructor(extensionUri: vscode.Uri, workspaceState?: vscode.Memento) {
    super(extensionUri);
    // Initialize extended log state
    this._extendedLogState = this._createInitialExtendedLogState();

    // Store workspace state for panel width persistence
    this._workspaceState = workspaceState;

    // Load persisted panel widths or use defaults
    this._panelWidths = workspaceState
      ? loadPanelWidths(workspaceState)
      : [...DEFAULT_PANEL_WIDTHS];

    // Load persisted log-column widths or use defaults
    this._columnWidths = workspaceState
      ? loadColumnWidths(workspaceState)
      : [...DEFAULT_COLUMN_WIDTHS];

    // Register event emitters for disposal
    this._disposables.push(
      this._onDidChangeState,
      this._onDidRequestContextAction,
      this._onDidRequestFileDrop,
      this._onDidRequestLogContextAction,
      this._onDidSelectCommit,
      this._onDidRequestCommitDiff,
      this._onDidRequestLogFilter,
      this._onDidRequestCherryCompareRef,
      this._onDidRequestLoadMoreCommits,
      this._onDidRequestInitialData,
      this._onDidRequestRefresh,
      this._onDidSelectRepository
    );

    // Construct the tab router and register per-tab handlers.
    // The Log handler is intentionally a no-op; the existing
    // `_handleWebviewMessage` switch continues to own Log dispatch.
    this._tabRouter = new TabRouter({
      onActiveTabChanged: (_tab: TabId): void => {
        // Re-render the webview so the new active panel becomes visible.
        // (Inactive panels use `display: none`; a re-render is the simplest
        // way to update `aria-selected` / `aria-hidden` / `style.display`
        // consistently. Future iterations may flip display in JS.)
        this._updateWebview();
      },
    });
    this._tabRouter.register('log', createLogTabHandler());
    this._tabRouter.register('console', createConsoleTabHandler());
    this._tabRouter.register('incoming', createIncomingTabHandler());
    this._tabRouter.register('updateInfo', createUpdateInfoTabHandler());
    // History tab placeholder handler — replaced by `attachGitService()` once
    // the extension host wires this provider to a GitService instance.
    this._tabRouter.register('history', (_m) => {
      /* no-op until GitService attaches */
    });
  }

  /**
   * Attach a GitService to the History tab.
   *
   * The provider is constructed before the service registry is wired, so we
   * register a placeholder history handler in the constructor and swap it
   * out when the extension host calls this method. Calling with a different
   * service replaces the current tab (so tests can rebind).
   */
  public attachGitService(gitService: IGitService): void {
    // Hold the reference for `setFocusedBranch` →
    // `getMergeBase`. Re-attaches replace the prior reference.
    this._attachedGitService = gitService;

    this._historyTab = new HistoryTab(gitService, {
      onStateChange: (): void => {
        // A state change in the History tab means its HTML needs re-rendering.
        // We piggyback on the existing _updateWebview() path.
        if (this._tabRouter.getActiveTab() === 'history') {
          this._updateWebview();
        }
      },
    });
    this._tabRouter.register('history', this._historyTab.asTabHandler());

    // Parsed-remote cache must be invalidated whenever a repository
    // mutates (e.g. the user runs `git remote set-url`), otherwise
    // `_getDetailsPanelHtml` keeps rendering issue/PR links against the old
    // forge URL until the extension reloads. Subscribe once per attached
    // service and drop both the prior subscription and any stale cache
    // entries on re-attach.
    //
    // Deliberately NOT pushed into `_disposables`: that
    // would leak a stale entry per re-attach (the disposed disposable stays
    // pinned in the array). The subscription is disposed in {@link dispose}
    // instead, which always holds exactly one reference to the live one.
    this._remoteCacheSubscription?.dispose();
    this._remoteCacheSubscription = gitService.onDidChangeRepository(
      (changed: IRepository): void => {
        if (changed) {
          // Invalidate only the entry for the repo that actually changed so
          // unrelated repos keep their cached parse result.
          this._parsedRemoteCache.delete(changed.rootUri.fsPath);
        } else {
          // Defensive: unkeyed event — blow the whole cache away.
          this._parsedRemoteCache.clear();
        }
      }
    );
    // Fresh attach — any cache entries accumulated against the previous
    // service instance are now stale by definition.
    this._parsedRemoteCache.clear();
  }

  /**
   * Load a file's history into the History tab and reveal it.
   *
   * Called by the `intellig.showHistory` command when the tabbed layout flag
   * is on. Falls back silently when no GitService has been attached yet.
   */
  public async loadFileHistory(filePath: string, branch?: string): Promise<void> {
    if (!this._historyTab) {
      return;
    }
    await this._tabRouter.setActiveTab('history');
    await this._historyTab.loadFile(filePath, branch);
  }

  /**
   * Programmatically focus a tab. Exposed so the extension host can react to
   * `intellig.toolWindow.focusTab` command invocations (e.g. a StatusBarService
   * click jumping to the Incoming tab).
   */
  public async focusTab(tab: TabId): Promise<void> {
    await this._tabRouter.setActiveTab(tab);
  }

  /**
   * Read-only accessor for the currently active tab.
   * Primarily intended for unit tests and future integrations.
   */
  public getActiveTab(): TabId {
    return this._tabRouter.getActiveTab();
  }

  /**
   * Create initial extended Log state with commit nodes
   */
  private _createInitialExtendedLogState(): IExtendedLogState {
    return {
      selectedCommits: new Set<string>(),
      expandedCommit: undefined,
      filter: undefined,
      commitNodes: [],
      branchMap: new Map<string, IBranchRef[]>(),
      tagMap: new Map<string, string[]>(),
      anchorHash: null,
      // No branch focused at start.
      focusedBranchName: null,
    };
  }

  /**
   * Resolve the webview view when it becomes visible.
   * Called by VS Code when the view needs to be displayed.
   *
   * On first resolution, fires the `onDidRequestInitialData` event so the
   * extension host can fetch initial branch and commit data
   * or detect that no repository is available.
   */
  /**
   * Subclass hook for {@link BaseWebviewView.resolveWebviewView}. The base
   * class has already set webview options, assigned `this._view`, wired
   * `onDidReceiveMessage` → {@link _handleMessage}, wired `onDidDispose` to
   * clear `this._view`, and performed the initial render via {@link _render}.
   *
   * Here we add GitToolWindow-specific wiring:
   *   - Re-render on visibility change (so the panel repopulates when the user
   *     switches back after hiding the view).
   *   - Fire {@link onDidRequestInitialData} so the extension host can fetch
   *     branches + commits + repository availability.
   */
  protected override _onResolve(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    // Handle visibility changes
    webviewView.onDidChangeVisibility(
      () => {
        if (webviewView.visible) {
          this._updateWebview();
        }
      },
      undefined,
      this._disposables
    );

    // Fire the initial data request event so the extension host can
    // fetch branches, commits, and detect repository availability.
    this._onDidRequestInitialData.fire();
  }

  /**
   * Bridge from the base class's generic `_handleMessage` hook to the
   * already-tested `_handleWebviewMessage` method.
   */
  protected _handleMessage(message: unknown): void {
    this._handleWebviewMessage(message as IWebviewMessage);
  }

  /**
   * Get the current state of the tool window
   */
  public getState(): { hasRepository: boolean } {
    return { hasRepository: this._hasRepository };
  }

  /**
   * Refresh the tool window content.
   * Fires the onDidRequestRefresh event so the extension host can
   * re-fetch data and update all panels.
   */
  public refresh(): void {
    this._updateWebview();
    this._onDidChangeState.fire();
    this._onDidRequestRefresh.fire();
  }

  /**
   * Add a console entry
   */
  public addConsoleEntry(entry: Omit<IConsoleEntry, 'timestamp'>): void {
    const fullEntry: IConsoleEntry = {
      ...entry,
      timestamp: new Date(),
    };

    this._consoleEntries.push(fullEntry);

    // Trim entries if exceeding max
    while (this._consoleEntries.length > this._maxConsoleEntries) {
      this._consoleEntries.shift();
    }

    this._onDidChangeState.fire();
  }

  /**
   * Clear console entries
   */
  public clearConsole(): void {
    this._consoleEntries = [];
    this._onDidChangeState.fire();
  }

  /**
   * Set repository availability.
   * When set to false, the webview displays a "no repository" prompt
   *.
   */
  public setHasRepository(hasRepository: boolean): void {
    const wasLoading = this._isLoading;
    this._isLoading = false;
    if (this._hasRepository !== hasRepository || wasLoading) {
      this._hasRepository = hasRepository;
      this._updateWebview();
      this._onDidChangeState.fire();
    }
  }

  /**
   * Convenience method to set the no-repository state.
   * Displays a prompt to the user to initialize a repository.
   *
   * display a single message prompting the user to initialize a repository.
   */
  public setNoRepository(): void {
    this.setHasRepository(false);
  }

  /**
   * Update the Log state with commits
   */
  public updateLogState(
    commits: ICommit[],
    branchMap?: Map<string, IBranchRef[]>,
    tagMap?: Map<string, string[]>,
    headHash?: string,
    headBranchName?: string
  ): void {
    // The graph caller fetches `git log --topo-order` (extension.ts),
    // so `commits` arrives in a topology-respecting order: every
    // parent of a commit appears later in the list (or off-window).
    // We DON'T re-sort by date here — that step used to dominate
    // topology after a squash/rebase (fresh committerDate for the
    // rewritten commits collapsed divergent branches into the wrong
    // place in the list), which the algorithm faithfully rendered as
    // a linear graph. Trust the topo-ordered input instead.

    // re-validate the focused branch against the new
    // branch list. If the focus target disappeared (force-push, branch
    // rename, repo switch), null it out and clear the cached path-hash
    // set. The `commitNodes` we then generate get `onFocusedBranchPath:
    // false` for every node, which is the no-focus baseline.
    const branchNamesPresent = new Set<string>();
    if (branchMap) {
      for (const refs of branchMap.values()) {
        for (const ref of refs) {
          branchNamesPresent.add(ref.name);
        }
      }
    }
    const currentFocusName = this._extendedLogState.focusedBranchName;
    const newFocusName =
      currentFocusName && branchNamesPresent.has(currentFocusName) ? currentFocusName : null;
    if (newFocusName === null) {
      // Focus was either already off or invalidated by this update;
      // either way the cached path is stale.
      // Bump `_focusGeneration` so any
      // in-flight setFocusedBranch awaiting `getMergeBase` sees the
      // bump and bails. We only need to bump on the cleared-focus
      // path: a refresh that KEEPS the focus name doesn't invalidate
      // an in-flight continuation (whichever computed merge-base wins
      // is still semantically correct — the branch is still here).
      if (currentFocusName !== null) {
        this._focusGeneration += 1;
      }
      this._focusedPathHashes = new Set();
    }

    const commitNodes = generateCommitGraph(
      commits,
      branchMap,
      tagMap,
      this._focusedPathHashes.size > 0 ? this._focusedPathHashes : undefined,
      headBranchName,
      // Pass the explicit HEAD commit SHA so the lane algorithm can anchor
      // HEAD's mainline spine to lane 0 even when the branch NAME can't be
      // resolved (detached HEAD, getBranches failure, symbolic-ref race).
      // Previously dropped here, which silently disabled the spine fix and
      // let a divergent branch seize lane 0 — the reported mainline split.
      headHash
    );

    const emptyBranchMap: Map<string, IBranchRef[]> = new Map();
    const emptyTagMap: Map<string, string[]> = new Map();

    // Anchor lifecycle (TL-C-1):
    //   - Prune `selectedCommits` to the intersection with the new commit
    //     hashes so a force-push / log-filter that drops commits doesn't
    //     leave dangling selection state pointing at hashes that aren't
    //     in the rendered graph anymore.
    //   - Reset `anchorHash` to `null` when the anchor is no longer in
    //     the new list. JS `let anchorHash` mirror is reset by the
    //     `syncSelection` message we post below + by reading the
    // `data-anchor-hash` attribute on the next render.
    const newHashes = new Set(commitNodes.map((n) => n.commit.hash));
    const prunedSelection = new Set<string>();
    for (const h of this._extendedLogState.selectedCommits) {
      if (newHashes.has(h)) {
        prunedSelection.add(h);
      }
    }
    const currentAnchor = this._extendedLogState.anchorHash;
    const newAnchor = currentAnchor && newHashes.has(currentAnchor) ? currentAnchor : null;

    this._extendedLogState = {
      ...this._extendedLogState,
      commitNodes,
      branchMap: branchMap || emptyBranchMap,
      tagMap: tagMap || emptyTagMap,
      selectedCommits: prunedSelection,
      anchorHash: newAnchor,
      focusedBranchName: newFocusName,
      headHash,
      headBranchName,
    };

    this._hasRepository = true;
    this._isLoading = false;
    this._updateWebview();
    // Fire BEFORE the post sequence.
    // Aligns with the 5 setters and ADR-009 §3 generalised rule:
    // any host method that calls `_post*` helpers fires `onDidChangeState`
    // first so subscribers see "state changed" on the same event-loop
    // tick the host knows it.
    this._onDidChangeState.fire();
    this._postSyncSelection();
    this._postMenuStateUpdate();
  }

  /**
   * Set the log filter
   */
  public setLogFilter(filter: ILogFilter | undefined): void {
    this._extendedLogState.filter = filter;
    this._onDidChangeState.fire();
  }

  /**
   * Populate the cherry-pick classification for the current log.
   *
   * `hashes` is the set of commit hashes that git considers equivalent
   * (`=` mark) to commits already on {@link baseRef}. The UI renders those
   * rows dimmed with a ✓ badge. Pass `undefined` / empty to clear.
   *
   * Gated by the `intellig.log.highlightCherryPicked` config — when the
   * flag is off, the caller should pass `undefined` so the UI stays clean.
   */
  public setCherryPickedHashes(hashes: Set<string> | undefined, baseRef?: string): void {
    this._extendedLogState.cherryPickedHashes = hashes && hashes.size > 0 ? hashes : undefined;
    this._extendedLogState.cherryPickBaseRef = baseRef;
    this._updateWebview();
    this._onDidChangeState.fire();
  }

  /**
   * Store the manual cherry-compare base ref and notify the extension host so
   * it can re-run the cherry-mark computation against that ref. An empty ref
   * clears the override (fires `undefined`) so cherry marks revert to the
   * auto-upstream.
   */
  private _handleSetCherryCompareRef(ref: string): void {
    this._extendedLogState.manualCherryCompareRef = ref || undefined;
    this._onDidRequestCherryCompareRef.fire(ref || undefined);
  }

  /**
   * The user-set cherry-compare base ref, if any. The extension host passes
   * this back into the cherry-mark computation on repo-change refreshes so the
   * manual choice survives reloads. `undefined` means auto-upstream.
   */
  public getManualCherryCompareRef(): string | undefined {
    return this._extendedLogState.manualCherryCompareRef;
  }

  /**
   * Get the extended log state with commit nodes
   */
  public getExtendedLogState(): IExtendedLogState {
    return {
      ...this._extendedLogState,
      selectedCommits: new Set(this._extendedLogState.selectedCommits),
      branchMap: new Map(this._extendedLogState.branchMap),
      tagMap: new Map(this._extendedLogState.tagMap),
    };
  }

  /**
   * Scroll to the commit currently loaded in the graph that matches
   * the given hash. Extension-level code resolves the user's query (SHA
   * prefix / branch name / tag name) to a full hash via
   * {@link findCommitByQuery} and then hands that hash here.
   *
   * Posts a `scrollToCommit` message to the webview and stores the hash so
   * a subsequent full re-render also scrolls. Also updates the selection so
   * the details panel reflects the newly-highlighted commit.
   *
   * @returns `true` when the hash was found in the loaded commits;
   *          `false` when it wasn't (caller decides what to surface).
   */
  public scrollToCommit(hash: string): boolean {
    if (!hash) {
      return false;
    }
    const loadedCommits = this._extendedLogState.commitNodes;
    const matched = loadedCommits.some((n) => n.commit.hash === hash);
    if (!matched) {
      return false;
    }

    this._scrollToCommitHash = hash;
    this.selectCommit(hash);

    if (this._view) {
      void this._view.webview.postMessage({
        type: 'scrollToCommit',
        commitHash: hash,
      });
    }
    return true;
  }

  /**
   * Select a commit in the log view
   */
  public selectCommit(hash: string): void {
    handleSelectCommit(this, hash);
  }

  /**
   * Update the commit details with fetched changed files.
   * Called by the extension host after fetching diff data for a selected commit.
   *
   * @param hash - The commit hash to update details for
   * @param changedFiles - The changed files fetched from git diff
   * @param error - Optional error if the diff fetch failed
   */
  public updateCommitDetails(hash: string, changedFiles: IChangedFile[], error?: unknown): void {
    // Only update if this commit is still the expanded commit
    if (this._extendedLogState.expandedCommit !== hash) {
      return;
    }

    // Store the changed files and error for use in the next render
    this._pendingChangedFiles = changedFiles;
    this._pendingChangedFilesError = error;

    // Send a partial update to the webview instead of a full re-render
    // to preserve the graph panel's scroll position
    if (this._view) {
      const node = this._extendedLogState.commitNodes.find((n) => n.commit.hash === hash);
      if (node) {
        const commitDetails: ICommitDetails = {
          hash: node.commit.hash,
          message: node.commit.message,
          body: node.commit.body,
          author: { name: node.commit.author.name, email: node.commit.author.email },
          date: node.commit.authorDate,
          parents: node.commit.parents || [],
          branches: (node.branches || []).map((ref) => ref.name),
          tags: node.tags || [],
          changedFiles,
          changedFilesError: error ? String(error) : undefined,
        };
        const detailsHtml = this._getDetailsPanelHtml(commitDetails);
        void this._view.webview.postMessage({
          type: 'updateDetailsPanel',
          html: detailsHtml,
        });
      }
    }
  }

  /**
   * Toggle commit selection (for multi-select)
   */
  public toggleCommitSelection(hash: string): void {
    handleToggleCommitSelection(this, hash);
  }

  // IGtwControllerContext — capability methods for extracted handlers. Each is
  // a one-line dynamic delegation to the in-class impl (or emitter), read off
  // `this` on every call: the webview reference and the EventEmitter stay
  // encapsulated on the provider, and the underlying instance methods stay
  // patchable so the render-then-post ordering tests (which reassign
  // _updateWebview / _onDidChangeState.fire / _postSyncSelection /
  // _postMenuStateUpdate on the instance) observe the real call order. Do not
  // inline these bodies or capture the references — that would hide the patch.
  updateWebview(): void {
    this._updateWebview();
  }

  fireDidChangeState(): void {
    this._onDidChangeState.fire();
  }

  postSyncSelection(): void {
    this._postSyncSelection();
  }

  postMenuStateUpdate(): void {
    this._postMenuStateUpdate();
  }

  /**
   * Programmatic selection setter.
   *
   * Public API for B/C/scripted entry points: replaces the current
   * selection with `hashes`, sets `anchorHash` to `anchor` (or `null`
   * when omitted, or to the first hash when omitted and the selection
   * is non-empty). Hashes not in the rendered `commitNodes` are silently
   * dropped — matches the same virtualization-tolerant policy used by
   * {@link rangeSelectCommit}.
   *
   * Does NOT fire `onDidSelectCommit` (the event is for click-driven
   * single-select) but DOES fire `onDidChangeState` and post
   * `updateMenuEnableState` so the webview stays in sync.
   */
  public selectCommits(hashes: readonly string[], anchor?: string | null): void {
    handleSelectCommits(this, hashes, anchor);
  }

  // IGtwControllerContext — clear the pending changed-files payload + its
  // error together (they always clear as a pair, so a single mutation method
  // keeps the invariant rather than exposing two writable fields).
  clearPendingChangedFiles(): void {
    this._pendingChangedFiles = undefined;
    this._pendingChangedFilesError = undefined;
  }

  // IGtwControllerContext — capability methods for the single-select handler.
  // Each is a dynamic delegation read off `this` on every call (never a
  // captured reference), so the webview reference and the onDidSelectCommit
  // emitter stay encapsulated on the provider and the underlying instance
  // methods stay patchable for the render-then-post ordering tests.
  hasView(): boolean {
    return !!this._view;
  }

  postToWebview(msg: unknown): void {
    void this._view?.webview.postMessage(msg);
  }

  fireDidSelectCommit(hash: string): void {
    this._onDidSelectCommit.fire(hash);
  }

  getDetailsPanelHtml(details: ICommitDetails): string {
    return this._getDetailsPanelHtml(details);
  }

  getDetailsPanelPlaceholderHtml(): string {
    return this._getDetailsPanelPlaceholderHtml();
  }

  /**
   * host-side mirror of "right-click on a non-selected
   * commit moves selection to that commit". Called by the webview when
   * the user opens the context menu on a row that isn't in
   * `selectedCommits`. No-op when the hash is already part of the
   * selection — the multi-select stays intact so the action targets all
   * selected commits.
   */
  public selectIfNotSelected(hash: string): void {
    handleSelectIfNotSelected(this, hash);
  }

  // IGtwControllerContext — the LIVE extended log state. Returns the single
  // class-owned field by reference (not a copy) so extracted handlers read +
  // mutate exactly the state the class holds.
  get extendedLogState(): IExtendedLogState {
    return this._extendedLogState;
  }

  /**
   * Shift+click range-select.
   *
   * Replaces the existing selection with the inclusive range from the
   * current `anchorHash` to `hash` (in display order). When `anchorHash`
   * is `null` (no prior click) or has scrolled out of the rendered
   * commit list (virtualization), falls back to {@link selectCommit}
   * behavior + sets the anchor to the clicked hash.
   *
   * Anchor is intentionally NOT moved — IntelliJ semantics so the user
   * can keep extending the range from the same anchor.
   */
  public rangeSelectCommit(hash: string): void {
    handleRangeSelectCommit(this, hash);
  }

  // IGtwControllerContext — dynamic delegation to the in-class details-panel
  // post (keeps the webview ref encapsulated + the method patchable for the
  // ordering tests, same as the other postX delegations).
  postDetailsForExpandedCommit(): void {
    this._postDetailsForExpandedCommit();
  }

  /**
   * Shift+Ctrl+click additive range-select.
   *
   * Adds the inclusive range from `anchorHash` to `hash` to the existing
   * selection. With anchor null, falls back to a single toggle so the
   * first click still has an effect. Anchor is unchanged.
   */
  public addRangeSelectCommit(hash: string): void {
    handleAddRangeSelectCommit(this, hash);
  }

  /**
   * Get selected commit hashes in DISPLAY ORDER (newest-first; matches
   * what the user sees in the log). Introduced the
   * display-order projection so consumers see hashes in the
   * order the user expects rather than Set-iteration order.
   *
   * **WARNING for chronological-replay consumers (cherry-pick, rebase):**
   * Display order is NEWEST-FIRST. Operations that replay commits onto
   * a branch (cherry-pick, rebase) MUST `.reverse()` the result to
   * apply commits OLDEST-FIRST; otherwise authored-order is destroyed
   * and `git log` shows the new commits backwards relative to the
   * source branch..
   *
   * Handlers that batch-apply commits should call:
   *
   * ```ts
   * const replayOrder = [...provider.getSelectedCommits()].reverse();
   * for (const hash of replayOrder) {
   *   await cherryPick(repo, hash);
   * }
   * ```
   *
   * Hashes that aren't in `commitNodes` are dropped (mirrors the rest
   * of the multi-select policy).
   */
  public getSelectedCommits(): readonly string[] {
    const set = this._extendedLogState.selectedCommits;
    const out: string[] = [];
    for (const node of this._extendedLogState.commitNodes) {
      if (set.has(node.commit.hash)) {
        out.push(node.commit.hash);
      }
    }
    return out;
  }

  /**
   * Selected commit hashes in OLDEST-FIRST replay
   * order: chronologically older commits first, suitable for any git
   * operation that replays commits onto a branch (cherry-pick, drop,
   * squash, rebase). Returns `getSelectedCommits().slice().reverse()`.
   *
   * The naming is the explicit-direction antidote to the chronological-
   * replay footgun documented in `getSelectedCommits()`'s WARNING:
   *   - Use `getSelectedCommits()` for display-order consumers (clipboard
   *     copy, status-bar count, `Compare Versions` lhs/rhs picking, or
   *     revert where newest-first is the right replay direction).
   *   - Use `getSelectedCommitsOldestFirst()` for chronological-replay
   *     consumers (cherry-pick, drop, squash, rebase).
   *
   * Aimed at external programmatic callers (palette commands, scripted
   * entry points) and handlers. 's webview-driven dispatch
   * receives display-order via the event payload and
   * `.reverse()`s inline at the call site for cherry-pick — both
   * approaches converge on the same direction. ADR-009 §6.
   *
   * @returns Hashes in oldest-first replay order; `[]` when no selection.
   */
  public getSelectedCommitsOldestFirst(): readonly string[] {
    return this.getSelectedCommits().slice().reverse();
  }

  /**
   * Tear down subclass-owned disposables that deliberately bypass
   * `_disposables` (see S-2 rationale on {@link attachGitService}), then
   * delegate to the base class for the standard drain + `_view` clear.
   *
   * Idempotent: after the first call the subscription handle is cleared, so
   * a second `dispose()` won't double-dispose it; `BaseWebviewView.dispose`
   * guards on `_disposed` regardless.
   */
  public override dispose(): void {
    this._remoteCacheSubscription?.dispose();
    this._remoteCacheSubscription = undefined;
    super.dispose();
  }

  /**
   * host-side menu-state computation.
   *
   * The host is the source of truth for which menu items are visible /
   * enabled. Whenever selection or commit-list state changes, we
   * recompute via {@link computeMenuState} and post the result to the
   * webview. The JS side has a tiny apply-loop that toggles classes per
   * the precomputed map — no rule duplication.
   *
   * Cheap: the helper is O(N) on `commitNodes.length` and runs per
   * selection edit, not per render.
   */
  private _postMenuStateUpdate(): void {
    if (!this._view) {
      return;
    }
    const commitNodes = this._extendedLogState.commitNodes.map((n) => ({
      hash: n.commit.hash,
      parentCount: (n.commit.parents || []).length,
    }));
    // Read the real head hash from state. This used
    // `commitNodes[0].hash` which assumed HEAD was the newest commit; that's
    // only true when HEAD is at the tip of the loaded log. In detached state
    // at an older commit, the bogus assumption made `computeMenuState`'s
    // HEAD-membership rule (which gates "Reset to here", "Squash", etc.)
    // wrong for any commit that wasn't the top row. TG-.
    const headHash = this._extendedLogState.headHash ?? '';
    const state = computeMenuState({
      selectedHashes: this._extendedLogState.selectedCommits,
      commitNodes,
      headHash,
    });
    const msg: WaveAOutboundMessage = {
      type: 'updateMenuEnableState',
      state,
      selectedCount: this._extendedLogState.selectedCommits.size,
    };
    void this._view.webview.postMessage(msg);
  }

  /**
   * (TL-C-1) — sync the webview's `let anchorHash` mirror with
   * the freshly-computed host anchor after a re-render that may have
   * pruned the prior anchor. The webview JS reads
   * {@link IExtendedLogState.anchorHash} from the rendered
   * `data-anchor-hash` attribute on full re-render; this message handles
   * the partial-update case (e.g. a programmatic `selectCommits` that
   * doesn't trigger a full HTML rebuild).
   */
  private _postSyncSelection(): void {
    if (!this._view) {
      return;
    }
    const msg: WaveAOutboundMessage = {
      type: 'syncSelection',
      anchorHash: this._extendedLogState.anchorHash,
      selectedHashes: Array.from(this._extendedLogState.selectedCommits),
    };
    void this._view.webview.postMessage(msg);
  }

  /**
   * Push an `updateDetailsPanel` message for the current
   * `expandedCommit`. Used by the range-select handlers (which
   * deliberately avoid `_updateWebview()` to preserve commit-row
   * focus for keyboard navigation) so the details pane still
   * reflects the latest range tip without re-rendering the graph.
   *
   * Mirrors the inline post path in {@link selectCommit}.
   */
  private _postDetailsForExpandedCommit(): void {
    if (!this._view) {
      return;
    }
    const expanded = this._extendedLogState.expandedCommit;
    if (!expanded) {
      return;
    }
    const node = this._extendedLogState.commitNodes.find((n) => n.commit.hash === expanded);
    if (!node) {
      const placeholderHtml = this._getDetailsPanelPlaceholderHtml();
      void this._view.webview.postMessage({
        type: 'updateDetailsPanel',
        html: placeholderHtml,
      });
      return;
    }
    const commitDetails: ICommitDetails = {
      hash: node.commit.hash,
      message: node.commit.message,
      body: node.commit.body,
      author: { name: node.commit.author.name, email: node.commit.author.email },
      date: node.commit.authorDate,
      parents: node.commit.parents || [],
      branches: (node.branches || []).map((ref) => ref.name),
      tags: node.tags || [],
      changedFiles: [],
    };
    const detailsHtml = this._getDetailsPanelHtml(commitDetails);
    void this._view.webview.postMessage({
      type: 'updateDetailsPanel',
      html: detailsHtml,
    });
  }

  /**
   * Handle messages from the webview
   */
  private _handleWebviewMessage(message: IWebviewMessage): void {
    // Intercept router-owned messages (tabChange + non-Log tabs).
    // This is intentionally a synchronous pre-filter so the existing Log
    // switch below keeps its exact pre-refactor invocation ordering.
    if (this._routeIfNonLog(message)) {
      return;
    }
    switch (message.type) {
      case 'refresh':
        this.refresh();
        break;
      case 'selectCommit':
        if (message.commitHash) {
          this._handleCommitSelection(message.commitHash);
        }
        break;
      case 'toggleCommitSelection':
        if (message.commitHash) {
          this.toggleCommitSelection(message.commitHash);
        }
        break;
      case 'rangeSelectCommit':
        // shift+click: replace selection with [anchor..click].
        // The user's click anchor travels in the message and
        // wins over the host's cached anchorHash. Ensures the host honours
        // the JS view of the world for this single click instead of
        // consulting a cache that can be one render stale (ADR-009 §3).
        // Real type narrow — accept string|null only,
        // ignore wrong-type fields (a rogue / bug-mutated webview can't
        // poison the host state).
        if (message.commitHash) {
          if (typeof message.anchorHash === 'string' || message.anchorHash === null) {
            this._extendedLogState.anchorHash = message.anchorHash;
          }
          this.rangeSelectCommit(message.commitHash);
        }
        break;
      case 'addRangeSelectCommit':
        // shift+ctrl+click: ADD [anchor..click] to existing selection.
        // Same message-anchor-wins contract as rangeSelectCommit.
        // Same type narrow.
        if (message.commitHash) {
          if (typeof message.anchorHash === 'string' || message.anchorHash === null) {
            this._extendedLogState.anchorHash = message.anchorHash;
          }
          this.addRangeSelectCommit(message.commitHash);
        }
        break;
      case 'selectIfNotSelected':
        // right-click on a non-selected commit.
        if (message.commitHash) {
          this.selectIfNotSelected(message.commitHash);
        }
        break;
      case 'initRepository':
        void vscode.commands.executeCommand('git.init');
        break;
      case 'commitContextMenu':
        if (message.action && message.commitHashes) {
          this._handleCommitContextMenu(message.action as LogContextAction, message.commitHashes);
        }
        break;
      case 'doubleClickFile':
        if (message.commitHash && message.path) {
          // opens a VS Code diff view for that file at the selected commit.
          this._handleCommitFileDoubleClick(message.commitHash, message.path);
        } else if (message.path) {
          // Fallback: when no commitHash is provided, fire a showDiff context action
          this._onDidRequestContextAction.fire({
            action: 'showDiff',
            files: [message.path],
          });
        }
        break;
      case 'doubleClickCommitFile':
        if (message.commitHash && message.path) {
          this._handleCommitFileDoubleClick(message.commitHash, message.path);
        }
        break;
      case 'applyLogFilter':
        this._handleApplyLogFilter(message.filter as IWebviewLogFilter | null);
        break;
      case 'requestLogFilterOptions':
        void this._handleRequestLogFilterOptions();
        break;
      case 'clearLogFilter':
        // Fired by the "Clear filter" button on the filtered-empty
        // graph state. Clearing is just applying a null filter, which
        // resets `_extendedLogState.filter` and re-fires the log-filter
        // event so the host reloads the unfiltered commit list.
        this._handleApplyLogFilter(null);
        break;
      case 'branchClick':
        if (message.branchName) {
          this._handleBranchClick(message.branchName);
        }
        break;
      case 'loadMoreCommits':
        this._handleLoadMoreCommits();
        break;
      case 'panelResize':
        if (message.widths) {
          this._handlePanelResize(message.widths);
        }
        break;
      case 'columnResize':
        if (message.widths) {
          this._handleColumnResize(message.widths);
        }
        break;
      case 'selectRepository':
        if (message.repositoryIndex !== undefined) {
          this._handleRepositorySelection(message.repositoryIndex);
        }
        break;
      case 'focusBranchOnGraph':
        // Webview asked to focus the graph on a branch.
        // The bridge is async (getMergeBase + scroll); fire-and-forget.
        //
        // (security) — the branchName arrives
        // from the webview, which is untrusted; combined with the
        // `git merge-base <refA> <refB>` argv shape this can become a
        // git-option-injection if a string like `--upload-pack=evil`
        // is passed in. Validate against the *current* host-known
        // branch list before propagating; on mismatch, drop silently.
        // The argv hardening (`--end-of-options` separator) lives in
        // GitService.getMergeBase.
        if (message.branchName === null) {
          void this.setFocusedBranch(null);
        } else if (typeof message.branchName === 'string') {
          const known = this._collectKnownBranchNames();
          if (known.has(message.branchName)) {
            void this.setFocusedBranch(message.branchName);
          }
          // else: silently drop — webview is desync'd or compromised.
        }
        break;
      default:
        getLogger()
          .child({ component: 'GitToolWindowProvider' })
          .warn('unknown webview message type', {
            messageType: typeof message.type === 'string' ? message.type : '<non-string>',
          });
    }
  }

  /**
   * Pre-filter webview messages through the tab router.
   *
   * Returns `true` if the message was consumed (tabChange meta-message, or a
   * non-Log-tab message routed to a stub handler) — in that case the caller
   * short-circuits the Log switch.
   *
   * Returns `false` for any message the router considers Log-scoped (including
   * all implicit-`log`-tab messages like `selectCommit`, `panelResize`, etc.),
   * so the pre-refactor switch runs unchanged.
   *
   * Errors from the (async) router are swallowed — the Log tab must never
   * regress because the router threw.
   */
  private _routeIfNonLog(message: IWebviewMessage): boolean {
    try {
      const dispatchPromise = this._tabRouter.dispatch(
        message as unknown as Record<string, unknown> & { type: string }
      );
      // The router's internal state mutations (setActiveTab, handler calls)
      // happen synchronously on the first microtask. For message types we
      // need to short-circuit (tabChange + non-Log prefixes), we can determine
      // the answer synchronously by inspecting the type without awaiting.
      // Kick the promise so any `await`ed work inside handlers runs, but
      // don't block here.
      void dispatchPromise.catch(() => {});
    } catch {
      // Unreachable — dispatch is noexcept, but belt-and-suspenders.
      return false;
    }
    const type = typeof message.type === 'string' ? message.type : '';
    if (type === 'tabChange') {
      return true;
    }
    if (
      type.startsWith('console.') ||
      type.startsWith('incoming.') ||
      type.startsWith('updateInfo.') ||
      type.startsWith('history.')
    ) {
      return true;
    }
    return false;
  }

  /**
   * Handle applying log filter from webview
   */
  private _handleApplyLogFilter(webviewFilter: IWebviewLogFilter | null): void {
    let filter: ILogFilter | undefined;

    if (webviewFilter) {
      filter = {};

      if (webviewFilter.branch) {
        // IntelliJ BranchFilterModel: a value containing `..`/`...` is a range
        // (VcsLogRangeFilter), not a single branch ref — route it accordingly.
        if (webviewFilter.branch.includes('..')) {
          filter.logRange = webviewFilter.branch;
        } else {
          filter.branch = webviewFilter.branch;
        }
      }
      if (webviewFilter.searchText) {
        filter.searchText = webviewFilter.searchText;
        // Mode flags only matter alongside search text; a toggle with no text
        // is not a filter criterion, so it must not keep the filter "active".
        if (webviewFilter.searchRegex) {
          filter.searchRegex = true;
        }
        if (webviewFilter.searchCaseSensitive) {
          filter.searchCaseSensitive = true;
        }
      }
      if (webviewFilter.author) {
        filter.author = webviewFilter.author;
      }
      if (webviewFilter.path) {
        filter.path = webviewFilter.path;
      }
      if (webviewFilter.since) {
        filter.since = new Date(webviewFilter.since);
      }
      if (webviewFilter.until) {
        filter.until = new Date(webviewFilter.until);
      }
      if (webviewFilter.noMerges) {
        filter.noMerges = true;
      }
      if (webviewFilter.firstParent) {
        filter.firstParent = true;
      }
      if (webviewFilter.simplifyMerges) {
        filter.simplifyMerges = true;
      }
      // Treat 0 as "not set" (0 min-parents is git's default anyway).
      if (webviewFilter.minParents) {
        filter.minParents = webviewFilter.minParents;
      }
      if (webviewFilter.maxParents) {
        filter.maxParents = webviewFilter.maxParents;
      }

      // Check if filter is empty
      if (
        !filter.branch &&
        !filter.logRange &&
        !filter.searchText &&
        !filter.author &&
        !filter.path &&
        !filter.since &&
        !filter.until &&
        !filter.noMerges &&
        !filter.firstParent &&
        !filter.simplifyMerges &&
        !filter.minParents &&
        !filter.maxParents
      ) {
        filter = undefined;
      }
    }

    this.setLogFilter(filter);
    this._onDidRequestLogFilter.fire(filter);

    // Cherry-compare ref: separate from filter criteria — does not affect which
    // commits are shown, only which are highlighted as cherry-picked equivalents.
    const cherryCompareRef = webviewFilter?.cherryCompareRef?.trim() ?? '';
    this._handleSetCherryCompareRef(cherryCompareRef);
  }

  /**
   * Fetch ref-aware filter options (branch names + distinct authors) for
   * the active repo and post them back so the webview can populate the
   * branch/author datalists. Silent no-op when no repo or service is
   * attached — the datalists simply stay empty.
   */
  private async _handleRequestLogFilterOptions(): Promise<void> {
    const repo = this.getSelectedRepository();
    const gitService = this._attachedGitService;
    if (!repo || !gitService) {
      return;
    }
    const [branches, contributors] = await Promise.all([
      gitService.getBranches(repo),
      gitService.getLogContributors(repo),
    ]);
    if (!this._view) {
      return;
    }
    void this._view.webview.postMessage({
      type: 'logFilterOptionsReady',
      branches: branches.map((b) => b.name),
      contributors,
    });
  }

  /**
   * Handle commit selection in Log view
   */
  private _handleCommitSelection(commitHash: string): void {
    this.selectCommit(commitHash);
  }

  /**
   * Navigate the graph to a branch's HEAD commit.
   * Public wrapper around the branch-click logic so that external callers
   * (e.g. the native BRANCHES tree view selection handler) can scroll the
   * graph to a given branch.
   *
   * and highlights the latest commit of that branch.
   */
  public navigateToBranch(branchName: string): void {
    this._handleBranchClick(branchName);
  }

  /**
   * Focus the graph on a branch.
   *
   * Resolves the branch's tip commit, scrolls the graph to it, computes
   * the BFS path back to the merge-base with HEAD, updates internal
   * state, fires `onDidChangeState` (per ADR-009 §3 fire-before-post),
   * posts a `branchFocusUpdate` partial-update message to the webview,
   * and triggers a full re-render so the focus class lands on the
   * branch chip in the next render pass.
   *
   * Distinct from {@link navigateToBranch} (single-click on the chip,
   * which only scrolls). The plan specifies a separate inline command
   * `intellig.branch.focusOnGraph` so the user opts into focus
   * deliberately rather than getting it on every chip click.
   *
   * Ordering corrected to render-then-post per
   * ADR-009 §3 (generalisation): every method that calls
   * `_post*` helpers does `_updateWebview() → fire → _post*()` so the
   * post lands on the new document, not the doomed pre-render one.
   *
   * The `_focusGeneration` guard bails
   * after `await getMergeBase` if a later focus call (or
   * updateLogState) has bumped the counter, so rapid focus switches
   * don't land state in the wrong order.
   *
   * Does NOT mutate selection state. Uses
   * {@link _scrollWebviewToCommit} (post-only) so a user's mid-shift-
   * click range survives a focus toggle.
   *
   * @param branchName - The branch to focus. When `null`, clears focus.
   */
  public async setFocusedBranch(branchName: string | null): Promise<void> {
    // Bump generation counter. Capture for post-await
    // staleness check.
    this._focusGeneration += 1;
    const myGen = this._focusGeneration;

    if (branchName === null) {
      // Clear focus — chip class drops, path empties, graph re-renders
      // baseline. Cheap because every branch goes through here on the way
      // out (e.g. user re-clicks the icon to toggle off).
      this._extendedLogState.focusedBranchName = null;
      this._focusedPathHashes = new Set();
      this._regenerateCommitNodesForFocus();
      // ADR-009 §3 — render FIRST, fire, then post.
      // Posting before render means the post lands on the doomed
      // pre-reload document.
      this._updateWebview();
      this._onDidChangeState.fire();
      this._postBranchFocusUpdate(null, null);
      return;
    }

    // Resolve the branch's tip commit hash by scanning the branchMap and,
    // as a fallback, the per-node `branches` array (mirrors
    // `_handleBranchClick`).
    const targetHash = this._resolveBranchTipHash(branchName);
    if (!targetHash) {
      // Branch isn't in the loaded log. We still set the focus name so a
      // subsequent updateLogState that DOES contain it lights up the
      // chip — this matches IntelliJ's "focus persists until cleared"
      // behavior. The path remains empty.
      this._extendedLogState.focusedBranchName = branchName;
      this._focusedPathHashes = new Set();
      this._regenerateCommitNodesForFocus();
      this._updateWebview();
      this._onDidChangeState.fire();
      this._postBranchFocusUpdate(branchName, null);
      return;
    }

    // Compute the path from `targetHash` back through
    // `commitNodes` to the merge-base of `HEAD` and the branch.
    let pathHashes = new Set<string>();
    const repo = this.getSelectedRepository();
    if (repo && this._attachedGitService?.getMergeBase) {
      // T-8: getMergeBase may return undefined (no common ancestor / git
      // error). In that case `mergeBaseHash` is undefined and the BFS
      // walks until it exhausts loaded nodes — the "all walked commits
      // are on path" trap-handler in {@link _bfsPathToMergeBase}.
      let mergeBaseHash: string | undefined;
      try {
        mergeBaseHash = await this._attachedGitService.getMergeBase(repo, 'HEAD', branchName);
      } catch {
        // Defensive — same as undefined.
        mergeBaseHash = undefined;
      }

      // Staleness check after `await`. If a later
      // setFocusedBranch / updateLogState bumped the counter, OR if
      // the focused branch is no longer in the current branchMap
      // (refresh dropped it), bail: the live state already reflects
      // the newer intent and overwriting it would regress.
      if (myGen !== this._focusGeneration) {
        return;
      }
      const known = this._collectKnownBranchNames();
      if (!known.has(branchName)) {
        return;
      }

      pathHashes = this._bfsPathToMergeBase(targetHash, mergeBaseHash);
    }

    this._focusedPathHashes = pathHashes;
    this._extendedLogState.focusedBranchName = branchName;

    // Re-tag commit nodes with onFocusedBranchPath now that the path set
    // is populated. updateLogState would also do this, but
    // setFocusedBranch fires WITHOUT a commit-list refresh, so we walk
    // the existing nodes and patch the flag in place.
    this._regenerateCommitNodesForFocus();

    // ADR-009 §3 — render-then-fire-then-post.
    this._updateWebview();
    this._onDidChangeState.fire();
    this._postBranchFocusUpdate(branchName, targetHash);

    // non-selecting scroll: bring the tip into view
    // WITHOUT clearing the user's selection / anchor / expandedCommit.
    this._scrollWebviewToCommit(targetHash);
  }

  /**
   * read-only accessor for the current focus
   * name. Used by the `intellig.branch.focusOnGraph` command handler in
   * extension.ts to implement toggle semantics: clicking the same
   * branch's eye icon a second time clears focus.
   */
  public getFocusedBranchName(): string | null {
    return this._extendedLogState.focusedBranchName;
  }

  /**
   * Collect every branch name visible to the
   * host (i.e. listed in `branchMap.values()` or any `commitNodes[].
   * branches`). The webview-message handler validates against this set
   * before propagating to {@link setFocusedBranch}, defending against
   * a malicious / desynced webview that posts arbitrary strings.
   */
  private _collectKnownBranchNames(): Set<string> {
    const names = new Set<string>();
    for (const list of this._extendedLogState.branchMap.values()) {
      for (const ref of list) {
        names.add(ref.name);
      }
    }
    for (const node of this._extendedLogState.commitNodes) {
      if (node.branches) {
        for (const ref of node.branches) {
          names.add(ref.name);
        }
      }
    }
    return names;
  }

  /**
   * non-selecting scroll. Posts a
   * `scrollToCommit` message to the webview without touching
   * `selectedCommits`, `expandedCommit`, or `anchorHash`.
   *
   * The caller-facing {@link scrollToCommit} pairs scroll with
   * `selectCommit` because its existing callers (jump-to-hash, branch
   * click) want both. Branch-focus does NOT — a focus toggle should
   * preserve a user's mid-shift-click range.
   */
  private _scrollWebviewToCommit(hash: string): void {
    if (!this._view) {
      return;
    }
    const matched = this._extendedLogState.commitNodes.some((n) => n.commit.hash === hash);
    if (!matched) {
      return;
    }
    this._scrollToCommitHash = hash;
    void this._view.webview.postMessage({
      type: 'scrollToCommit',
      commitHash: hash,
    });
  }

  /**
   * Resolve a branch name to its tip commit hash by inspecting the
   * branchMap and (as a fallback) the per-node branches array.
   * Returns undefined when the branch isn't in the loaded log.
   */
  private _resolveBranchTipHash(branchName: string): string | undefined {
    for (const [commitHash, branches] of this._extendedLogState.branchMap.entries()) {
      if (branches.some((ref) => ref.name === branchName)) {
        return commitHash;
      }
    }
    for (const node of this._extendedLogState.commitNodes) {
      if (node.branches && node.branches.some((ref) => ref.name === branchName)) {
        return node.commit.hash;
      }
    }
    return undefined;
  }

  /**
   * BFS over `commitNodes`'s parent edges from `targetHash`
   * back to `mergeBaseHash`. Every visited commit (inclusive of the merge
   * base when found) is added to the result set.
   *
   * Trap T-1: cap walking at `commitNodes.length` to defend against
   * cyclic / corrupt parent chains. When the BFS exhausts loaded nodes
   * without finding the merge-base, the result is the full set of walked
   * commits (no infinite loop, partial highlight).
   *
   * Trap T-8: when `mergeBaseHash` is undefined (no common ancestor or
   * git error), the BFS still walks until exhaustion or until it leaves
   * the loaded commit set — same partial-highlight outcome.
   *
   * orphan-branch behavior. When the focused
   * branch shares no common ancestor with HEAD (e.g. `git checkout
   * --orphan`), `getMergeBase` returns undefined and this BFS walks
   * the entire loaded ancestry of the focused branch. That over-
   * highlights compared to a strict "tip → merge-base" path, but is
   * the safe conservative default — every commit the user can see
   * from the focused branch is "on path" from focus's perspective.
   * Documented in `docs/parity/git-log-graph.md` §3.3.
   */
  private _bfsPathToMergeBase(targetHash: string, mergeBaseHash: string | undefined): Set<string> {
    const path = new Set<string>();
    const nodeByHash = new Map<string, ICommitNode>();
    for (const node of this._extendedLogState.commitNodes) {
      nodeByHash.set(node.commit.hash, node);
    }

    if (!nodeByHash.has(targetHash)) {
      return path;
    }

    const queue: string[] = [targetHash];
    const cap = this._extendedLogState.commitNodes.length;
    let walked = 0;
    while (queue.length > 0) {
      if (walked >= cap) {
        // Trap T-1 — bail on suspected corrupt parent chain.
        break;
      }
      const head = queue.shift()!;
      if (path.has(head)) {
        continue;
      }
      path.add(head);
      walked += 1;

      // If we just reached the merge-base, stop expanding from this
      // branch of the BFS.
      if (mergeBaseHash !== undefined && head === mergeBaseHash) {
        continue;
      }

      const node = nodeByHash.get(head);
      if (!node) {
        continue;
      }
      for (const parent of node.commit.parents) {
        if (!path.has(parent) && nodeByHash.has(parent)) {
          queue.push(parent);
        }
      }
    }
    return path;
  }

  /**
   * re-tag every node's `onFocusedBranchPath` flag against
   * the current `_focusedPathHashes` set. Cheaper than re-running
   * {@link generateCommitGraph}, and the lane assignments don't change
   * with focus state.
   */
  private _regenerateCommitNodesForFocus(): void {
    const path = this._focusedPathHashes;
    const tagged: ICommitNode[] = this._extendedLogState.commitNodes.map((node) => ({
      ...node,
      onFocusedBranchPath: path.has(node.commit.hash),
    }));
    this._extendedLogState = {
      ...this._extendedLogState,
      commitNodes: tagged,
    };
  }

  /**
   * Post a `branchFocusUpdate` message to the webview
   * with the current focus name and resolved tip hash. The webview's
   * inline-script handler caches this into a `branchFocus` local and
   * toggles the `branch-label-focused` class on `[data-branch-name]`
   * chips so a partial state update (no full re-render) keeps the chip
   * in sync.
   *
   * `focusedPathHashes` was dropped from the
   * payload: the JS handler only ever read `focusedBranchName` /
   * `focusedHash`. The path data flows host-side via
   * {@link _focusedPathHashes}; the SVG dim/brighten lands during the
   * full re-render that follows this post (see {@link setFocusedBranch}
   * tail).
   */
  private _postBranchFocusUpdate(
    focusedBranchName: string | null,
    focusedHash: string | null
  ): void {
    if (!this._view) {
      return;
    }
    void this._view.webview.postMessage({
      type: 'updateBranchFocus',
      focusedBranchName,
      focusedHash,
    });
  }

  /**
   * Handle branch click to scroll the Graph Panel to the branch's HEAD commit.
   * Finds the branch's HEAD commit hash from the loaded commit nodes and branch map,
   * then selects that commit and asks the webview to scroll to it.
   *
   * Uses the partial-update path (selectCommit + _scrollWebviewToCommit) rather
   * than a full re-render, so the graph panel's scroll position is preserved. The
   * visibility-aware inline scrollToCommit then only scrolls when the target row is
   * not already fully visible, and highlights the latest commit of that branch.
   */
  private _handleBranchClick(branchName: string): void {
    // Look up the commit hash for this branch from the branch map
    const branchMap = this._extendedLogState.branchMap;
    let targetCommitHash: string | undefined;

    // The branchMap maps commit hash -> branch refs[]
    // We need to find the commit hash that has this branch name
    for (const [commitHash, branches] of branchMap.entries()) {
      if (branches.some((ref) => ref.name === branchName)) {
        targetCommitHash = commitHash;
        break;
      }
    }

    // If not found in branchMap, search through commit nodes for a matching branch reference
    if (!targetCommitHash) {
      for (const node of this._extendedLogState.commitNodes) {
        if (node.branches && node.branches.some((ref) => ref.name === branchName)) {
          targetCommitHash = node.commit.hash;
          break;
        }
      }
    }

    if (targetCommitHash) {
      // Use the partial-update path (no full re-render) so the graph panel's
      // scroll position is preserved. selectCommit posts selectGraphRow +
      // updateDetailsPanel; _scrollWebviewToCommit posts { type: 'scrollToCommit',
      // commitHash } which the now visibility-aware inline scrollToCommit gates.
      // Avoiding _updateWebview() means scrollTop is never reset to the top, so
      // the inline visibility check runs against the user's real scroll position.
      this.selectCommit(targetCommitHash);
      this._scrollWebviewToCommit(targetCommitHash);
    }
  }

  // IGtwControllerContext — fire-only access to the load-more emitter, so
  // extracted handlers can request more commits without reaching the emitter
  // object (which would also expose subscribe + dispose).
  fireLoadMoreCommits(): void {
    this._onDidRequestLoadMoreCommits.fire();
  }

  /**
   * Handle the loadMoreCommits message from the webview.
   * Fires the onDidRequestLoadMoreCommits event so that the extension host
   * can fetch the next batch of commits and append them.
   */
  private _handleLoadMoreCommits(): void {
    handleLoadMoreCommits(this);
  }

  /**
   * Handle panel resize message from the webview.
   * Receives new width percentages from the draggable dividers,
   * updates the internal state, and persists them to workspace state.
   *
   * @param widths - The new panel width percentages [graph, details]
   */
  private _handlePanelResize(widths: [number, number]): void {
    handlePanelResize(this, widths);
  }

  // IGtwControllerContext — apply new panel widths. Owns the write + persist
  // as one atomic operation so extracted handlers never touch _workspaceState
  // and can't update the widths without persisting them.
  setPanelWidths(widths: [number, number]): void {
    // Update internal panel widths state
    this._panelWidths = widths;

    // Persist to workspace state if available
    if (this._workspaceState) {
      savePanelWidths(this._workspaceState, widths);
    }
  }

  /**
   * Get the current panel widths.
   * Returns the persisted panel width percentages.
   *
   * @returns The current panel width percentages [graph, details]
   */
  public getPanelWidths(): [number, number] {
    return [...this._panelWidths];
  }

  /**
   * Handle a log-column resize message from the webview.
   *
   * The webview posts the live [author, date] pixel widths as the user drags
   * a column-header divider. We clamp them to the per-column min/max (so a
   * column can never be dragged to zero) and persist, mirroring the panel
   * splitter's write-and-persist coupling. No re-render is triggered — the
   * webview already applied the new width to its CSS custom properties live
   * during the drag; persistence just makes the change survive the next
   * full re-render (commit-switch, filter, repo-change).
   *
   * @param widths - The new [author, date] column widths in pixels.
   */
  private _handleColumnResize(widths: [number, number]): void {
    this._columnWidths = clampColumnWidths(widths);
    if (this._workspaceState) {
      saveColumnWidths(this._workspaceState, this._columnWidths);
    }
  }

  /**
   * Get the current log-column widths.
   *
   * @returns The current [author, date] column widths in pixels.
   */
  public getColumnWidths(): [number, number] {
    return [...this._columnWidths];
  }

  /**
   * Set the list of available repositories discovered in the workspace.
   * If the currently selected repository index is out of bounds after the update,
   * it falls back to the first available repository.
   * If no repositories are available, the selected index is reset to 0.
   *
   * Invariant — repo selector identity must be stable by **path**, not
   * by index, across rebuilds that shift the list (e.g. drop-commit
   * triggering a workspace re-scan). This method is the rebuild boundary
   * that path-based hardening routes through. See
   * `docs/design/git-tool-window-spec.md` §8.L5 and §8.L14
   * (`normalizeRepoPath` helper).
   *
   * @param repos - Array of discovered repositories
   */
  public setAvailableRepositories(repos: IRepository[]): void {
    // Identity-stable selection across reloads.
    //
    // Keying by INDEX alone broke after any mutation that triggered
    // `loadAllPanelData` (drop commit, squash, rebase, etc.). The
    // gitService's repo cache iteration order is insertion-order, and
    // a watcher tear-down + re-add (which happens on
    // reloadRepository's invalidate path) can shift a repo's slot in
    // the cache — making `_selectedRepositoryIndex = 2` silently
    // point at a DIFFERENT repo on the next render. Symptom: user
    // dropped a commit on repo A, dropdown silently jumped to repo B.
    //
    // Fix: remember the selected repo's `rootUri.fsPath` BEFORE
    // overwriting `_availableRepositories`, then re-resolve the index
    // by matching that path against the new list. Falls back to 0
    // when the previously-selected repo is no longer present (folder
    // removed from workspace) — the prior contract.
    // Identity comparison goes through `normalizeRepoPath` (L14) so a
    // Windows drive-letter-case or slash-flavor difference between the
    // old and new list entries doesn't read as a different repo and
    // silently drop the user's selection.
    const previousSelected = this._availableRepositories[this._selectedRepositoryIndex];
    const previousSelectedPath = previousSelected
      ? normalizeRepoPath(previousSelected.rootUri)
      : undefined;

    this._availableRepositories = repos;

    if (repos.length === 0) {
      this._selectedRepositoryIndex = 0;
    } else if (previousSelectedPath !== undefined) {
      const matched = repos.findIndex((r) => normalizeRepoPath(r.rootUri) === previousSelectedPath);
      this._selectedRepositoryIndex = matched >= 0 ? matched : 0;
    } else if (this._selectedRepositoryIndex >= repos.length) {
      // No prior selection (cold start) and the saved index is
      // out-of-bounds — fall back to first.
      this._selectedRepositoryIndex = 0;
    }

    this._updateWebview();
    this._onDidChangeState.fire();
  }

  /**
   * Get the currently selected repository.
   * Returns undefined if no repositories are available.
   *
   * @returns The selected repository, or undefined if none available
   */
  public getSelectedRepository(): IRepository | undefined {
    if (this._availableRepositories.length === 0) {
      return undefined;
    }
    return this._availableRepositories[this._selectedRepositoryIndex];
  }

  /**
   * Handle repository selection from the webview.
   * Clamps the index to the valid range (0 to repos.length - 1) and logs a warning
   * if the index is out of bounds. Updates the selected index and fires the
   * onDidSelectRepository event so the extension host can re-fetch data.
   *
   * @param index - The repository index selected by the user
   */
  private _handleRepositorySelection(index: number): void {
    if (this._availableRepositories.length === 0) {
      return;
    }

    // Clamp to valid range
    let clampedIndex = index;
    if (index < 0 || index >= this._availableRepositories.length) {
      getLogger()
        .child({ component: 'GitToolWindowProvider' })
        .warn('repository index out of bounds; clamping to valid range', {
          index,
          maxIndex: this._availableRepositories.length - 1,
        });
      clampedIndex = Math.max(0, Math.min(index, this._availableRepositories.length - 1));
    }

    this._selectedRepositoryIndex = clampedIndex;
    this._onDidChangeState.fire();

    const selectedRepo = this._availableRepositories[clampedIndex];
    this._onDidSelectRepository.fire(selectedRepo);
  }

  /**
   * Handle commit context menu action from the Graph Panel.
   * Fires the same event as the log context menu, since both operate on commits.
   */
  private _handleCommitContextMenu(action: LogContextAction, commitHashes: string[]): void {
    // Validate every targeted hash is still in the
    // rendered commit list. The webview's selection state can drift
    // mid-action if a refresh / force-push / log-filter change happens
    // between the user opening the menu and clicking the action. Aborting
    // with a toast is safer than silently firing the action with stale
    // hashes (which could target the wrong commits after a rebase).
    const known = new Set(this._extendedLogState.commitNodes.map((n) => n.commit.hash));
    const stale = commitHashes.filter((h) => !known.has(h));
    if (stale.length > 0) {
      void vscode.window.showInformationMessage(
        'Commit selection changed since the menu opened — please retry.'
      );
      return;
    }
    // Push the slim newest-first
    // commit-node projection forward so handlers don't call back into
    // the provider. ADR-009 §6 covers the direction convention.
    // Collapsed the prior parallel records (`displayOrder` and
    // `parentCounts`) to this single typed list — same data, one
    // lookup, one test-fixture shape.
    const commitNodes: IMenuStateNode[] = this._extendedLogState.commitNodes.map((n) => ({
      hash: n.commit.hash,
      parentCount: (n.commit.parents || []).length,
    }));
    this._onDidRequestLogContextAction.fire({
      action,
      commitHashes,
      commitNodes,
    });
  }

  /**
   * Handle double-click on a file in commit details
   */
  private _handleCommitFileDoubleClick(commitHash: string, filePath: string): void {
    this._onDidRequestCommitDiff.fire({
      commitHash,
      filePath,
    });
  }

  /**
   * Update the webview content. Delegates to the base class's idempotent,
   * dispose-safe {@link BaseWebviewView._render} — which in turn calls our
   * {@link _render} override (below).
   */
  private _updateWebview(): void {
    this._render();
  }

  /**
   * Base-class render override. GitToolWindowProvider produces a full
   * `<!DOCTYPE html>…</html>` document via {@link _getHtmlContent} (the
   * legacy {@link _getThreePanelHtmlContent} family is public for tests and
   * owns its own CSP envelope). Rather than re-template in the base, we
   * override `_render` to assign `_getHtmlContent(view.webview)` directly.
   *
   * The base class still owns dispose-safety: this override is only called
   * when `this._view` is defined and `!this._disposed`.
   */
  protected override _render(): void {
    if (this._disposed) {
      return;
    }
    const view = this._view;
    if (!view) {
      return;
    }
    view.webview.html = this._getHtmlContent(view.webview);
  }

  /**
   * Get the HTML content for the webview.
   * Now delegates to the 2-panel layout.
   */
  private _getHtmlContent(webview: vscode.Webview): string {
    // Show loading state while initial data is being fetched
    if (this._isLoading) {
      return this._getLoadingHtml(webview);
    }

    // If no repository, show init prompt
    if (!this._hasRepository) {
      return this._getNoRepositoryHtml(webview);
    }

    const commitNodes = this._extendedLogState.commitNodes;
    const selectedCommits = this._extendedLogState.selectedCommits;
    const expandedCommit = this._extendedLogState.expandedCommit;

    // Build commit details if a commit is expanded
    let commitDetails: ICommitDetails | undefined;
    if (expandedCommit) {
      const node = commitNodes.find((n) => n.commit.hash === expandedCommit);
      if (node) {
        commitDetails = {
          hash: node.commit.hash,
          message: node.commit.message,
          body: node.commit.body,
          author: { name: node.commit.author.name, email: node.commit.author.email },
          date: node.commit.authorDate,
          parents: node.commit.parents || [],
          branches: (node.branches || []).map((ref) => ref.name),
          tags: node.tags || [],
          changedFiles:
            this._pendingChangedFiles && this._extendedLogState.expandedCommit === node.commit.hash
              ? this._pendingChangedFiles
              : [],
          changedFilesError:
            this._pendingChangedFilesError &&
            this._extendedLogState.expandedCommit === node.commit.hash
              ? String(this._pendingChangedFilesError)
              : undefined,
        };
      }
    }

    return this._getThreePanelHtmlContent(
      webview,
      commitNodes,
      commitDetails,
      this._panelWidths,
      selectedCommits,
      commitNodes.length,
      commitNodes.length
    );
  }

  /**
   * Generate the complete HTML document for the 2-panel layout.
   *
   * Produces a flexbox-based layout with two panels (Graph, Details)
   * arranged horizontally from left to right, separated by a draggable divider.
   *
   * Panel widths are set via inline styles based on the provided panelWidths
   * percentages. When the container width is less than 500px, panels stack
   * vertically via CSS.
   *
   * This method is public for testability.
   *
   * @param webview - The VS Code Webview instance (used for CSP source)
   * @param commitNodes - Commit nodes for the graph panel
   * @param commitDetails - Optional commit details for the details panel
   * @param panelWidths - Panel width percentages [graph, details], defaults to [60, 40]
   * @param selectedCommits - Set of selected commit hashes
   * @param loadedCount - Number of commits currently loaded
   * @param totalAvailable - Total commits available
   * @returns Complete HTML document string
   */
  public _getThreePanelHtmlContent(
    webview: vscode.Webview,
    commitNodes: ICommitNode[],
    commitDetails?: ICommitDetails,
    panelWidths?: [number, number],
    selectedCommits?: Set<string>,
    loadedCount?: number,
    totalAvailable?: number
  ): string {
    const nonce = this._getNonce();
    const widths = panelWidths || this._panelWidths;

    // Generate panel content using existing methods
    // Branch panel removed — branches are now displayed in the native BRANCHES tree view
    const graphPanelHtml = this._getGraphPanelHtml(
      commitNodes,
      selectedCommits,
      loadedCount,
      totalAvailable,
      this._scrollToCommitHash
    );
    const detailsPanelHtml = commitDetails
      ? this._getDetailsPanelHtml(commitDetails)
      : this._getDetailsPanelPlaceholderHtml();

    // Clear the scroll target after rendering so it's only used once
    this._scrollToCommitHash = undefined;

    // Commit context menu (branch context menu removed — handled by native tree view)
    const commitContextMenuHtml = this._getCommitContextMenuHtml();

    // Use 2-panel widths directly
    const graphWidth = widths[0];
    const detailsWidth = widths[1];

    // Log-tab body (pre-refactor markup — unchanged).
    const logBody = `
  <div class="three-panel-layout" role="application" aria-label="Git Tool Window">
    <div id="graph-panel" class="panel" style="width: ${graphWidth}%;" role="region" aria-label="Graph Panel">
      ${graphPanelHtml}
    </div>
    <div class="panel-divider" data-divider="0" role="separator" aria-label="Resize Graph and Details panels" tabindex="0"></div>
    <div id="details-panel" class="panel" style="width: ${detailsWidth}%;" role="region" aria-label="Details Panel">
      ${detailsPanelHtml}
    </div>
    ${commitContextMenuHtml}
    <div id="ref-popup" class="context-menu" hidden role="menu" aria-label="Branches at this commit"></div>
  </div>`;

    // When the tabbed-layout flag is ON, wrap the Log body with the tab
    // strip + stubbed panel shells. When the flag is OFF, emit exactly
    // the pre-refactor HTML so users see zero UI change.
    const flagOn = isTabbedGitToolWindowEnabled();
    const historyState = this._historyTab?.getState();
    const historyActive = flagOn && this._tabRouter.getActiveTab() === 'history';
    const bodyMarkup = flagOn
      ? wrapTabbedBody({
          activeTab: this._tabRouter.getActiveTab(),
          logBodyHtml: logBody,
          consoleBodyHtml: renderConsoleTabBody(),
          incomingBodyHtml: renderIncomingTabBody(),
          updateInfoBodyHtml: renderUpdateInfoTabBody(),
          historyBodyHtml:
            renderHistoryTabBody(historyState) +
            (historyActive
              ? `<script nonce="${nonce}">${historyTabBehaviorScript()}</script>`
              : ''),
          nonce,
        })
      : logBody;

    const extraStyles = flagOn ? `${tabStripStyles()}\n${historyTabStyles()}` : '';

    // / HIG — codicon font loader. Without a `@font-face`
    // declaration that points to the actual TTF, the `<i class="codicon">`
    // glyphs we emit on every chip render as empty-box "tofu" — the WCAG
    // 1.4.1 non-color affordance (snap-12f/12g) silently fails. The
    // shared helper computes the asWebviewUri() form of the bundled
    // `media/codicon.ttf` and emits the @font-face + .codicon utility
    // rules. CSP is widened to allow font-src from the webview's
    // cspSource so the same-origin font URI resolves.
    const codiconFontCss = this._getCodiconFontFaceCss(webview);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
  <title>Git Tool Window</title>
  <style>
    ${codiconFontCss}
    ${this._getThreePanelStyles()}
    ${extraStyles}
  </style>
</head>
<body>
${bodyMarkup}

  <script nonce="${nonce}">
    ${this._getInlineScript()}
    ${this._getDividerDragScript()}
    ${this._getColumnResizeScript()}
  </script>
</body>
</html>`;
  }

  // IGtwControllerContext — pure pass-throughs that expose the slice the
  // extracted builder modules need without handing them the concrete class.
  getNonce(): string {
    return this._getNonce();
  }

  getInlineStyles(): string {
    return this._getInlineStyles();
  }

  /**
   * Get the loading HTML shown while initial data is being fetched.
   */
  private _getLoadingHtml(webview: vscode.Webview): string {
    return buildLoadingHtml(this, webview);
  }

  /**
   * Generate the HTML for the no-repository state.
   * Displays a prompt to initialize a repository.
   *
   * display a single message prompting the user to initialize a repository.
   */
  private _getNoRepositoryHtml(webview: vscode.Webview): string {
    return buildNoRepositoryHtml(this, webview);
  }

  /**
   * Codicon @font-face + glyph CSS for the webview. Thin forwarder to
   * {@link buildCodiconFontFaceCss} (in provider/stylesBuilder.ts), passing the
   * provider-owned extension URI so the font URI resolution stays out of the
   * builder while the byte-for-byte CSS lives next to the other styles.
   */
  private _getCodiconFontFaceCss(webview: vscode.Webview): string {
    return buildCodiconFontFaceCss(this._extensionUri, webview);
  }

  /**
   * Two-panel layout CSS for the webview. Thin forwarder to
   * {@link buildThreePanelStyles} (in provider/stylesBuilder.ts).
   */
  private _getThreePanelStyles(): string {
    return buildThreePanelStyles();
  }

  /**
   * Get the inline JavaScript for draggable panel dividers.
   *
   * Handles:
   * - Mouse down/move/up events on dividers for drag resizing
   * - Posting panelResize messages to the extension host
   * - JS-based width check for vertical stacking at < 500px
   * - Keyboard arrow key support for divider repositioning
   *
   * @returns JavaScript string for divider drag functionality
   */
  private _getDividerDragScript(): string {
    return `
      (function() {
        const layout = document.querySelector('.three-panel-layout');
        if (!layout) return;

        const panels = layout.querySelectorAll('.panel');
        const dividers = layout.querySelectorAll('.panel-divider');
        let activeDivider = null;
        let startX = 0;
        let startWidths = [];
        const MIN_PANEL_PX = 100;

        // JS-based vertical stacking check
        function checkVerticalLayout() {
          if (!layout) return;
          const width = layout.getBoundingClientRect().width;
          if (width < 500) {
            layout.classList.add('vertical-layout');
          } else {
            layout.classList.remove('vertical-layout');
          }
        }

        // Check on load and on resize
        checkVerticalLayout();
        window.addEventListener('resize', checkVerticalLayout);

        // Observe layout size changes
        if (typeof ResizeObserver !== 'undefined') {
          const resizeObserver = new ResizeObserver(function() {
            checkVerticalLayout();
          });
          resizeObserver.observe(layout);
        }

        dividers.forEach(function(divider) {
          divider.addEventListener('mousedown', function(e) {
            e.preventDefault();
            activeDivider = divider;
            startX = e.clientX;

            // Capture current widths of all panels in pixels
            startWidths = Array.from(panels).map(function(p) {
              return p.getBoundingClientRect().width;
            });

            document.body.classList.add('resizing');
            divider.classList.add('dragging');
          });

          // Keyboard support for divider
          divider.addEventListener('keydown', function(e) {
            const dividerIndex = parseInt(divider.getAttribute('data-divider'), 10);
            const leftPanel = panels[dividerIndex];
            const rightPanel = panels[dividerIndex + 1];
            if (!leftPanel || !rightPanel) return;

            const step = 10; // pixels per key press
            let delta = 0;

            switch (e.key) {
              case 'ArrowLeft':
                delta = -step;
                e.preventDefault();
                break;
              case 'ArrowRight':
                delta = step;
                e.preventDefault();
                break;
              default:
                return;
            }

            const leftWidth = leftPanel.getBoundingClientRect().width + delta;
            const rightWidth = rightPanel.getBoundingClientRect().width - delta;

            if (leftWidth >= MIN_PANEL_PX && rightWidth >= MIN_PANEL_PX) {
              const totalWidth = layout.getBoundingClientRect().width;
              const leftPct = (leftWidth / totalWidth) * 100;
              const rightPct = (rightWidth / totalWidth) * 100;

              leftPanel.style.width = leftPct + '%';
              rightPanel.style.width = rightPct + '%';

              // Post resize message
              const widths = Array.from(panels).map(function(p) {
                return parseFloat(p.style.width) || 0;
              });
              vscode.postMessage({ type: 'panelResize', widths: widths });
            }
          });
        });

        document.addEventListener('mousemove', function(e) {
          if (!activeDivider) return;

          const dividerIndex = parseInt(activeDivider.getAttribute('data-divider'), 10);
          const delta = e.clientX - startX;

          const leftWidth = startWidths[dividerIndex] + delta;
          const rightWidth = startWidths[dividerIndex + 1] - delta;

          // Enforce minimum widths
          if (leftWidth >= MIN_PANEL_PX && rightWidth >= MIN_PANEL_PX) {
            const totalWidth = layout.getBoundingClientRect().width;
            const leftPct = (leftWidth / totalWidth) * 100;
            const rightPct = (rightWidth / totalWidth) * 100;

            panels[dividerIndex].style.width = leftPct + '%';
            panels[dividerIndex + 1].style.width = rightPct + '%';
          }
        });

        document.addEventListener('mouseup', function() {
          if (!activeDivider) return;

          document.body.classList.remove('resizing');
          activeDivider.classList.remove('dragging');
          activeDivider = null;

          // Post the final panel widths as percentages
          const widths = Array.from(panels).map(function(p) {
            return parseFloat(p.style.width) || 0;
          });
          vscode.postMessage({ type: 'panelResize', widths: widths });
        });
      })();
    `;
  }

  /**
   * Inline JavaScript for drag-to-resize on the log column headers.
   *
   * Handles:
   * - Mouse down/move/up on the `data-column-resize` handles to resize the
   *   fixed Author and Date columns live by writing the panel's
   *   `--col-author-width` / `--col-date-width` custom properties.
   * - Min/max pixel clamps so a column can never be dragged to zero (or so
   *   wide it crowds out the flexible Subject column). The clamp mirrors the
   *   host-side `clampColumnWidths` bounds.
   * - Keyboard arrow support on a focused handle (10px steps).
   * - Posting a `columnResize` message so the new widths persist across
   *   re-renders.
   *
   * Re-binds on every render via event delegation on `document`, so the
   * handlers survive the webview's full-HTML refresh without per-element
   * listener bookkeeping.
   *
   * @returns JavaScript string for column-resize functionality.
   */
  private _getColumnResizeScript(): string {
    return `
      (function() {
        const MIN_COL = 40;
        const MAX_COL = 600;
        // CSS custom property each handle drives, keyed by data-column-resize.
        const VAR_BY_COLUMN = { author: '--col-author-width', date: '--col-date-width' };

        function panelFor(el) {
          return el.closest('.graph-panel');
        }
        function currentWidth(panel, column) {
          const raw = getComputedStyle(panel).getPropertyValue(VAR_BY_COLUMN[column]);
          const n = parseFloat(raw);
          return isFinite(n) ? n : (column === 'author' ? 120 : 145);
        }
        function clamp(px) {
          return Math.round(Math.min(MAX_COL, Math.max(MIN_COL, px)));
        }
        function applyAndPost(panel, column, px) {
          const clamped = clamp(px);
          panel.style.setProperty(VAR_BY_COLUMN[column], clamped + 'px');
          vscode.postMessage({
            type: 'columnResize',
            widths: [currentWidth(panel, 'author'), currentWidth(panel, 'date')],
          });
          return clamped;
        }

        let active = null;     // the handle element being dragged
        let activePanel = null;
        let activeColumn = null;
        let startX = 0;
        let startWidth = 0;

        document.addEventListener('mousedown', function(e) {
          const handle = e.target.closest && e.target.closest('.log-column-resize-handle');
          if (!handle) return;
          const panel = panelFor(handle);
          if (!panel) return;
          e.preventDefault();
          active = handle;
          activePanel = panel;
          activeColumn = handle.getAttribute('data-column-resize');
          startX = e.clientX;
          startWidth = currentWidth(panel, activeColumn);
          document.body.classList.add('resizing-column');
          handle.classList.add('dragging');
        });

        // Each handle sits on the LEFT edge of the column it resizes (the
        // fixed columns are right-anchored), so moving the pointer LEFT widens
        // the column and moving RIGHT shrinks it — the delta is subtracted.
        document.addEventListener('mousemove', function(e) {
          if (!active) return;
          const delta = e.clientX - startX;
          applyAndPost(activePanel, activeColumn, startWidth - delta);
        });

        document.addEventListener('mouseup', function() {
          if (!active) return;
          document.body.classList.remove('resizing-column');
          active.classList.remove('dragging');
          active = null;
          activePanel = null;
          activeColumn = null;
        });

        // Keyboard support: arrow keys nudge a focused handle by 10px.
        document.addEventListener('keydown', function(e) {
          const handle = e.target.closest && e.target.closest('.log-column-resize-handle');
          if (!handle) return;
          let step = 0;
          if (e.key === 'ArrowLeft') step = -10;
          else if (e.key === 'ArrowRight') step = 10;
          else return;
          e.preventDefault();
          const panel = panelFor(handle);
          if (!panel) return;
          const column = handle.getAttribute('data-column-resize');
          applyAndPost(panel, column, currentWidth(panel, column) + step);
        });
      })();
    `;
  }

  /**
   * Return a `var(--vscode-gitDecoration-*, #hex)` expression
   * for the given file status, so the colour follows the user's theme
   * (especially high-contrast) instead of the bare IntelliJ hex. The
   * Hex literal is retained as the CSS-var fallback (defence
   * in depth + dev-mode jsdom test surface). Pinned by
   * `fileStatusTheme-1..8` in detailsPanel.test.ts.
   *
   * Public + `this`-free: the builders that used to call it have moved to
   * htmlBuilders.ts, so its only remaining reach is the reflective test that
   * invokes `prototype._getFileStatusColor.call({}, status)`. Public so the
   * reflection-only surface satisfies noUnusedLocals (same convention as the
   * other test-reflected underscore methods); `this`-free so the `.call({})`
   * binding still works. Delegates to the free getFileStatusColor.
   */
  public _getFileStatusColor(status: FileStatus): string {
    return getFileStatusColor(status);
  }

  /**
   * Generate the Graph Panel HTML for the 2-panel layout.
   *
   * Renders commit rows in reverse chronological order (as provided by the
   * commitNodes array). Each row contains:
   * - SVG graph visualization (via renderGraphSvg with computeActiveLanes)
   * - Commit short hash
   * - Commit message summary (first line, truncated to ~60 chars)
   * - Author name
   * - Relative date
   *
   * The method uses the existing graphRenderer utilities to produce color-coded
   * lane SVGs and the commitGraph utilities for lane computation.
   *
   * @param commitNodes - Array of ICommitNode in reverse chronological order
   * @param selectedCommits - Set of currently selected commit hashes (optional)
   * @param loadedCount - Number of commits currently loaded (optional, for incremental loading)
   * @param totalAvailable - Total number of commits available in the repository (optional)
   * @param scrollToCommitHash - Optional commit hash to auto-scroll to on page load
   * @returns HTML string for the graph panel content
   */
  public _getGraphPanelHtml(
    commitNodes: ICommitNode[],
    selectedCommits?: Set<string>,
    loadedCount?: number,
    totalAvailable?: number,
    scrollToCommitHash?: string
  ): string {
    const selected = selectedCommits || new Set<string>();

    if (commitNodes.length === 0) {
      return this._getEmptyGraphPanelHtml();
    }

    // Compute active lanes for the entire commit list
    const activeLaneMap = computeActiveLanes(commitNodes);

    // Compute terminal nodes and child count map for icon rendering
    const terminalNodes = computeTerminalNodes(commitNodes);
    const childCountMap = computeChildCountMap(commitNodes);
    const childLanesMap = computeChildLanesMap(commitNodes);
    // Far-parent fork-point bends. For each parent
    // row that receives a far-parent first-parent line from above, the
    // renderer draws the bend AT the parent row (not at the source row);
    // this map surfaces the source lanes per parent hash.
    const incomingBendsMap = computeIncomingBendsMap(commitNodes);

    // True when ANY commit in the rendered set is on the
    // focused-branch path. The renderer reads this to decide whether to
    // brighten on-path / dim off-path lines and nodes. When false, the
    // graph renders at baseline (no change from).
    const hasFocusedBranch = commitNodes.some((n) => n.onFocusedBranchPath === true);

    // Pre-resolve the cherry-picked set once per render to keep the
    // per-row check O(1).
    const cherryPickedHashes = this._extendedLogState.cherryPickedHashes;
    const cherryPickBaseRef = this._extendedLogState.cherryPickBaseRef;

    // Size the graph column to the WIDEST row across the whole window. The
    // `.commit-graph` cell is `width: var(--graph-width)` with
    // `overflow: hidden`; that var was never set, so it fell back to the
    // 80px default — which fits only ~3 lanes. Any repo with more parallel
    // branches than that had its outer lanes (and the branches living on
    // them) CLIPPED out of view, even with plenty of horizontal room in the
    // panel — the reported "older branches pushed out of the tree" bug. We
    // compute the pixel width from the max lane index across all nodes and
    // publish it as `--graph-width` on the panel so every row's graph cell
    // is wide enough to show every lane.
    const graphColumnWidthPx = Math.max(80, computeGraphWidth(commitNodes, DEFAULT_GRAPH_CONFIG));

    // Build commit rows
    const rowsHtml = buildCommitRows(commitNodes, {
      selected,
      cherryPickedHashes,
      cherryPickBaseRef,
      activeLaneMap,
      terminalNodes,
      childCountMap,
      childLanesMap,
      incomingBendsMap,
      hasFocusedBranch,
      branchLabelsFor: (node) => this._getBranchLabelsHtml(node),
    });

    // Determine if more commits are available for incremental loading
    const loaded = loadedCount ?? commitNodes.length;
    const total = totalAvailable ?? commitNodes.length;
    const hasMore = loaded < total;

    const loadingIndicatorHtml = hasMore
      ? `<div class="graph-loading-indicator" data-loaded="${loaded}" data-total="${total}">
          <span class="loading-spinner">⟳</span>
          <span class="loading-text">Loading more commits... (${loaded} of ${total})</span>
        </div>`
      : '';

    const scrollAttr = scrollToCommitHash ? ` data-scroll-to-commit="${scrollToCommitHash}"` : '';

    const repositorySelectorHtml = this._getRepositorySelectorHtml();

    // Embed the anchor hash so a full
    // re-render rehydrates the JS `let anchorHash` mirror correctly.
    // The webview JS reads this attribute on script-execution and
    // again whenever the host posts a `syncSelection` message.
    const anchorAttr = this._extendedLogState.anchorHash ?? '';

    // visually-hidden help span referenced by
    // `aria-describedby="focused-branch-help"` on every focused branch
    // chip. Rendered ONCE per panel so all focused chips (only one is
    // ever focused at a time today; loop-safe nonetheless) share the
    // same description without duplicating it in the DOM. The
    // `.visually-hidden` utility keeps the text in the AT layer (read
    // by screen readers, find-in-page, accessibility-tree inspectors)
    // while removing it from sighted layout.
    const focusedBranchHelpHtml = `<span id="focused-branch-help" class="visually-hidden">Currently focused branch — graph is filtered to this branch's history</span>`;

    // Publish the resizable fixed-column widths as CSS custom properties on
    // the panel so the header and every row read the same value — a single
    // source of truth keeps them aligned, and embedding the current widths in
    // the markup means a full re-render rehydrates a user's dragged widths.
    const [authorWidthPx, dateWidthPx] = this._columnWidths;
    const columnHeaderHtml = this._getLogColumnHeaderHtml();
    const logFilterBarHtml = this._getLogFilterBarHtml();

    return `
      <div class="graph-panel" role="listbox" aria-label="Commit Graph" aria-multiselectable="true" style="--graph-width: ${graphColumnWidthPx}px; --col-author-width: ${authorWidthPx}px; --col-date-width: ${dateWidthPx}px;" data-selected-count="${selected.size}" data-anchor-hash="${this._escapeHtml(anchorAttr)}" data-loaded-count="${loaded}" data-total-available="${total}"${scrollAttr}>
        ${focusedBranchHelpHtml}
        ${repositorySelectorHtml}
        ${logFilterBarHtml}
        ${columnHeaderHtml}
        ${rowsHtml}
        ${loadingIndicatorHtml}
      </div>`;
  }

  /**
   * Build the empty-state body for the graph panel.
   *
   * The graph panel reaches this branch whenever `commitNodes` is empty
   * AND the host has already cleared the loading state and confirmed a
   * repository (the loading / no-repository cases are handled upstream
   * in `_getHtmlContent` by `_getLoadingHtml` / `_getNoRepositoryHtml`,
   * so they never reach here). That leaves exactly two reasons the row
   * list can be empty:
   *
   *   - `filteredEmpty` — a log filter is active and matched zero
   *     commits. We surface a "Clear filter" affordance so the user can
   *     recover in one click.
   *   - `noCommits` — a real repository with no commits in the loaded
   *     window (a freshly-initialised repo before the first commit).
   *
   * Distinguishing the two avoids the old "No commits found" message,
   * which read as "your filter is broken" to users staring at a fresh
   * repo and "your repo is empty" to users who'd just typed a filter
   * that matched nothing.
   *
   * The repository selector is preserved at the top so a multi-repo
   * user can switch repos without the dropdown vanishing on an empty
   * result.
   */
  private _getEmptyGraphPanelHtml(): string {
    const repositorySelectorHtml = this._getRepositorySelectorHtml();
    const hasActiveFilter = this._extendedLogState.filter !== undefined;

    const body = hasActiveFilter
      ? `<div class="graph-empty-state">
           <p class="empty-message">No commits match the current filter</p>
           <button type="button" class="graph-empty-action" data-action="clearLogFilter">Clear filter</button>
         </div>`
      : `<div class="graph-empty-state">
           <p class="empty-message">No commits yet — make your first commit</p>
         </div>`;

    return `
      <div class="graph-panel" role="listbox" aria-label="Commit Graph" aria-multiselectable="true" data-selected-count="0" data-anchor-hash="">
        ${repositorySelectorHtml}
        ${body}
      </div>`;
  }

  /**
   * Build the log column-header row.
   *
   * The header sits above the commit rows and labels the three columns —
   * the flexible Subject column plus the two fixed-width Author and Date
   * columns. Between the columns sit drag handles (`data-column-resize`):
   * dragging the Subject↕Author handle resizes the Author column, and the
   * Author↕Date handle resizes the Date column. The fixed columns size
   * themselves from the `--col-author-width` / `--col-date-width` custom
   * properties published on the panel, so the header and every row stay
   * pixel-aligned. The graph cell's left spacer matches `--graph-width` so
   * the Subject label lines up with the commit messages below it.
   *
   * @returns HTML string for the column-header row.
   */
  private _getLogColumnHeaderHtml(): string {
    return `
        <div class="log-column-header" role="row" aria-hidden="true">
          <div class="log-column-header-graph"></div>
          <div class="log-column-header-info">
            <div class="log-column-header-title">Subject</div>
            <div class="log-column-resize-handle" data-column-resize="author" role="separator" aria-label="Resize author column" tabindex="0"></div>
            <div class="log-column-header-author">Author</div>
            <div class="log-column-resize-handle" data-column-resize="date" role="separator" aria-label="Resize date column" tabindex="0"></div>
            <div class="log-column-header-date">Date</div>
          </div>
        </div>`;
  }

  /**
   * Build the log filter bar — IntelliJ's Git-log filter set
   * (text/author/path/date), wired to the host's already-live
   * `applyLogFilter` pipeline.
   *
   * The webview CSP is `script-src 'nonce-<nonce>'` with no
   * `unsafe-inline`, so the bar uses `data-action` attributes (routed by
   * the delegated click/keydown listeners in the inline script), never
   * inline `onclick=`/`onkeyup=`. The toggle button lives at the top so a
   * user can open the bar without it stealing vertical space when closed.
   *
   * The bar starts `hidden`; `toggleLogFilters` flips it. The inputs are
   * rehydrated from `_extendedLogState.filter` so a full re-render (which
   * the host does on every refresh) preserves what the user typed. All
   * values are HTML-escaped — they land in `value="…"` attributes and are
   * user-controlled, so an unescaped quote would break out of the
   * attribute.
   *
   * @returns HTML string for the toggle button + `#log-filter-bar`.
   * @internal Public for direct snapshot/DOM tests; the `_` prefix flags
   *   "not for production callers outside this class", matching the
   *   existing `_get*Html` testability pattern.
   */
  public _getLogFilterBarHtml(): string {
    const filter = this._extendedLogState.filter;
    const search = this._escapeHtml(filter?.searchText ?? '');
    const author = this._escapeHtml(filter?.author ?? '');
    const path = this._escapeHtml(filter?.path ?? '');
    const since = this._toDateInputValue(filter?.since);
    const until = this._toDateInputValue(filter?.until);
    const noMerges = filter?.noMerges === true;
    const firstParent = filter?.firstParent === true;
    const simplifyMerges = filter?.simplifyMerges === true;
    // A range filter ("A..B") lives in logRange; rehydrate it into the branch
    // input since that's the field the user typed it into.
    const branchOrRange = this._escapeHtml(filter?.logRange ?? filter?.branch ?? '');
    const minParents = filter?.minParents ?? '';
    const maxParents = filter?.maxParents ?? '';
    const searchRegex = filter?.searchRegex ?? false;
    const searchCaseSensitive = filter?.searchCaseSensitive ?? false;
    const cherryCompare = this._escapeHtml(this._extendedLogState.manualCherryCompareRef ?? '');
    const active = filter !== undefined;

    return `
        <div class="log-filter-toolbar">
          <button type="button" class="log-filter-toggle${active ? ' active' : ''}" data-action="toggleLogFilters" aria-label="Toggle log filters" aria-expanded="${active}" title="Filter commits">Filter</button>
        </div>
        <div id="log-filter-bar" class="log-filter-bar"${active ? '' : ' hidden'} role="group" aria-label="Log filters">
          <div class="log-filter-row">
            <div class="log-filter-group">
              <label class="log-filter-label" for="filter-branch">Branch</label>
              <input type="text" id="filter-branch" class="log-filter-input" list="filter-branch-options" data-action="filterKeydown" placeholder="Branch, tag, or range (A..B)" value="${branchOrRange}" autocomplete="off" />
              <datalist id="filter-branch-options"></datalist>
            </div>
            <div class="log-filter-group">
              <label class="log-filter-label" for="filter-search">Message / Hash</label>
              <input type="text" id="filter-search" class="log-filter-input" data-action="filterKeydown" placeholder="Subject or commit hash" value="${search}" />
              <div class="log-filter-toggle-group">
                <button type="button" id="filter-search-regex" class="log-filter-toggle-btn${searchRegex ? ' active' : ''}" data-action="toggleSearchRegex" title="Use regular expression" aria-pressed="${searchRegex}">.*</button>
                <button type="button" id="filter-search-case" class="log-filter-toggle-btn${searchCaseSensitive ? ' active' : ''}" data-action="toggleSearchCase" title="Match case" aria-pressed="${searchCaseSensitive}">Aa</button>
              </div>
            </div>
            <div class="log-filter-group">
              <label class="log-filter-label" for="filter-author">Author</label>
              <input type="text" id="filter-author" class="log-filter-input" list="filter-author-options" data-action="filterKeydown" placeholder="Author name or email" value="${author}" autocomplete="off" />
              <datalist id="filter-author-options"></datalist>
            </div>
            <div class="log-filter-group">
              <label class="log-filter-label" for="filter-path">Path</label>
              <input type="text" id="filter-path" class="log-filter-input" data-action="filterKeydown" placeholder="File or directory path" value="${path}" />
            </div>
            <div class="log-filter-group">
              <label class="log-filter-label" for="filter-cherry-compare">Cherry-compare with</label>
              <input type="text" id="filter-cherry-compare" class="log-filter-input" list="filter-branch-options" data-action="filterKeydown" placeholder="Branch or ref (highlights cherry-picked)" value="${cherryCompare}" autocomplete="off" />
            </div>
          </div>
          <div class="log-filter-row">
            <div class="log-filter-group log-filter-group-date">
              <label class="log-filter-label" for="filter-since">Since</label>
              <input type="date" id="filter-since" class="log-filter-input log-filter-date" data-action="filterKeydown" value="${since}" />
            </div>
            <div class="log-filter-group log-filter-group-date">
              <label class="log-filter-label" for="filter-until">Until</label>
              <input type="date" id="filter-until" class="log-filter-input log-filter-date" data-action="filterKeydown" value="${until}" />
            </div>
            <div class="log-filter-group log-filter-group-check">
              <label class="log-filter-check-label" for="filter-no-merges">
                <input type="checkbox" id="filter-no-merges" class="log-filter-check"${noMerges ? ' checked' : ''} /> No Merges
              </label>
            </div>
            <div class="log-filter-group log-filter-group-check">
              <label class="log-filter-check-label" for="filter-first-parent">
                <input type="checkbox" id="filter-first-parent" class="log-filter-check"${firstParent ? ' checked' : ''} /> First Parent
              </label>
            </div>
            <div class="log-filter-group log-filter-group-check">
              <label class="log-filter-check-label" for="filter-simplify-merges">
                <input type="checkbox" id="filter-simplify-merges" class="log-filter-check"${simplifyMerges ? ' checked' : ''} /> Simplify Merges
              </label>
            </div>
            <div class="log-filter-group log-filter-group-parents">
              <label class="log-filter-label">Parents</label>
              <input type="number" id="filter-min-parents" class="log-filter-input log-filter-parents-input" data-action="filterKeydown" placeholder="Min" min="0" value="${minParents}" />
              <span class="log-filter-parents-sep">–</span>
              <input type="number" id="filter-max-parents" class="log-filter-input log-filter-parents-input" data-action="filterKeydown" placeholder="Max" min="0" value="${maxParents}" />
            </div>
          </div>
          <div class="log-filter-actions">
            <button type="button" class="log-filter-button log-filter-clear" data-action="clearLogFilter">Clear</button>
            <button type="button" class="log-filter-button log-filter-apply" data-action="applyLogFilter">Apply</button>
          </div>
        </div>`;
  }

  /**
   * Format a filter date for an `<input type="date">` value (YYYY-MM-DD).
   * Uses UTC parts so the rendered day matches the stored instant rather
   * than shifting under the host's local timezone. Returns '' for an
   * absent or invalid date.
   */
  private _toDateInputValue(date: Date | undefined): string {
    if (!date || Number.isNaN(date.getTime())) {
      return '';
    }
    const yyyy = date.getUTCFullYear().toString().padStart(4, '0');
    const mm = (date.getUTCMonth() + 1).toString().padStart(2, '0');
    const dd = date.getUTCDate().toString().padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  /**
   * Get the branch labels HTML for a commit node.
   * Renders `<span>` elements for each branch name on the commit node.
   * Applies `branch-label-local` or `branch-label-remote` CSS class based on
   * the branch ref's `type` (sourced from `IBranch.type`, NOT guessed from
   * the name — see Bug E).
   * Branch names are escaped for HTML safety.
   *
   * @param node - The commit node to render branch labels for
   * @returns HTML string with branch label spans, or empty string if no branches
   *
   * @internal Public for direct snapshot tests (snap-7a..7e in
   *   `commitGraphSnapshots.test.ts`). The `_` prefix flags "do not
   *   call from production code outside this class"; the `public`
   *   visibility is intentional contract for white-box testability,
   *   matching the existing pattern (`_getGraphPanelHtml`,
   *   `_getMultiCommitDetailsPanelHtml`, etc.).
   */
  public _getBranchLabelsHtml(node: ICommitNode): string {
    const hasBranches = !!node.branches && node.branches.length > 0;
    // Tag chips render alongside the branch chip family. The
    // empty-string return contract (snap-7d) extends to the no-tag case
    // here so `.commit-branches:empty` still collapses.
    const hasTags = !!node.tags && node.tags.length > 0;

    if (!hasBranches && !hasTags) {
      // CSS `.commit-branches:empty { display: none }` depends
      // on this returning the LITERAL empty string (not whitespace, not
      // an HTML comment) so the empty wrapper collapses with no margin
      // / no flex basis. Pinned by snap-7d in commitGraphSnapshots.test.ts.
      //
      // Following IntelliJ, there is no separate "HEAD" badge: the
      // current branch is conveyed by colouring its own chip yellow (see
      // below). A detached HEAD with no branch tip therefore produces no
      // chip at all — matching IntelliJ, where a detached HEAD shows only
      // the bare commit row.
      return '';
    }

    const focusedBranchName = this._extendedLogState.focusedBranchName;
    const headBranchName = this._extendedLogState.headBranchName;
    const allBranches = node.branches || [];
    // Chip collapse rule (IntelliJ parity).
    //
    // Inline up to MAX_INLINE chips. Privileged refs — the current
    // (HEAD) branch and the focused branch — are pulled to the FRONT of
    // the inline set so they are never the ones hidden when a commit
    // carries more refs than fit. The remainder collapses into a single
    // clickable `+N` summary chip.
    //
    // This deliberately NEVER hides a lone branch behind a bare `+1`: a
    // single non-current tip always shows its name, because one chip is
    // always ≤ MAX_INLINE.
    const MAX_INLINE_BRANCH_CHIPS = 3;
    const isPrivileged = (name: string): boolean =>
      name === headBranchName || name === focusedBranchName;
    // Stable partition: privileged refs first (in their original
    // relative order), then the rest. A stable ordering keeps the
    // snapshot output deterministic.
    const orderedBranches = [
      ...allBranches.filter((b) => isPrivileged(b.name)),
      ...allBranches.filter((b) => !isPrivileged(b.name)),
    ];
    const inlineBranches: IBranchRef[] = orderedBranches.slice(0, MAX_INLINE_BRANCH_CHIPS);
    const collapsedBranches: IBranchRef[] = orderedBranches.slice(MAX_INLINE_BRANCH_CHIPS);

    const labels = inlineBranches.map((branchRef) => {
      const branchName = branchRef.name;
      // Classify directly from the branch ref's `type` (sourced from
      // IBranch.type / refs-prefix), NOT from a `name.includes('/')` heuristic.
      // A local branch named `feature/foo` is local, not remote.
      const isRemote = branchRef.type === 'remote';
      // The current branch (the one HEAD points at) is coloured YELLOW
      // via `.branch-label-head`, matching IntelliJ's HEAD convention —
      // there is no separate "HEAD" badge. Non-current local branches are
      // green; remote branches are violet.
      const isCurrent = !!headBranchName && branchName === headBranchName;
      const baseClass = isCurrent
        ? 'branch-label-head'
        : isRemote
          ? 'branch-label-remote'
          : 'branch-label-local';
      // `branch-label-focused` is render-time source of
      // truth for the focus outline; the partial-update message handler
      // is just the optimization for selection-changes-without-rerender.
      const isFocused = focusedBranchName === branchName;
      const cssClass = isFocused ? `${baseClass} branch-label-focused` : baseClass;
      const escapedName = this._escapeHtml(branchName);
      // role="img" + descriptive aria-label tells SRs
      // this is a branch chip, not just inline text. Per UX request,
      // both local and remote branches use the same codicon-git-branch
      // icon — the ref kind is still distinguishable via the chip's
      // CSS class (`branch-label-local` / `branch-label-remote`) and
      // the aria-label text ("Local branch:" / "Remote branch:"). The
      // icon's aria-hidden="true" lets the chip's own aria-label own
      // the AT narration. The aria-label string is run through
      // _escapeHtml since branch names are user-controlled.
      // aria-pressed is deferred to when chips become
      // keyboard-interactive — adding it now would lie about an
      // interaction that doesn't yet exist. Pinned by snap-12b..d, 12f.
      //
      // The current (HEAD) branch chip announces "Current branch: …".
      // With the standalone ✓HEAD badge removed, the yellow colour is the
      // visual current-branch cue; the aria-label is the non-colour
      // (WCAG 1.4.1) affordance that tells SR users which ref is HEAD.
      const iconClass = 'codicon-git-branch';
      const ariaLabelText = isCurrent
        ? `Current branch: ${branchName}`
        : isRemote
          ? `Remote branch: ${branchName}`
          : `Local branch: ${branchName}`;
      const ariaLabel = this._escapeHtml(ariaLabelText);
      // Focused chip carries `aria-describedby` to
      // a visually-hidden help span (rendered once at panel level)
      // explaining the focus state. Non-focused chips omit the
      // attribute so SRs don't announce the help text on every chip.
      const ariaDescribedByAttr = isFocused ? ' aria-describedby="focused-branch-help"' : '';
      // data-branch-name carries the unescaped name so the inline
      // script's partial-update handler can match by attribute. The
      // attribute value goes through the same _escapeHtml the chip text
      // uses so reflective injection is impossible.
      return `<span class="${cssClass}" data-branch-name="${escapedName}" role="img" aria-label="${ariaLabel}"${ariaDescribedByAttr}><i class="codicon ${iconClass}" aria-hidden="true"></i>${escapedName}</span>`;
    });

    // Tag chips render LAST (rightmost) so branch
    // chips remain in their existing order. Following IntelliJ's "Tag
    // Names off" default, a tag renders as the codicon-tag ICON at rest;
    // the NAME is revealed only on hover/focus (the .tag-label-name span,
    // collapsed by CSS until :hover/:focus). The name stays in the DOM
    // (find-in-page + textContent) and is always available to screen
    // readers via the chip's aria-label="Tag: …" (the discoverability
    // backstop), plus a native title= tooltip. The chip is keyboard-
    // focusable (tabindex="0") so focus reveals the name too — the
    // reveal is never mouse-only (WCAG). data-tag-name carries the
    // unescaped name for any future partial-update path. The tag name is
    // run through `_escapeHtml` for textContent, aria-label, and title.
    const tagLabels = (node.tags || []).map((tagName) => {
      const escapedName = this._escapeHtml(tagName);
      const ariaLabel = this._escapeHtml(`Tag: ${tagName}`);
      return `<span class="tag-label" data-tag-name="${escapedName}" role="img" aria-label="${ariaLabel}" title="${escapedName}" tabindex="0"><i class="codicon codicon-tag" aria-hidden="true"></i><span class="tag-label-name">${escapedName}</span></span>`;
    });

    // Collapse summary chip: `+N` shown after the inline branch chips
    // (and before the tag chips) when more branches exist than fit
    // inline. The chip is a BUTTON — clicking (or Enter/Space) opens a
    // popup listing every collapsed ref; each popup row navigates to that
    // branch. role="button" + tabindex="0" make it keyboard-activatable
    // with a visible focus ring (WCAG 1.4.1 — interaction is not
    // colour-only). aria-haspopup advertises the menu; aria-expanded
    // starts "false" and the popup handler toggles it as the menu
    // opens/closes (WCAG 4.1.2 state). The title= tooltip still lists the
    // names on hover, and data-collapsed-branches carries the names the
    // popup handler consumes.
    let collapsedSummaryHtml = '';
    if (collapsedBranches.length > 0) {
      const tooltipLines = collapsedBranches.map((b) => b.name).join('\n');
      const escapedTooltip = this._escapeHtml(tooltipLines);
      // data-collapsed-branches is a JSON array of the collapsed ref names,
      // consumed by the popup handler's `JSON.parse`. JSON lets a name
      // contain ANY character — including a literal '|' (git permits it) —
      // without the delimiter collision a pipe-join had. _escapeHtml then
      // makes the JSON safe inside the double-quoted attribute; the browser
      // decodes the entities back to valid JSON before the handler reads it.
      const dataAttr = this._escapeHtml(JSON.stringify(collapsedBranches.map((b) => b.name)));
      const ariaLabel = this._escapeHtml(
        `Show ${collapsedBranches.length} more branch${collapsedBranches.length === 1 ? '' : 'es'}: ${collapsedBranches.map((b) => b.name).join(', ')}`
      );
      collapsedSummaryHtml = `<span class="branch-label-collapsed" data-collapsed-branches="${dataAttr}" role="button" tabindex="0" aria-label="${ariaLabel}" aria-haspopup="true" aria-expanded="false" title="${escapedTooltip}">+${collapsedBranches.length}</span>`;
    }

    return labels.join('') + collapsedSummaryHtml + tagLabels.join('');
  }

  /**
   * Get the repository selector HTML for the graph panel header.
   * Renders a `<select>` dropdown when multiple repositories are available.
   * When 0 or 1 repositories exist, returns an empty string (selector is hidden).
   *
   * The dropdown displays the folder name (last path segment of rootUri.fsPath)
   * for each repository and sends a `selectRepository` message with the
   * selected `repositoryIndex` when the user changes the selection.
   *
   * @returns HTML string for the repository selector, or empty string if not needed
   */
  public _getRepositorySelectorHtml(): string {
    if (this._availableRepositories.length <= 1) {
      return '';
    }

    const optionsHtml = this._availableRepositories
      .map((repo, index) => {
        const fsPath = repo.rootUri.fsPath;
        const folderName = this._escapeHtml(fsPath.split('/').pop() || fsPath);
        const selected = index === this._selectedRepositoryIndex ? ' selected' : '';
        // `title` carries the full user-friendly path so two repos
        // with the same leaf folder name are distinguishable on hover
        // (spec section 4.2). Internal identity comparisons use the
        // normalized form (see setAvailableRepositories); the tooltip
        // shows the raw path the user recognizes.
        const titleAttr = ` title="${this._escapeHtml(fsPath)}"`;
        return `<option value="${index}"${selected}${titleAttr}>${folderName}</option>`;
      })
      .join('');

    // The `change` listener is wired from the main inline script
    // (`_getInlineScript`), which already holds the single `vscode` API
    // instance. A second `acquireVsCodeApi()` call inside an inline
    // `onchange` handler would throw — VS Code only allows one acquire
    // per webview lifetime — and silently drop the selection.
    return `
      <div class="repository-selector-container">
        <select class="repository-selector" aria-label="Select repository">
          ${optionsHtml}
        </select>
      </div>`;
  }

  /**
   * Get the commit context menu HTML overlay for the Graph Panel.
   * Renders a context menu with all 7 required options:
   * Copy Revision Number, Create Patch, Cherry-Pick, Checkout Revision,
   * Show Repository at Revision, Compare with Local, Reset Current Branch to Here,
   * Revert Commit, Undo Commit, Drop Commit, Edit Commit Message,
   * Merge into Current Branch, Interactively Rebase from Here.
   *
   * Items are organized into four sections separated by dividers:
   * Navigation & Inspection, Branch Operations, History Manipulation, Merge & Integration.
   *
   * The menu is hidden by default and shown on right-click via JS handlers.
   * The data-head-hash attribute stores the HEAD commit hash for disabled state logic.
   *
   * @returns HTML string for the commit context menu overlay
   */
  public _getCommitContextMenuHtml(): string {
    return buildCommitContextMenuHtml(this);
  }

  /**
   * Generate the Details Panel HTML for the 2-panel layout.
   *
   * Displays full commit metadata and a list of changed files with
   * IntelliJ-style color-coded status indicators.
   *
   * Commit metadata displayed:
   * - Commit message (and body if present)
   * - Full hash
   * - Author name and email
   * - Commit date-time
   * - Parent commit hashes
   *
   * Changed files list:
   * - Each file shows a color-coded status letter (M, A, D, R, etc.)
   * - File name and directory path are displayed separately
   * - Colors follow IntelliJ conventions via INTELLIJ_FILE_STATUS_COLORS
   *
   * @param commitDetails - The commit details data to render
   * @returns HTML string for the details panel content
   */
  public _getDetailsPanelHtml(commitDetails: ICommitDetails): string {
    return buildDetailsPanelHtml(this, commitDetails);
  }

  /**
   * Get placeholder HTML for the Details Panel when no commit is selected.
   *
   * a placeholder message indicating that a commit should be selected.
   *
   * @returns HTML string for the placeholder state
   */
  public _getDetailsPanelPlaceholderHtml(): string {
    return buildDetailsPanelPlaceholderHtml();
  }

  /**
   * Generate HTML for the Details Panel when multiple commits are selected.
   * Displays a header showing how many commits are selected, a list of selected
   * commit hashes/messages, and the combined changed files list with IntelliJ-style
   * color coding.
   *
   * The combined changed files are computed by merging the changed files from all
   * selected commits, deduplicating by path and keeping the most recent status.
   *
   * display the combined changes across all selected commits.
   *
   * @param commitDetailsList - Array of commit details for the selected commits
   * @param combinedChangedFiles - Optional pre-computed combined changed files
   *   (e.g., from GitService.getMultiCommitDiff()). If not provided, the method
   *   merges changed files from the individual commit details.
   * @returns HTML string for the multi-commit details panel
   */
  public _getMultiCommitDetailsPanelHtml(
    commitDetailsList: ICommitDetails[],
    combinedChangedFiles?: IChangedFile[]
  ): string {
    return buildMultiCommitDetailsPanelHtml(commitDetailsList, combinedChangedFiles);
  }

  /**
   * Format date as absolute date-time string.
   * Format: YYYY-MM-DD H:MM AM/PM
   */
  public _formatAbsoluteDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const rawHours = date.getHours();
    const ampm = rawHours >= 12 ? 'PM' : 'AM';
    const hours = rawHours % 12 || 12;
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes} ${ampm}`;
  }

  /**
   * Inline base styles for the webview.
   *
   * Thin forwarder to {@link buildInlineStyles} (in provider/stylesBuilder.ts),
   * kept as an instance method because tests reach it by name on the provider
   * instance and the orchestrators embed its output into the rendered HTML.
   */
  private _getInlineStyles(): string {
    return buildInlineStyles();
  }

  /**
   * Inline `<script>` source for the webview.
   *
   * Thin forwarder to {@link buildInlineScript} (in provider/scriptBuilder.ts),
   * kept as an instance method because a test reaches it by name on the
   * provider instance.
   */
  private _getInlineScript(): string {
    return buildInlineScript();
  }

  /**
   * Escape HTML special characters.
   *
   * Thin forwarder to {@link escapeHtml} (in provider/htmlBuilders.ts), kept
   * because the deferred graph-cluster builders and other in-class callers
   * still reach it via `this._escapeHtml`.
   */
  private _escapeHtml(text: string): string {
    return escapeHtml(text);
  }

  /**
   * Check whether the `intellig.commitMessageIssueLinks` feature
   * flag is enabled. Default is `true` (set in package.json contributions).
   * When the flag is off, the details panel renders commit messages with
   * plain HTML-escape and no clickable issue links.
   */
  private _isIssueLinkingEnabled(): boolean {
    try {
      const config = vscode.workspace.getConfiguration('intellig');
      return config.get<boolean>('commitMessageIssueLinks', true);
    } catch {
      // Getting configuration shouldn't throw in practice, but if it does
      // we prefer to keep the flag on so the feature stays visible.
      return true;
    }
  }

  /**
   * Parse and cache the first remote URL for the currently selected
   * repository. Falls back to `origin` when present, otherwise the first
   * remote. Returns `undefined` when the repo has no remotes or when the
   * URL can't be parsed (e.g. custom SCP-style remote we don't know about).
   *
   * The cache key is the repo's root filesystem path; entries survive
   * repository-selector changes.
   */
  private _getSelectedRepoRemote(): IRemoteUrl | undefined {
    const repo = this.getSelectedRepository();
    if (!repo) {
      return undefined;
    }
    const key = repo.rootUri.fsPath;
    if (this._parsedRemoteCache.has(key)) {
      return this._parsedRemoteCache.get(key);
    }
    const remotes = repo.remotes ?? [];
    if (remotes.length === 0) {
      this._parsedRemoteCache.set(key, undefined);
      return undefined;
    }
    const preferred = remotes.find((r) => r.name === 'origin') ?? remotes[0];
    const url = preferred.fetchUrl ?? preferred.pushUrl;
    const parsed = parseRemoteUrl(url);
    this._parsedRemoteCache.set(key, parsed);
    return parsed;
  }

  /**
   * Controller-context view over the issue-linking config flag. Delegates to
   * the in-class config read so the flag lookup stays on the provider while
   * extracted HTML builders can gate on it through the context.
   */
  public isIssueLinkingEnabled(): boolean {
    return this._isIssueLinkingEnabled();
  }

  /**
   * Controller-context view over the selected repository's parsed remote.
   * Delegates to the in-class accessor so the parsed-remote cache stays
   * owned by the provider while extracted HTML builders can resolve issue/PR
   * link targets through the context.
   */
  public getSelectedRepoRemote(): IRemoteUrl | undefined {
    return this._getSelectedRepoRemote();
  }
}

/**
 * Log filter from webview (with string dates)
 */
interface IWebviewLogFilter {
  branch?: string;
  searchText?: string;
  author?: string;
  path?: string;
  since?: string | null;
  until?: string | null;
  noMerges?: boolean;
  firstParent?: boolean;
  simplifyMerges?: boolean;
  minParents?: number;
  maxParents?: number;
  searchRegex?: boolean;
  searchCaseSensitive?: boolean;
  cherryCompareRef?: string;
}

/**
 * Message types from the webview.
 *
 * The optional `tab` field is used for per-tab routing. Legacy
 * messages (selectCommit, panelResize, applyLogFilter, etc.) omit `tab`
 * and are treated as implicit `tab: 'log'` by {@link TabRouter}.
 */
/**
 * Typed envelopes for the new wire types.
 * Included as a separate union (rather than a refactor of the legacy
 * flat `IWebviewMessage` shape) to keep the scope tight: can
 * extend the union as new messages land.
 *
 * Inbound (webview → host):
 *   - rangeSelectCommit       : shift-click range-replace
 *   - addRangeSelectCommit    : shift+ctrl-click range-add
 *   - selectIfNotSelected     : right-click on a non-selected row
 *
 * Outbound (host → webview):
 *   - updateMenuEnableState   : precomputed menu visibility + enable map
 *   - syncSelection           : anchor + selection mirror after a re-render
 */
// TODO(post-Wave-C): fold WaveAInboundMessage / WaveBInboundMessage /
// WaveCInboundMessage into a single discriminated union
// `WebviewInboundMessage` so the `_handleWebviewMessage` switch is
// exhaustively-checkable.
export type WaveAInboundMessage =
  // The click anchor travels WITH the message.
  // The host trusts the message anchor for this single operation rather
  // than consulting its own cache, which can be stale by one render.
  // ADR-009 §3 documents the exception.
  | { type: 'rangeSelectCommit'; commitHash: string; anchorHash: string | null }
  | { type: 'addRangeSelectCommit'; commitHash: string; anchorHash: string | null }
  | { type: 'selectIfNotSelected'; commitHash: string };

export type WaveAOutboundMessage =
  | {
      type: 'updateMenuEnableState';
      state: Record<MultiSelectMenuAction, IMenuItemState>;
      selectedCount: number;
    }
  | {
      type: 'syncSelection';
      anchorHash: string | null;
      selectedHashes: string[];
    };

interface IWebviewMessage {
  type: string;
  path?: string;
  changelistId?: string;
  commitHash?: string;
  commitHashes?: string[];
  action?: string;
  files?: string[];
  targetChangelistId?: string;
  filter?: IWebviewLogFilter | null;
  /**
   * Branch name carried by `branchClick` and `focusBranchOnGraph`.
   * `null` is allowed for the focus message to clear the
   * current focus.
   */
  branchName?: string | null;
  branchType?: 'local' | 'remote';
  widths?: [number, number];
  repositoryIndex?: number;
  /**
   * Click anchor that travels with
   * `rangeSelectCommit` / `addRangeSelectCommit`. `null` means "no
   * prior anchor" (first click after a render). Authoritative for the
   * single message it carries; see {@link WaveAInboundMessage}.
   */
  anchorHash?: string | null;
  /** Optional tab discriminator for tab routing. */
  tab?: TabId;
}

// Nonce generation is owned by `BaseWebviewView._getNonce()`, which
// delegates to the shared `generateNonce()` helper in `utils/webviewNonce.ts`
// so every IntelliG webview produces nonces with identical shape + entropy.
// All three HTML emitters in this file call `this._getNonce()` directly;
// the former module-local `getNonce()` has been removed.
