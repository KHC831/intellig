/**
 * Commit graph generation utilities.
 *
 * This module provides functionality to generate visual graph data from commit history,
 * showing branch and merge relationships. Each commit is assigned a column position
 * (lane) and lines connecting to parent commits.
 */

import { ICommit } from '../services/interfaces/IGitService';

/**
 * Represents a line in the commit graph connecting commits.
 */
export interface IGraphLine {
  /** Starting column (lane) of the line */
  fromColumn: number;
  /** Ending column (lane) of the line */
  toColumn: number;
  /** Color identifier for the line (used for visual distinction) */
  color: string;
  /** Type of line: commit (normal), merge (from merge commit), or branch (new branch) */
  type: 'commit' | 'merge' | 'branch';
}

/**
 * Represents a commit with its graph visualization data.
 */
export interface ICommitNode {
  /** The underlying commit data */
  commit: ICommit;
  /** Column position (lane) where this commit is displayed */
  graphColumn: number;
  /** Lines connecting this commit to its parents */
  graphLines: IGraphLine[];
  /** Branch names pointing to this commit */
  branches: string[];
  /** Tag names pointing to this commit */
  tags: string[];
  /**
   * Wave D / D3 — true when this commit lies on the BFS path from the
   * currently-focused branch tip back to its merge-base with HEAD. The
   * renderer brightens on-path lines / commit circles and dims off-path
   * ones (full IntelliJ parity). When no branch is focused, every node has
   * `onFocusedBranchPath: false` and the renderer treats it as a no-op.
   */
  onFocusedBranchPath?: boolean;
}

/**
 * Color palette for graph lines.
 * Colors are assigned to lanes to visually distinguish different branches.
 */
const GRAPH_COLORS = [
  '#4CAF50', // Green
  '#2196F3', // Blue
  '#FF9800', // Orange
  '#9C27B0', // Purple
  '#F44336', // Red
  '#00BCD4', // Cyan
  '#FFEB3B', // Yellow
  '#E91E63', // Pink
  '#795548', // Brown
  '#607D8B', // Blue Grey
];

/**
 * Get a color for a given column index.
 *
 * @param column - The column index
 * @returns A color string from the palette
 */
export function getColumnColor(column: number): string {
  return GRAPH_COLORS[column % GRAPH_COLORS.length];
}

/**
 * Internal state for tracking active lanes during graph generation.
 */
interface ILaneState {
  /** Map of commit hash to lane (column) index */
  commitToLane: Map<string, number>;
  /** Set of currently active lane indices */
  activeLanes: Set<number>;
  /** Next available lane index */
  nextLane: number;
}

/**
 * Find the next available lane (column) for a new branch.
 *
 * @param state - Current lane state
 * @returns The next available lane index
 */
function findNextAvailableLane(state: ILaneState): number {
  // Try to find a gap in active lanes first
  for (let i = 0; i < state.nextLane; i++) {
    if (!state.activeLanes.has(i)) {
      return i;
    }
  }
  // No gap found, use the next lane
  return state.nextLane;
}

/**
 * Wave D / D1 — children pre-pass.
 *
 * Build a map of `parentHash → array of child hashes in display order` so
 * the main pass can ask "is THIS commit the first-seen child of `parent`?"
 * Without this pre-pass the single-pass algorithm collapses divergent
 * branches that share an unseen parent: the SECOND child of a parent gets
 * its parent's lane unconditionally, which puts it on top of the first
 * child's lane.
 *
 * Display order matters — we record children in the same newest-first
 * order the main pass consumes commits, so `firstChild = arr[0]` gives the
 * topologically-newest child of each parent.
 *
 * @param commits - Array of commits in topological order (newest first)
 * @returns Map of parent hash → array of child hashes (newest-first)
 */
export function buildChildrenMap(commits: ICommit[]): Map<string, string[]> {
  const childrenMap = new Map<string, string[]>();
  for (const commit of commits) {
    for (const parent of commit.parents) {
      const arr = childrenMap.get(parent);
      if (arr) {
        // Wave D R1 / Senior L-3 — defensive dedupe. A corrupt object
        // store can produce a commit listing the same parent twice; if
        // we let it slip through, the same child appears twice in the
        // children list and the first-seen check is a no-op for the
        // duplicated parent slot. Cheap O(arr.length) per push; arr is
        // tiny in any non-pathological repo.
        if (arr.includes(commit.hash)) {
          continue;
        }
        arr.push(commit.hash);
      } else {
        childrenMap.set(parent, [commit.hash]);
      }
    }
  }
  return childrenMap;
}

