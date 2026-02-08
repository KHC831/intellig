/**
 * Git Tool Window Provider interface.
 * Provides the main Git tool window with a 3-panel layout (Branch Panel, Graph Panel, Details Panel).
 */

import * as vscode from 'vscode';
import { IBranch, ICommit, FileStatus } from './IGitService';
import { ICommitNode } from '../../utils/commitGraph';
import { ActiveLaneMap } from '../../utils/graphRenderer';

// ─── Three-Panel State Interfaces ────────────────────────────────────────────

/**
 * Changed file entry for the Details Panel.
 * Represents a file that was modified in a commit.
 *
 * Requirements: 4.2
 */
export interface IChangedFile {
  path: string;
  status: FileStatus;
  oldPath?: string; // for renames
}

/**
 * Branch panel data model.
 * Organizes branches into HEAD, Local, and Remote categories.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5
 */
export interface IBranchPanelData {
  head: {
    name: string;        // branch name or short hash if detached
    isDetached: boolean;
    commitHash?: string; // shown when detached
  };
  local: IBranch[];      // sorted alphabetically by name
  remote: {
    remoteName: string;  // e.g. "origin"
    branches: IBranch[]; // sorted alphabetically
  }[];
}

/**
 * Commit details data model for the Details Panel.
 * Contains full commit metadata and changed files.
 *
 * Requirements: 4.1, 4.2
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
}

/**
 * Complete state for the 3-panel Git Tool Window.
 * Replaces the previous tabbed IGitToolWindowState.
 *
 * Requirements: 1.1, 1.2, 5.4
 */
export interface IThreePanelState {
  // Branch panel
  branches: {
    head: { name: string; isDetached: boolean; commitHash?: string };
    local: IBranch[];
    remote: Map<string, IBranch[]>; // grouped by remote name
  };
  selectedBranch?: string;

  // Graph panel
  commitNodes: ICommitNode[];
  selectedCommits: Set<string>;
  activeLaneMap: ActiveLaneMap;
  graphWidth: number;
  loadedCount: number;
  totalAvailable: number;

  // Details panel
  expandedCommit?: {
    commit: ICommit;
    node: ICommitNode;
    changedFiles: IChangedFile[];
  };

  // Layout
  panelWidths: [number, number, number]; // percentages, e.g. [20, 50, 30]
  hasRepository: boolean;
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

import { IChangelist, IFileChange } from './IChangelistService';

export { IChangelist, IFileChange };

// ─── Webview Message Protocol ────────────────────────────────────────────────

/**
 * Messages from the webview to the extension host.
 *
 * Requirements: 2.6, 2.7, 2.8, 3.3, 3.4, 3.5, 4.3, 1.3, 1.4, 3.8, 5.1, 5.2
 */
export type WebviewMessage =
  | { type: 'branchClick'; branchName: string }
  | { type: 'branchContextMenu'; branchName: string; branchType: 'local' | 'remote'; action: string }
  | { type: 'selectCommit'; commitHash: string }
  | { type: 'toggleCommitSelection'; commitHash: string }
  | { type: 'commitContextMenu'; action: string; commitHashes: string[] }
  | { type: 'doubleClickFile'; commitHash: string; path: string }
  | { type: 'panelResize'; widths: [number, number, number] }
  | { type: 'loadMoreCommits' }
  | { type: 'refresh' }
  | { type: 'initRepository' };

// ─── Provider Interface ──────────────────────────────────────────────────────

/**
 * Git Tool Window Provider interface.
 * Implements VS Code's WebviewViewProvider to provide the 3-panel Git tool window.
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
   * Update branches displayed in the Branch Panel
   */
  updateBranches?(branchData: IBranchPanelData): void;

  /**
   * Update commits displayed in the Graph Panel
   */
  updateCommits?(commits: ICommit[], branchMap?: Map<string, string[]>, tagMap?: Map<string, string[]>): void;

  /**
   * Update commit details displayed in the Details Panel
   */
  updateCommitDetails?(commit: ICommit, files: IChangedFile[]): void;

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
