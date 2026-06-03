/**
 * Optimized commit graph generation utilities.
 *
 * This module provides performance-optimized graph generation for large commit histories.
 * It uses incremental processing and efficient data structures to handle repositories
 * with thousands of commits.
 */

import { ICommit } from './interfaces/IGitService';
import { ICommitNode, IBranchRef, IGraphLine, getColumnColor } from './commitGraph';

/**
 * Configuration for optimized graph generation.
 */
export interface IGraphOptimizationConfig {
  /** Maximum number of active lanes to track (default: 50) */
  maxLanes?: number;
  /** Whether to use simplified graph for very large histories (default: true) */
  simplifyLargeGraphs?: boolean;
  /** Threshold for switching to simplified mode (default: 5000) */
  simplificationThreshold?: number;
  /** Whether to batch process commits (default: true) */
  batchProcessing?: boolean;
  /** Batch size for processing (default: 500) */
  batchSize?: number;
}

/**
 * Default optimization configuration.
 */
const DEFAULT_CONFIG: Required<IGraphOptimizationConfig> = {
  maxLanes: 50,
  simplifyLargeGraphs: true,
  simplificationThreshold: 5000,
  batchProcessing: true,
  batchSize: 500,
};

/**
 * Optimized lane state using more efficient data structures.
 */
interface IOptimizedLaneState {
  /** Map of commit hash to lane index */
  commitToLane: Map<string, number>;
  /** Array of lane availability (true = available) */
  laneAvailability: boolean[];
  /** Current number of active lanes */
  activeLaneCount: number;
  /** Maximum lane index used */
  maxLaneUsed: number;
}

/**
 * Create initial optimized lane state.
 */
function createLaneState(maxLanes: number): IOptimizedLaneState {
  return {
    commitToLane: new Map(),
    laneAvailability: Array.from({ length: maxLanes }, () => true),
    activeLaneCount: 0,
    maxLaneUsed: -1,
  };
}

/**
 * Find the next available lane efficiently.
 */
function findAvailableLane(state: IOptimizedLaneState): number {
  // First, try to find an available lane in the existing range
  for (let i = 0; i < state.laneAvailability.length; i++) {
    if (state.laneAvailability[i]) {
      return i;
    }
  }

  // If no lane available, extend the array
  const newLane = state.laneAvailability.length;
  state.laneAvailability.push(false);
  return newLane;
}

/**
 * Allocate a lane for a commit.
 */
function allocateLane(
  state: IOptimizedLaneState,
  commitHash: string,
  preferredLane?: number
): number {
  // If commit already has a lane, return it
  const existingLane = state.commitToLane.get(commitHash);
  if (existingLane !== undefined) {
    return existingLane;
  }

  // Try to use preferred lane if available
  let lane: number;
  if (
    preferredLane !== undefined &&
    preferredLane < state.laneAvailability.length &&
    state.laneAvailability[preferredLane]
  ) {
    lane = preferredLane;
  } else {
    lane = findAvailableLane(state);
  }

  // Mark lane as occupied
  state.laneAvailability[lane] = false;
  state.commitToLane.set(commitHash, lane);
  state.activeLaneCount++;
  state.maxLaneUsed = Math.max(state.maxLaneUsed, lane);

  return lane;
}

/**
 * Release a lane when a commit is processed.
 */
function releaseLane(state: IOptimizedLaneState, lane: number): void {
  if (lane < state.laneAvailability.length) {
    state.laneAvailability[lane] = true;
    state.activeLaneCount--;
  }
}

/**
 * Generate commit graph with optimizations for large histories.
 *
 * This function uses several optimizations:
 * 1. Efficient lane allocation using array-based availability tracking
 * 2. Early lane release to minimize active lanes
 * 3. Simplified graph mode for very large histories
 * 4. Batch processing support for incremental rendering
 *
 * @param commits - Array of commits in topological order (newest first)
 * @param branchMap - Optional map of commit hash to branch refs (name + type)
 * @param tagMap - Optional map of commit hash to tag names
 * @param config - Optimization configuration
 * @returns Array of commit nodes with graph visualization data
 */
