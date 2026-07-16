import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { randomBytes } from 'node:crypto';
import { atomicWriteFileSync } from '../utils/atomicWrite';
import { getLogger, type Logger } from '../utils/logger';
import { IChangelistService, IChangelist, IFileChange } from './interfaces/IChangelistService';
import {
  IGitService,
  IGitWorkingTreeEvents,
  IRepository,
  FileStatus,
  IFileStatus,
} from '../git-core/interfaces/IGitService';
import { statusCodeToFileStatus } from '../git-core/gitParser';
import { resolveWorktreeGitDir } from '../git-core/repo/RepositoryDiscovery';

/**
 * Changelist storage file format version.
 *
 * History:
 *  v1 — initial format, records without `description`.
 *  v2 — adds optional per-record `description` and top-level
 *       `activeChangelistId`. Reads of v1 files are migrated lazily
 *       (record gets `description: ''`, file stays on disk as v1 until
 *       the next write).
 *  v3 — drops per-record `isDefault`; `activeChangelistId` is the single
 *       active/default marker (reference: active == default is one
 *       concept — SetDefaultChangeListAction). Legacy files derive the
 *       active id from the `isDefault` record when no explicit id is
 *       stored; the key itself is consumed, never round-tripped.
 */
const CHANGELIST_STORAGE_VERSION = 3;

/**
 * Changelist storage file name.
 * Stored in the .git directory to keep it repository-specific.
 */
const CHANGELIST_STORAGE_FILE = 'intellig-changelists.json';

/**
 * Default changelist name.
 */
const DEFAULT_CHANGELIST_NAME = 'Default Changelist';

/**
 * Default changelist ID.
 */
const DEFAULT_CHANGELIST_ID = 'default';

/**
 * Debounce window (ms) for reacting to `onDidChangeRepository` events.
 * Matches the project convention for file-watcher debouncing.
 */
const RECONCILE_DEBOUNCE_MS = 300;

/**
 * Changelist storage model for JSON persistence.
 *
 * Forward-compat round-trip: unknown top-level keys and unknown per-item
 * keys are preserved verbatim across load/save cycles. This lets a newer
 * version of the extension introduce new fields without older versions
 * silently dropping them when they persist back to disk. The shape we
 * recognise is narrow (known keys below); everything else is captured in
 * `_unknownTopLevel` / `_unknownPerItem` and re-emitted on save. These
 * two fields are purely in-memory bookkeeping — they are never themselves
 * written to disk as named keys.
 */
interface IChangelistStorage {
  version: number;
  /**
   * Id of the currently active changelist. Added in v2. If missing on
   * read (v1 file), defaults to the default changelist id.
   */
  activeChangelistId: string;
  changelists: IChangelistStorageItem[];
  /**
   * Unknown top-level keys captured during load. Spread back out when
   * saving so forward-compat fields survive a round trip.
   * @internal
   */
  _unknownTopLevel?: Record<string, unknown>;
}

/**
 * Runtime git-status overlay for a single dirty path. Derived from the
 * `IFileStatus` reconcile already reads; never persisted.
 */
interface IFileChangeMeta {
  status: FileStatus;
  staged: boolean;
}

/**
 * Changelist storage item model.
 */
interface IChangelistStorageItem {
  id: string;
  name: string;
  /**
   * Optional free-form description. Added in v2. Absent on v1 records
   * until lazy migration runs during the next write.
   */
  description?: string;
  files: string[];
  /**
   * Unknown per-item keys captured during load. Spread back out when
   * saving so forward-compat fields survive a round trip.
   * @internal
   */
  _unknownItem?: Record<string, unknown>;
}

/**
 * The set of known top-level keys. Used by the forward-compat round-trip
 * logic to partition a parsed payload into known vs. unknown halves.
 *
 * Compile-time audit: the `satisfies Record<...>` clause below makes TS
 * fail to compile if a new field is added to {@link IChangelistStorage}
 * without being listed here (or if a listed key is removed from the
 * interface). `_unknownTopLevel` is excluded because it is an in-memory
 * bookkeeping field, not an on-disk key.
 */
const KNOWN_TOP_LEVEL_KEYS_SPEC = {
  version: true,
  activeChangelistId: true,
  changelists: true,
} as const satisfies Record<Exclude<keyof IChangelistStorage, '_unknownTopLevel'>, true>;

const KNOWN_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(Object.keys(KNOWN_TOP_LEVEL_KEYS_SPEC));

/**
 * The set of known per-item keys. Same purpose as {@link KNOWN_TOP_LEVEL_KEYS}
 * but for individual changelist records. Same compile-time audit mechanism —
 * adding a field to {@link IChangelistStorageItem} requires a matching entry
 * here or the build fails. `_unknownItem` is excluded as in-memory
 * bookkeeping.
 */
