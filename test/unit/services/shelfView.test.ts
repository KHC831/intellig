/**
 * unit tests for ShelfView.
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
import { ShelfView } from '../../../src/shelf/ShelfView';
import {
  IShelfService,
  IShelfItem,
  IShelveSelection,
  IUnshelveOptions,
  IUnshelveResult,
  IImportPatchOptions,
} from '../../../src/shelf/interfaces/IShelfService';
import { IRepository, IDiff } from '../../../src/git-core/interfaces/IGitService';
import {
  setMockConfigValue,
  resetMockConfiguration,
  registeredContentProviders,
} from '../../mocks/vscode';
import {
  installErrorMessageTracker,
  installWarningMessageTracker,
  installInfoMessageTracker,
  restoreMessageFunctions,
} from '../../typed/windowStub';
import { __resetOutputChannelForTest, getOutputChannel } from '../../../src/utils/outputChannel';

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
      return items.filter((i) => i.deletedAt === undefined);
    },
    deleteShelfItem(_repo: IRepository, shelfId: string): void {
      const match = items.find((i) => i.id === shelfId);
      if (match && match.deletedAt === undefined) {
        match.deletedAt = new Date();
        emitter.fire(items.filter((i) => i.deletedAt === undefined));
      }
    },
    getRecycledShelfItems(): IShelfItem[] {
      return items.filter((i) => i.deletedAt !== undefined);
    },
    restoreFromRecycleBin(_repo: IRepository, shelfId: string): void {
      const match = items.find((i) => i.id === shelfId);
      if (match) {
        match.deletedAt = undefined;
        emitter.fire(items.filter((i) => i.deletedAt === undefined));
      }
    },
    deleteShelfItemPermanently(_repo: IRepository, shelfId: string): void {
      const index = items.findIndex((i) => i.id === shelfId);
      if (index >= 0) {
        items.splice(index, 1);
        emitter.fire(items.filter((i) => i.deletedAt === undefined));
      }
    },
    getShelfDiff(): Promise<IDiff[]> {
      return Promise.resolve([]);
    },
    getShelvedFileContent(_repo: IRepository, _shelfId: string, filePath: string): Promise<string> {
      return Promise.resolve(`shelved://${filePath}`);
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

describe('ShelfView', () => {
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

  describe('unshelveFiles (per-file)', () => {
    it('passes the picked file subset + removeFromShelf:true to unshelve', async () => {
      svc._items.push({
        id: 'a',
        name: 'wip',
        timestamp: new Date(),
        files: [
          { path: 'x.ts', diff: 'diff' },
          { path: 'y.ts', diff: 'diff' },
        ],
      });
      await view.refresh();

      // Multi-select picker: simulate the user choosing only x.ts.
      const originalPick = vscode.window.showQuickPick;
      (
        vscode.window as unknown as {
          showQuickPick: (items: unknown[]) => Promise<unknown>;
        }
      ).showQuickPick = async (items: unknown[]) =>
        (items as Array<{ label: string }>).filter((i) => i.label.includes('x.ts'));

      try {
        const result = await view.unshelveFiles('a');
        assert.strictEqual(result.success, true);
        assert.strictEqual(svc._unshelved.length, 1);
        assert.deepStrictEqual(svc._unshelved[0].options?.files, ['x.ts']);
        assert.strictEqual(svc._unshelved[0].options?.removeFromShelf, true);
      } finally {
        (vscode.window as unknown as { showQuickPick: typeof originalPick }).showQuickPick =
          originalPick;
      }
    });

    it('does not call unshelve when the file pick is cancelled', async () => {
      svc._items.push({
        id: 'a',
        name: 'wip',
        timestamp: new Date(),
        files: [
          { path: 'x.ts', diff: 'diff' },
          { path: 'y.ts', diff: 'diff' },
        ],
      });
      await view.refresh();

      const originalPick = vscode.window.showQuickPick;
      (
        vscode.window as unknown as {
          showQuickPick: (items: unknown[]) => Promise<unknown>;
        }
      ).showQuickPick = async () => undefined;

      try {
        const result = await view.unshelveFiles('a');
        assert.strictEqual(result.success, false);
        assert.strictEqual(svc._unshelved.length, 0, 'unshelve must not run on cancel');
      } finally {
        (vscode.window as unknown as { showQuickPick: typeof originalPick }).showQuickPick =
          originalPick;
      }
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

    it('warns that binary files were excluded instead of silently dropping them', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-shelfpatch-bin-'));
      const outPath = path.join(tmpDir, 'wip.patch');

      svc._items.push({
        id: 'a',
        name: 'wip',
        timestamp: new Date(),
        files: [
          { path: 'x.ts', diff: 'diff --git a/x.ts b/x.ts\n' },
          // A binary entry carries no text diff — it must NOT vanish silently.
          {
            path: 'logo.png',
            diff: '',
            isBinary: true,
            binaryContent: 'AAAA',
            binaryStatus: 'added',
          },
        ],
      });
      await view.refresh();

      const warnings = installWarningMessageTracker();
      const infos = installInfoMessageTracker();
      const originalSave = vscode.window.showSaveDialog;
      (
        vscode.window as unknown as {
          showSaveDialog: () => Promise<vscode.Uri | undefined>;
        }
      ).showSaveDialog = async () => vscode.Uri.file(outPath);

      try {
        const result = await view.createPatchFromShelf('a');
        assert.strictEqual(result.success, true, 'the text portion still exports successfully');

        // The text file is written; the binary is excluded but ANNOUNCED.
        const written = fs.readFileSync(outPath, 'utf-8');
        assert.ok(written.includes('diff --git a/x.ts'), 'text file must be in the patch');

        assert.strictEqual(infos.calls.length, 0, 'a plain success toast would hide the data loss');
        assert.strictEqual(
          warnings.calls.length,
          1,
          'binary exclusion must be surfaced as a warning'
        );
        assert.ok(
          /binary/i.test(warnings.calls[0].message) &&
            warnings.calls[0].message.includes('logo.png'),
          `warning must name the excluded binary, got: ${warnings.calls[0].message}`
        );
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

    // The aggregate toast "N patch file(s) could not be imported"
    // is informative-only. The per-file sanitized error lives in the
    // returned result[]; without routing it out, users have no way to see
    // which file failed with what error. Route
    // each failed patch's sanitized error into the shared OutputChannel
    // as a separate `appendLine` so `Output → IntelliG` shows the
    // filename + error. Keep the toast text unchanged.
    it('routes each failed import to OutputChannel with filename + sanitized error', async () => {
      // Two files: one succeeds, two fail with different sanitisable errors.
      const RAW_A = 'apply failed: https://alice:secret@example.com/a.git';
      const EXPECTED_A = 'apply failed: https://<redacted>@example.com/a.git';
      const RAW_B = 'apply failed: /Users/alice/project/b.patch: corrupt';
      const EXPECTED_B = 'apply failed: ~/project/b.patch: corrupt';

      svc.importPatch = (_repo, options): Promise<IShelfItem> => {
        if (options.patchPath === '/tmp/a.patch') {
          throw new Error(RAW_A);
        }
        if (options.patchPath === '/tmp/b.patch') {
          throw new Error(RAW_B);
        }
        return Promise.resolve({
          id: 'ok-1',
          name: options.name ?? 'ok',
          timestamp: new Date(),
          files: [{ path: options.patchPath ?? 'p', diff: 'diff' }],
        });
      };

      // Drop any prior cached channel so this test's appendLine calls
      // go into a fresh _lines bucket.
      __resetOutputChannelForTest();
      const channel = getOutputChannel() as unknown as { _lines: string[] };

      const originalOpen = vscode.window.showOpenDialog;
      (
        vscode.window as unknown as {
          showOpenDialog: () => Promise<vscode.Uri[] | undefined>;
        }
      ).showOpenDialog = async () => [
        vscode.Uri.file('/tmp/a.patch'),
        vscode.Uri.file('/tmp/b.patch'),
        vscode.Uri.file('/tmp/ok.patch'),
      ];

      try {
        const results = await view.importPatches();
        assert.strictEqual(results.length, 3);
        const failedCount = results.filter((r) => !r.success).length;
        assert.strictEqual(failedCount, 2, 'expected exactly two failed imports');

        // The OutputChannel must carry one line per failure with the
        // filename + sanitized error. Successful imports are silent.
        const failureLines = channel._lines.filter((l) => l.includes('ShelfView.importPatches'));
        assert.strictEqual(
          failureLines.length,
          2,
          `expected two per-file failure lines in OutputChannel, got:\n  ${channel._lines.join('\n  ')}`
        );

        // Each line must contain the filename + its own sanitized error.
        const lineForA = failureLines.find((l) => l.includes('a.patch'));
        const lineForB = failureLines.find((l) => l.includes('b.patch'));
        assert.ok(lineForA, 'expected a line mentioning a.patch');
        assert.ok(lineForB, 'expected a line mentioning b.patch');
        assert.ok(
          lineForA.includes(EXPECTED_A),
          `a.patch line must carry sanitized error; got: ${lineForA}`
        );
        assert.ok(
          lineForB.includes(EXPECTED_B),
          `b.patch line must carry sanitized error; got: ${lineForB}`
        );
        // And must not leak the raw credentials / home path.
        assert.ok(!lineForA.includes('alice:secret'), 'a.patch line must not leak credentials');
        assert.ok(!lineForB.includes('/Users/alice'), 'b.patch line must not leak home path');
      } finally {
        (vscode.window as unknown as { showOpenDialog: typeof originalOpen }).showOpenDialog =
          originalOpen;
        __resetOutputChannelForTest();
      }
    });

    // Sanitize importPatches error path. Per-file import failures
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

  // refresh() returns { error? } so callers can surface a refresh
  // failure immediately rather than leaving it latent in _state.error until
  // the next shelf-list open. No production consumer reads
  // IShelfViewState.error (the sole reader, _showShelfList, surfaces
  // refreshResult.error directly). These specs pin the three behaviours:
  //   (a) success → resolves with `{}` (no error field)
  //   (b) service-throw → resolves with { error: sanitized }
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
    });

    // getState() MUST NOT expose an `error` field. The canonical error
    // channel is the refresh() return value; an additional sideband on
    // IShelfViewState would be unread in production and risks a future
    // caller reading the latent-until-next-refresh value instead of the
    // live one.
    it('getState() does not expose an error field — refresh() is the sole error channel', async () => {
      // After a successful refresh
      svc._items.push({
        id: 'a',
        name: 'ok',
        timestamp: new Date(),
        files: [],
      });
      await view.refresh();
      assert.strictEqual(
        'error' in view.getState(),
        false,
        'getState() must not carry an error field after a successful refresh'
      );

      // And after a failed refresh
      svc.getShelfItems = (): IShelfItem[] => {
        throw new Error('shelf storage corrupt');
      };
      const result = await view.refresh();
      assert.ok(result.error, 'refresh() must still surface the error on its return value');
      assert.strictEqual(
        'error' in view.getState(),
        false,
        'getState() must not carry an error field after a failed refresh — refresh() return is canonical'
      );
    });

    it('resolves with { error } when getShelfItems throws', async () => {
      svc.getShelfItems = (): IShelfItem[] => {
        throw new Error('shelf storage corrupt');
      };
      const result = await view.refresh();
      assert.ok(result.error, 'refresh() must surface an error');
      assert.ok(
        result.error.includes('shelf storage corrupt'),
        `unexpected error text: ${result.error}`
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

  // Verify user-facing callers (unshelve/delete/shelve/importPatches)
  // surface a refresh() failure as a warning toast, so a stale view after
  // unshelve has a user-visible trace rather than a failure sitting latent
  // in _state.error until the next shelf-list open.
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

    // Parallel specs for showShelveDialog + importPatches +
    // _showShelfList. These all pass on current code (the surfacing code
    // lives at each call site already); they're explicitly GREEN-FIRST,
    // locking in the behaviour so a future regression that drops the
    // warning toast fails a pinned spec instead of sliding through.
    it('showShelveDialog emits a warning toast when the post-action refresh fails', async () => {
      // Seed a status so the dialog proceeds past the "no changes" early return.
      const view2 = new ShelfView(svc, () =>
        Promise.resolve([{ path: 'x.ts', indexStatus: 'M', workTreeStatus: ' ' } as never])
      );
      (view2 as unknown as { _repository: IRepository })._repository = repo;

      // The first refresh (seeding in the shelf-list open path) doesn't
      // run through this method; showShelveDialog calls shelve + then
      // refresh. Force the post-shelve refresh to throw.
      svc.getShelfItems = (): IShelfItem[] => {
        throw new Error('refresh IO error');
      };

      const originalPick = vscode.window.showQuickPick;
      (
        vscode.window as unknown as {
          showQuickPick: (items: unknown[]) => Promise<unknown>;
        }
      ).showQuickPick = async (items: unknown[]) => items.slice();

      const originalInput = vscode.window.showInputBox;
      (
        vscode.window as unknown as {
          showInputBox: (opts?: unknown) => Promise<string | undefined>;
        }
      ).showInputBox = async () => 'my-shelf';

      const warnCalls: string[] = [];
      const originalWarn = vscode.window.showWarningMessage;
      (
        vscode.window as unknown as {
          showWarningMessage: (m: string, ...items: unknown[]) => Promise<string | undefined>;
        }
      ).showWarningMessage = async (m: string): Promise<string | undefined> => {
        warnCalls.push(m);
        return undefined;
      };

      try {
        await view2.showShelveDialog(repo);
        assert.ok(
          warnCalls.some((m) => m.startsWith('Shelf list refresh failed:')),
          `expected refresh-failed warning toast, got: ${warnCalls.join(' | ')}`
        );
      } finally {
        (vscode.window as unknown as { showQuickPick: typeof originalPick }).showQuickPick =
          originalPick;
        (vscode.window as unknown as { showInputBox: typeof originalInput }).showInputBox =
          originalInput;
        (
          vscode.window as unknown as { showWarningMessage: typeof originalWarn }
        ).showWarningMessage = originalWarn;
        view2.dispose();
      }
    });

    it('importPatches emits a warning toast when the post-action refresh fails', async () => {
      // importPatches fires refresh at the end; make it throw.
      const originalGet = svc.getShelfItems;
      let imported = 0;
      svc.importPatch = (_r, opts): Promise<IShelfItem> => {
        imported += 1;
        return Promise.resolve({
          id: `imp-${imported}`,
          name: opts.name ?? 'imp',
          timestamp: new Date(),
          files: [{ path: 'p', diff: 'diff' }],
        });
      };
      svc.getShelfItems = (): IShelfItem[] => {
        throw new Error('refresh IO error');
      };

      const originalOpen = vscode.window.showOpenDialog;
      (
        vscode.window as unknown as {
          showOpenDialog: () => Promise<vscode.Uri[] | undefined>;
        }
      ).showOpenDialog = async () => [vscode.Uri.file('/tmp/a.patch')];

      const warnCalls: string[] = [];
      const originalWarn = vscode.window.showWarningMessage;
      (
        vscode.window as unknown as {
          showWarningMessage: (m: string, ...items: unknown[]) => Promise<string | undefined>;
        }
      ).showWarningMessage = async (m: string): Promise<string | undefined> => {
        warnCalls.push(m);
        return undefined;
      };

      try {
        await view.importPatches();
        assert.ok(
          warnCalls.some((m) => m.startsWith('Shelf list refresh failed:')),
          `expected refresh-failed warning toast, got: ${warnCalls.join(' | ')}`
        );
      } finally {
        (vscode.window as unknown as { showOpenDialog: typeof originalOpen }).showOpenDialog =
          originalOpen;
        (
          vscode.window as unknown as { showWarningMessage: typeof originalWarn }
        ).showWarningMessage = originalWarn;
        svc.getShelfItems = originalGet.bind(svc);
      }
    });

    it('_showShelfList emits an error toast when the refresh-on-open fails', async () => {
      svc.getShelfItems = (): IShelfItem[] => {
        throw new Error('refresh IO error');
      };
      const tracker = installErrorMessageTracker();
      try {
        // show() delegates to the private _showShelfList which is the
        // caller we're pinning here; the refresh-on-open failure must
        // route to showErrorMessage (more severe than the warning toast
        // path taken by user-action callers) because the user
        // explicitly asked to open the list and can't see one without a
        // successful refresh.
        await view.show(repo);
        assert.ok(
          tracker.calls.some((c) => c.message.startsWith('Failed to load shelf items:')),
          `expected load-failed error toast, got: ${tracker.calls.map((c) => c.message).join(' | ')}`
        );
      } finally {
        restoreMessageFunctions();
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
        // The first call is the recycle confirm modal; flip to failure
        // mode so the post-delete refresh throws.
        if (m.includes('Recently Deleted')) {
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

  // Close the boundary on the two remaining ShelfView action paths
  // (`showShelveDialog`, `viewShelfItem`) whose catch blocks must run raw
  // `error.message` through `sanitizeGitError` rather than concatenating it
  // straight into the toast template. Mirrors the unshelve /
  // deleteShelfItem / renameShelfItem coverage.
  describe('action-path toasts route through sanitizeGitError', () => {
    const RAW = 'fail: https://alice:secret@example.com/repo.git\n/Users/alice/project';
    const EXPECTED = 'fail: https://<redacted>@example.com/repo.git\n~/project';

    it('showShelveDialog: sanitizes credentialed URL + home path in toast', async () => {
      const view2 = new ShelfView(svc, () =>
        Promise.resolve([{ path: 'x.ts', indexStatus: 'M', workTreeStatus: ' ' } as never])
      );
      (view2 as unknown as { _repository: IRepository })._repository = repo;

      // shelve throws with credentialed payload.
      svc.shelve = (): Promise<never> => Promise.reject(new Error(RAW));

      const originalPick = vscode.window.showQuickPick;
      (
        vscode.window as unknown as {
          showQuickPick: (items: unknown[]) => Promise<unknown>;
        }
      ).showQuickPick = async (items: unknown[]) => items.slice();
      const originalInput = vscode.window.showInputBox;
      (
        vscode.window as unknown as {
          showInputBox: (opts?: unknown) => Promise<string | undefined>;
        }
      ).showInputBox = async () => 'my-shelf';

      const tracker = installErrorMessageTracker();
      try {
        const result = await view2.showShelveDialog(repo);
        assert.strictEqual(result.shelved, false);
        assert.strictEqual(tracker.calls.length, 1, 'expected one error toast');
        assert.strictEqual(tracker.calls[0].message, `Failed to shelve changes: ${EXPECTED}`);
        assert.ok(
          !tracker.calls[0].message.includes('alice:secret'),
          'toast must not leak credentials'
        );
        assert.ok(
          !tracker.calls[0].message.includes('/Users/alice'),
          'toast must not leak home path'
        );
      } finally {
        restoreMessageFunctions();
        (vscode.window as unknown as { showQuickPick: typeof originalPick }).showQuickPick =
          originalPick;
        (vscode.window as unknown as { showInputBox: typeof originalInput }).showInputBox =
          originalInput;
        view2.dispose();
      }
    });

    it('viewShelfItem: sanitizes credentialed URL + home path in toast', async () => {
      svc._items.push({
        id: 'a',
        name: 'wip',
        timestamp: new Date(),
        files: [{ path: 'x.ts', diff: 'diff' }],
      });
      await view.refresh();

      // getShelfDiff throws with credentialed payload.
      svc.getShelfDiff = (): Promise<never> => Promise.reject(new Error(RAW));

      const tracker = installErrorMessageTracker();
      try {
        const diffs = await view.viewShelfItem('a');
        assert.deepStrictEqual(diffs, []);
        assert.strictEqual(tracker.calls.length, 1, 'expected one error toast');
        assert.strictEqual(tracker.calls[0].message, `Failed to view shelf item: ${EXPECTED}`);
        assert.ok(
          !tracker.calls[0].message.includes('alice:secret'),
          'toast must not leak credentials'
        );
        assert.ok(
          !tracker.calls[0].message.includes('/Users/alice'),
          'toast must not leak home path'
        );
      } finally {
        restoreMessageFunctions();
      }
    });
  });

  describe('Compare with Local (shelved-vs-working-tree diff)', () => {
    const SHELF_SCHEME = 'intellig-shelf';
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-view-diff-'));
      repo = {
        rootUri: vscode.Uri.file(tmpDir),
        state: 'idle',
        remotes: [],
        submodules: [],
      } as unknown as IRepository;
      (view as unknown as { _repository: IRepository })._repository = repo;
    });

    afterEach(() => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors.
      }
    });

    it('registers an intellig-shelf content provider that serves the shelved file content', async () => {
      const provider = registeredContentProviders.get(SHELF_SCHEME);
      assert.ok(provider, 'ShelfView should register an intellig-shelf content provider');

      svc._items.push({
        id: 's1',
        name: 'S',
        timestamp: new Date(),
        files: [{ path: 'a.ts', diff: '' }],
      });
      await view.refresh();

      const uri = vscode.Uri.from({ scheme: SHELF_SCHEME, path: '/a.ts', query: 's1' });
      const content = await provider.provideTextDocumentContent(uri);

      // Mock getShelvedFileContent echoes `shelved://<path>`.
      assert.strictEqual(content, 'shelved://a.ts');
    });

    it('opens vscode.diff with the shelved version on the left and the working-tree file on the right', async () => {
      const fileAbs = path.join(tmpDir, 'a.ts');
      fs.writeFileSync(fileAbs, 'local content\n');

      svc._items.push({
        id: 's2',
        name: 'S2',
        timestamp: new Date(),
        files: [{ path: 'a.ts', diff: '' }],
      });
      await view.refresh();

      svc.getShelfDiff = (): Promise<IDiff[]> =>
        Promise.resolve([
          {
            path: 'a.ts',
            status: 'modified',
            hunks: [
              { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, header: '@@', lines: [] },
            ],
            binary: false,
          },
        ]);

      const calls: Array<{ command: string; args: unknown[] }> = [];
      const origQuickPick = vscode.window.showQuickPick;
      const origExec = vscode.commands.executeCommand;
      (
        vscode.window as unknown as { showQuickPick: (items: unknown[]) => Promise<unknown> }
      ).showQuickPick = async (items: unknown[]) => items[0];
      (
        vscode.commands as unknown as {
          executeCommand: (command: string, ...args: unknown[]) => Promise<unknown>;
        }
      ).executeCommand = async (command: string, ...args: unknown[]) => {
        calls.push({ command, args });
        return undefined;
      };

      try {
        await view.viewShelfItem('s2');
      } finally {
        (vscode.window as unknown as { showQuickPick: typeof origQuickPick }).showQuickPick =
          origQuickPick;
        (vscode.commands as unknown as { executeCommand: typeof origExec }).executeCommand =
          origExec;
      }

      const diffCall = calls.find((c) => c.command === 'vscode.diff');
      assert.ok(diffCall, 'expected a vscode.diff invocation');
      const [left, right] = diffCall.args as [vscode.Uri, vscode.Uri];
      assert.strictEqual(left.scheme, SHELF_SCHEME, 'left side is the shelved virtual document');
      assert.strictEqual(left.query, 's2', 'left side carries the shelf id');
      assert.strictEqual(right.scheme, 'file', 'right side is the working-tree file');
      assert.strictEqual(right.fsPath, fileAbs, 'right side points at the on-disk file');
    });
  });

  describe('_showShelfDiffPicker — basename collision', () => {
    it('opens the file the user picked, not a basename twin', async () => {
      const diffA = {
        path: 'src/a/config.ts',
        status: 'modified',
        hunks: [{}],
        binary: false,
      } as unknown as IDiff;
      const diffB = {
        path: 'src/b/config.ts',
        status: 'modified',
        hunks: [{}],
        binary: false,
      } as unknown as IDiff;

      let captured: IDiff | undefined;
      (
        view as unknown as { _showShelvedVsLocalDiff: (i: IShelfItem, d: IDiff) => Promise<void> }
      )._showShelvedVsLocalDiff = async (_i, d) => {
        captured = d;
      };

      const oPick = vscode.window.showQuickPick;
      // User picks the SECOND item — same basename (config.ts) as the first.
      (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = async (
        items: vscode.QuickPickItem[]
      ) => items[1];

      try {
        await (
          view as unknown as {
            _showShelfDiffPicker: (i: IShelfItem, d: IDiff[]) => Promise<void>;
          }
        )._showShelfDiffPicker({ id: 'a', name: 'wip', timestamp: new Date(), files: [] }, [
          diffA,
          diffB,
        ]);
        assert.strictEqual(
          captured?.path,
          'src/b/config.ts',
          'must open the picked file, not its basename twin'
        );
      } finally {
        (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = oPick;
      }
    });
  });
});
