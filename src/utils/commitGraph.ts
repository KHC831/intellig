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
 * Generate commit graph data from a list of commits.
 *
 * This function processes commits in topological order (newest first) and assigns
 * each commit to a lane (column). It generates graph lines showing the connections
 * between commits and their parents.
 *
 * The algorithm:
 * 1. Process commits from newest to oldest
 * 2. Assign each commit to a lane based on its first parent's lane or a new lane
 * 3. Generate lines connecting commits to their parents
 * 4. Handle merge commits by creating multiple lines to different parent lanes
 *
 * @param commits - Array of commits in topological order (newest first)
 * @param branchMap - Optional map of commit hash to branch names
 * @param tagMap - Optional map of commit hash to tag names
 * @returns Array of commit nodes with graph visualization data
 */
export function generateCommitGraph(
  commits: ICommit[],
  branchMap?: Map<string, string[]>,
  tagMap?: Map<string, string[]>
): ICommitNode[] {
  if (commits.length === 0) {
    return [];
  }

  const result: ICommitNode[] = [];
  const state: ILaneState = {
    commitToLane: new Map(),
    activeLanes: new Set(),
    nextLane: 0,
  };

  // First pass: assign lanes to all commits based on parent relationships
  // We need to know which commits are parents to properly assign lanes
  const parentCommits = new Set<string>();
  for (const commit of commits) {
    for (const parent of commit.parents) {
      parentCommits.add(parent);
    }
  }

  // Process each commit
  for (const commit of commits) {
    const commitHash = commit.hash;
    let column: number;
    const graphLines: IGraphLine[] = [];

    // Check if this commit already has a lane assigned (from being a parent)
    if (state.commitToLane.has(commitHash)) {
      column = state.commitToLane.get(commitHash)!;
    } else {
      // Assign a new lane for this commit
      column = findNextAvailableLane(state);
      state.commitToLane.set(commitHash, column);
      if (column >= state.nextLane) {
        state.nextLane = column + 1;
      }
    }

    // Mark this lane as active
    state.activeLanes.add(column);

    // Process parents and create graph lines
    const parents = commit.parents;

    if (parents.length === 0) {
      // Root commit - no lines to draw, but we can free the lane
      // The lane will be freed after this commit is processed
    } else if (parents.length === 1) {
      // Single parent - normal commit
      const parentHash = parents[0];
      let parentLane: number;

      if (state.commitToLane.has(parentHash)) {
        parentLane = state.commitToLane.get(parentHash)!;
      } else {
        // Parent not yet seen, assign it to the same lane as this commit
        parentLane = column;
        state.commitToLane.set(parentHash, parentLane);
      }

      graphLines.push({
        fromColumn: column,
        toColumn: parentLane,
        color: getColumnColor(column),
        type: 'commit',
      });
    } else {
      // Merge commit - multiple parents
      for (let i = 0; i < parents.length; i++) {
        const parentHash = parents[i];
        let parentLane: number;

        if (state.commitToLane.has(parentHash)) {
          parentLane = state.commitToLane.get(parentHash)!;
        } else {
          if (i === 0) {
            // First parent (main line) - keep in same lane
            parentLane = column;
          } else {
            // Other parents (merged branches) - assign new lanes
            parentLane = findNextAvailableLane(state);
            if (parentLane >= state.nextLane) {
              state.nextLane = parentLane + 1;
            }
          }
          state.commitToLane.set(parentHash, parentLane);
          state.activeLanes.add(parentLane);
        }

        graphLines.push({
          fromColumn: column,
          toColumn: parentLane,
          color: getColumnColor(i === 0 ? column : parentLane),
          type: i === 0 ? 'commit' : 'merge',
        });
      }
    }

    // Check if this commit is not a parent of any other commit in our list
    // If so, we can potentially free its lane after processing
    if (!parentCommits.has(commitHash)) {
      // This is a tip commit (no children in our list)
      // The lane can be freed for reuse by subsequent commits
      // But we keep it active for now as we process in reverse order
    }

    // Get branches and tags for this commit
    const branches = branchMap?.get(commitHash) || [];
    const tags = tagMap?.get(commitHash) || [];

    result.push({
      commit,
      graphColumn: column,
      graphLines,
      branches,
      tags,
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
