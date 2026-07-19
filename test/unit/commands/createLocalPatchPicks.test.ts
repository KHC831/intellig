/**
 * Persistence for the Create Patch from Local Changes flow.
 *
 * Destinations (file / clipboard) persist; Reverse deliberately does NOT —
 * IntelliJ's CreatePatchCommitExecutor calls `myPanel.setReversePatch(false)`
 * every time the panel opens, so a stale tick can never silently invert the
 * next patch. The destination directory persists instead (its `vcs.patch.path`
 * property), seeding the save dialog.
 */
import '../../setup';
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  PATCH_DESTINATIONS_SLOT,
  LAST_PATCH_DIR_SLOT,
  validatePatchDestinations,
  patchSaveDefaultUri,
  rememberPatchDir,
  type PatchDestination,
} from '../../../src/patches/createPatchFlow';
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

describe('validatePatchDestinations', () => {
  it('accepts a destination-carrying set and dedupes it', () => {
    assert.deepStrictEqual(validatePatchDestinations(['file', 'file']), ['file']);
    assert.deepStrictEqual(validatePatchDestinations(['clipboard']), ['clipboard']);
    assert.deepStrictEqual(validatePatchDestinations(['file', 'clipboard']), ['file', 'clipboard']);
  });

  it('rejects a set carrying `reverse` so the option can never be restored', () => {
    assert.strictEqual(validatePatchDestinations(['file', 'reverse']), undefined);
    assert.strictEqual(validatePatchDestinations(['reverse']), undefined);
  });

  it('rejects an empty set and junk shapes', () => {
    assert.strictEqual(validatePatchDestinations([]), undefined);
    assert.strictEqual(validatePatchDestinations('file'), undefined);
    assert.strictEqual(validatePatchDestinations(['file', 'save-to-cloud']), undefined);
    assert.strictEqual(validatePatchDestinations([1, 2]), undefined);
    assert.strictEqual(validatePatchDestinations({ file: true }), undefined);
    assert.strictEqual(validatePatchDestinations(null), undefined);
  });

  it('drops a legacy blob that persisted the Reverse tick', async () => {
    const memento = makeMemento();

    memento.store.set(PATCH_DESTINATIONS_SLOT.key, { v: 1, data: ['file', 'reverse'] });

    assert.strictEqual(
      loadPersisted(memento, PATCH_DESTINATIONS_SLOT),
      undefined,
      'a persisted Reverse must not survive into the reopened pick'
    );
  });

  it('round-trips destinations through the persisted slot', async () => {
    const memento = makeMemento();
    const destinations: PatchDestination[] = ['clipboard'];

    await savePersisted(memento, PATCH_DESTINATIONS_SLOT, destinations);

    assert.deepStrictEqual(loadPersisted(memento, PATCH_DESTINATIONS_SLOT), ['clipboard']);
  });
});

describe('patch save destination', () => {
  const repoRoot = vscode.Uri.file(path.join(path.sep, 'repo'));

  it('seeds the save dialog under the repo root when nothing is remembered', () => {
    const uri = patchSaveDefaultUri(makeMemento(), repoRoot, 'changes.patch');

    assert.strictEqual(uri.fsPath, path.join(repoRoot.fsPath, 'changes.patch'));
  });

  it('seeds the save dialog in the last used directory once one is remembered', async () => {
    const memento = makeMemento();
    const lastDir = path.join(path.sep, 'elsewhere', 'patches');
    await rememberPatchDir(memento, vscode.Uri.file(path.join(lastDir, 'previous.patch')));

    const uri = patchSaveDefaultUri(memento, repoRoot, 'changes.patch');

    assert.strictEqual(uri.fsPath, path.join(lastDir, 'changes.patch'));
  });

  it('falls back to the repo root when the remembered value is junk', () => {
    const memento = makeMemento();
    memento.store.set(LAST_PATCH_DIR_SLOT.key, { v: 1, data: 42 });

    const uri = patchSaveDefaultUri(memento, repoRoot, 'changes.patch');

    assert.strictEqual(uri.fsPath, path.join(repoRoot.fsPath, 'changes.patch'));
  });
});
