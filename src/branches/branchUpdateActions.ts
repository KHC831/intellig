/**
 * Update / pull actions for the branch context menu: Update (integrate the
 * current branch, or fast-forward a non-current one), Update Selected
 * (align-local fast-forward), and the pull-using-merge / pull-using-rebase
 * entries. Includes the align-local planner shared with those flows. Reaches
 * back into the dispatcher through {@link IBranchUpdateContext}.
 */

import * as vscode from 'vscode';
import type {
  IBranch,
  IGitService,
  IRepository,
  IUpstream,
} from '../git-core/interfaces/IGitService';
import type { BranchTreeProvider } from './BranchTreeProvider';
import { getIncomingOutgoingFetcher } from './BranchPopup';
import { sanitizeGitError } from '../git-core/gitError';
import { buildUpdatePullOptions, resolveUpdateRebase } from '../sync/updateProject';
import { readConfig } from '../config/configKeys';
import { getLogger } from '../utils/logger';
import type { ITreeItemRunArgs } from '../commands/registration/commandSpine';

/**
 * One selected local branch fed to {@link planAlignLocal}, carrying just the
 * facts the FF-vs-skip decision needs: whether it is checked out, its tracking
 * upstream, and its incoming/outgoing counts relative to that upstream.
 */
export interface IAlignLocalBranchInput {
  /** Local branch short name (e.g. `main`, `feature/x`). */
  name: string;
  /** True when this is the repository's checked-out branch. */
  isCurrent: boolean;
  /** Tracking upstream, or undefined when the branch tracks nothing. */
  upstream?: IUpstream;
  /** Commits the upstream has that the local branch lacks (git "behind"). */
  incoming: number;
  /** Local commits the upstream lacks (git "ahead"). */
  outgoing: number;
}

/** A fast-forward fetch the align-local action will run for one branch. */
export interface IAlignLocalFetch {
  /** Local branch being advanced. */
  branch: string;
  /** Remote to fetch from (the upstream's remote). */
  remote: string;
  /** `<remoteRef>:<localRef>` refspec — fetch FFs the local ref or refuses. */
  refspec: string;
}

/** Outcome of classifying a selection of local branches for align-local. */
export interface IAlignLocalPlan {
  /** Branches that are behind-only and will be fast-forwarded. */
  fetches: IAlignLocalFetch[];
  /** Branches we won't touch, with a user-facing reason. */
  skipped: { branch: string; reason: string }[];
  /** Branches already in sync with their upstream — nothing to do. */
  upToDate: string[];
}

/**
 * Classify selected local branches into fast-forward / skip / up-to-date
 * buckets for the align-local "Update Selected" action.
 *
 * Mirrors git4idea's GitBranchActionsUtil.updateBranches: every NON-current
 * tracking branch is fast-forwarded via a `<remoteRef>:<localRef>` fetch
 * refspec (`GitFetchSpec(repo, remote, "$remoteBranch:$localBranch")`), and
 * the action only ever fast-forwards — a diverged branch is left alone. We
 * decide FF-ability from the incoming/outgoing counts (behind-only ⇒ FF-able;
 * any outgoing ⇒ diverged) so we never even attempt a non-FF fetch, rather
 * than relying on git to refuse it.
 *
 * Skip reasons:
 * - no upstream configured.
 * - checked-out current branch — FF into a checked-out ref is refused. This
 *   is planner-level defense only: the Update / Update Selected handlers
 *   route the current branch to a full integration
 *   (`updateCurrentBranch`, GitUpdateExecutionProcess parity) before ever
 *   consulting this planner.
 * - diverged (has outgoing commits) — not a fast-forward.
 *
 * The refspec joins user-controlled ref names; callers MUST splice it through
 * `buildGitArgs` (the fetch op does) so it can never be parsed as a git flag.
 */
