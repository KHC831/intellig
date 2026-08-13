/**
 * Commit Tool Window — sticky target repository (multi-root).
 *
 * The CTW renders ONE repository's changelists and every action targets it.
 * That repo is owned by the window: seeded once (active editor → single repo
 * → one disambiguation prompt) and then reused — a second action must never
 * re-prompt, and the background refresh must keep refreshing the SAME repo
 * (the non-interactive resolver returns undefined in multi-root, which used
 * to leave the list permanently stale after a commit). The Git tool window's
 * repository selector switches the target explicitly via setRepository.
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

interface CommitToolWindowLiveTestSurface {
  _handleWebviewMessage(message: unknown): Promise<void>;
}
function asSurface(tw: CommitToolWindow): CommitToolWindowLiveTestSurface {
  return tw as unknown as CommitToolWindowLiveTestSurface;
}

interface PostedMessage {
  type?: string;
  model?: ICommitToolWindowInitModel;
}

function createMockMemento(): vscode.Memento {
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
  } as unknown as vscode.Memento;
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

function makeChangelist(name: string, files: string[]): IChangelist {
  return {
    id: name,
    name,
    isDefault: true,
    isActive: true,
    files: files.map((path) => ({ path, status: 'modified' as const, staged: false })),
  };
}

interface Harness {
  tw: CommitToolWindow;
  posted: PostedMessage[];
  changelists: Map<string, IChangelist[]>;
  fireChangelists(): void;
}

function makeHarness(repos: IRepository[]): Harness {
  const changelists = new Map<string, IChangelist[]>();
  const shelf = new Map<string, IShelfItem[]>();
  const stashes = new Map<string, IStash[]>();
  for (const r of repos) {
    changelists.set(r.rootUri.fsPath, []);
    shelf.set(r.rootUri.fsPath, []);
    stashes.set(r.rootUri.fsPath, []);
  }
  const repoChange = new EventEmitter<IRepository>();
  const clChange = new EventEmitter<IChangelist[]>();
  const shelfChange = new EventEmitter<IShelfItem[]>();

  const gitService = {
    onDidChangeRepository: repoChange.event,
    getRepositories: () => repos,
    getRepository: async () => repos[0],
    stashList: async (repo: IRepository) => stashes.get(repo.rootUri.fsPath) ?? [],
    getDiff: async () => ({ path: '', status: 'modified' as const, hunks: [], binary: false }),
    dispose: () => {},
  } as unknown as IGitService;
  const changelistService = {
    onDidChangeChangelists: clChange.event,
    getChangelists: (repo: IRepository) => changelists.get(repo.rootUri.fsPath) ?? [],
    reconcileWithGitStatus: async () => {},
    getActiveChangelist: async (repo: IRepository) =>
      (changelists.get(repo.rootUri.fsPath) ?? []).find((c) => c.isActive),
    dispose: () => {},
  } as unknown as IChangelistService;
  const shelfService = {
    onDidChangeShelf: shelfChange.event,
    getShelfItems: (repo: IRepository) => shelf.get(repo.rootUri.fsPath) ?? [],
    dispose: () => {},
  } as unknown as IShelfService;

  const tw = new CommitToolWindow(
    Uri.file('/ext'),
    gitService,
    changelistService,
    shelfService,
    createMockMemento()
  );

  const posted: PostedMessage[] = [];
  const view = {
    visible: true,
    webview: {
      html: '',
      options: {},
      cspSource: 'test:',
      asWebviewUri: (u: unknown) => u,
      postMessage: (m: unknown) => {
        posted.push(m as PostedMessage);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: () => ({ dispose: () => {} }),
    },
    onDidDispose: () => ({ dispose: () => {} }),
    onDidChangeVisibility: () => ({ dispose: () => {} }),
  } as unknown as vscode.WebviewView;
  tw.resolveWebviewView(
    view,
    {} as vscode.WebviewViewResolveContext,
    {} as vscode.CancellationToken
  );

  return { tw, posted, changelists, fireChangelists: () => clChange.fire([]) };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await flushMicrotasks();
  }
}

/** Every file path in a model's Local tab, across flat AND directory grouping. */
function filesOf(model: ICommitToolWindowInitModel | undefined): string[] {
  return (model?.local.changelists ?? []).flatMap((cl) => {
    if (cl.files) {
      return cl.files.map((f) => f.path);
    }
    return (cl.dirGroups ?? []).flatMap((g) => g.files.map((f) => f.path));
  });
}

