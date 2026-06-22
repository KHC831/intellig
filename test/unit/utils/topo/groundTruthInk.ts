/**
 * Shared node-geometry ink oracle for the topo regression pins.
 *
 * Recomputes, directly from the built node geometry (NOT from the line-style
 * rule under test), the set of lanes that genuinely have ink at each row:
 *   - a node's own column at its row;
 *   - an off-window first-parent mainline continuation: a commit whose FIRST
 *     parent is off-window but which HAS an in-window parent is a trunk that
 *     inks its column straight down to the window bottom;
 *   - a same-lane line's column across its whole span;
 *   - a bending line's DESTINATION column across its span PLUS its source column
 *     at the source row only (the bend lives entirely in the source row);
 *   - a far-parent (`endRow`) line's source lane down to endRow-1 (the bend
 *     itself lands at endRow but is inked there by the parent's own column).
 *
 * Used as an INDEPENDENT cross-check of `computeActiveLanes` — derived from
 * topology, so it catches an orphan active lane (a painted lane with no real
 * ink) without circularity.
 */
import { ICommitNode } from '../../../../src/git-core/commitGraph';

export function groundTruthInk(nodes: ICommitNode[]): Map<number, Set<number>> {
  const rowOf = new Map<string, number>();
  nodes.forEach((n, i) => rowOf.set(n.commit.hash, i));
  const truth = new Map<number, Set<number>>();
  const mark = (row: number, lane: number): void => {
    if (!truth.has(row)) {
      truth.set(row, new Set());
    }
    truth.get(row)!.add(lane);
  };
  nodes.forEach((n, i) => {
    mark(i, n.graphColumn);
    const firstParentOffWindow =
      n.commit.parents.length > 0 && rowOf.get(n.commit.parents[0]) === undefined;
    const hasInWindowParent = n.commit.parents.some((p) => rowOf.get(p) !== undefined);
    if (firstParentOffWindow && hasInWindowParent) {
      for (let r = i; r < nodes.length; r++) {
        mark(r, n.graphColumn);
      }
    }
    for (const line of n.graphLines) {
      if (line.endRow !== undefined) {
        if (line.endRow > i) {
          for (let r = i; r <= line.endRow - 1; r++) {
            mark(r, line.fromColumn);
          }
        } else {
          mark(i, line.fromColumn);
        }
        continue;
      }
      let target = i;
      for (const p of n.commit.parents) {
        const pr = rowOf.get(p);
        if (pr !== undefined && pr > i && nodes[pr].graphColumn === line.toColumn) {
          target = pr;
          break;
        }
      }
      if (line.fromColumn === line.toColumn) {
        for (let r = i; r <= Math.max(i, target); r++) {
          mark(r, line.fromColumn);
        }
      } else {
        mark(i, line.fromColumn);
        for (let r = i; r <= Math.max(i, target); r++) {
          mark(r, line.toColumn);
        }
      }
    }
  });
  return truth;
}
