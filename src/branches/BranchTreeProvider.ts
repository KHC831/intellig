/**
 * Branch Tree Provider implementation.
 * Provides a tree view of branches with context menu support.
 */

import * as vscode from 'vscode';
import { IGitService, IRepository, IBranch, ITag } from '../git-core/interfaces/IGitService';
import { compareRefNames, partitionRefsByPathSegment } from './refPathGrouping';
import { resolveRepo } from '../utils/resolveRepo';
import { BranchTreeScope } from './branchTreeScope';
import { safeFireAndForget } from '../utils/safeFireAndForget';
import { getLogger, type Logger } from '../utils/logger';
import {
  favoritesRepoPath,
  InMemoryFavoritesStore,
  type FavoriteRefType,
  type IFavoritesStore,
} from './favoritesStore';
import {
  enrichBranchesWithIncomingOutgoing,
  getIncomingOutgoingFetcher,
  type IncomingOutgoingFetcher,
} from './BranchPopup';
import {
  BranchTreeItem,
  repositoryLabel,
  WORKTREES_CATEGORY,
  type BranchFolderScope,
} from './branchTreeItem';
import { worktreeRows } from './worktreeTreeItems';

export {
  BranchTreeItem,
  CONTEXT_VALUES,
  graphTargetForTreeSelection,
  type BranchFolderScope,
  type BranchTreeItemType,
} from './branchTreeItem';

/**
 * Branch Tree Data Provider.
 * Provides tree data for the branches view with local branches, remote branches, and tags.
 *
 * - Context menu for local branches
 * - Context menu for remote branches
 * - Disable checkout for current branch
 * - Context menu for tags
 * - Organize menu items in logical groupings
 */