describe('CommitToolWindow — sticky target repository', () => {
  let timers: ReturnType<typeof installFakeTimers> | undefined;
  let savedQuickPick: (items: unknown[], options?: unknown) => Promise<unknown>;

  beforeEach(() => {
    savedQuickPick = writableWindow().showQuickPick;
    writableWindow().activeTextEditor = undefined;
  });

  afterEach(() => {
    writableWindow().showQuickPick = savedQuickPick;
    timers?.uninstall();
    timers = undefined;
  });

  it('opening the view in multi-root never prompts (boot reload is background work)', async () => {
    timers = installFakeTimers();
    let quickPicks = 0;
    writableWindow().showQuickPick = async () => {
      quickPicks++;
      return undefined;
    };
    const h = makeHarness([makeRepo('/repo-a'), makeRepo('/repo-b')]);
    try {
      timers.tick(300);
      await settle();
      assert.strictEqual(quickPicks, 0, 'resolving the view must not open a repository picker');
    } finally {
      h.tw.dispose();
    }
  });

  it('prompts ONCE in multi-root: the answer sticks for later actions', async () => {
    timers = installFakeTimers();
    const repoA = makeRepo('/repo-a');
    const repoB = makeRepo('/repo-b');
    const h = makeHarness([repoA, repoB]);
    let quickPicks = 0;
    writableWindow().showQuickPick = async (items: unknown[]) => {
      quickPicks++;
      return (items as Array<{ repo: IRepository }>).find((i) => i.repo === repoB);
    };
    try {
      timers.tick(300);
      await settle();

      await asSurface(h.tw)._handleWebviewMessage({ type: 'selectFile', path: 'src/a.ts' });
      await settle();
      assert.strictEqual(quickPicks, 1, 'first action disambiguates once');
      assert.strictEqual(h.tw.lastSelectedFileUri?.fsPath, '/repo-b/src/a.ts');

      await asSurface(h.tw)._handleWebviewMessage({ type: 'selectFile', path: 'src/b.ts' });
      await settle();
      assert.strictEqual(quickPicks, 1, 'the second action reuses the sticky repo — no re-prompt');
      assert.strictEqual(h.tw.lastSelectedFileUri?.fsPath, '/repo-b/src/b.ts');
    } finally {
      h.tw.dispose();
    }
  });

  it('background refresh keeps refreshing the sticky repo (post-commit staleness)', async () => {
    timers = installFakeTimers();
    const repoA = makeRepo('/repo-a');
    const repoB = makeRepo('/repo-b');
    const h = makeHarness([repoA, repoB]);
    writableWindow().showQuickPick = async (items: unknown[]) => {
      return (items as Array<{ repo: IRepository }>).find((i) => i.repo === repoB);
    };
    try {
      timers.tick(300);
      await settle();

      // Establish the sticky repo (repo-b) with a first action, with a file
      // list rendered from it.
      h.changelists.set('/repo-b', [makeChangelist('Changes', ['src/before.ts'])]);
      await asSurface(h.tw)._handleWebviewMessage({ type: 'selectFile', path: 'src/a.ts' });
      h.fireChangelists();
      timers.tick(300);
      await settle();
      const rendered = h.posted.filter((m) => m.type === 'updateModel');
      assert.deepStrictEqual(
        filesOf(rendered[rendered.length - 1]?.model),
        ['src/before.ts'],
        'positive control: the pre-commit list actually rendered the file'
      );

      // The commit lands: the repo's changelists change and the service fires
      // (the same signal a real commit produces). No active editor, so the
      // old non-interactive resolve found NO repo and kept the stale list.
      const baseline = h.posted.length;
      h.changelists.set('/repo-b', [makeChangelist('Changes', [])]);
      h.fireChangelists();
      timers.tick(300);
      await settle();

      const updates = h.posted.slice(baseline).filter((m) => m.type === 'updateModel');
      assert.ok(updates.length >= 1, 'the background push must deliver the refreshed model');
      const files = filesOf(updates[updates.length - 1].model);
      assert.deepStrictEqual(
        files,
        [],
        'the refreshed model must reflect the post-commit (empty) list'
      );
    } finally {
      h.tw.dispose();
    }
  });

  it('setRepository switches the target explicitly and reloads without prompting', async () => {
    timers = installFakeTimers();
    const repoA = makeRepo('/repo-a');
    const repoB = makeRepo('/repo-b');
    const h = makeHarness([repoA, repoB]);
    let quickPicks = 0;
    writableWindow().showQuickPick = async () => {
      quickPicks++;
      return undefined;
    };
    try {
      timers.tick(300);
      await settle();

      h.changelists.set('/repo-a', [makeChangelist('A-list', ['a-only.ts'])]);
      h.tw.setRepository(repoA);
      timers.tick(300);
      await settle();

      const updates = h.posted.filter((m) => m.type === 'updateModel');
      assert.deepStrictEqual(
        filesOf(updates[updates.length - 1]?.model),
        ['a-only.ts'],
        'the model renders the selector-chosen repo'
      );
      assert.strictEqual(quickPicks, 0, 'an explicit selection never prompts');

      // Later actions target the selected repo without prompting.
      await asSurface(h.tw)._handleWebviewMessage({ type: 'selectFile', path: 'x.ts' });
      await settle();
      assert.strictEqual(h.tw.lastSelectedFileUri?.fsPath, '/repo-a/x.ts');
      assert.strictEqual(quickPicks, 0);
    } finally {
      h.tw.dispose();
    }
  });
});
