/**
 * Layer 3 — the graph PRINT MODEL (single source of truth for what each row draws).
 *
 * INVARIANT: this module is a PURE PROJECTION of `ICommitNode[]`. It allocates no
 * lanes and re-derives no lane STATE; the only continuity signal is per-edge
 * endpoint identity (an edge's top half at row R and bottom half at row R+1 come
 * from the SAME edge). `IRowPrintModel` exposes NO lane-set, so the set-membership
 * question the gap/phantom bug class came from is structurally impossible to ask.
 *
 * Mirrors IntelliJ vcs-log `platform/vcs-log/graph` impl/print: an explicit
 * per-row element list (node + edge halves) that a DUMB painter renders. See
 * PrintElementGeneratorImpl.kt + EdgePrintElementImpl (Type.UP / Type.DOWN) and
 * GraphEdge.java (nullable endpoints for off-window edges).
 *
 * All topology/continuity decisions live here (Layer 3); the geometry + SVG
 * string emission is the dumb painter's job (Layer 4, graphPainter.ts).
 */

import {
  ICommitNode,
  computeChildCountMap,
  computeIncomingBendsMap,
  computeTerminalNodes,
  getColumnColor,
  isBranchSplit,
} from '../commitGraph';
import { commitNodeKey, parentNodeKey } from '../graphRowKey';
import { computeBranchColors, type IColorNode } from './branchColors';
import { computeLongEdgeCuts, applyLongEdgeHiding } from './longEdges';
import {
  computeActiveLanes,
  computeLaneContinuesFromAbove,
  computeLaneContinuesBelow,
  collectMergedLaneIntervals,
  isValidLane,
} from '../../utils/graphRenderer';

/**
 * An edge's parent endpoint. Off-window parents have NO row (mirrors
 * `GraphEdge`'s @Nullable downNodeIndex + GraphEdgeType) — never a sentinel row
 * that could collide with a reused lane.
 */
export type EdgeEnd = { kind: 'inWindow'; row: number } | { kind: 'offWindow' };

/**
 * Edge identity: child row (newer) + parent end + the edge's own lane.
 *
 * RETAINED IDENTITY SEAM — not dead code. This is the deliberate Layer-3
 * edge-identity layer of the graph print model (DAG → layout → edge-segment
 * identity → dumb Layer-4 painter), mirroring IntelliJ's vcs-log/graph. The
 * Layer-4 painter ({@link graphPainter}) draws geometry from
 * `lane/fromLane/targetLane/half/curved/color/topLane/bottomLane`, and
 * `laneLinking.ts` DOES read `el.edge` (`edgeIdKey(e.edge)`, `e.edge.lane`)
 * to resolve a seam column — but per ADR-016 that read has no independent
 * effect on painted output today: the identity lookup, whenever it
 * resolves, is provably identical to the raw-lane lookup that runs right
 * after it (both are keyed off the same per-row rank map). This apparatus
 * (plus {@link laneEdgeId}, which does the off-window parent tagging) is
 * kept as the stable per-edge identity needed for future edge-level
 * interactivity (hover/highlight/select a specific edge) and is exercised
 * by printModel.test at the model level. Do not delete it as "unused" —
 * it's an architectural seam, not accidental cruft.
 */
export interface IGraphEdgeId {
  childRow: number;
  parent: EdgeEnd;
  lane: number;
}

/** Which half of the row this segment occupies. `full` = a straight pass-through spanning the whole row. */
export type EdgeHalf = 'up' | 'down' | 'full';

/**
 * One drawable edge segment in a row. The painter resolves color via the single
 * L4 rule: `colorSource = (type === 'commit' || !curved) ? fromLane : targetLane`.
 */
