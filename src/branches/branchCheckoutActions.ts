/**
 * Checkout actions for the branch context menu: plain checkout (with the
 * dirty-tree stash/force recovery), checkout-and-rebase, and checking out a
 * remote branch as a local one. Includes the shared dirty-tree prompt and the
 * auto-stash bracket those flows use. Reaches back into the dispatcher through
 * {@link IBranchCheckoutContext}.
 */

import * as vscode from 'vscode';
import type { IGitService, IRepository } from '../git-core/interfaces/IGitService';
import type { BranchTreeProvider } from './BranchTreeProvider';
import type { IConflictResolutionService } from '../conflicts/interfaces/IConflictResolutionService';
import { sanitizeGitError, worktreeConflictMessage } from '../git-core/gitError';
import {
  looksLikeConflictText,
  isLocalChangesWouldBeOverwritten,
  parseUntrackedOverwriteFiles,
} from '../git-core/gitProse';
import type { ITreeItemRunArgs } from '../commands/registration/commandSpine';
import { routeRebaseOutcome, type IRebaseOutcomeContext } from './refOperationOutcome';

/**
 * Deps the checkout actions reach back into the dispatcher for. Rebase-conflict
 * surfacing comes from {@link IRebaseOutcomeContext}: it stays on the
 * dispatcher, which owns the resolve dialog seam and shares it with the
 * rebase-onto handler.
 */
export interface IBranchCheckoutContext extends IRebaseOutcomeContext {
  readonly gitService: IGitService;
  readonly branchTreeProvider: BranchTreeProvider;
  /**
   * Call-time read of the setter-wired conflict service — the stash-restore
   * arm consults it AFTER awaiting the pop, so a handler-entry snapshot could
   * miss a service wired in between.
   */
  conflictResolutionService(): IConflictResolutionService | undefined;
}

/**
 * Handle the outer dirty-working-tree checkout error pattern.
 *
 * Four cases:
 * - Worktree conflict (git refuses atomically) → shows a targeted error,
 *   returns `null` (caller must not show a second error).
 * - UNTRACKED files would be overwritten → fatal error naming the files,
 *   returns `null`. No Stash & Switch: the stash has no
 *   `--include-untracked`, so a stash-and-retry fails on the same files
 *   (git4idea treats this arm as fatal, GitCheckoutOperation.java:187-190).
 * - TRACKED dirty tree (`would be overwritten` / `Please commit`) → shows
 *   the Stash & Switch / Force Checkout / Cancel dialog, returns the
 *   user's choice or `null` on Cancel.
 * - Any other error → shows `fallbackError` and returns `null`.
 *
 * Callers act on the returned choice and provide their own
 * branch-specific stash/force logic.
 */
async function handleDirtyTreeError(
  errorMessage: string,
  dirtyHeader: string,
  fallbackError: string
): Promise<'Stash & Switch' | 'Force Checkout' | null> {
  const worktreeMessage = worktreeConflictMessage(errorMessage);
  if (worktreeMessage) {
    void vscode.window.showErrorMessage(worktreeMessage);
    return null;
  }
  const untracked = parseUntrackedOverwriteFiles(errorMessage);
  if (untracked) {
    void vscode.window.showErrorMessage(
      `Untracked working tree files would be overwritten: ${untracked.join(', ')}. ` +
        `Move or remove them, then retry.`
    );
    return null;
  }
  if (isLocalChangesWouldBeOverwritten(errorMessage)) {
    const choice = await vscode.window.showWarningMessage(
      dirtyHeader,
      'Stash & Switch',
      'Force Checkout',
      'Cancel'
    );
    if (choice === 'Stash & Switch' || choice === 'Force Checkout') {
      return choice as 'Stash & Switch' | 'Force Checkout';
    }
    return null;
  }
  void vscode.window.showErrorMessage(fallbackError);
  return null;
}

/**
 * Restore ("pop") the auto-stash created by a Stash & Switch / Stash and
 * reset flow after the checkout landed — git4idea's Smart Checkout is
 * stash → checkout → UNSTASH; stopping after the checkout silently parks
 * the user's changes in the stash.
 *
 * A pop that conflicts with the switched-to branch routes into the
 * Resolve Conflicts flow as an `unstash` (same handoff StashView uses, so
 * ours/theirs reversal is correct); any other failure keeps the changes
 * safely in the stash and says so.
 *
 * @returns `'restored'` on a clean pop, `'conflict-routed'` when the
 *   Resolve Conflicts dialog took over, `'failed'` when the changes stay
 *   parked in the stash (already surfaced to the user).
 */
