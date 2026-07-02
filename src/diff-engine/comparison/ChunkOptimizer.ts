// Ported from intellij-community platform/util/diff/src/com/intellij/diff/comparison/ChunkOptimizer.kt
// Copyright 2000-2021 JetBrains s.r.o. and contributors. Apache 2.0 license.

import { Range } from '../util/Range';
import { Side } from '../util/Side';
import { ICancellationChecker } from './CancellationChecker';
import { IKeyedElement } from './ChangeCorrector';
import { getUnimportantLineCharCount } from './ComparisonUtil';
import { IFairDiffIterable } from './iterables/DiffIterable';
import { createUnchanged, fair } from './iterables/DiffIterableUtil';
import { isSpaceEnterOrTabAt } from './strings';
import { IInlineChunk, NewlineChunk } from './wordChunks';

export abstract class ChunkOptimizer<T extends IKeyedElement> {
  private readonly ranges: Range[] = [];

  constructor(
    protected readonly data1: readonly T[],
    protected readonly data2: readonly T[],
    private readonly iterable: IFairDiffIterable,
    protected readonly indicator: ICancellationChecker
  ) {}

  build(): IFairDiffIterable {
    for (const range of this.iterable.iterateUnchanged()) {
      this.ranges.push(range);
      this.processLastRanges();
    }

    return fair(createUnchanged(this.ranges, this.data1.length, this.data2.length));
  }

  private processLastRanges(): void {
    if (this.ranges.length < 2) {
      return; // nothing to do
    }

    const range1 = this.ranges[this.ranges.length - 2];
    const range2 = this.ranges[this.ranges.length - 1];
    if (range1.end1 !== range2.start1 && range1.end2 !== range2.start2) {
      // if changes do not touch and we still can perform one of these optimisations,
      // it means that given DiffIterable is not LCS (because we can build a smaller one).
      // This should not happen.
      return;
    }

    const count1 = range1.end1 - range1.start1;
    const count2 = range2.end1 - range2.start1;

    const keysEqual = (index1: number, index2: number): boolean =>
      this.data1[index1].equalityKey === this.data2[index2].equalityKey;

    const equalForward = expandForwardCount(
      range1.end1,
      range1.end2,
      range1.end1 + count2,
      range1.end2 + count2,
      keysEqual
    );
    const equalBackward = expandBackwardCount(
      range2.start1 - count1,
      range2.start2 - count1,
      range2.start1,
      range2.start2,
      keysEqual
    );

    // nothing to do
    if (equalForward === 0 && equalBackward === 0) {
      return;
    }

    // merge chunks left [A]B[B] -> [AB]B
    if (equalForward === count2) {
      this.ranges.pop();
      this.ranges.pop();
      this.ranges.push(
        new Range(range1.start1, range1.end1 + count2, range1.start2, range1.end2 + count2)
      );
      this.processLastRanges();
      return;
    }

    // merge chunks right [A]A[B] -> A[AB]
    if (equalBackward === count1) {
      this.ranges.pop();
      this.ranges.pop();
      this.ranges.push(
        new Range(range2.start1 - count1, range2.end1, range2.start2 - count1, range2.end2)
      );
      this.processLastRanges();
      return;
    }

    const touchSide = Side.fromLeft(range1.end1 === range2.start1);

    const shift = this.getShift(touchSide, equalForward, equalBackward, range1, range2);
    if (shift !== 0) {
      this.ranges.pop();
      this.ranges.pop();
      this.ranges.push(
        new Range(range1.start1, range1.end1 + shift, range1.start2, range1.end2 + shift)
      );
      this.ranges.push(
        new Range(range2.start1 + shift, range2.end1, range2.start2 + shift, range2.end2)
      );
    }
  }

  // 0 - do nothing
  // >0 - shift forward
  // <0 - shift backward
  protected abstract getShift(
    touchSide: Side,
    equalForward: number,
    equalBackward: number,
    range1: Range,
    range2: Range
  ): number;
}

function expandForwardCount(
  start1: number,
  start2: number,
  end1: number,
  end2: number,
  equals: (index1: number, index2: number) => boolean
): number {
  let count = 0;
  while (start1 + count < end1 && start2 + count < end2) {
    if (!equals(start1 + count, start2 + count)) {
      break;
    }
    count++;
  }
  return count;
}

