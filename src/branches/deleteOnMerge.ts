/**
 * deleteOnMerge PROPOSE — git4idea parity. GitBranchPopupActions.MergeAction
 * merges a non-protected local branch with deleteOnMerge = PROPOSE
 * (GitBranchPopupActions.java:287-291), and GitMergeOperation.notifySuccess's
 * PROPOSE arm posts a "Delete <branch>" action on the success notification.
 * Shared by the Merge Dialog and the branch-menu fallback merge path.
 */

import * as vscode from 'vscode';
import type { IGitService, IRepository } from '../git-core/interfaces/IGitService';
import { sanitizeGitError } from '../git-core/gitError';

/**
 * Recognise the canonical "not fully merged" stderr emitted by
 * `git branch -d` when the branch's tip is unreachable from any other
 * ref. Used to upgrade a safe-delete failure to a force path rather than
 * surfacing the raw CLI hint to the user.
 *
 * Matches across git versions and locales by checking for the stable
 * "not fully merged" phrase. The full message is roughly:
 *   error: the branch '<name>' is not fully merged
 *   If you are sure you want to delete it, run 'git branch -D <name>'
 */
export function isNotFullyMergedError(message: string): boolean {
  return /not fully merged/i.test(message);
}

/** Git surface + refresh hook {@link proposeDeleteMergedBranch} needs. */
export interface IProposeDeleteDeps {
  gitService: Pick<IGitService, 'deleteBranch' | 'reloadRepository'>;
  /** Fired after a successful delete so the caller can refresh its views. */
  onDeleted?: () => void;
}

/**
 * Post `successMessage` with a "Delete <branch>" action; accepting deletes
 * the merged branch. A not-fully-merged refusal force-retries without a
 * second prompt — reference parity (GitDeleteBranchOperation auto-forces),
 * and a squash merge leaves the branch unmerged by design while the user
 * just asked to delete exactly this branch.
 */
export async function proposeDeleteMergedBranch(
  deps: IProposeDeleteDeps,
  repo: IRepository,
  branchName: string,
  successMessage: string
): Promise<void> {
  const label = `Delete ${branchName}`;
  const choice = await vscode.window.showInformationMessage(successMessage, label);
  if (choice !== label) {
    return;
  }
  try {
    try {
      await deps.gitService.deleteBranch(repo, branchName).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (!isNotFullyMergedError(message)) {
        throw error;
      }
      await deps.gitService.deleteBranch(repo, branchName, true).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
    }
    // Branch list changed; reload before the caller's refresh.
    await deps.gitService.reloadRepository(repo);
    void vscode.window.showInformationMessage(`Deleted branch '${branchName}'`);
    deps.onDeleted?.();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(`Failed to delete branch: ${sanitizeGitError(message)}`);
  }
}
