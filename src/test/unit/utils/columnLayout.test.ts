/**
 * Unit tests for log-column layout utility functions.
 *
 * The Git log rows have three columns — a flexible title column plus two
 * fixed-width metadata columns (author, date). These helpers own the pure
 * clamp logic for the two resizable fixed columns and their persistence,
 * mirroring the panel-splitter helpers in `panelLayout.ts` but kept separate
 * because the column contract (per-column min/max, two independent widths, the
 * title column as the flex absorber) is distinct from the panel-percentage one.
 *
 * Tests cover:
 * - clampColumnWidths: per-column min/max enforcement, NaN/negative handling
 * - saveColumnWidths / loadColumnWidths round-trip + validation fallback
 */

import * as assert from 'assert';
import {
  clampColumnWidths,
  saveColumnWidths,
  loadColumnWidths,
  DEFAULT_COLUMN_WIDTHS,
  MIN_COLUMN_WIDTH,
  MAX_COLUMN_WIDTH,
} from '../../../utils/columnLayout';

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

describe('clampColumnWidths', () => {
  it('returns widths unchanged when already within bounds', () => {
    const result = clampColumnWidths([130, 160]);
    assert.deepStrictEqual(result, [130, 160]);
  });

  it('clamps a column dragged below the minimum up to MIN_COLUMN_WIDTH', () => {
    const result = clampColumnWidths([10, 160]);
    assert.strictEqual(result[0], MIN_COLUMN_WIDTH);
    assert.strictEqual(result[1], 160);
  });

  it('clamps a column dragged to zero up to MIN_COLUMN_WIDTH (never collapses to 0)', () => {
    const result = clampColumnWidths([0, 0]);
    assert.strictEqual(result[0], MIN_COLUMN_WIDTH);
    assert.strictEqual(result[1], MIN_COLUMN_WIDTH);
  });

  it('clamps a negative width up to MIN_COLUMN_WIDTH', () => {
    const result = clampColumnWidths([-50, 160]);
    assert.strictEqual(result[0], MIN_COLUMN_WIDTH);
  });

  it('clamps an over-large width down to MAX_COLUMN_WIDTH', () => {
    const result = clampColumnWidths([99999, 160]);
    assert.strictEqual(result[0], MAX_COLUMN_WIDTH);
  });

  it('replaces a non-finite width with the default for that column', () => {
    const result = clampColumnWidths([Number.NaN, Number.POSITIVE_INFINITY]);
    assert.strictEqual(result[0], DEFAULT_COLUMN_WIDTHS[0]);
    assert.strictEqual(result[1], DEFAULT_COLUMN_WIDTHS[1]);
  });

  it('is pure — does not mutate its input tuple', () => {
    const input: [number, number] = [10, 160];
    clampColumnWidths(input);
    assert.deepStrictEqual(input, [10, 160]);
  });

  it('rounds fractional pixel widths to whole pixels', () => {
    const result = clampColumnWidths([130.7, 160.2]);
    assert.strictEqual(result[0], 131);
    assert.strictEqual(result[1], 160);
  });
});

describe('saveColumnWidths / loadColumnWidths', () => {
  it('round-trips clamped widths through workspace state', () => {
    const state = createMockMemento();
    saveColumnWidths(state, [130, 160]);
    assert.deepStrictEqual(loadColumnWidths(state), [130, 160]);
  });

  it('falls back to defaults when nothing is stored', () => {
    const state = createMockMemento();
    assert.deepStrictEqual(loadColumnWidths(state), [...DEFAULT_COLUMN_WIDTHS]);
  });

  it('falls back to defaults when the stored value is malformed', () => {
    const state = createMockMemento();
    void state.update('intellig.columnWidths', { not: 'an array' });
    assert.deepStrictEqual(loadColumnWidths(state), [...DEFAULT_COLUMN_WIDTHS]);
  });

  it('falls back to defaults when the stored array has the wrong length', () => {
    const state = createMockMemento();
    void state.update('intellig.columnWidths', [120]);
    assert.deepStrictEqual(loadColumnWidths(state), [...DEFAULT_COLUMN_WIDTHS]);
  });

  it('clamps out-of-range stored widths on load rather than trusting them blindly', () => {
    const state = createMockMemento();
    void state.update('intellig.columnWidths', [5, 99999]);
    const loaded = loadColumnWidths(state);
    assert.strictEqual(loaded[0], MIN_COLUMN_WIDTH);
    assert.strictEqual(loaded[1], MAX_COLUMN_WIDTH);
  });
});
