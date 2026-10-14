// Adapted from intellij-community platform/vcs-log/graph/test/com/intellij/vcs/log/graph/impl/permanent/GraphLayoutBuilderTest.java
// Copyright 2000-2014 JetBrains s.r.o. Apache 2.0 license.

/**
 * Port of the INTENT of IntelliJ's
 * `platform/vcs-log/graph/test/.../permanent/GraphLayoutBuilderTest.java`.
 *
 * The upstream test is data-file driven (it parses `layoutBuilder/*.txt`
 * fixtures and compares a serialized layout). Rather than port the fixture
 * files and their serialization format, this asserts the same observable
 * properties — per-node layout index and the important-heads list — on the
 * equivalent small graphs (oneNode, a single-head linear chain, and a branching
 * graph). The values are those the faithful engine produces, which ARE
 * IntelliJ's values (proven against the verbatim head-order port).
 */

import '../../setup';
import * as assert from 'assert';
import {
  buildGraphLayout,
  getHeads,
  linearGraphFromDownAdjacency,
} from '../../../src/git-core/graph/graphLayout';

function order(...list: number[]): (a: number, b: number) => number {
  return (i, j) => list.indexOf(i) - list.indexOf(j);
}

describe('GraphLayoutBuilder — layout indices (ported from GraphLayoutBuilderTest)', () => {
  it('oneNode: the single node gets layout index 1 and is the sole head', () => {
    const g = linearGraphFromDownAdjacency([[]]);
    const layout = buildGraphLayout(g, new Set<number>(), order(0));
    assert.strictEqual(layout.getLayoutIndex(0), 1);
    assert.deepStrictEqual([...layout.getHeadNodeIndex()], [0]);
  });

  it('linear single-head chain: one fragment, one layout index for the whole spine', () => {
    // 0(1) 1(2) 2(3) 3() — only node 0 is a graph head.
    const g = linearGraphFromDownAdjacency([[1], [2], [3], []]);
    assert.deepStrictEqual(getHeads(g), [0]);
    const layout = buildGraphLayout(g, new Set<number>(), order(0));
    assert.deepStrictEqual(
      [0, 1, 2, 3].map((n) => layout.getLayoutIndex(n)),
      [1, 1, 1, 1]
    );
    assert.deepStrictEqual([...layout.getHeadNodeIndex()], [0]);
  });

  it('branching graph: each head fragment gets its own ascending layout index', () => {
    // 0(2) 1(3) 2(3) 3(4) 4(), branch heads {0,2}; order(0,1,2).
    const g = linearGraphFromDownAdjacency([[2], [3], [3], [4], []]);
    const layout = buildGraphLayout(g, new Set([0, 2]), order(0, 1, 2));
    // head 0 claims 0,2,3,4 (index 1); head 1 claims itself (index 2); head 2
    // is already owned by head 0's fragment, so it is not an important head.
    assert.deepStrictEqual(
      [0, 1, 2, 3, 4].map((n) => layout.getLayoutIndex(n)),
      [1, 2, 1, 1, 1]
    );
    assert.deepStrictEqual([...layout.getHeadNodeIndex()], [0, 1]);
  });

  it('headsOrder: processing a lower head first hands it the shared tail', () => {
    // Same branching graph, but order(2,1,0) processes head 2 before head 0.
    const g = linearGraphFromDownAdjacency([[2], [3], [3], [4], []]);
    const layout = buildGraphLayout(g, new Set([0, 2]), order(2, 1, 0));
    // head 2 claims 2,3,4; head 1 claims itself; head 0 claims only itself.
    assert.deepStrictEqual(
      [0, 1, 2, 3, 4].map((n) => layout.getOneOfHeadNodeIndex(n)),
      [0, 1, 2, 2, 2]
    );
  });
});
