/**
 * Graph renderer utilities for IntelliJ-style commit graph visualization.
 *
 * This module provides types, configuration, and rendering functions for
 * converting ICommitNode[] data into SVG markup for each commit row,
 * including pass-through lanes and inter-row connections.
 *
 * Requirements: 4.1, 4.2, 4.4, 5.1, 7.1, 2.1, 2.2
 */

import { ICommitNode, getMaxGraphColumn, getColumnColor } from './commitGraph';

/**
 * Configuration for graph rendering dimensions and styling.
 *
 * Controls the pixel spacing, node sizing, and line widths used
 * when generating SVG markup for the commit graph.
 */
export interface IGraphRenderConfig {
  /** Pixels between adjacent lanes (default: 20). Requirement 4.1 */
  columnWidth: number;
  /** Pixels per commit row height (default: 32). Requirement 4.2 */
  rowHeight: number;
  /** Commit circle radius in pixels (default: 6) */
  nodeRadius: number;
  /** Horizontal padding on each side of the graph area in pixels (default: 10). Requirement 4.4 */
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
 * - columnWidth: 20px between lanes (Requirement 4.1: at least 20px)
 * - rowHeight: 32px per row (Requirement 4.2: at least 32px)
 * - nodeRadius: 6px commit circles
 * - padding: 10px horizontal padding (Requirement 4.4: at least 10px)
 * - lineWidth: 2px stroke width
 */
export const DEFAULT_GRAPH_CONFIG: IGraphRenderConfig = {
  columnWidth: 20,
  rowHeight: 32,
  nodeRadius: 6,
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
 *
 * Requirements: 5.1 (deterministic lane positioning)
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
 *
 * Requirements: 7.1, 2.1, 2.2
 */
export function computeActiveLanes(nodes: ICommitNode[]): ActiveLaneMap {
  const result: ActiveLaneMap = new Map();

  if (nodes.length === 0) {
    return result;
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

      // If we didn't find a matching parent by graphColumn, try to find any parent
      // at a later row that could be the target (fallback for edge cases)
      if (targetRow === rowIndex) {
        for (const parentHash of node.commit.parents) {
          const parentRow = hashToRow.get(parentHash);
          if (parentRow !== undefined && parentRow > rowIndex) {
            targetRow = parentRow;
            break;
          }
        }
      }

      // The fromColumn lane is active from this row to the target row
      if (targetRow > rowIndex) {
        intervals.push({ lane: line.fromColumn, startRow: rowIndex, endRow: targetRow });
      }

      // The toColumn lane is active from this row to the target row
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

  // Initialize result map with empty sets for each row
  for (let i = 0; i < nodes.length; i++) {
    result.set(i, new Set());
  }

  // For each lane, merge overlapping intervals and mark rows as active
  for (const [lane, rawIntervals] of laneIntervals) {
    // Sort intervals by startRow
    rawIntervals.sort((a, b) => a.startRow - b.startRow);

    // Merge overlapping/adjacent intervals
    const merged: Array<{ startRow: number; endRow: number }> = [];
    for (const interval of rawIntervals) {
      if (merged.length > 0 && interval.startRow <= merged[merged.length - 1].endRow) {
        // Overlapping or adjacent — extend the current merged interval
        merged[merged.length - 1].endRow = Math.max(
          merged[merged.length - 1].endRow,
          interval.endRow
        );
      } else {
        merged.push({ startRow: interval.startRow, endRow: interval.endRow });
      }
    }

    // Mark the lane as active for all rows in the merged intervals
    for (const interval of merged) {
      for (let row = interval.startRow; row <= interval.endRow; row++) {
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
 *
 * Requirements: 4.3
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
 *
 * Requirements: 7.3
 */
function isValidLane(lane: number): boolean {
  return Number.isFinite(lane) && lane >= 0 && lane <= 1000;
}

/**
 * Generate the SVG string for a single commit row in the graph.
 *
 * Renders an IntelliJ-style commit graph row including:
 * 1. Vertical pass-through lines for all active lanes (full row height)
 * 2. The commit node's own vertical line segments
 * 3. Merge/branch cubic bezier curves
 * 4. The commit node circle (drawn last, on top)
 *
 * The SVG is sized to accommodate all active lanes and graph line columns.
 * Invalid lane indices (negative or > 1000) are skipped gracefully.
 *
 * @param node - The commit node to render
 * @param rowIndex - The row index of this commit (0-based)
 * @param activeLanes - Set of lane indices that are active at this row
 * @param config - The graph render configuration
 * @returns An SVG string for this commit row
 *
 * Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.5, 5.1, 7.3
 */
export function renderGraphSvg(
  node: ICommitNode,
  rowIndex: number,
  activeLanes: Set<number>,
  config: IGraphRenderConfig
): string {
  const { rowHeight, nodeRadius, lineWidth } = config;
  const centerY = rowHeight / 2;
  const bottomY = rowHeight;
  const elements: string[] = [];

  // Compute SVG width: accommodate all active lanes, the commit's own column,
  // and all graph line columns
  const allColumns: number[] = [];
  for (const lane of activeLanes) {
    if (isValidLane(lane)) {
      allColumns.push(lane);
    }
  }
  if (isValidLane(node.graphColumn)) {
    allColumns.push(node.graphColumn);
  }
  for (const line of node.graphLines) {
    if (isValidLane(line.fromColumn)) {
      allColumns.push(line.fromColumn);
    }
    if (isValidLane(line.toColumn)) {
      allColumns.push(line.toColumn);
    }
  }

  const maxCol = allColumns.length > 0 ? Math.max(...allColumns) : 0;
  const svgWidth = (maxCol + 1) * config.columnWidth + config.padding * 2;

  // Determine if the commit's own lane has parents (continues below)
  const hasParents = node.commit.parents.length > 0;

  // --- Step 1: Draw vertical pass-through lines for all active lanes ---
  // Pass-through lanes are lanes that are active but NOT the commit's own lane.
  // These are drawn as full-height vertical lines (y=0 to y=rowHeight).
  for (const lane of activeLanes) {
    if (!isValidLane(lane)) {
      continue;
    }
    if (lane === node.graphColumn) {
      // The commit's own lane is handled separately in step 2
      continue;
    }
    const x = getColumnX(lane, config);
    const color = getColumnColor(lane);
    elements.push(
      `<line x1="${x}" y1="0" x2="${x}" y2="${rowHeight}" stroke="${color}" stroke-width="${lineWidth}" stroke-linecap="round"/>`
    );
  }

  // --- Step 2: Draw the commit node's own vertical line segments ---
  // The commit's own lane is split into two segments around the commit node:
  // - Top segment: from y=0 to y=centerY (if the lane continues above)
  // - Bottom segment: from y=centerY to y=rowHeight (if the lane continues below)
  if (isValidLane(node.graphColumn)) {
    const commitX = getColumnX(node.graphColumn, config);
    const commitColor = getColumnColor(node.graphColumn);

    // Draw top-to-center segment if this is not the first row
    // (i.e., there's a row above that connects to this lane)
    if (rowIndex > 0) {
      elements.push(
        `<line x1="${commitX}" y1="0" x2="${commitX}" y2="${centerY}" stroke="${commitColor}" stroke-width="${lineWidth}" stroke-linecap="round"/>`
      );
    }

    // Draw center-to-bottom segment if the commit has parents
    // (i.e., the lane continues below to a parent commit)
    if (hasParents) {
      elements.push(
        `<line x1="${commitX}" y1="${centerY}" x2="${commitX}" y2="${bottomY}" stroke="${commitColor}" stroke-width="${lineWidth}" stroke-linecap="round"/>`
      );
    }
  }

  // --- Step 3: Draw merge/branch cubic bezier curves ---
  // For each graph line where fromColumn !== toColumn, draw a bezier curve
  // from the commit node to the target lane.
  // Bezier: M fromX,centerY C fromX,bottomY toX,centerY toX,bottomY
  for (const line of node.graphLines) {
    if (!isValidLane(line.fromColumn) || !isValidLane(line.toColumn)) {
      continue;
    }
    if (line.fromColumn === line.toColumn) {
      // Same-lane lines are already handled by the vertical segments
      continue;
    }
    const fromX = getColumnX(line.fromColumn, config);
    const toX = getColumnX(line.toColumn, config);
    const color = getColumnColor(line.toColumn);
    elements.push(
      `<path d="M ${fromX},${centerY} C ${fromX},${bottomY} ${toX},${centerY} ${toX},${bottomY}" stroke="${color}" fill="none" stroke-width="${lineWidth}" stroke-linecap="round"/>`
    );
  }

  // --- Step 4: Draw the commit node circle (on top of everything) ---
  if (isValidLane(node.graphColumn)) {
    const cx = getColumnX(node.graphColumn, config);
    const cy = centerY;
    const fillColor = getColumnColor(node.graphColumn);
    const isMerge = node.commit.parents.length > 1;

    if (isMerge) {
      // Merge commits get a contrasting white stroke ring
      elements.push(
        `<circle cx="${cx}" cy="${cy}" r="${nodeRadius}" fill="${fillColor}" stroke="#ffffff" stroke-width="2"/>`
      );
    } else {
      // Normal commits: stroke matches fill (no visible border)
      elements.push(
        `<circle cx="${cx}" cy="${cy}" r="${nodeRadius}" fill="${fillColor}" stroke="${fillColor}" stroke-width="2"/>`
      );
    }
  }

  // Wrap all elements in an SVG tag
  return `<svg width="${svgWidth}" height="${rowHeight}">${elements.join('')}</svg>`;
}
