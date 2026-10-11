/**
 * Long-edge hiding (IntelliJ vcs-log parity). Verifies the pure cut computation
 * (which mid-span rows are hidden, where the arrow stubs land) and the model
 * transform (pass-through removal, arrow half-stubs, inkedLanes shrink, color
 * preserved). See PrintElementGeneratorImpl.kt isEdgeVisibleInRow/getArrowType.
 */

import '../../setup';
import * as assert from 'assert';
import {
  computeLongEdgeCuts,
  applyLongEdgeHiding,
  LONG_EDGE_SIZE,
} from '../../../src/git-core/graph/longEdges';
import { buildGraphPrintModel } from '../../../src/git-core/graph/printModel';
import type { IRowPrintModel, IRowEdgeElement } from '../../../src/git-core/graph/printModel';
import { paintRow } from '../../../src/git-core/graph/graphPainter';
import { generateCommitGraph } from '../../../src/git-core/commitGraph';
import { DEFAULT_GRAPH_CONFIG } from '../../../src/utils/graphRenderer';
import type { ILaneInterval } from '../../../src/utils/graphRenderer';
import type { ICommit } from '../../../src/git-core/interfaces/IGitService';

type Iv = ILaneInterval;

/** graphColumn per row from a compact `row → lane` spec (default lane 0). */
function nodesWithLanes(count: number, laneAt: Record<number, number>): { graphColumn: number }[] {
  return Array.from({ length: count }, (_v, r) => ({ graphColumn: laneAt[r] ?? 0 }));
}

function intervals(entries: Array<[number, Iv[]]>): Map<number, Iv[]> {
  return new Map(entries);
}

