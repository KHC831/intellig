import * as vscode from 'vscode';
import { IDiff, IHunk, IRepository } from './IGitService';

/**
 * Selection of changes to shelve
 */
export interface IShelveSelection {
  files?: string[];
  changelists?: string[];
  hunks?: Map<string, IHunk[]>;
}

/**
 * Shelved file information
 */
export interface IShelfFile {
  path: string;
  diff: string;
}

/**
 * Shelf item - a saved set of changes
 */
export interface IShelfItem {
  id: string;
  name: string;
  timestamp: Date;
  files: IShelfFile[];
  /**
   * Timestamp of when this entry was successfully applied (unshelved). Once
   * set the entry is "Already Unshelved" — hidden by default in the Shelf
   * view unless `Show Already Unshelved` is enabled. T2-10 addition.
   */
  unshelvedAt?: Date;
}

/**
 * Options for unshelving changes
 */
export interface IUnshelveOptions {
  removeFromShelf?: boolean;
  targetChangelist?: string;
  /**
   * T2-10: when `true`, drop any file from the shelf entry that applied
   * cleanly. If the entry is emptied, the whole entry is deleted. Lets
   * users incrementally unshelve and retain only conflict/uncovered files.
   */
  removeAppliedFiles?: boolean;
}

/**
 * T2-10: payload for importing a `.patch` / `.diff` file as a new shelf
 * entry. Either `patchContent` OR `patchPath` must be provided. The entry's
 * name defaults to the file's basename when not given.
 */
export interface IImportPatchOptions {
  /** Name for the shelf entry. Defaults to basename(patchPath). */
  name?: string;
  /** Absolute path to the `.patch`/`.diff` file on disk. */
  patchPath?: string;
  /** Inline patch text. Mutually exclusive with `patchPath`. */
  patchContent?: string;
}

/**
 * Result of unshelve operation
 */
export interface IUnshelveResult {
  success: boolean;
  conflicts?: string[];
}

/**
 * Shelf Service interface for IDE-managed shelf storage.
 * The shelf is separate from Git stash and persists across sessions.
 */
export interface IShelfService {
  /**
   * Shelve selected changes
   */
  shelve(repo: IRepository, name: string, changes: IShelveSelection): Promise<IShelfItem>;

  /**
   * Unshelve changes back to working directory
   */
  unshelve(
    repo: IRepository,
    shelfId: string,
    options?: IUnshelveOptions
  ): Promise<IUnshelveResult>;

  /**
   * Get all shelf items for a repository
   */
  getShelfItems(repo: IRepository): IShelfItem[];

  /**
   * Delete a shelf item
   */
  deleteShelfItem(repo: IRepository, shelfId: string): void;

  /**
   * T2-10: rename a shelf entry. The new name is persisted to storage.
   * Throws when the entry can't be found.
   */
  renameShelf(repo: IRepository, shelfId: string, newName: string): void;

  /**
   * T2-10: import a `.patch` / `.diff` file as a new shelf entry. The
   * patch's body becomes the entry's single file's diff content. No git
   * commands run — the patch is stored verbatim so subsequent unshelve
   * applies it via the existing `git apply` path.
   *
   * @returns the newly-created shelf item.
   */
  importPatch(repo: IRepository, options: IImportPatchOptions): Promise<IShelfItem>;

  /**
   * T2-10: mark a shelf entry as successfully applied. Sets `unshelvedAt`
   * to now so the Already-Unshelved filter can elide it from the default
   * list. Idempotent.
   */
  markAsUnshelved(repo: IRepository, shelfId: string): void;

  /**
   * T2-10: re-activate a previously Already-Unshelved entry by clearing
   * `unshelvedAt`. Idempotent.
   */
  restoreShelf(repo: IRepository, shelfId: string): void;

  /**
   * T2-10: remove successfully-applied files from a shelf entry, preserving
   * only those paths listed in `remainingPaths`. When the resulting entry
   * has zero files the entry itself is deleted and the method returns
   * `undefined`.
   */
  filterShelfFiles(
    repo: IRepository,
    shelfId: string,
    remainingPaths: string[]
  ): IShelfItem | undefined;

  /**
   * Get diff for a shelf item
   */
  getShelfDiff(repo: IRepository, shelfId: string): Promise<IDiff[]>;

  /**
   * Event fired when shelf changes
   */
  onDidChangeShelf: vscode.Event<IShelfItem[]>;

  /**
   * Dispose of resources
   */
  dispose(): void;
}
