/**
 * Unit tests for panel layout utility functions.
 *
 * Tests cover:
 * - clampPanelWidths basic behavior
 * - Minimum width enforcement (100px per panel)
 * - Sum preservation (widths sum to container width)
 * - Edge cases (small containers, negative widths, zero widths)
 */

import * as assert from 'assert';
import {
  clampPanelWidths,
  clampPanelWidthRatios,
  savePanelWidths,
  loadPanelWidths,
  DEFAULT_PANEL_WIDTHS,
} from '../../../src/utils/panelLayout';

/**
 * Creates a mock VS Code Memento (workspace state) for testing.
 * Stores values in an in-memory Map.
 */
function createMockMemento(): import('vscode').Memento {
  const store = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue?: T): T | undefined {
      if (store.has(key)) {
        return store.get(key) as T;
      }
      return defaultValue;
    },
    update(key: string, value: unknown): Promise<void> {
      store.set(key, value);
      return Promise.resolve();
    },
    keys(): readonly string[] {
      return Array.from(store.keys());
    },
  } as import('vscode').Memento;
}

describe('clampPanelWidthRatios', () => {
  it('passes valid in-band ratios through unchanged', () => {
    assert.deepStrictEqual(clampPanelWidthRatios([60, 40]), [60, 40]);
    assert.deepStrictEqual(clampPanelWidthRatios([55, 45]), [55, 45]);
    assert.deepStrictEqual(clampPanelWidthRatios([90, 10]), [90, 10]);
  });

  it('clamps a layout-bricking [100, 0] into the valid band, summing to 100', () => {
    const [a, b] = clampPanelWidthRatios([100, 0]);
    assert.deepStrictEqual([a, b], [90, 10]);
  });

  it('clamps the symmetric [0, 100] case', () => {
    assert.deepStrictEqual(clampPanelWidthRatios([0, 100]), [10, 90]);
  });

  it('re-normalises off-100 totals to percentages summing to 100', () => {
    // 3:1 ratio → 75/25 regardless of the absolute scale.
    assert.deepStrictEqual(clampPanelWidthRatios([600, 200]), [75, 25]);
  });

  it('falls back to defaults for non-finite or non-positive input', () => {
    assert.deepStrictEqual(clampPanelWidthRatios([NaN, 50]), DEFAULT_PANEL_WIDTHS);
    assert.deepStrictEqual(clampPanelWidthRatios([0, 0]), DEFAULT_PANEL_WIDTHS);
    assert.deepStrictEqual(clampPanelWidthRatios([-10, -10]), DEFAULT_PANEL_WIDTHS);
  });

  it('always returns a tuple within [10, 90] that sums to 100', () => {
    for (const input of [
      [100, 0],
      [0, 100],
      [95, 5],
      [5, 95],
      [1000, 1],
    ] as [number, number][]) {
      const [a, b] = clampPanelWidthRatios(input);
      assert.ok(a >= 10 && a <= 90, `first ${a} in band for ${JSON.stringify(input)}`);
      assert.ok(b >= 10 && b <= 90, `second ${b} in band for ${JSON.stringify(input)}`);
      assert.ok(Math.abs(a + b - 100) < 1e-9, `sums to 100 for ${JSON.stringify(input)}`);
    }
  });
});

