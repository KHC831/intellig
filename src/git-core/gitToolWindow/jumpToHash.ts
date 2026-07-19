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

/**
 * Seed items for the Jump-to-Commit picker (IntelliJ's completing popup):
 * local branches, then remote branches, then tags — the same label-order
 * rank {@link findCommitByQuery} uses to break prefix ties. A typed query
 * that is not one of these rides the verbatim row
 * ({@link verbatimJumpItem}), because a QuickPick always keeps a
 * fuzzy-matched item active and Enter would otherwise take the ref.
 */
export function buildJumpQuickPickItems(
  branches: ReadonlyArray<IBranch>,
  tags: ReadonlyArray<ITag>
): Array<{ label: string; description: 'branch' | 'tag' }> {
  const locals = branches.filter((b) => b.type === 'local');
  const remotes = branches.filter((b) => b.type !== 'local');
  return [
    ...[...locals, ...remotes].map((b) => ({ label: b.name, description: 'branch' as const })),
    ...tags.map((t) => ({ label: t.name, description: 'tag' as const })),
  ];
}

/** Marks the picker row that stands for the raw typed text. */
export const VERBATIM_JUMP_DESCRIPTION = 'as typed';

/** The leading picker row carrying whatever the user typed, verbatim. */
export interface IVerbatimJumpItem {
  label: string;
  description: typeof VERBATIM_JUMP_DESCRIPTION;
  /** Never filtered out — it IS the query. */
  alwaysShow: true;
  /** The raw text accepting this row resolves to. */
  value: string;
}

/**
 * Build the verbatim row for `typed`.
 *
 * A QuickPick keeps a fuzzy-matched item active as soon as the typed text
 * matches any ref loosely, so pressing Enter on a full SHA resolved to that
 * ref's tip instead of the SHA. Offering the raw input as its own leading row
 * (the VS Code checkout-picker idiom) makes accept-on-typed-text reachable.
 */
export function verbatimJumpItem(typed: string): IVerbatimJumpItem {
  return {
    label: `Jump to '${typed}'`,
    description: VERBATIM_JUMP_DESCRIPTION,
    alwaysShow: true,
    value: typed,
  };
}

/**
 * The query an accept resolves to: the verbatim row's raw value when that row
 * is the active one, otherwise the picked ref's label, otherwise the typed
 * text (an accept with nothing active).
 */
export function resolveJumpAccept(
  picked: { label?: string; description?: string; value?: string } | undefined,
  typed: string
): string | undefined {
  const trimmed = typed.trim();
  if (picked?.description === VERBATIM_JUMP_DESCRIPTION) {
    return picked.value?.trim() || undefined;
  }
  return picked?.label ?? trimmed ?? undefined;
}
