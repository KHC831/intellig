/**
 * Wave D / D4-snap — visual-snapshot tests for `generateCommitGraph`.
 *
 * These tests freeze the lane assignments + graph-line topology for five
 * canonical fixtures so any algorithm change that *visually* alters the
 * graph triggers a deliberate snapshot update.
 *
 * The pre-Wave-D bug (Gap 1: divergent branches collapsing onto a single
 * lane) shipped past the existing behavioural tests because no fixture
 * pinned the divergent-branch lane numbers — only counts. snap-2
 * specifically pins lane numbers for the two-children-of-unseen-parent
 * case, so a future regression to single-pass would force a snapshot
 * change explicitly.
 *
 * NO new test framework — same `assert.deepStrictEqual` against inline
 * frozen objects pattern used elsewhere in `commitGraph.test.ts`. When
 * the algorithm changes legitimately, the developer updates the inline
 * expected literal; there is no `--update-snapshots` opacity.
 *
 * Each snapshot captures `{ graphColumn, parents, graphLines }` per row
 * — enough to reproduce the on-screen lane layout deterministically.
 */

import * as assert from 'assert';
import { generateCommitGraph, type ICommitNode } from '../../../utils/commitGraph';
import type { ICommit } from '../../../services/interfaces/IGitService';
import { renderGraphSvg, DEFAULT_GRAPH_CONFIG } from '../../../utils/graphRenderer';

function mkCommit(hash: string, parents: string[] = []): ICommit {
  return {
    hash,
    shortHash: hash.substring(0, 7),
    message: hash,
    author: { name: 'a', email: 'a@a' },
    committer: { name: 'a', email: 'a@a' },
    parents,
    authorDate: new Date('2024-01-01T00:00:00Z'),
    commitDate: new Date('2024-01-01T00:00:00Z'),
  };
}

interface SnapshotRow {
  hash: string;
  graphColumn: number;
  parents: string[];
  graphLines: Array<{ fromColumn: number; toColumn: number; type: 'commit' | 'merge' | 'branch' }>;
}

function snapshotOf(nodes: ICommitNode[]): SnapshotRow[] {
  return nodes.map((n) => ({
    hash: n.commit.hash,
    graphColumn: n.graphColumn,
    parents: [...n.commit.parents],
    graphLines: n.graphLines.map((line) => ({
      fromColumn: line.fromColumn,
      toColumn: line.toColumn,
      type: line.type,
    })),
  }));
}

