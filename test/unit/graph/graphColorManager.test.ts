/**
 * Port of IntelliJ's color-by-head behavior —
 * `GraphColorManagerImpl` + `GraphColorGetterByHead` (platform/vcs-log).
 *
 * IntelliJ has no standalone `GraphColorManagerImplTest`; the rule is exercised
 * through the print pipeline. This test pins the ported rule directly:
 *   - a node ON its head's main fragment (headFragmentIndex == fragmentIndex)
 *     takes the head ref name's `hashCode()` color;
 *   - a node on any other fragment takes the fragment (layout) index as color;
 *   - `javaStringHashCode` matches `java.lang.String.hashCode()` exactly.
 */

import '../../setup';
import * as assert from 'assert';
import {
  DEFAULT_COLOR,
  getColor,
  getNodeColor,
  javaStringHashCode,
} from '../../../src/git-core/graph/graphColorManager';
import {
  buildGraphLayout,
  linearGraphFromDownAdjacency,
} from '../../../src/git-core/graph/graphLayout';

function order(...list: number[]): (a: number, b: number) => number {
  return (i, j) => list.indexOf(i) - list.indexOf(j);
}

describe('graphColorManager — javaStringHashCode (matches java.lang.String.hashCode)', () => {
  it('reproduces known JDK hashCode values', () => {
    // Reference values from java.lang.String.hashCode().
    assert.strictEqual(javaStringHashCode(''), 0);
    assert.strictEqual(javaStringHashCode('a'), 97);
    assert.strictEqual(javaStringHashCode('main'), 3343801);
    assert.strictEqual(javaStringHashCode('master'), -1081267614);
    assert.strictEqual(javaStringHashCode('origin/main'), javaStringHashCode('origin/main'));
  });
});

describe('graphColorManager — getColor (ported from GraphColorManagerImpl.getColor)', () => {
  it('uses the head ref name hash on the head fragment', () => {
    assert.strictEqual(getColor('main', 1, 1), javaStringHashCode('main'));
  });

  it('uses the fragment index off the head fragment', () => {
    assert.strictEqual(getColor('main', 1, 5), 5);
  });

  it('falls back to DEFAULT_COLOR when the head has no ref', () => {
    assert.strictEqual(getColor(undefined, 2, 2), DEFAULT_COLOR);
  });
});

describe('graphColorManager — getNodeColor (ported from GraphColorGetterByHead)', () => {
  // Linear graph 0->1->2->3 with branch heads {0,2}; refs: head 0 = "main",
  // head 2 = "feature".
  const g = linearGraphFromDownAdjacency([[1], [2], [3], []]);
  const refNameForHead = (h: number): string | undefined =>
    h === 0 ? 'main' : h === 2 ? 'feature' : undefined;

  it('topmost head owns the whole overlapping line — one branch color', () => {
    const layout = buildGraphLayout(g, new Set([0, 2]), order(0, 2));
    const colors = [0, 1, 2, 3].map((n) =>
      getNodeColor(layout, refNameForHead, n, layout.getLayoutIndex(n))
    );
    assert.deepStrictEqual(colors, Array(4).fill(javaStringHashCode('main')));
  });

  it('lower head first splits the line into two branch colors', () => {
    const layout = buildGraphLayout(g, new Set([0, 2]), order(2, 0));
    const colors = [0, 1, 2, 3].map((n) =>
      getNodeColor(layout, refNameForHead, n, layout.getLayoutIndex(n))
    );
    assert.deepStrictEqual(colors, [
      javaStringHashCode('main'),
      javaStringHashCode('main'),
      javaStringHashCode('feature'),
      javaStringHashCode('feature'),
    ]);
  });
});
