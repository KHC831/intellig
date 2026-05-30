/**
 * Tests for `GitService` configuration-change rediscovery (TL-86 / #211).
 *
 * Bug: pre-TL-86, `intellig.repositoryScanMaxDepth` and
 * `intellig.repositoryScanIgnoredFolders` were read once at workspace-folder-add
 * time (or initial extension activation). Mid-session config changes had no
 * effect until window reload.
 *
 * Fix: register `vscode.workspace.onDidChangeConfiguration` on the GitService
 * and, when either of the two scan-related keys change, re-run discovery on
 * every workspace folder. New repos discovered after a depth-increase fire
 * `onDidChangeRepository` per repo (per existing TL-82 contract); already-known
 * repos do NOT re-fire.
 *
 * Each spec was authored RED-first and confirmed failing before the
 * configuration-change listener was registered. See AGENT_WORKSPACE.md for
 * the verbatim red-message captures.
 */

import '../../setup';
import * as assert from 'assert';
import { GitService } from '../../../git-core/GitService';
import * as vscodeMock from '../../mocks/vscode';
import { IRepoScanFs } from '../../../git-core/repoScan';

const { Uri, workspace } = vscodeMock;

class StubGitCli {
  public readonly rootByPath: Map<string, string | undefined> = new Map();
  public readonly calls: string[] = [];

  setRoot(query: string, root: string | undefined): void {
    this.rootByPath.set(query, root);
  }

  async getRepositoryRoot(p: string): Promise<string | undefined> {
    this.calls.push(p);
    return this.rootByPath.get(p);
  }

  async exec(): Promise<{ exitCode: number; stdout: string; stderr: string; combined: string }> {
    return { exitCode: 0, stdout: '', stderr: '', combined: '' };
  }

  get onCommandExecuted(): () => { dispose: () => void } {
    return (): { dispose: () => void } => ({ dispose: (): void => {} });
  }

  dispose(): void {
    /* no-op */
  }
}

interface ConfigRescanSurface {
  _gitCli: StubGitCli;
  loadRepository: (root: string) => Promise<unknown>;
  setupRepositoryWatcher: (root: string) => void;
  discoverRepository: (path: string) => Promise<void>;
  _repoScanFs: IRepoScanFs;
}

function makeFsStub(tree: Record<string, string[]>): IRepoScanFs {
  return {
    async readdir(
      p: string,
      _options: { withFileTypes: true }
    ): Promise<
      {
        name: string;
        isDirectory(): boolean;
        isSymbolicLink(): boolean;
        isFile(): boolean;
      }[]
    > {
      const children = tree[p] ?? [];
      return children.map((name) => ({
        name,
        isDirectory(): boolean {
          return true;
        },
        isSymbolicLink(): boolean {
          return false;
        },
        isFile(): boolean {
          // TL-87 (#212): IRepoScanFs.Dirent requires isFile(); the
          // discovery scenarios in this file only model directories.
          return false;
        },
      }));
    },
    async realpath(p: string): Promise<string> {
      return p;
    },
  };
}

