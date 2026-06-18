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
  type IFavoritesStore,
} from '../../../branches/BranchTreeProvider';
import {
  createMockGitService,
  attachedRepo,
  detachedRepo,
  emptyRepo,
  rebasingRepo,
  corruptRepo,
} from '../../mocks/mockGitService';
import type { IBranch, IRepository } from '../../../git-core/interfaces/IGitService';
import type { IncomingOutgoingFetcher } from '../../../branches/BranchPopup';
import type { IIncomingOutgoing } from '../../../git-core/ops/IncomingOutgoingOps';
import { repoDisplayName } from '../../../sync/updateProject';

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

/**
 * Tree-provider incoming/outgoing enrichment. The branch popup already shows
 * ↑N/↓N for tracked branches via an injected IncomingOutgoingFetcher; the tree
 * sidebar was the matching gap. When a fetcher is injected, tracked local
 * branches (those with an `upstream`) are enriched with ahead/behind counts so
 * the tree rows render the same badges. The fetcher maps incoming→behind (↓)
 * and outgoing→ahead (↑).
 */
describe('Wave D — BranchTreeProvider incoming/outgoing enrichment', () => {
  it('renders ↑outgoing/↓incoming on a tracked local branch when a fetcher is injected', async () => {
    const repo = attachedRepo('main', 'b'.repeat(40));
    const branches: IBranch[] = [
      {
        name: 'main',
        type: 'local',
        commit: 'b'.repeat(40),
        isHead: true,
        upstream: { remote: 'origin', name: 'main' },
      },
    ];
    const gitService = createMockGitService(repo, { getBranches: async () => branches });
    const fetcher: IncomingOutgoingFetcher = async (
      _repo: IRepository,
      branch: string
    ): Promise<IIncomingOutgoing> => ({ branch, incoming: 3, outgoing: 2, noUpstream: false });

    const provider = new BranchTreeProvider(gitService, fetcher);
    provider.setRepository(repo);

    const items = await localBranchesFromTree(provider);
    assert.strictEqual(items.length, 1);
    const desc = items[0].description;
    assert.strictEqual(typeof desc, 'string');
    assert.ok(
      (desc as string).includes('↑2'),
      `expected ↑2 (outgoing) in description; got: ${String(desc)}`
    );
    assert.ok(
      (desc as string).includes('↓3'),
      `expected ↓3 (incoming) in description; got: ${String(desc)}`
    );
  });

  it('leaves an untracked local branch (no upstream) un-enriched', async () => {
    const repo = attachedRepo('main', 'b'.repeat(40));
    const branches: IBranch[] = [
      { name: 'main', type: 'local', commit: 'b'.repeat(40), isHead: true },
    ];
    const gitService = createMockGitService(repo, { getBranches: async () => branches });
    let fetcherCalls = 0;
    const fetcher: IncomingOutgoingFetcher = async (
      _repo: IRepository,
      branch: string
    ): Promise<IIncomingOutgoing> => {
      fetcherCalls += 1;
      return { branch, incoming: 3, outgoing: 2, noUpstream: false };
    };

    const provider = new BranchTreeProvider(gitService, fetcher);
    provider.setRepository(repo);

    const items = await localBranchesFromTree(provider);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(fetcherCalls, 0, 'no fetch for a branch without an upstream');
    assert.ok(!(items[0].description as string).includes('↑'), 'no ↑ badge on an untracked branch');
  });

  it('renders no ↑/↓ badges when no fetcher is injected (back-compat)', async () => {
    const repo = attachedRepo('main', 'b'.repeat(40));
    const branches: IBranch[] = [
      {
        name: 'main',
        type: 'local',
        commit: 'b'.repeat(40),
        isHead: true,
        upstream: { remote: 'origin', name: 'main' },
      },
    ];
    const gitService = createMockGitService(repo, { getBranches: async () => branches });

    const provider = new BranchTreeProvider(gitService);
    provider.setRepository(repo);

    const items = await localBranchesFromTree(provider);
    assert.strictEqual(items.length, 1);
    assert.ok(
      !(items[0].description as string).includes('↑'),
      'no fetcher → no ahead/behind badges'
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

/**
 * D slice 2 — HEAD root node + favorites (git4idea parity).
 *
 * North star: `GitBranchesTreeModel` pins the current ref to the very top
 * of the tree (`getRefComparator`: `!isCurrentRefInAny` first) and starred
 * favorites next (`!isFavoriteInAll`). Favorite state is persisted per repo
 * in `GitRepositoryModel.favoriteRefs` (`GitFavoriteRefs`).
 *
 * Here we mirror that with:
 *   - a synthetic `'head'` root node showing the current branch at the very
 *     top (above Local/Remote/Tags), only when HEAD is attached;
 *   - a `Favorites` category listing starred local branches, only when at
 *     least one favorite exists;
 *   - `toggleFavorite` / `isFavorite` backed by an injected
 *     {@link IFavoritesStore} (Memento in production, in-memory double here)
 *     so favorites survive across sessions.
 */
describe('D slice 2 — BranchTreeProvider HEAD root node + favorites', () => {
  class InMemoryStore implements IFavoritesStore {
    private _data: string[];
    public writes = 0;
    constructor(initial: string[] = []) {
      this._data = [...initial];
    }
    read(): string[] {
      return [...this._data];
    }
    write(favorites: string[]): void {
      this.writes += 1;
      this._data = [...favorites];
    }
  }

  function providerWith(
    branches: IBranch[],
    repo: IRepository = attachedRepo('main', 'b'.repeat(40)),
    store?: IFavoritesStore
  ): BranchTreeProvider {
    const gitService = createMockGitService(repo, { getBranches: async () => branches });
    const provider = new BranchTreeProvider(gitService, undefined, store);
    provider.setRepository(repo);
    return provider;
  }

  // --- HEAD root node ---

  it('renders a HEAD root node at the very top when HEAD is attached to a branch', async () => {
    const provider = providerWith([
      { name: 'main', type: 'local', commit: 'b'.repeat(40), isHead: true },
    ]);
    const root = await provider.getChildren();
    assert.strictEqual(root[0].itemType, 'head', 'HEAD node must be the first root child');
    assert.strictEqual(root[0].label, 'main', 'HEAD node label is the current branch name');
    assert.strictEqual(root[0].contextValue, CONTEXT_VALUES.HEAD_NODE);
    assert.strictEqual(root[0].isCurrentBranch, true);
  });

  it('HEAD root node carries the current branch ref so selection can navigate', async () => {
    const provider = providerWith([
      { name: 'main', type: 'local', commit: 'b'.repeat(40), isHead: true },
    ]);
    const root = await provider.getChildren();
    assert.strictEqual(root[0].branch?.name, 'main');
  });

  it('omits the HEAD root node when HEAD is detached', async () => {
    const provider = providerWith(
      [{ name: 'main', type: 'local', commit: 'b'.repeat(40), isHead: false }],
      detachedRepo('a'.repeat(40))
    );
    const root = await provider.getChildren();
    assert.strictEqual(
      root.filter((c) => c.itemType === 'head').length,
      0,
      'detached HEAD → no head node (the synthetic Local row covers it)'
    );
    assert.strictEqual(root[0].label, 'Local', 'first root child falls back to Local');
  });

  it('omits the HEAD root node for an empty repo', async () => {
    const gitService = createMockGitService(emptyRepo());
    const provider = new BranchTreeProvider(gitService);
    provider.setRepository(emptyRepo());
    const root = await provider.getChildren();
    assert.strictEqual(root.filter((c) => c.itemType === 'head').length, 0);
  });

  // --- favorite toggle + persistence ---

  it('toggleFavorite marks a branch favorite and writes through to the store', () => {
    const store = new InMemoryStore();
    const provider = providerWith(
      [{ name: 'feature', type: 'local', commit: 'c'.repeat(40), isHead: false }],
      attachedRepo('main', 'b'.repeat(40)),
      store
    );
    assert.strictEqual(provider.isFavorite('feature'), false);
    provider.toggleFavorite('feature');
    assert.strictEqual(provider.isFavorite('feature'), true);
    assert.deepStrictEqual(store.read(), ['feature'], 'favorite persisted to the store');
  });

  it('toggleFavorite a second time removes the favorite and persists the removal', () => {
    const store = new InMemoryStore(['feature']);
    const provider = providerWith(
      [{ name: 'feature', type: 'local', commit: 'c'.repeat(40), isHead: false }],
      attachedRepo('main', 'b'.repeat(40)),
      store
    );
    assert.strictEqual(provider.isFavorite('feature'), true, 'loaded from store on construction');
    provider.toggleFavorite('feature');
    assert.strictEqual(provider.isFavorite('feature'), false);
    assert.deepStrictEqual(store.read(), []);
  });

  it('loads persisted favorites from the store on construction', () => {
    const provider = providerWith(
      [{ name: 'release', type: 'local', commit: 'c'.repeat(40), isHead: false }],
      attachedRepo('main', 'b'.repeat(40)),
      new InMemoryStore(['release'])
    );
    assert.strictEqual(provider.isFavorite('release'), true);
  });

  // --- favorites section ---

  it('renders a Favorites category (after HEAD) when at least one favorite exists', async () => {
    const provider = providerWith(
      [
        { name: 'main', type: 'local', commit: 'b'.repeat(40), isHead: true },
        { name: 'release', type: 'local', commit: 'c'.repeat(40), isHead: false },
      ],
      attachedRepo('main', 'b'.repeat(40)),
      new InMemoryStore(['release'])
    );
    const root = await provider.getChildren();
    assert.strictEqual(root[0].itemType, 'head');
    assert.strictEqual(root[1].label, 'Favorites', 'Favorites category sits right below HEAD');
    assert.strictEqual(root[1].itemType, 'category');
    // The remaining sections are preserved in order.
    assert.deepStrictEqual(
      root.slice(2).map((c) => c.label),
      ['Local', 'Remote', 'Tags']
    );
  });

  it('omits the Favorites category when there are no favorites', async () => {
    const provider = providerWith([
      { name: 'main', type: 'local', commit: 'b'.repeat(40), isHead: true },
    ]);
    const root = await provider.getChildren();
    assert.strictEqual(root.filter((c) => c.label === 'Favorites').length, 0);
  });

  it('Favorites category lists only the starred local branches as leaf rows', async () => {
    const provider = providerWith(
      [
        { name: 'main', type: 'local', commit: 'b'.repeat(40), isHead: true },
        { name: 'release', type: 'local', commit: 'c'.repeat(40), isHead: false },
        { name: 'feature', type: 'local', commit: 'd'.repeat(40), isHead: false },
      ],
      attachedRepo('main', 'b'.repeat(40)),
      new InMemoryStore(['release'])
    );
    const root = await provider.getChildren();
    const favCategory = root.find((c) => c.label === 'Favorites')!;
    const favs = await provider.getChildren(favCategory);
    assert.strictEqual(favs.length, 1);
    assert.strictEqual(favs[0].itemType, 'local-branch');
    assert.strictEqual(favs[0].branch?.name, 'release');
    assert.strictEqual(favs[0].isFavorite, true);
  });

  // --- favorite marking in the Local section ---

  it('flags a favorite local branch row via isFavorite', async () => {
    const provider = providerWith(
      [
        { name: 'main', type: 'local', commit: 'b'.repeat(40), isHead: true },
        { name: 'release', type: 'local', commit: 'c'.repeat(40), isHead: false },
      ],
      attachedRepo('main', 'b'.repeat(40)),
      new InMemoryStore(['release'])
    );
    const items = await localBranchesFromTree(provider);
    const releaseRow = items.find((i) => i.label === 'release')!;
    assert.strictEqual(releaseRow.isFavorite, true);
  });

  it('keeps the base local-branch context value on a favorite so its full menu stays', async () => {
    // Regression guard: a starred branch must NOT get a distinct context
    // value, or it loses the localBranch context-menu entries (checkout,
    // compare, …). Favorite state is conveyed by the icon instead.
    const provider = providerWith(
      [
        { name: 'main', type: 'local', commit: 'b'.repeat(40), isHead: true },
        { name: 'release', type: 'local', commit: 'c'.repeat(40), isHead: false },
      ],
      attachedRepo('main', 'b'.repeat(40)),
      new InMemoryStore(['release'])
    );
    const items = await localBranchesFromTree(provider);
    const releaseRow = items.find((i) => i.label === 'release')!;
    assert.strictEqual(releaseRow.contextValue, CONTEXT_VALUES.LOCAL_BRANCH);
  });
});

/**
 * D slice 3 — multi-repo grouping (git4idea `GitBranchesTreeMultiRepoModel`).
 *
 * North star:
 * `plugins/git4idea/shared/src/com/intellij/vcs/git/branch/tree/GitBranchesTreeMultiRepoModel.kt`
 * builds top-level `RepositoryNode`s (one per `GitRepositoryModel`) when the
 * project has more than one repository, so each repo owns its own branch
 * subtree. Here we mirror that: when `gitService.getRepositories()` reports
 * more than one repo, the tree root is one `'repository'` node per repo, and
 * each repo node expands to the same HEAD / Favorites / Local / Remote / Tags
 * sections scoped to that repository. With a single repo the flat layout is
 * unchanged (no repository wrapper) — pinned by the no-regression cases.
 */
describe('D slice 3 — BranchTreeProvider multi-repo grouping', () => {
  /** Build an attached repo whose root basename is `name`. */
  function repoAt(name: string, branchName = 'main', commit = 'a'.repeat(40)): IRepository {
    return {
      rootUri: { fsPath: `/work/${name}`, scheme: 'file' } as IRepository['rootUri'],
      state: 'idle',
      head: { name: `refs/heads/${branchName}`, commit, ahead: 0, behind: 0 },
      remotes: [],
      submodules: [],
    };
  }

  /**
   * Wire a provider over `repos` (multi- or single-repo). `branchesByRepo`
   * maps a repo to its branch list, dispatched by reference equality so the
   * provider's per-repo `getBranches(repo)` returns the right list.
   */
  function multiRepoProvider(
    repos: IRepository[],
    branchesByRepo: Map<IRepository, IBranch[]>,
    store?: IFavoritesStore,
    scope: 'all' | 'specific' = 'all'
  ): BranchTreeProvider {
    const gitService = createMockGitService(repos[0], {
      getRepositories: () => repos,
      getBranches: async (repo: IRepository) => branchesByRepo.get(repo) ?? [],
    });
    const provider = new BranchTreeProvider(gitService, undefined, store);
    provider.setRepository(repos[0]);
    // The grouped per-repo layout is the 'all' scope. `setRepository` above
    // selects a specific scope (the SelectedRepoModel-equivalent flat view),
    // so callers that want the grouped MultiRepoModel layout must opt back in.
    if (scope === 'all') {
      provider.setRepositoryScope('all');
    }
    return provider;
  }

  it('roots the tree at one repository node per repo when >1 repository exists', async () => {
    const repoA = repoAt('alpha');
    const repoB = repoAt('beta', 'dev');
    const provider = multiRepoProvider(
      [repoA, repoB],
      new Map([
        [repoA, [{ name: 'main', type: 'local', commit: 'a'.repeat(40), isHead: true }]],
        [repoB, [{ name: 'dev', type: 'local', commit: 'b'.repeat(40), isHead: true }]],
      ])
    );

    const root = await provider.getChildren();
    assert.strictEqual(root.length, 2, 'two repository root nodes');
    assert.ok(
      root.every((n) => n.itemType === 'repository'),
      'every root node is a repository node'
    );
    assert.strictEqual(root[0].label, repoDisplayName(repoA), 'label is the repo folder basename');
    assert.strictEqual(root[1].label, repoDisplayName(repoB));
    assert.strictEqual(root[0].contextValue, CONTEXT_VALUES.REPOSITORY);
  });

  it('expands a repository node into HEAD + Local/Remote/Tags scoped to that repo', async () => {
    const repoA = repoAt('alpha', 'main');
    const repoB = repoAt('beta', 'dev');
    const provider = multiRepoProvider(
      [repoA, repoB],
      new Map([
        [repoA, [{ name: 'main', type: 'local', commit: 'a'.repeat(40), isHead: true }]],
        [repoB, [{ name: 'dev', type: 'local', commit: 'b'.repeat(40), isHead: true }]],
      ])
    );

    const root = await provider.getChildren();
    const repoBNode = root[1];
    const sections = await provider.getChildren(repoBNode);

    // HEAD node first (repoB's current branch is "dev"), then categories.
    assert.strictEqual(sections[0].itemType, 'head');
    assert.strictEqual(sections[0].label, 'dev', 'HEAD node reflects THIS repo, not repoA');
    assert.deepStrictEqual(
      sections.slice(1).map((s) => s.label),
      ['Local', 'Remote', 'Tags']
    );
  });

  it("lists a repository node's local branches from THAT repository only", async () => {
    const repoA = repoAt('alpha', 'main');
    const repoB = repoAt('beta', 'dev');
    const provider = multiRepoProvider(
      [repoA, repoB],
      new Map([
        [
          repoA,
          [
            { name: 'main', type: 'local', commit: 'a'.repeat(40), isHead: true },
            { name: 'alpha-only', type: 'local', commit: 'c'.repeat(40), isHead: false },
          ],
        ],
        [repoB, [{ name: 'dev', type: 'local', commit: 'b'.repeat(40), isHead: true }]],
      ])
    );

    const root = await provider.getChildren();
    const repoANode = root[0];
    const sections = await provider.getChildren(repoANode);
    const localCategory = sections.find((s) => s.label === 'Local')!;
    const locals = await provider.getChildren(localCategory);

    const labels = locals.map((l) => l.label).sort();
    assert.deepStrictEqual(labels, ['alpha-only', 'main'], 'only repoA branches appear');
  });

  it('keeps per-repo folder nesting reachable under a repository node', async () => {
    const repoA = repoAt('alpha', 'main');
    const repoB = repoAt('beta', 'dev');
    const provider = multiRepoProvider(
      [repoA, repoB],
      new Map([
        [repoA, [{ name: 'main', type: 'local', commit: 'a'.repeat(40), isHead: true }]],
        [
          repoB,
          [
            { name: 'dev', type: 'local', commit: 'b'.repeat(40), isHead: true },
            { name: 'feature/x', type: 'local', commit: 'd'.repeat(40), isHead: false },
          ],
        ],
      ])
    );

    const root = await provider.getChildren();
    const sections = await provider.getChildren(root[1]); // repoB
    const localCategory = sections.find((s) => s.label === 'Local')!;
    const locals = await provider.getChildren(localCategory);
    const folder = locals.find((l) => l.itemType === 'branch-folder' && l.label === 'feature')!;
    assert.ok(folder, 'feature folder exists under repoB');

    const folderChildren = await provider.getChildren(folder);
    assert.strictEqual(folderChildren.length, 1);
    assert.strictEqual(folderChildren[0].label, 'x');
    assert.strictEqual(folderChildren[0].branch?.name, 'feature/x');
  });

  // --- single-repo no-regression ---

  it('keeps the flat layout (no repository node) when only one repository exists', async () => {
    const repoA = repoAt('solo', 'main');
    const provider = multiRepoProvider(
      [repoA],
      new Map([[repoA, [{ name: 'main', type: 'local', commit: 'a'.repeat(40), isHead: true }]]])
    );

    const root = await provider.getChildren();
    assert.strictEqual(
      root.filter((n) => n.itemType === 'repository').length,
      0,
      'single repo → no repository wrapper node'
    );
    assert.strictEqual(root[0].itemType, 'head', 'flat layout still starts with the HEAD node');
    assert.deepStrictEqual(
      root.filter((n) => n.itemType === 'category').map((n) => n.label),
      ['Local', 'Remote', 'Tags']
    );
  });

  // --- scope-driven root layout (selector scopes the branch tree) ---

  it('scopes the root to the selected repo category nodes (NOT grouped) when scope is a specific repo with >1 repository', async () => {
    const repoA = repoAt('alpha', 'main');
    const repoB = repoAt('beta', 'dev');
    const provider = multiRepoProvider(
      [repoA, repoB],
      new Map([
        [
          repoA,
          [
            { name: 'main', type: 'local', commit: 'a'.repeat(40), isHead: true },
            { name: 'alpha-only', type: 'local', commit: 'c'.repeat(40), isHead: false },
          ],
        ],
        [repoB, [{ name: 'dev', type: 'local', commit: 'b'.repeat(40), isHead: true }]],
      ]),
      undefined,
      'specific'
    );

    // setRepository(repoA) in the helper put scope on repoA specifically.
    const root = await provider.getChildren();

    assert.strictEqual(
      root.filter((n) => n.itemType === 'repository').length,
      0,
      'specific scope must NOT render per-repo wrapper nodes'
    );
    assert.strictEqual(root[0].itemType, 'head', 'scoped tree starts with repoA HEAD node');
    assert.strictEqual(root[0].label, 'main', 'HEAD reflects the scoped repo (repoA)');
    assert.deepStrictEqual(
      root.filter((n) => n.itemType === 'category').map((n) => n.label),
      ['Local', 'Remote', 'Tags'],
      'scoped tree is the flat HEAD/Local/Remote/Tags layout of the selected repo'
    );

    const localCategory = root.find((n) => n.label === 'Local')!;
    const locals = await provider.getChildren(localCategory);
    assert.deepStrictEqual(
      locals.map((l) => l.label).sort(),
      ['alpha-only', 'main'],
      'scoped Local lists only the selected repo branches'
    );
  });

  it('switches scope to a different specific repo when setRepository is called again', async () => {
    const repoA = repoAt('alpha', 'main');
    const repoB = repoAt('beta', 'dev');
    const provider = multiRepoProvider(
      [repoA, repoB],
      new Map([
        [repoA, [{ name: 'main', type: 'local', commit: 'a'.repeat(40), isHead: true }]],
        [repoB, [{ name: 'dev', type: 'local', commit: 'b'.repeat(40), isHead: true }]],
      ]),
      undefined,
      'specific'
    );

    provider.setRepository(repoB);
    const root = await provider.getChildren();

    assert.strictEqual(
      root.filter((n) => n.itemType === 'repository').length,
      0,
      'still flat after switching to another specific repo'
    );
    assert.strictEqual(root[0].label, 'dev', 'HEAD now reflects repoB');
  });

  it('regroups to per-repo root nodes when scope is reset to all', async () => {
    const repoA = repoAt('alpha', 'main');
    const repoB = repoAt('beta', 'dev');
    const provider = multiRepoProvider(
      [repoA, repoB],
      new Map([
        [repoA, [{ name: 'main', type: 'local', commit: 'a'.repeat(40), isHead: true }]],
        [repoB, [{ name: 'dev', type: 'local', commit: 'b'.repeat(40), isHead: true }]],
      ]),
      undefined,
      'specific'
    );

    // Start scoped to repoA (flat), then flip back to "All".
    let root = await provider.getChildren();
    assert.strictEqual(root.filter((n) => n.itemType === 'repository').length, 0);

    provider.setRepositoryScope('all');
    root = await provider.getChildren();

    assert.strictEqual(root.length, 2, 'two repository root nodes after regrouping');
    assert.ok(
      root.every((n) => n.itemType === 'repository'),
      'every root node is a repository node once scope is all'
    );
  });
});
