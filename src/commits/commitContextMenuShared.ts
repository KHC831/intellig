/**
 * Shared helpers for the commit context-menu command handlers, referenced by
 * both the dispatcher class and the per-domain action modules split out of it.
 */

/**
 * Defence-in-depth hash format check.
 *
 * `_handleCommitContextMenu` already rejects hashes that
 * aren't in the rendered `commitNodes`, but a future bypass (palette
 * command, scripted entry point) could feed unvalidated input. A
 * lowercase-hex regex catches obvious shell-injection / typoed-string
 * inputs before they reach the gitCli argv. Bounds:
 *   - 4 chars is the shortest `git rev-parse` accepts (abbreviated
 *     refs).
 *   - The upper bound is 64 (not 40) to support
 *     SHA-256 repos created by `git init --object-format=sha256` (Git
 *     ≥ 2.29). A SHA-1 cap would silently reject valid SHA-256
 *     hashes.
 */
const HASH_RE = /^[0-9a-f]{4,64}$/i;
export function allHashesValid(hashes: readonly string[]): boolean {
  return hashes.every((h) => HASH_RE.test(h));
}

/**
 * Single source of truth for the stale-selection
 * toast surfaced when an in-order guard rejects a dispatched action whose
 * commit hash is no longer in the rendered commitNodes. The same
 * literal previously lived in five places (createPatchMulti, compareVersions,
 * dropCommitMulti, squashCommits, dropCommit) and inline structural tests
 * pinned exact matches. The const lets future copy edits land in one
 * place. Wire format frozen here.
 *
 * TODO(post-locale): when locale work begins, replace this with a
 * message-id and ship the localised string from a resource bundle.
 */
export const STALE_SELECTION_TOAST =
  'Commit selection changed since the menu opened — please retry.';