export function planAlignLocal(inputs: IAlignLocalBranchInput[]): IAlignLocalPlan {
  const plan: IAlignLocalPlan = { fetches: [], skipped: [], upToDate: [] };

  for (const input of inputs) {
    if (!input.upstream) {
      plan.skipped.push({ branch: input.name, reason: 'no upstream configured' });
      continue;
    }
    if (input.isCurrent) {
      plan.skipped.push({
        branch: input.name,
        reason: 'checked out — use Update/Pull to advance the current branch',
      });
      continue;
    }
    if (input.outgoing > 0) {
      plan.skipped.push({
        branch: input.name,
        reason: 'diverged from upstream — not fast-forwardable',
      });
      continue;
    }
    if (input.incoming === 0) {
      plan.upToDate.push(input.name);
      continue;
    }
    plan.fetches.push({
      branch: input.name,
      remote: input.upstream.remote,
      refspec: `${input.upstream.name}:${input.name}`,
    });
  }

  return plan;
}

/** Deps the update / pull actions reach back into the dispatcher for. */
export interface IBranchUpdateContext {
  readonly gitService: IGitService;
  readonly branchTreeProvider: BranchTreeProvider;
  // Pull-conflict routing (sole live reader of the setter-wired conflict
  // service + the dialog seam) stays on the dispatcher; moved handlers reach
  // it here.
  routePullConflicts(
    repo: IRepository,
    operation: 'merge' | 'rebase',
    target: string
  ): Promise<boolean>;
}

/**
 * Handle update command for local branches — git4idea updateBranches parity
 * (GitBranchActionsUtil.updateBranches).
 *
 * A NON-current branch gets the align-local fast-forward via a
 * `<remoteRef>:<localRef>` fetch refspec (shared with Update Selected). The
 * CURRENT branch cannot be fetched into, so it is INTEGRATED — the
 * reference routes it through GitUpdateExecutionProcess (fetch + merge or
 * rebase per the update settings); ours mirrors Update Project's per-repo
 * step in {@link updateCurrentBranch}.
 */
export async function handleUpdate(
  ctx: IBranchUpdateContext,
  { repo, target }: ITreeItemRunArgs<'branch'>
): Promise<void> {
  const upstream = target.branch.upstream;
  if (!upstream) {
    void vscode.window.showInformationMessage(
      `Branch '${target.branch.name}' has no upstream configured.`
    );
    return;
  }

  if (!target.branch.isHead) {
    await alignLocalBranch(ctx, repo, target.branch);
    return;
  }

  await updateCurrentBranch(ctx, repo, target.branch);
}

/**
 * Integrate the CURRENT branch with its upstream. git4idea routes Update on
 * the checked-out branch through `GitUpdateExecutionProcess.update` (fetch +
 * merge/rebase per the update method, with a local-changes saver;
 * GitBranchActionsUtil.kt:51-63) — a fetch-plus-toast is not an update.
 *
 * Mirrors Update Project's single-repo step: fetch the upstream remote with
 * prune, probe the incoming count (0 ⇒ up-to-date toast, probe failure ⇒
 * pull anyway — never claim up-to-date on data we did not read), then pull
 * with the branch-default strategy (`resolveUpdateRebase` over
 * `intellig.pullRebase`) + autostash via {@link buildUpdatePullOptions}. A
 * pull that stops on conflicts routes into the Resolve Conflicts dialog
 * with the operation matching the strategy, so ours/theirs naming follows
 * the same reversal inference the pull handlers use.
 */
async function updateCurrentBranch(
  ctx: IBranchUpdateContext,
  repo: IRepository,
  branch: IBranch
): Promise<void> {
  const upstream = branch.upstream;
  if (!upstream) {
    void vscode.window.showInformationMessage(
      `Branch '${branch.name}' has no upstream configured.`
    );
    return;
  }
  const rebase = resolveUpdateRebase('branch-default', readConfig('pullRebase'));
  const strategy = rebase ? 'rebase' : 'merge';
  try {
    await ctx.gitService.fetch(repo, { remote: upstream.remote, prune: true }).match(
      () => undefined,
      (e) => {
        throw e;
      }
    );
    let incoming: number | undefined;
    const fetcher = getIncomingOutgoingFetcher(ctx.gitService);
    if (fetcher) {
      try {
        incoming = (await fetcher(repo, branch.name)).incoming;
      } catch {
        incoming = undefined;
      }
    }
    if (incoming === 0) {
      // Fetch updated remote-tracking refs; reload so ahead/behind counts
      // on the branch tree match the post-fetch state.
      await ctx.gitService.reloadRepository(repo);
      void vscode.window.showInformationMessage(
        `Fetched '${upstream.remote}'. '${branch.name}' is up to date.`
      );
      ctx.branchTreeProvider.refresh();
      return;
    }
    await ctx.gitService.pull(repo, buildUpdatePullOptions(rebase)).match(
      () => undefined,
      (e) => {
        throw e;
      }
    );
    // Pull moved HEAD; reload before refresh.
    await ctx.gitService.reloadRepository(repo);
    void vscode.window.showInformationMessage(
      incoming === undefined
        ? `Updated '${branch.name}' from '${upstream.remote}' using ${strategy}`
        : `Updated '${branch.name}': integrated ${incoming} commit(s) from ` +
            `'${upstream.remote}' using ${strategy}`
    );
    ctx.branchTreeProvider.refresh();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    if (await ctx.routePullConflicts(repo, strategy, branch.name)) {
      return;
    }
    void vscode.window.showErrorMessage(
      `Failed to update branch: ${sanitizeGitError(errorMessage)}`
    );
  }
}

