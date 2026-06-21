/**
 * No-merges log filter — `getLog({ noMerges })` must pass `--no-merges`.
 *
 * Mirrors IntelliJ's VCS-log "No Merges" filter
 * (platform/vcs-log VcsLogBundle `vcs.log.filter.no.merges`). `--no-merges`
 * is a static flag (no user input), so it is spliced as a plain argument.
 */

import '../../setup';
import * as assert from 'assert';
import { StashTagHistoryOps } from '../../../src/git-core/ops/StashTagHistoryOps';
import { IGitOpsContext } from '../../../src/git-core/ops/GitOpsContext';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';

function makeOps(): { ops: StashTagHistoryOps; calls: string[][] } {
  const calls: string[][] = [];
  const gitCli = {
    exec: async (args: string[]) => {
      calls.push(args);
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

describe('StashTagHistoryOps.getLog — no-merges filter', () => {
  it('adds --no-merges when noMerges is true', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { noMerges: true });
    assert.ok(calls[0].includes('--no-merges'), '--no-merges must be present');
  });

  it('omits --no-merges when noMerges is false', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { noMerges: false });
    assert.ok(!calls[0].includes('--no-merges'));
  });

  it('omits --no-merges when noMerges is unset', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { maxCount: 10 });
    assert.ok(!calls[0].includes('--no-merges'));
  });
});