export function generateOptimizedCommitGraph(
  commits: ICommit[],
  branchMap?: Map<string, IBranchRef[]>,
  tagMap?: Map<string, string[]>,
  config?: IGraphOptimizationConfig
): ICommitNode[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (commits.length === 0) {
    return [];
  }

  // Use simplified mode for very large histories
  if (cfg.simplifyLargeGraphs && commits.length > cfg.simplificationThreshold) {
    return generateSimplifiedGraph(commits, branchMap, tagMap, cfg);
  }

  return generateFullGraph(commits, branchMap, tagMap, cfg);
}

/**
 * Generate a full graph with all parent relationships.
 */
function generateFullGraph(
  commits: ICommit[],
  branchMap: Map<string, IBranchRef[]> | undefined,
  tagMap: Map<string, string[]> | undefined,
  config: Required<IGraphOptimizationConfig>
): ICommitNode[] {
  const result: ICommitNode[] = [];
  const state = createLaneState(config.maxLanes);

  // Build a set of all parent commits for efficient lookup
  const parentCommits = new Set<string>();
  for (const commit of commits) {
    for (const parent of commit.parents) {
      parentCommits.add(parent);
    }
  }

  // Build a map of commit hash to index for efficient lookup
  const commitIndex = new Map<string, number>();
  for (let i = 0; i < commits.length; i++) {
    commitIndex.set(commits[i].hash, i);
  }

  // Process each commit
  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];
    const graphLines: IGraphLine[] = [];

    // Allocate lane for this commit
    const column = allocateLane(state, commit.hash);

    // Process parents
    const parents = commit.parents;

    if (parents.length === 0) {
      // Root commit - release lane after processing
      // Lane will be released below
    } else if (parents.length === 1) {
      // Single parent - normal commit
      const parentHash = parents[0];
      const parentInList = commitIndex.has(parentHash);

      if (parentInList) {
        // Parent is in our commit list - allocate lane for it
        const parentLane = allocateLane(state, parentHash, column);

        graphLines.push({
          fromColumn: column,
          toColumn: parentLane,
          color: getColumnColor(column),
          type: 'commit',
        });
      }
    } else {
      // Merge commit - multiple parents
      for (let j = 0; j < parents.length; j++) {
        const parentHash = parents[j];
        const parentInList = commitIndex.has(parentHash);

        if (parentInList) {
          const parentLane = allocateLane(state, parentHash, j === 0 ? column : undefined);

          graphLines.push({
            fromColumn: column,
            toColumn: parentLane,
            color: getColumnColor(j === 0 ? column : parentLane),
            type: j === 0 ? 'commit' : 'merge',
          });
        }
      }
    }

    // Check if this commit's lane can be released
    // A lane can be released if this commit is not a parent of any later commit
    if (!parentCommits.has(commit.hash)) {
      releaseLane(state, column);
    }

    // Get branches and tags
    const branches = branchMap?.get(commit.hash) || [];
    const tags = tagMap?.get(commit.hash) || [];

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
 * Generate a simplified graph for very large histories.
 *
 * In simplified mode:
 * - Only first-parent relationships are shown
 * - Merge commits show a single line to first parent
 * - This significantly reduces visual complexity and processing time
 */
function generateSimplifiedGraph(
  commits: ICommit[],
  branchMap: Map<string, IBranchRef[]> | undefined,
  tagMap: Map<string, string[]> | undefined,
  config: Required<IGraphOptimizationConfig>
): ICommitNode[] {
  const result: ICommitNode[] = [];
  const state = createLaneState(config.maxLanes);

  // Build commit index for efficient lookup
  const commitIndex = new Map<string, number>();
  for (let i = 0; i < commits.length; i++) {
    commitIndex.set(commits[i].hash, i);
  }

  // In simplified mode, we only track first-parent relationships
  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];
    const graphLines: IGraphLine[] = [];

    // Allocate lane for this commit
    const column = allocateLane(state, commit.hash);

    // Only process first parent in simplified mode
    if (commit.parents.length > 0) {
      const firstParent = commit.parents[0];
      const parentInList = commitIndex.has(firstParent);

      if (parentInList) {
        const parentLane = allocateLane(state, firstParent, column);

        graphLines.push({
          fromColumn: column,
          toColumn: parentLane,
          color: getColumnColor(column),
          type: 'commit',
        });
      }
    }

    // Check if lane can be released
    // In simplified mode, check if this commit is a first parent of any commit
    let isFirstParent = false;
    for (let j = 0; j < i; j++) {
      if (commits[j].parents[0] === commit.hash) {
        isFirstParent = true;
        break;
      }
    }

    if (!isFirstParent) {
      releaseLane(state, column);
    }

    // Get branches and tags
    const branches = branchMap?.get(commit.hash) || [];
    const tags = tagMap?.get(commit.hash) || [];

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
 * Process commits in batches for incremental rendering.
 *
 * This is useful for showing partial results while processing large histories.
 *
 * @param commits - Array of commits to process
 * @param batchSize - Number of commits per batch
 * @param onBatch - Callback for each processed batch
 * @param branchMap - Optional branch map (commit hash → branch refs)
 * @param tagMap - Optional tag map
 */
