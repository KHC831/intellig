// Ported from intellij-community platform/util/testSrc/com/intellij/util/diff/ReindexerNewTest.java
// (verifyLCS from IntLCSAutoTest.java). Copyright 2000-2014 JetBrains s.r.o. Apache 2.0 license.

import '../../setup';
import * as assert from 'assert';
import { BitSet } from '../../../src/diff-engine/diff/BitSet';
import { ILCSBuilder } from '../../../src/diff-engine/diff/LCSBuilder';
import { MyersLCS } from '../../../src/diff-engine/diff/MyersLCS';
import { Reindexer } from '../../../src/diff-engine/diff/Reindexer';

/** The unchanged elements paired up by the change sets must be truly equal, and nothing may be left over. */
function verifyLCS(
  sequence1: number[],
  sequence2: number[],
  changes1: BitSet,
  changes2: BitSet
): void {
  const count1 = sequence1.length;
  const count2 = sequence2.length;
  let index1 = changes1.nextClearBit(0);
  let index2 = changes2.nextClearBit(0);

  while (index1 < count1 || index2 < count2) {
    assert.ok(index1 < count1, 'side 1 ran out of unchanged elements before side 2');
    assert.ok(index2 < count2, 'side 2 ran out of unchanged elements before side 1');

    assert.strictEqual(
      sequence1[index1],
      sequence2[index2],
      `unchanged pair at ${index1}/${index2} differs`
    );

    index1 = changes1.nextClearBit(index1 + 1);
    index2 = changes2.nextClearBit(index2 + 1);
  }
  assert.ok(index1 >= count1 && index2 >= count2);
}

function checkCase(ints1: number[], ints2: number[], message: string = ''): void {
  const reindexChanges: [BitSet, BitSet] = [new BitSet(), new BitSet()];
  let index1 = 0;
  let index2 = 0;
  const builder: ILCSBuilder = {
    addEqual(length: number): void {
      index1 += length;
      index2 += length;
    },
    addChange(first: number, second: number): void {
      reindexChanges[0].setRange(index1, index1 + first, true);
      reindexChanges[1].setRange(index2, index2 + second, true);
      index1 += first;
      index2 += second;
    },
  };

  const reindexer = new Reindexer();
  const discarded = reindexer.discardUnique(ints1, ints2);
  const lcs = new MyersLCS(discarded[0], discarded[1]);
  lcs.execute();
  reindexer.reindex(lcs.changes, builder);

  try {
    verifyLCS(ints1, ints2, reindexChanges[0], reindexChanges[1]);
  } catch (e) {
    if (message) {
      throw new Error(`${message}\n${e instanceof Error ? e.message : String(e)}`);
    }
    throw e;
  }
}

describe('diff-engine Reindexer (ReindexerNewTest)', () => {
  it('all unique', () => {
    checkCase([1, 2, 3], [4, 5]);
    checkCase([], [4, 5]);
    checkCase([1, 2, 3], []);
  });

  it('unique beginning', () => {
    checkCase([13, 15, 1, 2, 3], [17, 1, 3]);
  });

  it('unique end', () => {
    checkCase([1, 2, 3, 13, 15], [1, 3, 17]);
  });

  it('single unique moved', () => {
    checkCase([1, 1, 2, 2, 10], [10, 1, 1, 2, 2]);
  });

  it('single function moved', () => {
    checkCase(
      [1, 2, 3, 4, 5, 6, 7, 8, 7, 9, 10, 2, 11, 12, 5, 13, 7, 8, 7],
      [10, 2, 11, 12, 5, 13, 7, 8, 7, 9, 1, 2, 3, 4, 5, 6, 7, 8, 7]
    );
  });

  it('inner chunks', () => {
    checkCase([0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0], [1, 2, 1, 3, 1, 4, 1, 5, 1, 6, 1, 7, 1]);
    checkCase([0, 2, 3, 0, 4, 5, 0], [1, 2, 1, 3, 4, 5, 1]);
    checkCase([15, 1, 2, 3, 1, 4, 5, 1, 15], [13, 1, 2, 1, 3, 4, 5, 1, 13]);
    checkCase(
      [15, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 15],
      [13, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 13]
    );
  });

  it('random examples', () => {
    for (let i = 0; i < 10; i++) {
      const ints1 = Array.from({ length: 100 }, () => Math.floor(Math.random() * 60));
      const ints2 = Array.from({ length: 100 }, () => Math.floor(Math.random() * 60));
      checkCase(ints1, ints2, `first: {${ints1.join(', ')}}\nsecond: {${ints2.join(', ')}}`);
    }
  });
});
