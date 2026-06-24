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
  isBranchSplit,
} from '../commitGraph';
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

/** Edge identity: child row (newer) + parent end + the edge's own lane. */
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
}

/** The commit dot for the row. */
export interface IRowNodeElement {
  lane: number;
  isMerge: boolean;
  isTerminal: boolean;
  isBranchSplit: boolean;
  onFocusedBranchPath: boolean;
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
  hasFocusedBranch: boolean;
}

/**
 * Per (row, lane) → the merged interval covering it, so a pass-through segment
 * can carry its edge identity (childRow = interval start; parent = interval end,
 * tagged off-window when the lane runs off the bottom of the loaded slice).
 */
function buildIntervalLookup(
  nodes: ICommitNode[]
): Map<number, Map<number, { startRow: number; endRow: number }>> {
  const byRow = new Map<number, Map<number, { startRow: number; endRow: number }>>();
  for (let i = 0; i < nodes.length; i++) {
    byRow.set(i, new Map());
  }
  for (const [lane, intervals] of collectMergedLaneIntervals(nodes)) {
    for (const iv of intervals) {
      for (let row = iv.startRow; row <= iv.endRow; row++) {
        byRow.get(row)?.set(lane, iv);
      }
    }
  }
  return byRow;
}

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
  isBranchSplit: boolean;
  isLastRow: boolean;
  hasFocusedBranch: boolean;
  /** Full node list — for hash-keyed parent resolution + off-window edge identity. */
  nodes: ICommitNode[];
  /** Merged interval covering each lane at this row, for pass-through edge identity. */
  intervalByLane: Map<number, { startRow: number; endRow: number }>;
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

  const edges: IRowEdgeElement[] = [];
  const bottomInkLanes = new Set<number>();
  const chevronLanes = new Set<number>();

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
    const straight = (half: EdgeHalf): IRowEdgeElement => ({
      edge,
      half,
      lane,
      fromLane: lane,
      targetLane: lane,
      curved: false,
      type: 'commit',
      style: 'solid',
    });
    if (enters && exits) {
      edges.push(straight(isBezierTarget ? 'up' : 'full'));
    } else if (enters && !exits) {
      edges.push(straight('up'));
    } else if (!enters && exits && !isBezierTarget) {
      edges.push(straight('down'));
    }
    // !enters && !exits, or born bezier target: nothing straight (bezier/node draws it).
  }

  // --- Own-lane segments around the commit dot ---
  if (isValidLane(ownLane)) {
    const ownEdge = laneEdgeId(nodes, ivLookup.get(ownLane), ownLane, rowIndex);
    if (continuesFromAbove.has(ownLane)) {
      edges.push({
        edge: ownEdge,
        half: 'up',
        lane: ownLane,
        fromLane: ownLane,
        targetLane: ownLane,
        curved: false,
        type: 'commit',
        style: 'solid',
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
    const parentRow = findParentRow(nodes, node, line.toColumn, rowIndex);
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
        // First-parent far edge → L4 source-lane color; the (type==='commit' || !curved)
        // short-circuit is load-bearing here (curved AND first-parent).
        type: 'commit',
        style: 'solid',
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
    isBranchSplit: ctx.isBranchSplit,
    onFocusedBranchPath: node.onFocusedBranchPath === true,
  };

  return {
    rowIndex,
    node: nodeEl,
    edges,
    inkedLanes: [...inkedLanes],
    isLastRow,
    chevronLanes: [...chevronLanes].filter(isValidLane),
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

/**
 * Build the per-row print model for the whole graph window. Pure function.
 */
export function buildGraphPrintModel(nodes: ICommitNode[]): IRowPrintModel[] {
  const activeLaneMap = computeActiveLanes(nodes);
  const continuesFromAboveMap = computeLaneContinuesFromAbove(nodes);
  const continuesBelowMap = computeLaneContinuesBelow(nodes);
  const childCountMap = computeChildCountMap(nodes);
  const incomingBendsMap = computeIncomingBendsMap(nodes);
  const bendsLandingBelowMap = computeBendsLandingBelowMap(nodes);
  const terminalNodes = computeTerminalNodes(nodes);
  const intervalLookup = buildIntervalLookup(nodes);
  const hasFocusedBranch = nodes.some((n) => n.onFocusedBranchPath === true);

  return nodes.map((node, rowIndex) =>
    projectRow(node, rowIndex, {
      activeLanes: activeLaneMap.get(rowIndex) ?? new Set<number>(),
      continuesFromAbove: continuesFromAboveMap.get(rowIndex) ?? new Set<number>(),
      continuesBelow: continuesBelowMap.get(rowIndex) ?? new Set<number>(),
      incomingBendLanes: incomingBendsMap.get(node.commit.hash) ?? new Set<number>(),
      bendsLandingBelow: bendsLandingBelowMap.get(rowIndex) ?? new Set<number>(),
      isTerminal: terminalNodes.has(node.commit.hash),
      isBranchSplit: isBranchSplit(node.commit.hash, childCountMap),
      isLastRow: rowIndex === nodes.length - 1,
      hasFocusedBranch,
      nodes,
      intervalByLane:
        intervalLookup.get(rowIndex) ?? new Map<number, { startRow: number; endRow: number }>(),
    })
  );
}

/**
 * Resolve which in-window parent row a bending line targets — hash-keyed (never
 * "any later parent by lane match"), mirroring the lookup the interval builder
 * uses. Returns undefined for an off-window parent.
 */
function findParentRow(
  nodes: ICommitNode[],
  node: ICommitNode,
  toColumn: number,
  rowIndex: number
): number | undefined {
  const hashToRow = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) {
    hashToRow.set(nodes[i].commit.hash, i);
  }
  for (const parentHash of node.commit.parents) {
    const pr = hashToRow.get(parentHash);
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