describe('clampPanelWidths', () => {
  describe('Basic behavior', () => {
    it('should return widths unchanged when they already satisfy constraints', () => {
      const result = clampPanelWidths(600, [300, 300]);
      assert.deepStrictEqual(result, [300, 300]);
    });

    it('should preserve the sum equal to container width', () => {
      const result = clampPanelWidths(900, [500, 400]);
      const sum = result[0] + result[1];
      assert.strictEqual(sum, 900);
    });

    it('should return default-like distribution for equal input widths', () => {
      const result = clampPanelWidths(600, [300, 300]);
      assert.deepStrictEqual(result, [300, 300]);
    });
  });

  describe('Minimum width enforcement', () => {
    it('should clamp a panel below 100px to at least 100px', () => {
      const result = clampPanelWidths(600, [50, 550]);
      assert.ok(result[0] >= 100, `First panel ${result[0]} should be >= 100`);
      assert.ok(result[1] >= 100, `Second panel ${result[1]} should be >= 100`);
    });

    it('should clamp all panels when all are below minimum', () => {
      const result = clampPanelWidths(600, [50, 50]);
      assert.ok(result[0] >= 100);
      assert.ok(result[1] >= 100);
      const sum = result[0] + result[1];
      assert.ok(Math.abs(sum - 600) < 0.001, `Sum ${sum} should equal 600`);
    });

    it('should enforce minimum when one panel is zero', () => {
      const result = clampPanelWidths(600, [0, 600]);
      assert.ok(result[0] >= 100);
      assert.ok(result[1] >= 100);
    });

    it('should enforce minimum when one panel is negative', () => {
      const result = clampPanelWidths(600, [-50, 650]);
      assert.ok(result[0] >= 100);
      assert.ok(result[1] >= 100);
    });
  });

  describe('Sum preservation', () => {
    it('should adjust widths so they sum to container width when input sum is too large', () => {
      const result = clampPanelWidths(600, [400, 400]);
      const sum = result[0] + result[1];
      assert.ok(Math.abs(sum - 600) < 0.001, `Sum ${sum} should equal 600`);
      assert.ok(result[0] >= 100);
      assert.ok(result[1] >= 100);
    });

    it('should adjust widths so they sum to container width when input sum is too small', () => {
      const result = clampPanelWidths(600, [100, 100]);
      const sum = result[0] + result[1];
      assert.ok(Math.abs(sum - 600) < 0.001, `Sum ${sum} should equal 600`);
    });

    it('should handle exact minimum distribution for 200px container', () => {
      const result = clampPanelWidths(200, [100, 100]);
      assert.deepStrictEqual(result, [100, 100]);
    });
  });

  describe('Edge cases', () => {
    it('should return [0, 0] for zero container width', () => {
      const result = clampPanelWidths(0, [100, 100]);
      assert.deepStrictEqual(result, [0, 0]);
    });

    it('should return [0, 0] for negative container width', () => {
      const result = clampPanelWidths(-100, [100, 100]);
      assert.deepStrictEqual(result, [0, 0]);
    });

    it('should distribute equally for container width below 200px', () => {
      const result = clampPanelWidths(100, [50, 50]);
      assert.strictEqual(result[0], 50);
      assert.strictEqual(result[1], 50);
      const sum = result[0] + result[1];
      assert.strictEqual(sum, 100);
    });

    it('should handle very large container width', () => {
      const result = clampPanelWidths(10000, [6000, 4000]);
      const sum = result[0] + result[1];
      assert.ok(Math.abs(sum - 10000) < 0.001);
      assert.ok(result[0] >= 100);
      assert.ok(result[1] >= 100);
    });

    it('should handle NaN widths by clamping to minimum', () => {
      const result = clampPanelWidths(600, [NaN, 500]);
      assert.ok(result[0] >= 100);
      assert.ok(Number.isFinite(result[0]));
      const sum = result[0] + result[1];
      assert.ok(Math.abs(sum - 600) < 0.001);
    });

    it('should handle Infinity widths by clamping to minimum', () => {
      const result = clampPanelWidths(600, [Infinity, 400]);
      assert.ok(result[0] >= 100);
      assert.ok(result[1] >= 100);
      const sum = result[0] + result[1];
      assert.ok(Math.abs(sum - 600) < 0.001);
    });
  });
});

describe('DEFAULT_PANEL_WIDTHS', () => {
  it('should be [60, 40]', () => {
    assert.deepStrictEqual(DEFAULT_PANEL_WIDTHS, [60, 40]);
  });

  it('should sum to 100', () => {
    const sum = DEFAULT_PANEL_WIDTHS[0] + DEFAULT_PANEL_WIDTHS[1];
    assert.strictEqual(sum, 100);
  });
});