/**
 * Generate commit graph data from a list of commits.
 *
 * This function processes commits in topological order (newest first) and assigns
 * each commit to a lane (column). It generates graph lines showing the connections
 * between commits and their parents.
 *
 * Wave D / D1 — children-map two-pass algorithm. The pre-pass records each
 * parent's children in display order; the main pass uses that to decide
 * whether the current commit's parent inherits the current lane (only when
 * THIS commit is the parent's first-seen child AND it is the parent's
 * first parent slot, i.e. straight-down inheritance) or claims a brand
 * new lane (any other case — divergent fork).
 *
 * Wave D / D3 — `focusedPathHashes` is the optional set of commit hashes
 * on the BFS path from the focused branch tip to its merge-base with
 * HEAD. Each `ICommitNode` is annotated with `onFocusedBranchPath` (true
 * when its hash is in the set, false otherwise — including when the set
 * is undefined or empty). The renderer reads this flag and the
 * `hasFocusedBranch` global to brighten on-path / dim off-path lines.
 *
 * The algorithm:
 * 1. Pre-pass: build childrenMap (parent hash → array of child hashes in display order).
 * 2. Main pass: for each commit, claim a lane (inherit if pre-claimed by an earlier
 *    child, else allocate next available); for each parent, decide whether to inherit
 *    this commit's lane (first-child + first-parent) or claim a new lane (divergence).
 * 3. Tag every node with `onFocusedBranchPath` for the renderer.
 *
 * @param commits - Array of commits in topological order (newest first)
 * @param branchMap - Optional map of commit hash to branch names
 * @param tagMap - Optional map of commit hash to tag names
 * @param focusedPathHashes - Optional set of commit hashes on the focused
 *   branch's path-to-merge-base (Wave D / D3). When `undefined` or empty,
 *   every node's `onFocusedBranchPath` is `false`.
 * @returns Array of commit nodes with graph visualization data
 */
export function generateCommitGraph(
  commits: ICommit[],
  branchMap?: Map<string, string[]>,
  tagMap?: Map<string, string[]>,
  focusedPathHashes?: Set<string>
): ICommitNode[] {
  if (commits.length === 0) {
    return [];
  }

  // PRE-PASS — children-map: parent hash → array of child hashes in
  // display order. A parent's "first-seen" child is `childrenMap[parent][0]`.
  const childrenMap = buildChildrenMap(commits);

  const result: ICommitNode[] = [];
  const state: ILaneState = {
    commitToLane: new Map(),
    activeLanes: new Set(),
    nextLane: 0,
  };

  // Helper that allocates a brand-new lane and bumps `nextLane` so the
  // next allocation never collides with the one we just handed out.
  const allocateLane = (): number => {
    const lane = findNextAvailableLane(state);
    if (lane >= state.nextLane) {
      state.nextLane = lane + 1;
    }
    return lane;
  };

  // MAIN PASS — claim lanes + emit graph lines.
  for (const commit of commits) {
    const commitHash = commit.hash;
    const graphLines: IGraphLine[] = [];

    // --- Step A: claim a lane for THIS commit ---
    // If a prior child already pre-claimed our lane (because we were
    // their first-seen-child target), inherit it; otherwise allocate.
    let column: number;
    if (state.commitToLane.has(commitHash)) {
      column = state.commitToLane.get(commitHash)!;
    } else {
      column = allocateLane();
      state.commitToLane.set(commitHash, column);
    }
    state.activeLanes.add(column);

    // --- Step B: decide each parent's lane and emit a graph line ---
    const parents = commit.parents;
    for (let i = 0; i < parents.length; i++) {
      const parentHash = parents[i];
      let parentLane: number;

      if (state.commitToLane.has(parentHash)) {
        // Already claimed — either by an earlier sibling (the common
        // ancestor in a fork-then-merge) or by an even earlier prior
        // commit. Use the existing lane.
        parentLane = state.commitToLane.get(parentHash)!;
      } else {
        // KEY CHANGE (D1) — only inherit our lane if WE are the parent's
        // first-seen child in display order AND we're the parent's first
        // parent slot. Anything else is a divergent fork that needs a
        // brand-new lane.
        const firstChildOfParent = childrenMap.get(parentHash)?.[0];
        if (firstChildOfParent === commitHash && i === 0) {
          parentLane = column; // straight-down inheritance
        } else {
          parentLane = allocateLane();
        }
        state.commitToLane.set(parentHash, parentLane);
        state.activeLanes.add(parentLane);
      }

      graphLines.push({
        fromColumn: column,
        toColumn: parentLane,
        // Merge / branch lines (i > 0) take the destination lane's color
        // so they read as "joining the merged branch's color"; the main
        // line uses the current commit's lane color.
        color: getColumnColor(i === 0 ? column : parentLane),
        type: i === 0 ? 'commit' : 'merge',
      });
    }

    const branches = branchMap?.get(commitHash) || [];
    const tags = tagMap?.get(commitHash) || [];
    const onFocusedBranchPath = focusedPathHashes?.has(commitHash) ?? false;

    result.push({
      commit,
      graphColumn: column,
      graphLines,
      branches,
      tags,
      onFocusedBranchPath,
    });
  }

  return result;
}

/**
 * Compute the set of commit hashes that are terminal nodes (branch tips).
 * A terminal node is a commit that is NOT a parent of any other commit in the graph.
 *
 * @param nodes - Array of commit nodes
 * @returns Set of commit hashes that have no children in the graph
 */
