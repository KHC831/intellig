// Ported from intellij-community platform/util/diff/src/com/intellij/util/diff/Reindexer.kt
// Copyright 2000-2025 JetBrains s.r.o. and contributors. Apache 2.0 license.

import { BitSet } from './BitSet';
import { ILCSBuilder } from './LCSBuilder';

/**
 * Drops elements that occur in only one of the two sequences (they can never match),
 * lets the LCS run on the reduced sequences, and translates the resulting change
 * ranges back to the original indices.
 */
export class Reindexer {
  private readonly oldIndices: [number[], number[]] = [[], []];
  private readonly originalLengths: [number, number] = [-1, -1];
  private readonly discardedLengths: [number, number] = [-1, -1];

  discardUnique(ints1: readonly number[], ints2: readonly number[]): [number[], number[]] {
    const discarded1 = this.discard(ints2, ints1, 0);
    return [discarded1, this.discard(discarded1, ints2, 1)];
  }

  /** Test-only: pretend nothing was discarded, so reindex maps indices 1:1. */
  idInit(length1: number, length2: number): void {
    this.originalLengths[0] = length1;
    this.originalLengths[1] = length2;
    this.discardedLengths[0] = length1;
    this.discardedLengths[1] = length2;
    for (const j of [0, 1] as const) {
      const originalLength = this.originalLengths[j];
      this.oldIndices[j] = Array.from({ length: originalLength }, (_, i) => i);
    }
  }

  private discard(
    needed: readonly number[],
    toDiscard: readonly number[],
    arrayIndex: 0 | 1
  ): number[] {
    this.originalLengths[arrayIndex] = toDiscard.length;
    const sorted1 = [...needed].sort((a, b) => a - b);
    const discarded: number[] = [];
    const oldIndices: number[] = [];
    for (let i = 0; i < toDiscard.length; i++) {
      const index = toDiscard[i];
      if (binarySearch(sorted1, index) >= 0) {
        discarded.push(index);
        oldIndices.push(i);
      }
    }
    this.oldIndices[arrayIndex] = oldIndices;
    this.discardedLengths[arrayIndex] = discarded.length;
    return discarded;
  }

  reindex(discardedChanges: readonly [BitSet, BitSet], builder: ILCSBuilder): void {
    let changes1: BitSet;
    let changes2: BitSet;

    if (
      this.discardedLengths[0] === this.originalLengths[0] &&
      this.discardedLengths[1] === this.originalLengths[1]
    ) {
      changes1 = discardedChanges[0];
      changes2 = discardedChanges[1];
    } else {
      changes1 = new BitSet(this.originalLengths[0]);
      changes2 = new BitSet(this.originalLengths[1]);
      let x = 0;
      let y = 0;
      while (x < this.discardedLengths[0] || y < this.discardedLengths[1]) {
        if (
          x < this.discardedLengths[0] &&
          y < this.discardedLengths[1] &&
          !discardedChanges[0].get(x) &&
          !discardedChanges[1].get(y)
        ) {
          x = increment(this.oldIndices[0], x, changes1, this.originalLengths[0]);
          y = increment(this.oldIndices[1], y, changes2, this.originalLengths[1]);
        } else if (discardedChanges[0].get(x)) {
          changes1.set(this.oldIndices[0][x], true);
          x = increment(this.oldIndices[0], x, changes1, this.originalLengths[0]);
        } else if (discardedChanges[1].get(y)) {
          changes2.set(this.oldIndices[1][y], true);
          y = increment(this.oldIndices[1], y, changes2, this.originalLengths[1]);
        }
      }
      if (this.discardedLengths[0] === 0) {
        changes1.setRange(0, this.originalLengths[0]);
      } else {
        changes1.setRange(0, this.oldIndices[0][0]);
      }
      if (this.discardedLengths[1] === 0) {
        changes2.setRange(0, this.originalLengths[1]);
      } else {
        changes2.setRange(0, this.oldIndices[1][0]);
      }
    }

    let x = 0;
    let y = 0;
    while (x < this.originalLengths[0] && y < this.originalLengths[1]) {
      const startX = x;
      while (
        x < this.originalLengths[0] &&
        y < this.originalLengths[1] &&
        !changes1.get(x) &&
        !changes2.get(y)
      ) {
        x++;
        y++;
      }
      if (x > startX) {
        builder.addEqual(x - startX);
      }
      let dx = 0;
      let dy = 0;
      while (x < this.originalLengths[0] && changes1.get(x)) {
        dx++;
        x++;
      }
      while (y < this.originalLengths[1] && changes2.get(y)) {
        dy++;
        y++;
      }
      if (dx !== 0 || dy !== 0) {
        builder.addChange(dx, dy);
      }
    }
    if (x !== this.originalLengths[0] || y !== this.originalLengths[1]) {
      builder.addChange(this.originalLengths[0] - x, this.originalLengths[1] - y);
    }
  }
}

function increment(indexes: readonly number[], i: number, set: BitSet, length: number): number {
  if (i + 1 < indexes.length) {
    set.setRange(indexes[i] + 1, indexes[i + 1]);
  } else {
    set.setRange(indexes[i] + 1, length);
  }
  return i + 1;
}

/** Standard binary search over a sorted array: index when found, -(insertionPoint + 1) otherwise. */
export function binarySearch(
  array: readonly number[],
  element: number,
  fromIndex: number = 0,
  toIndex: number = array.length
): number {
  if (fromIndex > toIndex) {
    throw new RangeError(`fromIndex (${fromIndex}) is greater than toIndex (${toIndex}).`);
  }
  if (fromIndex < 0) {
    throw new RangeError(`fromIndex (${fromIndex}) is less than zero.`);
  }
  if (toIndex > array.length) {
    throw new RangeError(`toIndex (${toIndex}) is greater than size (${array.length}).`);
  }

  let low = fromIndex;
  let high = toIndex - 1;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    const midElement = array[mid];

    if (midElement < element) {
      low = mid + 1;
    } else if (midElement > element) {
      high = mid - 1;
    } else {
      return mid;
    }
  }
  return -(low + 1);
}
