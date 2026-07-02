// Ported from intellij-community platform/diff-impl/tests/testSrc/com/intellij/diff/comparison/TrimUtilTest.kt
// Copyright 2000-2015 JetBrains s.r.o. Apache 2.0 license.

import '../../setup';
import * as assert from 'assert';
import {
  isAlpha,
  isContinuousScript,
  isPunctuationCode,
} from '../../../src/diff-engine/comparison/TrimUtil';

const BACKSLASH = String.fromCharCode(92);
const PUNCTUATION = '(){}[],./?`~!@#$%^&*-=+|' + BACKSLASH + ';:\'"<>';

const CH_SMILE = String.fromCodePoint(0x1f602);
const CH_MAN = String.fromCodePoint(0x1f9d2);
const CR = String.fromCharCode(13);
const CTRL_A = String.fromCharCode(1);
// Left-to-right mark, right-to-left mark, Arabic letter mark (format characters)
const DIRECTION_MARKS = String.fromCodePoint(0x200e, 0x200f, 0x061c);

function codePoints(text: string): number[] {
  return [...text].map((s) => s.codePointAt(0) as number);
}

function assertIsAlpha(text: string, expected: boolean): void {
  for (const cp of codePoints(text)) {
    assert.strictEqual(isAlpha(cp), expected, `${cp} - ${String.fromCodePoint(cp)}`);
  }
}

function assertIsContinuous(text: string, expected: boolean): void {
  for (const cp of codePoints(text)) {
    assert.strictEqual(isContinuousScript(cp), expected, `${cp} - ${String.fromCodePoint(cp)}`);
  }
}

describe('diff-engine TrimUtil (TrimUtilTest)', () => {
  it('punctuation', () => {
    for (let c = 0; c <= 0xffff; c++) {
      assert.strictEqual(
        isPunctuationCode(c),
        PUNCTUATION.includes(String.fromCharCode(c)),
        `'${String.fromCharCode(c)}' - ${c}`
      );
    }
  });

  it('continuous script', () => {
    assertIsAlpha('!? \t\n+~', false);

    assertIsAlpha('AB12', true);
    assertIsAlpha('АБВ汉语日ひรไ', true);
    assertIsAlpha('óèäñĀ', true);
    assertIsAlpha(CR + '_' + CTRL_A, true);
    assertIsAlpha(CH_SMILE + CH_MAN, true);

    assertIsContinuous('12_ABZ', false);
    assertIsContinuous('АБВ', false);
    assertIsContinuous('ʁit', false);
    assertIsContinuous('음훈', false);
    assertIsContinuous('óèäñĀ', false);
    assertIsContinuous(CR + '_' + CTRL_A, false);

    assertIsContinuous('象形文字', true);
    assertIsContinuous('อักษรไ', true);
    assertIsContinuous('ひらがなカタカナ日本語', true);
    assertIsContinuous('汉语漢語', true);
    assertIsContinuous('☺♥', true);
    assertIsContinuous(CH_SMILE + CH_MAN, true);
    assertIsContinuous(DIRECTION_MARKS, true);
  });
});
