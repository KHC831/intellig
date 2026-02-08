/**
 * Unit tests for panel layout utility functions.
 *
 * Tests cover:
 * - clampPanelWidths basic behavior
 * - Minimum width enforcement (100px per panel)
 * - Sum preservation (widths sum to container width)
 * - Edge cases (small containers, negative widths, zero widths)
 *
 * Requirements: 1.3 — Panel resize with minimum width of 100px per panel.
 */

import * as assert from 'assert';
import { clampPanelWidths, savePanelWidths, loadPanelWidths, DEFAULT_PANEL_WIDTHS } from '../../../utils/panelLayout';

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

describe('clampPanelWidths', () => {
  describe('Basic behavior', () => {
    it('should return widths unchanged when they already satisfy constraints', () => {
      const result = clampPanelWidths(600, [120, 300, 180]);
      assert.deepStrictEqual(result, [120, 300, 180]);
    });

    it('should preserve the sum equal to container width', () => {
      const result = clampPanelWidths(900, [200, 400, 300]);
      const sum = result[0] + result[1] + result[2];
      assert.strictEqual(sum, 900);
    });

    it('should return default-like distribution for equal input widths', () => {
      const result = clampPanelWidths(600, [200, 200, 200]);
      assert.deepStrictEqual(result, [200, 200, 200]);
    });
  });

  describe('Minimum width enforcement', () => {
    it('should clamp a panel below 100px to at least 100px', () => {
      const result = clampPanelWidths(600, [50, 300, 250]);
      assert.ok(result[0] >= 100, `First panel ${result[0]} should be >= 100`);
      assert.ok(result[1] >= 100, `Second panel ${result[1]} should be >= 100`);
      assert.ok(result[2] >= 100, `Third panel ${result[2]} should be >= 100`);
    });

    it('should clamp all panels when all are below minimum', () => {
      const result = clampPanelWidths(600, [50, 50, 50]);
      assert.ok(result[0] >= 100);
      assert.ok(result[1] >= 100);
      assert.ok(result[2] >= 100);
      const sum = result[0] + result[1] + result[2];
      assert.ok(Math.abs(sum - 600) < 0.001, `Sum ${sum} should equal 600`);
    });

    it('should enforce minimum when one panel is zero', () => {
      const result = clampPanelWidths(600, [0, 300, 300]);
      assert.ok(result[0] >= 100);
      assert.ok(result[1] >= 100);
      assert.ok(result[2] >= 100);
    });

    it('should enforce minimum when one panel is negative', () => {
      const result = clampPanelWidths(600, [-50, 350, 300]);
      assert.ok(result[0] >= 100);
      assert.ok(result[1] >= 100);
      assert.ok(result[2] >= 100);
    });
  });

  describe('Sum preservation', () => {
    it('should adjust widths so they sum to container width when input sum is too large', () => {
      const result = clampPanelWidths(600, [300, 300, 300]);
      const sum = result[0] + result[1] + result[2];
      assert.ok(Math.abs(sum - 600) < 0.001, `Sum ${sum} should equal 600`);
      assert.ok(result[0] >= 100);
      assert.ok(result[1] >= 100);
      assert.ok(result[2] >= 100);
    });

    it('should adjust widths so they sum to container width when input sum is too small', () => {
      const result = clampPanelWidths(600, [100, 100, 100]);
      const sum = result[0] + result[1] + result[2];
      assert.ok(Math.abs(sum - 600) < 0.001, `Sum ${sum} should equal 600`);
    });

    it('should handle exact minimum distribution for 300px container', () => {
      const result = clampPanelWidths(300, [100, 100, 100]);
      assert.deepStrictEqual(result, [100, 100, 100]);
    });
  });

  describe('Edge cases', () => {
    it('should return [0, 0, 0] for zero container width', () => {
      const result = clampPanelWidths(0, [100, 100, 100]);
      assert.deepStrictEqual(result, [0, 0, 0]);
    });

    it('should return [0, 0, 0] for negative container width', () => {
      const result = clampPanelWidths(-100, [100, 100, 100]);
      assert.deepStrictEqual(result, [0, 0, 0]);
    });

    it('should distribute equally for container width below 300px', () => {
      const result = clampPanelWidths(150, [50, 50, 50]);
      assert.strictEqual(result[0], 50);
      assert.strictEqual(result[1], 50);
      assert.strictEqual(result[2], 50);
      const sum = result[0] + result[1] + result[2];
      assert.strictEqual(sum, 150);
    });

    it('should handle very large container width', () => {
      const result = clampPanelWidths(10000, [3000, 4000, 3000]);
      const sum = result[0] + result[1] + result[2];
      assert.ok(Math.abs(sum - 10000) < 0.001);
      assert.ok(result[0] >= 100);
      assert.ok(result[1] >= 100);
      assert.ok(result[2] >= 100);
    });

    it('should handle NaN widths by clamping to minimum', () => {
      const result = clampPanelWidths(600, [NaN, 300, 200]);
      assert.ok(result[0] >= 100);
      assert.ok(Number.isFinite(result[0]));
      const sum = result[0] + result[1] + result[2];
      assert.ok(Math.abs(sum - 600) < 0.001);
    });

    it('should handle Infinity widths by clamping to minimum', () => {
      const result = clampPanelWidths(600, [Infinity, 200, 200]);
      assert.ok(result[0] >= 100);
      assert.ok(result[1] >= 100);
      assert.ok(result[2] >= 100);
      const sum = result[0] + result[1] + result[2];
      assert.ok(Math.abs(sum - 600) < 0.001);
    });
  });
});


