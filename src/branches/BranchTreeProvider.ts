/**
 * Branch Tree Provider implementation.
 * Provides a tree view of branches with context menu support.
 */

import * as vscode from 'vscode';
import { IGitService, IRepository, IBranch, ITag } from '../git-core/interfaces/IGitService';
import { resolveRepo } from '../utils/resolveRepo';
import { safeFireAndForget } from '../utils/safeFireAndForget';
import { getLogger, type Logger } from '../utils/logger';
import {
  loadPersisted,
  savePersisted,
  readStringArray,
  type PersistedSlot,
} from '../utils/persistedState';
import {
  enrichBranchesWithIncomingOutgoing,
  getIncomingOutgoingFetcher,
  type IncomingOutgoingFetcher,
} from './BranchPopup';

/**
 * Last path segment of a repository root, used as the label of a
 * `'repository'` root node in multi-repo mode. Matches the repo-name
 * derivation used elsewhere (e.g. the update/pull/push repo pickers).
 */
function repositoryLabel(repo: IRepository): string {
  const fsPath = repo.rootUri.fsPath;
  return fsPath.split(/[\\/]/).filter(Boolean).pop() ?? fsPath;
}

/**
 * charts.* theme colors usable on tree icons, blue first to match the
 * graph's blue-leads convention. git4idea parity: repository nodes render a
 * per-repository color (VcsRepositoryIconsProvider, colored square); here
 * the repo glyph itself takes the color.
 */
const REPOSITORY_ICON_COLORS: readonly string[] = [
  'charts.blue',
  'charts.orange',
  'charts.yellow',
  'charts.purple',
  'charts.green',
  'charts.red',
];

/**
 * Per-repository icon color from a STABLE hash of the repo label (the same
 * `String.hashCode` idiom as the graph's branchColorFor), so a repository
 * keeps its color across refreshes and sessions. Two same-named roots share
 * a color — the same accepted collision class as two branches sharing a
 * palette slot.
 */
function repositoryIconColor(label: string): vscode.ThemeColor {
  let h = 0;
  for (let i = 0; i < label.length; i++) {
    h = (Math.imul(31, h) + label.charCodeAt(i)) | 0;
  }
  const n = REPOSITORY_ICON_COLORS.length;
  return new vscode.ThemeColor(REPOSITORY_ICON_COLORS[((h % n) + n) % n]);
}

/**
 * Tree item types for the branch tree
 */
export type BranchTreeItemType =
  | 'local-branch'
  | 'remote-branch'
  | 'tag'
  | 'category'
  | 'detached-head' // Synthetic row for detached HEAD state — the only HEAD-specific row (an attached HEAD is the checked row inside Local)
  | 'branch-folder' // IntelliJ-parity nesting node ("feature" container with feature/* children)
  | 'repository'; // Per-repository root node in a multi-repo workspace (git4idea GitBranchesTreeMultiRepoModel)

/**
 * Branch-folder scope (the kind of branches the folder groups).
 * Used to dispatch back to the right branch list when expanding the
 * folder.
 */
export type BranchFolderScope = 'local' | 'remote';

/**
 * Context values for tree items (used in when clauses for menus)
 */
export const CONTEXT_VALUES = {
  LOCAL_BRANCH: 'intellig.localBranch',
  LOCAL_BRANCH_CURRENT: 'intellig.localBranchCurrent',
  REMOTE_BRANCH: 'intellig.remoteBranch',
  TAG: 'intellig.tag',
  CATEGORY: 'intellig.category',
  DETACHED_HEAD: 'intellig.detachedHead',
  BRANCH_FOLDER: 'intellig.branchFolder',
  REPOSITORY: 'intellig.repository',
} as const;

/**
 * Memento key under which favorite refs are persisted.
 * Mirrors git4idea's `DvcsBranchSettings` (favorites + excluded-from-favorite),
 * keyed by repository path so a star in one root stays in that root.
 */
