/**
 * Tests for `GitService.discoverRepository` nested-repo discovery
 * (task #204).
 *
 * Earlier behavior: `discoverRepository(folder)` only checked the
 * folder root for `.git/`, so opening `~/work/` with `~/work/projectA/.git`
 * + `~/work/projectB/.git` showed ZERO repos in IntelliG.
 *
 * Now: `discoverRepository` delegates to `scanFolderForGitRepos`
 * which mirrors VS Code's `git.repositoryScanMaxDepth` algorithm. The
 * settings exposed are `intellig.repositoryScanMaxDepth` (default 1) and
 * `intellig.repositoryScanIgnoredFolders` (default []).
 *
 * Each spec was written BEFORE the wire-up and confirmed RED first; see
 * AGENT_WORKSPACE.md for the verbatim red-message captures.
 */

import '../../setup';
import * as assert from 'assert';
import { okAsync, ResultAsync } from 'neverthrow';
import { GitService } from '../../../src/git-core/GitService';
import { GitError } from '../../../src/git-core/errors';
import * as vscodeMock from '../../mocks/vscode';
import { IRepoScanFs } from '../../../src/git-core/repoScan';

const { Uri, workspace } = vscodeMock;

/**
 * Stub GitCli that scripts `getRepositoryRoot` per-path. Tests call
 * `setRoot('/work/a', '/work/a')` to teach the stub that
 * `getRepositoryRoot('/work/a')` should resolve to `'/work/a'`.
 */
class StubGitCliForDiscovery {
  public readonly rootByPath: Map<string, string | undefined> = new Map();
  public readonly calls: string[] = [];

  setRoot(query: string, root: string | undefined): void {
    this.rootByPath.set(query, root);
  }

  getRepositoryRoot(path: string): ResultAsync<string | undefined, GitError> {
    this.calls.push(path);
    return okAsync(this.rootByPath.get(path));
  }

  async exec(
    _args: string[],
    _options?: unknown
  ): Promise<{ exitCode: number; stdout: string; stderr: string; combined: string }> {
    return { exitCode: 0, stdout: '', stderr: '', combined: '' };
  }

  get onCommandExecuted(): () => { dispose: () => void } {
    return (): { dispose: () => void } => ({ dispose: (): void => {} });
  }

  dispose(): void {
    /* no-op */
  }
}

interface DiscoverTestSurface {
  _gitCli: StubGitCliForDiscovery;
  loadRepository: (root: string) => Promise<unknown>;
  setupRepositoryWatcher: (root: string) => void;
  discoverRepository: (path: string) => Promise<void>;
  _repoScanFs: IRepoScanFs;
}

/**
 * Pre-populated in-memory fs stub. Tests can wire a static directory tree.
 */
