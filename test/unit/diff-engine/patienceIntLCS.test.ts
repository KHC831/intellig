// Ported from intellij-community platform/util/testSrc/com/intellij/util/diff/PatienceIntLCSTest.java
// Copyright 2000-2014 JetBrains s.r.o. Apache 2.0 license.

import '../../setup';
import * as assert from 'assert';
import { BitSet } from '../../../src/diff-engine/diff/BitSet';
import { FilesTooBigForDiffException } from '../../../src/diff-engine/diff/FilesTooBigForDiffException';
import { PatienceIntLCS } from '../../../src/diff-engine/diff/PatienceIntLCS';

function buildChange(first: number[], second: number[]): [BitSet, BitSet] {
  const patienceIntLCS = new PatienceIntLCS(first, second);
  patienceIntLCS.execute();
  return patienceIntLCS.changes;
}

function checkChange(
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

function checkAborted(shouldBeAborted: boolean, first: number[], second: number[]): void {
  const patienceIntLCS = new PatienceIntLCS(first, second);
  try {
    patienceIntLCS.execute(true);
    assert.strictEqual(shouldBeAborted, false, 'expected the LCS to abort');
  } catch (e) {
    if (!(e instanceof FilesTooBigForDiffException)) {
      throw e;
    }
    assert.strictEqual(shouldBeAborted, true, 'the LCS aborted unexpectedly');
  }
}

describe('diff-engine PatienceIntLCS (PatienceIntLCSTest)', () => {
  it('equal', () => {
    checkChange(buildChange([1, 2, 3], [1, 2, 3]), [0, 0, 0], [0, 0, 0]);
  });

  it('one at beginning', () => {
    checkChange(buildChange([1, 2], [1, 3]), [0, 1], [0, 1]);
  });

  it('one at end', () => {
    checkChange(buildChange([1, 3], [2, 3]), [1, 0], [1, 0]);
  });

  it('one over at end', () => {
    checkChange(buildChange([1, 2], [1, 2, 3]), [0, 0], [0, 0, 1]);
  });

  it('one over at beginning', () => {
    checkChange(buildChange([1, 2, 3], [2, 3]), [1, 0, 0], [0, 0]);
  });

  it('single middle', () => {
    checkChange(buildChange([1, 2, 3], [4, 2, 5]), [1, 0, 1], [1, 0, 1]);
  });

  it('absolutely different', () => {
    checkChange(buildChange([1, 2], [3, 4]), [1, 1], [1, 1]);
    checkChange(buildChange([1, 2, 3], [4, 5, 6]), [1, 1, 1], [1, 1, 1]);
  });

  it('single unique moved', () => {
    checkChange(buildChange([1, 1, 2, 2, 10], [10, 1, 1, 2, 2]), [1, 1, 1, 1, 0], [0, 1, 1, 1, 1]);
  });

  it('single function moved', () => {
    checkChange(
      buildChange(
        [1, 2, 3, 4, 5, 6, 7, 8, 7, 9, 10, 2, 11, 12, 5, 13, 7, 8, 7],
        [10, 2, 11, 12, 5, 13, 7, 8, 7, 9, 1, 2, 3, 4, 5, 6, 7, 8, 7]
      ),
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
    );
  });

  it('bug 1', () => {
    checkChange(
      buildChange(
        [2, 3, 4, 6, 7, 8, 9, 11, 12, 4, 6, 11, 15],
        [2, 3, 6, 7, 8, 9, 6, 11, 12, 4, 11, 15, 6]
      ),
      [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0]
    );
  });

  it('inner chunks 1', () => {
    checkChange(
      buildChange([0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0], [1, 2, 1, 3, 1, 4, 1, 5, 1, 6, 1, 7, 1]),
      [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1],
      [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1]
    );
  });

  it('inner chunks 2', () => {
    checkChange(
      buildChange([0, 2, 3, 0, 4, 5, 0], [1, 2, 1, 3, 4, 5, 1]),
      [1, 0, 0, 1, 0, 0, 1],
      [1, 0, 1, 0, 0, 0, 1]
    );
  });

  it('inner chunks 3', () => {
    checkChange(
      buildChange([15, 1, 2, 3, 1, 4, 5, 1, 15], [13, 1, 2, 1, 3, 4, 5, 1, 13]),
      [1, 0, 0, 0, 1, 0, 0, 0, 1],
      [1, 0, 0, 1, 0, 0, 0, 0, 1]
    );
  });

  it('inner chunks 4', () => {
    checkChange(
      buildChange(
        [15, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 15],
        [13, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 13]
      ),
      [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
      [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]
    );
  });

  it('not aborted: equal', () => {
    checkAborted(false, [1, 2, 3], [1, 2, 3]);
  });

  it('not aborted: simple', () => {
    checkAborted(false, [100, 1, 2, 3, 4, 5, 100], [1, 2, 3, 4]);
  });

  it('aborted: no matches', () => {
    checkAborted(true, [4, 1, 2, 3], [500, 100, 600]);
  });

  it('aborted: simple', () => {
    checkAborted(true, [4, 1, 2, 3, 100], [5, 1, 6, 8, 9, 10]);
  });

  it('not aborted: second step', () => {
    checkAborted(
      false,
      [100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 100],
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0]
    );
  });

  it('not aborted: third step', () => {
    checkAborted(
      false,
      [100, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 200, 1, 0, 100],
      [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 2]
    );
  });

  it('aborted: fourth step', () => {
    checkAborted(
      true,
      [100, 3, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 200, 1, 0, 100],
      [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 1, 0, 2]
    );
  });
});
