/**
 * Read in-progress git operation markers from a `.git/` directory and
 * synthesise an {@link IInProgressOperation} payload that StatusBarService
 * surfaces as a verb-form label (e.g. `$(git-merge) Merging feature/foo`).
 *
 * The function is *pure* — no git CLI invocation happens here. Cherry-pick
 * and revert require an abbreviated SHA, which is a git-specific transform
 * (`git rev-parse --short`); callers inject that transform via the
 * {@link ShortenSha} callback so this module stays free of GitCli coupling
 * and is trivially testable against tmpdir-based fake `.git/` layouts.
 *
 * Marker precedence (mirrors what `git status` prints):
 *   1. rebase-merge/  (interactive rebase)
 *   2. rebase-apply/  (legacy `git am` / non-interactive rebase)
 *   3. CHERRY_PICK_HEAD
 *   4. REVERT_HEAD
 *   5. MERGE_HEAD
 *
 * Rebase-then-merge is the only ambiguous case: if `git rebase --continue`
 * reaches an unresolved merge, both `rebase-merge/` and `MERGE_HEAD` exist
 * — git treats the operation as "still rebasing", so we do too.
 *
 * Divergence vs. {@link ConflictResolutionService}: that service additionally
 * inspects `.git/REBASE_HEAD` (a single-file marker git keeps around between
 * rebase steps and on rebase abort) to detect aborted/checkpoint state. This
 * reader deliberately does NOT read `REBASE_HEAD` because:
 *   - The presence of `rebase-merge/` or `rebase-apply/` directories is
 *     the canonical "rebase in progress" signal; `REBASE_HEAD` lingers
 *     after `--abort` runs and would mis-classify the post-abort steady
 *     state as still-rebasing.
 *   - This module exists to drive the StatusBar verb-form prefix, which
 *     should reflect *active* operations only. ConflictResolutionService
 *     cares about both active AND aborted/checkpoint states because its
 *     job is to decide which conflict-resolution UI to surface.
 * Future readers: do not unify the two marker sets without revisiting
 * StatusBar parity (the verb form would flicker on between rebase steps).
 *
 * Caller contract:
 *   - Returns `undefined` when no marker is present (the common idle case)
 *     or when the gitDir does not exist (mid-`rm -rf .git` race, etc.).
 *   - Never throws. Read errors on individual marker files are swallowed
 *     and fall through to the next marker; missing optional auxiliary files
 *     (e.g. `rebase-merge/onto`) leave the corresponding field undefined.
 *   - `target` is the human-readable name (with `refs/heads/` stripped) when
 *     known, or the abbreviated SHA when only a hash is available
 *     (cherry-pick / revert), or `undefined` for plain merges where neither
 *     a name nor a SHA-based label is appropriate.
 *   - `targetSha` is set only when the underlying marker carries a 40-char
 *     SHA (cherry-pick / revert).
 */

import * as path from 'path';
import { IInProgressOperation } from './interfaces/IGitService';
import {
  ShortenSha,
  tryReadGitFile,
  stripRefsHeads,
  firstShaToken,
  abbreviateSha,
  readRebaseMarker,
  isAmSession,
  readAmMarker,
} from './gitDirMarkers';

/**
 * Re-export the shared {@link ShortenSha} so this module's callers and
 * {@link resolveConflictSideNames} share one type (production callers wire it to
 * `git rev-parse --short`; tests pass a pure substring helper).
 */
export type { ShortenSha };

/**
 * Read all known in-progress markers under `gitDir/` and classify them.
 *
 * @param gitDir - Absolute path to the `.git/` directory of the repo. For
 *   submodules + linked worktrees this should be the resolved gitdir, not
 *   the worktree's `.git` *file* pointer.
 * @param shortenSha - Async callback that abbreviates a SHA. Called only
 *   for cherry-pick + revert markers; merge/rebase paths never invoke it.
 * @returns The classified in-progress operation, or `undefined` when no
 *   markers are present.
 */
