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
import {
  IChangelist,
  IFileChange,
  IChangelistService,
} from '../changelists/interfaces/IChangelistService';
import { IShelfItem, IShelfService } from '../shelf/interfaces/IShelfService';
import { IGitService, IRepository, IStash, FileStatus } from '../git-core/interfaces/IGitService';
import { performCommit, LAST_NO_VERIFY_STATE_KEY } from './CommitDialog';
import { runBeforeCommitChecks } from './CheckinChecks';
import { resolveRepo } from '../utils/resolveRepo';
import { generateNonce } from '../utils/webviewNonce';
import { buildWebviewCsp } from '../utils/webviewCsp';
import { BaseWebviewView } from '../utils/BaseWebviewView';
import { safeFireAndForget } from '../utils/safeFireAndForget';
import { sanitizeGitError } from '../git-core/gitError';

export const COMMIT_TOOL_WINDOW_VIEW_ID = 'intellig.commitToolWindow';

/** Config flag — when true, the new Commit tool window is exposed to users. */
export const COMMIT_TOOL_WINDOW_CONFIG_KEY = 'useCommitToolWindow';

/** workspaceState key for the currently-active tab (Local Changes / Shelf). */
export const ACTIVE_TAB_STATE_KEY = 'intellig.commitToolWindow.activeTab';

/** workspaceState key for the recent-commit-messages LRU. */
export const RECENT_MESSAGES_STATE_KEY = 'intellig.recentCommitMessages';

/**
 * workspaceState key for the Shelf-tab filter toggle.
 * One of `'shelves' | 'stashes' | 'both'` (default `'both'`).
 */
export const SHELF_TAB_FILTER_STATE_KEY = 'intellig.commitToolWindow.shelfFilter';

/** VS Code context key mirroring {@link ACTIVE_TAB_STATE_KEY}. */
export const ACTIVE_TAB_CONTEXT_KEY = 'intellig.commitToolWindow.activeTab';

/** Maximum size of the recent-commit-messages LRU. */
export const RECENT_MESSAGES_MAX = 20;

/** Sentinel id for the "Unversioned Files" pseudo-changelist. */
export const UNVERSIONED_PSEUDO_CHANGELIST_ID = '_unversioned';

/** Valid tab ids for this view. */
export type CommitToolWindowTab = 'localChanges' | 'shelf';

/**
 * Which kinds of entries appear in the Shelf tab.
 *   - `shelves` — only IDE-managed shelf entries (the legacy view).
 *   - `stashes` — only `git stash` entries.
 *   - `both`    — combined list, newest-first, with a type badge per row.
 */
export type ShelfTabFilter = 'shelves' | 'stashes' | 'both';

/**
 * A unified row for the combined Shelf+Stash list. The `kind` discriminator
 * lets the renderer pick a badge + drive the context menu's shape (shelf
 * rows expose Rename…/Restore; stash rows expose Pop/Create Branch…; common
 * actions appear on both).
 */
export type IShelfTabEntry =
  | {
      kind: 'shelf';
      id: string;
      name: string;
      timestamp: Date;
      fileCount: number;
      /** Present when the entry has been Already-Unshelved. */
      unshelvedAt?: Date;
    }
  | {
      kind: 'stash';
      /** Full `stash@{index}` ref as of the list snapshot. */
      id: string;
      name: string;
      timestamp: Date;
      /** Stash index used for apply/pop/drop plumbing. */
      index: number;
    };

/**
 * Imperative bag for Shelf-row context-menu actions. The extension binds
 * this to `ShelfView`'s public methods so the tool window doesn't have to
 * know about QuickPicks / VS Code window APIs itself. Keeping methods
 * optional lets tests pass a minimal stub.
 */
export interface IShelfTabShelfController {
  apply?: (id: string) => Promise<void>;
  showDiff?: (id: string) => Promise<void>;
  delete?: (id: string) => Promise<void>;
  rename?: (id: string) => Promise<void>;
  restore?: (id: string) => Promise<void>;
  importPatches?: () => Promise<void>;
  createPatch?: (id: string) => Promise<void>;
}

/**
 * Imperative bag for Stash-row context-menu actions. Backed by `StashView`
 * in production; tests pass a minimal stub.
 */
export interface IShelfTabStashController {
  apply?: (index: number) => Promise<void>;
  pop?: (index: number) => Promise<void>;
  drop?: (index: number) => Promise<void>;
  showDiff?: (index: number) => Promise<void>;
  rename?: (index: number) => Promise<void>;
  branchFromStash?: (index: number) => Promise<void>;
}

/** Action payload on a changelist-level context menu entry. */
export type ChangelistAction =
  | 'new'
  | 'setActive'
  | 'rename'
  | 'editDescription'
  | 'delete'
  | 'commitOnly'
  | 'shelve';

/** Action payload on a file-level context menu entry. */
export type FileAction =
  | 'showDiff'
  | 'jumpToSource'
  | 'moveToChangelist'
  | 'rollback'
  | 'shelve'
  | 'addToVcs'
  | 'showHistory'
  | 'annotate';

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

/**
 * Build the unified Shelf-tab entry list from the two source arrays and
 * apply the requested filter. Pure — a new array is returned. Rows are
 * sorted by timestamp descending (newest first). When both sources are
 * visible, shelves and stashes interleave purely by timestamp, which mirrors
 * IntelliJ's unified pane.
 *
 * @param shelfItems - Current `IShelfItem[]` from `IShelfService`.
 * @param stashes    - Current `IStash[]` from `IGitService.stashList`.
 * @param filter     - `'shelves' | 'stashes' | 'both'`.
 */
export function buildShelfTabEntries(
  shelfItems: readonly IShelfItem[],
  stashes: readonly IStash[],
  filter: ShelfTabFilter
): IShelfTabEntry[] {
  const entries: IShelfTabEntry[] = [];

  if (filter === 'shelves' || filter === 'both') {
    for (const it of shelfItems) {
      entries.push({
        kind: 'shelf',
        id: it.id,
        name: it.name,
        timestamp: it.timestamp,
        fileCount: it.files.length,
        unshelvedAt: it.unshelvedAt,
      });
    }
  }
  if (filter === 'stashes' || filter === 'both') {
    for (const s of stashes) {
      entries.push({
        kind: 'stash',
        id: `stash@{${s.index}}`,
        name: s.message,
        timestamp: s.date,
        index: s.index,
      });
    }
  }

  // Newest-first sort. Break ties deterministically by id so snapshots are
  // stable across runs.
  entries.sort((a, b) => {
    const delta = b.timestamp.getTime() - a.timestamp.getTime();
    if (delta !== 0) {
      return delta;
    }
    return a.id.localeCompare(b.id);
  });
  return entries;
}

/**
 * Whitelist valid filter strings. Used when hydrating persisted filter
 * state so a corrupt workspaceState value falls back to `'both'`.
 */
export function isShelfTabFilter(value: unknown): value is ShelfTabFilter {
  return value === 'shelves' || value === 'stashes' || value === 'both';
}

/**
 * Labels for the file-action context menu, in IntelliJ-parity order.
 * A file is considered untracked (eligible for `Add to VCS`) when its
 * status is `untracked`.
 *
 * Entries are intentionally kept in the order the IR lists them.
 */
export function fileContextMenuLabels(file: IFileChange): Array<{
  label: string;
  action: FileAction;
  shortcut?: string;
}> {
  const items: Array<{ label: string; action: FileAction; shortcut?: string }> = [
    { label: 'Show Diff', action: 'showDiff', shortcut: 'Ctrl+D' },
    { label: 'Jump to Source', action: 'jumpToSource', shortcut: 'F4' },
    { label: 'Move to Another Changelist…', action: 'moveToChangelist', shortcut: 'F6' },
    { label: 'Rollback…', action: 'rollback', shortcut: 'Ctrl+Alt+Z' },
    { label: 'Shelve Changes…', action: 'shelve' },
  ];
  if (file.status === 'untracked') {
    items.push({ label: 'Add to VCS', action: 'addToVcs', shortcut: 'Ctrl+Alt+A' });
  }
  items.push(
    { label: 'Show History', action: 'showHistory' },
    { label: 'Annotate with Git Blame', action: 'annotate' }
  );
  return items;
}

/**
 * Labels for the changelist-level context menu, in IntelliJ-parity order.
 * Caller-provided flags tune which entries are enabled (e.g. hide
 * `Set Active Changelist` when the row is already active).
 */
export function changelistContextMenuLabels(input: {
  isActive: boolean;
  isDefault: boolean;
}): Array<{ label: string; action: ChangelistAction; disabled?: boolean }> {
  return [
    { label: 'New Changelist…', action: 'new' },
    {
      label: 'Set Active Changelist',
      action: 'setActive',
      disabled: input.isActive,
    },
    { label: 'Rename Changelist…', action: 'rename', disabled: input.isDefault },
    { label: 'Edit Description…', action: 'editDescription' },
    {
      label: 'Remove Changelist',
      action: 'delete',
      disabled: input.isDefault,
    },
    { label: 'Commit Only This Changelist…', action: 'commitOnly' },
    { label: 'Shelve Changes', action: 'shelve' },
  ];
}