function setWorkspaceFolders(folders: string[]): void {
  workspace.workspaceFolders = folders.map((f) => ({
    uri: Uri.file(f),
    name: f,
    index: 0,
  }));
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe('GitService — config-change rediscovery (TL-86 / #211)', () => {
  let gitService: GitService;
  let stubCli: StubGitCli;
  let loadCalls: string[];

  beforeEach(() => {
    stubCli = new StubGitCli();
    gitService = new GitService();
    loadCalls = [];

    const surface = gitService as unknown as ConfigRescanSurface;
    surface._gitCli = stubCli;
    surface.loadRepository = async (root: string): Promise<unknown> => {
      loadCalls.push(root);
      const fakeRepo = {
        rootUri: Uri.file(root),
        state: 'idle',
        head: { name: 'main', commit: 'a'.repeat(40), ahead: 0, behind: 0 },
        remotes: [],
        submodules: [],
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      (gitService as any)._repositories.set(root, {
        repository: fakeRepo,
        lastUpdated: Date.now(),
      });
      return fakeRepo;
    };
    surface.setupRepositoryWatcher = (_root: string): void => {
      /* no-op */
    };
  });

  afterEach(() => {
    setWorkspaceFolders([]);
    void workspace.getConfiguration('intellig').update('repositoryScanMaxDepth', undefined);
    void workspace.getConfiguration('intellig').update('repositoryScanIgnoredFolders', undefined);
    gitService.dispose();
  });

  it('re-runs discovery on all workspace folders when repositoryScanMaxDepth changes', async () => {
    // Initial state: maxDepth=0 (no nested scan), one workspace folder /work
    // with two nested repos. With depth=0 we discover nothing.
    stubCli.setRoot('/work', undefined);
    stubCli.setRoot('/work/a', '/work/a');
    stubCli.setRoot('/work/b', '/work/b');

    setWorkspaceFolders(['/work']);
    void workspace.getConfiguration('intellig').update('repositoryScanMaxDepth', 0);

    const surface = gitService as unknown as ConfigRescanSurface;
    surface._repoScanFs = makeFsStub({ '/work': ['a', 'b'] });

    // Initial discovery: depth=0, should find nothing under /work.
    await surface.discoverRepository('/work');
    assert.strictEqual(
      gitService.getRepositories().length,
      0,
      'precondition: no repos discovered at depth 0'
    );

    // User flips the setting: depth=1. The configuration listener must
    // re-run discovery and pick up /work/a, /work/b.
    await workspace.getConfiguration('intellig').update('repositoryScanMaxDepth', 1);
    await flushMicrotasks();

    const roots = gitService.getRepositories().map((r) => r.rootUri.fsPath);
    assert.deepStrictEqual(
      roots.sort(),
      ['/work/a', '/work/b'],
      'after maxDepth raised from 0 → 1, both nested repos must be discovered without window reload'
    );
  });

  it('re-runs discovery when repositoryScanIgnoredFolders changes', async () => {
    // Initial state: depth=1, ignoredFolders=['a'] — only /work/b is found.
    stubCli.setRoot('/work', undefined);
    stubCli.setRoot('/work/a', '/work/a');
    stubCli.setRoot('/work/b', '/work/b');

    setWorkspaceFolders(['/work']);
    void workspace.getConfiguration('intellig').update('repositoryScanMaxDepth', 1);
    void workspace.getConfiguration('intellig').update('repositoryScanIgnoredFolders', ['a']);

    const surface = gitService as unknown as ConfigRescanSurface;
    surface._repoScanFs = makeFsStub({ '/work': ['a', 'b'] });

    await surface.discoverRepository('/work');
    assert.deepStrictEqual(
      gitService.getRepositories().map((r) => r.rootUri.fsPath),
      ['/work/b'],
      'precondition: only /work/b discovered with /work/a ignored'
    );

    // User clears the ignoredFolders list. Both repos should be discovered.
    await workspace.getConfiguration('intellig').update('repositoryScanIgnoredFolders', []);
    await flushMicrotasks();

    const roots = gitService.getRepositories().map((r) => r.rootUri.fsPath);
    assert.deepStrictEqual(
      roots.sort(),
      ['/work/a', '/work/b'],
      'after ignoredFolders cleared, /work/a must be discovered without window reload'
    );
  });

  it('does NOT re-fire onDidChangeRepository for already-known repos on config change', async () => {
    // The dedup guard (`_repositories.has(root)`) must keep already-tracked
    // repos from re-firing the change emitter when the listener kicks off
    // a re-discovery pass.
    stubCli.setRoot('/work', undefined);
    stubCli.setRoot('/work/a', '/work/a');

    setWorkspaceFolders(['/work']);
    void workspace.getConfiguration('intellig').update('repositoryScanMaxDepth', 1);

    const surface = gitService as unknown as ConfigRescanSurface;
    surface._repoScanFs = makeFsStub({ '/work': ['a'] });

    // Initial discovery: /work/a is added.
    await surface.discoverRepository('/work');
    assert.strictEqual(gitService.getRepositories().length, 1);

    const fired: string[] = [];
    const sub = gitService.onDidChangeRepository((r) => {
      fired.push(r.rootUri.fsPath);
    });
    try {
      // User changes the setting (no new repos to discover; existing /work/a
      // stays put). The emitter must NOT fire for /work/a — it's already known.
      await workspace.getConfiguration('intellig').update('repositoryScanIgnoredFolders', []);
      await flushMicrotasks();
    } finally {
      sub.dispose();
    }

    assert.deepStrictEqual(
      fired,
      [],
      'config change must not re-fire onDidChangeRepository for already-known repos'
    );
  });

  it('fires onDidChangeRepository exactly once for newly-discovered repos on config change', async () => {
    // Inverse of the test above: config change discovers a NEW repo. The
    // existing TL-82 contract requires firing onDidChangeRepository per new repo.
    stubCli.setRoot('/work', undefined);
    stubCli.setRoot('/work/a', '/work/a');
    stubCli.setRoot('/work/b', '/work/b');

    setWorkspaceFolders(['/work']);
    void workspace.getConfiguration('intellig').update('repositoryScanMaxDepth', 1);
    void workspace.getConfiguration('intellig').update('repositoryScanIgnoredFolders', ['b']);

    const surface = gitService as unknown as ConfigRescanSurface;
    surface._repoScanFs = makeFsStub({ '/work': ['a', 'b'] });

    await surface.discoverRepository('/work');
    assert.deepStrictEqual(
      gitService.getRepositories().map((r) => r.rootUri.fsPath),
      ['/work/a'],
      'precondition: only /work/a discovered'
    );

    const fired: string[] = [];
    const sub = gitService.onDidChangeRepository((r) => {
      fired.push(r.rootUri.fsPath);
    });
    try {
      // User clears the ignored list — /work/b should now be discovered.
      await workspace.getConfiguration('intellig').update('repositoryScanIgnoredFolders', []);
      await flushMicrotasks();
    } finally {
      sub.dispose();
    }

    assert.deepStrictEqual(
      fired,
      ['/work/b'],
      'config change must fire onDidChangeRepository exactly once for newly-discovered /work/b'
    );
  });

  it('does NOT re-discover when an unrelated intellig.* setting changes', async () => {
    // Defensive: only the two scan-related keys should trigger a re-scan. A
    // change to e.g. intellig.fetchTags must not cause any discovery work.
    stubCli.setRoot('/work', undefined);
    stubCli.setRoot('/work/a', '/work/a');

    setWorkspaceFolders(['/work']);
    void workspace.getConfiguration('intellig').update('repositoryScanMaxDepth', 1);

    const surface = gitService as unknown as ConfigRescanSurface;
    surface._repoScanFs = makeFsStub({ '/work': ['a'] });

    await surface.discoverRepository('/work');
    const baselineLoadCalls = loadCalls.length;

    await workspace.getConfiguration('intellig').update('fetchTags', 'all');
    await flushMicrotasks();

    assert.strictEqual(
      loadCalls.length,
      baselineLoadCalls,
      'unrelated intellig.* config change must not trigger any new discoveries'
    );
  });
});
