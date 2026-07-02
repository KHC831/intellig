// Ported from intellij-community platform/util/diff/src/com/intellij/diff/comparison/ComparisonUtil.kt
// Copyright 2000-2024 JetBrains s.r.o. and contributors. Apache 2.0 license.

import { DiffConfig } from '../diff/DiffConfig';
import { ComparisonPolicy } from './ComparisonPolicy';
import {
  equalsIgnoreWhitespaces,
  equalsTrimWhitespaces as stringEqualsTrimWhitespaces,
  isSpaceEnterOrTabAt,
  stringHashCode,
  stringHashCodeIgnoreWhitespaces,
} from './strings';

export function isEqualTexts(text1: string, text2: string, policy: ComparisonPolicy): boolean {
  switch (policy) {
    case ComparisonPolicy.DEFAULT:
      return text1 === text2;
    case ComparisonPolicy.TRIM_WHITESPACES:
      return equalsTrimWhitespaces(text1, text2);
    case ComparisonPolicy.IGNORE_WHITESPACES:
      return equalsIgnoreWhitespaces(text1, text2);
  }
}

export function comparisonHashCode(text: string, policy: ComparisonPolicy): number {
  switch (policy) {
    case ComparisonPolicy.DEFAULT:
      return stringHashCode(text);
    case ComparisonPolicy.TRIM_WHITESPACES: {
      let offset1 = 0;
      let offset2 = text.length;
      while (offset1 < offset2 && isSpaceEnterOrTabAt(text, offset1)) {
        offset1++;
      }
      while (offset1 < offset2 && isSpaceEnterOrTabAt(text, offset2 - 1)) {
        offset2--;
      }
      return stringHashCode(text, offset1, offset2);
    }
    case ComparisonPolicy.IGNORE_WHITESPACES:
      return stringHashCodeIgnoreWhitespaces(text);
  }
}

/**
 * Unlike the plain trimmed comparison, leading/trailing whitespace of *inner* lines is
 * ignored as well. E.g. "\nXY\n" and "\n XY \n" are equal, "\nXY\n" and "\nX Y\n" are not.
 */
export function equalsTrimWhitespaces(s1: string, s2: string): boolean {
  let index1 = 0;
  let index2 = 0;

  for (;;) {
    let lastLine1 = false;
    let lastLine2 = false;

    let end1 = s1.indexOf('\n', index1) + 1;
    let end2 = s2.indexOf('\n', index2) + 1;
    if (end1 === 0) {
      end1 = s1.length;
      lastLine1 = true;
    }
    if (end2 === 0) {
      end2 = s2.length;
      lastLine2 = true;
    }
    if (lastLine1 !== lastLine2) {
      return false;
    }

    const line1 = s1.substring(index1, end1);
    const line2 = s2.substring(index2, end2);
    if (!stringEqualsTrimWhitespaces(line1, line2)) {
      return false;
    }

    index1 = end1;
    index2 = end2;
    if (lastLine1) {
      return true;
    }
  }
}

export function getUnimportantLineCharCount(): number {
  return DiffConfig.UNIMPORTANT_LINE_CHAR_COUNT;
}