async function restoreStashAfterSwitch(
  ctx: IBranchCheckoutContext,
  repo: IRepository,
  stashSha?: string
): Promise<'restored' | 'conflict-routed' | 'failed'> {
  // Resolve the CREATED entry's current position first — `stash@{0}` is not
  // stable between the push and this pop (an autostash, a concurrent flow
  // or the user can push another entry, renumbering the stack), and popping
  // the head blindly applies the WRONG stash. `stashSha` is captured right
  // after the push; a legacy no-hash listing falls back to the head.
  let index = 0;
  if (stashSha !== undefined) {
    const entries = await ctx.gitService.stashList(repo);
    const entry = entries.find((e) => e.hash === stashSha);
    if (!entry) {
      void vscode.window.showWarningMessage(
        'Switched, but the auto-stash created for this checkout is no longer in the stash ' +
          'list — your changes were not restored.'
      );
      return 'failed';
    }
    index = entry.index;
  }
  try {
    // Explicit --index: this pops the extension's OWN auto-stash, so the
    // exact staged/unstaged split it captured must come back.
    await ctx.gitService.stashPop(repo, index, true).match(
      () => undefined,
      (e) => {
        throw e;
      }
    );
    return 'restored';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Read the setter-wired service HERE, after the pop settled — a handler-entry
    // snapshot would miss a service wired while the pop was in flight.
    const conflictService = ctx.conflictResolutionService();
    if (conflictService && looksLikeConflictText(message)) {
      const conflicts = await conflictService.getConflictedFiles(repo);
      if (conflicts.length > 0) {
        await conflictService.openResolveConflictsDialog(repo, conflicts, {
          operation: 'unstash',
          target: `stash@{${index}}`,
          canAbort: true,
          canContinue: true,
        });
        return 'conflict-routed';
      }
    }
    void vscode.window.showWarningMessage(
      `Switched, but restoring your stashed changes failed: ${sanitizeGitError(message)}. ` +
        `They remain in the stash list.`
    );
    return 'failed';
  }
}

/**
 * The sha of the most recently created stash entry, captured immediately
 * after a `stash push` so {@link restoreStashAfterSwitch} can pop exactly
 * that entry later. `undefined` when the listing carries no hash (legacy
 * stash-list form) — the restore then falls back to the head.
 */
async function captureCreatedStashSha(
  ctx: IBranchCheckoutContext,
  repo: IRepository
): Promise<string | undefined> {
  try {
    const entries = await ctx.gitService.stashList(repo);
    return entries[0]?.hash;
  } catch {
    return undefined;
  }
}

// ============================================
// Local Branch Command Handlers
// ============================================

/**
 * Handle checkout command for local branches.
 */
