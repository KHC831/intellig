import * as fc from 'fast-check';
import * as assert from 'assert';
import type { ICommit } from '../../src/git-core/interfaces/IGitService';
import {
  headHashSet,
  selectIncomingCommits,
} from '../../src/git-core/gitToolWindow/tabs/IncomingTab';

/**
 * Property-based tests for the Incoming tab's commit selection (Workstream C
 * Item 4).
 *
 * Property: the incoming commit list is EXACTLY the set of upstream commits
 * whose hash is not reachable from HEAD — i.e. a pure set difference. This must
 * hold for any partition of hashes into "shared", "upstream-only", and
 * "head-only" buckets, and must preserve the upstream's ordering.
 */
describe('Incoming commit selection property tests', () => {
  function commit(hash: string): ICommit {
    return {
      hash,
      shortHash: hash.slice(0, 7),
      message: `m-${hash}`,
      author: { name: 'A', email: 'a@x' },
      committer: { name: 'A', email: 'a@x' },
      parents: [],
      authorDate: new Date(0),
      commitDate: new Date(0),
    };
  }

  const hashArb = fc.hexaString({ minLength: 4, maxLength: 12 });

  it('returns exactly the upstream commits absent from HEAD', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(hashArb, { minLength: 0, maxLength: 20 }),
        fc.uniqueArray(hashArb, { minLength: 0, maxLength: 20 }),
        (sharedRaw, upstreamOnlyRaw) => {
          // Ensure disjoint buckets.
          const shared = sharedRaw.filter((h) => !upstreamOnlyRaw.includes(h));
          const upstreamOnly = upstreamOnlyRaw;

          // Upstream log = upstream-only commits on top of shared base.
          const upstreamLog = [...upstreamOnly, ...shared].map(commit);
          // HEAD log = shared base (+ possibly head-only commits, irrelevant).
          const headLog = shared.map(commit);

          const result = selectIncomingCommits(upstreamLog, headHashSet(headLog));
          const resultHashes = result.map((c) => c.hash);

          // 1. Every result hash is upstream-only (not in HEAD).
          for (const h of resultHashes) {
            assert.ok(!shared.includes(h), `result ${h} must not be in HEAD's shared set`);
          }
          // 2. The result is exactly the upstream-only set.
          assert.deepStrictEqual(new Set(resultHashes), new Set(upstreamOnly));
          // 3. Order is preserved relative to the upstream log.
          const upstreamOrder = upstreamLog.map((c) => c.hash).filter((h) => !shared.includes(h));
          assert.deepStrictEqual(resultHashes, upstreamOrder);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('is empty when the upstream is fully contained in HEAD', () => {
    fc.assert(
      fc.property(fc.uniqueArray(hashArb, { minLength: 0, maxLength: 20 }), (hashes) => {
        const upstreamLog = hashes.map(commit);
        const headLog = hashes.map(commit);
        assert.deepStrictEqual(selectIncomingCommits(upstreamLog, headHashSet(headLog)), []);
      }),
      { numRuns: 100 }
    );
  });
});
