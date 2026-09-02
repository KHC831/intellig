/**
 * `groupBranchFilterOptions` folds per-repo branch lists into the Log
 * filter's Branch popup shape. Every level the Branches tree also orders
 * (local names, remote headers, each remote's branches) must sort by the
 * SAME comparator the tree uses (compareRefNames) — a bare `.sort()` orders
 * by code unit and puts every capitalised name ahead of every lowercase one,
 * so mixing it with a locale-aware sort orders halves of the same popup by
 * different rules.
 */

import '../../setup';
import * as assert from 'assert';
import { groupBranchFilterOptions } from '../../../src/git-core/gitToolWindow/provider/loadedGraphQueries';
import { compareRefNames } from '../../../src/utils/refNameSort';

describe('groupBranchFilterOptions — ordering', () => {
  it("orders local branches, remote headers, and each remote's branches by compareRefNames", () => {
    const perRepoBranches = [
      [
        { name: 'Backup', type: 'local' },
        { name: 'fork', type: 'local' },
        { name: 'Upstream', type: 'local' },
        { name: 'upstream', type: 'local' },
        { name: 'Backup/x', type: 'remote' },
        { name: 'Upstream/a', type: 'remote' },
        { name: 'fork/z', type: 'remote' },
        { name: 'upstream/y', type: 'remote' },
      ],
    ];

    const groups = groupBranchFilterOptions(perRepoBranches);

    assert.deepStrictEqual(
      groups.local,
      [...groups.local].sort(compareRefNames),
      'local branches must sort by the shared locale-aware comparator, not code-unit order'
    );

    const headers = groups.remotes.map((g) => g.remote);
    assert.deepStrictEqual(
      headers,
      [...headers].sort(compareRefNames),
      'remote headers must sort by the shared comparator'
    );

    for (const g of groups.remotes) {
      assert.deepStrictEqual(
        g.branches,
        [...g.branches].sort(compareRefNames),
        `branches under remote "${g.remote}" must sort by the shared comparator`
      );
    }

    // Concrete divergence between code-unit and locale order, so the
    // assertions above cannot pass by accident when both orders coincide.
    assert.notDeepStrictEqual(
      [...groups.local].sort(),
      [...groups.local].sort(compareRefNames),
      'precondition: this name set must actually distinguish the two orderings'
    );
  });
});
