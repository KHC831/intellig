import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { IChangelistService, IChangelist, IFileChange } from './interfaces/IChangelistService';
import { IGitService, IRepository, FileStatus, IFileStatus } from './interfaces/IGitService';

/**
 * Changelist storage file format version.
 *
 * History:
 *  v1 — initial format, records without `description`.
 *  v2 — adds optional per-record `description` and top-level
 *       `activeChangelistId`. Reads of v1 files are migrated lazily
 *       (record gets `description: ''`, file stays on disk as v1 until
 *       the next write).
 */
const CHANGELIST_STORAGE_VERSION = 2;

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
 */
interface IChangelistStorage {
  version: number;
  /**
   * Id of the currently active changelist. Added in v2. If missing on
   * read (v1 file), defaults to the default changelist id.
   */
  activeChangelistId: string;
  changelists: IChangelistStorageItem[];
}

/**
 * Changelist storage item model.
 */
interface IChangelistStorageItem {
  id: string;
  name: string;
  isDefault: boolean;
  /**
   * Optional free-form description. Added in v2. Absent on v1 records
   * until lazy migration runs during the next write.
   */
  description?: string;
  files: string[];
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
   * Reference to GitService for status lookups and repository-change
   * subscription. Required — `reconcileWithGitStatus()` cannot run
   * without a backing git-status source, and the production-time
   * manifestation of a missing wire was a silently-no-op `shelve.silent`
   * command (Tier-2 E2E coder-tier2-e2e report, 2026-05-10). Non-optional
   * so the type checker catches future regressions at construction.
   */
  private readonly _gitService: IGitService;

  /**
   * Event fired when changelists change
   */
  readonly onDidChangeChangelists: vscode.Event<IChangelist[]>;

