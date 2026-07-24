/**
 * Cherry-pick actions for the branch context menu: pick commits from a branch
 * ref, plus the shared `-x` provenance-suffix probe (also used by the tag
 * cherry-pick flow). Reaches back into the dispatcher through
 * {@link IBranchCherryPickContext}.
 */

import * as vscode from 'vscode';
import type { IGitService, IRepository } from '../git-core/interfaces/IGitService';
import type { BranchTreeProvider } from './BranchTreeProvider';
import type { IConflictResolutionService } from '../conflicts/interfaces/IConflictResolutionService';
import { sanitizeGitError } from '../git-core/gitError';
import { readConfig } from '../config/configKeys';
import { isCommitPublished, type PublishProbeCli } from '../git-core/commitPublished';
import type { ITreeItemRunArgs } from '../commands/registration/commandSpine';

/** Deps the cherry-pick actions reach back into the dispatcher for. */
export interface IBranchCherryPickContext {
  readonly gitService: IGitService;
  readonly branchTreeProvider: BranchTreeProvider;
  // Setter-wired (setConflictResolutionService) and read AFTER an await, so the
  // context must read it live.
  conflictResolutionService(): IConflictResolutionService | undefined;
  // The Resolve Conflicts dialog seam stays on the dispatcher (sole live reader
  // of the setter-wired conflict service); moved handlers reach it here.
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
 * Cherry-pick options for the `-x` provenance suffix
 * (intellig.addCherryPickedFromSuffix). IntelliJ annotates only when the
 * setting is on AND the commit is published (CherryPickProcess.kt
 * shouldAddSuffix); our single git invocation annotates all-or-none, so
 * EVERY hash must be published. The publish probe needs the concrete
 * GitService's gitCli (frozen IGitService has none — ADR-001), reached
 * duck-typed; absence degrades to no annotation, matching the
 * known-published-only contract.
 */
export async function cherryPickSuffixOptions(
  ctx: Pick<IBranchCherryPickContext, 'gitService'>,
  repo: IRepository,
  hashes: readonly string[]
): Promise<{ addCherryPickedFrom: true } | undefined> {
  if (!readConfig('addCherryPickedFromSuffix')) {
    return undefined;
  }
  const cli = (ctx.gitService as unknown as { gitCli?: PublishProbeCli }).gitCli;
  if (!cli || typeof cli.exec !== 'function') {
    return undefined;
  }
  const cwd = repo.rootUri.fsPath;
  for (const hash of hashes) {
    if (!(await isCommitPublished(cli, cwd, hash, /* probeFailureMeansPublished */ false))) {
      return undefined;
    }
  }
  return { addCherryPickedFrom: true };
}

/**
 * Handle cherry-pick commits command.
 */
export async function handleCherryPickCommits(
  ctx: IBranchCherryPickContext,
  { repo, target }: ITreeItemRunArgs<'branch'>
): Promise<void> {
  try {
    // Scope the log to the SELECTED branch (e.g. `origin/feature`), not the
    // repo's global HEAD history — otherwise the picker lists HEAD's recent
    // commits and the user cherry-picks the wrong commits.
    const commits = await ctx.gitService.getLog(repo, {
      maxCount: 50,
      ref: target.branch.name,
    });

    const commitItems = commits.map((commit) => ({
      label: commit.shortHash,
      description: commit.message.split('\n')[0],
      detail: `${commit.author.name} - ${commit.authorDate.toLocaleDateString()}`,
      commit,
    }));

    const selected = await vscode.window.showQuickPick(commitItems, {
      title: `Cherry-pick commits from ${target.branch.name}`,
      placeHolder: 'Select commits to cherry-pick',
      canPickMany: true,
    });

    if (!selected || selected.length === 0) {
      return;
    }

    const commitHashes = selected.map((s) => s.commit.hash);
    const suffixOptions = await cherryPickSuffixOptions(ctx, repo, commitHashes);
    const result = await ctx.gitService.cherryPick(repo, commitHashes, suffixOptions).match(
      (r) => r,
      (e) => {
        throw e;
      }
    );

    if (result.success) {
      void vscode.window.showInformationMessage(
        `Cherry-picked ${selected.length} commit(s) successfully`
      );
    } else if (result.conflicts && result.conflicts.length > 0) {
      // Auto-open Resolve Conflicts dialog when wired.
      if (ctx.conflictResolutionService()) {
        await ctx.openResolveConflictsDialog(repo, result.conflicts, {
          operation: 'cherryPick',
          target: target.branch.name,
        });
      } else {
        void vscode.window.showWarningMessage(
          `Cherry-pick conflicts in ${result.conflicts.length} file(s). Please resolve conflicts.`
        );
      }
    } else {
      // Non-conflict failure: surface the underlying git error.
      const reason = result.failureReason ?? 'unknown error (no output from git)';
      void vscode.window.showErrorMessage(`Failed to cherry-pick: ${sanitizeGitError(reason)}`);
    }
    // cherry-pick moved HEAD; reload before refresh.
    await ctx.gitService.reloadRepository(repo);
    ctx.branchTreeProvider.refresh();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(`Failed to cherry-pick: ${sanitizeGitError(errorMessage)}`);
  }
}
