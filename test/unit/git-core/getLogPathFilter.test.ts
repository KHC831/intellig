/**
 * P1 parity fix — path-filtered `git log` must use full history.
 *
 * `getLog({ path })` filtered with a bare `-- <path>`, leaving git's default
 * history simplification on, which silently drops commits that touched the
 * path but sit off the simplified first-parent line (merges, side branches).
 * IntelliJ's file history is complete: add `--full-history --simplify-merges`
 * whenever a path filter is present.
 */

import '../../setup';
import * as assert from 'assert';
import { StashTagHistoryOps } from '../../../src/git-core/ops/StashTagHistoryOps';
import { IGitOpsContext } from '../../../src/git-core/ops/GitOpsContext';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { literalPathspec } from '../../../src/git-core/gitCli';

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

describe('StashTagHistoryOps.getLog — path filter full history (P1)', () => {
  it('adds --full-history --simplify-merges when filtering by path', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { path: 'src/foo.ts' });
    const args = calls[0];
    assert.ok(args.includes('--full-history'), '--full-history must be present');
    assert.ok(args.includes('--simplify-merges'), '--simplify-merges must be present');
    const sep = args.indexOf('--');
    assert.ok(
      sep !== -1 && args[sep + 1] === literalPathspec('src/foo.ts'),
      'pathspec follows -- separator'
    );
  });

  it('places a dash-leading path AFTER the -- separator so it cannot become a flag', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { path: '--output=/tmp/pwn' });
    const args = calls[0];
    const sep = args.indexOf('--');
    assert.ok(sep !== -1, 'a -- pathspec separator must be present');
    assert.strictEqual(
      args[sep + 1],
      literalPathspec('--output=/tmp/pwn'),
      'the path rides after --, never as a flag'
    );
    // No occurrence of the value BEFORE the separator (where it could be parsed as a flag).
    assert.ok(
      args.slice(0, sep).every((a) => a !== '--output=/tmp/pwn'),
      'the path value must not appear before the -- separator'
    );
  });

  it('omits history-simplification flags when there is no path filter', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { maxCount: 10 });
    const args = calls[0];
    assert.ok(!args.includes('--full-history'));
    assert.ok(!args.includes('--simplify-merges'));
  });

  it('scopes the log to a ref when one is given (cherry-pick picker)', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { maxCount: 50, ref: 'origin/feature' });
    const args = calls[0];
    assert.ok(args.includes('origin/feature'), 'the ref is passed as a revision arg');
    // No global --all when scoping to a single ref.
    assert.ok(!args.includes('--all'));
  });

  it('does not add a revision arg when no ref is given', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { maxCount: 50 });
    // Only the format/flags — no stray positional ref.
    assert.ok(!calls[0].some((a) => a === 'origin/feature'));
  });
});
