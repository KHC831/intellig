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
} from '../../../branches/BranchTreeProvider';
import {
  createMockGitService,
  attachedRepo,
  detachedRepo,
  emptyRepo,
  rebasingRepo,
  corruptRepo,
} from '../../mocks/mockGitService';
import type { IBranch } from '../../../git-core/interfaces/IGitService';

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

describe('Wave I H-3 — BranchTreeProvider.dispose()', () => {
  it('branchTree-dispose-1: dispose() unsubscribes from gitService.onDidChangeRepository', () => {
    const repo = attachedRepo();
    const gitService = createMockGitService(repo);
    // Pre-construction sanity: no subscribers yet.
    assert.strictEqual(gitService.changeRepositorySubscriberCount(), 0);

    const provider = new BranchTreeProvider(gitService);
    // After construction the provider has registered exactly one listener.
    assert.strictEqual(
      gitService.changeRepositorySubscriberCount(),
      1,
      'constructor must subscribe to onDidChangeRepository'
    );

    provider.dispose();
    // Post-dispose the listener is gone — proves the subscription was
    // captured AND torn down (pre-Wave-I leaked it).
    assert.strictEqual(
      gitService.changeRepositorySubscriberCount(),
      0,
      'dispose() must unsubscribe from onDidChangeRepository'
    );
  });

  it('branchTree-dispose-2: idempotent — double dispose is a no-op', () => {
    const repo = attachedRepo();
    const gitService = createMockGitService(repo);
    const provider = new BranchTreeProvider(gitService);

    provider.dispose();
    // Second call must NOT throw and must NOT crash the EventEmitter
    // (which is already disposed). The `_disposed` flag short-circuits.
    assert.doesNotThrow(() => provider.dispose());
    assert.strictEqual(gitService.changeRepositorySubscriberCount(), 0);
  });

  it('branchTree-dispose-3: post-dispose onDidChangeRepository fire is a no-op', () => {
    const repo = attachedRepo();
    const gitService = createMockGitService(repo);
    const provider = new BranchTreeProvider(gitService);

    let onDidChangeFireCount = 0;
    const sub = provider.onDidChangeTreeData(() => {
      onDidChangeFireCount += 1;
    });

    // Pre-dispose: firing onDidChangeRepository on the gitService should
    // trigger the provider's refresh() → onDidChangeTreeData fire.
    gitService.fireChangeRepository(repo);
    assert.strictEqual(onDidChangeFireCount, 1, 'pre-dispose: refresh fires once');

    provider.dispose();

    // Post-dispose: firing onDidChangeRepository must be a no-op.
    // Even if the subscription somehow stayed alive, the `_disposed`
    // guard short-circuits.
    gitService.fireChangeRepository(repo);
    assert.strictEqual(onDidChangeFireCount, 1, 'post-dispose: no further refreshes');

    sub.dispose();
  });
});

/**
 * Wave J R1 / MED-3 — accessibilityInformation on the synthetic
 * detached-head BranchTreeItem so SR users hear the same meaning the
 * visible icon + tooltip convey to sighted users. VS Code's TreeView
 * reads `label + description` by default; the detached row's visible
 * label is `(HEAD detached at <sha>)` and the description is
 * `'detached'` — neither phrase is meaningful out of context. We
 * provide an explicit `accessibilityInformation.label` that names
 * "Detached HEAD" upfront and includes the short SHA.
 */
describe('Wave J R1 / MED-3 — detached HEAD row accessibility', () => {
  it('branchTree-detached-aria-1: detached row exposes accessibilityInformation.label naming "Detached HEAD" + shortSha', async () => {
    const repo = detachedRepo(FULL_SHA);
    const gitService = createMockGitService(repo);
    const provider = new BranchTreeProvider(gitService);
    provider.setRepository(repo);

    const items = await localBranchesFromTree(provider);
    assert.strictEqual(items.length, 1, 'one item: the detached row');
    const row = items[0];
    assert.strictEqual(
      row.itemType,
      'detached-head',
      'pre-condition: row must be the detached-head row'
    );

    // The TreeItem MUST carry accessibilityInformation. VS Code reads
    // `accessibilityInformation.label` (when set) instead of `label +
    // description`, so this is the SR-narrated phrase.
    assert.ok(row.accessibilityInformation, 'detached-head row must set accessibilityInformation');
    const aria = row.accessibilityInformation as { label: string; role?: string };
    assert.ok(
      aria.label.includes('Detached HEAD'),
      `accessibilityInformation.label must name "Detached HEAD"; got: ${aria.label}`
    );
    assert.ok(
      aria.label.includes(SHORT_SHA),
      `accessibilityInformation.label must include short SHA "${SHORT_SHA}"; got: ${aria.label}`
    );
    assert.ok(
      /not on a branch/i.test(aria.label),
      `accessibilityInformation.label must mention "not on a branch"; got: ${aria.label}`
    );
  });
});
