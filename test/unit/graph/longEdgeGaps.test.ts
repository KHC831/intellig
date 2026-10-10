/**
 * Gap-level guarantees of long-edge hiding.
 *
 *   - `assertGapsCapped` (the invariant every topology fixture runs) must fail
 *     on a stub with no partner, not skip it.
 *   - `collectRawLaneIntervals` hands long-edge hiding ONE interval per edge.
 *   - `computeLongEdgeCuts` stays coherent on arbitrary interval sets: no row is
 *     both hidden and arrowed, every hidden run is capped at both ends, and a
 *     short edge is never hidden.
 *   - Many edges converging on one parent do not multiply the work.
 */

import '../../setup';
import * as assert from 'assert';
import * as fc from 'fast-check';
import { computeLongEdgeCuts, LONG_EDGE_SIZE } from '../../../src/git-core/graph/longEdges';
import { collectRawLaneIntervals } from '../../../src/utils/graphRenderer';
import { generateCommitGraph } from '../../../src/git-core/commitGraph';
import type { IRowPrintModel } from '../../../src/git-core/graph/printModel';
import { assertGapsCapped, mkCommit } from '../../support/graphInvariants';

type Iv = { startRow: number; endRow: number };

/** Minimal models: only what the gap invariant reads. */
function modelsWith(
  rows: number,
  marks: Array<{ row: number; lane: number; arrow?: 'up' | 'down' }>
): IRowPrintModel[] {
  const models = Array.from({ length: rows }, (_v, rowIndex) => ({ rowIndex, edges: [] }));
  for (const m of marks) {
    (models[m.row].edges as unknown[]).push({ edge: { lane: m.lane }, arrow: m.arrow });
  }
  return models as unknown as IRowPrintModel[];
}

describe('assertGapsCapped', () => {
  it('accepts a gap opened by a DOWN stub and closed by an UP stub', () => {
    assertGapsCapped(
      modelsWith(10, [
        { row: 1, lane: 2, arrow: 'down' },
        { row: 8, lane: 2, arrow: 'up' },
      ]),
      'ok'
    );
  });

  it('fails on a DOWN stub that is never closed', () => {
    assert.throws(
      () => assertGapsCapped(modelsWith(10, [{ row: 1, lane: 2, arrow: 'down' }]), 'open'),
      /never closed|no closing/i
    );
  });

  it('fails on an UP stub with nothing opening it', () => {
    assert.throws(
      () => assertGapsCapped(modelsWith(10, [{ row: 8, lane: 2, arrow: 'up' }]), 'orphan'),
      /nothing open|no opening/i
    );
  });

  it('fails on two DOWN stubs before one UP on the same lane', () => {
    assert.throws(
      () =>
        assertGapsCapped(
          modelsWith(12, [
            { row: 1, lane: 2, arrow: 'down' },
            { row: 4, lane: 2, arrow: 'down' },
            { row: 9, lane: 2, arrow: 'up' },
          ]),
          'double'
        ),
      /never closed|no closing/i
    );
  });

  it('fails on any ink of that lane inside the gap', () => {
    assert.throws(
      () =>
        assertGapsCapped(
          modelsWith(10, [
            { row: 1, lane: 2, arrow: 'down' },
            { row: 5, lane: 2 },
            { row: 8, lane: 2, arrow: 'up' },
          ]),
          'inked'
        ),
      /inks row 5/
    );
  });

  it('pairs each lane on its own', () => {
    assertGapsCapped(
      modelsWith(12, [
        { row: 1, lane: 2, arrow: 'down' },
        { row: 2, lane: 3, arrow: 'down' },
        { row: 8, lane: 2, arrow: 'up' },
        { row: 9, lane: 3, arrow: 'up' },
      ]),
      'two lanes'
    );
  });
});

describe('collectRawLaneIntervals', () => {
  it('emits one interval per straight edge, not two', () => {
    // c0 <- c1 <- c2 <- c3: three straight first-parent edges on one lane.
    const commits = [0, 1, 2, 3].map((i) => mkCommit(`c${i}`, i < 3 ? [`c${i + 1}`] : []));
    const nodes = generateCommitGraph(commits, undefined, undefined, undefined, undefined, 'c0');
    const lane = collectRawLaneIntervals(nodes).get(0) ?? [];
    const spans = lane
      .filter((iv) => iv.endRow > iv.startRow)
      .map((iv) => `${iv.startRow}..${iv.endRow}`);
    assert.deepStrictEqual(spans.sort(), ['0..1', '1..2', '2..3']);
  });
});

/**
 * The plainest possible statement of the cut rule, one row at a time: an
 * edge is split at the nodes on its own lane; each stretch shorter than the
 * threshold keeps all its rows drawn, a longer one keeps its endpoints; an
 * edge running off the window keeps every row; and each run of rows nothing
 * draws inside a long stretch is hidden, capped by a stub at either end, when
 * at least two rows survive the stubs.
 */
