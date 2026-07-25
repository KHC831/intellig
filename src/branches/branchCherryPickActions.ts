/**
 * Cherry-pick actions for the branch context menu: pick commits from a branch
 * ref, plus the shared `-x` provenance-suffix probe (also used by the tag
 * cherry-pick flow). Reaches back into the dispatcher through
 * {@link IBranchCherryPickContext}.
 */

import * as vscode from 'vscode';
import type { IGitService, IRepository } from '../git-core/interfaces/IGitService';
import type { BranchTreeProvider } from './BranchTreeProvider';
import { sanitizeGitError } from '../git-core/gitError';
import { readConfig } from '../config/configKeys';
import { isCommitPublished, type PublishProbeCli } from '../git-core/commitPublished';
import type { ITreeItemRunArgs } from '../commands/registration/commandSpine';
import { routeRefOperationOutcome, type IRefOperationConflictContext } from './refOperationOutcome';

/** Deps the cherry-pick actions reach back into the dispatcher for. */
export interface IBranchCherryPickContext extends IRefOperationConflictContext {
  readonly gitService: IGitService;
  readonly branchTreeProvider: BranchTreeProvider;
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

    await routeRefOperationOutcome(ctx, repo, result, {
      operation: 'cherryPick',
      target: target.branch.name,
      failurePrefix: 'Failed to cherry-pick',
      onSuccess: () =>
        void vscode.window.showInformationMessage(
          `Cherry-picked ${selected.length} commit(s) successfully`
        ),
    });
    // cherry-pick moved HEAD; reload before refresh.
    await ctx.gitService.reloadRepository(repo);
    ctx.branchTreeProvider.refresh();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(`Failed to cherry-pick: ${sanitizeGitError(errorMessage)}`);
  }
}
