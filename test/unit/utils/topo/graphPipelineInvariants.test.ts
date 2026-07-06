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
import * as fs from 'fs';
import * as path from 'path';
import { generateCommitGraph, IBranchRef, ICommitNode } from '../../../../src/git-core/commitGraph';
import { buildGraphPrintModel } from '../../../../src/git-core/graph/printModel';
import { compactPrintModelLanes } from '../../../../src/git-core/graph/laneCompaction';
import type { ICommit } from '../../../../src/git-core/interfaces/IGitService';
import { assertGraphInvariants, mkCommit, TopoCase } from '../../../support/graphInvariants';

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
    {
      label: 'bitcoin-like-spine',
      commits: spine.commits,
      headHash: spine.headHash,
      headBranchName: 'main',
      branchMap: singleBranchMap(spine.headHash),
    },
    // detached HEAD in the middle of a chain.
    { label: 'detached-head', commits: linear(20), headHash: 'c9' },
  ];

  for (const tc of cases) {
    it(`upholds every layout invariant: ${tc.label}`, () => {
      assertGraphInvariants(tc);
    });
  }

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
    // column count is strictly below the raw lane count (invariant H already
    // pins it to the optimum = max lanes drawn in one row).
    assert.ok(
      packedMax < rawMax,
      `compaction should reduce columns (raw max ${rawMax}, packed max ${packedMax})`
    );
  });
});

describe('Graph pipeline invariants — real bitcoin master (1000 commits)', () => {
  interface AnonFixture {
    commits: { hash: string; parents: string[] }[];
    branches: { commit: string; name: string; type: 'local' | 'remote' }[];
    headHash: string;
    headBranchName: string;
  }
  const fx = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'bitcoinMasterTopo.json'), 'utf-8')
  ) as AnonFixture;
  const commits = fx.commits.map((c) => mkCommit(c.hash, c.parents));
  const branchMap = new Map<string, IBranchRef[]>();
  for (const b of fx.branches) {
    const arr = branchMap.get(b.commit) ?? [];
    arr.push({ name: b.name, type: b.type });
    branchMap.set(b.commit, arr);
  }
  const tc: TopoCase = {
    label: 'bitcoin-master',
    commits,
    branchMap,
    headHash: fx.headHash,
    headBranchName: fx.headBranchName,
  };

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
      fx.headBranchName,
      fx.headHash
    );
    let rawMax = 0;
    for (const n of nodes) {
      rawMax = Math.max(
        rawMax,
        n.graphColumn,
        ...n.graphLines.flatMap((l) => [l.fromColumn, l.toColumn])
      );
    }
    const packedMax = maxColumn(nodes, fx.headHash);
    assert.ok(rawMax >= 20, `fixture should exercise many raw lanes, got ${rawMax}`);
    assert.ok(
      packedMax <= 15,
      `compaction should keep bitcoin's column count small (raw ${rawMax} -> packed ${packedMax})`
    );
    assert.ok(packedMax < rawMax, `packed (${packedMax}) must be below raw (${rawMax})`);
  });
});
