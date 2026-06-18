/**
 * Unit tests for the buffer-vs-HEAD line-status diff (slice A-2).
 *
 * Pins the per-line change-range model behind the live changed-line gutter,
 * mirroring IntelliJ's LineStatusTracker Range semantics (INSERTED / DELETED /
 * MODIFIED, expressed in current-document line coordinates):
 *
 *   - added lines  → 'added' range covering the new buffer lines
 *   - replaced lines → 'modified' range covering the new buffer lines
 *   - removed lines  → 'deleted' range anchored to the adjacent buffer line
 *   - unchanged buffer → no ranges
 *
 * Pure mapping function — no editor, no git.
 */

import * as assert from 'assert';
import {
  computeLineStatusRanges,
  ILineStatusRange,
  MAX_TRACKED_LINES,
  MAX_DIFF_CELLS,
} from '../../../linestatus/lineStatusDiff';

describe('computeLineStatusRanges', () => {
  it('returns no ranges when buffer matches HEAD', () => {
    const content = 'a\nb\nc\n';
    assert.deepStrictEqual(computeLineStatusRanges(content, content), []);
  });

  it('maps an inserted line to an added range at the new buffer line', () => {
    const head = 'a\nb\nc\n';
    const buffer = 'a\nNEW\nb\nc\n';
    assert.deepStrictEqual(computeLineStatusRanges(head, buffer), [
      { kind: 'added', start: 1, end: 1, bufStart: 1, bufEnd: 2, vcsStart: 1, vcsEnd: 1 },
    ]);
  });

  it('maps consecutive inserts to a single multi-line added range', () => {
    const head = 'a\nb\n';
    const buffer = 'a\nX\nY\nZ\nb\n';
    assert.deepStrictEqual(computeLineStatusRanges(head, buffer), [
      { kind: 'added', start: 1, end: 3, bufStart: 1, bufEnd: 4, vcsStart: 1, vcsEnd: 1 },
    ]);
  });

  it('maps a replaced line to a modified range', () => {
    const head = 'a\nb\nc\n';
    const buffer = 'a\nB-CHANGED\nc\n';
    assert.deepStrictEqual(computeLineStatusRanges(head, buffer), [
      { kind: 'modified', start: 1, end: 1, bufStart: 1, bufEnd: 2, vcsStart: 1, vcsEnd: 2 },
    ]);
  });

  it('maps a removed line to a deleted range anchored to the adjacent buffer line', () => {
    const head = 'a\nb\nc\n';
    const buffer = 'a\nc\n';
    assert.deepStrictEqual(computeLineStatusRanges(head, buffer), [
      { kind: 'deleted', start: 1, end: 1, bufStart: 1, bufEnd: 1, vcsStart: 1, vcsEnd: 2 },
    ]);
  });

  it('anchors a trailing deletion to the last buffer line', () => {
    const head = 'a\nb\nc\n';
    const buffer = 'a\nb\n';
    const ranges = computeLineStatusRanges(head, buffer);
    assert.strictEqual(ranges.length, 1);
    assert.strictEqual(ranges[0].kind, 'deleted');
    assert.strictEqual(ranges[0].start, 1);
  });

  it('reports independent ranges across the file in ascending order', () => {
    const head = 'a\nb\nc\nd\ne\n';
    // insert before a, modify c, delete e
    const buffer = 'TOP\na\nb\nC2\nd\n';
    const ranges = computeLineStatusRanges(head, buffer);
    const kinds = ranges.map((r: ILineStatusRange) => r.kind);
    assert.deepStrictEqual(kinds, ['added', 'modified', 'deleted']);
    // ascending by start
    for (let i = 1; i < ranges.length; i++) {
      assert.ok(ranges[i].start >= ranges[i - 1].start);
    }
  });

  it('treats an added file (empty HEAD) as a single added range over all lines', () => {
    const head = '';
    const buffer = 'x\ny\nz\n';
    assert.deepStrictEqual(computeLineStatusRanges(head, buffer), [
      { kind: 'added', start: 0, end: 2, bufStart: 0, bufEnd: 3, vcsStart: 0, vcsEnd: 0 },
    ]);
  });

  it('treats an emptied file as a single deleted range at line 0', () => {
    const head = 'x\ny\nz\n';
    const buffer = '';
    assert.deepStrictEqual(computeLineStatusRanges(head, buffer), [
      { kind: 'deleted', start: 0, end: 0, bufStart: 0, bufEnd: 0, vcsStart: 0, vcsEnd: 3 },
    ]);
  });

  it('skips the diff (returns no ranges) when a side exceeds the line cap', () => {
    // A buffer one line over the cap, against an empty HEAD: without the guard
    // this would be a huge added range; with it, we paint nothing.
    const buffer = `${'x\n'.repeat(MAX_TRACKED_LINES + 1)}`;
    assert.deepStrictEqual(computeLineStatusRanges('', buffer), []);
    // Also when HEAD is the oversized side.
    assert.deepStrictEqual(computeLineStatusRanges(buffer, 'x\n'), []);
  });

  it('skips the diff when the LCS table would exceed the cell cap, even with both sides under the line cap', () => {
    // 5000 x 5000 = 25M cells > MAX_DIFF_CELLS, yet each side is under
    // MAX_TRACKED_LINES — so only the product cap catches it. Without that cap
    // the dp table would allocate ~25M cells synchronously on the ext host.
    const n = 5000;
    assert.ok(n < MAX_TRACKED_LINES, 'sides must be under the per-side cap for this test');
    assert.ok(n * n > MAX_DIFF_CELLS, 'product must exceed the cell cap for this test');
    const head = `${Array.from({ length: n }, (_, i) => `a${i}`).join('\n')}\n`;
    const buffer = `${Array.from({ length: n }, (_, i) => `b${i}`).join('\n')}\n`;
    assert.deepStrictEqual(computeLineStatusRanges(head, buffer), []);
  });

  it('still diffs a file right at the line cap', () => {
    // Exactly MAX_TRACKED_LINES lines is within bounds and diffs normally.
    const lines = Array.from({ length: MAX_TRACKED_LINES }, (_, i) => `L${i}`);
    const head = `${lines.join('\n')}\n`;
    const buffer = [...lines];
    buffer[0] = 'CHANGED';
    const ranges = computeLineStatusRanges(head, `${buffer.join('\n')}\n`);
    assert.deepStrictEqual(ranges, [
      { kind: 'modified', start: 0, end: 0, bufStart: 0, bufEnd: 1, vcsStart: 0, vcsEnd: 1 },
    ]);
  });
});
