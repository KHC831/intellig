/**
 * Commit Tool Window.
 *
 * A `WebviewViewProvider` that renders the IntelliJ-style Commit tool window
 * inside the `intellig` panel container. Two tabs — **Local Changes** (which
 * shows the changelist tree) and **Shelf** (list + diff preview) — with a
 * commit composer below the Local-Changes tab.
 *
 * Ships behind the `intellig.useCommitToolWindow` configuration flag (default
 * `false`). When the flag is off, users see zero change: the existing
 * {@link CommitDialog} modal continues to be the commit surface.
 *
 * - Tabbed layout, active tab persisted per-workspace.
 * - Local Changes tab wired to {@link IChangelistService}.
 * - Shelf tab wired to {@link IShelfService} (list + basic actions).
 * - Commit composer with amend / sign-off checkboxes.
 * - Primary-button dropdown: `Commit` / `Commit and Push`.
 * - Message-history dropdown (workspaceState LRU, 20 entries, deduped).
 * - Gear menu skeleton (disabled items, tooltip "coming soon").
 * - `intellig.changelist.*` command set registered by extension.ts.
 *
 * All long string/HTML builders are extracted as pure exports below so unit
 * tests can exercise them without a VS Code host.
 */

import * as vscode from 'vscode';
import { readConfig } from '../config/configKeys';
import { loadPersisted, savePersisted } from '../utils/persistedState';
import {
  IChangelist,
  IFileChange,
  IChangelistService,
} from '../changelists/interfaces/IChangelistService';
import { IShelfItem, IShelfService } from '../shelf/interfaces/IShelfService';
import {
  handleShelfTabAction,
  type IShelfTabShelfController,
  type IShelfTabStashController,
} from './shelfTab';
import { handleChangelistAction, openFileDiffSurface } from './changelistTab';
import { countConflictRegionsPerFile } from './ctwConflictCounts';
import { commitToolWindowStyles } from './commitToolWindowStyles';
import {
  ACTIVE_TAB_SLOT,
  isChangesGroupingMode,
  isShelfTabFilter,
  CHANGES_GROUPING_SLOT,
  RECENT_MESSAGES_SLOT,
  SHELF_TAB_FILTER_SLOT,
  SIGN_OFF_SLOT,
} from './ctwPersistedSlots';
export {
  ACTIVE_TAB_SLOT,
  ACTIVE_TAB_STATE_KEY,
  CHANGES_GROUPING_SLOT,
  CHANGES_GROUPING_STATE_KEY,
  RECENT_MESSAGES_SLOT,
  RECENT_MESSAGES_STATE_KEY,
  SHELF_TAB_FILTER_SLOT,
  SHELF_TAB_FILTER_STATE_KEY,
  SIGN_OFF_SLOT,
  SIGN_OFF_STATE_KEY,
  isChangesGroupingMode,
  isShelfTabFilter,
} from './ctwPersistedSlots';

import { buildShelfTabEntries } from './shelfTab';
import { buildCommitToolWindowInitModel } from './ctwInitModel';
export { buildCommitToolWindowInitModel } from './ctwInitModel';
export type { IRenderInput } from './ctwInitModel';
import type { IRenderInput } from './ctwInitModel';
export { buildShelfTabEntries, gearMenuItems } from './shelfTab';
export { changelistContextMenuLabels, fileContextMenuLabels } from './changelistTab';
export {
  type IShelfTabShelfController,
  type IShelfTabStashController,
  shelfRowContextMenuLabels,
  stashRowContextMenuLabels,
} from './shelfTab';
import { IGitService, IRepository, IStash, FileStatus } from '../git-core/interfaces/IGitService';
import { performCommit, LAST_NO_VERIFY_SLOT } from './CommitDialog';
import { AmendMessageTracker, loadHeadCommitMessage } from './amendMessage';
import { runBeforeCommitChecks } from './CheckinChecks';
import { CtwRepoTarget } from './ctwRepoTarget';
import { isStaleForTarget } from './ctwRetargetGuard';
import { initIslandHtml } from '../utils/webviewInit';
import { BaseWebviewView } from '../utils/BaseWebviewView';
import { assertNever } from '../utils/assertNever';
import {
  asCommitToolWindowInbound,
  type CommitToolWindowOutbound,
} from './commitToolWindow.protocol';
import { safeFireAndForget } from '../utils/safeFireAndForget';
import { fingerprintCtwModel } from './ctwModelFingerprint';
import { sanitizeGitError } from '../git-core/gitError';
import type {
  CommitToolWindowTab,
  ShelfTabFilter,
  ChangesGroupingMode,
  ICommitToolWebviewMessage,
} from './commitToolWindow.types';

// The pure wire shapes + render model live in the vscode-free
// `./commitToolWindow.types` module so the protocol + the bundled webview entry
// can type-import them. Re-exported so existing importers (and the
// `src/services` barrel) keep resolving them from this file.
export type {
  CommitToolWindowTab,
  ShelfTabFilter,
  ChangesGroupingMode,
  IShelfTabEntry,
  ChangelistAction,
  FileAction,
  ShelfTabShelfAction,
  ShelfTabStashAction,
  ICommitToolWebviewMessage,
} from './commitToolWindow.types';

