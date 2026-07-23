/**
 * Shared git-safety guards for the commit context menu's history-rewrite and
 * revert/cherry-pick flows: published/protected-branch probes, merge detection,
 * mainline-parent selection, HEAD-containment, and the merge-flattening gate.
 * Extracted from CommitContextMenuCommands; the class delegates through a thin
 * context so behaviour is unchanged.
 */

import * as vscode from 'vscode';
import type { IGitService, IRepository } from '../git-core/interfaces/IGitService';
import type { GitCli } from '../git-core/gitCli';
import { isCommitPublished } from '../git-core/commitPublished';
import { isHexObjectId } from '../git-core/gitDirMarkers';
import { analyzeRebaseRange } from '../git-core/rebaseRange';
import { getLogger } from '../utils/logger';

/** Deps the guards reach back into the dispatcher for. */
export interface ICommitGuardsContext {
  readonly gitService: IGitService;
  readonly gitCli: GitCli;
  readProtectedBranches(): string[];
}

/**
 * Return true when the given commit is reachable from any remote-tracking
 * branch — i.e., someone has already pushed it somewhere.
 *
 * Uses `git branch --contains <hash> --remotes`. An empty output means
 * no remote branch contains the commit, so it's safe to rewrite.
 *
 * Probe failures resolve to `probeFailureMeansPushed` (default `true`):
 * rewrite guards stay conservative (assume pushed, block the rewrite),
 * while the cherry-pick `-x` suffix passes `false` — provenance is
 * annotated only for commits KNOWN to be published.
 */
export async function isCommitPushed(
  ctx: ICommitGuardsContext,
  cwd: string,
  hash: string,
  probeFailureMeansPushed = true
): Promise<boolean> {
  return isCommitPublished(ctx.gitCli, cwd, hash, probeFailureMeansPushed);
}

/**
 * Name of the first remote branch that both contains `hash` and matches an
 * `intellig.protectedBranches` entry, or `undefined` when none does.
 *
 * `git branch --remotes --contains` lists names like `origin/main`; a
 * branch matches when its remote-stripped name (`main`) or its full name
 * equals a configured entry. Fails OPEN on probe failure (logged): the
 * gate is a parity guard on top of each flow's own confirms, and a broken
 * probe must not block every rewrite.
 */
export async function findProtectedRemoteBranch(
  ctx: ICommitGuardsContext,
  cwd: string,
  hash: string
): Promise<string | undefined> {
  const protectedBranches = new Set(ctx.readProtectedBranches());
  if (protectedBranches.size === 0 || !isHexObjectId(hash, { allowPrefix: true })) {
    return undefined;
  }
  try {
    const res = await ctx.gitCli.exec(['branch', '--remotes', '--contains', hash], { cwd });
    if (res.exitCode !== 0) {
      getLogger()
        .child({ component: 'CommitContextMenuCommands' })
        .debug('protected-branch probe failed; gate degrades open', {
          exitCode: res.exitCode,
        });
      return undefined;
    }
    const names = res.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      // `origin/HEAD -> origin/main` symref lines: keep the left-hand name.
      .map((l) => l.split(/\s+/)[0]);
    for (const name of names) {
      const short = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
      if (protectedBranches.has(short) || protectedBranches.has(name)) {
        return name;
      }
    }
    return undefined;
  } catch (error) {
    getLogger()
      .child({ component: 'CommitContextMenuCommands' })
      .debug('protected-branch probe failed; gate degrades open', {
        err: error instanceof Error ? error.message : String(error),
      });
    return undefined;
  }
}

/**
 * Protected-branch gate shared by every history-rewriting flow (the
 * rewrite runner, undo commit, drop selected changes): a commit contained
 * in a remote branch matching `intellig.protectedBranches` must not be
 * rewritten — IntelliJ blocks every commit-editing action on such commits
 * (GitCommitEditingActionBase.kt checkCommitsCanBeEdited /
 * lastCheckCommitsEditingAvailability, findProtectedRemoteBranch).
 * Checking one commit — the OLDEST being rewritten — suffices: a rewritten
 * descendant on a protected branch implies its ancestors are on it too.
 *
 * Returns `true` to proceed; toasts the refusal naming the branch otherwise.
 */
export async function isNotOnProtectedBranch(
  ctx: ICommitGuardsContext,
  cwd: string,
  hash: string,
  opLabel: string
): Promise<boolean> {
  const protectedBranch = await findProtectedRemoteBranch(ctx, cwd, hash);
  if (protectedBranch === undefined) {
    return true;
  }
  void vscode.window.showErrorMessage(
    `${opLabel} refused: commit ${hash.substring(0, 8)} is already on protected branch ` +
      `'${protectedBranch}'. Rewriting protected published history is blocked ` +
      `(intellig.protectedBranches).`
  );
  return false;
}

/** Returns true if any of `hashes` refers to a merge commit (>1 parents). */
export async function anyIsMergeCommit(
  ctx: ICommitGuardsContext,
  repo: IRepository,
  hashes: string[]
): Promise<boolean> {
  const details = await Promise.all(hashes.map((h) => ctx.gitService.getCommit(repo, h)));
  return details.some((c) => c.parents.length > 1);
}