export interface IRowEdgeElement {
  /** Retained identity seam — see {@link IGraphEdgeId}. Not read by the Layer-4 painter yet. */
  edge: IGraphEdgeId;
  half: EdgeHalf;
  /** Straight: `fromLane === targetLane === lane`. Bend: source / destination lanes. */
  lane: number;
  fromLane: number;
  targetLane: number;
  /** true => bezier (merge/branch/far-parent bend); false => vertical stroke. */
  curved: boolean;
  type: 'commit' | 'merge' | 'branch';
  style: 'solid' | 'dashed';
  /**
   * Resolved stroke color (the owning branch's color, or the lane color when no
   * branch owns the segment). Optional so test-constructed elements omit it; the
   * painter falls back to {@link getColumnColor} on the lane.
   */
  color?: string;
  /**
   * Long-edge cut marker (see {@link applyLongEdgeHiding}). When set, this is a
   * half-height stub terminating in an arrowhead at the row center: `'down'`
   * near the child endpoint (the hidden edge continues downward), `'up'` near
   * the parent. Absent on ordinary segments.
   */
  arrow?: 'up' | 'down';
  /** Seam docking columns — see laneLinking.ts. Optional, default `lane`. */
  topLane?: number;
  bottomLane?: number;
}

/** The commit dot for the row. */
export interface IRowNodeElement {
  lane: number;
  isMerge: boolean;
  isTerminal: boolean;
  isBranchSplit: boolean;
  /** This commit is the tip of the checked-out branch (HEAD) — gets the white ring. */
  isCurrentHead: boolean;
  onFocusedBranchPath: boolean;
  /** Resolved node color (owning branch color, else lane color). Optional — see {@link IRowEdgeElement.color}. */
  color?: string;
}

/** Everything needed to paint one commit row. */
export interface IRowPrintModel {
  rowIndex: number;
  node: IRowNodeElement;
  edges: IRowEdgeElement[];
  /** EVERY lane this row inks (incl. far-parent bend SOURCE lanes) — for width calc. */
  inkedLanes: number[];
  isLastRow: boolean;
  /** Lanes capped with a "more history below" chevron (off-window leaves + last-row trunks). */
  chevronLanes: number[];
  /** Per-chevron color, parallel to {@link chevronLanes}. Optional — painter falls back to the lane color. */
  chevronColors?: string[];
  hasFocusedBranch: boolean;
}

/**
 * Per (row, lane) → the merged interval covering it, so a pass-through segment
 * can carry its edge identity (childRow = interval start; parent = interval end,
 * tagged off-window when the lane runs off the bottom of the loaded slice).
 */
function buildIntervalLookup(
  nodes: ICommitNode[],
  mergedIntervals: Map<number, Array<{ startRow: number; endRow: number }>>
): Map<number, Map<number, { startRow: number; endRow: number }>> {
  const byRow = new Map<number, Map<number, { startRow: number; endRow: number }>>();
  for (let i = 0; i < nodes.length; i++) {
    byRow.set(i, new Map());
  }
  for (const [lane, intervals] of mergedIntervals) {
    for (const iv of intervals) {
      for (let row = iv.startRow; row <= iv.endRow; row++) {
        byRow.get(row)?.set(lane, iv);
      }
    }
  }
  return byRow;
}

/**
 * Compute the {@link IGraphEdgeId} for a lane's segment on a row, including the
 * off-window parent tagging. Part of the retained Layer-3 identity seam — see
 * {@link IGraphEdgeId}.
 */
function laneEdgeId(
  nodes: ICommitNode[],
  iv: { startRow: number; endRow: number } | undefined,
  lane: number,
  rowIndex: number
): IGraphEdgeId {
  if (!iv) {
    return { childRow: rowIndex, parent: { kind: 'offWindow' }, lane };
  }
  const last = nodes.length - 1;
  // The lane runs off the bottom of the loaded slice when its interval reaches
  // the final row but no node on that row actually sits on this lane (an
  // off-window trunk continuation rather than a real parent landing).
  const runsOffWindow = iv.endRow === last && nodes[last]?.graphColumn !== lane;
  return {
    childRow: iv.startRow,
    parent: runsOffWindow ? { kind: 'offWindow' } : { kind: 'inWindow', row: iv.endRow },
    lane,
  };
}