function referenceCuts(
  nodes: ReadonlyArray<{ graphColumn: number }>,
  input: ReadonlyMap<number, ReadonlyArray<Iv & { offWindow?: boolean }>>
): { hidden: string[]; arrows: string[] } {
  const hidden: string[] = [];
  const arrows: string[] = [];
  for (const [lane, ivs] of input) {
    const drawn = new Set<number>();
    const stretches = new Set<string>();
    for (const iv of ivs) {
      if (iv.offWindow === true) {
        for (let r = iv.startRow; r <= iv.endRow; r++) {
          drawn.add(r);
        }
        continue;
      }
      const bounds = [iv.startRow];
      for (let r = iv.startRow + 1; r < iv.endRow; r++) {
        if (nodes[r]?.graphColumn === lane) {
          bounds.push(r);
        }
      }
      bounds.push(iv.endRow);
      for (let k = 0; k + 1 < bounds.length; k++) {
        const [a, b] = [bounds[k], bounds[k + 1]];
        drawn.add(a);
        drawn.add(b);
        if (b - a < LONG_EDGE_SIZE) {
          for (let r = a + 1; r < b; r++) {
            drawn.add(r);
          }
        } else {
          stretches.add(`${a}:${b}`);
        }
      }
    }
    const seen = new Set<string>();
    for (const key of stretches) {
      const [a, b] = key.split(':').map(Number);
      let first: number | undefined;
      const close = (last: number): void => {
        // Stubs at `first` and `last`; at least two rows between them to hide.
        if (first !== undefined && last - first >= 3) {
          const run = `${first}:${last}`;
          if (!seen.has(run)) {
            seen.add(run);
            arrows.push(`${first}/${lane}/down`, `${last}/${lane}/up`);
            for (let r = first + 1; r < last; r++) {
              hidden.push(`${r}/${lane}`);
            }
          }
        }
        first = undefined;
      };
      for (let r = a + 1; r < b; r++) {
        if (drawn.has(r)) {
          close(r - 1);
        } else if (first === undefined) {
          first = r;
        }
      }
      close(b - 1);
    }
  }
  return { hidden: hidden.sort(), arrows: arrows.sort() };
}

function flatten(cuts: ReturnType<typeof computeLongEdgeCuts>): {
  hidden: string[];
  arrows: string[];
} {
  const hidden: string[] = [];
  const arrows: string[] = [];
  for (const [row, lanes] of cuts.hidden) {
    for (const lane of lanes) {
      hidden.push(`${row}/${lane}`);
    }
  }
  for (const [row, m] of cuts.arrows) {
    for (const [lane, dir] of m) {
      arrows.push(`${row}/${lane}/${dir}`);
    }
  }
  return { hidden: hidden.sort(), arrows: arrows.sort() };
}

describe('computeLongEdgeCuts — agrees with the per-row reference', () => {
  const ROWS = 90;
  const LAST = ROWS - 1;
  const interval = fc
    .tuple(fc.integer({ min: 0, max: LAST }), fc.integer({ min: 0, max: LAST }), fc.boolean())
    .map(([a, b, offWindow]): Iv & { offWindow?: boolean } =>
      offWindow
        ? { startRow: Math.min(a, b), endRow: LAST, offWindow: true }
        : { startRow: Math.min(a, b), endRow: Math.max(a, b) }
    );
  const lanes = fc.dictionary(
    fc.constantFrom('0', '1', '2', '3'),
    fc.array(interval, { minLength: 1, maxLength: 8 })
  );
  // Nodes on every lane, edges' lanes included, so stretches split at nodes.
  const nodeLanes = fc.array(fc.integer({ min: 0, max: 3 }), {
    minLength: ROWS,
    maxLength: ROWS,
  });

  it('cuts exactly what the one-row-at-a-time rule cuts', () => {
    fc.assert(
      fc.property(lanes, nodeLanes, (byLane, cols) => {
        const nodes = cols.map((graphColumn) => ({ graphColumn }));
        const input = new Map(Object.entries(byLane).map(([l, ivs]) => [Number(l), ivs]));
        assert.deepStrictEqual(
          flatten(computeLongEdgeCuts(nodes, input)),
          referenceCuts(nodes, input)
        );
      }),
      {
        numRuns: 500,
        // A second run, rows 68..70, leaves one row between its stubs: not cut.
        examples: [
          [
            {
              '2': [
                { startRow: 0, endRow: 71 },
                { startRow: 0, endRow: 67 },
                { startRow: 0, endRow: 0 },
              ],
            },
            Array.from({ length: ROWS }, () => 0),
          ],
        ],
      }
    );
  });
});

describe('computeLongEdgeCuts — cost does not multiply with the edges', () => {
  /** Best of five runs, in ms. */
  function time(run: () => void): number {
    run();
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const t0 = process.hrtime.bigint();
      run();
      best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
    }
    return best;
  }

  /**
   * 2,000 edges on lane 1, each from its own row to one parent near the
   * bottom of a 12,000-row window, against a single such edge. Judged as a
   * ratio of the two on the same machine, so a slow or loaded runner moves
   * both sides together; walking each edge's span separately costs hundreds
   * of times the single edge.
   */
  function ratio(nodeEvery: number): number {
    const ROWS = 12_000;
    const PARENT = ROWS - 5;
    const nodes = Array.from({ length: ROWS }, (_v, r) => ({
      graphColumn: nodeEvery > 0 && r % nodeEvery === 0 ? 1 : 0,
    }));
    const many = new Map<number, Iv[]>([
      [1, Array.from({ length: 2000 }, (_v, i) => ({ startRow: i * 5, endRow: PARENT }))],
    ]);
    const one = new Map<number, Iv[]>([[1, [{ startRow: 0, endRow: PARENT }]]]);
    return (
      time(() => computeLongEdgeCuts(nodes, many)) /
      Math.max(
        time(() => computeLongEdgeCuts(nodes, one)),
        0.05
      )
    );
  }

  it('when nothing else sits on the shared lane', () => {
    const r = ratio(0);
    assert.ok(r < 10, `2,000 converging edges cost ${r.toFixed(1)}x one edge`);
  });

  it('when the shared lane carries commits of its own inside the spans', () => {
    const r = ratio(3);
    assert.ok(r < 10, `2,000 converging edges cost ${r.toFixed(1)}x one edge`);
  });
});
