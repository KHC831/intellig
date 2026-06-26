/**
 * Graph geometry config + lane-interval continuity helpers for IntelliJ-style
 * commit graph visualization.
 *
 * Provides the render config, column geometry, and the interval-model continuity
 * functions (computeActiveLanes / computeLaneContinuesFromAbove /
 * computeLaneContinuesBelow / collectMergedLaneIntervals) that the graph PRINT
 * MODEL (src/git-core/graph/printModel.ts) builds on. The per-row SVG painter
 * lives in src/git-core/graph/graphPainter.ts.
 */

import { ICommitNode, getMaxGraphColumn } from '../git-core/commitGraph';

/**
 * Configuration for graph rendering dimensions and styling.
 *
 * Controls the pixel spacing, node sizing, and line widths used
 * when generating SVG markup for the commit graph.
 */
export interface IGraphRenderConfig {
  /** Pixels between adjacent lanes (default: 20) */
  columnWidth: number;
  /** Pixels per commit row height (default: 32) */
  rowHeight: number;
  /** Commit circle radius in pixels (default: 6) */
  nodeRadius: number;
  /** Horizontal padding on each side of the graph area in pixels (default: 10) */
  padding: number;
  /** Stroke width for all lines in pixels (default: 2) */
  lineWidth: number;
}

/**
 * Active lanes per row — maps row index to the set of lane indices
 * that are active (have a line passing through) at that row.
 *
 * Computed once by computeActiveLanes() and used for all row renders.
 */
export type ActiveLaneMap = Map<number, Set<number>>;

/**
 * Default graph rendering configuration matching IntelliJ IDEA's style.
 *
 * - columnWidth: 20px between lanes
 * - rowHeight: 32px per row
 * - nodeRadius: 3.5px commit circles
 * - padding: 10px horizontal padding
 * - lineWidth: 2px stroke width
 */
export const DEFAULT_GRAPH_CONFIG: IGraphRenderConfig = {
  columnWidth: 20,
  rowHeight: 24,
  // 3.5px commit dot — IntelliJ-snug against the 2px line. (Was briefly 5px,
  // which read as oversized vs IntelliJ's tighter nodes.)
  nodeRadius: 3.5,
  padding: 10,
  lineWidth: 2,
};

/**
 * Compute the x-coordinate (center) for a given graph column.
 *
 * The x position is calculated so that each column is evenly spaced
 * with padding on the left side, and the node is centered within
 * its column slot.
 *
 * Formula: column * columnWidth + padding + columnWidth / 2
 *
 * @param column - The graph column index (0-based lane index)
 * @param config - The graph render configuration
 * @returns The x-coordinate in pixels for the center of the given column
 */
export function getColumnX(column: number, config: IGraphRenderConfig): number {
  return column * config.columnWidth + config.padding + config.columnWidth / 2;
}

/**
 * Compute the set of active lanes at each row index.
 *
 * A lane is "active" at row `i` if it has been introduced (by a commit's
 * graphColumn or a graphLine's toColumn) at or before row `i`, and its
 * target commit appears at or after row `i`.
 *
 * The nodes array is in topological order (newest first), so row 0 is the
 * most recent commit and higher row indices are older commits.
 *
 * Algorithm:
 * 1. Build a hash-to-row-index map so we can look up where each parent commit is
 * 2. For each row, collect all "lane intervals" — each interval is a (lane, startRow, endRow)
 *    tuple representing a lane that is active from startRow through endRow
 * 3. A commit's own graphColumn creates an interval at that single row (unless extended by lines)
 * 4. Each graphLine's toColumn creates an interval from the current row to the row where
 *    the target parent commit appears
 * 5. Build the ActiveLaneMap by iterating through all intervals
 *
 * @param nodes - Array of ICommitNode in topological order (newest first)
 * @returns Map from row index to the set of active lane indices at that row
 */