/**
 * Gear-menu placeholder items for the composer. These render as disabled
 * with a "coming soon" tooltip until they're wired up.
 */
export function gearMenuItems(): Array<{ label: string; tooltip: string }> {
  const tooltip = 'Coming soon';
  return [
    { label: 'Reformat code', tooltip },
    { label: 'Optimize imports', tooltip },
    { label: 'Run Code Cleanup', tooltip },
    { label: 'Check TODO', tooltip },
    { label: 'Disable pre-commit hooks (--no-verify)', tooltip },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Message shapes
// ─────────────────────────────────────────────────────────────────────────────

/** Message types posted from the webview to the host. */
export interface ICommitToolWebviewMessage {
  type: string;
  tab?: CommitToolWindowTab;
  path?: string;
  paths?: string[];
  changelistId?: string;
  message?: string;
  amend?: boolean;
  signOff?: boolean;
  files?: string[];
  collapsed?: boolean;
  action?: ChangelistAction | FileAction | ShelfTabShelfAction | ShelfTabStashAction;
  targetFiles?: string[];
  /** Newly-selected Shelf-tab filter from the segmented control. */
  filter?: ShelfTabFilter;
  /** Newly-selected Local Changes grouping mode from the segmented control. */
  grouping?: ChangesGroupingMode;
  /** Row kind being operated on when `action` targets a Shelf-tab row. */
  rowKind?: 'shelf' | 'stash';
  /** Shelf entry id (when rowKind === 'shelf'). */
  shelfId?: string;
  /** Stash index (when rowKind === 'stash'). */
  stashIndex?: number;
}

/** Shelf-row actions dispatched via the Shelf-tab context menu. */
export type ShelfTabShelfAction =
  | 'shelfApply'
  | 'shelfDelete'
  | 'shelfShowDiff'
  | 'shelfRename'
  | 'shelfRestore'
  | 'shelfImportPatches'
  | 'shelfCreatePatch';

/** Stash-row actions dispatched via the Shelf-tab context menu. */
export type ShelfTabStashAction =
  | 'stashApply'
  | 'stashPop'
  | 'stashDrop'
  | 'stashShowDiff'
  | 'stashRename'
  | 'stashBranchFromStash';

/**
 * Menu entries for a Shelf row in the combined tab. Pure — unit-tested
 * directly. `isAlreadyUnshelved` surfaces the Restore entry.
 */
export function shelfRowContextMenuLabels(input: {
  isAlreadyUnshelved: boolean;
}): Array<{ label: string; action: ShelfTabShelfAction }> {
  const items: Array<{ label: string; action: ShelfTabShelfAction }> = [];
  if (input.isAlreadyUnshelved) {
    items.push({ label: 'Restore', action: 'shelfRestore' });
  }
  items.push(
    { label: 'Apply (Unshelve)', action: 'shelfApply' },
    { label: 'Show Diff', action: 'shelfShowDiff' },
    { label: 'Rename…', action: 'shelfRename' },
    { label: 'Create Patch from Shelf…', action: 'shelfCreatePatch' },
    { label: 'Import Patches…', action: 'shelfImportPatches' },
    { label: 'Delete', action: 'shelfDelete' }
  );
  return items;
}

/**
 * Menu entries for a Stash row in the combined tab. Pure. `Pop` is listed
 * above `Apply` so the right-click default (Enter) matches IntelliJ's
 * recommended action for stash entries.
 */
export function stashRowContextMenuLabels(): Array<{
  label: string;
  action: ShelfTabStashAction;
}> {
  return [
    { label: 'Pop', action: 'stashPop' },
    { label: 'Apply', action: 'stashApply' },
    { label: 'Show Diff', action: 'stashShowDiff' },
    { label: 'Rename…', action: 'stashRename' },
    { label: 'Create Branch from Stash…', action: 'stashBranchFromStash' },
    { label: 'Drop', action: 'stashDrop' },
  ];
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
export class CommitToolWindow extends BaseWebviewView {
  public static readonly viewId = COMMIT_TOOL_WINDOW_VIEW_ID;

  private _activeTab: CommitToolWindowTab = 'localChanges';
  private _amend = false;
  private _signOff = false;
  /** Re-entrancy guard: true while a commit is in flight (blocks double-submit). */
  private _committing = false;
  private _composerMessage = '';

  private _changelists: IChangelist[] = [];
  private _shelfItems: IShelfItem[] = [];
  /** Most recent `git stash list` snapshot. */
  private _stashEntries: IStash[] = [];
  /** Active Shelf-tab filter, persisted to workspaceState. */
  private _shelfTabFilter: ShelfTabFilter = 'both';
  /** Local Changes file-grouping mode, persisted to workspaceState. */
  private _changesGrouping: ChangesGroupingMode = 'directory';
  private _selectedFiles: Set<string> = new Set();

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
    // Restore persisted active tab (defaults to localChanges).
    const persistedTab = this._workspaceState.get<CommitToolWindowTab>(
      ACTIVE_TAB_STATE_KEY,
      'localChanges'
    );
    if (persistedTab === 'localChanges' || persistedTab === 'shelf') {
      this._activeTab = persistedTab;
    }

    // Restore persisted Shelf-tab filter (defaults to 'both').
    const persistedFilter = this._workspaceState.get<unknown>(SHELF_TAB_FILTER_STATE_KEY, 'both');
    if (isShelfTabFilter(persistedFilter)) {
      this._shelfTabFilter = persistedFilter;
    }

    // Restore persisted Local Changes grouping mode (defaults to 'directory',
    // matching IntelliJ's default ChangesGroupingPolicy).
    const persistedGrouping = this._workspaceState.get<unknown>(
      CHANGES_GROUPING_STATE_KEY,
      'directory'
    );
    if (isChangesGroupingMode(persistedGrouping)) {
      this._changesGrouping = persistedGrouping;
    }

    // Watch the underlying services so the view updates incrementally.
    this._disposables.push(
      this._changelistService.onDidChangeChangelists((changelists) => {
        this._changelists = changelists;
        this._postMessage({ type: 'updateChangelistTree', changelists });
      }),
      this._shelfService.onDidChangeShelf((items) => {
        this._shelfItems = items;
        this._postMessage({
          type: 'updateShelfList',
          entries: buildShelfTabEntries(items, this._stashEntries, this._shelfTabFilter),
          filter: this._shelfTabFilter,
        });
      }),
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
   * render via {@link _getBodyParts}. Here we publish the active-tab context
   * key + kick an async reload of state.
   */
  protected override _onResolve(
    _webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    // Publish the active-tab context key so `when` clauses can react.
    void vscode.commands.executeCommand('setContext', ACTIVE_TAB_CONTEXT_KEY, this._activeTab);

    // Kick an async load. The initial HTML render already happened via
    // BaseWebviewView._render(); a data refresh follows once the services
    // respond. Bucket C: init path; the view rerenders on
    // onDidChangeRepository, so a first-load reject self-heals.
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
    await this._workspaceState.update(SHELF_TAB_FILTER_STATE_KEY, filter);
    this._render();
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
    await this._workspaceState.update(CHANGES_GROUPING_STATE_KEY, grouping);
    this._render();
  }

  /**
   * Read-only accessor for the recent-messages LRU. Exposed so the legacy
   * {@link CommitDialog} (or future callers) can reuse the same history.
   */
  /**
   * Prefill the commit composer's message field and re-render. Used by Undo
   * Commit to restore the undone commit's message so the user can re-commit
   * without retyping it (IntelliJ GitUncommitAction parity).
   */
  public prefillComposerMessage(message: string): void {
    this._composerMessage = message;
    this._render();
  }

  public getRecentMessages(): string[] {
    return [...this._readRecentMessages()];
  }

  // Disposal is owned by `BaseWebviewView.dispose()` — drains `_disposables`,
  // marks the view disposed, and clears `_view`. Subclasses that need extra
  // teardown can override and chain via `super.dispose()`.

  // ── Message handling ───────────────────────────────────────────────────

  private async _handleWebviewMessage(message: ICommitToolWebviewMessage): Promise<void> {
    if (!message || typeof message.type !== 'string') {
      return;
    }
    switch (message.type) {
      case 'tabChange':
        if (message.tab === 'localChanges' || message.tab === 'shelf') {
          await this._setActiveTab(message.tab);
        }
        break;
      case 'selectFile':
        if (message.path) {
          await this._handleSelectFile(message.path);
        }
        break;
      case 'toggleFile':
        if (message.path) {
          this._handleToggleFile(message.path);
        }
        break;
      case 'toggleChangelist':
        // Collapsed-state toggle is not persisted; this case is intentionally empty.
        break;
      case 'updateComposerField':
        if (typeof message.message === 'string') {
          this._composerMessage = message.message;
        }
        if (typeof message.amend === 'boolean') {
          this._amend = message.amend;
        }
        if (typeof message.signOff === 'boolean') {
          this._signOff = message.signOff;
        }
        break;
      case 'messageHistoryRequest':
        this._postMessage({
          type: 'messageHistory',
          messages: this._readRecentMessages(),
        });
        break;
      case 'commit':
        await this._handleCommit(message, /* push */ false);
        break;
      case 'commitAndPush':
        await this._handleCommit(message, /* push */ true);
        break;
      case 'changelistContextAction':
        await this._handleChangelistAction(message);
        break;
      case 'shelfTabFilterChange':
        if (isShelfTabFilter(message.filter)) {
          await this.setShelfTabFilter(message.filter);
        }
        break;
      case 'changesGroupingChange':
        if (isChangesGroupingMode(message.grouping)) {
          await this.setChangesGrouping(message.grouping);
        }
        break;
      case 'shelfTabContextAction':
        await this._handleShelfTabAction(message);
        break;
      default:
        // Unknown — drop silently so future message types can be added
        // without breaking older webview bundles.
        break;
    }
  }

  private async _setActiveTab(tab: CommitToolWindowTab): Promise<void> {
    if (this._activeTab === tab) {
      return;
    }
    this._activeTab = tab;
    await this._workspaceState.update(ACTIVE_TAB_STATE_KEY, tab);
    await vscode.commands.executeCommand('setContext', ACTIVE_TAB_CONTEXT_KEY, tab);
    this._render(); // structural change → full regen
  }

  private async _handleSelectFile(path: string): Promise<void> {
    if (this._activeTab !== 'localChanges') {
      return;
    }
    const repo = await this._resolveRepo();
    if (!repo) {
      return;
    }
    try {
      const diff = await this._gitService.getDiff(repo, path, /* staged */ false);
      this._postMessage({ type: 'updateDiffPreview', path, diff });
    } catch (error) {
      this._postMessage({
        type: 'updateDiffPreview',
        path,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  private _handleToggleFile(path: string): void {
    if (this._selectedFiles.has(path)) {
      this._selectedFiles.delete(path);
    } else {
      this._selectedFiles.add(path);
    }
    this._postMessage({
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
    const noVerify = this._workspaceState.get<boolean>(LAST_NO_VERIFY_STATE_KEY, false) ?? false;
    if (!noVerify) {
      const proceed = await runBeforeCommitChecks(this._gitService, repo, selected);
      if (!proceed) {
        this._postMessage({ type: 'commitDone', success: false });
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
      this._postMessage({
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

    this._postMessage({ type: 'commitDone', success: true });
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

    // Refresh after commit.
    await this._reloadState();
  }

  private async _handleChangelistAction(message: ICommitToolWebviewMessage): Promise<void> {
    const action = message.action as ChangelistAction | FileAction | 'contextOpen' | undefined;
    if (!action) {
      return;
    }

    // The webview posts `contextOpen` on right-click to ask the host to
    // present the IntelliJ-parity menu. We populate a QuickPick from the
    // already-tested label helpers (fileContextMenuLabels /
    // changelistContextMenuLabels) and recurse with the user's pick. A file
    // path on the message wins: file rows take precedence because a right-
    // click on a file row always carries both `path` and `changelistId`.
    if (action === 'contextOpen') {
      if (message.path) {
        const file = this._findFileChange(message.path);
        // If we don't have metadata for the path (e.g. stale state), fall
        // back to a minimal modified-file menu — better than silently
        // dropping the right-click.
        const fallback: IFileChange = {
          path: message.path,
          status: 'modified',
          staged: false,
        };
        const labels = fileContextMenuLabels(file ?? fallback);
        const picked = await vscode.window.showQuickPick(
          labels.map((l) => ({
            label: l.label,
            description: l.shortcut,
            _action: l.action,
          })),
          { title: message.path, placeHolder: 'Select an action' }
        );
        if (!picked) {
          return;
        }
        await this._handleChangelistAction({
          ...message,
          action: picked._action,
        });
        return;
      }
      if (message.changelistId) {
        const changelist = this._changelists.find((c) => c.id === message.changelistId);
        // isActive is resolved against the authoritative service call when
        // available; if the lookup fails we still render the menu with
        // default flags so the right-click isn't a no-op.
        let isActive = false;
        try {
          const repo = await this._resolveRepo();
          if (repo) {
            const active = await this._changelistService.getActiveChangelist(repo);
            isActive = !!active && active.id === message.changelistId;
          }
          // eslint-disable-next-line no-restricted-syntax -- no logger in scope; best-effort isActive lookup falls back to false so the right-click menu still renders.
        } catch {
          // Best-effort — some tests stub the service with a resolved
          // undefined / throw; we just fall back to isActive:false.
        }
        const labels = changelistContextMenuLabels({
          isActive,
          isDefault: changelist?.isDefault ?? false,
        });
        const picked = await vscode.window.showQuickPick(
          labels.filter((l) => !l.disabled).map((l) => ({ label: l.label, _action: l.action })),
          {
            title: changelist?.name ?? 'Changelist',
            placeHolder: 'Select an action',
          }
        );
        if (!picked) {
          return;
        }
        await this._handleChangelistAction({
          ...message,
          action: picked._action,
        });
        return;
      }
      return;
    }

    // File actions forwarded as changelistContextAction (UI can dispatch both
    // node types through the same message for simplicity).
    switch (action) {
      case 'new':
        await vscode.commands.executeCommand('intellig.changelist.new');
        return;
      case 'setActive':
        if (message.changelistId) {
          await vscode.commands.executeCommand(
            'intellig.changelist.setActive',
            message.changelistId
          );
        }
        return;
      case 'rename':
        if (message.changelistId) {
          await vscode.commands.executeCommand('intellig.changelist.rename', message.changelistId);
        }
        return;
      case 'editDescription':
        if (message.changelistId) {
          await vscode.commands.executeCommand(
            'intellig.changelist.editDescription',
            message.changelistId
          );
        }
        return;
      case 'delete':
        if (message.changelistId) {
          await vscode.commands.executeCommand('intellig.changelist.delete', message.changelistId);
        }
        return;
      case 'commitOnly':
        if (message.changelistId) {
          await vscode.commands.executeCommand(
            'intellig.changelist.commitOnly',
            message.changelistId
          );
        }
        return;
      case 'shelve':
        // A file row carries both `path` and `changelistId` (path wins): open
        // the Shelve dialog pre-checking that one file. A changelist-level
        // right-click (no path) shelves the whole changelist directly.
        if (message.path) {
          await vscode.commands.executeCommand('intellig.shelve', message.path);
        } else if (message.changelistId) {
          await vscode.commands.executeCommand('intellig.changelist.shelve', message.changelistId);
        }
        return;
      case 'moveToChangelist':
        if (message.targetFiles) {
          await vscode.commands.executeCommand(
            'intellig.changelist.moveFilesTo',
            message.targetFiles
          );
        }
        return;
      case 'showDiff':
        if (message.path) {
          await vscode.commands.executeCommand('intellig.localChanges.showDiff', message.path);
        }
        return;
      case 'jumpToSource':
        if (message.path) {
          await vscode.commands.executeCommand('intellig.localChanges.openFile', message.path);
        }
        return;
      case 'rollback':
        if (message.path) {
          // Route through the multi-file Rollback command so the user gets the
          // IntelliJ-style file-listing confirm and status-aware revert
          // (added → unindex, untracked → delete). Pass the file's known
          // status from the changelist model; fall back to a plain revert when
          // the row's status can't be resolved.
          const status = this._findChangeStatus(message.path);
          if (status) {
            await vscode.commands.executeCommand('intellig.rollbackChanges', [
              { path: message.path, status },
            ]);
          } else {
            await vscode.commands.executeCommand('intellig.revertFile', message.path);
          }
          await this._reloadState();
        }
        return;
      case 'addToVcs':
        if (message.path) {
          // The registered command is `intellig.explorer.addToVcs`
          // (explorerCommands.ts). The pre-fix code posted the non-existent
          // `intellig.addToVcs`, making Add-to-VCS a silent no-op. Fix the
          // id AND pass a proper file Uri — the command's
          // `resolveExplorerFileUri` expects a `vscode.Uri`, not the
          // repo-relative string the webview carries, so we resolve the
          // changelist path against the repo root first.
          const repo = await this._resolveRepo();
          if (repo) {
            const fileUri = vscode.Uri.joinPath(repo.rootUri, message.path);
            await vscode.commands.executeCommand('intellig.explorer.addToVcs', fileUri);
          }
        }
        return;
      case 'showHistory':
        if (message.path) {
          await vscode.commands.executeCommand('intellig.showHistory', message.path);
        }
        return;
      case 'annotate':
        if (message.path) {
          await vscode.commands.executeCommand('intellig.annotate', message.path);
        }
        return;
    }
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

  private async _reloadState(): Promise<void> {
    const repo = await this._resolveRepo();
    if (!repo) {
      return;
    }
    try {
      await this._changelistService.reconcileWithGitStatus(repo);
      // eslint-disable-next-line no-restricted-syntax -- ChangelistService surfaces reconcile errors via its own channels; this call is best-effort.
    } catch {
      // Best-effort; ChangelistService surfaces errors via its own channels.
    }
    this._changelists = this._changelistService.getChangelists(repo);
    this._shelfItems = this._shelfService.getShelfItems(repo);

    // Fetch stash list. Failure is non-fatal — the view falls back to an
    // empty stash array and the filter still works.
    try {
      this._stashEntries = await this._gitService.stashList(repo);
    } catch {
      this._stashEntries = [];
    }

    this._postMessage({
      type: 'fullRender',
      tab: this._activeTab,
      changelists: this._changelists,
      shelf: this._shelfItems,
      stash: this._stashEntries,
      filter: this._shelfTabFilter,
    });
  }

  /**
   * Resolve the target repository for commit / selectFile / _reloadState.
   * Honors the preferActive path so multi-root
   * workspaces route to the active-editor's repo instead of
   * `repositories[0]`. The `silent` flag suppresses the toast — callers
   * handle the undefined return (commit surfaces its own error; reload
   * simply no-ops).
   */
  private async _resolveRepo(): Promise<IRepository | undefined> {
    return resolveRepo(this._gitService, {
      preferActive: true,
      silent: true,
    });
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
    return this._workspaceState.get<string[]>(RECENT_MESSAGES_STATE_KEY, []) ?? [];
  }

  private async _pushRecentMessage(message: string): Promise<void> {
    const updated = updateRecentMessagesLru(this._readRecentMessages(), message);
    await this._workspaceState.update(RECENT_MESSAGES_STATE_KEY, updated);
  }

  private _postMessage(payload: unknown): void {
    if (!this._view) {
      return;
    }
    void this._view.webview.postMessage(payload);
  }

  // ── HTML rendering ─────────────────────────────────────────────────────

  /**
   * {@link BaseWebviewView} hook. Returns the current {body, script} tuple;
   * the base class wraps it in the authoritative CSP + nonce template.
   */
  protected override _getBodyParts(): { body: string; script: string } {
    return buildCommitToolWindowBodyParts({
      activeTab: this._activeTab,
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
      },
      activeChangelistId: findActiveChangelistId(this._changelists),
      grouping: this._changesGrouping,
    });
  }

  // ── Shelf-tab message handlers ─────────────────────────────────────────

  /**
   * Route a Shelf-tab context-menu action to the appropriate controller.
   * Unknown actions silently no-op so a stale webview bundle won't crash.
   *
   * When `action === 'contextOpen'`, the webview is asking the host to
   * display the menu. The host shows a QuickPick using
   * {@link shelfRowContextMenuLabels} / {@link stashRowContextMenuLabels}
   * and forwards the user's pick back through this same code path.
   */
  private async _handleShelfTabAction(message: ICommitToolWebviewMessage): Promise<void> {
    const action = message.action as
      | ShelfTabShelfAction
      | ShelfTabStashAction
      | 'contextOpen'
      | undefined;
    if (!action) {
      return;
    }

    // contextOpen branch — prompt the user, then recurse with the chosen
    // action. Keeping the recursion tight means the action-dispatch switch
    // below doesn't have to know whether the trigger was a right-click
    // or a direct command invocation.
    if (action === 'contextOpen') {
      if (message.rowKind === 'shelf' && message.shelfId) {
        const entry = this._shelfItems.find((i) => i.id === message.shelfId);
        if (!entry) {
          return;
        }
        const labels = shelfRowContextMenuLabels({
          isAlreadyUnshelved: entry.unshelvedAt !== undefined,
        });
        const picked = await vscode.window.showQuickPick(
          labels.map((l) => ({ label: l.label, _action: l.action })),
          { title: `Shelf: ${entry.name}`, placeHolder: 'Select an action' }
        );
        if (!picked) {
          return;
        }
        await this._handleShelfTabAction({
          ...message,
          action: picked._action,
        });
        return;
      }
      if (message.rowKind === 'stash' && typeof message.stashIndex === 'number') {
        const labels = stashRowContextMenuLabels();
        const picked = await vscode.window.showQuickPick(
          labels.map((l) => ({ label: l.label, _action: l.action })),
          {
            title: `stash@{${message.stashIndex}}`,
            placeHolder: 'Select an action',
          }
        );
        if (!picked) {
          return;
        }
        await this._handleShelfTabAction({
          ...message,
          action: picked._action,
        });
        return;
      }
      return;
    }

    if (message.rowKind === 'shelf') {
      if (!message.shelfId) {
        return;
      }
      const id = message.shelfId;
      switch (action) {
        case 'shelfApply':
          await this._shelfController.apply?.(id);
          return;
        case 'shelfShowDiff':
          await this._shelfController.showDiff?.(id);
          return;
        case 'shelfRename':
          await this._shelfController.rename?.(id);
          return;
        case 'shelfRestore':
          await this._shelfController.restore?.(id);
          return;
        case 'shelfDelete':
          await this._shelfController.delete?.(id);
          return;
        case 'shelfCreatePatch':
          await this._shelfController.createPatch?.(id);
          return;
        case 'shelfImportPatches':
          await this._shelfController.importPatches?.();
          return;
        default:
          return;
      }
    }

    if (message.rowKind === 'stash') {
      if (typeof message.stashIndex !== 'number') {
        return;
      }
      const idx = message.stashIndex;
      switch (action) {
        case 'stashApply':
          await this._stashController.apply?.(idx);
          return;
        case 'stashPop':
          await this._stashController.pop?.(idx);
          return;
        case 'stashDrop':
          await this._stashController.drop?.(idx);
          return;
        case 'stashShowDiff':
          await this._stashController.showDiff?.(idx);
          return;
        case 'stashRename':
          await this._stashController.rename?.(idx);
          return;
        case 'stashBranchFromStash':
          await this._stashController.branchFromStash?.(idx);
          return;
        default:
          return;
      }
    }
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

export interface IRenderInput {
  /**
   * Present for backward-compat with the standalone
   * {@link renderCommitToolWindowHtml} legacy template. The
   * `BaseWebviewView`-backed flow ignores this field — CSP / nonce / cspSource
   * are owned by the base class now — but older tests call the standalone
   * renderer with `cspSource` supplied.
   */
  cspSource?: string;
  activeTab: CommitToolWindowTab;
  changelists: readonly IChangelist[];
  shelfItems: readonly IShelfItem[];
  /** Unified shelf+stash entries. Derived from shelfItems + stashes. */
  shelfTabEntries?: readonly IShelfTabEntry[];
  /** Active Shelf-tab filter, used to render the segmented control. */
  shelfTabFilter?: ShelfTabFilter;
  composer: { message: string; amend: boolean; signOff: boolean };
  activeChangelistId?: string;
  /** Local Changes file-grouping mode. Defaults to `flat` when omitted. */
  grouping?: ChangesGroupingMode;
}

/**
 * Build the Commit tool window's `{body, script}` tuple. Pure — safe to
 * unit-test without a webview instance. The `BaseWebviewView` base class
 * wraps the body in the authoritative CSP + nonce template on the class path.
 *
 * The standalone {@link renderCommitToolWindowHtml} wrapper preserves the
 * legacy end-to-end renderer for tests that want to assert against a
 * complete document.
 */
/** A single file entry in the Local Changes render model. */
interface ICtwFileEntry {
  path: string;
  statusChar: string;
  /** Full path in flat mode, basename in directory mode. */
  displayName: string;
}

/** One changelist (or the unversioned pseudo-node) in the render model. */
interface ICtwChangelistModel {
  id: string;
  name: string;
  isActive: boolean;
  fileCount: number;
  /** Present in flat grouping: file rows rendered directly. */
  files?: ICtwFileEntry[];
  /** Present in directory grouping: files bucketed under directory nodes. */
  dirGroups?: Array<{ dir: string | null; files: ICtwFileEntry[] }>;
}

/**
 * JSON-serializable render model for the Commit Tool Window. The host
 * precomputes everything the inline script needs to build the DOM via
 * createElement (no host-side HTML strings), so the script is a pure
 * data→DOM mapper. Crosses to the webview as the `INIT` island.
 */
interface ICommitToolWindowInitModel {
  activeTab: CommitToolWindowTab;
  showLocal: boolean;
  grouping: ChangesGroupingMode;
  gearItems: Array<{ label: string; tooltip: string }>;
  composer: { message: string; amend: boolean; signOff: boolean };
  local: {
    empty: boolean;
    changelists: ICtwChangelistModel[];
    unversioned: ICtwChangelistModel | null;
  };
  shelf: {
    filter: ShelfTabFilter;
    empty: boolean;
    emptyCopy: string;
    rows: Array<
      | { kind: 'shelf'; id: string; name: string; alreadyUnshelved: boolean; fileCount: number }
      | { kind: 'stash'; index: number; name: string; id: string }
    >;
  };
}

/** Map an {@link IFileChange} to its render-model entry. */
function buildCtwFileEntry(f: IFileChange, displayName: string): ICtwFileEntry {
  return { path: f.path, statusChar: shortStatusChar(f.status), displayName };
}

/**
 * Build the file portion of a changelist's render model, honoring the grouping
 * mode. Flat mode yields a `files` array (full paths); directory mode yields
 * `dirGroups` bucketed by directory (basenames), mirroring renderChangelistFiles.
 */
function buildCtwChangelistFiles(
  files: readonly IFileChange[],
  grouping: ChangesGroupingMode
): Pick<ICtwChangelistModel, 'files' | 'dirGroups'> {
  if (grouping === 'directory') {
    return {
      dirGroups: groupFilesByDirectory(files).map((node) => ({
        dir: node.dir.length > 0 ? node.dir : null,
        files: node.files.map((f) => buildCtwFileEntry(f, basename(f.path))),
      })),
    };
  }
  return { files: files.map((f) => buildCtwFileEntry(f, f.path)) };
}

/**
 * Precompute the full {@link ICommitToolWindowInitModel} from render input.
 * Exported for unit/jsdom tests that assert the built DOM.
 */
export function buildCommitToolWindowInitModel(
  input: Omit<IRenderInput, 'cspSource'>
): ICommitToolWindowInitModel {
  const { activeTab, changelists, shelfItems, composer, activeChangelistId } = input;
  const grouping: ChangesGroupingMode = input.grouping ?? 'flat';
  // Derive combined entries when not already computed. Callers that skip
  // the field get a shelf-only view (legacy behavior).
  const shelfTabFilter: ShelfTabFilter = input.shelfTabFilter ?? 'shelves';
  const shelfTabEntries: readonly IShelfTabEntry[] =
    input.shelfTabEntries ?? buildShelfTabEntries(shelfItems, [], shelfTabFilter);

  const { changelists: tracked, unversioned } = partitionUnversionedFiles(changelists);
  const changelistModels: ICtwChangelistModel[] = tracked.map((cl) => ({
    id: cl.id,
    name: cl.name,
    isActive: cl.id === activeChangelistId,
    fileCount: cl.files.length,
    ...buildCtwChangelistFiles(cl.files, grouping),
  }));
  const unversionedModel: ICtwChangelistModel | null =
    unversioned.length === 0
      ? null
      : {
          id: UNVERSIONED_PSEUDO_CHANGELIST_ID,
          name: 'Unversioned Files',
          isActive: false,
          fileCount: unversioned.length,
          ...buildCtwChangelistFiles(unversioned, grouping),
        };

  const emptyCopy =
    shelfTabFilter === 'stashes'
      ? 'No stash entries.'
      : shelfTabFilter === 'shelves'
        ? 'Shelf is empty.'
        : 'No shelf or stash entries.';

  return {
    activeTab,
    showLocal: activeTab === 'localChanges',
    grouping,
    gearItems: gearMenuItems(),
    composer: { message: composer.message, amend: composer.amend, signOff: composer.signOff },
    local: {
      empty: changelists.length === 0,
      changelists: changelistModels,
      unversioned: unversionedModel,
    },
    shelf: {
      filter: shelfTabFilter,
      empty: shelfTabEntries.length === 0,
      emptyCopy,
      rows: shelfTabEntries.map((entry) =>
        entry.kind === 'shelf'
          ? {
              kind: 'shelf' as const,
              id: entry.id,
              name: entry.name,
              alreadyUnshelved: entry.unshelvedAt !== undefined,
              fileCount: entry.fileCount,
            }
          : {
              kind: 'stash' as const,
              index: entry.index,
              name: entry.name,
              id: entry.id,
            }
      ),
    },
  };
}

export function buildCommitToolWindowBodyParts(input: Omit<IRenderInput, 'cspSource'>): {
  body: string;
  script: string;
} {
  const model = buildCommitToolWindowInitModel(input);
  // Body is an empty root + styles; the inline script builds every panel via
  // createElement from the INIT island (no host-side HTML strings).
  const body = `
  <style>${commitToolWindowStyles()}</style>
  <div id="ctw-root"></div>`;
  return { body, script: commitToolWindowBehaviorScript(model) };
}

/**
 * Legacy end-to-end renderer. Preserved so existing unit tests that assert
 * against a complete `<!DOCTYPE html>` document keep working. The class-side
 * path no longer calls this — it goes through
 * {@link buildCommitToolWindowBodyParts} + {@link BaseWebviewView._wrapHtml}.
 *
 * The CSP is the shared minimal policy from `buildWebviewCsp` in
 * `src/utils/webviewCsp.ts` (no img/font-src — this frame needs neither);
 * change CSP semantics there.
 */
export function renderCommitToolWindowHtml(input: IRenderInput): string {
  const nonce = generateNonce();
  const { body, script } = buildCommitToolWindowBodyParts(input);
  const cspSource = input.cspSource ?? '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${buildWebviewCsp(cspSource, nonce, { images: false, fonts: false })}">
  <title>Commit</title>
</head>
<body>
${body}
  <script nonce="${nonce}">${script}</script>
</body>
</html>`;
}

/**
 * How the Local Changes file list is grouped within each changelist.
 *
 * IntelliJ's `ChangesGroupingPolicy` supports directory / module / repository
 * grouping. IntelliG implements:
 *   - `flat`      — every file as a row showing its full repo-relative path
 *     (the pre-A4 behaviour).
 *   - `directory` — files nested under collapsible directory nodes, the
 *     IntelliJ default. Directory nodes show the directory path; file rows
 *     show just the basename.
 *
 * Module grouping has no VS Code analogue (no module model) and repository
 * grouping is the multi-root tool-window's job — both are out of scope here.
 */
export type ChangesGroupingMode = 'flat' | 'directory';

/** workspaceState key persisting the Local Changes grouping mode. */
export const CHANGES_GROUPING_STATE_KEY = 'intellig.commitToolWindow.changesGrouping';

/** Type-guard for a persisted grouping value. */
export function isChangesGroupingMode(value: unknown): value is ChangesGroupingMode {
  return value === 'flat' || value === 'directory';
}

/** A node in the directory-grouped file tree. Pure data — unit-tested. */
export interface IChangesTreeDirNode {
  /** Directory path relative to the repo root (`''` for repo root). */
  dir: string;
  /** Files that live directly in this directory. */
  files: IFileChange[];
}

/**
 * Group a changelist's files into directory buckets, sorted by directory then
 * filename. Each bucket holds the files that live directly in that directory
 * (no nested recursion — IntelliJ collapses single-child chains, but a flat
 * per-directory bucket is the simplest faithful grouping and keeps the render
 * + tests tractable).
 *
 * Pure — exported for unit + snapshot tests.
 */
export function groupFilesByDirectory(files: readonly IFileChange[]): IChangesTreeDirNode[] {
  const byDir = new Map<string, IFileChange[]>();
  for (const f of files) {
    const slash = f.path.lastIndexOf('/');
    const dir = slash === -1 ? '' : f.path.slice(0, slash);
    const bucket = byDir.get(dir);
    if (bucket) {
      bucket.push(f);
    } else {
      byDir.set(dir, [f]);
    }
  }
  return Array.from(byDir.entries())
    .map(([dir, dirFiles]) => ({
      dir,
      files: [...dirFiles].sort((a, b) => basename(a.path).localeCompare(basename(b.path))),
    }))
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

/** Last path segment (basename) of a repo-relative path. */
function basename(p: string): string {
  const slash = p.lastIndexOf('/');
  return slash === -1 ? p : p.slice(slash + 1);
}

/**
 * Split untracked (`untracked`) files out of the changelists into a separate
 * "Unversioned Files" bucket — IntelliJ renders these under a dedicated
 * top-level node rather than inside a changelist. Pure; the changelists are
 * returned with their untracked files removed so a file never renders twice.
 *
 * Exported for unit/snapshot tests.
 */
export function partitionUnversionedFiles(changelists: readonly IChangelist[]): {
  changelists: IChangelist[];
  unversioned: IFileChange[];
} {
  const unversioned: IFileChange[] = [];
  const filtered = changelists.map((cl) => {
    const tracked: IFileChange[] = [];
    for (const f of cl.files) {
      if (f.status === 'untracked') {
        unversioned.push(f);
      } else {
        tracked.push(f);
      }
    }
    return { ...cl, files: tracked };
  });
  unversioned.sort((a, b) => a.path.localeCompare(b.path));
  return { changelists: filtered, unversioned };
}

function shortStatusChar(status: string): string {
  switch (status) {
    case 'modified':
      return 'M';
    case 'added':
      return 'A';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    case 'copied':
      return 'C';
    case 'untracked':
      return '?';
    case 'ignored':
      return '!';
    case 'conflicted':
      return 'U';
    default:
      return status.charAt(0).toUpperCase();
  }
}

function commitToolWindowStyles(): string {
  return `
    body { margin: 0; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
    .ctw-tab-strip { display: flex; align-items: center; border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c); padding: 0 4px; }
    .ctw-tab { background: transparent; border: none; border-bottom: 2px solid transparent; padding: 6px 12px; color: inherit; font: inherit; cursor: pointer; }
    .ctw-tab:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
    .ctw-tab-active { border-bottom-color: var(--vscode-focusBorder, #0078d4); font-weight: 600; }
    .ctw-tab-spacer { flex: 1; }
    .ctw-gear { background: transparent; border: none; color: inherit; cursor: pointer; padding: 4px 8px; }
    .ctw-gear-wrap { position: relative; }
    .ctw-gear-menu { position: absolute; right: 0; top: 100%; background: var(--vscode-menu-background, #252526); border: 1px solid var(--vscode-menu-border, #454545); box-shadow: 0 4px 8px rgba(0,0,0,0.4); min-width: 220px; z-index: 10; }
    .ctw-gear-item { display: block; width: 100%; text-align: left; background: transparent; border: none; padding: 6px 12px; color: var(--vscode-disabledForeground, #888); cursor: not-allowed; }
    .ctw-body { display: flex; flex-direction: column; height: calc(100vh - 32px); }
    .ctw-panel { flex: 1 1 auto; flex-direction: column; overflow: auto; }
    .ctw-empty { padding: 16px; color: var(--vscode-descriptionForeground); }
    .ctw-changelist-tree { padding: 4px 0; }
    .ctw-changelist-row { display: flex; align-items: center; padding: 2px 8px; font-weight: 600; cursor: pointer; user-select: none; }
    .ctw-chevron { margin-right: 4px; }
    .ctw-changelist-name { flex: 1; }
    .ctw-changelist-active { font-style: italic; }
    .ctw-active-tag { color: var(--vscode-descriptionForeground); font-weight: normal; }
    .ctw-count { color: var(--vscode-descriptionForeground); font-weight: normal; font-size: 0.9em; }
    .ctw-file-row { display: flex; align-items: center; padding: 1px 8px 1px 28px; cursor: pointer; }
    .ctw-file-row:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.15)); }
    .ctw-file-status { width: 18px; color: var(--vscode-gitDecoration-modifiedResourceForeground); font-family: var(--vscode-editor-font-family, monospace); }
    .ctw-grouping { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c); }
    .ctw-grouping-label { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-right: 4px; }
    .ctw-grouping-btn { background: transparent; border: 1px solid transparent; color: inherit; padding: 2px 10px; cursor: pointer; font: inherit; border-radius: 3px; }
    .ctw-grouping-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
    .ctw-grouping-active { background: var(--vscode-inputOption-activeBackground, rgba(100,150,220,0.25)); border-color: var(--vscode-inputOption-activeBorder, var(--vscode-focusBorder, #0078d4)); }
    .ctw-dir-row { display: flex; align-items: center; padding: 1px 8px 1px 20px; color: var(--vscode-descriptionForeground); font-size: 0.9em; user-select: none; }
    .ctw-dir-chevron { margin-right: 4px; }
    .ctw-dir-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ctw-dir-group .ctw-file-row { padding-left: 40px; }
    .ctw-diff-preview { border-top: 1px solid var(--vscode-panel-border, #3c3c3c); max-height: 40%; overflow: auto; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.92em; }
    .ctw-diff-preview-empty { padding: 12px; color: var(--vscode-descriptionForeground); text-align: center; }
    .ctw-diff-preview-head { padding: 4px 8px; font-weight: 600; border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c); }
    .ctw-diff-preview-body { margin: 0; padding: 4px 8px; white-space: pre; }
    .ctw-diff-hunk-header { color: var(--vscode-descriptionForeground); }
    .ctw-diff-line { white-space: pre; }
    .ctw-diff-add { background: var(--vscode-diffEditor-insertedLineBackground, rgba(155,185,85,0.2)); }
    .ctw-diff-del { background: var(--vscode-diffEditor-removedLineBackground, rgba(255,0,0,0.2)); }
    .ctw-shelf-list { padding: 4px 0; }
    .ctw-shelf-row { display: flex; align-items: center; padding: 4px 8px; cursor: pointer; gap: 6px; }
    .ctw-shelf-row:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.15)); }
    .ctw-shelf-badge { width: 20px; text-align: center; opacity: 0.85; font-size: 0.95em; }
    .ctw-shelf-name { flex: 1; }
    .ctw-shelf-count { color: var(--vscode-descriptionForeground); font-size: 0.9em; font-family: var(--vscode-editor-font-family, monospace); }
    .ctw-shelf-alreadyUnshelved { color: var(--vscode-descriptionForeground); font-size: 0.85em; font-style: italic; margin-left: 4px; }
    .ctw-shelf-filter { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c); }
    .ctw-shelf-filter-label { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-right: 4px; }
    .ctw-shelf-filter-btn { background: transparent; border: 1px solid transparent; color: inherit; padding: 2px 10px; cursor: pointer; font: inherit; border-radius: 3px; }
    .ctw-shelf-filter-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
    .ctw-shelf-filter-active { background: var(--vscode-inputOption-activeBackground, rgba(100,150,220,0.25)); border-color: var(--vscode-inputOption-activeBorder, var(--vscode-focusBorder, #0078d4)); }
    .ctw-composer { border-top: 1px solid var(--vscode-panel-border, #3c3c3c); padding: 8px; display: flex; flex-direction: column; gap: 6px; }
    .ctw-composer-row { display: flex; gap: 4px; }
    .ctw-composer-msg { flex: 1; min-height: 60px; resize: vertical; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 4px 6px; font: inherit; }
    .ctw-msg-history { background: transparent; border: 1px solid var(--vscode-input-border, transparent); color: inherit; padding: 0 8px; cursor: pointer; }
    .ctw-composer-options { display: flex; gap: 16px; }
    .ctw-composer-actions { display: flex; justify-content: flex-end; position: relative; }
    .ctw-primary-group { display: flex; }
    .ctw-btn-commit, .ctw-btn-commit-dropdown, .ctw-btn-commit-and-push { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 12px; cursor: pointer; }
    .ctw-btn-commit-dropdown { border-left: 1px solid var(--vscode-button-separator, rgba(0,0,0,0.2)); padding: 4px 6px; }
    .ctw-primary-menu { position: absolute; right: 0; bottom: 100%; background: var(--vscode-menu-background); border: 1px solid var(--vscode-menu-border); min-width: 180px; z-index: 10; }
  `;
}

function commitToolWindowBehaviorScript(model: ICommitToolWindowInitModel): string {
  // `<`→`<` so the serialized model can never break out of the <script>.
  const initJson = JSON.stringify(model).replace(/</g, '\\u003c');
  return `
    (function () {
      const vscode = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : undefined;
      if (!vscode) return;

      const INIT = ${initJson};

      // ---- DOM builders (createElement — no host-side HTML strings) ----
      const el = function (tag, props) { return Object.assign(document.createElement(tag), props || {}); };
      const setAttrs = function (node, attrs) {
        for (const k in attrs) { if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, String(attrs[k])); }
        return node;
      };

      // Escape a value before splicing it into an attribute selector
      // ([data-path="<path>"]). Mirrors scriptBuilder.ts's cssEscapeHash:
      // prefers the native CSS.escape (present in the Chromium webview), falls
      // back to a minimal escaper under test DOMs that lack the CSS global. A
      // filename may legally contain a backslash on POSIX, which the old
      // quote-only escape left as an invalid selector that threw.
      const cssEscapeAttr = function (value) {
        var s = String(value);
        if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') {
          return CSS.escape(s);
        }
        return s.replace(/[^a-zA-Z0-9_-]/g, function (ch) { return '\\\\' + ch; });
      };

      function buildTabStrip() {
        const strip = el('div', { className: 'ctw-tab-strip' });
        setAttrs(strip, { role: 'tablist' });
        const tab = function (id, label) {
          const b = el('button', { className: 'ctw-tab' + (INIT.activeTab === id ? ' ctw-tab-active' : ''), textContent: label });
          setAttrs(b, { 'data-tab': id, role: 'tab', 'aria-selected': INIT.activeTab === id });
          return b;
        };
        strip.appendChild(tab('localChanges', 'Local Changes'));
        strip.appendChild(tab('shelf', 'Shelf'));
        strip.appendChild(el('div', { className: 'ctw-tab-spacer' }));
        const gearWrap = el('div', { className: 'ctw-gear-wrap' });
        const gear = el('button', { className: 'ctw-gear', textContent: '⚙' });
        setAttrs(gear, { title: 'Options', 'aria-haspopup': 'menu' });
        gearWrap.appendChild(gear);
        const gearMenu = el('div', { className: 'ctw-gear-menu', hidden: true });
        (INIT.gearItems || []).forEach(function (i) {
          const item = el('button', { className: 'ctw-gear-item', disabled: true, textContent: i.label });
          setAttrs(item, { title: i.tooltip });
          gearMenu.appendChild(item);
        });
        gearWrap.appendChild(gearMenu);
        strip.appendChild(gearWrap);
        return strip;
      }

      function buildFileRow(f, changelistId) {
        const row = el('div', { className: 'ctw-file-row' });
        setAttrs(row, { 'data-path': f.path, 'data-changelist': changelistId });
        const chk = el('input', { type: 'checkbox', className: 'ctw-file-check' });
        setAttrs(chk, { 'data-path': f.path });
        row.appendChild(chk);
        row.appendChild(el('span', { className: 'ctw-file-status', textContent: f.statusChar }));
        row.appendChild(el('span', { className: 'ctw-file-path', textContent: f.displayName }));
        return row;
      }

      // Append a changelist's files into its block, honoring grouping. Flat
      // mode appends file rows directly; directory mode wraps each bucket in a
      // .ctw-dir-group (with an optional .ctw-dir-row header).
      function appendChangelistFiles(block, cl) {
        if (cl.dirGroups) {
          cl.dirGroups.forEach(function (g) {
            const group = el('div', { className: 'ctw-dir-group' });
            if (g.dir !== null && g.dir !== undefined) {
              const dirRow = el('div', { className: 'ctw-dir-row' });
              setAttrs(dirRow, { 'data-dir': g.dir });
              dirRow.appendChild(el('span', { className: 'ctw-dir-chevron', textContent: '▾' }));
              dirRow.appendChild(el('span', { className: 'ctw-dir-path', textContent: g.dir }));
              group.appendChild(dirRow);
            }
            (g.files || []).forEach(function (f) { group.appendChild(buildFileRow(f, cl.id)); });
            block.appendChild(group);
          });
        } else {
          (cl.files || []).forEach(function (f) { block.appendChild(buildFileRow(f, cl.id)); });
        }
      }

      function buildChangelistBlock(cl, opts) {
        const block = el('div', { className: 'ctw-changelist-block' + (opts && opts.unversioned ? ' ctw-unversioned-block' : '') });
        const header = el('div', { className: 'ctw-changelist-row' + (opts && opts.unversioned ? ' ctw-unversioned-row' : '') });
        setAttrs(header, { 'data-changelist': cl.id });
        header.appendChild(el('span', { className: 'ctw-chevron', textContent: '▾' }));
        const name = el('span', { className: 'ctw-changelist-name' + (cl.isActive ? ' ctw-changelist-active' : '') });
        name.appendChild(document.createTextNode(cl.name));
        if (cl.isActive) {
          name.appendChild(document.createTextNode(' '));
          name.appendChild(el('span', { className: 'ctw-active-tag', textContent: '(Active)' }));
        }
        header.appendChild(name);
        header.appendChild(el('span', { className: 'ctw-count', textContent: cl.fileCount + ' file' + (cl.fileCount === 1 ? '' : 's') }));
        block.appendChild(header);
        appendChangelistFiles(block, cl);
        return block;
      }

      function buildGroupingToggle() {
        const wrap = el('div', { className: 'ctw-grouping' });
        setAttrs(wrap, { role: 'radiogroup', 'aria-label': 'Group by' });
        wrap.appendChild(el('span', { className: 'ctw-grouping-label', textContent: 'Group by:' }));
        const btn = function (value, label) {
          const b = el('button', { className: 'ctw-grouping-btn' + (INIT.grouping === value ? ' ctw-grouping-active' : ''), textContent: label });
          setAttrs(b, { 'data-grouping': value, 'aria-pressed': INIT.grouping === value });
          return b;
        };
        wrap.appendChild(btn('directory', 'Directory'));
        wrap.appendChild(btn('flat', 'Flat'));
        return wrap;
      }

      function buildLocalChangesPanel() {
        const frag = document.createDocumentFragment();
        frag.appendChild(buildGroupingToggle());
        if (INIT.local.empty) {
          frag.appendChild(el('div', { className: 'ctw-empty', textContent: 'No uncommitted changes.' }));
          return frag;
        }
        const tree = el('div', { className: 'ctw-changelist-tree' });
        setAttrs(tree, { role: 'tree' });
        INIT.local.changelists.forEach(function (cl) { tree.appendChild(buildChangelistBlock(cl)); });
        if (INIT.local.unversioned) { tree.appendChild(buildChangelistBlock(INIT.local.unversioned, { unversioned: true })); }
        frag.appendChild(tree);
        const pane = el('div', { className: 'ctw-diff-preview' });
        setAttrs(pane, { 'data-diff-preview': '' });
        pane.appendChild(el('div', { className: 'ctw-diff-preview-empty', textContent: 'Select a file to preview changes' }));
        frag.appendChild(pane);
        return frag;
      }

      function buildComposerPanel() {
        const c = INIT.composer;
        const wrap = el('div', { className: 'ctw-composer' });
        const row = el('div', { className: 'ctw-composer-row' });
        const ta = el('textarea', { className: 'ctw-composer-msg', value: c.message });
        setAttrs(ta, { placeholder: 'Commit message' });
        row.appendChild(ta);
        const hist = el('button', { className: 'ctw-msg-history', textContent: '∨' });
        setAttrs(hist, { title: 'Recent messages' });
        row.appendChild(hist);
        wrap.appendChild(row);
        const opts = el('div', { className: 'ctw-composer-options' });
        const checkbox = function (cls, checked, label) {
          const lbl = el('label');
          const input = el('input', { type: 'checkbox', className: cls, checked: !!checked });
          lbl.appendChild(input);
          lbl.appendChild(document.createTextNode(' ' + label));
          return lbl;
        };
        opts.appendChild(checkbox('ctw-chk-amend', c.amend, 'Amend'));
        opts.appendChild(checkbox('ctw-chk-signoff', c.signOff, 'Sign-off'));
        wrap.appendChild(opts);
        const actions = el('div', { className: 'ctw-composer-actions' });
        const group = el('div', { className: 'ctw-primary-group' });
        const commitBtn = el('button', { className: 'ctw-btn-commit', textContent: 'Commit' });
        setAttrs(commitBtn, { type: 'button' });
        group.appendChild(commitBtn);
        const dropdown = el('button', { className: 'ctw-btn-commit-dropdown', textContent: '▾' });
        setAttrs(dropdown, { type: 'button', 'aria-haspopup': 'menu' });
        group.appendChild(dropdown);
        actions.appendChild(group);
        const menu = el('div', { className: 'ctw-primary-menu', hidden: true });
        const cap = el('button', { className: 'ctw-btn-commit-and-push', textContent: 'Commit and Push…' });
        setAttrs(cap, { type: 'button' });
        menu.appendChild(cap);
        actions.appendChild(menu);
        wrap.appendChild(actions);
        return wrap;
      }

      function buildShelfFilterHeader() {
        const wrap = el('div', { className: 'ctw-shelf-filter' });
        setAttrs(wrap, { role: 'radiogroup', 'aria-label': 'Show' });
        wrap.appendChild(el('span', { className: 'ctw-shelf-filter-label', textContent: 'Show:' }));
        const btn = function (value, label) {
          const b = el('button', { className: 'ctw-shelf-filter-btn' + (INIT.shelf.filter === value ? ' ctw-shelf-filter-active' : ''), textContent: label });
          setAttrs(b, { 'data-shelf-filter': value, 'aria-pressed': INIT.shelf.filter === value });
          return b;
        };
        wrap.appendChild(btn('shelves', 'Shelves'));
        wrap.appendChild(btn('stashes', 'Stashes'));
        wrap.appendChild(btn('both', 'Both'));
        return wrap;
      }

      function buildShelfRow(entry) {
        const row = el('div', { className: 'ctw-shelf-row' });
        setAttrs(row, { role: 'listitem' });
        if (entry.kind === 'shelf') {
          setAttrs(row, { 'data-row-kind': 'shelf', 'data-shelf-id': entry.id });
          const badge = el('span', { className: 'ctw-shelf-badge', textContent: '📚' });
          setAttrs(badge, { title: 'Shelf entry' });
          row.appendChild(badge);
          const name = el('span', { className: 'ctw-shelf-name' });
          name.appendChild(document.createTextNode(entry.name));
          if (entry.alreadyUnshelved) {
            name.appendChild(document.createTextNode(' '));
            name.appendChild(el('span', { className: 'ctw-shelf-alreadyUnshelved', textContent: '(already unshelved)' }));
          }
          row.appendChild(name);
          row.appendChild(el('span', { className: 'ctw-shelf-count', textContent: entry.fileCount + ' file' + (entry.fileCount === 1 ? '' : 's') }));
        } else {
          setAttrs(row, { 'data-row-kind': 'stash', 'data-stash-index': entry.index });
          const badge = el('span', { className: 'ctw-shelf-badge', textContent: '📦' });
          setAttrs(badge, { title: 'Git stash' });
          row.appendChild(badge);
          row.appendChild(el('span', { className: 'ctw-shelf-name', textContent: entry.name }));
          row.appendChild(el('span', { className: 'ctw-shelf-count', textContent: entry.id }));
        }
        return row;
      }

      function buildShelfPanel() {
        const frag = document.createDocumentFragment();
        frag.appendChild(buildShelfFilterHeader());
        if (INIT.shelf.empty) {
          frag.appendChild(el('div', { className: 'ctw-empty', textContent: INIT.shelf.emptyCopy }));
          return frag;
        }
        const list = el('div', { className: 'ctw-shelf-list' });
        setAttrs(list, { role: 'list' });
        INIT.shelf.rows.forEach(function (r) { list.appendChild(buildShelfRow(r)); });
        frag.appendChild(list);
        return frag;
      }

      // Assemble the tool window into #ctw-root before wiring listeners.
      (function buildDom() {
        const root = document.getElementById('ctw-root');
        if (!root) return;
        root.appendChild(buildTabStrip());
        const bodyEl = el('div', { className: 'ctw-body' });
        const localPanel = el('div', { className: 'ctw-panel' });
        setAttrs(localPanel, { 'data-panel': 'localChanges', style: 'display:' + (INIT.showLocal ? 'flex' : 'none') + ';' });
        localPanel.appendChild(buildLocalChangesPanel());
        localPanel.appendChild(buildComposerPanel());
        bodyEl.appendChild(localPanel);
        const shelfPanel = el('div', { className: 'ctw-panel' });
        setAttrs(shelfPanel, { 'data-panel': 'shelf', style: 'display:' + (INIT.showLocal ? 'none' : 'flex') + ';' });
        shelfPanel.appendChild(buildShelfPanel());
        bodyEl.appendChild(shelfPanel);
        root.appendChild(bodyEl);
      })();

      // Tab click
      document.querySelectorAll('.ctw-tab').forEach(function (btn) {
        btn.addEventListener('click', function () {
          const tab = btn.getAttribute('data-tab');
          if (tab) vscode.postMessage({ type: 'tabChange', tab: tab });
        });
      });

      // Gear toggle
      const gear = document.querySelector('.ctw-gear');
      const gearMenu = document.querySelector('.ctw-gear-menu');
      if (gear && gearMenu) {
        gear.addEventListener('click', function () { gearMenu.hidden = !gearMenu.hidden; });
      }

      // File row click → selectFile, checkbox change → toggleFile
      document.querySelectorAll('.ctw-file-row').forEach(function (row) {
        row.addEventListener('click', function (e) {
          if (e.target && e.target.tagName === 'INPUT') return; // checkbox handled below
          const path = row.getAttribute('data-path');
          if (path) vscode.postMessage({ type: 'selectFile', path: path });
        });
      });
      document.querySelectorAll('.ctw-file-check').forEach(function (chk) {
        chk.addEventListener('change', function () {
          const path = chk.getAttribute('data-path');
          if (path) vscode.postMessage({ type: 'toggleFile', path: path });
        });
      });

      // Right-click on a changelist row or file row → send a context-action
      // ping to the host. Host decides what menu to present (keeps the
      // menu labels in one place — see changelistContextMenuLabels /
      // fileContextMenuLabels in the host module).
      document.addEventListener('contextmenu', function (e) {
        if (!(e.target instanceof Element)) return;
        const row = e.target.closest('.ctw-changelist-row, .ctw-file-row, .ctw-shelf-row');
        if (!row) return;
        e.preventDefault();
        // Shelf/stash rows take precedence — they open a QuickPick
        // via a dedicated host message rather than the changelist-flavored
        // context-action.
        if (row.classList.contains('ctw-shelf-row')) {
          const rowKind = row.getAttribute('data-row-kind');
          const shelfId = row.getAttribute('data-shelf-id');
          const stashIdxAttr = row.getAttribute('data-stash-index');
          vscode.postMessage({
            type: 'shelfTabContextAction',
            action: 'contextOpen',
            rowKind: rowKind,
            shelfId: shelfId || undefined,
            stashIndex: stashIdxAttr === null ? undefined : Number(stashIdxAttr),
          });
          return;
        }
        const path = row.getAttribute('data-path');
        const changelistId = row.getAttribute('data-changelist');
        vscode.postMessage({
          type: 'changelistContextAction',
          action: 'contextOpen',
          changelistId: changelistId,
          path: path,
        });
      });

      // Shelf-tab filter segmented control.
      document.querySelectorAll('.ctw-shelf-filter-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          const f = btn.getAttribute('data-shelf-filter');
          if (f === 'shelves' || f === 'stashes' || f === 'both') {
            vscode.postMessage({ type: 'shelfTabFilterChange', filter: f });
          }
        });
      });

      // Local Changes grouping segmented control (Directory / Flat).
      document.querySelectorAll('.ctw-grouping-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          const g = btn.getAttribute('data-grouping');
          if (g === 'flat' || g === 'directory') {
            vscode.postMessage({ type: 'changesGroupingChange', grouping: g });
          }
        });
      });

      // Plain click on a shelf-tab row → selection / preview. For
      // MVP this is a no-op; kept in the dispatcher so it's easy to hook
      // a diff preview when the UX spec grows.
      document.querySelectorAll('.ctw-shelf-row').forEach(function (row) {
        row.addEventListener('click', function () {
          // Reserved — host doesn't currently act on row clicks.
        });
      });

      // Composer fields
      const msgField = document.querySelector('.ctw-composer-msg');
      const amendChk = document.querySelector('.ctw-chk-amend');
      const signoffChk = document.querySelector('.ctw-chk-signoff');
      if (msgField) {
        msgField.addEventListener('input', function () {
          vscode.postMessage({ type: 'updateComposerField', message: msgField.value });
        });
      }
      if (amendChk) {
        amendChk.addEventListener('change', function () {
          vscode.postMessage({ type: 'updateComposerField', amend: amendChk.checked });
        });
      }
      if (signoffChk) {
        signoffChk.addEventListener('change', function () {
          vscode.postMessage({ type: 'updateComposerField', signOff: signoffChk.checked });
        });
      }

      // Primary commit button
      const commitBtn = document.querySelector('.ctw-btn-commit');
      const commitDropdownBtn = document.querySelector('.ctw-btn-commit-dropdown');
      const commitPushMenu = document.querySelector('.ctw-primary-menu');
      const commitAndPushBtn = document.querySelector('.ctw-btn-commit-and-push');

      function getComposerPayload() {
        return {
          message: msgField ? msgField.value : '',
          amend: amendChk ? amendChk.checked : false,
          signOff: signoffChk ? signoffChk.checked : false,
          files: Array.prototype.slice
            .call(document.querySelectorAll('.ctw-file-check'))
            .filter(function (c) { return c.checked; })
            .map(function (c) { return c.getAttribute('data-path'); }),
        };
      }

      if (commitBtn) {
        commitBtn.addEventListener('click', function () {
          vscode.postMessage(Object.assign({ type: 'commit' }, getComposerPayload()));
        });
      }
      if (commitDropdownBtn && commitPushMenu) {
        commitDropdownBtn.addEventListener('click', function () {
          commitPushMenu.hidden = !commitPushMenu.hidden;
        });
      }
      if (commitAndPushBtn) {
        commitAndPushBtn.addEventListener('click', function () {
          vscode.postMessage(Object.assign({ type: 'commitAndPush' }, getComposerPayload()));
          if (commitPushMenu) commitPushMenu.hidden = true;
        });
      }

      // Message-history dropdown — request history from the host and render
      // a simple native <select>-like overlay. Phase 1 keeps this minimal.
      const histBtn = document.querySelector('.ctw-msg-history');
      if (histBtn) {
        histBtn.addEventListener('click', function () {
          vscode.postMessage({ type: 'messageHistoryRequest' });
        });
      }

      // Render a diff into the preview pane. Builds DOM nodes (no innerHTML
      // with interpolated content) so a hostile path/line can't inject markup.
      function renderDiffPreview(pane, path, diff, error) {
        while (pane.firstChild) pane.removeChild(pane.firstChild);
        const head = document.createElement('div');
        head.className = 'ctw-diff-preview-head';
        head.textContent = path || '';
        pane.appendChild(head);
        if (error) {
          const err = document.createElement('div');
          err.className = 'ctw-diff-preview-empty';
          err.textContent = 'Failed to load diff: ' + error;
          pane.appendChild(err);
          return;
        }
        if (!diff || diff.binary || !diff.hunks || diff.hunks.length === 0) {
          const note = document.createElement('div');
          note.className = 'ctw-diff-preview-empty';
          note.textContent = diff && diff.binary ? 'Binary file' : 'No changes';
          pane.appendChild(note);
          return;
        }
        const body = document.createElement('pre');
        body.className = 'ctw-diff-preview-body';
        (diff.hunks || []).forEach(function (hunk) {
          const h = document.createElement('div');
          h.className = 'ctw-diff-hunk-header';
          h.textContent = hunk.header || '';
          body.appendChild(h);
          (hunk.lines || []).forEach(function (line) {
            const row = document.createElement('div');
            const t = line.type === 'add' ? 'add' : line.type === 'delete' ? 'del' : 'ctx';
            row.className = 'ctw-diff-line ctw-diff-' + t;
            const prefix = t === 'add' ? '+' : t === 'del' ? '-' : ' ';
            row.textContent = prefix + (line.content != null ? line.content : '');
            body.appendChild(row);
          });
        });
        pane.appendChild(body);
      }

      window.addEventListener('message', function (ev) {
        const m = ev.data;
        if (!m || typeof m.type !== 'string') return;
        if (m.type === 'updateFileCheckbox' && typeof m.path === 'string') {
          const box = document.querySelector('.ctw-file-check[data-path="' + cssEscapeAttr(m.path) + '"]');
          if (box) box.checked = !!m.checked;
        }
        if (m.type === 'updateDiffPreview') {
          const pane = document.querySelector('[data-diff-preview]');
          if (pane) renderDiffPreview(pane, m.path, m.diff, m.error);
        }
        if (m.type === 'commitDone' && m.success && msgField) {
          msgField.value = '';
        }
      });
    })();
  `;
}

/**
 * Read the `intellig.useCommitToolWindow` flag. The manifest default is
 * `true`, so the in-code fallback matches it (it only fires when the
 * configuration service is unavailable).
 */
export function isCommitToolWindowEnabled(): boolean {
  try {
    const config = vscode.workspace.getConfiguration('intellig');
    return Boolean(config.get<boolean>(COMMIT_TOOL_WINDOW_CONFIG_KEY, true));
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
