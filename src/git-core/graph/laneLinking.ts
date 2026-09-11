/**
 * Layer 3 — SEAM LINKING (docks a compacted edge to its neighbor row's column).
 *
 * {@link compactPrintModelLanes} relabels each row's lanes independently by
 * rank — a visible lane's packed column is the count of other visible lanes in
 * that row with a smaller raw index — so a raw lane's column can legitimately
 * differ from one row to the next whenever a lane appears or vanishes to its
 * left (a fork/merge, or a hidden long-edge gap freeing a column). Without a
 * seam, the painter draws a straight vertical at each row's OWN column and the
 * line visibly jumps sideways at the boundary. This module computes, per edge
 * half that touches a row boundary, which column the NEIGHBOR row actually
 * drew — {@link IRowEdgeElement.topLane} / {@link IRowEdgeElement.bottomLane} —
 * so the painter (Layer 4) can slant the last pixel-or-two toward it instead.
 *
 * ONE rule with a precedence, not two:
 *   straight: byIdentity[neighbor row][edge identity] ?? rawToColumn[neighbor row][raw lane] ?? own column
 *   bend:                                                rawToColumn[neighbor row][raw endpoint] ?? own column
 *
 * A bend skips the identity step: its continuation across a row boundary is
 * always a DIFFERENT edge by construction (the curve terminates at a node; the
 * line on the other side of the boundary belongs to a different parent/child).
 *
 * The raw-lane fallback is load-bearing, not tidiness: without it (identity,
 * then own column), a fork/merge boundary where two DIFFERENT edges share a
 * physical lane briefly fails to connect (measured: 173 broken row boundaries
 * on a real merge-heavy history, against 47 today — worse than shipped, in a
 * change whose whole point is that lines connect).
 */

import type { IRowEdgeElement, IRowPrintModel, IGraphEdgeId } from './printModel';

/** Raw (pre-remap) endpoints of one edge, captured before compaction overwrites
 * `fromLane`/`targetLane` with packed columns. For a straight segment `from ===
 * target === ` the raw lane; for a bend they're the raw source/destination. */
export interface IRawEdgeEndpoints {
  from: number;
  target: number;
}

/** Same identity string shape used by the test invariant suite (edgeKey in
 * test/support/graphInvariants.ts) — childRow + parent end + raw lane. */
function edgeIdKey(id: IGraphEdgeId): string {
  const parent = id.parent.kind === 'inWindow' ? `r${id.parent.row}` : 'off';
  return `${id.childRow}:${parent}:${id.lane}`;
}

/** Per-row identity → packed column, built from the ALREADY-REMAPPED models
 * (identity never changes across compaction, so this needs no raw capture). */
function buildIdentityMaps(models: IRowPrintModel[]): Array<Map<string, number>> {
  return models.map((m) => {
    const map = new Map<string, number>();
    for (const e of m.edges) {
      if (!e.curved && e.fromLane === e.targetLane) {
        map.set(edgeIdKey(e.edge), e.lane);
      }
    }
    return map;
  });
}

/**
 * Seam column for a STRAIGHT segment's one neighbor row. Identity match wins
 * (the SAME edge continuing) over a raw-lane match (a different edge sharing
 * the physical lane at a boundary) over no match (own column — no seam).
 */
function straightSeam(
  neighborIdentity: Map<string, number> | undefined,
  neighborRawToColumn: Map<number, number> | undefined,
  e: IRowEdgeElement,
  ownColumn: number
): number {
  const byIdentity = neighborIdentity?.get(edgeIdKey(e.edge));
  if (byIdentity !== undefined) {
    return byIdentity;
  }
  const byRawLane = neighborRawToColumn ? neighborRawToColumn.get(e.edge.lane) : undefined;
  if (byRawLane !== undefined) {
    return byRawLane;
  }
  return ownColumn;
}

/**
 * Seam columns for a BEND (merge/branch/far-parent curve). No identity step —
 * see the module doc. Falls back to the bend's own (already-remapped) column
 * when the neighbor row never claimed that raw endpoint's lane.
 */
function bendSeam(
  row: number,
  e: IRowEdgeElement,
  raw: IRawEdgeEndpoints,
  rawToColumn: ReadonlyArray<Map<number, number>>
): { topLane: number; bottomLane: number } {
  const topLane = row - 1 >= 0 ? (rawToColumn[row - 1].get(raw.from) ?? e.fromLane) : e.fromLane;
  const bottomLane =
    row + 1 < rawToColumn.length
      ? (rawToColumn[row + 1].get(raw.target) ?? e.targetLane)
      : e.targetLane;
  return { topLane, bottomLane };
}

/**
 * Dock every edge half that touches a row boundary to its neighbor row's
 * column, and fold both seam lanes into `inkedLanes` (a segment slanting
 * toward a column that exists only in the ADJACENT row would otherwise get
 * clipped by this row's own `svgWidth` — both values are already columns that
 * exist in some row, so this cannot widen the global gutter).
 *
 * `rawToColumn[row]` is the raw-lane → packed-column map for that row (the
 * SAME map {@link compactPrintModelLanes} builds for the remap itself — pass
 * it straight through, do not rebuild it). `rawEndpoints[row][i]` is edge `i`
 * in that row's PRE-remap `{ from, target }` — must be captured before the
 * remap loop overwrites `fromLane`/`targetLane` with packed columns, or a
 * raw-keyed lookup silently docks to the wrong line (this is the one bug a
 * prototype shipped with every other invariant green).
 */
export function linkSeams(
  models: IRowPrintModel[],
  rawToColumn: ReadonlyArray<Map<number, number>>,
  rawEndpoints: ReadonlyArray<ReadonlyArray<IRawEdgeEndpoints>>
): void {
  const identityMaps = buildIdentityMaps(models);

  models.forEach((m, row) => {
    m.edges.forEach((e, i) => {
      const raw = rawEndpoints[row][i];
      if (!e.curved && e.fromLane === e.targetLane) {
        if (e.half === 'full' || e.half === 'up') {
          e.topLane = straightSeam(identityMaps[row - 1], rawToColumn[row - 1], e, e.lane);
        }
        if (e.half === 'full' || e.half === 'down') {
          e.bottomLane = straightSeam(identityMaps[row + 1], rawToColumn[row + 1], e, e.lane);
        }
      } else if (e.curved) {
        const seam = bendSeam(row, e, raw, rawToColumn);
        if (e.half === 'up') {
          e.topLane = seam.topLane;
        } else if (e.half === 'down') {
          e.bottomLane = seam.bottomLane;
        }
      }
    });

    const inked = new Set(m.inkedLanes);
    for (const e of m.edges) {
      if (e.topLane !== undefined) {
        inked.add(e.topLane);
      }
      if (e.bottomLane !== undefined) {
        inked.add(e.bottomLane);
      }
    }
    m.inkedLanes = [...inked];
  });
}
