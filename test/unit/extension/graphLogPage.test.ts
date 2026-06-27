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
import {
  buildLogScope,
  fetchGraphPage,
  parseHashQuery,
} from '../../../src/registration/graphLogPage';
import type { ILogScopeFilter } from '../../../src/registration/graphLogPage';
import type {
  ICommit,
  IGitService,
  IRepository,
} from '../../../src/git-core/interfaces/IGitService';

const repo = { rootUri: { fsPath: '/r' } } as unknown as IRepository;

describe('buildLogScope — UI filter → git scope mapping', () => {
  it('walks all refs when no branch/range filter is set', () => {
    assert.strictEqual(buildLogScope(undefined).all, true);
    assert.strictEqual(buildLogScope({}).all, true);
  });

  it('scopes to a branch ref and suppresses --all', () => {
    const s = buildLogScope({ branch: 'feature/x' });
    assert.strictEqual(s.all, false);
    assert.deepStrictEqual(s.refs, ['feature/x']);
  });

  it('scopes to MULTIPLE branches (union) and suppresses --all', () => {
    const s = buildLogScope({ branches: ['feature/x', 'main'] });
    assert.strictEqual(s.all, false);
    assert.deepStrictEqual(s.refs, ['feature/x', 'main']);
  });

  it('maps the explicit "no branches" state to matchNothing (not --all)', () => {
    const s = buildLogScope({ branchesNone: true });
    assert.strictEqual(s.matchNothing, true, 'none must short-circuit to an empty result');
    assert.strictEqual(s.all, false, 'matchNothing is not the walk-all state');
    assert.strictEqual(s.refs, undefined);
  });

  it('folds a single legacy branch in with multi-select branches', () => {
    const s = buildLogScope({ branches: ['feature/x'], branch: 'main' });
    assert.deepStrictEqual(s.refs, ['feature/x', 'main']);
  });

  it('scopes to MULTIPLE paths (union)', () => {
    const s = buildLogScope({ paths: ['src/a.ts', 'src/b.ts'] });
    assert.deepStrictEqual(s.paths, ['src/a.ts', 'src/b.ts']);
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
    assert.strictEqual(s.hashes, undefined, 'a message search is not a hash filter');
  });

  it('treats a 7-40 hex searchText as a hash filter (not a message grep)', () => {
    // The "Message or hash" box: a hash query becomes a HASH_FILTER, matching
    // IntelliJ TextFilterModel (VcsLogUtil.HASH_REGEX = [a-fA-F0-9]{7,40}).
    const s = buildLogScope({ searchText: '1142593' });
    assert.deepStrictEqual(s.hashes, ['1142593'], 'hex query → hashes');
    assert.strictEqual(s.grep, undefined, 'hash query must NOT also grep the message');
    assert.strictEqual(s.all, false, 'a hash filter scopes to the named commits');
  });

  it('supports multiple space-separated hashes', () => {
    const s = buildLogScope({ searchText: 'deadbee 0badf00d' });
    assert.deepStrictEqual(s.hashes, ['deadbee', '0badf00d']);
    assert.strictEqual(s.grep, undefined);
  });

  it('does not treat short or non-hex text as a hash', () => {
    assert.strictEqual(buildLogScope({ searchText: 'abc123' }).hashes, undefined, '6 chars < 7');
    assert.strictEqual(buildLogScope({ searchText: 'feature' }).hashes, undefined, 'has non-hex');
    assert.strictEqual(buildLogScope({ searchText: 'fix bug' }).hashes, undefined, 'message');
  });
});

describe('parseHashQuery — IntelliJ VcsLogUtil.HASH_REGEX parity', () => {
  it('accepts a single 7-40 hex word', () => {
    assert.deepStrictEqual(parseHashQuery('1142593'), ['1142593']);
    assert.deepStrictEqual(parseHashQuery('ABCDEF0'), ['ABCDEF0']); // case-insensitive
    assert.deepStrictEqual(parseHashQuery('a'.repeat(40)), ['a'.repeat(40)]);
  });
  it('accepts multiple hex words separated by whitespace', () => {
    assert.deepStrictEqual(parseHashQuery('  deadbee\t0badf00d '), ['deadbee', '0badf00d']);
  });
  it('rejects < 7 hex, > 40 hex, non-hex, empty, and mixed', () => {
    assert.strictEqual(parseHashQuery('abc123'), undefined); // 6
    assert.strictEqual(parseHashQuery('a'.repeat(41)), undefined); // 41
    assert.strictEqual(parseHashQuery('feature'), undefined); // non-hex
    assert.strictEqual(parseHashQuery(''), undefined);
    assert.strictEqual(parseHashQuery('   '), undefined);
    assert.strictEqual(parseHashQuery('deadbee notahex'), undefined); // one word fails
  });
});

describe('buildLogScope — verbatim filter fields', () => {
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
    assert.deepStrictEqual(s.paths, ['src/a.ts']);
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
    ['branches (union)', { branches: ['feature/x', 'main'] }],
    ['range', { logRange: 'main..feature' }],
    ['path', { path: 'src/a.ts' }],
    ['paths (union)', { paths: ['src/a.ts', 'src/b.ts'] }],
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

      assert.strictEqual(await page.totalAvailable, 7, 'total threads through from getLogCount');
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
    assert.strictEqual(await page.totalAvailable, undefined);
  });
});