const FAVORITES_MEMENTO_KEY = 'intellig.branchTree.favorites';

/** Which ref namespace a favorite belongs to (git4idea GitBranchType). */
export type FavoriteRefType = 'local' | 'remote';

/**
 * One starred (or explicitly un-starred) ref. `repoPath` is the repository
 * root; the empty string is the all-repositories bucket that legacy, unscoped
 * favorites migrate into (DvcsBranchInfo.repoPath).
 */
export interface IFavoriteRef {
  repoPath: string;
  type: FavoriteRefType;
  name: string;
}

/** Persisted favorites state: explicit stars plus explicit un-stars. */
export interface IFavoritesState {
  favorites: IFavoriteRef[];
  excluded: IFavoriteRef[];
}

/**
 * Names starred out of the box (GitBranchManager.getDefaultBranchNames).
 * A default applies to every repository until explicitly excluded.
 */
const PREDEFINED_FAVORITES: Readonly<Record<FavoriteRefType, readonly string[]>> = {
  local: ['master', 'main'],
  remote: ['origin/master', 'origin/main'],
};

function isPredefinedFavorite(type: FavoriteRefType, name: string): boolean {
  return PREDEFINED_FAVORITES[type].includes(name);
}

function readFavoriteRefs(raw: unknown): IFavoriteRef[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const refs: IFavoriteRef[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const { repoPath, type, name } = entry as Record<string, unknown>;
    if (
      typeof repoPath === 'string' &&
      (type === 'local' || type === 'remote') &&
      typeof name === 'string' &&
      name.length > 0
    ) {
      refs.push({ repoPath, type, name });
    }
  }
  return refs;
}

/** Persisted slot for the favorites state. */
export const FAVORITES_SLOT: PersistedSlot<IFavoritesState> = {
  key: FAVORITES_MEMENTO_KEY,
  version: 2,
  validate: (raw) => {
    if (typeof raw !== 'object' || raw === null) {
      return undefined;
    }
    const favorites = readFavoriteRefs((raw as Record<string, unknown>).favorites);
    const excluded = readFavoriteRefs((raw as Record<string, unknown>).excluded);
    return favorites && excluded ? { favorites, excluded } : undefined;
  },
};

/** Store key for a repository; '' is the all-repositories bucket. */
function favoritesRepoPath(repo: IRepository | undefined): string {
  return repo?.rootUri.fsPath ?? '';
}

/**
 * An entry addressed to exactly this repository. This is the WRITE-path rule
 * (git4idea `BranchStorage.add/remove/contains` resolve their target by
 * strict `repoPath` equality — platform/dvcs-impl/shared/src/com/intellij/
 * dvcs/branch/BranchStorage.kt `find()`), so a mutation in one root never
 * rewrites another root's entry.
 */
function matchesExact(
  ref: IFavoriteRef,
  type: FavoriteRefType,
  repoPath: string,
  name: string
): boolean {
  return ref.type === type && ref.name === name && ref.repoPath === repoPath;
}

/**
 * An all-repositories entry, which applies to every root on the READ path
 * (git4idea fans `repoPath == ""` out across roots in
 * `DvcsBranchManager.collectBranchesByRoot`).
 */
function matchesAllRepos(ref: IFavoriteRef, type: FavoriteRefType, name: string): boolean {
  return ref.type === type && ref.name === name && ref.repoPath === '';
}

/**
 * Resolve whether a ref reads as starred in `repoPath`. A repository-scoped
 * entry outranks an all-repositories one, so un-starring in a single root
 * shadows a shared star there and leaves it standing everywhere else;
 * predefined defaults apply last (DvcsBranchManager.isFavorite ordering).
 */