/**
 * Per-row inputs for {@link projectRow}. `buildGraphPrintModel` computes these
 * from whole-DAG maps; tests may supply them directly to exercise the painter
 * with a fabricated row.
 */
export interface IRowProjectionContext {
  activeLanes: Set<number>;
  continuesFromAbove: Set<number>;
  continuesBelow: Set<number>;
  incomingBendLanes: Set<number>;
  /**
   * Source lanes whose far-parent first-parent bend lands at the row BELOW this
   * one (its incoming bend tops `rowIndex + 1`). Such a lane bottoms this row so
   * its straight pass-through meets the bend at the seam — its interval ends at
   * this row (the bend, not a pass-through, occupies the parent row), so
   * `continuesBelow` does not report it.
   */
  bendsLandingBelow: Set<number>;
  isTerminal: boolean;
  isCurrentHead: boolean;
  isBranchSplit: boolean;
  isLastRow: boolean;
  hasFocusedBranch: boolean;
  /** Full node list — for hash-keyed parent resolution + off-window edge identity. */
  nodes: ICommitNode[];
  /**
   * `commitHash → rowIndex` for the whole window. Optional: when omitted (e.g.
   * direct projectRow unit tests) it's derived locally. {@link buildGraphPrintModel}
   * builds it ONCE and threads it in so per-edge parent resolution
   * ({@link findParentRow}) is O(1) instead of rebuilding an O(N) map per bend.
   */
  hashToRow?: ReadonlyMap<string, number>;
  /** Merged interval covering each lane at this row, for pass-through edge identity. */
  intervalByLane: Map<number, { startRow: number; endRow: number }>;
  /**
   * Per-commit owning-branch color (`hash → color`) from {@link computeBranchColors}.
   * Optional/empty → every element falls back to its lane color (no behavior
   * change), so existing projectRow tests need not supply it.
   */
  branchColors?: ReadonlyMap<string, string>;
}

/**
 * Project a single row into its print model. Pure; the ONLY continuity source is
 * the interval-derived `continuesFromAbove` / `continuesBelow` sets — never lane
 * set-membership. Shared by {@link buildGraphPrintModel} and painter unit tests.
 */
