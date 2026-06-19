/**
 * Unit tests for `resolveWorktreeGitDir` — the synchronous git-dir resolver
 * used to place changelist/shelf storage in the correct directory.
 *
 * Regression: changelist + shelf storage previously hardcoded `<root>/.git`.
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
import { resolveWorktreeGitDir } from '../../../git-core/repo/RepositoryDiscovery';

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
