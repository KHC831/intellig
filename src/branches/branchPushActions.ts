/**
 * Push action for the branch context menu: push a local branch (via the Push
 * Dialog when wired, else a direct push), plus the shared target-remote picker
 * (also used by the tag push/delete-remote flows). Reaches back into the
 * dispatcher through {@link IBranchPushContext}.
 */

import * as vscode from 'vscode';
import type { IGitService, IRemote, IRepository } from '../git-core/interfaces/IGitService';
import type { BranchTreeProvider } from './BranchTreeProvider';
import type { PushDialogOpener } from './BranchContextMenuCommands';
import { sanitizeGitError } from '../git-core/gitError';
import type { ITreeItemRunArgs } from '../commands/registration/commandSpine';

/** Deps the push actions reach back into the dispatcher for. */
export interface IBranchPushContext {
  readonly gitService: IGitService;
  readonly branchTreeProvider: BranchTreeProvider;
  readonly pushDialogOpener: PushDialogOpener | undefined;
}

/**
 * Pick the target remote for a push — IntelliJ GitPushTarget.getRemoteToPush
 * parity: a single remote pushes without prompting; several remotes prompt,
 * defaulting to the branch's tracked remote (or origin). Returns undefined
 * when the user cancels the picker.
 *
 * The returned name flows into `gitService.push` / `pushTag`, both of which
 * splice it through `buildGitArgs` with `--end-of-options` ahead of the
 * remote — so a hostile remote name from `.git/config` can never be parsed
 * as a git flag (argv-injection defense; check:remote-ops-eoo).
 */
export async function chooseTargetRemote(
  ctx: Pick<IBranchPushContext, 'gitService'>,
  repo: IRepository,
  preferred?: string
): Promise<string | undefined> {
  let remotes: IRemote[];
  try {
    remotes = await ctx.gitService.getRemotes(repo).match(
      (r) => r,
      (e) => {
        throw e;
      }
    );
  } catch {
    // Enumeration failed (rare) — fall back to the preferred/origin default
    // and let the push itself surface any real error.
    return preferred ?? 'origin';
  }
  if (remotes.length <= 1) {
    return remotes[0]?.name ?? preferred ?? 'origin';
  }

  const names = remotes.map((r) => r.name);
  const fallback = names.includes('origin') ? 'origin' : names[0];
  const def = preferred && names.includes(preferred) ? preferred : fallback;
  const ordered = [def, ...names.filter((n) => n !== def)];

  const picked = await vscode.window.showQuickPick(
    ordered.map((name) => ({
      label: name,
      description: name === def ? 'default' : undefined,
    })),
    {
      title: 'Push — Choose Target Remote',
      placeHolder: `Select the remote to push to (default: ${def})`,
    }
  );
  return picked?.label;
}

/**
 * Handle push command for local branches.
 * Pushes the branch to its upstream remote, or sets upstream if none configured.
 */
export async function handlePush(
  ctx: IBranchPushContext,
  { repo, target }: ITreeItemRunArgs<'branch'>
): Promise<void> {
  // Route through the Push Dialog when available so the user gets
  // the per-row target edit, force-with-lease dropdown, and protected-
  // branch guard. Falls back to a direct push (original behaviour) when
  // the opener is absent — e.g. in unit tests that don't wire the dialog.
  if (ctx.pushDialogOpener) {
    // Thread the clicked branch's OWN upstream so a non-HEAD branch that
    // already tracks a remote keeps it in the dialog instead of being forced
    // to --set-upstream against the fallback remote.
    ctx.pushDialogOpener({
      repo,
      branch: target.branch.name,
      upstream: target.branch.upstream,
      // Thread the clicked branch's OWN divergence so a non-HEAD row shows
      // its real ahead/behind and the force-with-lease flip fires.
      ahead: target.branch.ahead,
      behind: target.branch.behind,
    });
    return;
  }

  try {
    const upstream = target.branch.upstream;
    // When several remotes exist, let the user pick the target (default =
    // tracked remote / origin); a single remote skips the prompt. Cancelling
    // the picker aborts the push.
    const targetRemote = await chooseTargetRemote(ctx, repo, upstream?.remote);
    if (!targetRemote) {
      return;
    }
    // Set upstream when the branch isn't yet tracking, or when the user
    // redirected it to a remote other than its current upstream — matching
    // IntelliJ's "set new upstream" on a remote change. Pushing to the
    // already-tracked remote keeps the existing tracking untouched.
    const setUpstream = !upstream || targetRemote !== upstream.remote;
    await ctx.gitService
      .push(repo, {
        remote: targetRemote,
        branch: target.branch.name,
        ...(setUpstream ? { setUpstream: true } : {}),
      })
      .match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
    void vscode.window.showInformationMessage(
      `Pushed branch '${target.branch.name}' to '${targetRemote}'`
    );
    // Fallback push path lacked any
    // reload/refresh; add both so ahead/behind counts on the
    // branch tree match the post-push state.
    await ctx.gitService.reloadRepository(repo);
    ctx.branchTreeProvider.refresh();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(`Failed to push branch: ${sanitizeGitError(errorMessage)}`);
  }
}
