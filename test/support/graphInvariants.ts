/**
 * Shared structural-invariant checker for the whole graph layout pipeline:
 * generateCommitGraph -> buildGraphPrintModel (long-edge hiding) ->
 * compactPrintModelLanes -> paintRow. Used by the synthetic topo suite and the
 * real bitcoin-master fixture so both exercise identical invariants.
 *
 * The compaction pass relabels an element's drawn lanes (`lane`/`fromLane`/
 * `targetLane`) but deliberately leaves the per-edge IDENTITY (`edge.edge`,
 * carrying the raw childRow + raw lane) untouched — so these checks use that
 * identity to reason about "the same edge across rows" after columns are packed.
 */

import * as assert from 'assert';
import { generateCommitGraph, IBranchRef, ICommitNode } from '../../src/git-core/commitGraph';
import {
  buildGraphPrintModel,
  IRowPrintModel,
  IRowEdgeElement,
} from '../../src/git-core/graph/printModel';
import { compactPrintModelLanes } from '../../src/git-core/graph/laneCompaction';
import { paintRow } from '../../src/git-core/graph/graphPainter';
import { DEFAULT_GRAPH_CONFIG } from '../../src/utils/graphRenderer';
import type { ICommit } from '../../src/git-core/interfaces/IGitService';

export function mkCommit(hash: string, parents: string[]): ICommit {
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

export interface TopoCase {
  label: string;
  commits: ICommit[];
  branchMap?: Map<string, IBranchRef[]>;
  headHash?: string;
  headBranchName?: string;
}

/** Stable identity key for an edge element (raw childRow/parent/lane). */
function edgeKey(e: IRowEdgeElement): string {
  const p = e.edge.parent.kind === 'inWindow' ? `r${e.edge.parent.row}` : 'off';
  return `${e.edge.childRow}:${p}:${e.edge.lane}`;
}

function straightVerticals(m: IRowPrintModel): IRowEdgeElement[] {
  return m.edges.filter((e) => !e.curved && e.fromLane === e.targetLane);
}

function build(tc: TopoCase): ICommitNode[] {
  return generateCommitGraph(
    tc.commits,
    tc.branchMap,
    undefined,
    undefined,
    tc.headBranchName,
    tc.headHash
  );
}

function models(tc: TopoCase, nodes: ICommitNode[]): IRowPrintModel[] {
  return buildGraphPrintModel(nodes, { headHash: tc.headHash });
}

/** Run the whole pipeline on a topology and assert every layout invariant. */
export function assertGraphInvariants(tc: TopoCase): void {
  const nodes = build(tc);
  assert.strictEqual(nodes.length, tc.commits.length, `${tc.label}: every commit is a node`);

  const rowOf = new Map<string, number>();
  nodes.forEach((n, i) => rowOf.set(n.commit.hash, i));

  // --- Generate-level invariants ---
  nodes.forEach((n, i) => {
    // A. topo order: an in-window parent is strictly below its child.
    for (const p of n.commit.parents) {
      const pr = rowOf.get(p);
      if (pr !== undefined) {
        assert.ok(
          pr > i,
          `${tc.label}: parent ${p} of ${n.commit.hash} must be below (row ${pr} <= ${i})`
        );
      }
    }
    // B. every line targets a real in-window parent lane OR is an off-window stub.
    for (const line of n.graphLines) {
      const offWindowStub = line.fromColumn === line.toColumn && line.style === 'dashed';
      if (offWindowStub) {
        continue;
      }
      const hasParentAtToCol = n.commit.parents.some((p) => {
        const pr = rowOf.get(p);
        return pr !== undefined && nodes[pr].graphColumn === line.toColumn;
      });
      const sameLaneInWindow =
        line.fromColumn === line.toColumn &&
        n.commit.parents.some((p) => rowOf.get(p) !== undefined);
      assert.ok(
        hasParentAtToCol || sameLaneInWindow,
        `${tc.label}: line from ${n.commit.hash} to col ${line.toColumn} hits no in-window parent`
      );
    }
  });

  // --- Pipeline: build (hidden) + compact ---
  const before = models(tc, nodes);
  const colorsBefore = before.map((m) => m.edges.map((e) => e.color));
  const compacted = compactPrintModelLanes(models(tc, nodes));

  // F. compaction preserves resolved colors (only columns are relabeled).
  const colorsAfter = compacted.map((m) => m.edges.map((e) => e.color));
  assert.deepStrictEqual(
    colorsAfter,
    colorsBefore,
    `${tc.label}: compaction must not change colors`
  );

  // I. idempotent — a second compaction is a no-op.
  const lanesOnce = compacted.map((m) => m.edges.map((e) => e.lane));
  compactPrintModelLanes(compacted);
  const lanesTwice = compacted.map((m) => m.edges.map((e) => e.lane));
  assert.deepStrictEqual(lanesTwice, lanesOnce, `${tc.label}: compaction must be idempotent`);

  let globalMaxCol = 0;
  let maxDistinctInARow = 0;
  const columnsUsed = new Set<number>();
  const prevByKey = new Map<string, { row: number; col: number }>();

  compacted.forEach((m, row) => {
    // C. paints without throwing, non-empty svg.
    const svg = paintRow(m, DEFAULT_GRAPH_CONFIG);
    assert.ok(svg.startsWith('<svg') && svg.length > 10, `${tc.label}: row ${row} must paint`);

    const sv = straightVerticals(m);
    // D. no collision: a packed column carries at most one distinct edge identity.
    const identsByCol = new Map<number, Set<string>>();
    for (const e of sv) {
      let set = identsByCol.get(e.lane);
      if (!set) {
        identsByCol.set(e.lane, (set = new Set()));
      }
      set.add(edgeKey(e));
    }
    for (const [col, idents] of identsByCol) {
      assert.strictEqual(
        idents.size,
        1,
        `${tc.label}: row ${row} column ${col} carries ${idents.size} distinct edges (collision)`
      );
    }

    // E. continuity: an edge on consecutive rows keeps its column.
    for (const e of sv) {
      const k = edgeKey(e);
      const prev = prevByKey.get(k);
      if (prev && prev.row === row - 1) {
        assert.strictEqual(
          e.lane,
          prev.col,
          `${tc.label}: edge ${k} jumped column ${prev.col}->${e.lane} between rows ${prev.row}/${row}`
        );
      }
      prevByKey.set(k, { row, col: e.lane });
    }

    // width / density bookkeeping.
    const cols = new Set<number>();
    if (m.node.lane >= 0) {
      cols.add(m.node.lane);
    }
    for (const e of m.edges) {
      for (const l of [e.lane, e.fromLane, e.targetLane]) {
        if (l >= 0) {
          cols.add(l);
          columnsUsed.add(l);
          globalMaxCol = Math.max(globalMaxCol, l);
        }
      }
    }
    maxDistinctInARow = Math.max(maxDistinctInARow, cols.size);
  });

  // G. HEAD first-parent chain stays on column 0 after compaction.
  if (tc.headHash !== undefined && rowOf.has(tc.headHash)) {
    let cur: string | undefined = tc.headHash;
    const guard = new Set<string>();
    while (cur !== undefined && rowOf.has(cur) && !guard.has(cur)) {
      guard.add(cur);
      const hrow: number = rowOf.get(cur)!;
      assert.strictEqual(
        compacted[hrow].node.lane,
        0,
        `${tc.label}: HEAD-chain commit ${cur} must stay on column 0`
      );
      cur = nodes[hrow].commit.parents[0];
    }
  }

  // H. compaction is dense + optimal: columns used are exactly 0..K where
  // K+1 == the max lanes drawn in any single row (interval-coloring optimum).
  if (columnsUsed.size > 0) {
    assert.strictEqual(
      globalMaxCol + 1,
      maxDistinctInARow,
      `${tc.label}: columns used (max ${globalMaxCol}) should equal the busiest row's lane count (${maxDistinctInARow})`
    );
    for (let c = 0; c <= globalMaxCol; c++) {
      assert.ok(columnsUsed.has(c), `${tc.label}: column ${c} skipped (not dense)`);
    }
  }
}
