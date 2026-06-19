/**
 * Graph page scope parity — `buildLogScope` / `fetchGraphPage`.
 *
 * The loaded list (`getLog`) and the honest total (`getLogCount`) MUST be
 * computed under the identical refs/filter scope; any divergence makes the
 * "X of Y" indicator lie and can leave `hasMore` permanently true (an endless
 * load-more spinner). These specs pin that single-source guarantee:
 *   - `buildLogScope` maps each UI filter to the right git scope field;
 *   - `fetchGraphPage` passes the SAME scope object to BOTH git calls, with the
 *     window/ordering options living only on the log fetch.
 */

import '../../setup';
import * as assert from 'assert';
import { buildLogScope, fetchGraphPage } from '../../../registration/graphLogPage';
import type { ILogScopeFilter } from '../../../registration/graphLogPage';
import type { ICommit, IGitService, IRepository } from '../../../git-core/interfaces/IGitService';

const repo = { rootUri: { fsPath: '/r' } } as unknown as IRepository;

describe('buildLogScope — UI filter → git scope mapping', () => {
  it('walks all refs when no branch/range filter is set', () => {
    assert.strictEqual(buildLogScope(undefined).all, true);
    assert.strictEqual(buildLogScope({}).all, true);
  });

  it('scopes to a branch ref and suppresses --all', () => {
    const s = buildLogScope({ branch: 'feature/x' });
    assert.strictEqual(s.all, false);
    assert.strictEqual(s.ref, 'feature/x');
  });

  it('scopes to a range and suppresses --all', () => {
    const s = buildLogScope({ logRange: 'main..feature' });
    assert.strictEqual(s.all, false);
    assert.strictEqual(s.logRange, 'main..feature');
  });

  it('maps searchText→grep, searchRegex→regex, searchCaseSensitive→caseSensitive', () => {
    const s = buildLogScope({ searchText: 'fix', searchRegex: true, searchCaseSensitive: true });
    assert.strictEqual(s.grep, 'fix');
    assert.strictEqual(s.regex, true);
    assert.strictEqual(s.caseSensitive, true);
  });

  it('carries author/since/until/path/parent-count filters verbatim', () => {
    const since = new Date('2024-01-01');
    const until = new Date('2024-02-01');
    const s = buildLogScope({
      author: 'alice',
      since,
      until,
      path: 'src/a.ts',
      minParents: 2,
      maxParents: 2,
      noMerges: true,
      firstParent: true,
      simplifyMerges: true,
    });
    assert.strictEqual(s.author, 'alice');
    assert.strictEqual(s.since, since);
    assert.strictEqual(s.until, until);
    assert.strictEqual(s.path, 'src/a.ts');
    assert.strictEqual(s.minParents, 2);
    assert.strictEqual(s.maxParents, 2);
    assert.strictEqual(s.noMerges, true);
    assert.strictEqual(s.firstParent, true);
    assert.strictEqual(s.simplifyMerges, true);
  });
});

interface Spy {
  gitService: Pick<IGitService, 'getLog' | 'getLogCount'>;
  logArgs: Record<string, unknown>[];
  countArgs: Record<string, unknown>[];
}

function makeSpy(total = 42): Spy {
  const logArgs: Record<string, unknown>[] = [];
  const countArgs: Record<string, unknown>[] = [];
  const gitService = {
    getLog: async (_r: IRepository, opts?: Record<string, unknown>): Promise<ICommit[]> => {
      logArgs.push(opts ?? {});
      return [];
    },
    getLogCount: async (_r: IRepository, opts?: Record<string, unknown>): Promise<number> => {
      countArgs.push(opts ?? {});
      return total;
    },
  } as unknown as Pick<IGitService, 'getLog' | 'getLogCount'>;
  return { gitService, logArgs, countArgs };
}

/** The window/ordering keys that live ONLY on the log fetch, not the count. */
function stripWindow(opts: Record<string, unknown>): Record<string, unknown> {
  const { maxCount: _m, topoOrder: _t, ...scope } = opts;
  void _m;
  void _t;
  return scope;
}

describe('fetchGraphPage — getLog and getLogCount consume the identical scope', () => {
  const representativeFilters: Array<[string, ILogScopeFilter | undefined]> = [
    ['no filter (all refs)', undefined],
    ['author', { author: 'alice' }],
    ['since', { since: new Date('2024-01-01') }],
    ['grep', { searchText: 'fix', searchRegex: true, searchCaseSensitive: true }],
    ['branch', { branch: 'feature/x' }],
    ['range', { logRange: 'main..feature' }],
    ['path', { path: 'src/a.ts' }],
  ];

  for (const [name, filter] of representativeFilters) {
    it(`scope parity for ${name}`, async () => {
      const spy = makeSpy(7);
      const page = await fetchGraphPage(spy.gitService, repo, filter, 500);

      assert.strictEqual(spy.logArgs.length, 1, 'getLog called once');
      assert.strictEqual(spy.countArgs.length, 1, 'getLogCount called once');

      // The log fetch carries the window + ordering; the count must not.
      assert.strictEqual(spy.logArgs[0].maxCount, 500, 'log fetch is windowed');
      assert.strictEqual(spy.logArgs[0].topoOrder, true, 'log fetch is topo-ordered');
      assert.ok(!('maxCount' in spy.countArgs[0]), 'count is NOT windowed');
      assert.ok(!('topoOrder' in spy.countArgs[0]), 'count is NOT ordering-scoped');

      // Same refs/filter SET drives both — the parity the indicator depends on.
      assert.deepStrictEqual(
        stripWindow(spy.logArgs[0]),
        spy.countArgs[0],
        `getLog and getLogCount must share the exact scope for ${name}`
      );

      assert.strictEqual(page.totalAvailable, 7, 'total threads through from getLogCount');
    });
  }

  it('degrades to undefined total (no spinner) when the count throws', async () => {
    const gitService = {
      getLog: async (): Promise<ICommit[]> => [],
      getLogCount: async (): Promise<number> => {
        throw new Error('rev-list blew up');
      },
    } as unknown as Pick<IGitService, 'getLog' | 'getLogCount'>;
    const page = await fetchGraphPage(gitService, repo, undefined, 500);
    assert.strictEqual(page.totalAvailable, undefined);
  });
});
