/**
 * Apply Patch dialog persistence + preview-check summarisation.
 *
 * The dialog reopened with hardcoded defaults every time and its "Preview"
 * only dumped raw text; these cover the persisted settings slot and the
 * per-file verdict the preview now renders.
 */
import '../../setup';
import * as assert from 'assert';
import {
  applyPatchSettingsSlot,
  validateApplyPatchSettings,
  previewFileResult,
  type IApplyPatchSettings,
} from '../../../src/patches/applyPatchSettings';
import { applyBlockedReason } from '../../../src/patches/applyPatchValidation';
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
      store.set(key, value);
      return Promise.resolve();
    },
  };
}

describe('validateApplyPatchSettings', () => {
  it('accepts a full settings object', () => {
    const settings: IApplyPatchSettings = {
      lastPatchDir: '/patches',
      stripLevel: 2,
      baseDir: 'sub',
      useAm: true,
    };

    assert.deepStrictEqual(validateApplyPatchSettings(settings), settings);
  });

  it('drops individually-invalid fields rather than the whole blob', () => {
    const out = validateApplyPatchSettings({
      lastPatchDir: 42,
      stripLevel: 'two',
      baseDir: 'sub',
      useAm: 'yes',
    });

    assert.deepStrictEqual(out, { baseDir: 'sub' });
  });

  it('rejects an out-of-range strip level', () => {
    assert.deepStrictEqual(validateApplyPatchSettings({ stripLevel: -1 }), {});
    assert.deepStrictEqual(validateApplyPatchSettings({ stripLevel: 99 }), {});
  });

  it('rejects junk shapes', () => {
    assert.strictEqual(validateApplyPatchSettings(null), undefined);
    assert.strictEqual(validateApplyPatchSettings('nope'), undefined);
    assert.strictEqual(validateApplyPatchSettings([1]), undefined);
  });

  it('round-trips through the persisted slot', async () => {
    const memento = makeMemento();
    const settings: IApplyPatchSettings = { stripLevel: 0, useAm: false };

    await savePersisted(memento, applyPatchSettingsSlot('/work/alpha'), settings);

    assert.deepStrictEqual(loadPersisted(memento, applyPatchSettingsSlot('/work/alpha')), settings);
  });

  it('keeps one repository settings out of another', async () => {
    // baseDir becomes `git apply --directory`; repo A's subdirectory is
    // meaningless (or destructive) in repo B.
    const memento = makeMemento();

    await savePersisted(memento, applyPatchSettingsSlot('/work/alpha'), { baseDir: 'alpha-sub' });

    assert.strictEqual(
      loadPersisted(memento, applyPatchSettingsSlot('/work/beta')),
      undefined,
      'repo B starts from the defaults'
    );
  });
});

describe('previewFileResult', () => {
  it('reports a clean check as applying', () => {
    const out = previewFileResult('a.ts', { success: true, appliedFiles: ['a.ts'] });

    assert.deepStrictEqual(out, { path: 'a.ts', ok: true });
  });

  it('carries the sanitised git reason when a file will not apply', () => {
    const out = previewFileResult('a.ts', {
      success: false,
      appliedFiles: [],
      stderr: 'error: patch does not apply',
    });

    assert.strictEqual(out.ok, false);
    assert.match(out.message ?? '', /does not apply/);
  });

  it('names conflicts explicitly rather than leaving a bare failure', () => {
    const out = previewFileResult('a.ts', {
      success: false,
      appliedFiles: [],
      conflicts: [{ path: 'a.ts', resolved: false }],
    });

    assert.strictEqual(out.ok, false);
    assert.match(out.message ?? '', /conflict/i);
  });

  it('falls back to a generic reason when git said nothing', () => {
    const out = previewFileResult('a.ts', { success: false, appliedFiles: [] });

    assert.strictEqual(out.ok, false);
    assert.ok((out.message ?? '').length > 0, 'a failure always carries a reason');
  });
});

describe('applyBlockedReason', () => {
  it('is ready for a chosen file with a valid strip level', () => {
    assert.strictEqual(
      applyBlockedReason({ useClipboard: false, patchPath: '/x.patch', stripLevel: 1 }),
      undefined
    );
  });

  it('is ready for the clipboard source with no file chosen', () => {
    assert.strictEqual(applyBlockedReason({ useClipboard: true, stripLevel: 1 }), undefined);
  });

  it('blocks a file source with no file chosen', () => {
    const reason = applyBlockedReason({ useClipboard: false, stripLevel: 1 });

    assert.match(reason ?? '', /patch file/i);
  });

  it('blocks an invalid strip level', () => {
    const reason = applyBlockedReason({ useClipboard: true, stripLevel: Number.NaN });

    assert.match(reason ?? '', /strip/i);
  });
});