export function projectRow(
  node: ICommitNode,
  rowIndex: number,
  ctx: IRowProjectionContext
): IRowPrintModel {
  const ownLane = node.graphColumn;
  const {
    activeLanes,
    continuesFromAbove,
    continuesBelow,
    incomingBendLanes,
    bendsLandingBelow,
    isLastRow,
    nodes,
    intervalByLane: ivLookup,
  } = ctx;
  // Built once by buildGraphPrintModel and threaded in; derived locally only on
  // the direct-projectRow test path so per-bend parent lookup stays O(1).
  const hashToRow = ctx.hashToRow ?? buildHashToRow(nodes);

  const edges: IRowEdgeElement[] = [];
  const bottomInkLanes = new Set<number>();
  const chevronLanes = new Set<number>();

  // Per-branch color resolution. NOTE: `nodes` is the whole window in display
  // order, so a node's row index IS its array index (`nodes[row]` ↔ row `row`);
  // the helpers below rely on that to map a row to its commit/lane and back.
  //
  // `colorForRow` is the leaf primitive: a single row's hash → owning-branch
  // color, falling back to the lane color when no branch owns it (or no
  // branchColors supplied) — so behavior is unchanged when coloring is off.
  const branchColors = ctx.branchColors;
  const colorForRow = (row: number, fallbackLane: number): string => {
    const commit = nodes[row]?.commit;
    const c = commit !== undefined ? branchColors?.get(commitNodeKey(commit)) : undefined;
    return c ?? getColumnColor(fallbackLane);
  };

  // `ownerColorForLaneAt` is THE single owner-lookup primitive every drawable
  // element resolves through (it replaced three ad-hoc lane walks). It bridges
  // lane TOPOLOGY to branch-color OWNERSHIP: it walks the lane to the nearest
  // node sitting ON it — searching from `from` up toward `lo`, else down toward
  // `hi` — and returns that owning commit's branch color via `colorForRow`. The
  // bridge only stays sound because both layers follow the first-parent spine
  // (see ADR-013 section 4, "the lane ↔ branch-color bridge invariant"): a
  // commit's spine sits on one lane, and ownership propagates down first parents.
  // Bounds keep the search inside ONE lane interval so an unrelated later reuse
  // of the same lane can't bleed its color in. Node dot, straight pass-through,
  // first-parent bend, and far-parent incoming bend all resolve through this, so
  // a segment can never disagree with the node it connects — elements that share
  // a lane share an owner by construction. Falls back to the lane color when no
  // node owns the lane in range (tip/parent off-window).
  const ownerColorForLaneAt = (lane: number, from: number, lo: number, hi: number): string => {
    for (let r = from; r >= lo; r--) {
      if (nodes[r]?.graphColumn === lane) {
        return colorForRow(r, lane);
      }
    }
    for (let r = from + 1; r <= hi; r++) {
      if (nodes[r]?.graphColumn === lane) {
        return colorForRow(r, lane);
      }
    }
    return getColumnColor(lane);
  };

  // `colorForLane` is the interval-bound wrapper for a pass-through segment: it
  // just supplies `ownerColorForLaneAt` with this lane's merged-interval bounds,
  // so color changes only AT a fork/merge junction node, exactly like IntelliJ —
  // never mid-run with a foreign top commit's color (the reported "long line a
  // different color than the nodes it connects").
  const colorForLane = (lane: number): string => {
    const iv = ivLookup.get(lane);
    if (!iv) {
      return getColumnColor(lane);
    }
    return ownerColorForLaneAt(lane, rowIndex, iv.startRow, iv.endRow);
  };

  const nodeColor = colorForRow(rowIndex, ownLane);

  // Cross-lane bezier targets DRAWN at this row. A far-parent line (endRow on a
  // lower row) bends at the PARENT row, so it is excluded here and must not
  // suppress the source row's straight pass-through.
  const bezierTargetLanes = new Set<number>();
  for (const line of node.graphLines) {
    if (
      isValidLane(line.fromColumn) &&
      isValidLane(line.toColumn) &&
      line.fromColumn !== line.toColumn
    ) {
      if (line.endRow !== undefined && line.endRow !== rowIndex) {
        continue;
      }
      bezierTargetLanes.add(line.toColumn);
    }
  }

  // --- Pass-through lanes (non-own active lanes), driven by the interval model ---
  for (const lane of activeLanes) {
    if (!isValidLane(lane) || lane === ownLane) {
      continue;
    }
    if (incomingBendLanes.has(lane)) {
      continue; // the bend path (below) draws this lane's top-half
    }
    const enters = continuesFromAbove.has(lane);
    // A far-parent bend landing at the row below also "exits" this row: the
    // source lane runs straight down to the seam, where the bend (drawn at the
    // parent row) takes over. Without this the lane stops at its center and
    // leaves a gap above the incoming bend.
    const exits = continuesBelow.has(lane) || bendsLandingBelow.has(lane);
    const isBezierTarget = bezierTargetLanes.has(lane);
    if (exits) {
      bottomInkLanes.add(lane);
    }
    const edge = laneEdgeId(nodes, ivLookup.get(lane), lane, rowIndex);
    const passThroughColor = colorForLane(lane);
    const straight = (half: EdgeHalf): IRowEdgeElement => ({
      edge,
      half,
      lane,
      fromLane: lane,
      targetLane: lane,
      curved: false,
      type: 'commit',
      style: 'solid',
      color: passThroughColor,
    });
    if (enters && exits) {
      // A genuine through-lane (continues above AND below) must always ink a
      // continuous vertical, even when a sibling's line bends INTO it here. The
      // incoming bezier is a DIFFERENT line and only meets this lane's bottom at
      // a point (a diagonal), so downgrading to 'up' dropped the lane's own
      // bottom-half vertical → a visible gap above the next node (reported bug).
      edges.push(straight('full'));
    } else if (enters && !exits) {
      edges.push(straight('up'));
    } else if (!enters && exits && !isBezierTarget) {
      edges.push(straight('down'));
    }
    // !enters && !exits, or born bezier target: nothing straight (the bezier IS
    // this lane's entry, or the node draws it).
  }

  // --- Own-lane segments around the commit dot ---
  if (isValidLane(ownLane)) {
    const ownIv = ivLookup.get(ownLane);
    const ownEdge = laneEdgeId(nodes, ownIv, ownLane, rowIndex);
    if (continuesFromAbove.has(ownLane)) {
      // The own-lane UP half connects this commit up to the child whose first
      // parent it is — the nearest node above on this lane. That edge belongs to
      // the CHILD's chain, so it takes the child's color: the whole child→parent
      // edge is one color, transitioning AT this dot, not mid-cell. Mirrors
      // IntelliJ's GraphColorGetter rule (the less-important endpoint owns the
      // edge; a child is never more important than its own first parent on the
      // same lane, so the child wins). Falls back to this node's color when no
      // in-window child sits above (a tip or an off-window continuation).
      let upColor = nodeColor;
      // Bound the upward search to this lane's interval via the edge identity's
      // childRow (== interval start), so it can't scan into an unrelated later
      // reuse of the lane and stays provably identical to the color oracle.
      const lo = ownEdge.childRow;
      for (let r = rowIndex - 1; r >= lo; r--) {
        if (nodes[r]?.graphColumn === ownLane) {
          upColor = colorForRow(r, ownLane);
          break;
        }
      }
      edges.push({
        edge: ownEdge,
        half: 'up',
        lane: ownLane,
        fromLane: ownLane,
        targetLane: ownLane,
        curved: false,
        type: 'commit',
        style: 'solid',
        color: upColor,
      });
    }
    const sameLaneLines = node.graphLines.filter(
      (l) => l.fromColumn === ownLane && l.toColumn === ownLane
    );
    const hasFarParentDownward = node.graphLines.some(
      (l) => l.endRow !== undefined && l.endRow > rowIndex && l.fromColumn === ownLane
    );
    if (sameLaneLines.length > 0 || hasFarParentDownward) {
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
      edges.push({
        edge: ownEdge,
        half: 'down',
        lane: ownLane,
        fromLane: ownLane,
        targetLane: ownLane,
        curved: false,
        type: 'commit',
        style: isDashed ? 'dashed' : 'solid',
        color: nodeColor,
      });
      bottomInkLanes.add(ownLane);
      if (isDashed) {
        chevronLanes.add(ownLane);
      }
    }
  }

  // --- Merge/branch/adjacent-fork bezier curves (bottom-half), at the source row ---
  for (const line of node.graphLines) {
    if (!isValidLane(line.fromColumn) || !isValidLane(line.toColumn)) {
      continue;
    }
    if (line.fromColumn === line.toColumn) {
      continue; // same-lane handled by the own-lane vertical
    }
    if (line.endRow !== undefined && line.endRow !== rowIndex) {
      continue; // far-parent line bends at the parent row, not here
    }
    const parentRow = findParentRow(nodes, hashToRow, node, line.toColumn, rowIndex);
    // L4 color source: a first-parent ('commit') bend keeps the SOURCE branch
    // color (this node); a merge/branch bend takes the DESTINATION branch color
    // (the parent it joins), falling back to the destination lane off-window.
    const bezierColor =
      line.type === 'commit'
        ? nodeColor
        : parentRow === undefined
          ? getColumnColor(line.toColumn)
          : colorForRow(parentRow, line.toColumn);
    edges.push({
      edge: {
        childRow: rowIndex,
        parent:
          parentRow === undefined ? { kind: 'offWindow' } : { kind: 'inWindow', row: parentRow },
        lane: line.toColumn,
      },
      half: 'down',
      lane: line.toColumn,
      fromLane: line.fromColumn,
      targetLane: line.toColumn,
      curved: true,
      type: line.type,
      style: line.style === 'dashed' ? 'dashed' : 'solid',
      color: bezierColor,
    });
  }

  // --- Far-parent incoming bends (top-half), landing at this parent row ---
  if (isValidLane(ownLane)) {
    for (const sourceLane of incomingBendLanes) {
      if (!isValidLane(sourceLane) || sourceLane === ownLane) {
        continue;
      }
      edges.push({
        edge: {
          childRow: rowIndex,
          parent: { kind: 'inWindow', row: rowIndex },
          lane: sourceLane,
        },
        half: 'up',
        lane: sourceLane,
        fromLane: sourceLane,
        targetLane: ownLane,
        curved: true,
        // First-parent far edge → the child's chain that owns the source lane.
        // The source lane's interval ENDS at the row above this parent (the bend
        // lives here, not a straight), so `colorForLane` can't see it; the bend
        // continues the straight far line directly above, so use the same owner
        // lookup over the rows ABOVE this one: the nearest commit on the source
        // lane there is the child whose first-parent line lands here.
        type: 'commit',
        style: 'solid',
        color: ownerColorForLaneAt(sourceLane, rowIndex - 1, 0, rowIndex - 1),
      });
    }
  }

  // --- Off-window chevrons ---
  if (isLastRow) {
    for (const lane of bottomInkLanes) {
      chevronLanes.add(lane);
    }
  }

  // inkedLanes = every lane this row draws ink on (matches the legacy svgWidth
  // sources: active lanes + own column + all line columns + far-parent bend sources).
  const inkedLanes = new Set<number>();
  for (const lane of activeLanes) {
    if (isValidLane(lane)) {
      inkedLanes.add(lane);
    }
  }
  if (isValidLane(ownLane)) {
    inkedLanes.add(ownLane);
  }
  for (const line of node.graphLines) {
    if (isValidLane(line.fromColumn)) {
      inkedLanes.add(line.fromColumn);
    }
    if (isValidLane(line.toColumn)) {
      inkedLanes.add(line.toColumn);
    }
  }
  for (const lane of incomingBendLanes) {
    if (isValidLane(lane)) {
      inkedLanes.add(lane);
    }
  }

  const nodeEl: IRowNodeElement = {
    lane: ownLane,
    isMerge: node.commit.parents.length > 1,
    isTerminal: ctx.isTerminal,
    isCurrentHead: ctx.isCurrentHead,
    isBranchSplit: ctx.isBranchSplit,
    onFocusedBranchPath: node.onFocusedBranchPath === true,
    color: nodeColor,
  };

  const chevronLaneList = [...chevronLanes].filter(isValidLane);
  return {
    rowIndex,
    node: nodeEl,
    edges,
    inkedLanes: [...inkedLanes],
    isLastRow,
    chevronLanes: chevronLaneList,
    chevronColors: chevronLaneList.map((lane) => colorForLane(lane)),
    hasFocusedBranch: ctx.hasFocusedBranch,
  };
}

