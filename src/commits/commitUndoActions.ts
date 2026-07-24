/**
 * Undo-commit action for the commit context menu: soft-reset the HEAD commit,
 * restore its message to the composer, and optionally move the uncommitted
 * changes to a chosen changelist (IntelliJ GitUncommitAction).
 */

import * as vscode from 'vscode';
import type { IGitService, IRepository } from '../git-core/interfaces/IGitService';
import type { GitCli } from '../git-core/gitCli';
import type { GitToolWindowProvider } from '../ui-shell/GitToolWindowProvider';
import { formatActionFailureToast } from '../git-core/gitError';
import { reloadAndRefresh, type ICommitRepoContext } from './commitContextMenuShared';

/** Deps the undo action reaches back into the dispatcher for. */
export interface ICommitUndoContext extends ICommitRepoContext {
  readonly gitService: IGitService;
  readonly gitCli: GitCli;
  readonly gitToolWindowProvider: GitToolWindowProvider;
  // Call-time getters (not snapshots): both services are setter-wired and read
  // AFTER the getCommit await below, so the context must read them live.
  changelistService():
    | {
        getChangelists(repo: IRepository): { id: string; name: string; isDefault?: boolean }[];
        createChangelist(repo: IRepository, name: string): { id: string; name: string };
        moveToChangelist(repo: IRepository, files: string[], changelistId: string): void;
      }
    | undefined;
  commitComposer(): { prefillComposerMessage(message: string): void } | undefined;
  isNotOnProtectedBranch(cwd: string, hash: string, opLabel: string): Promise<boolean>;
}

/**
 * Undo the selected commit by performing a soft reset to its parent.
 * Only works if the selected commit is the HEAD commit.
 */
export async function undoCommit(ctx: ICommitUndoContext, commitHashes: string[]): Promise<void> {
  const repo = await ctx.getRepositoryForCommit(commitHashes[0]);
  if (!repo || commitHashes.length === 0) {
    return;
  }

  const hash = commitHashes[0];
  const headHash = repo.head?.commit;

  // Same prefix-match as the reword flow's HEAD check: an abbreviated
  // hash (e.g. 7-char log hash) must be recognised as HEAD even when
  // headHash is the full 40-char SHA (hashesReferToSameCommit rule).
  const isHead =
    headHash && (headHash === hash || headHash.startsWith(hash) || hash.startsWith(headHash));
  if (!isHead) {
    void vscode.window.showErrorMessage('Undo Commit can only be performed on the HEAD commit.');
    return;
  }

  // Protected-branch gate: IntelliJ's GitUncommitAction rides the shared
  // commit-editing base gates, which block a commit contained in a
  // protected remote branch.
  if (!(await ctx.isNotOnProtectedBranch(repo.rootUri.fsPath, hash, 'Undo commit'))) {
    return;
  }

  // Capture the message BEFORE the reset so it can be restored to the
  // composer afterward (IntelliJ repopulates the message on uncommit).
  let undoneMessage = '';
  try {
    undoneMessage = (await ctx.gitService.getCommit(repo, hash)).message;
  } catch {
    undoneMessage = '';
  }

  // Target-changelist chooser (IntelliJ GitUncommitAction.java:60-68):
  // when changelists are available, the user picks where the uncommitted
  // changes land — an existing list or a new one suggested from the
  // commit subject. Cancel cancels the undo. Resolved BEFORE the reset so
  // a cancel has no side effects.
  let moveFilesTo: string | undefined;
  const changelistService = ctx.changelistService();
  if (changelistService) {
    const subject = undoneMessage.split('\n')[0].slice(0, 60).trim();
    interface IChooserItem extends vscode.QuickPickItem {
      changelistId?: string;
      createNamed?: string;
    }
    const items: IChooserItem[] = [];
    if (subject) {
      items.push({
        label: `$(add) New changelist: '${subject}'`,
        createNamed: subject,
      });
    }
    for (const list of changelistService.getChangelists(repo)) {
      items.push({
        label: list.name,
        description: list.isDefault ? 'default' : undefined,
        changelistId: list.id,
      });
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Undo Commit — move changes to changelist',
      placeHolder: 'Where should the uncommitted changes land?',
    });
    if (!picked) {
      return;
    }
    if (picked.createNamed !== undefined) {
      moveFilesTo = changelistService.createChangelist(repo, picked.createNamed).id;
    } else {
      moveFilesTo = picked.changelistId;
    }
  }

  // The commit's file list, captured pre-reset for the changelist move.
  let undoneFiles: string[] = [];
  if (moveFilesTo !== undefined) {
    try {
      undoneFiles = (await ctx.gitService.getCommitDiff(repo, hash)).map((d) => d.path);
    } catch {
      undoneFiles = [];
    }
  }

  try {
    await ctx.gitCli.exec(['reset', '--soft', 'HEAD~1'], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });

    if (moveFilesTo !== undefined && undoneFiles.length > 0) {
      ctx.changelistService()?.moveToChangelist(repo, undoneFiles, moveFilesTo);
    }
    if (undoneMessage) {
      ctx.commitComposer()?.prefillComposerMessage(undoneMessage);
    }
    void vscode.window.showInformationMessage('Commit undone. Changes restored to staging area.');
    // soft-reset moved HEAD; reload before refresh.
    await reloadAndRefresh(ctx, repo);
  } catch (error) {
    void vscode.window.showErrorMessage(formatActionFailureToast('Failed to undo commit', error));
  }
}
