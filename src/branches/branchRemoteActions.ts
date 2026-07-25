/**
 * Remote-branch actions for the branch context menu: delete a remote branch
 * (with the tracking-local cascade), track a remote branch, and the shared
 * tracked-branch delete offer used after a local delete. Reaches back into
 * the dispatcher through {@link IBranchRemoteContext}.
 */

import * as vscode from 'vscode';
import type {
  IBranch,
  IGitService,
  IRepository,
  IUpstream,
} from '../git-core/interfaces/IGitService';
import type { BranchTreeProvider } from './BranchTreeProvider';
import { sanitizeGitError } from '../git-core/gitError';
import { readConfig } from '../config/configKeys';
import { isProtectedTarget } from '../sync/PushDialog';
import { isNotFullyMergedError } from './deleteOnMerge';
import type { ITreeItemRunArgs } from '../commands/registration/commandSpine';

/** Deps the remote-branch actions reach back into the dispatcher for. */
export interface IBranchRemoteContext {
  readonly gitService: IGitService;
  readonly branchTreeProvider: BranchTreeProvider;
}

/**
 * Report a local branch deletion and, when the deleted branch's upstream is
 * now orphaned, offer to delete it on the remote too. Mirrors IntelliJ's
 * GitDeleteBranchOperation success notification, whose "Delete Tracked
 * Branch" action appears when the upstream has no other tracking branch
 * and is not protected (GitDeleteBranchOperation.java:158-165) — and our
 * own tag cascade (offerRemoteDeleteForLocalTags in branchTagActions).
 */
export async function offerDeleteTrackedBranches(
  ctx: IBranchRemoteContext,
  summary: string,
  deleted: ReadonlyArray<{ repo: IRepository; name: string; upstream?: IUpstream }>
): Promise<void> {
  const protectedBranches = readConfig('protectedBranches');
  // Eligibility per deleted branch: it tracked an upstream, that upstream
  // is not protected, and no surviving local still tracks it. The branch
  // list is read AFTER the deletion, so the deleted branch itself never
  // counts as a tracker. A branch-list read failure degrades to no offer.
  const branchesByRepo = new Map<string, IBranch[]>();
  const eligible: Array<{ repo: IRepository; upstream: IUpstream }> = [];
  for (const d of deleted) {
    if (!d.upstream || isProtectedTarget(d.upstream.name, protectedBranches)) {
      continue;
    }
    const key = d.repo.rootUri.fsPath;
    let branches = branchesByRepo.get(key);
    if (!branches) {
      try {
        branches = await ctx.gitService.getBranches(d.repo);
      } catch {
        branches = [];
      }
      branchesByRepo.set(key, branches);
    }
    const upstream = d.upstream;
    const stillTracked = branches.some(
      (b) =>
        b.type === 'local' &&
        b.upstream?.remote === upstream.remote &&
        b.upstream?.name === upstream.name
    );
    if (!stillTracked) {
      eligible.push({ repo: d.repo, upstream });
    }
  }

  if (eligible.length === 0) {
    void vscode.window.showInformationMessage(summary);
    return;
  }
  const label = eligible.length === 1 ? 'Delete Tracked Branch' : 'Delete Tracked Branches';
  const named =
    eligible.length === 1
      ? `'${eligible[0].upstream.remote}/${eligible[0].upstream.name}' is no longer tracked.`
      : `${eligible.length} upstream branches are no longer tracked.`;
  const choice = await vscode.window.showInformationMessage(`${summary}. ${named}`, label);
  if (choice !== label) {
    return;
  }
  let removed = 0;
  for (const e of eligible) {
    if (await deleteRemoteBranchRef(ctx, e.repo, e.upstream.remote, e.upstream.name)) {
      removed += 1;
    }
  }
  if (removed > 0) {
    const last = eligible[eligible.length - 1];
    void vscode.window.showInformationMessage(
      removed === 1
        ? `Deleted remote branch '${last.upstream.remote}/${last.upstream.name}'`
        : `Deleted ${removed} remote branches`
    );
    ctx.branchTreeProvider.refresh();
  }
}

/**
 * Delete one branch on `remote` (`git push <remote> :<name>`). Returns
 * whether it succeeded; a failure is toasted (credentials scrubbed) and
 * swallowed so a cascade can continue. Confirmation is the caller's job.
 */
