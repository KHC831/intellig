/**
 * `BranchTreeProvider` detached-HEAD synthetic row.
 *
 * Shipped a yellow/gold HEAD chip on the commit graph for
 * detached state. The Branches tree sidebar (this widget) was the
 * matching gap:, detached HEAD rendered no row in the tree
 * at all, so the user couldn't see WHERE HEAD lived from the
 * sidebar. IntelliJ shows a `(HEAD detached at <sha>)` row at the top
 * of Local Branches.
 *
 * Adds:
 *   - New `BranchTreeItemType: 'detached-head'`
 *   - New `CONTEXT_VALUES.DETACHED_HEAD: 'intellig.detachedHead'`
 *   - 7th constructor arg `detachedHeadSha` + `getDetachedHeadSha()` accessor
 *   - Synthetic row prepended to `_getLocalBranches()` when
 *     `head.name === undefined && head.commit !== undefined`
 *
 * The 5 fixtures below pin: canonical detached, detached + branches,
 * attached, empty repo, mid-rebase. Each guards a specific edge case
 * from the detached-HEAD risk analysis.
 *
 * Type extension (NOT fake-IBranch) is deliberate — the dispatcher
 * reads the SHA via `item.getDetachedHeadSha()`, never the
 * parenthesized label. Regression class can't be resurrected.
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
    const localCategory = rootChildren.find((c) => c.label === 'Local');
    if (!localCategory) {
      throw new Error('Local category missing');
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
    // Folder grouping (UI fix #37) alpha-sorts leaves, so "feature"
    // comes before "main" — IntelliJ parity. The detached row stays
    // anchored at the top regardless.
    assert.strictEqual(items[1].itemType, 'local-branch');
    assert.strictEqual(items[1].label, 'feature');
    assert.strictEqual(items[2].itemType, 'local-branch');
    assert.strictEqual(items[2].label, 'main');
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
    // Earlier the guard `head.commit !== undefined`
    // was trivially true once `head` was set, because `parseHead` always
    // sets `head.commit = commitOutput.trim()` (an empty string when git
    // returned nothing). That produced a `(HEAD detached at )` row with
    // an empty 7-char SHA in the tree. Tightens the guard to require
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
    // captured AND torn down (leaked it).
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
 * accessibilityInformation on the synthetic
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

/**
 * UI fix #37 — IntelliJ-parity nesting of BRANCHES tree by `/`-prefix.
 *
 * Previously the tree rendered a flat `feature/auth/login` row.
 * Now: branches with `/` in their names group into folder rows. The
 * folder is `branch-folder` itemType, expandable, holding either
 * further folder children or leaf branch rows whose label is just the
 * trailing path segment.
 *
 * For Remotes, a synthetic top folder per remote name (origin,
 * upstream, …) wraps that remote's branches; the folder structure
 * underneath mirrors the local tree.
 *
 * These tests pin the tree shape at each level. The FOLDER expansion
 * itself is exercised via a recursive walk so we cover the
 * `_getFolderChildren` path.
 */
