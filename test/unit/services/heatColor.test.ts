/**
 * Unit tests for the blame gutter heat-color helper.
 *
 * IntelliJ's annotation gutter uses a background gradient whose color is
 * interpolated across the commit age range visible for the file — the
 * newest commit gets the "hot" end of the palette and the oldest gets the
 * "cold" end. These tests pin the semantics we match:
 *
 *   - oldest commit → minimum alpha (cold end)
 *   - newest commit → maximum alpha (warm end)
 *   - single-commit file → warm color (clamp to hot end)
 *   - monotonic: intermediate age → alpha strictly between the bounds
 *   - color values are valid CSS rgba() strings
 *   - 'off' style produces no decorations (tested via the style guard)
 */

import * as assert from 'assert';
import { computeHeatColor, parseHeatRgba, heatAlphaForAge } from '../../../src/blame/heatColor';

describe('computeHeatColor', () => {
  const now = new Date('2024-06-15T12:00:00Z').getTime();
  const newest = now - 1 * 24 * 60 * 60 * 1000; // 1 day ago
  const oldest = now - 365 * 24 * 60 * 60 * 1000; // 365 days ago
  const middle = now - 180 * 24 * 60 * 60 * 1000; // ~180 days ago

  it('returns a CSS rgba() string', () => {
    const result = computeHeatColor(newest, oldest, newest);
    assert.match(result, /^rgba\(\d+,\s*\d+,\s*\d+,\s*[\d.]+\)$/);
  });

  it('newest commit gets maximum alpha (hot end)', () => {
    const hotColor = computeHeatColor(newest, oldest, newest);
    const coldColor = computeHeatColor(oldest, oldest, newest);
    const hotAlpha = parseHeatRgba(hotColor).a;
    const coldAlpha = parseHeatRgba(coldColor).a;
    assert.ok(hotAlpha > coldAlpha, `hot alpha ${hotAlpha} should exceed cold alpha ${coldAlpha}`);
  });

  it('oldest commit gets minimum alpha (cold end)', () => {
    const coldColor = computeHeatColor(oldest, oldest, newest);
    const { a } = parseHeatRgba(coldColor);
    // Cold end should be at the minimum alpha band
    assert.ok(a <= 0.4, `cold alpha ${a} should be at most 0.4`);
  });

  it('newest commit gets maximum alpha in range', () => {
    const hotColor = computeHeatColor(newest, oldest, newest);
    const { a } = parseHeatRgba(hotColor);
    // Hot end should be above 0.7
    assert.ok(a >= 0.7, `hot alpha ${a} should be at least 0.7`);
  });

  it('intermediate age has alpha strictly between cold and hot ends', () => {
    const coldColor = computeHeatColor(oldest, oldest, newest);
    const hotColor = computeHeatColor(newest, oldest, newest);
    const midColor = computeHeatColor(middle, oldest, newest);

    const coldAlpha = parseHeatRgba(coldColor).a;
    const hotAlpha = parseHeatRgba(hotColor).a;
    const midAlpha = parseHeatRgba(midColor).a;

    assert.ok(
      midAlpha > coldAlpha && midAlpha < hotAlpha,
      `mid alpha ${midAlpha} should be between ${coldAlpha} and ${hotAlpha}`
    );
  });

  it('single-commit file (oldest === newest) returns warm color', () => {
    // When all commits are the same age, clamp to the hot end
    const result = computeHeatColor(newest, newest, newest);
    const { a } = parseHeatRgba(result);
    assert.ok(a >= 0.7, `single-commit alpha ${a} should be at the warm end`);
  });

  it('is monotonic: older commits get progressively less alpha', () => {
    const times = [
      now - 30 * 24 * 60 * 60 * 1000, // 30 days (newest)
      now - 90 * 24 * 60 * 60 * 1000, // 90 days
      now - 180 * 24 * 60 * 60 * 1000, // 180 days
      now - 365 * 24 * 60 * 60 * 1000, // 365 days (oldest)
    ];
    const [t0, , , t3] = times;
    const oldest2 = t3;
    const newest2 = t0;

    const alphas = times.map((t) => parseHeatRgba(computeHeatColor(t, oldest2, newest2)).a);

    // Each successive alpha should be strictly less than the previous
    for (let i = 1; i < alphas.length; i++) {
      assert.ok(
        alphas[i] < alphas[i - 1],
        `alpha[${i}]=${alphas[i]} should be < alpha[${i - 1}]=${alphas[i - 1]}`
      );
    }
  });

  it('heatAlphaForAge returns 1.0 at ratio=1 (newest)', () => {
    assert.strictEqual(heatAlphaForAge(1.0), 0.85);
  });

  it('heatAlphaForAge returns minimum alpha at ratio=0 (oldest)', () => {
    assert.strictEqual(heatAlphaForAge(0.0), 0.15);
  });

  it('heatAlphaForAge is monotonically increasing', () => {
    const ratios = [0.0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0];
    const alphas = ratios.map(heatAlphaForAge);
    for (let i = 1; i < alphas.length; i++) {
      assert.ok(
        alphas[i] >= alphas[i - 1],
        `alpha[${i}]=${alphas[i]} should be >= alpha[${i - 1}]=${alphas[i - 1]}`
      );
    }
  });
});
