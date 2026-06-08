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
  isBranchSplit,
  computeChildLanesMap,
} from '../commitGraph';
import {
  computeActiveLanes,
  DEFAULT_GRAPH_CONFIG,
  renderGraphSvg,
} from '../../utils/graphRenderer';
import { savePanelWidths, loadPanelWidths, DEFAULT_PANEL_WIDTHS } from '../../utils/panelLayout';
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
import { buildFileTree, renderFileTree } from './html/fileTree';
import { createLogTabHandler } from './tabs/LogTab';
import { createConsoleTabHandler } from './tabs/ConsoleTab';
import { createIncomingTabHandler } from './tabs/IncomingTab';
import { createUpdateInfoTabHandler } from './tabs/UpdateInfoTab';
import { HistoryTab } from './tabs/HistoryTab';
import { parseRemoteUrl, type IRemoteUrl } from '../../utils/remoteUrl';
import { renderCommitMessageHtml } from '../../utils/commitMessageHtml';
import { BaseWebviewView } from '../../utils/BaseWebviewView';
import { getLogger } from '../../utils/logger';
import {
  computeMenuState,
  computeRangeSelection,
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
   * T3-07 — Set of commit hashes marked `=` by `git log --cherry-mark`
   * (i.e. equivalent to a commit already on the other side — already
   * cherry-picked). Populated when the extension host fetches marks; the
   * Log tab renders a dim row + ✓ badge for each.
   */
  cherryPickedHashes?: Set<string>;
  /**
   * T3-07 — The base ref used when computing {@link cherryPickedHashes}
   * (typically the upstream branch). Surfaced in the tooltip so users know
   * *which* branch the commit has already been cherry-picked to.
   */
  cherryPickBaseRef?: string;
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
export class GitToolWindowProvider extends BaseWebviewView implements IGitToolWindowProvider {
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
   * FU-1 — parsed remote URL for the current repository, cached by repo key.
   * Populated by {@link _setParsedRemoteForSelectedRepo}. Used by
   * {@link _getDetailsPanelHtml} to turn issue/PR refs in commit messages
   * into clickable links.
   *
   * Kept as a map (rather than a single cached value) so repository-selector
   * changes don't thrash the cache when the user flips between repos.
   */
  private readonly _parsedRemoteCache: Map<string, IRemoteUrl | undefined> = new Map();

  /**
   * T1-05 — host-side tab router.
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
   * T2-07 — stateful handler for the History tab. Constructed lazily via
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

    // Register event emitters for disposal
    this._disposables.push(
      this._onDidChangeState,
      this._onDidRequestContextAction,
      this._onDidRequestFileDrop,
      this._onDidRequestLogContextAction,
      this._onDidSelectCommit,
      this._onDidRequestCommitDiff,
      this._onDidRequestLogFilter,
      this._onDidRequestLoadMoreCommits,
      this._onDidRequestInitialData,
      this._onDidRequestRefresh,
      this._onDidSelectRepository
    );

    // T1-05 — construct the tab router and register per-tab handlers.
    // The Log handler is intentionally a no-op in Phase 1; the existing
    // `_handleWebviewMessage` switch continues to own Log dispatch.
    this._tabRouter = new TabRouter({
      onActiveTabChanged: (_tab: TabId): void => {
        // Re-render the webview so the new active panel becomes visible.
        // (Inactive panels use `display: none`; a re-render is the simplest
        // way to update `aria-selected` / `aria-hidden` / `style.display`
        // consistently in Phase 1. Future phases may flip display in JS.)
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
   * T2-07 — attach a GitService to the History tab.
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
   * T2-07 — load a file's history into the History tab and reveal it.
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
   * Read-only accessor for the currently active tab (T1-05 Phase 1).
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
      headBranchName
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
   * T3-07 — Populate the cherry-pick classification for the current log.
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
   * T3-06 — scroll to the commit currently loaded in the graph that matches
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
    // Clear pending changed files when selecting a new commit
    this._pendingChangedFiles = undefined;
    this._pendingChangedFilesError = undefined;

    this._extendedLogState.selectedCommits.clear();
    this._extendedLogState.selectedCommits.add(hash);
    this._extendedLogState.expandedCommit = hash;
    // plain-click sets the multi-select anchor.
    this._extendedLogState.anchorHash = hash;

    // Fire onDidChangeState BEFORE the post sequence
    // so subscribers see "selection changed" on the same event-loop
    // tick the host knows it.
    this._onDidSelectCommit.fire(hash);
    this._onDidChangeState.fire();
    this._postMenuStateUpdate();

    // Send a partial update to the details panel via postMessage
    // instead of a full _updateWebview() to preserve graph scroll position.
    // Also update the graph row selection highlighting and scroll to the commit.
    if (this._view) {
      // Update graph row selection
      void this._view.webview.postMessage({
        type: 'selectGraphRow',
        commitHash: hash,
      });

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
          changedFiles: [],
        };
        const detailsHtml = this._getDetailsPanelHtml(commitDetails);
        void this._view.webview.postMessage({
          type: 'updateDetailsPanel',
          html: detailsHtml,
        });
      } else {
        // Commit not found — show placeholder
        const placeholderHtml = this._getDetailsPanelPlaceholderHtml();
        void this._view.webview.postMessage({
          type: 'updateDetailsPanel',
          html: placeholderHtml,
        });
      }
    }
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
    if (this._extendedLogState.selectedCommits.has(hash)) {
      this._extendedLogState.selectedCommits.delete(hash);
    } else {
      this._extendedLogState.selectedCommits.add(hash);
    }
    // Ctrl/Cmd-click also moves the anchor to the clicked
    // commit, matching IntelliJ's selection model.
    this._extendedLogState.anchorHash = hash;

    // (HIGH) — order: render FIRST so the new document exists,
    // THEN post so postMessage lands on the live page rather than the
    // pre-reload one (ADR-009 §3 sub-rule). _postSyncSelection mirrors
    // the host's anchor + selection onto the JS-side mirror so the
    // freshly-rendered document agrees with state on first paint.
    this._updateWebview();
    // Fire onDidChangeState BEFORE the wire posts
    // so subscribers see "selection changed" on the same event-loop
    // tick the host knows it. Aligns with selectCommit's ordering.
    this._onDidChangeState.fire();
    // belt-and-suspenders — the rendered HTML already
    // carries data-anchor-hash; syncSelection guards against
    // interpolation bugs and partial-update extension cases.
    this._postSyncSelection();
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
    // Mirror selectCommit's pending-state cleanup so
    // a programmatic selection doesn't leak a half-loaded changed-files
    // payload into the next details-panel render.
    this._pendingChangedFiles = undefined;
    this._pendingChangedFilesError = undefined;

    const known = new Set(this._extendedLogState.commitNodes.map((n) => n.commit.hash));
    const filtered = hashes.filter((h) => known.has(h));
    this._extendedLogState.selectedCommits = new Set(filtered);

    if (anchor === undefined) {
      // No explicit anchor: pick the first surviving hash, or null if empty.
      this._extendedLogState.anchorHash = filtered.length > 0 ? filtered[0] : null;
    } else if (anchor === null) {
      this._extendedLogState.anchorHash = null;
    } else {
      this._extendedLogState.anchorHash = known.has(anchor) ? anchor : null;
    }
    // For N>=2, focus the details pane on the FIRST
    // surviving hash so the panel can't show a stale commit that's no
    // longer in the selection. For N=1, use that single hash. For N=0,
    // leave whatever was there (the pane will switch to the placeholder
    // on the next render).
    if (filtered.length >= 1) {
      this._extendedLogState.expandedCommit = filtered[0];
    }

    // (HIGH) — render BEFORE posting so the precomputed enable map
    // anchor sync land on the live document, not the pre-reload one.
    this._updateWebview();
    // Fire BEFORE the post sequence (matches
    // selectCommit's ordering).
    this._onDidChangeState.fire();
    // belt-and-suspenders — the rendered HTML already
    // carries data-anchor-hash; syncSelection guards against
    // interpolation bugs and partial-update extension cases.
    this._postSyncSelection();
    this._postMenuStateUpdate();
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
    if (this._extendedLogState.selectedCommits.has(hash)) {
      return;
    }
    this.selectCommit(hash);
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
    const allHashes = this._extendedLogState.commitNodes.map((n) => n.commit.hash);
    const range = computeRangeSelection(this._extendedLogState.anchorHash, hash, allHashes);

    if (range.length === 0) {
      // Click target not in the rendered list; nothing to do.
      return;
    }

    const anchorIsValid =
      this._extendedLogState.anchorHash !== null &&
      allHashes.indexOf(this._extendedLogState.anchorHash) !== -1;

    if (!anchorIsValid) {
      // Anchor-null OR stale anchor (TL-C-1): behave like a plain-click —
      // set anchor + selection to the clicked hash. Mirrors the
      // applyRangeSelectionDom JS behavior so the host doesn't drift.
      this.selectCommit(hash);
      return;
    }

    this._pendingChangedFiles = undefined;
    this._pendingChangedFilesError = undefined;

    this._extendedLogState.selectedCommits = new Set(range);
    this._extendedLogState.expandedCommit = hash;
    // Anchor unchanged — shift-click does not move the anchor.

    // Fire BEFORE the post sequence.
    this._onDidChangeState.fire();
    // Partial-update path — sync selection + details panel without
    // a full HTML re-render. Bug fix: the previous `_updateWebview()`
    // call rebuilt the entire panel HTML, which destroyed the
    // currently-focused commit-row DOM element. The webview JS keys
    // its keyboard handler off `e.target.closest('.commit-row')`, so
    // after a re-render no row is focused and the next Shift+Arrow
    // press finds no target — the user-visible "Shift+Arrow stops
    // responding after 1-2 commits" symptom.
    this._postSyncSelection();
    this._postDetailsForExpandedCommit();
    this._postMenuStateUpdate();
  }

  /**
   * Shift+Ctrl+click additive range-select.
   *
   * Adds the inclusive range from `anchorHash` to `hash` to the existing
   * selection. With anchor null, falls back to a single toggle so the
   * first click still has an effect. Anchor is unchanged.
   */
  public addRangeSelectCommit(hash: string): void {
    const allHashes = this._extendedLogState.commitNodes.map((n) => n.commit.hash);
    const range = computeRangeSelection(this._extendedLogState.anchorHash, hash, allHashes);

    if (range.length === 0) {
      return;
    }

    const anchorIsValid =
      this._extendedLogState.anchorHash !== null &&
      allHashes.indexOf(this._extendedLogState.anchorHash) !== -1;

    if (!anchorIsValid) {
      // Mirror rangeSelectCommit: stale/null anchor → plain toggle.
      this.toggleCommitSelection(hash);
      return;
    }

    for (const h of range) {
      this._extendedLogState.selectedCommits.add(h);
    }
    this._extendedLogState.expandedCommit = hash;

    // Fire BEFORE the post sequence.
    this._onDidChangeState.fire();
    // Partial-update path — see the matching comment block in
    // `rangeSelectCommit` for the rationale: a full `_updateWebview()`
    // re-render destroys commit-row focus and breaks the keyboard
    // Shift+Arrow loop.
    this._postSyncSelection();
    this._postDetailsForExpandedCommit();
    this._postMenuStateUpdate();
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
    // T1-05 — intercept router-owned messages (tabChange + non-Log tabs).
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
   * T1-05 Phase 1 — pre-filter webview messages through the tab router.
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

      if (webviewFilter.searchText) {
        filter.searchText = webviewFilter.searchText;
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

      // Check if filter is empty
      if (!filter.searchText && !filter.author && !filter.path && !filter.since && !filter.until) {
        filter = undefined;
      }
    }

    this.setLogFilter(filter);
    this._onDidRequestLogFilter.fire(filter);
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

  /**
   * Handle the loadMoreCommits message from the webview.
   * Fires the onDidRequestLoadMoreCommits event so that the extension host
   * can fetch the next batch of commits and append them.
   */
  private _handleLoadMoreCommits(): void {
    this._onDidRequestLoadMoreCommits.fire();
  }

  /**
   * Handle panel resize message from the webview.
   * Receives new width percentages from the draggable dividers,
   * updates the internal state, and persists them to workspace state.
   *
   * @param widths - The new panel width percentages [graph, details]
   */
  private _handlePanelResize(widths: [number, number]): void {
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
   * Set the list of available repositories discovered in the workspace.
   * If the currently selected repository index is out of bounds after the update,
   * it falls back to the first available repository.
   * If no repositories are available, the selected index is reset to 0.
   *
   * @param repos - Array of discovered repositories
   */
  public setAvailableRepositories(repos: IRepository[]): void {
    this._availableRepositories = repos;

    if (repos.length === 0) {
      this._selectedRepositoryIndex = 0;
    } else if (this._selectedRepositoryIndex >= repos.length) {
      // Selected repository became unavailable (folder removed) — fall back to first
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
  </div>`;

    // T1-05 Phase 1 — when the tabbed-layout flag is ON, wrap the Log body
    // with the tab strip + stubbed panel shells. When the flag is OFF, emit
    // exactly the pre-refactor HTML so users see zero UI change.
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
  </script>
</body>
</html>`;
  }

  /**
   * Get the loading HTML shown while initial data is being fetched.
   */
  private _getLoadingHtml(webview: vscode.Webview): string {
    const nonce = this._getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Git Tool Window</title>
  <style>
    ${this._getInlineStyles()}
    .loading-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      color: var(--vscode-descriptionForeground);
      font-size: 13px;
    }
    .loading-spinner-icon {
      font-size: 24px;
      animation: spin 1.5s linear infinite;
      margin-bottom: 12px;
    }
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="loading-container">
    <span class="loading-spinner-icon">&#x27F3;</span>
    <p>Loading git graph\u2026</p>
  </div>
</body>
</html>`;
  }

  /**
   * Generate the HTML for the no-repository state.
   * Displays a prompt to initialize a repository.
   *
   * display a single message prompting the user to initialize a repository.
   */
  private _getNoRepositoryHtml(webview: vscode.Webview): string {
    const nonce = this._getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Git Tool Window</title>
  <style>
    ${this._getInlineStyles()}
  </style>
</head>
<body>
  <div class="no-repository">
    <p>No Git repository found in this workspace.</p>
    <button class="init-repo-button" id="init-repo-btn">Initialize Repository</button>
  </div>
  <script nonce="${nonce}">
    (function() {
      const vscode = acquireVsCodeApi();
      const btn = document.getElementById('init-repo-btn');
      if (btn) {
        btn.addEventListener('click', function() {
          vscode.postMessage({ type: 'initRepository' });
        });
      }
    })();
  </script>
</body>
</html>`;
  }

  /**
   * / HIG — emit the `@font-face` declaration that loads
   * the bundled VS Code codicon TTF, plus the `.codicon` utility rule
   * that every codicon glyph (`<i class="codicon codicon-…">`) needs to
   * render as the actual icon instead of a "tofu" empty-box.
   *
   * The TTF ships at `media/codicon.ttf` (copied from
   * `node_modules/@vscode/codicons/dist/codicon.ttf` at install time).
   * `webview.asWebviewUri()` rewrites the local fs URI into the
   * `https://…/<extensionId>/media/codicon.ttf` form that the
   * webview's CSP accepts. The HTML emitter widens CSP to include
   * `font-src ${webview.cspSource}` so this same-origin URI loads.
   *
   * The base `.codicon` utility rule (font-family declaration +
   * display + text-rendering + smoothing) is copied from the
   * upstream `codicon.css` so the icon renders crisp at the chip's
   * 11px size. Per-glyph `::before { content: "\\…" }` rules are
   * inlined for ONLY the codicons we currently emit — extend the
   * mapping below whenever a new codicon class is added to a
   * webview that uses this loader. Codepoints are sourced from
   * `node_modules/@vscode/codicons/dist/codicon.css` (verbatim).
   * Pinned by `codiconFont-1..3` in commitGraphSnapshots.test.ts.
   */
  private _getCodiconFontFaceCss(webview: vscode.Webview): string {
    // Defensive: many existing unit-test mock webviews stub
    // `cspSource` only and omit `asWebviewUri`. The production VS Code
    // implementation always provides it; for the test surface, fall
    // back to the local-file URI so tests that don't care about the
    // codicon-font wiring don't break. The codiconFont-1..3 RED
    // contract still passes (it asserts the @font-face shape +
    // codepoint rules + CSP, none of which need a real `asWebviewUri`).
    const codiconLocalUri = vscode.Uri.joinPath(this._extensionUri, 'media', 'codicon.ttf');
    const codiconFontUri =
      typeof webview.asWebviewUri === 'function'
        ? webview.asWebviewUri(codiconLocalUri)
        : codiconLocalUri;
    return `
      @font-face {
        font-family: "codicon";
        font-display: block;
        src: url("${codiconFontUri.toString()}") format("truetype");
      }

      .codicon {
        font: normal normal normal 16px/1 codicon;
        display: inline-block;
        text-decoration: none;
        text-rendering: auto;
        text-align: center;
        text-transform: none;
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
        user-select: none;
        vertical-align: middle;
      }

      /* Codicon glyph mapping — upstream codepoints from
         @vscode/codicons@0.0.45 (dist/codicon.css). Add a new
         \`.codicon-<name>\` rule here whenever a new codicon class is
         emitted in the provider's HTML. Both \`::before\` (modern
         double-colon) and \`:before\` (single-colon, what upstream
         uses) are accepted by the engine; we keep the upstream
         single-colon shape for byte-equivalence with codicon.css. */
      .codicon-check:before { content: "\\eab2"; }
      .codicon-git-branch:before { content: "\\ec6f"; }
      .codicon-cloud:before { content: "\\ebaa"; }
      /* codicon-tag glyph for tag chips. Codepoint pulled from
         @vscode/codicons@0.0.45 dist/codicon.css (.codicon-tag:before
         → \\ea66). Pinned by codiconFont-4. */
      .codicon-tag:before { content: "\\ea66"; }
    `;
  }

  /**
   * Get CSS styles for the 2-panel flexbox layout.
   *
   * Includes:
   * - Flexbox row layout for horizontal panel arrangement
   * - Panel overflow and sizing rules
   * - Draggable divider styling
   * - Vertical stacking when container width < 500px
   * - All existing panel styles (graph, details)
   *
   * @returns CSS string for the 2-panel layout
   */
  private _getThreePanelStyles(): string {
    return `
      ${this._getInlineStyles()}

      /* Panel Layout*/
      .three-panel-layout {
        display: flex;
        flex-direction: row;
        height: 100vh;
        width: 100%;
        overflow: hidden;
      }

      .three-panel-layout > .panel {
        overflow: auto;
        min-width: 0;
        height: 100%;
      }

      #branch-panel {
        border-right: none;
      }

      #graph-panel {
        border-right: none;
      }

      #details-panel {
        /* No right border needed */
      }

      /* Panel Divider - Draggable separator between panels */
      .panel-divider {
        width: 4px;
        min-width: 4px;
        cursor: col-resize;
        background-color: var(--vscode-panel-border);
        transition: background-color 0.15s ease;
        flex-shrink: 0;
        position: relative;
        z-index: 10;
      }

      .panel-divider::before {
        content: '';
        position: absolute;
        top: 0;
        bottom: 0;
        left: -3px;
        right: -3px;
      }

      .panel-divider:hover,
      .panel-divider.dragging {
        background-color: var(--vscode-focusBorder);
      }

      .panel-divider:focus {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: -1px;
      }

      /* Vertical stacking for narrow containers*/
      @container (max-width: 499px) {
        .three-panel-layout {
          flex-direction: column;
        }

        .three-panel-layout > .panel {
          width: 100% !important;
          height: 50%;
          min-height: 100px;
        }

        .panel-divider {
          width: 100%;
          min-width: 100%;
          height: 4px;
          min-height: 4px;
          cursor: row-resize;
        }
      }

      /* JS-based vertical stacking fallback for < 500px */
      .three-panel-layout.vertical-layout {
        flex-direction: column;
      }

      .three-panel-layout.vertical-layout > .panel {
        width: 100% !important;
        height: 50%;
        min-height: 100px;
      }

      .three-panel-layout.vertical-layout .panel-divider {
        width: 100%;
        min-width: 100%;
        height: 4px;
        min-height: 4px;
        cursor: row-resize;
      }

      /* Prevent text selection during divider drag */
      body.resizing {
        user-select: none;
        cursor: col-resize;
      }

      body.resizing-vertical {
        user-select: none;
        cursor: row-resize;
      }
    `;
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
   * Return a `var(--vscode-gitDecoration-*, #hex)` expression
   * for the given file status, so the colour follows the user's theme
   * (especially high-contrast) instead of the bare IntelliJ hex. The
   * Hex literal is retained as the CSS-var fallback (defence
   * in depth + dev-mode jsdom test surface). Pinned by
   * `fileStatusTheme-1..8` in detailsPanel.test.ts.
   */
  private _getFileStatusColor(status: FileStatus): string {
    const cssVar = FILE_STATUS_THEME_VARS[status];
    const fallback = INTELLIJ_FILE_STATUS_COLORS[status] || '#FFFFFF';
    return cssVar ? `var(${cssVar}, ${fallback})` : fallback;
  }

  /**
   * Get status character for file status
   */
  private _getFileStatusChar(status: FileStatus): string {
    const statusChars: Record<FileStatus, string> = {
      modified: 'M',
      added: 'A',
      deleted: 'D',
      renamed: 'R',
      copied: 'C',
      untracked: 'U',
      ignored: 'I',
      conflicted: '!',
    };
    return statusChars[status] || '?';
  }

  /**
   * Get file name from path
   */
  private _getFileName(path: string): string {
    const parts = path.split('/');
    return parts[parts.length - 1];
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
      return `
        <div class="graph-panel" role="listbox" aria-label="Commit Graph" aria-multiselectable="true" data-selected-count="0" data-anchor-hash="">
          <p class="empty-message">No commits found</p>
        </div>`;
    }

    // Compute active lanes for the entire commit list
    const activeLaneMap = computeActiveLanes(commitNodes);

    // Compute terminal nodes and child count map for icon rendering
    const terminalNodes = computeTerminalNodes(commitNodes);
    const childCountMap = computeChildCountMap(commitNodes);
    const childLanesMap = computeChildLanesMap(commitNodes);

    // True when ANY commit in the rendered set is on the
    // focused-branch path. The renderer reads this to decide whether to
    // brighten on-path / dim off-path lines and nodes. When false, the
    // graph renders at baseline (no change from).
    const hasFocusedBranch = commitNodes.some((n) => n.onFocusedBranchPath === true);

    // T3-07 — pre-resolve the cherry-picked set once per render to keep the
    // per-row check O(1).
    const cherryPickedHashes = this._extendedLogState.cherryPickedHashes;
    const cherryPickBaseRef = this._extendedLogState.cherryPickBaseRef;

    // Build commit rows
    const rowsHtml = commitNodes
      .map((node, index) => {
        const commit = node.commit;
        const isSelected = selected.has(commit.hash);
        const isCherryPicked = cherryPickedHashes?.has(commit.hash) ?? false;

        // Generate SVG graph for this row
        const activeLanes = activeLaneMap.get(index) || new Set<number>();
        const isTerminal = terminalNodes.has(commit.hash);
        const isSplitPoint = isBranchSplit(commit.hash, childCountMap);
        const childLanes = childLanesMap.get(commit.hash) || new Set<number>();
        const graphSvg = renderGraphSvg(
          node,
          index,
          activeLanes,
          DEFAULT_GRAPH_CONFIG,
          isTerminal,
          isSplitPoint,
          childLanes,
          hasFocusedBranch
        );

        // Format fields.
        //
        // Emit the FULL first line of the commit message
        // and let CSS `.commit-title { overflow: hidden; text-overflow:
        // ellipsis; white-space: nowrap }` truncate responsively based on
        // the panel's actual flex-allocated width. The call to
        // `_truncateMessage(…, 60)` hard-capped the row text at 60 chars
        // regardless of available space, so a 1200px-wide panel still
        // showed `"…"` on a 70-char subject. The tooltip (`title=` below)
        // still carries the full multi-line message so hover still
        // reveals everything.
        //
        // `_truncateMessage` is preserved at :3149 — still used by
        // `_getMultiCommitDetailsPanelHtml` at :3057 for the
        // details-panel preview, where a hard char cap IS desired
        // (no flex container, no responsive ellipsis behind it).
        const messageFirstLine = commit.message.split('\n')[0];
        const messageSummary = this._escapeHtml(messageFirstLine);
        const fullMessage = this._escapeHtml(commit.message);
        const authorName = this._escapeHtml(commit.author.name);
        const authorEmail = this._escapeHtml(commit.author.email);
        const absoluteDate = this._formatAbsoluteDate(commit.authorDate);
        const fullDate = commit.authorDate.toLocaleString();

        // Generate branch labels HTML
        const branchLabelsHtml = this._getBranchLabelsHtml(node);

        // `✓` badge + title tooltip for already-cherry-picked commits.
        const cherryBadgeHtml = isCherryPicked
          ? `<span class="commit-cherry-badge" title="${
              cherryPickBaseRef
                ? `Already cherry-picked to ${this._escapeHtml(cherryPickBaseRef)}`
                : 'Already cherry-picked'
            }" aria-label="already cherry-picked">✓</span>`
          : '';

        const rowClasses = [
          'commit-row',
          isSelected ? 'selected' : '',
          isCherryPicked ? 'commit-row-cherry-picked' : '',
        ]
          .filter(Boolean)
          .join(' ');

        return `
        <div class="${rowClasses}"
             data-hash="${this._escapeHtml(commit.hash)}"
             role="option"
             tabindex="0"
             aria-selected="${isSelected}">
          <div class="commit-graph">
            ${graphSvg}${cherryBadgeHtml}
          </div>
          <div class="commit-info">
            <div class="commit-title" title="${fullMessage}">${messageSummary}</div>
            <div class="commit-branches">${branchLabelsHtml}</div>
            <span class="commit-author" title="${authorEmail}">${authorName}</span>
            <span class="commit-date" title="${fullDate}">${absoluteDate}</span>
          </div>
        </div>`;
      })
      .join('');

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

    return `
      <div class="graph-panel" role="listbox" aria-label="Commit Graph" aria-multiselectable="true" data-selected-count="${selected.size}" data-anchor-hash="${this._escapeHtml(anchorAttr)}" data-loaded-count="${loaded}" data-total-available="${total}"${scrollAttr}>
        ${focusedBranchHelpHtml}
        ${repositorySelectorHtml}
        ${rowsHtml}
        ${loadingIndicatorHtml}
      </div>`;
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
    const headHash = this._extendedLogState.headHash;
    const isHeadCommit = !!headHash && node.commit.hash === headHash;
    const hasBranches = !!node.branches && node.branches.length > 0;
    // Tag chips render alongside the existing HEAD/branch
    // chip family. The empty-string return contract (snap-7d) extends to
    // the no-tag case here so `.commit-branches:empty` still collapses.
    const hasTags = !!node.tags && node.tags.length > 0;

    if (!isHeadCommit && !hasBranches && !hasTags) {
      // CSS `.commit-branches:empty { display: none }` depends
      // on this returning the LITERAL empty string (not whitespace, not
      // an HTML comment) so the empty wrapper collapses with no margin
      // / no flex basis. Pinned by snap-7d in commitGraphSnapshots.test.ts.
      return '';
    }

    // HEAD chip is prepended FIRST (leftmost) so it precedes
    // any branch chips on the same commit. Detached HEAD: chip stands
    // alone. Pinned by snap-9a..9f.
    // The HEAD chip carries role="img" + descriptive
    // aria-label so SR users hear "Current HEAD" rather than just the
    // bare "HEAD" string. The codicon-check prefix is the non-color
    // WCAG 1.4.1 affordance — the icon is decorative for AT (the
    // aria-label is authoritative), so aria-hidden="true" hides it.
    // Pinned by snap-12a + snap-12f.
    const headChipHtml = isHeadCommit
      ? '<span class="branch-label-head" data-head-chip="true" role="img" aria-label="Current HEAD"><i class="codicon codicon-check" aria-hidden="true"></i>HEAD</span>'
      : '';

    const focusedBranchName = this._extendedLogState.focusedBranchName;
    const headBranchName = this._extendedLogState.headBranchName;
    const allBranches = node.branches || [];
    // Tighter chip collapse (UX request, IntelliJ parity).
    //
    // Previously: render up to 2 chips inline, collapse the rest into
    // a `+N more` summary chip — which was still noisy on hot commits
    // tagged by many remotes (origin/foo + upstream/foo + fork/foo + …).
    //
    // Now: when the host has told us which branch HEAD points to OR
    // a branch is focused, ONLY those two privileged chips stay
    // inline. Everything else collapses into the summary chip. The
    // two privileged chips are the ones the user explicitly cares
    // about; the rest are reachable via the summary chip's tooltip.
    //
    // Fallback (no privileged ref known — e.g. detached HEAD with no
    // focus, or unit tests that drive _getBranchLabelsHtml directly
    // without populating headBranchName): preserve the prior "top 2
    // inline, +N collapsed" behaviour so we don't degrade to "all
    // collapsed" when we have no signal about which chips matter.
    // This branch matters in the wild only for detached-HEAD-no-focus
    // — which is a rare state and where the old top-2 cap is fine.
    const MAX_INLINE_BRANCH_CHIPS_FALLBACK = 2;
    const havePrivilegedRef = !!headBranchName || !!focusedBranchName;
    let inlineBranches: IBranchRef[];
    let collapsedBranches: IBranchRef[];
    if (havePrivilegedRef) {
      const isInlineKeepName = (name: string): boolean =>
        name === headBranchName || name === focusedBranchName;
      inlineBranches = allBranches.filter((b) => isInlineKeepName(b.name));
      collapsedBranches = allBranches.filter((b) => !isInlineKeepName(b.name));
    } else {
      inlineBranches = allBranches.slice(0, MAX_INLINE_BRANCH_CHIPS_FALLBACK);
      collapsedBranches = allBranches.slice(MAX_INLINE_BRANCH_CHIPS_FALLBACK);
    }

    const labels = inlineBranches.map((branchRef) => {
      const branchName = branchRef.name;
      // Bug E: classify directly from the branch ref's `type` (sourced from
      // IBranch.type / refs-prefix), NOT from a `name.includes('/')` heuristic.
      // A local branch named `feature/foo` is local, not remote.
      const isRemote = branchRef.type === 'remote';
      const baseClass = isRemote ? 'branch-label-remote' : 'branch-label-local';
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
      const iconClass = 'codicon-git-branch';
      const ariaLabelText = isRemote
        ? `Remote branch: ${branchName}`
        : `Local branch: ${branchName}`;
      const ariaLabel = this._escapeHtml(ariaLabelText);
      // Focused chip carries `aria-describedby` to
      // a visually-hidden help span (rendered once at panel level)
      // explaining the focus state. Non-focused chips omit the
      // attribute so SRs don't announce the help text on every chip.
      const ariaDescribedByAttr = isFocused ? ' aria-describedby="focused-branch-help"' : '';
      // T-10: data-branch-name carries the unescaped name so the inline
      // script's partial-update handler can match by attribute. The
      // attribute value goes through the same _escapeHtml the chip text
      // uses so reflective injection is impossible.
      return `<span class="${cssClass}" data-branch-name="${escapedName}" role="img" aria-label="${ariaLabel}"${ariaDescribedByAttr}><i class="codicon ${iconClass}" aria-hidden="true"></i>${escapedName}</span>`;
    });

    // Tag chips render LAST (rightmost) so HEAD
    // branch chips remain in their existing order. Each tag chip carries
    // the chip-family contract: role="img" + aria-label="Tag: …"
    // + leading codicon prefix (codicon-tag for the non-color WCAG 1.4.1
    // affordance, distinct from codicon-git-branch / codicon-cloud /
    // codicon-check). aria-pressed is intentionally absent — tags are
    // not interactive yet (chip-as-button is still future work). The
    // tag name is run through `_escapeHtml` for both the textContent
    // and the aria-label since tags are user-controlled. data-tag-name
    // carries the unescaped name for any future click-handler partial-
    // update path (mirroring the data-branch-name discipline above).
    const tagLabels = (node.tags || []).map((tagName) => {
      const escapedName = this._escapeHtml(tagName);
      const ariaLabel = this._escapeHtml(`Tag: ${tagName}`);
      return `<span class="tag-label" data-tag-name="${escapedName}" role="img" aria-label="${ariaLabel}"><i class="codicon codicon-tag" aria-hidden="true"></i>${escapedName}</span>`;
    });

    // Collapse summary chip: `+N` shown after the inline branch chips
    // (and before the tag chips) when more branches exist than fit
    // inline. The tooltip lists the collapsed branch names so the user
    // can discover them on hover; data-collapsed-branches keeps a
    // pipe-delimited list available for any future click-to-expand
    // wiring.
    let collapsedSummaryHtml = '';
    if (collapsedBranches.length > 0) {
      const tooltipLines = collapsedBranches.map((b) => b.name).join('\n');
      const escapedTooltip = this._escapeHtml(tooltipLines);
      const dataAttr = this._escapeHtml(collapsedBranches.map((b) => b.name).join('|'));
      const ariaLabel = this._escapeHtml(
        `${collapsedBranches.length} more branch${collapsedBranches.length === 1 ? '' : 'es'}: ${collapsedBranches.map((b) => b.name).join(', ')}`
      );
      collapsedSummaryHtml = `<span class="branch-label-collapsed" data-collapsed-branches="${dataAttr}" role="img" aria-label="${ariaLabel}" title="${escapedTooltip}">+${collapsedBranches.length}</span>`;
    }

    return headChipHtml + labels.join('') + collapsedSummaryHtml + tagLabels.join('');
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
        return `<option value="${index}"${selected}>${folderName}</option>`;
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
    const headHash =
      this._extendedLogState.commitNodes.length > 0
        ? this._extendedLogState.commitNodes[0].commit.hash
        : '';

    // \u2014 A2: items marked with `menu-multi-hidden` default to hidden;
    // the inline-script `updateContextMenuState` JS toggles the class based
    // on `selectedCount`. This keeps the visibility rules in one
    // declarative place rather than string-rebuilding the menu each time.
    //
    // Single-only items render the `data-multi-action="single-only"` data
    // attribute so the JS can locate them without hardcoding the action
    // list. Multi-only items get `data-multi-action="multi-only"`.
    return `
      <div id="commit-context-menu" class="commit-context-menu context-menu" hidden role="menu" aria-label="Commit actions" data-head-hash="${this._escapeHtml(headHash)}">
        <div class="context-menu-item" data-action="copyHash" role="menuitem" tabindex="0">Copy Revision Number</div>
        <div class="context-menu-item" data-action="createPatch" role="menuitem" tabindex="0">Create Patch\u2026</div>
        <div class="context-menu-item" data-action="cherryPick" role="menuitem" tabindex="0">Cherry-Pick</div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" data-action="checkoutRevision" data-multi-action="single-only" role="menuitem" tabindex="0">Checkout Revision</div>
        <div class="context-menu-item" data-action="showRepoAtRevision" data-multi-action="single-only" role="menuitem" tabindex="0">Show Repository at Revision</div>
        <div class="context-menu-item" data-action="compareWithLocal" data-multi-action="single-only" role="menuitem" tabindex="0">Compare with Local</div>
        <div class="context-menu-item menu-multi-hidden" data-action="compareVersions" data-multi-action="multi-only" role="menuitem" tabindex="0">Compare Versions</div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" data-action="editCommitMessage" data-multi-action="single-only" role="menuitem" tabindex="0">Edit Commit Message</div>
        <div class="context-menu-item context-menu-danger" data-action="resetToHere" data-multi-action="single-only" role="menuitem" tabindex="0">Reset Current Branch to Here\u2026</div>
        <div class="context-menu-item" data-action="revert" role="menuitem" tabindex="0">Revert Commit</div>
        <div class="context-menu-item" data-action="undoCommit" data-multi-action="single-only" role="menuitem" tabindex="0">Undo Commit</div>
        <div class="context-menu-item context-menu-danger" data-action="dropCommit" role="menuitem" tabindex="0">Drop Commit</div>
        <div class="context-menu-item menu-multi-hidden" data-action="squashCommits" data-multi-action="multi-only" role="menuitem" tabindex="0">Squash Commits</div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" data-action="squashWithPrevious" data-multi-action="single-only" role="menuitem" tabindex="0">Squash with Previous</div>
        <div class="context-menu-item" data-action="fixupWithPrevious" data-multi-action="single-only" role="menuitem" tabindex="0">Fixup with Previous</div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" data-action="compareWithBranch" data-multi-action="single-only" role="menuitem" tabindex="0">Compare with Branch\u2026</div>
        <div class="context-menu-item" data-action="mergeIntoCurrent" data-multi-action="single-only" role="menuitem" tabindex="0">Merge into Current Branch</div>
        <div class="context-menu-item" data-action="interactiveRebase" data-multi-action="single-only" role="menuitem" tabindex="0">Interactively Rebase from Here\u2026</div>
      </div>`;
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
    // --- Commit metadata section ---
    // FU-1: render the commit message and body with issue/PR references
    // converted to clickable links, gated by the
    // `intellig.commitMessageIssueLinks` config (default true, from T3-09).
    // When the flag is off, or when no remote URL is parseable for the
    // current repository, we fall back to pure HTML-escape as before.
    const issueLinksEnabled = this._isIssueLinkingEnabled();
    const remote = issueLinksEnabled ? this._getSelectedRepoRemote() : undefined;
    const escape = (s: string): string => this._escapeHtml(s);
    const messageHtml = issueLinksEnabled
      ? renderCommitMessageHtml(commitDetails.message, remote, escape)
      : this._escapeHtml(commitDetails.message);
    const bodyHtml = commitDetails.body
      ? issueLinksEnabled
        ? renderCommitMessageHtml(commitDetails.body, remote, escape)
        : this._escapeHtml(commitDetails.body)
      : '';
    const fullHash = this._escapeHtml(commitDetails.hash);
    const authorName = this._escapeHtml(commitDetails.author.name);
    const authorEmail = this._escapeHtml(commitDetails.author.email);
    const dateStr = commitDetails.date.toLocaleString();

    // Parent hashes
    const parentsHtml =
      commitDetails.parents.length > 0
        ? commitDetails.parents
            .map(
              (p) =>
                `<span class="parent-hash" data-parent-hash="${this._escapeHtml(p)}" title="${this._escapeHtml(p)}">${this._escapeHtml(p.substring(0, 7))}</span>`
            )
            .join(', ')
        : '<span class="no-parents">None (root commit)</span>';

    // --- Changed files section ---
    let changedFilesHtml: string;
    if (commitDetails.changedFilesError) {
      changedFilesHtml = `<p class="empty-message error-message">Failed to load changed files: ${this._escapeHtml(commitDetails.changedFilesError)}</p>`;
    } else if (commitDetails.changedFiles.length === 0) {
      changedFilesHtml = '<p class="empty-message">No changed files</p>';
    } else {
      changedFilesHtml = renderFileTree(buildFileTree(commitDetails.changedFiles), 0, {
        escapeHtml: (s) => this._escapeHtml(s),
        statusColor: (st) => this._getFileStatusColor(st),
        statusChar: (st) => this._getFileStatusChar(st),
        fileName: (p) => this._getFileName(p),
        commitHash: commitDetails.hash,
      });
    }

    return `
      <div class="details-panel" role="region" aria-label="Commit Details">
        <div class="details-changed-files">
          <h4>Changed Files (${commitDetails.changedFiles.length})</h4>
          <div class="changed-files-list" role="list" aria-label="Changed Files">
            ${changedFilesHtml}
          </div>
        </div>
        <div class="details-metadata">
          <div class="detail-row message-row">
            <span class="detail-label">Message:</span>
            <pre class="detail-value commit-full-message">${messageHtml}${bodyHtml ? '\n\n' + bodyHtml : ''}</pre>
          </div>
          <div class="detail-row">
            <span class="detail-label">Hash:</span>
            <span class="detail-value hash-value" data-copy-text="${fullHash}" title="Click to copy">${fullHash}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Author:</span>
            <span class="detail-value">${authorName} &lt;${authorEmail}&gt;</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Date:</span>
            <span class="detail-value">${dateStr}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Parents:</span>
            <span class="detail-value">${parentsHtml}</span>
          </div>
        </div>
      </div>`;
  }

  /**
   * Get placeholder HTML for the Details Panel when no commit is selected.
   *
   * a placeholder message indicating that a commit should be selected.
   *
   * @returns HTML string for the placeholder state
   */
  public _getDetailsPanelPlaceholderHtml(): string {
    return `
      <div class="details-panel" role="region" aria-label="Commit Details">
        <div class="details-placeholder">
          <p class="placeholder-message">Select a commit to view details</p>
        </div>
      </div>`;
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
    const commitCount = commitDetailsList.length;

    // --- Header section: "N commits selected" ---
    const headerHtml = `<h3 class="multi-commit-header">${commitCount} commit${commitCount !== 1 ? 's' : ''} selected</h3>`;

    // --- Selected commits list ---
    const commitsListHtml = commitDetailsList
      .map((details) => {
        const shortHash = this._escapeHtml(details.hash.substring(0, 7));
        const message = this._escapeHtml(this._truncateMessage(details.message, 60));
        return `
          <div class="multi-commit-item" role="listitem">
            <span class="commit-short-hash">${shortHash}</span>
            <span class="commit-summary">${message}</span>
          </div>`;
      })
      .join('');

    // --- Combined changed files ---
    // Use pre-computed combined files if provided, otherwise merge from individual commits
    const mergedFiles = combinedChangedFiles ?? this._mergeChangedFiles(commitDetailsList);

    let changedFilesHtml: string;
    if (mergedFiles.length === 0) {
      changedFilesHtml = '<p class="empty-message">No changed files</p>';
    } else {
      changedFilesHtml = renderFileTree(buildFileTree(mergedFiles), 0, {
        escapeHtml: (s) => this._escapeHtml(s),
        statusColor: (st) => this._getFileStatusColor(st),
        statusChar: (st) => this._getFileStatusChar(st),
        fileName: (p) => this._getFileName(p),
      });
    }

    return `
      <div class="details-panel multi-commit-details" role="region" aria-label="Multi-Commit Details" data-selected-count="${commitCount}">
        ${headerHtml}
        <div class="multi-commit-list" role="list" aria-label="Selected Commits">
          ${commitsListHtml}
        </div>
        <div class="details-changed-files">
          <h4>Changed Files (${mergedFiles.length})</h4>
          <div class="changed-files-list" role="list" aria-label="Changed Files">
            ${changedFilesHtml}
          </div>
        </div>
      </div>`;
  }

  /**
   * Merge changed files from multiple commit details into a single deduplicated list.
   * When the same file appears in multiple commits, the last occurrence's status is kept.
   * Files are sorted alphabetically by path.
   *
   * @param commitDetailsList - Array of commit details to merge files from
   * @returns Deduplicated and sorted array of changed files
   */
  private _mergeChangedFiles(commitDetailsList: ICommitDetails[]): IChangedFile[] {
    const fileMap = new Map<string, IChangedFile>();

    for (const details of commitDetailsList) {
      for (const file of details.changedFiles) {
        // Later commits override earlier ones for the same path
        fileMap.set(file.path, { ...file });
      }
    }

    // Sort alphabetically by path
    return Array.from(fileMap.values()).sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Truncate message to specified length
   */
  private _truncateMessage(message: string, maxLength: number): string {
    // Get first line only
    const firstLine = message.split('\n')[0];
    if (firstLine.length <= maxLength) {
      return firstLine;
    }
    return firstLine.substring(0, maxLength - 3) + '...';
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
   * Get inline styles for the webview
   */
  private _getInlineStyles(): string {
    return `
      :root {
        --vscode-font-family: var(--vscode-editor-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif);
        --vscode-font-size: var(--vscode-editor-font-size, 13px);
        /* IntelliJ-style file status colors */
        --intellij-modified: #6897BB;
        --intellij-added: #629755;
        --intellij-deleted: #6C6C6C;
        --intellij-untracked: #CC7832;
        --intellij-ignored: #848504;
        --intellij-conflicted: #FF0000;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        padding: 0;
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        background-color: var(--vscode-sideBar-background);
      }

      /* Visually-hidden utility for assistive-tech-only text. Removes the
         element from sighted layout while keeping it in the DOM for screen
         readers, find-in-page, and a11y inspectors. The double-clip pattern
         (clip + clip-path) is the WAI-ARIA-recommended shape: older browsers
         fall back to "clip", modern browsers honour "clip-path". */
      .visually-hidden {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        clip-path: inset(50%);
        white-space: nowrap;
        border: 0;
      }

      .git-tool-window {
        display: flex;
        flex-direction: column;
        height: 100vh;
      }

      /* No Repository Message */
      .no-repository {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        text-align: center;
        color: var(--vscode-descriptionForeground);
      }

      .init-repo-button {
        margin-top: 16px;
        padding: 8px 16px;
        background-color: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: none;
        border-radius: 2px;
        cursor: pointer;
      }

      .init-repo-button:hover {
        background-color: var(--vscode-button-hoverBackground);
      }

      .init-repo-button:focus {
        outline: 1px solid var(--vscode-focusBorder);
      }

      /* Local Changes Toolbar */
      .local-changes-toolbar {
        display: flex;
        justify-content: flex-end;
        padding: 4px 8px;
        border-bottom: 1px solid var(--vscode-panel-border);
        background-color: var(--vscode-sideBar-background);
      }

      .toolbar-button {
        padding: 4px 8px;
        background: transparent;
        color: var(--vscode-foreground);
        border: none;
        border-radius: 3px;
        cursor: pointer;
        font-size: 14px;
      }

      .toolbar-button:hover {
        background-color: var(--vscode-toolbar-hoverBackground);
      }

      /* Local Changes Content */
      .local-changes-content {
        flex: 1;
        overflow: auto;
        padding: 4px;
      }

      /* Changelist Styles */
      .changelist {
        margin-bottom: 4px;
        border-radius: 3px;
        transition: background-color 0.2s ease;
      }

      .changelist.drag-over {
        background-color: var(--vscode-list-dropBackground);
        outline: 2px dashed var(--vscode-focusBorder);
      }

      .changelist-header {
        display: flex;
        align-items: center;
        padding: 6px 8px;
        cursor: pointer;
        border-radius: 3px;
        user-select: none;
      }

      .changelist-header:hover {
        background-color: var(--vscode-list-hoverBackground);
      }

      .changelist-header:focus {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: -1px;
      }

      .expand-icon {
        width: 16px;
        font-size: 10px;
        color: var(--vscode-foreground);
        flex-shrink: 0;
      }

      .changelist-name {
        flex: 1;
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .file-count {
        color: var(--vscode-descriptionForeground);
        font-size: 0.9em;
        margin-left: 8px;
      }

      .default-badge {
        font-size: 10px;
        padding: 1px 4px;
        margin-left: 8px;
        background-color: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
        border-radius: 3px;
      }

      .changelist-files {
        margin-left: 8px;
        padding-left: 8px;
        border-left: 1px solid var(--vscode-panel-border);
      }

      /* File Item Styles - IntelliJ-style */
      .file-item {
        display: flex;
        align-items: center;
        padding: 3px 8px;
        cursor: pointer;
        border-radius: 3px;
        user-select: none;
        transition: background-color 0.1s ease;
      }

      .file-item:hover {
        background-color: var(--vscode-list-hoverBackground);
      }

      .file-item:focus {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: -1px;
      }

      .file-item.selected {
        background-color: var(--vscode-list-activeSelectionBackground);
        color: var(--vscode-list-activeSelectionForeground);
      }

      .file-item.dragging {
        opacity: 0.5;
      }

      .file-status {
        width: 16px;
        height: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        font-weight: bold;
        margin-right: 6px;
        flex-shrink: 0;
      }

      .file-path {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
      }

      .file-dir {
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        margin-left: 8px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 150px;
      }

      .staged-indicator {
        color: var(--intellij-added);
        margin-left: 4px;
        font-size: 10px;
      }

      /* Context Menu Styles */
      .context-menu {
        position: fixed;
        background-color: var(--vscode-menu-background);
        border: 1px solid var(--vscode-menu-border);
        border-radius: 4px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        min-width: 180px;
        z-index: 1000;
        padding: 4px 0;
      }

      .context-menu-item {
        display: flex;
        align-items: center;
        padding: 6px 12px;
        cursor: pointer;
        color: var(--vscode-menu-foreground);
        font-size: 13px;
      }

      .context-menu-item:hover {
        background-color: var(--vscode-menu-selectionBackground);
        color: var(--vscode-menu-selectionForeground);
      }

      .context-menu-item.context-menu-danger:hover {
        background-color: var(--vscode-inputValidation-errorBackground);
      }

      .context-menu-item.disabled {
        opacity: 0.4;
        cursor: default;
        pointer-events: none;
      }

      /* Visibility flag for multi-select menu items. Keeps single-only
         items hidden when N>=2 and multi-only items hidden when their N
         constraint isn't met. display: none takes the row out of the flow
         so the menu collapses naturally. */
      .context-menu-item.menu-multi-hidden {
        display: none;
      }

      .context-menu-arrow {
        margin-left: auto;
        font-size: 10px;
        color: var(--vscode-descriptionForeground);
      }

      .context-menu-separator {
        height: 1px;
        background-color: var(--vscode-menu-separatorBackground);
        margin: 4px 0;
      }

      .context-menu-submenu {
        position: relative;
      }

      /* Console Styles */
      .console-toolbar {
        display: flex;
        justify-content: flex-end;
        padding: 4px;
        border-bottom: 1px solid var(--vscode-panel-border);
      }

      .clear-console-button {
        padding: 4px 8px;
        background: transparent;
        color: var(--vscode-foreground);
        border: 1px solid var(--vscode-button-border, transparent);
        border-radius: 2px;
        cursor: pointer;
        font-size: 12px;
      }

      .clear-console-button:hover {
        background-color: var(--vscode-toolbar-hoverBackground);
      }

      .console-content {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 12px;
        padding: 8px;
      }

      .console-entry {
        padding: 8px;
        border-bottom: 1px solid var(--vscode-panel-border);
      }

      .console-entry.error {
        background-color: var(--vscode-inputValidation-errorBackground);
      }

      .console-timestamp {
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        margin-bottom: 4px;
      }

      .console-command {
        color: var(--vscode-terminal-ansiCyan);
        margin-bottom: 4px;
      }

      .console-output {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-all;
      }

      .console-exit-code {
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        margin-top: 4px;
      }

      /* Empty/Placeholder Messages */
      .empty-message, .placeholder-message {
        color: var(--vscode-descriptionForeground);
        text-align: center;
        padding: 16px;
      }

      /* Log View Styles: IntelliJ-style log layout */
      .log-container {
        display: flex;
        flex-direction: column;
        height: 100%;
      }

      .log-toolbar {
        display: flex;
        justify-content: flex-end;
        padding: 4px 8px;
        border-bottom: 1px solid var(--vscode-panel-border);
        background-color: var(--vscode-sideBar-background);
        gap: 4px;
      }

      /* Log Filter Bar Styles*/
      .log-filter-bar {
        padding: 8px;
        background-color: var(--vscode-input-background);
        border-bottom: 1px solid var(--vscode-panel-border);
      }

      .log-filter-row {
        display: flex;
        gap: 12px;
        margin-bottom: 8px;
        flex-wrap: wrap;
      }

      .log-filter-row:last-of-type {
        margin-bottom: 0;
      }

      .log-filter-group {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-width: 120px;
      }

      .log-filter-group-date {
        flex: 0 0 auto;
        min-width: 130px;
      }

      .log-filter-label {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        margin-bottom: 2px;
        font-weight: 500;
      }

      .log-filter-input {
        padding: 4px 8px;
        border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
        border-radius: 3px;
        background-color: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        font-size: 12px;
        font-family: var(--vscode-font-family);
      }

      .log-filter-input:focus {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: -1px;
        border-color: var(--vscode-focusBorder);
      }

      .log-filter-input::placeholder {
        color: var(--vscode-input-placeholderForeground);
      }

      .log-filter-date {
        width: 130px;
      }

      .log-filter-actions {
        display: flex;
        gap: 8px;
        margin-top: 8px;
        justify-content: flex-end;
      }

      .log-filter-button {
        padding: 4px 12px;
        border: none;
        border-radius: 3px;
        font-size: 12px;
        cursor: pointer;
        transition: background-color 0.1s ease;
      }

      .log-filter-apply {
        background-color: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
      }

      .log-filter-apply:hover {
        background-color: var(--vscode-button-hoverBackground);
      }

      .log-filter-clear {
        background-color: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
      }

      .log-filter-clear:hover:not(:disabled) {
        background-color: var(--vscode-button-secondaryHoverBackground);
      }

      .log-filter-clear:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .log-filter-button:focus {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: 1px;
      }

      .log-split-view {
        display: flex;
        flex: 1;
        overflow: hidden;
      }

      .log-commit-list {
        flex: 1;
        overflow-y: auto;
        overflow-x: hidden;
        min-width: 300px;
      }

      .log-details-panel {
        width: 350px;
        border-left: 1px solid var(--vscode-panel-border);
        overflow-y: auto;
        background-color: var(--vscode-sideBar-background);
      }

      /* Commit Row Styles */
      .commit-row {
        display: flex;
        align-items: center;
        height: 24px;
        padding: 0;
        cursor: pointer;
        border-bottom: none;
        transition: background-color 0.1s ease;
      }

      .commit-row:hover {
        background-color: var(--vscode-list-hoverBackground);
      }

      .commit-row:focus {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: -1px;
      }

      .commit-row.selected {
        background-color: var(--vscode-list-activeSelectionBackground);
        color: var(--vscode-list-activeSelectionForeground);
      }

      .commit-row.expanded {
        background-color: var(--vscode-list-inactiveSelectionBackground);
      }

      /* Already-cherry-picked rows are dimmed with a ✓ badge. */
      .commit-row-cherry-picked {
        opacity: 0.6;
      }
      .commit-row-cherry-picked:hover {
        opacity: 0.85;
      }
      .commit-row-cherry-picked.selected {
        opacity: 1;
      }
      .commit-cherry-badge {
        display: inline-block;
        margin-left: 4px;
        font-size: 11px;
        color: var(--vscode-gitDecoration-addedResourceForeground, #629755);
        font-weight: bold;
        vertical-align: middle;
      }

      /* Graph Styles */
      .commit-graph {
        flex-shrink: 0;
        width: var(--graph-width, 80px);
        height: 24px;
        overflow: hidden;
        display: flex;
        align-items: center;
      }

      .commit-graph svg {
        display: block;
      }

      .commit-graph:empty,
      .commit-graph[data-width="0"] {
        display: none;
      }

      .graph-svg {
        display: block;
      }

      /* Commit Info Styles */
      .commit-info {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        display: flex;
        flex-direction: row;
        align-items: center;
        padding: 0 8px;
      }

      .commit-header {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 0;
      }

      .commit-title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
        line-height: 24px;
        flex: 1;
        min-width: 0;
        text-align: left;
      }

      /* Branch chips live in a sibling flex slot of .commit-title.
         The flex-shrink: 0 here is the IntelliJ-parity invariant: chips 
         are always reachable; the message ellipsises around them. The
         :empty rule keeps the slot from occupying the 8px right margin
         when a commit has no branches. */
      .commit-branches {
        display: flex;
        flex-shrink: 0;
        align-items: center;
        gap: 4px;
        margin-right: 8px;
      }

      .commit-branches:empty {
        display: none;
      }

      .commit-meta {
        display: flex;
        flex-direction: row;
        gap: 12px;
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        line-height: 1.2;
      }

      /* Author column: fixed-width, left-aligned. Match IntelliJ. The
         column was originally 140px which left a visible dead band
         between short names and the date column. 100px ellipsised too
         many real-world names (e.g. "Christopher" + last initial);
         120px is the IntelliJ-parity sweet spot — long names still
         ellipsise, but typical "First Last" names fit without
         truncation. */
      .commit-author {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        width: 120px;
        flex-shrink: 0;
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
        text-align: left;
        padding-left: 12px;
      }

      .commit-date {
        width: 145px;
        flex-shrink: 0;
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
        text-align: left;
        padding-left: 12px;
        white-space: nowrap;
      }

      /* Branch and Tag Labels */
      .commit-label {
        display: inline-block;
        padding: 1px 6px;
        border-radius: 3px;
        font-size: 10px;
        font-weight: 500;
        margin-right: 4px;
        flex-shrink: 0;
      }

      .branch-label {
        background-color: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
      }

      .branch-label.head-label {
        background-color: var(--vscode-gitDecoration-addedResourceForeground, #629755);
        color: white;
      }

      /* The HEAD chip is distinct from branch chips so the user reads
         "this is HEAD" at a glance even when HEAD is on a commit that ALSO
         has branch-tip chips. It lives in the same .commit-branches flex
         slot as branch chips, prepended FIRST (leftmost) so it precedes any
         branch chips. Theme variable falls back to the IntelliJ shade
         #d4a017 when --vscode-statusBarItem-warningBackground is absent
         (older themes). */
      .branch-label-head {
        display: inline-block;
        background: var(--vscode-statusBarItem-warningBackground, #d4a017);
        color: var(--vscode-statusBarItem-warningForeground, #1a1a1a);
        font-size: 11px;
        font-weight: 600;
        padding: 1px 5px;
        border-radius: 3px;
        margin-left: 4px;
        max-width: 200px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        vertical-align: middle;
      }

      /* Cap chip width with CSS ellipsis. Without a cap, a 70-char branch
         name like
         feature/JIRA-12345-very-long-descriptive-feature-name-with-context
         consumes ~350px in the non-shrinking .commit-branches slot,
         squeezing .commit-title (flex:1, min-width:0) to a few characters
         at typical panel widths. IntelliJ caps at ~200px; we match that with
         text-overflow: ellipsis. The chip's underlying text stays the full
         branch name (the data-branch-name attribute and textContent remain
         complete for screen readers + find-in-page), only visual rendering
         is clipped. vertical-align: middle is defensive — inline-block with
         default baseline alignment can shift slightly relative to message
         text on some font-metrics. */
      .branch-label-local,
      .branch-label-remote,
      .tag-label {
        display: inline-block;
        max-width: 200px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        vertical-align: middle;
      }

      /* Chip backgrounds use VS Code's badge-background / badge-foreground
         semantic tokens (guaranteed available: engines.vscode floor is
         ^1.85.0). The earlier gitDecoration-stageModifiedResourceForeground /
         gitDecoration-renamedResourceForeground tokens are FG-tier
         file-status semantics — themes that override those for the SCM tree
         would unexpectedly recolor branch chips here. The badge-* family is
         semantically correct for chip-shaped UI; local vs remote distinction
         comes from the codicon prefix (cloud vs git-branch) rather than the
         background colour. Falls back to hex literals when the theme variable
         is absent. Pinned by snap-12e. */
      .branch-label-local,
      .branch-label-remote {
        background: var(--vscode-badge-background, #2d5a1e);
        color: var(--vscode-badge-foreground, #a5d6a7);
        font-size: 11px;
        padding: 1px 5px;
        border-radius: 3px;
        margin-left: 4px;
      }

      /* Collapsed-summary chip ("+N"): rendered when a commit has more
         branches pointing at it than fit inline. Uses a muted
         description-foreground so it reads as metadata, not as another
         branch. The native title=tooltip carries the full list of
         collapsed branch names; a future click-to-expand handler can
         flip data-collapsed-branches into individual chips inline. */
      .branch-label-collapsed {
        background: var(--vscode-badge-background, #3a3a3a);
        color: var(--vscode-descriptionForeground, #888);
        font-size: 11px;
        padding: 1px 5px;
        border-radius: 3px;
        margin-left: 4px;
        cursor: help;
      }

      /* The remote-chip fallback hex pair is retained as a CSS-var
         secondary-fallback so a future theme that defines neither badge-*
         nor the gitDecoration-* family still gets a visually-readable chip.
         Themes that DO define badge-* see identical local + remote
         backgrounds — local vs remote is carried by the icon glyph, not the
         colour. The remote-only hex (#1a3a5c) is retained inline below for
         snap-12e and human grep, even though no rule consumes it directly. */
      .branch-label-remote {
        /* Fallback hex for the remote chip when neither
           --vscode-badge-background nor the legacy
           --vscode-gitDecoration-renamedResourceForeground is defined.
           The shared .branch-label-local, .branch-label-remote rule above is
           the primary; this rule only adds the #1a3a5c retention for snap-12e
           + future hi-contrast drift detection. */
        background: var(
          --vscode-badge-background,
          var(--vscode-gitDecoration-renamedResourceForeground, #1a3a5c)
        );
        color: var(
          --vscode-badge-foreground,
          var(--vscode-gitDecoration-modifiedResourceForeground, #90caf9)
        );
      }

      /* Codicon prefix sizing on chips. The icon is the non-color WCAG 1.4.1
         affordance for local vs remote vs HEAD distinction; font-size 11px
         matches chip text height so the icon does not blow up the chip
         vertically; vertical-align middle aligns the icon glyph with the chip
         text baseline; margin-right 4px separates icon from text. Pinned by
         snap-12g. */
      .branch-label-local i.codicon,
      .branch-label-remote i.codicon,
      .branch-label-head i.codicon,
      .tag-label i.codicon {
        margin-right: 4px;
        font-size: 11px;
        vertical-align: middle;
      }

      /* Focused branch chip (IntelliJ-parity outline + bold). Uses the
         theme-aware focus border so the outline reads correctly under
         high-contrast themes, falling back to currentColor when the variable
         is unavailable. font-weight 700 + underline keep the focused-branch
         affordance visible WITHOUT relying on the focus outline colour alone
         (WCAG 1.4.1 — never use colour as the sole non-text differentiator). */
      .branch-label-focused {
        outline: 1px solid var(--vscode-focusBorder, currentColor);
        outline-offset: 1px;
        font-weight: 700;
        text-decoration: underline;
      }

      /* Chip-family theme symmetry. The .branch-label-* family uses
         var(--vscode-badge-foreground, ...) for the chip text colour;
         .tag-label was the only chip still using a raw white token, which
         loses theme adherence on light and hi-contrast themes where
         badge-foreground is overridden. Match the rest of the chip family.
         snap-13f foreground assertion pins this. */
      .tag-label {
        background-color: var(--vscode-gitDecoration-modifiedResourceForeground, #6897BB);
        color: var(--vscode-badge-foreground, white);
      }

      /* Commit Details Panel */
      .commit-details {
        padding: 12px;
      }

      .commit-details-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 12px;
        padding-bottom: 8px;
        border-bottom: 1px solid var(--vscode-panel-border);
      }

      .commit-details-header h3 {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
      }

      .close-details-button {
        background: transparent;
        border: none;
        color: var(--vscode-foreground);
        font-size: 18px;
        cursor: pointer;
        padding: 0 4px;
        line-height: 1;
      }

      .close-details-button:hover {
        color: var(--vscode-errorForeground);
      }

      .commit-details-content {
        font-size: 12px;
      }

      .detail-row {
        margin-bottom: 8px;
      }

      .detail-label {
        display: block;
        font-weight: 600;
        color: var(--vscode-descriptionForeground);
        margin-bottom: 2px;
      }

      .detail-value {
        display: block;
        word-break: break-all;
      }

      .hash-value {
        font-family: var(--vscode-editor-font-family, monospace);
        cursor: pointer;
        color: var(--vscode-textLink-foreground);
      }

      .hash-value:hover {
        text-decoration: underline;
      }

      .parent-hash {
        font-family: var(--vscode-editor-font-family, monospace);
        cursor: pointer;
        color: var(--vscode-textLink-foreground);
      }

      .parent-hash:hover {
        text-decoration: underline;
      }

      .commit-full-message {
        margin: 0;
        white-space: pre-wrap;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 12px;
        background-color: var(--vscode-textBlockQuote-background);
        padding: 8px;
        border-radius: 3px;
        max-height: 150px;
        overflow-y: auto;
      }

      .message-row {
        margin-top: 12px;
      }

      /* Changed Files Section */
      .changed-files-section {
        margin-top: 16px;
        padding-top: 12px;
        border-top: 1px solid var(--vscode-panel-border);
      }

      .changed-files-section h4 {
        margin: 0 0 8px 0;
        font-size: 12px;
        font-weight: 600;
      }

      .changed-files-list {
        max-height: 200px;
        overflow-y: auto;
      }

      .changed-file-item {
        display: flex;
        align-items: center;
        padding: 3px 4px;
        cursor: pointer;
        border-radius: 3px;
      }

      .changed-file-item:hover {
        background-color: var(--vscode-list-hoverBackground);
      }

      .changed-dir-item {
        display: flex;
        align-items: center;
        padding: 3px 4px;
        font-weight: 600;
      }

      .changed-dir-item .dir-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .changed-file-status {
        width: 16px;
        font-size: 11px;
        font-weight: bold;
        margin-right: 6px;
        flex-shrink: 0;
      }

      .changed-file-path {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
      }

      .loading-message {
        color: var(--vscode-descriptionForeground);
        font-style: italic;
        padding: 8px;
      }

      /* Graph Panel Loading Indicator*/
      .graph-loading-indicator {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 12px 8px;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
        gap: 8px;
        border-top: 1px solid var(--vscode-panel-border);
      }

      .loading-spinner {
        display: inline-block;
        animation: spin 1s linear infinite;
        font-size: 16px;
      }

      .loading-text {
        font-style: italic;
      }

      @keyframes spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }

      /* Drag and Drop Visual Feedback */
      .drag-ghost {
        position: fixed;
        pointer-events: none;
        z-index: 1001;
        background-color: var(--vscode-list-activeSelectionBackground);
        color: var(--vscode-list-activeSelectionForeground);
        padding: 4px 8px;
        border-radius: 3px;
        font-size: 12px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      }

      /* Branch Panel Styles*/
      .branch-panel {
        padding: 4px 0;
        font-size: 13px;
      }

      .branch-category {
        margin-bottom: 2px;
      }

      .branch-category-header {
        display: flex;
        align-items: center;
        padding: 4px 8px;
        cursor: pointer;
        user-select: none;
        font-weight: 600;
        font-size: 11px;
        text-transform: uppercase;
        color: var(--vscode-descriptionForeground);
        letter-spacing: 0.5px;
      }

      .branch-category-header:hover {
        background-color: var(--vscode-list-hoverBackground);
      }

      .branch-category-header:focus {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: -1px;
      }

      .branch-category-children {
        padding-left: 8px;
      }

      .branch-category-name {
        margin-left: 4px;
      }

      .branch-remote-group {
        margin-left: 8px;
      }

      .branch-item {
        display: flex;
        align-items: center;
        padding: 3px 8px 3px 16px;
        cursor: pointer;
        border-radius: 3px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .branch-item:hover {
        background-color: var(--vscode-list-hoverBackground);
      }

      .branch-item:focus {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: -1px;
      }

      .branch-head-item {
        font-weight: 600;
      }

      .branch-icon {
        width: 16px;
        margin-right: 6px;
        flex-shrink: 0;
        font-size: 12px;
        text-align: center;
      }

      .branch-name {
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .branch-detached-label {
        color: var(--vscode-descriptionForeground);
        font-style: italic;
        margin-left: 6px;
        font-size: 11px;
      }

      /* Details Panel Styles */
      .details-panel {
        padding: 8px;
      }

      .details-metadata {
        font-size: 12px;
      }

      .file-status-indicator {
        width: 16px;
        font-size: 11px;
        font-weight: bold;
        margin-right: 6px;
        flex-shrink: 0;
        text-align: center;
      }

      .file-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
      }

      .file-directory {
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        margin-left: 6px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .rename-arrow {
        color: var(--vscode-descriptionForeground);
        margin: 0 4px;
      }

      .old-path {
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        text-decoration: line-through;
      }

      .no-parents {
        color: var(--vscode-descriptionForeground);
        font-style: italic;
      }

      /* Graph Panel wrapper */
      .graph-panel {
        overflow-y: auto;
        height: 100%;
      }

      /* Scroll highlight effect */
      .commit-row.highlight-scroll {
        background-color: var(--vscode-editor-findMatchHighlightBackground, rgba(255, 200, 0, 0.2));
        transition: background-color 0.3s ease;
      }
    `;
  }

  /**
   * Get inline script for the webview.
   *
   * FU — extract inline-script functions to a separate `.js` resource
   * served via `webview.asWebviewUri` when the function count crosses 5
   * non-trivial functions OR when the first inline-script-resident
   * function needs async data flow. Current count: 5
   * (`applyMenuEnableMap`, `applyRangeSelectionDom`,
   * `refreshSelectedCount`, `readInitialAnchor`, `scrollToCommit`).
   * Trigger imminent — 's per-action pre-flight checks may add
   * the sixth..
   */
  private _getInlineScript(): string {
    return `
      (function() {
        const vscode = acquireVsCodeApi();

        // Repository selector wiring. Posts the selectRepository message
        // through the single \`vscode\` instance acquired above. The
        // dropdown intentionally has no inline onchange handler — calling
        // \`acquireVsCodeApi()\` a second time in the same render throws
        // a DOMException and the message would be silently dropped.
        const repoSelect = document.querySelector('.repository-selector');
        if (repoSelect) {
          repoSelect.addEventListener('change', function(e) {
            const target = e.target;
            if (!target) return;
            const value = Number(target.value);
            if (!Number.isFinite(value)) return;
            vscode.postMessage({
              type: 'selectRepository',
              repositoryIndex: value,
            });
          });
        }

        // State for drag and drop
        let draggedFiles = [];
        let contextMenuTarget = null;

        // Multi-select webview state.
        //
        // The HOST is the source of truth for menu visibility/enable
        // state (ADR-009). The webview keeps a tiny mirror of:
        //   - anchorHash    — for immediate range-selection DOM updates
        //                     before the host's response round-trips back
        //   - menuEnableMap — most-recent updateMenuEnableState payload
        //
        // anchorHash is rehydrated from the rendered \`data-anchor-hash\`
        // attribute on script execution, and again on every
        // \`syncSelection\` message (sent by the host after updateLogState
        // prunes a stale anchor).
        let anchorHash = (function readInitialAnchor() {
          const gp = document.querySelector('.graph-panel[data-anchor-hash]');
          if (!gp) return null;
          const v = gp.getAttribute('data-anchor-hash') || '';
          return v.length > 0 ? v : null;
        })();

        // Most-recent enable map posted by the host. Populated on every
        // \`updateMenuEnableState\` message; consumed by
        // \`applyMenuEnableMap\` when the menu opens.
        let menuEnableMap = null;

        // Most-recent branch-focus payload from the host.
        // focusedBranchName toggles the branch-label-focused class on
        // chips matching data-branch-name. null means no focus.
        let branchFocus = null;

        // Reflect \`selectedCommits.size\` onto the graph-panel root's
        // \`data-selected-count\` attribute AND the multi-commit details
        // panel's data-selected-count. Cheap enough to call on
        // every selection change since the graph panel is bounded by the
        // virtualization window.
        function refreshSelectedCount() {
          const graphPanel = document.querySelector('.graph-panel[aria-multiselectable]');
          if (graphPanel) {
            const selected = graphPanel.querySelectorAll('.commit-row.selected');
            graphPanel.setAttribute('data-selected-count', String(selected.length));
            // Mirror onto the details panel root so CSS / test hooks that
            // bind to .multi-commit-details[data-selected-count] also stay
            // in sync.
            const multiDetails = document.querySelector('.multi-commit-details');
            if (multiDetails) {
              multiDetails.setAttribute('data-selected-count', String(selected.length));
            }
          }
        }

        // Apply shift-click DOM mutations: replace (or extend) the
        // \`.selected\` class on rows in the inclusive range from
        // \`anchorHash\` to \`clickHash\`, in display order. Falls back to
        // single-select when the anchor isn't in the rendered DOM
        // (virtualization edge case).
        function applyRangeSelectionDom(clickHash, additive) {
          const rows = Array.from(document.querySelectorAll('.graph-panel .commit-row[data-hash]'));
          const allHashes = rows.map(function(r) { return r.getAttribute('data-hash'); });
          const clickIdx = allHashes.indexOf(clickHash);
          if (clickIdx === -1) {
            return;
          }
          if (anchorHash === null || allHashes.indexOf(anchorHash) === -1) {
            // Anchor-null / virtualized-out fallback → behave as plain-click.
            rows.forEach(function(r) {
              r.classList.remove('selected');
              r.setAttribute('aria-selected', 'false');
            });
            const target = rows[clickIdx];
            target.classList.add('selected');
            target.setAttribute('aria-selected', 'true');
            anchorHash = clickHash;
            refreshSelectedCount();
            return;
          }
          const anchorIdx = allHashes.indexOf(anchorHash);
          const lo = Math.min(anchorIdx, clickIdx);
          const hi = Math.max(anchorIdx, clickIdx);
          if (!additive) {
            rows.forEach(function(r) {
              r.classList.remove('selected');
              r.setAttribute('aria-selected', 'false');
            });
          }
          for (let i = lo; i <= hi; i++) {
            rows[i].classList.add('selected');
            rows[i].setAttribute('aria-selected', 'true');
          }
          refreshSelectedCount();
          // Anchor unchanged — IntelliJ semantics.
        }

        // Handle state updates from extension
        window.addEventListener('message', event => {
          const message = event.data;
          if (message.type === 'scrollToCommit' && message.commitHash) {
            scrollToCommit(message.commitHash);
          }
          if (message.type === 'updateDetailsPanel' && message.html) {
            const detailsPanel = document.getElementById('details-panel');
            if (detailsPanel) {
              detailsPanel.innerHTML = message.html;
            }
          }
          if (message.type === 'selectGraphRow' && message.commitHash) {
            // Update graph row selection highlighting
            document.querySelectorAll('.commit-row.selected').forEach(function(r) {
              r.classList.remove('selected');
              r.setAttribute('aria-selected', 'false');
            });
            const targetRow = document.querySelector('.commit-row[data-hash="' + message.commitHash + '"]');
            if (targetRow) {
              targetRow.classList.add('selected');
              targetRow.setAttribute('aria-selected', 'true');
              targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            refreshSelectedCount();
          }
          // Host pushes the precomputed menu state (visibility +
          // enable per action) so the JS just stores it. The apply happens
          // when the menu opens, against the cached map. Source of truth is
          // the host; ADR-009.
          if (message.type === 'updateMenuEnableState' && message.state) {
            menuEnableMap = message.state;
            // If the menu is currently open, re-apply immediately so a
            // selection change made via keyboard / programmatic call
            // refreshes the visible items live.
            const openMenu = document.getElementById('commit-context-menu');
            if (openMenu && !openMenu.hidden) {
              applyMenuEnableMap(openMenu);
            }
          }
          // Host re-syncs the JS anchor mirror after a
          // selection or commit-list change that may have invalidated it.
          if (message.type === 'syncSelection') {
            anchorHash = typeof message.anchorHash === 'string' && message.anchorHash.length > 0
              ? message.anchorHash
              : null;
            // Reflect host-side selection onto the DOM as well.
            const wantSelected = new Set(Array.isArray(message.selectedHashes)
              ? message.selectedHashes
              : []);
            document.querySelectorAll('.graph-panel .commit-row[data-hash]').forEach(function(r) {
              const h = r.getAttribute('data-hash');
              if (h && wantSelected.has(h)) {
                r.classList.add('selected');
                r.setAttribute('aria-selected', 'true');
              } else {
                r.classList.remove('selected');
                r.setAttribute('aria-selected', 'false');
              }
            });
            refreshSelectedCount();
          }
          // Partial-update path for branch focus. The
          // render-time \`_getBranchLabelsHtml\` is the source of truth;
          // this handler exists so the chip outline lands without a full
          // DOM rebuild. Toggles \`branch-label-focused\` on every chip
          // matching \`data-branch-name\`.
          if (message.type === 'updateBranchFocus') {
            branchFocus = {
              focusedBranchName: typeof message.focusedBranchName === 'string' ? message.focusedBranchName : null,
              focusedHash: typeof message.focusedHash === 'string' ? message.focusedHash : null,
            };
            const focusedName = branchFocus.focusedBranchName;
            document.querySelectorAll('.branch-label-local[data-branch-name], .branch-label-remote[data-branch-name]').forEach(function(chip) {
              const name = chip.getAttribute('data-branch-name');
              if (focusedName !== null && name === focusedName) {
                chip.classList.add('branch-label-focused');
              } else {
                chip.classList.remove('branch-label-focused');
              }
            });
          }
        });

        function scrollToCommit(commitHash) {
          const commitRow = document.querySelector('[data-hash="' + commitHash + '"]');
          if (!commitRow) { return; }                       // Req 2.3 — not in DOM: no action

          const panel = commitRow.closest('.graph-panel');
          if (panel) {
            const rowTop = commitRow.offsetTop;
            const rowBottom = rowTop + commitRow.offsetHeight;
            const viewportTop = panel.scrollTop;
            const viewportBottom = viewportTop + panel.clientHeight;
            // Mirror of shouldScrollToRow (scrollVisibility.ts) — ephemeral UI affordance (ADR-009 §2).
            const fullyVisible = rowTop >= viewportTop && rowBottom <= viewportBottom;
            if (!fullyVisible) {
              // Off-screen: smooth-glide from the CURRENT scroll position to the target.
              commitRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          } else {
            commitRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }

          // Highlight always applies (D4) — visual confirmation regardless of scroll.
          commitRow.classList.add('highlight-scroll');
          setTimeout(function () { commitRow.classList.remove('highlight-scroll'); }, 2000);
        }

        // Auto-scroll to commit on page load when data-scroll-to-commit is set.
        // This handles the case where _updateWebview() fully replaces the DOM
        // (e.g., after a branch click), so a postMessage would arrive too late.
        (function autoScrollOnLoad() {
          const graphPanel = document.querySelector('.graph-panel[data-scroll-to-commit]');
          if (graphPanel) {
            const targetHash = graphPanel.getAttribute('data-scroll-to-commit');
            if (targetHash) {
              scrollToCommit(targetHash);
            }
          }
        })();

        // ─── Event delegation for commit rows ────────────────────────────

        // Commit row click → handleCommitClick
        document.addEventListener('click', function(e) {
          const commitRow = e.target.closest('.commit-row[data-hash]');
          if (commitRow) {
            // Don't handle if click was on a context menu or inside details panel
            if (e.target.closest('.context-menu') || e.target.closest('.details-panel')) {
              return;
            }
            const hash = commitRow.getAttribute('data-hash');
            if (hash) {
              // Selection key combos:
              //   Ctrl/Cmd        → toggle (existing) + move anchor
              //   Shift           → range-replace
              //   Shift+Ctrl/Cmd  → range-add
              //   plain           → single-select + set anchor
              if (e.shiftKey && (e.ctrlKey || e.metaKey)) {
                // Message anchor wins; the host treats the
                // JS-side anchor as authoritative for THIS click.
                vscode.postMessage({
                  type: 'addRangeSelectCommit',
                  commitHash: hash,
                  anchorHash: anchorHash,
                });
                applyRangeSelectionDom(hash, /* additive */ true);
              } else if (e.shiftKey) {
                vscode.postMessage({
                  type: 'rangeSelectCommit',
                  commitHash: hash,
                  anchorHash: anchorHash,
                });
                applyRangeSelectionDom(hash, /* additive */ false);
              } else if (e.ctrlKey || e.metaKey) {
                vscode.postMessage({ type: 'toggleCommitSelection', commitHash: hash });
                commitRow.classList.toggle('selected');
                var isNowSelected = commitRow.classList.contains('selected');
                commitRow.setAttribute('aria-selected', String(isNowSelected));
                anchorHash = hash;
                refreshSelectedCount();
              } else {
                vscode.postMessage({ type: 'selectCommit', commitHash: hash });
                document.querySelectorAll('.commit-row.selected').forEach(function(r) {
                  r.classList.remove('selected');
                  r.setAttribute('aria-selected', 'false');
                });
                commitRow.classList.add('selected');
                commitRow.setAttribute('aria-selected', 'true');
                anchorHash = hash;
                refreshSelectedCount();
              }
            }
          }
        });

        // Commit row right-click → showCommitContextMenu
        document.addEventListener('contextmenu', function(e) {
          const commitRow = e.target.closest('.commit-row[data-hash]');
          if (commitRow) {
            const hash = commitRow.getAttribute('data-hash');
            if (hash) {
              e.preventDefault();
              e.stopPropagation();
              showCommitContextMenu(e, hash);
            }
          }
        });

        // ─── Event delegation for details panel ──────────────────────────

        // Parent hash click → selectCommit
        document.addEventListener('click', function(e) {
          const parentHash = e.target.closest('.parent-hash[data-parent-hash]');
          if (parentHash) {
            const hash = parentHash.getAttribute('data-parent-hash');
            if (hash) {
              vscode.postMessage({ type: 'selectCommit', commitHash: hash });
            }
          }
        });

        // Hash value click → copy to clipboard
        document.addEventListener('click', function(e) {
          const hashValue = e.target.closest('.hash-value[data-copy-text]');
          if (hashValue) {
            const text = hashValue.getAttribute('data-copy-text');
            if (text) {
              navigator.clipboard.writeText(text).catch(function(_err) {
                // Clipboard writes can fail when the document loses focus
                // mid-call. The hash value remains visible on the chip;
                // the user can re-click to retry. Failure is intentionally
                // silent here — host-side logger isn't reachable from the
                // webview script.
              });
            }
          }
        });

        // Changed file double-click → open diff
        document.addEventListener('dblclick', function(e) {
          const fileItem = e.target.closest('.changed-file-item[data-path][data-commit-hash]');
          if (fileItem) {
            const commitHash = fileItem.getAttribute('data-commit-hash');
            const path = fileItem.getAttribute('data-path');
            if (commitHash && path) {
              vscode.postMessage({ type: 'doubleClickFile', commitHash: commitHash, path: path });
            }
          }
        });

        // Hide context menu when clicking elsewhere
        document.addEventListener('click', (e) => {
          const contextMenu = document.getElementById('context-menu');
          if (contextMenu && !contextMenu.contains(e.target)) {
            contextMenu.hidden = true;
          }
        });

        // Handle context menu item clicks
        document.addEventListener('click', (e) => {
          const menuItem = e.target.closest('.context-menu-item');
          if (menuItem && contextMenuTarget) {
            const action = menuItem.dataset.action;
            if (action) {
              vscode.postMessage({
                type: 'contextAction',
                action: action,
                files: [contextMenuTarget]
              });
              document.getElementById('context-menu').hidden = true;
            }
          }
        });

        // Global functions for onclick handlers
        window.toggleChangelist = function(changelistId) {
          vscode.postMessage({ type: 'toggleChangelist', changelistId });
        };

        window.selectFile = function(path) {
          vscode.postMessage({ type: 'selectFile', path });
        };

        window.doubleClickFile = function(path) {
          vscode.postMessage({ type: 'doubleClickFile', path });
        };

        window.clearConsole = function() {
          vscode.postMessage({ type: 'clearConsole' });
        };

        window.initRepository = function() {
          vscode.postMessage({ type: 'initRepository' });
        };

        window.refreshLocalChanges = function() {
          vscode.postMessage({ type: 'refresh' });
        };

        window.refreshLog = function() {
          vscode.postMessage({ type: 'refresh' });
        };

        // Log Filter functions
        window.toggleLogFilters = function() {
          const filterBar = document.getElementById('log-filter-bar');
          if (filterBar) {
            filterBar.hidden = !filterBar.hidden;
          }
        };

        window.applyLogFilters = function() {
          const searchInput = document.getElementById('filter-search');
          const authorInput = document.getElementById('filter-author');
          const pathInput = document.getElementById('filter-path');
          const sinceInput = document.getElementById('filter-since');
          const untilInput = document.getElementById('filter-until');

          const filter = {
            searchText: searchInput ? searchInput.value.trim() : '',
            author: authorInput ? authorInput.value.trim() : '',
            path: pathInput ? pathInput.value.trim() : '',
            since: sinceInput && sinceInput.value ? sinceInput.value : null,
            until: untilInput && untilInput.value ? untilInput.value : null
          };

          vscode.postMessage({ 
            type: 'applyLogFilter', 
            filter: filter 
          });
        };

        window.clearLogFilters = function() {
          const searchInput = document.getElementById('filter-search');
          const authorInput = document.getElementById('filter-author');
          const pathInput = document.getElementById('filter-path');
          const sinceInput = document.getElementById('filter-since');
          const untilInput = document.getElementById('filter-until');

          if (searchInput) searchInput.value = '';
          if (authorInput) authorInput.value = '';
          if (pathInput) pathInput.value = '';
          if (sinceInput) sinceInput.value = '';
          if (untilInput) untilInput.value = '';

          vscode.postMessage({ 
            type: 'applyLogFilter', 
            filter: null 
          });
        };

        window.handleFilterKeyup = function(event) {
          // Apply filters on Enter key
          if (event.key === 'Enter') {
            applyLogFilters();
          }
        };

        window.handleFilterSearchKeyup = function(event) {
          // Apply filters on Enter key for search
          if (event.key === 'Enter') {
            applyLogFilters();
          }
        };

        // Log context menu
        let logContextMenuTarget = null;

        window.showLogContextMenu = function(event, hash) {
          event.preventDefault();
          event.stopPropagation();
          
          logContextMenuTarget = hash;
          const contextMenu = document.getElementById('log-context-menu');
          if (contextMenu) {
            const x = event.clientX;
            const y = event.clientY;
            
            const menuWidth = 200;
            const menuHeight = 300;
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            
            const left = x + menuWidth > viewportWidth ? viewportWidth - menuWidth - 10 : x;
            const top = y + menuHeight > viewportHeight ? viewportHeight - menuHeight - 10 : y;
            
            contextMenu.style.left = left + 'px';
            contextMenu.style.top = top + 'px';
            contextMenu.hidden = false;
          }
        };

        // Handle log context menu item clicks
        document.addEventListener('click', (e) => {
          const logContextMenu = document.getElementById('log-context-menu');
          if (logContextMenu && !logContextMenu.contains(e.target)) {
            logContextMenu.hidden = true;
          }

          const menuItem = e.target.closest('#log-context-menu .context-menu-item');
          if (menuItem && logContextMenuTarget) {
            const action = menuItem.dataset.action;
            if (action) {
              vscode.postMessage({
                type: 'logContextAction',
                action: action,
                commitHashes: [logContextMenuTarget]
              });
              document.getElementById('log-context-menu').hidden = true;
            }
          }
        });

        // Keyboard handler for commits
        window.handleCommitKeydown = function(event, hash) {
          switch (event.key) {
            case 'Enter':
            case ' ':
              event.preventDefault();
              if (event.ctrlKey || event.metaKey) {
                vscode.postMessage({ type: 'toggleCommitSelection', commitHash: hash });
                const row = event.target.closest('.commit-row');
                if (row) {
                  row.classList.toggle('selected');
                  const isNowSelected = row.classList.contains('selected');
                  row.setAttribute('aria-selected', String(isNowSelected));
                }
                anchorHash = hash;
                refreshSelectedCount();
              } else {
                vscode.postMessage({ type: 'selectCommit', commitHash: hash });
                document.querySelectorAll('.commit-row.selected').forEach(function(r) {
                  r.classList.remove('selected');
                  r.setAttribute('aria-selected', 'false');
                });
                const row = event.target.closest('.commit-row');
                if (row) {
                  row.classList.add('selected');
                  row.setAttribute('aria-selected', 'true');
                }
                anchorHash = hash;
                refreshSelectedCount();
              }
              break;
            // Keyboard range-select.
            //
            //   ArrowUp/Down            : single-select prev/next row
            //   Shift+ArrowUp/Down      : range-replace prev/next row
            //   Ctrl+Shift+ArrowUp/Down : range-add prev/next row
            //
            // Targets are looked up by document order of commit rows;
            // the current graph isn't virtualised, so the rendered DOM
            // already reflects the host's display ordering. Focus is
            // moved to the new row so the next keypress targets it.
            case 'ArrowUp':
            case 'ArrowDown': {
              event.preventDefault();
              const rows = Array.from(document.querySelectorAll(
                '.graph-panel .commit-row[data-hash]'
              ));
              const allHashes = rows.map(function(r) { return r.getAttribute('data-hash'); });
              const curIdx = allHashes.indexOf(hash);
              if (curIdx === -1) break;
              const delta = event.key === 'ArrowDown' ? 1 : -1;
              const targetIdx = curIdx + delta;
              if (targetIdx < 0 || targetIdx >= rows.length) break;
              const targetRow = rows[targetIdx];
              const targetHash = allHashes[targetIdx];
              if (!targetHash) break;
              if (event.shiftKey && (event.ctrlKey || event.metaKey)) {
                // Message anchor wins.
                vscode.postMessage({
                  type: 'addRangeSelectCommit',
                  commitHash: targetHash,
                  anchorHash: anchorHash,
                });
                applyRangeSelectionDom(targetHash, /* additive */ true);
              } else if (event.shiftKey) {
                vscode.postMessage({
                  type: 'rangeSelectCommit',
                  commitHash: targetHash,
                  anchorHash: anchorHash,
                });
                applyRangeSelectionDom(targetHash, /* additive */ false);
              } else {
                vscode.postMessage({ type: 'selectCommit', commitHash: targetHash });
                document.querySelectorAll('.commit-row.selected').forEach(function(r) {
                  r.classList.remove('selected');
                  r.setAttribute('aria-selected', 'false');
                });
                targetRow.classList.add('selected');
                targetRow.setAttribute('aria-selected', 'true');
                anchorHash = targetHash;
                refreshSelectedCount();
              }
              // Move keyboard focus + scroll into view so the user
              // visually tracks the selection even on a virtualised list.
              if (targetRow.focus) {
                targetRow.focus();
              }
              if (targetRow.scrollIntoView) {
                targetRow.scrollIntoView({ block: 'nearest' });
              }
              break;
            }
            case 'ContextMenu':
              event.preventDefault();
              showLogContextMenu(event, hash);
              break;
            case 'c':
              if (event.ctrlKey || event.metaKey) {
                event.preventDefault();
                copyToClipboard(hash);
              }
              break;
          }
        };

        // Commit context menu for Graph Panel
        let commitContextMenuHashes = [];

        window.showCommitContextMenu = function(event, hash) {
          event.preventDefault();
          event.stopPropagation();

          // Determine if the right-clicked commit is part of a multi-select
          const selectedRows = document.querySelectorAll('.graph-panel .commit-row.selected');
          const selectedHashes = Array.from(selectedRows).map(function(row) {
            return row.getAttribute('data-hash');
          });

          // Right-click on a non-selected commit moves the
          // selection to ONLY that commit. Mirrors IntelliJ — the action
          // can never silently target a different set than the user sees
          // highlighted. The host gets the same news via
          // selectIfNotSelected so the host-side state stays in sync and
          // the next updateMenuEnableState reflects the move.
          if (selectedHashes.indexOf(hash) === -1) {
            document.querySelectorAll('.commit-row.selected').forEach(function(r) {
              r.classList.remove('selected');
              r.setAttribute('aria-selected', 'false');
            });
            const target = document.querySelector('.commit-row[data-hash="' + hash + '"]');
            if (target) {
              target.classList.add('selected');
              target.setAttribute('aria-selected', 'true');
            }
            anchorHash = hash;
            refreshSelectedCount();
            vscode.postMessage({ type: 'selectIfNotSelected', commitHash: hash });
            commitContextMenuHashes = [hash];
          } else if (selectedHashes.length > 1) {
            // Multi-select right-click on a member: target the whole set.
            commitContextMenuHashes = selectedHashes;
          } else {
            commitContextMenuHashes = [hash];
          }

          const contextMenu = document.getElementById('commit-context-menu');
          if (contextMenu) {
            const x = event.clientX;
            const y = event.clientY;

            const menuWidth = 220;
            const menuHeight = 400;
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;

            const left = x + menuWidth > viewportWidth ? viewportWidth - menuWidth - 10 : x;
            const top = y + menuHeight > viewportHeight ? viewportHeight - menuHeight - 10 : y;

            contextMenu.style.left = left + 'px';
            contextMenu.style.top = top + 'px';

            applyMenuEnableMap(contextMenu);

            contextMenu.hidden = false;
          }
        };

        // Apply-loop for the host-precomputed menu state.
        //
        // ADR-009: the host computes visibility + enabled per action via
        // \`multiSelect.ts:computeMenuState\` and posts the map as
        // \`updateMenuEnableState\`. The JS does NOT mirror the rules —
        // it just toggles classes per the cached \`menuEnableMap\`. If the
        // map is missing (extremely early page load, before the first
        // host post arrives), we fall back to "enable everything" so the
        // menu remains usable; the host's validation rejects any
        // stale invocation downstream so nothing destructive can slip
        // through that window.
        function applyMenuEnableMap(contextMenu) {
          const map = menuEnableMap;
          const items = contextMenu.querySelectorAll('.context-menu-item');
          items.forEach(function(item) {
            const action = item.getAttribute('data-action');
            const entry = map ? map[action] : null;
            const visible = entry ? entry.visible : true;
            const enabled = entry ? entry.enabled : true;
            if (visible) {
              item.classList.remove('menu-multi-hidden');
            } else {
              item.classList.add('menu-multi-hidden');
            }
            if (enabled) {
              item.classList.remove('disabled');
            } else {
              item.classList.add('disabled');
            }
            // Surface entry.reason as a title= tooltip on visible-disabled
            // rows. Defense-in-depth typeof check keeps a malformed payload
            // from rendering "[object Object]" or "undefined" into the
            // user's tooltip.
            //
            // INVARIANT (with multiSelect.ts:computeMenuState): the host
            // sets reason ONLY when visible && !enabled. This gate
            // mirrors that on the wire side. If a future host bug sets
            // reason on a hidden row, the title write would silently
            // emit on a .menu-multi-hidden element — invisible to the
            // user, but a sign that the host invariant has drifted.
            const titleAttr =
              entry && !entry.enabled && typeof entry.reason === 'string'
                ? entry.reason
                : '';
            if (titleAttr) {
              item.setAttribute('title', titleAttr);
            } else {
              item.removeAttribute('title');
            }
          });
        }

        // Handle commit context menu item clicks
        document.addEventListener('click', (e) => {
          const commitContextMenu = document.getElementById('commit-context-menu');
          if (commitContextMenu && !commitContextMenu.contains(e.target)) {
            commitContextMenu.hidden = true;
          }

          const menuItem = e.target.closest('#commit-context-menu .context-menu-item');
          if (menuItem && commitContextMenuHashes.length > 0) {
            if (menuItem.classList.contains('disabled')) return;
            const action = menuItem.dataset.action;
            if (action) {
              vscode.postMessage({
                type: 'commitContextMenu',
                action: action,
                commitHashes: commitContextMenuHashes
              });
              document.getElementById('commit-context-menu').hidden = true;
            }
          }
        });

        // Hide commit context menu on Escape key
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
            const commitContextMenu = document.getElementById('commit-context-menu');
            if (commitContextMenu) commitContextMenu.hidden = true;
          }
        });

        // Delegate keyboard handling to focused commit
        // rows so the arrow-key range-select works without per-row
        // \`onkeydown\` attributes (which would inflate the rendered HTML).
        document.addEventListener('keydown', function(e) {
          const focused = e.target && e.target.closest
            ? e.target.closest('.commit-row[data-hash]')
            : null;
          if (!focused) return;
          const hash = focused.getAttribute('data-hash');
          if (!hash) return;
          // Only intercept the keys the handler cares about — leave
          // everything else (Tab, Esc, plain typing) untouched.
          const handled = (
            e.key === 'Enter' || e.key === ' ' ||
            e.key === 'ArrowUp' || e.key === 'ArrowDown' ||
            e.key === 'ContextMenu' ||
            (e.key === 'c' && (e.ctrlKey || e.metaKey))
          );
          if (handled) {
            window.handleCommitKeydown(e, hash);
          }
        });

        // Context menu functions
        window.showContextMenu = function(event, path) {
          event.preventDefault();
          event.stopPropagation();
          
          contextMenuTarget = path;
          const contextMenu = document.getElementById('context-menu');
          if (contextMenu) {
            // Position the menu at the cursor
            const x = event.clientX;
            const y = event.clientY;
            
            // Ensure menu stays within viewport
            const menuWidth = 180;
            const menuHeight = 280;
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            
            const left = x + menuWidth > viewportWidth ? viewportWidth - menuWidth - 10 : x;
            const top = y + menuHeight > viewportHeight ? viewportHeight - menuHeight - 10 : y;
            
            contextMenu.style.left = left + 'px';
            contextMenu.style.top = top + 'px';
            contextMenu.hidden = false;
          }
        };

        // Drag and drop functions
        window.handleDragStart = function(event, path) {
          draggedFiles = [path];
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', path);
          event.target.classList.add('dragging');
          
          // Create custom drag image
          const dragGhost = document.createElement('div');
          dragGhost.className = 'drag-ghost';
          dragGhost.textContent = path.split('/').pop();
          document.body.appendChild(dragGhost);
          event.dataTransfer.setDragImage(dragGhost, 0, 0);
          
          // Remove ghost after drag starts
          setTimeout(() => {
            document.body.removeChild(dragGhost);
          }, 0);
        };

        window.handleDragEnd = function(event) {
          event.target.classList.remove('dragging');
          draggedFiles = [];
          
          // Remove drag-over class from all changelists
          document.querySelectorAll('.changelist').forEach(cl => {
            cl.classList.remove('drag-over');
          });
        };

        window.handleDragOver = function(event) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          
          const changelist = event.target.closest('.changelist');
          if (changelist) {
            changelist.classList.add('drag-over');
          }
        };

        window.handleDragLeave = function(event) {
          const changelist = event.target.closest('.changelist');
          if (changelist && !changelist.contains(event.relatedTarget)) {
            changelist.classList.remove('drag-over');
          }
        };

        window.handleDrop = function(event, targetChangelistId) {
          event.preventDefault();
          
          const changelist = event.target.closest('.changelist');
          if (changelist) {
            changelist.classList.remove('drag-over');
          }
          
          if (draggedFiles.length > 0) {
            vscode.postMessage({
              type: 'fileDrop',
              files: draggedFiles,
              targetChangelistId: targetChangelistId
            });
          }
          
          draggedFiles = [];
        };

        // Keyboard handlers
        window.handleChangelistKeydown = function(event, changelistId) {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggleChangelist(changelistId);
          }
        };

        window.handleFileKeydown = function(event, path) {
          switch (event.key) {
            case 'Enter':
              event.preventDefault();
              doubleClickFile(path);
              break;
            case ' ':
              event.preventDefault();
              selectFile(path);
              break;
            case 'ContextMenu':
              event.preventDefault();
              showContextMenu(event, path);
              break;
          }
        };

        // Incremental commit loading
        // Monitor the graph panel scroll position and request more commits
        // when the user scrolls within 50px of the bottom.
        let loadMoreCommitsRequested = false;

        function setupGraphPanelScrollListener() {
          const graphPanel = document.querySelector('.graph-panel');
          if (!graphPanel) return;

          graphPanel.addEventListener('scroll', function() {
            if (loadMoreCommitsRequested) return;

            const scrollTop = graphPanel.scrollTop;
            const scrollHeight = graphPanel.scrollHeight;
            const clientHeight = graphPanel.clientHeight;
            const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

            // Check if we have more commits to load
            const loadedCount = parseInt(graphPanel.getAttribute('data-loaded-count') || '0', 10);
            const totalAvailable = parseInt(graphPanel.getAttribute('data-total-available') || '0', 10);
            const hasMore = loadedCount < totalAvailable;

            if (hasMore && distanceFromBottom <= 50) {
              loadMoreCommitsRequested = true;
              vscode.postMessage({ type: 'loadMoreCommits' });
            }
          });
        }

        // Reset the loadMoreCommitsRequested flag when new content is loaded
        window.addEventListener('message', function(event) {
          const message = event.data;
          if (message.type === 'commitsLoaded') {
            loadMoreCommitsRequested = false;
          }
        });

        // Set up the scroll listener on initial load
        setupGraphPanelScrollListener();

        // Also observe DOM changes to re-attach the scroll listener if the graph panel is re-rendered
        const observer = new MutationObserver(function() {
          setupGraphPanelScrollListener();
          loadMoreCommitsRequested = false;
        });
        observer.observe(document.body, { childList: true, subtree: true });
      })();
    `;
  }

  /**
   * Escape HTML special characters
   */
  private _escapeHtml(text: string): string {
    const htmlEscapes: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return text.replace(/[&<>"']/g, (char) => htmlEscapes[char]);
  }

  /**
   * FU-1 — check whether the `intellig.commitMessageIssueLinks` feature
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
   * FU-1 — parse and cache the first remote URL for the currently selected
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
}

/**
 * Log filter from webview (with string dates)
 */
interface IWebviewLogFilter {
  searchText?: string;
  author?: string;
  path?: string;
  since?: string | null;
  until?: string | null;
}

/**
 * Message types from the webview.
 *
 * T1-05 added the optional `tab` field for per-tab routing. Legacy
 * messages (selectCommit, panelResize, applyLogFilter, etc.) omit `tab`
 * and are treated as implicit `tab: 'log'` by {@link TabRouter}.
 */
/**
 * Typed envelopes for the four new wire types.
 * Included as a separate union (rather than a refactor of the legacy
 * flat `IWebviewMessage` shape) to keep the scope tight: can
 * extend the union as their messages land.
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
// `WebviewInboundMessage`. Sub-unions are fine for the wave-by-wave
// development we're in; long-term this is one type so the
// `_handleWebviewMessage` switch is exhaustively-checkable.
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
  /** Optional tab discriminator for T1-05 routing (design §3.4). */
  tab?: TabId;
}

// Nonce generation is owned by `BaseWebviewView._getNonce()`, which
// delegates to the shared `generateNonce()` helper in `utils/webviewNonce.ts`
// so every IntelliG webview produces nonces with identical shape + entropy.
// All three HTML emitters in this file call `this._getNonce()` directly;
// the former module-local `getNonce()` has been removed.