function expandBackwardCount(
  start1: number,
  start2: number,
  end1: number,
  end2: number,
  equals: (index1: number, index2: number) => boolean
): number {
  let count = 0;
  while (start1 < end1 - count && start2 < end2 - count) {
    if (!equals(end1 - count - 1, end2 - count - 1)) {
      break;
    }
    count++;
  }
  return count;
}

/*
 * 1. Minimise the amount of chunks
 *      good: "AX[AB]" - "[AB]"
 *      bad: "[A]XA[B]" - "[A][B]"
 *
 * 2. Minimise the amount of modified 'sentences', where a sentence is a sequence of words
 *    that are not separated by whitespace
 *      good: "[AX] [AZ]" - "[AX] AY [AZ]"
 *      bad: "[AX A][Z]" - "[AX A]Y A[Z]"
 *      ex: "1.0.123 1.0.155" vs "1.0.123 1.0.134 1.0.155"
 */
export class WordChunkOptimizer extends ChunkOptimizer<IInlineChunk> {
  constructor(
    words1: readonly IInlineChunk[],
    words2: readonly IInlineChunk[],
    private readonly text1: string,
    private readonly text2: string,
    changes: IFairDiffIterable,
    indicator: ICancellationChecker
  ) {
    super(words1, words2, changes, indicator);
  }

  protected getShift(
    touchSide: Side,
    equalForward: number,
    equalBackward: number,
    _range1: Range,
    range2: Range
  ): number {
    const touchWords = touchSide.select(this.data1, this.data2);
    const touchText = touchSide.select(this.text1, this.text2);
    const touchStart = touchSide.select(range2.start1, range2.start2);

    // check if chunks are already separated by whitespaces
    if (isSeparatedWithWhitespace(touchText, touchWords[touchStart - 1], touchWords[touchStart])) {
      return 0;
    }

    // shift chunks left [X]A Y[A ZA] -> [XA] YA [ZA]
    //                   [X][A ZA] -> [XA] [ZA]
    const leftShift = findSequenceEdgeShift(touchText, touchWords, touchStart, equalForward, true);
    if (leftShift > 0) {
      return leftShift;
    }

    // shift chunks right [AX A]Y A[Z] -> [AX] AY [AZ]
    //                    [AX A][Z] -> [AX] [AZ]
    const rightShift = findSequenceEdgeShift(
      touchText,
      touchWords,
      touchStart - 1,
      equalBackward,
      false
    );
    if (rightShift > 0) {
      return -rightShift;
    }

    // nothing to do
    return 0;
  }
}

function findSequenceEdgeShift(
  text: string,
  words: readonly IInlineChunk[],
  offset: number,
  count: number,
  leftToRight: boolean
): number {
  for (let i = 0; i < count; i++) {
    let word1: IInlineChunk;
    let word2: IInlineChunk;
    if (leftToRight) {
      word1 = words[offset + i];
      word2 = words[offset + i + 1];
    } else {
      word1 = words[offset - i - 1];
      word2 = words[offset - i];
    }
    if (isSeparatedWithWhitespace(text, word1, word2)) {
      return i + 1;
    }
  }
  return -1;
}

function isSeparatedWithWhitespace(
  text: string,
  word1: IInlineChunk,
  word2: IInlineChunk
): boolean {
  if (word1 instanceof NewlineChunk || word2 instanceof NewlineChunk) {
    return true;
  }

  const offset1 = word1.offset2;
  const offset2 = word2.offset1;

  for (let i = offset1; i < offset2; i++) {
    if (isSpaceEnterOrTabAt(text, i)) {
      return true;
    }
  }
  return false;
}

/** The element shape LineChunkOptimizer needs from ByLineRt's Line. */
export interface IUnimportanceRankedElement extends IKeyedElement {
  readonly nonSpaceChars: number;
}

