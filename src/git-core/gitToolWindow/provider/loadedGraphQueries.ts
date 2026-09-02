/**
 * Pure queries over the loaded commit graph window. Extracted verbatim from
 * the provider; every input is a parameter, so the walks are testable without
 * a provider instance.
 */

import type { ICommitNode } from '../../commitGraph';
import type { IBranchFilterGroups } from '../gitToolWindow.wireTypes';
import { compareRefNames } from '../../../utils/refNameSort';

/**
 * BFS over `commitNodes`'s parent edges from `targetHash`
 * back to `mergeBaseHash`. Every visited commit (inclusive of the merge
 * base when found) is added to the result set.
 *
 * Trap T-1: cap walking at `commitNodes.length` to defend against
 * cyclic / corrupt parent chains. When the BFS exhausts loaded nodes
 * without finding the merge-base, the result is the full set of walked
 * commits (no infinite loop, partial highlight).
 *
 * Trap T-8: when `mergeBaseHash` is undefined (no common ancestor or
 * git error), the BFS still walks until exhaustion or until it leaves
 * the loaded commit set — same partial-highlight outcome.
 *
 * orphan-branch behavior. When the focused
 * branch shares no common ancestor with HEAD (e.g. `git checkout
 * --orphan`), `getMergeBase` returns undefined and this BFS walks
 * the entire loaded ancestry of the focused branch. That over-
 * highlights compared to a strict "tip → merge-base" path, but is
 * the safe conservative default — every commit the user can see
 * from the focused branch is "on path" from focus's perspective.
 */
export function bfsPathToMergeBase(
  commitNodes: readonly ICommitNode[],
  targetHash: string,
  mergeBaseHash: string | undefined
): Set<string> {
  const path = new Set<string>();
  const nodeByHash = new Map<string, ICommitNode>();
  for (const node of commitNodes) {
    nodeByHash.set(node.commit.hash, node);
  }

  if (!nodeByHash.has(targetHash)) {
    return path;
  }

  const queue: string[] = [targetHash];
  const cap = commitNodes.length;
  let walked = 0;
  while (queue.length > 0) {
    if (walked >= cap) {
      // Trap T-1 — bail on suspected corrupt parent chain.
      break;
    }
    const head = queue.shift()!;
    if (path.has(head)) {
      continue;
    }
    path.add(head);
    walked += 1;

    // If we just reached the merge-base, stop expanding from this
    // branch of the BFS.
    if (mergeBaseHash !== undefined && head === mergeBaseHash) {
      continue;
    }

    const node = nodeByHash.get(head);
    if (!node) {
      continue;
    }
    for (const parent of node.commit.parents) {
      if (!path.has(parent) && nodeByHash.has(parent)) {
        queue.push(parent);
      }
    }
  }
  return path;
}

/**
 * Fold per-repo branch lists into the Branch popup's grouped shape: a sorted
 * union of local names plus per-remote sorted groups (IntelliJ
 * BranchFilterModel parity for the merged scope).
 */
export function groupBranchFilterOptions(
  perRepoBranches: ReadonlyArray<ReadonlyArray<{ name: string; type: string }>>
): IBranchFilterGroups {
  const local = new Set<string>();
  const remotes = new Map<string, Set<string>>();
  for (const list of perRepoBranches) {
    for (const b of list) {
      if (b.type === 'local') {
        local.add(b.name);
      } else if (b.type === 'remote') {
        // Remote ref names look like `origin/feature`; group by the remote.
        const slash = b.name.indexOf('/');
        const remote = slash > 0 ? b.name.slice(0, slash) : b.name;
        let set = remotes.get(remote);
        if (!set) {
          set = new Set<string>();
          remotes.set(remote, set);
        }
        set.add(b.name);
      }
    }
  }
  const groups: IBranchFilterGroups = {
    local: [...local].sort(compareRefNames),
    remotes: [...remotes.entries()]
      .sort((a, b) => compareRefNames(a[0], b[0]))
      .map(([remote, set]) => ({ remote, branches: [...set].sort(compareRefNames) })),
  };
  return groups;
}
