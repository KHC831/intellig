/**
 * Graph renderer utilities for IntelliJ-style commit graph visualization.
 *
 * This module provides types, configuration, and rendering functions for
 * converting ICommitNode[] data into SVG markup for each commit row,
 * including pass-through lanes and inter-row connections.
 */

import { ICommitNode, getMaxGraphColumn, getColumnColor } from '../git-core/commitGraph';

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
 * - nodeRadius: 4px commit circles
 * - padding: 10px horizontal padding
 * - lineWidth: 2px stroke width
 */
export const DEFAULT_GRAPH_CONFIG: IGraphRenderConfig = {
  columnWidth: 20,
  rowHeight: 24,
  // 4px commit dot — IntelliJ-snug. (Was briefly 5px to keep the dot from
  // blending into the line, but that read as oversized vs IntelliJ's
  // tighter nodes — reported. 4px against the 2px line still leaves a clear
  // ~1px halo while matching IntelliJ's proportions.)
  nodeRadius: 4,
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
 * When `hasFocusedBranch` is true, the row is rendered with
 * focus-aware emphasis: an on-path commit (`node.onFocusedBranchPath ===
 * true`) renders at boosted opacity (1.0) and stroke-width × 1.5; an
 * off-path commit renders at reduced opacity (0.6) and baseline stroke.
 * When `hasFocusedBranch` is false, both treatments are no-ops and the
 * row matches its unfocused appearance.
 *
 * @param node - The commit node to render
 * @param rowIndex - The row index of this commit (0-based)
 * @param activeLanes - Set of lane indices that are active at this row
 * @param config - The graph render configuration
 * @param isTerminal - Whether this commit is a terminal node (branch tip with no children)
 * @param isBranchSplitPoint - Whether this commit is a branch split point (has multiple children)
 * @param childLanes - Set of lane indices where child commits of this node live (for drawing split curves from top)
 * @param hasFocusedBranch - true when ANY commit in the
 *   render set is on the focused-branch path. Drives the brighten / dim
 *   pair: true + onFocusedBranchPath = brighten; true + !onFocusedBranchPath
 *   = dim; false = no change.
 * @returns An SVG string for this commit row
 */
export function renderGraphSvg(
  node: ICommitNode,
  rowIndex: number,
  activeLanes: Set<number>,
  config: IGraphRenderConfig,
  isTerminal: boolean = false,
  isBranchSplitPoint: boolean = false,
  childLanes: Set<number> = new Set(),
  hasFocusedBranch: boolean = false,
  /**
   * Active lanes at the NEXT (lower) row. Used to decide whether a
   * bezier-target lane also continues below this row as a through-lane: if
   * it does, the pass-through must be drawn FULL height (the bezier merges
   * into a continuing line), not truncated to the top half. Without this, a
   * lane that both receives a merge bezier AND carries a transiting line
   * down to a far parent got truncated, leaving a visible GAP in the
   * mainline below a merge commit (reported disconnect). Defaults to an
   * empty set (no continuation known → previous top-half behaviour).
   */
  nextActiveLanes: Set<number> = new Set(),
  /**
   * Source lanes whose far-parent first-parent line BENDS into THIS
   * row from above. For each such lane, the renderer emits a TOP-HALF
   * bend `<path>` at this row landing in the commit's own column. For
   * non-far-parent bends the bend remains at the source row (a bottom-
   * half bezier emitted by the per-line loop); only far-parent lines
   * (those carrying `endRow`) shift the bend to the parent row, fed by
   * `computeIncomingBendsMap`. Defaults to empty (no incoming far-
   * parent bends → no top-half bend is drawn).
   */
  incomingBendLanes: Set<number> = new Set(),
  /**
   * Active lanes at the PREVIOUS (upper) row. Mirrors `nextActiveLanes`:
   * lets the pass-through loop tell whether a lane continues from ABOVE.
   * A lane that is active at this row but NOT above is BORN here — the
   * merged-in second-parent lane of a merge commit, which runs downward
   * only. Its top half (y=0 → centerY) is a spurious stub floating above
   * the merge diamond. Drawing the lane full height (because it continues
   * below) painted that stub. With this set populated the loop draws only
   * the BOTTOM half for born-here lanes. Defaults to an empty set: with no
   * continuation info we cannot tell a lane is born here, so the previous
   * full/top-half behaviour is preserved (backward-compatible — the empty
   * default is also what row 0, guarded separately, would see).
   */
  prevActiveLanes: Set<number> = new Set()
): string {
  const { rowHeight, nodeRadius, lineWidth } = config;
  const centerY = rowHeight / 2;
  const bottomY = rowHeight;
  const elements: string[] = [];

  // Focus-aware stroke + opacity overrides. When no branch
  // is focused (hasFocusedBranch=false), `effectiveStroke` is just the
  // baseline `lineWidth` and `effectiveOpacity` is 1.0 — every existing
  // visual matches its unfocused appearance.
  const onPath = !!node.onFocusedBranchPath;
  const effectiveStroke = hasFocusedBranch && onPath ? lineWidth * 1.5 : lineWidth;
  const effectiveOpacity = hasFocusedBranch ? (onPath ? 1.0 : 0.6) : 1.0;
  // Suffix appended to every emitted SVG element when hasFocusedBranch is
  // true so the dim / brighten effect lands on lines AND commit nodes.
  // We embed via the `opacity` attribute (most-compatible-with-no-CSS).
  const opacityAttr = hasFocusedBranch ? ` opacity="${effectiveOpacity}"` : '';

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
  // Far-parent fork-point bends (incomingBendLanes) land AT this row but
  // their source lane is in NONE of the above sources — neither in the
  // commit's own column, nor in any of its graphLines (the line is
  // attached to the SOURCE row's node, not this parent row's). Without
  // including these, svgWidth omits the source-lane column and the bend
  // path's start-X falls outside the viewport (clipped under
  // overflow:hidden in the panel).
  for (const lane of incomingBendLanes) {
    if (isValidLane(lane)) {
      allColumns.push(lane);
    }
  }

  const maxCol = allColumns.length > 0 ? Math.max(...allColumns) : 0;
  const svgWidth = (maxCol + 1) * config.columnWidth + config.padding * 2;

  // --- Draw vertical pass-through lines for all active lanes ---
  // Pass-through lanes are lanes that are active but NOT the commit's own lane.
  // These are drawn as full-height vertical lines (y=0 to y=rowHeight).

  // Collect lanes that this commit's bezier curves target (fromColumn→toColumn where they differ).
  // When a bezier curve connects this commit to a parent at a different lane, the curve
  // ends at the target lane at y=bottomY. Drawing a full pass-through at that lane creates
  // a visual "2 lines" artifact. Instead, draw only the top half (y=0 to y=centerY) so the
  // main branch line remains continuous from the row above while the bezier covers the bottom.
  const bezierTargetLanes = new Set<number>();
  for (const line of node.graphLines) {
    if (
      isValidLane(line.fromColumn) &&
      isValidLane(line.toColumn) &&
      line.fromColumn !== line.toColumn
    ) {
      bezierTargetLanes.add(line.toColumn);
    }
  }

  for (const lane of activeLanes) {
    if (!isValidLane(lane)) {
      continue;
    }
    if (lane === node.graphColumn) {
      // The commit's own lane is handled separately in step 2
      continue;
    }
    // At the topmost row there is nothing above to connect to, so a
    // pass-through stub (which always starts at y=0) renders as a detached
    // line floating above the row — most visible above a merge commit whose
    // merged-in lane is correctly marked active at row 0 so the bezier below
    // has a landing lane. The commit's own column already guards this at
    // `rowIndex > 0` below; the pass-through loop needs the same guard. The
    // bezier curve still draws the bottom-half connection, so suppressing the
    // top stub at row 0 loses no signal.
    if (rowIndex === 0) {
      continue;
    }
    // On a branch split row, suppress pass-through lines for diverging child lanes.
    // These lanes only exist above the split point (the children), not below it.
    if (isBranchSplitPoint && childLanes.has(lane)) {
      continue;
    }
    // Incoming far-parent bend: this lane's straight-down ink stops at
    // this row's top, then bends into the commit's own column. The
    // dedicated incoming-bend block below emits the curved top-half
    // path; suppress the straight pass-through here so we don't double-
    // draw the same lane.
    if (incomingBendLanes.has(lane)) {
      continue;
    }
    const x = getColumnX(lane, config);
    const color = getColumnColor(lane);
    // A bezier targets this lane (a merge/branch line lands here). Normally
    // we draw the pass-through top-half only and let the bezier cover the
    // bottom — avoiding a "2 lines" overlap. BUT if this lane ALSO continues
    // below (it's active in the next row too), it's a through-lane carrying
    // a transiting line down to a far parent; truncating it severs the line
    // and leaves a gap under the merge commit (reported disconnect). In that
    // case draw the FULL height: the bezier merging in overlaps the through
    // line harmlessly (same lane, same color).
    const continuesBelow = nextActiveLanes.has(lane);
    // A lane that is active here but NOT in the row above is BORN at this row
    // — the merged-in second-parent lane of a merge commit, which runs only
    // downward. Its top half (y=0 → centerY) would be a detached stub
    // floating above the merge diamond. We can only tell a lane is born-here
    // when prevActiveLanes is populated (the production call site always
    // passes it for rows > 0); with an empty set there is no continuation
    // info, so the previous full/top-half behaviour is preserved.
    const bornHere = prevActiveLanes.size > 0 && !prevActiveLanes.has(lane);
    if (bezierTargetLanes.has(lane) && !continuesBelow) {
      // Bezier lands here and the lane does not continue below. Draw the top
      // half and let the bezier cover the bottom — UNLESS the lane is born
      // here, in which case the top half is spurious (nothing above) and the
      // bezier already provides the only real connection: draw nothing.
      if (!bornHere) {
        elements.push(
          `<line x1="${x}" y1="0" x2="${x}" y2="${centerY}" stroke="${color}" stroke-width="${effectiveStroke}" stroke-linecap="round"${opacityAttr}/>`
        );
      }
    } else if (bornHere) {
      // Full-height pass-through would draw a top-half stub above the merge
      // diamond. A born-here lane only continues below (it runs down to its
      // parent), so draw the BOTTOM half only.
      elements.push(
        `<line x1="${x}" y1="${centerY}" x2="${x}" y2="${rowHeight}" stroke="${color}" stroke-width="${effectiveStroke}" stroke-linecap="round"${opacityAttr}/>`
      );
    } else {
      elements.push(
        `<line x1="${x}" y1="0" x2="${x}" y2="${rowHeight}" stroke="${color}" stroke-width="${effectiveStroke}" stroke-linecap="round"${opacityAttr}/>`
      );
    }
  }

  // --- Draw the commit node's own vertical line segments ---
  // The commit's own lane is split into two segments around the commit node:
  // - Top segment: from y=0 to y=centerY (if the lane continues above)
  // - Bottom segment: from y=centerY to y=rowHeight (if the lane continues below)
  if (isValidLane(node.graphColumn)) {
    const commitX = getColumnX(node.graphColumn, config);
    const commitColor = getColumnColor(node.graphColumn);

    // Draw top-to-center segment if this is not the first row
    // and not a terminal node (terminal nodes have no line above the circle)
    if (rowIndex > 0 && !isTerminal) {
      elements.push(
        `<line x1="${commitX}" y1="0" x2="${commitX}" y2="${centerY}" stroke="${commitColor}" stroke-width="${effectiveStroke}" stroke-linecap="round"${opacityAttr}/>`
      );
    }

    // Draw center-to-bottom segment if the commit has a parent in the same lane
    // (i.e., the lane continues straight down). If all parents are in different lanes,
    // the bezier curves handle the connection and no vertical stub is needed.
    //
    // L4 invariant — same-lane vertical stroke uses the commit's OWN
    // lane color (`commitColor` resolved above via
    // `getColumnColor(node.graphColumn)`), never a destination lane
    // color, even if a sibling line bends. See
    // `docs/design/git-tool-window-spec.md` section 8.L4.
    const sameLaneLines = node.graphLines.filter(
      (line) => line.fromColumn === node.graphColumn && line.toColumn === node.graphColumn
    );
    // Far-parent fork-point bend: a first-parent line leaving THIS
    // commit's lane that bends to a parent many rows below
    // also implies a straight-down stub at the source row, because the
    // source lane runs vertically through the rows in between (and the
    // bend itself lives at the parent row, not here). Without this stub
    // the source row reads as a hanging dot — the lane stops at the
    // commit's center with nothing below — even though the algorithm
    // marks the source lane active across the whole [row..endRow-1] span.
    const hasFarParentDownward = node.graphLines.some(
      (l) => l.endRow !== undefined && l.endRow > rowIndex && l.fromColumn === node.graphColumn
    );
    if (sameLaneLines.length > 0 || hasFarParentDownward) {
      // Dashed stroke ONLY when EVERY same-lane line targets an
      // off-window parent — i.e. this lane has no in-window continuation
      // and is purely "history continues below the loaded window".
      //
      // The earlier `.some()` rule was wrong for a merge whose FIRST
      // parent is in-window (same lane) but whose SECOND parent is
      // off-window: that produces two same-lane lines [solid, dashed],
      // and `.some()` painted the whole vertical stub dashed — dashing
      // the SOLID mainline even though it continues straight down to a
      // real, scrollable row. (Reported: mainline rows rendering with a
      // dashed segment under merge commits.) The off-window second
      // parent has no row to land on, so it is visually absorbed into
      // the solid mainline stub; only when NO same-lane parent is
      // in-window (`.every()` dashed — e.g. the bottom row of the window
      // whose sole parent fell off the slice) is the stub drawn dashed.
      // IntelliJ parity: solid connects to scrollable rows; dashed means
      // "more history exists, it just isn't loaded".
      // Dash ONLY when this lane's continuation below is purely "history
      // continues off-window" — same-lane lines exist AND every one is
      // dashed AND there is NO far-parent edge running below from this
      // commit's column. Without the hasFarParentDownward guard, a commit
      // with both a far-parent first-parent (which leaves sameLaneLines
      // empty for that edge — it bends, doesn't sit on this lane) and an
      // off-window dashed 2nd-parent stub painted the centerY→bottomY
      // stub dashed even though the far-parent edge it shadows runs to a
      // real in-window fork. A far-parent downward presence forces solid.
      //
      // ALSO solid for an off-window first-parent MAINLINE CONTINUATION: a
      // merge whose first parent fell off the slice but which has an in-window
      // parent (a merged side branch). Its lane is reserved and extended into
      // a full pass-through trunk to the window bottom, so it draws as one
      // solid column. We detect it structurally — every same-lane line is a
      // dashed off-window stub AND the node carries an in-window edge (a line
      // that is not a same-lane dashed stub) — so the rule is independent of
      // lane reuse below (a genuine LEAF, whose lane may be reused, stays
      // dashed). Dashing is reserved for that genuine leaf stub (all parents
      // off-window, nothing real continuing the lane), IntelliG's "history
      // continues below the loaded window" hint. (IntelliJ instead reserves
      // its dashed `LineStyle.DASHED` for collapsed long edges — a fold
      // affordance we do not yet have — and draws trunks solid; see
      // platform/vcs-log graph-api EdgePrintElement.kt + testData
      // elementGenerator/manyNodes_out.txt.)
      const hasInWindowEdge = node.graphLines.some(
        (l) => !(l.fromColumn === l.toColumn && l.style === 'dashed')
      );
      const isOffWindowContinuation =
        hasInWindowEdge &&
        sameLaneLines.length > 0 &&
        sameLaneLines.every((l) => l.style === 'dashed');
      const isDashed =
        !hasFarParentDownward &&
        !isOffWindowContinuation &&
        sameLaneLines.length > 0 &&
        sameLaneLines.every((l) => l.style === 'dashed');
      const dashAttr = isDashed ? ` stroke-dasharray="4,3"` : '';
      elements.push(
        `<line x1="${commitX}" y1="${centerY}" x2="${commitX}" y2="${bottomY}" stroke="${commitColor}" stroke-width="${effectiveStroke}" stroke-linecap="round"${dashAttr}${opacityAttr}/>`
      );
    }
  }

  // --- Draw merge/branch cubic bezier curves ---
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
    // Far-parent fork-point bend. The line is
    // logically attached to THIS row (the source commit), but its bend
    // is drawn at the PARENT row by the dedicated incoming-bends block
    // below. Skip the source-row bottom-half bezier so we don't draw it
    // twice — the source lane already runs straight down via the stub
    // emitted above.
    if (line.endRow !== undefined && line.endRow !== rowIndex) {
      continue;
    }
    const fromX = getColumnX(line.fromColumn, config);
    const toX = getColumnX(line.toColumn, config);
    // Color a bending edge by its TYPE, matching the algorithm's own
    // per-line color rule (commitGraph.ts) and L4's spirit:
    //   - 'commit' (the FIRST-parent line — the commit's mainline
    //     continuation): use the SOURCE lane color, i.e. the commit's
    //     OWN node color. A first-parent edge that bends to a parent
    //     sitting on another lane must still leave the node in the node's
    //     colour — otherwise you get a blue node with an orange outgoing
    //     line (reported), or a green node whose own line is orange.
    //   - 'merge' / 'branch' (a 2nd+ parent): use the DESTINATION lane
    //     color, so the edge reads as "joining the merged branch", shown
    //     in that branch's colour.
    // The earlier unconditional `getColumnColor(line.toColumn)` painted
    // EVERY bending edge in the destination colour, which mismatched the
    // node on any first-parent bend.
    const color =
      line.type === 'commit' ? getColumnColor(line.fromColumn) : getColumnColor(line.toColumn);
    const dashAttr = line.style === 'dashed' ? ` stroke-dasharray="4,3"` : '';
    elements.push(
      `<path d="M ${fromX},${centerY} C ${fromX},${bottomY} ${toX},${centerY} ${toX},${bottomY}" stroke="${color}" fill="none" stroke-width="${effectiveStroke}" stroke-linecap="round"${dashAttr}${opacityAttr}/>`
    );
  }

  // --- Far-parent incoming bends (top half) ---
  // For each source lane bending INTO this commit's row from above (fed
  // by `computeIncomingBendsMap`), emit a TOP-HALF cubic bezier landing
  // at the commit's own column at centerY. The companion source-row
  // bottom-half bezier is suppressed by the bezier loop above (where
  // `line.endRow !== rowIndex`); the bend is geometrically split across
  // two rows so the source lane reads as a straight column down to the
  // fork point. Colour is the SOURCE lane (first-parent edges always
  // carry the source-lane colour, matching L4 and the existing same-
  // lane-bezier rule in the loop above).
  if (isValidLane(node.graphColumn) && incomingBendLanes.size > 0) {
    const toX = getColumnX(node.graphColumn, config);
    for (const sourceLane of incomingBendLanes) {
      if (!isValidLane(sourceLane) || sourceLane === node.graphColumn) {
        continue;
      }
      const fromX = getColumnX(sourceLane, config);
      const color = getColumnColor(sourceLane);
      elements.push(
        `<path d="M ${fromX},0 C ${fromX},${centerY} ${toX},0 ${toX},${centerY}" stroke="${color}" fill="none" stroke-width="${effectiveStroke}" stroke-linecap="round"${opacityAttr}/>`
      );
    }
  }

  // --- Draw the commit node icon (on top of everything) ---
  if (isValidLane(node.graphColumn)) {
    const cx = getColumnX(node.graphColumn, config);
    const cy = centerY;
    const fillColor = getColumnColor(node.graphColumn);
    const isMerge = node.commit.parents.length > 1;

    if (isMerge) {
      // Merge commits get a diamond icon (rotated rect)
      // Merge takes precedence even if also a branch split point
      // Draw a background circle first to cover the line behind the diamond,
      // preventing the line from showing through the white stroke gap
      const side = nodeRadius * 1.8;
      const bgRadius = side * 0.72; // covers the diamond's bounding circle
      elements.push(
        `<circle cx="${cx}" cy="${cy}" r="${bgRadius}" fill="${fillColor}" stroke="none"${opacityAttr}/>`
      );
      elements.push(
        `<rect x="${cx - side / 2}" y="${cy - side / 2}" width="${side}" height="${side}" fill="${fillColor}" stroke="#ffffff" stroke-width="1.5" transform="rotate(45, ${cx}, ${cy})"${opacityAttr}/>`
      );
    } else if (isBranchSplitPoint) {
      // Branch split: filled circle with two angled tick marks from bottom
      elements.push(
        `<circle cx="${cx}" cy="${cy}" r="${nodeRadius}" fill="${fillColor}" stroke="${fillColor}" stroke-width="2"${opacityAttr}/>`
      );

      // Two tick marks at ±30° from the bottom of the circle
      // Bottom of circle is at (cx, cy + nodeRadius)
      // Tick length is nodeRadius * 0.8
      const tickLength = nodeRadius * 0.8;
      const bottomX = cx;
      const bottomCY = cy + nodeRadius;

      // Left tick: -30° from vertical downward (i.e., 210° from positive x-axis)
      // Angle from bottom going down-left: 180° + 30° = 210° in standard math coords
      // In SVG coords (y increases downward), angle of 30° to the left of straight down
      const angleLeft = Math.PI / 6; // 30 degrees
      const leftEndX = bottomX - tickLength * Math.sin(angleLeft);
      const leftEndY = bottomCY + tickLength * Math.cos(angleLeft);

      // Right tick: +30° from vertical downward
      const rightEndX = bottomX + tickLength * Math.sin(angleLeft);
      const rightEndY = bottomCY + tickLength * Math.cos(angleLeft);

      elements.push(
        `<line x1="${bottomX}" y1="${bottomCY}" x2="${leftEndX}" y2="${leftEndY}" stroke="${fillColor}" stroke-width="${effectiveStroke}" stroke-linecap="round"${opacityAttr}/>`
      );
      elements.push(
        `<line x1="${bottomX}" y1="${bottomCY}" x2="${rightEndX}" y2="${rightEndY}" stroke="${fillColor}" stroke-width="${effectiveStroke}" stroke-linecap="round"${opacityAttr}/>`
      );
    } else {
      // Normal commits: stroke matches fill (no visible border)
      elements.push(
        `<circle cx="${cx}" cy="${cy}" r="${nodeRadius}" fill="${fillColor}" stroke="${fillColor}" stroke-width="2"${opacityAttr}/>`
      );
    }

    // Terminal node: add outer ring circle
    if (isTerminal) {
      const ringRadius = nodeRadius + 2;
      // Draw a filled background circle at the ring radius to cover any line behind the ring gap
      elements.push(
        `<circle cx="${cx}" cy="${cy}" r="${ringRadius}" fill="${fillColor}" stroke="${fillColor}" stroke-width="1.5"${opacityAttr}/>`
      );
      // Draw the outer ring with a contrasting stroke on top
      elements.push(
        `<circle cx="${cx}" cy="${cy}" r="${ringRadius}" fill="none" stroke="#ffffff" stroke-width="1.5"${opacityAttr}/>`
      );
      // Redraw the inner filled circle on top so the center is the lane color
      elements.push(
        `<circle cx="${cx}" cy="${cy}" r="${nodeRadius}" fill="${fillColor}" stroke="${fillColor}" stroke-width="1"${opacityAttr}/>`
      );
    }
  }

  // Wrap all elements in an SVG tag
  return `<svg width="${svgWidth}" height="${rowHeight}">${elements.join('')}</svg>`;
}
