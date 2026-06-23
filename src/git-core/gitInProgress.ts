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

import * as fs from 'fs/promises';
import * as path from 'path';
import { IInProgressOperation } from './interfaces/IGitService';

/**
 * Callback that translates a full 40-char SHA into its abbreviated form.
 * Production callers wire this to `git rev-parse --short`. Tests pass a
 * pure substring helper.
 */
export type ShortenSha = (sha: string) => Promise<string>;

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
  // Order matters — see precedence list in the file-level doc comment.
  const rebaseMerge = await readRebaseDir(path.join(gitDir, 'rebase-merge'));
  if (rebaseMerge) {
    return rebaseMerge;
  }
  const rebaseApply = await readRebaseDir(path.join(gitDir, 'rebase-apply'));
  if (rebaseApply) {
    return rebaseApply;
  }
  const cherryPick = await readShaMarker(
    path.join(gitDir, 'CHERRY_PICK_HEAD'),
    'cherry-picking',
    shortenSha
  );
  if (cherryPick) {
    return cherryPick;
  }
  const revert = await readShaMarker(path.join(gitDir, 'REVERT_HEAD'), 'reverting', shortenSha);
  if (revert) {
    return revert;
  }
  const merge = await readMergeMarker(path.join(gitDir, 'MERGE_HEAD'));
  if (merge) {
    return merge;
  }
  return undefined;
}

/**
 * Read either `rebase-merge/` (interactive) or `rebase-apply/` (legacy
 * am-style). The directory must exist; `head-name` is the preferred target
 * source ("the branch that's being rebased"). Falls back to `onto` if
 * head-name is missing — `onto` resolves to a SHA on legacy `rebase-apply`
 * but git also writes a friendly name there in some interactive paths.
 */
async function readRebaseDir(dir: string): Promise<IInProgressOperation | undefined> {
  // Probe for existence cheaply by reading head-name first; if the dir
  // doesn't exist, every readFile will throw ENOENT and we return undefined.
  const headName = await tryReadFile(path.join(dir, 'head-name'));
  const onto = await tryReadFile(path.join(dir, 'onto'));
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

/** Hex-only git object id: 40-char (SHA-1) or 64-char (SHA-256). */
const FULL_SHA_RE = /^[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?$/;

/**
 * Read a SHA-bearing marker file (CHERRY_PICK_HEAD / REVERT_HEAD) and
 * abbreviate the contained SHA. Returns undefined when the file doesn't
 * exist or is empty.
 *
 * The file's first whitespace-delimited token is verified against
 * {@link FULL_SHA_RE} *before* being passed to the `shortenSha` callback. A
 * malformed marker (corrupt git plumbing, or a hand-edited file containing
 * path/expression characters that would otherwise hit the git CLI through
 * `buildGitArgs`) downgrades to a verb-only payload — the StatusBar still
 * renders "Cherry-picking" / "Reverting" without a target rather than
 * crashing or invoking git with attacker-controlled input.
 */
async function readShaMarker(
  filePath: string,
  kind: 'cherry-picking' | 'reverting',
  shortenSha: ShortenSha
): Promise<IInProgressOperation | undefined> {
  const raw = await tryReadFile(filePath);
  if (raw === undefined) {
    return undefined;
  }
  const sha = raw.trim().split(/\s+/)[0] ?? '';
  if (!sha) {
    return { kind };
  }
  // Reject anything that isn't a literal 40-char hex SHA — defends
  // `git rev-parse --short` against attacker-controlled marker contents
  // and avoids leaking junk into the status-bar `target`.
  if (!FULL_SHA_RE.test(sha)) {
    return { kind };
  }
  let short: string;
  try {
    short = await shortenSha(sha);
  } catch {
    short = sha.substring(0, 7);
  }
  return { kind, target: short, targetSha: short };
}

/**
 * Read MERGE_HEAD — merge has no friendly target name available without
 * extra git plumbing, so `target` is left undefined. The verb form
 * ("Merging") is sufficient signal on its own.
 */
async function readMergeMarker(filePath: string): Promise<IInProgressOperation | undefined> {
  const raw = await tryReadFile(filePath);
  if (raw === undefined) {
    return undefined;
  }
  return { kind: 'merging' };
}

/** Read a file as utf-8. Returns undefined on any error (ENOENT, EACCES, …). */
async function tryReadFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Strip the `refs/heads/` prefix when present. Returns undefined when the
 * input itself is undefined, empty after trim, or starts with the
 * parenthesized pseudo-ref shape (`(no branch, …)`) git emits during some
 * detached states. Pseudo-refs are filtered to keep them out of the
 * status-bar label, which would otherwise read e.g.
 * "Rebasing onto (no branch, rebasing main)".
 *
 * The trimmed value is reduced to its first line and then scrubbed of any
 * residual `\r` / `\n` characters before further inspection. A `head-name`
 * file containing `refs/heads/foo\nbar\n` (corrupt git plumbing or a
 * hand-edited file) would otherwise leak the embedded newline straight
 * through to the status-bar text and screen-reader narration. The split +
 * scrub pair makes it impossible for line terminators to reach `target`.
 */
function stripRefsHeads(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  // Split on any line terminator — `\r\n` (CRLF), `\n` (LF), or a bare `\r`
  // (classic-Mac, but also what some editors leave in malformed files). The
  // fallback to `''` is sound: the guard above ensures `trimmed` is
  // non-empty, so `split(..., 1)` always yields at least one element.
  const firstLine = trimmed.split(/\r\n|\r|\n/, 1)[0] ?? '';
  // Belt-and-braces: even if the split above ever regresses, embedded
  // line terminators still cannot leak into the StatusBar `target`.
  const scrubbed = firstLine.replace(/[\r\n]/g, '');
  if (scrubbed.length === 0) {
    return undefined;
  }
  if (scrubbed.startsWith('(') && scrubbed.endsWith(')')) {
    return undefined;
  }
  if (scrubbed.startsWith('refs/heads/')) {
    return scrubbed.substring('refs/heads/'.length);
  }
  return scrubbed;
}
