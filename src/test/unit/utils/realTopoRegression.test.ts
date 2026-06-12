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
  computeChildCountMap,
  computeChildLanesMap,
  computeIncomingBendsMap,
  isBranchSplit,
  IBranchRef,
  ICommitNode,
} from '../../../git-core/commitGraph';
import {
  computeActiveLanes,
  computeGraphWidth,
  getColumnX,
  renderGraphSvg,
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
      // Far-parent fork-point bend (Wave 2 / task #68): the source lane runs
      // straight down at rows [row..endRow-1]; the bend itself lands at
      // endRow but is inked there by the parent's own graphColumn — we
      // intentionally do NOT mark the source lane at endRow (preserves the
      // orphan-stroke invariant).
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

  it('test/test2 (c0..c4): branch lane stays vertical down to its fork point at c5', () => {
    // Wave 2 / task #68 — far-parent fork-point edge routing. The
    // divergent branch's oldest commit (c4) has its first parent (c5) on a
    // DIFFERENT lane many rows below. Pre-fix: c4 emitted a one-row
    // diagonal hook into the mainline at its own row, leaving lane 1
    // active only at c4's row and the rows above it. Post-fix: lane 1
    // runs straight down from c4 (row 4) to c5's row (row 22), bending
    // into lane 0 at row 22, where lane 0's own ink at the parent
    // commit absorbs the landing. The bend is drawn at the parent row
    // by the renderer; the source row no longer carries a 1→0 bezier.
    const nodes = build();
    const c4Row = nodes.findIndex((n) => n.commit.hash === 'c4');
    const c5Row = nodes.findIndex((n) => n.commit.hash === 'c5');
    assert.strictEqual(c4Row, 4, 'fixture sanity: c4 at row 4');
    assert.strictEqual(c5Row, 22, 'fixture sanity: c5 at row 22');

    const c4 = nodes[c4Row];
    const c5 = nodes[c5Row];

    // ─── Algorithm layer ────────────────────────────────────────────
    // c4's first-parent line carries endRow=22 (the parent's row).
    const c4Line = c4.graphLines[0];
    assert.ok(c4Line, 'c4 must have a graphLine');
    assert.strictEqual(c4Line.type, 'commit', 'c4 line is a first-parent line');
    assert.strictEqual(c4Line.fromColumn, 1, 'c4 line leaves source lane 1');
    assert.strictEqual(c4Line.toColumn, 0, 'c4 line lands on destination lane 0');
    assert.strictEqual(
      c4Line.endRow,
      22,
      `c4 first-parent line must carry endRow=22 (c5's row); got ${c4Line.endRow}`
    );

    // ─── Active-lanes layer ─────────────────────────────────────────
    // Lane 1 is active at every row from c4's row down to and including
    // (c5Row - 1). It is NOT active at c5's row (the bend lands there but
    // is inked by lane 0's parent column) and not at any row below.
    const active = computeActiveLanes(nodes);
    for (let r = c4Row; r <= c5Row - 1; r++) {
      const set = active.get(r) ?? new Set<number>();
      assert.ok(
        set.has(1),
        `lane 1 must be active at row ${r} (c4..c5-1 fork-point span); got {${[...set].join(',')}}`
      );
    }
    assert.ok(
      !(active.get(c5Row) ?? new Set<number>()).has(1),
      `lane 1 must NOT be active at c5's row ${c5Row} — the bend lands here but is inked by lane 0's parent column`
    );
    // And lane 1 must not leak below c5's row in the immediate stretch
    // beneath the fork point. (We bound this to rows that don't have
    // their own unrelated divergent branch — the fixture re-uses lane 1
    // for other side branches farther down. The orphan-stroke pin covers
    // the full range.)
    for (let r = c5Row + 1; r <= c5Row + 2; r++) {
      assert.ok(
        !(active.get(r) ?? new Set<number>()).has(1),
        `lane 1 must NOT be active at row ${r} (immediately below c5 fork point)`
      );
    }
    // Lane 0 is active at c5's row.
    assert.ok(
      (active.get(c5Row) ?? new Set<number>()).has(0),
      `lane 0 must be active at c5's row ${c5Row}`
    );

    // ─── Incoming-bends map ─────────────────────────────────────────
    const incoming = computeIncomingBendsMap(nodes);
    const c5Bends = incoming.get('c5') ?? new Set<number>();
    assert.ok(
      c5Bends.has(1),
      `computeIncomingBendsMap('c5') must contain source lane 1; got {${[...c5Bends].join(',')}}`
    );
    const c4Bends = incoming.get('c4') ?? new Set<number>();
    assert.strictEqual(
      c4Bends.size,
      0,
      `computeIncomingBendsMap('c4') must be empty (c4 is the source row, not a bend-landing row); got {${[...c4Bends].join(',')}}`
    );

    // ─── Renderer layer ─────────────────────────────────────────────
    const childCountMap = computeChildCountMap(nodes);
    const childLanesMap = computeChildLanesMap(nodes);
    const terminals = computeTerminalNodes(nodes);
    const cfg = DEFAULT_GRAPH_CONFIG;
    const centerY = cfg.rowHeight / 2;
    const lane0X = getColumnX(0, cfg);
    const lane1X = getColumnX(1, cfg);

    // Render c5's row — it should carry the TOP-HALF bend path drawn from
    // (lane1X, 0) curving into (lane0X, centerY).
    const c5Svg = renderGraphSvg(
      c5,
      c5Row,
      active.get(c5Row) ?? new Set<number>(),
      cfg,
      terminals.has('c5'),
      isBranchSplit('c5', childCountMap),
      childLanesMap.get('c5') ?? new Set<number>(),
      false /* hasFocusedBranch */,
      active.get(c5Row + 1) ?? new Set<number>(),
      incoming.get('c5') ?? new Set<number>()
    );
    const expectedTopHalfBend = `<path d="M ${lane1X},0 C ${lane1X},${centerY} ${lane0X},0 ${lane0X},${centerY}"`;
    assert.ok(
      c5Svg.includes(expectedTopHalfBend),
      `c5 row SVG must include the top-half bend path "${expectedTopHalfBend}"; got: ${c5Svg}`
    );

    // Render c4's row — it must NOT contain the OLD source-row 1→0
    // bottom-half bezier (`M lane1X,centerY C lane1X,bottomY lane0X,centerY lane0X,bottomY`),
    // and it MUST contain the lane-1 downward stub from centerY to bottomY
    // (the source lane carries straight-down ink at c4's row).
    const c4Svg = renderGraphSvg(
      c4,
      c4Row,
      active.get(c4Row) ?? new Set<number>(),
      cfg,
      terminals.has('c4'),
      isBranchSplit('c4', childCountMap),
      childLanesMap.get('c4') ?? new Set<number>(),
      false,
      active.get(c4Row + 1) ?? new Set<number>(),
      incoming.get('c4') ?? new Set<number>()
    );
    const bottomY = cfg.rowHeight;
    const oldSourceRowBend = `M ${lane1X},${centerY} C ${lane1X},${bottomY} ${lane0X},${centerY} ${lane0X},${bottomY}`;
    assert.ok(
      !c4Svg.includes(oldSourceRowBend),
      `c4 row SVG must NOT contain the OLD source-row 1→0 bezier "${oldSourceRowBend}" (the bend now lives at c5's row); got: ${c4Svg}`
    );
    const lane1Stub = `<line x1="${lane1X}" y1="${centerY}" x2="${lane1X}" y2="${bottomY}"`;
    assert.ok(
      c4Svg.includes(lane1Stub),
      `c4 row SVG must include the lane-1 downward stub "${lane1Stub}" (source lane stays vertical down to fork point); got: ${c4Svg}`
    );
  });
});
