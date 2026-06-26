/**
 * Tests for mid-session repository deletion.
 *
 * Without deletion detection, running `rm -rf .git` inside a discovered repo
 * leaves orphan watchers + a stale `_repositories` entry until window reload.
 * Subsequent commands against the (now-non-)repo either fail with
 * confusing "fatal: not a git repository" toasts or, worse, the
 * `.git/HEAD` watcher re-triggers reloads that all-fail-silently.
 * The repo also stays visible in tool-window pickers despite no longer
 * existing.
 *
 * Extend the per-repo watcher to detect deletion of `.git/HEAD`
 * (which is the strongest "this repo was destroyed" signal — a repo
 * cannot exist without HEAD), and route that to the new
 * `removeRepositoryWatcher(rootPath)` cleanup PLUS a new public
 * `onDidRemoveRepository` event so subscribers (BranchTreeProvider,
 * StatusBarService, BranchPopup, ChangelistService, etc.) can drop the
 * repo from their UI without polling.
 *
 * Each spec was authored RED-first and confirmed failing before the
 * deletion-detection wiring was added.
 */

import '../../setup';
import * as assert from 'assert';
import { okAsync, ResultAsync } from 'neverthrow';
import { GitService } from '../../../src/git-core/GitService';
import { GitError } from '../../../src/git-core/errors';
import * as vscodeMock from '../../mocks/vscode';
import { IRepoScanFs } from '../../../src/git-core/repoScan';

const { Uri, getCreatedFileSystemWatchers, RelativePattern, fireWorkspaceFoldersChange } =
  vscodeMock;

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

