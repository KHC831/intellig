/**
 * Cherry-pick action for the commit context menu, including the mainline
 * parent prompt for merge commits and the `-x` published-provenance suffix.
 * Extracted from CommitContextMenuCommands; the class delegates through a thin
 * context so behaviour is unchanged. The conflict-resolution service is read
 * through a call-time getter (it is setter-wired and read after the cherry-pick
 * await), and the Resolve Conflicts dialog stays on the class.
 */

import * as vscode from 'vscode';
import type { IGitService, IRepository } from '../git-core/interfaces/IGitService';
import type { GitToolWindowProvider } from '../ui-shell/GitToolWindowProvider';
import type { IConflictResolutionService } from '../conflicts/interfaces/IConflictResolutionService';
import { readConfig } from '../config/configKeys';
import { sanitizeGitError } from '../git-core/gitError';

/** Deps the cherry-pick action reaches back into the dispatcher for. */
export interface ICommitCherryPickActionsContext {
  readonly gitService: IGitService;
  readonly gitToolWindowProvider: GitToolWindowProvider;
  getRepositoryForCommit(hash?: string): Promise<IRepository | undefined>;
  isCrossRepoSelection(commitHashes: readonly string[]): boolean;
  anyIsMergeCommit(repo: IRepository, hashes: string[]): Promise<boolean>;
  pickMainlineParent(
    repo: IRepository,
    hashes: string[]
  ): Promise<{ cancelled: false; mainline: number } | { cancelled: true }>;
  isCommitPushed(cwd: string, hash: string, probeFailureMeansPushed?: boolean): Promise<boolean>;
  conflictResolutionService(): IConflictResolutionService | undefined;
  openResolveConflictsDialog(
    repo: IRepository,
    conflicts: string[],
    opContext: {
      operation: 'merge' | 'rebase' | 'cherryPick' | 'revert';
      target?: string;
      rebaseInProgress?: boolean;
    }
  ): Promise<void>;
}

/**
 * Cherry-pick the selected commit(s) onto the current branch.
 *
 * `commitHashes` arrives in NEWEST-FIRST order (the
 * webview sends DOM order from `.commit-row.selected`). For a
 * cherry-pick, that's the wrong direction: replaying newest-first
 * destroys authored ordering on the target branch. The
 * WARNING on `getSelectedCommits()` covers this contract: chronological-
 * replay consumers MUST `.reverse()`. We do it here so the `gitService`
 * call site is the canonical "this is the order git will see" point.
 *
 * Reversing also normalizes single-commit behavior — `[h]` reversed
 * is still `[h]`, no change.
 */
export async function handleCherryPick(
  ctx: ICommitCherryPickActionsContext,
  commitHashes: string[]
): Promise<void> {
  if (ctx.isCrossRepoSelection(commitHashes)) {
    return;
  }
  const repo = await ctx.getRepositoryForCommit(commitHashes[0]);
  if (!repo || commitHashes.length === 0) {
    return;
  }

  // Display order (newest-first) → replay order
  // (oldest-first). Slice first so we don't mutate the caller's array.
  const replayOrder = [...commitHashes].reverse();

  try {
    // Detect merge commits: a merge needs `-m <parent>` so git knows which
    // parent line is the mainline. Prompt for the parent (parent 1 = default
    // mainline). If the probe fails (e.g. network/bad hash), fall back to no
    // mainline — git will surface its own "is a merge" error in that edge case.
    const hasMerge = await ctx.anyIsMergeCommit(repo, replayOrder).catch(() => false);
    let cherryOptions: { mainline?: number; addCherryPickedFrom?: boolean } | undefined;
    if (hasMerge) {
      const picked = await ctx.pickMainlineParent(repo, replayOrder);
      if (picked.cancelled) {
        return;
      }
      cherryOptions = { mainline: picked.mainline };
    }

    // "(cherry picked from commit <hash>)" suffix for published commits —
    // IntelliJ applies `-x` per commit when the setting is on and the commit
    // is published (CherryPickProcess.kt shouldAddSuffix). Our single git
    // invocation annotates all-or-none, so require EVERY picked commit to be
    // published: the newest picked commit publishes its ancestors, but a
    // multi-select need not be one chain, so probe each.
    if (readConfig('addCherryPickedFromSuffix')) {
      const cwd = repo.rootUri.fsPath;
      let allPublished = true;
      for (const h of replayOrder) {
        if (!(await ctx.isCommitPushed(cwd, h, /* probeFailureMeansPushed */ false))) {
          allPublished = false;
          break;
        }
      }
      if (allPublished) {
        cherryOptions = { ...cherryOptions, addCherryPickedFrom: true };
      }
    }

    const result = await ctx.gitService.cherryPick(repo, replayOrder, cherryOptions).match(
      (r) => r,
      (e) => {
        throw e;
      }
    );

    if (result.success) {
      void vscode.window.showInformationMessage(
        `Cherry-picked ${commitHashes.length} commit(s) successfully`
      );
    } else if (result.conflicts && result.conflicts.length > 0) {
      // Auto-open the Resolve Conflicts dialog. Falls back to the legacy
      // toast if conflictResolutionService isn't wired yet.
      if (ctx.conflictResolutionService()) {
        await ctx.openResolveConflictsDialog(repo, result.conflicts, {
          operation: 'cherryPick',
          target: commitHashes[0].substring(0, 8),
        });
      } else {
        const choice = await vscode.window.showWarningMessage(
          `Cherry-pick conflicts in ${result.conflicts.length} file(s). Please resolve conflicts.`,
          'Open Conflicts',
          'Abort Cherry-Pick'
        );
        if (choice === 'Open Conflicts') {
          for (const filePath of result.conflicts) {
            const fileUri = vscode.Uri.joinPath(repo.rootUri, filePath);
            await vscode.commands.executeCommand('vscode.open', fileUri);
          }
        } else if (choice === 'Abort Cherry-Pick') {
          try {
            await ctx.gitService.cherryPickAbort(repo).match(
              () => undefined,
              (e) => {
                throw e;
              }
            );
            void vscode.window.showInformationMessage('Cherry-pick aborted.');
          } catch (abortError) {
            const abortMsg = abortError instanceof Error ? abortError.message : 'Unknown error';
            void vscode.window.showErrorMessage(
              `Failed to abort cherry-pick: ${sanitizeGitError(abortMsg)}`
            );
          }
        }
      }
    } else {
      // Non-conflict failure: surface the underlying git error.
      const reason = result.failureReason ?? 'unknown error (no output from git)';
      void vscode.window.showErrorMessage(`Failed to cherry-pick: ${sanitizeGitError(reason)}`);
    }
    // Synchronously reload before refresh so panel sees fresh
    // `repo.head.commit` after the cherry-pick.
    await ctx.gitService.reloadRepository(repo);
    ctx.gitToolWindowProvider.refresh();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(`Failed to cherry-pick: ${sanitizeGitError(errorMessage)}`);
  }
}
