/**
 * Low-level readers for `.git/` marker files, shared by every module that needs
 * to peek at in-progress operation state without spawning git: the status-bar
 * in-progress reader ({@link readInProgressOperation}) and the conflict
 * side-name resolver. Keeping these in one place stops the two surfaces from
 * drifting (e.g. a newline-injection scrub fixed in one but not the other).
 *
 * Pure except for the file reads and the injected {@link ShortenSha} callback.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

/** Hex-only git object id: 40-char (SHA-1) or 64-char (SHA-256). */
export const FULL_SHA_RE = /^[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?$/;

/** An abbreviated-or-full hex object id: 4–64 hex chars (SHA-1 or SHA-256). */
const HEX_OBJECT_ID_RE = /^[0-9a-fA-F]{4,64}$/;

/**
 * Whether `value` is a hex git object id — a full 40/64-char id, or (with
 * `{ allowPrefix: true }`) an abbreviated 4–64-char prefix. The single home for
 * this test so every argv guard stays SHA-256-ready instead of hard-capping at
 * 40 hex chars (which silently broke containing-branches, hash filters, stash
 * rename, and cherry marks in SHA-256 repos).
 */
export function isHexObjectId(value: string, options?: { allowPrefix?: boolean }): boolean {
  return options?.allowPrefix ? HEX_OBJECT_ID_RE.test(value) : FULL_SHA_RE.test(value);
}

/**
 * Translates a full 40/64-char SHA into its abbreviated form. Production callers
 * wire this to `git rev-parse --short`; tests pass a pure substring helper. May
 * resolve `undefined` (or reject) on failure — callers fall back to a 7-char
 * substring.
 */
export type ShortenSha = (sha: string) => Promise<string | undefined>;

/**
 * `.git/rebase-merge/` — live state of an interactive / merge-strategy
 * rebase. The named constant (not a re-typed literal) is the fence line:
 * `check:git-dir-markers` fails a raw literal outside this module.
 */
export const REBASE_MERGE_DIR = 'rebase-merge';

/**
 * `.git/rebase-apply/` — live state of a legacy `am`-style rebase OR a
 * `git am` session; the {@link AM_SESSION_MARKER} flag file separates the
 * two. Consumers must never infer meaning from this directory alone.
 */
export const REBASE_APPLY_DIR = 'rebase-apply';

/**
 * The two directories git uses to hold live rebase state. Only one exists at
 * a time. Shared so every "is a rebase in progress" probe checks the same set
 * instead of re-listing the literal.
 */
export const REBASE_STATE_DIRS = [REBASE_MERGE_DIR, REBASE_APPLY_DIR] as const;

/**
 * Flag file distinguishing a `git am` session from an am-based rebase: git's
 * own status check reads `rebase-apply/applying` — present = `git am`, absent
 * = rebase (git wt-status.c, show_rebase_information). Misreading an am
 * session as a rebase offers `git rebase --continue/--abort`, which git
 * refuses during am.
 */
export const AM_SESSION_MARKER = 'applying';

/** True when `rebase-apply/` holds a live `git am` session (not a rebase). */
export async function isAmSession(gitDir: string): Promise<boolean> {
  return (await readAmMarker(gitDir, AM_SESSION_MARKER)) !== undefined;
}

/**
 * Read a file from the `git am` session's state directory (`rebase-apply/`).
 * Callers gate on {@link isAmSession} first — the same directory backs an
 * am-based rebase.
 */
export async function readAmMarker(gitDir: string, fileName: string): Promise<string | undefined> {
  return tryReadGitFile(path.join(gitDir, REBASE_APPLY_DIR, fileName));
}

/**
 * Read a file from whichever rebase state directory is live. Only one exists at
 * a time, so the first hit is authoritative. Single home for the "which rebase
 * dir" walk shared by the status-bar reader and the conflict side-name resolver.
 */
export async function readRebaseMarker(
  gitDir: string,
  fileName: string
): Promise<string | undefined> {
  for (const dir of REBASE_STATE_DIRS) {
    const raw = await tryReadGitFile(path.join(gitDir, dir, fileName));
    if (raw !== undefined) {
      return raw;
    }
  }
  return undefined;
}

/**
 * Name of the live operation that would make a new interactive rebase fail
 * ("rebase-merge already exists" / sequencer conflicts), or `undefined` when
 * none is in flight: a rebase (either {@link REBASE_STATE_DIRS} directory)
 * or a cherry-pick / revert sequencer (`CHERRY_PICK_HEAD` / `REVERT_HEAD`).
 * A `MERGE_HEAD` alone is NOT reported — a conflicted merge is caught by the
 * unmerged-files gate, and a resolved-but-uncommitted merge fails loudly in
 * git itself. Pure marker reads; never throws (missing gitDir → undefined).
 */
export async function findBlockingOperation(
  gitDir: string
): Promise<'rebase' | 'patch apply (git am)' | 'cherry-pick' | 'revert' | undefined> {
  for (const dir of REBASE_STATE_DIRS) {
    try {
      if ((await fs.stat(path.join(gitDir, dir))).isDirectory()) {
        // rebase-apply/ backs BOTH `git am` and am-based rebases; the
        // `applying` flag file separates them (the returned name is
        // interpolated into refusal toasts, and pointing an am session at
        // rebase commands offers recovery git refuses).
        return (await isAmSession(gitDir)) ? 'patch apply (git am)' : 'rebase';
      }
      // eslint-disable-next-line no-restricted-syntax -- ENOENT is the expected idle case: the marker directory simply doesn't exist.
    } catch {
      // Marker absent — keep probing.
    }
  }
  if ((await tryReadGitFile(path.join(gitDir, 'CHERRY_PICK_HEAD'))) !== undefined) {
    return 'cherry-pick';
  }
  if ((await tryReadGitFile(path.join(gitDir, 'REVERT_HEAD'))) !== undefined) {
    return 'revert';
  }
  return undefined;
}

/**
 * Resolve a repo root's real `.git` directory. For a normal checkout `<root>/.git`
 * is a directory and is returned as-is. For a linked worktree or a submodule
 * `<root>/.git` is instead a FILE holding `gitdir: <path>` (that path is where the
 * per-worktree markers — MERGE_HEAD, CHERRY_PICK_HEAD, rebase dirs — actually
 * live). Parsing it here (a single fs read, no git subprocess) keeps marker-based
 * state detection correct inside worktrees, where `path.join(root, '.git')` would
 * otherwise point at the file and find no markers.
 *
 * Best-effort: falls back to `<root>/.git` on any read/parse failure.
 */
export async function resolveGitDir(rootPath: string): Promise<string> {
  const dotGit = path.join(rootPath, '.git');
  // The common case is a `.git` DIRECTORY; a single stat distinguishes it from
  // the worktree/submodule `.git` FILE without provoking an EISDIR read error.
  try {
    if ((await fs.stat(dotGit)).isDirectory()) {
      return dotGit;
    }
  } catch {
    // `.git` missing / unreadable: fall back to the raw path (best-effort).
    return dotGit;
  }
  const raw = await tryReadGitFile(dotGit);
  const match = raw?.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!match) {
    return dotGit;
  }
  const target = match[1].trim();
  return path.isAbsolute(target) ? target : path.resolve(rootPath, target);
}