export async function readInProgressOperation(
  gitDir: string,
  shortenSha: ShortenSha
): Promise<IInProgressOperation | undefined> {
  // The four marker probes are independent, so read them concurrently rather
  // than sequentially — on an idle repo every probe misses and serial awaits
  // would stack ~one fs round-trip each (costly on network/virtualized `.git`).
  // The SHA-shortening git call inside readShaMarker only fires when the marker
  // file actually exists, so a concurrent probe adds no subprocess. Precedence
  // (see the file-level doc comment) is restored by the `??` order below.
  const [rebase, cherryPick, revert, merge] = await Promise.all([
    readRebaseInProgress(gitDir),
    readShaMarker(path.join(gitDir, 'CHERRY_PICK_HEAD'), 'cherry-picking', shortenSha),
    readShaMarker(path.join(gitDir, 'REVERT_HEAD'), 'reverting', shortenSha),
    readMergeMarker(path.join(gitDir, 'MERGE_HEAD')),
  ]);
  return rebase ?? cherryPick ?? revert ?? merge;
}

/**
 * Read the live rebase state — `rebase-merge/` (interactive) or `rebase-apply/`
 * (legacy am-style), whichever exists. `head-name` is the preferred target
 * source ("the branch that's being rebased"); falls back to `onto` when
 * head-name is missing (legacy `rebase-apply` writes a SHA there).
 */
async function readRebaseInProgress(gitDir: string): Promise<IInProgressOperation | undefined> {
  // A `git am` session also lives in rebase-apply/ but writes the `applying`
  // flag (and no head-name) — git's own status check reads exactly this file
  // (wt-status.c show_rebase_information). It must never surface as a rebase:
  // the rebase recovery affordances are refused by git during am. Label with
  // the patch progress from next/last when present ("2/5").
  if (await isAmSession(gitDir)) {
    const next = (await readAmMarker(gitDir, 'next'))?.trim();
    const last = (await readAmMarker(gitDir, 'last'))?.trim();
    const result: IInProgressOperation = { kind: 'applying' };
    if (next && last && /^\d+$/.test(next) && /^\d+$/.test(last)) {
      result.target = `${next}/${last}`;
    }
    return result;
  }
  const headName = await readRebaseMarker(gitDir, 'head-name');
  const onto = await readRebaseMarker(gitDir, 'onto');
  if (headName === undefined && onto === undefined) {
    return undefined;
  }
  // Prefer the symbolic head-name (the branch being rebased) over the SHA
  // in `onto`. Strip `refs/heads/` so the StatusBar label reads
  // "Rebasing onto main" rather than "Rebasing onto refs/heads/main".
  const target = stripRefsHeads(headName) ?? stripRefsHeads(onto);
  const result: IInProgressOperation = { kind: 'rebasing' };
  if (target !== undefined) {
    result.target = target;
  }
  return result;
}

/**
 * Read a SHA-bearing marker file (CHERRY_PICK_HEAD / REVERT_HEAD) and
 * abbreviate the contained SHA. Returns undefined when the file doesn't exist;
 * downgrades to a verb-only payload (`{ kind }`) when the file is present but
 * holds no literal SHA — the StatusBar still renders "Cherry-picking" /
 * "Reverting" without a target rather than feeding junk to `git rev-parse`.
 */
async function readShaMarker(
  filePath: string,
  kind: 'cherry-picking' | 'reverting',
  shortenSha: ShortenSha
): Promise<IInProgressOperation | undefined> {
  const raw = await tryReadGitFile(filePath);
  if (raw === undefined) {
    return undefined;
  }
  const sha = firstShaToken(raw);
  if (!sha) {
    return { kind };
  }
  const short = await abbreviateSha(sha, shortenSha);
  return { kind, target: short, targetSha: short };
}

/**
 * Read MERGE_HEAD — merge has no friendly target name available without
 * extra git plumbing, so `target` is left undefined. The verb form
 * ("Merging") is sufficient signal on its own.
 */
async function readMergeMarker(filePath: string): Promise<IInProgressOperation | undefined> {
  const raw = await tryReadGitFile(filePath);
  if (raw === undefined) {
    return undefined;
  }
  return { kind: 'merging' };
}
