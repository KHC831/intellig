/**
 * Spec for src/utils/persistedState.ts — the versioned validate-on-load seam.
 *
 * Pins: round-trip through the {v,data} envelope, version-mismatch drop, legacy
 * bare-value back-compat (no user loses state on rollout), junk → undefined,
 * Date serialize round-trip, the isEnvelope collision case, and the two-slot
 * cross-store composition used by the favorites migration.
 */
import * as assert from 'assert';
import {
  loadPersisted,
  savePersisted,
  readStringArray,
  readDate,
  type MementoLike,
  type PersistedSlot,
} from '../../../src/utils/persistedState';
import { LOG_FILTER_SLOT } from '../../../src/utils/logFilterStorage';
import { PANEL_WIDTHS_SLOT } from '../../../src/utils/panelLayout';
import { COLUMN_WIDTHS_SLOT } from '../../../src/utils/columnLayout';
import {
  ACTIVE_TAB_SLOT,
  SHELF_TAB_FILTER_SLOT,
  CHANGES_GROUPING_SLOT,
  RECENT_MESSAGES_SLOT,
} from '../../../src/commits/CommitToolWindow';
import { LAST_NO_VERIFY_SLOT } from '../../../src/commits/CommitDialog';
import { RECENT_BRANCHES_SLOT, FAVORITES_LEGACY_SLOT } from '../../../src/branches/BranchPopup';
import { FAVORITES_SLOT } from '../../../src/branches/BranchTreeProvider';
import { HIDDEN_REVISIONS_SLOT } from '../../../src/blame/BlameOptionsSource';
import { RESET_MODE_SLOT } from '../../../src/ui-shell/ResetDialog';
import { REBASE_OPTIONS_SLOT } from '../../../src/rebase/RebaseDialog';

class FakeMemento implements MementoLike {
  private readonly m = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.m.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) {
      this.m.delete(key);
    } else {
      this.m.set(key, value);
    }
    return Promise.resolve();
  }
  /** Test seam: read the exact stored blob (envelope included). */
  peek(key: string): unknown {
    return this.m.get(key);
  }
}

const STRINGS_SLOT: PersistedSlot<string[]> = {
  key: 'test.strings',
  version: 1,
  validate: readStringArray,
};

const DATE_SLOT: PersistedSlot<Date> = {
  key: 'test.date',
  version: 1,
  validate: readDate,
  serialize: (d) => d.toISOString(),
};

describe('persistedState', () => {
  it('round-trips a slot value and wraps it in a versioned envelope', () => {
    const state = new FakeMemento();
    void savePersisted(state, STRINGS_SLOT, ['a', 'b']);
    assert.deepStrictEqual(loadPersisted(state, STRINGS_SLOT), ['a', 'b']);
    assert.deepStrictEqual(state.peek('test.strings'), { v: 1, data: ['a', 'b'] });
  });

  it('drops to undefined when the stored envelope version mismatches the slot', () => {
    const state = new FakeMemento();
    void state.update('test.strings', { v: 1, data: ['a'] });
    const v2Slot: PersistedSlot<string[]> = { ...STRINGS_SLOT, version: 2 };
    assert.strictEqual(loadPersisted(state, v2Slot), undefined);
  });

  it('loads a legacy bare (un-enveloped) value as the current version', () => {
    const state = new FakeMemento();
    // Simulate state written before the envelope shipped: a raw string[].
    void state.update('test.strings', ['legacy', 'value']);
    assert.deepStrictEqual(loadPersisted(state, STRINGS_SLOT), ['legacy', 'value']);
  });

  it('returns undefined when the payload fails validation', () => {
    const state = new FakeMemento();
    void state.update('test.strings', { v: 1, data: [1, 2, 3] }); // not strings
    assert.strictEqual(loadPersisted(state, STRINGS_SLOT), undefined);
  });

  it('round-trips a Date via the serialize hook', () => {
    const state = new FakeMemento();
    const when = new Date('2026-07-14T10:20:30.000Z');
    void savePersisted(state, DATE_SLOT, when);
    assert.deepStrictEqual(state.peek('test.date'), {
      v: 1,
      data: '2026-07-14T10:20:30.000Z',
    });
    const loaded = loadPersisted(state, DATE_SLOT);
    assert.ok(loaded instanceof Date);
    assert.strictEqual(loaded.getTime(), when.getTime());
  });

  it('does not treat a bare object with a wrong-typed v as an envelope', () => {
    const state = new FakeMemento();
    // A hand-edited blob with v:'1' (string) is NOT our envelope; it falls to
    // the legacy validate path, where the slot validator rejects the junk.
    void state.update('test.strings', { v: '1', data: ['a'] });
    assert.strictEqual(loadPersisted(state, STRINGS_SLOT), undefined);
  });

  it('clears a slot when saved with undefined', () => {
    const state = new FakeMemento();
    void savePersisted(state, STRINGS_SLOT, ['x']);
    void savePersisted(state, STRINGS_SLOT, undefined);
    assert.strictEqual(state.peek('test.strings'), undefined);
    assert.strictEqual(loadPersisted(state, STRINGS_SLOT), undefined);
  });

  it('every registered persisted slot uses a distinct key string', () => {
    const slots = [
      LOG_FILTER_SLOT,
      PANEL_WIDTHS_SLOT,
      COLUMN_WIDTHS_SLOT,
      ACTIVE_TAB_SLOT,
      SHELF_TAB_FILTER_SLOT,
      CHANGES_GROUPING_SLOT,
      RECENT_MESSAGES_SLOT,
      LAST_NO_VERIFY_SLOT,
      RECENT_BRANCHES_SLOT,
      FAVORITES_LEGACY_SLOT,
      FAVORITES_SLOT,
      HIDDEN_REVISIONS_SLOT,
      RESET_MODE_SLOT,
      REBASE_OPTIONS_SLOT,
    ];
    const keys = slots.map((s) => s.key);
    assert.strictEqual(
      new Set(keys).size,
      keys.length,
      `duplicate slot key(s): ${keys.join(', ')}`
    );
  });

  describe('two-slot cross-store composition (favorites migration shape)', () => {
    const CURRENT_SLOT: PersistedSlot<string[]> = {
      key: 'test.fav.current',
      version: 1,
      validate: readStringArray,
    };
    const LEGACY_SLOT: PersistedSlot<string[]> = {
      key: 'test.fav.legacy',
      version: 1,
      validate: readStringArray,
    };

    it('falls back to the legacy store when the current slot is empty', () => {
      const gs = new FakeMemento();
      const ws = new FakeMemento();
      void savePersisted(ws, LEGACY_SLOT, ['a']);
      const composed = loadPersisted(gs, CURRENT_SLOT) ?? loadPersisted(ws, LEGACY_SLOT);
      assert.deepStrictEqual(composed, ['a']);
    });

    it('never consults the legacy store once the current slot is populated', () => {
      const gs = new FakeMemento();
      const ws = new FakeMemento();
      void savePersisted(gs, CURRENT_SLOT, ['current']);
      void savePersisted(ws, LEGACY_SLOT, ['legacy']);
      const composed = loadPersisted(gs, CURRENT_SLOT) ?? loadPersisted(ws, LEGACY_SLOT);
      assert.deepStrictEqual(composed, ['current']);
    });
  });
});
