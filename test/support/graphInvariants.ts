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
import * as fs from 'fs';
import * as path from 'path';
import { generateCommitGraph, IBranchRef, ICommitNode } from '../../src/git-core/commitGraph';
import {
  buildGraphPrintModel,
  IRowPrintModel,
  IRowEdgeElement,
} from '../../src/git-core/graph/printModel';
import { compactPrintModelLanes } from '../../src/git-core/graph/laneCompaction';
import { paintRow } from '../../src/git-core/graph/graphPainter';
import { DEFAULT_GRAPH_CONFIG, getColumnX } from '../../src/utils/graphRenderer';
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

interface IAnonFixtureFile {
  commits: { hash: string; parents: string[] }[];
  branches: { commit: string; name: string; type: 'local' | 'remote' }[];
  headHash: string;
  headBranchName: string;
}

/**
 * Load one of the anonymized real-history fixtures (test/unit/utils/topo/*.json)
 * as a {@link TopoCase}, optionally windowed to the first `depth` commits (newest
 * first, matching git log order) — the shape `workspace-notes/verify/paintAll.ts`
 * uses to build the four named oracle fixtures (bitcoin@1000, realTopoAnon@413/100,
 * selfTopoAnon@125). A branch ref pointing outside the window is dropped rather
 * than left dangling, matching how a real repo's window load behaves.
 */
export function loadAnonFixture(filename: string, depth?: number): TopoCase {
  const fx = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../unit/utils/topo', filename), 'utf-8')
  ) as IAnonFixtureFile;
  const sliced = depth === undefined ? fx.commits : fx.commits.slice(0, depth);
  const inWindow = new Set(sliced.map((c) => c.hash));
  const commits = sliced.map((c) => mkCommit(c.hash, c.parents));
  const branchMap = new Map<string, IBranchRef[]>();
  for (const b of fx.branches) {
    if (!inWindow.has(b.commit)) {
      continue;
    }
    const arr = branchMap.get(b.commit) ?? [];
    arr.push({ name: b.name, type: b.type });
    branchMap.set(b.commit, arr);
  }
  return {
    label: depth === undefined ? filename : `${filename}@${depth}`,
    commits,
    branchMap,
    headHash: fx.headHash,
    headBranchName: fx.headBranchName,
  };
}

/** Stable identity key for an edge element (raw childRow/parent/lane). */
function edgeKey(e: IRowEdgeElement): string {
  const p = e.edge.parent.kind === 'inWindow' ? `r${e.edge.parent.row}` : 'off';
  return `${e.edge.childRow}:${p}:${e.edge.lane}`;
}

/**
 * The x this ONE edge actually paints at boundary `y` (0 or rowHeight), read
 * off `paintRow`'s real SVG output for that edge in isolation (node hidden,
 * no chevrons) — never `topLane`/`bottomLane` directly, so a docking bug
 * shows up as ink that lands somewhere else, not as a re-read of the same
 * field the bug is in. A straight/polyline's true endpoints are its first
 * and last point; a bezier's are its `M` start and its LAST coordinate pair
 * (the middle two pairs are control points, not endpoints, and can carry a
 * boundary y of their own — using them would false-match a curve that never
 * actually reaches this edge's real endpoint there).
 */
function isolatedBoundaryX(e: IRowEdgeElement, y: number): number | undefined {
  const isolated: IRowPrintModel = {
    rowIndex: 0,
    node: {
      lane: -1,
      isMerge: false,
      isTerminal: false,
      isCurrentHead: false,
      isBranchSplit: false,
      onFocusedBranchPath: false,
    },
    edges: [e],
    inkedLanes: [],
    isLastRow: false,
    chevronLanes: [],
    hasFocusedBranch: false,
  };
  const svg = paintRow(isolated, DEFAULT_GRAPH_CONFIG);

  const line = /<line x1="(-?[\d.]+)" y1="(-?[\d.]+)" x2="(-?[\d.]+)" y2="(-?[\d.]+)"/.exec(svg);
  if (line) {
    if (Number(line[2]) === y) {
      return Number(line[1]);
    }
    if (Number(line[4]) === y) {
      return Number(line[3]);
    }
    return undefined;
  }
  const poly = /<polyline points="([^"]+)"/.exec(svg);
  if (poly) {
    const pts = poly[1]
      .trim()
      .split(/\s+/)
      .map((p) => p.split(',').map(Number));
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (first[1] === y) {
      return first[0];
    }
    if (last[1] === y) {
      return last[0];
    }
    return undefined;
  }
  // The bezier tag is `<path d="..." stroke=...>` (fill="none"); an arrowhead
  // is `<path d="..." fill=...>` — disjoint from a bezier edge in isolation,
  // so matching on the attribute right after `d="..."` picks the curve only.
  const bezier = /<path d="([^"]+)" stroke=/.exec(svg);
  if (bezier) {
    const pts = (bezier[1].match(/-?[\d.]+,-?[\d.]+/g) ?? []).map((p) => p.split(',').map(Number));
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (first[1] === y) {
      return first[0];
    }
    if (last[1] === y) {
      return last[0];
    }
    return undefined;
  }
  return undefined;
}