describe('DEFAULT_PANEL_WIDTHS', () => {
  it('should be [20, 50, 30]', () => {
    assert.deepStrictEqual(DEFAULT_PANEL_WIDTHS, [20, 50, 30]);
  });

  it('should sum to 100', () => {
    const sum = DEFAULT_PANEL_WIDTHS[0] + DEFAULT_PANEL_WIDTHS[1] + DEFAULT_PANEL_WIDTHS[2];
    assert.strictEqual(sum, 100);
  });
});

describe('savePanelWidths', () => {
  it('should store widths in workspace state under the correct key', () => {
    const memento = createMockMemento();
    savePanelWidths(memento, [25, 45, 30]);
    const stored = memento.get<[number, number, number]>('intellij-git.panelWidths');
    assert.deepStrictEqual(stored, [25, 45, 30]);
  });

  it('should overwrite previously stored widths', () => {
    const memento = createMockMemento();
    savePanelWidths(memento, [20, 50, 30]);
    savePanelWidths(memento, [30, 40, 30]);
    const stored = memento.get<[number, number, number]>('intellij-git.panelWidths');
    assert.deepStrictEqual(stored, [30, 40, 30]);
  });
});

describe('loadPanelWidths', () => {
  it('should return stored widths when valid', () => {
    const memento = createMockMemento();
    savePanelWidths(memento, [25, 45, 30]);
    const result = loadPanelWidths(memento);
    assert.deepStrictEqual(result, [25, 45, 30]);
  });

  it('should return default widths when nothing is stored', () => {
    const memento = createMockMemento();
    const result = loadPanelWidths(memento);
    assert.deepStrictEqual(result, [20, 50, 30]);
  });

  it('should return default widths when stored value is not an array', () => {
    const memento = createMockMemento();
    void memento.update('intellij-git.panelWidths', 'not-an-array');
    const result = loadPanelWidths(memento);
    assert.deepStrictEqual(result, [20, 50, 30]);
  });

  it('should return default widths when stored array has wrong length', () => {
    const memento = createMockMemento();
    void memento.update('intellij-git.panelWidths', [20, 80]);
    const result = loadPanelWidths(memento);
    assert.deepStrictEqual(result, [20, 50, 30]);
  });

  it('should return default widths when stored values contain non-numbers', () => {
    const memento = createMockMemento();
    void memento.update('intellij-git.panelWidths', [20, 'fifty', 30]);
    const result = loadPanelWidths(memento);
    assert.deepStrictEqual(result, [20, 50, 30]);
  });

  it('should return default widths when a value is below 5', () => {
    const memento = createMockMemento();
    void memento.update('intellij-git.panelWidths', [3, 67, 30]);
    const result = loadPanelWidths(memento);
    assert.deepStrictEqual(result, [20, 50, 30]);
  });

  it('should return default widths when a value is above 90', () => {
    const memento = createMockMemento();
    void memento.update('intellij-git.panelWidths', [5, 91, 4]);
    const result = loadPanelWidths(memento);
    assert.deepStrictEqual(result, [20, 50, 30]);
  });

  it('should return default widths when values do not sum to approximately 100', () => {
    const memento = createMockMemento();
    void memento.update('intellij-git.panelWidths', [30, 30, 30]);
    const result = loadPanelWidths(memento);
    assert.deepStrictEqual(result, [20, 50, 30]);
  });

  it('should accept widths that sum to approximately 100 (within ±1 tolerance)', () => {
    const memento = createMockMemento();
    // 33.33 + 33.33 + 33.34 = 100.0
    void memento.update('intellij-git.panelWidths', [33.33, 33.33, 33.34]);
    const result = loadPanelWidths(memento);
    assert.deepStrictEqual(result, [33.33, 33.33, 33.34]);
  });

  it('should return default widths when stored value contains NaN', () => {
    const memento = createMockMemento();
    void memento.update('intellij-git.panelWidths', [NaN, 50, 30]);
    const result = loadPanelWidths(memento);
    assert.deepStrictEqual(result, [20, 50, 30]);
  });

  it('should return default widths when stored value contains Infinity', () => {
    const memento = createMockMemento();
    void memento.update('intellij-git.panelWidths', [Infinity, 50, 30]);
    const result = loadPanelWidths(memento);
    assert.deepStrictEqual(result, [20, 50, 30]);
  });

  it('should round-trip the default widths correctly', () => {
    const memento = createMockMemento();
    savePanelWidths(memento, DEFAULT_PANEL_WIDTHS);
    const result = loadPanelWidths(memento);
    assert.deepStrictEqual(result, DEFAULT_PANEL_WIDTHS);
  });

  it('should return a new array instance (not the stored reference)', () => {
    const memento = createMockMemento();
    savePanelWidths(memento, [25, 45, 30]);
    const result1 = loadPanelWidths(memento);
    const result2 = loadPanelWidths(memento);
    assert.notStrictEqual(result1, result2);
    assert.deepStrictEqual(result1, result2);
  });
});