function makeFsStub(
  tree: Record<string, string[]>,
  symlinks: Set<string> = new Set()
): IRepoScanFs {
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
          return symlinks.has(`${p}/${name}`);
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

/**
 * Reset workspace folder + intellig configuration between tests. The
 * vscode mock has module-level state so we have to clean it up explicitly.
 */
function setWorkspaceFolders(folders: string[]): void {
  workspace.workspaceFolders = folders.map((f) => ({
    uri: Uri.file(f),
    name: f,
    index: 0,
  }));
}

function setIntelligConfig(key: string, value: unknown): void {
  // Update the underlying configuration store via the workspace mock.
  void workspace.getConfiguration('intellig').update(key, value);
}

describe('GitService — nested-repo discovery (Wave 10 / task #204)', () => {
  let gitService: GitService;
  let stubCli: StubGitCliForDiscovery;
  let loadCalls: string[];

  beforeEach(() => {
    stubCli = new StubGitCliForDiscovery();
    gitService = new GitService();
    loadCalls = [];

    const surface = gitService as unknown as DiscoverTestSurface;
    surface._gitCli = stubCli;
    // Stub loadRepository to record root paths and add a fake repo cache
    // entry so `getRepositories()` returns something checkable.
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
    // Stub setupRepositoryWatcher so discovery doesn't try to install file
    // watchers per discovered root (the test fixture isn't responsible for
    // exercising the watcher path; that's gitServiceWatcher.test.ts).
    surface.setupRepositoryWatcher = (_root: string): void => {
      /* no-op */
    };
  });

  afterEach(() => {
    setWorkspaceFolders([]);
    setIntelligConfig('repositoryScanMaxDepth', undefined);
    setIntelligConfig('repositoryScanIgnoredFolders', undefined);
    gitService.dispose();
  });

  it('discovers nested repos when workspace root is not itself a repo', async () => {
    // Setup: /work has /work/a/.git and /work/b/.git but no /work/.git.
    stubCli.setRoot('/work', undefined);
    stubCli.setRoot('/work/a', '/work/a');
    stubCli.setRoot('/work/b', '/work/b');

    const surface = gitService as unknown as DiscoverTestSurface;
    surface._repoScanFs = makeFsStub({ '/work': ['a', 'b'] });

    await surface.discoverRepository('/work');

    const roots = gitService.getRepositories().map((r) => r.rootUri.fsPath);
    assert.deepStrictEqual(roots.sort(), ['/work/a', '/work/b']);
  });

  it('respects intellig.repositoryScanMaxDepth=0 setting (no nested scan)', async () => {
    // Regression guard: when the user sets maxDepth=0, the helper must
    // restrict to root-only behavior — even though /work has nested repos.
    stubCli.setRoot('/work', undefined);
    stubCli.setRoot('/work/a', '/work/a');
    stubCli.setRoot('/work/b', '/work/b');

    setIntelligConfig('repositoryScanMaxDepth', 0);

    const surface = gitService as unknown as DiscoverTestSurface;
    surface._repoScanFs = makeFsStub({ '/work': ['a', 'b'] });

    await surface.discoverRepository('/work');

    const roots = gitService.getRepositories().map((r) => r.rootUri.fsPath);
    assert.deepStrictEqual(roots, []);
  });

  it('respects intellig.repositoryScanIgnoredFolders setting', async () => {
    // When the user adds 'a' to the ignored list, only 'b' is discovered
    // even though /work/a/.git exists.
    stubCli.setRoot('/work', undefined);
    stubCli.setRoot('/work/a', '/work/a');
    stubCli.setRoot('/work/b', '/work/b');

    setIntelligConfig('repositoryScanIgnoredFolders', ['a']);

    const surface = gitService as unknown as DiscoverTestSurface;
    surface._repoScanFs = makeFsStub({ '/work': ['a', 'b'] });

    await surface.discoverRepository('/work');

    const roots = gitService.getRepositories().map((r) => r.rootUri.fsPath);
    assert.deepStrictEqual(roots, ['/work/b']);
  });

  // ============================================
  // Fire onDidChangeRepository on initial repo-add
  // so subscribers (BranchTreeProvider, StatusBarService, BranchPopup,
  // ChangelistService, ConflictResolutionService, GitToolWindowProvider)
  // see freshly-discovered repos. Earlier, only the debounced
  // refresh path fired the emitter — meaning a `git init` in a new
  // workspace folder produced an entry in `_repositories` but no event,
  // so the 6 subscribers stayed stale until the user manually triggered
  // a `.git/`-touching git operation.
  // ============================================

  it('fires onDidChangeRepository when discoverRepository adds a new repo (TL-82)', async () => {
    stubCli.setRoot('/work', undefined);
    stubCli.setRoot('/work/a', '/work/a');

    const surface = gitService as unknown as DiscoverTestSurface;
    surface._repoScanFs = makeFsStub({ '/work': ['a'] });

    const fired: string[] = [];
    const sub = gitService.onDidChangeRepository((repo) => {
      fired.push(repo.rootUri.fsPath);
    });
    try {
      await surface.discoverRepository('/work');
    } finally {
      sub.dispose();
    }

    assert.deepStrictEqual(
      fired,
      ['/work/a'],
      'onDidChangeRepository must fire exactly once per newly-added repo'
    );
  });

  it('fires onDidChangeRepository for each of multiple newly-added nested repos (TL-82)', async () => {
    stubCli.setRoot('/work', undefined);
    stubCli.setRoot('/work/a', '/work/a');
    stubCli.setRoot('/work/b', '/work/b');

    const surface = gitService as unknown as DiscoverTestSurface;
    surface._repoScanFs = makeFsStub({ '/work': ['a', 'b'] });

    const fired: string[] = [];
    const sub = gitService.onDidChangeRepository((repo) => {
      fired.push(repo.rootUri.fsPath);
    });
    try {
      await surface.discoverRepository('/work');
    } finally {
      sub.dispose();
    }

    assert.deepStrictEqual(
      fired.sort(),
      ['/work/a', '/work/b'],
      'onDidChangeRepository must fire once for EACH newly-added nested repo'
    );
  });

  it('does NOT re-fire onDidChangeRepository for an already-tracked repo (TL-82 idempotency)', async () => {
    // Defense-in-depth for the dedup branch: discoverRepository can be
    // called twice (e.g. mid-session new-repo watcher fires while initial
    // scan is still resolving). The second call must not re-fire the
    // emitter for repos already in `_repositories`.
    stubCli.setRoot('/work', undefined);
    stubCli.setRoot('/work/a', '/work/a');

    const surface = gitService as unknown as DiscoverTestSurface;
    surface._repoScanFs = makeFsStub({ '/work': ['a'] });

    const fired: string[] = [];
    const sub = gitService.onDidChangeRepository((repo) => {
      fired.push(repo.rootUri.fsPath);
    });
    try {
      await surface.discoverRepository('/work');
      await surface.discoverRepository('/work'); // second call
    } finally {
      sub.dispose();
    }

    assert.deepStrictEqual(
      fired,
      ['/work/a'],
      'second discoverRepository call must not re-fire the change emitter for the same repo'
    );
  });
});

// ============================================
// MEDIUM: setupRepositoryWatcher idempotency
// regression guard.
//
// The existing `_fileWatchers.has(rootPath)` short-circuit at the top of
// setupRepositoryWatcher already prevents a double-install. This spec
// pins that contract so a future refactor can't accidentally remove the
// guard and leak a second watcher array — which would (a) waste a
// FileSystemWatcher slot per repo per re-discovery, and (b) duplicate
// every onDidChange handler so a single ref-write triggers 2N debounced
// reloads instead of 1.
// ============================================
describe('GitService — setupRepositoryWatcher idempotency (Wave 10 R2 / TL-83)', () => {
  let gitService: GitService;
  let stubCli: StubGitCliForDiscovery;

  beforeEach(() => {
    stubCli = new StubGitCliForDiscovery();
    gitService = new GitService();
    // Replace _gitCli with the stub so any incidental git CLI activity
    // during loadRepository doesn't spawn real subprocesses.
    const surface = gitService as unknown as DiscoverTestSurface;
    surface._gitCli = stubCli;
  });

  afterEach(() => {
    gitService.dispose();
  });

  it('a second call for the same rootPath preserves the original watcher array (short-circuit fired)', () => {
    // (senior-r2 finding): the prior count-based assertion
    // (`secondCount === firstCount`) was a TAUTOLOGY. Without the short-
    // circuit, `_fileWatchers.set(rootPath, watchers)` would overwrite the
    // first array with a new array of the same length N — so both branches
    // (short-circuit fires vs. doesn't) would yield secondCount===N and
    // the spec would pass either way, catching no regression.
    //
    // Assert by ARRAY IDENTITY. With the short-circuit, the second
    // call returns early and `_fileWatchers.get(rootPath)` keeps the
    // SAME array reference. Without the short-circuit, the `.set` call
    // installs a fresh array (different reference) and identity fails.
    const surface = gitService as unknown as DiscoverTestSurface & {
      _fileWatchers: Map<string, unknown[]>;
    };

    surface.setupRepositoryWatcher('/work/a');
    const firstWatchers = surface._fileWatchers.get('/work/a');
    assert.ok(
      firstWatchers && firstWatchers.length > 0,
      'first call must install at least one watcher'
    );

    surface.setupRepositoryWatcher('/work/a');
    const secondWatchers = surface._fileWatchers.get('/work/a');

    assert.strictEqual(
      secondWatchers,
      firstWatchers,
      'second call must preserve the original watcher array reference (short-circuit fired); a fresh array means the short-circuit was bypassed and N additional watchers leaked'
    );
  });
});
