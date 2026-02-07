import * as vscode from 'vscode';
import { FileStatus, IHunk, IRepository } from './IGitService';

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
  files: IFileChange[];
}

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
   * Event fired when changelists change
   */
  onDidChangeChangelists: vscode.Event<IChangelist[]>;

  /**
   * Dispose of resources
   */
  dispose(): void;
}
