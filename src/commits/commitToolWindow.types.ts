/**
 * Pure data types for the Commit Tool Window — vscode-free AND node-free.
 *
 * Split out of {@link import('./CommitToolWindow').CommitToolWindow} (which
 * imports `vscode`) so the panel's `commitToolWindow.protocol.ts` and its
 * bundled webview entry can type-import the wire shapes + init model without
 * pulling the vscode/node runtime into the DOM-only webview program.
 * {@link import('./CommitToolWindow')} re-exports every type below, so existing
 * importers (and the `src/services` barrel) are unchanged.
 */

import type { IContextMenuItem } from '../webview-common/contextMenuItem';

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
      /**
       * The stash's commit sha, when git reported one. Survives the stack
       * renumbering that `index` does not, so a row opened on one stash can be
       * told apart from whatever later occupies its slot.
       */
      hash?: string;
    };

/** Action payload on a changelist-level context menu entry. */
export type ChangelistAction =
  'new' | 'setActive' | 'rename' | 'editDescription' | 'delete' | 'commitOnly' | 'shelve';

/** Action payload on a file-level context menu entry. */
export type FileAction =
  | 'resolveConflictFile'
  | 'acceptYours'
  | 'acceptTheirs'
  | 'showDiff'
  | 'jumpToSource'
  | 'moveToChangelist'
  | 'rollback'
  | 'shelve'
  | 'addToVcs'
  | 'showHistory'
  | 'annotate';

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
  | 'stashBranchFromStash'
  | 'stashClearAll';

/** Message types posted from the webview to the host. */
export interface ICommitToolWebviewMessage {
  type: string;
  tab?: CommitToolWindowTab;
  path?: string;
  changelistId?: string;
  message?: string;
  amend?: boolean;
  signOff?: boolean;
  files?: string[];
  /**
   * `contextOpen` is the right-click ping that asks the host for the menu's
   * items; the webview draws them and posts back the concrete action the user
   * picked. It rides the same `action` field as those concrete actions.
   */
  action?:
    ChangelistAction | FileAction | ShelfTabShelfAction | ShelfTabStashAction | 'contextOpen';
  targetFiles?: string[];
  /** Gear-menu item being toggled when `type` is `gearAction`. */
  id?: 'toggleNoVerify';
  /** Newly-selected Shelf-tab filter from the segmented control. */
  filter?: ShelfTabFilter;
  /** Newly-selected Local Changes grouping mode from the segmented control. */
  grouping?: ChangesGroupingMode;
  /** Row kind being operated on when `action` targets a Shelf-tab row. */
  rowKind?: 'shelf' | 'stash';
  /**
   * Repo root the view was rendered against, echoed back on file actions. The
   * host drops a message whose root is no longer the sticky target: the
   * selector can retarget mid-flight and rows still on screen belong to the
   * previous repo, so acting on them would resolve a stale path against the
   * new root.
   */
  repoRoot?: string;
  /** Shelf entry id (when rowKind === 'shelf'). */
  shelfId?: string;
  /** Stash index (when rowKind === 'stash'). */
  stashIndex?: number;
  /**
   * Stash commit sha the row displayed. A stash is addressed by POSITION and
   * positions move, so the index alone cannot tell the host whether the entry
   * it is about to act on is the one the user clicked.
   */
  stashSha?: string;
}

/** An action a context-menu row can carry — the union the wire message accepts. */
export type CtwMenuAction =
  ChangelistAction | FileAction | ShelfTabShelfAction | ShelfTabStashAction;

/**
 * One row of the Commit window's context menu, as the host describes it.
 *
 * Extends the shared row type rather than restating a subset of it, so this
 * window can express everything the widget can draw — `danger` and
 * `separator` included — and both windows tint a destructive row alike.
 */
export interface ICtwMenuItem extends IContextMenuItem {
  label: string;
  action: CtwMenuAction;
}

/**
 * What a context menu was opened on, so a pick is attributed back to it.
 *
 * `rowKind` decides which wire message the pick becomes: a Shelf or Stash row
 * answers on the Shelf tab's channel, everything else on the changelist one.
 */
