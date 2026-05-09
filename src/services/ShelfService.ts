import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  IShelfService,
  IShelfItem,
  IShelfFile,
  IShelveSelection,
  IUnshelveOptions,
  IUnshelveResult,
  IImportPatchOptions,
} from './interfaces/IShelfService';
import { IRepository, IDiff, IHunk } from './interfaces/IGitService';
import { GitCli, createGitCli } from '../utils/gitCli';
import { parseDiff } from '../utils/gitParser';

/**
 * Shelf storage file format version.
 * Increment this when making breaking changes to the storage format.
 *
 * v1: initial format (id, name, timestamp, files).
 * v2 (T2-10): adds optional `unshelvedAt` to mark Already-Unshelved entries.
 *   Backward-compat: v1 files load as v2 with `unshelvedAt` absent.
 */
const SHELF_STORAGE_VERSION = 2;

/**
 * Shelf storage file name.
 * Stored in the .git directory to keep it repository-specific.
 */
const SHELF_STORAGE_FILE = 'intellig-shelf.json';

/**
 * Shelf storage model for JSON persistence.
 */
interface IShelfStorage {
  version: number;
  items: IShelfStorageItem[];
}

/**
 * Shelf storage item model.
 */
interface IShelfStorageItem {
  id: string;
  name: string;
  timestamp: number;
  files: IShelfStorageFile[];
  /** v2 (T2-10): epoch ms of successful unshelve, if the entry is Already-Unshelved. */
  unshelvedAt?: number;
}

/**
 * Shelf storage file model.
 */
interface IShelfStorageFile {
  path: string;
  originalContent: string;
  patchContent: string;
}

/**
 * Shelf Service implementation.
 * Manages IDE-specific shelf storage for temporary changes.
 * The shelf is separate from Git stash and persists across VS Code sessions.
 */
export class ShelfService implements IShelfService {
  private _gitCli: GitCli;
  private _shelfCache: Map<string, IShelfItem[]> = new Map();
  private _onDidChangeShelf: vscode.EventEmitter<IShelfItem[]>;
  private _disposables: vscode.Disposable[] = [];

  /**
   * Event fired when shelf changes
   */
  readonly onDidChangeShelf: vscode.Event<IShelfItem[]>;

  constructor(gitCli?: GitCli) {
    this._gitCli = gitCli || createGitCli();
    this._onDidChangeShelf = new vscode.EventEmitter<IShelfItem[]>();
    this.onDidChangeShelf = this._onDidChangeShelf.event;
  }

  /**
   * Shelve selected changes.
   * Saves the selected changes to the shelf storage and optionally removes them from the working directory.
   *
   * @param repo - The repository
   * @param name - Name for the shelf item
   * @param changes - Selection of changes to shelve (files, changelists, or hunks)
   * @returns The created shelf item
   */
  async shelve(repo: IRepository, name: string, changes: IShelveSelection): Promise<IShelfItem> {
    const cwd = repo.rootUri.fsPath;

    // Validate that we have something to shelve
    if (!changes.files?.length && !changes.changelists?.length && !changes.hunks?.size) {
      throw new Error('No changes selected to shelve');
    }

    // Get the files to shelve
    const filesToShelve = this.resolveFilesToShelve(repo, changes);

    if (filesToShelve.length === 0) {
      throw new Error('No files found to shelve');
    }

    // Create shelf files with diffs
    const shelfFiles: IShelfFile[] = [];

    for (const filePath of filesToShelve) {
      // Get the diff for this file
      const diffResult = await this._gitCli.exec(['diff', '--', filePath], { cwd });

      if (diffResult.exitCode === 0 && diffResult.stdout.trim()) {
        // Check if we have specific hunks selected for this file
        const selectedHunks = changes.hunks?.get(filePath);

        let diffContent: string;
        if (selectedHunks && selectedHunks.length > 0) {
          // Generate diff for only the selected hunks
          diffContent = this.generateHunksDiff(filePath, selectedHunks);
        } else {
          // Use the full diff
          diffContent = diffResult.stdout;
        }

        if (diffContent.trim()) {
          shelfFiles.push({
            path: filePath,
            diff: diffContent,
          });
        }
      }
    }

    if (shelfFiles.length === 0) {
      throw new Error('No changes found in selected files');
    }

    // Generate unique ID
    const id = this.generateShelfId();

    // Create the shelf item
    const shelfItem: IShelfItem = {
      id,
      name,
      timestamp: new Date(),
      files: shelfFiles,
    };

    // Save to storage
    this.saveShelfItem(repo, shelfItem);

    // Revert the shelved changes from working directory
    await this.revertShelvedChanges(repo, shelfFiles, changes.hunks);

    // Update cache and fire event
    const items = this.getShelfItems(repo);
    this._onDidChangeShelf.fire(items);

    return shelfItem;
  }