const KNOWN_ITEM_KEYS_SPEC = {
  id: true,
  name: true,
  description: true,
  files: true,
} as const satisfies Record<Exclude<keyof IChangelistStorageItem, '_unknownItem'>, true>;

/**
 * `isDefault` is a CONSUMED legacy key (pre-v3): the migration reads it to
 * derive the active id, then drops it — it must never be captured as an
 * unknown key or it would round-trip back onto v3 files.
 */
const KNOWN_ITEM_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(KNOWN_ITEM_KEYS_SPEC),
  'isDefault',
]);

/**
 * Pure version of {@link ChangelistService.migrateStorage}, exported so
 * the property test can exercise load logic without constructing the
 * whole service. Unit tests rely on this matching the class method exactly.
 *
 * @internal
 */
export function migrateStorageForTest(parsed: Record<string, unknown>): IChangelistStorage {
  if (!parsed || !Array.isArray(parsed.changelists)) {
    return {
      version: CHANGELIST_STORAGE_VERSION,
      activeChangelistId: DEFAULT_CHANGELIST_ID,
      changelists: [],
    };
  }

  const version = typeof parsed.version === 'number' ? parsed.version : 1;

  const rawItems = parsed.changelists as unknown[];
  // Pre-v3 files mark the default/active list with a per-record `isDefault`
  // flag; consume it here as the active-id fallback (the key never
  // round-trips — see KNOWN_ITEM_KEYS).
  let legacyDefaultId: string | undefined;
  const changelists: IChangelistStorageItem[] = rawItems.map((raw) => {
    const item = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const unknownItem: Record<string, unknown> = {};
    for (const k of Object.keys(item)) {
      if (!KNOWN_ITEM_KEYS.has(k)) {
        unknownItem[k] = item[k];
      }
    }
    const id = typeof item.id === 'string' ? item.id : '';
    if (legacyDefaultId === undefined && Boolean(item.isDefault)) {
      legacyDefaultId = id;
    }
    return {
      id,
      name: typeof item.name === 'string' ? item.name : '',
      description: typeof item.description === 'string' ? item.description : '',
      files: Array.isArray(item.files) ? (item.files as string[]).slice() : [],
      ...(Object.keys(unknownItem).length > 0 ? { _unknownItem: unknownItem } : {}),
    };
  });

  if (version > CHANGELIST_STORAGE_VERSION) {
    getLogger()
      .child({ component: 'ChangelistService' })
      .warn(
        `Changelist storage version ${version} is newer than expected (${CHANGELIST_STORAGE_VERSION}); reading best-effort`
      );
  }

  const activeChangelistId =
    typeof parsed.activeChangelistId === 'string' && parsed.activeChangelistId.length > 0
      ? parsed.activeChangelistId
      : (legacyDefaultId ?? DEFAULT_CHANGELIST_ID);

  const unknownTopLevel: Record<string, unknown> = {};
  for (const k of Object.keys(parsed)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(k)) {
      unknownTopLevel[k] = parsed[k];
    }
  }

  return {
    version: CHANGELIST_STORAGE_VERSION,
    activeChangelistId,
    changelists,
    ...(Object.keys(unknownTopLevel).length > 0 ? { _unknownTopLevel: unknownTopLevel } : {}),
  };
}

/**
 * Serialize an in-memory storage back to the on-disk JSON shape.
 *
 * Known keys emit in the fixed order `{version, activeChangelistId,
 * changelists, ...unknownTopLevel}`; per-item keys emit in the fixed order
 * `{id, name, description, files, ...unknownItem}`.
 *
 * The internal bookkeeping fields (`_unknownTopLevel`, `_unknownItem`) are
 * consumed here and MUST NOT appear in the emitted JSON. Callers that
 * need to round-trip unknowns pass them in via those fields and get them
 * back out as anonymous sibling keys.
 *
 * Exported only for tests — production code always goes through
 * {@link ChangelistService.saveChangelistStorage}.
 *
 * @internal
 */
export function serializeStorageForDisk(storage: IChangelistStorage): Record<string, unknown> {
  const items = storage.changelists.map((cl) => {
    const known: Record<string, unknown> = {
      id: cl.id,
      name: cl.name,
      description: typeof cl.description === 'string' ? cl.description : '',
      files: cl.files.slice(),
    };
    return cl._unknownItem ? { ...known, ...cl._unknownItem } : known;
  });
  const known: Record<string, unknown> = {
    version: storage.version,
    activeChangelistId: storage.activeChangelistId,
    changelists: items,
  };
  return storage._unknownTopLevel ? { ...known, ...storage._unknownTopLevel } : known;
}

/**
 * Derive a file's changelist metadata from its git-status entry. A path is
 * staged when the index side carries a real change (anything other than a
 * clean or untracked marker); the status is the combined index/work-tree
 * classification.
 */
