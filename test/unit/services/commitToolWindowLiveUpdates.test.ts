/**
 * Host-side live-update tests for the Commit Tool Window.
 *
 * The CTW must reflect external changes (changelist reconcile, shelf
 * mutations, `git stash` from a terminal) by POSTING an incremental
 * `updateModel` message through the typed protocol — never by reassigning
 * `webview.html` after the resolve render. These specs drive the real
 * `resolveWebviewView` path against a recording webview stub so both the
 * html-assignment count and the posted message stream are the assertion
 * surface.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { CommitToolWindow } from '../../../src/commits/CommitToolWindow';
import type {
  IChangelist,
  IChangelistService,
} from '../../../src/changelists/interfaces/IChangelistService';
import type { IShelfItem, IShelfService } from '../../../src/shelf/interfaces/IShelfService';
import type {
  IGitService,
  IRepository,
  IStash,
} from '../../../src/git-core/interfaces/IGitService';
import type { ICommitToolWindowInitModel } from '../../../src/commits/commitToolWindow.types';
import { EventEmitter, Uri } from '../../mocks/vscode';
import { installFakeTimers, flushMicrotasks } from '../../helpers/fakeTimers';
import { writableWindow } from '../../typed/windowStub';

/**
 * Reaches the private webview-message entry point and the host-owned
 * checkbox-selection set. The public API can't express "the user checked a
 * box then the tree changed under them", which is exactly the state these
 * specs assert survives a live push.
 */
interface CommitToolWindowLiveTestSurface {
  _handleWebviewMessage(message: unknown): Promise<void>;
  _selectedFiles: Set<string>;
}
function asLiveSurface(tw: CommitToolWindow): CommitToolWindowLiveTestSurface {
  return tw as unknown as CommitToolWindowLiveTestSurface;
}

/** A posted host→webview message, narrowed by discriminant for assertions. */
interface PostedMessage {
  type?: string;
  model?: ICommitToolWindowInitModel;
  message?: string;
}

interface MockMemento extends vscode.Memento {
  store: Map<string, unknown>;
}

function createMockMemento(initial: Record<string, unknown> = {}): MockMemento {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    store,
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
  } as unknown as MockMemento;
}

