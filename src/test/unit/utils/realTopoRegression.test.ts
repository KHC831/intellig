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

  it('lanes are RELEASED and reused — the graph stays as narrow as concurrently-live branches', () => {
    // The reported "wasteful empty width" + "older branches pushed off the
    // tree" both trace to lanes never being released: every ended branch
    // left a permanently-reserved lane, so each new fork took an ever-higher
    // index (lane 10 in this real repo) even though only ~2-3 branches are
    // ever live at one row. With lane release, the max lane index collapses
    // to the max CONCURRENT lane count, and the computed graph width is tight
    // (IntelliJ-compact), not a wide band of empty columns.
    const nodes = build();
    let maxColIndex = 0;
    for (const n of nodes) {
      maxColIndex = Math.max(maxColIndex, n.graphColumn);
      for (const l of n.graphLines) {
        maxColIndex = Math.max(maxColIndex, l.fromColumn, l.toColumn);
      }
    }
    // Max concurrently-active lanes across all rows — the true visual width.
    const active = computeActiveLanes(nodes);
    let maxConcurrent = 0;
    for (const set of active.values()) {
      maxConcurrent = Math.max(maxConcurrent, set.size);
    }

    // Pre-fix this fixture hit lane index 10 with only ~2 concurrent lanes.
    // After release, the max lane index must be bounded by the concurrent
    // count (+ a tiny slack for transient bend reservations), NOT the total
    // number of branches ever seen.
    assert.ok(
      maxColIndex <= maxConcurrent + 1,
      `max lane index ${maxColIndex} must track concurrent lanes ${maxConcurrent} ` +
        `(+1 slack), not escalate with total branch count. Pre-fix this was 10.`
    );
    // And concretely, this real topology must stay compact (<= 4 lanes),
    // matching IntelliJ — pre-fix it was 11 columns wide.
    assert.ok(
      maxColIndex <= 4,
      `real topology must render compact (<= 4 lanes); got ${maxColIndex + 1} columns`
    );

    // The computed graph width follows suit: tight, not a 240px empty band.
    const width = computeGraphWidth(nodes, DEFAULT_GRAPH_CONFIG);
    const needed =
      (maxColIndex + 1) * DEFAULT_GRAPH_CONFIG.columnWidth + DEFAULT_GRAPH_CONFIG.padding * 2;
    assert.strictEqual(width, needed, 'width exactly fits the (now compact) lane count');
  });
});
