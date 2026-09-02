/**
 * The Commit tool window's changelist/file context-menu surface: the pure row
 * label builders and the action dispatcher for every changelist and file
 * action, including the `contextOpen` ping that answers a right-click with the
 * menu's items.
 *
 * The deps are live method views, not captured values: a dispatch awaits (repo
 * resolution, the active changelist, the user's own confirms) and the state
 * must be read at action time rather than at dispatch start.
 */

import type { CommitToolWindowOutbound } from './commitToolWindow.protocol';
import { answerContextOpen } from './contextOpenAnswer';
import * as vscode from 'vscode';
import type { IChangelist, IFileChange } from '../changelists/interfaces/IChangelistService';
import type { FileStatus, IRepository } from '../git-core/interfaces/IGitService';
import { getLogger } from '../utils/logger';
import type {
  ChangelistAction,
  FileAction,
  ICommitToolWebviewMessage,
  ICtwMenuItem,
} from './commitToolWindow.types';

/**
 * Labels for the file-action context menu, in IntelliJ-parity order.
 * A file is considered untracked (eligible for `Add to VCS`) when its
 * status is `untracked`.
 *
 * Entries are intentionally kept in the order the IR lists them.
 */
export function fileContextMenuLabels(file: IFileChange): ICtwMenuItem[] {
  const items: ICtwMenuItem[] = [];
  // Conflict actions lead for an unmerged file, matching IntelliJ's
  // Git.ChangesView.Conflicts group (anchor="first"): when a merge has
  // stopped, the actions that finish it should not sit under Rollback.
  if (file.status === 'conflicted') {
    items.push(
      { label: 'Resolve…', action: 'resolveConflictFile' },
      { label: 'Accept Yours', action: 'acceptYours' },
      { label: 'Accept Theirs', action: 'acceptTheirs' }
    );
  }
  items.push(
    { label: 'Show Diff', action: 'showDiff', shortcut: 'Ctrl+D' },
    { label: 'Jump to Source', action: 'jumpToSource', shortcut: 'F4' },
    { label: 'Move to Another Changelist…', action: 'moveToChangelist', shortcut: 'Alt+Shift+M' },
    { label: 'Rollback…', action: 'rollback', shortcut: 'Ctrl+Alt+Z', danger: true },
    { label: 'Shelve Changes…', action: 'shelve' }
  );
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
}): ICtwMenuItem[] {
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
      danger: true,
    },
    { label: 'Commit Only This Changelist…', action: 'commitOnly' },
    { label: 'Shelve Changes', action: 'shelve' },
  ];
}

/** Live views of the tool window state the dispatcher reads. */
export interface IChangelistActionDeps {
  getChangelists: () => readonly IChangelist[];
  getActiveChangelist: (repo: IRepository) => Promise<IChangelist | undefined>;
  resolveRepo: () => Promise<IRepository | undefined>;
  resolveFileUri: (path: string) => Promise<vscode.Uri | undefined>;
  findChangeStatus: (path: string) => FileStatus | undefined;
  findFileChange: (path: string) => IFileChange | undefined;
  reloadState: () => Promise<void>;
  /** Send the computed menu to the webview, which draws it at the pointer. */
  showContextMenu: (message: CommitToolWindowOutbound) => Promise<void> | void;
}

/**
 * Open a changed file's diff. The command itself picks the merge view over a
 * two-sided diff for an unmerged file, off a fresh status read, so this is
 * unconditional.
 *
 * Named rather than reached through a synthesized `changelistContextAction`
 * message: the row's menu entry and the row's double-click are the same action,
 * and a fake envelope would bypass any pre-processing later added to that arm.
 */
export async function openFileDiffSurface(
  deps: Pick<IChangelistActionDeps, 'resolveFileUri'>,
  path: string
): Promise<void> {
  const fileUri = await deps.resolveFileUri(path);
  if (fileUri) {
    await vscode.commands.executeCommand('intellig.explorer.showDiff', fileUri);
  }
}