export class BranchTreeProvider
  implements vscode.TreeDataProvider<BranchTreeItem>, vscode.Disposable
{
  private _gitService: IGitService;
  private _currentRepository: IRepository | undefined;
  private _onDidChangeTreeData: vscode.EventEmitter<BranchTreeItem | undefined | null | void>;
  readonly onDidChangeTreeData: vscode.Event<BranchTreeItem | undefined | null | void>;
  // Own the EventEmitter + every event subscription so
  // `dispose()` (called from the extension's
  // `context.subscriptions.push(...)` registration) tears down cleanly
  // on extension deactivation. The constructor leaked the
  // `onDidChangeRepository` listener and the EventEmitter on dispose.
  private readonly _disposables: vscode.Disposable[] = [];
  private _disposed = false;

  /**
   * Component-bound Logger emitted on each refresh trigger (debug)
   * and refresh failure (warn) so the BranchTree's lifecycle waypoints
   * land in the IntelliG OutputChannel uniformly with the rest of the
   * service graph.
   */
  private readonly _logger: Logger;

  /**
   * Optional incoming/outgoing fetcher. When present, tracked local branches
   * are enriched with ahead/behind counts so the tree renders ↑N/↓N badges —
   * matching the branch popup. Lives off the frozen IGitService interface
   * (ADR-001), so the factory duck-types it from the concrete service.
   */
  private readonly _incomingOutgoingFetcher: IncomingOutgoingFetcher | undefined;

  /**
   * Persistent backing for {@link _favorites}. Defaults to an in-memory
   * store; production injects a Memento-backed one so stars survive
   * across sessions (git4idea parity: `GitRepositoryModel.favoriteRefs`).
   */
  private readonly _favoritesStore: IFavoritesStore;

  /**
   * True when this provider created its own fallback store (no shared store
   * was injected), so dispose() tears the store's change emitter down. An
   * injected store is owned by the extension, never disposed here.
   */
  private readonly _ownsFavoritesStore: boolean;

  /**
   * Active search query (IntelliJ speed-search analogue). When set, every
   * section renders only refs whose FULL name contains it
   * (case-insensitive); folder grouping is built from the survivors.
   */
  private _searchQuery: string | undefined;

  /** What the Git tool window's scope leaves visible (repos + branches). */
  private readonly _scope = new BranchTreeScope();

  constructor(
    gitService: IGitService,
    incomingOutgoingFetcher?: IncomingOutgoingFetcher,
    favoritesStore?: IFavoritesStore
  ) {
    this._gitService = gitService;
    this._incomingOutgoingFetcher = incomingOutgoingFetcher;
    this._ownsFavoritesStore = favoritesStore === undefined;
    this._favoritesStore = favoritesStore ?? new InMemoryFavoritesStore();
    this._onDidChangeTreeData = new vscode.EventEmitter<BranchTreeItem | undefined | null | void>();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this._logger = getLogger().child({ component: 'BranchTreeProvider' });

    // Re-sync the favorite set whenever the shared store changes — including
    // stars added from the branch popup, so an already-open tree repaints
    // without a window reload. Captured so dispose() tears it down.
    this._disposables.push(
      this._favoritesStore.onDidChangeFavorites(() => {
        if (this._disposed) {
          return;
        }
        this.refresh();
      })
    );

    // Listen for repository changes. Capture the subscription
    // so dispose() tears it down. Guard the callback against post-dispose
    // delivery (the event source can outlive us when dispose() races
    // with an in-flight `onDidChangeRepository` fire — a no-op here is
    // safer than mutating `_currentRepository` mid-teardown).
    this._disposables.push(
      this._gitService.onDidChangeRepository((repo) => {
        if (this._disposed) {
          return;
        }
        this._currentRepository = repo;
        this.refresh();
      })
    );

    // Initialize with first repository. Bucket C: init path;
    // `onDidChangeRepository` above picks up repos discovered later, so a
    // cold-start failure is transient.
    safeFireAndForget(
      this._initializeRepository(),
      'BranchTreeProvider.constructor: initial repository load'
    );
  }

  /**
   * Dispose the EventEmitter and every captured
   * subscription. Idempotent: safe to call twice (the second call is
   * a no-op). Post-dispose, `refresh()` becomes a no-op because the
   * event emitter is dead and the `_disposed` flag short-circuits
   * the `onDidChangeRepository` callback.
   *
   * Registered with `context.subscriptions.push(branchTreeProvider)`
   * in `extension.ts:4178` so the extension lifecycle owns the
   * teardown.
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    if (activeBranchTreeProvider === this) {
      activeBranchTreeProvider = undefined;
    }
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables.length = 0;
    this._onDidChangeTreeData.dispose();
    if (this._ownsFavoritesStore) {
      this._favoritesStore.dispose();
    }
  }

  /**
   * Initialize the current repository for this tree provider.
   *
   * Route through `resolveRepo(preferActive: true)` so the
   * branches view reflects the active editor's repo in multi-root
   * workspaces, not an arbitrary first-enumerated repo. Falls back to
   * discovering the first workspace folder when the git service hasn't
   * populated any repos yet.
   */
  private async _initializeRepository(): Promise<void> {
    const repo = await resolveRepo(this._gitService, {
      preferActive: true,
      silent: true,
    });
    if (repo) {
      this._currentRepository = repo;
    } else {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders && workspaceFolders.length > 0) {
        this._currentRepository = await this._gitService.getRepository(workspaceFolders[0].uri);
      }
    }
    this.refresh();
  }

  /**
   * Refresh the tree view
   */
  refresh(): void {
    // debug-level waypoint on every refresh trigger.
    // Fires whenever upstream state changes
    // (repo switch, init, manual `setRepository`, etc.).
    this._logger.debug('refresh triggered');
    this._onDidChangeTreeData.fire();
  }

  /**
   * Record the repository selected in the Git tool window's selector. Backs
   * the single-repo flat layout and the fallback repo for rows that don't
   * carry their own; which repos the grouped layout SHOWS is governed by
   * {@link setVisibleRepoRoots}.
   */
  setRepository(repo: IRepository): void {
    this._currentRepository = repo;
    this.refresh();
  }

  /**
   * Narrow the grouped multi-root layout to `roots` (repo-root fsPaths),
   * mirroring the log's repository scope: a dropdown selection passes that
   * one repo, a checked subset passes those repos, `null` shows every repo,
   * and an explicit empty set shows none. A no-op change does not refire.
   */
  setVisibleRepoRoots(roots: readonly string[] | null): void {
    if (this._scope.setRepoRoots(roots)) {
      this.refresh();
    }
  }

  /**
   * Narrow the tree to the branches the log's branch filter selected; `null`
   * (an empty or cleared filter) lists every branch again. A no-op change
   * does not refire.
   */
  setVisibleBranches(names: readonly string[] | null): void {
    if (this._scope.setBranchNames(names)) {
      this.refresh();
    }
  }

  /**
   * Get the current repository
   */
  getRepository(): IRepository | undefined {
    return this._currentRepository;
  }

  /**
   * Whether any ref that actually EXISTS in `repo` is starred. Gating on the
   * stored names alone would show an empty Favorites category, since the
   * predefined defaults are listed whether or not the repo has those branches.
   */
  private _hasAnyFavorite(repo: IRepository, branches: readonly IBranch[]): boolean {
    return branches.some((b) =>
      this.isFavorite(repo, b.name, b.type === 'remote' ? 'remote' : 'local')
    );
  }

  /**
   * Whether `branchName` is starred in `repo`. Favorites are per-repository
   * (git4idea DvcsBranchInfo.repoPath), so the owning repo travels with every
   * lookup; `undefined` resolves against the all-repositories bucket. REMOTE
   * refs are first-class favorites, as in git4idea (GitBranchManager).
   */
  isFavorite(
    repo: IRepository | undefined,
    branchName: string,
    type: FavoriteRefType = 'local'
  ): boolean {
    return this._favoritesStore.isFavorite(type, favoritesRepoPath(repo), branchName);
  }

  /**
   * Toggle the favorite (star) state of a ref in `repo` by writing the new
   * set through {@link _favoritesStore}. The store's change event refreshes
   * the tree (a single source of truth, so the branch popup sees the same
   * toggle). Mirrors git4idea's `toggle_favorite` action (SPACE / star click).
   */
  toggleFavorite(
    repo: IRepository | undefined,
    branchName: string,
    type: FavoriteRefType = 'local'
  ): void {
    const repoPath = favoritesRepoPath(repo);
    const next = !this._favoritesStore.isFavorite(type, repoPath, branchName);
    this._favoritesStore.setFavorite(type, repoPath, branchName, next);
  }

  /**
   * Set or clear the tree's search filter. Empty / whitespace-only input
   * clears. A no-op change does not refire the tree.
   */
  setSearchQuery(query: string | undefined): void {
    const normalized = query?.trim() ? query.trim() : undefined;
    if (normalized === this._searchQuery) {
      return;
    }
    this._searchQuery = normalized;
    this._onDidChangeTreeData.fire();
  }

  /** The active search query, for command prefill and the view description. */
  getSearchQuery(): string | undefined {
    return this._searchQuery;
  }

  /** Case-insensitive substring match against the active query (no query → all pass). */
  private _matchesSearch(name: string): boolean {
    if (!this._searchQuery) {
      return true;
    }
    return name.toLowerCase().includes(this._searchQuery.toLowerCase());
  }

  /**
   * The single gate every branch ROW passes: the tree's own search query AND
   * the log's branch filter. One predicate rather than a check per list, so
   * the categories, favorites and folder children can't drift apart.
   *
   * The checked-out branch always survives the log filter — the tree must not
   * hide where HEAD is, and that row is the checkout anchor. The search query
   * still applies to it (the user typed that one themselves).
   */
  private _branchRowVisible(branch: IBranch): boolean {
    return this._matchesSearch(branch.name) && this._scope.branchVisible(branch);
  }

  getTreeItem(element: BranchTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: BranchTreeItem): Promise<BranchTreeItem[]> {
    // Root level. With more than one repository in the workspace, group
    // the tree under per-repository root nodes (git4idea
    // `GitBranchesTreeMultiRepoModel`); with a single repo keep the flat
    // HEAD / Favorites / Local / Remote / Tags layout unchanged.
    if (!element) {
      const repositories = this._gitService.getRepositories();
      // Group under per-repo root nodes (git4idea MultiRepoModel) whenever
      // the workspace holds more than one repo. The selector's scope narrows
      // WHICH repos render — the tree mirrors the log's repository scope —
      // while the grouped presentation itself persists, so even a single
      // visible repo keeps its repo-name row (never a bare "Local").
      const groupByRepository = repositories.length > 1;
      if (groupByRepository) {
        return repositories
          .filter((repo) => this._scope.repoVisible(repo))
          .map((repo) =>
            BranchTreeItem.forRepository(
              repositoryLabel(repo),
              vscode.TreeItemCollapsibleState.Expanded,
              'repository',
              repo
            )
          );
      }
      if (!this._currentRepository) {
        return [];
      }
      return await this._getCategoryNodes(this._currentRepository);
    }

    // Repository node — expand into its own HEAD / Favorites / Local /
    // Remote / Tags sections, scoped to that repo.
    if (element.itemType === 'repository') {
      return element.repository ? await this._getCategoryNodes(element.repository) : [];
    }

    // Every node below the root carries the repo it belongs to in
    // multi-repo mode; the single-repo flat layout leaves it undefined
    // and falls back to the current repository.
    const repo = element.repository ?? this._currentRepository;
    if (!repo) {
      return [];
    }

    if (element.itemType === 'worktrees-category') {
      return await worktreeRows(this._gitService, repo);
    }

    // Category level - show items
    if (element.itemType === 'category') {
      try {
        switch (element.label) {
          case 'Favorites':
            return await this._getFavoriteBranches(repo);
          case 'Local':
            return await this._getLocalBranches(repo);
          case 'Remote':
            return await this._getRemoteBranches(repo);
          case 'Tags':
            return await this._getTags(repo);
          default:
            return [];
        }
      } catch (err) {
        // warn-level waypoint on refresh failure.
        // Re-throw so VS Code still surfaces the
        // error to the TreeView host (preserves pre-task observable
        // behaviour).
        this._logger.warn('refresh failed', {
          category: typeof element.label === 'string' ? element.label : '',
        });
        throw err;
      }
    }

    // Branch-folder level — descend into nested folder children.
    if (element.itemType === 'branch-folder') {
      try {
        return await this._getFolderChildren(element, repo);
      } catch (err) {
        this._logger.warn('refresh failed', {
          category: 'branch-folder',
          folderPath: element.folderPath,
        });
        throw err;
      }
    }

    return [];
  }

  /**
   * Build the category-level rows for `repo`: an optional Favorites
   * section, then the Local / Remote / Tags categories. The current branch
   * is conveyed by its checked row inside Local (a pinned HEAD row would
   * duplicate it); the detached state keeps its synthetic row inside Local.
   *
   * In the flat single-repo layout these are the tree's root children; in
   * the multi-repo layout they hang under a `'repository'` node. Each node
   * is tagged with `repo` so descendants resolve branches against the
   * right repository.
   */
  private async _getCategoryNodes(repo: IRepository): Promise<BranchTreeItem[]> {
    const nodes: BranchTreeItem[] = [];

    // One branch read for the Favorites gate; best-effort, so a failed
    // read still renders the categories.
    let branches: IBranch[] = [];
    try {
      branches = await this._gitService.getBranches(repo);
    } catch {
      branches = [];
    }

    // Favorites section — only when a ref that exists here is starred.
    if (this._hasAnyFavorite(repo, branches)) {
      nodes.push(this._categoryNode('Favorites', vscode.TreeItemCollapsibleState.Expanded, repo));
    }

    nodes.push(
      this._categoryNode('Local', vscode.TreeItemCollapsibleState.Expanded, repo),
      this._categoryNode('Remote', vscode.TreeItemCollapsibleState.Collapsed, repo),
      this._categoryNode('Tags', vscode.TreeItemCollapsibleState.Collapsed, repo),
      BranchTreeItem.forRepository(
        WORKTREES_CATEGORY,
        vscode.TreeItemCollapsibleState.Collapsed,
        'worktrees-category',
        repo
      )
    );

    return nodes;
  }

  /**
   * Build a Local / Remote / Tags category node tagged with its
   * repository so `getChildren` resolves the right branch list in
   * multi-repo mode.
   */
  private _categoryNode(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    repo: IRepository
  ): BranchTreeItem {
    return BranchTreeItem.forRepository(label, collapsibleState, 'category', repo);
  }

  /**
   * The starred local branches, rendered as flat leaf rows for the
   * Favorites section. Carries ahead/behind enrichment (when a fetcher
   * is injected) and the `current` affordance, matching the Local
   * section's leaves.
   */
  private async _getFavoriteBranches(repo: IRepository): Promise<BranchTreeItem[]> {
    const branches = await this._gitService.getBranches(repo);
    let favorites = branches.filter(
      (b) =>
        this.isFavorite(repo, b.name, b.type === 'remote' ? 'remote' : 'local') &&
        this._branchRowVisible(b)
    );
    if (this._incomingOutgoingFetcher) {
      favorites = await enrichBranchesWithIncomingOutgoing(
        repo,
        favorites,
        this._incomingOutgoingFetcher
      );
    }

    const head = repo.head;
    const currentBranchName = head?.name?.replace('refs/heads/', '');

    favorites.sort((a, b) => a.name.localeCompare(b.name));
    return favorites.map(
      (branch) =>
        new BranchTreeItem(
          branch.name,
          vscode.TreeItemCollapsibleState.None,
          // The section admits REMOTE refs too; each row keeps its own kind so
          // the right-click menu matches the ref (a local menu on origin/main
          // would offer a Checkout that detaches HEAD).
          branch.type === 'remote' ? 'remote-branch' : 'local-branch',
          branch,
          undefined,
          branch.type !== 'remote' && (branch.name === currentBranchName || branch.isHead),
          undefined,
          undefined,
          undefined,
          undefined,
          true, // isFavorite
          repo
        )
    );
  }

  private async _getLocalBranches(repo: IRepository): Promise<BranchTreeItem[]> {
    const items: BranchTreeItem[] = [];

    // When detached, prepend a "(HEAD detached at <sha>)" row at
    // the TOP of Local Branches. Detached signal: `head.name === undefined
    // && head.commit` is a non-empty string (per: `git symbolic-ref
    // HEAD` exits non-zero in detached state, so `head.name` is undefined;
    // `parseHead` always sets `head.commit` to `commitOutput.trim()`,
    // which can be the EMPTY string in a corrupt repo where rev-parse
    // also returned nothing — guard against that with `length > 0` so
    // we don't render `(HEAD detached at )` with an empty SHA).
    // Empty repo (`head` undefined entirely) falls through — no detached
    // row. Mid-rebase keeps `head.name` set, so no detached row there
    // either. Pinned by branchTree-detached-1..6.
    const head = repo.head;
    // The detached row is positional info, not a ref — a search narrows the
    // tree to matching refs, so the synthetic row steps aside.
    if (
      !this._searchQuery &&
      head &&
      head.name === undefined &&
      head.commit &&
      head.commit.length > 0
    ) {
      const shortSha = head.commit.substring(0, 7);
      items.push(
        new BranchTreeItem(
          `(HEAD detached at ${shortSha})`,
          vscode.TreeItemCollapsibleState.None,
          'detached-head',
          undefined,
          undefined,
          true, // isCurrentBranch — yes, the user IS here
          head.commit, // detachedHeadSha (full 40-char SHA)
          undefined,
          undefined,
          undefined,
          false, // isFavorite
          repo
        )
      );
    }

    const branches = await this._gitService.getBranches(repo);
    let localBranches = branches.filter((b) => b.type === 'local' && this._branchRowVisible(b));
    // Enrich tracked branches with ahead/behind counts so the tree renders
    // ↑N/↓N — matching the branch popup. No fetcher → branches pass through
    // untouched (no badges).
    if (this._incomingOutgoingFetcher) {
      localBranches = await enrichBranchesWithIncomingOutgoing(
        repo,
        localBranches,
        this._incomingOutgoingFetcher
      );
    }
    const currentBranchName = head?.name?.replace('refs/heads/', '');

    // IntelliJ-parity nesting: branches with `/` in their names group
    // into folder rows. `feature/auth/login` shows up as
    // `feature → auth → login` instead of a flat `feature/auth/login`
    // entry. Build the level-0 view by partitioning the branches into
    // first-segment buckets.
    const groupedItems = this._groupBranchesByPath(
      localBranches,
      '',
      'local',
      currentBranchName,
      undefined,
      repo
    );
    items.push(...groupedItems);

    return items;
  }

  private async _getRemoteBranches(repo: IRepository): Promise<BranchTreeItem[]> {
    const branches = await this._gitService.getBranches(repo);
    const remoteBranches = branches.filter((b) => b.type === 'remote' && this._branchRowVisible(b));

    // First level under "Remote": one folder per remote name (origin,
    // upstream, …). The remote name is segment 0 of the branch's full
    // name (`origin/main` → remote=origin, leaf=main). When a remote
    // has only one branch we still nest it under the remote folder so
    // the user sees a consistent "remote → branches" structure
    // (matches IntelliJ).
    const byRemote = new Map<string, IBranch[]>();
    for (const branch of remoteBranches) {
      const slash = branch.name.indexOf('/');
      if (slash <= 0) {
        // Defensive: a remote branch without a `/` is malformed; surface it
        // at the top level rather than dropping it on the floor.
        const items = byRemote.get('') ?? [];
        items.push(branch);
        byRemote.set('', items);
        continue;
      }
      const remote = branch.name.slice(0, slash);
      const list = byRemote.get(remote) ?? [];
      list.push(branch);
      byRemote.set(remote, list);
    }

    const remoteNames = Array.from(byRemote.keys()).sort(compareRefNames);
    return remoteNames.map((remoteName) => {
      if (remoteName === '') {
        // Malformed branches (no `/` in the name) — render them as
        // a flat group under a synthetic empty-name folder so they're
        // still visible. Should never happen in practice.
        return new BranchTreeItem(
          '(unknown remote)',
          vscode.TreeItemCollapsibleState.Collapsed,
          'branch-folder',
          undefined,
          undefined,
          false,
          undefined,
          '',
          'remote',
          '',
          false,
          repo
        );
      }
      return new BranchTreeItem(
        remoteName,
        vscode.TreeItemCollapsibleState.Collapsed,
        'branch-folder',
        undefined,
        undefined,
        false,
        undefined,
        '',
        'remote',
        remoteName,
        false,
        repo
      );
    });
  }

  /**
   * Build the children of a {@link BranchTreeItem} whose itemType is
   * `'branch-folder'`. Re-fetches the branches (cheap; gitService
   * caches) and partitions them at the next path segment after
   * {@link BranchTreeItem.folderPath} (and {@link BranchTreeItem.remotePrefix}
   * for remotes).
   */
  private async _getFolderChildren(
    folder: BranchTreeItem,
    repo: IRepository
  ): Promise<BranchTreeItem[]> {
    if (!folder.folderScope) {
      return [];
    }
    if (folder.folderScope === 'tag') {
      return this._groupTagsByPath(await this._visibleTags(repo), folder.folderPath ?? '', repo);
    }
    const branches = await this._gitService.getBranches(repo);
    const filtered = branches.filter(
      (b) => b.type === folder.folderScope && this._branchRowVisible(b)
    );

    const head = repo.head;
    const currentBranchName = head?.name?.replace('refs/heads/', '');

    return this._groupBranchesByPath(
      filtered,
      folder.folderPath ?? '',
      folder.folderScope,
      currentBranchName,
      folder.remotePrefix,
      repo
    );
  }

  /**
   * Partition a flat list of branches into the children at a given
   * folder level (path-prefix grouping, IntelliJ parity).
   *
   * @param branches    Flat list of branches at this scope (already
   *                    filtered to local-only or remote-only).
   * @param folderPath  Slash-joined path from the category root,
   *                    excluding the {@link remotePrefix} for remotes.
   *                    Empty string means "at the root of the
   *                    category" (top-level for Local; underneath a
   *                    specific remote for Remote).
   * @param scope       `'local'` or `'remote'`.
   * @param currentBranchName HEAD's branch name (for the `current`
   *                    affordance; only meaningful for local
   *                    branches).
   * @param remotePrefix Remote-name prefix to strip from each branch
   *                    name before partitioning (e.g. `origin`).
   *                    Undefined for local branches.
   * @param repo        Repository this subtree belongs to, propagated to
   *                    the folder nodes so their children resolve against
   *                    the right repo in multi-repo mode.
   */
  private _groupBranchesByPath(
    branches: IBranch[],
    folderPath: string,
    scope: BranchFolderScope,
    currentBranchName: string | undefined,
    remotePrefix: string | undefined,
    repo: IRepository
  ): BranchTreeItem[] {
    const { folders, leaves } = partitionRefsByPathSegment(branches, folderPath, remotePrefix);

    const items: BranchTreeItem[] = folders.map((f) =>
      this._folderNode(f.segment, f.childPath, scope, remotePrefix, repo)
    );

    for (const { ref: branch, displayName } of leaves) {
      if (scope === 'local') {
        const isCurrentBranch = branch.name === currentBranchName || branch.isHead;
        items.push(
          new BranchTreeItem(
            displayName,
            vscode.TreeItemCollapsibleState.None,
            'local-branch',
            branch,
            undefined,
            isCurrentBranch,
            undefined,
            undefined,
            undefined,
            undefined,
            this.isFavorite(repo, branch.name), // isFavorite
            repo
          )
        );
      } else {
        items.push(
          new BranchTreeItem(
            displayName,
            vscode.TreeItemCollapsibleState.None,
            'remote-branch',
            branch,
            undefined,
            false,
            undefined,
            undefined,
            undefined,
            undefined,
            this.isFavorite(repo, branch.name, 'remote'), // isFavorite
            repo
          )
        );
      }
    }

    return items;
  }

  private async _getTags(repo: IRepository): Promise<BranchTreeItem[]> {
    return this._groupTagsByPath(await this._visibleTags(repo), '', repo);
  }

  /** Tags surviving the search filter; the folder layout is built from these. */
  private async _visibleTags(repo: IRepository): Promise<ITag[]> {
    return (await this._gitService.getTags(repo)).filter((t) => this._matchesSearch(t.name));
  }

  /**
   * Partition tags into the children at one folder level, mirroring
   * {@link _groupBranchesByPath}. Tags have no remote prefix and no
   * current-ref affordance, so the leaf arm is the whole difference.
   */
  private _groupTagsByPath(tags: ITag[], folderPath: string, repo: IRepository): BranchTreeItem[] {
    const { folders, leaves } = partitionRefsByPathSegment(tags, folderPath, undefined);

    const items: BranchTreeItem[] = folders.map((f) =>
      this._folderNode(f.segment, f.childPath, 'tag', undefined, repo)
    );

    for (const { ref: tag, displayName } of leaves) {
      items.push(
        new BranchTreeItem(
          displayName,
          vscode.TreeItemCollapsibleState.None,
          'tag',
          undefined,
          tag,
          false,
          undefined,
          undefined,
          undefined,
          undefined,
          false,
          repo
        )
      );
    }

    return items;
  }

  /** One nesting node, shared by every ref kind that folds on `/`. */
  private _folderNode(
    segment: string,
    childPath: string,
    scope: BranchFolderScope,
    remotePrefix: string | undefined,
    repo: IRepository
  ): BranchTreeItem {
    return new BranchTreeItem(
      segment,
      vscode.TreeItemCollapsibleState.Collapsed,
      'branch-folder',
      undefined,
      undefined,
      false,
      undefined,
      childPath,
      scope,
      remotePrefix,
      false,
      repo
    );
  }
}

