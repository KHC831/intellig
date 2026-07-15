/**
 * Tests for `GitService` configuration-change rediscovery.
 *
 * Without rediscovery, `intellig.repositoryScanMaxDepth` and
 * `intellig.repositoryScanIgnoredFolders` are read once at workspace-folder-add
 * time (or initial extension activation), so mid-session config changes have no
 * effect until window reload.
 *
 * Register `vscode.workspace.onDidChangeConfiguration` on the GitService
 * and, when either of the two scan-related keys change, re-run discovery on
 * every workspace folder. New repos discovered after a depth-increase fire
 * `onDidChangeRepository` per repo (per existing contract); already-known
 * repos do NOT re-fire.
 *
 * Each spec was authored RED-first and confirmed failing before the
 * configuration-change listener was registered.
 */

import '../../setup';
import * as assert from 'assert';
import * as path from 'path';
import { okAsync, ResultAsync } from 'neverthrow';
import { GitService } from '../../../src/git-core/GitService';
import { GitError } from '../../../src/git-core/errors';
import * as vscodeMock from '../../mocks/vscode';
import { IRepoScanFs } from '../../../src/git-core/repoScan';

const { Uri, workspace } = vscodeMock;

class StubGitCli {
  public readonly rootByPath: Map<string, string | undefined> = new Map();
  public readonly calls: string[] = [];

  setRoot(query: string, root: string | undefined): void {
    this.rootByPath.set(query, root);
  }

  getRepositoryRoot(p: string): ResultAsync<string | undefined, GitError> {
    this.calls.push(p);
    return okAsync(this.rootByPath.get(p));
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
  _repoScanPath: Pick<typeof path, 'join' | 'dirname' | 'sep'>;
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
          // (#212): IRepoScanFs.Dirent requires isFile(); the
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
  // Rediscovery awaits `loadRepository`, which interleaves git execs with
  // several on-disk marker reads (fs I/O for repository-state detection). Those
  // resolve across multiple event-loop turns, so yield generously to let the
  // full async tail of every re-loaded repo settle before asserting.
  for (let i = 0; i < 20; i++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

/**
 * Poll until `predicate` holds, yielding across event-loop turns, up to a
 * generous cap. The config listener fires rediscovery fire-and-forget, so a
 * fixed number of yields (flushMicrotasks) can under-wait when the async scan
 * tail is scheduled behind other work on a loaded CI runner. Waiting on the
 * observable end-state instead is deterministic: it returns the instant
 * discovery settles and only throws on a genuine hang.
 */
async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  assert.ok(predicate(), `timed out waiting for: ${label}`);
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
    // Fixtures use POSIX literal paths; pin the scanner's path impl so its joins
    // match them on a Windows runner (no-op on POSIX).
    surface._repoScanPath = path.posix;
    surface._gitCli = stubCli;
    // Record which roots get loaded, but delegate to the REAL `loadRepository`
    // funnel (StubGitCli `exec` returns benign empty output, so no real git
    // subprocess runs) so its first-insertion announce (onDidChangeRepository)
    // fires from production code rather than a stub.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const realLoad = (GitService.prototype as any).loadRepository as (
      this: GitService,
      root: string
    ) => Promise<unknown>;
    surface.loadRepository = async (root: string): Promise<unknown> => {
      loadCalls.push(root);
      return realLoad.call(gitService, root);
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
    await waitUntil(
      () => gitService.getRepositories().length === 2,
      'both nested repos discovered after maxDepth 0 → 1'
    );

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
    await waitUntil(
      () => gitService.getRepositories().length === 2,
      'both nested repos discovered after ignoredFolders cleared'
    );

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
    // existing contract requires firing onDidChangeRepository per new repo.
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
