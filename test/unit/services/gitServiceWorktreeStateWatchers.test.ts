/**
 * Each linked worktree's folder under `<common dir>/worktrees` gets a
 * watcher of its own for the files the Worktrees list shows.
 *
 * The recursive `worktrees/*\/locked` glob relies on the platform watcher
 * adding a watch for each new folder. On Linux a folder created together with
 * its parent, as the first `git worktree add` does, can be missed, and a later
 * `git worktree lock` in it then never reports. A watcher rooted at the folder
 * itself does not depend on that.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import { GitService } from '../../../src/git-core/GitService';
import { Uri, getCreatedFileSystemWatchers, RelativePattern } from '../../mocks/vscode';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

interface WatcherTestSurface {
  setupRepositoryWatcher: (root: string) => void;
  _refreshTimers: Map<string, NodeJS.Timeout>;
}

describe('GitService — per-worktree state watchers', () => {
  let root: string;
  let gitService: GitService;
  let surface: WatcherTestSurface;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'worktree-state-watch-'));
    fs.mkdirSync(path.join(root, '.git'));
    gitService = new GitService();
    surface = gitService as unknown as WatcherTestSurface;
  });

  afterEach(() => {
    gitService.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const worktreeDir = (name: string): string => path.join(root, '.git', 'worktrees', name);

  /** Active watchers rooted at a worktree's own folder. */
  function worktreeWatchers(name: string): ReturnType<typeof getCreatedFileSystemWatchers> {
    const base = Uri.file(worktreeDir(name)).fsPath;
    return getCreatedFileSystemWatchers().filter(
      (w) => w._pattern instanceof RelativePattern && w._pattern.base === base
    );
  }

  function headWatcher(): ReturnType<typeof getCreatedFileSystemWatchers>[number] {
    const base = Uri.file(path.join(root, '.git')).fsPath;
    const found = getCreatedFileSystemWatchers().find(
      (w) =>
        w._pattern instanceof RelativePattern &&
        w._pattern.base === base &&
        w._pattern.pattern === 'HEAD'
    );
    assert.ok(found, 'a HEAD watcher');
    return found;
  }

  it("watches each existing worktree's folder for its lock and gitdir files, without recursing", () => {
    fs.mkdirSync(worktreeDir('wt-a'), { recursive: true });

    surface.setupRepositoryWatcher(root);

    const watchers = worktreeWatchers('wt-a');
    assert.strictEqual(watchers.length, 1);
    assert.strictEqual((watchers[0]._pattern as RelativePattern).pattern, '{locked,gitdir}');
  });

  it('starts watching a worktree added after setup on the next .git event', () => {
    surface.setupRepositoryWatcher(root);
    assert.strictEqual(worktreeWatchers('wt-b').length, 0);

    fs.mkdirSync(worktreeDir('wt-b'), { recursive: true });
    headWatcher()._fireChange(Uri.file(path.join(root, '.git', 'HEAD')));

    assert.strictEqual(worktreeWatchers('wt-b').length, 1);
  });

  it('a lock written in a worktree folder schedules a repository refresh', () => {
    fs.mkdirSync(worktreeDir('wt-a'), { recursive: true });
    surface.setupRepositoryWatcher(root);
    assert.ok(!surface._refreshTimers.has(root));

    worktreeWatchers('wt-a')[0]._fireCreate(Uri.file(path.join(worktreeDir('wt-a'), 'locked')));

    assert.ok(surface._refreshTimers.has(root), 'the lock schedules a refresh');
  });

  it('stops watching a removed worktree, and stops them all on dispose', () => {
    fs.mkdirSync(worktreeDir('wt-a'), { recursive: true });
    fs.mkdirSync(worktreeDir('wt-b'), { recursive: true });
    surface.setupRepositoryWatcher(root);

    fs.rmSync(worktreeDir('wt-a'), { recursive: true });
    headWatcher()._fireChange(Uri.file(path.join(root, '.git', 'HEAD')));
    assert.strictEqual(worktreeWatchers('wt-a').length, 0);
    assert.strictEqual(worktreeWatchers('wt-b').length, 1);

    gitService.dispose();
    assert.strictEqual(worktreeWatchers('wt-b').length, 0);
  });
});