export function collectMergedLaneIntervals(
  nodes: ICommitNode[]
): Map<number, Array<{ startRow: number; endRow: number }>> {
  if (nodes.length === 0) {
    return new Map();
  }

  // Build a hash-to-row-index map for quick parent row lookups
  const hashToRow = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) {
    hashToRow.set(nodes[i].commit.hash, i);
  }

  // Collect all lane intervals: [laneIndex, startRow, endRow]
  // A lane interval means the lane is active from startRow through endRow (inclusive)
  const intervals: Array<{ lane: number; startRow: number; endRow: number }> = [];

  for (let rowIndex = 0; rowIndex < nodes.length; rowIndex++) {
    const node = nodes[rowIndex];

    // The commit's own graphColumn is active at this row.
    // It's at minimum active at just this row.
    // But if there are graphLines with fromColumn === graphColumn that go to a later row,
    // those will be captured by the graphLine intervals below.
    // We still need to ensure the commit's column is active at this row even if there are no lines.
    intervals.push({ lane: node.graphColumn, startRow: rowIndex, endRow: rowIndex });

    // Each graphLine represents a connection from this commit to a parent.
    // The toColumn lane should be active from this row to the parent's row.
    for (const line of node.graphLines) {
      // FAR-PARENT FORK-POINT BEND: the algorithm marks
      // a first-parent line whose parent is far below on a different lane
      // with `endRow=parentRow`. The source lane runs as straight-down ink
      // at rows `[rowIndex .. endRow-1]`; we deliberately do NOT mark the
      // source lane at `endRow` (that would re-introduce the orphan-stroke
      // invariant violation — the bend itself lives at the parent row and
      // is inked by the parent's own `graphColumn`). Skip the rest of the
      // generic resolution for these lines.
      if (line.endRow !== undefined) {
        if (line.endRow > rowIndex) {
          intervals.push({
            lane: line.fromColumn,
            startRow: rowIndex,
            endRow: line.endRow - 1,
          });
        } else {
          intervals.push({ lane: line.fromColumn, startRow: rowIndex, endRow: rowIndex });
        }
        continue;
      }

      // OFF-WINDOW FIRST-PARENT MAINLINE CONTINUATION. A first-parent
      // (`type: 'commit'`) same-lane dashed stub means the mainline's parent
      // fell off the loaded window. It is a CONTINUATION (trunk continues
      // BELOW the slice) only when this commit also has an in-window parent —
      // i.e. a merge whose merged side branch occupies the rows below. In that
      // case the lane is reserved (generateCommitGraph never frees it), so
      // mark it active straight down to the window bottom: the trunk renders
      // as one unbroken column instead of collapsing to a half-row stub at
      // this row (the gap the moment the row below sat on the side branch).
      //
      // When ALL of this commit's parents are off-window it is a genuine LEAF
      // (its lane ends here); it is NOT extended and stays a short dashed
      // stub at its own row — identical at any row, bottom or not. A
      // second-parent off-window stub (`type: 'merge'`) is likewise never a
      // continuation.
      if (
        line.type === 'commit' &&
        line.style === 'dashed' &&
        line.fromColumn === line.toColumn &&
        node.commit.parents.some((p) => hashToRow.has(p))
      ) {
        intervals.push({ lane: line.fromColumn, startRow: rowIndex, endRow: nodes.length - 1 });
        continue;
      }

      // Find the target parent commit's row
      // The parent hash is the commit that sits at toColumn.
      // We need to find which parent this line points to.
      // The line goes from fromColumn to toColumn, and the parent is at a later row.
      // We look through the commit's parents to find which one is at toColumn.
      let targetRow = rowIndex; // default: just this row if parent not found

      // Find the parent commit that this line targets
      for (const parentHash of node.commit.parents) {
        const parentRow = hashToRow.get(parentHash);
        if (parentRow !== undefined) {
          // Check if this parent's graphColumn matches the toColumn of this line
          if (nodes[parentRow].graphColumn === line.toColumn) {
            targetRow = parentRow;
            break;
          }
        }
      }

      // If we didn't find a parent whose graphColumn matches toColumn, fall
      // back to the parent that sits on `toColumn` if any, else leave
      // targetRow at rowIndex (no vertical extent). We deliberately do NOT
      // pick "any later parent regardless of column" — that mis-attributed
      // a line to an unrelated parent far down the window and extended the
      // lane interval across mainline rows it never touched. If no parent
      // owns toColumn, the line is a short same-row connector (e.g. an
      // off-window stub) and needs no multi-row interval.
      if (targetRow === rowIndex) {
        for (const parentHash of node.commit.parents) {
          const parentRow = hashToRow.get(parentHash);
          if (
            parentRow !== undefined &&
            parentRow > rowIndex &&
            nodes[parentRow].graphColumn === line.toColumn
          ) {
            targetRow = parentRow;
            break;
          }
        }
      }

      // The fromColumn lane's vertical extent depends on whether the line
      // BENDS. A same-lane line (fromColumn === toColumn) runs straight
      // down its column from this row to the parent's row, so fromColumn is
      // active across the whole span. A BENDING line (fromColumn !==
      // toColumn) is drawn as a bezier that leaves fromColumn at this row's
      // center and curves over to toColumn by this row's BOTTOM — the
      // source lane has NO vertical presence at any later row. Marking
      // fromColumn active down to the parent's row (the old behaviour)
      // painted a full-height pass-through stroke for the source lane
      // through rows where that branch no longer exists — the reported
      // "orphan vertical line in a side-lane colour running through the
      // mainline" artifact (and the node-vs-line colour mismatch, since
      // that stroke is a different colour than those rows' nodes). For a
      // bending line the source lane is active at the source row ONLY.
      if (line.fromColumn === line.toColumn) {
        if (targetRow > rowIndex) {
          intervals.push({ lane: line.fromColumn, startRow: rowIndex, endRow: targetRow });
        }
      } else {
        // Bending line: source lane present only at the source row.
        intervals.push({ lane: line.fromColumn, startRow: rowIndex, endRow: rowIndex });
      }

      // The toColumn lane is active from this row to the target row — the
      // destination lane genuinely runs down to the parent.
      if (targetRow >= rowIndex) {
        intervals.push({ lane: line.toColumn, startRow: rowIndex, endRow: targetRow });
      }
    }
  }

  // Build the ActiveLaneMap from all intervals
  // For each row, collect all lanes that have an interval covering that row
  // To do this efficiently, we merge intervals per lane and then iterate

  // Group intervals by lane
  const laneIntervals = new Map<number, Array<{ startRow: number; endRow: number }>>();
  for (const interval of intervals) {
    if (!laneIntervals.has(interval.lane)) {
      laneIntervals.set(interval.lane, []);
    }
    laneIntervals.get(interval.lane)!.push({
      startRow: interval.startRow,
      endRow: interval.endRow,
    });
  }

  // Merge overlapping/adjacent intervals per lane. NOTE: two intervals that
  // are merely ADJACENT but represent DIFFERENT lines (a lane reused one row
  // after a previous line bent away) do NOT overlap (the second's startRow is
  // strictly greater than the first's endRow), so they stay SEPARATE — which is
  // what `computeLaneContinuesFromAbove` relies on to tell a reused lane apart
  // from a genuine through-line.
  const mergedByLane = new Map<number, Array<{ startRow: number; endRow: number }>>();
  for (const [lane, rawIntervals] of laneIntervals) {
    rawIntervals.sort((a, b) => a.startRow - b.startRow);
    const merged: Array<{ startRow: number; endRow: number }> = [];
    for (const interval of rawIntervals) {
      if (merged.length > 0 && interval.startRow <= merged[merged.length - 1].endRow) {
        merged[merged.length - 1].endRow = Math.max(
          merged[merged.length - 1].endRow,
          interval.endRow
        );
      } else {
        merged.push({ startRow: interval.startRow, endRow: interval.endRow });
      }
    }
    mergedByLane.set(lane, merged);
  }
  return mergedByLane;
}

