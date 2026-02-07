/**
 * Git Tool Window Provider interface.
 * Provides the main Git tool window with tabbed interface (Local Changes, Log, Console).
 */

import * as vscode from 'vscode';
import { GitToolWindowTab } from './IConfigurationService';
import { IChangelist } from './IChangelistService';

/**
 * State for the Local Changes tab
 */
export interface ILocalChangesState {
  changelists: IChangelist[];
  expandedChangelists: Set<string>;
  selectedFiles: Set<string>;
}

/**
 * State for the Log tab
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
 * Console log entry
 */
export interface IConsoleEntry {
  timestamp: Date;
  command: string;
  output: string;
  exitCode?: number;
  isError: boolean;
}

/**
 * State for the Console tab
 */
export interface IConsoleState {
  entries: IConsoleEntry[];
  maxEntries: number;
}

/**
 * Complete state for the Git Tool Window
 */
export interface IGitToolWindowState {
  activeTab: GitToolWindowTab;
  localChangesState: ILocalChangesState;
  logState: ILogState;
  consoleState: IConsoleState;
  hasRepository: boolean;
}

/**
 * Git Tool Window Provider interface.
 * Implements VS Code's WebviewViewProvider to provide the Git tool window.
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
   * Set the active tab in the tool window
   */
  setActiveTab(tab: GitToolWindowTab): void;

  /**
   * Get the current active tab
   */
  getActiveTab(): GitToolWindowTab;

  /**
   * Get the current state of the tool window
   */
  getState(): IGitToolWindowState;

  /**
   * Refresh the tool window content
   */
  refresh(): void;

  /**
   * Add a console entry
   */
  addConsoleEntry(entry: Omit<IConsoleEntry, 'timestamp'>): void;

  /**
   * Clear console entries
   */
  clearConsole(): void;

  /**
   * Event fired when the active tab changes
   */
  onDidChangeActiveTab: vscode.Event<GitToolWindowTab>;

  /**
   * Event fired when the state changes
   */
  onDidChangeState: vscode.Event<IGitToolWindowState>;

  /**
   * Dispose of resources
   */
  dispose(): void;
}
