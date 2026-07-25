/**
 * Tag actions for the branch context menu: checkout-detached, cherry-pick,
 * merge-into-current, push, delete (single/batch), and delete-on-remote with
 * the local/remote delete cascades. Each action reaches back into the
 * dispatcher through {@link IBranchTagContext}.
 */

import * as vscode from 'vscode';
import type { IGitService, IRepository } from '../git-core/interfaces/IGitService';
import type { BranchTreeProvider } from './BranchTreeProvider';
import type { MergeDialogOpener } from './BranchContextMenuCommands';
import { sanitizeGitError, formatActionFailureToast } from '../git-core/gitError';
import type { ITreeItemRunArgs, ITreeItemBatchEntry } from '../commands/registration/commandSpine';
import { cherryPickSuffixOptions } from './branchCherryPickActions';
import { chooseTargetRemote } from './branchPushActions';
import { routeRefOperationOutcome, type IRefOperationConflictContext } from './refOperationOutcome';

/** Deps the tag actions reach back into the dispatcher for. */
export interface IBranchTagContext extends IRefOperationConflictContext {
  readonly gitService: IGitService;
  readonly branchTreeProvider: BranchTreeProvider;
  readonly mergeDialogOpener: MergeDialogOpener | undefined;
}

/**
 * Handle tag checkout (detached) command.
 */
export async function handleTagCheckoutDetached(
  ctx: IBranchTagContext,
  { repo, target }: ITreeItemRunArgs<'tag'>
): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    `Checking out tag '${target.tag.name}' will put you in detached HEAD state. Continue?`,
    { modal: true },
    'Checkout'
  );

  if (confirm !== 'Checkout') {
    return;
  }

  try {
    await ctx.gitService.checkout(repo, target.tag.name).match(
      () => undefined,
      (e) => {
        throw e;
      }
    );
    // checkout-tag moved HEAD into detached state; reload
    // before refresh so the tree's "current branch" mark clears
    // (HEAD chip on the log graph drives the user-visible cue).
    await ctx.gitService.reloadRepository(repo);
    void vscode.window.showInformationMessage(
      `Checked out tag '${target.tag.name}' (detached HEAD)`
    );
    ctx.branchTreeProvider.refresh();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(
      `Failed to checkout tag: ${sanitizeGitError(errorMessage)}`
    );
  }
}

/**
 * Handle tag cherry-pick command.
 */
export async function handleTagCherryPick(
  ctx: IBranchTagContext,
  { repo, target }: ITreeItemRunArgs<'tag'>
): Promise<void> {
  try {
    const suffixOptions = await cherryPickSuffixOptions(ctx, repo, [target.tag.commit]);
    const result = await ctx.gitService.cherryPick(repo, [target.tag.commit], suffixOptions).match(
      (r) => r,
      (e) => {
        throw e;
      }
    );

    await routeRefOperationOutcome(ctx, repo, result, {
      operation: 'cherryPick',
      target: target.tag.name,
      failurePrefix: 'Failed to cherry-pick',
      onSuccess: () =>
        void vscode.window.showInformationMessage(
          `Cherry-picked tag '${target.tag.name}' successfully`
        ),
    });
    // cherry-pick from tag moved HEAD; reload before refresh.
    await ctx.gitService.reloadRepository(repo);
    ctx.branchTreeProvider.refresh();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(`Failed to cherry-pick: ${sanitizeGitError(errorMessage)}`);
  }
}

/**
 * Handle tag "Merge into Current" command — merge the selected tag into the
 * current branch. IntelliJ git4idea parity: GitBranchPopupActions.TagActions
 * offers a MergeAction built from `new GitTag(tagName)`, so the same
 * `Merge <ref> into Current` flow that branches use applies to a tag ref.
 *
 * Reuses the existing merge surface: routes through the Merge Dialog when
 * wired (the dialog feeds the tag name straight into `mergeBranch` as a
 * generic source ref and owns the ff-only/no-ff/squash options plus conflict
 * handoff), falling back to a direct `mergeBranch` with the same conflict /
 * non-conflict-failure routing as `_handleMergeIntoCurrent`.
 */