/**
 * Active lanes per row index: every row covered by any lane's merged interval.
 */
export function computeActiveLanes(nodes: ICommitNode[]): ActiveLaneMap {
  const result: ActiveLaneMap = new Map();
  for (let i = 0; i < nodes.length; i++) {
    result.set(i, new Set());
  }
  for (const [lane, merged] of collectMergedLaneIntervals(nodes)) {
    for (const iv of merged) {
      for (let row = iv.startRow; row <= iv.endRow; row++) {
        result.get(row)!.add(lane);
      }
    }
  }
  return result;
}

/**
 * Per row, the lanes that CONTINUE from the row above as the SAME line — i.e.
 * the row is strictly inside a merged interval (not its first row). A lane that
 * is merely REUSED by an unrelated line one row down starts a NEW interval and
 * is NOT reported here, letting the renderer distinguish a genuine transiting
 * through-line at a branch-split row from a reused lane.
 */
export function computeLaneContinuesFromAbove(nodes: ICommitNode[]): ActiveLaneMap {
  const result: ActiveLaneMap = new Map();
  for (let i = 0; i < nodes.length; i++) {
    result.set(i, new Set());
  }
  for (const [lane, merged] of collectMergedLaneIntervals(nodes)) {
    for (const iv of merged) {
      for (let row = iv.startRow + 1; row <= iv.endRow; row++) {
        result.get(row)!.add(lane);
      }
    }
  }
  return result;
}

