/**
 * Real-git coverage for the add/add synthetic merge base.
 *
 * An add/add conflict has no stage-1 (no common ancestor), so VS Code's native
 * merge editor would show the whole file on both sides with an empty base.
 * `ensureSyntheticMergeBase` injects the conflict-marked working file as stage 1
 * (IntelliJ `GitMergeUtil.loadMergeData`'s fallback) WITHOUT disturbing
 * ours/theirs, so the editor can render a real diff.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ensureSyntheticMergeBase } from '../../../src/conflicts/syntheticMergeBase';
import { createGitCli } from '../../../src/git-core/gitCli';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** Make a repo and leave `new.txt` mid-merge as an add/add conflict (no base). */
function makeAddAddRepo(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-aa-'));
  git(root, 'init', '-q', '-b', 'mainline');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');

  fs.writeFileSync(path.join(root, 'seed.txt'), 'seed\n');
  git(root, 'add', 'seed.txt');
  git(root, 'commit', '-q', '-m', 'seed');

  git(root, 'checkout', '-q', '-b', 'theirs');
  fs.writeFileSync(path.join(root, 'new.txt'), 'line1\nFEATURE\nline3\nshared\nextra\n');
  git(root, 'add', 'new.txt');
  git(root, 'commit', '-q', '-m', 'theirs adds new.txt');

  git(root, 'checkout', '-q', 'mainline');
  fs.writeFileSync(path.join(root, 'new.txt'), 'line1\nMAIN\nline3\nshared\n');
  git(root, 'add', 'new.txt');
  git(root, 'commit', '-q', '-m', 'ours adds new.txt');

  try {
    git(root, 'merge', 'theirs');
  } catch {
    // expected — add/add conflict
  }
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Make a repo and leave `f.txt` mid-merge as a modify/modify conflict (has base). */
function makeModifyModifyRepo(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-mm-'));
  git(root, 'init', '-q', '-b', 'mainline');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');

  fs.writeFileSync(path.join(root, 'f.txt'), 'a\nb\nc\n');
  git(root, 'add', 'f.txt');
  git(root, 'commit', '-q', '-m', 'base');

  git(root, 'checkout', '-q', '-b', 'theirs');
  fs.writeFileSync(path.join(root, 'f.txt'), 'a\nB-THEIRS\nc\n');
  git(root, 'commit', '-q', '-am', 'theirs');

  git(root, 'checkout', '-q', 'mainline');
  fs.writeFileSync(path.join(root, 'f.txt'), 'a\nB-OURS\nc\n');
  git(root, 'commit', '-q', '-am', 'ours');

  try {
    git(root, 'merge', 'theirs');
  } catch {
    // expected
  }
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function stagesOf(root: string, file: string): Set<number> {
  const out = git(root, 'ls-files', '-u', '--', file);
  const stages = new Set<number>();
  for (const line of out.split('\n')) {
    const m = line.match(/\s([123])\t/);
    if (m) {
      stages.add(Number(m[1]));
    }
  }
  return stages;
}

describe('ensureSyntheticMergeBase() — real git', () => {
  const cli = createGitCli();

  it('injects stage-1 from the working file for an add/add conflict, preserving ours/theirs', async () => {
    const { root, cleanup } = makeAddAddRepo();
    try {
      assert.deepStrictEqual(
        [...stagesOf(root, 'new.txt')].sort(),
        [2, 3],
        'precondition: add/add has only stages 2 and 3'
      );

      const injected = await ensureSyntheticMergeBase(cli, root, 'new.txt');
      assert.strictEqual(injected, true, 'should report a synthetic base was injected');

      // All three stages now present.
      assert.deepStrictEqual([...stagesOf(root, 'new.txt')].sort(), [1, 2, 3]);

      // Stage 1 equals the conflict-marked working file.
      const working = fs.readFileSync(path.join(root, 'new.txt'), 'utf8');
      const stage1 = git(root, 'show', ':1:new.txt');
      assert.strictEqual(stage1, working, 'stage 1 must equal the working-tree content');
      assert.ok(stage1.includes('<<<<<<<'), 'synthetic base carries git conflict markers');

      // ours/theirs intact and still distinct.
      assert.ok(git(root, 'show', ':2:new.txt').includes('MAIN'), 'stage 2 (ours) preserved');
      assert.ok(git(root, 'show', ':3:new.txt').includes('FEATURE'), 'stage 3 (theirs) preserved');

      // Still an unmerged file (status UU), not accidentally resolved.
      assert.match(git(root, 'status', '--porcelain', 'new.txt'), /^(UU|AA) /);
    } finally {
      cleanup();
    }
  });

  it('is a no-op for a modify/modify conflict (base already present)', async () => {
    const { root, cleanup } = makeModifyModifyRepo();
    try {
      assert.deepStrictEqual([...stagesOf(root, 'f.txt')].sort(), [1, 2, 3]);
      const before = git(root, 'rev-parse', ':1:f.txt').trim();

      const injected = await ensureSyntheticMergeBase(cli, root, 'f.txt');
      assert.strictEqual(injected, false, 'must not touch a conflict that already has a base');

      const after = git(root, 'rev-parse', ':1:f.txt').trim();
      assert.strictEqual(after, before, 'stage 1 must be unchanged');
    } finally {
      cleanup();
    }
  });

  it('is a no-op when the file is not unmerged', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-clean-'));
    try {
      git(root, 'init', '-q');
      git(root, 'config', 'user.email', 'test@example.com');
      git(root, 'config', 'user.name', 'Test');
      fs.writeFileSync(path.join(root, 'plain.txt'), 'hello\n');
      git(root, 'add', 'plain.txt');
      git(root, 'commit', '-q', '-m', 'plain');

      const injected = await ensureSyntheticMergeBase(cli, root, 'plain.txt');
      assert.strictEqual(injected, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