describe('UI fix #37 — BranchTreeProvider folder grouping', () => {
  function repoWithBranches(branches: IBranch[]): {
    provider: BranchTreeProvider;
    repo: ReturnType<typeof attachedRepo>;
  } {
    const repo = attachedRepo('main', 'b'.repeat(40));
    const gitService = createMockGitService(repo, { getBranches: async () => branches });
    const provider = new BranchTreeProvider(gitService);
    provider.setRepository(repo);
    return { provider, repo };
  }

  it('groups feature/* branches into a single "feature" folder', async () => {
    const { provider } = repoWithBranches([
      { name: 'main', type: 'local', commit: 'a'.repeat(40), isHead: true },
      { name: 'feature/auth', type: 'local', commit: 'b'.repeat(40), isHead: false },
      { name: 'feature/billing', type: 'local', commit: 'c'.repeat(40), isHead: false },
    ]);

    const items = await localBranchesFromTree(provider);
    // Expect: folder "feature" first (alpha < "main"), then leaf "main".
    assert.strictEqual(
      items.length,
      2,
      `expected one folder + one leaf; got: ${items.map((i) => i.label).join(',')}`
    );
    assert.strictEqual(items[0].itemType, 'branch-folder');
    assert.strictEqual(items[0].label, 'feature');
    assert.strictEqual(items[0].folderPath, 'feature');
    assert.strictEqual(items[0].folderScope, 'local');
    assert.strictEqual(items[1].itemType, 'local-branch');
    assert.strictEqual(items[1].label, 'main');
    assert.strictEqual(items[1].isCurrentBranch, true);
  });

  it('expands the feature folder into its leaf branches (label = trailing segment only)', async () => {
    const { provider } = repoWithBranches([
      { name: 'main', type: 'local', commit: 'a'.repeat(40), isHead: true },
      { name: 'feature/auth', type: 'local', commit: 'b'.repeat(40), isHead: false },
      { name: 'feature/billing', type: 'local', commit: 'c'.repeat(40), isHead: false },
    ]);
    const items = await localBranchesFromTree(provider);
    const folder = items.find((i) => i.itemType === 'branch-folder' && i.label === 'feature');
    assert.ok(folder, 'feature folder must exist');

    const children = await provider.getChildren(folder);
    assert.strictEqual(children.length, 2);
    // Both children are leaves with the trailing-segment label only.
    assert.strictEqual(children[0].itemType, 'local-branch');
    assert.strictEqual(
      children[0].label,
      'auth',
      'label is the trailing segment, not the full path'
    );
    assert.strictEqual(
      children[0].branch?.name,
      'feature/auth',
      'branch ref carries the full name'
    );
    assert.strictEqual(children[1].itemType, 'local-branch');
    assert.strictEqual(children[1].label, 'billing');
    assert.strictEqual(children[1].branch?.name, 'feature/billing');
  });

  it('nests folders for paths with two or more `/` segments (feature/auth/login)', async () => {
    const { provider } = repoWithBranches([
      { name: 'feature/auth/login', type: 'local', commit: 'a'.repeat(40), isHead: false },
      { name: 'feature/auth/logout', type: 'local', commit: 'b'.repeat(40), isHead: false },
      { name: 'feature/billing', type: 'local', commit: 'c'.repeat(40), isHead: false },
    ]);

    const items = await localBranchesFromTree(provider);
    assert.strictEqual(items.length, 1);
    const featureFolder = items[0];
    assert.strictEqual(featureFolder.itemType, 'branch-folder');
    assert.strictEqual(featureFolder.folderPath, 'feature');

    const featureChildren = await provider.getChildren(featureFolder);
    // Folder "auth" first (alpha < "billing"), then leaf "billing".
    assert.strictEqual(featureChildren.length, 2);
    assert.strictEqual(featureChildren[0].itemType, 'branch-folder');
    assert.strictEqual(featureChildren[0].label, 'auth');
    assert.strictEqual(featureChildren[0].folderPath, 'feature/auth');
    assert.strictEqual(featureChildren[1].itemType, 'local-branch');
    assert.strictEqual(featureChildren[1].label, 'billing');

    const authChildren = await provider.getChildren(featureChildren[0]);
    assert.strictEqual(authChildren.length, 2);
    assert.strictEqual(authChildren[0].itemType, 'local-branch');
    assert.strictEqual(authChildren[0].label, 'login');
    assert.strictEqual(authChildren[0].branch?.name, 'feature/auth/login');
    assert.strictEqual(authChildren[1].label, 'logout');
  });

  it('groups remote branches by remote name then by `/` path', async () => {
    const { provider } = repoWithBranches([
      { name: 'origin/main', type: 'remote', commit: 'a'.repeat(40), isHead: false },
      { name: 'origin/feature/auth', type: 'remote', commit: 'b'.repeat(40), isHead: false },
      { name: 'origin/feature/billing', type: 'remote', commit: 'c'.repeat(40), isHead: false },
      { name: 'upstream/main', type: 'remote', commit: 'd'.repeat(40), isHead: false },
    ]);

    const rootChildren = await provider.getChildren();
    const remoteCategory = rootChildren.find((c) => c.label === 'Remote');
    assert.ok(remoteCategory, 'Remote category missing');
    const remoteRoots = await provider.getChildren(remoteCategory);

    // Top level under Remote: one folder per remote, sorted alpha.
    assert.strictEqual(remoteRoots.length, 2);
    assert.strictEqual(remoteRoots[0].itemType, 'branch-folder');
    assert.strictEqual(remoteRoots[0].label, 'origin');
    assert.strictEqual(remoteRoots[0].remotePrefix, 'origin');
    assert.strictEqual(remoteRoots[0].folderScope, 'remote');
    assert.strictEqual(remoteRoots[1].label, 'upstream');

    // Inside origin: "feature" folder + "main" leaf.
    const originChildren = await provider.getChildren(remoteRoots[0]);
    assert.strictEqual(originChildren.length, 2);
    assert.strictEqual(originChildren[0].itemType, 'branch-folder');
    assert.strictEqual(originChildren[0].label, 'feature');
    assert.strictEqual(originChildren[0].folderPath, 'feature');
    assert.strictEqual(originChildren[0].remotePrefix, 'origin');
    assert.strictEqual(originChildren[1].itemType, 'remote-branch');
    assert.strictEqual(originChildren[1].label, 'main');
    assert.strictEqual(originChildren[1].branch?.name, 'origin/main');

    // Inside origin/feature: two leaf remote branches.
    const featureChildren = await provider.getChildren(originChildren[0]);
    assert.strictEqual(featureChildren.length, 2);
    assert.strictEqual(featureChildren[0].itemType, 'remote-branch');
    assert.strictEqual(featureChildren[0].label, 'auth');
    assert.strictEqual(featureChildren[0].branch?.name, 'origin/feature/auth');
    assert.strictEqual(featureChildren[1].label, 'billing');
  });

  it('flat branches (no `/`) render as plain leaves with no folder wrapping', async () => {
    const { provider } = repoWithBranches([
      { name: 'main', type: 'local', commit: 'a'.repeat(40), isHead: true },
      { name: 'develop', type: 'local', commit: 'b'.repeat(40), isHead: false },
    ]);
    const items = await localBranchesFromTree(provider);
    assert.strictEqual(items.length, 2);
    assert.ok(items.every((i) => i.itemType === 'local-branch'));
    // Alpha-sorted.
    assert.strictEqual(items[0].label, 'develop');
    assert.strictEqual(items[1].label, 'main');
  });
});
