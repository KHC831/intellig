/**
 * DiffOps.getMergeBase — Result boundary.
 *
 * `git merge-base` now returns a neverthrow Result so a spawn/system fault
 * (the kind that used to be swallowed to `undefined`) is a typed Err and can
 * NEVER masquerade as the genuine "no common ancestor" domain absence:
 *   - common ancestor exists         → Ok(sha)
 *   - unrelated histories / unknown  → Ok(undefined)  (expected absence)
 *   - repo root is a file (ENOTDIR)  → Err(spawn-failed)
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { DiffOps } from '../../../src/git-core/ops/DiffOps';
import { IGitOpsContext } from '../../../src/git-core/ops/GitOpsContext';
import { createGitCli } from '../../../src/git-core/gitCli';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';

function makeRealDiffOps(): DiffOps {
  const ctx = {
    gitCli: createGitCli(),
    invalidateCache: () => undefined,
    fireDidFetch: () => undefined,
  } as unknown as IGitOpsContext;
  return new DiffOps(ctx);
}

const repo = (root: string): IRepository =>
  ({ rootUri: { fsPath: root } }) as unknown as IRepository;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@e',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@e',
    },
  });
}

describe('DiffOps.getMergeBase — Result boundary', () => {
  let tmpRoot: string;
  let ops: DiffOps;

  beforeEach(() => {
    tmpRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-mergebase-')));
    git(tmpRoot, ['init', '-q']);
    ops = makeRealDiffOps();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns Ok(sha) for two refs that share a common ancestor', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'base.txt'), 'base');
    git(tmpRoot, ['add', '.']);
    git(tmpRoot, ['commit', '-q', '-m', 'base']);
    const baseSha = git(tmpRoot, ['rev-parse', 'HEAD']).trim();

    git(tmpRoot, ['checkout', '-q', '-b', 'feature']);
    fs.writeFileSync(path.join(tmpRoot, 'feature.txt'), 'f');
    git(tmpRoot, ['add', '.']);
    git(tmpRoot, ['commit', '-q', '-m', 'feature']);
    const featureSha = git(tmpRoot, ['rev-parse', 'HEAD']).trim();

    const result = await ops.getMergeBase(repo(tmpRoot), baseSha, featureSha);
    assert.ok(result.isOk());
    assert.strictEqual(result._unsafeUnwrap(), baseSha);
  });

  it('returns Ok(undefined) for unrelated histories (no common ancestor)', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'a.txt'), 'a');
    git(tmpRoot, ['add', '.']);
    git(tmpRoot, ['commit', '-q', '-m', 'a']);
    const shaA = git(tmpRoot, ['rev-parse', 'HEAD']).trim();

    // An orphan branch shares no history with the initial branch.
    git(tmpRoot, ['checkout', '-q', '--orphan', 'orphan']);
    fs.writeFileSync(path.join(tmpRoot, 'b.txt'), 'b');
    git(tmpRoot, ['add', '.']);
    git(tmpRoot, ['commit', '-q', '-m', 'b']);
    const shaB = git(tmpRoot, ['rev-parse', 'HEAD']).trim();

    const result = await ops.getMergeBase(repo(tmpRoot), shaA, shaB);
    assert.ok(result.isOk(), 'no-common-ancestor is the expected domain absence');
    assert.strictEqual(result._unsafeUnwrap(), undefined);
  });

  it('returns a typed spawn-failed Err when the repo root is a FILE (ENOTDIR)', async () => {
    const filePath = path.join(tmpRoot, 'not-a-dir.txt');
    fs.writeFileSync(filePath, 'x');

    const result = await ops.getMergeBase(repo(filePath), 'HEAD', 'HEAD');
    assert.ok(result.isErr(), 'a file cwd must be an Err, not Ok(undefined)');
    assert.strictEqual(result._unsafeUnwrapErr().kind, 'spawn-failed');
  });
});