/**
 * Ground truth for "what column does raw lane L occupy in this (already
 * compacted) row" — recomputed independently from the row's OWN straight
 * edges (`edge.edge.lane`, untouched by remap, -> `e.lane`, the packed
 * result) plus the row's own commit (`nodes[row].graphColumn`, the untouched
 * allocator output, -> `m.node.lane`). Never reads `topLane`/`bottomLane`.
 */
function rawLaneGroundTruth(m: IRowPrintModel, rawNodeLane: number): Map<number, number> {
  const map = new Map<number, number>();
  for (const e of m.edges) {
    if (!e.curved && e.fromLane === e.targetLane) {
      map.set(e.edge.lane, e.lane);
    }
  }
  if (rawNodeLane >= 0) {
    map.set(rawNodeLane, m.node.lane);
  }
  return map;
}

/**
 * K, arm 1 (boundary ink continuity): for every edge half that touches a row
 * boundary, its raw lane (`edge.edge.lane`) is looked up in the NEIGHBOR
 * row's ground truth. When the neighbor genuinely draws that raw lane
 * somewhere, the painter docks this edge's boundary pixel to the MIDPOINT of
 * its own column and that neighbor column (graphPainter.ts's seam docking,
 * `(x + getColumnX(seamCol)) / 2`) rather than jumping straight to the
 * neighbor's column x — a seam is a slant toward continuity, not a teleport.
 * So the expected x here is that same midpoint, not the neighbor column's x.
 * No ground-truth entry means the neighbor never draws that raw lane at all —
 * a legitimate termination (hidden long-edge gap, off-window stub, a leaf),
 * not a break, so it's skipped rather than compared against 0.
 *
 * A curved 'down' half only checks the DIRECT case (its parent lands exactly
 * at the next row) — a far-parent bend spanning further rows is checked at
 * its OWN landing row instead, via the matching curved 'up' half there.
 */
function countBrokenBoundaries(models: IRowPrintModel[], nodes: ICommitNode[]): number {
  const groundTruth = models.map((m, row) => rawLaneGroundTruth(m, nodes[row].graphColumn));
  const bottomY = DEFAULT_GRAPH_CONFIG.rowHeight;
  let broken = 0;
  models.forEach((m, row) => {
    for (const e of m.edges) {
      const rawLane = e.edge.lane;
      const straight = !e.curved && e.fromLane === e.targetLane;
      if (
        (straight && (e.half === 'full' || e.half === 'down')) ||
        (e.curved && e.half === 'down')
      ) {
        const landsNextRow =
          straight || (e.edge.parent.kind === 'inWindow' && e.edge.parent.row === row + 1);
        if (landsNextRow && row + 1 < models.length) {
          const expectedCol = groundTruth[row + 1].get(rawLane);
          if (expectedCol !== undefined) {
            const actual = isolatedBoundaryX(e, bottomY);
            const ownX = getColumnX(e.curved ? e.targetLane : e.lane, DEFAULT_GRAPH_CONFIG);
            const mid = (ownX + getColumnX(expectedCol, DEFAULT_GRAPH_CONFIG)) / 2;
            if (actual !== mid) {
              broken++;
            }
          }
        }
      }
      if ((straight && (e.half === 'full' || e.half === 'up')) || (e.curved && e.half === 'up')) {
        if (row - 1 >= 0) {
          const expectedCol = groundTruth[row - 1].get(rawLane);
          if (expectedCol !== undefined) {
            const actual = isolatedBoundaryX(e, 0);
            const ownX = getColumnX(e.curved ? e.fromLane : e.lane, DEFAULT_GRAPH_CONFIG);
            const mid = (ownX + getColumnX(expectedCol, DEFAULT_GRAPH_CONFIG)) / 2;
            if (actual !== mid) {
              broken++;
            }
          }
        }
      }
    }
  });
  return broken;
}

