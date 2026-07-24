/**
 * Revert actions for the commit context menu: the mainline-aware revert flow
 * and the selective (per-file) revert path. Conflict UX lives on the
 * dispatcher class (`_handleRevertConflicts`, reached via the context)
 * because it reads the setter-wired conflict-resolution service live.
 */

import * as vscode from 'vscode';
import type { IGitService, IRepository } from '../git-core/interfaces/IGitService';
import type { GitCli } from '../git-core/gitCli';
import type { GitToolWindowProvider } from '../ui-shell/GitToolWindowProvider';
import { restorePathsToHead } from '../git-core/worktree/restoreToHead';
import { formatActionFailureToast, sanitizeGitError } from '../git-core/gitError';
import { resolveCommitSelection, type ICommitSelectionContext } from './commitContextMenuShared';

/** Deps the revert actions reach back into the dispatcher for. */
export interface ICommitRevertActionsContext extends ICommitSelectionContext {
  readonly gitService: IGitService;
  readonly gitCli: GitCli;
  readonly gitToolWindowProvider: GitToolWindowProvider;
  anyIsMergeCommit(repo: IRepository, hashes: string[]): Promise<boolean>;
  pickMainlineParent(
    repo: IRepository,
    hashes: string[]
  ): Promise<{ cancelled: false; mainline: number } | { cancelled: true }>;
  handleRevertConflicts(
    repo: IRepository,
    conflicts: string[],
    commitHashes: string[]
  ): Promise<void>;
}

export async function handleRevert(
  ctx: ICommitRevertActionsContext,
  commitHashes: string[]
): Promise<void> {
  const repo = await resolveCommitSelection(ctx, commitHashes);
  if (!repo) {
    return;
  }

  // Detect merge commits up front. A merge revert needs `-m <parent>`; the
  // selective (per-file) revert path runs `git revert -n` with no `-m` and
  // would fail, so merges skip it and go straight to the mainline-aware path.
  const hasMerge = await ctx.anyIsMergeCommit(repo, commitHashes).catch(() => false);

  // Selective-file revert is only offered on single, non-merge reverts.
  if (commitHashes.length === 1 && !hasMerge) {
    const outcome = await runSelectiveRevertIfApplicable(ctx, repo, commitHashes[0]);
    if (outcome === 'handled') {
      // selective-revert runs `git commit` internally (mutates
      // HEAD); reload before refresh so panel sees fresh state.
      await ctx.gitService.reloadRepository(repo);
      ctx.gitToolWindowProvider.refresh();
      return;
    }
    if (outcome === 'cancelled') {
      // User cancelled at the file-picker — no-op, no toast.
      return;
    }
    // `fallThrough` → drop into the standard revert path below.
  }

  try {
    // For single non-merge commits, offer an InputBox so the user can
    // customise the revert message (default: "Revert \"<subject>\"").
    // Merge commits use -m 1 + auto-generated message; multi-commit
    // reverts are too complex to prompt per-commit.
    if (commitHashes.length === 1 && !hasMerge) {
      const commit = await ctx.gitService.getCommit(repo, commitHashes[0]);
      const subject = commit.message.split('\n')[0];
      const defaultMsg = `Revert "${subject}"`;
      const message = await vscode.window.showInputBox({
        prompt: 'Revert commit message',
        value: defaultMsg,
      });
      if (message === undefined) {
        return;
      }
      const singleResult = await ctx.gitService.revert(repo, commitHashes, { message }).match(
        (r) => r,
        (e) => {
          throw e;
        }
      );
      if (singleResult.success) {
        void vscode.window.showInformationMessage('Reverted 1 commit(s) successfully');
      } else if (singleResult.conflicts && singleResult.conflicts.length > 0) {
        await ctx.handleRevertConflicts(repo, singleResult.conflicts, commitHashes);
      } else {
        const reason = singleResult.failureReason ?? 'unknown error';
        // The custom-message revert stages then commits separately; if the
        // commit failed the staged revert is left in the index. Tell the user
        // so they can commit or `git revert --abort` rather than assume the
        // working tree is untouched.
        const leftover = singleResult.stagedChangesRemain
          ? ' The revert was staged but not committed — commit it or run "git revert --abort" to discard.'
          : '';
        void vscode.window.showErrorMessage(
          `Failed to revert: ${sanitizeGitError(reason)}${leftover}`
        );
      }
      await ctx.gitService.reloadRepository(repo);
      ctx.gitToolWindowProvider.refresh();
      return;
    }

    // Merge commit: ask which parent is the mainline (`-m <n>`).
    let revertOptions: { mainline: number } | undefined;
    if (hasMerge) {
      const picked = await ctx.pickMainlineParent(repo, commitHashes);
      if (picked.cancelled) {
        return;
      }
      revertOptions = { mainline: picked.mainline };
    }

    // `commitHashes` arrives newest-first (DOM order). For
    // revert, that IS the right direction: undoing the most recent
    // change first means each subsequent revert applies to a tree the
    // user can mentally check against the displayed log. Cherry-pick
    // reverses; revert does not. ADR follows the contract.
    const result = await ctx.gitService.revert(repo, commitHashes, revertOptions).match(
      (r) => r,
      (e) => {
        throw e;
      }
    );

    if (result.success) {
      void vscode.window.showInformationMessage(
        `Reverted ${commitHashes.length} commit(s) successfully`
      );
    } else if (result.conflicts && result.conflicts.length > 0) {
      await ctx.handleRevertConflicts(repo, result.conflicts, commitHashes);
    } else {
      // Non-conflict failure: surface the underlying git error.
      const reason = result.failureReason ?? 'unknown error (no output from git)';
      void vscode.window.showErrorMessage(`Failed to revert: ${sanitizeGitError(reason)}`);
    }
    // Synchronously reload before refresh so panel sees fresh
    // `repo.head.commit` after the revert.
    await ctx.gitService.reloadRepository(repo);
    ctx.gitToolWindowProvider.refresh();
  } catch (error) {
    void vscode.window.showErrorMessage(formatActionFailureToast('Failed to revert', error));
  }
}

