/**
 * Row identity of a commit within a (possibly multi-root) graph window.
 *
 * The merged "all roots" log interleaves commits from several repositories,
 * and two checkouts/worktrees of the same repo carry IDENTICAL hashes — so a
 * bare hash is NOT a row identity there (IntelliJ vcs-log parity: CommitId =
 * Hash + root). Every intra-window relationship map in the graph pipeline
 * (children, lanes, rows, refs) keys by the `hash\0root` composite these
 * functions own. Commits without a `repoRoot` tag (single-repo /
 * specific-scope loads) degrade to the bare hash, so those paths are
 * byte-identical to a pre-multi-root world.
 */

import { ICommit } from './interfaces/IGitService';

/** Identity of a commit ROW within the graph window. */
export function commitNodeKey(commit: ICommit): string {
  const root = (commit as { repoRoot?: string }).repoRoot;
  return root ? `${commit.hash}\0${root}` : commit.hash;
}

/**
 * Identity of `commit`'s parent within the same window. A parent is by
 * definition in the SAME repository as its child, so it inherits the child's
 * `repoRoot`.
 */
export function parentNodeKey(commit: ICommit, parentHash: string): string {
  const root = (commit as { repoRoot?: string }).repoRoot;
  return root ? `${parentHash}\0${root}` : parentHash;
}

/**
 * Compose a graph-window key from a bare hash + root — for callers (the
 * merged loader's branch/tag maps) that key rows without an ICommit in hand.
 */
export function graphRowKey(hash: string, repoRoot: string | undefined): string {
  return repoRoot ? `${hash}\0${repoRoot}` : hash;
}

/**
 * Decompose a graph-window key back into its bare hash + root. The inverse of
 * {@link graphRowKey}: consumers that need a COMMIT identity out of a row key
 * (the branch-focus tip resolution) must route through this rather than treat
 * the key as a hash — a composite key handed to selectCommit/scrollToCommit
 * matches no node and no webview row.
 */
export function graphRowKeyParts(key: string): { hash: string; repoRoot?: string } {
  const sep = key.indexOf('\0');
  if (sep === -1) {
    return { hash: key };
  }
  return { hash: key.slice(0, sep), repoRoot: key.slice(sep + 1) };
}
