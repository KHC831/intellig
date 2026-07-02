// Ported from intellij-community platform/diff-impl/tests/testSrc/com/intellij/diff/comparison/LineUplifterTest.kt
// Copyright 2000-2025 JetBrains s.r.o. and contributors. Apache 2.0 license.
//
// The inputs carry expected line blocks inline: [..] marks a changed block, | marks an
// empty block before the current line, > an empty block after it; '_' and '\n' both
// separate lines.

import '../../setup';
import * as assert from 'assert';
import * as ComparisonManager from '../../../src/diff-engine/comparison/ComparisonManager';
import { ComparisonPolicy } from '../../../src/diff-engine/comparison/ComparisonPolicy';
import { LineOffsetsImpl } from '../../../src/diff-engine/text/LineOffsets';
import { CANCELLATION } from './comparisonTestUtil';

const NL = String.fromCharCode(10);
const CH_GUN = String.fromCodePoint(0x1f52b);

type LineRange = readonly [number, number];

function parseUplifterSource(input: string): string {
  return input.replace(/_/g, NL).replace(/[[\]|>]/g, '');
}

function parseUplifterLineRanges(input: string): LineRange[] {
  const result: LineRange[] = [];

  let line = 0;
  let start = -1;
  for (const ch of input) {
    switch (ch) {
      case '[':
        start = line;
        break;
      case ']':
        result.push([start, line + 1]);
        start = -1;
        break;
      case '|':
        result.push([line, line]);
        start = -1;
        break;
      case '>':
        result.push([line + 1, line + 1]);
        start = -1;
        break;
      case '_':
      case NL:
        line++;
        break;
      default:
        break;
    }
  }

  return result;
}

function wordFirst(
  input1: string,
  input2: string,
  policy: ComparisonPolicy = ComparisonPolicy.DEFAULT
): void {
  const text1 = parseUplifterSource(input1);
  const text2 = parseUplifterSource(input2);

  const ranges1 = parseUplifterLineRanges(input1);
  const ranges2 = parseUplifterLineRanges(input2);
  assert.strictEqual(ranges1.length, ranges2.length);
  const expected = ranges1.map((range, i) => [Array.from(range), Array.from(ranges2[i])]);

  const fragments = ComparisonManager.compareLinesWordFirst(
    text1,
    text2,
    LineOffsetsImpl.create(text1),
    LineOffsetsImpl.create(text2),
    policy,
    CANCELLATION
  );

  const actual = fragments.map((f) => [
    [f.startLine1, f.endLine1],
    [f.startLine2, f.endLine2],
  ]);
  assert.deepStrictEqual(actual, expected);
}

describe('diff-engine words-first line uplift (LineUplifterTest)', () => {
  it('simple cases', () => {
    wordFirst('', '');
    wordFirst('X_[Y]_Z', 'X_[A_B]_Z');
    wordFirst('X_[Y]_Z', 'X_|Z');
  });

  it('tricky edge cases', () => {
    wordFirst('_[x]', '_[x ]');

    wordFirst(
      `[a${NL}${CH_GUN}]${NL}|${CH_GUN}${CH_GUN}>`,
      `[b]${NL}[]${NL}${CH_GUN}${CH_GUN}${NL}[${NL}!]`
    );

    wordFirst('X_|_*_Z', 'X_[Y]__*_Z');

    wordFirst('|X_', '[Y_Y]_X_');
  });
});
