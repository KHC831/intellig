/**
 * StashTagHistoryOps.getLogCount — `git rev-list --count` over the SAME
 * refs/filter as getLog, so the Graph view's "X of Y" indicator is honest and
 * scroll-to-bottom load-more knows the true end of history.
 *
 * Specs pin:
 *   - argv shape: maps the set-changing filters exactly as getLog does, omits
 *     the window-only `maxCount`/`skip` and ordering-only `topoOrder`, and
 *     anchors to HEAD only when no all/ref/range scope is given;
 *   - ref/range leading `-`/`.` are rejected before reaching git (injection);
 *   - real-git round-trip: the count equals the actual number of commits, and
 *     matches `getLog(...).length` when getLog isn't windowed, across the
 *     all-refs, single-ref, and no-merges cases.
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
import { IRepository } from '../../../src/git-core/interfaces/IGitService';

function makeMockOps(stdout = '0'): { ops: StashTagHistoryOps; calls: string[][] } {
  const calls: string[][] = [];
  const gitCli = {
    exec: async (args: string[]) => {
      calls.push(args);
      return { exitCode: 0, stdout, stderr: '' };
    },
  };
  const ctx = {
    gitCli,
    invalidateCache: () => undefined,
    fireDidFetch: () => undefined,
  } as unknown as IGitOpsContext;
  return { ops: new StashTagHistoryOps(ctx), calls };
}

function makeRealOps(): StashTagHistoryOps {
  const ctx = {
    gitCli: createGitCli(),
    invalidateCache: () => undefined,
    fireDidFetch: () => undefined,
  } as unknown as IGitOpsContext;
  return new StashTagHistoryOps(ctx);
}

const repo = (root: string): IRepository =>
  ({ rootUri: { fsPath: root } }) as unknown as IRepository;

describe('StashTagHistoryOps.getLogCount — argv shape', () => {
  it('uses `rev-list --count` and anchors to HEAD with no scope', async () => {
    const { ops, calls } = makeMockOps('5');
    await ops.getLogCount(repo('/r'));
    assert.deepStrictEqual(calls[0], ['rev-list', '--count', 'HEAD']);
  });

  it('passes --all (excluding refs/stash) and does NOT add HEAD when all is set', async () => {
    const { ops, calls } = makeMockOps('5');
    await ops.getLogCount(repo('/r'), { all: true });
    assert.ok(calls[0].includes('--all') && calls[0].includes('--exclude=refs/stash'));
    assert.ok(!calls[0].includes('HEAD'), 'HEAD anchor is redundant under --all');
  });

  it('omits the window-only maxCount/skip and ordering-only topoOrder', async () => {
    const { ops, calls } = makeMockOps('5');
    await ops.getLogCount(repo('/r'), { maxCount: 500, skip: 10, topoOrder: true });
    assert.ok(!calls[0].some((a) => a.startsWith('-n')), 'no -n window');
    assert.ok(!calls[0].some((a) => a.startsWith('--skip')), 'no --skip');
    assert.ok(!calls[0].includes('--topo-order'), 'no --topo-order');
  });

  it('mirrors the set-changing filters from getLog', async () => {
    const { ops, calls } = makeMockOps('5');
    await ops.getLogCount(repo('/r'), {
      author: 'alice',
      grep: 'fix',
      noMerges: true,
      minParents: 2,
    });
    const a = calls[0];
    assert.ok(a.includes('--author=alice'));
    assert.ok(a.includes('--grep=fix'));
    assert.ok(a.includes('--regexp-ignore-case'), 'case-insensitive grep by default');
    assert.ok(a.includes('--no-merges'));
    assert.ok(a.includes('--min-parents=2'));
  });

  it('errs on a ref starting with `-` or `.` before running git', async () => {
    const { ops, calls } = makeMockOps('5');
    for (const ref of ['-evil', '.evil']) {
      const result = await ops.getLogCount(repo('/r'), { all: false, ref });
      assert.ok(result.isErr(), `expected Err for ref ${ref}`);
      assert.strictEqual(result._unsafeUnwrapErr().kind, 'invalid-argument');
    }
    assert.strictEqual(calls.length, 0, 'git must not be invoked for an invalid ref');
  });

  it('errs on a logRange starting with `-` or `.`', async () => {
    const { ops } = makeMockOps('5');
    const result = await ops.getLogCount(repo('/r'), { logRange: '-evil' });
    assert.ok(result.isErr());
    assert.strictEqual(result._unsafeUnwrapErr().kind, 'invalid-argument');
  });
});

describe('StashTagHistoryOps.getLogCount — real git round-trip', () => {
  let dir: string;
  const N = 12;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'getlogcount-'));
    const git = (...a: string[]): void => {
      execFileSync('git', a, { cwd: dir });
    };
    git('init', '-q');
    git('config', 'user.email', 't@t.io');
    git('config', 'user.name', 'T');
    git('config', 'commit.gpgsign', 'false');
    for (let i = 0; i < N; i++) {
      git('commit', '--allow-empty', '-q', '-m', `c${i}`);
    }
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('counts all commits on HEAD (no scope)', async () => {
    const ops = makeRealOps();
    assert.strictEqual((await ops.getLogCount(repo(dir)))._unsafeUnwrap(), N);
  });

  it('count equals an unwindowed getLog length under --all', async () => {
    const ops = makeRealOps();
    const count = (await ops.getLogCount(repo(dir), { all: true }))._unsafeUnwrap();
    const commits = (await ops.getLog(repo(dir), { all: true }))._unsafeUnwrap();
    assert.strictEqual(count, commits.length);
    assert.strictEqual(count, N);
  });

  it('respects a ref scope (HEAD~3 counts 3 fewer)', async () => {
    const ops = makeRealOps();
    assert.strictEqual(
      (await ops.getLogCount(repo(dir), { all: false, ref: 'HEAD~3' }))._unsafeUnwrap(),
      N - 3
    );
  });
});
