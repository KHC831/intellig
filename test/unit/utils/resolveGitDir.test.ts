/**
 * Unit tests for `resolveGitDir`.
 *
 * A normal checkout has a `.git` DIRECTORY; a linked worktree or submodule has a
 * `.git` FILE holding `gitdir: <path>` that points at where the per-worktree
 * marker files actually live. State detection reads markers from the resolved
 * path, so resolving the pointer correctly is what keeps in-progress detection
 * working inside a worktree.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { resolveGitDir } from '../../../src/git-core/gitDirMarkers';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

const TMP_ROOT = SCRATCH_ROOT;

describe('resolveGitDir', () => {
  let root: string;

  beforeEach(() => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    root = fs.mkdtempSync(path.join(TMP_ROOT, 'resolve-gitdir-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('returns <root>/.git when .git is a directory', async () => {
    fs.mkdirSync(path.join(root, '.git'));
    assert.strictEqual(await resolveGitDir(root), path.join(root, '.git'));
  });

  it('returns <root>/.git when .git is absent (best-effort fallback)', async () => {
    assert.strictEqual(await resolveGitDir(root), path.join(root, '.git'));
  });

  it('parses an absolute gitdir: pointer from a .git file (linked worktree)', async () => {
    const target = path.join(root, 'realgit', 'worktrees', 'wt');
    fs.writeFileSync(path.join(root, '.git'), `gitdir: ${target}\n`);
    assert.strictEqual(await resolveGitDir(root), target);
  });

  it('resolves a relative gitdir: pointer against the root', async () => {
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: ../shared/.git/worktrees/wt\n');
    assert.strictEqual(
      await resolveGitDir(root),
      path.resolve(root, '../shared/.git/worktrees/wt')
    );
  });
});