  /**
   * Unshelve changes back to working directory.
   * Restores the shelved changes and optionally removes them from the shelf.
   *
   * @param repo - The repository
   * @param shelfId - ID of the shelf item to unshelve
   * @param options - Unshelve options (removeFromShelf, targetChangelist)
   * @returns Result of the unshelve operation
   */
  async unshelve(
    repo: IRepository,
    shelfId: string,
    options?: IUnshelveOptions
  ): Promise<IUnshelveResult> {
    const cwd = repo.rootUri.fsPath;

    // Get the shelf item
    const items = this.getShelfItems(repo);
    const shelfItem = items.find((item) => item.id === shelfId);

    if (!shelfItem) {
      throw new Error(`Shelf item not found: ${shelfId}`);
    }

    const conflicts: string[] = [];
    // T2-10: track files that applied cleanly so removeAppliedFiles can
    // prune just those paths.
    const appliedCleanly: string[] = [];

    // Apply each file's diff
    for (const file of shelfItem.files) {
      try {
        // Apply the patch to the working directory
        const result = await this._gitCli.exec(['apply', '--3way', '-'], {
          cwd,
          input: file.diff,
        });

        if (result.exitCode !== 0) {
          // Check if it's a conflict
          if (result.stderr.includes('conflict') || result.stderr.includes('CONFLICT')) {
            conflicts.push(file.path);
          } else {
            // Try without 3-way merge
            const fallbackResult = await this._gitCli.exec(['apply', '-'], {
              cwd,
              input: file.diff,
            });

            if (fallbackResult.exitCode !== 0) {
              conflicts.push(file.path);
            } else {
              appliedCleanly.push(file.path);
            }
          }
        } else {
          appliedCleanly.push(file.path);
        }
      } catch {
        conflicts.push(file.path);
      }
    }

    // T2-10: honor removeAppliedFiles — prune cleanly-applied files from
    // the entry and delete the entry if nothing remains. This path takes
    // precedence over removeFromShelf because it is strictly more granular.
    const removeAppliedFiles = options?.removeAppliedFiles === true;
    if (removeAppliedFiles && appliedCleanly.length > 0) {
      const remaining = shelfItem.files.map((f) => f.path).filter((p) => !appliedCleanly.includes(p));
      this.filterShelfFiles(repo, shelfId, remaining);
    } else {
      // Standard removeFromShelf semantics (default is true).
      const removeFromShelf = options?.removeFromShelf !== false;
      if (removeFromShelf && conflicts.length === 0) {
        this.deleteShelfItem(repo, shelfId);
      } else if (conflicts.length === 0) {
        // T2-10: kept on shelf but fully applied → mark as
        // Already-Unshelved so the default filter elides it.
        this.markAsUnshelved(repo, shelfId);
      }
    }

    // Fire change event
    const updatedItems = this.getShelfItems(repo);
    this._onDidChangeShelf.fire(updatedItems);

    return {
      success: conflicts.length === 0,
      conflicts: conflicts.length > 0 ? conflicts : undefined,
    };
  }

  /**
   * Get all shelf items for a repository.
   *
   * @param repo - The repository
   * @returns Array of shelf items
   */
  getShelfItems(repo: IRepository): IShelfItem[] {
    const repoKey = this.getRepoKey(repo);

    // Check cache first
    if (this._shelfCache.has(repoKey)) {
      return this._shelfCache.get(repoKey)!;
    }

    // Load from storage
    const storage = this.loadShelfStorage(repo);
    const items = storage.items.map((item) => this.storageItemToShelfItem(item));

    // Update cache
    this._shelfCache.set(repoKey, items);

    return items;
  }

