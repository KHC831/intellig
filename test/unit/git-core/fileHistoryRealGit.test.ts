/**
 * Real-git integration for File History (`getFileHistory`).
 *
 * Mirrors IntelliJ git4idea's `GitFileHistoryTest` (plugins/git4idea/tests/
 * git4idea/history/GitFileHistoryTest.kt) against our ops surface, driving the
 * production path: `createGitCli()` → `StashTagHistoryOps.getFileHistory` over a
 * live repo built with real `git` commands. These cover the rename / merge /
 * branch-scope behaviours that mock unit tests can't exercise.
 *
 * Scope note: IntelliJ's file history is HEAD-scoped and always follows renames.
 * Our default mirrors that (follow defaults on at the tab layer); these ops-level
 * tests pass `follow` explicitly so each scenario is unambiguous.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { StashTagHistoryOps } from '../../../src/git-core/ops/StashTagHistoryOps';
import { IGitOpsContext } from '../../../src/git-core/ops/GitOpsContext';
import { createGitCli } from '../../../src/git-core/gitCli';
import type { ICommit, IRepository } from '../../../src/git-core/interfaces/IGitService';

function makeRealOps(): StashTagHistoryOps {
  const ctx = {
    gitCli: createGitCli(),
    invalidateCache: () => undefined,
    fireDidFetch: () => undefined,
  } as unknown as IGitOpsContext;
  return new StashTagHistoryOps(ctx);
}

describe('File History — real git (IntelliJ GitFileHistoryTest parity)', function () {
  this.timeout(120000);

  const ops = makeRealOps();
  let dir: string;
  const repo = (): IRepository => ({ rootUri: { fsPath: dir } }) as unknown as IRepository;

  function git(...args: string[]): string {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  }

  /** Write a file (creating parent dirs), stage it, commit with `message`. */
  function commitFile(relPath: string, content: string, message: string): void {
    const abs = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    git('add', '--', relPath);
    git('commit', '-q', '-m', message);
  }

  async function history(
    file: string,
    options?: { follow?: boolean; branch?: string }
  ): Promise<ICommit[]> {
    return (await ops.getFileHistory(repo(), file, options)).unwrapOr([]);
  }

  const messages = (commits: ICommit[]): string[] => commits.map((c) => c.message);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-filehistory-'));
    git('init', '-q');
    // Pin the initial branch name so branch-scope assertions are deterministic
    // across git versions whose default is `main` vs `master`.
    git('symbolic-ref', 'HEAD', 'refs/heads/master');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── linear history + message integrity ────────────────────────────────────

  it('returns the file history newest-first with commit messages intact', async () => {
    commitFile('a.txt', 'v1\n', 'add a.txt');
    commitFile('a.txt', 'v1\nv2\n', 'edit a.txt');

    const h = await history('a.txt');
    assert.deepStrictEqual(messages(h), ['edit a.txt', 'add a.txt']);
  });

  it('preserves a commit message containing an escape sequence (IntelliJ: escape sequence)', async () => {
    const message = 'Before [30;47mescaped[0m after';
    commitFile('a.txt', 'x\n', message);

    const h = await history('a.txt');
    assert.strictEqual(h.length, 1);
    assert.strictEqual(h[0].message, message);
  });

  it('returns an empty history for a path with no commits', async () => {
    commitFile('a.txt', 'x\n', 'add a.txt');
    const h = await history('does-not-exist.txt');
    assert.deepStrictEqual(h, []);
  });

  // ── rename following (the regression IntelliJ always covers) ───────────────

  it('follows a rename so pre-rename history is retained (follow:true)', async () => {
    commitFile('old.ts', 'a\n', 'add old.ts');
    commitFile('old.ts', 'a\nb\n', 'edit old.ts');
    git('mv', 'old.ts', 'new.ts');
    git('commit', '-q', '-m', 'rename old.ts to new.ts');
    commitFile('new.ts', 'a\nb\nc\n', 'edit new.ts');

    const followed = messages(await history('new.ts', { follow: true }));
    assert.deepStrictEqual(followed, [
      'edit new.ts',
      'rename old.ts to new.ts',
      'edit old.ts',
      'add old.ts',
    ]);
  });

  it('stops at the rename when follow is off (proving --follow is what crosses it)', async () => {
    commitFile('old.ts', 'a\n', 'add old.ts');
    commitFile('old.ts', 'a\nb\n', 'edit old.ts');
    git('mv', 'old.ts', 'new.ts');
    git('commit', '-q', '-m', 'rename old.ts to new.ts');
    commitFile('new.ts', 'a\nb\nc\n', 'edit new.ts');

    const unfollowed = messages(await history('new.ts', { follow: false }));
    assert.deepStrictEqual(unfollowed, ['edit new.ts', 'rename old.ts to new.ts']);
  });

  it('follows a file moved through several directories (IntelliJ: cyclic rename)', async () => {
    commitFile('source/F.java', '1\n', 'create source/F.java');
    git('mv', 'source/F.java', 'lang.java');
    git('commit', '-q', '-m', 'move to lang.java');
    fs.mkdirSync(path.join(dir, 'impl'), { recursive: true });
    git('mv', 'lang.java', 'impl/F.java');
    git('commit', '-q', '-m', 'move to impl/F.java');
    fs.appendFileSync(path.join(dir, 'impl/F.java'), '2\n');
    git('commit', '-qam', 'edit impl/F.java');

    const h = messages(await history('impl/F.java', { follow: true }));
    assert.deepStrictEqual(h, [
      'edit impl/F.java',
      'move to impl/F.java',
      'move to lang.java',
      'create source/F.java',
    ]);
  });

  // ── merges (IntelliJ: history through trivial / merged-rename merge) ────────

  it('follows a rename across a branch merge — the common workflow (rename on a branch, then merge)', async () => {
    // Rename a file on a feature branch (its own commit), edit it, then merge
    // the branch with --no-ff. Viewed from master, the file's full history —
    // including the pre-rename `add` — must be retained. `git log --follow`
    // ALONE drops the pre-rename commit here because the path reaches HEAD via
    // a merge; pairing it with --full-history --simplify-merges recovers it.
    commitFile('a.txt', 'a\n', 'add a.txt');
    git('checkout', '-q', '-b', 'feature');
    git('mv', 'a.txt', 'b.txt');
    git('commit', '-q', '-m', 'rename a.txt to b.txt');
    commitFile('b.txt', 'a\nb\n', 'edit b.txt on feature');

    git('checkout', '-q', 'master');
    git('merge', '--no-ff', '--no-edit', '-q', 'feature');

    const h = messages(await history('b.txt', { follow: true }));
    assert.deepStrictEqual(h, ['edit b.txt on feature', 'rename a.txt to b.txt', 'add a.txt']);
  });

  it('includes a branch commit pulled in by a --no-ff merge (IntelliJ: trivial merge)', async () => {
    commitFile('a.txt', 'a\n', 'add a.txt');
    commitFile('unrelated.txt', 'u\n', 'add unrelated.txt');
    const branchingPoint = git('rev-parse', 'HEAD~1');

    git('checkout', '-q', '-b', 'newBranch', branchingPoint);
    commitFile('a.txt', 'a\nbranch\n', 'modify a.txt on branch');

    git('checkout', '-q', 'master');
    git('merge', '--no-ff', '--no-edit', '-q', 'newBranch');

    const msgs = messages(await history('a.txt'));
    assert.ok(
      msgs.includes('modify a.txt on branch'),
      'branch modification is reachable from HEAD'
    );
    assert.ok(msgs.includes('add a.txt'), 'original add is present');
  });

  it('does not return EMPTY history for a rename made inside a merge commit (--follow merge bug guard)', async () => {
    // IntelliJ (GitFileHistoryTest "history through merged rename") recovers the
    // full pre-rename chain via a manual rename walk. We approximate with
    // `git log --follow`, which has a known bug: a rename performed *inside a
    // merge commit* makes `--follow` return nothing. The fallback in
    // `_getFileHistory` retries without `--follow` so the file still shows at
    // least git's default history (the rename/merge commit) instead of an empty
    // list. Recovering the deeper pre-rename branch edits would require porting
    // IntelliJ's manual walk and is a known parity gap, recorded here.
    commitFile('initial.txt', 'i\n', 'initial commit');
    const branchingPoint = git('rev-parse', 'HEAD');

    git('checkout', '-q', '-b', 'newBranch', branchingPoint);
    commitFile('a.txt', 'a\n', 'add a.txt on branch');
    commitFile('a.txt', 'a\nb\n', 'edit a.txt on branch');

    git('checkout', '-q', 'master');
    git('merge', '--no-ff', '--no-commit', 'newBranch');
    fs.mkdirSync(path.join(dir, 'dir'), { recursive: true });
    git('mv', 'a.txt', 'dir/b.txt');
    git('commit', '-q', '-m', 'rename a.txt to dir/b.txt in merge');

    const msgs = messages(await history('dir/b.txt', { follow: true }));
    assert.ok(msgs.length > 0, 'must not be empty (the --follow-on-merge bug guard)');
    assert.ok(
      msgs.includes('rename a.txt to dir/b.txt in merge'),
      'the merge/rename commit itself is shown'
    );
  });

  // ── branch scoping (IntelliJ: branches history) ────────────────────────────

  it('scopes history to the requested branch ref (IntelliJ: branches history)', async () => {
    commitFile('a.txt', '1\n', 'common add');
    commitFile('a.txt', '1\n2\n', 'common edit');
    const branchingPoint = git('rev-parse', 'HEAD');

    // master-only change.
    commitFile('a.txt', '1\n2\nmaster\n', 'master edit');

    // newBranch-only change off the common point.
    git('checkout', '-q', '-b', 'newBranch', branchingPoint);
    commitFile('a.txt', '1\n2\nbranch\n', 'branch edit');
    git('checkout', '-q', 'master');

    assert.deepStrictEqual(messages(await history('a.txt', { branch: 'master' })), [
      'master edit',
      'common edit',
      'common add',
    ]);
    assert.deepStrictEqual(messages(await history('a.txt', { branch: 'newBranch' })), [
      'branch edit',
      'common edit',
      'common add',
    ]);
    // Scoped to the branching-point commit: only the common history.
    assert.deepStrictEqual(messages(await history('a.txt', { branch: branchingPoint })), [
      'common edit',
      'common add',
    ]);
    // Default HEAD == master here.
    assert.deepStrictEqual(messages(await history('a.txt')), [
      'master edit',
      'common edit',
      'common add',
    ]);
  });

  it('scopes branch history across a rename (IntelliJ: branches history with rename)', async () => {
    commitFile('a.txt', '1\n', 'add a.txt');
    commitFile('a.txt', '1\n2\n', 'edit a.txt');
    const pointBeforeRename = git('rev-parse', 'HEAD');

    fs.mkdirSync(path.join(dir, 'dir'), { recursive: true });
    git('mv', 'a.txt', 'dir/b.txt');
    git('commit', '-q', '-m', 'rename a.txt to dir/b.txt');
    commitFile('dir/b.txt', '1\n2\n3\n', 'edit dir/b.txt');

    // On master, following renames yields the full chain.
    assert.deepStrictEqual(
      messages(await history('dir/b.txt', { branch: 'master', follow: true })),
      ['edit dir/b.txt', 'rename a.txt to dir/b.txt', 'edit a.txt', 'add a.txt']
    );
    // The post-rename path does not exist at the pre-rename commit.
    assert.deepStrictEqual(
      messages(await history('dir/b.txt', { branch: pointBeforeRename, follow: true })),
      []
    );
    // The pre-rename path scoped to the pre-rename commit yields its history.
    assert.deepStrictEqual(messages(await history('a.txt', { branch: pointBeforeRename })), [
      'edit a.txt',
      'add a.txt',
    ]);
  });
});
