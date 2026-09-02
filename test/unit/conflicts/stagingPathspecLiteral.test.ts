/**
 * Staging paths are PATHSPECS, and a filename holding `*`, `?` or `[` is a
 * pattern. `--` separates paths from options; it does not make them literal.
 * Against a real git repo these prove the write-back half of a conflict
 * resolve, and the rollback path, act on the file the user named and nothing
 * else.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { GitCli } from '../../../src/git-core/gitCli';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

describe('staging — pathspec character-class collision (real git)', () => {
  let repoRoot: string;
  let gitCli: GitCli;

  beforeEach(() => {
    fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
    repoRoot = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'staging-literal-'));
    git(repoRoot, ['init', '-q', '-b', 'main']);
    git(repoRoot, ['config', 'user.email', 'a@b.c']);
    git(repoRoot, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repoRoot, 'a[1].ts'), 'base\n');
    fs.writeFileSync(path.join(repoRoot, 'a1.ts'), 'v1\n');
    git(repoRoot, ['add', 'a[1].ts', 'a1.ts']);
    git(repoRoot, ['commit', '-q', '-m', 'base']);
    gitCli = new GitCli();
  });

  afterEach(() => {
    gitCli.dispose();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  const repo = (): { rootUri: { fsPath: string } } => ({ rootUri: { fsPath: repoRoot } });

  it('staging "a[1].ts" does not also stage an unrelated dirty "a1.ts"', async () => {
    const { StagingOps } = await import('../../../src/git-core/ops/StagingOps');
    fs.writeFileSync(path.join(repoRoot, 'a[1].ts'), 'resolved\n');
    fs.writeFileSync(path.join(repoRoot, 'a1.ts'), 'v1\nSECRET work in progress\n');

    const ops = new StagingOps({
      gitCli,
      invalidateCache: (): void => {},
    } as unknown as ConstructorParameters<typeof StagingOps>[0]);
    const result = await ops.stage(repo() as never, ['a[1].ts']);
    assert.ok(result.isOk(), 'the stage itself succeeds');

    const staged = git(repoRoot, ['diff', '--cached', '--name-only']).trim().split('\n');
    assert.deepStrictEqual(staged, ['a[1].ts'], 'only the named file is staged');
    assert.strictEqual(
      git(repoRoot, ['show', ':a1.ts']),
      'v1\n',
      "the neighbour's uncommitted work must not be staged"
    );
  });

  it('degrades an empty path to an Err instead of throwing out of stage()', async () => {
    // stage() builds its argv (and calls literalPathspec) SYNCHRONOUSLY,
    // outside ResultAsync.fromPromise — a throw there would escape this
    // method entirely rather than surfacing through the ResultAsync channel
    // every caller relies on.
    const { StagingOps } = await import('../../../src/git-core/ops/StagingOps');
    const ops = new StagingOps({
      gitCli,
      invalidateCache: (): void => {},
    } as unknown as ConstructorParameters<typeof StagingOps>[0]);

    const result = await ops.stage(repo() as never, ['']);

    assert.ok(result.isErr(), 'an empty path must degrade to a failed Result, not throw');
    const staged = git(repoRoot, ['diff', '--cached', '--name-only']).trim();
    assert.strictEqual(staged, '', 'nothing must be staged for a refused path');
  });

  it('un-staging "a[1].ts" does not also un-stage "a1.ts"', async () => {
    const { StagingOps } = await import('../../../src/git-core/ops/StagingOps');
    fs.writeFileSync(path.join(repoRoot, 'a[1].ts'), 'x\n');
    fs.writeFileSync(path.join(repoRoot, 'a1.ts'), 'deliberately staged\n');
    git(repoRoot, ['add', 'a[1].ts', 'a1.ts']);

    const ops = new StagingOps({
      gitCli,
      invalidateCache: (): void => {},
    } as unknown as ConstructorParameters<typeof StagingOps>[0]);
    const result = await ops.unstage(repo() as never, ['a[1].ts']);
    assert.ok(result.isOk(), 'the unstage itself succeeds');

    const staged = git(repoRoot, ['diff', '--cached', '--name-only']).trim();
    assert.strictEqual(staged, 'a1.ts', 'the neighbour stays staged');
  });
});

describe('rollback — pathspec character-class collision (real git)', () => {
  let repoRoot: string;
  let gitCli: GitCli;

  beforeEach(() => {
    fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
    repoRoot = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'rollback-literal-'));
    git(repoRoot, ['init', '-q', '-b', 'main']);
    git(repoRoot, ['config', 'user.email', 'a@b.c']);
    git(repoRoot, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repoRoot, 'a[1].ts'), 'base\n');
    fs.writeFileSync(path.join(repoRoot, 'a1.ts'), 'v1\n');
    git(repoRoot, ['add', 'a[1].ts', 'a1.ts']);
    git(repoRoot, ['commit', '-q', '-m', 'base']);
    gitCli = new GitCli();
  });

  afterEach(() => {
    gitCli.dispose();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('rolling back "a[1].ts" does not discard uncommitted work in "a1.ts"', async () => {
    const { restorePathsToHead } = await import('../../../src/git-core/worktree/restoreToHead');
    fs.writeFileSync(path.join(repoRoot, 'a[1].ts'), 'edited\n');
    fs.writeFileSync(path.join(repoRoot, 'a1.ts'), 'PRECIOUS UNSAVED WORK\n');

    await restorePathsToHead(gitCli, repoRoot, [{ path: 'a[1].ts', inHead: true }]);

    assert.strictEqual(
      fs.readFileSync(path.join(repoRoot, 'a1.ts'), 'utf8'),
      'PRECIOUS UNSAVED WORK\n',
      'rolling back one file must not revert its neighbour'
    );
    assert.strictEqual(fs.readFileSync(path.join(repoRoot, 'a[1].ts'), 'utf8'), 'base\n');
  });
});
