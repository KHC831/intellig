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
 * This pass relabels each row's columns independently, by RANK: a visible lane's
 * packed column is the count of other visible lanes in that row with a smaller
 * raw index. This is order-preserving by construction (rank cannot invert two
 * lanes' relative order) and every row's column set is dense `{0..k-1}` where k
 * is that row's visible-lane count, with zero cost for a hidden long edge's freed
 * lane (not visible, so not ranked). Runs on the FINAL hidden print model — NOT
 * the interval builder — so per-element colors (already resolved) are untouched.
 * A raw lane's column can differ between two rows even when both draw it (a
 * fork/merge changes which lanes are simultaneously visible); {@link linkSeams}
 * is what keeps the painted line looking continuous across that boundary.
 */

import { isValidLane } from '../../utils/graphRenderer';
import { IRowPrintModel } from './printModel';
import { linkSeams, type IRawEdgeEndpoints } from './laneLinking';

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

/**
 * Per-row raw-lane -> packed-column map: each visible lane's rank (0-based
 * position) among that row's visible lanes sorted ascending by raw index.
 */
function buildRankMap(models: IRowPrintModel[]): Array<Map<number, number>> {
  return models.map((m) => {
    const sorted = [...lanesInRow(m)].sort((a, b) => a - b);
    const map = new Map<number, number>();
    sorted.forEach((lane, rank) => map.set(lane, rank));
    return map;
  });
}

/**
 * Relabel every print-model column to its packed value (see the module doc).
 * Mutates the models in place and returns them. A no-op when nothing compacts.
 */
export function compactPrintModelLanes(models: IRowPrintModel[]): IRowPrintModel[] {
  if (models.length === 0) {
    return models;
  }
  const mapByRow = buildRankMap(models);

  // Capture every edge's RAW (pre-remap) endpoints before the loop below
  // overwrites fromLane/targetLane with packed columns — linkSeams needs the
  // raw values to look up the neighbor row's column for the same physical lane.
  const rawEndpoints: IRawEdgeEndpoints[][] = models.map((m) =>
    m.edges.map((e) => ({ from: e.fromLane, target: e.targetLane }))
  );

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

  linkSeams(models, mapByRow, rawEndpoints);
  return models;
}
