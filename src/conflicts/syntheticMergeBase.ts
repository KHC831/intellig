import { GitCli } from '../git-core/gitCli';
import { readUnmergedStages } from './conflictStageModel';

/**
 * Give an add/add conflict a synthetic merge base so VS Code's native merge
 * editor can show a real diff instead of the whole file on both sides.
 *
 * An add/add conflict (a file newly created on both branches) has no common
 * ancestor, so git's index carries stage 2 (ours) and stage 3 (theirs) but no
 * stage 1 (base). Fed an empty base, the native merge editor renders the entire
 * file as "added" on both sides with an empty middle — no reconciliation of the
 * lines the two versions actually share.
 *
 * IntelliJ handles this in `GitMergeUtil.loadMergeData`: when stage 1 is absent
 * it falls back to the working-tree file (which already carries git's own
 * `<<<<<<<`/`=======`/`>>>>>>>` markers) as the base. Diffing each side against
 * that marker-laden base collapses the shared lines and leaves only the genuine
 * conflict. We reproduce that for the native editor by writing the working file
 * as a blob and injecting it as stage 1.
 *
 * Stages 2 and 3 MUST be re-supplied in the same `update-index --index-info`
 * call: feeding only a stage-1 line replaces the path's whole index entry and
 * wipes ours/theirs. The injected base leaves `--ours`/`--theirs` and the
 * working file untouched, and an abort (`merge`/`rebase --abort`) resets the
 * index regardless.
 *
 * Best-effort: callers wrap this so a failure still opens the editor.
 *
 * @returns `true` when a synthetic base was injected, `false` when the file was
 * not an add/add (a base already exists, or a stage is missing) OR when the
 * index could not be read at all. Both mean "no synthetic base", which is all
 * this caller acts on.
 */
export async function ensureSyntheticMergeBase(
  gitCli: GitCli,
  repoRoot: string,
  relPath: string
): Promise<boolean> {
  // `update-index --index-info` parses a tab/newline-delimited text record, so a
  // path carrying either byte could corrupt the index write. Such paths are
  // pathological; skip the (best-effort) base injection rather than risk it.
  if (relPath.includes('\t') || relPath.includes('\n')) {
    return false;
  }

  // Read the index stage model (Layer 0) for this path. add/add = both sides
  // present with no base; an absent stage 2/3 is a delete/modify (no three-way
  // text) and a present stage 1 means the native editor can already diff.
  const stagesRead = await readUnmergedStages(gitCli, repoRoot, relPath);
  // Deliberately unspecced: an unreadable index and a path that is not add/add
  // both mean "no synthetic base", the caller's only question, and it already
  // treats this as best-effort. A spec here would pin an equivalence, not a
  // decision.
  const entry = stagesRead.ok ? stagesRead.stages.get(relPath) : undefined;
  if (!entry || entry.stage1 || !entry.stage2 || !entry.stage3) {
    return false;
  }
  const { stage2, stage3 } = entry;

  // Write the conflict-marked working file as a blob to serve as the base.
  // pathspec-exempt: hash-object takes a FILENAME, not a pathspec
  const hashed = await gitCli.exec(['hash-object', '-w', '--', relPath], {
    cwd: repoRoot,
    throwOnError: true,
  });
  const baseSha = hashed.stdout.trim();
  if (baseSha.length === 0) {
    return false;
  }

  // Re-supply all three stages so ours/theirs survive the index rewrite. Mirror
  // each blob's existing mode so an executable file keeps its bit.
  const indexInfo =
    `${stage2.mode} ${baseSha} 1\t${relPath}\n` +
    `${stage2.mode} ${stage2.sha} 2\t${relPath}\n` +
    `${stage3.mode} ${stage3.sha} 3\t${relPath}\n`;

  await gitCli.exec(['update-index', '--index-info'], {
    cwd: repoRoot,
    input: indexInfo,
    throwOnError: true,
  });

  return true;
}
