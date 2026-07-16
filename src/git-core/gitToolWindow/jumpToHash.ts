/**
 * Jump-to-Hash helpers for the Git tool window Log tab.
 *
 * Pure, dependency-injected matching logic so unit tests can exercise it
 * without a VS Code host. The extension-side command wires this up to the
 * webview via a `scrollToCommit` postMessage.
 *
 * Resolution contract mirrors git4idea's `VcsLogNavigationUtil.jumpToRefOrHash`:
 * refs are matched FIRST by name prefix (`startsWith`), the best ref picked by
 * a label-order comparator; only when no ref matches does the query fall back
 * to commit-hash resolution.
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
 * priority (ref > sha, per jumpToRefOrHash).
 */
export type JumpToHashMatchKind = 'sha' | 'branch' | 'tag';

/** One prefix-matched ref candidate, ranked by {@link compareRefCandidates}. */
interface IRefCandidate {
  name: string;
  commit: string;
  /** Label-order rank: local branch < remote branch < tag (GitRefManager analog). */
  rank: number;
  /** Exact name match beats any longer prefix match. */
  exact: boolean;
}

/**
 * Best-ref comparator — the VcsGoToRefComparator analog. git's label order
 * puts local branches before remotes before tags; an exact name match wins
 * over a longer prefix match, and name order breaks remaining ties so the
 * pick is deterministic.
 */
function compareRefCandidates(a: IRefCandidate, b: IRefCandidate): number {
  if (a.exact !== b.exact) {
    return a.exact ? -1 : 1;
  }
  if (a.rank !== b.rank) {
    return a.rank - b.rank;
  }
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Collect refs whose name starts with `query`, ranked for the comparator. */
function matchRefs(
  query: string,
  branches: readonly IBranch[],
  tags: readonly ITag[]
): IRefCandidate[] {
  const candidates: IRefCandidate[] = [];
  for (const branch of branches) {
    if (branch.commit && branch.name.startsWith(query)) {
      candidates.push({
        name: branch.name,
        commit: branch.commit,
        rank: branch.type === 'local' ? 0 : 1,
        exact: branch.name === query,
      });
    }
  }
  for (const tag of tags) {
    if (tag.commit && tag.name.startsWith(query)) {
      candidates.push({ name: tag.name, commit: tag.commit, rank: 2, exact: tag.name === query });
    }
  }
  return candidates.sort(compareRefCandidates);
}

/**
 * Strip the shell-quote characters the reference trims around a hash query
 * (`()'"` and backticks — VcsLogNavigationUtil.jumpToHash) from both ends.
 */
function trimHashQuery(query: string): string {
  return query.replace(/^[()'"`]+/, '').replace(/[()'"`]+$/, '');
}

/**
 * Attempt to resolve the given query string to a commit hash.
 *
 * Match rules (first-match-wins, in this order — jumpToRefOrHash parity):
 *
 *   1. **Ref prefix** — any branch or tag whose name STARTS WITH the query
 *      (case-sensitive; git ref names are case-sensitive). The best match is
 *      picked by the label-order comparator: exact name first, then local
 *      branches before remote branches before tags, then name order. The
 *      ref's commit is returned.
 *   2. **SHA prefix** — any loaded commit whose full hash starts with the
 *      (case-insensitive) query, after trimming surrounding `()'"` backticks.
 *      Minimum length 4.
 *
 * Returns `undefined` when nothing matches. The pure helper matches only the
 * inputs it is given; the command layer grows the log window and retries on
 * a miss (the reference retries as data packs load until the pack is full),
 * then surfaces the "no match" UI.
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

  // 1. Ref prefix — refs resolve before hashes (an all-hex branch name like
  // `beef` must jump to the branch, not a SHA-prefix match).
  const refs = matchRefs(trimmed, branches, tags);
  if (refs.length > 0) {
    return refs[0].commit;
  }

  // 2. SHA prefix over the loaded commits.
  const hashQuery = trimHashQuery(trimmed);
  if (hashQuery.length >= MIN_SHA_PREFIX_LENGTH && isHexString(hashQuery)) {
    const lowered = hashQuery.toLowerCase();
    for (const commit of loadedCommits) {
      if (commit.hash && commit.hash.toLowerCase().startsWith(lowered)) {
        return commit.hash;
      }
    }
  }

  return undefined;
}

/**
 * Classify the query so a future results UI can label the match kind.
 * Mirrors {@link findCommitByQuery}'s ref-first priority. Returns
 * `undefined` when the query doesn't resemble any known shape.
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

  const refs = matchRefs(trimmed, branches, tags);
  if (refs.length > 0) {
    return refs[0].rank === 2 ? 'tag' : 'branch';
  }
  const hashQuery = trimHashQuery(trimmed);
  if (hashQuery.length >= MIN_SHA_PREFIX_LENGTH && isHexString(hashQuery)) {
    const lowered = hashQuery.toLowerCase();
    if (loadedCommits.some((c) => c.hash?.toLowerCase().startsWith(lowered))) {
      return 'sha';
    }
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