export async function handleTagMergeIntoCurrent(
  ctx: IBranchTagContext,
  { repo, target }: ITreeItemRunArgs<'tag'>
): Promise<void> {
  const tagRef = target.tag.name;

  if (ctx.mergeDialogOpener) {
    ctx.mergeDialogOpener({ repo, sourceBranch: tagRef });
    return;
  }

  try {
    const result = await ctx.gitService.mergeBranch(repo, tagRef);

    await routeRefOperationOutcome(ctx, repo, result, {
      operation: 'merge',
      target: tagRef,
      failurePrefix: `Failed to merge '${tagRef}'`,
      onSuccess: () => void vscode.window.showInformationMessage(`Merged '${tagRef}' successfully`),
    });
    // Merge moved HEAD; reload before refresh.
    await ctx.gitService.reloadRepository(repo);
    ctx.branchTreeProvider.refresh();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(`Failed to merge tag: ${sanitizeGitError(errorMessage)}`);
  }
}

/**
 * Delete every tag in a multi-select batch: ONE confirm naming them all,
 * per-tag deletion with per-item repos, failures collected into a single
 * error toast. The spine's refreshOnSuccess covers the tree refresh.
 */
export async function handleTagDeleteBatch(
  ctx: IBranchTagContext,
  batch: ReadonlyArray<ITreeItemBatchEntry<'tag'>>
): Promise<void> {
  const names = batch.map((e) => e.target.tag.name);
  const confirm = await vscode.window.showWarningMessage(
    `Are you sure you want to delete ${batch.length} tags?\n\n${names.join(', ')}`,
    { modal: true },
    'Delete'
  );
  if (confirm !== 'Delete') {
    return;
  }

  const failures: string[] = [];
  const touchedRepos = new Map<string, IRepository>();
  const deleted: Array<{ repo: IRepository; name: string }> = [];
  for (const entry of batch) {
    const name = entry.target.tag.name;
    try {
      await ctx.gitService.deleteTag(entry.repo, name).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      deleted.push({ repo: entry.repo, name });
      touchedRepos.set(entry.repo.rootUri.fsPath, entry.repo);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      failures.push(`${name}: ${sanitizeGitError(message)}`);
    }
  }
  for (const repo of touchedRepos.values()) {
    await ctx.gitService.reloadRepository(repo);
  }
  // Fire-and-forget the success toast + optional remote-delete offer so it
  // doesn't hold the command pending on the toast.
  void offerRemoteDeleteForLocalTags(ctx, deleted);
  if (failures.length > 0) {
    void vscode.window.showErrorMessage(`Failed to delete: ${failures.join('; ')}`);
  }
}

/**
 * Handle push tag command.
 */
export async function handleTagPush(
  ctx: IBranchTagContext,
  { repo, target }: ITreeItemRunArgs<'tag'>
): Promise<void> {
  try {
    // Choose the target remote when several exist (default = origin / first);
    // a single remote pushes without prompting. Cancel aborts.
    const targetRemote = await chooseTargetRemote(ctx, repo);
    if (!targetRemote) {
      return;
    }
    await ctx.gitService.pushTag(repo, target.tag.name, targetRemote).match(
      () => undefined,
      (e) => {
        throw e;
      }
    );
    void vscode.window.showInformationMessage(
      `Pushed tag '${target.tag.name}' to '${targetRemote}'`
    );
    // pushTag updates remote-tracking refs;
    // reload + refresh so the tag tree's "pushed to remote" cue
    // (when present) reads the post-push state.
    await ctx.gitService.reloadRepository(repo);
    ctx.branchTreeProvider.refresh();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(`Failed to push tag: ${sanitizeGitError(errorMessage)}`);
  }
}

/**
 * Handle delete-remote-tag command — IntelliJ GitDeleteRemoteTagOperation parity
 * (`git4idea/backend/src/ui/GitTagDialog.java` and
 * `StashTagHistoryOps.deleteRemoteTag`).
 *
 * Prompts for confirmation then calls
 * `git push <remote> :refs/tags/<name>` via the existing
 * {@link StashTagHistoryOps.deleteRemoteTag} op. Errors route through
 * {@link sanitizeGitError} so credentials in remote URLs are stripped.
 */
