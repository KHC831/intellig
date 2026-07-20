import { GitCli } from '../git-core/gitCli';

/**
 * Layer 0 — the pure index/stage model for a conflicted repository, git4idea's
 * `GitConflict`. A conflicted path carries up to three index stages: 1 = merge
 * base, 2 = ours, 3 = theirs. Which stages are PRESENT is the single source of
 * truth for the "take a side vs. delete" decision — a side whose stage blob is
 * absent (delete/modify UD/DU, add-by-one-side AU/UA, both-deleted DD) must be
 * resolved with `git rm`, never a `git checkout --ours/--theirs` of a stage that
 * does not exist. The presence is read ONCE from the index (`git ls-files -u`,
 * no working-tree walk); callers consume the snapshot.
 */

/** A blob referenced by one index stage of a conflicted path. */
export interface IStageBlob {
  mode: string;
  sha: string;
}

/** The index stages present for a single conflicted path. */
export interface IUnmergedEntry {
  stage1?: IStageBlob;
  stage2?: IStageBlob;
  stage3?: IStageBlob;
}

/** Physical conflict side: ours = index stage 2, theirs = index stage 3. */
export type ConflictSide = 'ours' | 'theirs';

/**
 * Parse `git ls-files -u -z [-- <path>]` output into a path → stage-entry map.
 * Each NUL-terminated record is `<mode> <sha> <stage>\t<path>`; `-z` means the
 * path is literal (no C-quoting). Malformed records are skipped.
 */
export function parseUnmergedStages(output: string): Map<string, IUnmergedEntry> {
  const byPath = new Map<string, IUnmergedEntry>();
  for (const record of output.split('\0')) {
    if (record.length === 0) {
      continue;
    }
    const tab = record.indexOf('\t');
    if (tab < 0) {
      continue;
    }
    const meta = record.slice(0, tab).trim().split(/\s+/);
    const path = record.slice(tab + 1);
    if (meta.length < 3) {
      continue;
    }
    const stage = Number(meta[2]);
    if (stage !== 1 && stage !== 2 && stage !== 3) {
      continue;
    }
    const entry = byPath.get(path) ?? {};
    entry[`stage${stage}` as 'stage1' | 'stage2' | 'stage3'] = { mode: meta[0], sha: meta[1] };
    byPath.set(path, entry);
  }
  return byPath;
}

/**
 * Outcome of reading the index stage model. "Nothing is unmerged" and "the
 * index could not be read" are DIFFERENT facts: the first is information a
 * caller may act on, the second is the absence of information. `ls-files` runs
 * with `throwOnError: false`, so a failed read arrives as a non-zero exit and
 * never as an exception — a caller that only guards a `catch` is not guarded.
 */
export type UnmergedStagesRead =
  | { readonly ok: true; readonly stages: Map<string, IUnmergedEntry> }
  | { readonly ok: false; readonly stderr: string };

/**
 * Read the unmerged stage model from the index — index-only, so no whole
 * working-tree `git status` walk. Scoped to `filePath` when given.
 *
 * The result is a discriminated union rather than a bare map so a caller
 * cannot silently treat a failed read as an empty index — that ambiguity
 * defeated three separate callers.
 */
export async function readUnmergedStages(
  gitCli: GitCli,
  repoRoot: string,
  filePath?: string
): Promise<UnmergedStagesRead> {
  const args = ['ls-files', '-u', '-z'];
  if (filePath !== undefined) {
    args.push('--', filePath);
  }
  const result = await gitCli.exec(args, { cwd: repoRoot, throwOnError: false });
  if (result.exitCode !== 0) {
    return { ok: false, stderr: result.stderr };
  }
  return { ok: true, stages: parseUnmergedStages(result.stdout) };
}

// No flattening helper is provided on purpose. One existed and every caller
// that reached for it was wrong in a different way; a caller that genuinely
// wants to degrade writes `read.ok ? read.stages : new Map()` at its own site,
// where the choice is visible in review.

/**
 * Whether the physical stage for `side` (ours = 2, theirs = 3) is present in the
 * index for a conflicted path. `'deleted'` means the wanted stage has no blob —
 * the caller resolves by removing the path rather than checking out a
 * nonexistent stage.
 */
export function sideStatus(entry: IUnmergedEntry, side: ConflictSide): 'present' | 'deleted' {
  const stage = side === 'ours' ? entry.stage2 : entry.stage3;
  return stage ? 'present' : 'deleted';
}
