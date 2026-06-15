/**
 * P1 parity fix — stash apply/pop must reinstate the index (`--index`).
 *
 * Without `--index`, `git stash apply|pop` returns previously-staged changes
 * as unstaged, silently losing the staged/unstaged split. IntelliJ's unstash
 * reinstates the index (GitStashUtils → `--index`); per the locked UX decision
 * our plain Pop/Apply always pass `--index`.
 */

import '../../setup';
import * as assert from 'assert';
import { StashTagHistoryOps } from '../../../git-core/ops/StashTagHistoryOps';
import { IGitOpsContext } from '../../../git-core/ops/GitOpsContext';
import { IRepository } from '../../../git-core/interfaces/IGitService';

interface ExecCall {
  args: string[];
}

function makeOps(): { ops: StashTagHistoryOps; calls: ExecCall[] } {
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
  return { ops: new StashTagHistoryOps(ctx), calls };
}

const repo = { rootUri: { fsPath: '/repo' } } as unknown as IRepository;

describe('StashTagHistoryOps — stash apply/pop reinstate index (P1: stash --index)', () => {
  it('stashApply passes --index so staged changes return staged', async () => {
    const { ops, calls } = makeOps();
    await ops.stashApply(repo, 0);
    assert.deepStrictEqual(calls[0].args, ['stash', 'apply', '--index', 'stash@{0}']);
  });

  it('stashPop passes --index so staged changes return staged', async () => {
    const { ops, calls } = makeOps();
    await ops.stashPop(repo, 1);
    assert.deepStrictEqual(calls[0].args, ['stash', 'pop', '--index', 'stash@{1}']);
  });
});