function resolveFavorite(
  favorites: readonly IFavoriteRef[],
  excluded: readonly IFavoriteRef[],
  type: FavoriteRefType,
  repoPath: string,
  name: string
): boolean {
  if (favorites.some((ref) => matchesExact(ref, type, repoPath, name))) {
    return true;
  }
  if (excluded.some((ref) => matchesExact(ref, type, repoPath, name))) {
    return false;
  }
  if (favorites.some((ref) => matchesAllRepos(ref, type, name))) {
    return true;
  }
  if (excluded.some((ref) => matchesAllRepos(ref, type, name))) {
    return false;
  }
  return isPredefinedFavorite(type, name);
}

/**
 * Persistence seam for favorite refs (git4idea parity: `DvcsBranchManager` +
 * `DvcsBranchSettings`). Resolution follows DvcsBranchManager.isFavorite: an
 * explicit star wins, then an explicit exclusion, then the predefined
 * defaults. Constructor-injected so favorites survive across sessions in
 * production (Memento-backed) while unit tests drive an in-memory double.
 *
 * Observable: {@link onDidChangeFavorites} fires whenever a mutation lands, so
 * every surface sharing the store (Branches tree, branch popup) stays
 * live-consistent within a session. `dispose` tears down the change emitter;
 * the store's owner (the extension) calls it, not the injected consumers.
 */
export interface IFavoritesStore {
  isFavorite(type: FavoriteRefType, repoPath: string, name: string): boolean;
  setFavorite(type: FavoriteRefType, repoPath: string, name: string, favorite: boolean): void;
  /** Resolved favorite names for a repository: defaults plus stars, minus exclusions. */
  favoriteNames(type: FavoriteRefType, repoPath: string): string[];
  readonly onDidChangeFavorites: vscode.Event<void>;
  dispose(): void;
}

/**
 * Shared base for the {@link IFavoritesStore} implementations. Owns the
 * change-emitter plumbing and the favorite/excluded resolution rules, so a
 * backing store only supplies state {@link _load} / {@link _save}.
 */
abstract class FavoritesStoreBase implements IFavoritesStore {
  private readonly _onDidChangeFavorites = new vscode.EventEmitter<void>();
  readonly onDidChangeFavorites = this._onDidChangeFavorites.event;

  protected abstract _load(): IFavoritesState;
  protected abstract _save(state: IFavoritesState): void;

  isFavorite(type: FavoriteRefType, repoPath: string, name: string): boolean {
    const state = this._load();
    return resolveFavorite(state.favorites, state.excluded, type, repoPath, name);
  }

  /**
   * Record the star state for `repoPath` only. Entries owned by other roots
   * — including the shared all-repositories bucket — are left verbatim; the
   * new state is expressed by adding the repository-scoped entry that flips
   * the resolution, exactly as git4idea's strict-equality storage does.
   */
  setFavorite(type: FavoriteRefType, repoPath: string, name: string, favorite: boolean): void {
    const state = this._load();
    const without = (refs: IFavoriteRef[]): IFavoriteRef[] =>
      refs.filter((ref) => !matchesExact(ref, type, repoPath, name));
    const favorites = without(state.favorites);
    const excluded = without(state.excluded);
    const entry: IFavoriteRef = { repoPath, type, name };
    const readsFavorite = resolveFavorite(favorites, excluded, type, repoPath, name);
    const next: IFavoritesState =
      favorite === readsFavorite
        ? { favorites, excluded }
        : favorite
          ? { favorites: [...favorites, entry], excluded }
          : { favorites, excluded: [...excluded, entry] };
    this._save(next);
    this._fireChange();
  }

  favoriteNames(type: FavoriteRefType, repoPath: string): string[] {
    const state = this._load();
    const candidates = new Set<string>(PREDEFINED_FAVORITES[type]);
    for (const ref of state.favorites) {
      if (ref.type === type && (ref.repoPath === repoPath || ref.repoPath === '')) {
        candidates.add(ref.name);
      }
    }
    return [...candidates].filter((name) =>
      resolveFavorite(state.favorites, state.excluded, type, repoPath, name)
    );
  }

