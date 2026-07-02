// Ported from intellij-community platform/util/diff/src/com/intellij/diff/comparison/iterables/DiffIterableUtil.kt
// Copyright 2000-2024 JetBrains s.r.o. and contributors. Apache 2.0 license.

import { buildChanges, buildChangesInts, Change } from '../../diff/Diff';
import { FilesTooBigForDiffException } from '../../diff/FilesTooBigForDiffException';
import { IDiffFragment } from '../../fragments/DiffFragment';
import { PeekableIteratorWrapper } from '../../util/PeekableIterator';
import { Range } from '../../util/Range';
import { ICancellationChecker } from '../CancellationChecker';
import { DiffTooBigException } from '../DiffTooBigException';
import { expand } from '../TrimUtil';
import { IDiffIterable, IFairDiffIterable, IKtIterator } from './DiffIterable';
import { DiffChangeDiffIterable } from './DiffChangeDiffIterable';
import { DiffFragmentsDiffIterable } from './DiffFragmentsDiffIterable';
import { ExpandedDiffIterable } from './ExpandedDiffIterable';
import { RangesDiffIterable } from './RangesDiffIterable';
import { FairDiffIterableWrapper, InvertedDiffIterableWrapper } from './wrappers';

let SHOULD_VERIFY_ITERABLE = false;

/** Test-only: makes every factory validate the produced iterable. */
export function setVerifyEnabled(value: boolean): void {
  SHOULD_VERIFY_ITERABLE = value;
}

/** Compare two arrays of integers. */
export function diffInts(
  data1: readonly number[],
  data2: readonly number[],
  indicator: ICancellationChecker
): IFairDiffIterable {
  indicator.checkCanceled();

  try {
    const change = buildChangesInts(data1, data2);
    return fair(createFromChange(change, data1.length, data2.length));
  } catch (e) {
    if (e instanceof FilesTooBigForDiffException) {
      throw new DiffTooBigException();
    }
    throw e;
  }
}

/**
 * Compare two arrays. Elements match when === (Kotlin uses equals/hashCode; pass keyOf
 * to compare object elements by a canonical key instead).
 */
export function diff<T>(
  data1: readonly T[],
  data2: readonly T[],
  indicator: ICancellationChecker,
  keyOf?: (element: T) => string | number
): IFairDiffIterable {
  indicator.checkCanceled();

  try {
    const change =
      keyOf === undefined
        ? buildChanges(data1, data2)
        : buildChanges(data1.map(keyOf), data2.map(keyOf));
    return fair(createFromChange(change, data1.length, data2.length));
  } catch (e) {
    if (e instanceof FilesTooBigForDiffException) {
      throw new DiffTooBigException();
    }
    throw e;
  }
}

//
// Iterable
//

export function createFromChange(
  change: Change | undefined,
  length1: number,
  length2: number
): IDiffIterable {
  const iterable = new DiffChangeDiffIterable(change, length1, length2);
  verify(iterable);
  return iterable;
}

export function createFragments(
  fragments: readonly IDiffFragment[],
  length1: number,
  length2: number
): IDiffIterable {
  const iterable = new DiffFragmentsDiffIterable(fragments, length1, length2);
  verify(iterable);
  return iterable;
}

export function create(ranges: readonly Range[], length1: number, length2: number): IDiffIterable {
  const iterable = new RangesDiffIterable(ranges, length1, length2);
  verify(iterable);
  return iterable;
}

export function createUnchanged(
  ranges: readonly Range[],
  length1: number,
  length2: number
): IDiffIterable {
  const inverted = invert(create(ranges, length1, length2));
  verify(inverted);
  return inverted;
}

export function invert(iterable: IDiffIterable): IDiffIterable {
  const wrapper = new InvertedDiffIterableWrapper(iterable);
  verify(wrapper);
  return wrapper;
}

export function fair(iterable: IDiffIterable): IFairDiffIterable {
  if ((iterable as Partial<IFairDiffIterable>).isFair === true) {
    return iterable as IFairDiffIterable;
  }
  const wrapper = new FairDiffIterableWrapper(iterable);
  verifyFair(wrapper);
  return wrapper;
}

export function expandedIterable(
  iterable: IDiffIterable,
  offset1: number,
  offset2: number,
  length1: number,
  length2: number
): IDiffIterable {
  if (offset1 + iterable.length1 > length1 || offset2 + iterable.length2 > length2) {
    throw new Error('expanded iterable does not fit the given lengths');
  }
  return new ExpandedDiffIterable(iterable, offset1, offset2, length1, length2);
}

//
// Misc
//

/** Iterate both changed and unchanged ranges one-by-one. */
export function iterateAll(iterable: IDiffIterable): Iterable<readonly [Range, boolean]> {
  return {
    [Symbol.iterator](): Iterator<readonly [Range, boolean]> {
      const it = new AllRangesIterator(iterable);
      return {
        next(): IteratorResult<readonly [Range, boolean]> {
          return it.hasNext()
            ? { value: it.next(), done: false }
            : { value: undefined, done: true };
        },
      };
    },
  };
}

export function getRangeDelta(range: Range): number {
  const deleted = range.end1 - range.start1;
  const inserted = range.end2 - range.start2;
  return inserted - deleted;
}

//
// Verification
//

export function verify(iterable: IDiffIterable): void {
  if (!SHOULD_VERIFY_ITERABLE) {
    return;
  }

  verifyRanges(iterable.iterateChanges());
  verifyRanges(iterable.iterateUnchanged());

  verifyFullCover(iterable);
}

