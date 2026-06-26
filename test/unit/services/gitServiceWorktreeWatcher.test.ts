/**
 * L-B3 regression — the file watchers must be rooted at the per-worktree
 * git directory.
 *
 * In a normal checkout `<root>/.git` is a directory and IS the git dir, so the
 * watchers glob it directly. In a LINKED WORKTREE (or submodule) `<root>/.git`
 * is a regular FILE holding a `gitdir: <path>` pointer; a `RelativePattern`
 * rooted at that file matches nothing, so the worktree never live-refreshes,
 * and `handleHeadDelete`'s `readdir(gitDir)` would throw on a file. The fix
 * roots the watchers at `resolveWorktreeGitDir(root)`, which follows the
 * pointer for a worktree and returns `<root>/.git` unchanged for a checkout.
 *
 * Uses REAL temp directories because `resolveWorktreeGitDir` reads the `.git`
 * file with the platform fs (no injection seam).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { GitService } from '../../../src/git-core/GitService';
import { Uri, getCreatedFileSystemWatchers, RelativePattern } from '../../mocks/vscode';

interface WatcherSetupSurface {
  setupRepositoryWatcher: (root: string) => void;
}

describe('GitService — worktree-aware watcher rooting (L-B3)', () => {
  let base: string;
  let gitService: GitService;
  let baselineWatcherCount: number;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-worktree-watch-'));
    gitService = new GitService();
    baselineWatcherCount = getCreatedFileSystemWatchers().length;
  });

  afterEach(() => {
    gitService.dispose();
    fs.rmSync(base, { recursive: true, force: true });
  });

  /** Distinct bases (RelativePattern roots) of the watchers this test created. */
  function freshWatcherBases(): string[] {
    const bases = getCreatedFileSystemWatchers()
      .slice(baselineWatcherCount)
      .map((w) => (w._pattern instanceof RelativePattern ? w._pattern.base : String(w._pattern)));
    return [...new Set(bases)];
  }

  it('roots watchers at <root>/.git for a normal checkout (.git is a directory)', () => {
    const root = path.join(base, 'normal');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });

    (gitService as unknown as WatcherSetupSurface).setupRepositoryWatcher(root);

    const expected = Uri.file(path.join(root, '.git')).fsPath;
    assert.deepStrictEqual(
      freshWatcherBases(),
      [expected],
      'normal checkout watchers must be rooted at <root>/.git'
    );
  });

  it('roots watchers at the resolved gitdir for a linked worktree (.git is a file)', () => {
    const root = path.join(base, 'worktree');
    fs.mkdirSync(root, { recursive: true });
    // The real per-worktree gitdir the pointer targets.
    const realGitDir = path.join(base, 'main', '.git', 'worktrees', 'worktree');
    fs.mkdirSync(realGitDir, { recursive: true });
    // `<root>/.git` is a FILE holding the gitdir pointer.
    fs.writeFileSync(path.join(root, '.git'), `gitdir: ${realGitDir}\n`);

    (gitService as unknown as WatcherSetupSurface).setupRepositoryWatcher(root);

    const bases = freshWatcherBases();
    const notWatched = Uri.file(path.join(root, '.git')).fsPath;
    assert.deepStrictEqual(
      bases,
      [Uri.file(realGitDir).fsPath],
      `worktree watchers must be rooted at the resolved gitdir, not the .git file (${notWatched}); got ${JSON.stringify(bases)}`
    );
  });
});
