/**
 * Layer 3 — LANE COMPACTION (the payoff of long-edge hiding).
 *
 * After {@link applyLongEdgeHiding} removes a long edge's middle ink, that edge's
 * lane is still ASSIGNED a high column index (the allocator reserved it across the
 * whole span). On a merge-heavy history dozens of edges are "in flight" at once,
 * so indices climb to ~46 even though only ~10 lanes are ever VISIBLE in a row —
 * and the graph column is sized to the max index, leaving a wide empty gap before
 * the message text.
 *
 * This pass relabels the print model's columns down to the lanes actually drawn.
 * It works on maximal DRAWN row-runs ("clusters"): a long edge contributes two
 * clusters (near each endpoint) with its freed middle in between, and clusters are
 * packed by interval-graph coloring so the column count equals the max lanes drawn
 * in any single row (a constant, not a function of window size). Runs on the FINAL
 * hidden print model — NOT the interval builder — so two branches' intervals are
 * never merged/confused, and per-element colors (already resolved) are untouched.
 * Mirrors IntelliJ's visible-graph layout, which lays out only collapsed edges.
 */

import { isValidLane } from '../../utils/graphRenderer';
import { IRowPrintModel } from './printModel';

/** Every lane a row occupies (node dot + each edge's own/from/target + inked set). */
function lanesInRow(model: IRowPrintModel): Set<number> {
  const lanes = new Set<number>();
  const add = (l: number): void => {
    if (isValidLane(l)) {
      lanes.add(l);
    }
  };
  add(model.node.lane);
  for (const e of model.edges) {
    add(e.lane);
    add(e.fromLane);
    add(e.targetLane);
  }
  for (const l of model.inkedLanes) {
    add(l);
  }
  return lanes;
}

interface ILaneCluster {
  lane: number;
  start: number;
  end: number;
  column: number;
}

/**
 * Split each raw lane's drawn rows into maximal consecutive runs (clusters) and
 * interval-graph-color them: process clusters by start row, giving each the lowest
 * column free at that row. Overlapping clusters (different lanes drawn in the same
 * rows) get distinct columns; a lane's disjoint clusters (the two ends of a hidden
 * long edge) are colored independently, so the total column count equals the max
 * lanes drawn in one row. The mainline (lane 0, drawn from row 0) sorts first and
 * keeps column 0.
 */
function buildClusters(models: IRowPrintModel[]): ILaneCluster[] {
  const rowsOfLane = new Map<number, number[]>();
  models.forEach((m, row) => {
    for (const lane of lanesInRow(m)) {
      let rows = rowsOfLane.get(lane);
      if (!rows) {
        rowsOfLane.set(lane, (rows = []));
      }
      rows.push(row);
    }
  });

  const clusters: ILaneCluster[] = [];
  for (const [lane, rows] of rowsOfLane) {
    rows.sort((a, b) => a - b);
    let start = rows[0];
    let prev = rows[0];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i] === prev + 1) {
        prev = rows[i];
        continue;
      }
      clusters.push({ lane, start, end: prev, column: -1 });
      start = prev = rows[i];
    }
    clusters.push({ lane, start, end: prev, column: -1 });
  }

  // Interval-graph greedy: sort by start (then lane for stability); assign the
  // lowest column whose last cluster ended strictly before this one starts.
  clusters.sort((a, b) => a.start - b.start || a.lane - b.lane);
  const columnFreeAfter: number[] = []; // columnFreeAfter[c] = last end row on column c
  for (const cl of clusters) {
    let col = 0;
    while (col < columnFreeAfter.length && columnFreeAfter[col] >= cl.start) {
      col++;
    }
    if (col === columnFreeAfter.length) {
      columnFreeAfter.push(cl.end);
    } else {
      columnFreeAfter[col] = cl.end;
    }
    cl.column = col;
  }
  return clusters;
}

/**
 * Relabel every print-model column to its packed value (see the module doc).
 * Mutates the models in place and returns them. A no-op when nothing compacts.
 */
export function compactPrintModelLanes(models: IRowPrintModel[]): IRowPrintModel[] {
  if (models.length === 0) {
    return models;
  }
  // Per-row lane -> packed column.
  const mapByRow: Array<Map<number, number>> = models.map(() => new Map<number, number>());
  for (const cl of buildClusters(models)) {
    for (let r = cl.start; r <= cl.end; r++) {
      mapByRow[r].set(cl.lane, cl.column);
    }
  }

  models.forEach((m, row) => {
    const map = mapByRow[row];
    const remap = (lane: number): number => (isValidLane(lane) ? (map.get(lane) ?? lane) : lane);
    m.node.lane = remap(m.node.lane);
    for (const e of m.edges) {
      e.lane = remap(e.lane);
      e.fromLane = remap(e.fromLane);
      e.targetLane = remap(e.targetLane);
    }
    m.inkedLanes = m.inkedLanes.map(remap);
    m.chevronLanes = m.chevronLanes.map(remap);
  });
  return models;
}
