// Ported from intellij-community platform/util/diff/src/com/intellij/diff/comparison/CharacterUtils.kt
// Copyright 2000-2025 JetBrains s.r.o. and contributors. Apache 2.0 license.
//
// The upstream file embeds Unicode range tables extracted from PropList.txt/Scripts.txt;
// here the same character classes come from JavaScript's built-in Unicode property
// escapes, which track the same UCD properties.

/** Returns the Unicode code point at the specified index (handles surrogate pairs). */
export function codePointAtIndex(text: string, index: number): number {
  return text.codePointAt(index) as number;
}

/** Number of UTF-16 code units the code point occupies. */
export function charCount(codePoint: number): number {
  return codePoint >= 0x10000 ? 2 : 1;
}

const ALPHABETIC = /^\p{Alphabetic}$/u;
const IDEOGRAPHIC = /^\p{Ideographic}$/u;
const HIRAGANA = /^\p{Script=Hiragana}$/u;
const KATAKANA = /^\p{Script=Katakana}$/u;
const THAI = /^\p{Script=Thai}$/u;
const JAVANESE = /^\p{Script=Javanese}$/u;
const DECIMAL_DIGIT = /^\p{Nd}$/u;

export function isAlphabetic(codePoint: number): boolean {
  return ALPHABETIC.test(String.fromCodePoint(codePoint));
}

export function isIdeographic(codePoint: number): boolean {
  return IDEOGRAPHIC.test(String.fromCodePoint(codePoint));
}

export function isBmpCodePoint(codePoint: number): boolean {
  return codePoint >>> 16 === 0;
}

export function isHiraganaScript(codePoint: number): boolean {
  return HIRAGANA.test(String.fromCodePoint(codePoint));
}

export function isKatakanaScript(codePoint: number): boolean {
  return KATAKANA.test(String.fromCodePoint(codePoint));
}

export function isThaiScript(codePoint: number): boolean {
  return THAI.test(String.fromCodePoint(codePoint));
}

export function isJavaneseScript(codePoint: number): boolean {
  return JAVANESE.test(String.fromCodePoint(codePoint));
}

export function isDecimalDigit(codePoint: number): boolean {
  return DECIMAL_DIGIT.test(String.fromCodePoint(codePoint));
}
