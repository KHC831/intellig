/**
 * Local-branch delete actions for the branch context menu: single delete with
 * a not-fully-merged force retry, and multi-select batch delete with one
 * follow-up force prompt. Both offer the tracked-branch delete cascade after a
 * successful deletion. Reaches back into the dispatcher through
 * {@link IBranchDeleteContext}.
 */

import * as vscode from 'vscode';
import type { IGitService, IRepository, IUpstream } from '../git-core/interfaces/IGitService';
import type { BranchTreeProvider } from './BranchTreeProvider';
import { sanitizeGitError } from '../git-core/gitError';
import { isNotFullyMergedError } from './deleteOnMerge';
import { offerDeleteTrackedBranches } from './branchRemoteActions';
import type { ITreeItemRunArgs, ITreeItemBatchEntry } from '../commands/registration/commandSpine';

/**
 * Deps the delete actions reach back into the dispatcher for. Both are
 * constructor-stable, so a snapshot is live. The shape also structurally
 * satisfies {@link import('./branchRemoteActions').IBranchRemoteContext}, so it
 * is passed straight through to the shared tracked-branch delete cascade.
 */
export interface IBranchDeleteContext {
  readonly gitService: IGitService;
  readonly branchTreeProvider: BranchTreeProvider;
}

/**
 * Delete a single local branch, or route a multi-select to
 * {@link handleDeleteBatch}. IntelliJ parity: a safe delete
 * (`git branch -d`) that refuses on not-fully-merged prompts a force
 * (`git branch -D`) retry.
 */
export async function handleDelete(
  ctx: IBranchDeleteContext,
  args: ITreeItemRunArgs<'branch'>
): Promise<void> {
  if (args.batch.length > 1) {
    return handleDeleteBatch(ctx, args.batch);
  }
  const { repo, target } = args;
  const branchName = target.branch.name;

  const confirm = await vscode.window.showWarningMessage(
    `Are you sure you want to delete the branch '${branchName}'?`,
    { modal: true },
    'Delete'
  );

  if (confirm !== 'Delete') {
    return;
  }

  const upstream = target.branch.upstream;
  try {
    await ctx.gitService.deleteBranch(repo, branchName).match(
      () => undefined,
      (e) => {
        throw e;
      }
    );
    // Branch list changed; reload so the tree shows the
    // post-deletion ref set deterministically.
    await ctx.gitService.reloadRepository(repo);
    // Fire-and-forget: the success toast + optional tracked-branch cascade
    // must not hold the command pending on the toast.
    void offerDeleteTrackedBranches(ctx, `Deleted branch '${branchName}'`, [
      { repo, name: branchName, upstream },
    ]);
    ctx.branchTreeProvider.refresh();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (isNotFullyMergedError(errorMessage)) {
      const forceConfirm = await vscode.window.showWarningMessage(
        `Branch '${branchName}' is not fully merged. Force delete? Unmerged commits will be lost.`,
        { modal: true },
        'Force Delete'
      );
      if (forceConfirm !== 'Force Delete') {
        return;
      }
      try {
        await ctx.gitService.deleteBranch(repo, branchName, true).match(
          () => undefined,
          (e) => {
            throw e;
          }
        );
        await ctx.gitService.reloadRepository(repo);
        void offerDeleteTrackedBranches(ctx, `Force-deleted branch '${branchName}'`, [
          { repo, name: branchName, upstream },
        ]);
        ctx.branchTreeProvider.refresh();
      } catch (forceError) {
        const forceMessage = forceError instanceof Error ? forceError.message : 'Unknown error';
        void vscode.window.showErrorMessage(
          `Failed to force-delete branch: ${sanitizeGitError(forceMessage)}`
        );
      }
      return;
    }

    void vscode.window.showErrorMessage(
      `Failed to delete branch: ${sanitizeGitError(errorMessage)}`
    );
  }
}

/**
 * Delete every branch in a multi-select batch: ONE confirm naming them
 * all, per-branch deletion with per-item repos, then ONE follow-up force
 * prompt covering every not-fully-merged branch (instead of a modal per
 * branch mid-batch). Other failures are collected into a single error
 * toast; the batch never stops early, so one refused branch doesn't strand
 * the rest of a cleanup.
 */
async function handleDeleteBatch(
  ctx: IBranchDeleteContext,
  batch: ReadonlyArray<ITreeItemBatchEntry<'branch'>>
): Promise<void> {
  const names = batch.map((e) => e.target.branch.name);
  const confirm = await vscode.window.showWarningMessage(
    `Are you sure you want to delete ${batch.length} branches?\n\n${names.join(', ')}`,
    { modal: true },
    'Delete'
  );
  if (confirm !== 'Delete') {
    return;
  }

  const notMerged: Array<ITreeItemBatchEntry<'branch'>> = [];
  const failures: string[] = [];
  const touchedRepos = new Map<string, IRepository>();
  const deletedEntries: Array<{ repo: IRepository; name: string; upstream?: IUpstream }> = [];

  const tryDelete = async (entry: ITreeItemBatchEntry<'branch'>, force: boolean): Promise<void> => {
    const name = entry.target.branch.name;
    try {
      await ctx.gitService.deleteBranch(entry.repo, name, force || undefined).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      deletedEntries.push({ repo: entry.repo, name, upstream: entry.target.branch.upstream });
      touchedRepos.set(entry.repo.rootUri.fsPath, entry.repo);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (!force && isNotFullyMergedError(message)) {
        notMerged.push(entry);
      } else {
        failures.push(`${name}: ${sanitizeGitError(message)}`);
      }
    }
  };

  for (const entry of batch) {
    await tryDelete(entry, false);
  }

  if (notMerged.length > 0) {
    const unmergedNames = notMerged.map((e) => e.target.branch.name).join(', ');
    const forceConfirm = await vscode.window.showWarningMessage(
      `${notMerged.length} branch(es) are not fully merged: ${unmergedNames}. ` +
        `Force delete? Unmerged commits will be lost.`,
      { modal: true },
      'Force Delete'
    );
    if (forceConfirm === 'Force Delete') {
      for (const entry of notMerged) {
        await tryDelete(entry, true);
      }
    }
  }

  for (const repo of touchedRepos.values()) {
    await ctx.gitService.reloadRepository(repo);
  }
  if (deletedEntries.length > 0) {
    // Fire-and-forget: the toast + optional tracked-branch cascade must
    // not hold the command pending on the toast.
    void offerDeleteTrackedBranches(
      ctx,
      deletedEntries.length === batch.length
        ? `Deleted ${deletedEntries.length} branches`
        : `Deleted ${deletedEntries.length} of ${batch.length} branches`,
      deletedEntries
    );
  }
  if (failures.length > 0) {
    void vscode.window.showErrorMessage(`Failed to delete: ${failures.join('; ')}`);
  }
  ctx.branchTreeProvider.refresh();
}