  constructor(gitService: IGitService) {
    this._onDidChangeChangelists = new vscode.EventEmitter<IChangelist[]>();
    this.onDidChangeChangelists = this._onDidChangeChangelists.event;

    this._gitService = gitService;

    // Subscribe to repository changes so storage stays in sync with
    // external `git add`, file removal, rename, etc.
    this._disposables.push(
      gitService.onDidChangeRepository((repo) => {
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

    // Ensure default changelist exists
    const hadDefault = storage.changelists.some((cl) => cl.isDefault);
    this.ensureDefaultChangelist(storage);

    // Save if we added the default changelist
    if (!hadDefault) {
      this.saveChangelistStorage(repo, storage);
    }

    // Convert to IChangelist format
    const changelists = storage.changelists.map((item) => this.storageItemToChangelist(item));

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

    // Load current storage
    const storage = this.loadChangelistStorage(repo);

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
      isDefault: false,
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

    // Create the changelist object
    const changelist = this.storageItemToChangelist(storageItem);

    // Fire change event
    const changelists = this.getChangelists(repo);
    this._onDidChangeChangelists.fire(changelists);

    return changelist;
  }

  /**
   * Delete a changelist.
   * Files in the deleted changelist are moved to the default changelist.
   *
   * @param repo - The repository
   * @param id - ID of the changelist to delete
   */
  deleteChangelist(repo: IRepository, id: string): void {
    // Cannot delete the default changelist
    if (id === DEFAULT_CHANGELIST_ID) {
      throw new Error('Cannot delete the default changelist');
    }

    // Load current storage
    const storage = this.loadChangelistStorage(repo);

    // Find the changelist to delete
    const index = storage.changelists.findIndex((cl) => cl.id === id);
    if (index === -1) {
      throw new Error(`Changelist not found: ${id}`);
    }

    const changelistToDelete = storage.changelists[index];

    // Cannot delete if it's marked as default
    if (changelistToDelete.isDefault) {
      throw new Error('Cannot delete the default changelist');
    }

    // Find the default changelist
    const defaultChangelist = storage.changelists.find((cl) => cl.isDefault);
    if (!defaultChangelist) {
      // This should never happen, but handle it gracefully
      this.ensureDefaultChangelist(storage);
    }

    // Move files to default changelist
    const defaultCl = storage.changelists.find((cl) => cl.isDefault)!;
    for (const file of changelistToDelete.files) {
      if (!defaultCl.files.includes(file)) {
        defaultCl.files.push(file);
      }
    }

    // Remove the changelist
    storage.changelists.splice(index, 1);

    // If the deleted changelist was the active one, fall back to default.
    if (storage.activeChangelistId === id) {
      storage.activeChangelistId = defaultCl.id;
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
   * Set the description of a changelist (T1-04).
   *
   * The description field was introduced in storage schema v2 (T1-06) but
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
   * Get the default changelist.
   * Creates it if it doesn't exist.
   *
   * @param repo - The repository
   * @returns The default changelist
   */
  getDefaultChangelist(repo: IRepository): IChangelist {
    const changelists = this.getChangelists(repo);
    const defaultChangelist = changelists.find((cl) => cl.isDefault);

    if (!defaultChangelist) {
      // This should never happen since getChangelists ensures default exists
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
  async getChangelistForFile(
    repo: IRepository,
    filePath: string
  ): Promise<string | undefined> {
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
      console.error('ChangelistService: failed to read git status during reconcile:', error);
      return;
    }

    // Set of current dirty paths per git status (uses renamed -> target path).
    const dirtyPaths = new Set<string>();
    for (const entry of statuses) {
      dirtyPaths.add(entry.path);
    }

    const storage = this.loadChangelistStorage(repo);
    this.ensureDefaultChangelist(storage);

    let changed = false;

    // Step b: prune storage entries whose path is no longer dirty.
    for (const cl of storage.changelists) {
      const originalLen = cl.files.length;
      cl.files = cl.files.filter((f) => dirtyPaths.has(f));
      if (cl.files.length !== originalLen) {
        changed = true;
      }
    }

    // Step c: add missing dirty paths to the default changelist.
    const assigned = new Set<string>();
    for (const cl of storage.changelists) {
      for (const f of cl.files) {
        assigned.add(f);
      }
    }
    const defaultCl = storage.changelists.find((cl) => cl.isDefault)!;
    for (const p of dirtyPaths) {
      if (!assigned.has(p)) {
        defaultCl.files.push(p);
        changed = true;
      }
    }

    // Always persist — this also lazily migrates v1 files to v2.
    this.saveChangelistStorage(repo, storage);

    const repoKey = this.getRepoKey(repo);
    this._changelistCache.delete(repoKey);

    if (changed) {
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
        console.error('ChangelistService: reconcile failed:', err);
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
    const hasDefault = storage.changelists.some((cl) => cl.isDefault);

    if (!hasDefault) {
      // Create the default changelist
      storage.changelists.unshift({
        id: DEFAULT_CHANGELIST_ID,
        name: DEFAULT_CHANGELIST_NAME,
        isDefault: true,
        description: '',
        files: [],
      });
    }

    if (!storage.activeChangelistId) {
      storage.activeChangelistId = DEFAULT_CHANGELIST_ID;
    }
  }

  /**
   * Convert a storage item to a changelist.
   *
   * @param storageItem - The storage item
   * @returns The changelist
   */
  private storageItemToChangelist(storageItem: IChangelistStorageItem): IChangelist {
    return {
      id: storageItem.id,
      name: storageItem.name,
      isDefault: storageItem.isDefault,
      description: storageItem.description ?? '',
      files: storageItem.files.map((filePath) => this.createFileChange(filePath)),
    };
  }

  /**
   * Create a file change object from a file path.
   * When a GitService is wired, the real status code is resolved from
   * the cached status lookup the caller already performed; otherwise we
   * fall back to `modified` as a placeholder that downstream UI can
   * refresh later.
   *
   * @param filePath - The file path
   * @returns The file change object
   */
  private createFileChange(filePath: string): IFileChange {
    return {
      path: filePath,
      status: 'modified' as FileStatus, // Default status, should be updated by caller
      staged: false,
    };
  }

  /**
   * Load changelist storage from file.
   *
   * Handles the v1 → v2 lazy migration:
   *  - v1 files are parsed as-is; records get `description: ''`
   *    filled in and the top-level `activeChangelistId` defaults to
   *    the default changelist id. The file stays on-disk as v1 until
   *    the next save (lazy migration per cluster-C-tool-windows.md §4.5).
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
        const parsed = JSON.parse(content) as Partial<IChangelistStorage>;
        return this.migrateStorage(parsed);
      }
    } catch (error) {
      console.error('Failed to load changelist storage:', error);
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
   */
  private migrateStorage(parsed: Partial<IChangelistStorage>): IChangelistStorage {
    if (!parsed || !Array.isArray(parsed.changelists)) {
      return {
        version: CHANGELIST_STORAGE_VERSION,
        activeChangelistId: DEFAULT_CHANGELIST_ID,
        changelists: [],
      };
    }

    const version = typeof parsed.version === 'number' ? parsed.version : 1;

    const changelists: IChangelistStorageItem[] = parsed.changelists.map((item) => ({
      id: item.id,
      name: item.name,
      isDefault: Boolean(item.isDefault),
      description: typeof item.description === 'string' ? item.description : '',
      files: Array.isArray(item.files) ? item.files.slice() : [],
    }));

    if (version > CHANGELIST_STORAGE_VERSION) {
      console.warn(
        `Changelist storage version ${version} is newer than expected (${CHANGELIST_STORAGE_VERSION}); reading best-effort`
      );
    }

    const activeChangelistId =
      typeof parsed.activeChangelistId === 'string' && parsed.activeChangelistId.length > 0
        ? parsed.activeChangelistId
        : DEFAULT_CHANGELIST_ID;

    return {
      version: CHANGELIST_STORAGE_VERSION,
      activeChangelistId,
      changelists,
    };
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

      // Write storage file
      const content = JSON.stringify(storage, null, 2);
      fs.writeFileSync(storagePath, content, 'utf8');
    } catch (error) {
      console.error('Failed to save changelist storage:', error);
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
    return path.join(repo.rootUri.fsPath, '.git', CHANGELIST_STORAGE_FILE);
  }

  /**
   * Generate a unique changelist ID.
   *
   * @returns A unique ID string
   */
  private generateChangelistId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
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
    this._onDidChangeChangelists.dispose();
    this._changelistCache.clear();

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
export function createChangelistService(gitService: IGitService): ChangelistService {
  return new ChangelistService(gitService);
}