export async function handleCheckout(
  ctx: IBranchCheckoutContext,
  { repo, target }: ITreeItemRunArgs<'branch' | 'detached'>
): Promise<void> {
  // Accept the detached row as a checkout target (the SHA rides on the
  // target). The git command runs uniformly (no early-return on "already
  // at that commit" — IntelliJ does the same; the dirty-working-tree
  // fallback flow handles errors). The toast branches: branch name vs
  // detached re-checkout.
  const branch = target.kind === 'branch' ? target.branch : undefined;
  const ref = branch?.name ?? (target.kind === 'detached' ? target.sha : undefined);
  if (!ref) {
    return;
  }
  const successToast = (): string =>
    branch
      ? `Switched to branch '${branch.name}'`
      : `Re-checked out detached HEAD at ${ref.substring(0, 7)}`;
  const dirtyHeader = (): string =>
    branch
      ? `Cannot switch to '${branch.name}': local changes would be overwritten.`
      : `Cannot re-checkout detached HEAD at ${ref.substring(0, 7)}: local changes would be overwritten.`;
  const stashLabel = (): string =>
    branch
      ? `Auto-stash before checkout ${branch.name}`
      : `Auto-stash before checkout ${ref.substring(0, 7)}`;
  const stashSuccessToast = (restored: boolean): string => {
    const target = branch
      ? `switched to '${branch.name}'`
      : `re-checked out detached HEAD at ${ref.substring(0, 7)}`;
    return restored
      ? `Stashed changes, ${target}, and restored them`
      : `Stashed changes and ${target}`;
  };
  const forceSuccessToast = (): string =>
    branch
      ? `Force switched to '${branch.name}'`
      : `Force re-checked out detached HEAD at ${ref.substring(0, 7)}`;

  try {
    await ctx.gitService.checkout(repo, ref).match(
      () => undefined,
      (e) => {
        throw e;
      }
    );
    // Checkout moved HEAD; reload before refresh so the
    // BranchTreeProvider's "current branch" mark reflects fresh state.
    await ctx.gitService.reloadRepository(repo);
    void vscode.window.showInformationMessage(successToast());
    ctx.branchTreeProvider.refresh();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const choice = await handleDirtyTreeError(
      errorMessage,
      dirtyHeader(),
      `Failed to checkout branch: ${sanitizeGitError(errorMessage)}`
    );
    if (choice === 'Stash & Switch') {
      try {
        await ctx.gitService.stash(repo, stashLabel()).match(
          () => undefined,
          (e) => {
            throw e;
          }
        );
        const createdStashSha = await captureCreatedStashSha(ctx, repo);
        await ctx.gitService.checkout(repo, ref).match(
          () => undefined,
          (e) => {
            throw e;
          }
        );
        // Smart-checkout parity: restore the stash onto the new branch.
        const restore = await restoreStashAfterSwitch(ctx, repo, createdStashSha);
        // Stash + checkout (+ pop) moved HEAD; reload before refresh.
        await ctx.gitService.reloadRepository(repo);
        if (restore !== 'conflict-routed') {
          void vscode.window.showInformationMessage(stashSuccessToast(restore === 'restored'));
        }
        ctx.branchTreeProvider.refresh();
      } catch (stashError) {
        const stashMsg = stashError instanceof Error ? stashError.message : 'Unknown error';
        void vscode.window.showErrorMessage(
          `Failed to stash and checkout: ${sanitizeGitError(stashMsg)}`
        );
      }
    } else if (choice === 'Force Checkout') {
      try {
        await ctx.gitService.checkout(repo, ref, { force: true }).match(
          () => undefined,
          (e) => {
            throw e;
          }
        );
        // Force checkout moved HEAD; reload before refresh.
        await ctx.gitService.reloadRepository(repo);
        void vscode.window.showInformationMessage(forceSuccessToast());
        ctx.branchTreeProvider.refresh();
      } catch (forceError) {
        const forceMsg = forceError instanceof Error ? forceError.message : 'Unknown error';
        void vscode.window.showErrorMessage(
          `Failed to force checkout: ${sanitizeGitError(forceMsg)}`
        );
      }
    }
  }
}

/**
 * Data-loss guard shared by the remote-arm `-B` checkouts: `-B` rewrites the
 * local's commit pointer, so every commit the remote tip cannot reach becomes
 * unreachable. Ask git which branches contain the local tip: when the checkout
 * target is among them the local is an ancestor of it and the reset is a
 * fast-forward, so the reset is safe and silent. Anything else — ahead,
 * diverged, or a probe that failed (the facade degrades to `[]`) — prompts
 * first, so an unmeasured answer errs toward asking rather than discarding.
 *
 * The check measures against the CHECKOUT TARGET, not the local's own
 * upstream: those differ for a cross-tracked local, and an untracked
 * local has no upstream to measure against at all.
 */
async function confirmStaleLocalReset(
  ctx: IBranchCheckoutContext,
  repo: IRepository,
  branchName: string,
  track: string
): Promise<{ cancelled: true } | { cancelled: false; stashed: boolean; stashSha?: string }> {
  const branches = await ctx.gitService.getBranches(repo);
  const local = branches.find((b) => b.type === 'local' && b.name === branchName);
  const fastForward =
    local !== undefined &&
    (await ctx.gitService.getContainingBranches(repo, local.commit)).includes(track);
  if (!local || fastForward) {
    return { cancelled: false, stashed: false };
  }
  const choice = await vscode.window.showWarningMessage(
    `Local branch '${branchName}' has commits that are not on remote '${track}'. ` +
      `Resetting to the remote tip will make them unreachable.`,
    { modal: true },
    'Reset anyway',
    'Stash and reset'
  );
  if (choice === 'Stash and reset') {
    await ctx.gitService.stash(repo, `Auto-stash before checkout ${branchName}`).match(
      () => undefined,
      (e) => {
        throw e;
      }
    );
    return { cancelled: false, stashed: true, stashSha: await captureCreatedStashSha(ctx, repo) };
  }
  if (choice === 'Reset anyway') {
    return { cancelled: false, stashed: false };
  }
  // Cancel (or dialog dismissed): do not touch the local branch.
  return { cancelled: true };
}

