/**
 * Interior-segment `-` guard for `getLog` and `getLogCount` refs.
 *
 * The existing check rejects refs whose FULL name starts with `-` (which would
 * smuggle a CLI flag). But a ref like `origin/-flag` does not start with `-`,
 * so the outer `ref.startsWith('-')` guard misses it. Any `/`-separated
 * SEGMENT starting with `-` is equally suspect: git-check-ref-format permits
 * refs with such components, but they represent an unusual construction that is
 * unlikely to be legitimate user input in this context.
 *
 * The fix: also check `ref.split('/').some(seg => seg.startsWith('-'))`.
 *
 * getLog returns ResultAsync, so tests await the result and check isErr()
 * rather than using assert.rejects (which requires a Promise).
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

describe('StashTagHistoryOps.getLog — interior -segment rejection in refs', () => {
  it('rejects a ref whose first segment starts with - (leading-dash ref)', async () => {
    const { ops } = makeOps();
    const result = await ops.getLog(repo, { ref: '-flag' });
    assert.ok(result.isErr(), 'leading-dash ref must return an error Result');
    assert.match(result._unsafeUnwrapErr().message, /Invalid ref/);
  });

  it('rejects a ref where an interior segment starts with - (e.g. origin/-flag)', async () => {
    const { ops } = makeOps();
    const result = await ops.getLog(repo, { ref: 'origin/-flag' });
    assert.ok(result.isErr(), 'interior -segment ref must return an error Result');
    assert.match(result._unsafeUnwrapErr().message, /Invalid ref/);
  });

  it('rejects a ref where a deep interior segment starts with - (e.g. refs/heads/-bad)', async () => {
    const { ops } = makeOps();
    const result = await ops.getLog(repo, { ref: 'refs/heads/-bad' });
    assert.ok(result.isErr(), 'deep interior -segment ref must return an error Result');
    assert.match(result._unsafeUnwrapErr().message, /Invalid ref/);
  });

  it('accepts a valid ref (main)', async () => {
    const { ops, calls } = makeOps();
    const result = await ops.getLog(repo, { ref: 'main' });
    assert.ok(result.isOk(), 'valid ref must succeed');
    assert.ok(calls[0].includes('main'), 'valid ref must be forwarded to git');
  });

  it('accepts a valid remote ref (origin/main)', async () => {
    const { ops, calls } = makeOps();
    const result = await ops.getLog(repo, { ref: 'origin/main' });
    assert.ok(result.isOk(), 'valid remote ref must succeed');
    assert.ok(calls[0].includes('origin/main'), 'valid remote ref must be forwarded to git');
  });
});

describe('StashTagHistoryOps.getLogCount — interior -segment rejection in refs', () => {
  it('rejects a ref where an interior segment starts with - (e.g. origin/-flag)', async () => {
    const { ops } = makeOps();
    const result = await ops.getLogCount(repo, { ref: 'origin/-flag' });
    assert.ok(result.isErr(), 'interior -segment ref must return an error Result in getLogCount');
    assert.match(result._unsafeUnwrapErr().message, /Invalid ref/);
  });

  it('accepts a valid ref in getLogCount (origin/main)', async () => {
    const { ops, calls } = makeOps();
    const result = await ops.getLogCount(repo, { ref: 'origin/main' });
    assert.ok(result.isOk(), 'valid remote ref must succeed in getLogCount');
    assert.ok(calls[0].includes('origin/main'), 'valid remote ref must be forwarded to git');
  });
});
