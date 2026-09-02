/**
 * Multi-select branch/path log filters: `getLog`/`getLogCount` must union
 * multiple refs (positional revisions → `git log <refA> <refB>` = any) and
 * multiple paths (`-- pathA pathB` = commits touching any), guarding each ref
 * against a leading `-`/`.` exactly as the single-ref path does.
 */

import '../../setup';
import * as assert from 'assert';
import { StashTagHistoryOps } from '../../../src/git-core/ops/StashTagHistoryOps';
import { IGitOpsContext } from '../../../src/git-core/ops/GitOpsContext';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { pathspecTarget } from '../../helpers/pathspec';

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

/** Positional revisions are the args after the flags and before any `--`. */
function positionalRevs(args: string[]): string[] {
  const dd = args.indexOf('--');
  const end = dd === -1 ? args.length : dd;
  return args.slice(1, end).filter((a) => !a.startsWith('-'));
}

function pathspecs(args: string[]): string[] {
  const dd = args.indexOf('--');
  return dd === -1 ? [] : args.slice(dd + 1).map(pathspecTarget);
}

describe('getLog — multi-select branches (union)', () => {
  it('pushes every ref as a positional revision', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { refs: ['feature/x', 'main'] });
    assert.deepStrictEqual(positionalRevs(calls[0]), ['feature/x', 'main']);
  });

  it('still accepts the single legacy `ref`', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { ref: 'feature/x' });
    assert.deepStrictEqual(positionalRevs(calls[0]), ['feature/x']);
  });

  it('rejects a ref that could smuggle a flag (leading `-`/`.`) — Err, no exec', async () => {
    const { ops, calls } = makeOps();
    const r = await ops.getLog(repo, { refs: ['main', '--upload-pack=evil'] });
    assert.ok(r.isErr(), 'a flag-smuggling ref must yield an Err');
    const r2 = await ops.getLog(repo, { refs: ['.hidden'] });
    assert.ok(r2.isErr(), 'a leading-dot ref must yield an Err');
    assert.strictEqual(calls.length, 0, 'guard short-circuits before any git exec');
  });
});

describe('getLog — multi-select paths (union)', () => {
  it('pushes every path after `--`', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { paths: ['src/a.ts', 'src/b.ts'] });
    assert.deepStrictEqual(pathspecs(calls[0]), ['src/a.ts', 'src/b.ts']);
    assert.ok(calls[0].includes('--full-history') && calls[0].includes('--simplify-merges'));
  });
});

describe('getLog/getLogCount — matchNothing short-circuit (no branches selected)', () => {
  it('returns an empty list and zero count without spawning git', async () => {
    const { ops, calls } = makeOps();
    const commits = await ops.getLog(repo, { matchNothing: true });
    const count = await ops.getLogCount(repo, { matchNothing: true });
    assert.deepStrictEqual(commits.unwrapOr(['x']), [], 'no commits for matchNothing');
    assert.strictEqual(count.unwrapOr(-1), 0, 'zero count for matchNothing');
    assert.strictEqual(calls.length, 0, 'matchNothing never invokes git');
  });
});

describe('getLogCount — mirrors the multi-select union', () => {
  it('unions refs (no HEAD anchor) and paths like getLog', async () => {
    const { ops, calls } = makeOps();
    await ops.getLogCount(repo, { refs: ['feature/x', 'main'], paths: ['src/a.ts', 'src/b.ts'] });
    assert.deepStrictEqual(positionalRevs(calls[0]), ['feature/x', 'main']);
    assert.ok(!calls[0].includes('HEAD'), 'refs present → no HEAD anchor');
    assert.deepStrictEqual(pathspecs(calls[0]), ['src/a.ts', 'src/b.ts']);
  });

  it('still anchors HEAD when there is no ref scope', async () => {
    const { ops, calls } = makeOps();
    await ops.getLogCount(repo, {});
    assert.ok(calls[0].includes('HEAD'), 'no scope → HEAD anchor');
  });
});