/**
 * Handle checkout and rebase command.
 * Checks out the right-clicked branch and rebases it onto the previously
 * current branch — IntelliJ's "Checkout and Rebase onto '{current}'" flow.
 *
 * Remote-branch handling: a plain `git checkout origin/main` on a
 * remote-tracking ref detaches HEAD at that ref's commit (remote-tracking
 * refs aren't local branches). IntelliJ's behaviour is to create or
 * fast-forward a LOCAL branch of the same leaf name, tracking the remote,
 * and check THAT out so HEAD stays attached. The fix below uses
 * `checkout -B <local> --track <remote>` when the right-clicked item is
 * a remote branch, mirroring `handleCheckoutAsLocal`'s pattern — including
 * its stale-local reset guard, which prompts before `-B` would drop
 * local-only commits.
 */
export async function handleCheckoutAndRebase(
  ctx: IBranchCheckoutContext,
  { repo, target }: ITreeItemRunArgs<'branch'>
): Promise<void> {
  // Store the revision to rebase onto BEFORE checkout. When HEAD is attached
  // that's the branch name; when DETACHED there's no branch name, so capture
  // the prior COMMIT sha — rebasing onto the literal 'HEAD' would target the
  // just-moved HEAD (a no-op / nonsensical target).
  const previousCurrentBranch = repo.head?.name?.replace('refs/heads/', '') || repo.head?.commit;
  if (!previousCurrentBranch) {
    void vscode.window.showErrorMessage('Cannot determine the previous revision to rebase onto.');
    return;
  }

  // Resolve the actual checkout target:
  //   - Local branch  → check out by name (`git checkout main`).
  //   - Remote branch → create-or-fast-forward a local tracking branch
  //     of the same leaf name (`git checkout -B main --track origin/main`).
  //     This keeps HEAD attached. IntelliJ parity.
  const isRemote = target.branch.type === 'remote';
  const remoteFullName = target.branch.name; // e.g. 'origin/main'
  const localLeafName = isRemote
    ? remoteFullName.split('/').slice(1).join('/') // 'origin/main' → 'main'
    : target.branch.name;
  // Refuse when the checkout target IS the current branch. The remote arm's
  // `-B` would move the very branch captured above as the rebase base, so the
  // rebase would target the branch's own new tip — a guaranteed no-op behind
  // a success toast, and a silent reset of any local-only commits. git4idea
  // refuses this outright (GitCheckoutAndRebaseRemoteBranchWorkflow.kt:
  // "Cannot overwrite current branch"); the local arm (clicking the branch
  // that is already current) degenerates the same way, matching IntelliJ
  // hiding the action on the current branch.
  if (localLeafName === previousCurrentBranch) {
    const hint = isRemote
      ? ` To update it from '${remoteFullName}', use 'Pull into Current Using Rebase'.`
      : '';
    void vscode.window.showErrorMessage(
      `Checkout and Rebase failed: cannot overwrite the current branch '${previousCurrentBranch}'.${hint}`
    );
    return;
  }
  // The branch label rendered in toasts always uses the LOCAL leaf name —
  // reads as "Checked out main" rather than "Checked out origin/main".
  const displayName = localLeafName;
  const checkout = (force?: boolean): Promise<void> =>
    (isRemote
      ? ctx.gitService.checkout(repo, localLeafName, {
          forceCreate: true,
          track: remoteFullName,
          ...(force ? { force: true } : {}),
        })
      : ctx.gitService.checkout(repo, localLeafName, force ? { force: true } : undefined)
    ).match(
      () => undefined,
      (e) => {
        throw e;
      }
    );

  try {
    // Same stale-local guard as checkout-as-local: without it, the remote
    // arm's `-B` create-or-reset drops local-only commits silently.
    let stashedBeforeReset = false;
    let stashShaBeforeReset: string | undefined;
    if (isRemote) {
      const decision = await confirmStaleLocalReset(ctx, repo, localLeafName, remoteFullName);
      if (decision.cancelled) {
        return;
      }
      stashedBeforeReset = decision.stashed;
      stashShaBeforeReset = decision.stashSha;
    }

    // Checkout the right-clicked branch (attached HEAD).
    await checkout();

    if (stashedBeforeReset) {
      // Smart-checkout parity: restore the pre-reset stash before the rebase
      // (the rebase runs with --autostash, so restored dirtiness is handled).
      // A conflicted restore hands off to the Resolve Conflicts flow and must
      // NOT start a rebase over an unmerged tree.
      const restore = await restoreStashAfterSwitch(ctx, repo, stashShaBeforeReset);
      if (restore === 'conflict-routed') {
        await ctx.gitService.reloadRepository(repo);
        ctx.branchTreeProvider.refresh();
        return;
      }
    }

    // Rebase onto the previously current branch
    const result = await ctx.gitService.rebaseBranch(repo, previousCurrentBranch);

    await routeRebaseOutcome(ctx, repo, result, {
      onto: previousCurrentBranch,
      successMessage: `Checked out '${displayName}' and rebased onto '${previousCurrentBranch}'`,
    });
    // Checkout + rebase moved HEAD; reload before refresh.
    await ctx.gitService.reloadRepository(repo);
    ctx.branchTreeProvider.refresh();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const choice = await handleDirtyTreeError(
      errorMessage,
      `Cannot switch to '${displayName}': local changes would be overwritten.`,
      `Failed to checkout and rebase: ${sanitizeGitError(errorMessage)}`
    );
    if (choice === 'Stash & Switch') {
      try {
        await ctx.gitService.stash(repo, `Auto-stash before checkout ${displayName}`).match(
          () => undefined,
          (e) => {
            throw e;
          }
        );
        const createdStashSha = await captureCreatedStashSha(ctx, repo);
        await checkout();
        // Smart-checkout parity: restore the stash before the rebase (the
        // rebase itself runs with --autostash, so restored dirtiness is
        // handled). A conflicted restore hands off to the Resolve
        // Conflicts flow and must NOT start a rebase over an unmerged tree.
        const restoreOutcome = await restoreStashAfterSwitch(ctx, repo, createdStashSha);
        if (restoreOutcome === 'conflict-routed') {
          await ctx.gitService.reloadRepository(repo);
          ctx.branchTreeProvider.refresh();
          return;
        }
        const result = await ctx.gitService.rebaseBranch(repo, previousCurrentBranch);
        await routeRebaseOutcome(ctx, repo, result, {
          onto: previousCurrentBranch,
          successMessage:
            `Stashed changes, checked out '${displayName}' and rebased onto ` +
            `'${previousCurrentBranch}'`,
        });
        // Stash + checkout + rebase moved HEAD; reload before refresh.
        await ctx.gitService.reloadRepository(repo);
        ctx.branchTreeProvider.refresh();
      } catch (stashError) {
        const stashMsg = stashError instanceof Error ? stashError.message : 'Unknown error';
        void vscode.window.showErrorMessage(
          `Failed to stash and checkout: ${sanitizeGitError(stashMsg)}`
        );
      }
    } else if (choice === 'Force Checkout') {
      try {
        await checkout(true);
        const result = await ctx.gitService.rebaseBranch(repo, previousCurrentBranch);
        await routeRebaseOutcome(ctx, repo, result, {
          onto: previousCurrentBranch,
          successMessage: `Force checked out '${displayName}' and rebased onto '${previousCurrentBranch}'`,
        });
        // Force checkout + rebase moved HEAD; reload before refresh.
        await ctx.gitService.reloadRepository(repo);
        ctx.branchTreeProvider.refresh();
      } catch (forceError) {
        const forceMsg = forceError instanceof Error ? forceError.message : 'Unknown error';
        void vscode.window.showErrorMessage(
          `Failed to force checkout and rebase: ${sanitizeGitError(forceMsg)}`
        );
      }
    }
  }
}