/**
 * Create a new BranchTreeProvider instance.
 *
 * @param gitService - The Git service to use
 * @param favoritesStore - Shared favorites store (workspaceState-backed via
 *   {@link createFavoritesStore}), the same instance the branch popup uses so
 *   stars stay consistent across both surfaces. When omitted, favorites live
 *   only for the provider's lifetime.
 * @returns A new BranchTreeProvider instance
 */
export function createBranchTreeProvider(
  gitService: IGitService,
  favoritesStore?: IFavoritesStore
): BranchTreeProvider {
  // Wire the incoming/outgoing fetcher when the concrete GitService exposes
  // it so tracked branches in the tree show ↑N/↓N badges (ADR-001: the method
  // is off the frozen IGitService interface, detected via duck-typing).
  const provider = new BranchTreeProvider(
    gitService,
    getIncomingOutgoingFetcher(gitService),
    favoritesStore
  );
  activeBranchTreeProvider = provider;
  return provider;
}

/** The factory-created provider instance, for {@link getBranchTreeProvider}. */
let activeBranchTreeProvider: BranchTreeProvider | undefined;

/**
 * The live Branches tree provider (factory-created; cleared on dispose).
 * Bundle-singleton seam for the Electron test bridge — re-exported from
 * extension.ts so the e2e lane can assert the tree's repository scoping
 * against real multi-root fixtures (see test/e2e/support/activatedExtension.ts).
 */
export function getBranchTreeProvider(): BranchTreeProvider | undefined {
  return activeBranchTreeProvider;
}