/**
 * Map each row index → the source lanes whose far-parent first-parent bend lands
 * at the row BELOW it. A far-parent line (`endRow` set) bends into its parent at
 * `endRow`; the source lane therefore needs to bottom row `endRow - 1` so its
 * straight pass-through meets that incoming bend at the seam. The companion to
 * {@link computeIncomingBendsMap} (which keys the bend by the PARENT row); this
 * keys it by the row immediately above so {@link projectRow} can close the seam.
 */
function computeBendsLandingBelowMap(nodes: ICommitNode[]): Map<number, Set<number>> {
  const result = new Map<number, Set<number>>();
  for (let rowIndex = 0; rowIndex < nodes.length; rowIndex++) {
    for (const line of nodes[rowIndex].graphLines) {
      if (line.endRow === undefined || line.endRow <= rowIndex) {
        continue;
      }
      const rowAboveParent = line.endRow - 1;
      if (rowAboveParent < 0 || rowAboveParent >= nodes.length) {
        continue;
      }
      let set = result.get(rowAboveParent);
      if (!set) {
        set = new Set<number>();
        result.set(rowAboveParent, set);
      }
      set.add(line.fromColumn);
    }
  }
  return result;
}

/** Options for {@link buildGraphPrintModel}. */
export interface IBuildPrintModelOptions {
  /** Currently checked-out branch — a tiebreak when a commit has multiple refs. */
  headBranchName?: string;
  /**
   * The checked-out commit (what `HEAD` resolves to). That commit's node gets the
   * white "you are here" ring — including a DETACHED HEAD, where there's no branch
   * tip to key off. `undefined` (e.g. merged multi-root) leaves no node ringed.
   */
  headHash?: string;
  /**
   * Precomputed owning-branch colors (`hash → color`). Supply this when the
   * caller also needs the map elsewhere (e.g. to color the branch chips to
   * match) so it's computed once; otherwise it's derived from `headBranchName`.
   */
  branchColors?: ReadonlyMap<string, string>;
  /**
   * Hide the middle of edges longer than the IntelliJ threshold (default true —
   * IntelliJ's "Show Long Edges" OFF). Set false to draw every edge full-span
   * (the `intellig.log.showLongEdges` toggle). See {@link applyLongEdgeHiding}.
   */
  hideLongEdges?: boolean;
}

