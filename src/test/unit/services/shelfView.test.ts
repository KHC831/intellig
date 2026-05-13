/**
 * T2-10 unit tests for ShelfView.
 *
 * Covers:
 * - Already-Unshelved filter hides / shows entries.
 * - setShowAlreadyUnshelved toggles visibility.
 * - renameShelfItem prompts and delegates to ShelfService.renameShelf.
 * - restoreShelfItem clears unshelvedAt via ShelfService.restoreShelf.
 * - unshelveSilent passes removeFromShelf: true + the configured
 *   removeAppliedFiles flag through to ShelfService.unshelve.
 */

/*
 * Stub factories synthesise IShelfService implementations whose member
 * signatures return `Promise<T>`; no-await stub bodies are intentional here.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ShelfView } from '../../../services/ShelfView';
import {
  IShelfService,
  IShelfItem,
  IShelveSelection,
  IUnshelveOptions,
  IUnshelveResult,
  IImportPatchOptions,
} from '../../../services/interfaces/IShelfService';
import { IRepository, IDiff } from '../../../services/interfaces/IGitService';
import { setMockConfigValue, resetMockConfiguration } from '../../mocks/vscode';
import { installErrorMessageTracker, restoreMessageFunctions } from '../../typed/windowStub';

/**
 * Build a controllable IShelfService stub. Tests push items onto `_items` and
 * the stub reflects them back through getShelfItems() + firing onDidChange.
 */
