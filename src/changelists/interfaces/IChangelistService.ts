import * as vscode from 'vscode';
import { IRepository } from '../../git-core/interfaces/IGitService';
import type { IChangelist } from './changelistModels';

// Pure model shapes live in the vscode-free `./changelistModels` so a webview
// entry's protocol can type-import them without pulling this file's `vscode`
// import into the DOM-only program. Re-exported so existing importers are
// unchanged.
export type { IFileChange, IChangelist } from './changelistModels';

/**
 * Changelist Service interface for managing changelists.
 * Changelists organize uncommitted changes into named groups.
 */
export interface IChangelistService {
  /**
   * Get all changelists for a repository
   */
  getChangelists(repo: IRepository): IChangelist[];

  /**
   * Create a new changelist
   */
  createChangelist(repo: IRepository, name: string): IChangelist;

  /**
   * Delete a changelist (files move to default changelist)
   */
  deleteChangelist(repo: IRepository, id: string): void;

  /**
   * Rename a changelist
   */
  renameChangelist(repo: IRepository, id: string, newName: string): void;

  /**
   * Move files to a specific changelist
   */
  moveToChangelist(repo: IRepository, files: string[], changelistId: string): void;

  /**
   * Get the default changelist (always exists)
   */
  getDefaultChangelist(repo: IRepository): IChangelist;

  /**
   * Set the active changelist for the given repository.
   * The active changelist is used as the default target for new file
   * assignments made through the UI.
   *
   * @param repo - The repository
   * @param id - ID of the changelist to mark active. Must reference an
   *   existing changelist; otherwise an error is thrown.
   */
  setActiveChangelist(repo: IRepository, id: string): Promise<void>;

  /**
   * Get the currently active changelist for the given repository.
   * Falls back to the default changelist if no active id has been set.
   */
  getActiveChangelist(repo: IRepository): Promise<IChangelist>;

  /**
   * Reconcile the stored changelist assignments with the current git
   * working-tree status. Git status is the source of truth for which
   * files are dirty; storage only holds path → changelistId overlays.
   *
   * Steps (see cluster-C-tool-windows.md section 4.4):
   *  a. fetch current git status
   *  b. prune storage entries whose path is no longer dirty
   *  c. add any missing dirty-file entries to the default changelist
   *  d. persist
   *  e. fire {@link onDidChangeChangelists}
   *
   * Concurrent calls for the same repository coalesce to a single
   * in-flight reconcile.
   */
  reconcileWithGitStatus(repo: IRepository): Promise<void>;

  /**
   * Return the changelist id that owns the given working-tree path,
   * or `undefined` if the path is not tracked by any changelist.
   *
   * Paths are compared as-stored (no case normalization) to match
   * git's behavior on the current platform.
   */
  getChangelistForFile(repo: IRepository, filePath: string): Promise<string | undefined>;

  /**
   * Event fired when changelists change
   */
  onDidChangeChangelists: vscode.Event<IChangelist[]>;

  /**
   * Dispose of resources
   */
  dispose(): void;
}
