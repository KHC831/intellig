// Ported from intellij-community platform/util/diff/src/com/intellij/diff/comparison/iterables/ChangeDiffIterableBase.kt
// Copyright 2000-2021 JetBrains s.r.o. and contributors. Apache 2.0 license.

import { Range } from '../../util/Range';
import { IDiffIterable, IKtIterator, toIterable } from './DiffIterable';

/** Cursor over a sequence of change ranges: valid() tells whether the cursor points at one. */
export interface IChangeIterable {
  valid(): boolean;
  next(): void;
  readonly start1: number;
  readonly start2: number;
  readonly end1: number;
  readonly end2: number;
}

export abstract class ChangeDiffIterableBase implements IDiffIterable {
  constructor(
    readonly length1: number,
    readonly length2: number
  ) {}

  changes(): IKtIterator<Range> {
    return new ChangedIterator(this.createChangeIterable());
  }

  unchanged(): IKtIterator<Range> {
    return new UnchangedIterator(this.createChangeIterable(), this.length1, this.length2);
  }

  iterateChanges(): Iterable<Range> {
    return toIterable(() => this.changes());
  }

  iterateUnchanged(): Iterable<Range> {
    return toIterable(() => this.unchanged());
  }

  protected abstract createChangeIterable(): IChangeIterable;
}

class ChangedIterator implements IKtIterator<Range> {
  constructor(private readonly iterable: IChangeIterable) {}

  hasNext(): boolean {
    return this.iterable.valid();
  }

  next(): Range {
    const range = new Range(
      this.iterable.start1,
      this.iterable.end1,
      this.iterable.start2,
      this.iterable.end2
    );
    this.iterable.next();
    return range;
  }
}

class UnchangedIterator implements IKtIterator<Range> {
  private lastIndex1 = 0;
  private lastIndex2 = 0;

  constructor(
    private readonly iterable: IChangeIterable,
    private readonly length1: number,
    private readonly length2: number
  ) {
    if (this.iterable.valid()) {
      if (this.iterable.start1 === 0 && this.iterable.start2 === 0) {
        this.lastIndex1 = this.iterable.end1;
        this.lastIndex2 = this.iterable.end2;
        this.iterable.next();
      }
    }
  }

  hasNext(): boolean {
    return (
      this.iterable.valid() || this.lastIndex1 !== this.length1 || this.lastIndex2 !== this.length2
    );
  }

  next(): Range {
    if (this.iterable.valid()) {
      if (this.iterable.start1 < this.lastIndex1 && this.iterable.start2 < this.lastIndex2) {
        throw new Error('unchanged ranges are out of order');
      }
      const chunk = new Range(
        this.lastIndex1,
        this.iterable.start1,
        this.lastIndex2,
        this.iterable.start2
      );

      this.lastIndex1 = this.iterable.end1;
      this.lastIndex2 = this.iterable.end2;

      this.iterable.next();

      return chunk;
    }
    if (this.length1 - this.lastIndex1 === 0 && this.length2 - this.lastIndex2 === 0) {
      throw new Error('no unchanged range left');
    }
    const chunk = new Range(this.lastIndex1, this.length1, this.lastIndex2, this.length2);

    this.lastIndex1 = this.length1;
    this.lastIndex2 = this.length2;

    return chunk;
  }
}
