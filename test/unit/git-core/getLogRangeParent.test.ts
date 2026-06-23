/**
 * Range / first-parent / simplify-merges / parent-count log filters.
 *
 * `getLog` must translate the four NORTHSTAR-G filters into git args:
 *   - firstParent     → --first-parent (IntelliJ PermanentGraph.Options.FirstParent,
 *                       "Follow only the first parent commit upon seeing a merge")
 *   - simplifyMerges  → --simplify-merges (graph options chooser)
 *   - minParents/maxParents → --min-parents=N / --max-parents=N
 *                       (IntelliJ ParentFilterModel / VcsLogFilterObject.fromParentCount)
 *   - logRange        → positional "A..B" range (IntelliJ BranchFilterModel range
 *                       notation → VcsLogRangeFilter); --all suppressed since the
 *                       range is self-scoping.
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

describe('StashTagHistoryOps.getLog — first-parent filter', () => {
  it('adds --first-parent when firstParent is true', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { firstParent: true });
    assert.ok(calls[0].includes('--first-parent'), '--first-parent must be present');
  });

  it('omits --first-parent when firstParent is false', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { firstParent: false });
    assert.ok(!calls[0].includes('--first-parent'));
  });
});

describe('StashTagHistoryOps.getLog — simplify-merges filter', () => {
  it('adds --simplify-merges when simplifyMerges is true', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { simplifyMerges: true });
    assert.ok(calls[0].includes('--simplify-merges'), '--simplify-merges must be present');
  });
});

describe('StashTagHistoryOps.getLog — parent-count filter', () => {
  it('adds --min-parents=2 when minParents is 2', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { minParents: 2 });
    assert.ok(calls[0].includes('--min-parents=2'), '--min-parents=2 must be present');
  });

  it('adds --max-parents=1 when maxParents is 1', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { maxParents: 1 });
    assert.ok(calls[0].includes('--max-parents=1'), '--max-parents=1 must be present');
  });

  it('adds --min-parents=0 when minParents is 0 (explicit, not skipped)', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { minParents: 0 });
    assert.ok(calls[0].includes('--min-parents=0'), '--min-parents=0 must be present');
  });
});

describe('StashTagHistoryOps.getLog — range filter', () => {
  it('adds the range as a positional arg and does not add --all', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { logRange: 'main..feature' });
    assert.ok(calls[0].includes('main..feature'), 'range must be a positional arg');
    assert.ok(!calls[0].includes('--all'), '--all must not be present with a range');
  });

  it('passes a three-dot symmetric range through verbatim', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { logRange: 'main...feature' });
    assert.ok(calls[0].includes('main...feature'), 'symmetric range passed through');
  });

  it('errs when the range starts with "." (invalid per git-check-ref-format)', async () => {
    const { ops } = makeOps();
    const result = await ops.getLog(repo, { logRange: '.bad-range' });
    assert.ok(result.isErr());
    assert.match(result._unsafeUnwrapErr().message, /Invalid log range/);
  });

  it('errs when the range starts with "-" (would smuggle a CLI flag)', async () => {
    const { ops } = makeOps();
    const result = await ops.getLog(repo, { logRange: '-bad' });
    assert.ok(result.isErr());
    assert.match(result._unsafeUnwrapErr().message, /Invalid log range/);
  });
});
