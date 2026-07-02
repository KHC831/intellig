// Ported from intellij-community platform/diff-impl/tests/testSrc/com/intellij/diff/comparison/ComparisonUtilTest.kt
// Copyright 2000-2020 JetBrains s.r.o. Apache 2.0 license.

import '../../setup';
import * as assert from 'assert';
import * as ComparisonManager from '../../../src/diff-engine/comparison/ComparisonManager';
import { ComparisonPolicy } from '../../../src/diff-engine/comparison/ComparisonPolicy';
import { isEqualTexts } from '../../../src/diff-engine/comparison/ComparisonUtil';
import { CANCELLATION, parseSource } from './comparisonTestUtil';

const NL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);

function doTestTrim(expected: boolean, string1: string, string2: string): void {
  const result = isEqualTexts(string1, string2, ComparisonPolicy.TRIM_WHITESPACES);
  assert.strictEqual(result, expected, `---${NL}${string1}${NL}---${NL}${string2}${NL}---`);
}

function doTestLineFragment(
  string1: string,
  string2: string,
  offsets1: readonly [number, number],
  offsets2: readonly [number, number],
  lines1: readonly [number, number],
  lines2: readonly [number, number]
): void {
  const fragments = ComparisonManager.compareLines(
    parseSource(string1),
    parseSource(string2),
    ComparisonPolicy.DEFAULT,
    CANCELLATION
  );
  assert.strictEqual(fragments.length, 1, `fragments: ${fragments.length}`);
  const fragment = fragments[0];

  const message = `fragment lines [${fragment.startLine1}, ${fragment.endLine1}) - [${fragment.startLine2}, ${fragment.endLine2})`;
  assert.strictEqual(fragment.startOffset1, offsets1[0], message);
  assert.strictEqual(fragment.endOffset1, offsets1[1], message);
  assert.strictEqual(fragment.startOffset2, offsets2[0], message);
  assert.strictEqual(fragment.endOffset2, offsets2[1], message);
  assert.strictEqual(fragment.startLine1, lines1[0], message);
  assert.strictEqual(fragment.endLine1, lines1[1], message);
  assert.strictEqual(fragment.startLine2, lines2[0], message);
  assert.strictEqual(fragment.endLine2, lines2[1], message);
}

describe('diff-engine text equality and single line fragments (ComparisonUtilTest)', () => {
  it('trim equals', () => {
    doTestTrim(true, '', '');
    doTestTrim(true, '', '   ');
    doTestTrim(true, '   ', '   ');
    doTestTrim(true, `${NL}   `, `  ${NL}`);
    doTestTrim(true, 'asd ', 'asd  ');
    doTestTrim(true, '    asd', 'asd');
    doTestTrim(true, `${NL}${NL}${NL}`, `${NL}${NL}${NL}`);
    doTestTrim(true, `${NL}  ${NL}  ${NL} `, `  ${NL} ${NL}${NL}  `);
    doTestTrim(false, `${NL}${NL}`, `${NL}${NL}${NL}`);

    doTestTrim(false, `${NL}asd `, `asd${NL}  `);
    doTestTrim(true, `${NL}asd ${NL}`, `${NL} asd${NL}  `);
    doTestTrim(false, 'x', 'y');
    doTestTrim(false, NL, ' ');

    doTestTrim(true, `${TAB} `, '');
    doTestTrim(false, '', `${TAB}${NL} ${NL}${TAB}`);
    doTestTrim(false, TAB, NL);

    doTestTrim(true, 'x', ' x');
    doTestTrim(true, 'x', 'x ');
    doTestTrim(false, `x${NL}`, 'x');

    doTestTrim(false, 'abc', `a${NL}b${NL}c${NL}`);
    doTestTrim(true, `${NL}x y x${NL}`, `${NL}x y x${NL}`);
    doTestTrim(false, `${NL}xyx${NL}`, `${NL}x y x${NL}`);
    doTestTrim(true, `${NL}x y x`, `${NL}x y x`);
    doTestTrim(false, `${NL}xyx`, `${NL}x y x`);
    doTestTrim(true, 'x y x', 'x y x');
    doTestTrim(false, 'xyx', 'x y x');
    doTestTrim(true, '  x y x  ', 'x y x');

    doTestTrim(false, 'x', `${TAB}${NL} `);
    doTestTrim(false, '', ' x ');
    doTestTrim(false, '', 'x ');
    doTestTrim(false, '', ' x');
    doTestTrim(false, 'xyx', 'xxx');
    doTestTrim(false, 'xyx', 'xYx');
  });

  it('line fragment', () => {
    doTestLineFragment('', 'x', [0, 0], [0, 1], [0, 1], [0, 1]);
    doTestLineFragment('x', 'y', [0, 1], [0, 1], [0, 1], [0, 1]);
    doTestLineFragment('x_', 'y_', [0, 2], [0, 2], [0, 1], [0, 1]);
    doTestLineFragment('x', 'y_', [0, 1], [0, 2], [0, 1], [0, 2]);
    doTestLineFragment('x', 'x_', [1, 1], [2, 2], [1, 1], [1, 2]);
    doTestLineFragment('x_y_z_', 'x_Y_z_', [2, 4], [2, 4], [1, 2], [1, 2]);
    doTestLineFragment('x_y_z_', 'x_y_Z_', [4, 6], [4, 6], [2, 3], [2, 3]);
    doTestLineFragment('x_y_z_', 'x_y_Z', [4, 6], [4, 5], [2, 4], [2, 3]);
    doTestLineFragment('x_y_z', 'x_y_Z_', [4, 5], [4, 6], [2, 3], [2, 4]);
    doTestLineFragment(' ', '_ ', [0, 0], [0, 1], [0, 0], [0, 1]);
    doTestLineFragment(' ', ' _', [1, 1], [2, 2], [1, 1], [1, 2]);
  });
});