function fileMetaFromStatus(entry: IFileStatus): IFileChangeMeta {
  return {
    status: statusCodeToFileStatus(entry.indexStatus, entry.workTreeStatus),
    staged: entry.indexStatus !== ' ' && entry.indexStatus !== '?',
  };
}

/**
 * Whether two status overlays describe the same set of paths with the same
 * `status` / `staged` for each. Used by {@link ChangelistService.doReconcile}
 * to fire the change event on a pure staged/status flip (no changelist
 * membership change), so a Commit tool window that only listens for
 * `onDidChangeChangelists` repaints when a file is `git add`-ed externally. A
 * missing previous overlay counts as equal only to an empty new overlay, so
 * the very first empty reconcile stays silent.
 */
function statusMetaEqual(
  previous: ReadonlyMap<string, IFileChangeMeta> | undefined,
  next: ReadonlyMap<string, IFileChangeMeta>
): boolean {
  if (!previous) {
    return next.size === 0;
  }
  if (previous.size !== next.size) {
    return false;
  }
  for (const [path, meta] of next) {
    const prev = previous.get(path);
    if (!prev || prev.status !== meta.status || prev.staged !== meta.staged) {
      return false;
    }
  }
  return true;
}

/**
 * Changelist Service implementation.
 * Manages changelists for organizing uncommitted changes.
 * Changelists are an IDE-level feature (not Git) that helps organize work before committing.
 */
export class ChangelistService implements IChangelistService {
  private _changelistCache: Map<string, IChangelist[]> = new Map();
  private _onDidChangeChangelists: vscode.EventEmitter<IChangelist[]>;
  private _disposables: vscode.Disposable[] = [];

  /**
   * In-flight reconcile promises keyed by repo-key. Concurrent callers
   * coalesce to the same promise so we never run two reconciles in
   * parallel for the same repository.
   */
  private _inFlightReconcile: Map<string, Promise<void>> = new Map();

  /**
   * Pending debounce timers keyed by repo-key. Set when
   * `onDidChangeRepository` fires; cleared when the timer runs.
   */
  private _reconcileTimers: Map<string, NodeJS.Timeout> = new Map();

  /**
   * Per-repo overlay of the real git-status metadata for each dirty path,
   * keyed by repo-key then path. Populated by {@link doReconcile} from the
   * status it already fetches, consulted by {@link createFileChange} so the
   * synchronous, cached {@link getChangelists} render path can report each
   * file's true `status` / `staged` without spawning git. Runtime-only —
   * never persisted (on-disk storage stays path-only).
   */
  private _statusByPath: Map<string, Map<string, IFileChangeMeta>> = new Map();

  /**
   * Reference to GitService for status lookups and repository-change
   * subscription. Required — `reconcileWithGitStatus()` cannot run
   * without a backing git-status source, and the production-time
   * manifestation of a missing wire was a silently-no-op `shelve.silent`
   * command (Tier-2 E2E coder-tier2-e2e report, 2026-05-10). Non-optional
   * so the type checker catches future regressions at construction.
   */
  private readonly _gitService: IGitService;

  /**
   * Component-bound Logger for ChangelistService lifecycle events,
   * git-status reconcile failures, and storage I/O failures.
   */
  private readonly _logger: Logger;

  /**
   * Event fired when changelists change
   */
  readonly onDidChangeChangelists: vscode.Event<IChangelist[]>;

  constructor(gitService: IGitService & IGitWorkingTreeEvents) {
    this._onDidChangeChangelists = new vscode.EventEmitter<IChangelist[]>();
    this.onDidChangeChangelists = this._onDidChangeChangelists.event;

    this._gitService = gitService;
    this._logger = getLogger().child({ component: 'ChangelistService' });
    this._logger.info('ChangelistService constructed');

    // Subscribe to BOTH change lanes so storage stays in sync: the
    // repository lane (external `git add`, commits, checkouts) and the
    // working-tree lane (editor saves — the status-only refresh that
    // deliberately does not fire onDidChangeRepository).
    this._disposables.push(
      gitService.onDidChangeRepository((repo) => {
        this.scheduleReconcile(repo);
      })
    );
    this._disposables.push(
      gitService.onDidChangeWorkingTree((repo) => {
        this.scheduleReconcile(repo);
      })
    );
  }

