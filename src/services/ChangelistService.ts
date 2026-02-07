import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { IChangelistService, IChangelist, IFileChange } from './interfaces/IChangelistService';
import { IRepository, FileStatus } from './interfaces/IGitService';

/**
 * Changelist storage file format version.
 * Increment this when making breaking changes to the storage format.
 */
const CHANGELIST_STORAGE_VERSION = 1;

/**
 * Changelist storage file name.
 * Stored in the .git directory to keep it repository-specific.
 */
const CHANGELIST_STORAGE_FILE = 'intellij-git-changelists.json';

/**
 * Default changelist name.
 */
const DEFAULT_CHANGELIST_NAME = 'Default Changelist';

/**
 * Default changelist ID.
 */
const DEFAULT_CHANGELIST_ID = 'default';

/**
 * Changelist storage model for JSON persistence.
 */
interface IChangelistStorage {
  version: number;
  changelists: IChangelistStorageItem[];
}

/**
 * Changelist storage item model.
 */
interface IChangelistStorageItem {
  id: string;
  name: string;
  isDefault: boolean;
  files: string[];
}

/**
 * Changelist Service implementation.
 * Manages changelists for organizing uncommitted changes.
 * Changelists are an IDE-level feature (not Git) that helps organize work before committing.
 *
 * Requirements: 2.2, 2.3, 2.4, 2.5
 */
export class ChangelistService implements IChangelistService {
  private _changelistCache: Map<string, IChangelist[]> = new Map();
  private _onDidChangeChangelists: vscode.EventEmitter<IChangelist[]>;
  private _disposables: vscode.Disposable[] = [];

  /**
   * Event fired when changelists change
   */
  readonly onDidChangeChangelists: vscode.Event<IChangelist[]>;

  constructor() {
    this._onDidChangeChangelists = new vscode.EventEmitter<IChangelist[]>();
    this.onDidChangeChangelists = this._onDidChangeChangelists.event;
  }

  /**
   * Get all changelists for a repository.
   * Ensures the default changelist always exists.
   *
   * @param repo - The repository
   * @returns Array of changelists
   *
   * Requirements: 2.2
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
   *
   * Requirements: 2.3
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
   *
   * Requirements: 2.5
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
   * Move files to a specific changelist.
   *
   * @param repo - The repository
   * @param files - Array of file paths to move
   * @param changelistId - ID of the target changelist
   *
   * Requirements: 2.4
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
   *
   * Requirements: 2.2
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
        files: [],
      });
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
      files: storageItem.files.map((filePath) => this.createFileChange(filePath)),
    };
  }

  /**
   * Create a file change object from a file path.
   * Note: The actual file status would need to be determined by querying Git.
   * For now, we create a placeholder that can be enriched later.
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
   * @param repo - The repository
   * @returns The changelist storage
   */
  private loadChangelistStorage(repo: IRepository): IChangelistStorage {
    const storagePath = this.getStoragePath(repo);

    try {
      if (fs.existsSync(storagePath)) {
        const content = fs.readFileSync(storagePath, 'utf8');
        const storage = JSON.parse(content) as IChangelistStorage;

        // Validate version
        if (storage.version !== CHANGELIST_STORAGE_VERSION) {
          // Handle version migration if needed
          console.warn(
            `Changelist storage version mismatch: expected ${CHANGELIST_STORAGE_VERSION}, got ${storage.version}`
          );
        }

        return storage;
      }
    } catch (error) {
      console.error('Failed to load changelist storage:', error);
    }

    // Return empty storage with default changelist
    return {
      version: CHANGELIST_STORAGE_VERSION,
      changelists: [],
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

    for (const disposable of this._disposables) {
      disposable.dispose();
    }
    this._disposables = [];
  }
}

/**
 * Create a new ChangelistService instance.
 *
 * @returns A new ChangelistService instance
 */
export function createChangelistService(): ChangelistService {
  return new ChangelistService();
}
