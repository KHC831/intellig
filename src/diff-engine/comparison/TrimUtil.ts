// Ported from intellij-community platform/util/diff/src/com/intellij/diff/comparison/TrimUtil.kt
// Copyright 2000-2021 JetBrains s.r.o. and contributors. Apache 2.0 license.
//
// Kotlin's arity-overloaded trim/expand helpers carry a numeric suffix here for the
// three-sided variants (trim3, expandWhitespaces3, ...).

import { MergeRange } from '../util/MergeRange';
import { Range } from '../util/Range';
import {
  isAlphabetic,
  isBmpCodePoint,
  isDecimalDigit,
  isHiraganaScript,
  isIdeographic,
  isJavaneseScript,
  isKatakanaScript,
  isThaiScript,
} from './CharacterUtils';
import { ComparisonPolicy } from './ComparisonPolicy';
import { isEqualTexts } from './ComparisonUtil';
import { isSpaceEnterOrTabAt, isSpaceEnterOrTabCode } from './strings';

type Sequence = string | readonly unknown[];

export function isPunctuation(c: string): boolean {
  return isPunctuationCode(c.charCodeAt(0));
}

export function isPunctuationCode(b: number): boolean {
  if (b === 95) {
    return false;
  } // exclude '_'
  return (
    (b >= 33 && b <= 47) || // !"#$%&'()*+,-./
    (b >= 58 && b <= 64) || // :;<=>?@
    (b >= 91 && b <= 96) || // [\]^_`
    (b >= 123 && b <= 126) // {|}~
  );
}

export function isAlpha(codePoint: number): boolean {
  if (isWhiteSpaceCodePoint(codePoint)) {
    return false;
  }
  return !isPunctuationCode(codePoint);
}

export function isWhiteSpaceCodePoint(codePoint: number): boolean {
  return codePoint < 128 && isSpaceEnterOrTabCode(codePoint);
}

export function isContinuousScript(codePoint: number): boolean {
  if (codePoint < 128) {
    return false;
  }
  if (isDecimalDigit(codePoint)) {
    return false;
  }

  if (!isBmpCodePoint(codePoint)) {
    return true;
  }

  if (isIdeographic(codePoint)) {
    return true;
  }
  if (!isAlphabetic(codePoint)) {
    return true;
  }

  return (
    isHiraganaScript(codePoint) ||
    isKatakanaScript(codePoint) ||
    isThaiScript(codePoint) ||
    isJavaneseScript(codePoint)
  );
}

export function trim(text: string, start: number, end: number): readonly [number, number] {
  return trimPredicate(start, end, (index) => isSpaceEnterOrTabAt(text, index));
}

export function trimStart(text: string, start: number, end: number): number {
  return trimStartPredicate(start, end, (index) => isSpaceEnterOrTabAt(text, index));
}

export function trimEnd(text: string, start: number, end: number): number {
  return trimEndPredicate(start, end, (index) => isSpaceEnterOrTabAt(text, index));
}

export function trim2(
  text1: string,
  text2: string,
  start1: number,
  start2: number,
  end1: number,
  end2: number
): Range {
  return trim2Predicates(
    start1,
    start2,
    end1,
    end2,
    (index) => isSpaceEnterOrTabAt(text1, index),
    (index) => isSpaceEnterOrTabAt(text2, index)
  );
}

export function trim3(
  text1: string,
  text2: string,
  text3: string,
  start1: number,
  start2: number,
  start3: number,
  end1: number,
  end2: number,
  end3: number
): MergeRange {
  return trim3Predicates(
    start1,
    start2,
    start3,
    end1,
    end2,
    end3,
    (index) => isSpaceEnterOrTabAt(text1, index),
    (index) => isSpaceEnterOrTabAt(text2, index),
    (index) => isSpaceEnterOrTabAt(text3, index)
  );
}

export function trimRange2(text1: string, text2: string, range: Range): Range {
  return trim2(text1, text2, range.start1, range.start2, range.end1, range.end2);
}