describe('savePanelWidths', () => {
  it('should store widths in workspace state under the correct key', () => {
    const memento = createMockMemento();
    savePanelWidths(memento, [55, 45]);
    const stored = memento.get<[number, number]>('intellig.panelWidths');
    assert.deepStrictEqual(stored, [55, 45]);
  });

  it('should overwrite previously stored widths', () => {
    const memento = createMockMemento();
    savePanelWidths(memento, [60, 40]);
    savePanelWidths(memento, [70, 30]);
    const stored = memento.get<[number, number]>('intellig.panelWidths');
    assert.deepStrictEqual(stored, [70, 30]);
  });
});

describe('loadPanelWidths', () => {
  it('should return stored widths when valid', () => {
    const memento = createMockMemento();
    savePanelWidths(memento, [55, 45]);
    const result = loadPanelWidths(memento);
    assert.deepStrictEqual(result, [55, 45]);
  });

  it('should return default widths when nothing is stored', () => {
    const memento = createMockMemento();
    const result = loadPanelWidths(memento);
    assert.deepStrictEqual(result, [60, 40]);
  });

  it('should return default widths when stored value is not an array', () => {
    const memento = createMockMemento();
    void memento.update('intellig.panelWidths', 'not-an-array');
    const result = loadPanelWidths(memento);
    assert.deepStrictEqual(result, [60, 40]);
  });

  it('should return default widths when stored array has wrong length', () => {
    const memento = createMockMemento();
    void memento.update('intellig.panelWidths', [20, 50, 30]);
    const result = loadPanelWidths(memento);
    assert.deepStrictEqual(result, [60, 40]);
  });

  it('should return default widths when stored values contain non-numbers', () => {
    const memento = createMockMemento();
    void memento.update('intellig.panelWidths', [60, 'forty']);
    const result = loadPanelWidths(memento);
    assert.deepStrictEqual(result, [60, 40]);
  });

  it('should return default widths when a value is below 5', () => {
    const memento = createMockMemento();
    void memento.update('intellig.panelWidths', [3, 97]);
    const result = loadPanelWidths(memento);
    assert.deepStrictEqual(result, [60, 40]);
  });

  it('should return default widths when a value is above 90', () => {
    const memento = createMockMemento();
    void memento.update('intellig.panelWidths', [91, 9]);
    const result = loadPanelWidths(memento);
    assert.deepStrictEqual(result, [60, 40]);
  });

  it('should return default widths when values do not sum to approximately 100', () => {
    const memento = createMockMemento();
    void memento.update('intellig.panelWidths', [30, 30]);
    const result = loadPanelWidths(memento);
    assert.deepStrictEqual(result, [60, 40]);
  });

  it('should accept widths that sum to approximately 100 (within ±1 tolerance)', () => {
    const memento = createMockMemento();
    void memento.update('intellig.panelWidths', [49.5, 50.5]);
    const result = loadPanelWidths(memento);
    assert.deepStrictEqual(result, [49.5, 50.5]);
  });

  it('should return default widths when stored value contains NaN', () => {
    const memento = createMockMemento();
    void memento.update('intellig.panelWidths', [NaN, 50]);
    const result = loadPanelWidths(memento);
    assert.deepStrictEqual(result, [60, 40]);
  });

  it('should return default widths when stored value contains Infinity', () => {
    const memento = createMockMemento();
    void memento.update('intellig.panelWidths', [Infinity, 50]);
    const result = loadPanelWidths(memento);
    assert.deepStrictEqual(result, [60, 40]);
  });

  it('should round-trip the default widths correctly', () => {
    const memento = createMockMemento();
    savePanelWidths(memento, DEFAULT_PANEL_WIDTHS);
    const result = loadPanelWidths(memento);
    assert.deepStrictEqual(result, DEFAULT_PANEL_WIDTHS);
  });

  it('should return a new array instance (not the stored reference)', () => {
    const memento = createMockMemento();
    savePanelWidths(memento, [55, 45]);
    const result1 = loadPanelWidths(memento);
    const result2 = loadPanelWidths(memento);
    assert.notStrictEqual(result1, result2);
    assert.deepStrictEqual(result1, result2);
  });
});
