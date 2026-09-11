/**
 * Comprehensive topology coverage for the whole graph layout pipeline
 * (generate -> long-edge hide -> lane compaction -> paint).
 *
 * Two sources feed one battery of structural invariants (see
 * test/support/graphInvariants.ts): a set of hand-built synthetic topologies
 * covering the layout's interesting shapes, and a 1000-commit anonymized capture
 * of the real bitcoin `master` history (bitcoinMasterTopo.json) — the merge-heavy
 * case that motivated long-edge hiding + compaction.
 */

import '../../../setup';
import * as assert from 'assert';
import { generateCommitGraph, IBranchRef, ICommitNode } from '../../../../src/git-core/commitGraph';
import { buildGraphPrintModel } from '../../../../src/git-core/graph/printModel';
import { compactPrintModelLanes } from '../../../../src/git-core/graph/laneCompaction';
import type { ICommit } from '../../../../src/git-core/interfaces/IGitService';
import {
  assertGraphInvariants,
  assertRankMapMembership,
  loadAnonFixture,
  mkCommit,
  rawPrintModels,
  TopoCase,
} from '../../../support/graphInvariants';
import { INTELLIJ_TOPO } from './intellijTopo';

/** Max column index across a compacted model set. */
function maxColumn(nodes: ICommitNode[], headHash?: string): number {
  const models = compactPrintModelLanes(buildGraphPrintModel(nodes, { headHash }));
  let mx = 0;
  for (const m of models) {
    for (const l of m.inkedLanes) {
      mx = Math.max(mx, l);
    }
  }
  return mx;
}

// ─── Synthetic topology generators (newest-first commit order) ──────────────

/** A straight chain c0 <- c1 <- ... */
function linear(n: number): ICommit[] {
  return Array.from({ length: n }, (_v, i) => mkCommit(`c${i}`, i + 1 < n ? [`c${i + 1}`] : []));
}

/** Mainline with a side branch of `len` commits that merges back `forkBack` rows down. */
function sideBranch(len: number, forkBack: number): ICommit[] {
  // order: merge, side0..side(len-1), then mainline m0..m(forkBack)
  const commits: ICommit[] = [];
  commits.push(mkCommit('merge', ['m0', 's0']));
  for (let i = 0; i < len; i++) {
    commits.push(mkCommit(`s${i}`, [i + 1 < len ? `s${i + 1}` : `m${forkBack}`]));
  }
  for (let i = 0; i <= forkBack; i++) {
    commits.push(mkCommit(`m${i}`, i < forkBack + 5 ? [`m${i + 1}`] : []));
  }
  commits.push(mkCommit(`m${forkBack + 1}`, []));
  return commits;
}

/**
 * A bitcoin-like merge spine: N merges on the mainline, each merging a 1-commit
 * PR that forks `fork` rows below — so up to `fork` long edges overlap at once
 * and the raw lane count climbs while only a few are visible per row.
 */
function mergeSpine(n: number, fork: number): { commits: ICommit[]; headHash: string } {
  const commits: ICommit[] = [];
  const tail = n + fork + 2;
  for (let i = 0; i < n; i++) {
    commits.push(mkCommit(`M${i}`, [`M${i + 1}`, `P${i}`])); // merge: first parent mainline, second PR
    commits.push(mkCommit(`P${i}`, [`M${i + fork}`])); // PR tip forks `fork` back
  }
  for (let i = n; i <= tail; i++) {
    commits.push(mkCommit(`M${i}`, i < tail ? [`M${i + 1}`] : []));
  }
  return { commits, headHash: 'M0' };
}

/**
 * A first-parent line that bends into a DIFFERENT, already-claimed lane more
 * than one row below its source (`IGraphLine.endRow`, commitGraph.ts's
 * "far-parent fork-point bend"): M1's own first parent is M2, but P0 — an
 * earlier-processed side branch — reaches M2 first and claims it onto its own
 * lane, so M1's edge to M2 bends onto that lane 2 rows down instead of
 * continuing straight. The landing row (M2) is 2 rows below the source (M1),
 * and M2's own lane differs from M1's, so the incoming bend is not adjacent
 * to where the line left.
 */