async function deleteRemoteBranchRef(
  ctx: IBranchRemoteContext,
  repo: IRepository,
  remote: string,
  name: string
): Promise<boolean> {
  try {
    await ctx.gitService.push(repo, { remote, branch: `:${name}` }).match(
      () => undefined,
      (e) => {
        throw e;
      }
    );
    // Push :branch removed the remote ref; reload so the tree's
    // remote-branches list reflects the deletion.
    await ctx.gitService.reloadRepository(repo);
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(
      `Failed to delete remote branch '${remote}/${name}': ${sanitizeGitError(errorMessage)}`
    );
    return false;
  }
}

/**
 * Handle delete remote branch command.
 *
 * IntelliJ parity (GitDeleteRemoteBranchOperation.java:46-72): the confirm
 * also offers deleting the LOCAL branches tracking the remote one — the
 * current branch excluded. Accepting deletes the remote ref, then each
 * tracking local; a not-fully-merged local is force-deleted without a
 * second prompt, matching the reference's execute() flow (the user already
 * confirmed deleting exactly these branches).
 */
export async function handleDeleteRemote(
  ctx: IBranchRemoteContext,
  { repo, target }: ITreeItemRunArgs<'branch'>
): Promise<void> {
  // Parse remote name from branch name
  const parts = target.branch.name.split('/');
  const remoteName = parts[0];
  const branchName = parts.slice(1).join('/');

  // Tracking locals eligible for the cascade (current branch excluded —
  // "don't propose to remove current branch even if it tracks the remote
  // branch"). A branch-list read failure degrades to the plain confirm.
  let trackingLocals: string[] = [];
  try {
    const branches = await ctx.gitService.getBranches(repo);
    trackingLocals = branches
      .filter(
        (b) =>
          b.type === 'local' &&
          !b.isHead &&
          b.upstream?.remote === remoteName &&
          b.upstream?.name === branchName
      )
      .map((b) => b.name);
  } catch {
    trackingLocals = [];
  }

  const DELETE_WITH_LOCALS = 'Delete with Local Branches';
  const message =
    trackingLocals.length > 0
      ? `Are you sure you want to delete the remote branch '${target.branch.name}'? ` +
        `This cannot be undone. Tracking local branch(es): ${trackingLocals.join(', ')}.`
      : `Are you sure you want to delete the remote branch '${target.branch.name}'? This cannot be undone.`;
  const buttons = trackingLocals.length > 0 ? ['Delete', DELETE_WITH_LOCALS] : ['Delete'];
  const confirm = await vscode.window.showWarningMessage(message, { modal: true }, ...buttons);
  if (confirm !== 'Delete' && confirm !== DELETE_WITH_LOCALS) {
    return;
  }

  if (!(await deleteRemoteBranchRef(ctx, repo, remoteName, branchName))) {
    return;
  }

  const deletedLocals: string[] = [];
  if (confirm === DELETE_WITH_LOCALS) {
    for (const local of trackingLocals) {
      try {
        try {
          await ctx.gitService.deleteBranch(repo, local).match(
            () => undefined,
            (e) => {
              throw e;
            }
          );
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Unknown error';
          if (!isNotFullyMergedError(msg)) {
            throw error;
          }
          // Auto-force, reference parity: GitDeleteBranchOperation retries
          // with force when the safe delete reports not-fully-merged; the
          // confirm above already named this branch.
          await ctx.gitService.deleteBranch(repo, local, true).match(
            () => undefined,
            (e) => {
              throw e;
            }
          );
        }
        deletedLocals.push(local);
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        void vscode.window.showErrorMessage(
          `Failed to delete local branch '${local}': ${sanitizeGitError(msg)}`
        );
      }
    }
  }

  await ctx.gitService.reloadRepository(repo);
  void vscode.window.showInformationMessage(
    deletedLocals.length > 0
      ? `Deleted remote branch '${target.branch.name}' and local ${deletedLocals.join(', ')}`
      : `Deleted remote branch '${target.branch.name}'`
  );
  ctx.branchTreeProvider.refresh();
}

