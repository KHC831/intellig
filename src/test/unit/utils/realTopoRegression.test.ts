/**
 * Real-topology regression pin (anonymized).
 *
 * `src/test/fixtures/realTopoAnon.json` is a FULLY ANONYMIZED capture of a
 * real `git log --all --topo-order -n500` from a repo whose graph rendered
 * the reported bugs (node/line colour mismatch; mainline fragmented across
 * lanes/colours; orphan vertical strokes running through the trunk). All
 * private data is stripped: commit SHAs are renumbered c0,c1,…; branch names
 * are genericised branch0,branch1,…; authors/dates/messages are dropped. Only
 * the parent topology, which tip each branch ref points at, and which ref is
 * HEAD are preserved — that's all the lane algorithm consumes.
 *
 * This is the test that finally reproduced the bug after several rounds of
 * synthetic fixtures failed to. On the PRE-fix code this fixture produced 49
 * orphan-active-lane rows and split the mainline across 3 lanes (L0/L2/L11);
 * the fix collapses it to a single lane-0 mainline with 0 orphans. We pin
 * both invariants so a regression in either the spine pre-claim
 * (commitGraph.ts) or the bending-line interval logic (graphRenderer.ts) is
 * caught against real-world data, not just generated DAGs.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  generateCommitGraph,
  computeTerminalNodes,
  IBranchRef,
  ICommitNode,
} from '../../../git-core/commitGraph';
import {
  computeActiveLanes,
  computeGraphWidth,
  DEFAULT_GRAPH_CONFIG,
} from '../../../utils/graphRenderer';
import type { ICommit } from '../../../git-core/interfaces/IGitService';

interface AnonFixture {
  commits: { hash: string; parents: string[] }[];
  branches: { commit: string; name: string; type: 'local' | 'remote' }[];
  headHash: string;
  headBranchName: string;
}

function mk(hash: string, parents: string[]): ICommit {
  return {
    hash,
    shortHash: hash,
    message: hash,
    author: { name: 'a', email: 'a@a' },
    committer: { name: 'a', email: 'a@a' },
    parents,
    authorDate: new Date(0),
    commitDate: new Date(0),
  } as ICommit;
}

/**
 * Recompute, directly from the node geometry, the set of lanes that
 * genuinely have ink at each row: a node's own column at its row; a
 * same-lane line's column across its whole span; a bending line's
 * DESTINATION column across its span PLUS its source column at the source
 * row only (the bend lives entirely in the source row).
 */
function groundTruthInk(nodes: ICommitNode[]): Map<number, Set<number>> {
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
    for (const line of n.graphLines) {
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

describe('Real anonymized topology — graph regression pins', () => {
  const fx = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'realTopoAnon.json'), 'utf-8')
  ) as AnonFixture;
  const commits = fx.commits.map((c) => mk(c.hash, c.parents));
  const branchMap = new Map<string, IBranchRef[]>();
  for (const b of fx.branches) {
    const arr = branchMap.get(b.commit) ?? [];
    arr.push({ name: b.name, type: b.type });
    branchMap.set(b.commit, arr);
  }

  function build(): ICommitNode[] {
    return generateCommitGraph(
      commits,
      branchMap,
      undefined,
      undefined,
      fx.headBranchName,
      fx.headHash
    );
  }

  it('HEAD mainline is a single contiguous lane-0 column (not fragmented across lanes)', () => {
    const nodes = build();
    const byHash = new Map<string, ICommitNode>(nodes.map((n) => [n.commit.hash, n]));
    let cur: string | undefined = fx.headHash;
    const guard = new Set<string>();
    while (cur !== undefined && byHash.has(cur) && !guard.has(cur)) {
      guard.add(cur);
      const n: ICommitNode | undefined = byHash.get(cur);
      if (n === undefined) {
        break;
      }
      assert.strictEqual(
        n.graphColumn,
        0,
        `HEAD first-parent chain commit ${cur} must be on lane 0; got ${n.graphColumn}. ` +
          `Pre-fix this fixture split the mainline across L0/L2/L11.`
      );
      cur = n.commit.parents[0];
    }
  });

  it('no orphan active lanes — every active lane at a row has real ink there', () => {
    const nodes = build();
    const active = computeActiveLanes(nodes);
    const truth = groundTruthInk(nodes);
    const orphans: string[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const al = active.get(i) ?? new Set<number>();
      const legit = truth.get(i) ?? new Set<number>();
      for (const lane of al) {
        if (!legit.has(lane)) {
          orphans.push(`row ${i} (${nodes[i].commit.hash}): orphan lane ${lane}`);
        }
      }
    }
    assert.deepStrictEqual(
      orphans.slice(0, 20),
      [],
      `${orphans.length} orphan active-lane(s) — pre-fix this fixture had 49. ` +
        `An orphan lane paints a side-colour vertical stroke through a row whose node is a different colour.`
    );
  });

  it('every node first-parent line colour equals its node lane colour', () => {
    const nodes = build();
    const mismatches: string[] = [];
    for (const n of nodes) {
      const fp = n.graphLines.find((l) => l.type === 'commit');
      if (fp) {
        const expected = `lane ${n.graphColumn}`;
        // The line stores a resolved colour string; compare against the
        // node's lane by re-deriving via the same column index.
        // (getColumnColor is deterministic per column.)
        // We assert structurally: a first-parent line's fromColumn must
        // equal the node's column (so colours match by construction).
        assert.strictEqual(
          fp.fromColumn,
          n.graphColumn,
          `${n.commit.hash}: first-parent line fromColumn ${fp.fromColumn} != node ${expected}`
        );
      }
    }
    assert.deepStrictEqual(mismatches, []);
  });

  it('terminal-node computation is consistent (sanity on real data)', () => {
    const nodes = build();
    const terminals = computeTerminalNodes(nodes);
    assert.ok(terminals.size > 0, 'expected at least one terminal node');
  });

  it('graph column width accommodates ALL lanes (no clipping of outer branches)', () => {
    // The `.commit-graph` cell is `width: var(--graph-width)` with
    // `overflow: hidden`. The provider must publish a --graph-width computed
    // from the widest row, not leave it at the 80px fallback (which fits
    // only ~3 lanes and clipped real repos with more branches — the
    // "older branches pushed out of the tree even when there's space" bug).
    const nodes = build();
    let maxCol = 0;
    for (const n of nodes) {
      maxCol = Math.max(maxCol, n.graphColumn);
      for (const l of n.graphLines) {
        maxCol = Math.max(maxCol, l.fromColumn, l.toColumn);
      }
    }
    const width = computeGraphWidth(nodes, DEFAULT_GRAPH_CONFIG);
    // Width must hold every lane: (maxCol+1) columns of columnWidth + padding.
    const needed =
      (maxCol + 1) * DEFAULT_GRAPH_CONFIG.columnWidth + DEFAULT_GRAPH_CONFIG.padding * 2;
    assert.ok(
      width >= needed,
      `graph width ${width}px must hold all ${maxCol + 1} lanes (needs ${needed}px)`
    );
    // Real fixture has 10+ lanes — prove it exceeds the old 80px clip.
    assert.ok(
      width > 80,
      `real multi-branch topology needs > 80px (the old hardcoded fallback); got ${width}px`
    );
  });
});