interface DeletionSurface {
  _gitCli: StubGitCli;
  loadRepository: (root: string) => Promise<unknown>;
  discoverRepository: (path: string) => Promise<void>;
  setupNewRepoWatcher: (folderPath: string) => void;
  _repoScanFs: IRepoScanFs;
  _fileWatchers: Map<string, unknown[]>;
  _repositories: Map<string, unknown>;
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

interface IFireableWatcher {
  _pattern: string | { base: string; pattern: string };
  _fireDelete: (uri: import('../../mocks/vscode').Uri) => void;
}

/**
 * Find the HEAD-pattern watcher that `setupRepositoryWatcher(rootPath)`
 * installs against `<rootPath>/.git`. The watcher is registered with a
 * RelativePattern whose `base` ends in `.git` and whose `pattern` is
 * exactly `HEAD`.
 */
function findHeadWatcher(rootPath: string): IFireableWatcher {
  const watchers = getCreatedFileSystemWatchers();
  const expectedBase = `${rootPath}/.git`;
  const match = watchers.find((w) => {
    const pat = w._pattern;
    if (pat instanceof RelativePattern) {
      return pat.pattern === 'HEAD' && pat.base === expectedBase;
    }
    return false;
  });
  if (!match) {
    throw new Error(
      `findHeadWatcher: no HEAD watcher under ${expectedBase}; ` +
        `available patterns: ${watchers
          .map((w) =>
            w._pattern instanceof RelativePattern
              ? `${w._pattern.base}/${w._pattern.pattern}`
              : 'string'
          )
          .join(', ')}`
    );
  }
  return match as IFireableWatcher;
}

describe('GitService — mid-session repo deletion (TL-88 / #213)', () => {
  let gitService: GitService;
  let stubCli: StubGitCli;

  beforeEach(() => {
    stubCli = new StubGitCli();
    gitService = new GitService();

    const surface = gitService as unknown as DeletionSurface;
    surface._gitCli = stubCli;
    // Stub loadRepository so discovery registers a fake repo without real git
    // subprocesses. It must fulfill the real `loadRepository` contract that the
    // first-insertion funnel relies on: register the repo AND install its
    // per-repo `.git/` watcher (the real `setupRepositoryWatcher`, which these
    // tests probe via `findHeadWatcher`).
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      (gitService as any).setupRepositoryWatcher(root);
      return fakeRepo;
    };
    // Avoid spawning the new-repo watcher in the test fixture — only the
    // per-repo watcher matters here.
    surface.setupNewRepoWatcher = (_folderPath: string): void => {
      /* no-op */
    };
  });

  afterEach(() => {
    gitService.dispose();
  });

  it('exposes onDidRemoveRepository as a public event on IGitService', () => {
    // Type-level pin: subscribers (BranchTreeProvider, etc.) need a stable
    // event surface. A regression that drops the field would break the
    // dependency chain at compile time.
    const sub = gitService.onDidRemoveRepository(() => {
      /* no-op */
    });
    assert.ok(typeof sub.dispose === 'function', 'onDidRemoveRepository must return a Disposable');
    sub.dispose();
  });

  it('fires onDidRemoveRepository exactly once when .git/HEAD is deleted', async () => {
    stubCli.setRoot('/repo', '/repo');
    const surface = gitService as unknown as DeletionSurface;
    surface._repoScanFs = {
      async readdir() {
        return [];
      },
      async realpath(p: string): Promise<string> {
        return p;
      },
    };

    await surface.discoverRepository('/repo');
    assert.strictEqual(gitService.getRepositories().length, 1, 'precondition: repo discovered');

    const fired: string[] = [];
    const sub = gitService.onDidRemoveRepository((repo) => {
      fired.push(repo.rootUri.fsPath);
    });
    try {
      const headWatcher = findHeadWatcher('/repo');
      headWatcher._fireDelete(Uri.file('/repo/.git/HEAD'));
      await flushMicrotasks();
    } finally {
      sub.dispose();
    }

    assert.deepStrictEqual(
      fired,
      ['/repo'],
      'onDidRemoveRepository must fire exactly once when .git/HEAD is deleted'
    );
  });

  it('removes the repository from getRepositories() when .git/HEAD is deleted', async () => {
    stubCli.setRoot('/repo', '/repo');
    const surface = gitService as unknown as DeletionSurface;
    surface._repoScanFs = {
      async readdir() {
        return [];
      },
      async realpath(p: string): Promise<string> {
        return p;
      },
    };

    await surface.discoverRepository('/repo');
    assert.strictEqual(gitService.getRepositories().length, 1);

    findHeadWatcher('/repo')._fireDelete(Uri.file('/repo/.git/HEAD'));
    await flushMicrotasks();

    assert.deepStrictEqual(
      gitService.getRepositories().map((r) => r.rootUri.fsPath),
      [],
      'getRepositories() must be empty after .git deletion'
    );
  });

  it('disposes per-repo watchers when .git/HEAD is deleted (no orphan watchers)', async () => {
    stubCli.setRoot('/repo', '/repo');
    const surface = gitService as unknown as DeletionSurface;
    surface._repoScanFs = {
      async readdir() {
        return [];
      },
      async realpath(p: string): Promise<string> {
        return p;
      },
    };

    await surface.discoverRepository('/repo');
    assert.ok(surface._fileWatchers.has('/repo'), 'precondition: watcher map has entry');

    findHeadWatcher('/repo')._fireDelete(Uri.file('/repo/.git/HEAD'));
    await flushMicrotasks();

    assert.ok(
      !surface._fileWatchers.has('/repo'),
      '_fileWatchers entry for /repo must be removed (no orphan watchers)'
    );
  });

  it('does NOT fire onDidRemoveRepository for unrelated .git/HEAD changes (only deletions)', async () => {
    // Sanity check: a HEAD *change* (e.g. branch checkout) goes through the
    // normal debounced refresh path, not the deletion path. The remove
    // event must not fire on a pure change event.
    stubCli.setRoot('/repo', '/repo');
    const surface = gitService as unknown as DeletionSurface;
    surface._repoScanFs = {
      async readdir() {
        return [];
      },
      async realpath(p: string): Promise<string> {
        return p;
      },
    };

    await surface.discoverRepository('/repo');

    const fired: string[] = [];
    const sub = gitService.onDidRemoveRepository((repo) => {
      fired.push(repo.rootUri.fsPath);
    });
    try {
      // Simulate `git checkout other-branch` — fires onDidChange, not onDidDelete.
      const headWatcher = findHeadWatcher('/repo') as IFireableWatcher & {
        _fireChange: (uri: import('../../mocks/vscode').Uri) => void;
      };
      headWatcher._fireChange(Uri.file('/repo/.git/HEAD'));
      await flushMicrotasks();
    } finally {
      sub.dispose();
    }

    assert.deepStrictEqual(
      fired,
      [],
      'onDidRemoveRepository must NOT fire for a HEAD change event (only for delete)'
    );
  });

  it('does NOT evict the repo on a TRANSIENT HEAD delete (atomic rename: HEAD still present)', async () => {
    // Repro for the multi-repo vanishing bug: git updates a ref by renaming
    // HEAD.lock over HEAD, which some watchers report as delete+create. The
    // repo's `.git/HEAD` still exists, so the delete is transient and the repo
    // must stay in the Map — otherwise an unrelated tool's git op silently
    // drops live repos from the tool window until a window reload.
    stubCli.setRoot('/repo', '/repo');
    const surface = gitService as unknown as DeletionSurface;
    surface._repoScanFs = {
      async readdir(p: string) {
        // The HEAD-deletion guard reads `.git`; report HEAD as still present.
        if (p.endsWith('/.git')) {
          return [
            {
              name: 'HEAD',
              isDirectory: () => false,
              isSymbolicLink: () => false,
              isFile: () => true,
            },
          ];
        }
        return [];
      },
      async realpath(p: string): Promise<string> {
        return p;
      },
    };

    await surface.discoverRepository('/repo');
    assert.strictEqual(gitService.getRepositories().length, 1, 'precondition: repo discovered');

    const fired: string[] = [];
    const sub = gitService.onDidRemoveRepository((repo) => {
      fired.push(repo.rootUri.fsPath);
    });
    try {
      findHeadWatcher('/repo')._fireDelete(Uri.file('/repo/.git/HEAD'));
      await flushMicrotasks();
    } finally {
      sub.dispose();
    }

    assert.deepStrictEqual(
      fired,
      [],
      'a transient HEAD delete must not fire onDidRemoveRepository'
    );
    assert.deepStrictEqual(
      gitService.getRepositories().map((r) => r.rootUri.fsPath),
      ['/repo'],
      'the repo must remain in getRepositories() when .git/HEAD still exists'
    );
  });

  it('does NOT fire onDidRemoveRepository for already-removed repos (idempotent)', async () => {
    // If the user runs `rm -rf .git` and then the user runs it again somehow
    // (filesystem races), the second deletion event must not double-fire the
    // remove event for a repo that's already been cleaned up.
    stubCli.setRoot('/repo', '/repo');
    const surface = gitService as unknown as DeletionSurface;
    surface._repoScanFs = {
      async readdir() {
        return [];
      },
      async realpath(p: string): Promise<string> {
        return p;
      },
    };

    await surface.discoverRepository('/repo');

    const fired: string[] = [];
    const sub = gitService.onDidRemoveRepository((repo) => {
      fired.push(repo.rootUri.fsPath);
    });
    try {
      const headWatcher = findHeadWatcher('/repo');
      headWatcher._fireDelete(Uri.file('/repo/.git/HEAD'));
      await flushMicrotasks();
      // Second event — repo is already gone.
      headWatcher._fireDelete(Uri.file('/repo/.git/HEAD'));
      await flushMicrotasks();
    } finally {
      sub.dispose();
    }

    assert.deepStrictEqual(
      fired,
      ['/repo'],
      'onDidRemoveRepository must fire exactly once even if the deletion event arrives twice'
    );
  });

  // ============================================
  // JSDoc on `onDidRemoveRepository` promises the
  // event fires "either because the user removed its workspace folder, OR
  // because the repo's `.git/HEAD` was deleted." Earlier only the latter
  // path fired the emitter — the workspace-folder listener at line ~263
  // called `removeRepositoryWatcher(folderPath)` directly without
  // touching the emitter. Six future subscribers (BranchTreeProvider,
  // StatusBarService, BranchPopup, ChangelistService,
  // ConflictResolutionService, GitToolWindowProvider) would silently
  // fail on the COMMON path (drag a folder out of the workspace) and
  // only work on the EXOTIC `.git/HEAD`-deletion path.
  //
  // These specs pin the contract on the workspace-folder-removal path.
  // ============================================

  it('fires onDidRemoveRepository when a workspace folder containing the repo is removed (R1/C1)', async () => {
    stubCli.setRoot('/work/projectA', '/work/projectA');
    const surface = gitService as unknown as DeletionSurface;
    surface._repoScanFs = {
      async readdir() {
        return [];
      },
      async realpath(p: string): Promise<string> {
        return p;
      },
    };

    await surface.discoverRepository('/work/projectA');
    assert.strictEqual(gitService.getRepositories().length, 1, 'precondition: repo discovered');

    const fired: string[] = [];
    const sub = gitService.onDidRemoveRepository((repo) => {
      fired.push(repo.rootUri.fsPath);
    });
    try {
      // Synthesize the production listener firing — vscode delivers this
      // event when the user drags a folder out of the workspace.
      fireWorkspaceFoldersChange({
        removed: [{ uri: Uri.file('/work/projectA'), name: 'projectA', index: 0 }],
      });
      await flushMicrotasks();
    } finally {
      sub.dispose();
    }

    assert.deepStrictEqual(
      fired,
      ['/work/projectA'],
      'onDidRemoveRepository must fire exactly once when the containing workspace folder is removed (the JSDoc-promised common path)'
    );
  });

  it('fires onDidRemoveRepository for EVERY nested repo when the parent workspace folder is removed (R1/C1)', async () => {
    // Nested-repo discovery: opening `~/work/` registers
    // `~/work/projectA` AND `~/work/projectB` as separate repos. When
    // the user removes `~/work` from the workspace, BOTH must fire the
    // remove event so subscribers drop both repos.
    stubCli.setRoot('/work', undefined);
    stubCli.setRoot('/work/projectA', '/work/projectA');
    stubCli.setRoot('/work/projectB', '/work/projectB');
    const surface = gitService as unknown as DeletionSurface;
    surface._repoScanFs = {
      async readdir(p: string) {
        if (p === '/work') {
          return [
            {
              name: 'projectA',
              isDirectory: () => true,
              isSymbolicLink: () => false,
              isFile: () => false,
            },
            {
              name: 'projectB',
              isDirectory: () => true,
              isSymbolicLink: () => false,
              isFile: () => false,
            },
          ];
        }
        return [];
      },
      async realpath(p: string): Promise<string> {
        return p;
      },
    };

    await surface.discoverRepository('/work');
    assert.strictEqual(
      gitService.getRepositories().length,
      2,
      'precondition: both nested repos discovered'
    );

    const fired: string[] = [];
    const sub = gitService.onDidRemoveRepository((repo) => {
      fired.push(repo.rootUri.fsPath);
    });
    try {
      fireWorkspaceFoldersChange({
        removed: [{ uri: Uri.file('/work'), name: 'work', index: 0 }],
      });
      await flushMicrotasks();
    } finally {
      sub.dispose();
    }

    assert.deepStrictEqual(
      fired.sort(),
      ['/work/projectA', '/work/projectB'],
      'onDidRemoveRepository must fire once for EACH nested repo when the parent folder is removed'
    );
  });

  it('does NOT fire onDidRemoveRepository for sibling-prefix paths (e.g. /workspace vs /work) (R1/C1)', async () => {
    // Defensive: removing `/work` must NOT trigger the remove event for
    // `/workspace/other` — the path-child rule (already enforced by
    // `removeRepositoryWatcher`'s `isInsideOrEqual` helper) extends to
    // the new emitter path.
    stubCli.setRoot('/work', '/work');
    stubCli.setRoot('/workspace/other', '/workspace/other');
    const surface = gitService as unknown as DeletionSurface;
    surface._repoScanFs = {
      async readdir() {
        return [];
      },
      async realpath(p: string): Promise<string> {
        return p;
      },
    };

    await surface.discoverRepository('/work');
    await surface.discoverRepository('/workspace/other');
    assert.strictEqual(
      gitService.getRepositories().length,
      2,
      'precondition: both repos discovered'
    );

    const fired: string[] = [];
    const sub = gitService.onDidRemoveRepository((repo) => {
      fired.push(repo.rootUri.fsPath);
    });
    try {
      fireWorkspaceFoldersChange({
        removed: [{ uri: Uri.file('/work'), name: 'work', index: 0 }],
      });
      await flushMicrotasks();
    } finally {
      sub.dispose();
    }

    assert.deepStrictEqual(
      fired,
      ['/work'],
      'onDidRemoveRepository must NOT fire for /workspace/other when /work is removed (sibling string prefix, not a path child)'
    );
  });
});
