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
import {
  loadPersisted,
  savePersisted,
  readBoolean,
  readEnum,
  readStringArray,
  type PersistedSlot,
} from '../utils/persistedState';
import {
  IChangelist,
  IFileChange,
  IChangelistService,
} from '../changelists/interfaces/IChangelistService';
import { IShelfItem, IShelfService } from '../shelf/interfaces/IShelfService';
import { IGitService, IRepository, IStash, FileStatus } from '../git-core/interfaces/IGitService';
import { performCommit, LAST_NO_VERIFY_SLOT } from './CommitDialog';
import { AmendMessageTracker, loadHeadCommitMessage } from './amendMessage';
import { runBeforeCommitChecks } from './CheckinChecks';
import { resolveRepo } from '../utils/resolveRepo';
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
  IShelfTabEntry,
  ChangelistAction,
  FileAction,
  ShelfTabShelfAction,
  ShelfTabStashAction,
  ICommitToolWebviewMessage,
  ICommitToolWindowInitModel,
  ICtwChangelistModel,
  ICtwFileEntry,
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

/** workspaceState key for the currently-active tab (Local Changes / Shelf). */
export const ACTIVE_TAB_STATE_KEY = 'intellig.commitToolWindow.activeTab';

/** workspaceState key for the recent-commit-messages LRU. */
export const RECENT_MESSAGES_STATE_KEY = 'intellig.recentCommitMessages';

/**
 * workspaceState key for the Shelf-tab filter toggle.
 * One of `'shelves' | 'stashes' | 'both'` (default `'both'`).
 */
export const SHELF_TAB_FILTER_STATE_KEY = 'intellig.commitToolWindow.shelfFilter';

/** workspaceState key for the sticky Sign-off checkbox. */
export const SIGN_OFF_STATE_KEY = 'intellig.commitToolWindow.signOff';

/** Maximum size of the recent-commit-messages LRU. */
export const RECENT_MESSAGES_MAX = 20;

/**
 * Trailing-coalescer window for live pushes. Matches ChangelistService's
 * reconcile debounce so a reconcile burst costs one push; upstream lanes
 * (250 ms repo watcher, 1 s/5 s status lane) debounce independently.
 */
const LIVE_UPDATE_DEBOUNCE_MS = 300;

/** Sentinel id for the "Unversioned Files" pseudo-changelist. */
export const UNVERSIONED_PSEUDO_CHANGELIST_ID = '_unversioned';

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
  /** Clear the whole stash stack (warning confirm owned by the view). */
  clearAll?: () => Promise<void>;
}

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

/** Persisted slot for the active tab (Local Changes / Shelf). */
export const ACTIVE_TAB_SLOT: PersistedSlot<CommitToolWindowTab> = {
  key: ACTIVE_TAB_STATE_KEY,
  version: 1,
  validate: readEnum<CommitToolWindowTab>(['localChanges', 'shelf']),
};

/** Persisted slot for the Shelf-tab filter toggle. */
export const SHELF_TAB_FILTER_SLOT: PersistedSlot<ShelfTabFilter> = {
  key: SHELF_TAB_FILTER_STATE_KEY,
  version: 1,
  validate: (raw) => (isShelfTabFilter(raw) ? raw : undefined),
};

/** Persisted slot for the recent-commit-messages LRU (shared with CommitDialog). */
export const RECENT_MESSAGES_SLOT: PersistedSlot<string[]> = {
  key: RECENT_MESSAGES_STATE_KEY,
  version: 1,
  validate: readStringArray,
};

/**
 * Persisted slot for the Sign-off checkbox — a sticky preference like
 * IntelliJ's (GitCommitOptions persists it), not per-commit state.
 */
export const SIGN_OFF_SLOT: PersistedSlot<boolean> = {
  key: SIGN_OFF_STATE_KEY,
  version: 1,
  validate: readBoolean,
};

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
    { label: 'Move to Another Changelist…', action: 'moveToChangelist', shortcut: 'Alt+Shift+M' },
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
 * Gear-menu items for the composer. The single entry toggles the persisted
 * no-verify flag the commit path reads (shared with CommitDialog's gear via
 * LAST_NO_VERIFY_SLOT); `checked` mirrors that flag.
 */
export function gearMenuItems(
  noVerify: boolean
): Array<{ id: 'toggleNoVerify'; label: string; checked: boolean }> {
  return [
    {
      id: 'toggleNoVerify',
      label: 'Disable pre-commit hooks (--no-verify)',
      checked: noVerify,
    },
  ];
}

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
    { label: 'Clear All Stashes', action: 'stashClearAll' },
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
export class CommitToolWindow extends BaseWebviewView<CommitToolWindowOutbound> {
  public static readonly viewId = COMMIT_TOOL_WINDOW_VIEW_ID;

  private _activeTab: CommitToolWindowTab = 'localChanges';
  private _amend = false;
  private readonly _amendTracker = new AmendMessageTracker();
  private _signOff = false;
  /** Re-entrancy guard: true while a commit is in flight (blocks double-submit). */
  private _committing = false;
  private _composerMessage = '';