describe('Wave D / D4-snap — frozen visual snapshots for generateCommitGraph', () => {
  // ─── snap-1: linear baseline ──────────────────────────────────────────
  it('snap-1: single-branch linear (must NOT regress to multi-lane)', () => {
    const commits = [
      mkCommit('c5', ['c4']),
      mkCommit('c4', ['c3']),
      mkCommit('c3', ['c2']),
      mkCommit('c2', ['c1']),
      mkCommit('c1'),
    ];
    const result = generateCommitGraph(commits);
    const expected: SnapshotRow[] = [
      {
        hash: 'c5',
        graphColumn: 0,
        parents: ['c4'],
        graphLines: [{ fromColumn: 0, toColumn: 0, type: 'commit' }],
      },
      {
        hash: 'c4',
        graphColumn: 0,
        parents: ['c3'],
        graphLines: [{ fromColumn: 0, toColumn: 0, type: 'commit' }],
      },
      {
        hash: 'c3',
        graphColumn: 0,
        parents: ['c2'],
        graphLines: [{ fromColumn: 0, toColumn: 0, type: 'commit' }],
      },
      {
        hash: 'c2',
        graphColumn: 0,
        parents: ['c1'],
        graphLines: [{ fromColumn: 0, toColumn: 0, type: 'commit' }],
      },
      { hash: 'c1', graphColumn: 0, parents: [], graphLines: [] },
    ];
    assert.deepStrictEqual(snapshotOf(result), expected);
  });

  // ─── snap-2: divergent two-children-of-unseen-parent (Gap 1 repro) ────
  it('snap-2: two divergent branches with shared ancestor (PINS lane separation)', () => {
    const commits = [mkCommit('tipA', ['base']), mkCommit('tipB', ['base']), mkCommit('base')];
    const result = generateCommitGraph(commits);
    const expected: SnapshotRow[] = [
      {
        hash: 'tipA',
        graphColumn: 0,
        parents: ['base'],
        graphLines: [{ fromColumn: 0, toColumn: 0, type: 'commit' }],
      },
      {
        hash: 'tipB',
        // Gap 1 GUARD — tipB MUST NOT collapse onto lane 0. The
        // pre-Wave-D single-pass algorithm produced graphColumn: 0 here.
        graphColumn: 1,
        parents: ['base'],
        graphLines: [{ fromColumn: 1, toColumn: 0, type: 'commit' }],
      },
      { hash: 'base', graphColumn: 0, parents: [], graphLines: [] },
    ];
    assert.deepStrictEqual(snapshotOf(result), expected);
  });

  // ─── snap-3: three branches (2 local + 1 remote-tracking) ─────────────
  it('snap-3: three divergent branches all root in distinct lanes', () => {
    const commits = [
      mkCommit('local1', ['base']),
      mkCommit('local2', ['base']),
      mkCommit('originMain', ['base']),
      mkCommit('base'),
    ];
    const result = generateCommitGraph(commits);
    const expected: SnapshotRow[] = [
      {
        hash: 'local1',
        graphColumn: 0,
        parents: ['base'],
        graphLines: [{ fromColumn: 0, toColumn: 0, type: 'commit' }],
      },
      {
        hash: 'local2',
        graphColumn: 1,
        parents: ['base'],
        graphLines: [{ fromColumn: 1, toColumn: 0, type: 'commit' }],
      },
      {
        hash: 'originMain',
        graphColumn: 2,
        parents: ['base'],
        graphLines: [{ fromColumn: 2, toColumn: 0, type: 'commit' }],
      },
      { hash: 'base', graphColumn: 0, parents: [], graphLines: [] },
    ];
    assert.deepStrictEqual(snapshotOf(result), expected);
  });

  // ─── snap-4: merge with branches at both parents ──────────────────────
  it('snap-4: merge commit with both parents in distinct lanes', () => {
    const commits = [
      mkCommit('merge', ['main2', 'feat']),
      mkCommit('feat', ['base']),
      mkCommit('main2', ['base']),
      mkCommit('base'),
    ];
    const result = generateCommitGraph(commits);
    const expected: SnapshotRow[] = [
      {
        hash: 'merge',
        graphColumn: 0,
        parents: ['main2', 'feat'],
        graphLines: [
          // First parent (main2) — inherits merge's lane.
          { fromColumn: 0, toColumn: 0, type: 'commit' },
          // Second parent (feat) — must claim a NEW lane.
          { fromColumn: 0, toColumn: 1, type: 'merge' },
        ],
      },
      {
        hash: 'feat',
        graphColumn: 1,
        parents: ['base'],
        graphLines: [{ fromColumn: 1, toColumn: 1, type: 'commit' }],
      },
      {
        hash: 'main2',
        graphColumn: 0,
        parents: ['base'],
        graphLines: [{ fromColumn: 0, toColumn: 1, type: 'commit' }],
      },
      { hash: 'base', graphColumn: 1, parents: [], graphLines: [] },
    ];
    assert.deepStrictEqual(snapshotOf(result), expected);
  });

  // ─── snap-5: focus state (chip + on-path tagging) ─────────────────────
  it('snap-5: focused branch path tagging applied to nodes', () => {
    const commits = [
      mkCommit('aaa', ['bbb']),
      mkCommit('bbb', ['ccc']),
      mkCommit('ccc', ['ddd']),
      mkCommit('ddd'),
    ];
    const branchMap = new Map<string, string[]>();
    branchMap.set('aaa', ['feature']);
    const focusedPath = new Set(['aaa', 'bbb', 'ccc']);
    const result = generateCommitGraph(commits, branchMap, undefined, focusedPath);

    // Snapshot the lane shape PLUS the onFocusedBranchPath flag.
    const focusSnapshot = result.map((n) => ({
      hash: n.commit.hash,
      graphColumn: n.graphColumn,
      branches: n.branches,
      onFocusedBranchPath: n.onFocusedBranchPath,
    }));
    const expected = [
      { hash: 'aaa', graphColumn: 0, branches: ['feature'], onFocusedBranchPath: true },
      { hash: 'bbb', graphColumn: 0, branches: [], onFocusedBranchPath: true },
      { hash: 'ccc', graphColumn: 0, branches: [], onFocusedBranchPath: true },
      { hash: 'ddd', graphColumn: 0, branches: [], onFocusedBranchPath: false },
    ];
    assert.deepStrictEqual(focusSnapshot, expected);
  });
});

