import { GitCli, IGitCommandOptions, literalPathspec } from '../git-core/gitCli';
import {
  IUnmergedEntry,
  UnmergedStagesRead,
  readUnmergedStages,
  sideStatus,
} from './conflictStageModel';

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
   *
   * Returns a discriminated result: a failed read is NOT an empty index. Each
   * caller decides, because they differ — a batch that resolves everything must
   * fail loudly, while a single-file accept can proceed with an unknown entry,
   * whose ambiguity takeSide already resolves safely.
   */
  readStages(repoRoot: string, filePath?: string): Promise<UnmergedStagesRead>;

  /**
   * Resolve `filePath` to one side (`--ours`/`--theirs`). Returns `true` when the
   * checked-out file still needs staging; `false` when the side was absent and
   * the path was removed with `git rm` (which already stages the removal).
   */
  takeSide(
    repoRoot: string,
    filePath: string,
    flag: '--ours' | '--theirs',
    entry: IUnmergedEntry | undefined,
    /**
     * Whether the index STAGE read succeeded. A readable index reporting no
     * entry means the path has no conflict, and taking a side on it would
     * discard uncommitted work; unreadable leaves it unknown, which falls
     * through to checkout as before. Defaults to the refusing side.
     */
    indexReadable?: boolean
  ): Promise<boolean>;

  /**
   * Send a RESOLVED file back to conflicted state (`git checkout --merge --
   * <path>`). Git recreates the conflict from the resolve-undo (REUC) index
   * data it records when a conflict is resolved, so this only works while
   * the merge/rebase/cherry-pick is still in progress; afterwards git
   * refuses with its own error. (git4idea has no per-file equivalent — this
   * rides on git's native behavior.)
   */
  restoreConflict(repoRoot: string, filePath: string): Promise<void>;
}

/** Production {@link IConflictIndexWriter} over a real {@link GitCli}. */
export class ConflictIndexWriter implements IConflictIndexWriter {
  constructor(private readonly _gitCli: GitCli) {}

  readStages(repoRoot: string, filePath?: string): Promise<UnmergedStagesRead> {
    return readUnmergedStages(this._gitCli, repoRoot, filePath);
  }

  async takeSide(
    repoRoot: string,
    filePath: string,
    flag: '--ours' | '--theirs',
    entry: IUnmergedEntry | undefined,
    indexReadable = true
  ): Promise<boolean> {
    const options: IGitCommandOptions = { cwd: repoRoot, throwOnError: true };
    const side = flag === '--ours' ? 'ours' : 'theirs';
    // `git checkout --ours -- <path>` exits 0 on an ordinary file and rewrites
    // it from HEAD, so running it on a path with no conflict silently discards
    // whatever the user had not committed. Refuse where the command is issued:
    // callers reach here with a target the user did not necessarily pick.
    if (indexReadable && !entry) {
      throw new Error(`${filePath} has no merge conflict to resolve`);
    }
    // Only route to `git rm` when the path IS unmerged (entry present) but the
    // wanted stage is absent — never for a non-conflicted file (which would
    // wrongly delete it); an unknown entry falls through to checkout.
    if (entry && sideStatus(entry, side) === 'deleted') {
      await this._gitCli.exec(['rm', '--', literalPathspec(filePath)], options);
      return false;
    }
    await this._gitCli.exec(['checkout', flag, '--', literalPathspec(filePath)], options);
    return true;
  }

  async restoreConflict(repoRoot: string, filePath: string): Promise<void> {
    await this._gitCli.exec(['checkout', '--merge', '--', literalPathspec(filePath)], {
      cwd: repoRoot,
      throwOnError: true,
    });
  }
}
