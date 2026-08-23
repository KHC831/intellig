/**
 * The Commit tool window's changelist/file context-menu surface: the pure
 * row label builders and the action dispatcher for every changelist and file
 * action (including the contextOpen QuickPick flow, which recurses with the
 * chosen action). Extracted verbatim from CommitToolWindow; the deps are
 * live method views because the QuickPick awaits mean state must be read at
 * action time, never captured at dispatch start.
 */

import * as vscode from 'vscode';
import type { IChangelist, IFileChange } from '../changelists/interfaces/IChangelistService';
import type { FileStatus, IRepository } from '../git-core/interfaces/IGitService';
import type {
  ChangelistAction,
  FileAction,
  ICommitToolWebviewMessage,
} from './commitToolWindow.types';

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

/** Live views of the tool window state the dispatcher reads. */
export interface IChangelistActionDeps {
  getChangelists: () => readonly IChangelist[];
  getActiveChangelist: (repo: IRepository) => Promise<IChangelist | undefined>;
  resolveRepo: () => Promise<IRepository | undefined>;
  resolveFileUri: (path: string) => Promise<vscode.Uri | undefined>;
  findChangeStatus: (path: string) => FileStatus | undefined;
  findFileChange: (path: string) => IFileChange | undefined;
  reloadState: () => Promise<void>;
}

export async function handleChangelistAction(
  deps: IChangelistActionDeps,
  message: ICommitToolWebviewMessage
): Promise<void> {
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
      const file = deps.findFileChange(message.path);
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
      await handleChangelistAction(deps, {
        ...message,
        action: picked._action,
      });
      return;
    }
    if (message.changelistId) {
      const changelist = deps.getChangelists().find((c) => c.id === message.changelistId);
      // isActive is resolved against the authoritative service call when
      // available; if the lookup fails we still render the menu with
      // default flags so the right-click isn't a no-op.
      let isActive = false;
      try {
        const repo = await deps.resolveRepo();
        if (repo) {
          const active = await deps.getActiveChangelist(repo);
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
      await handleChangelistAction(deps, {
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
    case 'showDiff':
      if (message.path) {
        const fileUri = await deps.resolveFileUri(message.path);
        if (fileUri) {
          // Unconditional: the command itself picks the merge view over a
          // two-sided diff for an unmerged file, off a fresh status read.
          await vscode.commands.executeCommand('intellig.explorer.showDiff', fileUri);
        }
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