  /**
   * Get all changelists for a repository.
   * Ensures the default changelist always exists.
   *
   * @param repo - The repository
   * @returns Array of changelists
   */
  getChangelists(repo: IRepository): IChangelist[] {
    const repoKey = this.getRepoKey(repo);

    // Check cache first
    if (this._changelistCache.has(repoKey)) {
      return this._changelistCache.get(repoKey)!;
    }

    // Load from storage
    const storage = this.loadChangelistStorage(repo);

    // Ensure at least one changelist exists (persist when one was seeded).
    const hadChangelists = storage.changelists.length > 0;
    this.ensureDefaultChangelist(storage);
    if (!hadChangelists) {
      this.saveChangelistStorage(repo, storage);
    }

    // Resolve the active id once for the whole list. A stored id that no
    // longer references an existing changelist (manual JSON edit, migration
    // glitch) falls back so exactly one changelist ends up marked
    // `isActive` — mirroring getActiveChangelist's fallback.
    const activeId = this.resolveActiveChangelistId(storage);

    // Convert to IChangelist format
    const statusMeta = this._statusByPath.get(repoKey);
    const changelists = storage.changelists.map((item) =>
      this.storageItemToChangelist(item, activeId, statusMeta)
    );

    // Update cache
    this._changelistCache.set(repoKey, changelists);

    return changelists;
  }

  /**
   * Create a new changelist.
   *
   * @param repo - The repository
   * @param name - Name for the new changelist
   * @returns The created changelist
   */
  createChangelist(repo: IRepository, name: string): IChangelist {
    if (!name || name.trim().length === 0) {
      throw new Error('Changelist name cannot be empty');
    }

    const trimmedName = name.trim();

    // Load current storage. Seed the initial list first so a create on a
    // fresh repo never leaves the new list as the only (hence active) one.
    const storage = this.loadChangelistStorage(repo);
    this.ensureDefaultChangelist(storage);

    // Check for duplicate names
    if (storage.changelists.some((cl) => cl.name === trimmedName)) {
      throw new Error(`Changelist with name "${trimmedName}" already exists`);
    }

    // Generate unique ID
    const id = this.generateChangelistId();

    // Create the storage item
    const storageItem: IChangelistStorageItem = {
      id,
      name: trimmedName,
      description: '',
      files: [],
    };

    // Add to storage
    storage.changelists.push(storageItem);

    // Save to file
    this.saveChangelistStorage(repo, storage);

    // Clear cache
    const repoKey = this.getRepoKey(repo);
    this._changelistCache.delete(repoKey);

    // Create the changelist object. A freshly-created changelist is never
    // the active one, so resolve against the unchanged stored active id.
    const changelist = this.storageItemToChangelist(
      storageItem,
      this.resolveActiveChangelistId(storage),
      this._statusByPath.get(this.getRepoKey(repo))
    );

    // Fire change event
    const changelists = this.getChangelists(repo);
    this._onDidChangeChangelists.fire(changelists);

    return changelist;
  }

  /**
   * Delete a changelist.
   * Files in the deleted changelist are moved to the ACTIVE changelist
   * (the reference's default — active and default are one concept). The
   * active changelist itself cannot be deleted.
   *
   * @param repo - The repository
   * @param id - ID of the changelist to delete
   */
  deleteChangelist(repo: IRepository, id: string): void {
    // Load current storage
    const storage = this.loadChangelistStorage(repo);
    this.ensureDefaultChangelist(storage);

    // Find the changelist to delete
    const index = storage.changelists.findIndex((cl) => cl.id === id);
    if (index === -1) {
      throw new Error(`Changelist not found: ${id}`);
    }

    // The active list is the routing target for new changes — undeletable,
    // matching the reference (the default changelist cannot be removed).
    const activeId = this.resolveActiveChangelistId(storage);
    if (id === activeId) {
      throw new Error('Cannot delete the active changelist');
    }

    const changelistToDelete = storage.changelists[index];

    // Move files to the active changelist.
    const activeCl = storage.changelists.find((cl) => cl.id === activeId)!;
    for (const file of changelistToDelete.files) {
      if (!activeCl.files.includes(file)) {
        activeCl.files.push(file);
      }
    }

    // Remove the changelist
    storage.changelists.splice(index, 1);

    // Save to file
    this.saveChangelistStorage(repo, storage);

    // Clear cache
    const repoKey = this.getRepoKey(repo);
    this._changelistCache.delete(repoKey);

    // Fire change event
    const changelists = this.getChangelists(repo);
    this._onDidChangeChangelists.fire(changelists);
  }

  /**
   * Rename a changelist.
   *
   * @param repo - The repository
   * @param id - ID of the changelist to rename
   * @param newName - New name for the changelist
   */
  renameChangelist(repo: IRepository, id: string, newName: string): void {
    if (!newName || newName.trim().length === 0) {
      throw new Error('Changelist name cannot be empty');
    }

    const trimmedName = newName.trim();

    // Load current storage
    const storage = this.loadChangelistStorage(repo);

    // Find the changelist
    const changelist = storage.changelists.find((cl) => cl.id === id);
    if (!changelist) {
      throw new Error(`Changelist not found: ${id}`);
    }

    // Check for duplicate names (excluding current changelist)
    if (storage.changelists.some((cl) => cl.id !== id && cl.name === trimmedName)) {
      throw new Error(`Changelist with name "${trimmedName}" already exists`);
    }

    // Update the name
    changelist.name = trimmedName;

    // Save to file
    this.saveChangelistStorage(repo, storage);

    // Clear cache
    const repoKey = this.getRepoKey(repo);
    this._changelistCache.delete(repoKey);

    // Fire change event
    const changelists = this.getChangelists(repo);
    this._onDidChangeChangelists.fire(changelists);
  }