export function computeTerminalNodes(nodes: ICommitNode[]): Set<string> {
  // Build a set of all hashes that appear as parents of other commits
  const parentHashes = new Set<string>();
  for (const node of nodes) {
    for (const parentHash of node.commit.parents) {
      parentHashes.add(parentHash);
    }
  }

  // Terminal nodes are commits whose hash does NOT appear as a parent
  const terminalNodes = new Set<string>();
  for (const node of nodes) {
    if (!parentHashes.has(node.commit.hash)) {
      terminalNodes.add(node.commit.hash);
    }
  }

  return terminalNodes;
}

/**
 * Build a map of commit hash -> number of child commits in the graph.
 * For each commit, counts how many other commits in the graph list it as a parent.
 *
 * @param nodes - Array of commit nodes
 * @returns Map of commit hash to child count
 */
export function computeChildCountMap(nodes: ICommitNode[]): Map<string, number> {
  const childCountMap = new Map<string, number>();

  for (const node of nodes) {
    for (const parentHash of node.commit.parents) {
      const currentCount = childCountMap.get(parentHash) || 0;
      childCountMap.set(parentHash, currentCount + 1);
    }
  }

  return childCountMap;
}

/**
 * Determine if a commit is a branch split point.
 * A branch split occurs when a commit's hash appears as a parent
 * of more than one other commit in the loaded graph.
 *
 * @param commitHash - The hash of the commit to check
 * @param childCountMap - Map of commit hash to child count (from computeChildCountMap)
 * @returns True if the commit has more than one child in the graph
 */
export function isBranchSplit(commitHash: string, childCountMap: Map<string, number>): boolean {
  const count = childCountMap.get(commitHash) || 0;
  return count > 1;
}

/**
 * Calculate the maximum column (lane) used in the graph.
 * Useful for determining the width needed to render the graph.
 *
 * @param nodes - Array of commit nodes
 * @returns The maximum column index used, or -1 if empty
 */
export function getMaxGraphColumn(nodes: ICommitNode[]): number {
  if (nodes.length === 0) {
    return -1;
  }

  let maxColumn = 0;
  for (const node of nodes) {
    maxColumn = Math.max(maxColumn, node.graphColumn);
    for (const line of node.graphLines) {
      maxColumn = Math.max(maxColumn, line.fromColumn, line.toColumn);
    }
  }

  return maxColumn;
}

/**
 * Check if a commit is a merge commit (has multiple parents).
 *
 * @param commit - The commit to check
 * @returns True if the commit has more than one parent
 */
export function isMergeCommit(commit: ICommit): boolean {
  return commit.parents.length > 1;
}

/**
 * Classify a branch name as local or remote.
 * A branch is considered remote if it contains a '/' character, indicating
 * it is a remote tracking branch (e.g., "origin/main", "upstream/develop").
 * Otherwise it is classified as local (e.g., "main", "develop", "feature-branch").
 *
 * @param name - The branch name to classify
 * @returns 'remote' if the branch name contains a '/', 'local' otherwise
 */
export function classifyBranchName(name: string): 'local' | 'remote' {
  return name.includes('/') ? 'remote' : 'local';
}

/**
 * Check if a commit is a root commit (has no parents).
 *
 * @param commit - The commit to check
 * @returns True if the commit has no parents
 */
export function isRootCommit(commit: ICommit): boolean {
  return commit.parents.length === 0;
}

/**
 * Get the number of active lanes at a given commit.
 * This represents how many parallel branches are visible at that point.
 *
 * @param nodes - Array of commit nodes up to and including the target
 * @param index - Index of the target commit in the nodes array
 * @returns Number of active lanes
 */
export function getActiveLaneCount(nodes: ICommitNode[], index: number): number {
  if (index < 0 || index >= nodes.length) {
    return 0;
  }

  const activeLanes = new Set<number>();

  // Collect all lanes used up to this point
  for (let i = 0; i <= index; i++) {
    const node = nodes[i];
    activeLanes.add(node.graphColumn);
    for (const line of node.graphLines) {
      activeLanes.add(line.toColumn);
    }
  }

  return activeLanes.size;
}

/**
 * Compute a map of parent commit hash → Set of child commit graph columns.
 * For each commit that appears as a parent of another commit, records which
 * columns (lanes) the child commits occupy.
 *
 * This is used to draw split curves on the parent's row showing lines
 * diverging from the parent node up to the child lanes.
 *
 * @param nodes - Array of commit nodes
 * @returns Map of parent hash to set of child column indices
 */
export function computeChildLanesMap(nodes: ICommitNode[]): Map<string, Set<number>> {
  const childLanesMap = new Map<string, Set<number>>();

  for (const node of nodes) {
    for (const parentHash of node.commit.parents) {
      if (!childLanesMap.has(parentHash)) {
        childLanesMap.set(parentHash, new Set());
      }
      childLanesMap.get(parentHash)!.add(node.graphColumn);
    }
  }

  return childLanesMap;
}