/**
 * IntelliJ-parity "Track Branch" — single menu
 * entry with smart detection of the user's intent based on whether a
 * matching local branch already exists.
 *
 * Behaviour matrix (matching IntelliJ's "Track Branch" semantics):
 *
 *   - **No local with the simple name**: create + checkout the local
 *     branch with the right-clicked remote ref as upstream
 *     (`git checkout --track <remote>/<branch>` shape via
 *     `gitService.checkout(createBranch: true, track: …)`).
 *
 *   - **Local exists with no upstream**: silently set its upstream
 *     to the right-clicked remote ref via
 *     `gitService.setBranchUpstream(local, upstream)`. No checkout
 *     (the user is already in the local; if they're not, they didn't
 *     ask to switch).
 *
 *   - **Local exists with a different upstream**: confirm dialog,
 *     then `gitService.setBranchUpstream(local, upstream)` if the
 *     user agrees. The cross-tracking case is the one footgun in
 *     this menu — without confirm, the user could accidentally lose
 *     their existing tracking association on `git pull`.
 *
 *   - **Local exists with the SAME upstream**: no-op + info toast
 *     ("Already tracking …"). Saves the user wondering whether the
 *     menu fired at all.
 *
 * We exposed only `Checkout (as new local)` for remote
 * branches, which always created a new local — the existing-local
 * cross-tracking case had no menu surface at all. Closes that
 * IntelliJ-parity gap.
 */
export async function handleTrackRemote(
  ctx: IBranchRemoteContext,
  { repo, target }: ITreeItemRunArgs<'branch'>
): Promise<void> {
  // Parse remote name from branch name (e.g. "origin/main" -> remote
  // "origin", branch "main"). The "simple name" extraction matches
  // the existing checkoutAsLocal path; nested branch names like
  // `origin/feature/foo` produce simple-name `feature/foo`.
  const parts = target.branch.name.split('/');
  if (parts.length < 2) {
    // Defensive — `IBranch.type === 'remote'` should guarantee a
    // remote-prefixed name, but if somehow we got a malformed input
    // surface a clear error rather than crashing on the slice below.
    void vscode.window.showErrorMessage(
      `Cannot parse remote branch '${target.branch.name}' — expected format <remote>/<branch>.`
    );
    return;
  }
  const upstreamRef = target.branch.name; // e.g. "origin/main"
  const simpleName = parts.slice(1).join('/');

  // Defense in depth: validateBranchName guards the service boundary, but
  // simpleName is sliced out of a remote ref that could be hostile
  // (`origin/-evil`, `origin/.hidden`). Rejecting it here makes the failure a
  // friendly toast instead of a service-boundary throw.
  if (simpleName.startsWith('-') || simpleName.startsWith('.')) {
    void vscode.window.showErrorMessage(
      `Cannot create local branch from remote with reserved name prefix: ${simpleName}`
    );
    return;
  }

  let existingLocal: IBranch | undefined;
  try {
    const branches = await ctx.gitService.getBranches(repo);
    existingLocal = branches.find((b) => b.type === 'local' && b.name === simpleName);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(`Failed to load branches: ${sanitizeGitError(msg)}`);
    return;
  }

  try {
    if (!existingLocal) {
      // No local with this name → create + checkout with --track.
      await ctx.gitService
        .checkout(repo, simpleName, {
          createBranch: true,
          track: upstreamRef,
        })
        .match(
          () => undefined,
          (e) => {
            throw e;
          }
        );
      await ctx.gitService.reloadRepository(repo);
      void vscode.window.showInformationMessage(
        `Created local branch '${simpleName}' tracking '${upstreamRef}'`
      );
      ctx.branchTreeProvider.refresh();
      return;
    }

    // Existing local — examine its upstream.
    const currentUpstream = existingLocal.upstream
      ? `${existingLocal.upstream.remote}/${existingLocal.upstream.name}`
      : undefined;

    if (currentUpstream === upstreamRef) {
      void vscode.window.showInformationMessage(`'${simpleName}' already tracks '${upstreamRef}'`);
      return;
    }

    if (currentUpstream && currentUpstream !== upstreamRef) {
      const confirm = await vscode.window.showWarningMessage(
        `'${simpleName}' currently tracks '${currentUpstream}'. Re-track to '${upstreamRef}'?`,
        { modal: true },
        'Re-track'
      );
      if (confirm !== 'Re-track') {
        return;
      }
    }

    await ctx.gitService.setBranchUpstream(repo, simpleName, upstreamRef).match(
      () => undefined,
      (e) => {
        throw e;
      }
    );
    await ctx.gitService.reloadRepository(repo);
    void vscode.window.showInformationMessage(`'${simpleName}' now tracks '${upstreamRef}'`);
    ctx.branchTreeProvider.refresh();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(
      `Failed to track branch: ${sanitizeGitError(errorMessage)}`
    );
  }
}