  /**
   * Set the description of a changelist.
   *
   * The description field was introduced in storage schema v2 but
   * had no setter. The Edit Description… UI action on the Commit tool
   * window's changelist tree calls this to persist the new value.
   *
   * @param repo - The repository
   * @param id - ID of the changelist whose description should change
   * @param description - New description. Empty string clears the value.
   */
  setDescription(repo: IRepository, id: string, description: string): void {
    const storage = this.loadChangelistStorage(repo);
    const changelist = storage.changelists.find((cl) => cl.id === id);
    if (!changelist) {
      throw new Error(`Changelist not found: ${id}`);
    }

    changelist.description = description;
    this.saveChangelistStorage(repo, storage);

    const repoKey = this.getRepoKey(repo);
    this._changelistCache.delete(repoKey);

    const changelists = this.getChangelists(repo);
    this._onDidChangeChangelists.fire(changelists);
  }

  /**
   * Move files to a specific changelist.
   *
   * @param repo - The repository
   * @param files - Array of file paths to move
   * @param changelistId - ID of the target changelist
   */
  moveToChangelist(repo: IRepository, files: string[], changelistId: string): void {
    if (!files || files.length === 0) {
      return;
    }

    // Load current storage
    const storage = this.loadChangelistStorage(repo);

    // Find the target changelist
    const targetChangelist = storage.changelists.find((cl) => cl.id === changelistId);
    if (!targetChangelist) {
      throw new Error(`Changelist not found: ${changelistId}`);
    }

    // Remove files from all other changelists and add to target
    for (const file of files) {
      // Remove from all changelists
      for (const cl of storage.changelists) {
        const fileIndex = cl.files.indexOf(file);
        if (fileIndex !== -1) {
          cl.files.splice(fileIndex, 1);
        }
      }

      // Add to target changelist
      if (!targetChangelist.files.includes(file)) {
        targetChangelist.files.push(file);
      }
    }

    // Save to file
    this.saveChangelistStorage(repo, storage);

    // Clear cache
    const repoKey = this.getRepoKey(repo);
    this._changelistCache.delete(repoKey);

    // Fire change event
    const changelists = this.getChangelists(repo);
    this._onDidChangeChangelists.fire(changelists);
  }

  /**
   * Get the default changelist — the ACTIVE one (active and default are one
   * concept, matching the reference). Synchronous counterpart of
   * {@link getActiveChangelist}; creates the initial list if none exists.
   *
   * @param repo - The repository
   * @returns The default (= active) changelist
   */
  getDefaultChangelist(repo: IRepository): IChangelist {
    const changelists = this.getChangelists(repo);
    const defaultChangelist = changelists.find((cl) => cl.isDefault);

    if (!defaultChangelist) {
      // This should never happen since getChangelists ensures a valid active id
      throw new Error('Default changelist not found');
    }

    return defaultChangelist;
  }

  /**
   * Set the active changelist. Throws if `id` does not reference an
   * existing changelist.
   *
   * @param repo - The repository
   * @param id - ID of the changelist to mark active
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- interface contract requires Promise<void>
  async setActiveChangelist(repo: IRepository, id: string): Promise<void> {
    const storage = this.loadChangelistStorage(repo);

    const exists = storage.changelists.some((cl) => cl.id === id);
    if (!exists) {
      throw new Error(`Changelist not found: ${id}`);
    }

    if (storage.activeChangelistId === id) {
      // No-op — already active. Still ensure storage is persisted if
      // we had to synthesize defaults on load.
      this.saveChangelistStorage(repo, storage);
      return;
    }

    storage.activeChangelistId = id;
    this.saveChangelistStorage(repo, storage);

    const repoKey = this.getRepoKey(repo);
    this._changelistCache.delete(repoKey);

    const changelists = this.getChangelists(repo);
    this._onDidChangeChangelists.fire(changelists);
  }

  /**
   * Get the currently active changelist. Falls back to the default
   * changelist if no active id is set (e.g., fresh storage).
   *
   * @param repo - The repository
   * @returns The active changelist
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- interface contract requires Promise<IChangelist>
  async getActiveChangelist(repo: IRepository): Promise<IChangelist> {
    const storage = this.loadChangelistStorage(repo);
    const changelists = this.getChangelists(repo);

    const active = changelists.find((cl) => cl.id === storage.activeChangelistId);
    if (active) {
      return active;
    }

    // Storage references a changelist that no longer exists (edge case
    // after manual JSON edit or migration glitch) — fall back to default.
    return this.getDefaultChangelist(repo);
  }

  /**
   * Return the changelist id that owns the given path, or `undefined`.
   *
   * @param repo - The repository
   * @param filePath - The file path to look up (as stored, no normalization)
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- interface contract requires Promise<string | undefined>
  async getChangelistForFile(repo: IRepository, filePath: string): Promise<string | undefined> {
    const changelists = this.getChangelists(repo);
    for (const cl of changelists) {
      if (cl.files.some((f) => f.path === filePath)) {
        return cl.id;
      }
    }
    return undefined;
  }

  /**
   * Reconcile storage with current git status for the given repository.
   *
   * @param repo - The repository
   */
  reconcileWithGitStatus(repo: IRepository): Promise<void> {
    const repoKey = this.getRepoKey(repo);

    // Coalesce concurrent reconcile calls for the same repo.
    const existing = this._inFlightReconcile.get(repoKey);
    if (existing) {
      return existing;
    }

    const promise = this.doReconcile(repo).finally(() => {
      this._inFlightReconcile.delete(repoKey);
    });
    this._inFlightReconcile.set(repoKey, promise);
    return promise;
  }