  private _changelists: IChangelist[] = [];
  private _shelfItems: IShelfItem[] = [];
  /** Most recent `git stash list` snapshot. */
  private _stashEntries: IStash[] = [];
  /** Trailing coalescer for {@link _pushLiveUpdate} (service-event bursts). */
  private _liveUpdateTimer: ReturnType<typeof setTimeout> | undefined;
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
    this._lastSelectedFileUri = vscode.Uri.joinPath(repo.rootUri, path);
    try {
      const diff = await this._gitService.getDiff(repo, path, /* staged */ false);
      void this.postMessage({ type: 'updateDiffPreview', path, diff });
    } catch (error) {
      void this.postMessage({
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
      case 'moveToChangelist': {
        // The context-menu message carries only the clicked path; an explicit
        // targetFiles list (multi-select) takes precedence when present.
        const files = message.targetFiles ?? (message.path ? [message.path] : undefined);
        if (files) {
          await vscode.commands.executeCommand('intellig.changelist.moveFilesTo', files);
        }
        return;
      }
      case 'showDiff':
        if (message.path) {
          const fileUri = await this._resolveFileUri(message.path);
          if (fileUri) {
            await vscode.commands.executeCommand('intellig.explorer.showDiff', fileUri);
          }
        }
        return;
      case 'jumpToSource':
        if (message.path) {
          const fileUri = await this._resolveFileUri(message.path);
          if (fileUri) {
            await vscode.commands.executeCommand('intellig.localChanges.openFile', fileUri);
          }
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
          const fileUri = await this._resolveFileUri(message.path);
          if (fileUri) {
            await vscode.commands.executeCommand('intellig.explorer.addToVcs', fileUri);
          }
        }
        return;
      case 'showHistory':
        if (message.path) {
          const fileUri = await this._resolveFileUri(message.path);
          if (fileUri) {
            await vscode.commands.executeCommand('intellig.showHistory', fileUri);
          }
        }
        return;
      case 'annotate':
        if (message.path) {
          const fileUri = await this._resolveFileUri(message.path);
          if (fileUri) {
            await vscode.commands.executeCommand('intellig.toggleBlame', fileUri);
          }
        }
        return;
    }
  }

  /**
   * Resolve a webview row's repo-relative path to an absolute file Uri for
   * dispatch to the owning commands (their handlers expect a `vscode.Uri`,
   * not the bare relative string the webview carries).
   */
  private async _resolveFileUri(path: string): Promise<vscode.Uri | undefined> {
    const repo = await this._resolveRepo();
    return repo ? vscode.Uri.joinPath(repo.rootUri, path) : undefined;
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
    const repo =
      repoOverride ??
      (await resolveRepo(this._gitService, {
        preferActive: true,
        silent: true,
        nonInteractive: true,
      }));
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
    }

    const model = buildCommitToolWindowInitModel(this._renderInput());
    const fingerprint = fingerprintCtwModel(model);
    if (fingerprint === this._lastPushedFingerprint) {
      return;
    }
    this._lastPushedFingerprint = fingerprint;
    this._lastPostDelivered = await this.postMessage({ type: 'updateModel', model });
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
    };
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
        case 'stashClearAll':
          await this._stashController.clearAll?.();
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
  activeTab: CommitToolWindowTab;
  changelists: readonly IChangelist[];
  shelfItems: readonly IShelfItem[];
  /** Unified shelf+stash entries. Derived from shelfItems + stashes. */
  shelfTabEntries?: readonly IShelfTabEntry[];
  /** Active Shelf-tab filter, used to render the segmented control. */
  shelfTabFilter?: ShelfTabFilter;
  composer: { message: string; amend: boolean; signOff: boolean; noVerify?: boolean };
  activeChangelistId?: string;
  /** Local Changes file-grouping mode. Defaults to `flat` when omitted. */
  grouping?: ChangesGroupingMode;
  /** Checked file paths (host-owned inclusion model). Defaults to none. */
  selectedFiles?: readonly string[];
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
export function buildCommitToolWindowInitModel(input: IRenderInput): ICommitToolWindowInitModel {
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
    gearItems: gearMenuItems(composer.noVerify ?? false),
    composer: { message: composer.message, amend: composer.amend, signOff: composer.signOff },
    selectedFiles: [...(input.selectedFiles ?? [])],
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

/** workspaceState key persisting the Local Changes grouping mode. */
export const CHANGES_GROUPING_STATE_KEY = 'intellig.commitToolWindow.changesGrouping';

/** Type-guard for a persisted grouping value. */
export function isChangesGroupingMode(value: unknown): value is ChangesGroupingMode {
  return value === 'flat' || value === 'directory';
}

/** Persisted slot for the Local Changes grouping mode. */
export const CHANGES_GROUPING_SLOT: PersistedSlot<ChangesGroupingMode> = {
  key: CHANGES_GROUPING_STATE_KEY,
  version: 1,
  validate: (raw) => (isChangesGroupingMode(raw) ? raw : undefined),
};

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
    .ctw-composer-options { display: flex; gap: 16px; }
    .ctw-composer-actions { display: flex; justify-content: flex-end; position: relative; }
    .ctw-primary-group { display: flex; }
    .ctw-btn-commit, .ctw-btn-commit-dropdown, .ctw-btn-commit-and-push { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 12px; cursor: pointer; }
    .ctw-btn-commit-dropdown { border-left: 1px solid var(--vscode-button-separator, rgba(0,0,0,0.2)); padding: 4px 6px; }
    .ctw-primary-menu { position: absolute; right: 0; bottom: 100%; background: var(--vscode-menu-background); border: 1px solid var(--vscode-menu-border); min-width: 180px; z-index: 10; }
  `;
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
