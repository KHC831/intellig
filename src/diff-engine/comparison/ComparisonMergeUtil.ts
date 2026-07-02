// Ported from intellij-community platform/util/diff/src/com/intellij/diff/comparison/ComparisonMergeUtil.kt
// (tryResolveConflict lives in MergeResolveUtil.ts to keep the module graph acyclic).
// Copyright 2000-2024 JetBrains s.r.o. and contributors. Apache 2.0 license.

import { MergeRange } from '../util/MergeRange';
import { Range } from '../util/Range';
import { Side } from '../util/Side';
import { IPeekableIterator, PeekableIteratorWrapper } from '../util/PeekableIterator';
import { ICancellationChecker } from './CancellationChecker';
import { IFairDiffIterable } from './iterables/DiffIterable';

export type SideEquality = (leftIndex: number, baseIndex: number, rightIndex: number) => boolean;

export function buildSimple(
  fragments1: IFairDiffIterable,
  fragments2: IFairDiffIterable,
  indicator: ICancellationChecker
): MergeRange[] {
  if (fragments1.length1 !== fragments2.length1) {
    throw new Error('the two iterables must share the base sequence');
  }
  indicator.checkCanceled();
  return new FairMergeBuilder().execute(fragments1, fragments2);
}

export function buildMerge(
  fragments1: IFairDiffIterable,
  fragments2: IFairDiffIterable,
  trueEquality: SideEquality,
  indicator: ICancellationChecker
): MergeRange[] {
  if (fragments1.length1 !== fragments2.length1) {
    throw new Error('the two iterables must share the base sequence');
  }
  indicator.checkCanceled();
  return new FairMergeBuilder(trueEquality).execute(fragments1, fragments2);
}

class FairMergeBuilder {
  private readonly changesBuilder: ChangeBuilder;

  constructor(trueEquality?: SideEquality) {
    this.changesBuilder =
      trueEquality === undefined ? new ChangeBuilder() : new IgnoringChangeBuilder(trueEquality);
  }

  execute(fragments1: IFairDiffIterable, fragments2: IFairDiffIterable): MergeRange[] {
    const unchanged1: IPeekableIterator<Range> = new PeekableIteratorWrapper(
      fragments1.unchanged()
    );
    const unchanged2: IPeekableIterator<Range> = new PeekableIteratorWrapper(
      fragments2.unchanged()
    );

    while (unchanged1.hasNext() && unchanged2.hasNext()) {
      const side = this.add(unchanged1.peek(), unchanged2.peek());
      side.select<IPeekableIterator<Range>>(unchanged1, unchanged2).next();
    }

    return this.changesBuilder.finish(fragments1.length2, fragments1.length1, fragments2.length2);
  }

  private add(range1: Range, range2: Range): Side {
    const start1 = range1.start1;
    const end1 = range1.end1;

    const start2 = range2.start1;
    const end2 = range2.end1;

    if (end1 <= start2) {
      return Side.LEFT;
    }
    if (end2 <= start1) {
      return Side.RIGHT;
    }

    const startBase = Math.max(start1, start2);
    const endBase = Math.min(end1, end2);
    const count = endBase - startBase;

    const startShift1 = startBase - start1;
    const startShift2 = startBase - start2;

    const startLeft = range1.start2 + startShift1;
    const endLeft = startLeft + count;
    const startRight = range2.start2 + startShift2;
    const endRight = startRight + count;

    this.changesBuilder.markEqual(startLeft, startBase, startRight, endLeft, endBase, endRight);

    return Side.fromLeft(end1 <= end2);
  }
}

class ChangeBuilder {
  protected readonly changes: MergeRange[] = [];

  private index1 = 0;
  private index2 = 0;
  private index3 = 0;

  protected addChange(
    start1: number,
    start2: number,
    start3: number,
    end1: number,
    end2: number,
    end3: number
  ): void {
    if (start1 === end1 && start2 === end2 && start3 === end3) {
      return;
    }
    this.changes.push(new MergeRange(start1, end1, start2, end2, start3, end3));
  }

  markEqual(
    start1: number,
    start2: number,
    start3: number,
    end1: number,
    end2: number,
    end3: number
  ): void {
    if (
      this.index1 > start1 ||
      this.index2 > start2 ||
      this.index3 > start3 ||
      start1 > end1 ||
      start2 > end2 ||
      start3 > end3
    ) {
      throw new Error('equal ranges must arrive in order');
    }

    this.processChange(this.index1, this.index2, this.index3, start1, start2, start3);

    this.index1 = end1;
    this.index2 = end2;
    this.index3 = end3;
  }

  finish(length1: number, length2: number, length3: number): MergeRange[] {
    if (this.index1 > length1 || this.index2 > length2 || this.index3 > length3) {
      throw new Error('processed ranges are past the sequence ends');
    }

    this.processChange(this.index1, this.index2, this.index3, length1, length2, length3);

    return this.changes;
  }

  protected processChange(
    start1: number,
    start2: number,
    start3: number,
    end1: number,
    end2: number,
    end3: number
  ): void {
    this.addChange(start1, start2, start3, end1, end2, end3);
  }
}

class IgnoringChangeBuilder extends ChangeBuilder {
  constructor(private readonly trueEquality: SideEquality) {
    super();
  }

  protected override processChange(
    start1: number,
    start2: number,
    start3: number,
    end1: number,
    end2: number,
    end3: number
  ): void {
    const lastChange =
      this.changes.length === 0 ? undefined : this.changes[this.changes.length - 1];
    const unchangedStart1 = lastChange?.end1 ?? 0;
    const unchangedStart2 = lastChange?.end2 ?? 0;
    const unchangedStart3 = lastChange?.end3 ?? 0;
    this.addIgnoredChanges(
      unchangedStart1,
      unchangedStart2,
      unchangedStart3,
      start1,
      start2,
      start3
    );

    this.addChange(start1, start2, start3, end1, end2, end3);
  }

  private addIgnoredChanges(
    start1: number,
    start2: number,
    start3: number,
    end1: number,
    end2: number,
    end3: number
  ): void {
    const count = end2 - start2;
    if (end1 - start1 !== count || end3 - start3 !== count) {
      throw new Error('unchanged ranges must have equal lengths on all sides');
    }

    let firstIgnoredCount = -1;
    for (let i = 0; i < count; i++) {
      const isIgnored = !this.trueEquality(start1 + i, start2 + i, start3 + i);
      const previousAreIgnored = firstIgnoredCount !== -1;

      if (isIgnored && !previousAreIgnored) {
        firstIgnoredCount = i;
      }
      if (!isIgnored && previousAreIgnored) {
        this.addChange(
          start1 + firstIgnoredCount,
          start2 + firstIgnoredCount,
          start3 + firstIgnoredCount,
          start1 + i,
          start2 + i,
          start3 + i
        );
        firstIgnoredCount = -1;
      }
    }

    if (firstIgnoredCount !== -1) {
      this.addChange(
        start1 + firstIgnoredCount,
        start2 + firstIgnoredCount,
        start3 + firstIgnoredCount,
        start1 + count,
        start2 + count,
        start3 + count
      );
    }
  }
}
