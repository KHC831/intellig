import * as assert from 'assert';
import { buildOrderColorMap, orderColorPalette } from '../../../src/blame/heatColor';

describe('buildOrderColorMap — per-commit categorical colors', () => {
  it('assigns the same color to every line of the same commit', () => {
    const map = buildOrderColorMap([
      { commit: 'a', dateMs: 1000 },
      { commit: 'b', dateMs: 2000 },
      { commit: 'a', dateMs: 1000 },
    ]);
    assert.ok(map.get('a'));
    assert.strictEqual(map.get('a'), map.get('a'));
  });

  it('gives DISTINCT colors to distinct commits (adjacent commits differ)', () => {
    const map = buildOrderColorMap([
      { commit: 'a', dateMs: 1000 },
      { commit: 'b', dateMs: 1001 }, // 1ms apart — a timestamp gradient would collapse these
      { commit: 'c', dateMs: 1002 },
    ]);
    const colors = new Set([map.get('a'), map.get('b'), map.get('c')]);
    assert.strictEqual(
      colors.size,
      3,
      `expected 3 distinct colors, got ${[...colors].join(' / ')}`
    );
  });

  it('assigns palette entries by age rank (oldest → first palette entry)', () => {
    const palette = orderColorPalette();
    const map = buildOrderColorMap([
      { commit: 'new', dateMs: 9000 },
      { commit: 'old', dateMs: 1000 },
      { commit: 'mid', dateMs: 5000 },
    ]);
    assert.strictEqual(map.get('old'), palette[0], 'oldest commit gets palette[0]');
    assert.strictEqual(map.get('mid'), palette[1]);
    assert.strictEqual(map.get('new'), palette[2]);
  });

  it('cycles the palette when commits exceed its length', () => {
    const palette = orderColorPalette();
    const lines = Array.from({ length: palette.length + 1 }, (_, i) => ({
      commit: `c${i}`,
      dateMs: 1000 + i,
    }));
    const map = buildOrderColorMap(lines);
    // The (palette.length)-th commit wraps back to palette[0].
    assert.strictEqual(map.get(`c${palette.length}`), palette[0]);
  });

  it('uses a human-friendly palette — no amber/brown heat ramp', () => {
    // Every palette entry is a translucent rgba() with the gentle ORDER alpha.
    for (const color of orderColorPalette()) {
      assert.match(color, /^rgba\(\d+, \d+, \d+, 0\.35\)$/, `unexpected palette color: ${color}`);
    }
  });

  it('colors a single-commit file without error', () => {
    const map = buildOrderColorMap([{ commit: 'solo', dateMs: 1000 }]);
    assert.ok(map.get('solo'));
  });
});
