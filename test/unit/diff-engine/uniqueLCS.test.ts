// Ported from intellij-community platform/util/testSrc/com/intellij/util/diff/UniqueLCSTest.java
// Copyright 2000-2014 JetBrains s.r.o. Apache 2.0 license.

import '../../setup';
import * as assert from 'assert';
import { UniqueLCS } from '../../../src/diff-engine/diff/UniqueLCS';

function buildChange(first: number[], second: number[]): [number[], number[]] | undefined {
  return new UniqueLCS(first, second).execute();
}

function checkChange(
  change: [number[], number[]] | undefined,
  expected1: number[],
  expected2: number[]
): void {
  assert.ok(change);
  for (let i = 0; i < expected1.length; i++) {
    assert.strictEqual(change[0][i], expected1[i]);
  }
  for (let i = 0; i < expected2.length; i++) {
    assert.strictEqual(change[1][i], expected2[i]);
  }
}

function checkMaxSequence(sequence: number[], expected: number[]): void {
  let max = 0;
  for (const value of sequence) {
    max = Math.max(value + 1, max);
  }

  const first = new Array<number>(sequence.length).fill(0);
  const second = new Array<number>(max + 2).fill(0);

  for (let i = 0; i < sequence.length; i++) {
    assert.strictEqual(second[sequence[i]], 0, 'Elements in sequence should be unique');
    first[i] = i + 1;
    second[sequence[i]] = i + 1;
  }

  const result = buildChange(first, second);

  assert.ok(result);
  assert.strictEqual(result[0].length, result[1].length);
  assert.strictEqual(result[0].length, expected.length);
  for (let i = 0; i < expected.length; i++) {
    assert.strictEqual(sequence[result[0][i]], expected[i]);
  }
}

describe('diff-engine UniqueLCS (UniqueLCSTest)', () => {
  it('no unique', () => {
    assert.strictEqual(buildChange([1, 2, 3], [4, 5, 6]), undefined);
    assert.strictEqual(buildChange([1, 2, 1], [1, 3, 1]), undefined);
    assert.strictEqual(buildChange([1, 2, 3, 3, 2, 1], [1, 2, 3]), undefined);
    assert.strictEqual(buildChange([1, 2, 3], [1, 2, 3, 3, 2, 1]), undefined);
    assert.strictEqual(buildChange([1, 2, 1], [2, 1, 2]), undefined);
    assert.strictEqual(buildChange([], [2, 1, 2]), undefined);
    assert.strictEqual(buildChange([1, 2, 2], []), undefined);
    assert.strictEqual(buildChange([], []), undefined);
  });

  it('single unique', () => {
    checkChange(buildChange([1], [1]), [0], [0]);
    checkChange(buildChange([5, 1], [1]), [1], [0]);
    checkChange(buildChange([1], [2, 1]), [0], [1]);
    checkChange(buildChange([1], [1, 4]), [0], [0]);
    checkChange(buildChange([1, 3], [1]), [0], [0]);
    checkChange(buildChange([5, 1, 3], [2, 1, 4]), [1], [1]);
  });

  it('single sequence', () => {
    checkChange(
      buildChange([2, 4, 6, 1, 8, 3, 8, 2, 6, 5, 2, 4, 7, 11, 13], [1, 10, 2, 3, 5, 7, 11, 13, 12]),
      [3, 5, 9, 12, 13, 14],
      [0, 3, 4, 5, 6, 7]
    );
  });

  it('largest LCS 1', () => {
    checkMaxSequence([1, 2, 3], [1, 2, 3]);
  });

  it('largest LCS 2', () => {
    checkMaxSequence([5, 6, 1, 2, 3], [1, 2, 3]);
  });

  it('largest LCS 3', () => {
    checkMaxSequence([0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 7, 15], [0, 2, 6, 9, 13, 15]);
  });

  it('largest LCS 4', () => {
    checkMaxSequence([1, 9, 3, 8, 11, 4, 5, 6, 19, 7], [1, 3, 4, 5, 6, 7]);
  });
});
