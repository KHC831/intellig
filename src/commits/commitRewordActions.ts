/**
 * Edit-commit-message (reword) action for the commit context menu.
 */

import * as vscode from 'vscode';
import { getLogger } from '../utils/logger';
import { CommitMessageDialog } from './CommitMessageDialog';
import { formatActionFailureToast } from '../git-core/gitError';
import { runHistoryRewrite, type ICommitHistoryRewriteContext } from './commitHistoryRewriteRunner';
import { promptForMessageInEditor } from './commitMessageEditor';
import { hashesReferToSameCommit, reloadAndRefresh } from './commitContextMenuShared';

/**
 * Edit the commit message of the selected commit.
 * Uses git commit --amend for HEAD commits.
 * Uses interactive rebase with reword for non-HEAD commits.
 * Both paths stash uncommitted/unmerged changes first to avoid conflicts.
 */
export async function handleEditCommitMessage(
  ctx: ICommitHistoryRewriteContext,
  commitHashes: string[]
): Promise<void> {
  const repo = await ctx.getRepositoryForCommit(commitHashes[0]);
  if (!repo || commitHashes.length === 0) {
    return;
  }

  const hash = commitHashes[0];
  const cwd = repo.rootUri.fsPath;

  // HEAD-containment gate (before the message dialog / stash / rebase). The
  // non-HEAD path rewords via `hash~1..HEAD` rebase, which would move the
  // checked-out branch for a commit HEAD doesn't contain; the HEAD-amend path
  // targets HEAD itself, which is trivially contained (guard passes).
  if (!(await ctx.isOldestInCurrentBranch(repo, hash))) {
    return;
  }

  // Protected-branch gate BEFORE the message dialog, mirroring IntelliJ's
  // perform-time check ordering (lastCheckCommitsEditingAvailability runs
  // before the reword dialog). Applies to BOTH arms: the HEAD amend
  // rewrites protected published history just like the non-HEAD rebase
  // (which the runner would also gate, later).
  if (!(await ctx.isNotOnProtectedBranch(cwd, hash, 'Edit message'))) {
    return;
  }

  try {
    // Fetch the full commit message
    let fullMessage = '';
    try {
      const msgResult = await ctx.gitCli.exec(['log', '-1', '--format=%B', hash], { cwd });
      if (msgResult.exitCode === 0 && msgResult.stdout.trim()) {
        fullMessage = msgResult.stdout.trim();
      }
    } catch (error) {
      // Continue with empty message; log the probe fault so it stays visible.
      getLogger()
        .child({ component: 'CommitContextMenuCommands' })
        .debug('editCommitMessage: full-message fetch failed', {
          err: error instanceof Error ? error.message : String(error),
        });
    }

    // Multi-line editor so the user can enter a subject + body (a
    // single-line input would collapse the whole message into the
    // subject). Primary: the webview dialog (when an extension context
    // is available); fallback: a tempfile editor — matching the squash
    // message flow.
    let newMessage: string | undefined;
    if (ctx.context) {
      const dialog = new CommitMessageDialog(ctx.context, {
        seedMessage: fullMessage,
        viewType: 'intellig.editMessageDialog',
        title: 'Edit Commit Message',
        heading: 'Edit commit message',
        submitLabel: 'Update Message',
        submitVerb: 'save',
      });
      newMessage = await dialog.prompt();
    } else {
      newMessage = await promptForMessageInEditor(fullMessage, {
        tmpInfix: 'reword',
        opName: 'Edit message',
        fallbackPrompt: 'Edit commit message',
      });
    }

    // Undefined OR blank = cancel: the dialogs collapse a blank submit
    // to undefined, but guard explicitly so an empty message never
    // becomes a no-op reword with an empty subject.
    if (newMessage === undefined || newMessage.trim().length === 0) {
      return;
    }

    const headHash = repo.head?.commit;
    const isHead = headHash !== undefined && hashesReferToSameCommit(headHash, hash);

    if (isHead) {
      // HEAD amend: git commit --amend -m only rewrites the commit message.
      // It doesn't touch the working tree or index, so it works even with
      // unmerged files or dirty state — no stash needed.
      await ctx.gitCli.exec(['commit', '--amend', '--allow-empty', '--only', '-m', newMessage], {
        cwd,
        throwOnError: true,
      });
      void vscode.window.showInformationMessage(
        `Updated commit message for ${hash.substring(0, 8)}`
      );
      // The amend rewrote HEAD; reload before refresh.
      await reloadAndRefresh(ctx, repo);
    } else {
      // Non-HEAD: reword via the shared history-rewrite runner.
      await runHistoryRewrite(ctx, repo, {
        onto: `${hash}~1`,
        oldest: hash,
        opLabel: 'Edit message',
        target: 'reword',
        successToast: `Updated commit message for ${hash.substring(0, 8)}`,
        buildPlan: (session) => {
          const targetCommit = session.commits.find((c) => hashesReferToSameCommit(c.hash, hash));
          if (!targetCommit) {
            void vscode.window.showErrorMessage(
              `Commit ${hash.substring(0, 8)} not found in rebase session.`
            );
            return 'stale';
          }
          return session.commits.map((c) =>
            c.hash === targetCommit.hash
              ? { hash: c.hash, action: 'reword' as const, newMessage }
              : { hash: c.hash, action: c.action }
          );
        },
        // The reword carries a non-blank override, so the todo transform
        // realises it as `pick` + a non-interactive amend and the rebase
        // normally never pauses. Defence in depth: should a pause surface
        // anyway (a rebase left mid-flight by an earlier failure),
        // `provideRewordMessage` amends the paused commit to the typed
        // message and continues, rather than stranding the rebase. A
        // conflict (or cleared-stale no-op) surfaced mid-drive returns
        // to the runner's outcome switch, which pauses / reports it.
        drivePaused: async (first) => {
          let result = first;
          while (result.success && result.status === 'paused') {
            result = await ctx.rebaseService.provideRewordMessage(repo, newMessage);
          }
          return result;
        },
      });
    }
  } catch (error) {
    void vscode.window.showErrorMessage(
      formatActionFailureToast('Failed to edit commit message', error)
    );
  }
}
