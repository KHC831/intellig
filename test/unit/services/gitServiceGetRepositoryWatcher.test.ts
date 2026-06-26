/**
 * Regression: a repository first reached through `GitService.getRepository()`
 * (the lazy blame/line-status/merge-view path) must become a FIRST-CLASS repo —
 * it must install a `.git/` file watcher AND fire `onDidChangeRepository`,
 * exactly as the workspace-scan `discoverRepository` path does.
 *
 * The bug: `getRepository`'s rev-parse fallback loaded + cached the repo but
 * stopped there — no watcher (so it never live-refreshed on commit/checkout)
 * and no `onDidChangeRepository` (so the SCM provider, branch tree, status bar,
 * etc. never learned it existed). Only `discoverRepository` announced + watched.
 *
 * Fix: both discovery paths funnel through `loadRepository`, which installs the
 * watcher + fires the change event the first time a root is inserted into
 * `_repositories`, so the two paths can't diverge.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { okAsync, errAsync, ResultAsync } from 'neverthrow';
import { GitService } from '../../../src/git-core/GitService';
import { GitError, SpawnFailedError } from '../../../src/git-core/errors';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

class StubGitCli {
  async exec(): Promise<{ exitCode: number; stdout: string; stderr: string; combined: string }> {
    return { exitCode: 0, stdout: '', stderr: '', combined: '' };
  }

  getRepositoryRoot(p: string): ResultAsync<string | undefined, GitError> {
    let dir = p;
    try {
      if (!fs.statSync(p).isDirectory()) {
        return errAsync(new SpawnFailedError('spawn ENOTDIR'));
      }
    } catch {
      return errAsync(new SpawnFailedError('spawn ENOENT'));
    }
    while (dir !== path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, '.git'))) {
        return okAsync(fs.realpathSync.native(dir));
      }
      dir = path.dirname(dir);
    }
    return okAsync(undefined);
  }

  dispose(): void {}
}

describe('GitService.getRepository announces + watches a lazily-discovered repo', () => {
  let gitService: GitService;
  let tmpRoot: string;

  beforeEach(() => {
    gitService = new GitService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._gitCli = new StubGitCli();
    tmpRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-lazywatch-')));
    fs.mkdirSync(path.join(tmpRoot, '.git'));
    fs.mkdirSync(path.join(tmpRoot, 'src'));
    fs.writeFileSync(path.join(tmpRoot, 'src', 'foo.ts'), 'x', 'utf8');
  });

  afterEach(() => {
    gitService.dispose();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function watcherMap(): Map<string, unknown> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    return (gitService as any)._fileWatchers as Map<string, unknown>;
  }

  function hasWatcher(rootPath: string): boolean {
    return watcherMap().has(rootPath);
  }

  it('fires onDidChangeRepository the first time a repo is reached via getRepository', async () => {
    const announced: IRepository[] = [];
    gitService.onDidChangeRepository((r) => announced.push(r));

    const repo = await gitService.getRepository(Uri.file(tmpRoot));

    assert.ok(repo, 'repo should be discovered');
    assert.strictEqual(
      announced.length,
      1,
      'onDidChangeRepository must fire once on first discovery'
    );
    assert.strictEqual(announced[0]?.rootUri.fsPath, tmpRoot, 'announces the discovered repo');
  });

  it('installs a .git/ file watcher for a lazily-discovered repo', async () => {
    await gitService.getRepository(Uri.file(tmpRoot));
    assert.ok(hasWatcher(tmpRoot), 'a lazily-discovered repo must get a file watcher');
  });

  it('does not re-announce or re-watch on a subsequent getRepository for the same repo', async () => {
    const announced: IRepository[] = [];
    gitService.onDidChangeRepository((r) => announced.push(r));

    await gitService.getRepository(Uri.file(tmpRoot));
    // Second resolve via a file inside the same repo (cached, ancestor match).
    await gitService.getRepository(Uri.file(path.join(tmpRoot, 'src', 'foo.ts')));

    assert.strictEqual(
      announced.length,
      1,
      'first discovery announces exactly once; cache hits do not re-fire'
    );
    assert.ok(hasWatcher(tmpRoot), 'watcher stays installed');
  });

  it('a reload fires onDidChangeRepository exactly once and does NOT re-install the watcher', async () => {
    // Pins both halves of the no-double-fire invariant: a reload deletes the
    // cache entry but keeps the watcher, so `loadRepository`'s first-insertion
    // funnel must SUPPRESS its own fire (watcher still present) and the reload
    // path owns the single fire. A regression that drops the watcher on
    // invalidate, or removes the `_fileWatchers.has` guard, would double-fire
    // here — the duplicate-refresh-storm class this codebase has fought.
    const repo = await gitService.getRepository(Uri.file(tmpRoot));
    assert.ok(repo, 'repo should be discovered');

    const announced: IRepository[] = [];
    gitService.onDidChangeRepository((r) => announced.push(r));
    const watcherBefore = watcherMap().get(tmpRoot);

    await gitService.reloadRepository(repo);

    assert.strictEqual(
      announced.length,
      1,
      'a reload must fire onDidChangeRepository exactly once'
    );
    assert.strictEqual(watcherMap().size, 1, 'reload must not add a second watcher entry');
    assert.strictEqual(
      watcherMap().get(tmpRoot),
      watcherBefore,
      'reload must reuse the existing watcher, not re-install it'
    );
  });
});
