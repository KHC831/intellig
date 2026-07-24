/**
 * Checkout-revision and reset-to-here actions for the commit context menu.
 */

import * as vscode from 'vscode';
import type { IGitService } from '../git-core/interfaces/IGitService';
import type { GitToolWindowProvider } from '../ui-shell/GitToolWindowProvider';
import { showResetDialog } from '../ui-shell/ResetDialog';
import { formatActionFailureToast } from '../git-core/gitError';
import { isLocalChangesWouldBeOverwritten } from '../git-core/gitProse';
import {
  previewCommitSubject,
  reloadAndRefresh,
  type ICommitRepoContext,
} from './commitContextMenuShared';

/** Deps the checkout/reset actions reach back into the dispatcher for. */
export interface ICommitCheckoutResetActionsContext extends ICommitRepoContext {
  readonly gitService: IGitService;
  readonly gitToolWindowProvider: GitToolWindowProvider;
  readonly context: vscode.ExtensionContext | undefined;
  readProtectedBranches(): string[];
}

/**
 * Checkout the selected commit in detached HEAD mode.
 * Uses the stash/force fallback pattern from BranchContextMenuCommands.
 */
export async function checkoutRevision(
  ctx: ICommitCheckoutResetActionsContext,
  commitHashes: string[]
): Promise<void> {
  const repo = await ctx.getRepositoryForCommit(commitHashes[0]);
  if (!repo || commitHashes.length === 0) {
    return;
  }

  const hash = commitHashes[0];

  try {
    await ctx.gitService.checkout(repo, hash).match(
      () => undefined,
      (e) => {
        throw e;
      }
    );
    // Synchronously reload after checkout so the panel reload
    // runs against fresh `repo.head.commit` (the user's stated bug).
    await ctx.gitService.reloadRepository(repo);
    void vscode.window.showInformationMessage(
      `Checked out revision ${hash.substring(0, 8)} (detached HEAD)`
    );
    ctx.gitToolWindowProvider.refresh();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    if (isLocalChangesWouldBeOverwritten(errorMessage)) {
      const choice = await vscode.window.showWarningMessage(
        `Cannot checkout revision: local changes would be overwritten.`,
        'Stash & Switch',
        'Force Checkout',
        'Cancel'
      );
      if (choice === 'Stash & Switch') {
        try {
          await ctx.gitService
            .stash(repo, `Auto-stash before checkout ${hash.substring(0, 8)}`)
            .match(
              () => undefined,
              (e) => {
                throw e;
              }
            );
          await ctx.gitService.checkout(repo, hash).match(
            () => undefined,
            (e) => {
              throw e;
            }
          );
          // Reload after the stash + checkout pair so panel
          // reload sees fresh `repo.head.commit`.
          await ctx.gitService.reloadRepository(repo);
          void vscode.window.showInformationMessage(
            `Stashed changes and checked out revision ${hash.substring(0, 8)} (detached HEAD)`
          );
          ctx.gitToolWindowProvider.refresh();
        } catch (stashError) {
          void vscode.window.showErrorMessage(
            formatActionFailureToast('Failed to stash and checkout', stashError)
          );
        }
      } else if (choice === 'Force Checkout') {
        try {
          await ctx.gitService.checkout(repo, hash, { force: true }).match(
            () => undefined,
            (e) => {
              throw e;
            }
          );
          // Reload after force checkout.
          await ctx.gitService.reloadRepository(repo);
          void vscode.window.showInformationMessage(
            `Force checked out revision ${hash.substring(0, 8)} (detached HEAD)`
          );
          ctx.gitToolWindowProvider.refresh();
        } catch (forceError) {
          void vscode.window.showErrorMessage(
            formatActionFailureToast('Failed to force checkout', forceError)
          );
        }
      }
    } else {
      void vscode.window.showErrorMessage(
        formatActionFailureToast('Failed to checkout revision', error)
      );
    }
  }
}

/**
 * Reset the current branch to the selected commit.
 * Opens the ResetDialog (webview-based 4-mode picker with protected-branch
 * guard and single destructive-op confirm).
 */
export async function resetToHere(
  ctx: ICommitCheckoutResetActionsContext,
  commitHashes: string[]
): Promise<void> {
  const repo = await ctx.getRepositoryForCommit(commitHashes[0]);
  if (!repo || commitHashes.length === 0) {
    return;
  }
  if (!ctx.context) {
    // Should not happen in production — register() wires this — but
    // guard defensively so tests that skip register() don't crash.
    void vscode.window.showErrorMessage(
      'Reset dialog is unavailable: extension context not initialised.'
    );
    return;
  }

  const hash = commitHashes[0];

  // Commit subject for the dialog header; falls back to blank (the shared
  // helper bounds the lookup at 500ms so a slow git can't stall the dialog).
  const subject = await previewCommitSubject(ctx, repo, hash);

  const currentBranch = extractBranchName(repo.head?.name) ?? '';
  const protectedBranches = ctx.readProtectedBranches();

  showResetDialog(ctx.context, {
    repo,
    target: { hash, subject },
    currentBranch,
    protectedBranches,
    gitService: ctx.gitService,
    onResetComplete: () => {
      // fire-and-forget reload before refresh so panel sees
      // fresh `repo.head.commit` after the dialog's resetToCommit. The
      // callback can't be async (dialog API constraint), so we
      // sequence reload → refresh inside an IIFE; the watcher's
      // debounced reload remains as a fallback.
      void (async (): Promise<void> => {
        await reloadAndRefresh(ctx, repo);
      })();
    },
  });
}

/**
 * Convert a refspec like `refs/heads/main` to its short branch name (`main`).
 * Returns undefined for detached HEAD / falsy input.
 */
function extractBranchName(ref: string | undefined): string | undefined {
  if (!ref) {
    return undefined;
  }
  return ref.replace(/^refs\/heads\//, '');
}