export async function handleChangelistAction(
  deps: IChangelistActionDeps,
  message: ICommitToolWebviewMessage
): Promise<void> {
  const action = message.action as ChangelistAction | FileAction | 'contextOpen' | undefined;
  if (!action) {
    return;
  }

  // The webview posts `contextOpen` on right-click and the host answers with
  // the items, which the webview draws under the pointer. The labels stay here
  // (fileContextMenuLabels / changelistContextMenuLabels) so there is one
  // definition of what the menu contains. A file path on the message wins:
  // right-clicking a file row carries both `path` and `changelistId`.
  if (action === 'contextOpen') {
    if (message.path) {
      const path = message.path;
      const changelistId = message.changelistId;
      // Never bails: a path with no changelist metadata (e.g. stale state)
      // still renders a minimal modified-file menu rather than silently
      // dropping the right-click.
      await answerContextOpen(deps.showContextMenu, () => {
        const file = deps.findFileChange(path);
        const fallback: IFileChange = { path, status: 'modified', staged: false };
        return {
          type: 'showRowContextMenu',
          path,
          changelistId,
          items: fileContextMenuLabels(file ?? fallback),
        };
      });
      return;
    }
    if (message.changelistId) {
      const changelistId = message.changelistId;
      // Never bails either: an id that no longer matches any changelist, or
      // a throwing isActive lookup, still renders a menu with default flags
      // rather than dropping the right-click.
      await answerContextOpen(deps.showContextMenu, async () => {
        const changelist = deps.getChangelists().find((c) => c.id === changelistId);
        let isActive = false;
        try {
          const repo = await deps.resolveRepo();
          if (repo) {
            const active = await deps.getActiveChangelist(repo);
            isActive = !!active && active.id === changelistId;
          }
        } catch (error) {
          // Best-effort — some tests stub the service with a resolved
          // undefined / throw; we just fall back to isActive:false.
          getLogger()
            .child({ component: 'changelistTab' })
            .warn('Failed to read the active changelist for a right-click menu', {
              error: String(error),
            });
        }
        return {
          type: 'showRowContextMenu',
          changelistId,
          items: changelistContextMenuLabels({
            isActive,
            isDefault: changelist?.isDefault ?? false,
          }),
        };
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
        await vscode.commands.executeCommand('intellig.changelist.setActive', message.changelistId);
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
    // Resolve routes through the shared Show Diff seam, which sends an
    // unmerged path to the merge window before it builds a two-pane diff.
    case 'resolveConflictFile':
      if (message.path) {
        await openFileDiffSurface(deps, message.path);
      }
      return;
    // Accept one side without opening anything. `reversed` is left to the
    // service, which auto-detects it from repository state — a rebase puts the
    // user's own commit on stage 3, so re-deciding that here would be a second
    // place for the swap to be got wrong.
    case 'acceptYours':
    case 'acceptTheirs': {
      if (!message.path) {
        return;
      }
      const fileUri = await deps.resolveFileUri(message.path);
      if (!fileUri) {
        return;
      }
      // A literal id per branch, not a computed one: the dispatch-targets
      // guard inventories these, and an id built at runtime drops out of that
      // inventory — a later rename would then pass the gate green.
      if (action === 'acceptTheirs') {
        await vscode.commands.executeCommand('intellig.conflict.acceptIncomingFile', fileUri);
      } else {
        await vscode.commands.executeCommand('intellig.conflict.acceptCurrentFile', fileUri);
      }
      return;
    }
    case 'showDiff':
      if (message.path) {
        await openFileDiffSurface(deps, message.path);
      }
      return;
    case 'jumpToSource':
      if (message.path) {
        const fileUri = await deps.resolveFileUri(message.path);
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
        const status = deps.findChangeStatus(message.path);
        if (status) {
          await vscode.commands.executeCommand('intellig.rollbackChanges', [
            { path: message.path, status },
          ]);
        } else {
          await vscode.commands.executeCommand('intellig.revertFile', message.path);
        }
        await deps.reloadState();
      }
      return;
    case 'addToVcs':
      if (message.path) {
        const fileUri = await deps.resolveFileUri(message.path);
        if (fileUri) {
          await vscode.commands.executeCommand('intellig.explorer.addToVcs', fileUri);
        }
      }
      return;
    case 'showHistory':
      if (message.path) {
        const fileUri = await deps.resolveFileUri(message.path);
        if (fileUri) {
          await vscode.commands.executeCommand('intellig.showHistory', fileUri);
        }
      }
      return;
    case 'annotate':
      if (message.path) {
        const fileUri = await deps.resolveFileUri(message.path);
        if (fileUri) {
          await vscode.commands.executeCommand('intellig.toggleBlame', fileUri);
        }
      }
      return;
  }
}