function makeMockShelfService(): IShelfService & {
  _items: IShelfItem[];
  _renamed: Array<{ id: string; name: string }>;
  _restored: string[];
  _marked: string[];
  _unshelved: Array<{ id: string; options?: IUnshelveOptions }>;
  _unshelveReturn: IUnshelveResult;
  _importedPatches: IImportPatchOptions[];
} {
  const emitter = new vscode.EventEmitter<IShelfItem[]>();
  const items: IShelfItem[] = [];
  const renamed: Array<{ id: string; name: string }> = [];
  const restored: string[] = [];
  const marked: string[] = [];
  const unshelved: Array<{ id: string; options?: IUnshelveOptions }> = [];
  const importedPatches: IImportPatchOptions[] = [];
  let unshelveReturn: IUnshelveResult = { success: true };
  const svc: IShelfService & {
    _items: IShelfItem[];
    _renamed: Array<{ id: string; name: string }>;
    _restored: string[];
    _marked: string[];
    _unshelved: Array<{ id: string; options?: IUnshelveOptions }>;
    _unshelveReturn: IUnshelveResult;
    _importedPatches: IImportPatchOptions[];
  } = {
    onDidChangeShelf: emitter.event,
    async shelve(_repo: IRepository, name: string, _changes: IShelveSelection) {
      const item: IShelfItem = {
        id: `shelf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name,
        timestamp: new Date(),
        files: [{ path: 'a.ts', diff: 'diff --git a/a.ts b/a.ts\n' }],
      };
      items.push(item);
      emitter.fire(items.slice());
      return item;
    },
    async unshelve(_repo: IRepository, shelfId: string, options?: IUnshelveOptions) {
      unshelved.push({ id: shelfId, options });
      return unshelveReturn;
    },
    getShelfItems(): IShelfItem[] {
      return items.slice();
    },
    deleteShelfItem(_repo: IRepository, shelfId: string): void {
      const index = items.findIndex((i) => i.id === shelfId);
      if (index >= 0) {
        items.splice(index, 1);
        emitter.fire(items.slice());
      }
    },
    getShelfDiff(): Promise<IDiff[]> {
      return Promise.resolve([]);
    },
    renameShelf(_repo: IRepository, shelfId: string, newName: string): void {
      renamed.push({ id: shelfId, name: newName });
      const match = items.find((i) => i.id === shelfId);
      if (match) {
        match.name = newName;
        emitter.fire(items.slice());
      }
    },
    async importPatch(_repo: IRepository, options: IImportPatchOptions): Promise<IShelfItem> {
      importedPatches.push(options);
      const item: IShelfItem = {
        id: `imp-${importedPatches.length}`,
        name: options.name ?? 'imported',
        timestamp: new Date(),
        files: [{ path: 'imported-patch', diff: options.patchContent ?? 'diff' }],
      };
      items.push(item);
      emitter.fire(items.slice());
      return item;
    },
    markAsUnshelved(_repo: IRepository, shelfId: string): void {
      marked.push(shelfId);
      const match = items.find((i) => i.id === shelfId);
      if (match) {
        match.unshelvedAt = new Date();
        emitter.fire(items.slice());
      }
    },
    restoreShelf(_repo: IRepository, shelfId: string): void {
      restored.push(shelfId);
      const match = items.find((i) => i.id === shelfId);
      if (match) {
        match.unshelvedAt = undefined;
        emitter.fire(items.slice());
      }
    },
    filterShelfFiles(): IShelfItem | undefined {
      return undefined;
    },
    dispose(): void {
      emitter.dispose();
    },
    _items: items,
    _renamed: renamed,
    _restored: restored,
    _marked: marked,
    _unshelved: unshelved,
    _importedPatches: importedPatches,
    get _unshelveReturn(): IUnshelveResult {
      return unshelveReturn;
    },
    set _unshelveReturn(v: IUnshelveResult) {
      unshelveReturn = v;
    },
  };
  return svc;
}

function makeRepo(): IRepository {
  return {
    rootUri: vscode.Uri.file('/tmp/fake-repo'),
    state: 'idle',
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
}

describe('ShelfView — T2-10', () => {
  let svc: ReturnType<typeof makeMockShelfService>;
  let view: ShelfView;
  let repo: IRepository;

  beforeEach(() => {
    resetMockConfiguration();
    svc = makeMockShelfService();
    view = new ShelfView(svc);
    repo = makeRepo();
    // Seed the internal repository reference without triggering show()'s
    // QuickPick; refresh() reads _repository directly.
    (view as unknown as { _repository: IRepository })._repository = repo;
  });

  afterEach(() => {
    view.dispose();
  });

  describe('Already-Unshelved filter', () => {
    it('hides entries with unshelvedAt when toggle is off (default)', async () => {
      svc._items.push(
        {
          id: 'a',
          name: 'first',
          timestamp: new Date(),
          files: [{ path: 'x.ts', diff: 'diff' }],
        },
        {
          id: 'b',
          name: 'second',
          timestamp: new Date(),
          files: [{ path: 'y.ts', diff: 'diff' }],
          unshelvedAt: new Date(),
        }
      );
      await view.refresh();
      const state = view.getState();
      assert.strictEqual(state.shelfItems.length, 1);
      assert.strictEqual(state.shelfItems[0].shelfItem.id, 'a');
    });

    it('setShowAlreadyUnshelved(true) exposes unshelved entries', async () => {
      svc._items.push(
        {
          id: 'a',
          name: 'first',
          timestamp: new Date(),
          files: [],
        },
        {
          id: 'b',
          name: 'second',
          timestamp: new Date(),
          files: [],
          unshelvedAt: new Date(),
        }
      );
      await view.refresh();
      assert.strictEqual(view.getState().shelfItems.length, 1);

      view.setShowAlreadyUnshelved(true);
      // Toggle triggers an internal refresh which runs synchronously for our
      // in-memory mock. Give the microtask queue a tick.
      await Promise.resolve();
      await view.refresh();
      assert.strictEqual(view.getState().shelfItems.length, 2);
      assert.strictEqual(view.getShowAlreadyUnshelved(), true);
    });
  });

  describe('renameShelfItem', () => {
    it('prompts and delegates to ShelfService.renameShelf', async () => {
      svc._items.push({
        id: 'a',
        name: 'old',
        timestamp: new Date(),
        files: [],
      });
      await view.refresh();

      // Stub showInputBox.
      const originalInput = vscode.window.showInputBox;
      (
        vscode.window as unknown as {
          showInputBox: (opts?: unknown) => Promise<string | undefined>;
        }
      ).showInputBox = async () => 'new-name';

      try {
        const result = await view.renameShelfItem('a');
        assert.strictEqual(result.success, true);
        assert.deepStrictEqual(svc._renamed, [{ id: 'a', name: 'new-name' }]);
      } finally {
        (vscode.window as unknown as { showInputBox: typeof originalInput }).showInputBox =
          originalInput;
      }
    });

    it('no-ops when the user cancels the prompt', async () => {
      svc._items.push({
        id: 'a',
        name: 'old',
        timestamp: new Date(),
        files: [],
      });
      await view.refresh();

      const originalInput = vscode.window.showInputBox;
      (
        vscode.window as unknown as { showInputBox: () => Promise<string | undefined> }
      ).showInputBox = async () => undefined;

      try {
        const result = await view.renameShelfItem('a');
        assert.strictEqual(result.success, false);
        assert.strictEqual(svc._renamed.length, 0);
      } finally {
        (vscode.window as unknown as { showInputBox: typeof originalInput }).showInputBox =
          originalInput;
      }
    });
  });

  describe('restoreShelfItem', () => {
    it('clears unshelvedAt via ShelfService.restoreShelf', async () => {
      svc._items.push({
        id: 'a',
        name: 'done',
        timestamp: new Date(),
        files: [],
        unshelvedAt: new Date(),
      });
      // Flip the filter on so the entry is visible to _findShelfItemById.
      view.setShowAlreadyUnshelved(true);
      await view.refresh();

      const result = view.restoreShelfItem('a');
      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(svc._restored, ['a']);
    });
  });

  describe('unshelveSilent', () => {
    it('passes removeFromShelf:true + config.removeAppliedFiles to unshelve', async () => {
      setMockConfigValue('intellig.shelve', 'removeAppliedFiles', true);

      svc._items.push({
        id: 'a',
        name: 'wip',
        timestamp: new Date(),
        files: [{ path: 'x.ts', diff: 'diff' }],
      });
      await view.refresh();

      const result = await view.unshelveSilent('a');
      assert.strictEqual(result.success, true);
      assert.strictEqual(svc._unshelved.length, 1);
      assert.deepStrictEqual(svc._unshelved[0].options, {
        removeFromShelf: true,
        removeAppliedFiles: true,
      });
    });

    it('defaults removeAppliedFiles to false when config not set', async () => {
      svc._items.push({
        id: 'a',
        name: 'wip',
        timestamp: new Date(),
        files: [{ path: 'x.ts', diff: 'diff' }],
      });
      await view.refresh();

      await view.unshelveSilent('a');
      assert.deepStrictEqual(svc._unshelved[0].options, {
        removeFromShelf: true,
        removeAppliedFiles: false,
      });
    });
  });

  describe('createPatchFromShelf — TL-38 atomic write', () => {
    it('writes the combined patch atomically to the user-picked path', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-shelfpatch-ok-'));
      const outPath = path.join(tmpDir, 'wip.patch');

      svc._items.push({
        id: 'a',
        name: 'wip',
        timestamp: new Date(),
        files: [
          { path: 'x.ts', diff: 'diff --git a/x.ts b/x.ts\n' },
          { path: 'y.ts', diff: 'diff --git a/y.ts b/y.ts\n' },
        ],
      });
      await view.refresh();

      const originalSave = vscode.window.showSaveDialog;
      (
        vscode.window as unknown as {
          showSaveDialog: () => Promise<vscode.Uri | undefined>;
        }
      ).showSaveDialog = async () => vscode.Uri.file(outPath);

      try {
        const result = await view.createPatchFromShelf('a');
        assert.strictEqual(result.success, true);
        const written = fs.readFileSync(outPath, 'utf-8');
        assert.ok(written.includes('diff --git a/x.ts'));
        assert.ok(written.includes('diff --git a/y.ts'));
        // No sibling tmp-debris remains after the atomic rename.
        const debris = fs.readdirSync(tmpDir).filter((f) => f.includes('.tmp-'));
        assert.strictEqual(debris.length, 0, `unexpected tmp debris: ${debris.join(', ')}`);
      } finally {
        (vscode.window as unknown as { showSaveDialog: typeof originalSave }).showSaveDialog =
          originalSave;
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    });

    it('surfaces sanitised toast when atomic write fails; no success toast, no event fired', async () => {
      // Pick a non-existent directory so atomicWriteFile's sibling-tmp
      // write rejects with ENOENT. Exercises the catch path in
      // createPatchFromShelf — write failure must surface as a toast,
      // suppress the success info toast, and NOT fire onDidRequestAction.
      const missingPath = path.join(
        os.tmpdir(),
        `intellig-shelfpatch-missing-${process.pid}-${Date.now()}`,
        'wip.patch'
      );

      svc._items.push({
        id: 'a',
        name: 'wip',
        timestamp: new Date(),
        files: [{ path: 'x.ts', diff: 'diff --git a/x.ts b/x.ts\n' }],
      });
      await view.refresh();

      const tracker = installErrorMessageTracker();
      const requestedActions: string[] = [];
      const actionSub = view.onDidRequestAction((e) => {
        requestedActions.push(e.action);
      });
      const originalSave = vscode.window.showSaveDialog;
      (
        vscode.window as unknown as {
          showSaveDialog: () => Promise<vscode.Uri | undefined>;
        }
      ).showSaveDialog = async () => vscode.Uri.file(missingPath);

      try {
        const result = await view.createPatchFromShelf('a');
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.action, 'createPatch');
        assert.strictEqual(
          tracker.calls.length,
          1,
          `expected exactly one showErrorMessage call, got ${tracker.calls.length}`
        );
        assert.ok(
          tracker.calls[0].message.startsWith('Failed to write patch:'),
          `expected user-facing prefix, got: "${tracker.calls[0].message}"`
        );
        assert.strictEqual(
          requestedActions.length,
          0,
          'onDidRequestAction(createPatch) must not fire when the write failed'
        );
      } finally {
        actionSub.dispose();
        restoreMessageFunctions();
        (vscode.window as unknown as { showSaveDialog: typeof originalSave }).showSaveDialog =
          originalSave;
      }
    });
  });

  describe('error sanitization — unshelve / deleteShelfItem / renameShelfItem', () => {
    // Bracket-delimited URL triggers the CREDENTIAL_URL_REGEX pattern
    // reliably (same sentinel used in sanitizeGitError unit tests).
    const RAW = 'push failed: https://alice:secret@example.com/repo.git\n/Users/alice/code';
    const EXPECTED = 'push failed: https://<redacted>@example.com/repo.git\n~/code';

    it('unshelve: sanitizes both the toast and the structured error', async () => {
      svc._items.push({
        id: 'a',
        name: 'wip',
        timestamp: new Date(),
        files: [{ path: 'x.ts', diff: 'diff' }],
      });
      await view.refresh();

      // Replace the unshelve stub with one that throws a credentialed error.
      svc.unshelve = async () => {
        throw new Error(RAW);
      };

      const tracker = installErrorMessageTracker();
      try {
        // Pass options explicitly so the unshelve-options QuickPick isn't
        // summoned. We want the error-path to run against the actual
        // service call, not bail early on a missing dialog response.
        const result = await view.unshelve('a', { removeFromShelf: true });
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, EXPECTED);
        assert.ok(
          !result.error?.includes('alice:secret'),
          'structured error must not leak credentials'
        );
        assert.ok(
          !result.error?.includes('/Users/alice'),
          'structured error must not leak home path'
        );
        assert.strictEqual(tracker.calls.length, 1);
        assert.strictEqual(tracker.calls[0].message, `Failed to unshelve: ${EXPECTED}`);
      } finally {
        restoreMessageFunctions();
      }
    });

    it('deleteShelfItem: sanitizes both the toast and the structured error', async () => {
      svc._items.push({
        id: 'a',
        name: 'wip',
        timestamp: new Date(),
        files: [{ path: 'x.ts', diff: 'diff' }],
      });
      await view.refresh();

      svc.deleteShelfItem = (): void => {
        throw new Error(RAW);
      };

      // Auto-confirm the Delete prompt.
      const originalWarn = vscode.window.showWarningMessage;
      (
        vscode.window as unknown as {
          showWarningMessage: (...args: unknown[]) => Promise<string | undefined>;
        }
      ).showWarningMessage = async () => 'Delete';

      const tracker = installErrorMessageTracker();
      try {
        const result = await view.deleteShelfItem('a');
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, EXPECTED);
        assert.ok(
          !result.error?.includes('alice:secret'),
          'structured error must not leak credentials'
        );
        assert.strictEqual(tracker.calls.length, 1);
        assert.strictEqual(tracker.calls[0].message, `Failed to delete shelf item: ${EXPECTED}`);
      } finally {
        restoreMessageFunctions();
        (
          vscode.window as unknown as {
            showWarningMessage: typeof originalWarn;
          }
        ).showWarningMessage = originalWarn;
      }
    });

    it('renameShelfItem: sanitizes both the toast and the structured error', async () => {
      svc._items.push({
        id: 'a',
        name: 'old',
        timestamp: new Date(),
        files: [],
      });
      await view.refresh();

      svc.renameShelf = (): void => {
        throw new Error(RAW);
      };

      const originalInput = vscode.window.showInputBox;
      (
        vscode.window as unknown as {
          showInputBox: (opts?: unknown) => Promise<string | undefined>;
        }
      ).showInputBox = async () => 'new-name';

      const tracker = installErrorMessageTracker();
      try {
        const result = await view.renameShelfItem('a');
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, EXPECTED);
        assert.ok(
          !result.error?.includes('alice:secret'),
          'structured error must not leak credentials'
        );
        assert.strictEqual(tracker.calls.length, 1);
        assert.strictEqual(tracker.calls[0].message, `Failed to rename shelf: ${EXPECTED}`);
      } finally {
        restoreMessageFunctions();
        (
          vscode.window as unknown as {
            showInputBox: typeof originalInput;
          }
        ).showInputBox = originalInput;
      }
    });
  });

  describe('importPatches', () => {
    it('opens file dialog and imports each selected patch', async () => {
      const originalOpen = vscode.window.showOpenDialog;
      (
        vscode.window as unknown as {
          showOpenDialog: () => Promise<vscode.Uri[] | undefined>;
        }
      ).showOpenDialog = async () => [
        vscode.Uri.file('/tmp/a.patch'),
        vscode.Uri.file('/tmp/b.patch'),
      ];

      try {
        const results = await view.importPatches();
        assert.strictEqual(results.length, 2);
        assert.strictEqual(
          results.every((r) => r.success),
          true
        );
        assert.deepStrictEqual(
          svc._importedPatches.map((p) => p.patchPath),
          ['/tmp/a.patch', '/tmp/b.patch']
        );
      } finally {
        (vscode.window as unknown as { showOpenDialog: typeof originalOpen }).showOpenDialog =
          originalOpen;
      }
    });

    it('returns empty array when the user cancels the file picker', async () => {
      const originalOpen = vscode.window.showOpenDialog;
      (
        vscode.window as unknown as {
          showOpenDialog: () => Promise<vscode.Uri[] | undefined>;
        }
      ).showOpenDialog = async () => undefined;

      try {
        const results = await view.importPatches();
        assert.strictEqual(results.length, 0);
        assert.strictEqual(svc._importedPatches.length, 0);
      } finally {
        (vscode.window as unknown as { showOpenDialog: typeof originalOpen }).showOpenDialog =
          originalOpen;
      }
    });

    // TL-55: sanitize importPatches error path. Per-file import failures
    // embed their raw Error message into the structured result; `git
    // apply`/`git am` can surface credentialed remote URLs (from patch
    // headers) and /Users/<name> absolute paths, both of which must be
    // redacted before the string flows into downstream consumers (logs,
    // telemetry, webviews, aggregated UI counters).
    it('sanitizes importPatch errors — credentialed URLs + home paths redacted', async () => {
      const RAW = 'apply failed: https://alice:secret@example.com/repo.git\n/Users/alice/project';
      const EXPECTED = 'apply failed: https://<redacted>@example.com/repo.git\n~/project';

      svc.importPatch = (): Promise<IShelfItem> => {
        throw new Error(RAW);
      };

      const originalOpen = vscode.window.showOpenDialog;
      (
        vscode.window as unknown as {
          showOpenDialog: () => Promise<vscode.Uri[] | undefined>;
        }
      ).showOpenDialog = async () => [vscode.Uri.file('/tmp/bad.patch')];

      try {
        const results = await view.importPatches();
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].success, false);
        assert.strictEqual(results[0].error, EXPECTED);
        assert.ok(
          !results[0].error?.includes('alice:secret'),
          'structured error must not leak credentials'
        );
        assert.ok(
          !results[0].error?.includes('/Users/alice'),
          'structured error must not leak home path'
        );
      } finally {
        (vscode.window as unknown as { showOpenDialog: typeof originalOpen }).showOpenDialog =
          originalOpen;
      }
    });
  });

  // TL-42: refresh() returns { error? } so callers can surface a refresh
  // failure immediately rather than leaving it latent in _state.error until
  // the next shelf-list open. These specs pin the three behaviours:
  //   (a) success → resolves with `{}` (no error field)
  //   (b) service-throw → resolves with { error: sanitized } AND updates
  //       _state.error for the _showShelfList render path
  //   (c) sanitization — credentialed URL in the service error surfaces
  //       through the refresh() return value, not just the toast
  describe('refresh() — { error? } return contract', () => {
    it('resolves with {} when the service read succeeds', async () => {
      svc._items.push({
        id: 'a',
        name: 'ok',
        timestamp: new Date(),
        files: [],
      });
      const result = await view.refresh();
      assert.deepStrictEqual(result, {});
      assert.strictEqual(view.getState().error, undefined);
    });

    it('resolves with { error } and updates _state.error when getShelfItems throws', async () => {
      svc.getShelfItems = (): IShelfItem[] => {
        throw new Error('shelf storage corrupt');
      };
      const result = await view.refresh();
      assert.ok(result.error, 'refresh() must surface an error');
      assert.ok(
        result.error.includes('shelf storage corrupt'),
        `unexpected error text: ${result.error}`
      );
      assert.strictEqual(
        view.getState().error,
        result.error,
        '_state.error must mirror the returned error for the _showShelfList render path'
      );
    });

    it('sanitizes credentialed URLs and home paths in the returned error', async () => {
      const RAW = 'read failed: https://alice:secret@example.com/repo.git\n/Users/alice/project';
      const EXPECTED = 'read failed: https://<redacted>@example.com/repo.git\n~/project';
      svc.getShelfItems = (): IShelfItem[] => {
        throw new Error(RAW);
      };
      const result = await view.refresh();
      assert.strictEqual(result.error, EXPECTED);
      assert.ok(
        !result.error.includes('alice:secret'),
        'refresh() error must not leak credentials'
      );
      assert.ok(!result.error.includes('/Users/alice'), 'refresh() error must not leak home path');
    });

    it('resolves with {} when no repository is bound (no-op)', async () => {
      (view as unknown as { _repository: IRepository | undefined })._repository = undefined;
      const result = await view.refresh();
      assert.deepStrictEqual(result, {});
    });
  });

  // TL-42: verify user-facing callers (unshelve/delete/shelve/importPatches)
  // surface a refresh() failure as a warning toast. Previously refresh
  // failures would sit latent in _state.error until the next shelf-list
  // open, so a stale view after unshelve had no user-visible trace.
  describe('refresh-failure surfacing in user-facing callers', () => {
    it('unshelve emits a warning toast when the post-action refresh fails', async () => {
      svc._items.push({
        id: 'a',
        name: 'wip',
        timestamp: new Date(),
        files: [{ path: 'x.ts', diff: 'diff' }],
      });
      // First refresh (seeding) must succeed so unshelve finds the item.
      await view.refresh();

      // Now flip getShelfItems to throw on the post-unshelve refresh.
      let refreshCallCount = 0;
      const originalGet = svc.getShelfItems;
      svc.getShelfItems = (): IShelfItem[] => {
        refreshCallCount += 1;
        if (refreshCallCount >= 1) {
          throw new Error('refresh IO error');
        }
        return originalGet(repo);
      };

      const warnCalls: string[] = [];
      const originalWarn = vscode.window.showWarningMessage;
      (
        vscode.window as unknown as {
          showWarningMessage: (m: string, ...items: string[]) => Promise<string | undefined>;
        }
      ).showWarningMessage = async (m: string): Promise<string | undefined> => {
        warnCalls.push(m);
        return undefined;
      };

      try {
        await view.unshelve('a', { removeFromShelf: true });
        assert.ok(
          warnCalls.some((m) => m.startsWith('Shelf list refresh failed:')),
          `expected refresh-failed warning toast, got: ${warnCalls.join(' | ')}`
        );
      } finally {
        (
          vscode.window as unknown as { showWarningMessage: typeof originalWarn }
        ).showWarningMessage = originalWarn;
      }
    });

    it('deleteShelfItem emits a warning toast when the post-action refresh fails', async () => {
      svc._items.push({
        id: 'a',
        name: 'wip',
        timestamp: new Date(),
        files: [{ path: 'x.ts', diff: 'diff' }],
      });
      await view.refresh();

      // After delete, the next refresh() fires getShelfItems on an
      // already-emptied items array — we want it to throw instead.
      const originalGet = svc.getShelfItems;
      let fail = false;
      svc.getShelfItems = (): IShelfItem[] => {
        if (fail) {
          throw new Error('refresh IO error');
        }
        return originalGet(repo);
      };

      // Auto-confirm the Delete prompt.
      const originalWarn = vscode.window.showWarningMessage;
      const warnCalls: string[] = [];
      (
        vscode.window as unknown as {
          showWarningMessage: (m: string, ...items: unknown[]) => Promise<string | undefined>;
        }
      ).showWarningMessage = async (
        m: string,
        ..._items: unknown[]
      ): Promise<string | undefined> => {
        warnCalls.push(m);
        // The first call is the Delete confirm modal; flip to failure
        // mode so the post-delete refresh throws.
        if (m.includes('Are you sure')) {
          fail = true;
          return 'Delete';
        }
        return undefined;
      };

      try {
        const result = await view.deleteShelfItem('a');
        assert.strictEqual(result.success, true, 'delete itself must succeed');
        assert.ok(
          warnCalls.some((m) => m.startsWith('Shelf list refresh failed:')),
          `expected refresh-failed warning toast, got: ${warnCalls.join(' | ')}`
        );
      } finally {
        (
          vscode.window as unknown as { showWarningMessage: typeof originalWarn }
        ).showWarningMessage = originalWarn;
      }
    });
  });
});