export async function handleTagDeleteRemote(
  ctx: IBranchTagContext,
  { repo, target }: ITreeItemRunArgs<'tag'>
): Promise<void> {
  // Choose the target remote (default = origin / first; prompt when several
  // exist), mirroring `handleTagPush` — don't silently hardcode origin in a
  // multi-remote repo. Cancel aborts.
  const targetRemote = await chooseTargetRemote(ctx, repo);
  if (!targetRemote) {
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Delete remote tag '${target.tag.name}' from ${targetRemote}?`,
    { modal: true },
    'Delete from Remote'
  );

  if (confirm !== 'Delete from Remote') {
    return;
  }

  if (!(await deleteRemoteTag(ctx, repo, target.tag.name, targetRemote))) {
    return;
  }
  // Re-sync the tree with reality (this command previously never refreshed).
  ctx.branchTreeProvider.refresh();
  // Fire-and-forget the success toast + local-delete offer so it never holds
  // the command pending on the toast.
  void offerLocalDeleteAfterRemote(ctx, repo, target.tag.name, targetRemote);
}

/**
 * Report a remote tag deletion and offer to delete the still-present local
 * tag too. The branch window lists LOCAL tags (`git tag -l`); deleting the
 * remote ref leaves the local one, so the tag keeps showing unchanged and the
 * user thinks the delete failed. Mirror of {@link offerRemoteDeleteForLocalTags}
 * in the other direction so a tag can be fully removed from either entry point.
 */
async function offerLocalDeleteAfterRemote(
  ctx: IBranchTagContext,
  repo: IRepository,
  name: string,
  remote: string
): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    `Deleted remote tag '${name}' from ${remote}. It still exists locally.`,
    'Delete Locally'
  );
  if (choice !== 'Delete Locally') {
    return;
  }
  const deleted = await ctx.gitService.deleteTag(repo, name).match(
    () => true,
    (error) => {
      void vscode.window.showErrorMessage(formatActionFailureToast('Failed to delete tag', error));
      return false;
    }
  );
  if (!deleted) {
    return;
  }
  // Tag list changed; reload so the tree drops the tag before the repaint.
  await ctx.gitService.reloadRepository(repo);
  ctx.branchTreeProvider.refresh();
  void vscode.window.showInformationMessage(`Deleted tag '${name}' locally`);
}

/**
 * Delete one tag on `remote` (`git push <remote> :refs/tags/<name>`). Returns
 * whether it succeeded; a failure is toasted (credentials scrubbed) and
 * swallowed so a batch can continue. Confirmation is the caller's job — the
 * direct command uses a modal, the post-local-delete affordance uses the
 * toast action as the confirm.
 */
async function deleteRemoteTag(
  ctx: IBranchTagContext,
  repo: IRepository,
  name: string,
  remote: string
): Promise<boolean> {
  try {
    await ctx.gitService.deleteRemoteTag(repo, name, remote).match(
      () => undefined,
      (e) => {
        throw e;
      }
    );
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(
      `Failed to delete remote tag '${name}': ${sanitizeGitError(errorMessage)}`
    );
    return false;
  }
}

/**
 * Report a local tag deletion and, when a deleted tag's repo has a remote,
 * offer to delete it there too. A local `git tag -d` never touches the remote
 * and AutoFetch re-imports a tag that still exists on a remote — so without
 * this the tag "comes back" after a delete that reported success. Mirrors
 * IntelliJ's GitDeleteTagOperation, whose success notification carries a
 * "Delete on Remote" action when the repo has remotes
 * (git4idea/backend/src/branch/GitDeleteTagOperation.java).
 */
export async function offerRemoteDeleteForLocalTags(
  ctx: IBranchTagContext,
  deleted: ReadonlyArray<{ repo: IRepository; name: string }>
): Promise<void> {
  if (deleted.length === 0) {
    return;
  }
  const summary =
    deleted.length === 1
      ? `Deleted tag '${deleted[0].name}' locally`
      : `Deleted ${deleted.length} tags locally`;
  if (!deleted.some((d) => d.repo.remotes.length > 0)) {
    void vscode.window.showInformationMessage(summary);
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `${summary}. ${deleted.length === 1 ? 'It may' : 'They may'} still exist on the remote.`,
    'Delete on Remote'
  );
  if (choice !== 'Delete on Remote') {
    return;
  }
  // Group by repo so a multi-remote repo prompts for its remote only once.
  const byRepo = new Map<string, { repo: IRepository; names: string[] }>();
  for (const d of deleted) {
    const entry = byRepo.get(d.repo.rootUri.fsPath) ?? { repo: d.repo, names: [] };
    entry.names.push(d.name);
    byRepo.set(d.repo.rootUri.fsPath, entry);
  }
  let removed = 0;
  let lastName = '';
  for (const { repo, names } of byRepo.values()) {
    if (repo.remotes.length === 0) {
      continue;
    }
    const remote = await chooseTargetRemote(ctx, repo);
    if (!remote) {
      continue;
    }
    for (const name of names) {
      if (await deleteRemoteTag(ctx, repo, name, remote)) {
        removed += 1;
        lastName = name;
      }
    }
  }
  if (removed === 1) {
    void vscode.window.showInformationMessage(`Deleted remote tag '${lastName}'`);
  } else if (removed > 1) {
    void vscode.window.showInformationMessage(`Deleted ${removed} remote tags`);
  }
}