export function trimRange3(
  text1: string,
  text2: string,
  text3: string,
  range: MergeRange
): MergeRange {
  return trim3(
    text1,
    text2,
    text3,
    range.start1,
    range.start2,
    range.start3,
    range.end1,
    range.end2,
    range.end3
  );
}

export function expand(
  seq1: Sequence,
  seq2: Sequence,
  start1: number,
  start2: number,
  end1: number,
  end2: number,
  equals: (index1: number, index2: number) => boolean = (index1, index2): boolean =>
    seq1[index1] === seq2[index2]
): Range {
  return expandPredicate(start1, start2, end1, end2, equals);
}

export function expandForward(
  seq1: Sequence,
  seq2: Sequence,
  start1: number,
  start2: number,
  end1: number,
  end2: number
): number {
  return expandForwardPredicate(
    start1,
    start2,
    end1,
    end2,
    (index1, index2) => seq1[index1] === seq2[index2]
  );
}

export function expandBackward(
  seq1: Sequence,
  seq2: Sequence,
  start1: number,
  start2: number,
  end1: number,
  end2: number
): number {
  return expandBackwardPredicate(
    start1,
    start2,
    end1,
    end2,
    (index1, index2) => seq1[index1] === seq2[index2]
  );
}

export function expandRange(text1: string, text2: string, range: Range): Range {
  return expand(text1, text2, range.start1, range.start2, range.end1, range.end2);
}

export function expandWhitespaces(
  text1: string,
  text2: string,
  start1: number,
  start2: number,
  end1: number,
  end2: number
): Range {
  return expandIgnored(
    start1,
    start2,
    end1,
    end2,
    (index1, index2) => text1[index1] === text2[index2],
    (index) => isSpaceEnterOrTabAt(text1, index)
  );
}

export function expandWhitespacesRange(text1: string, text2: string, range: Range): Range {
  return expandWhitespaces(text1, text2, range.start1, range.start2, range.end1, range.end2);
}

export function expandWhitespacesForward(
  text1: string,
  text2: string,
  start1: number,
  start2: number,
  end1: number,
  end2: number
): number {
  return expandIgnoredForward(
    start1,
    start2,
    end1,
    end2,
    (index1, index2) => text1[index1] === text2[index2],
    (index) => isSpaceEnterOrTabAt(text1, index)
  );
}

export function expandWhitespacesBackward(
  text1: string,
  text2: string,
  start1: number,
  start2: number,
  end1: number,
  end2: number
): number {
  return expandIgnoredBackward(
    start1,
    start2,
    end1,
    end2,
    (index1, index2) => text1[index1] === text2[index2],
    (index) => isSpaceEnterOrTabAt(text1, index)
  );
}

export function expandWhitespaces3(
  text1: string,
  text2: string,
  text3: string,
  start1: number,
  start2: number,
  start3: number,
  end1: number,
  end2: number,
  end3: number
): MergeRange {
  return expandIgnored3(
    start1,
    start2,
    start3,
    end1,
    end2,
    end3,
    (index1, index2) => text1[index1] === text2[index2],
    (index1, index3) => text1[index1] === text3[index3],
    (index) => isSpaceEnterOrTabAt(text1, index)
  );
}

export function expandWhitespacesForward3(
  text1: string,
  text2: string,
  text3: string,
  start1: number,
  start2: number,
  start3: number,
  end1: number,
  end2: number,
  end3: number
): number {
  return expandIgnoredForward3(
    start1,
    start2,
    start3,
    end1,
    end2,
    end3,
    (index1, index2) => text1[index1] === text2[index2],
    (index1, index3) => text1[index1] === text3[index3],
    (index) => isSpaceEnterOrTabAt(text1, index)
  );
}

export function expandWhitespacesBackward3(
  text1: string,
  text2: string,
  text3: string,
  start1: number,
  start2: number,
  start3: number,
  end1: number,
  end2: number,
  end3: number
): number {
  return expandIgnoredBackward3(
    start1,
    start2,
    start3,
    end1,
    end2,
    end3,
    (index1, index2) => text1[index1] === text2[index2],
    (index1, index3) => text1[index1] === text3[index3],
    (index) => isSpaceEnterOrTabAt(text1, index)
  );
}

