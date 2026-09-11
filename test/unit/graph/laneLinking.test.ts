/**
 * Seam-linking unit coverage. `linkSeams` takes `rawToColumn` and
 * `rawEndpoints` as parameters, so — unlike the production pipeline, which can
 * never disagree with its own identity map — a test can hand it a
 * `rawToColumn` that disagrees with identity. That is the only way to tell
 * `straightSeam`'s three arms (identity, raw lane, own column) apart.
 */

import '../../setup';
import * as assert from 'assert';
import { linkSeams, type IRawEdgeEndpoints } from '../../../src/git-core/graph/laneLinking';
import type {
  EdgeHalf,
  IRowEdgeElement,
  IRowPrintModel,
} from '../../../src/git-core/graph/printModel';

function mkModel(rowIndex: number, edges: IRowEdgeElement[]): IRowPrintModel {
  return {
    rowIndex,
    node: {
      lane: -1,
      isMerge: false,
      isTerminal: false,
      isCurrentHead: false,
      isBranchSplit: false,
      onFocusedBranchPath: false,
    },
    edges,
    inkedLanes: [...new Set(edges.map((e) => e.lane))],
    isLastRow: false,
    chevronLanes: [],
    hasFocusedBranch: false,
  };
}

/** A straight vertical: `edge.lane` is the raw identity lane; `lane` is the
 * already-packed column linkSeams sees. */
function straightEdge(
  rawLane: number,
  column: number,
  half: EdgeHalf,
  childRow = 0,
  parentRow = 1
): IRowEdgeElement {
  return {
    edge: { childRow, parent: { kind: 'inWindow', row: parentRow }, lane: rawLane },
    half,
    lane: column,
    fromLane: column,
    targetLane: column,
    curved: false,
    type: 'commit',
    style: 'solid',
  };
}

/** A bend (merge/branch curve). `bendSeam` reads only `fromLane`/`targetLane`
 * (as the own-column fallback) and the caller-supplied raw endpoints — its
 * `edge` identity is never consulted. */
function bendEdge(half: 'up' | 'down', fromLane: number, targetLane: number): IRowEdgeElement {
  return {
    edge: { childRow: 0, parent: { kind: 'inWindow', row: 1 }, lane: 0 },
    half,
    lane: half === 'up' ? fromLane : targetLane,
    fromLane,
    targetLane,
    curved: true,
    type: 'merge',
    style: 'solid',
  };
}

function endpoints(from: number, target: number): IRawEdgeEndpoints {
  return { from, target };
}

