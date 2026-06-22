/**
 * Whole-DAG graph lane-continuity guard (property / fuzz).
 *
 * Renders the FULL production graph pipeline (`generateCommitGraph` →
 * `computeActiveLanes` / `computeLaneContinuesFromAbove` /
 * `computeLaneContinuesBelow` → per-row `renderGraphSvg`, exactly as
 * `graphClusterBuilder` does) over thousands of randomly generated, fully
 * in-window DAGs and asserts every lane's vertical ink is continuous: no GAP
 * (a single line that loses a row's stroke) and no PHANTOM stub (ink on a lane
 * where no line spans the boundary).
 *
 * This is the anti-regression ratchet for the class of "git tree graph has a
 * gap with multiple branches / different merge operations" bugs. The root cause
 * was straight-stroke ink being decided by `prev/nextActiveLanes` SET membership,
 * which cannot tell lane REUSE (one line dies, an unrelated one is reborn on the
 * same lane next row) from a genuine through-line. The fix drives all straight
 * strokes from the interval model. The single reported topology is pinned
 * separately in `test/unit/utils/topo/graphSplitThroughLine.test.ts`; this guard
 * covers the whole generated space.
 *
 * SCOPE: fully in-window DAGs (every parent references a loaded row; the oldest
 * rows are true roots). Off-window / dashed "history continues below" stubs are
 * an orthogonal concern, pinned by the real/self/intellij topo fixtures.
 *
 * Oracle (exact, exception-free for in-window DAGs). For row i, lane L:
 *   expectedTop(i,L)    = continuesFromAbove(i).has(L) || a far-parent bend lands here from L
 *   expectedBottom(i,L) = continuesFromAbove(i+1).has(L) || a cross-lane bezier is drawn to L here
 * Validated to flag ZERO defects on the committed real/self anonymized topo
 * fixtures (genuine well-rendered histories) before being relied on here.
 */

import '../setup';
import * as assert from 'assert';
import {
  generateCommitGraph,
  computeChildLanesMap,
  computeChildCountMap,
  computeTerminalNodes,
  computeIncomingBendsMap,
  isBranchSplit,
} from '../../src/git-core/commitGraph';
import {
  computeActiveLanes,
  computeLaneContinuesFromAbove,
  computeLaneContinuesBelow,
  renderGraphSvg,
  getColumnX,
  DEFAULT_GRAPH_CONFIG,
} from '../../src/utils/graphRenderer';
import type { ICommit } from '../../src/git-core/interfaces/IGitService';

const BOTTOM_Y = DEFAULT_GRAPH_CONFIG.rowHeight;

/** Deterministic PRNG so a failing seed reproduces exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function commit(hash: string, parents: string[]): ICommit {
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

/**
 * Random valid newest-first DAG resembling a real `git log` window: every
 * parent references a row strictly below (in-window); the oldest rows are true
 * roots. Mostly-linear with ~45% merges and a near-first-parent bias, so it
 * exercises lane reuse, far-parent fork points, and branch-split through-lines.
 */
function genDag(rng: () => number): ICommit[] {
  const n = 6 + Math.floor(rng() * 44); // 6..49 commits
  const commits: ICommit[] = [];
  for (let i = 0; i < n; i++) {
    const id = `n${i}`;
    const below: number[] = [];
    for (let j = i + 1; j < n; j++) {
      below.push(j);
    }
    if (below.length === 0) {
      commits.push(commit(id, [])); // oldest row: a true root
      continue;
    }
    const parents: string[] = [];
    const pcount = rng() < 0.55 ? 1 : 2; // ~45% merges
    const used = new Set<number>();
    for (let p = 0; p < pcount; p++) {
      let pick = p === 0 && rng() < 0.6 ? below[0] : below[Math.floor(rng() * below.length)];
      if (used.has(pick)) {
        pick = below[Math.floor(rng() * below.length)];
      }
      used.add(pick);
      parents.push(`n${pick}`);
    }
    commits.push(commit(id, parents));
  }
  return commits;
}

/**
 * Endpoint-only ink probe: a vertical `<line>`'s endpoints, and a `<path>`
 * bezier's START (`M`) and FINAL point — NOT its control points (which are not
 * drawn ink and would yield false matches).
 */
function inkAt(svg: string, x: number, y: number): boolean {
  const lineRe = /<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/g;
  for (let m = lineRe.exec(svg); m; m = lineRe.exec(svg)) {
    if (+m[1] === x && +m[3] === x && (+m[2] === y || +m[4] === y)) {
      return true;
    }
  }
  const pathRe = /<path d="M ([\d.-]+),([\d.-]+) C [\d.,\s-]* ([\d.-]+),([\d.-]+)"/g;
  for (let m = pathRe.exec(svg); m; m = pathRe.exec(svg)) {
    if ((+m[1] === x && +m[2] === y) || (+m[3] === x && +m[4] === y)) {
      return true;
    }
  }
  return false;
}

