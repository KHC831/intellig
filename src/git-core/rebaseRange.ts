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
import { getLogger } from '../utils/logger';

/** What `git rebase -i <onto>` would do to `<onto>..HEAD`. */
export interface IRebaseRangeAnalysis {
  /** Non-merge commits in the range — the entries the todo will list. */
  todoCommits: number;
  /** Merge commits in the range — flattened away by a plain `rebase -i`. */
  mergeCommits: number;
  /**
   * Whether `onto` sits on HEAD's first-parent chain (the mainline). False
   * means the user picked a commit on a merged side branch, where the range
   * is far larger than the commit's visual distance from HEAD suggests.
   */
  firstParentBase: boolean;
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
  const range = `${onto}..HEAD`;
  try {
    const count = async (flags: string[]): Promise<number> => {
      const result = await gitCli.exec(buildGitArgs('rev-list', ['--count', ...flags], [range]), {
        cwd,
      });
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || `rev-list --count exited ${result.exitCode}`);
      }
      const n = parseInt(result.stdout.trim(), 10);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`unparseable rev-list count: ${result.stdout.trim()}`);
      }
      return n;
    };

    const total = await count([]);
    const todoCommits = await count(['--no-merges']);

    // `onto` is a first-parent ancestor exactly when walking first parents
    // from HEAD lands ON it. `rev-list --first-parent <onto>..HEAD` counts the
    // steps that walk takes before reaching something reachable from `onto`
    // (the fork point for a side-branch base, `onto` itself for a mainline
    // one), so resolve HEAD~<steps> and compare it to `onto` — equal means
    // mainline. HEAD~<steps> always exists here because the walk stopped at a
    // reachable boundary commit; a failed resolve is treated as off-mainline.
    const firstParentSteps = await count(['--first-parent']);
    const boundary = await revParseVerified(gitCli, cwd, `HEAD~${firstParentSteps}`);
    const ontoFull = await revParseVerified(gitCli, cwd, onto);
    const firstParentBase =
      boundary !== undefined && ontoFull !== undefined && boundary === ontoFull;

    return { todoCommits, mergeCommits: total - todoCommits, firstParentBase };
  } catch (error) {
    getLogger().debug('rebase range analysis failed; skipping the flattening warning', {
      onto,
      err: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
