// Ported from intellij-community platform/util/diff/src/com/intellij/diff/comparison/iterables/
// FairDiffIterableWrapper.kt and InvertedDiffIterableWrapper.kt.
// Copyright 2000-2021 JetBrains s.r.o. and contributors. Apache 2.0 license.

import { Range } from '../../util/Range';
import { IDiffIterable, IFairDiffIterable, IKtIterator } from './DiffIterable';

export class FairDiffIterableWrapper implements IFairDiffIterable {
  readonly isFair = true as const;

  constructor(private readonly iterable: IDiffIterable) {}

  get length1(): number {
    return this.iterable.length1;
  }

  get length2(): number {
    return this.iterable.length2;
  }

  changes(): IKtIterator<Range> {
    return this.iterable.changes();
  }

  unchanged(): IKtIterator<Range> {
    return this.iterable.unchanged();
  }

  iterateChanges(): Iterable<Range> {
    return this.iterable.iterateChanges();
  }

  iterateUnchanged(): Iterable<Range> {
    return this.iterable.iterateUnchanged();
  }
}

/** Swaps changed and unchanged ranges. */
export class InvertedDiffIterableWrapper implements IDiffIterable {
  constructor(private readonly iterable: IDiffIterable) {}

  get length1(): number {
    return this.iterable.length1;
  }

  get length2(): number {
    return this.iterable.length2;
  }

  changes(): IKtIterator<Range> {
    return this.iterable.unchanged();
  }

  unchanged(): IKtIterator<Range> {
    return this.iterable.changes();
  }

  iterateChanges(): Iterable<Range> {
    return this.iterable.iterateUnchanged();
  }

  iterateUnchanged(): Iterable<Range> {
    return this.iterable.iterateChanges();
  }
}
