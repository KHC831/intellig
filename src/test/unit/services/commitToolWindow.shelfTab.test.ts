/**
 * Unit tests for T3-10: Combined Stash+Shelf tab in the Commit Tool Window.
 *
 * Coverage:
 *  - `buildShelfTabEntries` pure helper — filter states + newest-first sort
 *    + stable tie-break.
 *  - `isShelfTabFilter` whitelist guard.
 *  - `shelfRowContextMenuLabels` surfaces Restore only for Already-Unshelved
 *    entries; otherwise returns the standard IR-parity list.
 *  - `stashRowContextMenuLabels` returns the full stash menu.
 *  - `renderShelfTabPanel` writes the active-filter CSS class + empty-state
 *    copy that matches the filter.
 *  - CommitToolWindow host-side: filter toggle persists to workspaceState,
 *    shelfTabContextAction dispatches to the correct controller method,
 *    and `contextOpen` escalates to a QuickPick that honors the row kind.
 */

/*
 * Stub factories synthesise IGitService / IChangelistService implementations
 * whose member signatures return `Promise<T>`; no-await stub bodies are
 * intentional here.
 */

import '../../../test/setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  CommitToolWindow,
  buildShelfTabEntries,
  isShelfTabFilter,
  shelfRowContextMenuLabels,
  stashRowContextMenuLabels,
  renderShelfTabPanel,
  renderCommitToolWindowHtml,
  COMMIT_TOOL_WINDOW_SHELF_TAB_FILTER_STATE_KEY,
} from '../../../services';
import type {
  IShelfTabEntry,
  IShelfTabShelfController,
  IShelfTabStashController,
} from '../../../services';
import type { IShelfItem } from '../../../services/interfaces/IShelfService';
import type { IStash, IGitService, IRepository } from '../../../services/interfaces/IGitService';
import type { IChangelistService } from '../../../services/interfaces/IChangelistService';
import { EventEmitter, Uri } from '../../mocks/vscode';

// ─── pure helpers ────────────────────────────────────────────────────────────

describe('T3-10 — buildShelfTabEntries', () => {
  const shelfItem = (id: string, name: string, ts: Date, fileCount = 1): IShelfItem => ({
    id,
    name,
    timestamp: ts,
    files: Array.from({ length: fileCount }, (_, i) => ({ path: `${id}-${i}.ts`, diff: '' })),
  });
  const stash = (index: number, message: string, date: Date): IStash => ({
    index,
    message,
    date,
  });

  it('filter=shelves returns only shelf rows', () => {
    const out = buildShelfTabEntries(
      [shelfItem('s1', 'wip', new Date(1000))],
      [stash(0, 'stashed', new Date(2000))],
      'shelves'
    );
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].kind, 'shelf');
  });

  it('filter=stashes returns only stash rows', () => {
    const out = buildShelfTabEntries(
      [shelfItem('s1', 'wip', new Date(2000))],
      [stash(0, 'stashed', new Date(1000))],
      'stashes'
    );
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].kind, 'stash');
  });

  it('filter=both returns both, sorted newest-first', () => {
    const out = buildShelfTabEntries(
      [
        shelfItem('s1', 'older-shelf', new Date(1000)),
        shelfItem('s2', 'newest-shelf', new Date(3000)),
      ],
      [stash(0, 'middle-stash', new Date(2000))],
      'both'
    );
    assert.strictEqual(out.length, 3);
    assert.strictEqual(out[0].name, 'newest-shelf');
    assert.strictEqual(out[1].name, 'middle-stash');
    assert.strictEqual(out[2].name, 'older-shelf');
  });

  it('stable tie-break by id when timestamps are equal', () => {
    const t = new Date(1000);
    const out = buildShelfTabEntries(
      [shelfItem('b-shelf', 'b', t), shelfItem('a-shelf', 'a', t)],
      [],
      'both'
    );
    assert.strictEqual(out[0].id, 'a-shelf');
    assert.strictEqual(out[1].id, 'b-shelf');
  });

  it('preserves unshelvedAt on shelf rows', () => {
    const ts = new Date(1000);
    const unshelved = new Date(2000);
    const out = buildShelfTabEntries(
      [{ id: 's1', name: 'done', timestamp: ts, files: [], unshelvedAt: unshelved }],
      [],
      'both'
    );
    assert.strictEqual(out[0].kind, 'shelf');
    if (out[0].kind === 'shelf') {
      assert.strictEqual(out[0].unshelvedAt?.getTime(), unshelved.getTime());
    }
  });
});