export const COMMIT_TOOL_WINDOW_VIEW_ID = 'intellig.commitToolWindow';

/** Config flag — when true, the new Commit tool window is exposed to users. */
export const COMMIT_TOOL_WINDOW_CONFIG_KEY = 'useCommitToolWindow';

/** Maximum size of the recent-commit-messages LRU. */
export const RECENT_MESSAGES_MAX = 20;

/**
 * Trailing-coalescer window for live pushes. Matches ChangelistService's
 * reconcile debounce so a reconcile burst costs one push; upstream lanes
 * (250 ms repo watcher, 1 s/5 s status lane) debounce independently.
 */
const LIVE_UPDATE_DEBOUNCE_MS = 300;

export {
  UNVERSIONED_PSEUDO_CHANGELIST_ID,
  groupFilesByDirectory,
  partitionUnversionedFiles,
  shortStatusChar,
  type IChangesTreeDirNode,
} from './ctwChangesTree';

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (tested directly)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Push a commit message onto the front of the LRU, deduplicate existing
 * entries, and cap at {@link RECENT_MESSAGES_MAX}. Pure — returns a new array.
 */
export function updateRecentMessagesLru(existing: readonly string[], message: string): string[] {
  const trimmed = message.trim();
  if (!trimmed) {
    return [...existing];
  }
  const deduped = existing.filter((m) => m !== trimmed);
  return [trimmed, ...deduped].slice(0, RECENT_MESSAGES_MAX);
}

/**
 * Sort changelists for display — default first, then active, then the rest by
 * name ascending. Pure.
 */