  /**
   * Delete a shelf item.
   *
   * @param repo - The repository
   * @param shelfId - ID of the shelf item to delete
   */
  deleteShelfItem(repo: IRepository, shelfId: string): void {
    const storage = this.loadShelfStorage(repo);

    // Find and remove the item
    const index = storage.items.findIndex((item) => item.id === shelfId);
    if (index === -1) {
      throw new Error(`Shelf item not found: ${shelfId}`);
    }

    storage.items.splice(index, 1);

    // Save updated storage
    this.saveShelfStorage(repo, storage);

    // Update cache
    const repoKey = this.getRepoKey(repo);
    this._shelfCache.delete(repoKey);

    // Fire change event
    const items = this.getShelfItems(repo);
    this._onDidChangeShelf.fire(items);
  }

  // ===========================================================================
  // T2-10 additions: rename / importPatch / markAsUnshelved / restoreShelf /
  // filterShelfFiles.
  // ===========================================================================

  /**
   * Rename a shelf entry. Throws when the entry does not exist.
   */
  renameShelf(repo: IRepository, shelfId: string, newName: string): void {
    const storage = this.loadShelfStorage(repo);
    const item = storage.items.find((i) => i.id === shelfId);
    if (!item) {
      throw new Error(`Shelf item not found: ${shelfId}`);
    }
    const trimmed = newName.trim();
    if (trimmed.length === 0) {
      throw new Error('Shelf name cannot be empty');
    }
    item.name = trimmed;
    this.saveShelfStorage(repo, storage);

    // Invalidate cache and fire event.
    this._shelfCache.delete(this.getRepoKey(repo));
    this._onDidChangeShelf.fire(this.getShelfItems(repo));
  }

  /**
   * Import a `.patch` / `.diff` file (or inline patch text) as a new shelf
   * entry. The patch's body is captured verbatim as the entry's single
   * file's diff so subsequent unshelve applies it through the standard
   * `git apply` path.
   *
   * The entry is added in an "unapplied" state (no working-tree mutation);
   * callers typically follow with unshelve when they want to actually apply.
   */
  async importPatch(repo: IRepository, options: IImportPatchOptions): Promise<IShelfItem> {
    if (!options.patchPath && options.patchContent === undefined) {
      throw new Error('importPatch: either patchPath or patchContent is required');
    }
    if (options.patchPath && options.patchContent !== undefined) {
      throw new Error('importPatch: patchPath and patchContent are mutually exclusive');
    }

    let content: string;
    if (options.patchPath) {
      content = await fs.promises.readFile(options.patchPath, 'utf-8');
    } else {
      content = options.patchContent!;
    }
    if (content.trim().length === 0) {
      throw new Error('importPatch: patch content is empty');
    }

    const name =
      options.name?.trim() ||
      (options.patchPath ? path.basename(options.patchPath) : 'Imported patch');

    // The patch may touch multiple files, but storage currently keys each
    // shelf file by its repo-relative path. For the MVP we store the entire
    // patch body under a synthetic `imported-patch` path; git apply reads
    // the file headers from the diff itself, so the synthetic path doesn't
    // affect the apply behavior.
    const shelfItem: IShelfItem = {
      id: this.generateShelfId(),
      name,
      timestamp: new Date(),
      files: [{ path: 'imported-patch', diff: content }],
    };

    this.saveShelfItem(repo, shelfItem);
    this._shelfCache.delete(this.getRepoKey(repo));
    this._onDidChangeShelf.fire(this.getShelfItems(repo));

    return shelfItem;
  }

  /**
   * Mark a shelf entry as successfully applied. Idempotent.
   */
  markAsUnshelved(repo: IRepository, shelfId: string): void {
    const storage = this.loadShelfStorage(repo);
    const item = storage.items.find((i) => i.id === shelfId);
    if (!item) {
      return; // Idempotent — silently no-op when the entry is already gone.
    }
    if (item.unshelvedAt !== undefined) {
      return;
    }
    item.unshelvedAt = Date.now();
    this.saveShelfStorage(repo, storage);
    this._shelfCache.delete(this.getRepoKey(repo));
    this._onDidChangeShelf.fire(this.getShelfItems(repo));
  }

  /**
   * Re-activate an Already-Unshelved entry. Idempotent.
   */
  restoreShelf(repo: IRepository, shelfId: string): void {
    const storage = this.loadShelfStorage(repo);
    const item = storage.items.find((i) => i.id === shelfId);
    if (!item) {
      return;
    }
    if (item.unshelvedAt === undefined) {
      return;
    }
    item.unshelvedAt = undefined;
    this.saveShelfStorage(repo, storage);
    this._shelfCache.delete(this.getRepoKey(repo));
    this._onDidChangeShelf.fire(this.getShelfItems(repo));
  }

