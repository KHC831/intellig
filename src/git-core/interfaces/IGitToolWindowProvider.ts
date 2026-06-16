/**
 * Git Tool Window Provider interface.
 * Provides the main Git tool window with a 2-panel layout (Graph Panel, Details Panel).
 */

import * as vscode from 'vscode';
import { ICommit, FileStatus } from './IGitService';

// ─── Two-Panel State Interfaces ────────────────────────────────────────────

/**
 * Changed file entry for the Details Panel.
 * Represents a file that was modified in a commit.
 */
export interface IChangedFile {
  path: string;
  status: FileStatus;
  oldPath?: string; // for renames
}

/**
 * Commit details data model for the Details Panel.
 * Contains full commit metadata and changed files.
 */
export interface ICommitDetails {
  hash: string;
  message: string;
  body?: string;
  author: { name: string; email: string };
  date: Date;
  parents: string[];
  branches: string[];
  tags: string[];
  changedFiles: IChangedFile[];
  /** Optional error message when changed files could not be loaded */
  changedFilesError?: string;
}

// ─── Preserved Types (still used by other services) ──────────────────────────

/**
 * State for the Log tab (preserved for backward compatibility during migration)
 */
export interface ILogState {
  selectedCommits: Set<string>;
  expandedCommit?: string;
  filter?: ILogFilter;
}

/**
 * Log filter options
 */
export interface ILogFilter {
  branch?: string;
  author?: string;
  since?: Date;
  until?: Date;
  path?: string;
  searchText?: string;
  /** Exclude merge commits — IntelliJ's VCS-log "No Merges" filter. */
  noMerges?: boolean;
  /**
   * Follow only the first parent of each merge (`--first-parent`). Mirrors
   * IntelliJ PermanentGraph.Options.FirstParent ("Follow only the first parent
   * commit upon seeing a merge commit").
   */
  firstParent?: boolean;
  /**
   * Prune merges made redundant by history simplification (`--simplify-merges`).
   * Part of IntelliJ's VCS-log graph options chooser.
   */
  simplifyMerges?: boolean;
  /** Only commits with at least this many parents (`--min-parents=N`). */
  minParents?: number;
  /** Only commits with at most this many parents (`--max-parents=N`). */
  maxParents?: number;
  /**
   * Revision range like "main..feature" or "main...feature". Passed directly to
   * git log as a positional ref. Mirrors IntelliJ BranchFilterModel range
   * notation, which produces a VcsLogRangeFilter rather than a branch filter.
   */
  logRange?: string;
  /** True = use Perl-extended regex (-E); false = plain text. */
  searchRegex?: boolean;
  /** True = case-sensitive; false = case-insensitive (--regexp-ignore-case). */
  searchCaseSensitive?: boolean;
}

/**
 * Console log entry (preserved — used by IConsoleService and ConsoleService)
 */
export interface IConsoleEntry {
  timestamp: Date;
  command: string;
  output: string;
  exitCode?: number;
  isError: boolean;
}

// ─── Backward-Compatible Types ───────────────────────────────────────────────
// IChangelist and IFileChange are re-exported for use by other services.

import { IChangelist, IFileChange } from '../../changelists/interfaces/IChangelistService';

export { IChangelist, IFileChange };

// ─── Webview Message Protocol ────────────────────────────────────────────────

/**
 * Messages from the webview to the extension host.
 */
export type WebviewMessage =
  | { type: 'branchClick'; branchName: string }
  | { type: 'selectCommit'; commitHash: string }
  | { type: 'toggleCommitSelection'; commitHash: string }
  | { type: 'commitContextMenu'; action: string; commitHashes: string[] }
  | { type: 'doubleClickFile'; commitHash: string; path: string }
  | { type: 'panelResize'; widths: [number, number] }
  | { type: 'loadMoreCommits' }
  | { type: 'refresh' }
  | { type: 'initRepository' };

// ─── Provider Interface ──────────────────────────────────────────────────────

/**
 * Git Tool Window Provider interface.
 * Implements VS Code's WebviewViewProvider to provide the 2-panel Git tool window.
 */
export interface IGitToolWindowProvider extends vscode.WebviewViewProvider {
  /**
   * Resolve the webview view when it becomes visible.
   * This is called by VS Code when the view needs to be displayed.
   */
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    token: vscode.CancellationToken
  ): void | Thenable<void>;

  /**
   * Get the current state of the tool window
   */
  getState(): { hasRepository: boolean };

  /**
   * Refresh the tool window content
   */
  refresh(): void;

  /**
   * Update commits displayed in the Graph Panel
   */
  updateCommits?(
    commits: ICommit[],
    branchMap?: Map<string, string[]>,
    tagMap?: Map<string, string[]>
  ): void;

  /**
   * Update commit details displayed in the Details Panel
   */
  updateCommitDetails?(hash: string, changedFiles: IChangedFile[], error?: unknown): void;

  /**
   * Add a console entry (preserved for backward compatibility)
   */
  addConsoleEntry(entry: Omit<IConsoleEntry, 'timestamp'>): void;

  /**
   * Clear console entries (preserved for backward compatibility)
   */
  clearConsole(): void;

  /**
   * Event fired when the state changes
   */
  onDidChangeState: vscode.Event<unknown>;

  /**
   * Dispose of resources
   */
  dispose(): void;
}
