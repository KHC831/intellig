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
 * Per-invocation blame options. Map 1-to-1 onto `git blame` flags.
 *
 * Design ref: T2-08 (gap analysis) — surfaces IntelliJ "Options" submenu
 * (Ignore Whitespaces / Detect Movements Within File / Detect Movements
 * Across Files).
 */
export interface IBlameOptions {
  /** `-w`: ignore whitespace when comparing parent/child revisions. */
  ignoreWhitespace?: boolean;
  /** `-M`: detect moved/copied lines **within** the same file. */
  detectMovementsWithinFile?: boolean;
  /** `-C`: detect moved/copied lines **across** files (implies `-M`). */
  detectMovementsAcrossFiles?: boolean;
}

/**
 * Blame Service interface for blame/annotation functionality.
 */
export interface IBlameService {
  /**
   * Get blame information for a file.
   *
   * @param repo - the repository
   * @param path - the file path (relative to repo root)
   * @param revision - optional revision (defaults to HEAD)
   * @param options - optional blame flags (see {@link IBlameOptions})
   */
  getBlame(
    repo: IRepository,
    path: string,
    revision?: string,
    options?: IBlameOptions
  ): Promise<IBlameInfo>;

  /**
   * Get blame for a specific line
   */
  getBlameForLine(
    repo: IRepository,
    path: string,
    line: number,
    options?: IBlameOptions
  ): Promise<IBlameLine>;

  /**
   * Get blame for the file at the previous revision
   */
  getPreviousRevisionBlame(
    repo: IRepository,
    path: string,
    commit: string,
    options?: IBlameOptions
  ): Promise<IBlameInfo>;

  /**
   * Event fired when blame information changes
   */
  onDidChangeBlame: vscode.Event<{ path: string; blame: IBlameInfo }>;

  /**
   * Dispose of resources
   */
  dispose(): void;
}
