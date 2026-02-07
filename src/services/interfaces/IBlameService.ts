import * as vscode from 'vscode';
import { IBlameLine, IRepository } from './IGitService';

/**
 * Blame information for a file
 */
export interface IBlameInfo {
  path: string;
  lines: IBlameLine[];
}

/**
 * Blame Service interface for blame/annotation functionality.
 */
export interface IBlameService {
  /**
   * Get blame information for a file
   */
  getBlame(repo: IRepository, path: string, revision?: string): Promise<IBlameInfo>;

  /**
   * Get blame for a specific line
   */
  getBlameForLine(repo: IRepository, path: string, line: number): Promise<IBlameLine>;

  /**
   * Get blame for the file at the previous revision
   */
  getPreviousRevisionBlame(repo: IRepository, path: string, commit: string): Promise<IBlameInfo>;

  /**
   * Event fired when blame information changes
   */
  onDidChangeBlame: vscode.Event<{ path: string; blame: IBlameInfo }>;

  /**
   * Dispose of resources
   */
  dispose(): void;
}
