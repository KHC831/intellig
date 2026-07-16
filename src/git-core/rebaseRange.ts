/**
 * Pre-flight analysis for "Interactively Rebase from Here": what would
 * `git rebase -i <onto>` actually replay?
 *
 * A commit graph renders merged-branch commits directly beneath the merge
 * that brought them in, so a commit that LOOKS two rows below HEAD can sit
 * on a merged side branch whose ancestry excludes weeks of mainline — the
 * range `<onto>..HEAD` then spans hundreds of commits, and a plain
 * interactive rebase FLATTENS every merge in it (the merge commits vanish
 * and each replayed commit gets a new hash). The caller uses these numbers
 * to warn before opening the plan editor.
 */

import { GitCli, buildGitArgs, revParseVerified } from './gitCli';
import { REBASE_ROOT } from './interfaces/IRebaseService';
import { getLogger } from '../utils/logger';

/** What `git rebase -i <onto>` would do to `<onto>..HEAD`. */
export interface IRebaseRangeAnalysis {
  /** Non-merge commits in the range — the entries the todo will list. */
  todoCommits: number;
  /** Merge commits in the range — flattened away by a plain `rebase -i`. */
  mergeCommits: number;
}

/**
 * `git rev-list --count <flags> <rev>..HEAD`, throwing on any probe failure.
 * {@link REBASE_ROOT} counts the FULL history (`HEAD`) — a `--root` rebase
 * replays everything reachable.
 */
async function countRange(
  gitCli: GitCli,
  cwd: string,
  rev: string,
  flags: string[]
): Promise<number> {
  const result = await gitCli.exec(
    buildGitArgs(
      'rev-list',
      ['--count', ...flags],
      [rev === REBASE_ROOT ? 'HEAD' : `${rev}..HEAD`]
    ),
    { cwd }
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `rev-list --count exited ${result.exitCode}`);
  }
  const n = parseInt(result.stdout.trim(), 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`unparseable rev-list count: ${result.stdout.trim()}`);
  }
  return n;
}

/**
 * Analyze `<onto>..HEAD`. Returns `undefined` when the probes fail (missing
 * ref, unreadable repo) — the caller proceeds without a warning, matching
 * the behavior before this pre-flight existed; the rebase itself surfaces
 * any real error.
 */
export async function analyzeRebaseRange(
  gitCli: GitCli,
  cwd: string,
  onto: string
): Promise<IRebaseRangeAnalysis | undefined> {
  try {
    const total = await countRange(gitCli, cwd, onto, []);
    const todoCommits = await countRange(gitCli, cwd, onto, ['--no-merges']);
    return { todoCommits, mergeCommits: total - todoCommits };
  } catch (error) {
    getLogger().debug('rebase range analysis failed; skipping the flattening warning', {
      onto,
      err: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * Whether `rev` sits on HEAD's first-parent chain (the mainline). False
 * means it lives on a merged side branch — the shape where a commit's
 * visual distance from HEAD wildly understates `<rev>..HEAD`, because its
 * ancestry stops at the branch's fork point. Keyed to the CLICKED commit
 * by the merged-branch hint: the single-commit-branch case (parent = the
 * mainline fork point) must still read as off-mainline.
 *
 * `rev` is a first-parent ancestor exactly when walking first parents from
 * HEAD lands ON it: `rev-list --first-parent <rev>..HEAD` counts the steps
 * that walk takes before reaching something reachable from `rev` (the fork
 * point for a side-branch commit, `rev` itself for a mainline one), so
 * resolve HEAD~<steps> and compare. Degrades to `true` (no hint) when a
 * probe fails — the hint is advisory and must never block.
 */
export async function isFirstParentAncestor(
  gitCli: GitCli,
  cwd: string,
  rev: string
): Promise<boolean> {
  try {
    const steps = await countRange(gitCli, cwd, rev, ['--first-parent']);
    const boundary = await revParseVerified(gitCli, cwd, `HEAD~${steps}`);
    const revFull = await revParseVerified(gitCli, cwd, rev);
    return boundary !== undefined && revFull !== undefined && boundary === revFull;
  } catch (error) {
    getLogger().debug('first-parent membership probe failed; treating as mainline', {
      rev,
      err: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}
