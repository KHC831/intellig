/**
 * The Commit tool window's Shelf tab: the controller contracts the extension
 * binds to ShelfView/StashView, the pure row context-menu label builders, and
 * the action dispatcher for every shelf/stash row action (including the
 * contextOpen ping that answers a right-click with the menu's contents).
 * The deps are call-time getters because the awaits in here mean the item list
 * and controllers must be read live, never captured at dispatch start.
 */

import { answerContextOpen, CONTEXT_OPEN_BAIL } from './contextOpenAnswer';
import type { IStash } from '../git-core/interfaces/IGitService';
import type { IShelfTabEntry, ShelfTabFilter } from './commitToolWindow.types';
import type { CommitToolWindowOutbound } from './commitToolWindow.protocol';
import type { IShelfItem } from '../shelf/interfaces/IShelfService';
import type {
  ICommitToolWebviewMessage,
  ICtwMenuItem,
  ShelfTabShelfAction,
  ShelfTabStashAction,
} from './commitToolWindow.types';

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
/**
 * A stash is addressed by POSITION, and positions move: popping one elsewhere
 * renumbers the stack. `expectedSha` is the stash the clicked row displayed, so
 * the view can refuse an index that now holds a different entry.
 */
export interface IShelfTabStashController {
  apply?: (index: number, expectedSha?: string) => Promise<void>;
  pop?: (index: number, expectedSha?: string) => Promise<void>;
  drop?: (index: number, expectedSha?: string) => Promise<void>;
  showDiff?: (index: number, expectedSha?: string) => Promise<void>;
  rename?: (index: number, expectedSha?: string) => Promise<void>;
  branchFromStash?: (index: number, expectedSha?: string) => Promise<void>;
  /** Clear the whole stash stack (warning confirm owned by the view). */
  clearAll?: () => Promise<void>;
}

/**
 * Menu entries for a Shelf row in the combined tab. Pure — unit-tested
 * directly. `isAlreadyUnshelved` surfaces the Restore entry.
 */
export function shelfRowContextMenuLabels(input: { isAlreadyUnshelved: boolean }): ICtwMenuItem[] {
  const items: ICtwMenuItem[] = [];
  if (input.isAlreadyUnshelved) {
    items.push({ label: 'Restore', action: 'shelfRestore' });
  }
  items.push(
    { label: 'Apply (Unshelve)', action: 'shelfApply' },
    { label: 'Show Diff', action: 'shelfShowDiff' },
    { label: 'Rename…', action: 'shelfRename' },
    { label: 'Create Patch from Shelf…', action: 'shelfCreatePatch' },
    { label: 'Import Patches…', action: 'shelfImportPatches' },
    { label: 'Delete', action: 'shelfDelete', danger: true }
  );
  return items;
}

/**
 * Menu entries for a Stash row in the combined tab. Pure. `Pop` is listed
 * above `Apply` so the right-click default (Enter) matches IntelliJ's
 * recommended action for stash entries.
 */
export function stashRowContextMenuLabels(): ICtwMenuItem[] {
  return [
    { label: 'Pop', action: 'stashPop' },
    { label: 'Apply', action: 'stashApply' },
    { label: 'Show Diff', action: 'stashShowDiff' },
    { label: 'Rename…', action: 'stashRename' },
    { label: 'Create Branch from Stash…', action: 'stashBranchFromStash' },
    { label: 'Drop', action: 'stashDrop', danger: true },
    { label: 'Clear All Stashes', action: 'stashClearAll', danger: true },
  ];
}

/** Live views of the tool window state the dispatcher reads. */
export interface IShelfTabActionDeps {
  getShelfController: () => IShelfTabShelfController;
  getStashController: () => IShelfTabStashController;
  getShelfItems: () => readonly IShelfItem[];
  /** Send the computed menu to the webview, which draws it at the pointer. */
  showContextMenu: (message: CommitToolWindowOutbound) => Promise<void> | void;
}

