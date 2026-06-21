import * as assert from 'assert';
import { applyTextPatch } from '../../../src/patches/applyTextPatch';
import { parseDiff } from '../../../src/git-core/gitParser';
import { IDiff } from '../../../src/git-core/interfaces/IGitService';

/**
 * Unit tests for applyTextPatch — the pure helper that reconstructs the
 * "after" (shelved) content of a file from its base content plus a parsed
 * unified diff. Drives the shelf "Compare with Local" left-hand side.
 *
 * Each test feeds a real `git diff`-shaped patch through parseDiff so the
 * helper is exercised against the exact IDiff shape production code passes it.
 */
describe('applyTextPatch', () => {
  /** parseDiff a single-file patch and return its one IDiff. */
  function singleDiff(patch: string): IDiff {
    const diffs = parseDiff(patch);
    assert.strictEqual(diffs.length, 1, 'expected exactly one parsed file diff');
    return diffs[0];
  }

  it('reconstructs a modified line in the middle of a file', () => {
    const base = 'line1\nline2\nline3\n';
    const patch = [
      'diff --git a/f.txt b/f.txt',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1,3 +1,3 @@',
      ' line1',
      '-line2',
      '+line2-modified',
      ' line3',
      '',
    ].join('\n');

    const result = applyTextPatch(base, singleDiff(patch));

    assert.strictEqual(result, 'line1\nline2-modified\nline3\n');
  });

  it('reconstructs an added file from an all-additions patch with empty base', () => {
    const patch = [
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1,2 @@',
      '+alpha',
      '+beta',
      '',
    ].join('\n');

    const result = applyTextPatch('', singleDiff(patch));

    assert.strictEqual(result, 'alpha\nbeta\n');
  });

  it('reconstructs a deleted file as empty content', () => {
    const base = 'x\ny\n';
    const patch = [
      'diff --git a/gone.txt b/gone.txt',
      'deleted file mode 100644',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-x',
      '-y',
      '',
    ].join('\n');

    const result = applyTextPatch(base, singleDiff(patch));

    assert.strictEqual(result, '');
  });

  it('applies multiple non-adjacent hunks against the untouched base in between', () => {
    const base = 'a\nb\nc\nd\ne\nf\n';
    const patch = [
      'diff --git a/m.txt b/m.txt',
      '--- a/m.txt',
      '+++ b/m.txt',
      '@@ -1,2 +1,2 @@',
      '-a',
      '+A',
      ' b',
      '@@ -5,2 +5,2 @@',
      ' e',
      '-f',
      '+F',
      '',
    ].join('\n');

    const result = applyTextPatch(base, singleDiff(patch));

    // Hunk 1 changes a→A; lines c,d are untouched base; hunk 2 changes f→F.
    assert.strictEqual(result, 'A\nb\nc\nd\ne\nF\n');
  });

  it('appends new lines added at the end of a file', () => {
    const base = 'first\n';
    const patch = [
      'diff --git a/append.txt b/append.txt',
      '--- a/append.txt',
      '+++ b/append.txt',
      '@@ -1 +1,2 @@',
      ' first',
      '+second',
      '',
    ].join('\n');

    const result = applyTextPatch(base, singleDiff(patch));

    assert.strictEqual(result, 'first\nsecond\n');
  });

  it('returns the base unchanged when the diff carries no hunks', () => {
    const base = 'untouched\ncontent\n';
    const diff: IDiff = {
      path: 'b.txt',
      status: 'modified',
      hunks: [],
      binary: false,
    };

    const result = applyTextPatch(base, diff);

    assert.strictEqual(result, base);
  });
});
