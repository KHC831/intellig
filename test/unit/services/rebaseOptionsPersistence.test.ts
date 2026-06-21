/**
 * P3 — rebase options persistence (IntelliJ GitRebaseSettings parity).
 *
 * IntelliJ saves the last-used rebase options per project and reloads them on
 * next open. We persist the five boolean flags (rebaseMerges/keepEmpty/
 * updateRefs/autosquash/root) through a globalState-shaped Memento. The pure
 * load/save helpers are validated here against an in-memory store.
 */

import '../../setup';
import * as assert from 'assert';
import {
  loadRebaseOptions,
  saveRebaseOptions,
  REBASE_OPTIONS_STATE_KEY,
} from '../../../src/rebase/RebaseDialog';

function makeStore(initial?: Record<string, unknown>): {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): Thenable<void>;
  _data: Record<string, unknown>;
} {
  const data: Record<string, unknown> = { ...initial };
  return {
    _data: data,
    get<T>(key: string, fallback: T): T {
      return (key in data ? data[key] : fallback) as T;
    },
    update(key: string, value: unknown): Thenable<void> {
      data[key] = value;
      return Promise.resolve();
    },
  };
}

describe('rebase options persistence (#P3)', () => {
  it('defaults to all-false when nothing is stored', () => {
    assert.deepStrictEqual(loadRebaseOptions(makeStore()), {
      rebaseMerges: false,
      keepEmpty: false,
      updateRefs: false,
      autosquash: false,
      root: false,
    });
  });

  it('round-trips the saved flags', async () => {
    const store = makeStore();
    await saveRebaseOptions(store, {
      rebaseMerges: true,
      keepEmpty: false,
      updateRefs: true,
      autosquash: false,
      root: false,
    });
    assert.deepStrictEqual(loadRebaseOptions(store), {
      rebaseMerges: true,
      keepEmpty: false,
      updateRefs: true,
      autosquash: false,
      root: false,
    });
  });

  it('coerces a partial / corrupt stored object to booleans, defaulting missing keys to false', () => {
    const store = makeStore({
      [REBASE_OPTIONS_STATE_KEY]: { rebaseMerges: true, updateRefs: 'yes' },
    });
    const loaded = loadRebaseOptions(store);
    assert.strictEqual(loaded.rebaseMerges, true);
    assert.strictEqual(loaded.updateRefs, true, 'truthy non-boolean coerces to true');
    assert.strictEqual(loaded.keepEmpty, false, 'missing key defaults false');
    assert.strictEqual(loaded.autosquash, false);
    assert.strictEqual(loaded.root, false, 'missing root defaults false');
  });

  it('falls back to all-false when the stored value is not an object', () => {
    assert.deepStrictEqual(loadRebaseOptions(makeStore({ [REBASE_OPTIONS_STATE_KEY]: 'nope' })), {
      rebaseMerges: false,
      keepEmpty: false,
      updateRefs: false,
      autosquash: false,
      root: false,
    });
  });
});
