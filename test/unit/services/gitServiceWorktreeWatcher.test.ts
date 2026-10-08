/**
 * Regression — the file watchers must be rooted at the per-worktree
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

describe('GitService — worktree-aware watcher rooting', () => {
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

  /**
   * Distinct bases (RelativePattern roots) of the `.git` watchers this test
   * created. Excludes the broad working-tree watcher (pattern `**`), which is
   * deliberately rooted at the repo root — its rooting is covered by
   * gitServiceWorkingTreeWatcher.test.ts. This regression is about the
   * `.git`-internals watchers following the worktree gitdir pointer.
   */
  function freshWatcherBases(): string[] {
    const bases = getCreatedFileSystemWatchers()
      .slice(baselineWatcherCount)
      .filter((w) => !(w._pattern instanceof RelativePattern && w._pattern.pattern === '**'))
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

  /** Each `.git` watcher's pattern mapped to the directory it is rooted at. */
  function freshWatcherRoots(): Map<string, string> {
    const roots = new Map<string, string>();
    for (const w of getCreatedFileSystemWatchers().slice(baselineWatcherCount)) {
      if (w._pattern instanceof RelativePattern && w._pattern.pattern !== '**') {
        roots.set(w._pattern.pattern, w._pattern.base);
      }
    }
    return roots;
  }

  it("roots a linked worktree's own files at its gitdir and the shared ones at the common dir", () => {
    const root = path.join(base, 'worktree');
    fs.mkdirSync(root, { recursive: true });
    const commonDir = path.join(base, 'main', '.git');
    // The real per-worktree gitdir the pointer targets, with git's `commondir`
    // file pointing back to the shared directory.
    const realGitDir = path.join(commonDir, 'worktrees', 'worktree');
    fs.mkdirSync(realGitDir, { recursive: true });
    fs.writeFileSync(path.join(realGitDir, 'commondir'), '../..\n');
    // `<root>/.git` is a FILE holding the gitdir pointer.
    fs.writeFileSync(path.join(root, '.git'), `gitdir: ${realGitDir}\n`);

    (gitService as unknown as WatcherSetupSurface).setupRepositoryWatcher(root);

    const roots = freshWatcherRoots();
    const own = Uri.file(realGitDir).fsPath;
    const shared = Uri.file(commonDir).fsPath;
    for (const pattern of ['HEAD', 'index', 'MERGE_HEAD', 'rebase-merge/**']) {
      assert.strictEqual(roots.get(pattern), own, `${pattern} is this worktree's own`);
    }
    for (const pattern of ['refs/**', 'packed-refs', 'config', 'logs/refs/stash']) {
      assert.strictEqual(roots.get(pattern), shared, `${pattern} is shared by every worktree`);
    }
    assert.ok(
      ![...roots.values()].includes(Uri.file(path.join(root, '.git')).fsPath),
      'nothing is rooted at the .git pointer file'
    );
  });
});