export function verifyFair(iterable: IDiffIterable): void {
  if (!SHOULD_VERIFY_ITERABLE) {
    return;
  }

  verify(iterable);

  for (const range of iterable.iterateUnchanged()) {
    if (range.end1 - range.start1 !== range.end2 - range.start2) {
      throw new Error(`fair iterable has an unbalanced unchanged range: ${range.toString()}`);
    }
  }
}

function verifyRanges(iterable: Iterable<Range>): void {
  for (const range of iterable) {
    if (range.start1 > range.end1 || range.start2 > range.end2) {
      throw new Error(`invalid range: ${range.toString()}`);
    }
    if (range.start1 === range.end1 && range.start2 === range.end2) {
      throw new Error(`empty range: ${range.toString()}`);
    }
  }
}

function verifyFullCover(iterable: IDiffIterable): void {
  let last1 = 0;
  let last2 = 0;
  let lastEquals: boolean | undefined;

  for (const [range, equal] of iterateAll(iterable)) {
    if (last1 !== range.start1 || last2 !== range.start2 || lastEquals === equal) {
      throw new Error(`ranges do not cover the sequences: ${range.toString()}`);
    }

    last1 = range.end1;
    last2 = range.end2;
    lastEquals = equal;
  }

  if (last1 !== iterable.length1 || last2 !== iterable.length2) {
    throw new Error('ranges do not reach the end of the sequences');
  }
}

//
// Helpers
//

export abstract class ChangeBuilderBase {
  private _index1 = 0;
  private _index2 = 0;

  constructor(
    readonly length1: number,
    readonly length2: number
  ) {}

  get index1(): number {
    return this._index1;
  }

  get index2(): number {
    return this._index2;
  }

  markEqual(index1: number, index2: number, count: number = 1): void {
    this.markEqualRange(index1, index2, index1 + count, index2 + count);
  }

  markEqualRange(index1: number, index2: number, end1: number, end2: number): void {
    if (index1 === end1 && index2 === end2) {
      return;
    }

    if (this._index1 > index1 || this._index2 > index2 || index1 > end1 || index2 > end2) {
      throw new Error(`invalid equal range [${index1}, ${end1}) - [${index2}, ${end2})`);
    }

    if (this._index1 !== index1 || this._index2 !== index2) {
      this.addChange(this._index1, this._index2, index1, index2);
    }
    this._index1 = end1;
    this._index2 = end2;
  }

  protected doFinish(): void {
    if (this._index1 > this.length1 || this._index2 > this.length2) {
      throw new Error('current indices are past the sequence ends');
    }

    if (this.length1 !== this._index1 || this.length2 !== this._index2) {
      this.addChange(this._index1, this._index2, this.length1, this.length2);
      this._index1 = this.length1;
      this._index2 = this.length2;
    }
  }

  protected abstract addChange(start1: number, start2: number, end1: number, end2: number): void;
}

export class ChangeBuilder extends ChangeBuilderBase {
  private readonly myChanges: Range[] = [];

  protected addChange(start1: number, start2: number, end1: number, end2: number): void {
    this.myChanges.push(new Range(start1, end1, start2, end2));
  }

  finish(): IDiffIterable {
    this.doFinish();
    return create(this.myChanges, this.length1, this.length2);
  }
}

export class ExpandChangeBuilder extends ChangeBuilder {
  private readonly equals: (index1: number, index2: number) => boolean;

  constructor(
    private readonly objects1: string | readonly unknown[],
    private readonly objects2: string | readonly unknown[],
    equals?: (index1: number, index2: number) => boolean
  ) {
    super(objects1.length, objects2.length);
    this.equals =
      equals ?? ((index1, index2): boolean => this.objects1[index1] === this.objects2[index2]);
  }

  protected override addChange(start1: number, start2: number, end1: number, end2: number): void {
    const range = expand(this.objects1, this.objects2, start1, start2, end1, end2, this.equals);
    if (!range.isEmpty) {
      super.addChange(range.start1, range.start2, range.end1, range.end2);
    }
  }
}

class AllRangesIterator implements IKtIterator<readonly [Range, boolean]> {
  private readonly changes: PeekableIteratorWrapper<Range>;
  private nextUnchanged: Range | undefined;

  constructor(private readonly iterable: IDiffIterable) {
    this.changes = new PeekableIteratorWrapper(iterable.changes());
    this.nextUnchanged = this.peekNextUnchanged(0, 0);
  }

  private peekNextUnchanged(start1: number, start2: number): Range | undefined {
    const nextChange = this.changes.hasNext() ? this.changes.peek() : undefined;
    const range =
      nextChange !== undefined
        ? new Range(start1, nextChange.start1, start2, nextChange.start2)
        : new Range(start1, this.iterable.length1, start2, this.iterable.length2);
    if (range.isEmpty) {
      return undefined;
    }
    return range;
  }

  hasNext(): boolean {
    return this.changes.hasNext() || this.nextUnchanged !== undefined;
  }

  next(): readonly [Range, boolean] {
    const unchanged = this.nextUnchanged;
    if (unchanged !== undefined) {
      this.nextUnchanged = undefined;
      return [unchanged, true];
    }

    const range = this.changes.next();
    this.nextUnchanged = this.peekNextUnchanged(range.end1, range.end2);
    return [range, false];
  }
}