/** Returns a list of human-readable defects ([] = clean). */
function findDefects(commits: ICommit[]): string[] {
  const nodes = generateCommitGraph(commits);
  const active = computeActiveLanes(nodes);
  const fromAbove = computeLaneContinuesFromAbove(nodes);
  const below = computeLaneContinuesBelow(nodes);
  const childLanes = computeChildLanesMap(nodes);
  const childCount = computeChildCountMap(nodes);
  const incoming = computeIncomingBendsMap(nodes);
  const terminal = computeTerminalNodes(nodes);

  const svgs = nodes.map((nd, i) =>
    renderGraphSvg(
      nd,
      i,
      active.get(i) ?? new Set(),
      DEFAULT_GRAPH_CONFIG,
      terminal.has(nd.commit.hash),
      isBranchSplit(nd.commit.hash, childCount),
      childLanes.get(nd.commit.hash) ?? new Set(),
      false,
      active.get(i + 1) ?? new Set(),
      incoming.get(nd.commit.hash) ?? new Set(),
      active.get(i - 1) ?? new Set(),
      i === nodes.length - 1,
      fromAbove.get(i) ?? new Set(),
      below.get(i) ?? new Set()
    )
  );

  const maxLane = Math.max(
    ...nodes.map((nd) => nd.graphColumn),
    ...[...active.values()].flatMap((s) => [...s])
  );

  const defects: string[] = [];
  for (let i = 0; i < svgs.length; i++) {
    const cfa = fromAbove.get(i) ?? new Set<number>();
    const cfaNext = fromAbove.get(i + 1) ?? new Set<number>();
    const bends = incoming.get(nodes[i].commit.hash) ?? new Set<number>();
    // Cross-lane beziers DRAWN at this row land on toColumn at the bottom. A
    // far-parent line (endRow set on a lower row) bends at the PARENT row, not
    // here, so it draws no bezier here and is excluded.
    const beziers = new Set<number>();
    for (const ln of nodes[i].graphLines) {
      if (ln.fromColumn === ln.toColumn) {
        continue;
      }
      if (ln.endRow !== undefined && ln.endRow !== i) {
        continue;
      }
      beziers.add(ln.toColumn);
    }
    const isLast = i === svgs.length - 1;
    for (let lane = 0; lane <= maxLane; lane++) {
      const expTop = cfa.has(lane) || bends.has(lane);
      const expBottom = (cfaNext.has(lane) && !isLast) || beziers.has(lane);
      const x = getColumnX(lane, DEFAULT_GRAPH_CONFIG);
      const top = inkAt(svgs[i], x, 0);
      const bottom = inkAt(svgs[i], x, BOTTOM_Y);
      if (top !== expTop) {
        defects.push(
          `row ${i} (${nodes[i].commit.hash}) lane ${lane} TOP: expected ${expTop}, got ${top}`
        );
      }
      // Last row caps off-window continuations with chevrons; skip its bottom.
      if (!isLast && bottom !== expBottom) {
        defects.push(
          `row ${i} (${nodes[i].commit.hash}) lane ${lane} BOTTOM: expected ${expBottom}, got ${bottom}`
        );
      }
    }
  }
  return defects;
}

describe('graph lane continuity — whole-DAG gap/phantom guard', () => {
  it('renders no lane gap or phantom stub across 3000 random in-window DAGs', () => {
    const NRUNS = 3000;
    for (let seed = 1; seed <= NRUNS; seed++) {
      const dag = genDag(mulberry32(seed));
      const defects = findDefects(dag);
      assert.deepStrictEqual(
        defects.slice(0, 6),
        [],
        `seed ${seed}: ${defects.length} lane-continuity defect(s)\n${defects
          .slice(0, 6)
          .join('\n')}\nTopology:\n${dag
          .map((c) => `  ${c.hash} -> [${c.parents.join(', ')}]`)
          .join('\n')}`
      );
    }
  });

  it('pins the reuse-phantom minimal repro (a dying lane reborn next row)', () => {
    // lane 1 dies at n2 (a root) and is reborn at the n3 merge for n5; the old
    // renderer drew a phantom top stub at n3's lane 1 (prevActiveLanes saw it
    // active above and assumed continuation).
    const dag = [
      commit('n0', ['n1']),
      commit('n1', ['n3', 'n2']),
      commit('n2', []),
      commit('n3', ['n4', 'n5']),
      commit('n4', ['n5']),
      commit('n5', []),
    ];
    assert.deepStrictEqual(findDefects(dag), []);
  });

  it('pins the far-parent fork-point minimal repro (through-trunk under far edges)', () => {
    // n0/n2/n3 carry far-parent edges to n5; lane 0 is the trunk transiting
    // straight down. The old renderer counted each far edge's destination lane 0
    // as a bezier target and truncated the trunk to its top half (gap), because
    // the far bezier is deferred to the parent row and never drawn here.
    const dag = [
      commit('n0', ['n5']),
      commit('n1', ['n2']),
      commit('n2', ['n5']),
      commit('n3', ['n5']),
      commit('n4', ['n5']),
      commit('n5', []),
    ];
    assert.deepStrictEqual(findDefects(dag), []);
  });
});