describe('T3-10 — isShelfTabFilter', () => {
  it('whitelists the 3 valid strings', () => {
    assert.strictEqual(isShelfTabFilter('shelves'), true);
    assert.strictEqual(isShelfTabFilter('stashes'), true);
    assert.strictEqual(isShelfTabFilter('both'), true);
  });

  it('rejects anything else', () => {
    assert.strictEqual(isShelfTabFilter('other'), false);
    assert.strictEqual(isShelfTabFilter(undefined), false);
    assert.strictEqual(isShelfTabFilter(null), false);
    assert.strictEqual(isShelfTabFilter(42), false);
  });
});

describe('T3-10 — shelfRowContextMenuLabels', () => {
  it('includes Restore only when isAlreadyUnshelved is true', () => {
    const plain = shelfRowContextMenuLabels({ isAlreadyUnshelved: false });
    assert.strictEqual(
      plain.find((e) => e.action === 'shelfRestore'),
      undefined
    );

    const restored = shelfRowContextMenuLabels({ isAlreadyUnshelved: true });
    assert.ok(restored.find((e) => e.action === 'shelfRestore'));
    // Restore should be first so the menu default is "bring it back".
    assert.strictEqual(restored[0].action, 'shelfRestore');
  });

  it('always exposes the standard actions', () => {
    const labels = shelfRowContextMenuLabels({ isAlreadyUnshelved: false }).map((e) => e.action);
    assert.ok(labels.includes('shelfApply'));
    assert.ok(labels.includes('shelfShowDiff'));
    assert.ok(labels.includes('shelfRename'));
    assert.ok(labels.includes('shelfCreatePatch'));
    assert.ok(labels.includes('shelfImportPatches'));
    assert.ok(labels.includes('shelfDelete'));
  });

  it('uses Unicode … on prompt-opening entries', () => {
    const labels = shelfRowContextMenuLabels({ isAlreadyUnshelved: true }).map((e) => e.label);
    assert.ok(
      labels.some((l) => l.endsWith('…')),
      'at least one label must use Unicode …'
    );
    // Apply + Delete must not have the ellipsis.
    assert.ok(labels.some((l) => l === 'Apply (Unshelve)'));
    assert.ok(labels.some((l) => l === 'Delete'));
  });
});

describe('T3-10 — stashRowContextMenuLabels', () => {
  it('returns Pop + Apply + Show Diff + Rename… + Create Branch…  + Drop', () => {
    const labels = stashRowContextMenuLabels().map((e) => e.action);
    assert.deepStrictEqual(labels, [
      'stashPop',
      'stashApply',
      'stashShowDiff',
      'stashRename',
      'stashBranchFromStash',
      'stashDrop',
    ]);
  });
});

// ─── renderShelfTabPanel ─────────────────────────────────────────────────────

describe('T3-10 — renderShelfTabPanel', () => {
  it('marks the active filter button with ctw-shelf-filter-active', () => {
    const html = renderShelfTabPanel([], 'stashes');
    const matches = html.match(/ctw-shelf-filter-active/g);
    assert.ok(matches && matches.length === 1, 'exactly one button should be active');
    assert.ok(html.includes('data-shelf-filter="stashes"'));
    assert.ok(html.includes('aria-pressed="true"'));
  });

  it('renders filter-appropriate empty copy', () => {
    assert.ok(renderShelfTabPanel([], 'shelves').includes('Shelf is empty.'));
    assert.ok(renderShelfTabPanel([], 'stashes').includes('No stash entries.'));
    assert.ok(renderShelfTabPanel([], 'both').includes('No shelf or stash entries.'));
  });

  it('renders type badges per row', () => {
    const entries: IShelfTabEntry[] = [
      { kind: 'shelf', id: 's1', name: 'wip', timestamp: new Date(2000), fileCount: 2 },
      { kind: 'stash', id: 'stash@{0}', name: 'stashed', timestamp: new Date(1000), index: 0 },
    ];
    const html = renderShelfTabPanel(entries, 'both');
    assert.ok(html.includes('📚'), 'shelf badge should render');
    assert.ok(html.includes('📦'), 'stash badge should render');
    assert.ok(html.includes('data-row-kind="shelf"'));
    assert.ok(html.includes('data-row-kind="stash"'));
    assert.ok(html.includes('data-shelf-id="s1"'));
    assert.ok(html.includes('data-stash-index="0"'));
  });

  it('appends "(already unshelved)" suffix for entries with unshelvedAt', () => {
    const entries: IShelfTabEntry[] = [
      {
        kind: 'shelf',
        id: 's1',
        name: 'old',
        timestamp: new Date(1000),
        fileCount: 1,
        unshelvedAt: new Date(2000),
      },
    ];
    const html = renderShelfTabPanel(entries, 'both');
    assert.ok(html.includes('(already unshelved)'));
  });
});