describe('computeLongEdgeCuts', () => {
  it('hides the middle of a long same-lane edge and arrows one row inside each end', () => {
    // 40 rows on lane 0; lane 1 has nodes ONLY at its endpoints (child row 2,
    // parent row 38) → a 36-row edge with an empty interior.
    const nodes = nodesWithLanes(40, { 2: 1, 38: 1 });
    const perEdge = intervals([
      [0, [{ startRow: 0, endRow: 39 }]],
      [1, [{ startRow: 2, endRow: 38 }]],
    ]);

    const { hidden, arrows } = computeLongEdgeCuts(nodes, perEdge);

    // Arrows: row 3 (child+1) DOWN, row 37 (parent-1) UP.
    assert.strictEqual(arrows.get(3)?.get(1), 'down');
    assert.strictEqual(arrows.get(37)?.get(1), 'up');
    // Interior rows 4..36 hide lane 1; the endpoints (2, 38) and arrow rows
    // (3, 37) do NOT hide it.
    for (const r of [2, 3, 37, 38]) {
      assert.ok(!hidden.get(r)?.has(1), `row ${r} must keep lane 1`);
    }
    for (let r = 4; r <= 36; r++) {
      assert.ok(hidden.get(r)?.has(1), `row ${r} must hide lane 1`);
    }
  });

  it('leaves the dense mainline (a node every row) untouched', () => {
    const nodes = nodesWithLanes(40, { 2: 1, 38: 1 });
    const perEdge = intervals([
      [0, [{ startRow: 0, endRow: 39 }]],
      [1, [{ startRow: 2, endRow: 38 }]],
    ]);
    const { hidden, arrows } = computeLongEdgeCuts(nodes, perEdge);
    for (let r = 0; r < 40; r++) {
      assert.ok(!hidden.get(r)?.has(0), `lane 0 must never be hidden (row ${r})`);
      assert.ok(!arrows.get(r)?.has(0), `lane 0 must never get an arrow (row ${r})`);
    }
  });

  it('does not hide an edge shorter than LONG_EDGE_SIZE', () => {
    // lane 1 spans exactly LONG_EDGE_SIZE-1 rows → fully visible.
    const child = 2;
    const parent = child + (LONG_EDGE_SIZE - 1);
    const nodes = nodesWithLanes(parent + 5, { [child]: 1, [parent]: 1 });
    const perEdge = intervals([
      [0, [{ startRow: 0, endRow: parent + 4 }]],
      [1, [{ startRow: child, endRow: parent }]],
    ]);
    const { hidden, arrows } = computeLongEdgeCuts(nodes, perEdge);
    assert.strictEqual(hidden.size, 0);
    assert.strictEqual(arrows.size, 0);
  });

  it('hides a far-parent interval whose bottom is a bend seam (not a node)', () => {
    // Far-parent style: source lane runs [child .. endRow-1] with no node at the
    // bottom (the bend lands one row lower). Still in-window → hidden.
    const nodes = nodesWithLanes(50, { 2: 1 }); // node on lane 1 only at the child
    const perEdge = intervals([
      [0, [{ startRow: 0, endRow: 49 }]],
      [1, [{ startRow: 2, endRow: 40 }]],
    ]);
    const { hidden, arrows } = computeLongEdgeCuts(nodes, perEdge);
    assert.strictEqual(arrows.get(3)?.get(1), 'down');
    assert.strictEqual(arrows.get(39)?.get(1), 'up');
    assert.ok(hidden.get(20)?.has(1));
  });

  it('keeps a short edge inked where it shares a lane with a long edge', () => {
    // Lane 1 carries a 48-row edge [2..50] AND a 5-row edge [20..25] that
    // begins inside it — a second merge into the same parent. The short edge is
    // under the threshold, so its rows stay drawn and the long edge hides the
    // two stretches either side of them, each capped by its own arrow pair.
    const nodes = nodesWithLanes(60, { 2: 1 });
    const perEdge = intervals([
      [0, [{ startRow: 0, endRow: 59 }]],
      [
        1,
        [
          { startRow: 2, endRow: 50 },
          { startRow: 20, endRow: 25 },
        ],
      ],
    ]);

    const { hidden, arrows } = computeLongEdgeCuts(nodes, perEdge);

    assert.strictEqual(arrows.get(3)?.get(1), 'down');
    assert.strictEqual(arrows.get(19)?.get(1), 'up');
    assert.strictEqual(arrows.get(26)?.get(1), 'down');
    assert.strictEqual(arrows.get(49)?.get(1), 'up');
    for (let r = 20; r <= 25; r++) {
      assert.ok(!hidden.get(r)?.has(1), `short edge's row ${r} must keep its ink`);
    }
    for (const r of [4, 18, 27, 48]) {
      assert.ok(hidden.get(r)?.has(1), `row ${r} must hide lane 1`);
    }
  });

  it('cuts the same runs for two long edges sharing a lane, swallowing no stub', () => {
    // Overlapping long edges [0..50] and [10..60] on lane 1. Each stretch that
    // neither edge inks becomes its own gap; because both edges' endpoints
    // count as drawn, the two cut identical runs, so no edge's arrow row ends
    // up hidden by the other.
    const nodes = nodesWithLanes(70, {});
    const pair: Iv[] = [
      { startRow: 0, endRow: 50 },
      { startRow: 10, endRow: 60 },
    ];
    const perEdge = intervals([[1, pair]]);

    const { hidden, arrows } = computeLongEdgeCuts(nodes, perEdge);

    for (const [row, dir] of [
      [1, 'down'],
      [9, 'up'],
      [11, 'down'],
      [49, 'up'],
      [51, 'down'],
      [59, 'up'],
    ] as Array<[number, 'up' | 'down']>) {
      assert.strictEqual(arrows.get(row)?.get(1), dir, `row ${row} arrow`);
      assert.ok(!hidden.get(row)?.has(1), `row ${row} arrow must survive, not be hidden`);
    }
    for (const r of [0, 10, 50, 60]) {
      assert.ok(!hidden.get(r)?.has(1), `endpoint row ${r} must keep its ink`);
    }
    for (const r of [2, 8, 12, 48, 52, 58]) {
      assert.ok(hidden.get(r)?.has(1), `row ${r} must hide lane 1`);
    }
    // Interval order within a lane must not change the cuts.
    const reversed = computeLongEdgeCuts(nodes, intervals([[1, [...pair].reverse()]]));
    assert.deepStrictEqual(reversed.hidden, hidden);
    assert.deepStrictEqual(reversed.arrows, arrows);
  });

  it('exempts only the edge reaching the window edge, not the rest of its lane', () => {
    // Lane 1 carries a 39-row edge [2..41] ending at a real parent and a
    // trunk-style 38-row interval [41..79] that reaches the last row with no
    // node there. The chevron interval keeps all its ink; the earlier long edge
    // is hidden like any other. Merging the lane first yields one span [2..79]
    // that reaches the last row, which would exempt BOTH and leave the earlier
    // edge fully drawn.
    const nodes = nodesWithLanes(80, { 2: 1, 41: 1 });
    const perEdge = intervals([
      [0, [{ startRow: 0, endRow: 79 }]],
      [
        1,
        [
          { startRow: 2, endRow: 41 },
          { startRow: 41, endRow: 79, offWindow: true },
        ],
      ],
    ]);

    const { hidden, arrows } = computeLongEdgeCuts(nodes, perEdge);

    assert.strictEqual(arrows.get(3)?.get(1), 'down');
    assert.strictEqual(arrows.get(40)?.get(1), 'up');
    for (const r of [4, 20, 39]) {
      assert.ok(hidden.get(r)?.has(1), `row ${r} of the in-window edge must hide lane 1`);
    }
    for (let r = 42; r <= 79; r++) {
      assert.ok(!hidden.get(r)?.has(1), `chevron row ${r} must keep its ink`);
      assert.ok(!arrows.get(r)?.has(1), `chevron row ${r} must not be arrowed`);
    }
  });

  it('leaves a run too short to be worth hiding fully drawn', () => {
    // Lane 1: a long edge [2..50] whose interior is inked by two other edges
    // that leave rows 19..21 free. A stub costs the first and last of those, so
    // hiding would blank one row and spend two on arrowheads — the run is left
    // drawn instead.
    const nodes = nodesWithLanes(60, { 2: 1 });
    const perEdge = intervals([
      [0, [{ startRow: 0, endRow: 59 }]],
      [
        1,
        [
          { startRow: 2, endRow: 50 },
          { startRow: 3, endRow: 18 },
          { startRow: 22, endRow: 48 },
        ],
      ],
    ]);

    const { hidden, arrows } = computeLongEdgeCuts(nodes, perEdge);

    for (const r of [19, 20, 21]) {
      assert.ok(!hidden.get(r)?.has(1), `free row ${r} must stay drawn`);
    }
    for (let r = 0; r < 60; r++) {
      assert.ok(!arrows.get(r)?.has(1), `no stub belongs at row ${r}`);
    }
  });

  it('hides a long edge that merely ends on the last row, when its parent is loaded', () => {
    // Lane 2 runs rows 5..39 to a parent on the last row. Nothing marks it off
    // window, so it is an ordinary long edge — reaching the last row is not, by
    // itself, a reason to stay whole.
    const nodes = nodesWithLanes(40, { 5: 2 });
    const perEdge = intervals([
      [0, [{ startRow: 0, endRow: 39 }]],
      [2, [{ startRow: 5, endRow: 39 }]],
    ]);
    const { hidden, arrows } = computeLongEdgeCuts(nodes, perEdge);
    assert.strictEqual(arrows.get(6)?.get(2), 'down');
    assert.strictEqual(arrows.get(38)?.get(2), 'up');
    assert.ok(hidden.get(20)?.has(2));
  });

  it('leaves an edge whose parent is not loaded whole (it ends in a chevron)', () => {
    // lane 2 reaches the last row with no node there → off-window continuation.
    const nodes = nodesWithLanes(40, { 5: 2 });
    const perEdge = intervals([
      [0, [{ startRow: 0, endRow: 39 }]],
      [2, [{ startRow: 5, endRow: 39, offWindow: true }]],
    ]);
    const { hidden, arrows } = computeLongEdgeCuts(nodes, perEdge);
    for (let r = 0; r < 40; r++) {
      assert.ok(!hidden.get(r)?.has(2), `off-window lane 2 must not be hidden (row ${r})`);
      assert.ok(!arrows.get(r)?.has(2), `off-window lane 2 must not be arrowed (row ${r})`);
    }
  });
});

