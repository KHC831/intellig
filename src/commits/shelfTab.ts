/**
 * The Commit tool window's Shelf tab: the controller contracts the extension
 * binds to ShelfView/StashView, the pure row context-menu label builders, and
 * the action dispatcher for every shelf/stash row action (including the
 * contextOpen QuickPick flow, which recurses with the chosen action).
 * Extracted verbatim from CommitToolWindow; the deps are call-time getters
 * because the QuickPick awaits mean the item list and controllers must be
 * read live, never captured at dispatch start.
 */

import * as vscode from 'vscode';
import type { IShelfItem } from '../shelf/interfaces/IShelfService';
import type {
  ICommitToolWebviewMessage,
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

/** Live views of the tool window state the dispatcher reads. */
export interface IShelfTabActionDeps {
  getShelfController: () => IShelfTabShelfController;
  getStashController: () => IShelfTabStashController;
  getShelfItems: () => readonly IShelfItem[];
}

/**
 * Route a Shelf-tab context-menu action to the appropriate controller.
 * Unknown actions silently no-op so a stale webview bundle won't crash.
 *
 * When `action === 'contextOpen'`, the webview is asking the host to
 * display the menu. The host shows a QuickPick using
 * {@link shelfRowContextMenuLabels} / {@link stashRowContextMenuLabels}
 * and forwards the user's pick back through this same code path.
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

  // contextOpen branch — prompt the user, then recurse with the chosen
  // action. Keeping the recursion tight means the action-dispatch switch
  // below doesn't have to know whether the trigger was a right-click
  // or a direct command invocation.
  if (action === 'contextOpen') {
    if (message.rowKind === 'shelf' && message.shelfId) {
      const entry = deps.getShelfItems().find((i) => i.id === message.shelfId);
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
      await handleShelfTabAction(deps, {
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
      await handleShelfTabAction(deps, {
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
    if (typeof message.stashIndex !== 'number') {
      return;
    }
    const idx = message.stashIndex;
    switch (action) {
      case 'stashApply':
        await deps.getStashController().apply?.(idx);
        return;
      case 'stashPop':
        await deps.getStashController().pop?.(idx);
        return;
      case 'stashDrop':
        await deps.getStashController().drop?.(idx);
        return;
      case 'stashShowDiff':
        await deps.getStashController().showDiff?.(idx);
        return;
      case 'stashRename':
        await deps.getStashController().rename?.(idx);
        return;
      case 'stashBranchFromStash':
        await deps.getStashController().branchFromStash?.(idx);
        return;
      case 'stashClearAll':
        await deps.getStashController().clearAll?.();
        return;
      default:
        return;
    }
  }
}
