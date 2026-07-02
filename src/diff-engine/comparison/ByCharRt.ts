// Ported from intellij-community platform/util/diff/src/com/intellij/diff/comparison/ByCharRt.kt
// (including ChangeCorrector.DefaultCharChangeCorrector, which is mutually recursive with
// the char comparison). Copyright 2000-2024 JetBrains s.r.o. and contributors.
// Apache 2.0 license.

import { Range } from '../util/Range';
import { ICancellationChecker } from './CancellationChecker';
import { ChangeCorrector } from './ChangeCorrector';
import { charCount, codePointAtIndex } from './CharacterUtils';
import { IDiffIterable, IFairDiffIterable } from './iterables/DiffIterable';
import { ChangeBuilder, create, diffInts, fair, iterateAll } from './iterables/DiffIterableUtil';
import { expandWhitespacesForward, isPunctuation, isWhiteSpaceCodePoint } from './TrimUtil';
import { TrimSpacesCorrector } from './whitespaceCorrectors';

export function compare(
  text1: string,
  text2: string,
  indicator: ICancellationChecker
): IFairDiffIterable {
  indicator.checkCanceled();

  const codePoints1 = getAllCodePoints(text1);
  const codePoints2 = getAllCodePoints(text2);

  const iterable = diffInts(codePoints1, codePoints2, indicator);

  let offset1 = 0;
  let offset2 = 0;
  const builder = new ChangeBuilder(text1.length, text2.length);
  for (const [range, equals] of iterateAll(iterable)) {
    const end1 = offset1 + countChars(codePoints1, range.start1, range.end1);
    const end2 = offset2 + countChars(codePoints2, range.start2, range.end2);

    if (equals) {
      builder.markEqualRange(offset1, offset2, end1, end2);
    }

    offset1 = end1;
    offset2 = end2;
  }
  if (offset1 !== text1.length || offset2 !== text2.length) {
    throw new Error('code points did not cover the compared texts');
  }

  return fair(builder.finish());
}

export function compareTwoStep(
  text1: string,
  text2: string,
  indicator: ICancellationChecker
): IFairDiffIterable {
  indicator.checkCanceled();

  const codePoints1 = getNonSpaceCodePoints(text1);
  const codePoints2 = getNonSpaceCodePoints(text2);

  const nonSpaceChanges = diffInts(codePoints1.codePoints, codePoints2.codePoints, indicator);
  return matchAdjustmentSpaces(codePoints1, codePoints2, text1, text2, nonSpaceChanges, indicator);
}

export function compareTrimWhitespaces(
  text1: string,
  text2: string,
  indicator: ICancellationChecker
): IDiffIterable {
  const iterable = compareTwoStep(text1, text2, indicator);
  return new TrimSpacesCorrector(iterable, text1, text2, indicator).build();
}

export function compareIgnoreWhitespaces(
  text1: string,
  text2: string,
  indicator: ICancellationChecker
): IDiffIterable {
  indicator.checkCanceled();

  const codePoints1 = getNonSpaceCodePoints(text1);
  const codePoints2 = getNonSpaceCodePoints(text2);

  const changes = diffInts(codePoints1.codePoints, codePoints2.codePoints, indicator);
  return matchAdjustmentSpacesIW(codePoints1, codePoints2, text1, text2, changes);
}

/** Compare punctuation chars only; all other characters are left unmatched. */
export function comparePunctuation(
  text1: string,
  text2: string,
  indicator: ICancellationChecker
): IFairDiffIterable {
  indicator.checkCanceled();

  const chars1 = getPunctuationChars(text1);
  const chars2 = getPunctuationChars(text2);

  const nonSpaceChanges = diffInts(chars1.codePoints, chars2.codePoints, indicator);
  return transferPunctuation(chars1, chars2, text1, text2, nonSpaceChanges);
}

//
// Impl
//

function transferPunctuation(
  chars1: CodePointsOffsets,
  chars2: CodePointsOffsets,
  text1: string,
  text2: string,
  changes: IFairDiffIterable
): IFairDiffIterable {
  const builder = new ChangeBuilder(text1.length, text2.length);

  for (const range of changes.iterateUnchanged()) {
    const count = range.end1 - range.start1;
    for (let i = 0; i < count; i++) {
      // Punctuation code points are always 1 char
      const offset1 = chars1.offsets[range.start1 + i];
      const offset2 = chars2.offsets[range.start2 + i];
      builder.markEqual(offset1, offset2);
    }
  }

  return fair(builder.finish());
}

/*
 * Given a DiffIterable on non-space characters, convert it into a DiffIterable on the
 * original texts.
 *
 * Idea: run a fair diff on all gaps between matched characters (inside these gaps there
 * can be non-space characters, but they are unique and can't be matched).
 */
function matchAdjustmentSpaces(
  codePoints1: CodePointsOffsets,
  codePoints2: CodePointsOffsets,
  text1: string,
  text2: string,
  changes: IFairDiffIterable,
  indicator: ICancellationChecker
): IFairDiffIterable {
  return new DefaultCharChangeCorrector(
    codePoints1,
    codePoints2,
    text1,
    text2,
    changes,
    indicator
  ).build();
}

