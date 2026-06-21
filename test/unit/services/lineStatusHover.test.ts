/**
 * Unit tests for the inline-diff hover popup model (slice F-8b).
 *
 * Pins the pure mapping behind the hover popup IntelliJ shows on a change
 * marker (platform/diff-impl/.../vcs/ex/LineStatusMarkerPopupActions.kt):
 * given a change range + the committed (HEAD) lines, produce the OLD content
 * text for the range and the replacement edit the "Revert this change" action
 * applies (range → old lines). Pure functions — no editor, no git.
 */

import * as assert from 'assert';
import { computeLineStatusRanges, ILineStatusRange } from '../../../src/linestatus/lineStatusDiff';
import {
  buildHoverModel,
  computeRevertEdit,
  renderHoverMarkdown,
} from '../../../src/linestatus/lineStatusHover';

/** Compute the single change range for a head/buffer pair (asserts exactly one). */
function singleRange(head: string, buffer: string): ILineStatusRange {
  const ranges = computeLineStatusRanges(head, buffer);
  assert.strictEqual(ranges.length, 1, `expected one range, got ${ranges.length}`);
  return ranges[0];
}

function headLines(head: string): string[] {
  return head.length === 0 ? [] : head.replace(/\n$/, '').split('\n');
}

describe('lineStatusHover', () => {
  describe('buildHoverModel — old content', () => {
    it('shows the replaced HEAD line for a modified range', () => {
      const head = 'a\nb\nc\n';
      const range = singleRange(head, 'a\nB-CHANGED\nc\n');
      const model = buildHoverModel(range, headLines(head));
      assert.strictEqual(model.kind, 'modified');
      assert.deepStrictEqual(model.oldLines, ['b']);
    });

    it('shows the removed HEAD lines for a deleted range', () => {
      const head = 'a\nb\nc\n';
      const range = singleRange(head, 'a\nc\n');
      const model = buildHoverModel(range, headLines(head));
      assert.strictEqual(model.kind, 'deleted');
      assert.deepStrictEqual(model.oldLines, ['b']);
    });

    it('has no old content for an added range', () => {
      const head = 'a\nb\n';
      const range = singleRange(head, 'a\nX\nb\n');
      const model = buildHoverModel(range, headLines(head));
      assert.strictEqual(model.kind, 'added');
      assert.deepStrictEqual(model.oldLines, []);
    });

    it('shows the full multi-line old block for a modified range', () => {
      const head = 'a\nb\nc\nd\n';
      const range = singleRange(head, 'a\nB2\nC2\nd\n');
      const model = buildHoverModel(range, headLines(head));
      assert.strictEqual(model.kind, 'modified');
      assert.deepStrictEqual(model.oldLines, ['b', 'c']);
    });
  });

  describe('computeRevertEdit — replacement edit', () => {
    it('replaces the modified buffer lines with the old HEAD lines', () => {
      const head = 'a\nb\nc\n';
      const range = singleRange(head, 'a\nB-CHANGED\nc\n');
      assert.deepStrictEqual(computeRevertEdit(range, headLines(head)), {
        startLine: 1,
        endLine: 2,
        lines: ['b'],
      });
    });

    it('deletes the added buffer lines (no old content)', () => {
      const head = 'a\nb\n';
      const range = singleRange(head, 'a\nX\nY\nb\n');
      assert.deepStrictEqual(computeRevertEdit(range, headLines(head)), {
        startLine: 1,
        endLine: 3,
        lines: [],
      });
    });

    it('re-inserts the removed HEAD lines at the deletion point', () => {
      const head = 'a\nb\nc\n';
      const range = singleRange(head, 'a\nc\n');
      assert.deepStrictEqual(computeRevertEdit(range, headLines(head)), {
        startLine: 1,
        endLine: 1,
        lines: ['b'],
      });
    });

    it('re-inserts a trailing deletion at the true end-of-file line (unclamped)', () => {
      // The decoration anchor for a trailing deletion is clamped to the last
      // buffer line; the revert must use the real (unclamped) insertion point.
      const head = 'a\nb\nc\n';
      const range = singleRange(head, 'a\nb\n');
      assert.deepStrictEqual(computeRevertEdit(range, headLines(head)), {
        startLine: 2,
        endLine: 2,
        lines: ['c'],
      });
    });
  });

  describe('renderHoverMarkdown — escaping & links', () => {
    it('HTML-escapes the old content and includes the action links', () => {
      const head = 'x<y>&z\n';
      const range = singleRange(head, 'CHANGED\n');
      const model = buildHoverModel(range, headLines(head));
      const md = renderHoverMarkdown(model, 'command:revert?1', 'command:copy?1');
      assert.ok(md.includes('x&lt;y&gt;&amp;z'), 'old content should be HTML-escaped');
      assert.ok(!md.includes('x<y>'), 'raw angle brackets must not leak through');
      assert.ok(md.includes('command:revert?1'), 'revert link present');
      assert.ok(md.includes('command:copy?1'), 'copy link present');
    });

    it('picks a code fence longer than any backtick run in the old content', () => {
      const head = 'a```b\n';
      const range = singleRange(head, 'CHANGED\n');
      const model = buildHoverModel(range, headLines(head));
      const md = renderHoverMarkdown(model, 'command:revert?1', 'command:copy?1');
      // A triple-backtick fence would be broken by the content's ``` run.
      assert.ok(md.includes('````'), 'fence should be at least 4 backticks');
    });
  });
});