export function expandWhitespacesRange3(
  text1: string,
  text2: string,
  text3: string,
  range: MergeRange
): MergeRange {
  return expandWhitespaces3(
    text1,
    text2,
    text3,
    range.start1,
    range.start2,
    range.start3,
    range.end1,
    range.end2,
    range.end3
  );
}

export function trimExpandRange(
  start1: number,
  start2: number,
  end1: number,
  end2: number,
  equals: (index1: number, index2: number) => boolean,
  ignored1: (index: number) => boolean,
  ignored2: (index: number) => boolean
): Range {
  return trimExpand(start1, start2, end1, end2, equals, ignored1, ignored2);
}

export function isEquals(text1: string, text2: string, range: Range): boolean {
  const sequence1 = text1.substring(range.start1, range.end1);
  const sequence2 = text2.substring(range.start2, range.end2);
  return isEqualTexts(sequence1, sequence2, ComparisonPolicy.DEFAULT);
}

export function isEqualsIgnoreWhitespaces(text1: string, text2: string, range: Range): boolean {
  const sequence1 = text1.substring(range.start1, range.end1);
  const sequence2 = text2.substring(range.start2, range.end2);
  return isEqualTexts(sequence1, sequence2, ComparisonPolicy.IGNORE_WHITESPACES);
}

export function isEquals3(text1: string, text2: string, text3: string, range: MergeRange): boolean {
  const sequence1 = text1.substring(range.start1, range.end1);
  const sequence2 = text2.substring(range.start2, range.end2);
  const sequence3 = text3.substring(range.start3, range.end3);
  return (
    isEqualTexts(sequence2, sequence1, ComparisonPolicy.DEFAULT) &&
    isEqualTexts(sequence2, sequence3, ComparisonPolicy.DEFAULT)
  );
}

export function isEqualsIgnoreWhitespaces3(
  text1: string,
  text2: string,
  text3: string,
  range: MergeRange
): boolean {
  const sequence1 = text1.substring(range.start1, range.end1);
  const sequence2 = text2.substring(range.start2, range.end2);
  const sequence3 = text3.substring(range.start3, range.end3);
  return (
    isEqualTexts(sequence2, sequence1, ComparisonPolicy.IGNORE_WHITESPACES) &&
    isEqualTexts(sequence2, sequence3, ComparisonPolicy.IGNORE_WHITESPACES)
  );
}

//
// Trim
//

function trim2Predicates(
  start1: number,
  start2: number,
  end1: number,
  end2: number,
  ignored1: (index: number) => boolean,
  ignored2: (index: number) => boolean
): Range {
  start1 = trimStartPredicate(start1, end1, ignored1);
  end1 = trimEndPredicate(start1, end1, ignored1);
  start2 = trimStartPredicate(start2, end2, ignored2);
  end2 = trimEndPredicate(start2, end2, ignored2);

  return new Range(start1, end1, start2, end2);
}

function trim3Predicates(
  start1: number,
  start2: number,
  start3: number,
  end1: number,
  end2: number,
  end3: number,
  ignored1: (index: number) => boolean,
  ignored2: (index: number) => boolean,
  ignored3: (index: number) => boolean
): MergeRange {
  start1 = trimStartPredicate(start1, end1, ignored1);
  end1 = trimEndPredicate(start1, end1, ignored1);
  start2 = trimStartPredicate(start2, end2, ignored2);
  end2 = trimEndPredicate(start2, end2, ignored2);
  start3 = trimStartPredicate(start3, end3, ignored3);
  end3 = trimEndPredicate(start3, end3, ignored3);

  return new MergeRange(start1, end1, start2, end2, start3, end3);
}

