/**
 * Stash apply/pop reinstate-index toggle (`--index`).
 *
 * Without `--index`, `git stash apply|pop` returns previously-staged changes
 * as unstaged, losing the staged/unstaged split. IntelliJ's unstash dialog has
 * a "Reinstate index" checkbox; `GitStashUtils.createUnstashHandler` adds
 * `--index` only when it is selected. The default reinstates (true) to preserve
 * the staged split; passing `reinstateIndex=false` omits `--index` for a
 * working-tree-only apply.
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

describe('StashTagHistoryOps — stash apply/pop reinstate index (--index toggle)', () => {
  it('stashApply defaults to --index so staged changes return staged', async () => {
    const { ops, calls } = makeOps();
    await ops.stashApply(repo, 0);
    assert.deepStrictEqual(calls[0].args, ['stash', 'apply', '--index', 'stash@{0}']);
  });

  it('stashPop defaults to --index so staged changes return staged', async () => {
    const { ops, calls } = makeOps();
    await ops.stashPop(repo, 1);
    assert.deepStrictEqual(calls[0].args, ['stash', 'pop', '--index', 'stash@{1}']);
  });

  it('stashApply with reinstateIndex=true passes --index', async () => {
    const { ops, calls } = makeOps();
    await ops.stashApply(repo, 2, true);
    assert.deepStrictEqual(calls[0].args, ['stash', 'apply', '--index', 'stash@{2}']);
  });

  it('stashApply with reinstateIndex=false omits --index (working-tree-only)', async () => {
    const { ops, calls } = makeOps();
    await ops.stashApply(repo, 0, false);
    assert.deepStrictEqual(calls[0].args, ['stash', 'apply', 'stash@{0}']);
  });

  it('stashPop with reinstateIndex=false omits --index (working-tree-only)', async () => {
    const { ops, calls } = makeOps();
    await ops.stashPop(repo, 1, false);
    assert.deepStrictEqual(calls[0].args, ['stash', 'pop', 'stash@{1}']);
  });
});