/*
 * Given a DiffIterable on non-whitespace characters, convert it into a DiffIterable on
 * the original texts.
 *
 * Matched characters: matched non-space characters + all adjustment whitespaces.
 */
function matchAdjustmentSpacesIW(
  codePoints1: CodePointsOffsets,
  codePoints2: CodePointsOffsets,
  text1: string,
  text2: string,
  changes: IFairDiffIterable
): IDiffIterable {
  const ranges: Range[] = [];

  for (const ch of changes.iterateChanges()) {
    let startOffset1: number;
    let endOffset1: number;
    if (ch.start1 === ch.end1) {
      endOffset1 = expandForwardW(codePoints1, codePoints2, text1, text2, ch, true);
      startOffset1 = endOffset1;
    } else {
      startOffset1 = codePoints1.charOffset(ch.start1);
      endOffset1 = codePoints1.charOffsetAfter(ch.end1 - 1);
    }

    let startOffset2: number;
    let endOffset2: number;
    if (ch.start2 === ch.end2) {
      endOffset2 = expandForwardW(codePoints1, codePoints2, text1, text2, ch, false);
      startOffset2 = endOffset2;
    } else {
      startOffset2 = codePoints2.charOffset(ch.start2);
      endOffset2 = codePoints2.charOffsetAfter(ch.end2 - 1);
    }

    ranges.push(new Range(startOffset1, endOffset1, startOffset2, endOffset2));
  }
  return create(ranges, text1.length, text2.length);
}

/*
 * We need this to correct the insertion/deletion position: we want to match whitespaces
 * if we can.
 *
 * Sample: "x y" -> "x zy", the space should be matched instead of being ignored.
 */
function expandForwardW(
  codePoints1: CodePointsOffsets,
  codePoints2: CodePointsOffsets,
  text1: string,
  text2: string,
  ch: Range,
  left: boolean
): number {
  const offset1 = ch.start1 === 0 ? 0 : codePoints1.charOffsetAfter(ch.start1 - 1);
  const offset2 = ch.start2 === 0 ? 0 : codePoints2.charOffsetAfter(ch.start2 - 1);

  const start = left ? offset1 : offset2;

  return (
    start + expandWhitespacesForward(text1, text2, offset1, offset2, text1.length, text2.length)
  );
}

//
// Misc
//

function getAllCodePoints(text: string): number[] {
  const list: number[] = [];

  const len = text.length;
  let offset = 0;

  while (offset < len) {
    const ch = codePointAtIndex(text, offset);
    list.push(ch);
    offset += charCount(ch);
  }

  return list;
}

function getNonSpaceCodePoints(text: string): CodePointsOffsets {
  const codePoints: number[] = [];
  const offsets: number[] = [];

  const len = text.length;
  let offset = 0;

  while (offset < len) {
    const ch = codePointAtIndex(text, offset);

    if (!isWhiteSpaceCodePoint(ch)) {
      codePoints.push(ch);
      offsets.push(offset);
    }

    offset += charCount(ch);
  }

  return new CodePointsOffsets(codePoints, offsets);
}

function getPunctuationChars(text: string): CodePointsOffsets {
  const codePoints: number[] = [];
  const offsets: number[] = [];

  for (let i = 0; i < text.length; i++) {
    if (isPunctuation(text[i])) {
      codePoints.push(text.charCodeAt(i));
      offsets.push(i);
    }
  }

  return new CodePointsOffsets(codePoints, offsets);
}

function countChars(codePoints: readonly number[], start: number, end: number): number {
  let count = 0;
  for (let i = start; i < end; i++) {
    count += charCount(codePoints[i]);
  }
  return count;
}

export class CodePointsOffsets {
  constructor(
    readonly codePoints: readonly number[],
    readonly offsets: readonly number[]
  ) {}

  charOffset(index: number): number {
    return this.offsets[index];
  }

  charOffsetAfter(index: number): number {
    return this.offsets[index] + charCount(this.codePoints[index]);
  }
}

class DefaultCharChangeCorrector extends ChangeCorrector {
  constructor(
    private readonly codePoints1: CodePointsOffsets,
    private readonly codePoints2: CodePointsOffsets,
    private readonly text1: string,
    private readonly text2: string,
    changes: IFairDiffIterable,
    indicator: ICancellationChecker
  ) {
    super(text1.length, text2.length, changes, indicator);
  }

  protected matchGap(start1: number, end1: number, start2: number, end2: number): void {
    const inner1 = this.text1.substring(start1, end1);
    const inner2 = this.text2.substring(start2, end2);
    const innerChanges = compare(inner1, inner2, this.indicator);

    for (const chunk of innerChanges.iterateUnchanged()) {
      this.builder.markEqual(
        start1 + chunk.start1,
        start2 + chunk.start2,
        chunk.end1 - chunk.start1
      );
    }
  }

  protected getOriginalRange1(index: number): readonly [number, number] {
    return [this.codePoints1.charOffset(index), this.codePoints1.charOffsetAfter(index)];
  }

  protected getOriginalRange2(index: number): readonly [number, number] {
    return [this.codePoints2.charOffset(index), this.codePoints2.charOffsetAfter(index)];
  }
}