/** Map graph nodes to the minimal shape {@link computeBranchColors} needs. */
export function colorNodesFrom(nodes: ICommitNode[]): IColorNode[] {
  // Node-keyed ids (hash + root in the merged window) so the branch-color
  // first-parent walk can't hop between same-hash copies from different roots.
  return nodes.map((n) => ({
    hash: commitNodeKey(n.commit),
    parents: n.commit.parents.map((p) => parentNodeKey(n.commit, p)),
    refs: n.branches,
  }));
}

/**
 * Build the per-row print model for the whole graph window. Pure function.
 *
 * Resolves each commit's owning-branch color once (so a branch's trunk and its
 * chip can share it); segments with no owning branch fall back to the lane color.
 */
export function buildGraphPrintModel(
  nodes: ICommitNode[],
  options: IBuildPrintModelOptions = {}
): IRowPrintModel[] {
  const branchColors =
    options.branchColors ??
    computeBranchColors(colorNodesFrom(nodes), { headBranchName: options.headBranchName });
  // Compute the merged lane intervals ONCE and derive all four interval-driven
  // maps from it — `computeActiveLanes`, both continues-* maps, and the
  // per-row interval lookup each used to rebuild it independently (5 walks per
  // render), which scales badly as the loaded window grows via "load more".
  const mergedIntervals = collectMergedLaneIntervals(nodes);
  const activeLaneMap = computeActiveLanes(nodes, mergedIntervals);
  const continuesFromAboveMap = computeLaneContinuesFromAbove(nodes, mergedIntervals);
  const continuesBelowMap = computeLaneContinuesBelow(nodes, mergedIntervals);
  const childCountMap = computeChildCountMap(nodes);
  const incomingBendsMap = computeIncomingBendsMap(nodes);
  const bendsLandingBelowMap = computeBendsLandingBelowMap(nodes);
  const terminalNodes = computeTerminalNodes(nodes);
  const intervalLookup = buildIntervalLookup(nodes, mergedIntervals);
  const hashToRow = buildHashToRow(nodes);
  const hasFocusedBranch = nodes.some((n) => n.onFocusedBranchPath === true);
  // The checked-out commit (what HEAD resolves to) earns the white ring — keyed
  // on the commit hash, so it lands on a detached-HEAD commit just as well as a
  // branch tip.
  const currentHeadHash = options.headHash;

  const models = nodes.map((node, rowIndex) =>
    projectRow(node, rowIndex, {
      activeLanes: activeLaneMap.get(rowIndex) ?? new Set<number>(),
      continuesFromAbove: continuesFromAboveMap.get(rowIndex) ?? new Set<number>(),
      continuesBelow: continuesBelowMap.get(rowIndex) ?? new Set<number>(),
      incomingBendLanes: incomingBendsMap.get(commitNodeKey(node.commit)) ?? new Set<number>(),
      bendsLandingBelow: bendsLandingBelowMap.get(rowIndex) ?? new Set<number>(),
      isTerminal: terminalNodes.has(commitNodeKey(node.commit)),
      isCurrentHead: node.commit.hash === currentHeadHash,
      isBranchSplit: isBranchSplit(commitNodeKey(node.commit), childCountMap),
      isLastRow: rowIndex === nodes.length - 1,
      hasFocusedBranch,
      nodes,
      intervalByLane:
        intervalLookup.get(rowIndex) ?? new Map<number, { startRow: number; endRow: number }>(),
      hashToRow,
      branchColors,
    })
  );

  // Long-edge hiding (IntelliJ default): cut edges longer than the threshold to
  // endpoint stubs + arrows so a merge-heavy history doesn't hold dozens of
  // full-span lanes at once. Reuses the merged intervals computed above.
  if (options.hideLongEdges !== false) {
    applyLongEdgeHiding(models, computeLongEdgeCuts(nodes, mergedIntervals));
  }
  return models;
}