/**
 * Route a Shelf-tab context-menu action to the appropriate controller.
 * Unknown actions silently no-op so a stale webview bundle won't crash.
 *
 * When `action === 'contextOpen'`, the webview is asking the host what the
 * menu contains. The host answers with the labels from
 * {@link shelfRowContextMenuLabels} / {@link stashRowContextMenuLabels}; the
 * webview draws them under the pointer and posts the pick back here.
 */
export async function handleShelfTabAction(
  deps: IShelfTabActionDeps,
  message: ICommitToolWebviewMessage
): Promise<void> {
  const action = message.action as
    | ShelfTabShelfAction
    | ShelfTabStashAction
    | 'contextOpen'
    | undefined;
  if (!action) {
    return;
  }

  // contextOpen branch — hand the items to the webview, which draws them under
  // the pointer and posts the pick back here as an ordinary action. The labels
  // stay computed here so there is one definition of what the menu contains.
  if (action === 'contextOpen') {
    if (message.rowKind === 'shelf' && message.shelfId) {
      const shelfId = message.shelfId;
      // Bails when the entry is gone — unlike the file/changelist arms,
      // there is no meaningful default menu for a shelf id that no longer
      // exists.
      await answerContextOpen(deps.showContextMenu, () => {
        const entry = deps.getShelfItems().find((i) => i.id === shelfId);
        if (!entry) {
          return CONTEXT_OPEN_BAIL;
        }
        return {
          type: 'showRowContextMenu',
          rowKind: 'shelf',
          shelfId,
          items: shelfRowContextMenuLabels({ isAlreadyUnshelved: entry.unshelvedAt !== undefined }),
        };
      });
      return;
    }
    if (message.rowKind === 'stash' && typeof message.stashIndex === 'number') {
      const stashIndex = message.stashIndex;
      // No lookup and no bail: a stash row is addressed by position only,
      // so any index renders the same menu.
      await answerContextOpen(deps.showContextMenu, () => ({
        type: 'showRowContextMenu',
        rowKind: 'stash',
        stashIndex,
        items: stashRowContextMenuLabels(),
      }));
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
        await deps.getShelfController().apply?.(id);
        return;
      case 'shelfShowDiff':
        await deps.getShelfController().showDiff?.(id);
        return;
      case 'shelfRename':
        await deps.getShelfController().rename?.(id);
        return;
      case 'shelfRestore':
        await deps.getShelfController().restore?.(id);
        return;
      case 'shelfDelete':
        await deps.getShelfController().delete?.(id);
        return;
      case 'shelfCreatePatch':
        await deps.getShelfController().createPatch?.(id);
        return;
      case 'shelfImportPatches':
        await deps.getShelfController().importPatches?.();
        return;
      default:
        return;
    }
  }

  if (message.rowKind === 'stash') {
    // A stash is addressed by position, so a NaN or a negative would drop or
    // pop whatever git resolves `stash@{...}` to. The webview builds this with
    // Number() over a DOM attribute, and the inbound validator checks only the
    // message type, so this is the only place it can be rejected.
    const idx = message.stashIndex;
    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0) {
      return;
    }
    const sha = typeof message.stashSha === 'string' ? message.stashSha : undefined;
    switch (action) {
      case 'stashApply':
        await deps.getStashController().apply?.(idx, sha);
        return;
      case 'stashPop':
        await deps.getStashController().pop?.(idx, sha);
        return;
      case 'stashDrop':
        await deps.getStashController().drop?.(idx, sha);
        return;
      case 'stashShowDiff':
        await deps.getStashController().showDiff?.(idx, sha);
        return;
      case 'stashRename':
        await deps.getStashController().rename?.(idx, sha);
        return;
      case 'stashBranchFromStash':
        await deps.getStashController().branchFromStash?.(idx, sha);
        return;
      case 'stashClearAll':
        await deps.getStashController().clearAll?.();
        return;
      default:
        return;
    }
  }
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
        hash: s.hash,
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
