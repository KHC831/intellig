// Ported from intellij-community platform/util/diff/src/com/intellij/diff/comparison/iterables/RangesDiffIterable.kt
// Copyright 2000-2021 JetBrains s.r.o. and contributors. Apache 2.0 license.

import { Range } from '../../util/Range';
import { ChangeDiffIterableBase, IChangeIterable } from './ChangeDiffIterableBase';

export class RangesDiffIterable extends ChangeDiffIterableBase {
  constructor(
    private readonly ranges: readonly Range[],
    length1: number,
    length2: number
  ) {
    super(length1, length2);
  }

  protected createChangeIterable(): IChangeIterable {
    return new RangesChangeIterable(this.ranges);
  }
}

class RangesChangeIterable implements IChangeIterable {
  private index = 0;
  private last: Range | undefined;

  constructor(private readonly ranges: readonly Range[]) {
    this.next();
  }

  valid(): boolean {
    return this.last !== undefined;
  }

  next(): void {
    this.last = this.index < this.ranges.length ? this.ranges[this.index++] : undefined;
  }

  get start1(): number {
    return (this.last as Range).start1;
  }

  get start2(): number {
    return (this.last as Range).start2;
  }

  get end1(): number {
    return (this.last as Range).end1;
  }

  get end2(): number {
    return (this.last as Range).end2;
  }
}