  /**
   * Perform the actual reconcile work. Not re-entrant — always invoked
   * through {@link reconcileWithGitStatus} which enforces per-repo
   * serialization.
   */
  private async doReconcile(repo: IRepository): Promise<void> {
    let statuses: IFileStatus[];
    try {
      statuses = await this._gitService.getStatus(repo);
    } catch (error) {
      this._logger.error(
        'failed to read git status during reconcile',
        error instanceof Error ? error : undefined
      );
      return;
    }

    // Set of current dirty paths per git status (uses renamed -> target path).
    const dirtyPaths = new Set<string>();
    // Map a rename's OLD path → its NEW path so a file that was renamed keeps
    // its user-assigned changelist instead of being pruned (old path gone) and
    // re-added to the default (new path unseen).
    const renamedFrom = new Map<string, string>();
    // Overlay the real status metadata for each dirty path so the
    // synchronous getChangelists render path can report it without git.
    const statusMeta = new Map<string, IFileChangeMeta>();
    for (const entry of statuses) {
      dirtyPaths.add(entry.path);
      statusMeta.set(entry.path, fileMetaFromStatus(entry));
      if (entry.renamed) {
        renamedFrom.set(entry.renamed, entry.path);
      }
    }

    const storage = this.loadChangelistStorage(repo);
    this.ensureDefaultChangelist(storage);

    let changed = false;

    // Step a: migrate a rename in place — swap the old path for the new one in
    // whatever changelist held it, so the assignment survives the rename.
    for (const cl of storage.changelists) {
      for (let i = 0; i < cl.files.length; i++) {
        const newPath = renamedFrom.get(cl.files[i]);
        if (newPath !== undefined && cl.files[i] !== newPath) {
          cl.files[i] = newPath;
          changed = true;
        }
      }
    }

    // Step b: prune storage entries whose path is no longer dirty.
    for (const cl of storage.changelists) {
      const originalLen = cl.files.length;
      cl.files = cl.files.filter((f) => dirtyPaths.has(f));
      if (cl.files.length !== originalLen) {
        changed = true;
      }
    }

    // Step c: add missing dirty paths to the ACTIVE changelist — the
    // reference routes new changes to the default(=active) list
    // (ChangeListWorker.myDefault).
    const assigned = new Set<string>();
    for (const cl of storage.changelists) {
      for (const f of cl.files) {
        assigned.add(f);
      }
    }
    const activeCl = storage.changelists.find(
      (cl) => cl.id === this.resolveActiveChangelistId(storage)
    )!;
    for (const p of dirtyPaths) {
      if (!assigned.has(p)) {
        activeCl.files.push(p);
        changed = true;
      }
    }

    // Always persist — this also lazily migrates v1 files to v2.
    this.saveChangelistStorage(repo, storage);

    const repoKey = this.getRepoKey(repo);
    // A pure staged/status flip (e.g. an external `git add`) changes the
    // overlay without touching changelist membership, so `changed` stays
    // false. Compare against the previous overlay so the event still fires
    // and the Commit tool window repaints. An unchanged overlay stays silent.
    const statusChanged = !statusMetaEqual(this._statusByPath.get(repoKey), statusMeta);
    this._statusByPath.set(repoKey, statusMeta);
    this._changelistCache.delete(repoKey);

    if (changed || statusChanged) {
      const changelists = this.getChangelists(repo);
      this._onDidChangeChangelists.fire(changelists);
    }
  }

