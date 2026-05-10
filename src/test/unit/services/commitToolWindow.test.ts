/**
 * Unit tests for the T1-04 Commit Tool Window.
 *
 * Covers the pure helpers (`updateRecentMessagesLru`,
 * `sortChangelistsForDisplay`, `fileContextMenuLabels`,
 * `changelistContextMenuLabels`, `gearMenuItems`) plus the host-side message
 * handler behavior (tab persistence, context action dispatch, commit via
 * `performCommit`, commitAndPush via `intellig.push`, message-history LRU).
 *
 * The CommitToolWindow is not instantiated in every test because
 * `resolveWebviewView` needs a `WebviewView` that the mock doesn't supply.
 * Host-side behavior is instead exercised through a direct construction
 * plus `_handleWebviewMessage` invocation, since that method is the sole
 * entry point for webview→host traffic.
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
  changelistContextMenuLabels,
  fileContextMenuLabels,
  gearMenuItems,
  sortChangelistsForDisplay,
  updateRecentMessagesLru,
  renderCommitToolWindowHtml,
  COMMIT_TOOL_WINDOW_ACTIVE_TAB_STATE_KEY,
  COMMIT_TOOL_WINDOW_RECENT_MESSAGES_STATE_KEY,
  COMMIT_TOOL_WINDOW_RECENT_MESSAGES_MAX as RECENT_MESSAGES_MAX,
} from '../../../services';
import type { IChangelist, IFileChange } from '../../../services/interfaces/IChangelistService';
import type { IShelfItem } from '../../../services/interfaces/IShelfService';
import type { IRepository } from '../../../services/interfaces/IGitService';
import { EventEmitter, Uri } from '../../mocks/vscode';

// ─── updateRecentMessagesLru ──────────────────────────────────────────────────

describe('CommitToolWindow — updateRecentMessagesLru', () => {
  it('prepends the new message to the front', () => {
    const next = updateRecentMessagesLru(['a', 'b'], 'c');
    assert.deepStrictEqual(next, ['c', 'a', 'b']);
  });

  it('deduplicates existing entries (moves to front)', () => {
    const next = updateRecentMessagesLru(['a', 'b', 'c'], 'b');
    assert.deepStrictEqual(next, ['b', 'a', 'c']);
  });

  it('caps the LRU at 20 entries', () => {
    const initial = Array.from({ length: RECENT_MESSAGES_MAX }, (_, i) => `msg-${i}`);
    const next = updateRecentMessagesLru(initial, 'fresh');
    assert.strictEqual(next.length, RECENT_MESSAGES_MAX);
    assert.strictEqual(next[0], 'fresh');
    // The oldest entry (msg-19) should be evicted.
    assert.ok(!next.includes(`msg-${RECENT_MESSAGES_MAX - 1}`));
  });

  it('ignores empty / whitespace-only messages', () => {
    assert.deepStrictEqual(updateRecentMessagesLru(['a'], ''), ['a']);
    assert.deepStrictEqual(updateRecentMessagesLru(['a'], '   '), ['a']);
  });

  it('trims incoming messages before storing', () => {
    const next = updateRecentMessagesLru([], '  hello  ');
    assert.deepStrictEqual(next, ['hello']);
  });
});

// ─── sortChangelistsForDisplay ────────────────────────────────────────────────

describe('CommitToolWindow — sortChangelistsForDisplay', () => {
  const cls: IChangelist[] = [
    { id: 'c', name: 'refactor', isDefault: false, files: [] },
    { id: 'a', name: 'feature', isDefault: false, files: [] },
    { id: 'def', name: 'Default', isDefault: true, files: [] },
  ];
  it('places the default changelist first', () => {
    const sorted = sortChangelistsForDisplay(cls);
    assert.strictEqual(sorted[0].isDefault, true);
  });
  it('sorts the remaining changelists by name', () => {
    const sorted = sortChangelistsForDisplay(cls);
    assert.strictEqual(sorted[1].name, 'feature');
    assert.strictEqual(sorted[2].name, 'refactor');
  });
});

// ─── Context-menu labels ──────────────────────────────────────────────────────

describe('CommitToolWindow — changelistContextMenuLabels', () => {
  it('produces every IR-parity entry in the documented order', () => {
    const labels = changelistContextMenuLabels({ isActive: false, isDefault: false }).map(
      (e) => e.label
    );
    assert.deepStrictEqual(labels, [
      'New Changelist…',
      'Set Active Changelist',
      'Rename Changelist…',
      'Edit Description…',
      'Remove Changelist',
      'Commit Only This Changelist…',
      'Shelve Changes',
    ]);
  });

  it('uses Unicode ellipsis (…) for destructive/parameterized actions', () => {
    const labels = changelistContextMenuLabels({ isActive: false, isDefault: false });
    const ellipsis = labels.filter((l) => l.label.endsWith('…'));
    assert.ok(
      ellipsis.length >= 3,
      `expected multiple entries to use Unicode '…', got: ${ellipsis.map((e) => e.label).join(', ')}`
    );
  });

  it('disables Set Active on an already-active changelist', () => {
    const entries = changelistContextMenuLabels({ isActive: true, isDefault: false });
    const setActive = entries.find((e) => e.action === 'setActive');
    assert.ok(setActive?.disabled);
  });

  it('disables Rename and Delete on the default changelist', () => {
    const entries = changelistContextMenuLabels({ isActive: false, isDefault: true });
    const rename = entries.find((e) => e.action === 'rename');
    const del = entries.find((e) => e.action === 'delete');
    assert.ok(rename?.disabled);
    assert.ok(del?.disabled);
  });
});

describe('CommitToolWindow — fileContextMenuLabels', () => {
  const modifiedFile: IFileChange = { path: 'a.ts', status: 'modified', staged: true };
  const untrackedFile: IFileChange = { path: 'b.md', status: 'untracked', staged: false };

  it('produces IR-parity entries in the documented order for modified files', () => {
    const labels = fileContextMenuLabels(modifiedFile).map((e) => e.label);
    assert.deepStrictEqual(labels, [
      'Show Diff',
      'Jump to Source',
      'Move to Another Changelist…',
      'Rollback…',
      'Shelve Changes…',
      'Show History',
      'Annotate with Git Blame',
    ]);
  });

  it('adds the Add to VCS entry for untracked files', () => {
    const labels = fileContextMenuLabels(untrackedFile).map((e) => e.label);
    assert.ok(labels.includes('Add to VCS'));
  });

  it('omits Add to VCS for non-untracked files', () => {
    const labels = fileContextMenuLabels(modifiedFile).map((e) => e.label);
    assert.ok(!labels.includes('Add to VCS'));
  });

  it('includes keyboard shortcuts for the usual IntelliJ accelerators', () => {
    const entries = fileContextMenuLabels(modifiedFile);
    const shortcuts = new Map(entries.map((e) => [e.action, e.shortcut]));
    assert.strictEqual(shortcuts.get('showDiff'), 'Ctrl+D');
    assert.strictEqual(shortcuts.get('jumpToSource'), 'F4');
    assert.strictEqual(shortcuts.get('moveToChangelist'), 'F6');
    assert.strictEqual(shortcuts.get('rollback'), 'Ctrl+Alt+Z');
  });
});

describe('CommitToolWindow — gearMenuItems', () => {
  const items = gearMenuItems();
  it('renders the five IR gear entries as disabled stubs', () => {
    const labels = items.map((i) => i.label);
    assert.deepStrictEqual(labels, [
      'Reformat code',
      'Optimize imports',
      'Run Code Cleanup',
      'Check TODO',
      'Disable pre-commit hooks (--no-verify)',
    ]);
  });
  it('tags every item with a "coming soon" tooltip so users know the feature is stubbed', () => {
    for (const i of items) {
      assert.ok(i.tooltip.toLowerCase().includes('coming soon'));
    }
  });
});

// ─── renderCommitToolWindowHtml ───────────────────────────────────────────────

describe('CommitToolWindow — renderCommitToolWindowHtml', () => {
  it('renders both tab buttons and marks the active one', () => {
    const html = renderCommitToolWindowHtml({
      cspSource: 'vscode-webview://mock',
      activeTab: 'shelf',
      changelists: [],
      shelfItems: [],
      composer: { message: '', amend: false, signOff: false },
    });
    assert.ok(html.includes('data-tab="localChanges"'));
    assert.ok(html.includes('data-tab="shelf"'));
    assert.ok(html.includes('data-tab="shelf" role="tab" aria-selected="true"'));
    assert.ok(html.includes('data-tab="localChanges" role="tab" aria-selected="false"'));
  });

  it('displays an empty state for the Local Changes tab when no changelists exist', () => {
    const html = renderCommitToolWindowHtml({
      cspSource: 'vscode-webview://mock',
      activeTab: 'localChanges',
      changelists: [],
      shelfItems: [],
      composer: { message: '', amend: false, signOff: false },
    });
    assert.ok(html.includes('No uncommitted changes'));
  });

  it('escapes user-supplied changelist names', () => {
    const html = renderCommitToolWindowHtml({
      cspSource: 'vscode-webview://mock',
      activeTab: 'localChanges',
      changelists: [
        {
          id: 'x',
          name: '<script>alert(1)</script>',
          isDefault: false,
          files: [],
        },
      ],
      shelfItems: [],
      composer: { message: '', amend: false, signOff: false },
    });
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  });
});

// ─── CommitToolWindow host behavior ───────────────────────────────────────────

describe('CommitToolWindow — host behavior', () => {
  interface MockMemento extends vscode.Memento {
    store: Map<string, unknown>;
  }

  function createMockMemento(initial: Record<string, unknown> = {}): MockMemento {
    const store = new Map<string, unknown>(Object.entries(initial));
    const memento = {
      store,
      get<T>(key: string, defaultValue?: T): T | undefined {
        if (store.has(key)) {
          return store.get(key) as T;
        }
        return defaultValue;
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
    } as unknown as MockMemento;
    return memento;
  }

  function createMockRepo(): IRepository {
    return {
      rootUri: Uri.file('/test-repo'),
      state: 'idle',
      head: { name: 'refs/heads/main', commit: 'abc', ahead: 0, behind: 0 },
      remotes: [],
      submodules: [],
    };
  }

  interface MockServices {
    gitService: any;
    changelistService: any;
    shelfService: any;
    calls: Array<{ method: string; args: unknown[] }>;
  }

  function createMockServices(
    repo: IRepository,
    changelists: IChangelist[] = [],
    shelf: IShelfItem[] = []
  ): MockServices {
    const repoChange = new EventEmitter<IRepository>();
    const clChange = new EventEmitter<IChangelist[]>();
    const shelfChange = new EventEmitter<IShelfItem[]>();
    const calls: Array<{ method: string; args: unknown[] }> = [];

    const gitService: any = {
      onDidChangeRepository: repoChange.event,
      getRepositories: () => [repo],
      getRepository: async () => repo,
      getStatus: async () => [],
      stage: async (...args: unknown[]) => {
        calls.push({ method: 'stage', args });
      },
      unstage: async (...args: unknown[]) => {
        calls.push({ method: 'unstage', args });
      },
      commit: async (...args: unknown[]) => {
        calls.push({ method: 'commit', args });
      },
      getDiff: async () => ({ path: '', status: 'modified' as const, hunks: [], binary: false }),
    };

    const changelistService: any = {
      onDidChangeChangelists: clChange.event,
      getChangelists: () => changelists,
      reconcileWithGitStatus: async () => {},
      getDefaultChangelist: () => changelists.find((c) => c.isDefault) ?? changelists[0],
      getActiveChangelist: async () => changelists.find((c) => c.isDefault) ?? changelists[0],
      setActiveChangelist: async () => {},
      createChangelist: (...args: unknown[]) => {
        calls.push({ method: 'createChangelist', args });
        return { id: 'new', name: String(args[1]), isDefault: false, files: [] };
      },
      deleteChangelist: (...args: unknown[]) => {
        calls.push({ method: 'deleteChangelist', args });
      },
      renameChangelist: (...args: unknown[]) => {
        calls.push({ method: 'renameChangelist', args });
      },
      moveToChangelist: (...args: unknown[]) => {
        calls.push({ method: 'moveToChangelist', args });
      },
      getChangelistForFile: async () => undefined,
    };

    const shelfService: any = {
      onDidChangeShelf: shelfChange.event,
      getShelfItems: () => shelf,
      shelve: async () => ({ id: 'new', name: '', timestamp: new Date(), files: [] }),
      unshelve: async () => ({ success: true }),
      deleteShelfItem: () => {},
      getShelfDiff: async () => [],
    };

    return { gitService, changelistService, shelfService, calls };
  }

  // Preserve / restore the command executeCommand stub across tests.
  let savedExecuteCommand: typeof vscode.commands.executeCommand;
  beforeEach(() => {
    savedExecuteCommand = vscode.commands.executeCommand;
  });
  afterEach(() => {
    (vscode.commands as any).executeCommand = savedExecuteCommand;
  });

  it('persists the active tab to workspaceState on tabChange', async () => {
    const memento = createMockMemento();
    const repo = createMockRepo();
    const services = createMockServices(repo, []);
    const tw = new CommitToolWindow(
      Uri.file('/ext'),
      services.gitService,
      services.changelistService,
      services.shelfService,
      memento
    );

    await (tw as any)._handleWebviewMessage({ type: 'tabChange', tab: 'shelf' });
    assert.strictEqual(
      memento.store.get(COMMIT_TOOL_WINDOW_ACTIVE_TAB_STATE_KEY),
      'shelf',
      `expected active tab stored under ${COMMIT_TOOL_WINDOW_ACTIVE_TAB_STATE_KEY}, got ${JSON.stringify(Object.fromEntries(memento.store))}`
    );
    assert.strictEqual(tw.getActiveTab(), 'shelf');

    // Switch back
    await (tw as any)._handleWebviewMessage({ type: 'tabChange', tab: 'localChanges' });
    assert.strictEqual(memento.store.get(COMMIT_TOOL_WINDOW_ACTIVE_TAB_STATE_KEY), 'localChanges');
    tw.dispose();
  });

  it('restores the active tab from workspaceState on construction', () => {
    const memento = createMockMemento({
      [COMMIT_TOOL_WINDOW_ACTIVE_TAB_STATE_KEY]: 'shelf',
    });
    const repo = createMockRepo();
    const services = createMockServices(repo);
    const tw = new CommitToolWindow(
      Uri.file('/ext'),
      services.gitService,
      services.changelistService,
      services.shelfService,
      memento
    );
    assert.strictEqual(tw.getActiveTab(), 'shelf');
    tw.dispose();
  });

  it('commit dispatches to performCommit via GitService.stage/unstage/commit', async () => {
    const memento = createMockMemento();
    const repo = createMockRepo();
    const changelists: IChangelist[] = [
      {
        id: 'def',
        name: 'Default',
        isDefault: true,
        files: [
          { path: 'src/a.ts', status: 'modified', staged: true },
          { path: 'src/b.ts', status: 'modified', staged: false },
        ],
      },
    ];
    const services = createMockServices(repo, changelists);
    const tw = new CommitToolWindow(
      Uri.file('/ext'),
      services.gitService,
      services.changelistService,
      services.shelfService,
      memento
    );
    // Preload state that the tool window normally fetches via _reloadState.
    (tw as any)._changelists = changelists;

    await (tw as any)._handleWebviewMessage({
      type: 'commit',
      message: 'feat: add thing',
      files: ['src/a.ts', 'src/b.ts'],
      amend: false,
      signOff: false,
    });

    // b.ts is unstaged → must be staged. a.ts is already staged → no stage call.
    const stageCall = services.calls.find((c) => c.method === 'stage');
    assert.ok(stageCall, 'expected a stage call for src/b.ts');
    assert.deepStrictEqual(stageCall?.args[1], ['src/b.ts']);

    // No unstage call expected (all files selected).
    assert.ok(!services.calls.some((c) => c.method === 'unstage'));

    // Commit invoked with the given message.
    const commitCall = services.calls.find((c) => c.method === 'commit');
    assert.ok(commitCall);
    assert.strictEqual(commitCall?.args[1], 'feat: add thing');

    tw.dispose();
  });

  it('commitAndPush invokes intellig.push after a successful commit', async () => {
    const memento = createMockMemento();
    const repo = createMockRepo();
    const changelists: IChangelist[] = [
      {
        id: 'def',
        name: 'Default',
        isDefault: true,
        files: [{ path: 'src/a.ts', status: 'modified', staged: true }],
      },
    ];
    const services = createMockServices(repo, changelists);
    const tw = new CommitToolWindow(
      Uri.file('/ext'),
      services.gitService,
      services.changelistService,
      services.shelfService,
      memento
    );
    (tw as any)._changelists = changelists;

    const executed: string[] = [];
    (vscode.commands as any).executeCommand = async (command: string): Promise<undefined> => {
      executed.push(command);
      return undefined;
    };

    await (tw as any)._handleWebviewMessage({
      type: 'commitAndPush',
      message: 'feat: add thing',
      files: ['src/a.ts'],
    });

    assert.ok(
      executed.includes('intellig.push'),
      `expected intellig.push to be invoked after commit; executed: ${executed.join(', ')}`
    );
    tw.dispose();
  });

  it('persists recent commit messages to workspaceState (20-entry LRU)', async () => {
    const memento = createMockMemento();
    const repo = createMockRepo();
    const changelists: IChangelist[] = [
      {
        id: 'def',
        name: 'Default',
        isDefault: true,
        files: [{ path: 'src/a.ts', status: 'modified', staged: true }],
      },
    ];
    const services = createMockServices(repo, changelists);
    const tw = new CommitToolWindow(
      Uri.file('/ext'),
      services.gitService,
      services.changelistService,
      services.shelfService,
      memento
    );
    (tw as any)._changelists = changelists;

    for (let i = 0; i < 25; i++) {
      await (tw as any)._handleWebviewMessage({
        type: 'commit',
        message: `msg ${i}`,
        files: ['src/a.ts'],
      });
    }
    const stored = memento.store.get(COMMIT_TOOL_WINDOW_RECENT_MESSAGES_STATE_KEY) as string[];
    assert.ok(Array.isArray(stored), 'recent messages should be persisted as an array');
    assert.strictEqual(stored.length, RECENT_MESSAGES_MAX);
    assert.strictEqual(stored[0], 'msg 24');

    tw.dispose();
  });

  it('dispatches changelistContextAction → intellig.changelist.* commands', async () => {
    const memento = createMockMemento();
    const repo = createMockRepo();
    const services = createMockServices(repo);
    const tw = new CommitToolWindow(
      Uri.file('/ext'),
      services.gitService,
      services.changelistService,
      services.shelfService,
      memento
    );
    const executed: Array<{ command: string; args: unknown[] }> = [];
    (vscode.commands as any).executeCommand = async (
      command: string,
      ...args: unknown[]
    ): Promise<undefined> => {
      executed.push({ command, args });
      return undefined;
    };

    await (tw as any)._handleWebviewMessage({
      type: 'changelistContextAction',
      action: 'new',
    });
    await (tw as any)._handleWebviewMessage({
      type: 'changelistContextAction',
      action: 'setActive',
      changelistId: 'abc',
    });
    await (tw as any)._handleWebviewMessage({
      type: 'changelistContextAction',
      action: 'rename',
      changelistId: 'abc',
    });
    await (tw as any)._handleWebviewMessage({
      type: 'changelistContextAction',
      action: 'editDescription',
      changelistId: 'abc',
    });
    await (tw as any)._handleWebviewMessage({
      type: 'changelistContextAction',
      action: 'delete',
      changelistId: 'abc',
    });
    await (tw as any)._handleWebviewMessage({
      type: 'changelistContextAction',
      action: 'shelve',
      changelistId: 'abc',
    });

    const commandIds = executed.map((e) => e.command);
    assert.ok(commandIds.includes('intellig.changelist.new'));
    assert.ok(commandIds.includes('intellig.changelist.setActive'));
    assert.ok(commandIds.includes('intellig.changelist.rename'));
    assert.ok(commandIds.includes('intellig.changelist.editDescription'));
    assert.ok(commandIds.includes('intellig.changelist.delete'));
    assert.ok(commandIds.includes('intellig.changelist.shelve'));

    // Arguments are forwarded correctly for id-bearing actions.
    const setActiveCall = executed.find((e) => e.command === 'intellig.changelist.setActive');
    assert.deepStrictEqual(setActiveCall?.args, ['abc']);

    tw.dispose();
  });

  // ─── SR-4: contextOpen right-click menu wiring ─────────────────────────────

  it('contextOpen on a changelist row shows a QuickPick of changelist menu labels', async () => {
    const memento = createMockMemento();
    const repo = createMockRepo();
    const changelists: IChangelist[] = [
      { id: 'def', name: 'Default', isDefault: true, files: [] },
      { id: 'feat', name: 'feature-x', isDefault: false, files: [] },
    ];
    const services = createMockServices(repo, changelists);
    // Service stub so the `isActive` lookup inside the contextOpen handler
    // has something to return.
    services.changelistService.getActiveChangelist = async () => changelists[1];

    const tw = new CommitToolWindow(
      Uri.file('/ext'),
      services.gitService,
      services.changelistService,
      services.shelfService,
      memento
    );
    (tw as any)._changelists = changelists;

    const pickCalls: Array<{ items: Array<{ label: string }>; options: { title?: string } }> = [];
    (vscode.window as any).showQuickPick = async (
      items: Array<{ label: string }>,
      options: { title?: string } = {}
    ) => {
      pickCalls.push({ items, options });
      // Pick the "Rename Changelist…" entry so we can also confirm the
      // recursive re-dispatch fires the rename command.
      return items.find((i) => i.label === 'Rename Changelist…');
    };

    const executed: Array<{ command: string; args: unknown[] }> = [];
    (vscode.commands as any).executeCommand = async (
      command: string,
      ...args: unknown[]
    ): Promise<undefined> => {
      executed.push({ command, args });
      return undefined;
    };

    await (tw as any)._handleWebviewMessage({
      type: 'changelistContextAction',
      action: 'contextOpen',
      changelistId: 'feat',
    });

    assert.strictEqual(pickCalls.length, 1);
    const menuLabels = pickCalls[0].items.map((i) => i.label);
    assert.ok(menuLabels.includes('Rename Changelist…'));
    assert.ok(
      menuLabels.includes('Set Active Changelist') === false,
      'Set Active Changelist should be filtered out when the row is already active'
    );
    assert.ok(menuLabels.includes('Commit Only This Changelist…'));

    // The pick should have been re-dispatched → intellig.changelist.rename
    // with the changelist id.
    const renameCall = executed.find((e) => e.command === 'intellig.changelist.rename');
    assert.ok(
      renameCall,
      `expected intellig.changelist.rename to fire; executed: ${executed.map((e) => e.command).join(', ')}`
    );
    assert.deepStrictEqual(renameCall?.args, ['feat']);

    tw.dispose();
  });

  it('contextOpen on a file row shows a QuickPick of fileContextMenu labels in order', async () => {
    const memento = createMockMemento();
    const repo = createMockRepo();
    const changelists: IChangelist[] = [
      {
        id: 'def',
        name: 'Default',
        isDefault: true,
        files: [{ path: 'src/a.ts', status: 'modified', staged: false }],
      },
    ];
    const services = createMockServices(repo, changelists);
    const tw = new CommitToolWindow(
      Uri.file('/ext'),
      services.gitService,
      services.changelistService,
      services.shelfService,
      memento
    );
    (tw as any)._changelists = changelists;

    const pickCalls: Array<{ items: Array<{ label: string }> }> = [];
    (vscode.window as any).showQuickPick = async (items: Array<{ label: string }>) => {
      pickCalls.push({ items });
      // Cancel — returning undefined should leave no side effects.
      return undefined;
    };
    const executed: string[] = [];
    (vscode.commands as any).executeCommand = async (command: string): Promise<undefined> => {
      executed.push(command);
      return undefined;
    };

    await (tw as any)._handleWebviewMessage({
      type: 'changelistContextAction',
      action: 'contextOpen',
      changelistId: 'def',
      path: 'src/a.ts',
    });

    assert.strictEqual(pickCalls.length, 1);
    const labels = pickCalls[0].items.map((i) => i.label);
    // IntelliJ-parity order for modified files — matches
    // fileContextMenuLabels.
    assert.deepStrictEqual(labels, [
      'Show Diff',
      'Jump to Source',
      'Move to Another Changelist…',
      'Rollback…',
      'Shelve Changes…',
      'Show History',
      'Annotate with Git Blame',
    ]);
    // Cancelling → no command invocation.
    assert.deepStrictEqual(executed, []);

    tw.dispose();
  });

  // ─── SR-8: multi-root resolveRepo ──────────────────────────────────────────

  it("commit in a multi-root workspace uses the active editor's repo, not repositories[0]", async () => {
    const memento = createMockMemento();
    const repoA: IRepository = {
      rootUri: Uri.file('/repo-a'),
      state: 'idle',
      head: { name: 'refs/heads/main', commit: 'aaa', ahead: 0, behind: 0 },
      remotes: [],
      submodules: [],
    };
    const repoB: IRepository = {
      rootUri: Uri.file('/repo-b'),
      state: 'idle',
      head: { name: 'refs/heads/main', commit: 'bbb', ahead: 0, behind: 0 },
      remotes: [],
      submodules: [],
    };
    const changelists: IChangelist[] = [
      {
        id: 'def',
        name: 'Default',
        isDefault: true,
        files: [{ path: 'src/a.ts', status: 'modified', staged: true }],
      },
    ];
    const services = createMockServices(repoA, changelists);
    // Override getRepositories so both repos are visible.
    services.gitService.getRepositories = () => [repoA, repoB];
    services.gitService.commit = async (...args: unknown[]) => {
      services.calls.push({ method: 'commit', args });
    };

    // Point the active editor at a file under /repo-b so resolveRepo's
    // preferActive branch resolves to repoB.
    (vscode.window as any).activeTextEditor = {
      document: { uri: Uri.file('/repo-b/src/a.ts') },
    };

    const tw = new CommitToolWindow(
      Uri.file('/ext'),
      services.gitService,
      services.changelistService,
      services.shelfService,
      memento
    );
    (tw as any)._changelists = changelists;

    await (tw as any)._handleWebviewMessage({
      type: 'commit',
      message: 'feat',
      files: ['src/a.ts'],
    });

    const commitCall = services.calls.find((c) => c.method === 'commit');
    assert.ok(commitCall, 'expected commit to fire');
    // First arg is the repo handed to gitService.commit; assert we got repoB.
    const committedRepo = commitCall?.args[0] as IRepository;
    assert.strictEqual(
      committedRepo.rootUri.fsPath,
      '/repo-b',
      `expected commit to route to the active editor's repo, got ${committedRepo.rootUri.fsPath}`
    );

    (vscode.window as any).activeTextEditor = undefined;
    tw.dispose();
  });

  it('drops malformed messages without throwing', async () => {
    const memento = createMockMemento();
    const repo = createMockRepo();
    const services = createMockServices(repo);
    const tw = new CommitToolWindow(
      Uri.file('/ext'),
      services.gitService,
      services.changelistService,
      services.shelfService,
      memento
    );

    await (tw as any)._handleWebviewMessage(undefined);
    await (tw as any)._handleWebviewMessage(null);
    await (tw as any)._handleWebviewMessage({});
    await (tw as any)._handleWebviewMessage({ type: 42 });
    await (tw as any)._handleWebviewMessage({ type: 'unknown.thing' });

    // No commit, stage, or unstage should have been called.
    assert.strictEqual(services.calls.length, 0);
    tw.dispose();
  });
});