describe('linkSeams', () => {
  it('SYNTHETIC (pipeline-unreachable): given a rawToColumn that disagrees with identity, identity wins over a decoy raw-lane entry — pins the precedence contract for the retained identity seam, not a real-output claim', () => {
    // linkSeams takes rawToColumn as a parameter, so this test can hand it a
    // value the real pipeline never produces: identity and raw-lane
    // DISAGREEING. In production both maps derive from the same per-row rank
    // map, so identity — whenever it resolves — always names the same column
    // raw-lane would (ADR-016); this decoy makes the identity arm observable
    // in isolation, the way a real repaint never can (the empty-rawToColumn
    // case below does the same by omission rather than disagreement).
    //
    // Row 0's edge and row 1's edge share the same raw identity (childRow 0,
    // parent row 1, raw lane 5) — the same abstract line continuing across the
    // boundary — but row 1 repacked it to column 2. rawToColumn[1] carries a
    // decoy entry mapping raw lane 5 to column 0; if identity were deleted,
    // the raw-lane arm would answer 0 instead of the real 2.
    const row0Edge = straightEdge(5, 1, 'down');
    const row1Edge = straightEdge(5, 2, 'up');
    const models = [mkModel(0, [row0Edge]), mkModel(1, [row1Edge])];
    const rawToColumn = [new Map<number, number>(), new Map([[5, 0]])];
    const rawEndpoints = [[endpoints(1, 1)], [endpoints(2, 2)]];

    linkSeams(models, rawToColumn, rawEndpoints);

    assert.strictEqual(row0Edge.bottomLane, 2, 'identity must win over the decoy raw-lane entry');
  });

  it('a straight boundary with no identity match falls back to the raw-lane entry, not its own column', () => {
    // Row 1 carries a DIFFERENT edge's identity (raw lane 7) — no identity
    // match for row 0's raw lane 5 — but rawToColumn[1] records that some
    // other edge occupies raw lane 5's column at row 1.
    const row0Edge = straightEdge(5, 1, 'down');
    const row1Edge = straightEdge(7, 0, 'full');
    const models = [mkModel(0, [row0Edge]), mkModel(1, [row1Edge])];
    const rawToColumn = [new Map<number, number>(), new Map([[5, 3]])];
    const rawEndpoints = [[endpoints(1, 1)], [endpoints(0, 0)]];

    linkSeams(models, rawToColumn, rawEndpoints);

    assert.strictEqual(row0Edge.bottomLane, 3, 'raw-lane match must win over own column');
  });

  it('the raw-lane arm keys on the physical lane, not on the edge that occupies it', () => {
    // The neighbour row's element on the shared raw lane is a DIFFERENT edge
    // with a different endpoint. Keying on the lane resolves the column the
    // neighbour actually drew; keying on the edge or its endpoint node — the
    // shape IntelliJ's own resolver uses, which is why the two are not
    // interchangeable — finds nothing and falls through to the own column.
    const row0Edge = straightEdge(5, 1, 'down');
    const row1Edge = straightEdge(5, 4, 'full');
    row1Edge.edge = { ...row1Edge.edge, childRow: 99, parent: { kind: 'inWindow', row: 100 } };
    const models = [mkModel(0, [row0Edge]), mkModel(1, [row1Edge])];
    const rawToColumn = [new Map<number, number>(), new Map([[5, 4]])];
    const rawEndpoints = [[endpoints(1, 1)], [endpoints(4, 4)]];

    linkSeams(models, rawToColumn, rawEndpoints);

    assert.strictEqual(
      row0Edge.bottomLane,
      4,
      'a lane-keyed lookup docks to the neighbour column; an endpoint-keyed one would not'
    );
  });

  it('a straight boundary with neither an identity nor a raw-lane match keeps its own column (no seam)', () => {
    const row0Edge = straightEdge(5, 1, 'down');
    const models = [mkModel(0, [row0Edge]), mkModel(1, [])];
    const rawToColumn = [new Map<number, number>(), new Map<number, number>()];
    const rawEndpoints = [[endpoints(1, 1)], []];

    linkSeams(models, rawToColumn, rawEndpoints);

    assert.strictEqual(row0Edge.bottomLane, 1, 'no match must collapse to the edge’s own column');
  });

  it('collapses to its own column at both window edges without throwing (no row above the first, none below the last)', () => {
    const topEdge = straightEdge(5, 1, 'up');
    const bottomEdge = straightEdge(5, 1, 'down');
    const models = [mkModel(0, [topEdge]), mkModel(1, [bottomEdge])];
    const rawToColumn = [new Map<number, number>(), new Map<number, number>()];
    const rawEndpoints = [[endpoints(1, 1)], [endpoints(1, 1)]];

    assert.doesNotThrow(() => linkSeams(models, rawToColumn, rawEndpoints));
    assert.strictEqual(topEdge.topLane, 1, 'no row above row 0: own column');
    assert.strictEqual(bottomEdge.bottomLane, 1, 'no row below the last row: own column');
  });

  it('a bend reads the RAW endpoint against the neighbor row, not its own already-packed lane', () => {
    // 'down' half: bottomLane must come from rawToColumn[row+1] keyed on the
    // RAW target (9), not the bend's own (already-remapped) targetLane (1).
    const downBend = bendEdge('down', 0, 1);
    const rowsDown = [mkModel(0, [downBend]), mkModel(1, [])];
    linkSeams(rowsDown, [new Map(), new Map([[9, 4]])], [[endpoints(0, 9)], []]);
    assert.strictEqual(downBend.bottomLane, 4, 'must key off the raw target, not targetLane');

    // 'up' half: topLane must come from rawToColumn[row-1] keyed on the RAW
    // source (9), not the bend's own fromLane (0).
    const upBend = bendEdge('up', 0, 1);
    const rowsUp = [mkModel(0, []), mkModel(1, [upBend])];
    linkSeams(rowsUp, [new Map([[9, 4]]), new Map()], [[], [endpoints(9, 1)]]);
    assert.strictEqual(upBend.topLane, 4, 'must key off the raw source, not fromLane');
  });

  it("bendEdge's own lane stays aliased to the endpoint printModel.ts aliases it to (down: targetLane, up: fromLane)", () => {
    // linkSeams/bendSeam never reads a curved edge's own `lane` field — it
    // keys purely on the raw endpoints — so this alias is inert for seam
    // docking. It is load-bearing for workspace-notes/verify/measureSlantHistogram.ts
    // (see ADR-016), which measures every seam's displacement as
    // `|paintedLane - e.lane|` and is correct only because printModel.ts's
    // down-bend push sets `lane: line.toColumn` beside `targetLane:
    // line.toColumn`, and its up-bend push sets `lane: sourceLane` beside
    // `fromLane: sourceLane`. Nothing else in this suite pins it.
    const down = bendEdge('down', 0, 1);
    assert.strictEqual(down.lane, down.targetLane, 'a down bend keeps lane aliased to targetLane');
    const up = bendEdge('up', 0, 1);
    assert.strictEqual(up.lane, up.fromLane, 'an up bend keeps lane aliased to fromLane');
  });

  it('folds both stamped seam lanes into inkedLanes so a slanting segment is not clipped by its own row width', () => {
    // rawToColumn is empty for both rows, so the raw-lane arm can never
    // resolve here — pipeline-unreachable the same way the SYNTHETIC case
    // above is, just by omission rather than a disagreeing decoy. The seam
    // columns this test asserts on can only come from the identity arm.
    const row0Edge = straightEdge(5, 1, 'down');
    const row1Edge = straightEdge(5, 3, 'up');
    const models = [mkModel(0, [row0Edge]), mkModel(1, [row1Edge])];
    const rawToColumn = [new Map<number, number>(), new Map<number, number>()];
    const rawEndpoints = [[endpoints(1, 1)], [endpoints(3, 3)]];

    linkSeams(models, rawToColumn, rawEndpoints);

    assert.ok(models[0].inkedLanes.includes(3), 'row 0 must ink its bottom seam column');
    assert.ok(models[1].inkedLanes.includes(1), 'row 1 must ink its top seam column');
  });
});
