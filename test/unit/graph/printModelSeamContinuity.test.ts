/**
 * Seam-continuity invariant for the graph PRINT MODEL — every edge half meets its
 * neighbor across a row boundary, so a bend's two halves are always paired.
 *
 * This is an INDEPENDENT oracle: it reads only the print-model edge halves (not
 * the interval/active-lane model the production projection is built from), so it
 * catches gaps the interval-derived continuity oracle is blind to. Concretely it
 * reproduces the reported bug — a far-parent first-parent line that bends ≥2 rows
 * below: the source lane's bottom half at the row just above the parent was never
 * emitted, leaving the incoming bend at the parent row with nothing to meet.
 *
 * Geometry the halves map to (matches graphPainter.ts):
 *   - straight 'full' on lane L: inks y=0..bottomY on L (tops AND bottoms the row at L)
 *   - straight 'up'   on lane L: inks y=0..centerY on L (tops the row at L)
 *   - straight 'down' on lane L: inks centerY..bottomY on L (bottoms the row at L)
 *   - curved 'up'   (incoming bend at the parent row): starts at (fromLane, y=0) → tops at lane
 *   - curved 'down' (bezier at the source row):        ends at (targetLane, bottomY) → bottoms at lane
 * So `half ∈ {up,full}` tops the seam at `e.lane`; `half ∈ {down,full}` bottoms it at `e.lane`.
 */

import '../../setup';
import * as assert from 'assert';
import { generateCommitGraph } from '../../../src/git-core/commitGraph';
import { buildGraphPrintModel } from '../../../src/git-core/graph/printModel';
import type { ICommit } from '../../../src/git-core/interfaces/IGitService';

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

/** Human-readable list of unpaired half-segments at any row seam ([] = clean). */
function seamDefects(commits: ICommit[]): string[] {
  const models = buildGraphPrintModel(generateCommitGraph(commits));
  const defects: string[] = [];

  for (let r = 0; r < models.length - 1; r++) {
    const top = models[r];
    const below = models[r + 1];

    const bottomLanes = new Set<number>();
    for (const e of top.edges) {
      if (e.half === 'down' || e.half === 'full') {
        bottomLanes.add(e.lane);
      }
    }
    const topLanesBelow = new Set<number>();
    for (const e of below.edges) {
      if (e.half === 'up' || e.half === 'full') {
        topLanesBelow.add(e.lane);
      }
    }
    // Off-window stubs end with a chevron and legitimately have no pairing below.
    const chevron = new Set(top.chevronLanes);

    // (a) Every half that TOPS row r+1 must be BOTTOMED by row r — this is the
    //     reported bend gap: an incoming bend's up-half with no segment above it.
    for (const lane of topLanesBelow) {
      if (!bottomLanes.has(lane)) {
        defects.push(
          `seam ${r}->${r + 1} lane ${lane}: up-half at ${r + 1} has no down/full at ${r}`
        );
      }
    }
    // (b) Every non-chevron half that BOTTOMS row r must be TOPPED by row r+1.
    for (const lane of bottomLanes) {
      if (!chevron.has(lane) && !topLanesBelow.has(lane)) {
        defects.push(
          `seam ${r}->${r + 1} lane ${lane}: down/full at ${r} has no up/full at ${r + 1}`
        );
      }
    }
  }
  return defects;
}

describe('print model — row-seam continuity (no unpaired bend half)', () => {
  it('far-parent first-parent bend spanning ≥2 rows pairs at every seam (reported gap)', () => {
    // A=tip, B inherits the trunk lane to E; S is a side tip whose first parent E
    // is 2 rows below on the trunk lane → a far-parent bend (endRow set). The
    // source lane's bottom half at the row above E must not be dropped.
    const defects = seamDefects([
      c('A', ['B']),
      c('B', ['E']),
      c('S', ['E']),
      c('C', ['E']),
      c('E', []),
    ]);
    assert.deepStrictEqual(defects, [], defects.join('\n'));
  });

  it('a fan of far-parent edges converging on one ancestor pairs at every seam', () => {
    // n2/n3/n4 each bend down to n5 across multiple rows (the n5 fan). Every
    // source lane must bottom the row above n5 to meet its incoming bend.
    const defects = seamDefects([
      c('n0', ['n5']),
      c('n1', ['n2']),
      c('n2', ['n5']),
      c('n3', ['n5']),
      c('n4', ['n5']),
      c('n5', []),
    ]);
    assert.deepStrictEqual(defects, [], defects.join('\n'));
  });

  it('a plain linear chain has no seam defects (no false positives)', () => {
    assert.deepStrictEqual(seamDefects([c('a', ['b']), c('b', ['d']), c('d', [])]), []);
  });

  it('a simple merge + branch split pairs at every seam (no false positives)', () => {
    const defects = seamDefects([c('m', ['p', 's']), c('p', ['b']), c('s', ['b']), c('b', [])]);
    assert.deepStrictEqual(defects, [], defects.join('\n'));
  });

  it('a through-lane keeps its vertical where a sibling bends into it (reported gap)', () => {
    // A(lane0)→B is a through-trunk passing X's row; X(lane1)→B bends INTO lane0
    // at X's row. lane0 there must ink a continuous VERTICAL (full/down straight),
    // not just an 'up' half relying on X's diagonal bezier — otherwise the trunk
    // shows a gap above B. The seam oracle is blind to this (the bezier endpoint
    // "bottoms" the lane at a point), so assert the straight half directly.
    const nodes = generateCommitGraph([c('A', ['B']), c('X', ['B']), c('B', ['C']), c('C', [])]);
    const models = buildGraphPrintModel(nodes);
    const row1 = models[1]; // X's row
    const lane0Straights = row1.edges.filter((e) => e.lane === 0 && !e.curved);
    const bottomsLane0 = lane0Straights.some((e) => e.half === 'full' || e.half === 'down');
    assert.ok(
      bottomsLane0,
      'lane0 through-trunk must ink its bottom-half vertical at the bend row (no gap)'
    );
  });
});
