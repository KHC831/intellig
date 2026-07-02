/**
 * Tests for the mid-session new-repo watcher (task #204).
 *
 * Contract: when the user runs `git init` in a workspace subfolder
 * mid-session, IntelliG should detect the new `.git/` directory and
 * register the parent dir as a repo without requiring a window reload.
 *
 * Implementation lives in `GitService.setupNewRepoWatcher`. The watcher
 * uses `**\/.git` glob with `ignoreChangeEvents: true` +
 * `ignoreDeleteEvents: true` so it does NOT contribute to the
 * `.git/objects/**` modification storm that caused the original infinite
 * refresh loop.
 *
 * Each spec was written BEFORE wiring.
 */

import '../../setup';
import * as assert from 'assert';
import { okAsync, ResultAsync } from 'neverthrow';
import { GitService } from '../../../src/git-core/GitService';
import { GitError } from '../../../src/git-core/errors';
import * as vscodeMock from '../../mocks/vscode';
import { IRepoScanFs } from '../../../src/git-core/repoScan';

const { Uri, getCreatedFileSystemWatchers, RelativePattern, workspace } = vscodeMock;

class StubGitCli {
  public readonly rootByPath: Map<string, string | undefined> = new Map();

  setRoot(query: string, root: string | undefined): void {
    this.rootByPath.set(query, root);
  }

