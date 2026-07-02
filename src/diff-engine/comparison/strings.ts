// Substitutes for the IntelliJ string helpers the diff engine uses
// (com.intellij.openapi.util.text.Strings / StringUtilRt): whitespace here is
// exactly ' ', '\t', '\n' — matching IntelliJ's StringUtil.isWhiteSpace.

const SPACE = 0x20;
const TAB = 0x09;
const LF = 0x0a;

export function isSpaceEnterOrTabCode(charCode: number): boolean {
  return charCode === LF || charCode === TAB || charCode === SPACE;
}

export function isSpaceEnterOrTabAt(text: string, index: number): boolean {
  return isSpaceEnterOrTabCode(text.charCodeAt(index));
}

/** Both strings equal after ignoring every whitespace character on either side. */
export function equalsIgnoreWhitespaces(s1: string, s2: string): boolean {
  let index1 = 0;
  let index2 = 0;
  const len1 = s1.length;
  const len2 = s2.length;

  for (;;) {
    while (index1 < len1 && isSpaceEnterOrTabAt(s1, index1)) {
      index1++;
    }
    while (index2 < len2 && isSpaceEnterOrTabAt(s2, index2)) {
      index2++;
    }
    if (index1 === len1 || index2 === len2) {
      break;
    }
    if (s1[index1] !== s2[index2]) {
      return false;
    }
    index1++;
    index2++;
  }
  return index1 === len1 && index2 === len2;
}

/** Both strings equal after trimming leading/trailing whitespace. */
export function equalsTrimWhitespaces(s1: string, s2: string): boolean {
  let start1 = 0;
  let end1 = s1.length;
  let start2 = 0;
  let end2 = s2.length;

  while (start1 < end1 && isSpaceEnterOrTabAt(s1, start1)) {
    start1++;
  }
  while (start1 < end1 && isSpaceEnterOrTabAt(s1, end1 - 1)) {
    end1--;
  }
  while (start2 < end2 && isSpaceEnterOrTabAt(s2, start2)) {
    start2++;
  }
  while (start2 < end2 && isSpaceEnterOrTabAt(s2, end2 - 1)) {
    end2--;
  }

  if (end1 - start1 !== end2 - start2) {
    return false;
  }
  for (let i = 0; i < end1 - start1; i++) {
    if (s1[start1 + i] !== s2[start2 + i]) {
      return false;
    }
  }
  return true;
}

/** Java String.hashCode over [start, end), with 32-bit overflow semantics. */
export function stringHashCode(text: string, start: number = 0, end: number = text.length): number {
  let h = 0;
  for (let i = start; i < end; i++) {
    h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  }
  return h;
}

/** Java-style hash that skips whitespace characters. */
export function stringHashCodeIgnoreWhitespaces(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (isSpaceEnterOrTabCode(code)) {
      continue;
    }
    h = (Math.imul(31, h) + code) | 0;
  }
  return h;
}
