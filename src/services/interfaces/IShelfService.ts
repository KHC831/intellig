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
}

/**
 * Options for unshelving changes
 */
export interface IUnshelveOptions {
  removeFromShelf?: boolean;
  targetChangelist?: string;
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