export async function processCommitsInBatches(
  commits: ICommit[],
  batchSize: number,
  onBatch: (nodes: ICommitNode[], isComplete: boolean) => void,
  branchMap?: Map<string, IBranchRef[]>,
  tagMap?: Map<string, string[]>
): Promise<ICommitNode[]> {
  const allNodes: ICommitNode[] = [];
  const state = createLaneState(50);

  // Build parent set and commit index
  const parentCommits = new Set<string>();
  const commitIndex = new Map<string, number>();

  for (let i = 0; i < commits.length; i++) {
    commitIndex.set(commits[i].hash, i);
    for (const parent of commits[i].parents) {
      parentCommits.add(parent);
    }
  }

  // Process in batches
  for (let batchStart = 0; batchStart < commits.length; batchStart += batchSize) {
    const batchEnd = Math.min(batchStart + batchSize, commits.length);
    const batchNodes: ICommitNode[] = [];

    for (let i = batchStart; i < batchEnd; i++) {
      const commit = commits[i];
      const graphLines: IGraphLine[] = [];

      const column = allocateLane(state, commit.hash);

      // Process parents
      for (let j = 0; j < commit.parents.length; j++) {
        const parentHash = commit.parents[j];
        if (commitIndex.has(parentHash)) {
          const parentLane = allocateLane(state, parentHash, j === 0 ? column : undefined);
          graphLines.push({
            fromColumn: column,
            toColumn: parentLane,
            color: getColumnColor(j === 0 ? column : parentLane),
            type: j === 0 ? 'commit' : 'merge',
          });
        }
      }

      if (!parentCommits.has(commit.hash)) {
        releaseLane(state, column);
      }

      const node: ICommitNode = {
        commit,
        graphColumn: column,
        graphLines,
        branches: branchMap?.get(commit.hash) || [],
        tags: tagMap?.get(commit.hash) || [],
      };

      batchNodes.push(node);
      allNodes.push(node);
    }

    // Notify callback with batch results
    const isComplete = batchEnd >= commits.length;
    onBatch(batchNodes, isComplete);

    // Yield to allow UI updates
    if (!isComplete) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return allNodes;
}

/**
 * Calculate graph statistics for performance monitoring.
 */
export interface IGraphStats {
  /** Total number of commits */
  totalCommits: number;
  /** Maximum lane used */
  maxLanes: number;
  /** Number of merge commits */
  mergeCommits: number;
  /** Number of root commits */
  rootCommits: number;
  /** Average parents per commit */
  avgParents: number;
}

/**
 * Calculate statistics about a commit graph.
 *
 * @param commits - Array of commits
 * @returns Graph statistics
 */
export function calculateGraphStats(commits: ICommit[]): IGraphStats {
  let mergeCommits = 0;
  let rootCommits = 0;
  let totalParents = 0;

  for (const commit of commits) {
    totalParents += commit.parents.length;

    if (commit.parents.length === 0) {
      rootCommits++;
    } else if (commit.parents.length > 1) {
      mergeCommits++;
    }
  }

  return {
    totalCommits: commits.length,
    maxLanes: 0, // Will be calculated during graph generation
    mergeCommits,
    rootCommits,
    avgParents: commits.length > 0 ? totalParents / commits.length : 0,
  };
}

/**
 * Determine if a commit history should use simplified graph mode.
 *
 * @param commits - Array of commits
 * @param threshold - Threshold for switching to simplified mode
 * @returns True if simplified mode should be used
 */
export function shouldUseSimplifiedGraph(commits: ICommit[], threshold = 5000): boolean {
  return commits.length > threshold;
}