function trimPredicate(
  start: number,
  end: number,
  ignored: (index: number) => boolean
): readonly [number, number] {
  start = trimStartPredicate(start, end, ignored);
  end = trimEndPredicate(start, end, ignored);
  return [start, end];
}

function trimStartPredicate(
  start: number,
  end: number,
  ignored: (index: number) => boolean
): number {
  while (start < end) {
    if (!ignored(start)) {
      break;
    }
    start++;
  }
  return start;
}

function trimEndPredicate(start: number, end: number, ignored: (index: number) => boolean): number {
  while (start < end) {
    if (!ignored(end - 1)) {
      break;
    }
    end--;
  }
  return end;
}

//
// Expand
//

function expandPredicate(
  start1: number,
  start2: number,
  end1: number,
  end2: number,
  equals: (index1: number, index2: number) => boolean
): Range {
  const count1 = expandForwardPredicate(start1, start2, end1, end2, equals);
  start1 += count1;
  start2 += count1;

  const count2 = expandBackwardPredicate(start1, start2, end1, end2, equals);
  end1 -= count2;
  end2 -= count2;

  return new Range(start1, end1, start2, end2);
}

function expandForwardPredicate(
  start1: number,
  start2: number,
  end1: number,
  end2: number,
  equals: (index1: number, index2: number) => boolean
): number {
  const oldStart1 = start1;
  while (start1 < end1 && start2 < end2) {
    if (!equals(start1, start2)) {
      break;
    }
    start1++;
    start2++;
  }
  return start1 - oldStart1;
}

function expandBackwardPredicate(
  start1: number,
  start2: number,
  end1: number,
  end2: number,
  equals: (index1: number, index2: number) => boolean
): number {
  const oldEnd1 = end1;
  while (start1 < end1 && start2 < end2) {
    if (!equals(end1 - 1, end2 - 1)) {
      break;
    }
    end1--;
    end2--;
  }
  return oldEnd1 - end1;
}

//
// Expand Ignored
//

function expandIgnored(
  start1: number,
  start2: number,
  end1: number,
  end2: number,
  equals: (index1: number, index2: number) => boolean,
  ignored1: (index: number) => boolean
): Range {
  const count1 = expandIgnoredForward(start1, start2, end1, end2, equals, ignored1);
  start1 += count1;
  start2 += count1;

  const count2 = expandIgnoredBackward(start1, start2, end1, end2, equals, ignored1);
  end1 -= count2;
  end2 -= count2;

  return new Range(start1, end1, start2, end2);
}

function expandIgnoredForward(
  start1: number,
  start2: number,
  end1: number,
  end2: number,
  equals: (index1: number, index2: number) => boolean,
  ignored1: (index: number) => boolean
): number {
  const oldStart1 = start1;
  while (start1 < end1 && start2 < end2) {
    if (!equals(start1, start2)) {
      break;
    }
    if (!ignored1(start1)) {
      break;
    }
    start1++;
    start2++;
  }
  return start1 - oldStart1;
}

function expandIgnoredBackward(
  start1: number,
  start2: number,
  end1: number,
  end2: number,
  equals: (index1: number, index2: number) => boolean,
  ignored1: (index: number) => boolean
): number {
  const oldEnd1 = end1;
  while (start1 < end1 && start2 < end2) {
    if (!equals(end1 - 1, end2 - 1)) {
      break;
    }
    if (!ignored1(end1 - 1)) {
      break;
    }
    end1--;
    end2--;
  }
  return oldEnd1 - end1;
}

function expandIgnored3(
  start1: number,
  start2: number,
  start3: number,
  end1: number,
  end2: number,
  end3: number,
  equals12: (index1: number, index2: number) => boolean,
  equals13: (index1: number, index3: number) => boolean,
  ignored1: (index: number) => boolean
): MergeRange {
  const count1 = expandIgnoredForward3(
    start1,
    start2,
    start3,
    end1,
    end2,
    end3,
    equals12,
    equals13,
    ignored1
  );
  start1 += count1;
  start2 += count1;
  start3 += count1;

  const count2 = expandIgnoredBackward3(
    start1,
    start2,
    start3,
    end1,
    end2,
    end3,
    equals12,
    equals13,
    ignored1
  );
  end1 -= count2;
  end2 -= count2;
  end3 -= count2;

  return new MergeRange(start1, end1, start2, end2, start3, end3);
}

