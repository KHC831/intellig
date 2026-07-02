// Ported from intellij-community platform/util/diff/src/com/intellij/diff/comparison/iterables/DiffIterable.kt
// and FairDiffIterable.kt. Copyright 2000-2022 JetBrains s.r.o. and contributors. Apache 2.0 license.

import { Range } from '../../util/Range';

/** Kotlin-style iterator (hasNext/next), which the engine's merge loops peek into. */
export interface IKtIterator<T> {
  hasNext(): boolean;
  next(): T;
}

/**
 * Represents computed differences between two sequences.
 *
 * All ranges are non-empty (at least one element on one of the sides) and do not overlap.
 * Differences are NOT guaranteed to be 'squashed': there can be two adjacent changed
 * ranges (range1.end1 == range2.start1 && range1.end2 == range2.start2).
 */
export interface IDiffIterable {
  readonly length1: number;
  readonly length2: number;
  changes(): IKtIterator<Range>;
  unchanged(): IKtIterator<Range>;
  iterateChanges(): Iterable<Range>;
  iterateUnchanged(): Iterable<Range>;
}

/**
 * Marker for iterables whose elements are compared one-by-one: if range [a, b) is equal
 * to [a', b'), then element(a + i) equals element(a' + i) for every i. Unchanged ranges
 * therefore always have equal lengths on both sides.
 */
export interface IFairDiffIterable extends IDiffIterable {
  readonly isFair: true;
}

export function toIterable<T>(makeIterator: () => IKtIterator<T>): Iterable<T> {
  return {
    [Symbol.iterator](): Iterator<T> {
      const it = makeIterator();
      return {
        next(): IteratorResult<T> {
          return it.hasNext()
            ? { value: it.next(), done: false }
            : { value: undefined, done: true };
        },
      };
    },
  };
}
