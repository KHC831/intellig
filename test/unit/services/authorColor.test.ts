/**
 * Unit tests for the blame AUTHOR color-mode helper.
 *
 * IntelliJ's annotation gutter AUTHOR mode (AnnotateToggleAction.computeBgColors,
 * AUTHOR branch) assigns each line a stable per-author color: the distinct
 * authors of the file are sorted and the author at sorted index `i` is given
 * `palette[i % palette.length]`. These tests pin that contract:
 *
 *   - the palette is deterministic across calls (no per-session randomness)
 *   - assignment follows the sorted-author index, not input order
 *   - the same author + same author set always yields the same color
 *   - more authors than palette entries wrap around by modulo
 *   - an author absent from the supplied set is still colored deterministically
 *   - colors are valid CSS rgba() strings carrying AUTHOR_BG_ALPHA
 */

import * as assert from 'assert';
import {
  AUTHOR_BG_ALPHA,
  authorColorPalette,
  buildAuthorColorMap,
  computeAuthorColor,
} from '../../../src/blame/authorColor';
import { parseHeatRgba } from '../../../src/blame/heatColor';

describe('authorColorPalette', () => {
  it('returns a non-empty list of valid CSS rgba() strings', () => {
    const palette = authorColorPalette();
    assert.ok(palette.length > 0, 'palette should not be empty');
    for (const color of palette) {
      assert.match(color, /^rgba\(\d+,\s*\d+,\s*\d+,\s*[\d.]+\)$/);
    }
  });

  it('carries AUTHOR_BG_ALPHA on every entry', () => {
    for (const color of authorColorPalette()) {
      assert.strictEqual(parseHeatRgba(color).a, AUTHOR_BG_ALPHA);
    }
  });

  it('is deterministic across calls (no per-session randomness)', () => {
    assert.deepStrictEqual(authorColorPalette(), authorColorPalette());
  });

  it('contains only distinct colors within a single anchor-derived palette', () => {
    const palette = authorColorPalette();
    const unique = new Set(palette);
    assert.strictEqual(unique.size, palette.length, 'palette entries should be distinct');
  });
});

describe('buildAuthorColorMap', () => {
  it('assigns colors by sorted-author index, independent of input order', () => {
    const palette = authorColorPalette();
    const map = buildAuthorColorMap(['Charlie', 'Alice', 'Bob']);
    // Sorted order is Alice, Bob, Charlie → palette[0], [1], [2].
    assert.strictEqual(map.get('Alice'), palette[0]);
    assert.strictEqual(map.get('Bob'), palette[1]);
    assert.strictEqual(map.get('Charlie'), palette[2]);
  });

  it('produces the same mapping regardless of input ordering', () => {
    const a = buildAuthorColorMap(['Zoe', 'Anna', 'Mike']);
    const b = buildAuthorColorMap(['Mike', 'Zoe', 'Anna']);
    assert.deepStrictEqual([...a.entries()].sort(), [...b.entries()].sort());
  });

  it('collapses duplicate authors to a single entry', () => {
    const map = buildAuthorColorMap(['Alice', 'Alice', 'Bob']);
    assert.strictEqual(map.size, 2);
  });

  it('wraps around to palette[0] when authors exceed the palette size', () => {
    const palette = authorColorPalette();
    // Generate sorted author names a0001, a0002, ... so index ordering is known.
    const count = palette.length + 1;
    const authors = Array.from({ length: count }, (_, i) => `a${String(i).padStart(4, '0')}`);
    const map = buildAuthorColorMap(authors);
    // The (palette.length)-th sorted author reuses palette[0].
    assert.strictEqual(map.get(authors[palette.length]), palette[0]);
  });
});

describe('computeAuthorColor', () => {
  it('returns the same color for the same author + author set', () => {
    const authors = ['Alice', 'Bob', 'Charlie'];
    assert.strictEqual(computeAuthorColor('Bob', authors), computeAuthorColor('Bob', authors));
  });

  it('agrees with buildAuthorColorMap for an author in the set', () => {
    const authors = ['Alice', 'Bob', 'Charlie'];
    const map = buildAuthorColorMap(authors);
    assert.strictEqual(computeAuthorColor('Charlie', authors), map.get('Charlie'));
  });

  it('colors an author absent from the supplied set deterministically', () => {
    // 'Aaron' sorts before everyone → folded in at index 0.
    const color = computeAuthorColor('Aaron', ['Bob', 'Charlie']);
    assert.strictEqual(color, authorColorPalette()[0]);
  });

  it('returns a valid rgba() string carrying AUTHOR_BG_ALPHA', () => {
    const color = computeAuthorColor('Bob', ['Alice', 'Bob']);
    assert.match(color, /^rgba\(\d+,\s*\d+,\s*\d+,\s*[\d.]+\)$/);
    assert.strictEqual(parseHeatRgba(color).a, AUTHOR_BG_ALPHA);
  });
});
