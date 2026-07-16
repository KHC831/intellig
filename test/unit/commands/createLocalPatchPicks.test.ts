/**
 * Pure validation for the persisted Create Patch from Local Changes pick set
 * (destinations + Reverse). The slot's validator must reject junk and
 * option-only sets so a corrupt blob degrades to the default instead of
 * reopening the pick with no destination checked.
 */
import '../../setup';
import * as assert from 'assert';
import {
  CREATE_LOCAL_PATCH_PICKS_SLOT,
  validateCreateLocalPatchPicks,
  type CreateLocalPatchPick,
} from '../../../src/commands/registration/commitRepoCoreCommands';
import { loadPersisted, savePersisted } from '../../../src/utils/persistedState';
import type { MementoLike } from '../../../src/utils/persistedState';

function makeMemento(): MementoLike & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    get<T>(key: string): T | undefined {
      return store.get(key) as T | undefined;
    },
    update(key: string, value: unknown): Thenable<void> {
      if (value === undefined) {
        store.delete(key);
      } else {
        store.set(key, value);
      }
      return Promise.resolve();
    },
  };
}

describe('validateCreateLocalPatchPicks', () => {
  it('accepts a destination-carrying pick set and dedupes it', () => {
    assert.deepStrictEqual(validateCreateLocalPatchPicks(['file', 'file', 'reverse']), [
      'file',
      'reverse',
    ]);
    assert.deepStrictEqual(validateCreateLocalPatchPicks(['clipboard']), ['clipboard']);
    assert.deepStrictEqual(validateCreateLocalPatchPicks(['file', 'clipboard', 'reverse']), [
      'file',
      'clipboard',
      'reverse',
    ]);
  });

  it('rejects an options-only set (no destination)', () => {
    assert.strictEqual(validateCreateLocalPatchPicks(['reverse']), undefined);
    assert.strictEqual(validateCreateLocalPatchPicks([]), undefined);
  });

  it('rejects junk shapes', () => {
    assert.strictEqual(validateCreateLocalPatchPicks('file'), undefined);
    assert.strictEqual(validateCreateLocalPatchPicks(['file', 'save-to-cloud']), undefined);
    assert.strictEqual(validateCreateLocalPatchPicks([1, 2]), undefined);
    assert.strictEqual(validateCreateLocalPatchPicks({ file: true }), undefined);
    assert.strictEqual(validateCreateLocalPatchPicks(null), undefined);
  });

  it('round-trips through the persisted slot and drops a corrupt blob', async () => {
    const memento = makeMemento();
    const picks: CreateLocalPatchPick[] = ['clipboard', 'reverse'];
    await savePersisted(memento, CREATE_LOCAL_PATCH_PICKS_SLOT, picks);
    assert.deepStrictEqual(loadPersisted(memento, CREATE_LOCAL_PATCH_PICKS_SLOT), [
      'clipboard',
      'reverse',
    ]);

    memento.store.set(CREATE_LOCAL_PATCH_PICKS_SLOT.key, { v: 1, data: ['reverse'] });
    assert.strictEqual(
      loadPersisted(memento, CREATE_LOCAL_PATCH_PICKS_SLOT),
      undefined,
      'an options-only persisted blob must fall back to the default'
    );
  });
});