  protected _fireChange(): void {
    this._onDidChangeFavorites.fire();
  }
  dispose(): void {
    this._onDidChangeFavorites.dispose();
  }
}

/**
 * In-memory {@link IFavoritesStore} used when no persistent store is
 * supplied (tests, and as a safe default that keeps favorites for the
 * lifetime of the provider). Production wires {@link MementoFavoritesStore}.
 */
export class InMemoryFavoritesStore extends FavoritesStoreBase {
  private _state: IFavoritesState = { favorites: [], excluded: [] };
  protected _load(): IFavoritesState {
    return this._state;
  }
  protected _save(state: IFavoritesState): void {
    this._state = state;
  }
}

/**
 * {@link IFavoritesStore} backed by a VS Code {@link vscode.Memento}
 * (the extension's workspaceState) so favorites persist across sessions
 * per workspace — the analogue of git4idea persisting branch settings in
 * PROJECT-level state (starring `main` in one project must not star `main`
 * everywhere).
 */
class MementoFavoritesStore extends FavoritesStoreBase {
  constructor(private readonly _memento: vscode.Memento) {
    super();
  }
  protected _load(): IFavoritesState {
    return loadPersisted(this._memento, FAVORITES_SLOT) ?? { favorites: [], excluded: [] };
  }
  protected _save(state: IFavoritesState): void {
    void savePersisted(this._memento, FAVORITES_SLOT, state);
  }
}

/**
 * Read any pre-repo-scope payload as all-repository LOCAL stars. The old slot
 * held a bare (or version-1 enveloped) array of local branch names, which had
 * no repository dimension — so those stars keep applying everywhere.
 */
function migrateFlatFavorites(raw: unknown): IFavoritesState | undefined {
  const names = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' && raw !== null && (raw as { v?: unknown }).v === 1
      ? (raw as { data?: unknown }).data
      : undefined;
  const flat = readStringArray(names);
  if (!flat) {
    return undefined;
  }
  return {
    favorites: flat.map((name) => ({ repoPath: '', type: 'local' as const, name })),
    excluded: [],
  };
}

/**
 * Build the shared, Memento-backed favorites store — the single source of
 * truth for starred refs across the Branches tree and the branch popup
 * (git4idea parity: one project-level `DvcsBranchSettings`). Persists to
 * `workspaceState`. Favorites once lived in globalState as a flat name list;
 * both the legacy location and the legacy shape are migrated once, leaving the
 * legacy slot intact so other workspaces can run the same migration.
 */
export function createFavoritesStore(
  workspaceState: vscode.Memento,
  legacyGlobalState?: vscode.Memento
): IFavoritesStore {
  // RAW-key reads: the current slot validator rejects the legacy shapes, so a
  // migration probe cannot go through loadPersisted.
  // persisted-state-exempt: migration probe only — the steady-state reads and writes below go through loadPersisted/savePersisted.
  const workspaceRaw = workspaceState.get(FAVORITES_SLOT.key);
  if (workspaceRaw !== undefined) {
    const migrated = migrateFlatFavorites(workspaceRaw);
    if (migrated) {
      void savePersisted(workspaceState, FAVORITES_SLOT, migrated);
    }
  } else if (legacyGlobalState) {
    // persisted-state-exempt: migration probe only — see above.
    const legacyRaw = legacyGlobalState.get(FAVORITES_SLOT.key);
    const legacy = migrateFlatFavorites(legacyRaw) ?? FAVORITES_SLOT.validate(legacyRaw);
    if (legacy) {
      void savePersisted(workspaceState, FAVORITES_SLOT, legacy);
    }
  }
  return new MementoFavoritesStore(workspaceState);
}

/**
 * Branch tree item representing a branch, tag, or category in the tree view
 */
