/**
 * Tier-2 command E2E — real-git status assertions.
 *
 * Modeled on git4idea's `GitTestAssertions.kt` / `GitRepository.assertStatus`:
 * every assertion shells out to real `git status --porcelain <file>` and
 * compares the two-character XY status code against the expectation, rather
 * than trusting a mock or the extension's own parsing. This is the lane that
 * catches "the command ran but did nothing to the index/working tree" — the
 * exact class of bug the explorer context-menu ops shipped with.
 *
 * Porcelain XY recap (git-status(1)):
 *   - X = index (staged) state, Y = working-tree state.
 *   - "A " staged add, "M " staged modification, " M" unstaged modification,
 *     "MM" staged + further unstaged, "??" untracked, "" (no output) clean.
 */

import * as assert from 'assert';

import { execGit } from './gitFixture';

/**
 * Return the two-character porcelain status for a single repo-relative path,
 * or the empty string when git reports the path as clean / committed (no
 * porcelain line). Always queries with `--` so a path that looks like a flag
 * is still treated as a pathspec.
 */
export async function porcelainStatus(repoRoot: string, relPath: string): Promise<string> {
  const r = await execGit(repoRoot, ['status', '--porcelain', '--', relPath]);
  const line = r.stdout.split('\n').find((l) => l.length > 0);
  if (!line) {
    return '';
  }
  // Porcelain lines are `XY <path>`; the XY code is the first two chars.
  return line.slice(0, 2);
}

/** Assert the file is staged (index records a change: leading X is non-space, non-`?`). */
export async function assertStaged(repoRoot: string, relPath: string): Promise<void> {
  const xy = await porcelainStatus(repoRoot, relPath);
  const indexChar = xy.charAt(0);
  assert.ok(
    indexChar !== '' && indexChar !== ' ' && indexChar !== '?',
    `expected ${relPath} to be STAGED, but porcelain status was "${xy}" (clean = "")`
  );
}

/**
 * Assert the file has an unstaged working-tree change AND nothing staged for
 * it (the post-unstage shape): the index column is a space and the
 * working-tree column records a change. An untracked file ("??") also counts
 * as "not staged" for the add→unstage round-trip.
 */
export async function assertUnstaged(repoRoot: string, relPath: string): Promise<void> {
  const xy = await porcelainStatus(repoRoot, relPath);
  assert.ok(
    xy === '??' || (xy.charAt(0) === ' ' && xy.charAt(1) !== ' '),
    `expected ${relPath} to be UNSTAGED (working-tree change, clean index), but porcelain status was "${xy}"`
  );
}

/** Assert the file is clean — committed with no staged or unstaged change. */
export async function assertReverted(repoRoot: string, relPath: string): Promise<void> {
  const xy = await porcelainStatus(repoRoot, relPath);
  assert.strictEqual(
    xy,
    '',
    `expected ${relPath} to be REVERTED (clean, no porcelain entry), but status was "${xy}"`
  );
}
