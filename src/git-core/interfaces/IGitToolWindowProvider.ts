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
  /** Lines added in this file (from the diff hunks); omitted for binary files. */
  additions?: number;
  /** Lines deleted in this file (from the diff hunks); omitted for binary files. */
  deletions?: number;
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
  /** Committer, when it differs from the author (amend, rebase, applied patch). */
  committer?: { name: string; email: string };
  date: Date;
  /** Commit timestamp; differs from {@link date} whenever history was rewritten. */
  commitDate?: Date;
  parents: string[];
  branches: string[];
  tags: string[];
  changedFiles: IChangedFile[];
  /** Optional error message when changed files could not be loaded */
  changedFilesError?: string;
  /**
   * Branches (local + remote) that contain this commit, sorted alphabetically.
   * Fetched asynchronously after the commit is selected; `undefined` means the
   * list is still loading, `[]` means the commit is in no branch.
   */
  containingBranches?: string[];
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
/** Relative date presets the log filter offers alongside a custom range. */
export type DatePreset = '24h' | '7d';

export interface ILogFilter {
  branch?: string;
  /** Multi-select branches — union (show commits from ANY). */
  branches?: string[];
  /**
   * Explicit "no branches selected" — show NO commits. Distinct from an
   * absent/empty branch filter (which means "all branches"). Mirrors the repo
   * filter's empty-subset "show none". Maps to `ILogScope.matchNothing`.
   */
  branchesNone?: boolean;
  author?: string;
  /** Multi-select authors — union (git ORs repeated --author patterns). */
  authors?: string[];
  since?: Date;
  until?: Date;
  /**
   * The relative preset `since` came from ('24h' / '7d'). Keeps the popup
   * showing "Last 24 Hours" and keeps Apply from re-rounding the instant to
   * the date input's midnight.
   */
  datePreset?: DatePreset;
  path?: string;
  /** Multi-select paths — union (commits touching ANY). */
  paths?: string[];
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
  /**
   * Stable identity for an entry whose output arrives over time. The provider
   * stores a COPY of each entry, so a streaming entry can only be updated in
   * place if both sides can name it.
   */
  id?: string;
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
  | { type: 'selectCommit'; commitHash: string; viaHashLink?: boolean }
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
   * Update an already-added console entry in place. Streamed output arrives
   * after `addConsoleEntry`, and the provider holds a snapshot, so without this
   * the stored copy keeps the empty string the stream started with.
   */
  updateConsoleEntry(update: {
    id: string;
    output: string;
    exitCode?: number;
    isError?: boolean;
  }): void;

  /**
   * Event fired when the state changes
   */
  onDidChangeState: vscode.Event<unknown>;

  /**
   * Dispose of resources
   */
  dispose(): void;
}
