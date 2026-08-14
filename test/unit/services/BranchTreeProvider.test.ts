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
  InMemoryFavoritesStore,
  type BranchTreeItem,
  type IFavoritesStore,
} from '../../../src/branches/BranchTreeProvider';
import {
  createMockGitService,
  attachedRepo,
  detachedRepo,
  emptyRepo,
  rebasingRepo,
  corruptRepo,
} from '../../mocks/mockGitService';
import type { IBranch, IRepository } from '../../../src/git-core/interfaces/IGitService';
import type { IncomingOutgoingFetcher } from '../../../src/branches/BranchPopup';
import type { IIncomingOutgoing } from '../../../src/git-core/ops/IncomingOutgoingOps';
import { repoDisplayName } from '../../../src/sync/updateProject';

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

describe('BranchTreeProvider detached HEAD row', () => {
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
describe('BranchTreeProvider incoming/outgoing enrichment', () => {
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
 *   - the current branch marked on its own row inside Local (no separate
 *     pinned HEAD row; HEAD-specific presentation exists only for the
 *     detached state, as the synthetic row inside Local);
 *   - a `Favorites` category listing starred local branches, only when at
 *     least one favorite exists;
 *   - `toggleFavorite` / `isFavorite` backed by an injected
 *     {@link IFavoritesStore} (Memento in production, in-memory double here)
 *     so favorites survive across sessions.
 */
describe('D slice 2 — BranchTreeProvider HEAD root node + favorites', () => {
  /**
   * The production in-memory store, plus a write counter — these specs assert
   * the tree does not re-persist on a no-op toggle.
   */
  class InMemoryStore extends InMemoryFavoritesStore {
    public writes = 0;
    constructor(initial: string[] = []) {
      super();
      for (const name of initial) {
        super.setFavorite('local', '', name, true);
      }
    }
    override setFavorite(
      type: 'local' | 'remote',
      repoPath: string,
      name: string,
      favorite: boolean
    ): void {
      this.writes += 1;
      super.setFavorite(type, repoPath, name, favorite);
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

  // --- no pinned HEAD row ---
  //
  // The current branch is conveyed by the checked row inside Local; a pinned
  // HEAD row on top duplicated it. HEAD-specific presentation survives ONLY
  // for the detached state (the synthetic row inside Local), where no branch
  // row can carry it.

  it('renders no pinned HEAD row when HEAD is attached to a branch', async () => {
    const provider = providerWith([
      { name: 'topic', type: 'local', commit: 'b'.repeat(40), isHead: true },
    ]);
    const root = await provider.getChildren();
    assert.strictEqual(root[0].label, 'Local', 'root starts with the categories');
    assert.deepStrictEqual(
      root.map((c) => c.itemType),
      ['category', 'category', 'category'],
      'no synthetic head row anywhere in the root'
    );
  });

  it('marks the current branch inside Local instead', async () => {
    const provider = providerWith([
      { name: 'topic', type: 'local', commit: 'b'.repeat(40), isHead: true },
    ]);
    const root = await provider.getChildren();
    const locals = await provider.getChildren(root.find((c) => c.label === 'Local'));
    const current = locals.find((l) => l.isCurrentBranch)!;
    assert.ok(current, 'the current branch row exists in Local');
    assert.strictEqual(current.branch?.name, 'topic');
  });

  it('keeps the synthetic detached row inside Local when HEAD is detached', async () => {
    // A non-default branch name keeps this spec about detached HEAD alone —
    // `main` would be starred by default and add a Favorites category.
    const provider = providerWith(
      [{ name: 'topic', type: 'local', commit: 'b'.repeat(40), isHead: false }],
      detachedRepo('a'.repeat(40))
    );
    const root = await provider.getChildren();
    assert.strictEqual(root[0].label, 'Local', 'first root child is Local');
    const locals = await provider.getChildren(root[0]);
    assert.strictEqual(locals[0].itemType, 'detached-head', 'the detached row survives');
  });

  it('renders only the categories for an empty repo', async () => {
    const gitService = createMockGitService(emptyRepo());
    const provider = new BranchTreeProvider(gitService);
    provider.setRepository(emptyRepo());
    const root = await provider.getChildren();
    assert.deepStrictEqual(
      root.map((c) => c.label),
      ['Local', 'Remote', 'Tags']
    );
  });

  // --- favorite toggle + persistence ---

  it('toggleFavorite marks a branch favorite and writes through to the store', () => {
    const store = new InMemoryStore();
    const repo = attachedRepo('main', 'b'.repeat(40));
    const provider = providerWith(
      [{ name: 'feature', type: 'local', commit: 'c'.repeat(40), isHead: false }],
      repo,
      store
    );
    assert.strictEqual(provider.isFavorite(repo, 'feature'), false);
    provider.toggleFavorite(repo, 'feature');
    assert.strictEqual(provider.isFavorite(repo, 'feature'), true);
    assert.ok(store.isFavorite('local', '/test', 'feature'), 'favorite persisted to the store');
  });

  it('toggleFavorite a second time removes the favorite and persists the removal', () => {
    const store = new InMemoryStore(['feature']);
    const repo = attachedRepo('main', 'b'.repeat(40));
    const provider = providerWith(
      [{ name: 'feature', type: 'local', commit: 'c'.repeat(40), isHead: false }],
      repo,
      store
    );
    assert.strictEqual(
      provider.isFavorite(repo, 'feature'),
      true,
      'loaded from store on construction'
    );
    provider.toggleFavorite(repo, 'feature');
    assert.strictEqual(provider.isFavorite(repo, 'feature'), false);
    assert.strictEqual(store.isFavorite('local', '/test', 'feature'), false);
  });

  it('loads persisted favorites from the store on construction', () => {
    const repo = attachedRepo('main', 'b'.repeat(40));
    const provider = providerWith(
      [{ name: 'release', type: 'local', commit: 'c'.repeat(40), isHead: false }],
      repo,
      new InMemoryStore(['release'])
    );
    assert.strictEqual(provider.isFavorite(repo, 'release'), true);
  });

  // --- favorites section ---

  it('renders a Favorites category first when at least one favorite exists', async () => {
    const provider = providerWith(
      [
        { name: 'main', type: 'local', commit: 'b'.repeat(40), isHead: true },
        { name: 'release', type: 'local', commit: 'c'.repeat(40), isHead: false },
      ],
      attachedRepo('main', 'b'.repeat(40)),
      new InMemoryStore(['release'])
    );
    const root = await provider.getChildren();
    assert.strictEqual(root[0].label, 'Favorites', 'Favorites category leads the root');
    assert.strictEqual(root[0].itemType, 'category');
    // The remaining sections are preserved in order.
    assert.deepStrictEqual(
      root.slice(1).map((c) => c.label),
      ['Local', 'Remote', 'Tags']
    );
  });

  it('omits the Favorites category when no ref is starred', async () => {
    // `main`/`master` are starred out of the box, so a repo without them has
    // nothing in Favorites (GitBranchManager.getDefaultBranchNames).
    const provider = providerWith([
      { name: 'topic', type: 'local', commit: 'b'.repeat(40), isHead: true },
    ]);
    const root = await provider.getChildren();
    assert.strictEqual(root.filter((c) => c.label === 'Favorites').length, 0);
  });

  it('Favorites category lists the starred branches, defaults included, as leaf rows', async () => {
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
    assert.deepStrictEqual(
      favs.map((f) => f.branch?.name).sort(),
      ['main', 'release'],
      'the explicit star plus the predefined default'
    );
    assert.ok(favs.every((f) => f.itemType === 'local-branch' && f.isFavorite));
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
   * provider's per-repo `getBranches(repo)` returns the right list. The
   * layout follows the repo count alone: >1 repo groups per repository,
   * regardless of the recorded selection.
   */
  function multiRepoProvider(
    repos: IRepository[],
    branchesByRepo: Map<IRepository, IBranch[]>,
    store?: IFavoritesStore
  ): BranchTreeProvider {
    const gitService = createMockGitService(repos[0], {
      getRepositories: () => repos,
      getBranches: async (repo: IRepository) => branchesByRepo.get(repo) ?? [],
    });
    const provider = new BranchTreeProvider(gitService, undefined, store);
    provider.setRepository(repos[0]);
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

  it('expands a repository node into Local/Remote/Tags scoped to that repo (no HEAD row)', async () => {
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

    assert.deepStrictEqual(
      sections.map((s) => s.label),
      ['Local', 'Remote', 'Tags'],
      'categories only — the checked row inside Local carries the current branch; ' +
        'repoB holds only `dev`, so no default is starred and Favorites stays hidden'
    );
    const locals = await provider.getChildren(sections[0]);
    const current = locals.find((l) => l.isCurrentBranch)!;
    assert.strictEqual(current.branch?.name, 'dev', 'current marker reflects THIS repo, not repoA');
  });

  it('colors every repository row icon with the single green theme color', async () => {
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
    for (const node of root) {
      const icon = node.iconPath as { id?: string; color?: { id?: string } };
      assert.strictEqual(icon.id, 'repo', 'repository rows keep the repo glyph');
      assert.strictEqual(
        icon.color?.id,
        'charts.green',
        'every repository icon uses the one green color'
      );
    }
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

  // --- leaf items carry their owning repository (multi-repo data-loss guard) ---
  //
  // Branch names collide across repos (every repo has `main`/`master`). The
  // context menu must target the repo the CLICKED leaf hangs under, not the
  // tree's current repo — so every leaf row carries `repository`. Without it,
  // deleting `main` under repo B's node would delete repo A's `main`.

  it('tags a local-branch leaf with its owning repository so a colliding name targets the right repo', async () => {
    const repoA = repoAt('alpha', 'main');
    const repoB = repoAt('beta', 'dev');
    const provider = multiRepoProvider(
      [repoA, repoB],
      new Map([
        [repoA, [{ name: 'main', type: 'local', commit: 'a'.repeat(40), isHead: true }]],
        [
          repoB,
          [
            { name: 'main', type: 'local', commit: 'b'.repeat(40), isHead: false },
            { name: 'dev', type: 'local', commit: 'c'.repeat(40), isHead: true },
          ],
        ],
      ])
    );

    const root = await provider.getChildren();
    const sections = await provider.getChildren(root[1]); // repoB node
    const localCategory = sections.find((s) => s.label === 'Local')!;
    const locals = await provider.getChildren(localCategory);
    const mainLeaf = locals.find((l) => l.label === 'main')!;

    assert.strictEqual(mainLeaf.itemType, 'local-branch');
    assert.strictEqual(
      mainLeaf.repository,
      repoB,
      'the `main` leaf under repoB carries repoB, not the context repo'
    );
  });

  it('tags a nested-folder local-branch leaf with its owning repository', async () => {
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
    const sections = await provider.getChildren(root[1]); // repoB node
    const localCategory = sections.find((s) => s.label === 'Local')!;
    const locals = await provider.getChildren(localCategory);
    const folder = locals.find((l) => l.itemType === 'branch-folder' && l.label === 'feature')!;
    const folderChildren = await provider.getChildren(folder);
    const leaf = folderChildren.find((l) => l.label === 'x')!;

    assert.strictEqual(leaf.itemType, 'local-branch');
    assert.strictEqual(leaf.repository, repoB, 'nested leaf carries the owning repo');
  });

  it('tags a remote-branch leaf with its owning repository', async () => {
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
            { name: 'origin/main', type: 'remote', commit: 'c'.repeat(40), isHead: false },
          ],
        ],
      ])
    );

    const root = await provider.getChildren();
    const sections = await provider.getChildren(root[1]); // repoB node
    const remoteCategory = sections.find((s) => s.label === 'Remote')!;
    const remoteFolders = await provider.getChildren(remoteCategory);
    const originFolder = remoteFolders.find((f) => f.label === 'origin')!;
    const remoteLeaves = await provider.getChildren(originFolder);
    const leaf = remoteLeaves.find((l) => l.itemType === 'remote-branch')!;

    assert.strictEqual(leaf.repository, repoB, 'remote leaf carries the owning repo');
  });

  it('tags the synthetic detached-head row with its owning repository', async () => {
    const repoA = repoAt('alpha', 'main');
    const repoB: IRepository = {
      rootUri: { fsPath: '/work/beta', scheme: 'file' } as IRepository['rootUri'],
      state: 'idle',
      head: { name: undefined, commit: 'f'.repeat(40), ahead: 0, behind: 0 },
      remotes: [],
      submodules: [],
    };
    const provider = multiRepoProvider(
      [repoA, repoB],
      new Map([
        [repoA, [{ name: 'main', type: 'local', commit: 'a'.repeat(40), isHead: true }]],
        [repoB, [{ name: 'dev', type: 'local', commit: 'b'.repeat(40), isHead: false }]],
      ])
    );

    const root = await provider.getChildren();
    const sections = await provider.getChildren(root[1]); // repoB node
    const localCategory = sections.find((s) => s.label === 'Local')!;
    const locals = await provider.getChildren(localCategory);
    const detached = locals.find((l) => l.itemType === 'detached-head')!;

    assert.ok(detached, 'detached-head row exists for repoB');
    assert.strictEqual(detached.repository, repoB, 'detached row carries the owning repo');
  });

  it('tags a favorite leaf with its owning repository', async () => {
    const repoA = repoAt('alpha', 'main');
    const repoB = repoAt('beta', 'dev');
    const favStore: IFavoritesStore = new InMemoryFavoritesStore();
    const provider = multiRepoProvider(
      [repoA, repoB],
      new Map([
        [repoA, [{ name: 'main', type: 'local', commit: 'a'.repeat(40), isHead: true }]],
        [
          repoB,
          [
            { name: 'main', type: 'local', commit: 'b'.repeat(40), isHead: false },
            { name: 'dev', type: 'local', commit: 'c'.repeat(40), isHead: true },
          ],
        ],
      ]),
      favStore
    );

    const root = await provider.getChildren();
    const sections = await provider.getChildren(root[1]); // repoB node
    const favCategory = sections.find((s) => s.label === 'Favorites')!;
    const favs = await provider.getChildren(favCategory);
    const favLeaf = favs.find((l) => l.branch?.name === 'main')!;

    assert.strictEqual(favLeaf.repository, repoB, 'favorite leaf carries the owning repo');
  });

  it('tags a tag leaf with its owning repository', async () => {
    const repoA = repoAt('alpha', 'main');
    const repoB = repoAt('beta', 'dev');
    const gitService = createMockGitService(repoA, {
      getRepositories: () => [repoA, repoB],
      getBranches: async (repo: IRepository) =>
        repo === repoB
          ? [{ name: 'dev', type: 'local', commit: 'b'.repeat(40), isHead: true }]
          : [{ name: 'main', type: 'local', commit: 'a'.repeat(40), isHead: true }],
      getTags: async (repo: IRepository) =>
        repo === repoB ? [{ name: 'v1.0', commit: 'e'.repeat(40), isAnnotated: false }] : [],
    });
    const provider = new BranchTreeProvider(gitService, undefined, undefined);
    provider.setRepository(repoA);

    const root = await provider.getChildren();
    const sections = await provider.getChildren(root[1]); // repoB node
    const tagsCategory = sections.find((s) => s.label === 'Tags')!;
    const tags = await provider.getChildren(tagsCategory);
    const tagLeaf = tags.find((t) => t.itemType === 'tag')!;

    assert.strictEqual(tagLeaf.tag?.name, 'v1.0');
    assert.strictEqual(tagLeaf.repository, repoB, 'tag leaf carries the owning repo');
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
    assert.deepStrictEqual(
      root.map((n) => n.label),
      ['Favorites', 'Local', 'Remote', 'Tags'],
      'flat layout is the categories alone (main is starred by default)'
    );
  });

  // --- the tree shows the repos in the log's scope ---
  //
  // The Git tool window's repository selector scopes the Branches tree the
  // same way it scopes the log: a single-repo selection shows only that
  // repo's group row (the row keeps the repo-name context), a checked subset
  // shows those repos, and "All Repositories" shows every repo.

  it('hides non-selected repos when the selector narrows to one repo', async () => {
    const repoA = repoAt('alpha', 'main');
    const repoB = repoAt('beta', 'dev');
    const provider = multiRepoProvider(
      [repoA, repoB],
      new Map([
        [repoA, [{ name: 'main', type: 'local', commit: 'a'.repeat(40), isHead: true }]],
        [repoB, [{ name: 'dev', type: 'local', commit: 'b'.repeat(40), isHead: true }]],
      ])
    );

    provider.setVisibleRepoRoots([repoA.rootUri.fsPath]);
    const root = await provider.getChildren();

    assert.strictEqual(root.length, 1, 'only the selected repository row remains');
    assert.strictEqual(root[0].itemType, 'repository', 'the row keeps the repo-name context');
    assert.strictEqual(root[0].label, repoDisplayName(repoA));
  });

  it('follows the selection when it moves to another repo', async () => {
    const repoA = repoAt('alpha', 'main');
    const repoB = repoAt('beta', 'dev');
    const provider = multiRepoProvider(
      [repoA, repoB],
      new Map([
        [repoA, [{ name: 'main', type: 'local', commit: 'a'.repeat(40), isHead: true }]],
        [repoB, [{ name: 'dev', type: 'local', commit: 'b'.repeat(40), isHead: true }]],
      ])
    );

    provider.setVisibleRepoRoots([repoA.rootUri.fsPath]);
    provider.setVisibleRepoRoots([repoB.rootUri.fsPath]);
    const root = await provider.getChildren();

    assert.strictEqual(root.length, 1);
    assert.strictEqual(root[0].label, repoDisplayName(repoB));
  });

  it('shows exactly the checked repos for a multi-select subset', async () => {
    const repoA = repoAt('alpha', 'main');
    const repoB = repoAt('beta', 'dev');
    const repoC = repoAt('gamma', 'main');
    const branches = new Map([
      [repoA, [{ name: 'main', type: 'local' as const, commit: 'a'.repeat(40), isHead: true }]],
      [repoB, [{ name: 'dev', type: 'local' as const, commit: 'b'.repeat(40), isHead: true }]],
      [repoC, [{ name: 'main', type: 'local' as const, commit: 'c'.repeat(40), isHead: true }]],
    ]);
    const provider = multiRepoProvider([repoA, repoB, repoC], branches);

    provider.setVisibleRepoRoots([repoA.rootUri.fsPath, repoC.rootUri.fsPath]);
    const root = await provider.getChildren();

    assert.deepStrictEqual(
      root.map((n) => n.label),
      [repoDisplayName(repoA), repoDisplayName(repoC)],
      'the subset keeps repo order and hides the unchecked repo'
    );
  });

  it('restores every repo when the scope returns to all', async () => {
    const repoA = repoAt('alpha', 'main');
    const repoB = repoAt('beta', 'dev');
    const provider = multiRepoProvider(
      [repoA, repoB],
      new Map([
        [repoA, [{ name: 'main', type: 'local', commit: 'a'.repeat(40), isHead: true }]],
        [repoB, [{ name: 'dev', type: 'local', commit: 'b'.repeat(40), isHead: true }]],
      ])
    );

    provider.setVisibleRepoRoots([repoA.rootUri.fsPath]);
    provider.setVisibleRepoRoots(null);
    const root = await provider.getChildren();

    assert.strictEqual(root.length, 2, 'all repository rows return');
  });

  it('shows no repo rows for an explicit empty subset (the log shows no commits)', async () => {
    const repoA = repoAt('alpha', 'main');
    const repoB = repoAt('beta', 'dev');
    const provider = multiRepoProvider(
      [repoA, repoB],
      new Map([
        [repoA, [{ name: 'main', type: 'local', commit: 'a'.repeat(40), isHead: true }]],
        [repoB, [{ name: 'dev', type: 'local', commit: 'b'.repeat(40), isHead: true }]],
      ])
    );

    provider.setVisibleRepoRoots([]);
    const root = await provider.getChildren();

    assert.strictEqual(root.length, 0, 'empty subset hides every repository row');
  });

  it('ignores visible roots that match no live repository', async () => {
    const repoA = repoAt('alpha', 'main');
    const repoB = repoAt('beta', 'dev');
    const provider = multiRepoProvider(
      [repoA, repoB],
      new Map([
        [repoA, [{ name: 'main', type: 'local', commit: 'a'.repeat(40), isHead: true }]],
        [repoB, [{ name: 'dev', type: 'local', commit: 'b'.repeat(40), isHead: true }]],
      ])
    );

    provider.setVisibleRepoRoots([repoA.rootUri.fsPath, '/no/such/repo']);
    const root = await provider.getChildren();

    assert.deepStrictEqual(
      root.map((n) => n.label),
      [repoDisplayName(repoA)],
      'a stale root is dropped by intersecting with the live repository list'
    );
  });

  it('fires a tree refresh when the visible set changes, and not on a no-op', async () => {
    const repoA = repoAt('alpha', 'main');
    const repoB = repoAt('beta', 'dev');
    const provider = multiRepoProvider(
      [repoA, repoB],
      new Map([
        [repoA, [{ name: 'main', type: 'local', commit: 'a'.repeat(40), isHead: true }]],
        [repoB, [{ name: 'dev', type: 'local', commit: 'b'.repeat(40), isHead: true }]],
      ])
    );
    let fires = 0;
    provider.onDidChangeTreeData(() => {
      fires++;
    });

    provider.setVisibleRepoRoots([repoA.rootUri.fsPath]);
    provider.setVisibleRepoRoots([repoA.rootUri.fsPath]);
    provider.setVisibleRepoRoots(null);
    provider.setVisibleRepoRoots(null);

    assert.strictEqual(fires, 2, 'one fire per real change, no fire on a no-op repeat');
  });

  // --- favorites are per-repository in the grouped layout ---

  it('stars a branch under the repo the row belongs to, not the selected repo', async () => {
    const repoA = repoAt('alpha', 'main');
    const repoB = repoAt('beta', 'dev');
    const favStore: IFavoritesStore = new InMemoryFavoritesStore();
    const provider = multiRepoProvider(
      [repoA, repoB],
      new Map([
        [repoA, [{ name: 'main', type: 'local', commit: 'a'.repeat(40), isHead: true }]],
        [
          repoB,
          [
            { name: 'dev', type: 'local', commit: 'c'.repeat(40), isHead: true },
            { name: 'ship-it', type: 'local', commit: 'd'.repeat(40), isHead: false },
          ],
        ],
      ]),
      favStore
    );

    provider.toggleFavorite(repoB, 'ship-it');

    assert.strictEqual(
      favStore.isFavorite('local', repoB.rootUri.fsPath, 'ship-it'),
      true,
      'the star lands under the row owner repo'
    );
    assert.strictEqual(
      favStore.isFavorite('local', repoA.rootUri.fsPath, 'ship-it'),
      false,
      'the star must not leak into the selected repo'
    );
  });

  it('renders each repo Favorites section from that repo own stars', async () => {
    const repoA = repoAt('alpha', 'main');
    const repoB = repoAt('beta', 'dev');
    const favStore: IFavoritesStore = new InMemoryFavoritesStore();
    // Same branch name exists in both repos; only repoB's copy is starred.
    favStore.setFavorite('local', repoB.rootUri.fsPath, 'ship-it', true);
    const provider = multiRepoProvider(
      [repoA, repoB],
      new Map([
        [
          repoA,
          [
            { name: 'main', type: 'local', commit: 'a'.repeat(40), isHead: true },
            { name: 'ship-it', type: 'local', commit: 'b'.repeat(40), isHead: false },
          ],
        ],
        [
          repoB,
          [
            { name: 'dev', type: 'local', commit: 'c'.repeat(40), isHead: true },
            { name: 'ship-it', type: 'local', commit: 'd'.repeat(40), isHead: false },
          ],
        ],
      ]),
      favStore
    );

    const root = await provider.getChildren();
    const favNames = async (repoNode: BranchTreeItem): Promise<string[]> => {
      const sections = await provider.getChildren(repoNode);
      const favCategory = sections.find((s) => s.label === 'Favorites');
      if (!favCategory) {
        return [];
      }
      return (await provider.getChildren(favCategory)).map((l) => l.branch?.name ?? '');
    };

    assert.ok((await favNames(root[1])).includes('ship-it'), 'repoB Favorites shows its own star');
    assert.ok(
      !(await favNames(root[0])).includes('ship-it'),
      'repoA Favorites must not show repoB star'
    );
  });
});