describe('applyLongEdgeHiding', () => {
  function straight(lane: number, half: 'up' | 'down' | 'full', color: string): IRowEdgeElement {
    return {
      edge: { childRow: 0, parent: { kind: 'inWindow', row: 1 }, lane },
      half,
      lane,
      fromLane: lane,
      targetLane: lane,
      curved: false,
      type: 'commit',
      style: 'solid',
      color,
    };
  }
  function row(rowIndex: number, edges: IRowEdgeElement[], inkedLanes: number[]): IRowPrintModel {
    return {
      rowIndex,
      node: {
        lane: 0,
        isMerge: false,
        isTerminal: false,
        isCurrentHead: false,
        isBranchSplit: false,
        onFocusedBranchPath: false,
      },
      edges,
      inkedLanes,
      isLastRow: false,
      chevronLanes: [],
      hasFocusedBranch: false,
    };
  }

  it('removes hidden pass-throughs, drops the lane from inkedLanes, keeps color', () => {
    // Interior row: lane 0 straight + lane 5 straight (hidden). After: only lane 0.
    const models = [row(10, [straight(0, 'full', '#aaa'), straight(5, 'full', '#f00')], [0, 5])];
    const cuts = {
      hidden: new Map([[10, new Set([5])]]),
      arrows: new Map<number, Map<number, 'up' | 'down'>>(),
    };
    applyLongEdgeHiding(models, cuts);
    assert.deepStrictEqual(
      models[0].edges.map((e) => e.lane),
      [0]
    );
    assert.deepStrictEqual(models[0].inkedLanes, [0]);
  });

  it('converts the child-side cut row to an up-half DOWN-arrow stub, preserving color', () => {
    const models = [row(3, [straight(0, 'full', '#aaa'), straight(5, 'full', '#f00')], [0, 5])];
    const cuts = {
      hidden: new Map<number, Set<number>>(),
      arrows: new Map([[3, new Map<number, 'up' | 'down'>([[5, 'down']])]]),
    };
    applyLongEdgeHiding(models, cuts);
    const stub = models[0].edges.find((e) => e.lane === 5)!;
    assert.strictEqual(stub.arrow, 'down');
    assert.strictEqual(stub.half, 'up'); // top→center, connecting up to the child
    assert.strictEqual(stub.color, '#f00');
    assert.ok(models[0].inkedLanes.includes(5)); // stub still inks its lane
  });

  it('converts the parent-side cut row to a down-half UP-arrow stub', () => {
    const models = [row(37, [straight(0, 'full', '#aaa'), straight(5, 'full', '#f00')], [0, 5])];
    const cuts = {
      hidden: new Map<number, Set<number>>(),
      arrows: new Map([[37, new Map<number, 'up' | 'down'>([[5, 'up']])]]),
    };
    applyLongEdgeHiding(models, cuts);
    const stub = models[0].edges.find((e) => e.lane === 5)!;
    assert.strictEqual(stub.arrow, 'up');
    assert.strictEqual(stub.half, 'down'); // center→bottom, connecting down to the parent
  });
});

