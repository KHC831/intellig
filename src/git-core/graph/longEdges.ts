/**
 * Layer 3 — LONG-EDGE HIDING (IntelliJ vcs-log parity, default ON).
 *
 * A merge-heavy history draws many parallel lanes whose edges span hundreds of
 * rows between their endpoints; each such edge holds a lane for its whole span,
 * so the graph column grows to swallow the panel. IntelliJ's default hides the
 * MIDDLE of any edge longer than {@link LONG_EDGE_SIZE} rows, drawing ink only
 * within {@link LONG_EDGE_PART_SIZE} rows of each endpoint and cutting it with a
 * small arrow stub. Mirrors PrintElementGeneratorImpl.kt (`isEdgeVisibleInRow` /
 * `getArrowType`): an edge `up→down` with `down-up >= longEdgeSize` is visible
 * only where `min(row-up, down-row) <= visiblePartSize`; the row one step inside
 * the child endpoint gets a DOWN arrow, the row one step inside the parent an UP
 * arrow. Both arrows point INTO the hidden gap.
 *
 * This is a PURE post-projection over {@link IRowPrintModel}[] (ADR-013 layer
 * discipline): topology/cut decisions live here; the dumb Layer-4 painter only
 * learns to draw an arrowhead ({@link IRowEdgeElement.arrow}). It reuses the
 * already-resolved per-element colors, so a cut stub keeps its branch color at
 * both ends.
 */

import type { ICommitNode } from '../commitGraph';
import type { ILaneInterval } from '../../utils/graphRenderer';
import { binarySearch } from './graphLayout';
import type { IRowPrintModel } from './printModel';

/** IntelliJ LONG_EDGE_SIZE: an edge spanning >= this many rows is hidden mid-span. */
export const LONG_EDGE_SIZE = 30;
/**
 * IntelliJ LONG_EDGE_PART_SIZE: rows of ink kept within each endpoint. A
 * constant rather than a parameter on purpose: at least one row is what an
 * arrow stub is cut from, so a value below 1 would hide a gap with nothing to
 * cap it.
 */
const LONG_EDGE_PART_SIZE = 1;

/**
 * The cuts for a whole window: which (row, lane) pass-throughs to suppress, and
 * which (row, lane) become arrow stubs (with the arrow direction).
 */
export interface ILongEdgeCuts {
  /** row → lanes whose straight pass-through ink is removed at that row. */
  hidden: Map<number, Set<number>>;
  /** row → (lane → arrow direction) for the cut stubs near each endpoint. */
  arrows: Map<number, Map<number, 'up' | 'down'>>;
}

/**
 * Compute the long-edge cuts from per-edge lane intervals + node positions.
 *
 * Visibility is decided one EDGE at a time, as PrintElementGeneratorImpl.kt's
 * `isEdgeVisibleInRow` does: it asks about one edge and knows nothing of lanes.
 * An edge spanning at least {@link LONG_EDGE_SIZE} rows keeps ink within
 * {@link LONG_EDGE_PART_SIZE} rows of each endpoint; a shorter one stays whole.
 *
 * Several edges can share one lane, so a long edge hides only the stretches no
 * other edge inks. Each such stretch is its own gap, capped by its own DOWN
 * arrow at the top and UP arrow at the bottom, so a short merge beginning
 * inside a long edge's span keeps its ink and the long edge is cut around it.
 * Deciding this from merged intervals instead cannot tell the pair from one
 * edge spanning both, which silently erases the shorter edge.
 *
 * One edge is exempt: one whose parent is not loaded ({@link
 * ILaneInterval.offWindow}). It ends in a "more history below" chevron rather
 * than at a commit, so it stays whole. This is an IntelliG divergence —
 * IntelliJ draws an off-window edge as a special dotted-arrow edge with a stub
 * beside its anchor (PrintElementGeneratorImpl.kt, DOTTED_ARROW_DOWN /
 * NOT_LOAD_COMMIT). Only that edge is exempt: an earlier long edge on the same
 * lane, the mainline's own included, is hidden like any other.
 *
 * Every lane is reasoned about in intervals, never row by row, so the cost
 * follows the number of edges and nodes, plus the rows actually hidden: many
 * edges converging on one parent do not each pay for the rows they span.
 */