function farParentBendLanding(): ICommit[] {
  return [
    mkCommit('M0', ['M1', 'P0']),
    mkCommit('P0', ['M2']),
    mkCommit('M1', ['M2', 'P1']),
    mkCommit('P1', ['M3']),
    mkCommit('M2', ['M3']),
    mkCommit('M3', ['M4']),
    mkCommit('M4', ['M5']),
    mkCommit('M5', ['M6']),
    mkCommit('M6', []),
  ];
}

/** An octopus merge (3 parents) rejoining a shared base. */
function octopus(): ICommit[] {
  return [
    mkCommit('o', ['a', 'b', 'c']),
    mkCommit('a', ['base']),
    mkCommit('b', ['base']),
    mkCommit('c', ['base']),
    mkCommit('base', []),
  ];
}

/** Criss-cross: two branches that each merge the other. */
function crissCross(): ICommit[] {
  return [
    mkCommit('mA', ['a1', 'b1']),
    mkCommit('mB', ['b1', 'a1']),
    mkCommit('a1', ['base']),
    mkCommit('b1', ['base']),
    mkCommit('base', []),
  ];
}

/** A lane freed by a finished branch, then reused by a later unrelated branch. */
function reusedLane(): ICommit[] {
  return [
    mkCommit('m2', ['top', 'y0']), // later merge reuses the freed lane
    mkCommit('top', ['mid']),
    mkCommit('y0', ['mid']),
    mkCommit('mid', ['m1']),
    mkCommit('m1', ['base', 'x0']), // earlier merge
    mkCommit('x0', ['base']),
    mkCommit('base', []),
  ];
}

/** Parents that fall off the loaded window (dashed off-window stubs). */
function offWindow(): ICommit[] {
  return [
    mkCommit('h', ['p1', 'sideOff']), // sideOff not in window
    mkCommit('p1', ['p2']),
    mkCommit('p2', ['deepOff']), // deepOff not in window
  ];
}

/**
 * A side-branch tip whose SOLE parent fell off the loaded window, mid-window
 * (not at the window bottom, and not sharing its lane with an in-window
 * parent). The lone same-lane dashed stub this leaf emits merges into a
 * single-row interval, so the straight drawn on its lane carries an identity
 * with `childRow === parent.row` — a shape `offWindow()` above misses because
 * its off-window parents are either a second parent (collapses onto the
 * first-parent lane) or at the last row (spans more than one row).
 */
function offWindowLeafMidWindow(): ICommit[] {
  return [
    mkCommit('h', ['p1']),
    mkCommit('tip', ['sideOff']),
    mkCommit('p1', ['p2']),
    mkCommit('p2', []),
  ];
}

function singleBranchMap(tip: string, name = 'main'): Map<string, IBranchRef[]> {
  return new Map([[tip, [{ name, type: 'local' }]]]);
}