// ─── CommitToolWindow host-side behavior ─────────────────────────────────────

/**
 * Build a minimal in-memory Memento that records updates so tests can assert
 * persistence behavior without real workspaceState.
 */
function makeMemento(): vscode.Memento & { _store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue?: T): T | undefined {
      return store.has(key) ? (store.get(key) as T) : defaultValue;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) {
        store.delete(key);
      } else {
        store.set(key, value);
      }
    },
    keys(): readonly string[] {
      return Array.from(store.keys());
    },
    _store: store,
  };
}

function makeGitService(opts?: { stashes?: IStash[] }): IGitService {
  const emitter = new EventEmitter<IRepository>();
  return {
    onDidChangeRepository: emitter.event,
    getRepositories(): IRepository[] {
      return [];
    },
    getRepository(): Promise<undefined> {
      return Promise.resolve(undefined);
    },
    async stashList(): Promise<IStash[]> {
      return opts?.stashes ?? [];
    },
    // Unused but required for the type surface.
    getStatus: async (): Promise<[]> => [],
    stage: async (): Promise<void> => {},
    unstage: async (): Promise<void> => {},
  } as unknown as IGitService;
}

function makeChangelistService(): IChangelistService {
  const emitter = new EventEmitter<[]>();
  return {
    onDidChangeChangelists: emitter.event,
    getChangelists: (): [] => [],
    createChangelist: (): unknown => ({}),
    deleteChangelist: (): void => {},
    renameChangelist: (): void => {},
    moveToChangelist: (): void => {},
    getDefaultChangelist: (): unknown => ({
      id: 'default',
      name: 'Default',
      isDefault: true,
      files: [],
    }),
    async setActiveChangelist(): Promise<void> {},
    async getActiveChangelist() {
      return { id: 'default', name: 'Default', isDefault: true, files: [] };
    },
    async reconcileWithGitStatus(): Promise<void> {},
    async getChangelistForFile(): Promise<undefined> {
      return undefined;
    },
    dispose(): void {},
  } as unknown as IChangelistService;
}

function makeShelfService(items: IShelfItem[] = []): {
  svc: ReturnType<typeof makeShelfServiceImpl>;
} {
  return { svc: makeShelfServiceImpl(items) };
}

function makeShelfServiceImpl(items: IShelfItem[]) {
  const emitter = new EventEmitter<IShelfItem[]>();
  return {
    onDidChangeShelf: emitter.event,
    async shelve(): Promise<IShelfItem> {
      return items[0];
    },
    async unshelve(): Promise<{ success: boolean }> {
      return { success: true };
    },
    getShelfItems(): IShelfItem[] {
      return items;
    },
    deleteShelfItem(): void {},
    renameShelf(): void {},
    async importPatch(): Promise<IShelfItem> {
      return items[0];
    },
    markAsUnshelved(): void {},
    restoreShelf(): void {},
    filterShelfFiles(): undefined {
      return undefined;
    },
    getShelfDiff(): Promise<[]> {
      return Promise.resolve([]);
    },
    dispose(): void {},
  } as unknown as import('../../../services/interfaces/IShelfService').IShelfService;
}

