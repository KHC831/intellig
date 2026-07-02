// Ported from intellij-community platform/util/diff/src/com/intellij/diff/comparison/iterables/ExpandedDiffIterable.kt
// Copyright 2000-2021 JetBrains s.r.o. and contributors. Apache 2.0 license.

import { Range } from '../../util/Range';
import { ChangeDiffIterableBase, IChangeIterable } from './ChangeDiffIterableBase';
import { IDiffIterable, IKtIterator } from './DiffIterable';

export class ExpandedDiffIterable extends ChangeDiffIterableBase {
  constructor(
    private readonly iterable: IDiffIterable,
    private readonly offset1: number,
    private readonly offset2: number,
    length1: number,
    length2: number
  ) {
    super(length1, length2);
  }

  protected createChangeIterable(): IChangeIterable {
    return new ShiftedChangeIterable(this.iterable, this.offset1, this.offset2);
  }
}

class ShiftedChangeIterable implements IChangeIterable {
  private readonly iterator: IKtIterator<Range>;
  private last: Range | undefined;

  constructor(
    iterable: IDiffIterable,
    private readonly offset1: number,
    private readonly offset2: number
  ) {
    this.iterator = iterable.changes();
    this.next();
  }

  valid(): boolean {
    return this.last !== undefined;
  }

  next(): void {
    this.last = this.iterator.hasNext() ? this.iterator.next() : undefined;
  }

  get start1(): number {
    return (this.last as Range).start1 + this.offset1;
  }

  get start2(): number {
    return (this.last as Range).start2 + this.offset2;
  }

  get end1(): number {
    return (this.last as Range).end1 + this.offset1;
  }

  get end2(): number {
    return (this.last as Range).end2 + this.offset2;
  }
}
