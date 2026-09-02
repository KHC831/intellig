/**
 * What the Git tool window's three context menus contain.
 *
 * The rows are fixed, so they are declared once here and handed to the shared
 * {@link import('../../../webview-common/contextMenu').ContextMenu} widget,
 * which owns the drawing. Keeping them as data rather than markup is what lets
 * the parity test read the action list directly instead of parsing HTML.
 */

import type { IContextMenuItem, IContextMenuOptions } from '../../../webview-common/contextMenu';

/** Heights the menus are expected to reach once laid out, for edge clamping. */
const COMMIT_MENU_HEIGHT = 400;
const SHORT_MENU_HEIGHT = 200;

const SEPARATOR: IContextMenuItem = { separator: true };

/**
 * The commit-row menu.
 *
 * Every `action` MUST be a member of MultiSelectMenuAction: the host computes a
 * per-action (visible, enabled) map for the current selection, and an unknown
 * action falls back to visible+enabled, which would silently leave the row
 * clickable in multi-select. `menuActionParity.test.ts` pins the containment.
 * `hiddenByDefault` marks the multi-only rows.
 */
export const COMMIT_MENU_ITEMS: readonly IContextMenuItem[] = [
  { action: 'copyHash', label: 'Copy Revision Number' },
  { action: 'createPatch', label: 'Create Patch…' },
  { action: 'createPatchToClipboard', label: 'Create Patch to Clipboard' },
  { action: 'cherryPick', label: 'Cherry-Pick' },
  SEPARATOR,
  { action: 'checkoutRevision', label: 'Checkout Revision' },
  { action: 'showRepoAtRevision', label: 'Show Repository at Revision' },
  { action: 'compareWithLocal', label: 'Compare with Local' },
  { action: 'compareVersions', label: 'Compare Versions', hiddenByDefault: true },
  SEPARATOR,
  { action: 'resetToHere', label: 'Reset Current Branch to Here…', danger: true },
  { action: 'revert', label: 'Revert Commit' },
  { action: 'undoCommit', label: 'Undo Commit' },
  SEPARATOR,
  { action: 'editCommitMessage', label: 'Edit Commit Message…' },
  { action: 'fixup', label: 'Fixup…' },
  { action: 'squashInto', label: 'Squash Into…' },
  { action: 'squashCommits', label: 'Squash Commits', hiddenByDefault: true },
  { action: 'dropCommit', label: 'Drop Commit', danger: true },
  { action: 'interactiveRebase', label: 'Interactively Rebase from Here…' },
  { action: 'pushUpToCommit', label: 'Push All up to Here…' },
  SEPARATOR,
  { action: 'newBranch', label: 'New Branch…' },
  { action: 'newTag', label: 'New Tag…' },
  SEPARATOR,
  { action: 'goToChild', label: 'Go to Child Commit' },
  { action: 'goToParent', label: 'Go to Parent Commit' },
];

/**
 * The changed-file menu in the details panel. Entry order mirrors IntelliJ's
 * `Vcs.RepositoryChangesBrowserMenu` (VcsActions.xml): Show Diff, Open
 * Repository Version, then Show History for Revision. Each action relays (via
 * the `fileContextAction` wire message) to the matching registered
 * `intellig.commit.*` command host-side. Its own `data-file-action` namespace
 * keeps the commit menu's MultiSelectMenuAction fence untouched.
 */
export const FILE_MENU_ITEMS: readonly IContextMenuItem[] = [
  { action: 'showDiff', label: 'Show Diff' },
  { action: 'openRepositoryVersion', label: 'Open Repository Version' },
  SEPARATOR,
  { action: 'fileHistoryFromHere', label: 'Show History for Revision' },
];

/**
 * The History-tab revision menu: the compare actions IntelliJ's file-history
 * context menu offers beyond the toolbar buttons. Each action posts on the tab
 * channel; the HistoryTab relays to the registered `intellig.commit.compareWith*`
 * commands.
 */
export const HISTORY_MENU_ITEMS: readonly IContextMenuItem[] = [
  { action: 'compareWithHead', label: 'Compare with HEAD' },
  { action: 'compareWithRef', label: 'Compare With…' },
];

/**
 * How each menu identifies itself. Declared beside the rows so a spec renders
 * the same menu the webview does, rather than a look-alike built from
 * hand-copied ids and attribute names.
 */
export const COMMIT_MENU: IContextMenuOptions = {
  id: 'commit-context-menu',
  ariaLabel: 'Commit actions',
  expectedHeight: COMMIT_MENU_HEIGHT,
};

export const FILE_MENU: IContextMenuOptions = {
  id: 'file-context-menu',
  ariaLabel: 'Changed file actions',
  actionAttr: 'data-file-action',
  expectedHeight: SHORT_MENU_HEIGHT,
};

export const HISTORY_MENU: IContextMenuOptions = {
  id: 'history-context-menu',
  ariaLabel: 'Revision actions',
  actionAttr: 'data-history-action',
  expectedHeight: SHORT_MENU_HEIGHT,
};