function makeRepo(root: string): IRepository {
  return {
    rootUri: Uri.file(root),
    state: 'idle',
    head: { name: 'refs/heads/main', commit: 'abc', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  };
}

/**
 * Mutable per-repo service state the specs edit between events — the services
 * read from here at call time, so a push re-reads current state (I2) rather
 * than an event payload.
 */
interface LiveServiceState {
  changelists: Map<string, IChangelist[]>;
  shelf: Map<string, IShelfItem[]>;
  stashes: Map<string, IStash[]>;
}

interface LiveServices {
  gitService: IGitService;
  changelistService: IChangelistService;
  shelfService: IShelfService;
  state: LiveServiceState;
  stashListCalls: IRepository[];
  fireChangelists(): void;
  fireShelf(): void;
  fireRepository(repo: IRepository): void;
}

function createLiveServices(repos: IRepository[]): LiveServices {
  const state: LiveServiceState = {
    changelists: new Map(),
    shelf: new Map(),
    stashes: new Map(),
  };
  for (const r of repos) {
    state.changelists.set(r.rootUri.fsPath, []);
    state.shelf.set(r.rootUri.fsPath, []);
    state.stashes.set(r.rootUri.fsPath, []);
  }
  const repoChange = new EventEmitter<IRepository>();
  const clChange = new EventEmitter<IChangelist[]>();
  const shelfChange = new EventEmitter<IShelfItem[]>();
  const stashListCalls: IRepository[] = [];

  // Only the members CommitToolWindow's live-update path touches are stubbed;
  // the single documented cast keeps the factory compact (the full-literal
  // factory lives in commitToolWindow.test.ts and guards interface growth).
  const gitService = {
    onDidChangeRepository: repoChange.event,
    getRepositories: () => repos,
    getRepository: async () => repos[0],
    stashList: async (repo: IRepository) => {
      stashListCalls.push(repo);
      return state.stashes.get(repo.rootUri.fsPath) ?? [];
    },
    getDiff: async () => ({ path: '', status: 'modified' as const, hunks: [], binary: false }),
    dispose: () => {},
  } as unknown as IGitService;

  const changelistService = {
    onDidChangeChangelists: clChange.event,
    getChangelists: (repo: IRepository) => state.changelists.get(repo.rootUri.fsPath) ?? [],
    reconcileWithGitStatus: async () => {},
    getActiveChangelist: async (repo: IRepository) =>
      (state.changelists.get(repo.rootUri.fsPath) ?? []).find((c) => c.isActive),
    dispose: () => {},
  } as unknown as IChangelistService;

  const shelfService = {
    onDidChangeShelf: shelfChange.event,
    getShelfItems: (repo: IRepository) => state.shelf.get(repo.rootUri.fsPath) ?? [],
    dispose: () => {},
  } as unknown as IShelfService;

  return {
    gitService,
    changelistService,
    shelfService,
    state,
    stashListCalls,
    fireChangelists: () => clChange.fire([]),
    fireShelf: () => shelfChange.fire([]),
    fireRepository: (repo: IRepository) => repoChange.fire(repo),
  };
}

/** Recording stub the real resolveWebviewView path renders + posts into. */
interface RecordedView {
  posted: PostedMessage[];
  htmlAssignments: () => number;
  html: () => string;
  /** What the stub's postMessage resolves — false simulates a missed delivery. */
  setDelivered(delivered: boolean): void;
  fireVisibility(visible: boolean): void;
}

function resolveView(tw: CommitToolWindow): RecordedView {
  let html = '';
  let assignments = 0;
  let delivered = true;
  const posted: PostedMessage[] = [];
  const visibilityEmitter = new EventEmitter<void>();
  const view = {
    visible: true,
    webview: {
      get html(): string {
        return html;
      },
      set html(v: string) {
        assignments++;
        html = v;
      },
      options: {},
      cspSource: 'test:',
      asWebviewUri: (u: unknown) => u,
      postMessage: (m: unknown) => {
        posted.push(m as PostedMessage);
        return Promise.resolve(delivered);
      },
      onDidReceiveMessage: () => ({ dispose: () => {} }),
    },
    onDidDispose: () => ({ dispose: () => {} }),
    onDidChangeVisibility: visibilityEmitter.event,
  } as unknown as vscode.WebviewView;
  tw.resolveWebviewView(
    view,
    {} as vscode.WebviewViewResolveContext,
    {} as vscode.CancellationToken
  );
  return {
    posted,
    htmlAssignments: () => assignments,
    html: () => html,
    setDelivered: (d: boolean) => {
      delivered = d;
    },
    fireVisibility: (visible: boolean) => {
      (view as { visible: boolean }).visible = visible;
      visibilityEmitter.fire();
    },
  };
}

/** Drain chained microtasks (async reload → reads → post) to quiescence. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await flushMicrotasks();
  }
}

function updateModelPosts(posted: PostedMessage[], from = 0): PostedMessage[] {
  return posted.slice(from).filter((m) => m.type === 'updateModel');
}

function makeChangelist(name: string, files: string[] = []): IChangelist {
  return {
    id: name,
    name,
    isDefault: true,
    isActive: true,
    files: files.map((path) => ({ path, status: 'modified' as const, staged: false })),
  };
}

describe('CommitToolWindow — live updates (host seam)', () => {
  let timers: ReturnType<typeof installFakeTimers> | undefined;

  afterEach(() => {
    timers?.uninstall();
    timers = undefined;
  });

  function makeWindow(repos: IRepository[]): { tw: CommitToolWindow; services: LiveServices } {
    const services = createLiveServices(repos);
    const tw = new CommitToolWindow(
      Uri.file('/ext'),
      services.gitService,
      services.changelistService,
      services.shelfService,
      createMockMemento()
    );
    return { tw, services };
  }

  it('T1: a changelist event posts one updateModel and never reassigns webview.html after resolve', async () => {
    timers = installFakeTimers();
    const repo = makeRepo('/test-repo');
    const { tw, services } = makeWindow([repo]);

    const view = resolveView(tw);
    timers.tick(300);
    await settle();
    const baseline = view.posted.length;

    // External change: the service now reports a new changelist; the event
    // fires as a trigger (payload must not matter — state is re-read).
    services.state.changelists.set('/test-repo', [makeChangelist('LiveChangelist', ['src/a.ts'])]);
    services.fireChangelists();
    timers.tick(300);
    await settle();

    assert.strictEqual(
      view.htmlAssignments(),
      1,
      'webview.html must be assigned exactly once (the resolve render); post-resolve changes go through updateModel'
    );
    const updates = updateModelPosts(view.posted, baseline);
    assert.strictEqual(
      updates.length,
      1,
      `expected exactly one updateModel post after the event, got ${updates.length} (all posts: ${JSON.stringify(view.posted.map((p) => p.type))})`
    );
    const model = updates[0].model;
    assert.ok(
      model?.local.changelists.some((c) => c.name === 'LiveChangelist'),
      'the pushed model must carry the freshly-read changelist'
    );

    tw.dispose();
  });

  it('T2: a repository event re-lists stashes and pushes the new stash row (stash lane)', async () => {
    timers = installFakeTimers();
    const repo = makeRepo('/test-repo');
    const { tw, services } = makeWindow([repo]);
    const view = resolveView(tw);
    timers.tick(300);
    await settle();
    const baseline = view.posted.length;

    services.state.stashes.set('/test-repo', [
      { index: 0, message: 'external stash', date: new Date(0) },
    ]);
    services.fireRepository(repo);
    timers.tick(300);
    await settle();

    const updates = updateModelPosts(view.posted, baseline);
    assert.strictEqual(updates.length, 1, 'a repo event with changed stash state posts once');
    assert.ok(
      updates[0].model?.shelf.rows.some((r) => r.kind === 'stash' && r.name === 'external stash'),
      'the pushed model must carry the freshly-listed stash'
    );
    tw.dispose();
  });

  it('a shelf event pushes the new shelf row', async () => {
    timers = installFakeTimers();
    const repo = makeRepo('/test-repo');
    const { tw, services } = makeWindow([repo]);
    const view = resolveView(tw);
    timers.tick(300);
    await settle();
    const baseline = view.posted.length;

    services.state.shelf.set('/test-repo', [
      { id: 'shelf1', name: 'external shelf', timestamp: new Date(0), files: [] },
    ]);
    services.fireShelf();
    timers.tick(300);
    await settle();

    const updates = updateModelPosts(view.posted, baseline);
    assert.strictEqual(updates.length, 1);
    assert.ok(
      updates[0].model?.shelf.rows.some((r) => r.kind === 'shelf' && r.name === 'external shelf'),
      'the pushed model must carry the freshly-read shelf item'
    );
    tw.dispose();
  });

  it('T3: bursty events coalesce to one stashList call and one post (300 ms trailing)', async () => {
    timers = installFakeTimers();
    const repo = makeRepo('/test-repo');
    const { tw, services } = makeWindow([repo]);
    const view = resolveView(tw);
    timers.tick(300);
    await settle();
    const baselinePosts = view.posted.length;
    const baselineStashCalls = services.stashListCalls.length;

    services.state.changelists.set('/test-repo', [makeChangelist('Burst', ['src/burst.ts'])]);
    for (let i = 0; i < 5; i++) {
      services.fireChangelists();
      services.fireShelf();
      services.fireRepository(repo);
      timers.tick(50);
    }
    timers.tick(300);
    await settle();

    assert.strictEqual(
      services.stashListCalls.length - baselineStashCalls,
      1,
      'the burst must collapse to a single stashList spawn'
    );
    assert.strictEqual(
      updateModelPosts(view.posted, baselinePosts).length,
      1,
      'the burst must collapse to a single updateModel post'
    );
    tw.dispose();
  });

  it('T4: an event with unchanged service state posts nothing (fingerprint skip)', async () => {
    timers = installFakeTimers();
    const repo = makeRepo('/test-repo');
    const { tw, services } = makeWindow([repo]);
    const view = resolveView(tw);
    timers.tick(300);
    await settle();
    const baseline = view.posted.length;

    // No state mutation — a no-op reconcile fired the event.
    services.fireChangelists();
    timers.tick(300);
    await settle();
    assert.strictEqual(
      updateModelPosts(view.posted, baseline).length,
      0,
      'unchanged state must be absorbed by the fingerprint'
    );

    // Now a real change goes through.
    services.state.changelists.set('/test-repo', [makeChangelist('Changed', ['src/x.ts'])]);
    services.fireChangelists();
    timers.tick(300);
    await settle();
    assert.strictEqual(
      updateModelPosts(view.posted, baseline).length,
      1,
      'changed state must post'
    );
    tw.dispose();
  });

  it('T5: a push prunes vanished paths from selectedFiles (model AND host set)', async () => {
    timers = installFakeTimers();
    const repo = makeRepo('/test-repo');
    const { tw, services } = makeWindow([repo]);
    services.state.changelists.set('/test-repo', [
      makeChangelist('Changes', ['src/keep.ts', 'src/gone.ts']),
    ]);
    const view = resolveView(tw);
    timers.tick(300);
    await settle();

    await asLiveSurface(tw)._handleWebviewMessage({ type: 'toggleFile', path: 'src/keep.ts' });
    await asLiveSurface(tw)._handleWebviewMessage({ type: 'toggleFile', path: 'src/gone.ts' });
    const baseline = view.posted.length;

    // src/gone.ts left the working tree (e.g. reverted externally).
    services.state.changelists.set('/test-repo', [makeChangelist('Changes', ['src/keep.ts'])]);
    services.fireChangelists();
    timers.tick(300);
    await settle();

    const updates = updateModelPosts(view.posted, baseline);
    assert.strictEqual(updates.length, 1);
    assert.deepStrictEqual(
      updates[0].model?.selectedFiles,
      ['src/keep.ts'],
      'the pushed model must omit the vanished path'
    );
    assert.deepStrictEqual(
      [...asLiveSurface(tw)._selectedFiles],
      ['src/keep.ts'],
      'the host set must be pruned too (commit fallback reads it)'
    );
    tw.dispose();
  });

  it("T6: multi-root — an event for repo B pushes the RESOLVED repo A's state", async () => {
    timers = installFakeTimers();
    const repoA = makeRepo('/repo-a');
    const repoB = makeRepo('/repo-b');
    const { tw, services } = makeWindow([repoA, repoB]);
    // Active editor sits in repo A, so the CTW resolves to repo A.
    writableWindow().activeTextEditor = {
      document: { uri: Uri.file('/repo-a/src/a.ts') },
    } as unknown as vscode.TextEditor;
    try {
      const view = resolveView(tw);
      timers.tick(300);
      await settle();
      const baseline = view.posted.length;

      services.state.changelists.set('/repo-a', [makeChangelist('RepoA-List', ['src/a2.ts'])]);
      services.state.changelists.set('/repo-b', [makeChangelist('RepoB-List', ['src/b2.ts'])]);
      services.fireRepository(repoB);
      timers.tick(300);
      await settle();

      const updates = updateModelPosts(view.posted, baseline);
      assert.strictEqual(updates.length, 1);
      const names = updates[0].model?.local.changelists.map((c) => c.name);
      assert.deepStrictEqual(
        names,
        ['RepoA-List'],
        "the push must re-read the resolved repo's services, not the event payload's repo"
      );
    } finally {
      writableWindow().activeTextEditor = undefined;
      tw.dispose();
    }
  });

  it('T7: an undelivered post is re-pushed when the view becomes visible', async () => {
    timers = installFakeTimers();
    const repo = makeRepo('/test-repo');
    const { tw, services } = makeWindow([repo]);
    const view = resolveView(tw);
    timers.tick(300);
    await settle();

    // The next push is dropped by VS Code (hidden view without retain, etc.).
    view.setDelivered(false);
    services.state.changelists.set('/test-repo', [makeChangelist('Missed', ['src/m.ts'])]);
    services.fireChangelists();
    timers.tick(300);
    await settle();
    const baseline = view.posted.length;

    view.setDelivered(true);
    view.fireVisibility(true);
    timers.tick(300);
    await settle();

    const updates = updateModelPosts(view.posted, baseline);
    assert.strictEqual(updates.length, 1, 'visibility must force one redelivery push');
    assert.ok(
      updates[0].model?.local.changelists.some((c) => c.name === 'Missed'),
      'the redelivered model carries the state the missed post had'
    );
    tw.dispose();
  });

  it('T15: pre-resolve event bursts spawn no git and post nothing (never-resolved guard)', async () => {
    timers = installFakeTimers();
    const repo = makeRepo('/test-repo');
    const { tw, services } = makeWindow([repo]);

    services.state.stashes.set('/test-repo', [{ index: 0, message: 'early', date: new Date(0) }]);
    services.fireChangelists();
    services.fireShelf();
    services.fireRepository(repo);
    timers.tick(600);
    await settle();

    assert.strictEqual(
      services.stashListCalls.length,
      0,
      'a never-resolved CTW must not spawn git on event bursts'
    );

    // Resolve now: the initial load reads fresh data and the first push lands.
    const view = resolveView(tw);
    timers.tick(300);
    await settle();
    assert.ok(services.stashListCalls.length >= 1, 'resolve reads fresh state');
    const updates = updateModelPosts(view.posted);
    assert.strictEqual(updates.length, 1, 'the first post-resolve push must go through');
    assert.ok(
      updates[0].model?.shelf.rows.some((r) => r.kind === 'stash' && r.name === 'early'),
      'the resolve-time push carries the pre-resolve state'
    );
    tw.dispose();
  });

  it('a background push never prompts: multi-root with no active editor shows no QuickPick', async () => {
    timers = installFakeTimers();
    const repoA = makeRepo('/repo-a');
    const repoB = makeRepo('/repo-b');
    const { tw, services } = makeWindow([repoA, repoB]);
    // No active editor: the resolver's deterministic chain cannot pick a repo.
    writableWindow().activeTextEditor = undefined;
    let quickPicks = 0;
    const savedQuickPick = writableWindow().showQuickPick;
    writableWindow().showQuickPick = async () => {
      quickPicks++;
      return undefined;
    };
    try {
      const view = resolveView(tw);
      timers.tick(300);
      await settle();
      const pushBaselinePicks = quickPicks;

      services.state.changelists.set('/repo-a', [makeChangelist('BG', ['src/bg.ts'])]);
      services.fireChangelists();
      timers.tick(300);
      await settle();

      assert.strictEqual(
        quickPicks - pushBaselinePicks,
        0,
        'a background live push must never open the repo-disambiguation QuickPick'
      );
      void view;
    } finally {
      writableWindow().showQuickPick = savedQuickPick;
      tw.dispose();
    }
  });

  it('an unresolvable repo still pushes user-initiated chrome (tab switch from cached state)', async () => {
    timers = installFakeTimers();
    const repoA = makeRepo('/repo-a');
    const repoB = makeRepo('/repo-b');
    const { tw } = makeWindow([repoA, repoB]);
    writableWindow().activeTextEditor = undefined;
    const savedQuickPick = writableWindow().showQuickPick;
    writableWindow().showQuickPick = async () => undefined;
    try {
      const view = resolveView(tw);
      timers.tick(300);
      await settle();
      const baseline = view.posted.length;

      await asLiveSurface(tw)._handleWebviewMessage({ type: 'tabChange', tab: 'shelf' });
      await settle();

      const updates = updateModelPosts(view.posted, baseline);
      assert.strictEqual(
        updates.length,
        1,
        'a tab switch must still push (from cached state) when no repo resolves'
      );
      assert.strictEqual(updates[0].model?.activeTab, 'shelf');
    } finally {
      writableWindow().showQuickPick = savedQuickPick;
      tw.dispose();
    }
  });

  it('T16a: prefillComposerMessage posts one setComposerMessage — no regen, no updateModel', async () => {
    timers = installFakeTimers();
    const repo = makeRepo('/test-repo');
    const { tw, services } = makeWindow([repo]);
    void services;
    const view = resolveView(tw);
    timers.tick(300);
    await settle();
    const baseline = view.posted.length;

    tw.prefillComposerMessage('undone msg');
    timers.tick(300);
    await settle();

    assert.strictEqual(
      view.htmlAssignments(),
      1,
      'prefill must not reassign webview.html (resolve render only)'
    );
    const prefills = view.posted.slice(baseline).filter((m) => m.type === 'setComposerMessage');
    assert.strictEqual(prefills.length, 1, 'exactly one setComposerMessage post');
    assert.strictEqual(prefills[0].message, 'undone msg');
    assert.strictEqual(
      updateModelPosts(view.posted, baseline).length,
      0,
      'prefill must not ride the live-update arm (I7 would swallow it)'
    );
    tw.dispose();
  });
});
