import { GitCli, IGitCommandOptions } from '../git-core/gitCli';
import { IUnmergedEntry, readUnmergedStages, sideStatus } from './conflictStageModel';

/**
 * Layer 1 — the git index plumbing for conflict resolution, behind an interface
 * so the orchestrator (Layer 3) depends on a seam rather than a raw {@link GitCli}
 * downcast, and tests can substitute a fault injector.
 *
 * Reads the index stage model and takes a single side of a conflicted path:
 * check out the wanted stage, or `git rm` when that stage is absent (delete/
 * modify UD/DU, add-by-one-side AU/UA, both-deleted DD) — the delete-vs-checkout
 * decision keys off git STAGE presence (git4idea's model), never the porcelain
 * `D` column, so a missing stage is never checked out.
 */
export interface IConflictIndexWriter {
  /**
   * Read the unmerged index stage model — scoped to `filePath` when given,
   * otherwise every unmerged path. Index-only (no working-tree walk).
   */
  readStages(repoRoot: string, filePath?: string): Promise<Map<string, IUnmergedEntry>>;

  /**
   * Resolve `filePath` to one side (`--ours`/`--theirs`). Returns `true` when the
   * checked-out file still needs staging; `false` when the side was absent and
   * the path was removed with `git rm` (which already stages the removal).
   */
  takeSide(
    repoRoot: string,
    filePath: string,
    flag: '--ours' | '--theirs',
    entry: IUnmergedEntry | undefined
  ): Promise<boolean>;
}

/** Production {@link IConflictIndexWriter} over a real {@link GitCli}. */
export class ConflictIndexWriter implements IConflictIndexWriter {
  constructor(private readonly _gitCli: GitCli) {}

  readStages(repoRoot: string, filePath?: string): Promise<Map<string, IUnmergedEntry>> {
    return readUnmergedStages(this._gitCli, repoRoot, filePath);
  }

  async takeSide(
    repoRoot: string,
    filePath: string,
    flag: '--ours' | '--theirs',
    entry: IUnmergedEntry | undefined
  ): Promise<boolean> {
    const options: IGitCommandOptions = { cwd: repoRoot, throwOnError: true };
    const side = flag === '--ours' ? 'ours' : 'theirs';
    // Only route to `git rm` when the path IS unmerged (entry present) but the
    // wanted stage is absent — never for a non-conflicted file (which would
    // wrongly delete it); an unknown entry falls through to checkout.
    if (entry && sideStatus(entry, side) === 'deleted') {
      await this._gitCli.exec(['rm', '--', filePath], options);
      return false;
    }
    await this._gitCli.exec(['checkout', flag, '--', filePath], options);
    return true;
  }
}
