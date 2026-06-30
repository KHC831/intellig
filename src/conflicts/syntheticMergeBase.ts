import { GitCli } from '../git-core/gitCli';

/**
 * Files that received a synthetic add/add stage-1 base, keyed by repo root →
 * set of repo-relative paths. The base is the conflict-marked working file
 * (good for the native editor's 3-way diff) but is NOT a real common ancestor,
 * so "Apply Non-Conflicting" must treat it as the genuine add/add base (empty)
 * rather than diffing against the markers. Tracked precisely here — rather than
 * sniffing the stage-1 content for markers — so a real base that legitimately
 * contains marker-like lines is never mistaken for a synthetic one.
 */
const injectedBases = new Map<string, Set<string>>();

/**
 * Whether `relPath` in `repoRoot` has a synthetic add/add base recorded.
 * Non-consuming: the flag matches the index (stage 1 stays synthetic until the
 * conflict resolves), so repeated "Apply Non-Conflicting" on the same
 * still-unresolved file keeps treating the base as empty. The flag is cleared
 * by {@link clearSyntheticBasesForRepo} once the repo's conflicts clear.
 * Returns `false` for any file we did not inject.
 */
export function hasSyntheticBase(repoRoot: string, relPath: string): boolean {
  return injectedBases.get(repoRoot)?.has(relPath) ?? false;
}

/**
 * Drop all synthetic-base flags for a repo. Called when the repo's conflicts
 * clear, so a flag can never go stale into a later, unrelated conflict on the
 * same path.
 */
export function clearSyntheticBasesForRepo(repoRoot: string): void {
  injectedBases.delete(repoRoot);
}

/**
 * Stage of a conflicted file in the index, parsed from `git ls-files -u`.
 */
interface IUnmergedStage {
  mode: string;
  sha: string;
  stage: 1 | 2 | 3;
}

/**
 * Parse `git ls-files -u -z -- <path>` output into the stages present for a
 * single path. Each record is `<mode> <sha> <stage>\t<path>` terminated by NUL.
 */
function parseUnmergedStages(output: string): IUnmergedStage[] {
  const stages: IUnmergedStage[] = [];
  for (const record of output.split('\0')) {
    if (record.length === 0) {
      continue;
    }
    const tab = record.indexOf('\t');
    if (tab < 0) {
      continue;
    }
    const meta = record.slice(0, tab).trim().split(/\s+/);
    if (meta.length < 3) {
      continue;
    }
    const stage = Number(meta[2]);
    if (stage === 1 || stage === 2 || stage === 3) {
      stages.push({ mode: meta[0], sha: meta[1], stage });
    }
  }
  return stages;
}

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
 * not an add/add (a base already exists, or a stage is missing).
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

  const listed = await gitCli.exec(['ls-files', '-u', '-z', '--', relPath], {
    cwd: repoRoot,
    throwOnError: false,
  });
  if (listed.exitCode !== 0) {
    return false;
  }

  const stages = parseUnmergedStages(listed.stdout);
  const stage2 = stages.find((s) => s.stage === 2);
  const stage3 = stages.find((s) => s.stage === 3);
  const hasStage1 = stages.some((s) => s.stage === 1);

  // Only add/add qualifies: a base already present means the native editor can
  // already diff; a missing ours/theirs is a delete/modify (no three-way text).
  if (hasStage1 || !stage2 || !stage3) {
    return false;
  }

  // Write the conflict-marked working file as a blob to serve as the base.
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

  // Record so "Apply Non-Conflicting" treats this file's base as the true
  // (empty) add/add ancestor rather than the marker-laden synthetic blob.
  let set = injectedBases.get(repoRoot);
  if (!set) {
    set = new Set<string>();
    injectedBases.set(repoRoot, set);
  }
  set.add(relPath);

  return true;
}
