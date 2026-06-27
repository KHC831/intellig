/**
 * Edge-IDENTITY pins for the print model — the refactor's whole thesis. The
 * byte-equivalence oracle can't validate `edge.parent` because the painter reads
 * none of it, so these hand-built topologies validate the off-window vs in-window
 * classification directly (esp. the reviewer's worry: an in-window side branch
 * whose tip is the bottom row must NOT be misclassified off-window).
 */

import '../../setup';
import * as assert from 'assert';
import {
  generateCommitGraph,
  computeIncomingBendsMap,
  computeTerminalNodes,
  computeChildCountMap,
  isBranchSplit,
  type ICommitNode,
} from '../../../src/git-core/commitGraph';
import {
  buildGraphPrintModel,
  projectRow,
  IRowEdgeElement,
  type IRowProjectionContext,
} from '../../../src/git-core/graph/printModel';
import {
  computeActiveLanes,
  computeLaneContinuesFromAbove,
  computeLaneContinuesBelow,
  collectMergedLaneIntervals,
} from '../../../src/utils/graphRenderer';
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

function allEdges(commits: ICommit[]): IRowEdgeElement[] {
  return buildGraphPrintModel(generateCommitGraph(commits)).flatMap((m) => m.edges);
}

describe('print model — edge identity (off-window vs in-window)', () => {
  it('a fully in-window linear chain tags every edge in-window (no over-tagging)', () => {
    const edges = allEdges([c('n0', ['n1']), c('n1', ['n2']), c('n2', [])]);
    assert.ok(edges.length > 0, 'expected some edges');
    for (const e of edges) {
      assert.strictEqual(
        e.edge.parent.kind,
        'inWindow',
        `lane ${e.lane} edge must be in-window, got ${e.edge.parent.kind}`
      );
    }
  });

  it('an off-window trunk (merge with off-window first parent) tags its lane off-window', () => {
    // n0 merges an off-window first parent with an in-window second parent; its
    // own lane is reserved as the "history continues below the slice" trunk.
    const edges = allEdges([c('n0', ['off_x', 'n1']), c('n1', ['n2']), c('n2', [])]);
    const offWindow = edges.filter((e) => e.edge.parent.kind === 'offWindow');
    assert.ok(
      offWindow.length > 0,
      'expected at least one edge tagged off-window for the reserved trunk'
    );
  });

  it('an in-window side branch whose tip is the BOTTOM row is NOT misclassified off-window', () => {
    // n0 merges n1 (lane 0, row 1) and n2 (side branch, lane 1, BOTTOM row 2).
    // The side lane reaches the last row but the bottom node SITS on it → must be
    // in-window. This is the heuristic's failure mode the reviewer flagged.
    const edges = allEdges([c('n0', ['n1', 'n2']), c('n1', []), c('n2', [])]);
    const offWindow = edges.filter((e) => e.edge.parent.kind === 'offWindow');
    assert.deepStrictEqual(
      offWindow.map((e) => `lane ${e.lane}`),
      [],
      'a side branch ending on the bottom row must not be tagged off-window'
    );
  });
});

describe('print model — projectRow hashToRow seam (threaded vs derived)', () => {
  // Build a projectRow context for one row using the same exported helpers
  // buildGraphPrintModel uses, so projectRow can be exercised in isolation.
  function ctxFor(
    nodes: ICommitNode[],
    row: number,
    hashToRow: ReadonlyMap<string, number> | undefined
  ): IRowProjectionContext {
    const merged = collectMergedLaneIntervals(nodes);
    const intervalByLane = new Map<number, { startRow: number; endRow: number }>();
    for (const [lane, ivs] of merged) {
      for (const iv of ivs) {
        if (row >= iv.startRow && row <= iv.endRow) {
          intervalByLane.set(lane, iv);
        }
      }
    }
    return {
      activeLanes: computeActiveLanes(nodes, merged).get(row) ?? new Set<number>(),
      continuesFromAbove:
        computeLaneContinuesFromAbove(nodes, merged).get(row) ?? new Set<number>(),
      continuesBelow: computeLaneContinuesBelow(nodes, merged).get(row) ?? new Set<number>(),
      incomingBendLanes: computeIncomingBendsMap(nodes).get(nodes[row].commit.hash) ?? new Set(),
      bendsLandingBelow: new Set<number>(),
      isTerminal: computeTerminalNodes(nodes).has(nodes[row].commit.hash),
      isBranchSplit: isBranchSplit(nodes[row].commit.hash, computeChildCountMap(nodes)),
      isLastRow: row === nodes.length - 1,
      hasFocusedBranch: false,
      nodes,
      hashToRow,
      intervalByLane,
    };
  }

  it('a merge row projects identical edges whether hashToRow is threaded in or derived locally', () => {
    // Merge with a second-parent bezier on a different lane → projectRow calls
    // findParentRow, which uses hashToRow. The threaded map and the
    // `?? buildHashToRow` fallback must yield the same row.
    const nodes = generateCommitGraph([
      c('m', ['a', 'b']),
      c('a', ['base']),
      c('b', ['base']),
      c('base', []),
    ]);
    const mergeRow = 0;
    const prebuilt = new Map(nodes.map((n, i) => [n.commit.hash, i]));

    const threaded = projectRow(nodes[mergeRow], mergeRow, ctxFor(nodes, mergeRow, prebuilt));
    const derived = projectRow(nodes[mergeRow], mergeRow, ctxFor(nodes, mergeRow, undefined));

    assert.deepStrictEqual(
      derived.edges,
      threaded.edges,
      'fallback-derived hashToRow must project the same edges as the threaded map'
    );
  });
});