export interface ICtwMenuTarget {
  path?: string;
  changelistId?: string;
  rowKind?: 'shelf' | 'stash';
  shelfId?: string;
  stashIndex?: number;
  stashSha?: string;
  /**
   * Repo the row belonged to when it was right-clicked. The pick is a second,
   * later message, and the selector can retarget the view in between — so the
   * host's staleness guard has to be handed the root from the GESTURE, not
   * whatever the view is showing by the time the user picks.
   */
  repoRoot?: string;
}

/** A single file entry in the Local Changes render model. */
export interface ICtwFileEntry {
  path: string;
  statusChar: string;
  /** Full path in flat mode, basename in directory mode. */
  displayName: string;
  /**
   * Unmerged, per git's index rather than any marker text in the file. Set
   * host-side from the shared status mapping so the webview never re-derives
   * it from `statusChar` — a `=== 'U'` test misses the AA and DD conflicts
   * that carry no `U` column (see `isConflictedStatusCode`).
   */
  conflicted?: boolean;
  /**
   * Set when `status === 'untracked'`. `fileContextMenuLabels` adds "Add to
   * VCS" on this state, so `rowSignature` (ctwContextMenu.ts) must be able to
   * tell a tracked row from an untracked one to keep a stale menu from
   * outliving a tracked<->untracked flip.
   */
  untracked?: boolean;
}

/**
 * A conflicted row lifted into the Merge Conflicts node. It keeps the id of
 * the changelist it came from so its row actions still target the right list.
 */
export interface ICtwConflictEntry extends ICtwFileEntry {
  changelistId: string;
  /**
   * Conflict regions git marked up in the file. Absent when the file has none
   * to count — a binary or delete/modify conflict — so the row shows no count
   * rather than a misleading zero.
   */
  conflictCount?: number;
}

/**
 * The Merge Conflicts node: every unmerged file across all changelists,
 * pulled out of its normal position so a conflict cannot go unnoticed.
 * Always flat and always full paths — the rows are few and knowing where each
 * one lives matters more than the tree shape here.
 */
export interface ICtwConflictsModel {
  fileCount: number;
  files: ICtwConflictEntry[];
}

/** One changelist (or the unversioned pseudo-node) in the render model. */
export interface ICtwChangelistModel {
  id: string;
  name: string;
  isActive: boolean;
  fileCount: number;
  /**
   * Unmerged files, lifted to the top of THIS changelist's subtree. Null when
   * the list holds none. Nested here rather than above the changelists because
   * that is where IntelliJ puts it, and because a list holding only conflicts
   * must keep its header and its own actions.
   */
  conflicts?: ICtwConflictsModel | null;
  /** Present in flat grouping: file rows rendered directly. */
  files?: ICtwFileEntry[];
  /** Present in directory grouping: files bucketed under directory nodes. */
  dirGroups?: Array<{ dir: string | null; files: ICtwFileEntry[] }>;
}

/**
 * JSON-serializable render model for the Commit Tool Window. The host
 * precomputes everything the webview entry needs to build the DOM via
 * createElement (no host-side HTML strings), so the entry is a pure
 * data→DOM mapper. Crosses to the webview as the init island.
 */
export interface ICommitToolWindowInitModel {
  activeTab: CommitToolWindowTab;
  /** Repo root these rows were built from; echoed back on every file action. */
  repoRoot?: string;
  showLocal: boolean;
  grouping: ChangesGroupingMode;
  gearItems: Array<{ id: 'toggleNoVerify'; label: string; checked: boolean }>;
  composer: { message: string; amend: boolean; signOff: boolean };
  /**
   * Repo-relative paths whose file checkboxes are checked. Host-owned
   * inclusion model (IntelliJ `InclusionModel` parity): the webview applies
   * it on boot and on every `updateModel`, never deriving it from DOM state.
   */
  selectedFiles: string[];
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
      | { kind: 'stash'; index: number; name: string; id: string; hash?: string }
    >;
  };
}