export function computeLongEdgeCuts(
  nodes: ReadonlyArray<Pick<ICommitNode, 'graphColumn'>>,
  edgeIntervals: ReadonlyMap<number, ReadonlyArray<ILaneInterval>>
): ILongEdgeCuts {
  const hidden = new Map<number, Set<number>>();
  const arrows = new Map<number, Map<number, 'up' | 'down'>>();

  // Rows holding a node, per lane, ascending.
  const nodeRows = new Map<number, number[]>();
  nodes.forEach((node, row) => getOrInit(nodeRows, node.graphColumn, () => []).push(row));

  for (const [lane, intervals] of edgeIntervals) {
    for (const [first, last] of hiddenRuns(intervals, nodeRows.get(lane) ?? [])) {
      // A stub costs a row at each end, so hide a run only when at least two
      // rows are left to hide: a pair of arrowheads around one blank row buys
      // nothing and reads as noise.
      if (last - first < 2 * LONG_EDGE_PART_SIZE + 1) {
        continue;
      }
      getOrInit(arrows, first + LONG_EDGE_PART_SIZE - 1, () => new Map()).set(lane, 'down');
      getOrInit(arrows, last - LONG_EDGE_PART_SIZE + 1, () => new Map()).set(lane, 'up');
      for (let r = first + LONG_EDGE_PART_SIZE; r <= last - LONG_EDGE_PART_SIZE; r++) {
        getOrInit(hidden, r, () => new Set()).add(lane);
      }
    }
  }

  return { hidden, arrows };
}

/**
 * The runs of rows on one lane that nothing draws inside a long stretch, as
 * `[first, last]` pairs, each at most once.
 *
 * An edge is split at the nodes on its own lane, and each stretch between
 * them is judged on its own length: a short stretch is drawn whole, a long one
 * keeps only its endpoints. Hiding is only sound where NOTHING draws, so the
 * rows every edge keeps drawn are gathered first, as intervals, and a long
 * stretch hides only the gaps between them.
 *
 * Stretches strictly between two nodes are shared by every edge crossing both
 * nodes, so they are counted on the node axis — a +1/-1 per edge, summed once
 * — rather than enumerated per edge.
 */
function hiddenRuns(
  intervals: ReadonlyArray<ILaneInterval>,
  laneNodes: readonly number[]
): Array<[number, number]> {
  const drawn: Array<[number, number]> = [];
  const stretches: Array<[number, number]> = [];
  const stretch = (a: number, b: number): void => {
    if (b - a < LONG_EDGE_SIZE) {
      drawn.push([a, b]);
    } else {
      drawn.push([a, a], [b, b]);
      stretches.push([a, b]);
    }
  };
  // crossings[k] - crossings[k-1] counts the edges that span the gap between
  // node k and node k + 1.
  const crossings = new Int32Array(laneNodes.length + 1);

  for (const iv of intervals) {
    if (iv.offWindow === true) {
      drawn.push([iv.startRow, iv.endRow]);
      continue;
    }
    const firstInside = upperBound(laneNodes, iv.startRow);
    const lastInside = lowerBound(laneNodes, iv.endRow) - 1;
    if (firstInside > lastInside) {
      stretch(iv.startRow, iv.endRow);
      continue;
    }
    stretch(iv.startRow, laneNodes[firstInside]);
    stretch(laneNodes[lastInside], iv.endRow);
    crossings[firstInside] += 1;
    crossings[lastInside] -= 1;
  }
  let depth = 0;
  for (let k = 0; k + 1 < laneNodes.length; k++) {
    depth += crossings[k];
    if (depth > 0) {
      stretch(laneNodes[k], laneNodes[k + 1]);
    }
  }

  const inked = mergeSpans(drawn);
  const runs: Array<[number, number]> = [];
  // Walk the stretches top down, each row once. Every stretch's own endpoints
  // are drawn, so no run crosses them: the rows an overlapping stretch shares
  // with one above it were already cut.
  stretches.sort((x, y) => x[0] - y[0]);
  let walkedUntil = -1;
  for (const [a, b] of stretches) {
    let row = Math.max(a, walkedUntil) + 1;
    const end = b - 1;
    let i = firstEndingAtOrAfter(inked, row);
    while (row <= end) {
      if (i < inked.length && inked[i][0] <= row) {
        row = inked[i][1] + 1;
        i++;
        continue;
      }
      const runEnd = Math.min(end, i < inked.length ? inked[i][0] - 1 : end);
      runs.push([row, runEnd]);
      row = runEnd + 1;
    }
    walkedUntil = Math.max(walkedUntil, end);
  }
  return runs;
}

