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
    };

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
   * `contextOpen` is the right-click ping that asks the host to present the
   * QuickPick menu; the host then recurses with the concrete action the user
   * picked. It rides the same `action` field as the concrete actions.
   */
  action?:
    | ChangelistAction
    | FileAction
    | ShelfTabShelfAction
    | ShelfTabStashAction
    | 'contextOpen';
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

/** A single file entry in the Local Changes render model. */
export interface ICtwFileEntry {
  path: string;
  statusChar: string;
  /** Full path in flat mode, basename in directory mode. */
  displayName: string;
}

/** One changelist (or the unversioned pseudo-node) in the render model. */
export interface ICtwChangelistModel {
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
 * precomputes everything the webview entry needs to build the DOM via
 * createElement (no host-side HTML strings), so the entry is a pure
 * data→DOM mapper. Crosses to the webview as the init island.
 */
export interface ICommitToolWindowInitModel {
  activeTab: CommitToolWindowTab;
  showLocal: boolean;
  grouping: ChangesGroupingMode;
  gearItems: Array<{ label: string; tooltip: string }>;
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
      | { kind: 'stash'; index: number; name: string; id: string }
    >;
  };
}