describe('T3-10 — CommitToolWindow filter persistence', () => {
  it('hydrates the filter from workspaceState on construction', () => {
    const mem = makeMemento();
    mem._store.set(COMMIT_TOOL_WINDOW_SHELF_TAB_FILTER_STATE_KEY, 'stashes');
    const { svc: shelf } = makeShelfService();
    const ctw = new CommitToolWindow(
      Uri.file('/tmp/ext'),
      makeGitService(),
      makeChangelistService(),
      shelf,
      mem
    );
    try {
      assert.strictEqual(ctw.getShelfTabFilter(), 'stashes');
    } finally {
      ctw.dispose();
    }
  });

  it('defaults to "both" when no persisted value exists', () => {
    const mem = makeMemento();
    const { svc: shelf } = makeShelfService();
    const ctw = new CommitToolWindow(
      Uri.file('/tmp/ext'),
      makeGitService(),
      makeChangelistService(),
      shelf,
      mem
    );
    try {
      assert.strictEqual(ctw.getShelfTabFilter(), 'both');
    } finally {
      ctw.dispose();
    }
  });

  it('rejects corrupt persisted values (falls back to "both")', () => {
    const mem = makeMemento();
    mem._store.set(COMMIT_TOOL_WINDOW_SHELF_TAB_FILTER_STATE_KEY, 'not-a-filter');
    const { svc: shelf } = makeShelfService();
    const ctw = new CommitToolWindow(
      Uri.file('/tmp/ext'),
      makeGitService(),
      makeChangelistService(),
      shelf,
      mem
    );
    try {
      assert.strictEqual(ctw.getShelfTabFilter(), 'both');
    } finally {
      ctw.dispose();
    }
  });

  it('setShelfTabFilter persists the new value', async () => {
    const mem = makeMemento();
    const { svc: shelf } = makeShelfService();
    const ctw = new CommitToolWindow(
      Uri.file('/tmp/ext'),
      makeGitService(),
      makeChangelistService(),
      shelf,
      mem
    );
    try {
      await ctw.setShelfTabFilter('stashes');
      assert.strictEqual(mem._store.get(COMMIT_TOOL_WINDOW_SHELF_TAB_FILTER_STATE_KEY), 'stashes');
      assert.strictEqual(ctw.getShelfTabFilter(), 'stashes');
    } finally {
      ctw.dispose();
    }
  });
});