  getRepositoryRoot(p: string): ResultAsync<string | undefined, GitError> {
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

interface NewRepoWatcherSurface {
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

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe('GitService — mid-session new-repo watcher (Wave 10)', () => {
  let gitService: GitService;
  let stubCli: StubGitCli;
  let baselineWatcherCount: number;

  beforeEach(() => {
    stubCli = new StubGitCli();
    gitService = new GitService();
    baselineWatcherCount = getCreatedFileSystemWatchers().length;

    const surface = gitService as unknown as NewRepoWatcherSurface;
    surface._gitCli = stubCli;
    // Stub loadRepository to record + register repo cache entries.
    surface.loadRepository = async (root: string): Promise<unknown> => {
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
      /* no-op for these tests */
    };
  });

  afterEach(() => {
    workspace.workspaceFolders = undefined as unknown[] | undefined;
    void workspace.getConfiguration('intellig').update('repositoryScanMaxDepth', undefined);
    void workspace.getConfiguration('intellig').update('repositoryScanIgnoredFolders', undefined);
    gitService.dispose();
  });

  function getFreshWatchers(): ReturnType<typeof getCreatedFileSystemWatchers> {
    return getCreatedFileSystemWatchers().slice(baselineWatcherCount);
  }

  function findNewRepoWatcher(
    folderPath: string
  ): ReturnType<typeof getCreatedFileSystemWatchers>[number] | undefined {
    return getFreshWatchers().find(
      (w) =>
        w._pattern instanceof RelativePattern &&
        w._pattern.pattern === '**/.git' &&
        w._pattern.base === folderPath
    );
  }

  it('discovers a repo created mid-session under a workspace folder', async () => {
    // Initial state: workspace folder /work has no repos yet.
    stubCli.setRoot('/work', undefined);

    const surface = gitService as unknown as NewRepoWatcherSurface;
    surface._repoScanFs = makeFsStub({ '/work': [] });

    await surface.discoverRepository('/work');

    // No repos discovered initially.
    assert.strictEqual(gitService.getRepositories().length, 0);

    // The new-repo watcher must exist for /work.
    const watcher = findNewRepoWatcher('/work');
    assert.ok(watcher, 'a `**/.git` watcher must be installed for /work');

    // Simulate `git init /work/newproj` — `.git/` folder appears.
    stubCli.setRoot('/work/newproj', '/work/newproj');
    watcher._fireCreate(Uri.file('/work/newproj/.git'));

    await flushMicrotasks();
    // discoverRepository routes through safeFireAndForget; one extra tick
    // for the resolveRepoRoot promise + loadRepository to settle.
    await flushMicrotasks();
    await flushMicrotasks();

    const roots = gitService.getRepositories().map((r) => r.rootUri.fsPath);
    assert.deepStrictEqual(roots, ['/work/newproj']);
  });

  it('skips new repos whose path traverses an ignored folder (e.g. node_modules)', async () => {
    stubCli.setRoot('/work', undefined);
    const surface = gitService as unknown as NewRepoWatcherSurface;
    surface._repoScanFs = makeFsStub({ '/work': [] });

    await surface.discoverRepository('/work');

    const watcher = findNewRepoWatcher('/work');
    assert.ok(watcher);

    // npm packages ship their own .git/ — these must NOT be auto-loaded.
    stubCli.setRoot('/work/node_modules/foo', '/work/node_modules/foo');
    watcher._fireCreate(Uri.file('/work/node_modules/foo/.git'));

    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    assert.strictEqual(
      gitService.getRepositories().length,
      0,
      'new repo inside an ignored folder must not be auto-loaded'
    );
  });

  it('configures the watcher with ignoreChangeEvents + ignoreDeleteEvents to avoid the Wave 1 loop', async () => {
    // Defense-in-depth assertion: the new-repo watcher MUST not subscribe
    // to change/delete events. Otherwise every time a repo writes to its
    // own `.git/` (which happens on every git operation) we'd re-enter the
    // refresh path. Verified at the FileSystemWatcher constructor call.
    //
    // (test-ordering fragility fix): use a path
    // (`/r2-fresh-path`) the GitService constructor's async
    // `discoverRepositories()` cannot have visited (workspace folders are
    // explicitly cleared in the afterEach of the prior test, and beforeEach
    // doesn't set workspaceFolders), so the wrapper below is GUARANTEED to
    // capture the watcher install from our explicit `discoverRepository`
    // call below, not a stale construction-time call. Reset
    // `_newRepoWatchers` defensively so even if a constructor-side discovery
    // landed earlier, we re-trigger the install path here.
    const surface = gitService as unknown as NewRepoWatcherSurface & {
      _newRepoWatchers: Map<string, unknown>;
    };
    surface._newRepoWatchers.clear();

    const folderPath = '/r2-fresh-path';
    stubCli.setRoot(folderPath, undefined);
    surface._repoScanFs = makeFsStub({ [folderPath]: [] });

    // We need to inspect the constructor args. Wrap createFileSystemWatcher
    // and capture the call. Wrapping happens BEFORE the explicit
    // discoverRepository call AND the path-key isolation above guarantees
    // the wrapper captures THIS install, not any background construction.
    const origCreate = workspace.createFileSystemWatcher;
    const captured: {
      pattern: unknown;
      ignoreCreate: boolean | undefined;
      ignoreChange: boolean | undefined;
      ignoreDelete: boolean | undefined;
    }[] = [];
    workspace.createFileSystemWatcher = (
      pattern: unknown,
      ignoreCreate?: boolean,
      ignoreChange?: boolean,
      ignoreDelete?: boolean
    ): ReturnType<typeof origCreate> => {
      captured.push({ pattern, ignoreCreate, ignoreChange, ignoreDelete });
      return origCreate.call(
        workspace,
        pattern as Parameters<typeof origCreate>[0],
        ignoreCreate,
        ignoreChange,
        ignoreDelete
      );
    };
    try {
      await surface.discoverRepository(folderPath);
    } finally {
      workspace.createFileSystemWatcher = origCreate;
    }

    // Find the **/.git watcher in the captured list. Restrict to the
    // fresh-path base so we definitively know it's THIS test's install.
    const newRepoEntry = captured.find(
      (c) =>
        c.pattern instanceof RelativePattern &&
        c.pattern.pattern === '**/.git' &&
        c.pattern.base === folderPath
    );
    assert.ok(newRepoEntry, 'a `**/.git` watcher must be created');
    assert.strictEqual(
      newRepoEntry.ignoreCreate,
      false,
      'must NOT ignore create events (that is the only event we react to)'
    );
    assert.strictEqual(
      newRepoEntry.ignoreChange,
      true,
      'MUST ignore change events to avoid the Wave 1 .git/objects/** modify storm loop'
    );
    assert.strictEqual(
      newRepoEntry.ignoreDelete,
      false,
      'must NOT ignore delete events — deleting a repo dir has to evict it from the picker. ' +
        'Deletes of a `.git` basename are rare (unlike the .git/objects/** modify storm), so ' +
        'this cannot re-create the Wave 1 loop.'
    );
  });

  // ============================================
  // Scan-depth parity: the initial scan honors
  // `repositoryScanMaxDepth`, but the mid-session watcher registered a
  // `.git` created at ANY depth (its `**/.git` glob has no depth bound).
  // Test-run scratch repos at depth 2+ therefore appeared in the repo
  // picker even though a window reload would never discover them. The
  // create handler must apply the same depth rule as the scanner:
  // maxDepth 1 = the folder itself + direct children; -1 = unlimited.
  // ============================================
  it('skips a mid-session repo DEEPER than repositoryScanMaxDepth (parity with the initial scan)', async () => {
    stubCli.setRoot('/work', undefined);
    const surface = gitService as unknown as NewRepoWatcherSurface;
    surface._repoScanFs = makeFsStub({ '/work': [] });

    await surface.discoverRepository('/work');
    const watcher = findNewRepoWatcher('/work');
    assert.ok(watcher);

    // Default maxDepth is 1; /work/notes/tmp/scratch sits at depth 3.
    stubCli.setRoot('/work/notes/tmp/scratch', '/work/notes/tmp/scratch');
    watcher._fireCreate(Uri.file('/work/notes/tmp/scratch/.git'));

    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    assert.strictEqual(
      gitService.getRepositories().length,
      0,
      'a repo beyond repositoryScanMaxDepth must not be auto-loaded mid-session'
    );
  });

  it('registers a deep mid-session repo when repositoryScanMaxDepth allows it', async () => {
    await workspace.getConfiguration('intellig').update('repositoryScanMaxDepth', 3);
    stubCli.setRoot('/work', undefined);
    const surface = gitService as unknown as NewRepoWatcherSurface;
    surface._repoScanFs = makeFsStub({ '/work': [] });

    await surface.discoverRepository('/work');
    const watcher = findNewRepoWatcher('/work');
    assert.ok(watcher);

    stubCli.setRoot('/work/notes/tmp/scratch', '/work/notes/tmp/scratch');
    watcher._fireCreate(Uri.file('/work/notes/tmp/scratch/.git'));

    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    const roots = gitService.getRepositories().map((r) => r.rootUri.fsPath);
    assert.deepStrictEqual(roots, ['/work/notes/tmp/scratch']);
  });

  it('treats repositoryScanMaxDepth -1 as unlimited, matching the scanner', async () => {
    await workspace.getConfiguration('intellig').update('repositoryScanMaxDepth', -1);
    stubCli.setRoot('/work', undefined);
    const surface = gitService as unknown as NewRepoWatcherSurface;
    surface._repoScanFs = makeFsStub({ '/work': [] });

    await surface.discoverRepository('/work');
    const watcher = findNewRepoWatcher('/work');
    assert.ok(watcher);

    stubCli.setRoot('/work/a/b/c/d', '/work/a/b/c/d');
    watcher._fireCreate(Uri.file('/work/a/b/c/d/.git'));

    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    const roots = gitService.getRepositories().map((r) => r.rootUri.fsPath);
    assert.deepStrictEqual(roots, ['/work/a/b/c/d']);
  });

  // ============================================
  // Deletion pruning: the per-repo `.git/HEAD` watcher handles
  // `rm -rf .git` inside a live repo, but deleting the whole repo
  // DIRECTORY does not reliably surface a HEAD delete event — the repo
  // then lingers in the picker until window reload. The `**/.git`
  // workspace watcher sees the `.git` deletion itself; verify the path
  // is really gone (transient delete+recreate happens under rename-based
  // updates) and route through the shared removeRepositoryWatcher
  // teardown, which fires onDidRemoveRepository.
  // ============================================
  function makeDeletableFs(deletedPaths: Set<string>): IRepoScanFs {
    return {
      async readdir(): Promise<never[]> {
        return [];
      },
      async realpath(p: string): Promise<string> {
        if (deletedPaths.has(p)) {
          throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
        }
        return p;
      },
    };
  }

  it('evicts a registered repo when its .git is deleted (repo dir removed on disk)', async () => {
    stubCli.setRoot('/work', undefined);
    const surface = gitService as unknown as NewRepoWatcherSurface;
    const deleted = new Set<string>();
    surface._repoScanFs = makeDeletableFs(deleted);

    await surface.discoverRepository('/work');
    const watcher = findNewRepoWatcher('/work');
    assert.ok(watcher);

    stubCli.setRoot('/work/newproj', '/work/newproj');
    watcher._fireCreate(Uri.file('/work/newproj/.git'));
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
    assert.strictEqual(gitService.getRepositories().length, 1, 'precondition: repo registered');

    const fired: string[] = [];
    const sub = gitService.onDidRemoveRepository((repo) => {
      fired.push(repo.rootUri.fsPath);
    });
    try {
      deleted.add('/work/newproj/.git');
      watcher._fireDelete(Uri.file('/work/newproj/.git'));
      await flushMicrotasks();
      await flushMicrotasks();
      await flushMicrotasks();
    } finally {
      sub.dispose();
    }

    assert.strictEqual(gitService.getRepositories().length, 0, 'deleted repo must be evicted');
    assert.deepStrictEqual(fired, ['/work/newproj'], 'onDidRemoveRepository fires for the root');
  });

  it('does NOT evict on a transient .git delete event when the path still exists', async () => {
    stubCli.setRoot('/work', undefined);
    const surface = gitService as unknown as NewRepoWatcherSurface;
    surface._repoScanFs = makeDeletableFs(new Set());

    await surface.discoverRepository('/work');
    const watcher = findNewRepoWatcher('/work');
    assert.ok(watcher);

    stubCli.setRoot('/work/newproj', '/work/newproj');
    watcher._fireCreate(Uri.file('/work/newproj/.git'));
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
    assert.strictEqual(gitService.getRepositories().length, 1, 'precondition: repo registered');

    // FSEvents can surface a rename-based update as delete+create; the
    // realpath probe above still resolves, so the repo must survive.
    watcher._fireDelete(Uri.file('/work/newproj/.git'));
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    assert.strictEqual(
      gitService.getRepositories().length,
      1,
      'a transient delete event must not drop a live repo'
    );
  });

  it('ignores a .git delete event for a path that was never registered', async () => {
    stubCli.setRoot('/work', undefined);
    const surface = gitService as unknown as NewRepoWatcherSurface;
    surface._repoScanFs = makeDeletableFs(new Set(['/work/ghost/.git']));

    await surface.discoverRepository('/work');
    const watcher = findNewRepoWatcher('/work');
    assert.ok(watcher);

    const fired: string[] = [];
    const sub = gitService.onDidRemoveRepository((repo) => {
      fired.push(repo.rootUri.fsPath);
    });
    try {
      watcher._fireDelete(Uri.file('/work/ghost/.git'));
      await flushMicrotasks();
      await flushMicrotasks();
    } finally {
      sub.dispose();
    }

    assert.deepStrictEqual(fired, [], 'no removal event for an unknown root');
  });

  // ============================================
  // Senior addendum — MEDIUM:
  //   Path-prefix string match in ignored-folder filter.
  //
  //   A `repoParentDir.startsWith(folderPath)` STRING prefix check (not a
  //   PATH prefix check) is wrong: if folderPath='/work' and
  //   repoParentDir='/workspace/foo', startsWith returns true and the
  //   relative slice becomes 'space/foo' — meaning a `git init` inside
  //   `/workspace/foo` (a sibling directory that just happens to share
  //   '/work' as a prefix) gets misinterpreted as inside the watched
  //   /work folder.
  //
  //   Post-fix: use `path.relative(folderPath, repoParentDir)` and bail
  //   if the result starts with `..` (indicating the path is outside
  //   the watched folder).
  // ============================================
  it('does not load a repo whose path string-prefix-matches but is NOT inside the watched folder (senior MEDIUM)', async () => {
    stubCli.setRoot('/work', undefined);
    const surface = gitService as unknown as NewRepoWatcherSurface;
    surface._repoScanFs = makeFsStub({ '/work': [] });

    await surface.discoverRepository('/work');

    const watcher = findNewRepoWatcher('/work');
    assert.ok(watcher, 'watcher must be installed for /work');

    // `/workspace` is a sibling directory of `/work`, NOT a child.
    // With a string prefix check, `'/workspace/foo'.startsWith('/work')`
    // returns true so the watcher handler would think `/workspace/foo` is
    // inside `/work` and try to load it as a repo.
    //
    // Post-fix: `path.relative('/work', '/workspace/foo')` returns
    // `'../workspace/foo'` (POSIX) — the leading `..` signals "outside
    // the watched folder" and the handler bails.
    stubCli.setRoot('/workspace/foo', '/workspace/foo');
    watcher._fireCreate(Uri.file('/workspace/foo/.git'));

    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    assert.strictEqual(
      gitService.getRepositories().length,
      0,
      '/workspace/foo is OUTSIDE /work; the watcher must not auto-load it as a repo'
    );
  });
});

// ============================================
// Senior addendum — NEW HIGH:
//   Lifecycle leak on workspace-folder removal.
//
//   When the user removes `~/work` from the workspace mid-session and
//   the workspace contained NESTED repos (e.g. `~/work/projectA` +
//   `~/work/projectB` were registered as separate repos because the
//   folder root itself wasn't a git repo), `removeRepositoryWatcher`
//   only looks up the EXACT folder path — so the nested-repo entries
//   in `_fileWatchers` and `_repositories` leak.
//
//   Worst case: orphan watchers spawn `git status` against a now-
//   inaccessible path (USB unmount, network share gone). Each refresh
//   tick spawns a failing subprocess.
//
//   Post-fix: enumerate `_fileWatchers` and `_repositories` entries
//   whose key equals `folderPath` OR is a path-child of `folderPath`,
//   and dispose/delete each.
// ============================================
describe('GitService — workspace-folder removal lifecycle (Wave 10 R2 senior HIGH)', () => {
  let gitService: GitService;
  let stubCli: StubGitCli;

  beforeEach(() => {
    stubCli = new StubGitCli();
    gitService = new GitService();
    const surface = gitService as unknown as NewRepoWatcherSurface;
    surface._gitCli = stubCli;
  });

  afterEach(() => {
    workspace.workspaceFolders = undefined as unknown[] | undefined;
    gitService.dispose();
  });

  it('disposes nested-repo watchers AND removes nested-repo cache entries when the parent workspace folder is removed', () => {
    // Set up: /work has 2 nested repos (no .git/ at /work itself).
    const surface = gitService as unknown as NewRepoWatcherSurface & {
      _fileWatchers: Map<string, { dispose: () => void }[]>;
      _repositories: Map<string, unknown>;
      removeRepositoryWatcher: (folderPath: string) => void;
    };

    // Pre-populate as if discoverRepository had already discovered /work/a + /work/b.
    surface.setupRepositoryWatcher('/work/projectA');
    surface.setupRepositoryWatcher('/work/projectB');
    surface._repositories.set('/work/projectA', {
      repository: { rootUri: Uri.file('/work/projectA') },
      lastUpdated: Date.now(),
    });
    surface._repositories.set('/work/projectB', {
      repository: { rootUri: Uri.file('/work/projectB') },
      lastUpdated: Date.now(),
    });

    // Sanity precondition: both nested repos are tracked.
    assert.ok(
      surface._fileWatchers.has('/work/projectA'),
      'precondition: projectA watcher tracked'
    );
    assert.ok(
      surface._fileWatchers.has('/work/projectB'),
      'precondition: projectB watcher tracked'
    );
    assert.strictEqual(gitService.getRepositories().length, 2, 'precondition: 2 repos tracked');

    // User removes /work from the workspace.
    surface.removeRepositoryWatcher('/work');

    // Both nested watchers must be disposed (entries removed from the map).
    assert.ok(
      !surface._fileWatchers.has('/work/projectA'),
      '/work/projectA watcher must be disposed when /work workspace folder is removed'
    );
    assert.ok(
      !surface._fileWatchers.has('/work/projectB'),
      '/work/projectB watcher must be disposed when /work workspace folder is removed'
    );

    // Both nested repo entries must be removed from `_repositories`.
    assert.strictEqual(
      gitService.getRepositories().length,
      0,
      'no orphan repos must remain in _repositories after workspace-folder removal'
    );
  });

  it('does NOT dispose unrelated repos at sibling paths sharing a string prefix (path.sep boundary)', () => {
    const surface = gitService as unknown as NewRepoWatcherSurface & {
      _fileWatchers: Map<string, { dispose: () => void }[]>;
      _repositories: Map<string, unknown>;
      removeRepositoryWatcher: (folderPath: string) => void;
    };

    // Set up: /work/projectA AND /workspace/other (sibling that shares '/work' string prefix).
    surface.setupRepositoryWatcher('/work/projectA');
    surface.setupRepositoryWatcher('/workspace/other');
    surface._repositories.set('/work/projectA', {
      repository: { rootUri: Uri.file('/work/projectA') },
      lastUpdated: Date.now(),
    });
    surface._repositories.set('/workspace/other', {
      repository: { rootUri: Uri.file('/workspace/other') },
      lastUpdated: Date.now(),
    });

    // Removing /work must NOT touch /workspace/other (path-child boundary,
    // not string-prefix boundary).
    surface.removeRepositoryWatcher('/work');

    assert.ok(
      !surface._fileWatchers.has('/work/projectA'),
      '/work/projectA must be disposed (path-child of /work)'
    );
    assert.ok(
      surface._fileWatchers.has('/workspace/other'),
      '/workspace/other must be PRESERVED (sibling that shares only string prefix /work, not path prefix)'
    );
    const remaining = gitService.getRepositories().map((r) => r.rootUri.fsPath);
    assert.deepStrictEqual(
      remaining,
      ['/workspace/other'],
      '/workspace/other must remain in _repositories'
    );
  });
});