/**
 * Wave D R1 / Tech-lead TLD-L-1+L-2 — renderer-stage snapshots.
 *
 * snap-1..5 above pin algorithm output (lane assignments + onFocusedBranchPath
 * flags). snap-6 closes the multi-stage discipline gap by pinning the
 * RENDERED SVG markup `renderGraphSvg` emits, so a refactor that changes
 * how the brighten/dim treatment lands (per-element opacity vs CSS class
 * vs anything else) shows up as a deliberate snapshot diff.
 */
describe('Wave D R1 / D4-snap — renderer-stage SVG snapshots', () => {
  function nodeOf(hash: string, onFocusedBranchPath: boolean): ICommitNode {
    return {
      commit: mkCommit(hash, ['parent']),
      graphColumn: 0,
      graphLines: [{ fromColumn: 0, toColumn: 0, color: '#4CAF50', type: 'commit' }],
      branches: [],
      tags: [],
      onFocusedBranchPath,
    };
  }

  it('snap-6a: hasFocusedBranch=false → NO opacity attribute on any element', () => {
    const node = nodeOf('aaa', false);
    const svg = renderGraphSvg(
      node,
      0,
      new Set([0]),
      DEFAULT_GRAPH_CONFIG,
      false /* isTerminal */,
      false /* isBranchSplitPoint */,
      new Set() /* childLanes */,
      false /* hasFocusedBranch */
    );
    assert.ok(
      !/\bopacity=/.test(svg),
      `expected NO opacity= attribute when hasFocusedBranch=false; got: ${svg}`
    );
  });

  it('snap-6b: hasFocusedBranch=true + on-path → opacity="1" + 1.5× lineWidth', () => {
    const node = nodeOf('aaa', true);
    const svg = renderGraphSvg(
      node,
      0,
      new Set([0]),
      DEFAULT_GRAPH_CONFIG,
      false,
      false,
      new Set(),
      true /* hasFocusedBranch */
    );
    // baseline lineWidth = 2 → on-path = 2 × 1.5 = 3
    assert.ok(svg.includes('opacity="1"'), `on-path must brighten to opacity="1"; got: ${svg}`);
    assert.ok(
      svg.includes('stroke-width="3"'),
      `on-path must boost stroke-width to 3 (1.5× of 2); got: ${svg}`
    );
  });

  it('snap-6c: hasFocusedBranch=true + off-path → opacity="0.6" + baseline stroke', () => {
    const node = nodeOf('aaa', false);
    const svg = renderGraphSvg(
      node,
      0,
      new Set([0]),
      DEFAULT_GRAPH_CONFIG,
      false,
      false,
      new Set(),
      true /* hasFocusedBranch */
    );
    assert.ok(svg.includes('opacity="0.6"'), `off-path must dim to opacity="0.6"; got: ${svg}`);
    assert.ok(
      svg.includes('stroke-width="2"'),
      `off-path keeps baseline stroke-width="2"; got: ${svg}`
    );
    // And it must NOT have the boosted stroke.
    assert.ok(
      !svg.includes('stroke-width="3"'),
      `off-path must not boost stroke-width; got: ${svg}`
    );
  });
});
