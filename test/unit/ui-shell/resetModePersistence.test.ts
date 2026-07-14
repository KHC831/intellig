/**
 * P3 — Reset mode persistence (IntelliJ GitVcsSettings.setResetMode parity).
 *
 * IntelliJ remembers the last-used reset mode per project and pre-selects it
 * next time the reset dialog opens. We persist it through an
 * ExtensionContext.globalState-shaped Memento. The two pure helpers
 * (load/save) are validated here against an in-memory store, including the
 * default fallback and rejection of a corrupt stored value.
 */

import '../../setup';
import * as assert from 'assert';
import {
  loadPreferredResetMode,
  savePreferredResetMode,
  RESET_MODE_STATE_KEY,
} from '../../../src/ui-shell/ResetDialog';
import type { ResetMode } from '../../../src/git-core/interfaces/IGitService';

/** Minimal in-memory Memento for the helpers (get/update subset). */
function makeStore(initial?: Record<string, unknown>): {
  get<T>(key: string, fallback?: T): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
  _data: Record<string, unknown>;
} {
  const data: Record<string, unknown> = { ...initial };
  return {
    _data: data,
    get<T>(key: string, fallback?: T): T | undefined {
      return (key in data ? data[key] : fallback) as T | undefined;
    },
    update(key: string, value: unknown): Thenable<void> {
      data[key] = value;
      return Promise.resolve();
    },
  };
}

describe('reset mode persistence (#P3)', () => {
  it('defaults to "mixed" when nothing is stored', () => {
    assert.strictEqual(loadPreferredResetMode(makeStore()), 'mixed');
  });

  it('round-trips a saved mode', async () => {
    const store = makeStore();
    await savePreferredResetMode(store, 'soft');
    assert.deepStrictEqual(store._data[RESET_MODE_STATE_KEY], { v: 1, data: 'soft' });
    assert.strictEqual(loadPreferredResetMode(store), 'soft');
  });

  it('returns every valid mode it was given', async () => {
    for (const mode of ['soft', 'mixed', 'hard', 'keep'] as ResetMode[]) {
      const store = makeStore();
      await savePreferredResetMode(store, mode);
      assert.strictEqual(loadPreferredResetMode(store), mode);
    }
  });

  it('falls back to "mixed" when the stored value is corrupt / not a ResetMode', () => {
    assert.strictEqual(
      loadPreferredResetMode(makeStore({ [RESET_MODE_STATE_KEY]: 'bogus' })),
      'mixed'
    );
    assert.strictEqual(loadPreferredResetMode(makeStore({ [RESET_MODE_STATE_KEY]: 42 })), 'mixed');
  });
});