/**
 * Ask which parent line is the mainline for a merge commit's `-m <n>`
 * (1-based, the way `git revert`/`git cherry-pick` expect it). Parent 1 is
 * pre-selected — the conventional mainline, i.e. the branch the merge landed
 * on. git4idea (`GitRevertAction`) disables merge-revert outright; we go one
 * better and let the user pick the parent.
 *
 * Only a single-commit selection prompts; a multi-commit batch reuses parent
 * 1 for every commit because `-m` is a single number shared by the whole
 * invocation and per-commit prompting would be ambiguous.
 *
 * Returns `{ cancelled: true }` when the user dismisses the picker so the
 * caller aborts instead of guessing.
 */
export async function pickMainlineParent(
  ctx: ICommitGuardsContext,
  repo: IRepository,
  hashes: string[]
): Promise<{ cancelled: false; mainline: number } | { cancelled: true }> {
  if (hashes.length !== 1) {
    return { cancelled: false, mainline: 1 };
  }
  const commit = await ctx.gitService.getCommit(repo, hashes[0]);
  const parents = commit.parents;
  if (parents.length <= 1) {
    // Defensive: caller only invokes this for a detected merge.
    return { cancelled: false, mainline: 1 };
  }
  const items = await Promise.all(
    parents.map(async (parent, i) => {
      let subject = '';
      try {
        subject = (await ctx.gitService.getCommit(repo, parent)).message.split('\n')[0];
      } catch {
        subject = '';
      }
      return {
        label: `Parent ${i + 1}: ${parent.slice(0, 8)}`,
        description: subject,
        mainline: i + 1,
        picked: i === 0,
      };
    })
  );
  const choice = await vscode.window.showQuickPick(items, {
    title: 'Merge commit — choose the mainline parent',
    placeHolder: 'Parent 1 is the usual mainline (the branch the merge landed on)',
  });
  if (!choice) {
    return { cancelled: true };
  }
  return { cancelled: false, mainline: choice.mainline };
}

/**
 * Perform-time containment gate shared by every history-rewriting handler
 * that rebases `oldest^..HEAD` (squash / drop / edit message / interactive
 * rebase). Such a rebase silently rewrites — and MOVES — the checked-out
 * branch when the target commit lives on a different branch, so refuse unless
 * the oldest selected commit is reachable from HEAD (inclusive). Mirrors
 * IntelliJ GitCommitEditingActionBase.checkCommitsCanBeEdited, which blocks
 * an edit whose commit HEAD does not contain.
 *
 * `getMergeBase(oldest, HEAD) === oldest` iff `oldest` is an ancestor of
 * HEAD. When the service can't compute it (narrow test doubles that omit the
 * optional method) the check is permissive — production always provides it,
 * and the menu enable-state is the first line of defence.
 *
 * Returns `true` when contained; otherwise toasts and returns `false`.
 * Callers MUST gate BEFORE any stash / rebase so a blocked action has no
 * side effects.
 */
export async function isOldestInCurrentBranch(
  ctx: ICommitGuardsContext,
  repo: IRepository,
  oldestHash: string
): Promise<boolean> {
  if (!ctx.gitService.getMergeBase) {
    return true;
  }
  const mergeBase = await ctx.gitService.getMergeBase(repo, oldestHash, 'HEAD');
  if (mergeBase === oldestHash) {
    return true;
  }
  void vscode.window.showErrorMessage(
    'Selected commits are not in the current branch — check out that branch first.'
  );
  return false;
}

/**
 * Merge-flattening gate shared by every history-rewrite entry point: a
 * plain interactive rebase of `<onto>..HEAD` FLATTENS every merge in the
 * range (the merge commits vanish and their branch topology is lost), so
 * refuse when the range carries any — IntelliJ errors out before any git
 * mutation when no merge-free path exists between HEAD and the oldest
 * selected commit (GitCommitEditingActionBase.kt checkHeadLinearHistory).
 *
 * Returns `true` to proceed: the range carries no merges, or the analysis
 * itself failed (a probe failure must not block a rebase the user could
 * run before this gate existed; the rebase surfaces real errors itself).
 * `refusalHint` is resolved only on refusal and appended to the toast —
 * the interactive-rebase entry point adds a merged-branch pointer.
 */
export async function isRangeMergeFree(
  ctx: ICommitGuardsContext,
  repo: IRepository,
  onto: string,
  opLabel: string,
  refusalHint?: () => Promise<string>
): Promise<boolean> {
  const analysis = await analyzeRebaseRange(ctx.gitCli, repo.rootUri.fsPath, onto);
  if (!analysis || analysis.mergeCommits === 0) {
    return true;
  }
  const merges = `${analysis.mergeCommits} merge commit${analysis.mergeCommits === 1 ? '' : 's'}`;
  const hint = refusalHint ? await refusalHint() : '';
  void vscode.window.showErrorMessage(
    `${opLabel} refused: it would flatten ${merges} between the selection and HEAD ` +
      `(their branch topology would be lost). To rebase across merges, use the Rebase ` +
      `dialog with the --rebase-merges option.${hint}`
  );
  return false;
}
