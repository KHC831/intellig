/**
 * StagingOps.unstage must work in a repo with NO commits (unborn branch).
 *
 * `git reset HEAD -- <paths>` fatals on an unborn branch ("ambiguous argument
 * 'HEAD'"), so un-staging the very first files of a fresh repo errored. git4idea
 * special-cases this with `git rm --cached`. We fall back to that when the
 * reset fails against an unborn HEAD.
 */

import '../../setup';
import * as assert from 'assert';
import { StagingOps } from '../../../src/git-core/ops/StagingOps';
import { IGitOpsContext } from '../../../src/git-core/ops/GitOpsContext';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';

interface ExecCall {
  args: string[];
}

/** GitCli stub whose `reset HEAD` exits non-zero with the unborn-HEAD fatal. */
function makeOps(resetFails: boolean): { ops: StagingOps; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const gitCli = {
    exec: async (args: string[], options?: { throwOnError?: boolean }) => {
      calls.push({ args });
      if (args[0] === 'reset' && resetFails) {
        const result = {
          exitCode: 128,
          stdout: '',
          stderr: "fatal: ambiguous argument 'HEAD': unknown revision",
          combined: "fatal: ambiguous argument 'HEAD': unknown revision",
        };
        if (options?.throwOnError) {
          const err = new Error('reset failed') as Error & { result: typeof result };
          err.result = result;
          throw err;
        }
        return result;
      }
      return { exitCode: 0, stdout: '', stderr: '', combined: '' };
    },
  };
  const ctx = {
    gitCli,
    invalidateCache: () => undefined,
    fireDidFetch: () => undefined,
  } as unknown as IGitOpsContext;
  return { ops: new StagingOps(ctx), calls };
}

const repo = (): IRepository => ({ rootUri: { fsPath: '/r' } }) as unknown as IRepository;

describe('StagingOps.unstage — unborn branch fallback', () => {
  it('falls back to rm --cached when reset HEAD fails on an unborn branch', async () => {
    const { ops, calls } = makeOps(true);
    const result = await ops.unstage(repo(), ['first.ts']);
    assert.ok(result.isOk(), `unstage should succeed via fallback; got ${JSON.stringify(result)}`);
    const rm = calls.find((c) => c.args[0] === 'rm');
    assert.ok(rm, 'expected a rm --cached fallback');
    assert.deepStrictEqual(rm.args, ['rm', '--cached', '-r', '--', 'first.ts']);
  });

  it('uses plain reset HEAD when a commit exists (no fallback)', async () => {
    const { ops, calls } = makeOps(false);
    const result = await ops.unstage(repo(), ['a.ts']);
    assert.ok(result.isOk());
    assert.deepStrictEqual(calls[0].args, ['reset', 'HEAD', '--', 'a.ts']);
    assert.ok(!calls.some((c) => c.args[0] === 'rm'), 'no rm fallback when reset succeeds');
  });
});
