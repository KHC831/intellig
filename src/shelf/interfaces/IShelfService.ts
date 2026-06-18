import * as vscode from 'vscode';
import { IDiff, IHunk, IRepository } from '../../git-core/interfaces/IGitService';

/**
 * Selection of changes to shelve
 */
export interface IShelveSelection {
  files?: string[];
  changelists?: string[];
  hunks?: Map<string, IHunk[]>;
}

/**
 * Shelved file information.
 *
 * Text files carry their change as a unified `diff`. Binary files cannot be
 * represented as text hunks, so they instead capture the raw "after" bytes in
 * `binaryContent` (base64) and set `isBinary`. This mirrors IntelliJ's
 * `ShelvedBinaryFile` (platform/vcs-impl/.../shelf/ShelvedBinaryFile.java),
 * which stores the shelved binary as a separate file referenced by
 * `SHELVED_PATH` rather than encoding it in the text patch.
 */
export interface IShelfFile {
  path: string;
  diff: string;
  /**
   * `true` when this entry is a binary file. Binary entries are restored by
   * writing `binaryContent` back to disk (or deleting the file) rather than
   * via `git apply`, and the diff view shows "binary file" instead of text.
   */
  isBinary?: boolean;
  /**
   * Base64-encoded raw bytes of the file's shelved ("after") content. Present
   * only for binary entries. `undefined` for a deleted binary file — mirrors
   * IntelliJ's `ShelvedBinaryFile.SHELVED_PATH == null` deletion marker.
   */
  binaryContent?: string;
  /**
   * Change status for a binary entry: whether the shelved file was added,
   * modified, or deleted. Drives whether unshelve writes bytes or deletes the
   * path, and lets the diff view label the status. Absent for text entries.
   */
  binaryStatus?: 'added' | 'modified' | 'deleted';
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
   * view unless `Show Already Unshelved` is enabled.
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
   * When `true`, drop any file from the shelf entry that applied
   * cleanly. If the entry is emptied, the whole entry is deleted. Lets
   * users incrementally unshelve and retain only conflict/uncovered files.
   */
  removeAppliedFiles?: boolean;
  /**
   * Repo-relative paths of the subset of files to unshelve (partial /
   * per-file unshelve). When provided, only these files are applied to the
   * working tree; every other file in the entry is never touched and stays
   * shelved. When omitted the whole entry is unshelved (existing behavior).
   *
   * Mirrors IntelliJ's
   * `ShelveChangesManager.unshelveChangeList(changeList, changes subset, …)`
   * where unselected patches are collected into `remainingPatches` and
   * written back to the shelf after applying the selection.
   */
  files?: string[];
}

/**
 * Payload for importing a `.patch` / `.diff` file as a new shelf
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
   * Rename a shelf entry. The new name is persisted to storage.
   * Throws when the entry can't be found.
   */
  renameShelf(repo: IRepository, shelfId: string, newName: string): void;

  /**
   * Import a `.patch` / `.diff` file as a new shelf entry. The
   * patch's body becomes the entry's single file's diff content. No git
   * commands run — the patch is stored verbatim so subsequent unshelve
   * applies it via the existing `git apply` path.
   *
   * @returns the newly-created shelf item.
   */
  importPatch(repo: IRepository, options: IImportPatchOptions): Promise<IShelfItem>;

  /**
   * Mark a shelf entry as successfully applied. Sets `unshelvedAt`
   * to now so the Already-Unshelved filter can elide it from the default
   * list. Idempotent.
   */
  markAsUnshelved(repo: IRepository, shelfId: string): void;

  /**
   * Re-activate a previously Already-Unshelved entry by clearing
   * `unshelvedAt`. Idempotent.
   */
  restoreShelf(repo: IRepository, shelfId: string): void;

  /**
   * Remove successfully-applied files from a shelf entry, preserving
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
   * Reconstruct the *shelved* version of a single file — the content the user
   * had when they shelved it — by applying the entry's stored patch back onto
   * its base revision (`git show HEAD:<path>`, empty for an added file).
   *
   * Drives the shelf "Compare with Local" diff: the returned text is the
   * left-hand side, the current working-tree file is the right-hand side, so
   * the user sees how the shelved change relates to what's on disk now.
   * Mirrors IntelliJ's `DiffShelvedChangesActionProvider` which materialises
   * `texts.getPatched()` from the base revision plus the shelved patch.
   *
   * @throws when the shelf item or the file within it can't be found.
   */
  getShelvedFileContent(repo: IRepository, shelfId: string, filePath: string): Promise<string>;

  /**
   * Event fired when shelf changes
   */
  onDidChangeShelf: vscode.Event<IShelfItem[]>;

  /**
   * Dispose of resources
   */
  dispose(): void;
}