  /**
   * Schedule a debounced reconcile for the given repository.
   * Subsequent calls within the debounce window cancel the pending run
   * and start a new timer.
   */
  private scheduleReconcile(repo: IRepository): void {
    const repoKey = this.getRepoKey(repo);
    const existing = this._reconcileTimers.get(repoKey);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this._reconcileTimers.delete(repoKey);
      void this.reconcileWithGitStatus(repo).catch((err) => {
        this._logger.error('reconcile failed', err instanceof Error ? err : undefined);
      });
    }, RECONCILE_DEBOUNCE_MS);
    this._reconcileTimers.set(repoKey, timer);
  }

  /**
   * Ensure the default changelist exists in storage.
   *
   * @param storage - The changelist storage
   */
  private ensureDefaultChangelist(storage: IChangelistStorage): void {
    if (storage.changelists.length === 0) {
      // Seed the initial changelist.
      storage.changelists.unshift({
        id: DEFAULT_CHANGELIST_ID,
        name: DEFAULT_CHANGELIST_NAME,
        description: '',
        files: [],
      });
    }

    // Keep the active id pointing at an existing list.
    if (!storage.changelists.some((cl) => cl.id === storage.activeChangelistId)) {
      storage.activeChangelistId = storage.changelists[0].id;
    }
  }

  /**
   * Resolve the effective active changelist id for a storage blob.
   *
   * Returns `storage.activeChangelistId` when it references an existing
   * changelist; otherwise falls back to the default changelist's id (or, in
   * the degenerate case of no changelists at all, the constant default id).
   * Keeps the `isActive` marker on {@link storageItemToChangelist} in lockstep
   * with {@link getActiveChangelist}'s own dangling-id fallback.
   *
   * @param storage - The in-memory storage blob
   * @returns The id that should be treated as active
   */
  private resolveActiveChangelistId(storage: IChangelistStorage): string {
    const active = storage.changelists.find((cl) => cl.id === storage.activeChangelistId);
    if (active) {
      return active.id;
    }
    return storage.changelists[0]?.id ?? DEFAULT_CHANGELIST_ID;
  }

  /**
   * Convert a storage item to a changelist.
   *
   * @param storageItem - The storage item
   * @param activeChangelistId - The resolved active changelist id, used to
   *   set the item's `isActive` flag. Resolve via
   *   {@link resolveActiveChangelistId} so a dangling stored id falls back to
   *   the default.
   * @returns The changelist
   */
  private storageItemToChangelist(
    storageItem: IChangelistStorageItem,
    activeChangelistId: string,
    statusMeta?: ReadonlyMap<string, IFileChangeMeta>
  ): IChangelist {
    return {
      id: storageItem.id,
      name: storageItem.name,
      // Active and default are ONE concept (v3 collapse): the active list
      // is the routing target for new changes, i.e. the reference's default.
      isDefault: storageItem.id === activeChangelistId,
      isActive: storageItem.id === activeChangelistId,
      description: storageItem.description ?? '',
      files: storageItem.files.map((filePath) => this.createFileChange(filePath, statusMeta)),
    };
  }

  /**
   * Create a file change object from a file path, overlaying the real
   * `status` / `staged` captured by the last reconcile when available.
   * Before any reconcile has run for a repo the overlay is absent, so the
   * file degrades to a `modified` / unstaged placeholder.
   *
   * @param filePath - The file path
   * @param statusMeta - Per-path git-status overlay from the last reconcile
   * @returns The file change object
   */
  private createFileChange(
    filePath: string,
    statusMeta?: ReadonlyMap<string, IFileChangeMeta>
  ): IFileChange {
    const meta = statusMeta?.get(filePath);
    return {
      path: filePath,
      status: meta?.status ?? 'modified',
      staged: meta?.staged ?? false,
    };
  }

  /**
   * Load changelist storage from file.
   *
   * Handles the v1 → v2 lazy migration:
   *  - v1 files are parsed as-is; records get `description: ''`
   *    filled in and the top-level `activeChangelistId` defaults to
   *    the default changelist id. The file stays on-disk as v1 until
   *    the next save (lazy migration per cluster-C-tool-windows.md section 4.5).
   *  - v2 files are returned unchanged.
   *  - Unknown / corrupt / mismatched files are logged and treated as
   *    an empty store so the user is never blocked by a bad file.
   *
   * @param repo - The repository
   * @returns The changelist storage (in-memory v2 shape)
   */
  private loadChangelistStorage(repo: IRepository): IChangelistStorage {
    const storagePath = this.getStoragePath(repo);

    try {
      if (fs.existsSync(storagePath)) {
        const content = fs.readFileSync(storagePath, 'utf8');
        // Parse into a loose record so unknown keys survive the
        // migrate → save round trip. The known-field extraction lives in
        // {@link migrateStorage}.
        const parsed = JSON.parse(content) as Record<string, unknown>;
        return this.migrateStorage(parsed);
      }
    } catch (error) {
      this._logger.error(
        'failed to load changelist storage',
        error instanceof Error ? error : undefined
      );
      // Graceful fallback — corrupt file shouldn't block the user.
    }

    // Return empty storage with defaults.
    return {
      version: CHANGELIST_STORAGE_VERSION,
      activeChangelistId: DEFAULT_CHANGELIST_ID,
      changelists: [],
    };
  }

  /**
   * Normalize a parsed storage blob to the current (v2) in-memory shape.
   *
   * Unknown future versions are treated as v2 if the shape is close
   * enough (changelists array present); otherwise we reset to empty.
   *
   * Any top-level or per-item keys we don't recognise are captured into
   * `_unknownTopLevel` / `_unknownItem` and re-emitted on save (see
   * {@link saveChangelistStorage}) so a newer extension's forward-compat
   * fields survive round-tripping through this version.
   */
  private migrateStorage(parsed: Record<string, unknown>): IChangelistStorage {
    return migrateStorageForTest(parsed);
  }

  /**
   * Save changelist storage to file.
   *
   * @param repo - The repository
   * @param storage - The changelist storage to save
   */
  private saveChangelistStorage(repo: IRepository, storage: IChangelistStorage): void {
    const storagePath = this.getStoragePath(repo);

    try {
      // Ensure directory exists
      const dir = path.dirname(storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Stamp the current version — finalizes v1→v2 migration on first write.
      storage.version = CHANGELIST_STORAGE_VERSION;
      if (!storage.activeChangelistId) {
        storage.activeChangelistId = DEFAULT_CHANGELIST_ID;
      }
      // Ensure every record has a description field on-disk.
      for (const cl of storage.changelists) {
        if (typeof cl.description !== 'string') {
          cl.description = '';
        }
      }

      // Serialise into a plain object so the known keys land in a
      // deterministic order AND the unknown-key bookkeeping fields
      // (`_unknownTopLevel`, `_unknownItem`) never leak to disk. The
      // unknown keys themselves are spread back in verbatim, so
      // forward-compat fields from a newer extension version survive a
      // load/save round trip through this (older) version.
      // Atomic write — but last-writer-wins ACROSS WINDOWS: two VS Code windows
      // on the same repo saving changelists near-simultaneously can silently
      // overwrite each other (knowingly accepted; no cross-window lock). See
      // {@link atomicWriteFileSync} "Limitations".
      const content = JSON.stringify(serializeStorageForDisk(storage), null, 2);
      atomicWriteFileSync(storagePath, content, { encoding: 'utf8' });
    } catch (error) {
      this._logger.error(
        'failed to save changelist storage',
        error instanceof Error ? error : undefined
      );
      throw new Error('Failed to save changelist storage');
    }
  }

  /**
   * Get the storage file path for a repository.
   *
   * @param repo - The repository
   * @returns The storage file path
   */
  private getStoragePath(repo: IRepository): string {
    // Resolve the real per-worktree git dir: in a linked worktree `<root>/.git`
    // is a FILE (a `gitdir:` pointer), so the conventional `<root>/.git/<file>`
    // would throw on write. See {@link resolveWorktreeGitDir}.
    return path.join(resolveWorktreeGitDir(repo.rootUri.fsPath), CHANGELIST_STORAGE_FILE);
  }

  /**
   * Generate a unique changelist ID.
   *
   * Uses `randomBytes(4)` for 32 bits of CSPRNG entropy rather than
   * `Math.random()`, which is predictable and collides for rapid
   * creates in the same millisecond. Mirrors `src/utils/webviewNonce.ts`.
   *
   * @returns A unique ID string
   */
  private generateChangelistId(): string {
    const timestamp = Date.now().toString(36);
    const random = randomBytes(4).toString('hex');
    return `changelist-${timestamp}-${random}`;
  }

  /**
   * Get a unique key for a repository.
   *
   * @param repo - The repository
   * @returns A unique key string
   */
  private getRepoKey(repo: IRepository): string {
    return repo.rootUri.fsPath;
  }

  /**
   * Dispose of resources.
   */
  dispose(): void {
    this._logger.info('ChangelistService disposing');
    this._onDidChangeChangelists.dispose();
    this._changelistCache.clear();
    this._statusByPath.clear();

    for (const timer of this._reconcileTimers.values()) {
      clearTimeout(timer);
    }
    this._reconcileTimers.clear();
    this._inFlightReconcile.clear();

    for (const disposable of this._disposables) {
      disposable.dispose();
    }
    this._disposables = [];
  }
}

/**
 * Create a new ChangelistService instance.
 *
 * @param gitService - GitService used to drive git-status reconciliation
 *   and listen for repository-change events. Required — see
 *   {@link ChangelistService} constructor docs.
 * @returns A new ChangelistService instance
 */
export function createChangelistService(
  gitService: IGitService & IGitWorkingTreeEvents
): ChangelistService {
  return new ChangelistService(gitService);
}
