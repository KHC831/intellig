/**
 * Git Tool Window Provider implementation.
 * Provides the main Git tool window with a 2-panel layout (Graph Panel, Details Panel).
 * Implements VS Code's WebviewViewProvider interface.
 */

import * as vscode from 'vscode';
import { readConfig } from '../../config/configKeys';
import {
  IGitToolWindowProvider,
  ILogState,
  IConsoleEntry,
  ILogFilter,
  ICommitDetails,
  IChangedFile,
} from '../../services/interfaces';
import { FileStatus, ICommit, IGitService, IRepository } from '../interfaces/IGitService';
import { ICommitNode, IBranchRef } from '../commitGraph';
import { fingerprintLogState } from './provider/logStateFingerprint';
import { sanitizeWebviewLogFilter } from './provider/logFilterSanitizer';
import { groupBranchFilterOptions } from './provider/loadedGraphQueries';
import { loadLogFilter, saveLogFilter } from '../../utils/logFilterStorage';
import {
  savePanelWidths,
  loadPanelWidths,
  DEFAULT_PANEL_WIDTHS,
  clampPanelWidthRatios,
} from '../../utils/panelLayout';
import {
  saveColumnWidths,
  loadColumnWidths,
  clampColumnWidths,
  DEFAULT_COLUMN_WIDTHS,
} from '../../utils/columnLayout';
import { TabRouter, type TabId } from './tabRouter';
import type {
  IWebviewMessage,
  IWebviewLogFilter,
  IBranchFilterGroups,
} from './gitToolWindow.wireTypes';
import { isTabbedGitToolWindowEnabled } from './config';
import { tabStripStyles, wrapTabbedBody } from './html/commonHtml';
import { renderConsoleTabBody, consoleTabStyles } from './html/consoleHtml';
import { renderIncomingTabBody, incomingTabStyles } from './html/incomingHtml';
import { renderUpdateInfoTabBody, updateInfoTabStyles } from './html/updateInfoHtml';
import { renderHistoryTabBody, historyTabStyles } from './html/historyHtml';
import { createLogTabHandler } from './tabs/LogTab';
import { createConsoleTabHandler } from './tabs/ConsoleTab';
import { createIncomingTabHandler, IncomingTab, createIncomingTab } from './tabs/IncomingTab';
import { createUpdateInfoTabHandler, UpdateInfoTab } from './tabs/UpdateInfoTab';
import type { IUpdateInfoSummary } from '../../sync/updateProject';
import { HistoryTab, type IHistoryTabState } from './tabs/HistoryTab';
import type { RepositoryScopeSelection } from '../../registration/wiring';
import {
  buildBranchLabelsHtml,
  buildEmptyGraphPanelHtml,
  buildGraphPanelHtml,
  buildLogFilterRowHtml,
  type ILogPanelProps,
} from './provider/logPanelHtml';
import { type LocalChangesContextAction, type LogContextAction } from './provider/logActions';
import { buildInlineStyles, buildThreePanelStyles } from './provider/stylesBuilder';
import { buildCodiconFontFaceStyles } from './provider/codiconFontStyles';
import type { IGtwControllerContext } from './provider/IGtwControllerContext';
import {
  buildLoadingHtml,
  buildNoRepositoryHtml,
  buildUndockedPlaceholderHtml,
  buildCommitContextMenuHtml,
  buildFileContextMenuHtml,
  getFileStatusColor,
} from './provider/htmlBuilders';
import { buildWebviewCsp } from '../../utils/webviewCsp';
import { initIslandHtml } from '../../utils/webviewInit';
import {
  buildDetailsPanelModel,
  buildDetailsPanelPlaceholderModel,
  buildMultiCommitDetailsPanelModel,
  commitNodeToBaseDetails,
  commitToBaseDetails,
  type DetailsPanelModel,
} from './provider/detailsPanelModel';
import { type GitToolWindowOutbound } from './gitToolWindow.protocol';
import { asGitToolWindowTabsInbound } from './gitToolWindowTabs.protocol';
import {
  selectIfNotSelected as handleSelectIfNotSelected,
  toggleCommitSelection as handleToggleCommitSelection,
  selectCommits as handleSelectCommits,
  rangeSelectCommit as handleRangeSelectCommit,
  addRangeSelectCommit as handleAddRangeSelectCommit,
  selectCommit as handleSelectCommit,
  postDetailsForSelection,
  buildSelectionDetailsModel,
  dispatchLogMessage,
} from './provider/messageHandlers';
import type { IRemoteUrl } from '../../utils/remoteUrl';
import {
  loadDetailsGroupBy,
  saveDetailsGroupBy,
  type DetailsGroupBy,
} from '../../utils/detailsGroupBy';
import { BranchFocusController } from './provider/BranchFocusController';
import { DetailsModel } from './provider/DetailsModel';
import { LogStateModel } from './provider/LogStateModel';
import { RepoScopeModel } from './provider/RepoScopeModel';
import { BaseWebviewView, drainDisposables } from '../../utils/BaseWebviewView';
import { dispatchGuardedWebviewMessage } from '../../utils/webviewMessageGuard';
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

/** viewType of the undocked editor-tab panel (also referenced by keybinding when-clauses). */
export const GIT_LOG_PANEL_VIEW_TYPE = 'intellig.gitLogPanel';

/**
 * Serializer that revives an undocked Git Log tab after a window reload by
 * re-attaching it to the provider (attachPanel resets webview options and
 * requests initial data). Registered in registerViews against
 * {@link GIT_LOG_PANEL_VIEW_TYPE}.
 */
export function createLogPanelSerializer(
  getProvider: () => GitToolWindowProvider | undefined
): vscode.WebviewPanelSerializer {
  return {
    deserializeWebviewPanel(panel: vscode.WebviewPanel): Thenable<void> {
      getProvider()?.attachPanel(panel);
      return Promise.resolve();
    },
  };
}

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
 * How long a fetched branch-filter option list stays fresh. Long enough to
 * collapse a per-render request burst, short enough that a new branch shows up
 * promptly after the user creates one.
 */
const LOG_FILTER_OPTIONS_TTL_MS = 3000;

/**
 * Git Tool Window Provider implementation.
 */
/** The five tab sheets in emit order. The visual fixture renders this same concat, so the cascade a spec measures cannot drift from the one the document ships. */
export function toolWindowTabStyles(): string {
  return `${tabStripStyles()}\n${historyTabStyles()}\n${consoleTabStyles()}\n${updateInfoTabStyles()}\n${incomingTabStyles()}`;
}