/** Union of `[start, end]` spans as sorted, disjoint, non-adjacent spans. */
function mergeSpans(spans: Array<[number, number]>): Array<[number, number]> {
  spans.sort((x, y) => x[0] - y[0]);
  const out: Array<[number, number]> = [];
  for (const [start, end] of spans) {
    const last = out[out.length - 1];
    if (last !== undefined && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      out.push([start, end]);
    }
  }
  return out;
}

/** Index of the first span ending at or after `row`. */
function firstEndingAtOrAfter(spans: Array<[number, number]>, row: number): number {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (spans[mid][1] < row) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/** Index of the first entry greater than `row` (entries are distinct). */
function upperBound(sorted: readonly number[], row: number): number {
  const found = binarySearch(sorted, row);
  return found >= 0 ? found + 1 : -(found + 1);
}

/** Index of the first entry at or after `row` (entries are distinct). */
function lowerBound(sorted: readonly number[], row: number): number {
  const found = binarySearch(sorted, row);
  return found >= 0 ? found : -(found + 1);
}

function getOrInit<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  let value = map.get(key);
  if (value === undefined) {
    value = make();
    map.set(key, value);
  }
  return value;
}

/**
 * Apply {@link computeLongEdgeCuts} to a window's print models: drop hidden
 * pass-through segments (and the hidden lane from `inkedLanes`), and turn the
 * two cut rows into half-height arrow stubs. Returns the SAME model objects,
 * mutated in place (they are freshly built by {@link buildGraphPrintModel}).
 */
export function applyLongEdgeHiding(
  models: IRowPrintModel[],
  cuts: ILongEdgeCuts
): IRowPrintModel[] {
  for (const model of models) {
    const hiddenLanes = cuts.hidden.get(model.rowIndex);
    const arrowLanes = cuts.arrows.get(model.rowIndex);
    if (!hiddenLanes && !arrowLanes) {
      continue;
    }
    if (hiddenLanes) {
      // Drop only the straight pass-through on a hidden lane (a bezier crossing
      // it, or a node dot, stays — hidden rows have no node on the lane by
      // construction, so this only ever removes the transiting vertical).
      model.edges = model.edges.filter(
        (e) => !(hiddenLanes.has(e.lane) && !e.curved && e.fromLane === e.targetLane)
      );
      model.inkedLanes = model.inkedLanes.filter((l) => !hiddenLanes.has(l));
    }
    if (arrowLanes) {
      for (const e of model.edges) {
        if (e.curved || e.fromLane !== e.targetLane) {
          continue;
        }
        const dir = arrowLanes.get(e.lane);
        if (dir === undefined) {
          continue;
        }
        // Down arrow (child side): stub connects UP to the child (top→center).
        // Up arrow (parent side): stub connects DOWN to the parent (center→bottom).
        e.half = dir === 'down' ? 'up' : 'down';
        e.arrow = dir;
      }
    }
  }
  return models;
}
