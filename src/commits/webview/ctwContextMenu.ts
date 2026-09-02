/**
 * The Commit tool window's context menu.
 *
 * The box, the placement and the keyboard belong to the shared
 * {@link ContextMenu} widget; this adds the two things that are the Commit
 * window's own: the labels come from the host over the wire
 * (`fileContextMenuLabels` / `changelistContextMenuLabels`, so they have one
 * definition), and the reply is async, so the pointer position of the
 * right-click has to be held until it lands.
 */

import type { CtwMenuAction, ICtwMenuItem, ICtwMenuTarget } from '../commitToolWindow.types';
import { ContextMenu } from '../../webview-common/contextMenu';

export type { CtwMenuAction, ICtwMenuItem, ICtwMenuTarget };

/** Height the menu is expected to reach once laid out, for edge clamping. */
const MENU_HEIGHT = 320;

/**
 * What the live DOM says about the row a menu targets, or null when no such
 * row is on screen.
 *
 * Rows are matched by their identity ATTRIBUTES rather than by element
 * identity: `applyModel` rebuilds the tree from scratch, so even a refresh
 * that redraws exactly the same rows produces new elements, and keying on the
 * node would close the menu under the user on every watcher tick.
 *
 * Every arm carries the state its own menu's CONTENTS depend on, so a row
 * whose menu would now be built differently reads as a different row: a
 * file's conflicted-ness (Accept Yours / Accept Theirs) and untracked-ness
 * (Add to VCS), a shelf entry's already-unshelved flag (Restore), a
 * changelist's active flag (Set Active).
 *
 * The untracked-ness arm is defence-in-depth for that contract rather than
 * the only thing catching a stale menu: every untracked file lives in the
 * `_unversioned` pseudo-changelist (`partitionUnversionedFiles`,
 * ctwChangesTree.ts), so a tracked<->untracked flip always changes
 * `data-changelist` too, which the check above this arm already catches. It
 * stays load-bearing if that hoist ever becomes conditional.
 *
 * A stash also carries its sha, because a stash row is identified by POSITION
 * and positions move: popping one elsewhere renumbers the stack, and the slot
 * the menu was opened on then holds a different stash.
 */
function rowSignature(target: ICtwMenuTarget): string | null {
  // Attribute comparison in JS rather than an interpolated selector: a path is
  // user data and can carry quotes or a backslash.
  const rows = document.querySelectorAll<HTMLElement>(
    '.ctw-file-row, .ctw-changelist-row, .ctw-shelf-row'
  );
  for (const row of Array.from(rows)) {
    // A tab switch hides a whole panel rather than removing its rows, so a row
    // in the tab the user is no longer looking at is not on screen either.
    if (row.closest<HTMLElement>('[data-panel]')?.style.display === 'none') {
      continue;
    }
    if (target.rowKind !== undefined) {
      if (row.getAttribute('data-row-kind') !== target.rowKind) {
        continue;
      }
      if (target.shelfId !== undefined && row.getAttribute('data-shelf-id') === target.shelfId) {
        return (
          'shelf:' +
          target.shelfId +
          ':' +
          (row.querySelector('.ctw-shelf-alreadyUnshelved') ? 'unshelved' : 'fresh')
        );
      }
      if (
        target.stashIndex !== undefined &&
        row.getAttribute('data-stash-index') === String(target.stashIndex)
      ) {
        return (
          'stash:' + String(target.stashIndex) + ':' + (row.getAttribute('data-stash-sha') ?? '')
        );
      }
      continue;
    }
    if (target.path !== undefined) {
      if (
        !row.classList.contains('ctw-file-row') ||
        row.getAttribute('data-path') !== target.path ||
        row.getAttribute('data-changelist') !== (target.changelistId ?? null)
      ) {
        continue;
      }
      return (
        'file:' +
        target.path +
        ':' +
        (row.classList.contains('ctw-file-conflicted') ? 'conflicted' : 'clean') +
        ':' +
        (row.classList.contains('ctw-file-untracked') ? 'untracked' : 'tracked')
      );
    }
    if (target.changelistId !== undefined) {
      if (
        row.classList.contains('ctw-changelist-row') &&
        row.getAttribute('data-changelist') === target.changelistId
      ) {
        return (
          'changelist:' +
          target.changelistId +
          ':' +
          (row.querySelector('.ctw-changelist-active') ? 'active' : 'inactive')
        );
      }
    }
  }
  return null;
}