describe('Graph pipeline invariants — synthetic topologies', () => {
  const spine = mergeSpine(80, 20);
  const cases: TopoCase[] = [
    { label: 'linear-3', commits: linear(3) },
    {
      label: 'linear-50',
      commits: linear(50),
      headHash: 'c0',
      headBranchName: 'main',
      branchMap: singleBranchMap('c0'),
    },
    { label: 'short-side-branch', commits: sideBranch(3, 5) },
    { label: 'long-side-branch(40)', commits: sideBranch(2, 40) },
    { label: 'octopus', commits: octopus() },
    { label: 'criss-cross', commits: crissCross() },
    { label: 'reused-lane', commits: reusedLane() },
    { label: 'off-window-parents', commits: offWindow() },
    { label: 'off-window-leaf-mid-window', commits: offWindowLeafMidWindow() },
    {
      label: 'bitcoin-like-spine',
      commits: spine.commits,
      headHash: spine.headHash,
      headBranchName: 'main',
      branchMap: singleBranchMap(spine.headHash),
    },
    // detached HEAD in the middle of a chain.
    { label: 'detached-head', commits: linear(20), headHash: 'c9' },
    {
      label: 'far-parent-bend-landing',
      commits: farParentBendLanding(),
      headHash: 'M0',
      headBranchName: 'main',
      branchMap: singleBranchMap('M0'),
    },
    loadAnonFixture('realTopoAnon.json', 100),
    loadAnonFixture('realTopoAnon.json', 413),
    loadAnonFixture('selfTopoAnon.json', 125),
    // No branch refs, no HEAD (see intellijTopo.ts) — G is vacuous for this
    // case; it exists for structural coverage of every other invariant in
    // the suite.
    { label: 'intellij-topo(150)', commits: INTELLIJ_TOPO.map((c) => mkCommit(c.hash, c.parents)) },
  ];

  for (const tc of cases) {
    it(`upholds every layout invariant: ${tc.label}`, () => {
      assertGraphInvariants(tc);
    });
  }

  it('every lane a row contributes gets a rank: realTopoAnon.json@413', () => {
    // Isolated from assertGraphInvariants's other invariants on purpose: H2
    // (width/density, earlier in that function) cannot see this fixture's
    // gap — the row's orphaned lane happens to remap to itself — so a call
    // to the full assertGraphInvariants would prove nothing about M
    // specifically even if it passed. This calls production's own rank-map
    // builder (via assertRankMapMembership -> __buildRankMapForTest) against
    // the row's real node/edges/inkedLanes/chevronLanes, the same witness
    // the "upholds every layout invariant" loop above also runs for this
    // fixture (and every other one) as part of the full invariant set.
    const tc = loadAnonFixture('realTopoAnon.json', 413);
    assertRankMapMembership(tc, rawPrintModels(tc));
  });

  it('the off-window leaf really does emit a straight whose child row is its parent row', () => {
    // Without this the fixture above is green whether or not the shape occurs:
    // no invariant reads childRow against parent.row, so nothing else would
    // notice if a generator change stopped producing it.
    const nodes = generateCommitGraph(offWindowLeafMidWindow());
    const models = buildGraphPrintModel(nodes);
    const selfRowed = models
      .flatMap((m) => m.edges)
      .filter(
        (e) =>
          !e.curved &&
          e.fromLane === e.targetLane &&
          e.edge.parent.kind === 'inWindow' &&
          e.edge.parent.row === e.edge.childRow
      );
    assert.strictEqual(selfRowed.length, 1, 'expected exactly one self-rowed straight');
    assert.strictEqual(selfRowed[0].style, 'dashed');
  });

  it('compaction actually shrinks the merge-spine column count (freed lanes reused)', () => {
    const nodes = generateCommitGraph(
      spine.commits,
      undefined,
      undefined,
      undefined,
      undefined,
      spine.headHash
    );
    let rawMax = 0;
    for (const n of nodes) {
      rawMax = Math.max(
        rawMax,
        n.graphColumn,
        ...n.graphLines.flatMap((l) => [l.fromColumn, l.toColumn])
      );
    }
    const packedMax = maxColumn(nodes, spine.headHash);
    // Compaction reuses each hidden long edge's freed middle, so the packed
    // column count is strictly below the raw lane count.
    assert.ok(
      packedMax < rawMax,
      `compaction should reduce columns (raw max ${rawMax}, packed max ${packedMax})`
    );
  });
});