/**
 * Where should the git graph navigate when this tree row is selected?
 * Branch rows jump by NAME (the graph resolves the tip from its branch
 * map) plus the row's repo root when it has one — in a multi-root workspace
 * several repos carry a same-named branch, and the merged log needs the root
 * to land on the clicked repo's tip. Tag rows jump by the tag's peeled
 * COMMIT hash (tags aren't in the branch map, so name-based lookup can't
 * find them — the class of bug that left tag clicks doing nothing);
 * structural rows (categories, folders, repository headers) don't navigate.
 */
export function graphTargetForTreeSelection(
  item: BranchTreeItem
):
  | { kind: 'branch'; name: string; repoRoot?: string }
  | { kind: 'commit'; hash: string }
  | undefined {
  if (item.branch) {
    const repoRoot = item.repository?.rootUri.fsPath;
    return repoRoot
      ? { kind: 'branch', name: item.branch.name, repoRoot }
      : { kind: 'branch', name: item.branch.name };
  }
  if (item.tag) {
    return { kind: 'commit', hash: item.tag.commit };
  }
  return undefined;
}

export class BranchTreeItem extends vscode.TreeItem {
  public readonly itemType: BranchTreeItemType;
  public readonly branch?: IBranch;
  public readonly tag?: ITag;
  public readonly isCurrentBranch: boolean;
  /**
   * Full 40-char commit SHA when {@link itemType} is
   * `'detached-head'`. Read by dispatcher (e.g. `_handleCheckout`,
   * `_handleNewBranchFrom`) via {@link getDetachedHeadSha}; never reach
   * inside this field directly so the dispatcher contract stays
   * grep-able.
   *
   * Undefined for every non-detached-head row.
   */
  private readonly _detachedHeadSha?: string;
  /**
   * Folder-path data for {@link itemType} === `'branch-folder'`.
   *
   * `folderPath` is the slash-joined path from the category root
   * (e.g. `feature` or `feature/auth`); `folderScope` is `'local'` or
   * `'remote'` so getChildren can re-fetch the right branch list.
   * `remotePrefix` is the remote name (e.g. `origin`) when the folder
   * lives under the Remote category — remote branches arrive as
   * `origin/feature/auth`, but the user-visible path under Remote is
   * `origin → feature → auth`, so we keep the prefix separate from
   * `folderPath` to avoid double-counting `origin/` while filtering.
   *
   * All three are undefined for non-folder rows.
   */
  public readonly folderPath?: string;
  public readonly folderScope?: BranchFolderScope;
  public readonly remotePrefix?: string;
  /**
   * True when this row is a branch the user has starred (git4idea
   * parity: `GitRepositoryModel.favoriteRefs`). Drives the star icon.
   * Always false for non-branch rows.
   */
  public readonly isFavorite: boolean;
  /**
   * Repository this node belongs to in a multi-repo workspace
   * (git4idea parity: `GitBranchesTreeMultiRepoModel` builds a
   * `RepositoryNode` per repo). Set on the `'repository'` root node and
   * propagated to every section/folder node beneath it so `getChildren`
   * resolves branches against the right repo. Undefined in the
   * single-repo flat layout, where the provider falls back to its
   * `_currentRepository`.
   */
  public readonly repository?: IRepository;

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    itemType: BranchTreeItemType,
    branch?: IBranch,
    tag?: ITag,
    isCurrentBranch: boolean = false,
    detachedHeadSha?: string, // Full 40-char SHA for detached row
    folderPath?: string,
    folderScope?: BranchFolderScope,
    remotePrefix?: string,
    isFavorite: boolean = false,
    repository?: IRepository
  ) {
    super(label, collapsibleState);

    this.itemType = itemType;
    this.branch = branch;
    this.tag = tag;
    this.isCurrentBranch = isCurrentBranch;
    this._detachedHeadSha = detachedHeadSha;
    this.folderPath = folderPath;
    this.folderScope = folderScope;
    this.remotePrefix = remotePrefix;
    this.isFavorite = isFavorite;
    this.repository = repository;

    // Set context value for menu contributions
    this.contextValue = this._getContextValue();

    // Set icon based on type
    this.iconPath = this._getIcon();

    // Set description for branches
    this.description = this._getDescription();

    // Set tooltip
    this.tooltip = this._getTooltip();

    // accessibilityInformation for the synthetic
    // detached-head row. VS Code's TreeView reads `label + description`
    // by default; for the detached row we want the SR to hear the
    // multi-line tooltip's leading phrase ("Detached HEAD — at <sha>")
    // because the visible label is just `(HEAD detached at <sha>)` and
    // the description ("detached") doesn't convey "this is your current
    // commit". Pinned by `branchTree-detached-aria-1` in
    // BranchTreeProvider.test.ts.
    if (this.itemType === 'detached-head') {
      const sha = this._detachedHeadSha ?? '';
      const shortSha = sha.length >= 7 ? sha.substring(0, 7) : sha;
      this.accessibilityInformation = {
        label: shortSha
          ? `Detached HEAD at ${shortSha} — not on a branch`
          : 'Detached HEAD — not on a branch',
        role: 'treeitem',
      };
    }
  }

  /**
   * Public accessor for the detached HEAD SHA. Returns the full
   * 40-char commit SHA when this row is the synthetic detached-head row;
   * `undefined` otherwise.
   *
   * Dispatchers (`_handleCheckout`, `_handleNewBranchFrom`) call this
   * to obtain the git start-point WITHOUT reading the parenthesized
   * label string — that path is the regression class.
   */
  public getDetachedHeadSha(): string | undefined {
    return this._detachedHeadSha;
  }

  private _getContextValue(): string {
    switch (this.itemType) {
      case 'local-branch':
        // Favorite state is conveyed by the star icon, not the context
        // value — so a starred branch keeps the full local-branch menu
        // (checkout, compare, …). The Toggle Favorite action binds to
        // both local-branch context values.
        return this.isCurrentBranch
          ? CONTEXT_VALUES.LOCAL_BRANCH_CURRENT
          : CONTEXT_VALUES.LOCAL_BRANCH;
      case 'remote-branch':
        return CONTEXT_VALUES.REMOTE_BRANCH;
      case 'tag':
        return CONTEXT_VALUES.TAG;
      case 'category':
        return CONTEXT_VALUES.CATEGORY;
      case 'detached-head':
        return CONTEXT_VALUES.DETACHED_HEAD;
      case 'branch-folder':
        return CONTEXT_VALUES.BRANCH_FOLDER;
      case 'repository':
        return CONTEXT_VALUES.REPOSITORY;
      default:
        return '';
    }
  }

  private _getIcon(): vscode.ThemeIcon {
    switch (this.itemType) {
      case 'repository':
        // Per-repository root node — the repo glyph in this repository's
        // stable color, so repos are tellable apart at a glance in the
        // grouped multi-root layout.
        return new vscode.ThemeIcon(
          'repo',
          repositoryIconColor(typeof this.label === 'string' ? this.label : '')
        );
      case 'local-branch':
        if (this.isCurrentBranch) {
          return new vscode.ThemeIcon(
            'check',
            new vscode.ThemeColor('gitDecoration.addedResourceForeground')
          );
        }
        // Starred branches get a filled star (git4idea parity: favorite
        // refs render with the favorite/star icon).
        return this.isFavorite
          ? new vscode.ThemeIcon('star-full')
          : new vscode.ThemeIcon('git-branch');
      case 'remote-branch':
        // Both local and remote branches use the same git-branch icon
        // (per UX request to drop the cloud-vs-branch distinction). The
        // ref kind is still distinguishable via the parent category in
        // the tree (`Local` vs `Remote`) and the `Remote branch:` aria
        // label on chips. Favorites star the same way either side of that
        // line — a remote ref can be starred, so it must be able to show it.
        return this.isFavorite
          ? new vscode.ThemeIcon('star-full')
          : new vscode.ThemeIcon('git-branch');
      case 'tag':
        return new vscode.ThemeIcon('tag');
      case 'category':
        return new vscode.ThemeIcon('folder');
      case 'branch-folder':
        return new vscode.ThemeIcon('folder');
      case 'detached-head':
        // yellow/gold matches the HEAD chip in the graph
        // (`statusBarItem.warningBackground`). User reads "this is HEAD"
        // consistently across both surfaces.
        return new vscode.ThemeIcon(
          'git-commit',
          new vscode.ThemeColor('statusBarItem.warningBackground')
        );
      default:
        return new vscode.ThemeIcon('circle-outline');
    }
  }

  private _getDescription(): string | undefined {
    // Synthetic detached-head row description. Distinct from
    // 'current' (which implies a branch is checked out) — 'detached'
    // reads as "you are at this commit; HEAD is not bound to a branch".
    if (this.itemType === 'detached-head') {
      return 'detached';
    }
    if (this.branch) {
      const parts: string[] = [];

      if (this.isCurrentBranch) {
        parts.push('current');
      }

      if (this.branch.ahead !== undefined && this.branch.ahead > 0) {
        parts.push(`↑${this.branch.ahead}`);
      }

      if (this.branch.behind !== undefined && this.branch.behind > 0) {
        parts.push(`↓${this.branch.behind}`);
      }

      if (parts.length === 0 && this.branch.commit) {
        parts.push(this.branch.commit.substring(0, 7));
      }

      return parts.join(' ');
    }

    if (this.tag) {
      return this.tag.commit.substring(0, 7);
    }

    return undefined;
  }

  private _getTooltip(): string {
    // Per-repository root node tooltip — the repository's root path.
    if (this.itemType === 'repository') {
      const name = typeof this.label === 'string' ? this.label : '';
      const path = this.repository?.rootUri.fsPath;
      return path ? `Repository: ${name}\n${path}` : `Repository: ${name}`;
    }
    // Synthetic detached-head row tooltip.
    if (this.itemType === 'detached-head') {
      const sha = this._detachedHeadSha ?? '';
      return (
        `Detached HEAD\n` +
        `Commit: ${sha}\n` +
        `(Not on a branch — checkout a branch to attach HEAD)`
      );
    }
    if (this.branch) {
      let tooltip = `Branch: ${this.branch.name}`;
      if (this.branch.commit) {
        tooltip += `\nCommit: ${this.branch.commit}`;
      }
      if (this.branch.upstream) {
        tooltip += `\nUpstream: ${this.branch.upstream.remote}/${this.branch.upstream.name}`;
      }
      if (this.isCurrentBranch) {
        tooltip += '\n(Current Branch)';
      }
      return tooltip;
    }

    if (this.tag) {
      let tooltip = `Tag: ${this.tag.name}`;
      tooltip += `\nCommit: ${this.tag.commit}`;
      if (this.tag.message) {
        tooltip += `\nMessage: ${this.tag.message}`;
      }
      if (this.tag.isAnnotated) {
        tooltip += '\n(Annotated Tag)';
      }
      return tooltip;
    }

    return typeof this.label === 'string' ? this.label : '';
  }
}

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
   * Record the repository selected in the Git tool window's selector. The
   * tree's LAYOUT never changes with the selection (a multi-root workspace
   * always renders the grouped per-repo layout — git4idea parity: the
   * branches component is independent of the log's root filter); the
   * recorded repo backs the single-repo flat layout and the fallback repo
   * for rows that don't carry their own.
   */
  setRepository(repo: IRepository): void {
    this._currentRepository = repo;
    this.refresh();
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
      // the workspace holds more than one repo. The repository selector
      // narrows the LOG only — the grouped layout persists so the tree never
      // loses the repo-name context (and never collapses to a bare "Local").
      const groupByRepository = repositories.length > 1;
      if (groupByRepository) {
        return repositories.map(
          (repo) =>
            new BranchTreeItem(
              repositoryLabel(repo),
              vscode.TreeItemCollapsibleState.Expanded,
              'repository',
              undefined,
              undefined,
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
      nodes.push(
        new BranchTreeItem(
          'Favorites',
          vscode.TreeItemCollapsibleState.Expanded,
          'category',
          undefined,
          undefined,
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

    nodes.push(
      this._categoryNode('Local', vscode.TreeItemCollapsibleState.Expanded, repo),
      this._categoryNode('Remote', vscode.TreeItemCollapsibleState.Collapsed, repo),
      this._categoryNode('Tags', vscode.TreeItemCollapsibleState.Collapsed, repo)
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
    return new BranchTreeItem(
      label,
      collapsibleState,
      'category',
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      repo
    );
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
        this._matchesSearch(b.name)
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
    let localBranches = branches.filter((b) => b.type === 'local' && this._matchesSearch(b.name));
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
    const remoteBranches = branches.filter(
      (b) => b.type === 'remote' && this._matchesSearch(b.name)
    );

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

    const remoteNames = Array.from(byRemote.keys()).sort();
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
    const branches = await this._gitService.getBranches(repo);
    const filtered = branches.filter(
      (b) => b.type === folder.folderScope && this._matchesSearch(b.name)
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
    // Compute, for each branch, the path-stripped suffix relative to
    // the current folder. Drop branches that don't fall under the
    // folder.
    const stripPrefix = (name: string): string | undefined => {
      let rest = name;
      if (remotePrefix) {
        const remoteWithSlash = `${remotePrefix}/`;
        if (!rest.startsWith(remoteWithSlash)) {
          return undefined;
        }
        rest = rest.slice(remoteWithSlash.length);
      }
      if (folderPath) {
        const folderWithSlash = `${folderPath}/`;
        if (!rest.startsWith(folderWithSlash)) {
          return undefined;
        }
        rest = rest.slice(folderWithSlash.length);
      }
      return rest;
    };

    // Bucket: first segment of the suffix → either the leaf branch (no
    // more `/` in the suffix) or a list of branches grouped under that
    // segment as a folder.
    const leaves: IBranch[] = [];
    const folderBuckets = new Map<string, IBranch[]>();
    for (const branch of branches) {
      const suffix = stripPrefix(branch.name);
      if (suffix === undefined || suffix === '') {
        continue;
      }
      const slash = suffix.indexOf('/');
      if (slash === -1) {
        leaves.push(branch);
      } else {
        const segment = suffix.slice(0, slash);
        const list = folderBuckets.get(segment) ?? [];
        list.push(branch);
        folderBuckets.set(segment, list);
      }
    }

    // Render order (IntelliJ parity): folders first (alpha-sorted),
    // then leaves (alpha-sorted). The user scans top-down; folders
    // group related work, leaves are direct children.
    const items: BranchTreeItem[] = [];
    const folderSegments = Array.from(folderBuckets.keys()).sort();
    for (const segment of folderSegments) {
      const childPath = folderPath ? `${folderPath}/${segment}` : segment;
      items.push(
        new BranchTreeItem(
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
        )
      );
    }

    leaves.sort((a, b) => a.name.localeCompare(b.name));
    for (const branch of leaves) {
      const suffix = stripPrefix(branch.name)!;
      // The leaf's display name is the trailing segment, not the full
      // path — IntelliJ parity, and the parent folders already convey
      // the prefix in the tree breadcrumb.
      const displayName = suffix;
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
    const tags = (await this._gitService.getTags(repo)).filter((t) => this._matchesSearch(t.name));

    return tags.map((tag) => {
      return new BranchTreeItem(
        tag.name,
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
      );
    });
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
  return new BranchTreeProvider(gitService, getIncomingOutgoingFetcher(gitService), favoritesStore);
}