/**
 * Align-local "Update Selected": fast-forward the clicked local branch to its
 * tracked remote WITHOUT checking it out, skipping it when it has diverged.
 *
 * git4idea parity: GitBranchActionsUtil.updateBranches advances every
 * non-current tracking branch via a `<remoteRef>:<localRef>` fetch refspec
 * (`GitFetchSpec(repo, remote, "$remoteBranch:$localBranch")`) and only ever
 * fast-forwards — diverged branches are left untouched. The current branch
 * is routed to a full integration instead (GitUpdateExecutionProcess in the
 * reference, {@link updateCurrentBranch} here), since fetching into a
 * checked-out ref is refused. Surfaced from
 * BranchesDashboardActions.UpdateSelectedBranchAction.
 */
export async function handleUpdateSelected(
  ctx: IBranchUpdateContext,
  { repo, target }: ITreeItemRunArgs<'branch'>
): Promise<void> {
  if (target.branch.isHead && target.branch.upstream) {
    await updateCurrentBranch(ctx, repo, target.branch);
    return;
  }
  await alignLocalBranch(ctx, repo, target.branch);
}

/**
 * Fast-forward one local branch to its tracked remote via the align-local
 * refspec fetch, shared by Update (non-current branches) and Update
 * Selected. When the divergence probe is unavailable or fails, the FF fetch
 * is attempted anyway — git itself refuses a non-fast-forward into a
 * non-checked-out ref — instead of claiming "up to date" on data we never
 * read.
 */
async function alignLocalBranch(
  ctx: IBranchUpdateContext,
  repo: IRepository,
  branch: IBranch
): Promise<void> {
  // Incoming/outgoing lives on the concrete GitService, not the frozen
  // IGitService (ADR-001), so reach it through the same duck-typed fetcher
  // the branch popup/tree use rather than widening the interface.
  const fetcher = getIncomingOutgoingFetcher(ctx.gitService);
  let counts: { incoming: number; outgoing: number } | undefined;
  if (fetcher) {
    try {
      const io = await fetcher(repo, branch.name);
      counts = { incoming: io.incoming, outgoing: io.outgoing };
    } catch {
      counts = undefined;
    }
  }

  let fetches: IAlignLocalFetch[];
  const skipped: { branch: string; reason: string }[] = [];
  let upToDate: string[] = [];
  if (counts === undefined) {
    // Divergence unknown. Classify via the planner with a synthetic
    // behind-only count so the checked-out / no-upstream skip reasons stay
    // canonical, then let git enforce FF-only on the attempted fetch.
    const plan = planAlignLocal([
      {
        name: branch.name,
        isCurrent: branch.isHead,
        upstream: branch.upstream,
        incoming: 1,
        outgoing: 0,
      },
    ]);
    fetches = plan.fetches;
    skipped.push(...plan.skipped);
  } else {
    const plan = planAlignLocal([
      {
        name: branch.name,
        isCurrent: branch.isHead,
        upstream: branch.upstream,
        incoming: counts.incoming,
        outgoing: counts.outgoing,
      },
    ]);
    fetches = plan.fetches;
    skipped.push(...plan.skipped);
    upToDate = plan.upToDate;
  }

  const advanced: string[] = [];
  for (const fetch of fetches) {
    try {
      await ctx.gitService.fetch(repo, { remote: fetch.remote, refspec: fetch.refspec }).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      advanced.push(fetch.branch);
    } catch (error) {
      // git refuses a non-FF update into a non-checked-out ref; treat a late
      // divergence (the tracking ref moved since we read the counts) as a
      // skip rather than a hard error, mirroring git4idea's FF-only semantics.
      const message = error instanceof Error ? error.message : 'Unknown error';
      skipped.push({
        branch: fetch.branch,
        reason: `fast-forward failed — ${sanitizeGitError(message)}`,
      });
    }
  }

  if (advanced.length > 0) {
    await ctx.gitService.reloadRepository(repo);
    ctx.branchTreeProvider.refresh();
  }

  reportAlignLocalResult(advanced, skipped, upToDate);
}

