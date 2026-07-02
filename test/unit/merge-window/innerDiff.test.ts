// Ported expectations from intellij-community platform/diff-impl
// DiffUtil.compareThreesideInner — the per-change word-level highlights the
// merge window paints inside changed blocks.

import '../../setup';
import * as assert from 'assert';
import { ComparisonPolicy } from '../../../src/diff-engine/comparison/ComparisonPolicy';
import { compareThreesideInner } from '../../../src/conflicts/merge-window/innerDiff';

describe('merge window inner word diffs (compareThreesideInner)', () => {
  it('returns null when all chunks are absent', () => {
    assert.strictEqual(compareThreesideInner([null, null, null], ComparisonPolicy.DEFAULT), null);
  });

  it('returns null when only one chunk is present', () => {
    assert.strictEqual(compareThreesideInner(['x', null, null], ComparisonPolicy.DEFAULT), null);
    assert.strictEqual(compareThreesideInner([null, 'x', null], ComparisonPolicy.DEFAULT), null);
    assert.strictEqual(compareThreesideInner([null, null, 'x'], ComparisonPolicy.DEFAULT), null);
  });

  it('marks the differing words in all three sides of a conflict', () => {
    const result = compareThreesideInner(
      ['version: 2.0.0', 'version: 1.0.0', 'version: 1.0.4'],
      ComparisonPolicy.DEFAULT
    );
    assert.ok(result);
    // base→left changed "1"→"2" at [9,10); base→right changed the last "0"→"4".
    assert.deepStrictEqual(result.left, [{ start: 9, end: 10 }]);
    assert.deepStrictEqual(result.base, [
      { start: 9, end: 10 },
      { start: 13, end: 14 },
    ]);
    assert.deepStrictEqual(result.right, [{ start: 13, end: 14 }]);
  });

  it('compares the two present chunks when one side is absent', () => {
    // Deletion on the right: left and base present.
    const result = compareThreesideInner(['a X c', 'a Y c', null], ComparisonPolicy.DEFAULT);
    assert.ok(result);
    assert.deepStrictEqual(result.left, [{ start: 2, end: 3 }]);
    assert.deepStrictEqual(result.base, [{ start: 2, end: 3 }]);
    assert.strictEqual(result.right, null);
  });

  it('returns empty ranges for whitespace-only changes under IGNORE_WHITESPACES', () => {
    const result = compareThreesideInner(
      ['a  b', 'a b', 'a   b'],
      ComparisonPolicy.IGNORE_WHITESPACES
    );
    assert.ok(result);
    assert.deepStrictEqual(result.left, []);
    assert.deepStrictEqual(result.base, []);
    assert.deepStrictEqual(result.right, []);
  });
});