/** Read a file as utf-8. Returns undefined on any error (ENOENT, EACCES, …). */
export async function tryReadGitFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * The first whitespace-delimited token of a marker file, but only when it is a
 * literal full SHA. Rejecting anything else before it reaches `git rev-parse`
 * defends the CLI against attacker-controlled / corrupt marker contents and
 * keeps junk out of any label derived from it.
 */
export function firstShaToken(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const sha = raw.trim().split(/\s+/)[0] ?? '';
  return FULL_SHA_RE.test(sha) ? sha : undefined;
}

/** Abbreviate a SHA, falling back to a 7-char substring if the callback fails. */
export async function abbreviateSha(sha: string, shortenSha: ShortenSha): Promise<string> {
  try {
    return (await shortenSha(sha)) ?? sha.substring(0, 7);
  } catch {
    return sha.substring(0, 7);
  }
}

/**
 * Read a SHA-bearing marker file (e.g. CHERRY_PICK_HEAD / REVERT_HEAD / onto)
 * and return its abbreviated SHA, or undefined when the file is absent or does
 * not hold a literal SHA.
 */
export async function readAbbreviatedShaMarker(
  filePath: string,
  shortenSha: ShortenSha
): Promise<string | undefined> {
  const sha = firstShaToken(await tryReadGitFile(filePath));
  return sha ? abbreviateSha(sha, shortenSha) : undefined;
}

/**
 * Strip the `refs/heads/` prefix from a `head-name`-style value. Returns
 * undefined when the input is undefined, empty after trim, or a parenthesised
 * pseudo-ref (`(no branch, …)`). The value is reduced to its first line and
 * scrubbed of any residual CR/LF so a corrupt/hand-edited marker cannot leak a
 * line terminator into a status-bar label or screen-reader narration.
 */
export function stripRefsHeads(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const firstLine = trimmed.split(/\r\n|\r|\n/, 1)[0] ?? '';
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
