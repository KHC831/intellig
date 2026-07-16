/**
 * Stash apply/pop reinstate-index toggle (`--index`).
 *
 * IntelliJ's unstash dialog has a "Reinstate index" checkbox that defaults
 * OFF (GitUnstashAsDialog keepIndex=false); `GitStashUtils.createUnstashHandler`
 * adds `--index` only when it is selected — matching git's own default. The
 * ops default mirrors that: working-tree-only unless `reinstateIndex=true`
 * is passed explicitly.
 */

import '../../setup';
import * as assert from 'assert';
import { StashTagHistoryOps } from '../../../src/git-core/ops/StashTagHistoryOps';
import { IGitOpsContext } from '../../../src/git-core/ops/GitOpsContext';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';

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
  it('stashApply defaults to working-tree-only (no --index), the reference default', async () => {
    const { ops, calls } = makeOps();
    await ops.stashApply(repo, 0);
    assert.deepStrictEqual(calls[0].args, ['stash', 'apply', 'stash@{0}']);
  });

  it('stashPop defaults to working-tree-only (no --index), the reference default', async () => {
    const { ops, calls } = makeOps();
    await ops.stashPop(repo, 1);
    assert.deepStrictEqual(calls[0].args, ['stash', 'pop', 'stash@{1}']);
  });

  it('stashPop with reinstateIndex=true passes --index', async () => {
    const { ops, calls } = makeOps();
    await ops.stashPop(repo, 1, true);
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

describe('StashTagHistoryOps — stash clear', () => {
  it('stashClear issues git stash clear', async () => {
    const { ops, calls } = makeOps();
    await ops.stashClear(repo);
    assert.deepStrictEqual(calls[0].args, ['stash', 'clear']);
  });
});
