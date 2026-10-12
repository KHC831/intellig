// Ported from intellij-community platform/vcs-log/graph/src/com/intellij/vcs/log/graph/impl/permanent/GraphLayoutBuilder.kt
// and GraphLayoutImpl.kt. Copyright 2000-2024 JetBrains s.r.o. and contributors. Apache 2.0 license.

/**
 * Faithful TypeScript port of IntelliJ's graph-layout ownership engine —
 * `GraphLayoutBuilder` + `GraphLayoutImpl` (platform/vcs-log/graph).
 *
 * This is the authoritative answer to "which head (branch) owns each commit",
 * which is exactly what drives per-branch coloring: a commit's color comes from
 * the head its layout fragment belongs to. Porting the engine verbatim — rather
 * than re-deriving the rule — lets us run IntelliJ's own unit tests against it
 * (see `test/unit/graph/graphLayoutBuilderHeadOrder.test.ts`,
 * `graphLayoutBuilder.test.ts`) and guarantee bit-for-bit behavior matching.
 *
 * Direction convention (identical to IntelliJ's `LinearGraph`): node index
 * increases DOWN the log (0 = newest/top). An edge connects an up-node (smaller
 * index, newer) to a down-node (larger index, older = a parent). A "head" is a
 * node with no up-nodes (no children) — the newest tip of a chain.
 *
 * Pure (no DOM, no I/O, deterministic).
 */

import { Dfs, walk } from './dfsUtil';

/**
 * Minimal linear-graph surface the layout builder needs — the down/up adjacency
 * (LinearGraph in IntelliJ). `getDownNodes(i)` returns the parents of `i` (older
 * commits, larger indices); `getUpNodes(i)` its children.
 */
export interface ILinearGraph {
  nodesCount(): number;
  /** Parents of `nodeIndex` (down = older), in edge order. */
  getDownNodes(nodeIndex: number): number[];
  /** Children of `nodeIndex` (up = newer), in edge order. */
  getUpNodes(nodeIndex: number): number[];
}

/**
 * Build an {@link ILinearGraph} from a down-adjacency list (each node's
 * parents, by index). Up-edges are derived. Out-of-range / negative parent
 * indices are dropped (off-window parents), mirroring how IntelliJ omits edges
 * to not-loaded commits. `downAdjacency[i]` = parents of node `i`.
 */
export function linearGraphFromDownAdjacency(
  downAdjacency: readonly (readonly number[])[]
): ILinearGraph {
  const n = downAdjacency.length;
  const down: number[][] = [];
  const up: number[][] = [];
  for (let i = 0; i < n; i++) {
    down.push([]);
    up.push([]);
  }
  for (let i = 0; i < n; i++) {
    for (const parent of downAdjacency[i]) {
      if (parent >= 0 && parent < n) {
        down[i].push(parent);
        up[parent].push(i);
      }
    }
  }
  return {
    nodesCount: () => n,
    getDownNodes: (i) => down[i],
    getUpNodes: (i) => up[i],
  };
}

/** Heads of the graph: nodes with no up-nodes (no children). */
export function getHeads(graph: ILinearGraph): number[] {
  const heads: number[] = [];
  for (let i = 0; i < graph.nodesCount(); i++) {
    if (graph.getUpNodes(i).length === 0) {
      heads.push(i);
    }
  }
  return heads;
}

/**
 * The computed layout — a port of `GraphLayoutImpl`.
 *
 * `getLayoutIndex(node)` is the node's column/fragment index. Each head's
 * downward DFS claims a contiguous fragment and assigns it a single layout
 * index; a new index begins each time a fragment dead-ends.
 *
 * `getOneOfHeadNodeIndex(node)` is the head node that OWNS this node (drives its
 * color), found by mapping the node's layout index to the head with the largest
 * layout index not exceeding it (binary search, exactly as IntelliJ).
 */
export class GraphLayout {
  private readonly layoutIndexForHeadNodes: number[];

  constructor(
    private readonly layoutIndex: number[],
    /** Heads in processing order; their layout indices are ascending. */
    private readonly headNodes: number[]
  ) {
    this.layoutIndexForHeadNodes = headNodes.map((h) => layoutIndex[h]);
  }

  getLayoutIndex(nodeIndex: number): number {
    return this.layoutIndex[nodeIndex];
  }

  getOneOfHeadNodeIndex(nodeIndex: number): number {
    return this.headNodes[this.getHeadOrder(this.getLayoutIndex(nodeIndex))];
  }

  getHeadNodeIndex(): readonly number[] {
    return this.headNodes;
  }

  private getHeadOrder(layoutIndex: number): number {
    const i = binarySearch(this.layoutIndexForHeadNodes, layoutIndex);
    return i < 0 ? Math.max(0, -i - 2) : i;
  }
}

/**
 * Port of `GraphLayoutBuilder.build(graph, branches, comparator)`.
 *
 * The engine is FULL-DAG-capable (it walks whatever down-adjacency `graph`
 * exposes) and assumes nothing about first-parent semantics. The production
 * color caller (`branchColors.ts`) happens to feed it a FIRST-PARENT-ONLY graph
 * by deliberate choice, to keep ownership on the mainline spine — that is the
 * CALLER's policy, not a constraint of this function.
 *
 * @param graph      the linear graph.
 * @param branches   node indices of branch heads to include as layout heads
 *                   (IntelliJ adds these on top of the graph's own heads, so a
 *                   ref pointing mid-chain still seeds a fragment).
 * @param comparator orders heads by "importance" — the more important head is
 *                   processed first and reuses its color below a divergence.
 */
export function buildGraphLayout(
  graph: ILinearGraph,
  branches: Iterable<number>,
  comparator: (a: number, b: number) => number
): GraphLayout {
  const allHeads = new Set<number>(branches);
  for (const h of getHeads(graph)) {
    allHeads.add(h);
  }
  const sortedHeads = [...allHeads].sort(comparator);
  return buildFromSortedHeads(graph, sortedHeads);
}

function buildFromSortedHeads(graph: ILinearGraph, sortedHeads: readonly number[]): GraphLayout {
  const layoutIndex = new Array<number>(graph.nodesCount()).fill(0);
  const importantHeads: number[] = [];
  const state = { currentLayoutIndex: 1 };

  for (const head of sortedHeads) {
    if (layoutIndex[head] !== 0) {
      continue;
    }
    importantHeads.push(head);

    walk(head, (currentNode) => {
      const firstVisit = layoutIndex[currentNode] === 0;
      if (firstVisit) {
        layoutIndex[currentNode] = state.currentLayoutIndex;
      }
      const childWithoutLayoutIndex = graph
        .getDownNodes(currentNode)
        .find((it) => layoutIndex[it] === 0);
      if (childWithoutLayoutIndex === undefined) {
        if (firstVisit) {
          state.currentLayoutIndex++;
        }
        return Dfs.NextNode.NODE_NOT_FOUND;
      }
      return childWithoutLayoutIndex;
    });
  }

  return new GraphLayout(layoutIndex, importantHeads);
}

/**
 * Java `Arrays.binarySearch` semantics: returns the index of `key` if present,
 * else `-(insertionPoint) - 1`. The array must be ascending.
 */
export function binarySearch(sortedAscending: readonly number[], key: number): number {
  let low = 0;
  let high = sortedAscending.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const midVal = sortedAscending[mid];
    if (midVal < key) {
      low = mid + 1;
    } else if (midVal > key) {
      high = mid - 1;
    } else {
      return mid;
    }
  }
  return -(low + 1);
}