describe('T3-10 — CommitToolWindow shelfTabContextAction routing', () => {
  function makeRig(): {
    ctw: CommitToolWindow;
    shelfCalls: string[];
    stashCalls: string[];
  } {
    const mem = makeMemento();
    const { svc: shelf } = makeShelfService();
    const ctw = new CommitToolWindow(
      Uri.file('/tmp/ext'),
      makeGitService(),
      makeChangelistService(),
      shelf,
      mem
    );
    const shelfCalls: string[] = [];
    const stashCalls: string[] = [];
    const shelfCtrl: IShelfTabShelfController = {
      apply: async (id): Promise<void> => {
        shelfCalls.push(`apply:${id}`);
      },
      showDiff: async (id): Promise<void> => {
        shelfCalls.push(`showDiff:${id}`);
      },
      delete: async (id): Promise<void> => {
        shelfCalls.push(`delete:${id}`);
      },
      rename: async (id): Promise<void> => {
        shelfCalls.push(`rename:${id}`);
      },
      restore: async (id): Promise<void> => {
        shelfCalls.push(`restore:${id}`);
      },
      importPatches: async (): Promise<void> => {
        shelfCalls.push('importPatches');
      },
      createPatch: async (id): Promise<void> => {
        shelfCalls.push(`createPatch:${id}`);
      },
    };
    const stashCtrl: IShelfTabStashController = {
      apply: async (i): Promise<void> => {
        stashCalls.push(`apply:${i}`);
      },
      pop: async (i): Promise<void> => {
        stashCalls.push(`pop:${i}`);
      },
      drop: async (i): Promise<void> => {
        stashCalls.push(`drop:${i}`);
      },
      showDiff: async (i): Promise<void> => {
        stashCalls.push(`showDiff:${i}`);
      },
      rename: async (i): Promise<void> => {
        stashCalls.push(`rename:${i}`);
      },
      branchFromStash: async (i): Promise<void> => {
        stashCalls.push(`branchFromStash:${i}`);
      },
    };
    ctw.setShelfTabControllers(shelfCtrl, stashCtrl);
    return { ctw, shelfCalls, stashCalls };
  }

  async function dispatch(ctw: CommitToolWindow, message: Record<string, unknown>): Promise<void> {
    await (
      ctw as unknown as {
        _handleWebviewMessage: (m: Record<string, unknown>) => Promise<void>;
      }
    )._handleWebviewMessage({ type: 'shelfTabContextAction', ...message });
  }

  it('dispatches shelf actions via shelfId', async () => {
    const { ctw, shelfCalls } = makeRig();
    try {
      await dispatch(ctw, { action: 'shelfApply', rowKind: 'shelf', shelfId: 's1' });
      await dispatch(ctw, { action: 'shelfRename', rowKind: 'shelf', shelfId: 's1' });
      await dispatch(ctw, { action: 'shelfDelete', rowKind: 'shelf', shelfId: 's1' });
      await dispatch(ctw, { action: 'shelfImportPatches', rowKind: 'shelf', shelfId: 's1' });
      assert.deepStrictEqual(shelfCalls, ['apply:s1', 'rename:s1', 'delete:s1', 'importPatches']);
    } finally {
      ctw.dispose();
    }
  });

  it('dispatches stash actions via stashIndex', async () => {
    const { ctw, stashCalls } = makeRig();
    try {
      await dispatch(ctw, { action: 'stashPop', rowKind: 'stash', stashIndex: 2 });
      await dispatch(ctw, { action: 'stashBranchFromStash', rowKind: 'stash', stashIndex: 0 });
      await dispatch(ctw, { action: 'stashDrop', rowKind: 'stash', stashIndex: 0 });
      assert.deepStrictEqual(stashCalls, ['pop:2', 'branchFromStash:0', 'drop:0']);
    } finally {
      ctw.dispose();
    }
  });

  it('no-ops when rowKind/ids are missing', async () => {
    const { ctw, shelfCalls, stashCalls } = makeRig();
    try {
      await dispatch(ctw, { action: 'shelfApply', rowKind: 'shelf' }); // no shelfId
      await dispatch(ctw, { action: 'stashPop', rowKind: 'stash' }); // no stashIndex
      await dispatch(ctw, { action: 'shelfApply' }); // no rowKind
      assert.deepStrictEqual(shelfCalls, []);
      assert.deepStrictEqual(stashCalls, []);
    } finally {
      ctw.dispose();
    }
  });

  it('shelfTabFilterChange message updates state + persists', async () => {
    const { ctw } = makeRig();
    try {
      await (
        ctw as unknown as {
          _handleWebviewMessage: (m: Record<string, unknown>) => Promise<void>;
        }
      )._handleWebviewMessage({ type: 'shelfTabFilterChange', filter: 'stashes' });
      assert.strictEqual(ctw.getShelfTabFilter(), 'stashes');
    } finally {
      ctw.dispose();
    }
  });
});

// ─── render smoke: renderCommitToolWindowHtml still handles legacy shape ────

describe('T3-10 — renderCommitToolWindowHtml backward compat', () => {
  it('works without the new shelfTab* fields (legacy callers)', () => {
    const html = renderCommitToolWindowHtml({
      cspSource: 'vscode-webview://mock',
      activeTab: 'shelf',
      changelists: [],
      shelfItems: [],
      composer: { message: '', amend: false, signOff: false },
    });
    // Falls back to filter='shelves' → "Shelf is empty." copy surfaces.
    assert.ok(html.includes('Shelf is empty.'));
  });

  it('honors explicit shelfTabEntries + shelfTabFilter', () => {
    const html = renderCommitToolWindowHtml({
      cspSource: 'vscode-webview://mock',
      activeTab: 'shelf',
      changelists: [],
      shelfItems: [],
      shelfTabEntries: [
        { kind: 'stash', id: 'stash@{0}', name: 'wip', timestamp: new Date(), index: 0 },
      ],
      shelfTabFilter: 'stashes',
      composer: { message: '', amend: false, signOff: false },
    });
    assert.ok(html.includes('📦'));
    assert.ok(html.includes('data-row-kind="stash"'));
    assert.ok(html.includes('data-shelf-filter="stashes"'));
  });
});