/**
 * Implements the selective-file revert QuickPick.
 *
 * Return value:
 *  - `'fallThrough'` — no prompt shown (single-file commit, or diff
 *    lookup failed); the caller should run the normal revert path.
 *  - `'cancelled'`   — user pressed Esc at the QuickPick; caller should
 *    return without showing any toast.
 *  - `'handled'`     — selective revert ran (partial or full); caller
 *    should skip the normal revert path.
 */
export async function runSelectiveRevertIfApplicable(
  ctx: ICommitRevertActionsContext,
  repo: IRepository,
  hash: string
): Promise<'fallThrough' | 'cancelled' | 'handled'> {
  let diffs;
  try {
    diffs = await ctx.gitService.getCommitDiff(repo, hash);
  } catch {
    return 'fallThrough';
  }
  if (!diffs || diffs.length <= 1) {
    // Nothing meaningful to deselect — normal revert.
    return 'fallThrough';
  }

  const items = diffs.map((d) => ({
    label: d.path,
    description: d.status,
    picked: true,
    path: d.path,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: `Revert ${hash.substring(0, 8)} — choose files to include`,
    placeHolder: 'Deselect files to keep their changes intact',
    canPickMany: true,
    matchOnDescription: true,
  });
  if (!picked) {
    return 'cancelled';
  }
  if (picked.length === 0) {
    void vscode.window.showInformationMessage('No files selected — revert skipped.');
    return 'handled';
  }

  const pickedPaths = new Set(picked.map((p) => p.path));
  const excludedPaths = diffs.map((d) => d.path).filter((p) => !pickedPaths.has(p));

  if (excludedPaths.length === 0) {
    // User kept everything — fall through to the standard flow.
    return 'fallThrough';
  }

  // Partial revert via the `git revert -n` plumbing.
  const cwd = repo.rootUri.fsPath;
  try {
    await ctx.gitCli.exec(['revert', '-n', hash], { cwd, throwOnError: true });
  } catch (error) {
    void vscode.window.showErrorMessage(
      formatActionFailureToast('Failed to start selective revert', error)
    );
    return 'handled';
  }

  // Undo the staged revert for each excluded file, restoring it to its HEAD
  // state in both index and working tree so only the user's picked files stay
  // reverted. A file the commit DELETED is absent from HEAD, so the shared
  // writer unindexes and removes it rather than running a bare
  // `checkout HEAD -- <path>` that would fatal ("pathspec did not match") and
  // fail the whole batch.
  try {
    await restorePathsToHead(
      ctx.gitCli,
      cwd,
      excludedPaths.map((path) => ({ path, removeFromDiskIfAbsentFromHead: true }))
    );
  } catch (error) {
    // Best-effort abort so the working tree isn't half-reverted; ignore its
    // outcome — the primary error below is what the user needs to see.
    await ctx.gitService.revertAbort(repo).unwrapOr(undefined);
    void vscode.window.showErrorMessage(
      `${formatActionFailureToast('Failed to exclude files from revert', error)}. Revert aborted.`
    );
    return 'handled';
  }

  // Finalize the commit.
  let subject = hash.substring(0, 8);
  try {
    const commit = await ctx.gitService.getCommit(repo, hash);
    if (commit.message) {
      subject = commit.message.split('\n')[0];
    }
    // eslint-disable-next-line no-restricted-syntax -- getCommit already logs the fault at the facade re-throw arm; degrade the revert subject to the short hash.
  } catch {
    // Keep short-hash fallback.
  }
  const commitMessage = `Revert "${subject}"\n\nThis reverts parts of commit ${hash}.`;
  try {
    await ctx.gitCli.exec(['commit', '-m', commitMessage], { cwd, throwOnError: true });
  } catch (error) {
    void vscode.window.showErrorMessage(
      formatActionFailureToast('Failed to commit partial revert', error)
    );
    return 'handled';
  }

  void vscode.window.showInformationMessage(
    `Reverted ${pickedPaths.size} of ${diffs.length} file(s) from ${hash.substring(0, 8)}`
  );
  return 'handled';
}
