/**
 * Wave H — `BranchTreeProvider` detached-HEAD synthetic row.
 *
 * Wave G shipped a yellow/gold HEAD chip on the commit graph for
 * detached state. The Branches tree sidebar (this widget) was the
 * matching gap: pre-Wave-H, detached HEAD rendered no row in the tree
 * at all, so the user couldn't see WHERE HEAD lived from the
 * sidebar. IntelliJ shows a `(HEAD detached at <sha>)` row at the top
 * of Local Branches.
 *
 * Wave H adds:
 *   - New `BranchTreeItemType: 'detached-head'`
 *   - New `CONTEXT_VALUES.DETACHED_HEAD: 'intellig.detachedHead'`
 *   - 7th constructor arg `detachedHeadSha` + `getDetachedHeadSha()` accessor
 *   - Synthetic row prepended to `_getLocalBranches()` when
 *     `head.name === undefined && head.commit !== undefined`
 *
 * The 5 fixtures below pin: canonical detached, detached + branches,
 * attached, empty repo, mid-rebase. Each guards a specific edge case
 * called out in the tech-lead's risk analysis (TH-R1..TH-R11).
 *
 * Type extension (NOT fake-IBranch) is deliberate — the dispatcher
 * reads the SHA via `item.getDetachedHeadSha()`, never the
 * parenthesized label. Wave F regression class can't be resurrected.
 */

import '../../setup';
import * as assert from 'assert';
import {
  BranchTreeProvider,
  CONTEXT_VALUES,
  type BranchTreeItem,
} from '../../../services/BranchTreeProvider';
import {
  createMockGitService,
  attachedRepo,
  detachedRepo,
  emptyRepo,
  rebasingRepo,
  corruptRepo,
} from '../../mocks/mockGitService';
import type { IBranch } from '../../../services/interfaces/IGitService';

const FULL_SHA = 'abc1234567890abcdef1234567890abcdef12345';
const SHORT_SHA = 'abc1234';

function localBranchesFromTree(provider: BranchTreeProvider): Promise<BranchTreeItem[]> {
  return provider.getChildren().then((rootChildren) => {
    const localCategory = rootChildren.find((c) => c.label === 'Local Branches');
    if (!localCategory) {
      throw new Error('Local Branches category missing');
    }
    return provider.getChildren(localCategory);
  });
}

describe('Wave H — BranchTreeProvider detached HEAD row', () => {
  it('branchTree-detached-1: canonical detached state → detached row appears with correct shape', async () => {
    const repo = detachedRepo(FULL_SHA);
    const gitService = createMockGitService(repo);
    const provider = new BranchTreeProvider(gitService);
    provider.setRepository(repo);

    const items = await localBranchesFromTree(provider);

    assert.strictEqual(items.length, 1, 'one item: the detached row');
    const row = items[0];
    assert.strictEqual(row.label, `(HEAD detached at ${SHORT_SHA})`);
    assert.strictEqual(row.itemType, 'detached-head');
    assert.strictEqual(row.contextValue, CONTEXT_VALUES.DETACHED_HEAD);
    assert.strictEqual(row.isCurrentBranch, true);
    assert.strictEqual(row.getDetachedHeadSha(), FULL_SHA);
  });

  it('branchTree-detached-2: detached + 2 normal local branches → detached row FIRST, branches after', async () => {
    const repo = detachedRepo(FULL_SHA);
    const branches: IBranch[] = [
      { name: 'main', type: 'local', commit: 'b'.repeat(40), isHead: false },
      { name: 'feature', type: 'local', commit: 'c'.repeat(40), isHead: false },
    ];
    const gitService = createMockGitService(repo, { getBranches: async () => branches });
    const provider = new BranchTreeProvider(gitService);
    provider.setRepository(repo);

    const items = await localBranchesFromTree(provider);

    assert.strictEqual(items.length, 3);
    assert.strictEqual(items[0].itemType, 'detached-head');
    assert.strictEqual(items[1].itemType, 'local-branch');
    assert.strictEqual(items[1].label, 'main');
    assert.strictEqual(items[2].itemType, 'local-branch');
    assert.strictEqual(items[2].label, 'feature');
  });

  it('branchTree-detached-3: attached state → NO detached row; only branches', async () => {
    const repo = attachedRepo('main', 'b'.repeat(40));
    const branches: IBranch[] = [
      { name: 'main', type: 'local', commit: 'b'.repeat(40), isHead: true },
    ];
    const gitService = createMockGitService(repo, { getBranches: async () => branches });
    const provider = new BranchTreeProvider(gitService);
    provider.setRepository(repo);

    const items = await localBranchesFromTree(provider);

    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].itemType, 'local-branch');
    assert.strictEqual(items[0].label, 'main');
    assert.strictEqual(items[0].isCurrentBranch, true);
    assert.strictEqual(items.filter((i) => i.itemType === 'detached-head').length, 0);
  });

  it('branchTree-detached-4: empty repo (head undefined) → empty list, no detached row', async () => {
    const repo = emptyRepo();
    const gitService = createMockGitService(repo);
    const provider = new BranchTreeProvider(gitService);
    provider.setRepository(repo);

    const items = await localBranchesFromTree(provider);

    assert.strictEqual(items.length, 0, 'empty repo → no items at all');
  });

  it('branchTree-detached-5: mid-rebase (head.name still set) → NO detached row', async () => {
    const repo = rebasingRepo('main', 'b'.repeat(40));
    const branches: IBranch[] = [
      { name: 'main', type: 'local', commit: 'b'.repeat(40), isHead: true },
    ];
    const gitService = createMockGitService(repo, { getBranches: async () => branches });
    const provider = new BranchTreeProvider(gitService);
    provider.setRepository(repo);

    const items = await localBranchesFromTree(provider);

    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].itemType, 'local-branch');
    assert.strictEqual(
      items.filter((i) => i.itemType === 'detached-head').length,
      0,
      'mid-rebase must NOT show detached row (head.name is still set)'
    );
  });

  it('branchTree-detached-6: corrupt repo (head.name undefined + head.commit empty string) → NO detached row', async () => {
    // Wave H R1 / SHL-1 — pre-R1 the guard `head.commit !== undefined`
    // was trivially true once `head` was set, because `parseHead` always
    // sets `head.commit = commitOutput.trim()` (an empty string when git
    // returned nothing). That produced a `(HEAD detached at )` row with
    // an empty 7-char SHA in the tree. R1 tightens the guard to require
    // `head.commit.length > 0`.
    const repo = corruptRepo();
    const gitService = createMockGitService(repo);
    const provider = new BranchTreeProvider(gitService);
    provider.setRepository(repo);

    const items = await localBranchesFromTree(provider);

    assert.strictEqual(items.length, 0, 'corrupt repo → no detached row');
    assert.strictEqual(
      items.filter((i) => i.itemType === 'detached-head').length,
      0,
      'empty-commit corrupt state must NOT render the detached row'
    );
  });
});
