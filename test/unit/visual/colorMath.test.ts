/**
 * Arithmetic pins for the visual lane's contrast helper.
 *
 * The lane's verdicts are only worth what this maths is worth, and it runs
 * inside a browser where a wrong ratio is indistinguishable from a passing one.
 * These check it against WCAG's published reference values in the fast lane,
 * with no browser involved.
 */

import '../../setup';
import * as assert from 'assert';
import { contrastRatio } from '../../visual/support/assert';

const WHITE = '#ffffff';
const BLACK = '#000000';

describe('visual lane contrast maths', () => {
  it('returns WCAG 21:1 for black on white and 1:1 for identical colours', () => {
    assert.strictEqual(Number(contrastRatio(BLACK, WHITE).toFixed(4)), 21);
    assert.strictEqual(Number(contrastRatio(WHITE, WHITE).toFixed(4)), 1);
    assert.strictEqual(Number(contrastRatio(BLACK, BLACK).toFixed(4)), 1);
  });

  it('is symmetric in its arguments', () => {
    assert.strictEqual(contrastRatio(BLACK, WHITE), contrastRatio(WHITE, BLACK));
  });

  it('straddles the AA threshold at the canonical boundary greys', () => {
    // #767676 is the darkest grey that passes 4.5:1 on white; #777777 is the
    // lightest that fails. If the luminance curve drifts, these flip.
    assert.ok(contrastRatio('#767676', WHITE) >= 4.5);
    assert.ok(contrastRatio('#777777', WHITE) < 4.5);
  });

  it('composites a translucent foreground instead of scoring it opaque', () => {
    // Fully transparent text is invisible: 1:1, not the 21:1 its RGB implies.
    assert.strictEqual(Number(contrastRatio('rgba(0, 0, 0, 0)', WHITE).toFixed(4)), 1);
    // Half-opacity black on white lands between the two extremes.
    const half = contrastRatio('rgba(0, 0, 0, 0.5)', WHITE);
    assert.ok(half > 1 && half < 21, `expected a mid-range ratio, got ${half}`);
  });

  it('parses the colour forms a browser and a token actually produce', () => {
    const fromRgb = contrastRatio('rgb(0, 0, 0)', 'rgb(255, 255, 255)');
    const fromHex = contrastRatio(BLACK, WHITE);
    const fromShortHex = contrastRatio('#000', '#fff');
    const fromSrgb = contrastRatio('color(srgb 0 0 0)', 'color(srgb 1 1 1)');
    for (const [label, value] of [
      ['rgb()', fromRgb],
      ['short hex', fromShortHex],
      ['color(srgb)', fromSrgb],
    ] as const) {
      assert.strictEqual(
        Number(value.toFixed(4)),
        Number(fromHex.toFixed(4)),
        `${label} disagrees`
      );
    }
  });

  it('refuses a colour it cannot parse rather than guessing', () => {
    assert.throws(() => contrastRatio('currentColor', WHITE), /Cannot parse colour/);
  });
});
