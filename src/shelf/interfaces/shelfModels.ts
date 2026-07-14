/**
 * Pure shelf data models — vscode-free.
 *
 * Split out of {@link import('./IShelfService').IShelfService} (which imports
 * `vscode` for its service surface) so a webview entry's `*.protocol.ts` can
 * type-import them without pulling the vscode runtime into the DOM-only webview
 * program. {@link import('./IShelfService')} re-exports both, so every existing
 * importer is unchanged.
 */

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
  /**
   * Timestamp of when this entry was deleted into the recycle bin. Once set
   * the entry is in "Recently Deleted" — excluded from the active list
   * returned by {@link import('./IShelfService').IShelfService.getShelfItems}
   * and surfaced only via
   * {@link import('./IShelfService').IShelfService.getRecycledShelfItems}. A
   * deleted entry can be restored
   * ({@link import('./IShelfService').IShelfService.restoreFromRecycleBin}) or
   * purged
   * ({@link import('./IShelfService').IShelfService.deleteShelfItemPermanently}).
   * Mirrors IntelliJ's `ShelvedChangeList.isDeleted()` flag
   * (ShelveChangesManager.markChangeListAsDeleted / restoreList).
   */
  deletedAt?: Date;
  /**
   * Repo-relative paths of files whose changes could NOT be removed from the
   * working tree after being saved to the shelf. When non-empty the shelve is
   * only PARTIAL: the changes are stored on the shelf but the file(s) listed
   * here are still live in the working tree. Callers should surface a warning
   * so the user knows to resolve the duplication manually.
   *
   * Absent (or empty) when all working-tree removals succeeded.
   */
  partialCleanupFailures?: string[];
}
