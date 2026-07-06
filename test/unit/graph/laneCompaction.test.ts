/**
 * Lane compaction — relabels a hidden print model's columns down to the lanes
 * actually drawn, so a long edge's freed middle lets its column be reused. Packs
 * to the max lanes drawn in a single row (constant, not window-size dependent).
 */

import '../../setup';
import * as assert from 'assert';
import { compactPrintModelLanes } from '../../../src/git-core/graph/laneCompaction';
import type { IRowPrintModel, IRowEdgeElement } from '../../../src/git-core/graph/printModel';

function straight(lane: number, half: 'up' | 'down' | 'full'): IRowEdgeElement {
  return {
    edge: { childRow: 0, parent: { kind: 'inWindow', row: 1 }, lane },
    half,
    lane,
    fromLane: lane,
    targetLane: lane,
    curved: false,
    type: 'commit',
    style: 'solid',
  };
}

function row(rowIndex: number, nodeLane: number, edgeLanes: number[]): IRowPrintModel {
  const edges = edgeLanes.map((l) => straight(l, 'full'));
  return {
    rowIndex,
    node: {
      lane: nodeLane,
      isMerge: false,
      isTerminal: false,
      isCurrentHead: false,
      isBranchSplit: false,
      onFocusedBranchPath: false,
    },
    edges,
    inkedLanes: [...new Set([nodeLane, ...edgeLanes])],
    isLastRow: false,
    chevronLanes: [],
    hasFocusedBranch: false,
  };
}

/** Max column index used across a compacted model set. */
function maxColumn(models: IRowPrintModel[]): number {
  let mx = 0;
  for (const m of models) {
    for (const l of m.inkedLanes) {
      mx = Math.max(mx, l);
    }
  }
  return mx;
}

describe('compactPrintModelLanes', () => {
  it('reuses a long edge’s freed middle: a high lane packs to a low column', () => {
    // lane 0 drawn every row (mainline). lane 9 drawn ONLY at rows 0-1 and 40-41
    // (a long edge whose middle was hidden). No other lanes.
    const models: IRowPrintModel[] = [];
    for (let r = 0; r < 42; r++) {
      const has9 = r <= 1 || r >= 40;
      models.push(row(r, 0, has9 ? [0, 9] : [0]));
    }
    compactPrintModelLanes(models);
    // lane 9 had index 9 but only ever shares rows with lane 0 -> packs to column 1.
    assert.strictEqual(maxColumn(models), 1);
    assert.strictEqual(models[0].node.lane, 0); // mainline stays column 0
    for (const r of [0, 1, 40, 41]) {
      assert.ok(
        models[r].edges.some((e) => e.lane === 1),
        `row ${r} should carry the packed lane-9 stub on column 1`
      );
    }
  });

  it('keeps a lane on ONE column across its consecutive drawn rows (vertical continuity)', () => {
    // Two non-overlapping branches on high lanes 7 and 12; they never co-occur, so
    // both pack onto column 1 — but each stays on a single column through its run.
    const models: IRowPrintModel[] = [];
    for (let r = 0; r < 20; r++) {
      models.push(row(r, 0, r < 8 ? [0, 7] : [0, 12]));
    }
    compactPrintModelLanes(models);
    assert.strictEqual(maxColumn(models), 1);
    const colOf = (r: number): number => models[r].edges.find((e) => e.lane !== 0)!.lane;
    // lane 7's run (rows 0-7) all on the same column...
    const c7 = colOf(0);
    for (let r = 0; r < 8; r++) {
      assert.strictEqual(colOf(r), c7);
    }
    // ...and lane 12's run (rows 8-19) all on the same column.
    const c12 = colOf(8);
    for (let r = 8; r < 20; r++) {
      assert.strictEqual(colOf(r), c12);
    }
  });

  it('gives distinct columns to lanes drawn in the same row', () => {
    // lanes 0, 3, 8 all drawn together every row -> need 3 distinct columns.
    const models = Array.from({ length: 5 }, (_v, r) => row(r, 0, [0, 3, 8]));
    compactPrintModelLanes(models);
    assert.strictEqual(maxColumn(models), 2); // columns 0,1,2
    const cols = new Set(models[0].inkedLanes);
    assert.strictEqual(cols.size, 3);
  });

  it('is a no-op when columns are already dense', () => {
    const models = Array.from({ length: 4 }, (_v, r) => row(r, 0, [0, 1]));
    compactPrintModelLanes(models);
    assert.strictEqual(maxColumn(models), 1);
  });
});