/** Every x this row paints anywhere (lines, polylines, circles, rects, every
 * path coordinate pair) — for the containment arm, which must catch a chevron
 * or arrowhead as readily as a straight segment. */
function paintedXsAnywhere(svg: string): number[] {
  const xs: number[] = [];
  for (const m of svg.matchAll(/x1="(-?[\d.]+)"/g)) {
    xs.push(Number(m[1]));
  }
  for (const m of svg.matchAll(/x2="(-?[\d.]+)"/g)) {
    xs.push(Number(m[1]));
  }
  for (const m of svg.matchAll(/cx="(-?[\d.]+)"/g)) {
    xs.push(Number(m[1]));
  }
  for (const m of svg.matchAll(/<rect x="(-?[\d.]+)"[^>]*width="(-?[\d.]+)"/g)) {
    const x = Number(m[1]);
    const w = Number(m[2]);
    xs.push(x, x + w);
  }
  for (const m of svg.matchAll(/<polyline points="([^"]+)"/g)) {
    for (const pair of m[1].trim().split(/\s+/)) {
      xs.push(Number(pair.split(',')[0]));
    }
  }
  for (const m of svg.matchAll(/<path d="([^"]+)"/g)) {
    for (const pair of m[1].match(/-?[\d.]+,-?[\d.]+/g) ?? []) {
      xs.push(Number(pair.split(',')[0]));
    }
  }
  return xs;
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

  // I. deterministic — two INDEPENDENT fresh builds pack to the same columns.
  // Not a fixed-point (in-place re-compaction) check: once compaction also
  // links seams, a second in-place pass rebuilds rawToColumn from
  // already-packed lanes and is no longer a no-op on topLane/bottomLane —
  // running it on the SAME objects K inspects below would silently overwrite
  // a wrong seam with one that happens to agree, laundering the exact defect
  // K exists to catch before K ever sees it. Building a second, wholly
  // separate model set (no shared references with `compacted` at all) proves
  // the same thing — compaction is a pure function of the topology, not of
  // incidental object identity — without that hazard.
  const lanesOnce = compacted.map((m) => m.edges.map((e) => e.lane));
  const compactedAgain = compactPrintModelLanes(models(tc, nodes));
  const lanesAgain = compactedAgain.map((m) => m.edges.map((e) => e.lane));
  assert.deepStrictEqual(lanesAgain, lanesOnce, `${tc.label}: compaction must be deterministic`);

  let globalMaxCol = 0;
  let maxDistinctInARow = 0;
  const columnsUsed = new Set<number>();
  const prevByKey = new Map<string, { row: number; lane: number; bottomSeam: number }>();

  compacted.forEach((m, row) => {
    // C. paints without throwing, non-empty svg.
    const svg = paintRow(m, DEFAULT_GRAPH_CONFIG);
    assert.ok(svg.startsWith('<svg') && svg.length > 10, `${tc.label}: row ${row} must paint`);

    // K, arm 2 (containment): every painted x — lines, polylines, circles,
    // rects, every path (chevrons/arrowheads/beziers included) — stays inside
    // this row's OWN svgWidth. A chevron lane the packer never mapped keeps
    // its raw index and paints far off-canvas with no error otherwise.
    const widthMatch = /<svg width="(-?[\d.]+)"/.exec(svg);
    const svgWidth = widthMatch ? Number(widthMatch[1]) : 0;
    for (const x of paintedXsAnywhere(svg)) {
      assert.ok(
        x >= 0 && x <= svgWidth,
        `${tc.label}: row ${row} paints x=${x} outside its own svgWidth ${svgWidth}`
      );
    }

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

    // E2. seam continuity: RANK legitimately relabels a lane's column at a
    // fork/merge boundary (column continuity itself, old invariant E, is no
    // longer required — expect ~200 adjacent-row column changes on
    // bitcoin@1000 where there are 0 today), so what must hold instead is
    // that each side's seam stamp faithfully names the OTHER side's real
    // column — not that the two stamps equal each other. The painter's
    // docking midpoint is `(ownColumn + seamColumn) / 2` on both sides of a
    // boundary; that only lands on the same pixel when each stamp points at
    // the other row's actual `.lane`, e.g. own columns 1 (row r) and 0 (row
    // r+1) with seams 0 and 1 respectively both average to the same x —
    // seams 1 and 1 (equal to each other) would NOT. Quantified over every
    // element, straight or curved: a curved bend's identity never continues
    // by construction (see laneLinking.ts), so it never finds a `prev` here
    // and this is a silent no-op for it, same as old E's straightVerticals
    // filter was for bends.
    for (const e of m.edges) {
      const k = edgeKey(e);
      const prev = prevByKey.get(k);
      if ((e.half === 'full' || e.half === 'up') && prev && prev.row === row - 1) {
        const topSeam = e.topLane ?? e.lane;
        assert.strictEqual(
          prev.bottomSeam,
          e.lane,
          `${tc.label}: edge ${k} row ${prev.row}'s bottom seam ${prev.bottomSeam} must name row ${row}'s real column ${e.lane}`
        );
        assert.strictEqual(
          topSeam,
          prev.lane,
          `${tc.label}: edge ${k} row ${row}'s top seam ${topSeam} must name row ${prev.row}'s real column ${prev.lane}`
        );
      }
      if (e.half === 'full' || e.half === 'down') {
        prevByKey.set(k, { row, lane: e.lane, bottomSeam: e.bottomLane ?? e.lane });
      }
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
    for (const l of m.inkedLanes) {
      if (l >= 0) {
        cols.add(l);
        columnsUsed.add(l);
        globalMaxCol = Math.max(globalMaxCol, l);
      }
    }
    maxDistinctInARow = Math.max(maxDistinctInARow, cols.size);
  });

  // K, arm 1 (boundary ink continuity): compaction + seam linking must not ADD
  // a row boundary where ink leaving row r fails to meet ink entering row r+1.
  // Compared against the SAME models UNPACKED (`before`, post-hiding but
  // pre-compaction) rather than 0 — a hidden long-edge gap or a terminating
  // stub legitimately ends at a boundary, and those are already counted there.
  const brokenCompacted = countBrokenBoundaries(compacted, nodes);
  const brokenUnpacked = countBrokenBoundaries(before, nodes);
  assert.ok(
    brokenCompacted <= brokenUnpacked,
    `${tc.label}: compaction added a broken row boundary (unpacked ${brokenUnpacked}, compacted ${brokenCompacted})`
  );

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

  // H2. width budget + density: the packed width (max column + 1, over both
  // drawn edges and inked lanes) must not exceed the busiest row's distinct
  // drawn-lane count, and every column below the max is actually used.
  if (columnsUsed.size > 0) {
    assert.ok(
      globalMaxCol + 1 <= maxDistinctInARow,
      `${tc.label}: packed width ${globalMaxCol + 1} exceeds the drawn-density budget ${maxDistinctInARow}`
    );
    for (let c = 0; c <= globalMaxCol; c++) {
      assert.ok(columnsUsed.has(c), `${tc.label}: column ${c} skipped (not dense)`);
    }
  }

  // J. gap termination: a hidden long edge's two arrow stubs (applyLongEdgeHiding)
  // bound a span where its raw lane inks NOTHING at all. Asserted on
  // `e.edge.lane` (the identity's raw lane, untouched by compaction), never
  // `e.lane` — under rank the packed column in that span is freely reused by
  // whichever unrelated lane is visible there, which is the entire payoff of
  // compaction; asserting on the packed column would go red on correct code.
  const downArrows: Array<{ row: number; rawLane: number }> = [];
  const upArrows: Array<{ row: number; rawLane: number }> = [];
  compacted.forEach((m, row) => {
    for (const e of m.edges) {
      if (e.arrow === 'down') {
        downArrows.push({ row, rawLane: e.edge.lane });
      } else if (e.arrow === 'up') {
        upArrows.push({ row, rawLane: e.edge.lane });
      }
    }
  });
  for (const down of downArrows) {
    // Distinct spans on the same physical lane number never overlap in row
    // range (a lane is only reused once its previous interval fully ends), so
    // the NEAREST following up-arrow on the same raw lane is unambiguously
    // this gap's own closing stub.
    let closingUp: { row: number; rawLane: number } | undefined;
    for (const up of upArrows) {
      if (up.rawLane === down.rawLane && up.row > down.row) {
        if (closingUp === undefined || up.row < closingUp.row) {
          closingUp = up;
        }
      }
    }
    if (closingUp === undefined) {
      continue;
    }
    for (let r = down.row + 1; r < closingUp.row; r++) {
      const inksRawLane = compacted[r].edges.some((e) => e.edge.lane === down.rawLane);
      assert.ok(
        !inksRawLane,
        `${tc.label}: hidden gap's raw lane ${down.rawLane} inks row ${r} (between arrows at rows ${down.row}/${closingUp.row})`
      );
    }
  }
}
