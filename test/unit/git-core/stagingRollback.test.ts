/**
 * StagingOps.rollbackChanges — IntelliJ "Rollback / Revert Local Changes".
 *
 * Mirrors git4idea's GitRollbackEnvironment.rollbackChanges
 * (plugins/git4idea/backend/src/rollback/GitRollbackEnvironment.java):
 *   - MODIFICATION / DELETED  -> revert from HEAD (`git checkout HEAD -- <paths>`)
 *   - NEW (added/staged)      -> unindex (`git rm --cached -f -- <paths>`),
 *                                leaving the file untracked; deleted from the
 *                                working tree only when the caller opts in.
 *   - untracked               -> deleted from disk ONLY when explicitly included
 *
 * These specs pin the injection-safe argv (every path positional behind `--`,
 * no user input ever in flag position) and the untracked-deletion gating.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StagingOps } from '../../../src/git-core/ops/StagingOps';
import { IGitOpsContext } from '../../../src/git-core/ops/GitOpsContext';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';

interface ExecCall {
  args: string[];
}

function makeMockOps(): { ops: StagingOps; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const gitCli = {
    exec: async (args: string[]) => {
      calls.push({ args });
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
  const ctx = {
    gitCli,
    invalidateCache: () => undefined,
    fireDidFetch: () => undefined,
  } as unknown as IGitOpsContext;
  return { ops: new StagingOps(ctx), calls };
}

const repo = (root: string): IRepository =>
  ({ rootUri: { fsPath: root } }) as unknown as IRepository;

describe('StagingOps.rollbackChanges', () => {
  it('reverts modified + deleted files via checkout HEAD -- <paths>', async () => {
    const { ops, calls } = makeMockOps();
    await ops.rollbackChanges(repo('/r'), [
      { path: 'src/a.ts', status: 'modified' },
      { path: 'src/gone.ts', status: 'deleted' },
    ]);
    const revert = calls.find((c) => c.args[0] === 'checkout')!;
    assert.ok(revert, 'expected a checkout call');
    assert.deepStrictEqual(revert.args, ['checkout', 'HEAD', '--', 'src/a.ts', 'src/gone.ts']);
  });

  it('argv is injection-safe — a path that looks like a flag stays positional', async () => {
    const { ops, calls } = makeMockOps();
    await ops.rollbackChanges(repo('/r'), [{ path: '--force', status: 'modified' }]);
    const revert = calls.find((c) => c.args[0] === 'checkout')!;
    // The `--` terminator must precede the path so git can never read it as a flag.
    const sep = revert.args.indexOf('--');
    assert.ok(sep > 0, 'expected -- terminator');
    assert.ok(revert.args.indexOf('--force') > sep, 'path must follow the -- terminator');
  });

  it('added (staged) file is unstaged via rm --cached -f, not checked out', async () => {
    const { ops, calls } = makeMockOps();
    await ops.rollbackChanges(repo('/r'), [{ path: 'new.ts', status: 'added' }]);
    const rm = calls.find((c) => c.args[0] === 'rm');
    assert.ok(rm, 'expected a rm --cached call');
    assert.deepStrictEqual(rm.args, ['rm', '--cached', '-f', '--', 'new.ts']);
    assert.ok(!calls.some((c) => c.args[0] === 'checkout'), 'added file must not be checked out');
  });

  it('untracked file is NOT deleted unless explicitly included', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-untracked-'));
    try {
      const f = path.join(dir, 'junk.txt');
      fs.writeFileSync(f, 'x');
      const { ops, calls } = makeMockOps();
      await ops.rollbackChanges(repo(dir), [{ path: 'junk.txt', status: 'untracked' }]);
      assert.ok(fs.existsSync(f), 'untracked file must survive when deleteUntracked is off');
      assert.strictEqual(calls.length, 0, 'no git command for a skipped untracked file');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('untracked file IS deleted when deleteUntracked is set', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-untracked-'));
    try {
      const f = path.join(dir, 'junk.txt');
      fs.writeFileSync(f, 'x');
      const { ops } = makeMockOps();
      await ops.rollbackChanges(repo(dir), [{ path: 'junk.txt', status: 'untracked' }], {
        deleteUntracked: true,
      });
      assert.ok(!fs.existsSync(f), 'untracked file removed when explicitly included');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deletes a nested untracked path but rejects paths escaping the repo', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-escape-'));
    const dir = path.join(parent, 'repo');
    fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
    try {
      // A real nested file IS deleted.
      const nested = path.join(dir, 'nested', 'junk.txt');
      fs.writeFileSync(nested, 'x');
      const { ops } = makeMockOps();
      await ops.rollbackChanges(repo(dir), [{ path: 'nested/junk.txt', status: 'untracked' }], {
        deleteUntracked: true,
      });
      assert.ok(!fs.existsSync(nested), 'nested untracked file removed');

      // A sibling OUTSIDE the repo must survive a `../escape` path.
      const outside = path.join(parent, 'precious.txt');
      fs.writeFileSync(outside, 'keep me');
      for (const evil of ['', '.', '../precious.txt']) {
        await assert.rejects(
          ops.rollbackChanges(repo(dir), [{ path: evil, status: 'untracked' }], {
            deleteUntracked: true,
          }),
          /outside the repository/,
          `expected rejection for path ${JSON.stringify(evil)}`
        );
      }
      assert.ok(fs.existsSync(outside), 'file outside the repo must survive');
      assert.ok(fs.existsSync(dir), 'repo root must survive an empty/"." path');
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});
