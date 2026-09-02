/**
 * Unit tests for Combined Stash+Shelf tab in the Commit Tool Window.
 *
 * Coverage:
 *  - `buildShelfTabEntries` pure helper — filter states + newest-first sort
 *    + stable tie-break.
 *  - `isShelfTabFilter` whitelist guard.
 *  - `shelfRowContextMenuLabels` surfaces Restore only for Already-Unshelved
 *    entries; otherwise returns the standard IR-parity list.
 *  - `stashRowContextMenuLabels` returns the full stash menu.
 *  - the shelf panel (built client-side via the inline script from the INIT
 *    island) writes the active-filter CSS class + empty-state copy that
 *    matches the filter.
 *  - CommitToolWindow host-side: filter toggle persists to workspaceState,
 *    shelfTabContextAction dispatches to the correct controller method,
 *    and `contextOpen` answers with the menu items for the row kind.
 */

/*
 * Stub factories synthesise IGitService / IChangelistService implementations
 * whose member signatures return `Promise<T>`; no-await stub bodies are
 * intentional here.
 */

import '../../setup';
import { okAsync } from 'neverthrow';
import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  CommitToolWindow,
  buildShelfTabEntries,
  isShelfTabFilter,
  shelfRowContextMenuLabels,
  stashRowContextMenuLabels,
  buildCommitToolWindowBodyParts,
  COMMIT_TOOL_WINDOW_SHELF_TAB_FILTER_STATE_KEY,
} from '../../../src/services';
import type { IRenderInput } from '../../../src/services';
import { bootWebviewEntry, IWebviewEntryHarness } from '../../helpers/bootWebviewEntry';
import type {
  IShelfTabEntry,
  IShelfTabShelfController,
  IShelfTabStashController,
} from '../../../src/services';
import type { IShelfItem } from '../../../src/shelf/interfaces/IShelfService';
import type {
  IStash,
  IGitService,
  IRepository,
} from '../../../src/git-core/interfaces/IGitService';
import type { IChangelistService } from '../../../src/changelists/interfaces/IChangelistService';
import { EventEmitter, Uri } from '../../mocks/vscode';

// ─── pure helpers ────────────────────────────────────────────────────────────