/** Whether a host reply answers the right-click still waiting for one. */
function sameTarget(pending: ICtwMenuTarget, reply: ICtwMenuTarget): boolean {
  return (
    pending.path === reply.path &&
    pending.changelistId === reply.changelistId &&
    pending.rowKind === reply.rowKind &&
    pending.shelfId === reply.shelfId &&
    pending.stashIndex === reply.stashIndex
  );
}

export interface ICtwContextMenuDeps {
  /** Send the chosen action to the host. */
  onPick(target: ICtwMenuTarget, action: CtwMenuAction): void;
}

export class CtwContextMenu {
  private _target: ICtwMenuTarget = {};
  /** Pointer position of the right-click awaiting the host's item list. */
  private _pending:
    | { x: number; y: number; target: ICtwMenuTarget; opener?: HTMLElement }
    | undefined;
  private readonly _menu: ContextMenu;
  /** What the target row looked like when the menu was drawn on it. */
  private _signature: string | null = null;

  constructor(deps: ICtwContextMenuDeps) {
    this._menu = new ContextMenu({
      ariaLabel: 'File actions',
      expectedHeight: MENU_HEIGHT,
      onPick: (action): void => {
        // The menu hangs off <body>, so a rebuild of the tree leaves it up
        // over rows it no longer describes. Acting then rolls back a path the
        // model has dropped, or accepts a conflict side for a file git no
        // longer reports unmerged. Comparing the row rather than enumerating
        // the messages that rebuild it covers the whole class.
        if (rowSignature(this._target) !== this._signature) {
          return;
        }
        deps.onPick(this._target, action as CtwMenuAction);
      },
    });
  }

  /**
   * Remember where a right-click landed while the host computes the items.
   * The pointer is gone by the time the reply arrives, so it has to be held.
   *
   * Hides this menu first — clearing any pending click too — so a bailed
   * reply (CONTEXT_OPEN_BAIL) cannot leave the previous row's menu painted.
   */
  rememberClick(x: number, y: number, target: ICtwMenuTarget, opener?: HTMLElement): void {
    this.hide();
    this._pending = { x, y, target, opener };
  }

  /** Draw `items` at the remembered pointer position. */
  show(target: ICtwMenuTarget, items: readonly ICtwMenuItem[]): void {
    const at = this._pending;
    // A reply with no remembered click would otherwise paint a menu at 0,0.
    if (!at) {
      return;
    }
    // Two right-clicks can be in flight at once — the host awaits the active
    // changelist before it can answer — and the replies need not come back in
    // order. A reply for a right-click that has been superseded would draw the
    // OLD row's menu at the NEW row's pointer, which is invisible when both
    // rows carry the same labels. Leave the pending click alone so its own
    // reply can still land.
    if (!sameTarget(at.target, target)) {
      return;
    }
    // The row can go while the host is answering. Drawing its menu anyway
    // would put a dead target under the pointer.
    const signature = rowSignature(at.target);
    if (signature === null) {
      this._pending = undefined;
      return;
    }
    this._pending = undefined;
    // The remembered click, not the reply: it is the one that carries the repo
    // the row was rendered from.
    this._target = at.target;
    this._signature = signature;
    this._menu.render(items);
    this._menu.showAt(at.x, at.y, at.opener);
  }

  /**
   * Close without choosing anything, and abandon a right-click still awaiting
   * a reply — otherwise a reply landing afterwards would reopen a menu the
   * user already dismissed.
   */
  hide(): void {
    this._menu.hide();
    this._pending = undefined;
  }

  /**
   * Abandon a right-click that has not been answered yet.
   *
   * The host's reply is async (the changelist arm awaits repo resolution and
   * the active changelist). If the user clicks elsewhere while it is in flight,
   * a reply landing afterwards would pop the menu at the pointer position of a
   * gesture the user has already moved on from.
   */
  cancelPending(): void {
    this._pending = undefined;
  }

  /**
   * Close the menu if the row it was opened on is gone or has changed kind.
   *
   * Called after the tree is rebuilt: a menu left hanging over redrawn rows
   * points at whatever now sits under the pointer. A refresh that redraws the
   * same row leaves the menu alone, which is what makes a background tick
   * survivable.
   */
  revalidate(): void {
    if (this._menu.isOpen && rowSignature(this._target) !== this._signature) {
      this.hide();
    }
  }

  /** Whether the menu is currently open (for click-away bookkeeping). */
  get isOpen(): boolean {
    return this._menu.isOpen;
  }

  /** True when `node` is inside the menu, so a click on it is not click-away. */
  contains(node: Node): boolean {
    return this._menu.contains(node);
  }
}