/**
 * Surface the align-local outcome as a single info/warning toast. A clean
 * fast-forward is an info; any skip (diverged, no upstream, checked out)
 * downgrades to a warning so the user notices the branch was left behind.
 */
function reportAlignLocalResult(
  advanced: string[],
  skipped: { branch: string; reason: string }[],
  upToDate: string[]
): void {
  const parts: string[] = [];
  if (advanced.length > 0) {
    parts.push(`Fast-forwarded ${advanced.join(', ')}`);
  }
  if (upToDate.length > 0) {
    parts.push(`${upToDate.join(', ')} already up to date`);
  }
  for (const s of skipped) {
    parts.push(`Skipped ${s.branch}: ${s.reason}`);
  }

  const summary = parts.join('. ') + '.';
  if (skipped.length > 0) {
    void vscode.window.showWarningMessage(summary);
  } else {
    void vscode.window.showInformationMessage(summary);
  }
}

/**
 * Right-click "Pull into Current using Merge/Rebase" for a remote branch. The
 * menu entry already chose the strategy, so this bypasses the Pull Dialog —
 * which only exists to ask that question — and pulls directly, handing a
 * post-pull conflict off to the Resolve Conflicts dialog. The generic
 * `intellig.pull` palette command still routes through the dialog.
 */
export async function runPullFromBranchMenu(
  ctx: IBranchUpdateContext,
  { repo, target }: ITreeItemRunArgs<'branch'>,
  preset: 'rebase' | 'merge'
): Promise<void> {
  // Parse remote name and branch name from target.branch.name
  // (e.g., "origin/main" -> "origin", "main")
  const slashIndex = target.branch.name.indexOf('/');
  const remoteName =
    slashIndex >= 0 ? target.branch.name.substring(0, slashIndex) : target.branch.name;
  const branchName =
    slashIndex >= 0 ? target.branch.name.substring(slashIndex + 1) : target.branch.name;

  // Debug note (visible only at `log.level=debug`) so a received click stays
  // observable even though no dialog opens.
  getLogger()
    .child({ component: 'BranchContextMenuCommands' })
    .debug('pullUsing* bypassing PullDialog (strategy chosen via menu)', { preset });

  // Direct-pull path — the only path for both presets. The conflict-probe
  // handoff below auto-opens the Resolve Conflicts dialog when the pull
  // leaves the working tree with unresolved conflicts.
  try {
    await ctx.gitService
      .pull(repo, {
        remote: remoteName,
        branch: branchName,
        rebase: preset === 'rebase',
        prune: true,
      })
      .match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
    const strategy = preset === 'rebase' ? 'rebase' : 'merge';
    void vscode.window.showInformationMessage(
      `Pulled '${target.branch.name}' into current branch using ${strategy}`
    );
    // Pull moved HEAD; reload before refresh.
    await ctx.gitService.reloadRepository(repo);
    ctx.branchTreeProvider.refresh();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    // Conflict handoff: probe the working tree and auto-open the Resolve
    // Conflicts dialog when the pull left unresolved conflicts.
    // Pull-using-rebase maps to `'rebase'` and pull-using-merge to
    // `'merge'` — the same post-conflict states merge / rebase produce
    // directly. A probe failure never swallows the original pull error —
    // the generic toast below still fires.
    if (await ctx.routePullConflicts(repo, preset, target.branch.name)) {
      return;
    }
    const strategy = preset === 'rebase' ? 'rebase' : 'merge';
    void vscode.window.showErrorMessage(
      `Failed to pull using ${strategy}: ${sanitizeGitError(errorMessage)}`
    );
  }
}
