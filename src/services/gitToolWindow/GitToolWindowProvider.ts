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
} from '../interfaces';
import { FileStatus, ICommit, IGitService, IRepository } from '../interfaces/IGitService';
import { ICommitNode, generateCommitGraph, classifyBranchName, computeTerminalNodes, computeChildCountMap, isBranchSplit, computeChildLanesMap } from '../../utils/commitGraph';
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
import { createLogTabHandler } from './tabs/LogTab';
import { createConsoleTabHandler } from './tabs/ConsoleTab';
import { createIncomingTabHandler } from './tabs/IncomingTab';
import { createUpdateInfoTabHandler } from './tabs/UpdateInfoTab';
import { HistoryTab } from './tabs/HistoryTab';
import { parseRemoteUrl, type IRemoteUrl } from '../../utils/remoteUrl';
import { renderCommitMessageHtml } from '../../utils/commitMessageHtml';
import { BaseWebviewView } from '../../utils/BaseWebviewView';

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
 * Context menu action types for Log View
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
  | 'interactiveRebase';

/**
 * Extended Log state with commit nodes for graph visualization
 */
export interface IExtendedLogState extends ILogState {
  commitNodes: ICommitNode[];
  branchMap: Map<string, string[]>;
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
}

/**
 * Git Tool Window Provider implementation.
 */
export class GitToolWindowProvider extends BaseWebviewView implements IGitToolWindowProvider {
  private _extendedLogState: IExtendedLogState;
  private _panelWidths: [number, number];
  private readonly _workspaceState: vscode.Memento | undefined;
  private _hasRepository: boolean = false;
  private _isLoading: boolean = true;
  private _scrollToCommitHash: string | undefined;
  private _pendingChangedFiles: IChangedFile[] | undefined;
  private _pendingChangedFilesError: unknown | undefined;
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
   * Phase 1 responsibilities:
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

  constructor(
    extensionUri: vscode.Uri,
    workspaceState?: vscode.Memento
  ) {
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
  }