/**
 * Per row, the lanes that CONTINUE into the row below as the SAME line — i.e.
 * the row is covered by a merged interval but is NOT its last row. Mirror of
 * {@link computeLaneContinuesFromAbove}: `continuesBelow(i)` ===
 * `continuesFromAbove(i + 1)` for the same lane. A lane merely REUSED by an
 * unrelated line one row down starts a NEW interval, so its last row reports
 * `false` here — letting the renderer truncate a dying lane cleanly instead of
 * mistaking the reused line below for a continuation.
 */
export function computeLaneContinuesBelow(nodes: ICommitNode[]): ActiveLaneMap {
  const result: ActiveLaneMap = new Map();
  for (let i = 0; i < nodes.length; i++) {
    result.set(i, new Set());
  }
  for (const [lane, merged] of collectMergedLaneIntervals(nodes)) {
    for (const iv of merged) {
      for (let row = iv.startRow; row <= iv.endRow - 1; row++) {
        result.get(row)!.add(lane);
      }
    }
  }
  return result;
}

/**
 * Compute the total pixel width needed for the graph column.
 *
 * Uses the maximum lane index across all nodes (considering graphColumn
 * and all graphLine fromColumn/toColumn values) to determine how wide
 * the graph SVG needs to be.
 *
 * Formula: (maxColumn + 1) * columnWidth + padding * 2
 *
 * @param nodes - Array of ICommitNode to measure
 * @param config - The graph render configuration
 * @returns The total width in pixels, or 0 if the nodes array is empty
 */
export function computeGraphWidth(nodes: ICommitNode[], config: IGraphRenderConfig): number {
  if (nodes.length === 0) {
    return 0;
  }
  const maxCol = getMaxGraphColumn(nodes);
  return (maxCol + 1) * config.columnWidth + config.padding * 2;
}

/**
 * Check whether a lane index is valid for rendering.
 *
 * Out-of-bounds lane indices (negative or exceeding 1000) are skipped
 * gracefully to avoid rendering errors.
 *
 * @param lane - The lane index to validate
 * @returns True if the lane index is valid for rendering
 */
export function isValidLane(lane: number): boolean {
  return Number.isFinite(lane) && lane >= 0 && lane <= 1000;
}
