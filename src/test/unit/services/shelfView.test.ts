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
  });
});