  /**
   * Remove every file from a shelf entry whose path is NOT in
   * `remainingPaths`. If the resulting entry has zero files the whole
   * entry is deleted.
   *
   * @returns the updated entry, or `undefined` when it was deleted.
   */
  filterShelfFiles(
    repo: IRepository,
    shelfId: string,
    remainingPaths: string[]
  ): IShelfItem | undefined {
    const storage = this.loadShelfStorage(repo);
    const index = storage.items.findIndex((i) => i.id === shelfId);
    if (index < 0) {
      return undefined;
    }
    const retainSet = new Set(remainingPaths);
    const item = storage.items[index];
    item.files = item.files.filter((f) => retainSet.has(f.path));
    if (item.files.length === 0) {
      storage.items.splice(index, 1);
      this.saveShelfStorage(repo, storage);
      this._shelfCache.delete(this.getRepoKey(repo));
      this._onDidChangeShelf.fire(this.getShelfItems(repo));
      return undefined;
    }
    this.saveShelfStorage(repo, storage);
    this._shelfCache.delete(this.getRepoKey(repo));
    const updated = this.storageItemToShelfItem(item);
    this._onDidChangeShelf.fire(this.getShelfItems(repo));
    return updated;
  }

  /**
   * Get diff for a shelf item.
   * Returns the diffs for all files in the shelf item.
   *
   * @param repo - The repository
   * @param shelfId - ID of the shelf item
   * @returns Array of diffs for the shelf item
   */
  getShelfDiff(repo: IRepository, shelfId: string): Promise<IDiff[]> {
    const items = this.getShelfItems(repo);
    const shelfItem = items.find((item) => item.id === shelfId);

    if (!shelfItem) {
      return Promise.reject(new Error(`Shelf item not found: ${shelfId}`));
    }

    // Parse the diffs from the stored diff content
    const diffs: IDiff[] = [];

    for (const file of shelfItem.files) {
      const parsedDiffs = parseDiff(file.diff);
      diffs.push(...parsedDiffs);
    }

    return Promise.resolve(diffs);
  }

  /**
   * Resolve the list of files to shelve based on the selection.
   *
   * @param _repo - The repository (reserved for future changelist support)
   * @param changes - The selection of changes
   * @returns Array of file paths to shelve
   */
  private resolveFilesToShelve(_repo: IRepository, changes: IShelveSelection): string[] {
    const files = new Set<string>();

    // Add explicitly selected files
    if (changes.files) {
      for (const file of changes.files) {
        files.add(file);
      }
    }

    // Add files from hunks selection
    if (changes.hunks) {
      for (const filePath of changes.hunks.keys()) {
        files.add(filePath);
      }
    }

    // TODO: Add files from changelists when ChangelistService is implemented
    // For now, changelists are not supported

    return Array.from(files);
  }

  /**
   * Generate a diff string for specific hunks.
   *
   * @param filePath - The file path
   * @param hunks - The hunks to include
   * @returns The diff string
   */
  private generateHunksDiff(filePath: string, hunks: IHunk[]): string {
    const lines: string[] = [
      `diff --git a/${filePath} b/${filePath}`,
      `--- a/${filePath}`,
      `+++ b/${filePath}`,
    ];

    for (const hunk of hunks) {
      lines.push(hunk.header);

      for (const line of hunk.lines) {
        switch (line.type) {
          case 'add':
            lines.push(`+${line.content}`);
            break;
          case 'delete':
            lines.push(`-${line.content}`);
            break;
          case 'context':
            lines.push(` ${line.content}`);
            break;
        }
      }
    }

    return lines.join('\n') + '\n';
  }

