/**
 * Favorite (starred) refs for the Branches tree and the branch popup: the
 * persisted state, its resolution rules, and the stores that hold it.
 */

import * as vscode from 'vscode';
import type { IRepository } from '../git-core/interfaces/IGitService';
import {
  loadPersisted,
  savePersisted,
  readStringArray,
  type PersistedSlot,
} from '../utils/persistedState';

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
export function favoritesRepoPath(repo: IRepository | undefined): string {
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