export function sortChangelistsForDisplay(changelists: readonly IChangelist[]): IChangelist[] {
  return [...changelists].sort((a, b) => {
    if (a.isDefault && !b.isDefault) {
      return -1;
    }
    if (!a.isDefault && b.isDefault) {
      return 1;
    }
    return a.name.localeCompare(b.name);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CommitToolWindow
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Implementation.
 *
 * The class owns a single `WebviewView` (provided by VS Code when the user
 * focuses the sidebar view). It coordinates with:
 *
 *   - {@link IChangelistService} for the Local Changes tab.
 *   - {@link IShelfService} for the Shelf tab.
 *   - {@link performCommit} for commits (shared with `CommitDialog`).
 */
export class CommitToolWindow extends BaseWebviewView<CommitToolWindowOutbound> {
  public static readonly viewId = COMMIT_TOOL_WINDOW_VIEW_ID;

  private _activeTab: CommitToolWindowTab = 'localChanges';
  private _amend = false;
  private readonly _amendTracker = new AmendMessageTracker();
  private _signOff = false;
  /** Re-entrancy guard: true while a commit is in flight (blocks double-submit). */
  private _committing = false;
  private _composerMessage = '';

  /** Sticky target repository — see {@link CtwRepoTarget}. */
  private readonly _repoTarget: CtwRepoTarget;

  private _changelists: IChangelist[] = [];
  private _shelfItems: IShelfItem[] = [];
  /** Most recent `git stash list` snapshot. */
  private _stashEntries: IStash[] = [];
  /** Trailing coalescer for {@link _pushLiveUpdate} (service-event bursts). */
  private _liveUpdateTimer: ReturnType<typeof setTimeout> | undefined;
  /** Conflict-region count per unmerged path, refreshed on every push. */
  private _conflictRegionCounts: Map<string, number> = new Map();
  /** Fingerprint of the last pushed model; reset on every resolve. */
  private _lastPushedFingerprint = '';
  /** Delivery result of the last live post; drives visibility redelivery. */
  private _lastPostDelivered = true;
  /** Active Shelf-tab filter, persisted to workspaceState. */
  private _shelfTabFilter: ShelfTabFilter = 'both';
  /** Local Changes file-grouping mode, persisted to workspaceState. */
  private _changesGrouping: ChangesGroupingMode = 'directory';
  private _selectedFiles: Set<string> = new Set();
  /** Absolute URI of the last Local-Changes row the user selected (F4 target). */
  private _lastSelectedFileUri: vscode.Uri | undefined;
  /**
   * Active-changelist paths already OFFERED to the inclusion (whether or not
   * still selected) — the reference's `knownActiveChanges`. Auto-inclusion
   * only adds paths not in this set, so an explicit user uncheck survives
   * live updates.
   */
  private _knownActiveFiles: Set<string> = new Set();

  private readonly _onDidCommit = new vscode.EventEmitter<{
    repo: IRepository;
    message: string;
    files: string[];
  }>();
  public readonly onDidCommit = this._onDidCommit.event;

  /**
   * Imperative controllers for Shelf/Stash row actions. Injected in
   * extension.ts to avoid importing ShelfView / StashView into this module.
   * Both default to no-op so unit tests + feature-flag-off shipping are safe.
   */
  private _shelfController: IShelfTabShelfController = {};
  private _stashController: IShelfTabStashController = {};

  constructor(
    extensionUri: vscode.Uri,
    private readonly _gitService: IGitService,
    private readonly _changelistService: IChangelistService,
    private readonly _shelfService: IShelfService,
    private readonly _workspaceState: vscode.Memento
  ) {
    super(extensionUri);
    this._repoTarget = new CtwRepoTarget(_gitService);
    // Restore persisted active tab (defaults to localChanges).
    const persistedTab = loadPersisted(this._workspaceState, ACTIVE_TAB_SLOT);
    if (persistedTab !== undefined) {
      this._activeTab = persistedTab;
    }

    // Restore persisted Shelf-tab filter (defaults to 'both').
    const persistedFilter = loadPersisted(this._workspaceState, SHELF_TAB_FILTER_SLOT);
    if (persistedFilter !== undefined) {
      this._shelfTabFilter = persistedFilter;
    }

    // Restore persisted Local Changes grouping mode (defaults to 'directory',
    // matching IntelliJ's default ChangesGroupingPolicy).
    const persistedGrouping = loadPersisted(this._workspaceState, CHANGES_GROUPING_SLOT);
    if (persistedGrouping !== undefined) {
      this._changesGrouping = persistedGrouping;
    }

    // Restore the sticky Sign-off checkbox (defaults to off).
    const persistedSignOff = loadPersisted(this._workspaceState, SIGN_OFF_SLOT);
    if (persistedSignOff !== undefined) {
      this._signOff = persistedSignOff;
    }

    // Live-update triggers. Events are triggers ONLY: the coalesced push
    // re-reads the services for the resolved repo at push time, so a payload
    // from another repo can never cross-cache into this view. The repository
    // lane covers stash mutations (`refs/stash` + `logs/refs/stash` watchers)
    // exactly like IntelliJ's GIT_REPO_CHANGE → GitStashTracker refresh.
    this._disposables.push(
      this._changelistService.onDidChangeChangelists(() => this._scheduleLiveUpdate()),
      this._shelfService.onDidChangeShelf(() => this._scheduleLiveUpdate()),
      this._gitService.onDidChangeRepository(() => this._scheduleLiveUpdate()),
      this._onDidCommit
    );
  }

  /**
   * Wire the Shelf/Stash controllers. Called from extension.ts after
   * construction so tests can instantiate the window without stash/shelf
   * views. Safe to call multiple times — the last call wins.
   */
  public setShelfTabControllers(
    shelf: IShelfTabShelfController,
    stash: IShelfTabStashController
  ): void {
    this._shelfController = shelf;
    this._stashController = stash;
  }

  /**
   * Subclass hook for {@link BaseWebviewView.resolveWebviewView}. Base class
   * has already set webview options, wired `onDidReceiveMessage` →
   * {@link _handleMessage}, wired `onDidDispose`, and performed the initial
   * render via {@link _getBodyParts}. Here we kick an async reload of state.
   */
  protected override _onResolve(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    // A fresh document just rendered; the first push must always go through.
    this._lastPushedFingerprint = '';

    // Belt-and-braces redelivery: retainContextWhenHidden keeps hidden views
    // receiving posts, but if a post ever reports undelivered, re-push the
    // current model when the view becomes visible again.
    this._registerPerResolve(
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible && !this._lastPostDelivered) {
          this._lastPushedFingerprint = '';
          safeFireAndForget(
            this._pushLiveUpdate(),
            'CommitToolWindow._onResolve: redelivery push on visibility'
          );
        }
      })
    );

    // The base class already rendered an empty shell; kick the async state
    // load, which pushes the loaded changelists / shelf / stash once the
    // services respond. Bucket C: init path — a first-load reject leaves the
    // empty shell and self-heals on the next reload.
    safeFireAndForget(this._reloadState(), 'CommitToolWindow._onResolve: initial state reload');
  }

  /**
   * Bridge from the base class's generic `_handleMessage` hook to the
   * already-tested `_handleWebviewMessage` method. Keeps the message contract
   * strongly typed via {@link ICommitToolWebviewMessage} and leaves existing
   * unit tests (which drive `_handleWebviewMessage` directly) untouched.
   */
  protected _handleMessage(message: unknown): Promise<void> {
    return this._handleWebviewMessage(message as ICommitToolWebviewMessage);
  }

  /**
   * Programmatically focus the Commit tool window (Alt+0 target).
   */
  public async show(): Promise<void> {
    if (this._view) {
      this._view.show?.(true);
      return;
    }
    // Fallback: ask VS Code to focus the view by id.
    await vscode.commands.executeCommand(`${COMMIT_TOOL_WINDOW_VIEW_ID}.focus`);
  }

  public getActiveTab(): CommitToolWindowTab {
    return this._activeTab;
  }

  /**
   * Current Shelf-tab filter (persisted across sessions).
   */
  public getShelfTabFilter(): ShelfTabFilter {
    return this._shelfTabFilter;
  }

  /**
   * Programmatically change the Shelf-tab filter. Persists to workspaceState
   * + re-renders. Exposed as `public` so command palette entries (e.g. a
   * future "Shelf: Show Stashes Only") can toggle it.
   */
  public async setShelfTabFilter(filter: ShelfTabFilter): Promise<void> {
    if (this._shelfTabFilter === filter) {
      return;
    }
    this._shelfTabFilter = filter;
    await savePersisted(this._workspaceState, SHELF_TAB_FILTER_SLOT, filter);
    await this._pushLiveUpdate();
  }

  /** Current Local Changes grouping mode (persisted across sessions). */
  public getChangesGrouping(): ChangesGroupingMode {
    return this._changesGrouping;
  }

  /**
   * Change the Local Changes grouping mode (Flat / Directory). Persists to
   * workspaceState + re-renders. `public` so a palette command can toggle it.
   */
  public async setChangesGrouping(grouping: ChangesGroupingMode): Promise<void> {
    if (this._changesGrouping === grouping) {
      return;
    }
    this._changesGrouping = grouping;
    await savePersisted(this._workspaceState, CHANGES_GROUPING_SLOT, grouping);
    await this._pushLiveUpdate();
  }

  /**
   * Prefill the commit composer's message field. Used by Undo Commit to
   * restore the undone commit's message so the user can re-commit without
   * retyping it (IntelliJ GitUncommitAction parity). Ships on its own
   * outbound arm: an explicit user action that WRITES the composer, which the
   * live-update path never does (a live `updateModel` ignores composer state).
   */
  public prefillComposerMessage(message: string): void {
    this._composerMessage = message;
    void this.postMessage({ type: 'setComposerMessage', message });
  }

  /**
   * Amend checkbox flipped (reference AmendCommitHandlerImpl): entering amend
   * swaps HEAD's message into the composer (saving the draft); leaving amend
   * restores the draft unless the user edited the amend message. Both writes
   * ship on the explicit `setComposerMessage` arm.
   */
  private async _handleAmendToggled(amend: boolean): Promise<void> {
    const next = amend
      ? await this._amendTracker.enterAmend(this._composerMessage, async () =>
          loadHeadCommitMessage(this._gitService, await this._resolveRepo())
        )
      : this._amendTracker.exitAmend(this._composerMessage);
    if (next !== undefined) {
      this.prefillComposerMessage(next);
    }
  }

  /**
   * Read-only accessor for the recent-messages LRU. Exposed so the legacy
   * {@link CommitDialog} (or future callers) can reuse the same history.
   */
  public getRecentMessages(): string[] {
    return [...this._readRecentMessages()];
  }

  /** Chains to {@link BaseWebviewView.dispose} after stopping a pending push. */
  public override dispose(): void {
    if (this._liveUpdateTimer !== undefined) {
      clearTimeout(this._liveUpdateTimer);
      this._liveUpdateTimer = undefined;
    }
    super.dispose();
  }

  // ── Message handling ───────────────────────────────────────────────────

  private async _handleWebviewMessage(message: ICommitToolWebviewMessage): Promise<void> {
    // Runtime-reject an unknown/old type (forward-compat: an older webview
    // posting a since-removed type is dropped here); assertNever below is the
    // compile-time exhaustiveness gate over the known union.
    const msg = asCommitToolWindowInbound(message);
    if (!msg) {
      return;
    }
    if (isStaleForTarget(msg, (root) => this._repoTarget.isCurrent(root))) {
      return;
    }
    switch (msg.type) {
      case 'tabChange':
        if (msg.tab === 'localChanges' || msg.tab === 'shelf') {
          await this._setActiveTab(msg.tab);
        }
        break;
      case 'selectFile':
        if (msg.path) {
          await this._handleSelectFile(msg.path);
        }
        break;
      case 'openFileDiff':
        if (msg.path) {
          await this._handleOpenFileDiff(msg.path);
        }
        break;
      case 'toggleFile':
        if (msg.path) {
          this._handleToggleFile(msg.path);
        }
        break;
      case 'updateComposerField':
        if (typeof msg.message === 'string') {
          this._composerMessage = msg.message;
        }
        if (typeof msg.amend === 'boolean' && msg.amend !== this._amend) {
          this._amend = msg.amend;
          await this._handleAmendToggled(msg.amend);
        }
        if (typeof msg.signOff === 'boolean' && msg.signOff !== this._signOff) {
          this._signOff = msg.signOff;
          await savePersisted(this._workspaceState, SIGN_OFF_SLOT, msg.signOff);
        }
        break;
      case 'commit':
        await this._handleCommit(msg, /* push */ false);
        break;
      case 'commitAndPush':
        await this._handleCommit(msg, /* push */ true);
        break;
      case 'changelistContextAction':
        await this._handleChangelistAction(msg);
        break;
      case 'shelfTabFilterChange':
        if (isShelfTabFilter(msg.filter)) {
          await this.setShelfTabFilter(msg.filter);
        }
        break;
      case 'changesGroupingChange':
        if (isChangesGroupingMode(msg.grouping)) {
          await this.setChangesGrouping(msg.grouping);
        }
        break;
      case 'shelfTabContextAction':
        await this._handleShelfTabAction(msg);
        break;
      case 'resolveConflicts': {
        // The Resolve link on the Merge Conflicts header. Routed to the same
        // command the status-bar in-progress badge uses, so both entry points
        // land on one dialog that infers the operation from repository state.
        //
        // The sticky repo is passed explicitly. Without it the repo-scoped
        // spine falls back to the ACTIVE EDITOR, which in multi-root opens the
        // dialog on whatever repo the focused file belongs to rather than the
        // one whose rows are on screen — and the per-row Resolve beside it
        // already resolves through CtwRepoTarget.
        const target = await this._repoTarget.resolveForAction();
        await vscode.commands.executeCommand(
          'intellig.showResolveConflictsDialog',
          target?.rootUri
        );
        break;
      }
      case 'resolveConflictFile':
        // Per-row Resolve. Goes through the same Show Diff seam every row
        // uses, which routes an unmerged path to the merge window before it
        // ever builds a two-pane diff.
        if (msg.path) {
          await this._handleOpenFileDiff(msg.path);
        }
        break;
      case 'gearAction':
        if (msg.id === 'toggleNoVerify') {
          const next = !(loadPersisted(this._workspaceState, LAST_NO_VERIFY_SLOT) ?? false);
          await savePersisted(this._workspaceState, LAST_NO_VERIFY_SLOT, next);
          void this.postMessage({ type: 'setGearState', noVerify: next });
        }
        break;
      default:
        assertNever(msg);
    }
  }

  private async _setActiveTab(tab: CommitToolWindowTab): Promise<void> {
    if (this._activeTab === tab) {
      return;
    }
    this._activeTab = tab;
    await savePersisted(this._workspaceState, ACTIVE_TAB_SLOT, tab);
    await this._pushLiveUpdate();
  }

  /** Last Local-Changes selection, for the F4 / Jump to Source fallback. */
  get lastSelectedFileUri(): vscode.Uri | undefined {
    return this._lastSelectedFileUri;
  }

  private async _handleSelectFile(path: string): Promise<void> {
    if (this._activeTab !== 'localChanges') {
      return;
    }
    const repo = await this._resolveRepo();
    if (!repo) {
      return;
    }
    // Track the selection for F4 / Jump to Source: the keybinding invokes
    // localChanges.openFile with no argument and can't read the webview's
    // selection, so it falls back to this (IntelliJ EditSource semantics).
    this._lastSelectedFileUri = await this._resolveFileUri(path);
    // A fully-staged file (index carries the change, nothing further in the
    // working tree) has an EMPTY unstaged diff — the row's own `staged` flag
    // says which side of `git diff` actually holds the content.
    const staged = this._findFileChange(path)?.staged ?? false;
    try {
      const diff = await this._gitService.getDiff(repo, path, staged);
      void this.postMessage({ type: 'updateDiffPreview', path, diff });
    } catch (error) {
      void this.postMessage({
        type: 'updateDiffPreview',
        path,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Double-click on a Local Changes file row: open the full HEAD ↔ working-tree
   * diff in an editor tab. Single click only fills the inline preview pane, so
   * this is the gesture that gets the file onto a real editor — matching both
   * IntelliJ's Local Changes tree and the Source Control view.
   *
   * Routed through the row's own `Show Diff` menu action so the two entry
   * points can't drift apart.
   */
  private _handleOpenFileDiff(path: string): Promise<void> {
    if (this._activeTab !== 'localChanges') {
      return Promise.resolve();
    }
    return openFileDiffSurface({ resolveFileUri: (p) => this._resolveFileUri(p) }, path);
  }

  private _handleToggleFile(path: string): void {
    if (this._selectedFiles.has(path)) {
      this._selectedFiles.delete(path);
    } else {
      this._selectedFiles.add(path);
    }
    void this.postMessage({
      type: 'updateFileCheckbox',
      path,
      checked: this._selectedFiles.has(path),
    });
  }

  private async _handleCommit(message: ICommitToolWebviewMessage, push: boolean): Promise<void> {
    // Re-entrancy guard: a rapid second accept must not launch a second commit
    // while the first is still in flight.
    if (this._committing) {
      return;
    }
    this._committing = true;
    try {
      await this._handleCommitInner(message, push);
    } finally {
      this._committing = false;
    }
  }

  private async _handleCommitInner(
    message: ICommitToolWebviewMessage,
    push: boolean
  ): Promise<void> {
    const repo = await this._resolveRepo();
    if (!repo) {
      void vscode.window.showErrorMessage('No Git repository found');
      return;
    }

    const commitMessage = message.message ?? this._composerMessage;
    const selected = message.files ?? [...this._selectedFiles];

    // Build the all-files map from the changelist tree (everything except the
    // pseudo-unversioned bucket on the host side is considered staged-or-dirty).
    const allFiles = this._flattenFiles();

    // Run the before-commit checks unless `--no-verify` is persisted on
    // (shared workspaceState key with CommitDialog). `--no-verify` skips
    // both git's hooks and these IDE-side checks.
    const noVerify = loadPersisted(this._workspaceState, LAST_NO_VERIFY_SLOT) ?? false;
    if (!noVerify) {
      const proceed = await runBeforeCommitChecks(
        this._gitService,
        repo,
        selected,
        this._workspaceState
      );
      if (!proceed) {
        void this.postMessage({ type: 'commitDone', success: false });
        return;
      }
    }

    const result = await performCommit(this._gitService, repo, {
      message: commitMessage,
      selectedFiles: selected,
      allFiles,
      amend: message.amend ?? this._amend,
      signOff: message.signOff ?? this._signOff,
      noVerify,
    });

    if (!result.success) {
      // The webview renders nothing from this message beyond the flag — the
      // error itself is surfaced via the toast below.
      void this.postMessage({
        type: 'commitDone',
        success: false,
      });
      void vscode.window.showErrorMessage(
        result.error ? `Commit failed: ${sanitizeGitError(result.error)}` : 'Commit failed'
      );
      return;
    }

    // Persist to recent-messages LRU.
    await this._pushRecentMessage(commitMessage);

    // Fire the onDidCommit event so e.g. GitToolWindowProvider can refresh.
    this._onDidCommit.fire({
      repo,
      message: commitMessage,
      files: result.files ?? selected,
    });

    void this.postMessage({ type: 'commitDone', success: true });
    if (result.restoreWarning) {
      void vscode.window.showWarningMessage(result.restoreWarning);
    }
    void vscode.window.showInformationMessage(
      `Committed ${(result.files ?? selected).length} file(s)`
    );

    // Reset the composer state.
    this._composerMessage = '';
    this._amend = false;
    this._selectedFiles.clear();

    if (push) {
      // Delegate to the stable command; the concrete `intellig.push` handler
      // is owned elsewhere. This keeps us decoupled from any in-flight API
      // changes.
      try {
        await vscode.commands.executeCommand('intellig.push');
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        void vscode.window.showErrorMessage(`Push failed: ${sanitizeGitError(msg)}`);
      }
    }

    // Refresh after commit — the repo the commit ran against, no re-resolve.
    await this._reloadState(repo);
  }

  private _handleChangelistAction(message: ICommitToolWebviewMessage): Promise<void> {
    return handleChangelistAction(
      {
        getChangelists: () => this._changelists,
        getActiveChangelist: (repo) => this._changelistService.getActiveChangelist(repo),
        resolveRepo: () => this._resolveRepo(),
        resolveFileUri: (path) => this._resolveFileUri(path),
        findChangeStatus: (path) => this._findChangeStatus(path),
        findFileChange: (path) => this._findFileChange(path),
        reloadState: () => this._reloadState(),
        showContextMenu: async (m) => {
          await this.postMessage(m);
        },
      },
      message
    );
  }

  /**
   * Resolve a webview row's repo-relative path to an absolute file Uri for
   * dispatch to the owning commands (their handlers expect a `vscode.Uri`,
   * not the bare relative string the webview carries).
   */
  private _resolveFileUri(path: string): Promise<vscode.Uri | undefined> {
    return this._repoTarget.resolveFileUri(path);
  }

  // ── State helpers ──────────────────────────────────────────────────────

  /**
   * Resolve a changed file's status from the loaded changelist model so the
   * Rollback action can revert it the right way (modified → checkout,
   * added → unindex, untracked → delete). Returns undefined when the path
   * isn't in any changelist (stale row).
   */
  private _findChangeStatus(path: string): FileStatus | undefined {
    for (const changelist of this._changelists) {
      const file = changelist.files.find((f) => f.path === path);
      if (file) {
        return file.status;
      }
    }
    return undefined;
  }

  private async _reloadState(repoOverride?: IRepository): Promise<void> {
    // Reloads are background work (boot, post-action refreshes) and must
    // NEVER prompt — the interactive resolve belongs to user actions.
    const repo = repoOverride ?? (await this._repoTarget.resolveForBackground());
    if (!repo) {
      return;
    }
    try {
      await this._changelistService.reconcileWithGitStatus(repo);
      // eslint-disable-next-line no-restricted-syntax -- ChangelistService surfaces reconcile errors via its own channels; this call is best-effort.
    } catch {
      // Best-effort; ChangelistService surfaces errors via its own channels.
    }
    // The push re-reads every service for the resolved repo and ships the
    // result as an incremental updateModel (I6: the resolve render is the
    // only webview.html assignment). Pass the repo through so a multi-root
    // disambiguation made here isn't lost to the push's non-interactive
    // resolution.
    await this._pushLiveUpdate(repo);
  }

  /**
   * Coalesce service-event bursts into one {@link _pushLiveUpdate}. Trailing
   * 300 ms timer: the last event in a burst wins, and the push reads state
   * AFTER the burst settled.
   */
  private _scheduleLiveUpdate(): void {
    if (this._liveUpdateTimer !== undefined) {
      clearTimeout(this._liveUpdateTimer);
    }
    this._liveUpdateTimer = setTimeout(() => {
      this._liveUpdateTimer = undefined;
      safeFireAndForget(
        this._pushLiveUpdate(),
        'CommitToolWindow._scheduleLiveUpdate: coalesced live push'
      );
    }, LIVE_UPDATE_DEBOUNCE_MS);
  }

  /**
   * Re-read the services for the resolved repo, rebuild the render model, and
   * post it as one `updateModel` message. The single update seam: service
   * events, the stash lane, reloads, tab switches, shelf filter, and grouping
   * all end here. No-op when the fingerprint (composer excluded) matches the
   * last pushed model.
   *
   * Repo resolution is NON-INTERACTIVE: a push runs in the background (or
   * under a click that never prompted before), so it must not raise the
   * repo-disambiguation QuickPick. When no repo resolves deterministically
   * the re-read is skipped and the model builds from the cached state — a
   * tab/filter/grouping change still reaches the webview.
   */
  private async _pushLiveUpdate(repoOverride?: IRepository): Promise<void> {
    // Never-resolved / disposed guard: no service reads, no spawn, no post.
    // The provider is constructed at activation, so events fire long before a
    // user opens the view — this keeps those bursts free. Nothing is lost:
    // the resolve path loads fresh state (_reloadState) and the fingerprint
    // resets per-resolve, so the first post-resolve push always goes through.
    if (!this._view || this._disposed) {
      return;
    }
    // Sticky-first background resolve — the bare non-interactive resolver
    // found no repo in multi-root and left the rendered list stale.
    const repo = repoOverride ?? (await this._repoTarget.resolveForBackground());
    if (!repo) {
      // No repo resolved: the previous repo's conflict counts must not be
      // stamped onto whatever renders next.
      this._conflictRegionCounts = new Map();
    }
    if (repo) {
      this._changelists = this._changelistService.getChangelists(repo);
      this._shelfItems = this._shelfService.getShelfItems(repo);
      // Failure is non-fatal — the view falls back to an empty stash array
      // and the filter still works.
      try {
        this._stashEntries = await this._gitService.stashList(repo);
        // eslint-disable-next-line no-restricted-syntax -- stash list is decorative here; an empty list renders and the next push retries.
      } catch {
        this._stashEntries = [];
      }

      // Prune vanished paths from the inclusion model so neither the pushed
      // model nor the host-side commit fallback carries ghosts (I3).
      const present = new Set(this._flattenFiles().map((f) => f.path));
      for (const path of [...this._selectedFiles]) {
        if (!present.has(path)) {
          this._selectedFiles.delete(path);
        }
      }

      // Reference inclusion contract (ChangesViewCommitWorkflowHandler
      // setInclusion / inclusionChanged): the ACTIVE changelist's tracked
      // files are included by default — on load and as new ones appear —
      // unless the user explicitly unchecked them (_knownActiveFiles
      // remembers every path already offered). Unversioned files stay opt-in.
      const active = this._changelists.find((cl) => cl.isActive);
      if (active) {
        const activeTracked = active.files
          .filter((f) => f.status !== 'untracked')
          .map((f) => f.path);
        for (const path of activeTracked) {
          if (!this._knownActiveFiles.has(path)) {
            this._selectedFiles.add(path);
          }
        }
        this._knownActiveFiles = new Set(activeTracked);
      }

      this._conflictRegionCounts = await countConflictRegionsPerFile(
        repo,
        this._changelists.flatMap((cl) => cl.files)
      );
    }

    const model = buildCommitToolWindowInitModel(this._renderInput());
    const fingerprint = fingerprintCtwModel(model);
    if (fingerprint === this._lastPushedFingerprint) {
      return;
    }
    this._lastPushedFingerprint = fingerprint;
    this._lastPostDelivered = await this.postMessage({ type: 'updateModel', model });
  }

  /** Selector seam: point the view at `repo` (sticky target) and reload. */
  public setRepository(repo: IRepository): void {
    this._repoTarget.set(repo);
    safeFireAndForget(this._reloadState(repo), 'CommitToolWindow.setRepository: reload');
  }

  /** Target repo for a USER action (sticky, else the interactive chain). */
  private async _resolveRepo(): Promise<IRepository | undefined> {
    return this._repoTarget.resolveForAction();
  }

  /**
   * Look up a file entry across all changelists so the right-click helper
   * can pick the right menu shape (Add to VCS vs. normal).
   */
  private _findFileChange(path: string): IFileChange | undefined {
    for (const cl of this._changelists) {
      const hit = cl.files.find((f) => f.path === path);
      if (hit) {
        return hit;
      }
    }
    return undefined;
  }

  private _flattenFiles(): Array<{ path: string; staged: boolean }> {
    const out: Array<{ path: string; staged: boolean }> = [];
    for (const cl of this._changelists) {
      for (const f of cl.files) {
        out.push({ path: f.path, staged: f.staged });
      }
    }
    return out;
  }

  private _readRecentMessages(): string[] {
    return loadPersisted(this._workspaceState, RECENT_MESSAGES_SLOT) ?? [];
  }

  private async _pushRecentMessage(message: string): Promise<void> {
    const updated = updateRecentMessagesLru(this._readRecentMessages(), message);
    await savePersisted(this._workspaceState, RECENT_MESSAGES_SLOT, updated);
  }

  // ── HTML rendering ─────────────────────────────────────────────────────

  /**
   * Render the bundled webview entry (`media/webview/commitToolWindow.js`) via
   * an external `<script nonce src>` tag instead of an inline block. The base
   * class emits the tag when this returns a name; the client code is the
   * compiled entry `src/commits/webview/commitToolWindow.ts`.
   */
  protected override _getBundleName(): string {
    return 'commitToolWindow.js';
  }

  /**
   * {@link BaseWebviewView} hook. Returns `{ body }`; the base class wraps it in
   * the authoritative CSP + nonce template and emits the external bundle tag
   * (see {@link _getBundleName}). `body` carries the empty root + the init
   * island the bundled entry reads.
   */
  protected override _getBodyParts(): { body: string } {
    return buildCommitToolWindowBodyParts(this._renderInput());
  }

  /** Current render input — shared by the resolve render and the live push. */
  private _renderInput(): IRenderInput {
    return {
      activeTab: this._activeTab,
      repoRoot: this._repoTarget.root(),
      changelists: sortChangelistsForDisplay(this._changelists),
      shelfItems: this._shelfItems,
      shelfTabEntries: buildShelfTabEntries(
        this._shelfItems,
        this._stashEntries,
        this._shelfTabFilter
      ),
      shelfTabFilter: this._shelfTabFilter,
      composer: {
        message: this._composerMessage,
        amend: this._amend,
        signOff: this._signOff,
        noVerify: loadPersisted(this._workspaceState, LAST_NO_VERIFY_SLOT) ?? false,
      },
      activeChangelistId: findActiveChangelistId(this._changelists),
      grouping: this._changesGrouping,
      selectedFiles: [...this._selectedFiles],
      conflictRegionCounts: this._conflictRegionCounts,
    };
  }

  // ── Shelf-tab message handlers ─────────────────────────────────────────

  private _handleShelfTabAction(message: ICommitToolWebviewMessage): Promise<void> {
    return handleShelfTabAction(
      {
        getShelfController: () => this._shelfController,
        getStashController: () => this._stashController,
        getShelfItems: () => this._shelfItems,
        showContextMenu: async (m) => {
          await this.postMessage(m);
        },
      },
      message
    );
  }
}

/**
 * Find the currently-active changelist's id, if any.
 *
 * Reads the `isActive` marker the {@link IChangelistService} now sets on every
 * model (Phase 0b). The service guarantees exactly one changelist is active,
 * falling back to the default when the stored active id dangles, so this is a
 * synchronous render-path fast path that no longer has to fake active=default
 * or await {@link IChangelistService.getActiveChangelist}. Falls back to the
 * default changelist's id only if — defensively — no model carries the marker.
 */
function findActiveChangelistId(changelists: readonly IChangelist[]): string | undefined {
  const active = changelists.find((c) => c.isActive);
  if (active) {
    return active.id;
  }
  // Defensive fallback: a model list assembled without the service (e.g. a
  // narrow test fixture) may carry no active marker. Keep the default
  // visually distinguished rather than rendering no active row.
  return changelists.find((c) => c.isDefault)?.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML template (pure — safe to unit-test without a Webview instance)
// ─────────────────────────────────────────────────────────────────────────────

export function buildCommitToolWindowBodyParts(input: IRenderInput): {
  body: string;
} {
  const model = buildCommitToolWindowInitModel(input);
  // Body = styles + an empty root + the init island the bundled entry
  // (src/commits/webview/commitToolWindow.ts) reads on boot. The external
  // bundle `<script src>` tag is emitted by BaseWebviewView._wrapHtml via
  // {@link CommitToolWindow._getBundleName}.
  const body = `
  <style>${commitToolWindowStyles()}</style>
  <div id="ctw-root"></div>${initIslandHtml(model)}`;
  return { body };
}

/**
 * Read the `intellig.useCommitToolWindow` flag. The manifest default is
 * `true`, so the in-code fallback matches it (it only fires when the
 * configuration service is unavailable).
 */
export function isCommitToolWindowEnabled(): boolean {
  try {
    return Boolean(readConfig('useCommitToolWindow'));
  } catch {
    return true;
  }
}

/**
 * Factory matching the project convention.
 */
export function createCommitToolWindow(
  extensionUri: vscode.Uri,
  gitService: IGitService,
  changelistService: IChangelistService,
  shelfService: IShelfService,
  workspaceState: vscode.Memento
): CommitToolWindow {
  return new CommitToolWindow(
    extensionUri,
    gitService,
    changelistService,
    shelfService,
    workspaceState
  );
}
