/**
 * Verbatim port of IntelliJ's
 * `platform/vcs-log/graph/test/.../permanent/GraphLayoutBuilderHeadOrderTest.kt`.
 *
 * Validates the head-OWNERSHIP mapping `GraphLayout.getOneOfHeadNodeIndex` —
 * for each commit, which head owns it — under different head orderings. This is
 * the exact rule that drives per-branch coloring, so a green run here proves the
 * ownership engine (src/git-core/graph/graphLayout.ts) matches IntelliJ
 * bit-for-bit. The graphs, head sets, comparators and expected results below are
 * copied unchanged from the upstream test.
 */

import '../../setup';
import * as assert from 'assert';
import {
  buildGraphLayout,
  linearGraphFromDownAdjacency,
  type ILinearGraph,
} from '../../../src/git-core/graph/graphLayout';

/**
 * Mirror of the upstream `graph { 0(1); 1(2); … }` DSL: `downAdjacency[i]` is
 * the list of down-nodes (parents) of node `i`.
 */
function graph(downAdjacency: number[][]): ILinearGraph {
  return linearGraphFromDownAdjacency(downAdjacency);
}

/** Port of the test's `order(vararg list)` comparator. */
function order(...list: number[]): (a: number, b: number) => number {
  return (i, j) => list.indexOf(i) - list.indexOf(j);
}

/** Port of `getHeadNodeIndices`: for each commit, its owning head node. */
function headNodeIndices(
  graphInput: ILinearGraph,
  branchHeads: Set<number>,
  comparator: (a: number, b: number) => number
): number[] {
  const layout = buildGraphLayout(graphInput, branchHeads, comparator);
  const result: number[] = [];
  for (let i = 0; i < graphInput.nodesCount(); i++) {
    result.push(layout.getOneOfHeadNodeIndex(i));
  }
  return result;
}

function assertHeadsForCommits(
  graphInput: ILinearGraph,
  branchHeads: Set<number>,
  comparator: (a: number, b: number) => number,
  expectedHeads: number[]
): void {
  assert.deepStrictEqual(headNodeIndices(graphInput, branchHeads, comparator), expectedHeads);
}

describe('GraphLayoutBuilder — head order (ported from GraphLayoutBuilderHeadOrderTest)', () => {
  it('linearGraph', () => {
    // 0(1) 1(2) 2(3) 3()
    const g = graph([[1], [2], [3], []]);
    assertHeadsForCommits(g, new Set([0, 2]), order(0, 2), [0, 0, 0, 0]);
    assertHeadsForCommits(g, new Set([0, 2]), order(2, 0), [0, 0, 2, 2]);
  });

  it('branchingGraph', () => {
    // 0(2) 1(3) 2(3) 3(4) 4()
    const g = graph([[2], [3], [3], [4], []]);
    assertHeadsForCommits(g, new Set([0, 2]), order(0, 1, 2), [0, 1, 0, 0, 0]);
    assertHeadsForCommits(g, new Set([0, 2]), order(0, 2, 1), [0, 1, 0, 0, 0]);
    assertHeadsForCommits(g, new Set([0, 2]), order(1, 0, 2), [0, 1, 0, 1, 1]);
    assertHeadsForCommits(g, new Set([0, 2]), order(1, 2, 0), [0, 1, 2, 1, 1]);
    assertHeadsForCommits(g, new Set([0, 2]), order(2, 0, 1), [0, 1, 2, 2, 2]);
    assertHeadsForCommits(g, new Set([0, 2]), order(2, 1, 0), [0, 1, 2, 2, 2]);
  });
});
