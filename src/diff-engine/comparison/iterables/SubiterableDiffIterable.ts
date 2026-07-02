// Ported from intellij-community platform/util/diff/src/com/intellij/diff/comparison/iterables/SubiterableDiffIterable.kt
// Copyright 2000-2024 JetBrains s.r.o. and contributors. Apache 2.0 license.

import { Range } from '../../util/Range';
import { ChangeDiffIterableBase, IChangeIterable } from './ChangeDiffIterableBase';

export class SubiterableDiffIterable extends ChangeDiffIterableBase {
  /**
   * @param firstIndex First range in `changed` that might affect our range. This is an
   *   optimization to avoid O(changed.length) lookups of the first element for each
   *   sub-iterable.
   */
  constructor(
    private readonly changed: readonly Range[],
    private readonly start1: number,
    private readonly end1: number,
    private readonly start2: number,
    private readonly end2: number,
    private readonly firstIndex: number
  ) {
    super(end1 - start1, end2 - start2);
  }

  protected createChangeIterable(): IChangeIterable {
    return new SubiterableChangeIterable(
      this.changed,
      this.start1,
      this.end1,
      this.start2,
      this.end2,
      this.firstIndex
    );
  }
}

class SubiterableChangeIterable implements IChangeIterable {
  private last: Range | undefined;

  constructor(
    private readonly changed: readonly Range[],
    private readonly rangeStart1: number,
    private readonly rangeEnd1: number,
    private readonly rangeStart2: number,
    private readonly rangeEnd2: number,
    private index: number
  ) {
    this.next();
  }

  valid(): boolean {
    return this.last !== undefined;
  }

  next(): void {
    this.last = undefined;

    while (this.index < this.changed.length) {
      const range = this.changed[this.index];
      this.index++;

      if (range.end1 < this.rangeStart1 || range.end2 < this.rangeStart2) {
        continue;
      }
      if (range.start1 > this.rangeEnd1 || range.start2 > this.rangeEnd2) {
        break;
      }

      const newRange = new Range(
        Math.max(this.rangeStart1, range.start1) - this.rangeStart1,
        Math.min(this.rangeEnd1, range.end1) - this.rangeStart1,
        Math.max(this.rangeStart2, range.start2) - this.rangeStart2,
        Math.min(this.rangeEnd2, range.end2) - this.rangeStart2
      );
      if (newRange.isEmpty) {
        continue;
      }

      this.last = newRange;
      break;
    }
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