  /**
   * T2-07 — load a file's history into the History tab and reveal it.
   *
   * Called by the `intellig.showHistory` command when the tabbed layout flag
   * is on. Falls back silently when no GitService has been attached yet.
   */
  public async loadFileHistory(filePath: string, branch?: string): Promise<void> {
    if (!this._historyTab) return;
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
      branchMap: new Map<string, string[]>(),
      tagMap: new Map<string, string[]>(),
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
    branchMap?: Map<string, string[]>,
    tagMap?: Map<string, string[]>
  ): void {
    // Generate commit graph nodes
    const commitNodes = generateCommitGraph(commits, branchMap, tagMap);

    const emptyBranchMap: Map<string, string[]> = new Map();
    const emptyTagMap: Map<string, string[]> = new Map();

    this._extendedLogState = {
      ...this._extendedLogState,
      commitNodes,
      branchMap: branchMap || emptyBranchMap,
      tagMap: tagMap || emptyTagMap,
    };

    this._hasRepository = true;
    this._isLoading = false;
    this._updateWebview();
    this._onDidChangeState.fire();
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
    if (!hash) return false;
    const loadedCommits = this._extendedLogState.commitNodes;
    const matched = loadedCommits.some((n) => n.commit.hash === hash);
    if (!matched) return false;

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

    this._onDidSelectCommit.fire(hash);
    this._onDidChangeState.fire();

    // Send a partial update to the details panel via postMessage
    // instead of a full _updateWebview() to preserve graph scroll position.
    // Also update the graph row selection highlighting and scroll to the commit.
    if (this._view) {
      // Update graph row selection
      void this._view.webview.postMessage({
        type: 'selectGraphRow',
        commitHash: hash,
      });

      const node = this._extendedLogState.commitNodes.find(n => n.commit.hash === hash);
      if (node) {
        const commitDetails: ICommitDetails = {
          hash: node.commit.hash,
          message: node.commit.message,
          body: node.commit.body,
          author: { name: node.commit.author.name, email: node.commit.author.email },
          date: node.commit.authorDate,
          parents: node.commit.parents || [],
          branches: node.branches || [],
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
      const node = this._extendedLogState.commitNodes.find(n => n.commit.hash === hash);
      if (node) {
        const commitDetails: ICommitDetails = {
          hash: node.commit.hash,
          message: node.commit.message,
          body: node.commit.body,
          author: { name: node.commit.author.name, email: node.commit.author.email },
          date: node.commit.authorDate,
          parents: node.commit.parents || [],
          branches: node.branches || [],
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

    this._onDidChangeState.fire();
    this._updateWebview();
  }

  /**
   * Get selected commit hashes
   */
  public getSelectedCommits(): string[] {
    return Array.from(this._extendedLogState.selectedCommits);
  }

  // Disposal is owned by `BaseWebviewView.dispose()` — drains `_disposables`,
  // marks disposed, and clears `_view`. No subclass-specific teardown is
  // needed here; the event emitters are already registered with
  // `_disposables` in the constructor.

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
      default:
        console.warn('Unknown webview message type:', message);
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
   * Handle branch click to scroll the Graph Panel to the branch's HEAD commit.
   * Finds the branch's HEAD commit hash from the loaded commit nodes and branch map,
   * then selects that commit to scroll to it in the graph.
   *
   * and highlights the latest commit of that branch.
   */
  private _handleBranchClick(branchName: string): void {
    // Look up the commit hash for this branch from the branch map
    const branchMap = this._extendedLogState.branchMap;
    let targetCommitHash: string | undefined;

    // The branchMap maps commit hash -> branch names[]
    // We need to find the commit hash that has this branch name
    for (const [commitHash, branches] of branchMap.entries()) {
      if (branches.includes(branchName)) {
        targetCommitHash = commitHash;
        break;
      }
    }

    // If not found in branchMap, search through commit nodes for a matching branch reference
    if (!targetCommitHash) {
      for (const node of this._extendedLogState.commitNodes) {
        if (node.branches && node.branches.includes(branchName)) {
          targetCommitHash = node.commit.hash;
          break;
        }
      }
    }

    if (targetCommitHash) {
      // Store the scroll target so the re-rendered HTML will include it.
      // We need a full re-render for branch clicks to embed the scroll target
      // in the HTML via data-scroll-to-commit, since the inline script
      // auto-scrolls on page load.
      this._scrollToCommitHash = targetCommitHash;

      // Select the commit (updates state + sends details panel via postMessage)
      this.selectCommit(targetCommitHash);

      // Force a full re-render to embed the scroll-to-commit target in the HTML
      this._updateWebview();
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
      console.warn(
        `Repository index ${index} out of bounds (0-${this._availableRepositories.length - 1}). Clamping to valid range.`
      );
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
    this._onDidRequestLogContextAction.fire({
      action,
      commitHashes,
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
      const node = commitNodes.find(n => n.commit.hash === expandedCommit);
      if (node) {
        commitDetails = {
          hash: node.commit.hash,
          message: node.commit.message,
          body: node.commit.body,
          author: { name: node.commit.author.name, email: node.commit.author.email },
          date: node.commit.authorDate,
          parents: node.commit.parents || [],
          branches: node.branches || [],
          tags: node.tags || [],
          changedFiles: this._pendingChangedFiles && this._extendedLogState.expandedCommit === node.commit.hash
            ? this._pendingChangedFiles
            : [],
          changedFilesError: this._pendingChangedFilesError && this._extendedLogState.expandedCommit === node.commit.hash
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
            (historyActive ? `<script nonce="${nonce}">${historyTabBehaviorScript()}</script>` : ''),
          nonce,
        })
      : logBody;

    const extraStyles = flagOn ? `${tabStripStyles()}\n${historyTabStyles()}` : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
  <title>Git Tool Window</title>
  <style>
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
   * Get IntelliJ-style color for file status
   */
  private _getFileStatusColor(status: FileStatus): string {
    return INTELLIJ_FILE_STATUS_COLORS[status] || '#FFFFFF';
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
   * Get directory part of path
   */
  private _getFileDir(path: string): string {
    const parts = path.split('/');
    if (parts.length <= 1) {
      return '';
    }
    parts.pop();
    return parts.join('/');
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
        <div class="graph-panel" role="listbox" aria-label="Commit Graph">
          <p class="empty-message">No commits found</p>
        </div>`;
    }

    // Compute active lanes for the entire commit list
    const activeLaneMap = computeActiveLanes(commitNodes);

    // Compute terminal nodes and child count map for icon rendering
    const terminalNodes = computeTerminalNodes(commitNodes);
    const childCountMap = computeChildCountMap(commitNodes);
    const childLanesMap = computeChildLanesMap(commitNodes);

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
        const graphSvg = renderGraphSvg(node, index, activeLanes, DEFAULT_GRAPH_CONFIG, isTerminal, isSplitPoint, childLanes);

        // Format fields
        const messageSummary = this._escapeHtml(this._truncateMessage(commit.message, 60));
        const fullMessage = this._escapeHtml(commit.message);
        const authorName = this._escapeHtml(commit.author.name);
        const authorEmail = this._escapeHtml(commit.author.email);
        const absoluteDate = this._formatAbsoluteDate(commit.authorDate);
        const fullDate = commit.authorDate.toLocaleString();

        // Generate branch labels HTML
        const branchLabelsHtml = this._getBranchLabelsHtml(node);

        // T3-07 — `✓` badge + title tooltip for already-cherry-picked commits.
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
             data-hash="${commit.hash}"
             role="option"
             tabindex="0"
             aria-selected="${isSelected}">
          <div class="commit-graph">
            ${graphSvg}${cherryBadgeHtml}
          </div>
          <div class="commit-info">
            <div class="commit-title" title="${fullMessage}">${messageSummary}${branchLabelsHtml}</div>
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

    return `
      <div class="graph-panel" role="listbox" aria-label="Commit Graph" data-loaded-count="${loaded}" data-total-available="${total}"${scrollAttr}>
        ${repositorySelectorHtml}
        ${rowsHtml}
        ${loadingIndicatorHtml}
      </div>`;
  }

  /**
   * Get the branch labels HTML for a commit node.
   * Renders `<span>` elements for each branch name on the commit node.
   * Applies `branch-label-local` or `branch-label-remote` CSS class based on
   * the classification from `classifyBranchName`.
   * Branch names are escaped for HTML safety.
   *
   * @param node - The commit node to render branch labels for
   * @returns HTML string with branch label spans, or empty string if no branches
   */
  public _getBranchLabelsHtml(node: ICommitNode): string {
    if (!node.branches || node.branches.length === 0) {
      return '';
    }

    const labels = node.branches.map((branchName) => {
      const classification = classifyBranchName(branchName);
      const cssClass = classification === 'remote' ? 'branch-label-remote' : 'branch-label-local';
      const escapedName = this._escapeHtml(branchName);
      return `<span class="${cssClass}">${escapedName}</span>`;
    });

    return labels.join('');
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

    return `
      <div class="repository-selector-container">
        <select class="repository-selector" onchange="(function(el){ const vscode = acquireVsCodeApi(); vscode.postMessage({ type: 'selectRepository', repositoryIndex: Number(el.value) }); })(this)">
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
    const headHash = this._extendedLogState.commitNodes.length > 0
      ? this._extendedLogState.commitNodes[0].commit.hash
      : '';

    return `
      <div id="commit-context-menu" class="commit-context-menu context-menu" hidden role="menu" aria-label="Commit actions" data-head-hash="${headHash}">
        <div class="context-menu-item" data-action="copyHash" role="menuitem" tabindex="0">Copy Revision Number</div>
        <div class="context-menu-item" data-action="createPatch" role="menuitem" tabindex="0">Create Patch\u2026</div>
        <div class="context-menu-item" data-action="cherryPick" role="menuitem" tabindex="0">Cherry-Pick</div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" data-action="checkoutRevision" role="menuitem" tabindex="0">Checkout Revision</div>
        <div class="context-menu-item" data-action="showRepoAtRevision" role="menuitem" tabindex="0">Show Repository at Revision</div>
        <div class="context-menu-item" data-action="compareWithLocal" role="menuitem" tabindex="0">Compare with Local</div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" data-action="editCommitMessage" role="menuitem" tabindex="0">Edit Commit Message</div>
        <div class="context-menu-item context-menu-danger" data-action="resetToHere" role="menuitem" tabindex="0">Reset Current Branch to Here\u2026</div>
        <div class="context-menu-item" data-action="revert" role="menuitem" tabindex="0">Revert Commit</div>
        <div class="context-menu-item" data-action="undoCommit" role="menuitem" tabindex="0">Undo Commit</div>
        <div class="context-menu-item context-menu-danger" data-action="dropCommit" role="menuitem" tabindex="0">Drop Commit</div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" data-action="mergeIntoCurrent" role="menuitem" tabindex="0">Merge into Current Branch</div>
        <div class="context-menu-item" data-action="interactiveRebase" role="menuitem" tabindex="0">Interactively Rebase from Here\u2026</div>
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
    const parentsHtml = commitDetails.parents.length > 0
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
      changedFilesHtml = commitDetails.changedFiles
        .map((file) => {
          const statusColor = this._getFileStatusColor(file.status);
          const statusChar = this._getFileStatusChar(file.status);
          const fileName = this._getFileName(file.path);
          const fileDir = this._getFileDir(file.path);
          const fileDirDisplay = fileDir ? fileDir : '';

          // For renames, show the old path as well
          const renameInfo =
            file.status === 'renamed' && file.oldPath
              ? ` <span class="rename-arrow">←</span> <span class="old-path" title="${this._escapeHtml(file.oldPath)}">${this._escapeHtml(file.oldPath)}</span>`
              : '';

          return `
          <div class="changed-file-item"
               data-path="${this._escapeHtml(file.path)}"
               data-status="${file.status}"
               data-commit-hash="${this._escapeHtml(commitDetails.hash)}"
               role="listitem"
               tabindex="0">
            <span class="file-status-indicator" style="color: ${statusColor};" title="${file.status}">
              ${statusChar}
            </span>
            <span class="file-name" style="color: ${statusColor};">
              ${this._escapeHtml(fileName)}
            </span>
            <span class="file-directory" title="${this._escapeHtml(file.path)}">
              ${this._escapeHtml(fileDirDisplay)}
            </span>
            ${renameInfo}
          </div>`;
        })
        .join('');
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
      changedFilesHtml = mergedFiles
        .map((file) => {
          const statusColor = this._getFileStatusColor(file.status);
          const statusChar = this._getFileStatusChar(file.status);
          const fileName = this._getFileName(file.path);
          const fileDir = this._getFileDir(file.path);
          const fileDirDisplay = fileDir ? fileDir : '';

          // For renames, show the old path as well
          const renameInfo =
            file.status === 'renamed' && file.oldPath
              ? ` <span class="rename-arrow">←</span> <span class="old-path" title="${this._escapeHtml(file.oldPath)}">${this._escapeHtml(file.oldPath)}</span>`
              : '';

          return `
          <div class="changed-file-item"
               data-path="${this._escapeHtml(file.path)}"
               data-status="${file.status}"
               role="listitem"
               tabindex="0">
            <span class="file-status-indicator" style="color: ${statusColor};" title="${file.status}">
              ${statusChar}
            </span>
            <span class="file-name" style="color: ${statusColor};">
              ${this._escapeHtml(fileName)}
            </span>
            <span class="file-directory" title="${this._escapeHtml(file.path)}">
              ${this._escapeHtml(fileDirDisplay)}
            </span>
            ${renameInfo}
          </div>`;
        })
        .join('');
    }

    return `
      <div class="details-panel multi-commit-details" role="region" aria-label="Multi-Commit Details">
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

      /* T3-07 — already-cherry-picked rows are dimmed with a ✓ badge. */
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

      .commit-meta {
        display: flex;
        flex-direction: row;
        gap: 12px;
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        line-height: 1.2;
      }

      .commit-author {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        width: 140px;
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

      .branch-label-local {
        background: #2d5a1e;
        color: #a5d6a7;
        font-size: 11px;
        padding: 1px 5px;
        border-radius: 3px;
        margin-left: 4px;
      }

      .branch-label-remote {
        background: #1a3a5c;
        color: #90caf9;
        font-size: 11px;
        padding: 1px 5px;
        border-radius: 3px;
        margin-left: 4px;
      }

      .tag-label {
        background-color: var(--vscode-gitDecoration-modifiedResourceForeground, #6897BB);
        color: white;
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
   * Get inline script for the webview
   */
  private _getInlineScript(): string {
    return `
      (function() {
        const vscode = acquireVsCodeApi();
        
        // State for drag and drop
        let draggedFiles = [];
        let contextMenuTarget = null;

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
          }
        });

        function scrollToCommit(commitHash) {
          const commitRow = document.querySelector('[data-hash="' + commitHash + '"]');
          if (commitRow) {
            commitRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
            // Add a brief highlight effect
            commitRow.classList.add('highlight-scroll');
            setTimeout(function() {
              commitRow.classList.remove('highlight-scroll');
            }, 2000);
          }
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
              if (e.ctrlKey || e.metaKey) {
                // Ctrl/Cmd+click: toggle multi-select
                vscode.postMessage({ type: 'toggleCommitSelection', commitHash: hash });
                commitRow.classList.toggle('selected');
                var isNowSelected = commitRow.classList.contains('selected');
                commitRow.setAttribute('aria-selected', String(isNowSelected));
              } else {
                // Plain click: single select
                vscode.postMessage({ type: 'selectCommit', commitHash: hash });
                document.querySelectorAll('.commit-row.selected').forEach(function(r) {
                  r.classList.remove('selected');
                  r.setAttribute('aria-selected', 'false');
                });
                commitRow.classList.add('selected');
                commitRow.setAttribute('aria-selected', 'true');
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
              navigator.clipboard.writeText(text).catch(function(err) {
                console.error('Failed to copy:', err);
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
                toggleCommitSelection(hash);
                const row = event.target.closest('.commit-row');
                if (row) {
                  row.classList.toggle('selected');
                  const isNowSelected = row.classList.contains('selected');
                  row.setAttribute('aria-selected', String(isNowSelected));
                }
              } else {
                selectCommit(hash);
                document.querySelectorAll('.commit-row.selected').forEach(function(r) {
                  r.classList.remove('selected');
                  r.setAttribute('aria-selected', 'false');
                });
                const row = event.target.closest('.commit-row');
                if (row) {
                  row.classList.add('selected');
                  row.setAttribute('aria-selected', 'true');
                }
              }
              break;
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

          // If the right-clicked commit is part of the current multi-select,
          // apply the action to all selected commits
          if (selectedHashes.length > 1 && selectedHashes.indexOf(hash) !== -1) {
            commitContextMenuHashes = selectedHashes;
          } else {
            // Single commit or right-clicked a non-selected commit
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

            const undoItem = contextMenu.querySelector('[data-action="undoCommit"]');
            const editMsgItem = contextMenu.querySelector('[data-action="editCommitMessage"]');
            const dropItem = contextMenu.querySelector('[data-action="dropCommit"]');
            const headHash = contextMenu.getAttribute('data-head-hash') || '';
            const isSingleCommit = commitContextMenuHashes.length === 1;
            const isHeadCommit = isSingleCommit && commitContextMenuHashes[0] === headHash;

            if (undoItem) {
              if (isHeadCommit) {
                undoItem.classList.remove('disabled');
              } else {
                undoItem.classList.add('disabled');
              }
            }

            if (editMsgItem) {
              editMsgItem.classList.add('disabled');
            }

            if (dropItem) {
              if (isSingleCommit) {
                dropItem.classList.remove('disabled');
              } else {
                dropItem.classList.add('disabled');
              }
            }

            contextMenu.hidden = false;
          }
        };

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
    if (!repo) return undefined;
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
  branchName?: string;
  branchType?: 'local' | 'remote';
  widths?: [number, number];
  repositoryIndex?: number;
  /** Optional tab discriminator for T1-05 routing (design §3.4). */
  tab?: TabId;
}

// Nonce generation is owned by `BaseWebviewView._getNonce()` (TL-16), which
// delegates to the shared `generateNonce()` helper in `utils/webviewNonce.ts`
// so every IntelliG webview produces nonces with identical shape + entropy
// (SR-6, TL-12). All three HTML emitters in this file call `this._getNonce()`
// directly; the former module-local `getNonce()` has been removed.
