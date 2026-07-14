/**
 * Pure changelist data models — vscode-free.
 *
 * Split out of {@link import('./IChangelistService').IChangelistService} (which
 * imports `vscode` for its service surface) so a webview entry's `*.protocol.ts`
 * can type-import them without pulling the vscode runtime into the DOM-only
 * webview program. {@link import('./IChangelistService')} re-exports both, so
 * every existing importer is unchanged.
 */
import type { FileStatus, IHunk } from '../../git-core/interfaces/gitModels';

/**
 * File change within a changelist
 */
export interface IFileChange {
  path: string;
  status: FileStatus;
  staged: boolean;
  hunks?: IHunk[];
}

/**
 * Changelist model - a named group of uncommitted file changes
 */
export interface IChangelist {
  id: string;
  name: string;
  isDefault: boolean;
  /**
   * True when this changelist is the repository's currently-active one —
   * the default target for new file assignments made through the UI. Derived
   * from the storage-level `activeChangelistId` when the model is built, so
   * exactly one changelist in a repo's list carries `isActive: true` (the
   * active id always resolves to an existing changelist, falling back to the
   * default). Lets the tree render the active marker without a separate async
   * {@link import('./IChangelistService').IChangelistService.getActiveChangelist}
   * round-trip on the render path.
   */
  isActive: boolean;
  /**
   * Optional free-form description shown in the changelist tree / edit dialog.
   * Introduced in storage schema v2. Absent when migrating from v1 storage
   * until the first save after migration.
   */
  description?: string;
  files: IFileChange[];
}