/*
 * 1. Minimise the amount of chunks
 *      good: "AX[AB]" - "[AB]"
 *      bad: "[A]XA[B]" - "[A][B]"
 *
 * 2. Prefer insertions/deletions that are bounded by an empty (or 'unimportant') line
 *      good: "ABooYZ [ABuuYZ ]ABzzYZ" - "ABooYZ []ABzzYZ"
 *      bad: "ABooYZ AB[uuYZ AB]zzYZ" - "ABooYZ AB[]zzYZ"
 */
export class LineChunkOptimizer<T extends IUnimportanceRankedElement> extends ChunkOptimizer<T> {
  protected getShift(
    touchSide: Side,
    equalForward: number,
    equalBackward: number,
    range1: Range,
    range2: Range
  ): number {
    const threshold = getUnimportantLineCharCount();

    let shift = this.getUnchangedBoundaryShift(
      touchSide,
      equalForward,
      equalBackward,
      range1,
      range2,
      0
    );
    if (shift !== undefined) {
      return shift;
    }

    shift = this.getChangedBoundaryShift(touchSide, equalForward, equalBackward, range1, range2, 0);
    if (shift !== undefined) {
      return shift;
    }

    shift = this.getUnchangedBoundaryShift(
      touchSide,
      equalForward,
      equalBackward,
      range1,
      range2,
      threshold
    );
    if (shift !== undefined) {
      return shift;
    }

    shift = this.getChangedBoundaryShift(
      touchSide,
      equalForward,
      equalBackward,
      range1,
      range2,
      threshold
    );
    if (shift !== undefined) {
      return shift;
    }

    return 0;
  }

  /**
   * Search for an empty-line boundary in unchanged lines: we want the insertion/deletion
   * to go right before/after an empty line.
   */
  private getUnchangedBoundaryShift(
    touchSide: Side,
    equalForward: number,
    equalBackward: number,
    _range1: Range,
    range2: Range,
    threshold: number
  ): number | undefined {
    const touchLines = touchSide.select(this.data1, this.data2);
    const touchStart = touchSide.select(range2.start1, range2.start2);

    const shiftForward = findNextUnimportantLine(
      touchLines,
      touchStart,
      equalForward + 1,
      threshold
    );
    const shiftBackward = findPrevUnimportantLine(
      touchLines,
      touchStart - 1,
      equalBackward + 1,
      threshold
    );

    return selectShift(shiftForward, shiftBackward);
  }

  /**
   * Search for an empty-line boundary in changed lines: we want the insertion/deletion to
   * start/end with an empty line.
   */
  private getChangedBoundaryShift(
    touchSide: Side,
    equalForward: number,
    equalBackward: number,
    range1: Range,
    range2: Range,
    threshold: number
  ): number | undefined {
    const nonTouchSide = touchSide.other();
    const nonTouchLines = nonTouchSide.select(this.data1, this.data2);
    const changeStart = nonTouchSide.select(range1.end1, range1.end2);
    const changeEnd = nonTouchSide.select(range2.start1, range2.start2);

    const shiftForward = findNextUnimportantLine(
      nonTouchLines,
      changeStart,
      equalForward + 1,
      threshold
    );
    const shiftBackward = findPrevUnimportantLine(
      nonTouchLines,
      changeEnd - 1,
      equalBackward + 1,
      threshold
    );

    return selectShift(shiftForward, shiftBackward);
  }
}

function findNextUnimportantLine(
  lines: readonly IUnimportanceRankedElement[],
  offset: number,
  count: number,
  threshold: number
): number {
  for (let i = 0; i < count; i++) {
    if (lines[offset + i].nonSpaceChars <= threshold) {
      return i;
    }
  }
  return -1;
}

function findPrevUnimportantLine(
  lines: readonly IUnimportanceRankedElement[],
  offset: number,
  count: number,
  threshold: number
): number {
  for (let i = 0; i < count; i++) {
    if (lines[offset - i].nonSpaceChars <= threshold) {
      return i;
    }
  }
  return -1;
}

function selectShift(shiftForward: number, shiftBackward: number): number | undefined {
  if (shiftForward === -1 && shiftBackward === -1) {
    return undefined;
  }
  if (shiftForward === 0 || shiftBackward === 0) {
    return 0;
  }

  return shiftForward !== -1 ? shiftForward : -shiftBackward;
}
