/**
 * Real-git + fake-.git coverage for conflict SIDE NAME resolution — the names
 * shown as "Accept from {name}" for each side of a conflict. Naming must stay
 * reversal-correct (rebase/stash swap the index sides; a patch does not), walk
 * the branch-name → short-SHA → undefined fallback ladder, and disambiguate
 * identical names.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  resolveConflictSideNames,
  ShortenSha,
  NameRev,
} from '../../../src/conflicts/conflictSideNames';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

const shortenSha: ShortenSha = async (sha) => sha.substring(0, 7);
const noNameRev: NameRev = async () => undefined;

/** Temp dirs live under the gitignored workspace-notes/tmp, not os.tmpdir(). */
function tmpRoot(): string {
  const root = path.resolve(__dirname, '../../..', 'workspace-notes', 'tmp');
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function mkdtemp(prefix: string): string {
  return fs.mkdtempSync(path.join(tmpRoot(), prefix));
}

function initRepo(prefix: string): string {
  const root = mkdtemp(prefix);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  return root;
}

function gitDir(root: string): string {
  return path.join(root, '.git');
}

describe('resolveConflictSideNames — real git', () => {
  it('merge: yours is the current branch, theirs is the merged-in branch (from MERGE_MSG)', async () => {
    const root = initRepo('names-merge-');
    try {
      fs.writeFileSync(path.join(root, 'f.txt'), 'base\n');
      git(root, 'add', 'f.txt');
      git(root, 'commit', '-q', '-m', 'base');
      git(root, 'checkout', '-q', '-b', 'feature');
      fs.writeFileSync(path.join(root, 'f.txt'), 'feature\n');
      git(root, 'commit', '-q', '-am', 'f');
      git(root, 'checkout', '-q', 'main');
      fs.writeFileSync(path.join(root, 'f.txt'), 'main\n');
      git(root, 'commit', '-q', '-am', 'm');
      try {
        git(root, 'merge', 'feature');
      } catch {
        /* expected conflict */
      }

      const names = await resolveConflictSideNames(
        gitDir(root),
        'merge',
        'main',
        shortenSha,
        noNameRev
      );
      assert.strictEqual(names.yours, 'main');
      assert.strictEqual(names.theirs, 'feature');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rebase: yours is the replayed branch, theirs is the onto target (reversal-correct)', async () => {
    const root = initRepo('names-rebase-');
    try {
      fs.writeFileSync(path.join(root, 'f.txt'), 'base\n');
      git(root, 'add', 'f.txt');
      git(root, 'commit', '-q', '-m', 'base');
      git(root, 'checkout', '-q', '-b', 'feature');
      fs.writeFileSync(path.join(root, 'f.txt'), 'feature\n');
      git(root, 'commit', '-q', '-am', 'f');
      git(root, 'checkout', '-q', 'main');
      fs.writeFileSync(path.join(root, 'f.txt'), 'main\n');
      git(root, 'commit', '-q', '-am', 'm');
      git(root, 'checkout', '-q', 'feature');
      try {
        git(root, 'rebase', 'main');
      } catch {
        /* expected conflict */
      }

      const names = await resolveConflictSideNames(
        gitDir(root),
        'rebase',
        undefined,
        shortenSha,
        noNameRev
      );
      assert.strictEqual(names.yours, 'feature', 'Yours = the branch being replayed');
      assert.ok(
        names.theirs && /^[0-9a-f]{7}$/.test(names.theirs),
        'Theirs = onto short SHA when name-rev declines'
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rebase: onto uses the friendly name-rev result when available', async () => {
    const root = initRepo('names-rebase2-');
    try {
      fs.writeFileSync(path.join(root, 'f.txt'), 'base\n');
      git(root, 'add', 'f.txt');
      git(root, 'commit', '-q', '-m', 'base');
      git(root, 'checkout', '-q', '-b', 'feature');
      fs.writeFileSync(path.join(root, 'f.txt'), 'feature\n');
      git(root, 'commit', '-q', '-am', 'f');
      git(root, 'checkout', '-q', 'main');
      fs.writeFileSync(path.join(root, 'f.txt'), 'main\n');
      git(root, 'commit', '-q', '-am', 'm');
      git(root, 'checkout', '-q', 'feature');
      try {
        git(root, 'rebase', 'main');
      } catch {
        /* expected conflict */
      }

      const nameRev: NameRev = async () => 'main';
      const names = await resolveConflictSideNames(
        gitDir(root),
        'rebase',
        undefined,
        shortenSha,
        nameRev
      );
      assert.strictEqual(names.theirs, 'main');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('cherry-pick: theirs is the picked commit short SHA', async () => {
    const root = initRepo('names-cp-');
    try {
      fs.writeFileSync(path.join(root, 'f.txt'), 'base\n');
      git(root, 'add', 'f.txt');
      git(root, 'commit', '-q', '-m', 'base');
      git(root, 'checkout', '-q', '-b', 'feature');
      fs.writeFileSync(path.join(root, 'f.txt'), 'feature\n');
      git(root, 'commit', '-q', '-am', 'f');
      const pickedFull = git(root, 'rev-parse', 'HEAD').trim();
      git(root, 'checkout', '-q', 'main');
      fs.writeFileSync(path.join(root, 'f.txt'), 'main\n');
      git(root, 'commit', '-q', '-am', 'm');
      try {
        git(root, 'cherry-pick', pickedFull);
      } catch {
        /* expected conflict */
      }

      const names = await resolveConflictSideNames(
        gitDir(root),
        'cherryPick',
        'main',
        shortenSha,
        noNameRev
      );
      assert.strictEqual(names.yours, 'main');
      assert.strictEqual(names.theirs, pickedFull.substring(0, 7));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a conflicting pull of a same-named branch disambiguates the two sides', async () => {
    // `git pull` writes MERGE_MSG "Merge branch 'main' of <url> into main", so
    // both sides resolve to "main" — they must be qualified, not identical.
    const dir = mkdtemp('names-pull-');
    try {
      fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, '.git', 'MERGE_MSG'),
        "Merge branch 'main' of github.com:acme/app into main\n"
      );
      const names = await resolveConflictSideNames(
        path.join(dir, '.git'),
        'merge',
        'main',
        shortenSha,
        noNameRev
      );
      assert.strictEqual(names.yours, 'main (current)');
      assert.strictEqual(names.theirs, 'main (incoming)');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveConflictSideNames — stage mapping + fallbacks (fake .git)', () => {
  function fakeGit(prefix: string): string {
    const dir = mkdtemp(prefix);
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    return dir;
  }

  it('applyPatch: yours is the current branch, theirs is the patch (NOT reversed)', async () => {
    // Regression: `git apply --3way` is non-reversed — stage 2 (--ours) is the
    // current tree, stage 3 (--theirs) is the patch. So "Accept Yours" keeps the
    // current side and the patch must be named on the THEIRS side, or the user
    // accepts the opposite of the label.
    const dir = fakeGit('names-applypatch-');
    try {
      const names = await resolveConflictSideNames(
        path.join(dir, '.git'),
        'applyPatch',
        'main',
        shortenSha,
        noNameRev
      );
      assert.strictEqual(names.yours, 'main');
      assert.strictEqual(names.theirs, 'the patch');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('unstash: the stashed side has no ref name (undefined → generic), theirs is the current branch', async () => {
    const dir = fakeGit('names-stash-');
    try {
      const names = await resolveConflictSideNames(
        path.join(dir, '.git'),
        'unstash',
        'main',
        shortenSha,
        noNameRev
      );
      assert.strictEqual(names.yours, undefined);
      assert.strictEqual(names.theirs, 'main');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a custom merge message with stray apostrophes is not misparsed', async () => {
    const dir = fakeGit('names-custommsg-');
    try {
      fs.writeFileSync(path.join(dir, '.git', 'MERGE_MSG'), "Don't merge 'wip' yet\n");
      // The line does not match git's "Merge <kind> '…'" header and there is no
      // MERGE_HEAD, so theirs is undefined (not the bogus "t merge").
      const names = await resolveConflictSideNames(
        path.join(dir, '.git'),
        'merge',
        'main',
        shortenSha,
        noNameRev
      );
      assert.strictEqual(names.yours, 'main');
      assert.strictEqual(names.theirs, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detached HEAD with no branch falls back to the short HEAD SHA', async () => {
    const dir = fakeGit('names-detached-');
    try {
      const sha = 'a'.repeat(40);
      fs.writeFileSync(path.join(dir, '.git', 'HEAD'), sha + '\n');
      const names = await resolveConflictSideNames(
        path.join(dir, '.git'),
        'merge',
        undefined,
        shortenSha,
        noNameRev
      );
      assert.strictEqual(names.yours, sha.substring(0, 7));
      assert.strictEqual(names.theirs, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('nothing resolvable → both sides undefined, never throws', async () => {
    const dir = fakeGit('names-empty-');
    try {
      const names = await resolveConflictSideNames(
        path.join(dir, '.git'),
        'merge',
        undefined,
        shortenSha,
        noNameRev
      );
      assert.strictEqual(names.yours, undefined);
      assert.strictEqual(names.theirs, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