describe('long-edge hiding — end to end via buildGraphPrintModel', () => {
  function c(hash: string, parents: string[]): ICommit {
    const d = new Date('2024-01-01T00:00:00Z');
    return {
      hash,
      shortHash: hash,
      message: hash,
      author: { name: 'A', email: 'a@x' },
      committer: { name: 'A', email: 'a@x' },
      parents,
      authorDate: d,
      commitDate: d,
    };
  }

  // Merge M (row 0) with first parent m1 and second parent a branch tip F (row 1)
  // whose only parent is the LAST mainline commit far below → a >30-row side lane.
  const N = 34; // mainline commits m1..m34 => F's lane spans well past LONG_EDGE_SIZE
  const mainline = Array.from({ length: N }, (_v, i) => `m${i + 1}`);
  const commits: ICommit[] = [
    c('M', ['m1', 'F']),
    c('F', [mainline[N - 1]]),
    ...mainline.map((h, i) => c(h, i + 1 < N ? [mainline[i + 1]] : [])),
  ];
  const nodes = generateCommitGraph(commits);
  const fLane = nodes[1].graphColumn; // F's side lane

  it('places F on its own side lane spanning far below (sanity for the fixture)', () => {
    assert.ok(fLane > 0, 'F should get a non-mainline lane');
    assert.ok(N - 1 >= LONG_EDGE_SIZE, 'fixture must exceed the long-edge threshold');
  });

  it('draws no ink on the side lane through the hidden middle rows', () => {
    const models = buildGraphPrintModel(nodes);
    const mid = models[Math.floor(models.length / 2)];
    assert.ok(
      !mid.edges.some((e) => e.lane === fLane),
      'a mid-span row must draw nothing on the hidden side lane'
    );
    assert.ok(!mid.inkedLanes.includes(fLane), 'hidden lane must not count toward row width');
  });

  it('caps the side lane with a DOWN arrow near F and an UP arrow near its parent', () => {
    const models = buildGraphPrintModel(nodes);
    const downArrow = models.some((m) =>
      m.edges.some((e) => e.lane === fLane && e.arrow === 'down')
    );
    const upArrow = models.some((m) => m.edges.some((e) => e.lane === fLane && e.arrow === 'up'));
    assert.ok(downArrow, 'expected a DOWN arrow stub near the child endpoint');
    assert.ok(upArrow, 'expected an UP arrow stub near the parent endpoint');
  });

  it('keeps full spans when hideLongEdges is off (the toggle restores old behavior)', () => {
    const models = buildGraphPrintModel(nodes, { hideLongEdges: false });
    const mid = models[Math.floor(models.length / 2)];
    assert.ok(
      mid.edges.some((e) => e.lane === fLane),
      'with hiding off the side lane draws through every row'
    );
    assert.ok(
      !models.some((m) => m.edges.some((e) => e.arrow !== undefined)),
      'no arrow stubs when hiding is off'
    );
  });

  it('paints an arrowhead <path> for a cut stub', () => {
    const models = buildGraphPrintModel(nodes);
    const arrowModel = models.find((m) => m.edges.some((e) => e.arrow !== undefined))!;
    const svg = paintRow(arrowModel, DEFAULT_GRAPH_CONFIG);
    assert.ok(/<path d="M [^"]* L [^"]* L [^"]*" fill=/.test(svg), 'arrowhead path expected');
  });

  it('shrinks per-row inked width on hidden rows vs the full-span model', () => {
    const hidden = buildGraphPrintModel(nodes);
    const full = buildGraphPrintModel(nodes, { hideLongEdges: false });
    const midWidthHidden = hidden[Math.floor(hidden.length / 2)].inkedLanes.length;
    const midWidthFull = full[Math.floor(full.length / 2)].inkedLanes.length;
    assert.ok(
      midWidthHidden < midWidthFull,
      `mid-row inked lanes should drop (hidden ${midWidthHidden} < full ${midWidthFull})`
    );
  });
});