function expandIgnoredForward3(
  start1: number,
  start2: number,
  start3: number,
  end1: number,
  end2: number,
  end3: number,
  equals12: (index1: number, index2: number) => boolean,
  equals13: (index1: number, index3: number) => boolean,
  ignored1: (index: number) => boolean
): number {
  const oldStart1 = start1;
  while (start1 < end1 && start2 < end2 && start3 < end3) {
    if (!equals12(start1, start2)) {
      break;
    }
    if (!equals13(start1, start3)) {
      break;
    }
    if (!ignored1(start1)) {
      break;
    }
    start1++;
    start2++;
    start3++;
  }
  return start1 - oldStart1;
}

function expandIgnoredBackward3(
  start1: number,
  start2: number,
  start3: number,
  end1: number,
  end2: number,
  end3: number,
  equals12: (index1: number, index2: number) => boolean,
  equals13: (index1: number, index3: number) => boolean,
  ignored1: (index: number) => boolean
): number {
  const oldEnd1 = end1;
  while (start1 < end1 && start2 < end2 && start3 < end3) {
    if (!equals12(end1 - 1, end2 - 1)) {
      break;
    }
    if (!equals13(end1 - 1, end3 - 1)) {
      break;
    }
    if (!ignored1(end1 - 1)) {
      break;
    }
    end1--;
    end2--;
    end3--;
  }
  return oldEnd1 - end1;
}

//
// Trim Expand
//

export function trimExpand(
  start1: number,
  start2: number,
  end1: number,
  end2: number,
  equals: (index1: number, index2: number) => boolean,
  ignored1: (index: number) => boolean,
  ignored2: (index: number) => boolean
): Range {
  const starts = trimExpandForward(start1, start2, end1, end2, equals, ignored1, ignored2);
  start1 = starts[0];
  start2 = starts[1];

  const ends = trimExpandBackward(start1, start2, end1, end2, equals, ignored1, ignored2);
  end1 = ends[0];
  end2 = ends[1];

  return new Range(start1, end1, start2, end2);
}

function trimExpandForward(
  start1: number,
  start2: number,
  end1: number,
  end2: number,
  equals: (index1: number, index2: number) => boolean,
  ignored1: (index: number) => boolean,
  ignored2: (index: number) => boolean
): readonly [number, number] {
  while (start1 < end1 && start2 < end2) {
    if (equals(start1, start2)) {
      start1++;
      start2++;
      continue;
    }

    let skipped = false;
    if (ignored1(start1)) {
      skipped = true;
      start1++;
    }
    if (ignored2(start2)) {
      skipped = true;
      start2++;
    }
    if (!skipped) {
      break;
    }
  }

  start1 = trimStartPredicate(start1, end1, ignored1);
  start2 = trimStartPredicate(start2, end2, ignored2);

  return [start1, start2];
}

function trimExpandBackward(
  start1: number,
  start2: number,
  end1: number,
  end2: number,
  equals: (index1: number, index2: number) => boolean,
  ignored1: (index: number) => boolean,
  ignored2: (index: number) => boolean
): readonly [number, number] {
  while (start1 < end1 && start2 < end2) {
    if (equals(end1 - 1, end2 - 1)) {
      end1--;
      end2--;
      continue;
    }

    let skipped = false;
    if (ignored1(end1 - 1)) {
      skipped = true;
      end1--;
    }
    if (ignored2(end2 - 1)) {
      skipped = true;
      end2--;
    }
    if (!skipped) {
      break;
    }
  }

  end1 = trimEndPredicate(start1, end1, ignored1);
  end2 = trimEndPredicate(start2, end2, ignored2);

  return [end1, end2];
}
