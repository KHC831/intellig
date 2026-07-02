// Pins the Kotlin-null → TS-undefined edge in MergeConflictType: an
// unresolvable conflict must NOT report canBeResolved() just because an
// explicit `undefined` strategy fell through to a default parameter.
// (Upstream MergeRangeUtil.getMergeType passes null for unresolvable
// conflicts; the port must preserve that as "no strategy".)

import '../../setup';
import * as assert from 'assert';
import { mergeLines } from '../../../src/diff-engine/comparison/ComparisonManager';
import { EMPTY_CANCELLATION_CHECKER } from '../../../src/diff-engine/comparison/CancellationChecker';
import { ComparisonPolicy } from '../../../src/diff-engine/comparison/ComparisonPolicy';
import { LineOffsetsImpl } from '../../../src/diff-engine/text/LineOffsets';
import { MergeConflictResolutionStrategy } from '../../../src/diff-engine/util/MergeConflictResolutionStrategy';
import {
  MergeConflictType,
  MergeConflictTypeKind,
} from '../../../src/diff-engine/util/MergeConflictType';
import { getLineMergeType } from '../../../src/diff-engine/util/MergeRangeUtil';

function lineMergeTypes(left: string, base: string, right: string): MergeConflictType[] {
  const sequences = [left, base, right];
  const lineOffsets = sequences.map((s) => LineOffsetsImpl.create(s));
  const fragments = mergeLines(
    left,
    base,
    right,
    ComparisonPolicy.DEFAULT,
    EMPTY_CANCELLATION_CHECKER
  );
  return fragments.map((f) =>
    getLineMergeType(f, sequences, lineOffsets, ComparisonPolicy.DEFAULT)
  );
}

describe('diff-engine conflict resolvability (Kotlin null strategy)', () => {
  it('an unresolvable conflict has no resolution strategy', () => {
    // Both sides changed the same word differently — magic resolve fails.
    const types = lineMergeTypes('india yours', 'india original', 'india theirs');
    assert.strictEqual(types.length, 1);
    assert.strictEqual(types[0].type, MergeConflictTypeKind.CONFLICT);
    assert.strictEqual(types[0].resolutionStrategy, undefined);
    assert.strictEqual(types[0].canBeResolved(), false);
  });

  it('a delete-vs-modify conflict has no resolution strategy', () => {
    const types = lineMergeTypes(
      '',
      'kilo one\nkilo two\nkilo three',
      'kilo one\nkilo CHANGED\nkilo three'
    );
    assert.strictEqual(types.length, 1);
    assert.strictEqual(types[0].type, MergeConflictTypeKind.CONFLICT);
    assert.strictEqual(types[0].canBeResolved(), false);
  });

  it('a magic-resolvable conflict gets the TEXT strategy', () => {
    // IDEA-200696: non-overlapping word edits on the same line.
    const types = lineMergeTypes('version: 2.0.0', 'version: 1.0.0', 'version: 1.0.4');
    assert.strictEqual(types.length, 1);
    assert.strictEqual(types[0].type, MergeConflictTypeKind.CONFLICT);
    assert.strictEqual(types[0].resolutionStrategy, MergeConflictResolutionStrategy.TEXT);
    assert.strictEqual(types[0].canBeResolved(), true);
  });

  it('non-conflicting changes keep the DEFAULT strategy', () => {
    const types = lineMergeTypes('alpha CHANGED', 'alpha', 'alpha');
    assert.strictEqual(types.length, 1);
    assert.strictEqual(types[0].type, MergeConflictTypeKind.MODIFIED);
    assert.strictEqual(types[0].resolutionStrategy, MergeConflictResolutionStrategy.DEFAULT);
    assert.strictEqual(types[0].canBeResolved(), true);
  });
});