  /**
   * Revert shelved changes from the working directory.
   *
   * @param repo - The repository
   * @param shelfFiles - The shelved files
   * @param selectedHunks - Optional map of selected hunks per file
   */
  private async revertShelvedChanges(
    repo: IRepository,
    shelfFiles: IShelfFile[],
    selectedHunks?: Map<string, IHunk[]>
  ): Promise<void> {
    const cwd = repo.rootUri.fsPath;

    for (const file of shelfFiles) {
      try {
        // Apply the reverse patch to remove the changes
        await this._gitCli.exec(['apply', '-R', '-'], {
          cwd,
          input: file.diff,
        });
      } catch {
        // If reverse apply fails, try checkout for full file reverts
        if (!selectedHunks?.has(file.path)) {
          try {
            await this._gitCli.exec(['checkout', '--', file.path], { cwd });
          } catch {
            // Ignore errors - the file might be new
          }
        }
      }
    }
  }

  /**
   * Save a shelf item to storage.
   *
   * @param repo - The repository
   * @param item - The shelf item to save
   */
  private saveShelfItem(repo: IRepository, item: IShelfItem): void {
    const storage = this.loadShelfStorage(repo);

    // Convert to storage format
    const storageItem: IShelfStorageItem = {
      id: item.id,
      name: item.name,
      timestamp: item.timestamp.getTime(),
      files: item.files.map((file) => ({
        path: file.path,
        originalContent: '', // Not storing original content for now
        patchContent: file.diff,
      })),
      unshelvedAt: item.unshelvedAt?.getTime(),
    };

    // Add to storage
    storage.items.push(storageItem);

    // Save to file
    this.saveShelfStorage(repo, storage);

    // Update cache
    const repoKey = this.getRepoKey(repo);
    this._shelfCache.delete(repoKey);
  }

  /**
   * Load shelf storage from file.
   *
   * @param repo - The repository
   * @returns The shelf storage
   */
  private loadShelfStorage(repo: IRepository): IShelfStorage {
    const storagePath = this.getStoragePath(repo);

    try {
      if (fs.existsSync(storagePath)) {
        const content = fs.readFileSync(storagePath, 'utf8');
        const storage = JSON.parse(content) as IShelfStorage;

        // Validate version. v1 → v2 is a pure additive migration: new
        // optional `unshelvedAt` field. Entries without the field simply
        // remain "not yet unshelved". Re-tag the version in-place so the
        // next save writes the current schema.
        if (storage.version !== SHELF_STORAGE_VERSION) {
          if (storage.version === 1) {
            storage.version = SHELF_STORAGE_VERSION;
          } else {
            console.warn(
              `Shelf storage version mismatch: expected ${SHELF_STORAGE_VERSION}, got ${storage.version}`
            );
          }
        }

        return storage;
      }
    } catch (error) {
      console.error('Failed to load shelf storage:', error);
    }

    // Return empty storage
    return {
      version: SHELF_STORAGE_VERSION,
      items: [],
    };
  }

  /**
   * Save shelf storage to file.
   *
   * @param repo - The repository
   * @param storage - The shelf storage to save
   */
  private saveShelfStorage(repo: IRepository, storage: IShelfStorage): void {
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
      console.error('Failed to save shelf storage:', error);
      throw new Error('Failed to save shelf storage');
    }
  }

  /**
   * Get the storage file path for a repository.
   *
   * @param repo - The repository
   * @returns The storage file path
   */
  private getStoragePath(repo: IRepository): string {
    return path.join(repo.rootUri.fsPath, '.git', SHELF_STORAGE_FILE);
  }

  /**
   * Convert a storage item to a shelf item.
   *
   * @param storageItem - The storage item
   * @returns The shelf item
   */
  private storageItemToShelfItem(storageItem: IShelfStorageItem): IShelfItem {
    return {
      id: storageItem.id,
      name: storageItem.name,
      timestamp: new Date(storageItem.timestamp),
      files: storageItem.files.map((file) => ({
        path: file.path,
        diff: file.patchContent,
      })),
      unshelvedAt:
        storageItem.unshelvedAt !== undefined ? new Date(storageItem.unshelvedAt) : undefined,
    };
  }

  /**
   * Generate a unique shelf ID.
   *
   * @returns A unique ID string
   */
  private generateShelfId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `shelf-${timestamp}-${random}`;
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
    this._onDidChangeShelf.dispose();
    this._shelfCache.clear();

    for (const disposable of this._disposables) {
      disposable.dispose();
    }
    this._disposables = [];
  }
}

/**
 * Create a new ShelfService instance.
 *
 * @param gitCli - Optional GitCli instance to use
 * @returns A new ShelfService instance
 */
export function createShelfService(gitCli?: GitCli): ShelfService {
  return new ShelfService(gitCli);
}
