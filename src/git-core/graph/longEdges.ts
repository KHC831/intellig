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
import type { IRowPrintModel } from './printModel';

/** IntelliJ LONG_EDGE_SIZE: an edge spanning >= this many rows is hidden mid-span. */
export const LONG_EDGE_SIZE = 30;
/** IntelliJ LONG_EDGE_PART_SIZE: rows of ink kept within each endpoint. */
export const LONG_EDGE_PART_SIZE = 1;

/** Tunables (exposed for tests + the showLongEdges toggle path). */
export interface ILongEdgeOptions {
  longEdgeSize: number;
  partSize: number;
}

export const DEFAULT_LONG_EDGE_OPTIONS: ILongEdgeOptions = {
  longEdgeSize: LONG_EDGE_SIZE,
  partSize: LONG_EDGE_PART_SIZE,
};

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
 * Compute the long-edge cuts from lane intervals + node positions. A merged
 * interval is split at the rows where a node actually sits on that lane; each
 * resulting gap `[a..b]` with no node in its interior and `b - a >=
 * longEdgeSize` is a long edge. Its interior (rows farther than `partSize` from
 * either end) is hidden; the row `partSize` inside the child endpoint gets a
 * DOWN arrow, the one inside the parent an UP arrow.
 *
 * An interval that runs off the BOTTOM of the loaded window (reaches the last
 * row with no node on its lane there) is skipped: its parent endpoint is
 * off-window, it ends in a "more history below" chevron, and such trunks are
 * bounded by the lanes open at the window edge — not the width driver.
 */
export function computeLongEdgeCuts(
  nodes: ReadonlyArray<Pick<ICommitNode, 'graphColumn'>>,
  mergedIntervals: ReadonlyMap<number, ReadonlyArray<{ startRow: number; endRow: number }>>,
  opts: ILongEdgeOptions = DEFAULT_LONG_EDGE_OPTIONS
): ILongEdgeCuts {
  const hidden = new Map<number, Set<number>>();
  const arrows = new Map<number, Map<number, 'up' | 'down'>>();
  const lastRow = nodes.length - 1;

  const addHidden = (row: number, lane: number): void => {
    let set = hidden.get(row);
    if (!set) {
      hidden.set(row, (set = new Set<number>()));
    }
    set.add(lane);
  };
  const addArrow = (row: number, lane: number, dir: 'up' | 'down'): void => {
    let m = arrows.get(row);
    if (!m) {
      arrows.set(row, (m = new Map<number, 'up' | 'down'>()));
    }
    m.set(lane, dir);
  };

  for (const [lane, laneIntervals] of mergedIntervals) {
    for (const iv of laneIntervals) {
      // An interval running off the bottom of the loaded window ends in a
      // chevron, not a real parent — leave it whole (see doc comment).
      if (iv.endRow === lastRow && nodes[lastRow]?.graphColumn !== lane) {
        continue;
      }
      // Split the interval at the rows where a node actually sits on this lane;
      // each consecutive pair bounds one edge with an empty interior.
      const bounds: number[] = [iv.startRow];
      for (let r = iv.startRow + 1; r < iv.endRow; r++) {
        if (nodes[r]?.graphColumn === lane) {
          bounds.push(r);
        }
      }
      bounds.push(iv.endRow);
      for (let i = 0; i + 1 < bounds.length; i++) {
        const a = bounds[i];
        const b = bounds[i + 1];
        if (b - a < opts.longEdgeSize) {
          continue;
        }
        // Hide rows farther than partSize from either endpoint; the row exactly
        // partSize inside the child endpoint gets a DOWN arrow, inside the
        // parent an UP arrow (both point into the hidden gap).
        for (let r = a + 1; r <= b - 1; r++) {
          const distToChild = r - a;
          const distToParent = b - r;
          if (distToChild === opts.partSize) {
            addArrow(r, lane, 'down');
          } else if (distToParent === opts.partSize) {
            addArrow(r, lane, 'up');
          } else if (distToChild > opts.partSize && distToParent > opts.partSize) {
            addHidden(r, lane);
          }
        }
      }
    }
  }

  return { hidden, arrows };
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