/** Build the `commitHash → rowIndex` lookup for a window (O(N), once). */
function buildHashToRow(nodes: ICommitNode[]): Map<string, number> {
  const hashToRow = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) {
    // Node-keyed: same-hash copies across roots each keep their own row.
    hashToRow.set(commitNodeKey(nodes[i].commit), i);
  }
  return hashToRow;
}

/**
 * Resolve which in-window parent row a bending line targets — hash-keyed (never
 * "any later parent by lane match"), mirroring the lookup the interval builder
 * uses. Returns undefined for an off-window parent. Takes a prebuilt
 * `hashToRow` so a window with many bends doesn't rebuild the map per edge.
 */
function findParentRow(
  nodes: ICommitNode[],
  hashToRow: ReadonlyMap<string, number>,
  node: ICommitNode,
  toColumn: number,
  rowIndex: number
): number | undefined {
  for (const parentHash of node.commit.parents) {
    const pr = hashToRow.get(parentNodeKey(node.commit, parentHash));
    if (pr !== undefined && pr > rowIndex && nodes[pr].graphColumn === toColumn) {
      return pr;
    }
  }
  return undefined;
}

/**
 * Total graph pixel width — reduces per-row `inkedLanes` to the max lane index.
 * More correct than the old `getMaxGraphColumn` pass (which omitted far-parent
 * bend source lanes); carries the `isValidLane` clamp so a corrupt index can't
 * blow up the width.
 */
export function computeGraphWidthFromModels(
  models: IRowPrintModel[],
  columnWidth: number,
  padding: number
): number {
  let maxLane = 0;
  for (const m of models) {
    for (const lane of m.inkedLanes) {
      if (isValidLane(lane) && lane > maxLane) {
        maxLane = lane;
      }
    }
  }
  return (maxLane + 1) * columnWidth + padding * 2;
}
