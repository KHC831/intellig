// Ported from intellij-community platform/util/testSrc/com/intellij/util/diff/IntLCSTest.java
// and IntLCSNewTest.java. Copyright 2000-2020 JetBrains s.r.o. Apache 2.0 license.

import '../../setup';
import * as assert from 'assert';
import { BitSet } from '../../../src/diff-engine/diff/BitSet';
import { Change, ChangeBuilder } from '../../../src/diff-engine/diff/Diff';
import { MyersLCS } from '../../../src/diff-engine/diff/MyersLCS';
import { Reindexer } from '../../../src/diff-engine/diff/Reindexer';

export function checkChange(
  change: Change | undefined,
  line0: number,
  line1: number,
  inserted: number,
  deleted: number
): asserts change is Change {
  assert.ok(change, 'Expected not null change');
  const message = change.toString();
  assert.strictEqual(change.line0, line0, `${message} line0:`);
  assert.strictEqual(change.line1, line1, `${message} line1:`);
  assert.strictEqual(change.inserted, inserted, `${message} insert:`);
  assert.strictEqual(change.deleted, deleted, `${message} delete:`);
}

export function checkLastChange(
  change: Change | undefined,
  line0: number,
  line1: number,
  inserted: number,
  deleted: number
): void {
  checkChange(change, line0, line1, inserted, deleted);
  assert.strictEqual(change.link, undefined, 'Expected last change');
}

function countChanges(first: number[], second: number[]): number {
  const lcs = new MyersLCS(first, second);
  lcs.execute();
  const changes = lcs.changes;
  return changes[0].cardinality() + changes[1].cardinality();
}

function buildChange(
  first: number[],
  second: number[],
  expectedNonDiags: number
): Change | undefined {
  assert.strictEqual(countChanges(first, second), expectedNonDiags);
  const intLCS = new MyersLCS(first, second);
  intLCS.execute();
  const reindexer = new Reindexer();
  reindexer.idInit(first.length, second.length);
  const builder = new ChangeBuilder(0);
  reindexer.reindex(intLCS.changes, builder);
  return builder.firstChange;
}

describe('diff-engine MyersLCS (IntLCSTest)', () => {
  it('diag', () => {
    assert.strictEqual(buildChange([1, 2, 3], [1, 2, 3], 0), undefined);
  });

  it('one at beginning', () => {
    checkLastChange(buildChange([1, 2], [1, 3], 2), 1, 1, 1, 1);
  });

  it('one at end', () => {
    checkLastChange(buildChange([1, 3], [2, 3], 2), 0, 0, 1, 1);
  });

  it('one over at end', () => {
    checkLastChange(buildChange([1, 2], [1, 2, 3], 1), 2, 2, 1, 0);
  });

  it('one over at beginning', () => {
    checkLastChange(buildChange([1, 2, 3], [2, 3], 1), 0, 0, 0, 1);
  });

  it('one tail', () => {
    assert.strictEqual(countChanges([1, 2], [1, 2, 3]), 1);
  });

  it('single middle', () => {
    const change = buildChange([1, 2, 3], [4, 2, 5], 4);
    checkChange(change, 0, 0, 1, 1);
    checkLastChange(change.link, 2, 2, 1, 1);
  });

  it('absolutely different', () => {
    assert.strictEqual(countChanges([1, 2], [3, 4]), 4);
    assert.strictEqual(countChanges([1, 2, 3], [4, 5, 6]), 6);
  });
});

function buildBitSetChange(first: number[], second: number[]): [BitSet, BitSet] {
  const myersLCS = new MyersLCS(first, second);
  myersLCS.execute();
  return myersLCS.changes;
}

function checkBitSetChange(
  change: readonly [BitSet, BitSet],
  expected1: number[],
  expected2: number[]
): void {
  for (let i = 0; i < expected1.length; i++) {
    assert.strictEqual(change[0].get(i), expected1[i] === 1, `side 1 bit ${i}`);
  }
  for (let i = 0; i < expected2.length; i++) {
    assert.strictEqual(change[1].get(i), expected2[i] === 1, `side 2 bit ${i}`);
  }
}

describe('diff-engine MyersLCS changed-bits (IntLCSNewTest)', () => {
  it('equal', () => {
    checkBitSetChange(buildBitSetChange([1, 2, 3], [1, 2, 3]), [0, 0, 0], [0, 0, 0]);
  });

  it('one at beginning', () => {
    checkBitSetChange(buildBitSetChange([1, 2], [1, 3]), [0, 1], [0, 1]);
  });

  it('one at end', () => {
    checkBitSetChange(buildBitSetChange([1, 3], [2, 3]), [1, 0], [1, 0]);
  });

  it('one over at end', () => {
    checkBitSetChange(buildBitSetChange([1, 2], [1, 2, 3]), [0, 0], [0, 0, 1]);
  });

  it('one over at beginning', () => {
    checkBitSetChange(buildBitSetChange([1, 2, 3], [2, 3]), [1, 0, 0], [0, 0]);
  });

  it('single middle', () => {
    checkBitSetChange(buildBitSetChange([1, 2, 3], [4, 2, 5]), [1, 0, 1], [1, 0, 1]);
  });

  it('absolutely different', () => {
    checkBitSetChange(buildBitSetChange([1, 2], [3, 4]), [1, 1], [1, 1]);
    checkBitSetChange(buildBitSetChange([1, 2, 3], [4, 5, 6]), [1, 1, 1], [1, 1, 1]);
  });

  it('single unique moved', () => {
    checkBitSetChange(
      buildBitSetChange([1, 1, 2, 2, 10], [10, 1, 1, 2, 2]),
      [0, 0, 0, 0, 1],
      [1, 0, 0, 0, 0]
    );
  });

  it('single function moved', () => {
    checkBitSetChange(
      buildBitSetChange(
        [1, 2, 3, 4, 5, 6, 7, 8, 7, 9, 10, 2, 11, 12, 5, 13, 7, 8, 7],
        [10, 2, 11, 12, 5, 13, 7, 8, 7, 9, 1, 2, 3, 4, 5, 6, 7, 8, 7]
      ),
      [1, 0, 1, 1, 0, 1, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1],
      [1, 0, 1, 1, 0, 1, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1]
    );
  });
});