/**
 * Handle checkout as local branch command.
 *
 * A remote branch "Checkout" must land the user on the remote tip
 * even when a stale local of the same name exists. We use IntelliJ's
 * idiom `git checkout -B <branch> <remote>/<branch>` (forceCreate) which
 * creates-or-resets the local to the remote tip in one step — the old
 * `localExists ? plain-checkout : create-tracking` branching left a stale
 * local untouched. Because `-B` rewrites the local's commit pointer, we
 * first probe the local branch's `ahead` count and, when it has commits
 * not on the remote (which would become unreachable), show a modal
 * confirmation before resetting.
 */
export async function handleCheckoutAsLocal(
  ctx: IBranchCheckoutContext,
  { repo, target }: ITreeItemRunArgs<'branch'>
): Promise<void> {
  // Parse remote name from branch name (e.g., "origin/main" -> "origin", "main")
  const parts = target.branch.name.split('/');
  const remoteName = parts[0];
  const branchName = parts.slice(1).join('/');
  const track = `${remoteName}/${branchName}`;

  try {
    // Data-loss guard shared with checkout-and-rebase's remote arm (see
    // confirmStaleLocalReset for the probe's contract).
    const decision = await confirmStaleLocalReset(ctx, repo, branchName, track);
    if (decision.cancelled) {
      return;
    }
    const stashedBeforeReset = decision.stashed;
    const stashShaBeforeReset = decision.stashSha;

    // Create-or-reset the local to the remote tip in one step.
    await ctx.gitService.checkout(repo, branchName, { forceCreate: true, track }).match(
      () => undefined,
      (e) => {
        throw e;
      }
    );

    // Smart-checkout parity: a "Stash and reset" restores the stash too.
    const resetRestore = stashedBeforeReset
      ? await restoreStashAfterSwitch(ctx, repo, stashShaBeforeReset)
      : 'restored';

    // checkout-as-local moved HEAD; reload before refresh.
    await ctx.gitService.reloadRepository(repo);
    if (resetRestore !== 'conflict-routed') {
      void vscode.window.showInformationMessage(`Switched to branch '${branchName}'`);
    }
    ctx.branchTreeProvider.refresh();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const choice = await handleDirtyTreeError(
      errorMessage,
      `Cannot switch to '${branchName}': local changes would be overwritten.`,
      `Failed to checkout branch: ${sanitizeGitError(errorMessage)}`
    );
    if (choice === 'Stash & Switch') {
      try {
        await ctx.gitService.stash(repo, `Auto-stash before checkout ${branchName}`).match(
          () => undefined,
          (e) => {
            throw e;
          }
        );
        const createdStashSha = await captureCreatedStashSha(ctx, repo);
        // `-B` create-or-resets regardless of whether a local exists.
        await ctx.gitService.checkout(repo, branchName, { forceCreate: true, track }).match(
          () => undefined,
          (e) => {
            throw e;
          }
        );
        // Smart-checkout parity: restore the stash onto the new branch.
        const restore = await restoreStashAfterSwitch(ctx, repo, createdStashSha);
        // Stash + checkout (+ pop) moved HEAD; reload before refresh.
        await ctx.gitService.reloadRepository(repo);
        if (restore !== 'conflict-routed') {
          void vscode.window.showInformationMessage(
            restore === 'restored'
              ? `Stashed changes, switched to '${branchName}', and restored them`
              : `Stashed changes and switched to '${branchName}'`
          );
        }
        ctx.branchTreeProvider.refresh();
      } catch (stashError) {
        const stashMsg = stashError instanceof Error ? stashError.message : 'Unknown error';
        void vscode.window.showErrorMessage(
          `Failed to stash and checkout: ${sanitizeGitError(stashMsg)}`
        );
      }
    } else if (choice === 'Force Checkout') {
      try {
        // `-B` create-or-resets regardless of whether a local exists.
        await ctx.gitService
          .checkout(repo, branchName, {
            forceCreate: true,
            force: true,
            track,
          })
          .match(
            () => undefined,
            (e) => {
              throw e;
            }
          );
        // Force checkout moved HEAD; reload before refresh.
        await ctx.gitService.reloadRepository(repo);
        void vscode.window.showInformationMessage(`Force switched to '${branchName}'`);
        ctx.branchTreeProvider.refresh();
      } catch (forceError) {
        const forceMsg = forceError instanceof Error ? forceError.message : 'Unknown error';
        void vscode.window.showErrorMessage(
          `Failed to force checkout: ${sanitizeGitError(forceMsg)}`
        );
      }
    }
  }
}