export class GitToolWindowProvider
  extends BaseWebviewView
  implements IGitToolWindowProvider, IGtwControllerContext
{
  /**
   * Log-state store: the extended log state, fingerprint, totals, one-shot
   * scroll flags, and merged-HEAD set. Public so white-box tests and
   * per-cluster consumers reach the store directly.
   */
  public readonly log: LogStateModel;

  /**
   * Compatibility accessors over {@link log}: the class body (and the
   * white-box test surface) reads and writes the live state object under the
   * pre-split name; storage and the identity-replacement seam live on the
   * model.
   */
  private get _extendedLogState(): IExtendedLogState {
    return this.log.state;
  }
  private set _extendedLogState(next: IExtendedLogState) {
    this.log.replaceState(next);
  }
  /**
   * Search-mode toggles (regex / match case) as last reported by the webview.
   * UI state independent of the applied filter: flags with no committed text
   * must survive a re-render without becoming a filter criterion.
   */
  private _searchModeUi?: { regex: boolean; caseSensitive: boolean };
  /** Live search-box draft (uncommitted); survives re-renders. */
  private _searchDraft?: string;
  /**
   * Branch-focus state machine: the focused-path hash set, the staleness
   * generation, tip resolution and the focus/click flows. Public so
   * white-box tests and per-cluster consumers reach the controller directly.
   */
  public readonly focus: BranchFocusController;
  /**
   * Editor-tab WebviewPanel host while the log is undocked. When set, the
   * panel is the single live follower webview: every render and post targets
   * it and the sidebar view shows a placeholder (one follower at a time, so
   * the ADR-009 posting contract stays singular). Cleared when the panel is
   * disposed, which re-renders into the sidebar.
   */
  private _panel: vscode.WebviewPanel | undefined;
  /** Listeners scoped to the current panel attachment; drained on detach. */
  private _panelDisposables: vscode.Disposable[] = [];
  /**
   * Set when a render was skipped because the undocked panel was hidden
   * (retainContextWhenHidden keeps it alive, so it never no-ops on its own).
   * Flushed with a single rebuild when the panel becomes visible again.
   */
  private _panelRenderPending = false;
  /**
   * Set once an initial-data fetch has been requested and not yet resolved.
   * On a cold window reload both a restored panel (attach) and the sidebar
   * (resolve) fire cold; this latch collapses them to a single request so the
   * coalesced loader doesn't run a redundant trailing git-log walk. Cleared
   * when the fetch resolves (data lands via updateLogState / setHasRepository).
   */
  private _initialDataRequested = false;
  /**
   * The sidebar webview currently showing the undocked placeholder. The
   * placeholder document is static, so it is written once per sidebar
   * webview instance rather than on every render; tracked by identity so a
   * re-resolved sidebar (fresh document) gets it again.
   */
  private _placeholderWebview: vscode.Webview | undefined;
  private _panelWidths: [number, number];
  /** Fixed-column pixel widths for the log rows: [author, date]. The title
   * column is the flex absorber, so it has no stored width. Persisted to
   * workspace state so a user's drag survives re-render and commit-switch. */
  private _columnWidths: [number, number];
  private readonly _workspaceState: vscode.Memento | undefined;
  private _hasRepository: boolean = false;
  private _isLoading: boolean = true;

  /** Jump-to-hash growth delegate — see {@link setEnsureFullLogLoaded}. */
  private _ensureFullLogLoaded?: () => Promise<boolean>;
  /**
   * Details-panel pending state: single-commit files payload, containing
   * branches, the multi-selection file cache, and the Group By mode. Public
   * so white-box tests and per-cluster consumers reach the store directly;
   * the provider's orchestrators own every effect around it.
   */
  public readonly details: DetailsModel;
  /**
   * Whether the render CURRENTLY running answers a user gesture. The webview
   * persists its focus claim across window sessions, so this is what separates
   * "hand focus back to what the user was just using" from "yank focus into a
   * tool window they merely reopened". Only {@link _renderForGesture} writes
   * it, and only for the duration of one synchronous render.
   */
  private _restoreFocusOnNextRender = false;
  /**
   * Short-lived cache of the grouped Branch-popup options, keyed by the repo
   * scope. Collapses the per-open `requestLogFilterOptions` storm so a burst
   * can't re-run `git branch -a` on every Branch-popup open.
   */
  private _logFilterOptionsCache?: { key: string; groups: IBranchFilterGroups; at: number };
  private _consoleEntries: IConsoleEntry[] = [];
  private _maxConsoleEntries: number = DEFAULT_MAX_CONSOLE_ENTRIES;
  /**
   * Repository-scope state machine: repo list, selection, merged scope,
   * visible-roots subset, commit->root index, parsed-remote cache. Public so
   * white-box tests and per-cluster consumers reach the model directly; the
   * wide legacy entry points below stay as thin delegates.
   */
  public readonly repoScope: RepoScopeModel;

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
   * Root fsPath of the repository the History tab should query, recorded when
   * {@link loadFileHistory} is invoked with the file's resolved repo. In a
   * multi-repo workspace this pins history to the file's OWN repo instead of
   * defaulting to `getRepositories()[0]`. `undefined` falls back to the
   * currently selected repository.
   */
  private _historyRepoRoot: string | undefined;

  /**
   * Stateful handler for the Incoming tab. Constructed lazily via
   * `attachGitService()` once the data source is available.
   */
  private _incomingTab: IncomingTab | undefined;

  /**
   * Stateful handler for the Update Info tab. Holds the latest Update Project
   * summary ({@link setUpdateSummary}); the tab body renders its state. Created
   * in {@link attachGitService} (replacing the constructor-time no-op handler).
   */
  private _updateInfoTab: UpdateInfoTab | undefined;

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
   * Disposable for the `onDidChangeRepository` subscription wired by
   * {@link attachGitService}. Held so a second `attachGitService` call (e.g.
   * in tests) can dispose the prior subscription before wiring a new one.
   */
  private _remoteCacheSubscription: vscode.Disposable | undefined;

  /**
   * Live `onDidFetch` subscription that re-refreshes the Incoming tab when it
   * is visible. Re-created per `attachGitService`; disposed in {@link dispose}.
   */
  private _incomingFetchSubscription: vscode.Disposable | undefined;

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
     * test fixture shape. ADR-009 section 6 covers the
     * chronological-replay direction conventions.
     */
    commitNodes: readonly IMenuStateNode[];
  }>();
  private readonly _onDidSelectCommit = new vscode.EventEmitter<string>();
  private readonly _onDidSelectCommits = new vscode.EventEmitter<{ hashes: string[] }>();
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
   * Event emitter that fires whenever the repository SCOPE changes — either to
   * a specific repository or to the merged "all repositories" view. Drives the
   * dual log + branches wiring (see `wireRepositorySelection`).
   */
  private readonly _onDidChangeRepositoryScope =
    new vscode.EventEmitter<RepositoryScopeSelection>();

  // Public events
  public readonly onDidChangeState = this._onDidChangeState.event;
  public readonly onDidRequestContextAction = this._onDidRequestContextAction.event;
  public readonly onDidRequestFileDrop = this._onDidRequestFileDrop.event;
  public readonly onDidRequestLogContextAction = this._onDidRequestLogContextAction.event;
  public readonly onDidSelectCommit = this._onDidSelectCommit.event;
  /**
   * A MULTI-commit selection needs its files loaded, the same way
   * {@link onDidSelectCommit} drives the single-commit load. Fired only when
   * the panel has no files cached for that exact selection, so re-rendering
   * it (a Group By switch) costs no git.
   */
  public readonly onDidSelectCommits = this._onDidSelectCommits.event;
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
   * Event fired when the repository scope changes (a specific repo or the
   * merged "all repositories" view). The selector's single source of truth
   * for keeping the log and branches in agreement.
   */
  public readonly onDidChangeRepositoryScope = this._onDidChangeRepositoryScope.event;

  constructor(extensionUri: vscode.Uri, workspaceState?: vscode.Memento) {
    super(extensionUri);
    this.log = new LogStateModel();
    this.repoScope = new RepoScopeModel({
      render: (): void => this._render(),
      fireStateChange: (): void => this._onDidChangeState.fire(),
      fireScopeChange: (e): void => this._onDidChangeRepositoryScope.fire(e),
      readShowAllRootsConfig: (): boolean => this._isShowAllRootsConfigEnabled(),
    });
    // Store workspace state for panel width persistence
    this._workspaceState = workspaceState;
    // Restore the persisted log filter so a window reload resumes the same
    // scoped log (the initial load reapplies it via getActiveLogFilter).
    if (workspaceState) {
      this._extendedLogState.filter = loadLogFilter(workspaceState);
    }

    // Load persisted panel widths or use defaults
    this._panelWidths = workspaceState
      ? loadPanelWidths(workspaceState)
      : [...DEFAULT_PANEL_WIDTHS];

    this.details = new DetailsModel(workspaceState ? loadDetailsGroupBy(workspaceState) : 'tree');
    this.focus = new BranchFocusController(
      {
        render: (): void => this._render(),
        fireStateChange: (): void => this._onDidChangeState.fire(),
        hasView: (): boolean => this.hasView(),
        post: (msg): void => this.postToWebview(msg),
        getGitService: (): IGitService | undefined => this._attachedGitService,
        getSelectedRepository: (): IRepository | undefined => this.getSelectedRepository(),
        selectCommit: (hash): void => this.selectCommit(hash),
        scrollWebviewToCommit: (hash): void => this._scrollWebviewToCommit(hash),
      },
      this.log
    );

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
      this._onDidSelectCommits,
      this._onDidRequestCommitDiff,
      this._onDidRequestLogFilter,
      this._onDidRequestLoadMoreCommits,
      this._onDidRequestInitialData,
      this._onDidRequestRefresh,
      this._onDidChangeRepositoryScope
    );

    // Construct the tab router and register per-tab handlers.
    // The Log handler is intentionally a no-op; the existing
    // `_handleWebviewMessage` switch continues to own Log dispatch.
    this._tabRouter = new TabRouter({
      onActiveTabChanged: (tab: TabId): void => {
        // The Incoming tab holds no live subscription and computes its data
        // only in `refresh()`, so opening it must trigger one — otherwise it
        // shows its empty initial state ("Up to date with upstream…") no matter
        // the real incoming count.
        if (tab === 'incoming') {
          void this._incomingTab?.refresh();
        }
        // Re-render the webview so the new active panel becomes visible.
        // (Inactive panels use `display: none`; a re-render is the simplest
        // way to update `aria-selected` / `aria-hidden` / `style.display`
        // consistently. Future iterations may flip display in JS.)
        //
        // A gesture render: the hook only fires once `setActiveTab` has
        // confirmed the tab actually CHANGED, so a click on the already-active
        // tab never reaches here and never claims a focus restore.
        //
        // The classification is "any confirmed tab change", not "a webview tab
        // click": `loadFileHistory` (intellig.showHistory) and `focusTab` (a
        // status-bar click) reach it too. Both are user-initiated, and a
        // persisted commit-row claim is inert on a non-Log tab anyway —
        // inactive panels ship `display: none`, so `.focus()` is a no-op.
        this._renderForGesture();
      },
    });
    this._tabRouter.register('log', createLogTabHandler());
    this._tabRouter.register(
      'console',
      createConsoleTabHandler({ clearConsole: () => this.clearConsole() })
    );
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
    // render-unconditional: the renders below sit in tab onStateChange
    // callbacks, so they answer a tab's own state change rather than this call.
    // A second call re-subscribes and renders nothing, which would make an
    // idempotence entry pass while asserting nothing about them.
    //
    // Hold the reference for `setFocusedBranch` →
    // `getMergeBase`. Re-attaches replace the prior reference.
    this._attachedGitService = gitService;

    this._historyTab = new HistoryTab(gitService, {
      onStateChange: (): void => {
        // A state change in the History tab means its HTML needs re-rendering.
        // We piggyback on the existing _render() path.
        if (this._tabRouter.getActiveTab() === 'history') {
          this._render();
        }
      },
      getRepo: (): IRepository | undefined => this._resolveHistoryRepo(),
    });
    this._tabRouter.register('history', this._historyTab.asTabHandler());

    // Wire the Incoming tab now that the data source is available.
    // `getIncomingOutgoing` lives on the concrete GitService (ADR-001 — not
    // the frozen IGitService composite). Cast to the narrow role interface
    // the IncomingTab depends on, mirroring the IUpdateGitService pattern.
    this._incomingTab = createIncomingTab(
      gitService as unknown as import('./tabs/IncomingTab').IIncomingDataSource,
      {
        onStateChange: (): void => {
          if (this._tabRouter.getActiveTab() === 'incoming') {
            this._render();
          }
        },
        getRepo: (): import('../interfaces/IGitService').IRepository | undefined => {
          return this.getSelectedRepository();
        },
        jumpToCommit: (hash: string): void => {
          // Focus the Log tab, then scroll+select the commit there — the same
          // route the Update Info tab's jump takes.
          void this.focusTab('log').then(() => this.scrollToCommit(hash));
        },
      }
    );
    this._tabRouter.register('incoming', this._incomingTab.asTabHandler());

    // Wire the Update Info tab (replacing the constructor-time no-op handler).
    // It holds the latest Update Project summary; `setUpdateSummary` (called by
    // the `intellig.updateProject` command) installs a new one, and the body
    // renders the tab's state. A jump-to-commit routes into the Log tab's
    // scroll-to-commit path, mirroring the Incoming tab's row-click behavior.
    this._updateInfoTab = new UpdateInfoTab({
      onStateChange: (): void => {
        if (this._tabRouter.getActiveTab() === 'updateInfo') {
          this._render();
        }
      },
      jumpToCommit: (hash: string): void => {
        // Focus the Log tab, then scroll+select the commit there.
        void this.focusTab('log').then(() => this.scrollToCommit(hash));
      },
    });
    this._tabRouter.register('updateInfo', this._updateInfoTab.asTabHandler());

    // Keep the Incoming tab live after a fetch/pull: a fetch advances the
    // remote-tracking ref the incoming set is computed against, so a tab that
    // is currently visible must recompute. Guarded on the active tab so we
    // never run the log diff when the user isn't looking at it (activation
    // refresh covers the switch-to-it case). Re-subscribe on re-attach; the
    // single live subscription is disposed in {@link dispose}.
    this._incomingFetchSubscription?.dispose();
    this._incomingFetchSubscription = gitService.onDidFetch((): void => {
      if (this._tabRouter.getActiveTab() === 'incoming') {
        void this._incomingTab?.refresh();
      }
    });

    // Parsed-remote cache must be invalidated whenever a repository
    // mutates (e.g. the user runs `git remote set-url`), otherwise
    // `_getDetailsPanelModel` keeps building issue/PR links against the old
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
          this.repoScope.invalidateRemote(changed.rootUri.fsPath);
        } else {
          // Defensive: unkeyed event — blow the whole cache away.
          this.repoScope.clearRemoteCache();
        }
      }
    );
    // Fresh attach — any cache entries accumulated against the previous
    // service instance are now stale by definition.
    this.repoScope.clearRemoteCache();
  }

  /**
   * Load a file's history into the History tab and reveal it.
   *
   * Called by the `intellig.showHistory` command when the tabbed layout flag
   * is on. Falls back silently when no GitService has been attached yet.
   */
  public async loadFileHistory(
    filePath: string,
    repoRoot?: string,
    branch?: string
  ): Promise<void> {
    if (!this._historyTab) {
      return;
    }
    // Pin history to the file's own repo (the command resolved it). Without
    // this, the History tab defaults to `getRepositories()[0]` and a file in a
    // non-first repo of a multi-repo workspace shows the wrong repo's history.
    this._historyRepoRoot = repoRoot;
    await this._tabRouter.setActiveTab('history');
    await this._historyTab.loadFile(filePath, branch);
  }

  /**
   * Resolve the repository the History tab should query: the file's own repo
   * (recorded by {@link loadFileHistory}) when it still maps to an open repo,
   * otherwise the currently selected repository.
   */
  private _resolveHistoryRepo(): IRepository | undefined {
    if (this._historyRepoRoot) {
      const match = this.repoScope
        .getAvailableRepositories()
        .find((r) => r.rootUri.fsPath === this._historyRepoRoot);
      if (match) {
        return match;
      }
    }
    return this.getSelectedRepository();
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
   * Install a fresh Update Project summary into the Update Info tab. Called by
   * the `intellig.updateProject` command after a run. The tab's onStateChange
   * re-renders the body when it's the active tab; otherwise the new state is
   * shown the next time the user switches to (or deep-links into) the tab.
   *
   * A no-op until {@link attachGitService} has created the tab (the git service
   * is wired at activation, well before any user-triggered update).
   */
  public setUpdateSummary(summary: IUpdateInfoSummary): void {
    this._updateInfoTab?.setSummary(summary);
  }

  /**
   * Subclass hook for {@link BaseWebviewView.resolveWebviewView}. The base
   * class has already set webview options, assigned `this._view`, wired
   * `onDidReceiveMessage` → {@link _handleMessage}, wired `onDidDispose` to
   * clear `this._view`, and performed the initial render via
   * {@link BaseWebviewView._renderOnResolve}.
   *
   * Here we add GitToolWindow-specific wiring:
   *   - Re-render on visibility change (so the panel repopulates when the user
   *     switches back after hiding the view).
   *   - Fire {@link onDidRequestInitialData} on a cold resolve only, so the
   *     extension host fetches branches + commits + repository availability
   *     without a warm re-resolve clobbering already-loaded pages.
   */
  protected override _onResolve(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    // Handle visibility changes. Scoped to this resolve cycle (drained on the
    // view's onDidDispose) so a hide→show re-resolve doesn't accumulate a fresh
    // visibility listener each time. A become-visible is the same docked-vs-
    // undocked render decision as resolve, so delegate to _renderOnResolve so
    // that choice has one owner.
    this._registerPerResolve(
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          this._renderOnResolve();
        }
      })
    );

    // Request the initial fetch only on a cold resolve. Provider state is
    // host-owned and survives a sidebar re-resolve (collapse/expand): a warm
    // follower already has commits, so refetching would replace commitNodes
    // with page 1 and drop loaded-more pages. Staleness is the watchers' job
    // via onDidRequestRefresh; a genuinely cold resolve still fires.
    this._requestInitialDataIfNeeded();
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
   *
   * Deliberately does not render here. Every caller reloads and then refreshes,
   * so the only state available at this point is the state already on screen;
   * painting it again would destroy the document to show what it already shows.
   * Fresh data reaches the panel through `updateLogState`, which renders when
   * the data actually changes.
   */
  public refresh(): void {
    this._onDidChangeState.fire();
    this._onDidRequestRefresh.fire();
  }

  /**
   * Add a console entry
   */
  public addConsoleEntry(entry: Omit<IConsoleEntry, 'timestamp'>): void {
    // render-unconditional: appends. Two identical calls produce two different
    // console states, so repainting for the second one is correct.
    const fullEntry: IConsoleEntry = {
      ...entry,
      timestamp: new Date(),
    };

    this._consoleEntries.push(fullEntry);

    // Trim entries if exceeding max
    while (this._consoleEntries.length > this._maxConsoleEntries) {
      this._consoleEntries.shift();
    }

    // Only re-render when the Console tab is actually visible — mirrors the
    // History/Incoming tabs. Every git command logs an entry here, including
    // the `git show` a commit selection fires; an unconditional re-render
    // rebuilt the whole graph+details DOM on every git command, discarding the
    // user's live-dragged divider/column widths and scroll (the "graph resizes
    // on every click" bug) and producing a startup re-render storm. The Console
    // tab re-reads `_consoleEntries` from in-memory state on its next render.
    if (this._tabRouter.getActiveTab() === 'console') {
      this._render();
    }
    this._onDidChangeState.fire();
  }

  /**
   * Update a streaming entry in place.
   *
   * Deliberately narrower than `addConsoleEntry`: it re-renders only while the
   * Console tab is showing and does NOT fire `_onDidRequestRefresh`, because a
   * chatty clone emits thousands of chunks and a full data reload per chunk is
   * the refresh storm this view already paid for once.
   *
   * That closes the data half only. The render itself still reassigns
   * `webview.html`, so a visible Console tab reloads the document on each
   * flush and console scroll still resets mid-clone. Appending streamed bytes
   * over `postMessage` is the remaining half.
   */
  public updateConsoleEntry(update: {
    id: string;
    output: string;
    exitCode?: number;
    isError?: boolean;
  }): void {
    // render-unconditional: writing identical values still repaints. That is a
    // real defect and this annotation is where it stays visible; fixing it
    // means comparing against the stored entry and moving this name into
    // RENDER_IDEMPOTENCE_CASES.
    const entry = this._consoleEntries.find((e) => e.id === update.id);
    if (!entry) {
      return;
    }
    entry.output = update.output;
    if (update.exitCode !== undefined) {
      entry.exitCode = update.exitCode;
    }
    if (update.isError !== undefined) {
      entry.isError = update.isError;
    }
    if (this._tabRouter.getActiveTab() === 'console') {
      this._render();
    }
    this._onDidChangeState.fire();
  }

  /**
   * Clear console entries.
   *
   * Gated the same way as its two siblings, for the same reason: the render
   * reassigns `webview.html`, so clearing the console while the Log tab is
   * showing would destroy the log document — including a filter draft, which
   * lives only in the DOM. An already-empty list is not a change at all, so it
   * returns before both the render and the state event.
   */
  public clearConsole(): void {
    if (this._consoleEntries.length === 0) {
      return;
    }
    this._consoleEntries = [];
    if (this._tabRouter.getActiveTab() === 'console') {
      this._render();
    }
    this._onDidChangeState.fire();
  }

  /**
   * Set repository availability.
   * When set to false, the webview displays a "no repository" prompt
   *.
   */
  public setHasRepository(hasRepository: boolean): void {
    // The initial fetch has resolved (repo detection landed): allow a later
    // genuinely-cold request to fire again.
    this._initialDataRequested = false;
    const wasLoading = this._isLoading;
    this._isLoading = false;
    if (this._hasRepository !== hasRepository || wasLoading) {
      this._hasRepository = hasRepository;
      // Availability transitioned (or the loading screen resolved): the DOM no
      // longer shows the last log render, so the next updateLogState must
      // paint even if its data is unchanged.
      this.log.invalidateFingerprint();
      this._render();
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
   * Update the Log state with commits.
   *
   * @param totalAvailable - Total commits available for the current repo/filter
   *   (from `git rev-list --count`), independent of how many are loaded into
   *   `commits`. When provided and greater than `commits.length`, the graph
   *   shows an honest "loaded of total" indicator and the webview enables
   *   scroll-to-bottom load-more. Omit it (or pass `undefined`) when no count
   *   is available — the indicator then treats everything as loaded.
   */
  public updateLogState(
    commits: ICommit[],
    branchMap?: Map<string, IBranchRef[]>,
    tagMap?: Map<string, string[]>,
    headHash?: string,
    headBranchName?: string,
    totalAvailable?: number
  ): void {
    // Change detection: a watcher-driven background refresh usually reloads
    // the exact state already on screen. When the fingerprint matches and no
    // navigational scroll-reset is pending, update the cheap flags and stop —
    // no graph regeneration, no re-render, no post sequence. A pending
    // scroll-reset always forces the render through so navigation both
    // repaints and consumes its reset.
    const fingerprint = fingerprintLogState(
      commits,
      branchMap,
      tagMap,
      headHash,
      headBranchName,
      totalAvailable
    );
    if (
      this.log.fingerprintMatches(fingerprint) &&
      !this.log.hasPendingScrollReset() &&
      this._hasRepository
    ) {
      this.log.setTotal(totalAvailable);
      this._initialDataRequested = false;
      this._isLoading = false;
      return;
    }
    this.log.commitFingerprint(fingerprint);

    this.log.setTotal(totalAvailable);
    // Commits landed: the initial fetch has resolved, so clear the latch.
    this._initialDataRequested = false;
    // The graph caller fetches `git log --topo-order` (extension.ts),
    // so `commits` arrives in a topology-respecting order: every
    // parent of a commit appears later in the list (or off-window).
    // We DON'T re-sort by date here — a date re-sort dominates
    // topology after a squash/rebase (fresh committerDate for the
    // rewritten commits collapses divergent branches into the wrong
    // place in the list), which the algorithm faithfully renders as
    // a linear graph. Trust the topo-ordered input instead.

    // re-validate the focused branch against the new
    // branch list. If the focus target disappeared (force-push, branch
    // rename, repo switch), null it out and clear the cached path-hash
    // set. The `commitNodes` we then generate get `onFocusedBranchPath:
    // false` for every node, which is the no-focus baseline.
    this.repoScope.rebuildCommitRoots(commits);
    // Reset the per-root HEAD set; the merged loader repopulates it via
    // setMergedHeadCommitHashes right after this call. Single-repo / specific
    // loads leave it empty (the single headHash drives undoCommit there).
    this.log.clearMergedHeads();

    const branchNamesPresent = new Set<string>();
    if (branchMap) {
      for (const refs of branchMap.values()) {
        for (const ref of refs) {
          branchNamesPresent.add(ref.name);
        }
      }
    }
    const newFocusName = this.focus.revalidateOnSnapshot(branchNamesPresent);

    this.log.applySnapshot(
      commits,
      branchMap,
      tagMap,
      headHash,
      headBranchName,
      newFocusName,
      this.focus.pathHashesOrUndefined()
    );

    this._hasRepository = true;
    this._isLoading = false;
    this._render();
    // Fire BEFORE the post sequence.
    // Aligns with the 5 setters and ADR-009 section 3 generalised rule:
    // any host method that calls `_post*` helpers fires `onDidChangeState`
    // first so subscribers see "state changed" on the same event-loop
    // tick the host knows it.
    this._onDidChangeState.fire();
    this._postSyncSelection();
    this._postMenuStateUpdate();
  }

  /**
   * Total commits available for the current repo/filter, or `undefined` when
   * no count has been supplied. Test seam for the load-more wiring — production
   * reads it via the rendered `data-total-available` attribute.
   */
  public getLogTotalAvailable(): number | undefined {
    return this.log.getTotal();
  }

  /**
   * Fold a late-resolving total (the `git rev-list --count` that no longer
   * blocks first paint) into the already-rendered graph WITHOUT a full
   * re-render. It updates only the `.graph-panel` `data-total-available`
   * attribute the scroll-to-bottom load-more reads, so a slow count
   * re-enables load-more (and feeds the next render's "X of Y" indicator)
   * without destroying scroll / in-progress layout / selection — the disruption
   * a late `updateLogState` would cause. No-op if no view or the commits aren't
   * a windowed page (total ≤ loaded → nothing more to load).
   */
  public applyGraphTotalAvailable(total: number): void {
    this.log.setTotal(total);
    if (this.hasView()) {
      this.postToWebview({
        type: 'graphTotalsUpdate',
        loaded: this._extendedLogState.commitNodes.length,
        total,
      });
    }
  }

  /**
   * Ask the NEXT graph render to reset the webview to the top rather than
   * preserving the saved scroll position. Used by navigational loads (repo
   * switch, filter/branch/range change, initial load) where the user expects to
   * land at the newest commit. Scroll is preserved by default for every other
   * (in-place) re-render. The flag is one-shot: it is cleared by the render that
   * consumes it.
   */
  public markResetScrollOnNextRender(): void {
    this.log.markResetScroll();
  }

  /**
   * Tell the webview a requested page of commits has finished loading, so it
   * re-arms the scroll-to-bottom load-more debounce (`loadMoreCommitsRequested`).
   * Posted by the host after a load-more render completes. This makes the reset
   * EXPLICIT and reload-independent: the debounce no longer relies on the full
   * `webview.html` reload happening to clear it, so a future move to in-place
   * DOM patching can't silently wedge load-more after the first extra page.
   */
  public notifyCommitsLoaded(): void {
    if (!this.hasView()) {
      return;
    }
    this.postToWebview({ type: 'commitsLoaded' });
  }

  /**
   * Set the log filter
   */
  public setLogFilter(filter: ILogFilter | undefined): void {
    this._extendedLogState.filter = filter;
    if (this._workspaceState) {
      saveLogFilter(this._workspaceState, filter);
    }
    this._onDidChangeState.fire();
  }

  /**
   * The ACTIVE log filter, for the load path: the initial load and every
   * refresh-triggered reload reapply it so a background refresh never
   * silently widens a filtered log back to all commits.
   */
  public getActiveLogFilter(): ILogFilter | undefined {
    return this._extendedLogState.filter;
  }

  /**
   * Late-bind the jump-to-hash growth delegate. registerViews wires it to the
   * load-more controller (which owns the active scope + window), growing the
   * log window to the scope's full history and awaiting the reload.
   */
  public setEnsureFullLogLoaded(fn: () => Promise<boolean>): void {
    this._ensureFullLogLoaded = fn;
  }

  /**
   * Grow the log window to the active scope's full history so a jump target
   * outside the current window becomes reachable (the reference retries as
   * data packs load until the pack is full — VcsLogNavigationUtil.tryJumpTo).
   * Resolves false when the delegate is unwired, no scope has committed yet
   * (cold start / merged view), or the total couldn't be verified.
   */
  public async ensureFullLogLoaded(): Promise<boolean> {
    return this._ensureFullLogLoaded ? this._ensureFullLogLoaded() : false;
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
    const next = hashes && hashes.size > 0 ? hashes : undefined;
    // Change detection: this setter runs at the tail of EVERY graph load
    // (loadCherryMarksForRepo), including watcher-driven refreshes whose
    // marks are identical — rendering unconditionally here would rebuild the
    // DOM on every background tick even when updateLogState skipped.
    const prev = this._extendedLogState.cherryPickedHashes;
    const unchanged =
      this._extendedLogState.cherryPickBaseRef === baseRef &&
      (prev === next ||
        (prev !== undefined &&
          next !== undefined &&
          prev.size === next.size &&
          [...next].every((h) => prev.has(h))));
    if (unchanged) {
      return;
    }
    this._extendedLogState.cherryPickedHashes = next;
    this._extendedLogState.cherryPickBaseRef = baseRef;
    this._render();
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

    this.log.setScrollTarget(hash);
    this.selectCommit(hash);

    if (this.hasView()) {
      this.postToWebview({
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
    // The selection, not the expanded commit, decides who owns the panel: a
    // load that lands after the user grew the selection into a range must not
    // repaint that range as one commit. The payload is dropped along with the
    // paint, and the selection seam re-asks whenever a one-commit selection
    // has no payload of its own.
    if (this._extendedLogState.selectedCommits.size >= 2) {
      return;
    }

    // Store the changed files and error for use in the next render
    this.details.setPendingFiles(hash, changedFiles, error);

    // Send a partial update to the webview instead of a full re-render
    // to preserve the graph panel's scroll position
    if (this.hasView()) {
      const node = this._extendedLogState.commitNodes.find((n) => n.commit.hash === hash);
      if (node) {
        const commitDetails: ICommitDetails = {
          ...commitNodeToBaseDetails(node),
          changedFiles,
          changedFilesError: error ? String(error) : undefined,
          containingBranches: this.details.pendingBranchesFor(hash),
        };
        this.postToWebview({
          type: 'updateDetailsPanel',
          model: this._getDetailsPanelModel(commitDetails),
        });
      }
    }
  }

  /**
   * Update the details panel with the branches that contain the expanded
   * commit. Called by the host once `getContainingBranches` resolves. Posts a
   * partial details-panel update (preserving graph scroll) built from the
   * already-fetched changed files plus the branch list. No-ops if the user has
   * since selected a different commit.
   *
   * @param hash - the commit the branches belong to
   * @param branches - sorted containing-branch names (`[]` = in no branch)
   */
  public updateContainingBranches(hash: string, branches: string[]): void {
    if (this._extendedLogState.expandedCommit !== hash) {
      return;
    }
    // See updateCommitDetails: a range selection owns the panel, and the
    // expanded-commit match alone does not exclude one. Unreachable today for
    // the same reason, and kept for the same future multi-select callers.
    if (this._extendedLogState.selectedCommits.size >= 2) {
      return;
    }
    this.details.setPendingContainingBranches(hash, branches);

    if (this.hasView()) {
      const node = this._extendedLogState.commitNodes.find((n) => n.commit.hash === hash);
      if (node) {
        const commitDetails: ICommitDetails = {
          ...commitNodeToBaseDetails(node),
          ...this.details.pendingFilesFor(hash),
          containingBranches: branches,
        };
        this.postToWebview({
          type: 'updateDetailsPanel',
          model: this._getDetailsPanelModel(commitDetails),
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
  // _render / _onDidChangeState.fire / _postSyncSelection /
  // _postMenuStateUpdate on the instance) observe the real call order. Do not
  // inline these bodies or capture the references — that would hide the patch.
  updateWebview(fromGesture = false): void {
    // render-unconditional: this IS the unconditional render seam. Extracted
    // handlers call it to repaint after a gesture, so a guard here would defeat
    // its only purpose; the change decision belongs to each caller.
    if (fromGesture) {
      this._renderForGesture();
      return;
    }
    this._render();
  }

  /**
   * Render in answer to a user gesture, so the webview may hand keyboard focus
   * back to whoever this render is about to destroy.
   *
   * The flag is raised and dropped inside this one synchronous call, so it can
   * never outlive the render it describes. An earlier latch form could be armed
   * by a gesture that then produced NO render (a click on the already-active
   * tab), and the next ambient render — a `.git` watcher tick — spent it,
   * stealing focus from wherever the user had moved on to.
   */
  private _renderForGesture(): void {
    this._restoreFocusOnNextRender = true;
    try {
      this._render();
    } finally {
      this._restoreFocusOnNextRender = false;
    }
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

  // IGtwControllerContext — clear the pending details-panel state as one unit
  // (see {@link DetailsModel.clearPending} for the lockstep rationale).
  clearPendingChangedFiles(): void {
    this.details.clearPending();
  }

  // IGtwControllerContext — capability methods for the single-select handler.
  // Each is a dynamic delegation read off `this` on every call (never a
  // captured reference), so the webview reference and the onDidSelectCommit
  // emitter stay encapsulated on the provider and the underlying instance
  // methods stay patchable for the render-then-post ordering tests.
  hasView(): boolean {
    return this._followerWebview !== undefined;
  }

  postToWebview(msg: GitToolWindowOutbound): void {
    // typed-messages-exempt: the single typed send wrapper for the follower webview (docked view or undocked panel); msg is on-contract (GitToolWindowOutbound)
    void this._followerWebview?.postMessage(msg);
  }

  /** The single live follower webview: the undocked panel when present, else the sidebar view. */
  private get _followerWebview(): vscode.Webview | undefined {
    return this._panel?.webview ?? this._view?.webview;
  }

  /**
   * Undock: retarget the provider onto an editor-tab panel. The panel becomes
   * the follower webview; the sidebar (if resolved) renders a placeholder.
   * A previously attached panel is closed (never orphaned). Fires the
   * initial-data request so undocking works even when the sidebar has never
   * resolved (nothing else triggers the first fetch).
   */
  public attachPanel(panel: vscode.WebviewPanel): void {
    if (this._disposed) {
      // Refusing adoption must not leave the offered panel as a blank
      // orphaned tab (teardown-time hardening).
      panel.dispose();
      return;
    }
    const previous = this._panel;
    this._detachPanel();
    previous?.dispose();
    this._panel = panel;
    // Give the floated Git Log tab the activity-bar icon instead of the
    // generic webview glyph. Covers both entry points (openInEditor and the
    // serializer revive), which both adopt through here.
    panel.iconPath = vscode.Uri.joinPath(this._extensionUri, 'resources', 'git-icon-branch.svg');
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };
    this._panelDisposables.push(
      // typed-messages-exempt: second raw panel of the undocked window — same guarded pipeline as the docked view
      panel.webview.onDidReceiveMessage((message: unknown) => {
        this._guardedHandleMessage(message);
      }),
      panel.onDidDispose(() => {
        // Dock back: the sidebar becomes the follower again.
        this._detachPanel();
        this._retargetFollower();
      }),
      panel.onDidChangeViewState(() => {
        // Flush a render deferred while the panel was hidden, exactly once. Go
        // through the full render+post sequence: the rebuild resets the
        // webview's cached message-only state (e.g. the menu enable map), so the
        // follower-scoped posts must follow, exactly as a normal render does.
        if (panel.visible && this._panelRenderPending) {
          this._retargetFollower();
        }
      })
    );
    this._retargetFollower();
    // Cold attach only (nothing loaded yet — first-interaction undock or
    // serializer revival): request the initial fetch. A warm undock keeps
    // the already-rendered state; refetching would reset loaded-more pages.
    this._requestInitialDataIfNeeded();
  }

  /**
   * Fire the initial-data request at most once per cold start. Gated by
   * {@link _needsInitialData} (warm followers skip) and by the
   * {@link _initialDataRequested} latch (so a simultaneous attach + resolve
   * don't both fire).
   */
  private _requestInitialDataIfNeeded(): void {
    if (this._initialDataRequested || !this._needsInitialData()) {
      return;
    }
    this._initialDataRequested = true;
    this._onDidRequestInitialData.fire();
  }

  /**
   * Clear the initial-data latch when the requested load settled without
   * reaching the data callbacks (i.e. it rejected). Without this a failed cold
   * load would wedge the latch and every later cold attach/resolve would
   * early-return, leaving a stuck spinner with no retry.
   */
  public resetInitialDataRequest(): void {
    this._initialDataRequested = false;
  }

  /**
   * True when the follower has nothing to show yet — still loading, or no
   * commits fetched. Undock/revival uses this to decide whether to request an
   * initial fetch; a warm follower (commits already loaded) skips it so
   * loaded-more pages survive.
   */
  private _needsInitialData(): boolean {
    return this._isLoading || this._extendedLogState.commitNodes.length === 0;
  }

  /**
   * Create (or reveal) the undocked editor-tab panel. Owns the full panel
   * spec — viewType, title, and the creation-only retainContextWhenHidden —
   * so every entry point gets the same panel.
   */
  public openInEditor(): vscode.WebviewPanel | undefined {
    if (this._disposed) {
      return undefined;
    }
    if (this._panel) {
      this._panel.reveal();
      return this._panel;
    }
    const panel = vscode.window.createWebviewPanel(
      GIT_LOG_PANEL_VIEW_TYPE,
      'Git Log',
      vscode.ViewColumn.Active,
      { retainContextWhenHidden: true }
    );
    this.attachPanel(panel);
    return panel;
  }

  /**
   * Bring the log surface the user actually sees to the front: the undocked
   * panel when one exists, otherwise the sidebar view. Jump/reveal flows
   * route through this so they never focus the placeholder while the real
   * log sits in a background editor group or floated window.
   */
  public async revealLogHost(): Promise<void> {
    if (this._panel) {
      this._panel.reveal();
      return;
    }
    await vscode.commands.executeCommand(`${GIT_TOOL_WINDOW_VIEW_ID}.focus`);
  }

  /**
   * Re-render into the current follower and re-post the follower-scoped
   * state surfaces. Ordering per ADR-009: render first, post last, so the
   * fresh document receives the posts.
   */
  private _retargetFollower(): void {
    this._render();
    this._postSyncSelection();
    this._postMenuStateUpdate();
  }

  /**
   * Panel-side message dispatch under the same shared guard the sidebar path
   * gets from BaseWebviewView.resolveWebviewView.
   */
  private _guardedHandleMessage(message: unknown): void {
    dispatchGuardedWebviewMessage(() => this._handleMessage(message), {
      component: 'GitToolWindowProvider',
      rejectionLabel: 'GitToolWindowProvider.attachPanel: async _handleMessage rejection',
      syncThrowMessage: 'panel message handler threw',
    });
  }

  /** Drop the current panel attachment without re-rendering (attach-replace path). */
  private _detachPanel(): void {
    drainDisposables(this._panelDisposables);
    this._panel = undefined;
    this._placeholderWebview = undefined;
    this._panelRenderPending = false;
  }

  getDetailsPanelModel(details: ICommitDetails): DetailsPanelModel {
    return this._getDetailsPanelModel(details);
  }

  getDetailsPanelPlaceholderModel(): DetailsPanelModel {
    return buildDetailsPanelPlaceholderModel();
  }

  getMultiCommitDetailsPanelModel(detailsList: ICommitDetails[]): DetailsPanelModel {
    return this._getMultiCommitDetailsPanelModel(detailsList);
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
   * approaches converge on the same direction. ADR-009 section 6.
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
    this._incomingFetchSubscription?.dispose();
    this._incomingFetchSubscription = undefined;
    // Close the undocked panel with its owner. Detach first so the panel's
    // onDidDispose dock-back listener is gone before dispose() fires it.
    const panel = this._panel;
    this._detachPanel();
    panel?.dispose();
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
    if (!this.hasView()) {
      return;
    }
    const commitNodes = this._extendedLogState.commitNodes.map((n) => ({
      hash: n.commit.hash,
      parentCount: (n.commit.parents || []).length,
      // Parent hashes power the "in current branch" gate on Fixup / Squash Into
      // (HEAD-ancestor reachability over the loaded window).
      parents: n.commit.parents || [],
    }));
    // The real head hash, not the top row's: HEAD is only the newest commit
    // when it sits at the tip of the loaded log. `computeMenuState`'s
    // HEAD-membership rule gates "Reset to here", "Squash" and friends, so a
    // detached HEAD at an older commit must not read as the first row.
    const headHash = this._extendedLogState.headHash ?? '';
    const state = computeMenuState({
      selectedHashes: this._extendedLogState.selectedCommits,
      commitNodes,
      headHash,
      // Merged scope suppresses the single headHash; the per-root HEAD set
      // keeps undoCommit enabled for the clicked commit's own-repo HEAD.
      headHashes: this.log.getMergedHeads(),
    });
    const msg: WaveAOutboundMessage = {
      type: 'updateMenuEnableState',
      state,
      selectedCount: this._extendedLogState.selectedCommits.size,
    };
    this.postToWebview(msg);
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
    if (!this.hasView()) {
      return;
    }
    const msg: WaveAOutboundMessage = {
      type: 'syncSelection',
      anchorHash: this._extendedLogState.anchorHash,
      selectedHashes: Array.from(this._extendedLogState.selectedCommits),
    };
    this.postToWebview(msg);
  }

  /** Changed files already loaded for `hash` in the current selection. */
  getMultiChangedFiles(hash: string): IChangedFile[] | undefined {
    return this.details.getMultiChangedFiles(hash);
  }

  /** Why `hash` contributed no files to the current selection, if it failed. */
  getMultiChangedFilesError(hash: string): string | undefined {
    return this.details.getMultiChangedFilesError(hash);
  }

  /**
   * Ask the host to load changed files for a multi-commit selection, unless
   * they are already cached for exactly this selection.
   *
   * Returns `true` when the cache is warm, so the caller can paint files
   * immediately instead of waiting for a round trip it does not need.
   */
  requestMultiCommitFiles(hashes: readonly string[]): boolean {
    const noted = this.details.noteMultiSelection(hashes);
    if (noted.alreadyCurrent) {
      return noted.warm;
    }
    // Fired for EVERY selection change, including one too small to need a
    // load: the listener invalidates whatever is in flight, so shrinking a
    // large selection stops its remaining git calls instead of letting them
    // run to completion and be discarded at the paint seam.
    this._onDidSelectCommits.fire({ hashes: [...hashes] });
    return false;
  }

  /**
   * Receive the changed files loaded for a multi-commit selection and repaint
   * the panel with the real combined tree.
   *
   * `loadedHashes` is the subset {@link MULTI_DETAILS_COMMIT_CAP} allowed the
   * loader to read. The panel derives its "showing the first N" notice from
   * it rather than from a count, so the notice always describes the commits
   * it actually rendered. A payload for a selection the user has already left
   * is dropped.
   */
  public updateMultiCommitDetails(
    hashes: readonly string[],
    filesByHash: ReadonlyMap<string, IChangedFile[]>,
    loadedHashes: readonly string[],
    errorsByHash: ReadonlyMap<string, string>
  ): void {
    if (!this.details.acceptMultiFiles(hashes, filesByHash, loadedHashes, errorsByHash)) {
      return;
    }
    postDetailsForSelection(this);
  }

  /**
   * Push an `updateDetailsPanel` message for the current
   * `expandedCommit`. Used by the range-select handlers (which
   * deliberately avoid `_render()` to preserve commit-row
   * focus for keyboard navigation) so the details pane still
   * reflects the latest range tip without re-rendering the graph.
   *
   * Mirrors the inline post path in {@link selectCommit}.
   */
  private _postDetailsForExpandedCommit(): void {
    if (!this.hasView()) {
      return;
    }
    if (!this._extendedLogState.expandedCommit) {
      return;
    }
    const commitDetails = this.getExpandedCommitDetails();
    this.postToWebview({
      type: 'updateDetailsPanel',
      model: commitDetails
        ? this._getDetailsPanelModel(commitDetails)
        : buildDetailsPanelPlaceholderModel(),
    });
  }

  /**
   * Details for the currently expanded commit, or undefined when none is
   * expanded (or it has scrolled out of the loaded set).
   *
   * Carries the already-loaded payload, as updateContainingBranches does:
   * callers also repaint the panel for a commit whose files are in hand (a
   * Group By switch), and an empty list there empties the tree until the user
   * reselects the commit.
   */
  getExpandedCommitDetails(): ICommitDetails | undefined {
    const expanded = this._extendedLogState.expandedCommit;
    if (!expanded) {
      return undefined;
    }
    const node = this._extendedLogState.commitNodes.find((n) => n.commit.hash === expanded);
    if (!node) {
      return undefined;
    }
    const containingBranches = this.details.pendingBranchesFor(expanded);
    return {
      ...commitNodeToBaseDetails(node),
      ...this.details.pendingFilesFor(expanded),
      ...(containingBranches ? { containingBranches } : {}),
    };
  }

  /**
   * Ask the host to load the changed files for a single-commit selection,
   * unless they are already loading (or loaded) for that commit.
   *
   * Every gesture that lands on a one-commit selection routes through here, not
   * just the plain click: a selection that SHRINKS to one commit never fired
   * the select event, so its survivor was left permanently showing no files.
   */
  requestSingleCommitFiles(hash: string): void {
    if (!this.details.noteSingleRequest(hash)) {
      return;
    }
    this._onDidSelectCommit.fire(hash);
  }

  /**
   * Handle messages from the webview
   */
  // typed-messages-exempt-rule-c: the Log switch and its exhaustiveness gate
  // live in provider/messageHandlers.ts (dispatchLogMessage); this shell only
  // pre-filters router-owned messages and forwards.
  private _handleWebviewMessage(message: IWebviewMessage): void {
    // Intercept router-owned messages (tabChange + non-Log tabs).
    // This is intentionally a synchronous pre-filter so the Log dispatch
    // keeps its exact pre-refactor invocation ordering.
    if (this._routeIfNonLog(message)) {
      return;
    }
    dispatchLogMessage(this, message);
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
    // Typed tab-channel messages the webview entry posts (tabChange + the
    // History-tab actions) are recognized here. This guard is a typed
    // RECOGNIZER, not the drift fence: the fence is send-side — the entry's
    // typed `post()` (+ the Rule-D array tie) makes a new webview-posted
    // history.X fail to compile until it joins the union — so the prefix
    // fallback below is intentional, not a hole. The prefix checks also carry
    // the stub tabs and host-dispatched history messages that are NOT part of
    // the webview contract (e.g. `history.loadFile` from openFileHistory).
    if (asGitToolWindowTabsInbound(message)) {
      return true;
    }
    const type = typeof message.type === 'string' ? message.type : '';
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
   * Apply a filter posted by the webview: spend the in-flight search draft,
   * remember the regex/case UI toggles, sanitize the untrusted payload via
   * {@link sanitizeWebviewLogFilter}, and fire the filter request.
   */
  private _handleApplyLogFilter(webviewFilter: IWebviewLogFilter | null): void {
    // Applying a filter commits whatever the box held, so the in-flight draft
    // is spent. Keeping it would let the input keep displaying text that the
    // active filter does not contain.
    this._searchDraft = undefined;
    let filter: ILogFilter | undefined;
    if (webviewFilter) {
      // The regex/case toggles are UI properties independent of the search
      // text (IntelliJ TextFilterModel): remember them in their own slot so a
      // toggle-first-then-type flow survives re-renders. They only join the
      // FILTER alongside text — flags alone are not a filter criterion.
      this._searchModeUi = {
        regex: Boolean(webviewFilter.searchRegex),
        caseSensitive: Boolean(webviewFilter.searchCaseSensitive),
      };
      filter = sanitizeWebviewLogFilter(webviewFilter);
    }
    this.setLogFilter(filter);
    this._onDidRequestLogFilter.fire(filter);
  }

  /**
   * Fetch the ref-aware branch list for the active repo scope and post it back
   * grouped (Local + per-remote) so the Branch popup can render IntelliJ's
   * nested layout. Lazy: fired when the Branch popup opens. Silent no-op when
   * no repo or service is attached.
   */
  private async _handleRequestLogFilterOptions(): Promise<void> {
    const repo = this.getSelectedRepository();
    const gitService = this._attachedGitService;
    if (!repo || !gitService) {
      return;
    }
    // In the merged "All Repositories" scope the branch filter applies across
    // every visible root, so the dropdown must offer the UNION of all roots'
    // branches (IntelliJ BranchFilterModel parity) — listing only the context
    // repo's branches would silently scope the graph to one repo. A single-repo
    // scope lists just that repo's branches, unchanged.
    const branchSources = this.isAllReposSelected() ? this.getVisibleRepositories() : [repo];
    // Coalesce per-render re-requests. The inline init script re-fires this on
    // EVERY webview render (the dropdown is re-rendered empty each time), so
    // without a short cache a render/refresh burst spams `git branch -a`. Serve
    // a recent result for the same repo scope instead of re-running git.
    const cacheKey = branchSources.map((r) => r.rootUri.fsPath).join('\0');
    const now = Date.now();
    const cached = this._logFilterOptionsCache;
    if (cached && cached.key === cacheKey && now - cached.at < LOG_FILTER_OPTIONS_TTL_MS) {
      this._postLogFilterOptions(cached.groups);
      return;
    }
    // Per-root catch: a hard exec rejection on one root (e.g. an unmounted /
    // removed multi-root → cwd ENOENT, spawn failure) must not discard the
    // healthy roots' branches or escape as an unhandled rejection. Each bad
    // root contributes [] and the union survives. `getBranches` already returns
    // [] on a non-zero git exit; this guards the throw path.
    const perRepoBranches = await Promise.all(
      branchSources.map((r) => gitService.getBranches(r).catch(() => []))
    );
    const groups = groupBranchFilterOptions(perRepoBranches);
    this._logFilterOptionsCache = { key: cacheKey, groups, at: Date.now() };
    this._postLogFilterOptions(groups);
  }

  /** Post the grouped branch options (Local + per-remote) to the Branch popup. */
  private _postLogFilterOptions(groups: IBranchFilterGroups): void {
    if (!this.hasView()) {
      return;
    }
    this.postToWebview({ type: 'logFilterOptionsReady', branchGroups: groups });
  }

  /**
   * Fetch the distinct commit authors for the active repo and post them to the
   * User popup. Lazy: only fired when the User popup opens (avoids a load-time
   * `git shortlog`). Silent no-op when no repo or service is attached.
   */
  private async _handleRequestAuthorOptions(): Promise<void> {
    const repo = this.getSelectedRepository();
    const gitService = this._attachedGitService;
    if (!repo || !gitService || !this.hasView()) {
      return;
    }
    const authors = await gitService.getLogContributors(repo).catch(() => []);
    // The "me" preset identity (UserFilterPopupComponent parity). The lookup
    // lives on the concrete GitService, not the frozen IGitService (ADR-001),
    // so reach it duck-typed; absence or failure just omits the preset.
    let me: string | undefined;
    const identitySource = gitService as unknown as {
      getConfiguredUserIdentity?: (r: IRepository) => Promise<string | undefined>;
    };
    if (typeof identitySource.getConfiguredUserIdentity === 'function') {
      me = await identitySource.getConfiguredUserIdentity(repo).catch(() => undefined);
    }
    if (!this.hasView()) {
      return;
    }
    this.postToWebview({ type: 'authorOptionsReady', authors, me });
  }

  /**
   * Handle commit selection in Log view
   */
  private _handleCommitSelection(commitHash: string, viaHashLink = false): void {
    // A hash from a commit message is usually abbreviated, while selection
    // matches full object names — expand it against the loaded graph first.
    const target = this._expandCommitHashPrefix(commitHash);
    this.selectCommit(target);
    if (viaHashLink) {
      // The link's target is almost never the row the user is looking at, so
      // selecting alone leaves it off-screen and the jump reads as a no-op.
      // (vcs-log CommitPresentationUtil navigates as well as selects.)
      this.scrollToCommit(target);
    }
  }

  /**
   * Expand an abbreviated hash against the loaded graph.
   *
   * In a merged multi-root window a short prefix can match commits in more
   * than one root; the one in the same root as the commit whose message
   * carries the link wins, as CommitPresentationUtil.parseTargetCommit does
   * before falling back to the first match.
   */
  private _expandCommitHashPrefix(commitHash: string): string {
    const prefix = commitHash.toLowerCase();
    const matches = this._extendedLogState.commitNodes.filter((n) =>
      n.commit.hash.toLowerCase().startsWith(prefix)
    );
    if (matches.length === 0) {
      return commitHash;
    }
    const expanded = this._extendedLogState.expandedCommit;
    const preferredRoot = expanded ? this.repoScope.getRepoRootForCommit(expanded) : undefined;
    const sameRoot =
      preferredRoot === undefined
        ? undefined
        : matches.find(
            (n) =>
              (n.commit.repoRoot ?? this.repoScope.getRepoRootForCommit(n.commit.hash)) ===
              preferredRoot
          );
    return (sameRoot ?? matches[0]).commit.hash;
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
    this.focus.handleBranchClick(branchName);
  }

  /**
   * Navigate the graph to a specific commit hash — the tag-row analog of
   * {@link navigateToBranch} (tags aren't in the branch map, so the tree
   * hands over the tag's peeled commit directly). Same partial-update
   * contract as `_handleBranchClick`: selectCommit + scroll posts, never a
   * full re-render, so the panel's scroll position survives. A hash beyond
   * the loaded window is a silent no-op, matching branch clicks whose tip
   * isn't loaded.
   */
  public navigateToCommit(commitHash: string): void {
    if (!commitHash) {
      return;
    }
    this.selectCommit(commitHash);
    this._scrollWebviewToCommit(commitHash);
  }

  /**
   * Focus the graph on a branch (or clear it with `null`). Thin delegate over
   * {@link BranchFocusController.setFocusedBranch}, which owns the flow: tip
   * resolution, the merge-base BFS with its post-await staleness guard, the
   * ADR-009 render-fire-post ordering, and the non-selecting tail scroll.
   */
  public async setFocusedBranch(branchName: string | null): Promise<void> {
    return this.focus.setFocusedBranch(branchName);
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
    if (!this.hasView()) {
      return;
    }
    const matched = this._extendedLogState.commitNodes.some((n) => n.commit.hash === hash);
    if (!matched) {
      return;
    }
    this.log.setScrollTarget(hash);
    this.postToWebview({
      type: 'scrollToCommit',
      commitHash: hash,
    });
  }

  // IGtwControllerContext — fire-only access to the load-more emitter, so
  // extracted handlers can request more commits without reaching the emitter
  // object (which would also expose subscribe + dispose).
  fireLoadMoreCommits(): void {
    this._onDidRequestLoadMoreCommits.fire();
  }

  // IGtwControllerContext — apply new panel widths. Owns the write + persist
  // as one atomic operation so extracted handlers never touch _workspaceState
  // and can't update the widths without persisting them.
  setPanelWidths(widths: [number, number]): void {
    // Clamp into the valid layout band first (mirrors _handleColumnResize): an
    // extreme value from a rogue/bug-mutated webview must never collapse a
    // panel and brick the current session's layout.
    const clamped = clampPanelWidthRatios(widths);
    this._panelWidths = clamped;

    // Persist the clamped value (not the rogue input) if state is available.
    if (this._workspaceState) {
      savePanelWidths(this._workspaceState, clamped);
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
   * Thin delegates over {@link repoScope} — the wide legacy entry points the
   * extension wiring and the white-box test surface call. The cluster's
   * behavior and full documentation live on {@link RepoScopeModel}.
   */
  public setAvailableRepositories(repos: IRepository[]): void {
    this.repoScope.setAvailableRepositories(repos);
  }

  public getSelectedRepository(): IRepository | undefined {
    return this.repoScope.getSelectedRepository();
  }

  public isAllReposSelected(): boolean {
    return this.repoScope.isAllReposSelected();
  }

  public getVisibleRepoRoots(): string[] | null {
    return this.repoScope.getVisibleRepoRoots();
  }

  public getVisibleRepositories(): IRepository[] {
    return this.repoScope.getVisibleRepositories();
  }

  public getRepoRootForCommit(hash: string): string | undefined {
    return this.repoScope.getRepoRootForCommit(hash);
  }

  public resolveCommitRepoPin(hash: string): string | undefined {
    return this.repoScope.resolveCommitRepoPin(hash);
  }

  /**
   * Record the HEAD commit hashes of every root shown in the merged "all
   * roots" log. Called by the multi-root loader immediately after
   * {@link updateLogState} (which clears the set). Lets `undoCommit` stay
   * enabled in merged scope for a clicked commit that is its own repo's HEAD,
   * even though the single-repo HEAD spine / highlight is suppressed.
   */
  public setMergedHeadCommitHashes(hashes: Iterable<string>): void {
    this.log.setMergedHeads(hashes);
  }

  /**
   * Rebuild the follower's document — the meaning of "content changed"
   * everywhere. Undocked, that is the panel (plus ensuring the sidebar carries
   * its placeholder); docked, it is the sidebar view. GitToolWindowProvider
   * produces a full `<!DOCTYPE html>…</html>` document via
   * {@link _getHtmlContent}, which delegates to {@link _getThreePanelHtmlContent}
   * (public for tests, owns its own CSP envelope), so we assign it directly
   * instead of re-templating in the base. Guards `_disposed` itself since it
   * renders hosts the base class doesn't know about.
   *
   * The sole exception is the resolve path — {@link _renderOnResolve} — which
   * must NOT rewrite the panel while undocked (a sidebar lifecycle event does
   * not change panel content and would reload the visible panel for nothing).
   */
  protected override _render(): void {
    if (this._disposed) {
      return;
    }
    const panel = this._panel;
    if (panel) {
      // A hidden panel is retained but off-screen; defer the rebuild until it
      // is revealed so background git events don't churn its document.
      if (panel.visible) {
        panel.webview.html = this._getHtmlContent(panel.webview);
        this._panelRenderPending = false;
      } else {
        this._panelRenderPending = true;
      }
      this._renderSidebarPlaceholder();
      return;
    }
    const view = this._view;
    if (!view) {
      return;
    }
    view.webview.html = this._getHtmlContent(view.webview);
  }

  /**
   * Resolve-time render override. While undocked the resolving sidebar only
   * needs its static placeholder — the panel's content is unaffected by
   * sidebar lifecycle, and rewriting it here would reload the visible panel.
   * Docked, this is a plain {@link _render}. Keeping the panel-skip here (not
   * in `_render`) means `_render` stays "rebuild content everywhere" and the
   * resolve path is the structural special case.
   */
  protected override _renderOnResolve(): void {
    if (this._panel) {
      this._renderSidebarPlaceholder();
      return;
    }
    this._render();
  }

  /**
   * Write the static undocked placeholder into the sidebar, once per sidebar
   * webview instance — reassigning it on every render would reload the
   * sidebar iframe for no content change. Guards `_disposed` itself so every
   * caller (render paths + the resolve path) shares one owner for the check.
   */
  private _renderSidebarPlaceholder(): void {
    if (this._disposed) {
      return;
    }
    const view = this._view;
    if (!view || this._placeholderWebview === view.webview) {
      return;
    }
    view.webview.html = buildUndockedPlaceholderHtml(this, view.webview);
    this._placeholderWebview = view.webview;
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

    // The expanded commit's details come from the same builder every other
    // conversion site uses, so the render path cannot drop a field the panel
    // reads (a hand-built literal without committer/commitDate silently lost
    // the "Committed by" line on every re-render).
    const commitDetails = this.getExpandedCommitDetails();

    return this._getThreePanelHtmlContent(
      webview,
      commitNodes,
      commitDetails,
      this._panelWidths,
      selectedCommits,
      commitNodes.length,
      // Honest total from `git rev-list --count`; falls back to "all loaded"
      // so a missing count never leaves the loaded indicator spinning.
      this.log.getTotal() ?? commitNodes.length
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
    // One-shot: taken here so the target only steers this render.
    const scrollTarget = this.log.consumeScrollTarget();
    const graphPanelHtml = this._getGraphPanelHtml(
      commitNodes,
      selectedCommits,
      loadedCount,
      totalAvailable,
      scrollTarget
    );
    // The Details Panel is built client-side via createElement from this model;
    // #details-panel ships empty and the inline script fills it on load. The
    // model comes from the same selection-driven source the message path uses,
    // so a full re-render cannot repaint an N-commit selection as one commit
    // or undo the empty-selection placeholder.
    const detailsPanelModel = buildSelectionDetailsModel(this, commitDetails);
    // True only while `_renderForGesture` is on the stack.
    const restoreFocus = this._restoreFocusOnNextRender;

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
    <div id="details-panel" class="panel" style="width: ${detailsWidth}%;" role="region" aria-label="Details Panel"></div>
    ${commitContextMenuHtml}
    ${buildFileContextMenuHtml()}
    <div id="ref-popup" class="context-menu" hidden role="menu" aria-label="Branches at this commit"></div>
  </div>`;

    // When the tabbed-layout flag is ON, wrap the Log body with the tab
    // strip + stubbed panel shells. When the flag is OFF, emit exactly
    // the pre-refactor HTML so users see zero UI change.
    const flagOn = isTabbedGitToolWindowEnabled();
    const historyState = this._historyTab?.getState();
    const incomingState = this._incomingTab?.getState();
    const historyActive = flagOn && this._tabRouter.getActiveTab() === 'history';
    // History tab details reuse the Log page's panel model + client renderer.
    const historyDetailsModel =
      historyActive && historyState ? this._getHistoryDetailsPanelModel(historyState) : null;
    const bodyMarkup = flagOn
      ? wrapTabbedBody({
          activeTab: this._tabRouter.getActiveTab(),
          logBodyHtml: logBody,
          consoleBodyHtml: renderConsoleTabBody(this._consoleEntries),
          incomingBodyHtml: renderIncomingTabBody(incomingState),
          updateInfoBodyHtml: renderUpdateInfoTabBody(this._updateInfoTab?.getState()),
          historyBodyHtml: renderHistoryTabBody(historyState),
        })
      : logBody;

    const extraStyles = flagOn ? toolWindowTabStyles() : '';

    // / HIG — codicon font loader. Without a `@font-face`
    // declaration that points to the actual TTF, the `<i class="codicon">`
    // glyphs we emit on every chip render as empty-box "tofu" — the WCAG
    // 1.4.1 non-color affordance (snap-12f/12g) silently fails. The
    // shared helper computes the asWebviewUri() form of the bundled
    // `media/codicon.ttf` and emits the @font-face + .codicon utility
    // rules. CSP is widened to allow font-src from the webview's
    // cspSource so the same-origin font URI resolves.
    const codiconFontCss = this._getCodiconFontFaceStyles(webview);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${buildWebviewCsp(webview.cspSource, nonce)}">
  <title>Git Tool Window</title>
  <style>
    ${codiconFontCss}
    ${this._getThreePanelStyles()}
    ${extraStyles}
  </style>
</head>
<body>
${bodyMarkup}
${initIslandHtml({ initialDetails: detailsPanelModel, historyDetails: historyDetailsModel, restoreFocus })}

  <script nonce="${nonce}" src="${this.getWebviewBundleUri(webview)}"></script>
</body>
</html>`;
  }

  // IGtwControllerContext — log-dispatch capabilities. Each delegates to the
  // in-class impl (or emitter) so provider state and emitters stay
  // encapsulated and instance methods remain patchable by tests.
  commitSelection(hash: string, viaHashLink: boolean): void {
    this._handleCommitSelection(hash, viaHashLink);
  }

  applyLogFilter(webviewFilter: IWebviewLogFilter | null): void {
    this._handleApplyLogFilter(webviewFilter);
  }

  setSearchDraft(text: string | undefined): void {
    this._searchDraft = text;
  }

  requestLogFilterOptions(): Promise<void> {
    return this._handleRequestLogFilterOptions();
  }

  requestAuthorOptions(): Promise<void> {
    return this._handleRequestAuthorOptions();
  }

  clearEmptyVisibleRepoScope(): void {
    this.repoScope.clearEmptyVisibleRepoScope();
  }

  branchClick(branchName: string): void {
    this.focus.handleBranchClick(branchName);
  }

  columnResize(widths: [number, number]): void {
    this._handleColumnResize(widths);
  }

  visibleRepositoriesSelection(roots: string[]): void {
    this.repoScope.handleVisibleRepositoriesSelection(roots);
  }

  fireLogContextAction(payload: {
    action: LogContextAction;
    commitHashes: string[];
    commitNodes: readonly IMenuStateNode[];
  }): void {
    this._onDidRequestLogContextAction.fire(payload);
  }

  fireCommitDiffRequest(payload: { commitHash: string; filePath: string }): void {
    this._onDidRequestCommitDiff.fire(payload);
  }

  getHistoryCommitHashes(): string[] {
    return (this._historyTab?.getState().commits ?? []).map((c) => c.hash);
  }

  // IGtwControllerContext — pure pass-throughs that expose the slice the
  // extracted builder modules need without handing them the concrete class.
  getNonce(): string {
    return this._getNonce();
  }

  getInlineStyles(): string {
    return this._getInlineStyles();
  }

  getWebviewBundleUri(webview: vscode.Webview): string {
    return webview
      .asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'webview', 'gitToolWindow.js'))
      .toString();
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
   * {@link buildCodiconFontFaceStyles} (in provider/codiconFontStyles.ts), passing the
   * provider-owned extension URI so the font URI resolution stays out of the
   * builder while the byte-for-byte CSS lives next to the other styles.
   */
  private _getCodiconFontFaceStyles(webview: vscode.Webview): string {
    return buildCodiconFontFaceStyles(this._extensionUri, webview);
  }

  /**
   * Two-panel layout CSS for the webview. Thin forwarder to
   * {@link buildThreePanelStyles} (in provider/stylesBuilder.ts).
   */
  private _getThreePanelStyles(): string {
    return buildThreePanelStyles();
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
   * Per-render props for the extracted graph-panel/filter-row builders
   * (provider/logPanelHtml.ts): the live extended log state plus the scope,
   * layout, and settings values the builders read.
   */
  private _logPanelProps(preserveScroll = false): ILogPanelProps {
    return {
      state: this._extendedLogState,
      searchDraft: this._searchDraft,
      searchModeUi: this._searchModeUi,
      availableRepositories: this.repoScope.getAvailableRepositories(),
      visibleRepoRoots: this.repoScope.getVisibleRepoRoots(),
      repositoryScope: this.repoScope.getRepositoryScope(),
      selectedRepositoryIndex: this.repoScope.getSelectedRepositoryIndex(),
      columnWidths: this._columnWidths,
      trunkBranchNames: this.repoScope.trunkBranchNamesForScope(),
      showLongEdges: this._isShowLongEdgesEnabled(),
      showGpgColumn: this._isShowGpgColumnEnabled(),
      showRootColumn:
        this._isShowAllRootsEnabled() && this.repoScope.getAvailableRepositories().length > 1,
      showRootNames: this._isShowRootNamesEnabled(),
      preserveScroll,
    };
  }

  /**
   * Build the graph panel document body. Thin delegate over
   * {@link buildGraphPanelHtml}; consumes the one-shot scroll-reset flag here
   * so the flag's write stays with its owner.
   *
   * @internal Public for direct snapshot/DOM tests.
   */
  public _getGraphPanelHtml(
    commitNodes: ICommitNode[],
    selectedCommits?: Set<string>,
    loadedCount?: number,
    totalAvailable?: number,
    scrollToCommitHash?: string
  ): string {
    const preserveScroll = !this.log.consumeResetScroll();
    return buildGraphPanelHtml(
      commitNodes,
      selectedCommits,
      loadedCount,
      totalAvailable,
      scrollToCommitHash,
      this._logPanelProps(preserveScroll)
    );
  }

  /** @internal Public for direct snapshot/DOM tests. */
  public _getLogFilterRowHtml(): string {
    return buildLogFilterRowHtml(this._logPanelProps());
  }

  /** @internal Public for direct snapshot/DOM tests. */
  public _getEmptyGraphPanelHtml(): string {
    return buildEmptyGraphPanelHtml(this._logPanelProps());
  }

  /**
   * Branch/tag chip labels for a commit row. Thin delegate over
   * {@link buildBranchLabelsHtml}.
   *
   * @internal Public for direct snapshot tests (snap-7a..7e).
   */
  public _getBranchLabelsHtml(
    node: ICommitNode,
    branchColors?: ReadonlyMap<string, string>
  ): string {
    return buildBranchLabelsHtml(node, branchColors, this._extendedLogState);
  }

  /**
   * Get the commit context menu HTML overlay for the Graph Panel.
   * Renders a context menu with all 7 required options:
   * Copy Revision Number, Create Patch, Cherry-Pick, Checkout Revision,
   * Show Repository at Revision, Compare with Local, Reset Current Branch to Here,
   * Revert Commit, Undo Commit, Drop Commit, Edit Commit Message…,
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
   * @returns the details-panel render-model (built into DOM client-side)
   */
  public _getDetailsPanelModel(commitDetails: ICommitDetails): DetailsPanelModel {
    return buildDetailsPanelModel(this, commitDetails);
  }

  /**
   * Build the Details Panel model for the History tab's selected revision,
   * reusing the SAME model + renderer as the Log page (single source of truth
   * for the commit-details format). The affected paths double as the changed
   * files; the panel shows them in the same tree as the Log.
   */
  private _getHistoryDetailsPanelModel(state: IHistoryTabState): DetailsPanelModel {
    const commit = state.selectedCommit
      ? state.commits.find((c) => c.hash === state.selectedCommit)
      : undefined;
    if (!commit) {
      return buildDetailsPanelPlaceholderModel();
    }
    const commitDetails: ICommitDetails = {
      ...commitToBaseDetails(commit),
      changedFiles: state.affectedPathsError
        ? []
        : state.affectedPaths.map((p) => ({ path: p.path, status: p.status, oldPath: p.oldPath })),
      changedFilesError: state.affectedPathsError,
      containingBranches: state.containingBranches,
    };
    return this._getDetailsPanelModel(commitDetails);
  }

  /**
   * Build the Details Panel render-model when multiple commits are selected.
   * Carries a header count, the per-commit short-hash/summary list, and the
   * combined changed-files tree (deduplicated by path, most-recent status kept).
   *
   * Each entry carries its own loaded files; the builder merges them.
   *
   * @param commitDetailsList - Array of commit details for the selected commits
   * @returns the multi-commit details-panel render-model
   */
  public _getMultiCommitDetailsPanelModel(commitDetailsList: ICommitDetails[]): DetailsPanelModel {
    return buildMultiCommitDetailsPanelModel(
      commitDetailsList,
      this.getSelectedRepoProject(),
      this.details.getMultiSelectionLoaded(),
      this.getDetailsGroupBy()
    );
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
   * Check whether the `intellig.commitMessageIssueLinks` feature
   * flag is enabled. Default is `true` (set in package.json contributions).
   * When the flag is off, the details panel renders commit messages with
   * plain HTML-escape and no clickable issue links.
   */
  private _isIssueLinkingEnabled(): boolean {
    try {
      return readConfig('commitMessageIssueLinks');
    } catch {
      // Getting configuration shouldn't throw in practice, but if it does
      // we prefer to keep the flag on so the feature stays visible.
      return true;
    }
  }

  /**
   * Check whether the `intellig.log.showGpgColumn` feature flag is enabled.
   * Default is `false` — the column is opt-in because most repos aren't
   * GPG-signed and the column would always be empty. When enabled, each
   * commit row shows the %G? status glyph (G5 parity).
   */
  private _isShowGpgColumnEnabled(): boolean {
    try {
      return readConfig('log.showGpgColumn');
    } catch {
      return false;
    }
  }

  /**
   * Whether `intellig.log.showLongEdges` is on — IntelliJ's "Show Long Edges".
   * Off by default: the graph hides the middle of edges longer than 30 rows and
   * caps them with arrows, so a merge-heavy history keeps the graph column
   * narrow. On restores full-length edges.
   */
  private _isShowLongEdgesEnabled(): boolean {
    try {
      return readConfig('log.showLongEdges');
    } catch {
      return false;
    }
  }

  /**
   * Check whether `intellig.log.showRootNames` is enabled — IntelliJ's "Show
   * Root Names": the root column widens from the default color stripe to the
   * repo basename painted on that color. Off by default; meaningful only when
   * the root column itself is shown.
   */
  private _isShowRootNamesEnabled(): boolean {
    try {
      return readConfig('log.showRootNames');
    } catch {
      return false;
    }
  }

  /**
   * Whether the merged "all roots" view is active. Derives from the runtime
   * {@link _repositoryScope} so the repository selector is the single source
   * of truth: when scope is `'all'` (and multiple repos exist) the log merges
   * commits from every workspace repo and shows a Root column (G8). The
   * `intellig.log.showAllRoots` config now only seeds the initial default
   * (see {@link _resolveRepositoryScope}); it no longer gates the view at
   * render time.
   */
  public _isShowAllRootsEnabled(): boolean {
    return this.repoScope.isAllReposSelected();
  }

  /**
   * Read the `intellig.log.showAllRoots` config flag (default `true`, matching
   * the branch view which shows all repositories by default). Used once to seed
   * the initial repository scope; thereafter the runtime scope (driven by the
   * selector) is authoritative.
   */
  private _isShowAllRootsConfigEnabled(): boolean {
    try {
      return readConfig('log.showAllRoots');
    } catch {
      // Defensive: on a config-read failure, degrade to single-repo scope.
      return false;
    }
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
    return this.repoScope.getSelectedRepoRemote();
  }

  /** How the details panel currently groups changed files. */
  public getDetailsGroupBy(): DetailsGroupBy {
    return this.details.getGroupBy();
  }

  /**
   * Switch how the details panel groups changed files, persisting the choice
   * so it survives a reload, then re-render the panel.
   */
  public setDetailsGroupBy(mode: DetailsGroupBy): void {
    if (!this.details.setGroupBy(mode)) {
      return;
    }
    if (this._workspaceState) {
      saveDetailsGroupBy(this._workspaceState, mode);
    }
    this.postDetailsForExpandedCommit();
  }

  /**
   * Whether a hex run from a commit message names a commit in the LOADED
   * graph window. Only such runs become clickable refs, so an ordinary hex
   * word (a colour, a digest) never looks like a link; a real commit outside
   * the loaded window stays plain until it loads.
   */
  public isKnownCommitHash(hash: string): boolean {
    const prefix = hash.toLowerCase();
    return this._extendedLogState.commitNodes.some((node) =>
      node.commit.hash.toLowerCase().startsWith(prefix)
    );
  }

  /**
   * Controller-context view over the selected repository's display identity —
   * its root basename and home-abbreviated root path — for the changed-files
   * heading. Undefined when no repository is selected.
   */
  public getSelectedRepoProject(): { name: string; path: string } | undefined {
    return this.repoScope.getSelectedRepoProject();
  }
}

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
// TODO: fold WaveAInboundMessage / WaveBInboundMessage / WaveCInboundMessage
// into a single discriminated union `WebviewInboundMessage` so the
// `_handleWebviewMessage` switch is exhaustively-checkable.
export type WaveAInboundMessage =
  // The click anchor travels WITH the message.
  // The host trusts the message anchor for this single operation rather
  // than consulting its own cache, which can be stale by one render.
  // ADR-009 section 3 documents the exception.
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

export type { IWebviewMessage, IBranchFilterGroups } from './gitToolWindow.wireTypes';

// Nonce generation is owned by `BaseWebviewView._getNonce()`, which
// delegates to the shared `generateNonce()` helper in `utils/webviewNonce.ts`
// so every IntelliG webview produces nonces with identical shape + entropy.
// All three HTML emitters in this file call `this._getNonce()` directly;
// the former module-local `getNonce()` has been removed.
