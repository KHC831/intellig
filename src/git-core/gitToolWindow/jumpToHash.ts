/**
 * Jump-to-Hash helpers for the Git tool window Log tab.
 *
 * Pure, dependency-injected matching logic so unit tests can exercise it
 * without a VS Code host. The extension-side command wires this up to the
 * webview via a `scrollToCommit` postMessage.
 */

import type { IBranch, ICommit, ITag } from '../interfaces/IGitService';

/**
 * Minimum number of characters a SHA prefix must have to match. Shorter
 * prefixes are common hex substrings inside commit messages / branch names
 * and would produce too many false positives.
 */
export const MIN_SHA_PREFIX_LENGTH = 4;

/**
 * Match kinds — surfaced so future callers (e.g. a results list) can label
 * why a particular commit hash came back. {@link findCommitByQuery} only
 * returns the matched hash, but this string ordering reflects the match
 * priority (SHA > branch > tag).
 */
export type JumpToHashMatchKind = 'sha' | 'branch' | 'tag';

/**
 * Attempt to resolve the given query string to a commit hash within the
 * currently-loaded log.
 *
 * Match rules (first-match-wins, in this order):
 *
 *   1. **SHA prefix** — any loaded commit whose full hash starts with the
 *      (case-insensitive) query. Minimum length 4.
 *   2. **Branch name** — exact (case-sensitive) match against a branch in
 *      `branches`. The branch's commit is returned.
 *   3. **Tag name** — exact (case-sensitive) match against a tag in `tags`.
 *      The tag's commit is returned.
 *
 * Returns `undefined` when nothing matches. The caller is responsible for
 * surfacing the "no match" UI.
 *
 * This helper operates on *currently-loaded* commits only.
 * It does NOT auto-page / fetch more history on a miss. That policy
 * deliberately keeps the jump action instant.
 */
export function findCommitByQuery(
  query: string,
  loadedCommits: readonly ICommit[],
  branches: readonly IBranch[],
  tags: readonly ITag[]
): string | undefined {
  if (!query) {
    return undefined;
  }
  const trimmed = query.trim();
  if (!trimmed) {
    return undefined;
  }

  // 1. SHA prefix
  if (trimmed.length >= MIN_SHA_PREFIX_LENGTH && isHexString(trimmed)) {
    const lowered = trimmed.toLowerCase();
    for (const commit of loadedCommits) {
      if (commit.hash && commit.hash.toLowerCase().startsWith(lowered)) {
        return commit.hash;
      }
    }
  }

  // 2. Branch name — exact match
  for (const branch of branches) {
    if (branch.name === trimmed && branch.commit) {
      return branch.commit;
    }
  }

  // 3. Tag name — exact match
  for (const tag of tags) {
    if (tag.name === trimmed && tag.commit) {
      return tag.commit;
    }
  }

  return undefined;
}

/**
 * Classify the query so a future results UI can label the match kind.
 * Returns `undefined` when the query doesn't resemble any known shape.
 */
export function classifyQuery(
  query: string,
  loadedCommits: readonly ICommit[],
  branches: readonly IBranch[],
  tags: readonly ITag[]
): JumpToHashMatchKind | undefined {
  const trimmed = query.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.length >= MIN_SHA_PREFIX_LENGTH && isHexString(trimmed)) {
    const lowered = trimmed.toLowerCase();
    if (loadedCommits.some((c) => c.hash?.toLowerCase().startsWith(lowered))) {
      return 'sha';
    }
  }
  if (branches.some((b) => b.name === trimmed)) {
    return 'branch';
  }
  if (tags.some((t) => t.name === trimmed)) {
    return 'tag';
  }
  return undefined;
}

/** `true` when every character is a lowercase/uppercase hex digit. */
export function isHexString(s: string): boolean {
  if (!s) {
    return false;
  }
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const isDigit = c >= 48 && c <= 57;
    const isLower = c >= 97 && c <= 102;
    const isUpper = c >= 65 && c <= 70;
    if (!isDigit && !isLower && !isUpper) {
      return false;
    }
  }
  return true;
}