describe('buildShelfTabEntries', () => {
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

describe('isShelfTabFilter', () => {
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

describe('shelfRowContextMenuLabels', () => {
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

describe('stashRowContextMenuLabels', () => {
  it('returns Pop + Apply + Show Diff + Rename… + Create Branch… + Drop + Clear All', () => {
    const labels = stashRowContextMenuLabels().map((e) => e.action);
    assert.deepStrictEqual(labels, [
      'stashPop',
      'stashApply',
      'stashShowDiff',
      'stashRename',
      'stashBranchFromStash',
      'stashDrop',
      'stashClearAll',
    ]);
  });
});

// ─── Shelf panel (built client-side via createElement) ──────────────────────

/**
 * Boot the bundled Commit Tool Window entry against the host body (empty
 * `#ctw-root` + the `#intellig-init` island) and return the built document; the
 * entry builds every panel via createElement, so the rendered DOM — not a
 * host-side HTML string — is the assertion surface. Harnesses are disposed
 * after each test so jsdom globals don't leak.
 */
const _ctwHarnesses: IWebviewEntryHarness[] = [];
afterEach(() => {
  while (_ctwHarnesses.length > 0) {
    _ctwHarnesses.pop()?.dispose();
  }
});

function buildCtwDoc(input: IRenderInput): Document {
  const { body } = buildCommitToolWindowBodyParts(input);
  const h = bootWebviewEntry('commits/webview/commitToolWindow', { bodyHtml: body });
  _ctwHarnesses.push(h);
  return h.document;
}

/** Build a doc whose shelf tab shows the given entries + filter. */
function buildShelfDoc(
  entries: IShelfTabEntry[],
  filter: 'shelves' | 'stashes' | 'both'
): Document {
  return buildCtwDoc({
    activeTab: 'shelf',
    changelists: [],
    shelfItems: [],
    shelfTabEntries: entries,
    shelfTabFilter: filter,
    composer: { message: '', amend: false, signOff: false },
  });
}

describe('shelf panel (built via script)', () => {
  it('marks the active filter button with ctw-shelf-filter-active', () => {
    const doc = buildShelfDoc([], 'stashes');
    const active = doc.querySelectorAll('.ctw-shelf-filter-active');
    assert.strictEqual(active.length, 1, 'exactly one button should be active');
    assert.strictEqual(active[0].getAttribute('data-shelf-filter'), 'stashes');
    assert.strictEqual(active[0].getAttribute('aria-pressed'), 'true');
  });

  it('renders filter-appropriate empty copy', () => {
    assert.strictEqual(
      buildShelfDoc([], 'shelves').querySelector('[data-panel="shelf"] .ctw-empty')?.textContent,
      'Shelf is empty.'
    );
    assert.strictEqual(
      buildShelfDoc([], 'stashes').querySelector('[data-panel="shelf"] .ctw-empty')?.textContent,
      'No stash entries.'
    );
    assert.strictEqual(
      buildShelfDoc([], 'both').querySelector('[data-panel="shelf"] .ctw-empty')?.textContent,
      'No shelf or stash entries.'
    );
  });

  it('renders type badges per row', () => {
    const entries: IShelfTabEntry[] = [
      { kind: 'shelf', id: 's1', name: 'wip', timestamp: new Date(2000), fileCount: 2 },
      { kind: 'stash', id: 'stash@{0}', name: 'stashed', timestamp: new Date(1000), index: 0 },
    ];
    const doc = buildShelfDoc(entries, 'both');
    const shelfRow = doc.querySelector('.ctw-shelf-row[data-row-kind="shelf"]');
    const stashRow = doc.querySelector('.ctw-shelf-row[data-row-kind="stash"]');
    assert.ok(shelfRow, 'shelf row should render');
    assert.ok(stashRow, 'stash row should render');
    assert.strictEqual(shelfRow?.querySelector('.ctw-shelf-badge')?.textContent, '📚');
    assert.strictEqual(stashRow?.querySelector('.ctw-shelf-badge')?.textContent, '📦');
    assert.strictEqual(shelfRow?.getAttribute('data-shelf-id'), 's1');
    assert.strictEqual(stashRow?.getAttribute('data-stash-index'), '0');
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
    const doc = buildShelfDoc(entries, 'both');
    assert.strictEqual(
      doc.querySelector('.ctw-shelf-alreadyUnshelved')?.textContent,
      '(already unshelved)'
    );
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
    stage: () => okAsync(undefined),
    unstage: () => okAsync(undefined),
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
  } as unknown as import('../../../src/shelf/interfaces/IShelfService').IShelfService;
}

describe('CommitToolWindow filter persistence', () => {
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
      assert.deepStrictEqual(mem._store.get(COMMIT_TOOL_WINDOW_SHELF_TAB_FILTER_STATE_KEY), {
        v: 1,
        data: 'stashes',
      });
      assert.strictEqual(ctw.getShelfTabFilter(), 'stashes');
    } finally {
      ctw.dispose();
    }
  });
});

describe('CommitToolWindow shelfTabContextAction routing', () => {
  function makeRig(shelfItems: IShelfItem[] = []): {
    ctw: CommitToolWindow;
    shelfCalls: string[];
    stashCalls: string[];
  } {
    const mem = makeMemento();
    const { svc: shelf } = makeShelfService(shelfItems);
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
    // The shelf list is normally filled by a state reload against a repo; seed
    // it directly so the context-menu lookups have rows to find.
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
    (ctw as any)._shelfItems = shelfItems;
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

  const shelfEntry = (id: string, name: string): IShelfItem => ({
    id,
    name,
    timestamp: new Date(1000),
    files: [{ path: `${id}.ts`, diff: '' }],
  });

  /** Capture what the host posts to the webview. */
  function capturePosts(ctw: CommitToolWindow): Array<{
    type?: string;
    rowKind?: string;
    shelfId?: string;
    stashIndex?: number;
    items?: Array<{ label: string; action: string }>;
  }> {
    const posted: Array<{
      type?: string;
      rowKind?: string;
      shelfId?: string;
      stashIndex?: number;
      items?: Array<{ label: string; action: string }>;
    }> = [];
    /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
    (ctw as any)._view = {
      webview: {
        html: '',
        options: {},
        cspSource: 'test:',
        asWebviewUri: (u: unknown) => u,
        postMessage: (m: unknown) => {
          posted.push(m as (typeof posted)[number]);
          return Promise.resolve(true);
        },
        onDidReceiveMessage: () => ({ dispose: () => {} }),
      },
      onDidDispose: () => ({ dispose: () => {} }),
    };
    /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
    return posted;
  }

  it('answers a shelf-row right-click with the menu, not a QuickPick', async () => {
    // showQuickPick is VS Code's command-palette widget, which opens at the
    // top of the window nowhere near the row. The Local Changes tab draws a
    // real menu; this one must too, from the same items.
    const { ctw } = makeRig([shelfEntry('s1', 'wip')]);
    const posted = capturePosts(ctw);
    let quickPicks = 0;
    const realQuickPick = vscode.window.showQuickPick;
    (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick =
      (): Promise<undefined> => {
        quickPicks++;
        return Promise.resolve(undefined);
      };
    try {
      await dispatch(ctw, { action: 'contextOpen', rowKind: 'shelf', shelfId: 's1' });

      const menus = posted.filter((m) => m.type === 'showRowContextMenu');
      assert.strictEqual(menus.length, 1, 'the host answers with items for the webview to draw');
      assert.strictEqual(quickPicks, 0, 'and never opens a QuickPick');
      assert.strictEqual(menus[0].rowKind, 'shelf');
      assert.strictEqual(menus[0].shelfId, 's1', 'the reply names the row it belongs to');
      assert.deepStrictEqual(
        (menus[0].items ?? []).map((i) => i.action),
        shelfRowContextMenuLabels({ isAlreadyUnshelved: false }).map((i) => i.action),
        'the same labels the host has always computed'
      );
    } finally {
      (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = realQuickPick;
      ctw.dispose();
    }
  });

  it('answers a stash-row right-click with the stash menu', async () => {
    const { ctw } = makeRig();
    const posted = capturePosts(ctw);
    try {
      await dispatch(ctw, { action: 'contextOpen', rowKind: 'stash', stashIndex: 3 });

      const menus = posted.filter((m) => m.type === 'showRowContextMenu');
      assert.strictEqual(menus.length, 1);
      assert.strictEqual(menus[0].rowKind, 'stash');
      assert.strictEqual(menus[0].stashIndex, 3);
      assert.deepStrictEqual(
        (menus[0].items ?? []).map((i) => i.action),
        stashRowContextMenuLabels().map((i) => i.action)
      );
    } finally {
      ctw.dispose();
    }
  });

  it('offers Restore only on an already-unshelved entry', async () => {
    const { ctw } = makeRig([
      shelfEntry('plain', 'wip'),
      { ...shelfEntry('unshelved', 'applied'), unshelvedAt: new Date(5000) },
    ]);
    const posted = capturePosts(ctw);
    try {
      await dispatch(ctw, { action: 'contextOpen', rowKind: 'shelf', shelfId: 'plain' });
      await dispatch(ctw, { action: 'contextOpen', rowKind: 'shelf', shelfId: 'unshelved' });
      const menus = posted.filter((m) => m.type === 'showRowContextMenu');
      assert.strictEqual(menus.length, 2);
      assert.ok(
        !(menus[0].items ?? []).some((i) => i.action === 'shelfRestore'),
        'a shelf that was never unshelved has nothing to restore'
      );
      assert.ok(
        (menus[1].items ?? []).some((i) => i.action === 'shelfRestore'),
        'an entry that has been unshelved can be restored'
      );
    } finally {
      ctw.dispose();
    }
  });

  it('answers a stash-row right-click even for an index with no matching stash', async () => {
    // Unlike the shelf arm, the stash arm never looks a stash up by index —
    // it always renders the menu, so a stale/out-of-range index does not
    // bail the way an unknown shelf id does above.
    const { ctw } = makeRig();
    const posted = capturePosts(ctw);
    try {
      await dispatch(ctw, { action: 'contextOpen', rowKind: 'stash', stashIndex: 9999 });
      const menus = posted.filter((m) => m.type === 'showRowContextMenu');
      assert.strictEqual(menus.length, 1, 'no bail for an out-of-range stash index');
      assert.strictEqual(menus[0].stashIndex, 9999);
    } finally {
      ctw.dispose();
    }
  });

  it('stays silent when the shelf entry is gone', async () => {
    const { ctw } = makeRig([shelfEntry('s1', 'wip')]);
    const posted = capturePosts(ctw);
    try {
      await dispatch(ctw, { action: 'contextOpen', rowKind: 'shelf', shelfId: 'no-such-id' });
      assert.deepStrictEqual(
        posted.filter((m) => m.type === 'showRowContextMenu'),
        [],
        'no menu for a row that no longer exists'
      );
    } finally {
      ctw.dispose();
    }
  });

  it('refuses a stash index that is not a whole non-negative number', async () => {
    // A stash is addressed by position. The webview builds this with Number()
    // over a DOM attribute and the inbound validator checks only the message
    // type, so a NaN or a negative would otherwise reach drop/pop and act on
    // whatever git resolves stash@{...} to.
    const { ctw, stashCalls } = makeRig();
    try {
      for (const stashIndex of [Number.NaN, -1, 1.5]) {
        await dispatch(ctw, { action: 'stashDrop', rowKind: 'stash', stashIndex });
      }
      assert.deepStrictEqual(stashCalls, [], 'none of those address a stash');

      await dispatch(ctw, { action: 'stashDrop', rowKind: 'stash', stashIndex: 0 });
      assert.deepStrictEqual(stashCalls, ['drop:0'], 'a real index still works');
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

// ─── render smoke: the init model still handles the legacy shape ────

describe('CommitToolWindow render backward compat', () => {
  it('works without the new shelfTab* fields (legacy callers)', () => {
    const doc = buildCtwDoc({
      activeTab: 'shelf',
      changelists: [],
      shelfItems: [],
      composer: { message: '', amend: false, signOff: false },
    });
    // Falls back to filter='shelves' → "Shelf is empty." copy surfaces.
    assert.strictEqual(
      doc.querySelector('[data-panel="shelf"] .ctw-empty')?.textContent,
      'Shelf is empty.'
    );
  });

  it('honors explicit shelfTabEntries + shelfTabFilter', () => {
    const doc = buildCtwDoc({
      activeTab: 'shelf',
      changelists: [],
      shelfItems: [],
      shelfTabEntries: [
        { kind: 'stash', id: 'stash@{0}', name: 'wip', timestamp: new Date(), index: 0 },
      ],
      shelfTabFilter: 'stashes',
      composer: { message: '', amend: false, signOff: false },
    });
    const stashRow = doc.querySelector('.ctw-shelf-row[data-row-kind="stash"]');
    assert.ok(stashRow, 'stash row should render');
    assert.strictEqual(stashRow?.querySelector('.ctw-shelf-badge')?.textContent, '📦');
    assert.strictEqual(
      doc.querySelector('.ctw-shelf-filter-active')?.getAttribute('data-shelf-filter'),
      'stashes'
    );
  });
});
