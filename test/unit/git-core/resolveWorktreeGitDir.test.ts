/**
 * Unit tests for `resolveWorktreeGitDir` — the synchronous git-dir resolver
 * used to place changelist/shelf storage in the correct directory.
 *
 * Regression: changelist + shelf storage must resolve the git-dir rather than
 * hardcoding `<root>/.git`.
 * In a LINKED WORKTREE (and submodule) `<root>/.git` is a regular FILE holding
 * a `gitdir: <path>` pointer, so reads returned empty and WRITES THREW. The
 * resolver follows the pointer so each worktree gets an isolated, writable
 * store (per-worktree `--git-dir` semantics, not the shared `--git-common-dir`).
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resolveCommonGitDir,
  resolveWorktreeGitDir,
} from '../../../src/git-core/repo/RepositoryDiscovery';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

describe('resolveWorktreeGitDir', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gitdir-resolve-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns <root>/.git when .git is a real directory (normal checkout)', () => {
    const dotGit = path.join(tmpRoot, '.git');
    fs.mkdirSync(dotGit);

    assert.strictEqual(resolveWorktreeGitDir(tmpRoot), dotGit);
  });

  it('follows the gitdir pointer when .git is a FILE with an absolute pointer (linked worktree)', () => {
    const worktreeGitDir = path.join(tmpRoot, 'main', '.git', 'worktrees', 'wt-1');
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    const dotGitFile = path.join(tmpRoot, '.git');
    fs.writeFileSync(dotGitFile, `gitdir: ${worktreeGitDir}\n`, 'utf8');

    assert.strictEqual(resolveWorktreeGitDir(tmpRoot), worktreeGitDir);
  });

  it('resolves a relative gitdir pointer against the worktree root', () => {
    const worktreeGitDir = path.join(tmpRoot, 'common', '.git', 'worktrees', 'wt-2');
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    const relPointer = path.relative(tmpRoot, worktreeGitDir);
    fs.writeFileSync(path.join(tmpRoot, '.git'), `gitdir: ${relPointer}\n`, 'utf8');

    assert.strictEqual(resolveWorktreeGitDir(tmpRoot), worktreeGitDir);
  });

  it('falls back to <root>/.git when no .git entry exists', () => {
    // No `.git` created at all (mid-init / teardown race). The caller's
    // mkdir-on-write still produces a usable directory.
    assert.strictEqual(resolveWorktreeGitDir(tmpRoot), path.join(tmpRoot, '.git'));
  });

  it('falls back to <root>/.git when the .git file lacks a gitdir pointer', () => {
    fs.writeFileSync(path.join(tmpRoot, '.git'), 'garbage with no pointer\n', 'utf8');

    assert.strictEqual(resolveWorktreeGitDir(tmpRoot), path.join(tmpRoot, '.git'));
  });
});

describe('resolveCommonGitDir', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'common-dir-'));
  });

  it('is <root>/.git for a normal checkout', () => {
    fs.mkdirSync(path.join(tmpRoot, '.git'));
    assert.strictEqual(resolveCommonGitDir(tmpRoot), path.join(tmpRoot, '.git'));
  });

  it("follows a linked worktree's commondir back to the shared .git", () => {
    const common = path.join(tmpRoot, 'main', '.git');
    const own = path.join(common, 'worktrees', 'wt');
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, 'commondir'), '../..\n');
    const wt = path.join(tmpRoot, 'wt');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${own}\n`);
    assert.strictEqual(resolveCommonGitDir(wt), common);
  });

  it('is the gitdir itself when there is no commondir (a submodule)', () => {
    const modules = path.join(tmpRoot, 'super', '.git', 'modules', 'sub');
    fs.mkdirSync(modules, { recursive: true });
    const sub = path.join(tmpRoot, 'sub');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, '.git'), `gitdir: ${modules}\n`);
    assert.strictEqual(resolveCommonGitDir(sub), modules);
  });
});