describe('offWindow fixture — window bottom edge + off-window second-parent collapse', () => {
  // Window: h(row0, parents p1 in-window + sideOff OFF-window) -> p1(row1) ->
  // p2(row2, last row, sole parent deepOff OFF-window). All three sit on lane 0.
  const nodes = generateCommitGraph(offWindow());
  const models = buildGraphPrintModel(nodes);

  it('rows 0 and 1 carry no chevrons; only the last row (the real off-window edge) does', () => {
    assert.deepStrictEqual(models[0].chevronLanes, []);
    assert.deepStrictEqual(models[1].chevronLanes, []);
    assert.deepStrictEqual(models[2].chevronLanes, [0]);
    assert.deepStrictEqual(models[2].chevronColors, ['#4CAF50']);
  });

  it("the last row's down-segment is dashed (history continues below the window) and its second edge carries the chevron", () => {
    const downs = models[2].edges.filter((e) => e.half === 'down');
    assert.strictEqual(downs.length, 1);
    assert.strictEqual(downs[0].style, 'dashed');
  });

  it(
    "h's off-window SECOND parent (sideOff) produces no independent edge element — " +
      'it collapses into the single own-lane down-segment alongside the real first-parent line',
    () => {
      // DELIBERATE, not a gap: printModel.ts's own-lane segment builder draws
      // exactly ONE down-half per lane no matter how many graphLines share it
      // (see "Own-lane segments around the commit dot" in printModel.ts) —
      // drawing a second same-lane stroke would paint identical pixels. The
      // dashed/solid choice is decided by whether EVERY same-lane line is a
      // dashed off-window stub; here one is real (p1) so the drawn segment is
      // solid and the off-window merge marker leaves no visible trace.
      const hRow = models[0];
      assert.strictEqual(hRow.node.isMerge, true, 'h has 2 parents');
      const downs = hRow.edges.filter((e) => e.half === 'down' && e.lane === 0);
      assert.strictEqual(downs.length, 1, 'exactly one down segment, not one per graphLine');
      assert.strictEqual(
        downs[0].style,
        'solid',
        'the real in-window continuation wins over the off-window stub'
      );
    }
  );
});

describe('Graph pipeline invariants — real bitcoin master (1000 commits)', () => {
  const tc = loadAnonFixture('bitcoinMasterTopo.json');
  const { commits, branchMap, headHash, headBranchName } = tc;

  it('is a genuinely merge-heavy window (fixture sanity)', () => {
    const merges = commits.filter((c) => c.parents.length > 1).length;
    assert.ok(merges > 100, `expected a merge-heavy history, got ${merges} merges`);
  });

  it('upholds every layout invariant on real bitcoin topology', () => {
    assertGraphInvariants(tc);
  });

  it('compacts the ~46-lane raw graph down to a narrow, bounded column count', () => {
    const nodes = generateCommitGraph(
      commits,
      branchMap,
      undefined,
      undefined,
      headBranchName,
      headHash
    );
    let rawMax = 0;
    for (const n of nodes) {
      rawMax = Math.max(
        rawMax,
        n.graphColumn,
        ...n.graphLines.flatMap((l) => [l.fromColumn, l.toColumn])
      );
    }
    const packedMax = maxColumn(nodes, headHash);
    assert.ok(rawMax >= 20, `fixture should exercise many raw lanes, got ${rawMax}`);
    assert.ok(
      packedMax <= 15,
      `compaction should keep bitcoin's column count small (raw ${rawMax} -> packed ${packedMax})`
    );
    assert.ok(packedMax < rawMax, `packed (${packedMax}) must be below raw (${rawMax})`);
  });
});

describe('Graph pipeline invariants — packed gutter width pins', () => {
  // H2 (density + width-vs-maxDistinctInARow) holds by construction under rank
  // packing: every column counted is at most the global max, so the busiest
  // row's lane count can never exceed it by more than one, and rank's densest
  // row holds exactly that many — so H2 cannot catch a change in
  // the actual rendered width. These are the only assertions in the tree tied
  // to the real pixel gutter each oracle fixture renders; a widening here is a
  // real user-visible regression that no other invariant would catch.
  const cases: Array<[string, TopoCase, number]> = [
    ['bitcoin@1000', loadAnonFixture('bitcoinMasterTopo.json'), 8],
    ['realTopoAnon@413', loadAnonFixture('realTopoAnon.json', 413), 2],
    ['realTopoAnon@100', loadAnonFixture('realTopoAnon.json', 100), 1],
    ['selfTopoAnon@125', loadAnonFixture('selfTopoAnon.json', 125), 1],
  ];

  for (const [label, tc, expectedPackedMax] of cases) {
    it(`pins the packed gutter width on ${label}`, () => {
      const nodes = generateCommitGraph(
        tc.commits,
        tc.branchMap,
        undefined,
        undefined,
        tc.headBranchName,
        tc.headHash
      );
      const packedMax = maxColumn(nodes, tc.headHash);
      assert.strictEqual(
        packedMax,
        expectedPackedMax,
        `${label}: packed max column moved — the gutter width changed`
      );
    });
  }
});
