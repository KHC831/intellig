/**
 * Git Tool Window Provider implementation.
 * Provides the main Git tool window with tabbed interface (Local Changes, Log, Console).
 * Implements VS Code's WebviewViewProvider interface.
 */

import * as vscode from 'vscode';
import {
  IGitToolWindowProvider,
  IGitToolWindowState,
  ILocalChangesState,
  ILogState,
  IConsoleState,
  IConsoleEntry,
  GitToolWindowTab,
  IChangelist,
  IFileChange,
  ILogFilter,
} from './interfaces';
import { FileStatus, ICommit } from './interfaces/IGitService';
import { ICommitNode, generateCommitGraph } from '../utils/commitGraph';
import {
  computeActiveLanes,
  computeGraphWidth,
  DEFAULT_GRAPH_CONFIG,
  IGraphRenderConfig,
  renderGraphSvg,
} from '../utils/graphRenderer';

/**
 * View ID for the Git Tool Window
 */
export const GIT_TOOL_WINDOW_VIEW_ID = 'intellij-git.toolWindow';

/**
 * Default maximum number of console entries to keep
 */
const DEFAULT_MAX_CONSOLE_ENTRIES = 1000;

/**
 * IntelliJ-style file status colors
 * Requirement 17.10: Color coding consistent with IntelliJ's conventions
 */
export const INTELLIJ_FILE_STATUS_COLORS: Record<FileStatus, string> = {
  modified: '#6897BB', // Blue for modified files
  added: '#629755', // Green for added files
  deleted: '#6C6C6C', // Gray for deleted files
  renamed: '#6897BB', // Blue for renamed (similar to modified)
  copied: '#629755', // Green for copied (similar to added)
  untracked: '#CC7832', // Orange/brown for untracked files
  ignored: '#848504', // Dark yellow for ignored files
  conflicted: '#FF0000', // Red for conflicted files
};

/**
 * Context menu action types for Local Changes View
 * Requirement 2.7: Context menu with options
 */
export type LocalChangesContextAction =
  | 'stage'
  | 'unstage'
  | 'revert'
  | 'showDiff'
  | 'moveToChangelist'
  | 'shelve'
  | 'delete';

/**
 * Context menu action types for Log View
 * Requirement 9.5: Context menu on commits
 */
export type LogContextAction =
  | 'cherryPick'
  | 'revert'
  | 'createBranch'
  | 'createTag'
  | 'resetToHere'
  | 'showDiff'
  | 'copyHash';

/**
 * Extended Log state with commit nodes for graph visualization
 */
export interface IExtendedLogState extends ILogState {
  commitNodes: ICommitNode[];
  branchMap: Map<string, string[]>;
  tagMap: Map<string, string[]>;
}

/**
 * Git Tool Window Provider implementation.
 */
export class GitToolWindowProvider implements IGitToolWindowProvider {
  private _webviewView: vscode.WebviewView | undefined;
  private _state: IGitToolWindowState;
  private _extendedLogState: IExtendedLogState;
  private _disposables: vscode.Disposable[] = [];

  // Event emitters
  private readonly _onDidChangeActiveTab = new vscode.EventEmitter<GitToolWindowTab>();
  private readonly _onDidChangeState = new vscode.EventEmitter<IGitToolWindowState>();
  private readonly _onDidRequestContextAction = new vscode.EventEmitter<{
    action: LocalChangesContextAction;
    files: string[];
    targetChangelistId?: string;
  }>();
  private readonly _onDidRequestFileDrop = new vscode.EventEmitter<{
    files: string[];
    targetChangelistId: string;
  }>();
  private readonly _onDidRequestLogContextAction = new vscode.EventEmitter<{
    action: LogContextAction;
    commitHashes: string[];
  }>();
  private readonly _onDidSelectCommit = new vscode.EventEmitter<string>();
  private readonly _onDidRequestCommitDiff = new vscode.EventEmitter<{
    commitHash: string;
    filePath: string;
  }>();
  private readonly _onDidRequestLogFilter = new vscode.EventEmitter<ILogFilter | undefined>();

  // Public events
  public readonly onDidChangeActiveTab = this._onDidChangeActiveTab.event;
  public readonly onDidChangeState = this._onDidChangeState.event;
  public readonly onDidRequestContextAction = this._onDidRequestContextAction.event;
  public readonly onDidRequestFileDrop = this._onDidRequestFileDrop.event;
  public readonly onDidRequestLogContextAction = this._onDidRequestLogContextAction.event;
  public readonly onDidSelectCommit = this._onDidSelectCommit.event;
  public readonly onDidRequestLogFilter = this._onDidRequestLogFilter.event;
  public readonly onDidRequestCommitDiff = this._onDidRequestCommitDiff.event;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    defaultTab?: GitToolWindowTab
  ) {
    // Initialize state with defaults
    this._state = this._createInitialState(defaultTab);
    this._extendedLogState = this._createInitialExtendedLogState();

    // Register event emitters for disposal
    this._disposables.push(
      this._onDidChangeActiveTab,
      this._onDidChangeState,
      this._onDidRequestContextAction,
      this._onDidRequestFileDrop,
      this._onDidRequestLogContextAction,
      this._onDidSelectCommit,
      this._onDidRequestCommitDiff,
      this._onDidRequestLogFilter
    );
  }

  /**
   * Create the initial state for the tool window
   */
  private _createInitialState(defaultTab?: GitToolWindowTab): IGitToolWindowState {
    return {
      activeTab: defaultTab ?? 'local-changes',
      localChangesState: this._createInitialLocalChangesState(),
      logState: this._createInitialLogState(),
      consoleState: this._createInitialConsoleState(),
      hasRepository: false,
    };
  }

  /**
   * Create initial Local Changes state
   */
  private _createInitialLocalChangesState(): ILocalChangesState {
    return {
      changelists: [],
      expandedChangelists: new Set<string>(),
      selectedFiles: new Set<string>(),
    };
  }

  /**
   * Create initial Log state
   */
  private _createInitialLogState(): ILogState {
    return {
      selectedCommits: new Set<string>(),
      expandedCommit: undefined,
      filter: undefined,
    };
  }

  /**
   * Create initial Console state
   */
  private _createInitialConsoleState(): IConsoleState {
    return {
      entries: [],
      maxEntries: DEFAULT_MAX_CONSOLE_ENTRIES,
    };
  }

  /**
   * Create initial extended Log state with commit nodes
   */
  private _createInitialExtendedLogState(): IExtendedLogState {
    return {
      selectedCommits: new Set<string>(),
      expandedCommit: undefined,
      filter: undefined,
      commitNodes: [],
      branchMap: new Map<string, string[]>(),
      tagMap: new Map<string, string[]>(),
    };
  }

  /**
   * Resolve the webview view when it becomes visible.
   * Called by VS Code when the view needs to be displayed.
   */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._webviewView = webviewView;

    // Configure webview options
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    // Set the HTML content
    webviewView.webview.html = this._getHtmlContent(webviewView.webview);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(
      (message: unknown) => this._handleWebviewMessage(message as IWebviewMessage),
      undefined,
      this._disposables
    );

    // Handle visibility changes
    webviewView.onDidChangeVisibility(
      () => {
        if (webviewView.visible) {
          this._updateWebview();
        }
      },
      undefined,
      this._disposables
    );

    // Handle disposal
    webviewView.onDidDispose(
      () => {
        this._webviewView = undefined;
      },
      undefined,
      this._disposables
    );

    // Initial update
    this._updateWebview();
  }

  /**
   * Set the active tab in the tool window
   */
  public setActiveTab(tab: GitToolWindowTab): void {
    if (this._state.activeTab !== tab) {
      // Preserve state of current tab before switching
      this._preserveCurrentTabState();

      // Update active tab
      this._state.activeTab = tab;

      // Fire events
      this._onDidChangeActiveTab.fire(tab);
      this._onDidChangeState.fire(this._state);

      // Update webview
      this._updateWebview();
    }
  }

  /**
   * Get the current active tab
   */
  public getActiveTab(): GitToolWindowTab {
    return this._state.activeTab;
  }

  /**
   * Get the current state of the tool window
   */
  public getState(): IGitToolWindowState {
    // Return a deep copy to prevent external mutation
    return this._cloneState(this._state);
  }

  /**
   * Refresh the tool window content
   */
  public refresh(): void {
    this._updateWebview();
    this._onDidChangeState.fire(this._state);
  }

  /**
   * Add a console entry
   */
  public addConsoleEntry(entry: Omit<IConsoleEntry, 'timestamp'>): void {
    const fullEntry: IConsoleEntry = {
      ...entry,
      timestamp: new Date(),
    };

    this._state.consoleState.entries.push(fullEntry);

    // Trim entries if exceeding max
    while (this._state.consoleState.entries.length > this._state.consoleState.maxEntries) {
      this._state.consoleState.entries.shift();
    }

    // Update webview if console tab is active
    if (this._state.activeTab === 'console') {
      this._updateWebview();
    }

    this._onDidChangeState.fire(this._state);
  }

  /**
   * Clear console entries
   */
  public clearConsole(): void {
    this._state.consoleState.entries = [];

    if (this._state.activeTab === 'console') {
      this._updateWebview();
    }

    this._onDidChangeState.fire(this._state);
  }

  /**
   * Update the Local Changes state
   */
  public updateLocalChangesState(changelists: IChangelist[]): void {
    this._state.localChangesState.changelists = changelists;
    this._state.hasRepository = true;

    if (this._state.activeTab === 'local-changes') {
      this._updateWebview();
    }

    this._onDidChangeState.fire(this._state);
  }

  /**
   * Set repository availability
   */
  public setHasRepository(hasRepository: boolean): void {
    if (this._state.hasRepository !== hasRepository) {
      this._state.hasRepository = hasRepository;
      this._updateWebview();
      this._onDidChangeState.fire(this._state);
    }
  }

  /**
   * Update the Log state with commits
   * Requirement 9.1, 9.2: Display commit history with graph visualization
   */
  public updateLogState(
    commits: ICommit[],
    branchMap?: Map<string, string[]>,
    tagMap?: Map<string, string[]>
  ): void {
    // Generate commit graph nodes
    const commitNodes = generateCommitGraph(commits, branchMap, tagMap);

    const emptyBranchMap: Map<string, string[]> = new Map();
    const emptyTagMap: Map<string, string[]> = new Map();

    this._extendedLogState = {
      ...this._extendedLogState,
      commitNodes,
      branchMap: branchMap || emptyBranchMap,
      tagMap: tagMap || emptyTagMap,
    };

    // Also update the basic log state
    this._state.logState = {
      ...this._state.logState,
    };

    this._state.hasRepository = true;

    if (this._state.activeTab === 'log') {
      this._updateWebview();
    }

    this._onDidChangeState.fire(this._state);
  }

  /**
   * Set the log filter
   * Requirement 9.6: Log filtering
   */
  public setLogFilter(filter: ILogFilter | undefined): void {
    this._state.logState.filter = filter;
    this._extendedLogState.filter = filter;
    this._onDidChangeState.fire(this._state);
  }

  /**
   * Get the extended log state with commit nodes
   */
  public getExtendedLogState(): IExtendedLogState {
    return {
      ...this._extendedLogState,
      selectedCommits: new Set(this._extendedLogState.selectedCommits),
      branchMap: new Map(this._extendedLogState.branchMap),
      tagMap: new Map(this._extendedLogState.tagMap),
    };
  }

  /**
   * Select a commit in the log view
   * Requirement 9.3: Commit selection and details
   */
  public selectCommit(hash: string): void {
    this._state.logState.selectedCommits.clear();
    this._state.logState.selectedCommits.add(hash);
    this._extendedLogState.selectedCommits.clear();
    this._extendedLogState.selectedCommits.add(hash);
    this._state.logState.expandedCommit = hash;
    this._extendedLogState.expandedCommit = hash;

    this._onDidSelectCommit.fire(hash);
    this._onDidChangeState.fire(this._state);

    if (this._state.activeTab === 'log') {
      this._updateWebview();
    }
  }

  /**
   * Toggle commit selection (for multi-select)
   * Requirement 9.8: Multi-commit selection
   */
  public toggleCommitSelection(hash: string): void {
    if (this._state.logState.selectedCommits.has(hash)) {
      this._state.logState.selectedCommits.delete(hash);
      this._extendedLogState.selectedCommits.delete(hash);
    } else {
      this._state.logState.selectedCommits.add(hash);
      this._extendedLogState.selectedCommits.add(hash);
    }

    this._onDidChangeState.fire(this._state);

    if (this._state.activeTab === 'log') {
      this._updateWebview();
    }
  }

  /**
   * Get selected commit hashes
   */
  public getSelectedCommits(): string[] {
    return Array.from(this._state.logState.selectedCommits);
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    this._disposables.forEach((d) => {
      d.dispose();
    });
    this._disposables = [];
    this._webviewView = undefined;
  }

  /**
   * Preserve the state of the current tab before switching
   */
  private _preserveCurrentTabState(): void {
    // State is already preserved in the _state object
    // This method is a hook for any additional preservation logic
    // For example, saving scroll position, selection state, etc.
  }

  /**
   * Clone the state object to prevent external mutation
   */
  private _cloneState(state: IGitToolWindowState): IGitToolWindowState {
    return {
      activeTab: state.activeTab,
      hasRepository: state.hasRepository,
      localChangesState: {
        changelists: [...state.localChangesState.changelists],
        expandedChangelists: new Set(state.localChangesState.expandedChangelists),
        selectedFiles: new Set(state.localChangesState.selectedFiles),
      },
      logState: {
        selectedCommits: new Set(state.logState.selectedCommits),
        expandedCommit: state.logState.expandedCommit,
        filter: state.logState.filter ? { ...state.logState.filter } : undefined,
      },
      consoleState: {
        entries: [...state.consoleState.entries],
        maxEntries: state.consoleState.maxEntries,
      },
    };
  }

  /**
   * Handle messages from the webview
   */
  private _handleWebviewMessage(message: IWebviewMessage): void {
    switch (message.type) {
      case 'switchTab':
        if (isValidTab(message.tab)) {
          this.setActiveTab(message.tab);
        }
        break;
      case 'refresh':
        this.refresh();
        break;
      case 'selectFile':
        if (message.path) {
          this._handleFileSelection(message.path);
        }
        break;
      case 'toggleChangelist':
        if (message.changelistId) {
          this._handleChangelistToggle(message.changelistId);
        }
        break;
      case 'selectCommit':
        if (message.commitHash) {
          this._handleCommitSelection(message.commitHash);
        }
        break;
      case 'toggleCommitSelection':
        if (message.commitHash) {
          this.toggleCommitSelection(message.commitHash);
        }
        break;
      case 'clearConsole':
        this.clearConsole();
        break;
      case 'initRepository':
        void vscode.commands.executeCommand('git.init');
        break;
      case 'contextAction':
        if (message.action && message.files) {
          this._handleContextAction(
            message.action as LocalChangesContextAction,
            message.files,
            message.targetChangelistId
          );
        }
        break;
      case 'logContextAction':
        if (message.action && message.commitHashes) {
          this._handleLogContextAction(message.action as LogContextAction, message.commitHashes);
        }
        break;
      case 'fileDrop':
        if (message.files && message.targetChangelistId) {
          this._handleFileDrop(message.files, message.targetChangelistId);
        }
        break;
      case 'doubleClickFile':
        if (message.path) {
          this._handleFileDoubleClick(message.path);
        }
        break;
      case 'doubleClickCommitFile':
        if (message.commitHash && message.path) {
          this._handleCommitFileDoubleClick(message.commitHash, message.path);
        }
        break;
      case 'applyLogFilter':
        this._handleApplyLogFilter(message.filter as IWebviewLogFilter | null);
        break;
      default:
        console.warn('Unknown webview message type:', message);
    }
  }

  /**
   * Handle applying log filter from webview
   * Requirement 9.6: Log filtering by author, date range, file path
   * Requirement 9.7: Log searching commit messages and content
   */
  private _handleApplyLogFilter(webviewFilter: IWebviewLogFilter | null): void {
    let filter: ILogFilter | undefined;

    if (webviewFilter) {
      filter = {};

      if (webviewFilter.searchText) {
        filter.searchText = webviewFilter.searchText;
      }
      if (webviewFilter.author) {
        filter.author = webviewFilter.author;
      }
      if (webviewFilter.path) {
        filter.path = webviewFilter.path;
      }
      if (webviewFilter.since) {
        filter.since = new Date(webviewFilter.since);
      }
      if (webviewFilter.until) {
        filter.until = new Date(webviewFilter.until);
      }

      // Check if filter is empty
      if (!filter.searchText && !filter.author && !filter.path && !filter.since && !filter.until) {
        filter = undefined;
      }
    }

    this.setLogFilter(filter);
    this._onDidRequestLogFilter.fire(filter);
  }

  /**
   * Handle file selection in Local Changes view
   */
  private _handleFileSelection(path: string): void {
    const selectedFiles = this._state.localChangesState.selectedFiles;

    if (selectedFiles.has(path)) {
      selectedFiles.delete(path);
    } else {
      selectedFiles.add(path);
    }

    this._onDidChangeState.fire(this._state);
  }

  /**
   * Handle changelist expand/collapse toggle
   */
  private _handleChangelistToggle(changelistId: string): void {
    const expandedChangelists = this._state.localChangesState.expandedChangelists;

    if (expandedChangelists.has(changelistId)) {
      expandedChangelists.delete(changelistId);
    } else {
      expandedChangelists.add(changelistId);
    }

    this._updateWebview();
    this._onDidChangeState.fire(this._state);
  }

  /**
   * Handle commit selection in Log view
   */
  private _handleCommitSelection(commitHash: string): void {
    this.selectCommit(commitHash);
  }

  /**
   * Handle log context menu action
   * Requirement 9.5: Context menu on commits
   */
  private _handleLogContextAction(action: LogContextAction, commitHashes: string[]): void {
    this._onDidRequestLogContextAction.fire({
      action,
      commitHashes,
    });
  }

  /**
   * Handle double-click on a file in commit details
   * Requirement 9.4: Double-click shows diff for file in commit
   */
  private _handleCommitFileDoubleClick(commitHash: string, filePath: string): void {
    this._onDidRequestCommitDiff.fire({
      commitHash,
      filePath,
    });
  }

  /**
   * Handle context menu action on files
   * Requirement 2.7: Context menu with options
   */
  private _handleContextAction(
    action: LocalChangesContextAction,
    files: string[],
    targetChangelistId?: string
  ): void {
    this._onDidRequestContextAction.fire({
      action,
      files,
      targetChangelistId,
    });
  }

  /**
   * Handle file drop between changelists
   * Requirement 2.4: Drag files between changelists
   */
  private _handleFileDrop(files: string[], targetChangelistId: string): void {
    this._onDidRequestFileDrop.fire({
      files,
      targetChangelistId,
    });
  }

  /**
   * Handle double-click on a file to show diff
   * Requirement 2.6: Double-click opens diff view
   */
  private _handleFileDoubleClick(path: string): void {
    // Fire context action for showing diff
    this._onDidRequestContextAction.fire({
      action: 'showDiff',
      files: [path],
    });
  }

  /**
   * Update the webview content
   */
  private _updateWebview(): void {
    if (!this._webviewView) {
      return;
    }

    // Regenerate the full HTML to ensure all panels (including graph SVGs) are up to date
    this._webviewView.webview.html = this._getHtmlContent(this._webviewView.webview);
  }

  /**
   * Get the HTML content for the webview
   */
  private _getHtmlContent(webview: vscode.Webview): string {
    // Note: External resource URIs are prepared for future use when we add
    // separate CSS/JS files. Currently using inline styles and scripts.
    // const styleUri = webview.asWebviewUri(
    //   vscode.Uri.joinPath(this._extensionUri, 'resources', 'webview', 'style.css')
    // );
    // const scriptUri = webview.asWebviewUri(
    //   vscode.Uri.joinPath(this._extensionUri, 'resources', 'webview', 'main.js')
    // );

    // Use a nonce for content security
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
  <title>Git Tool Window</title>
  <style>
    ${this._getInlineStyles()}
  </style>
</head>
<body>
  <div class="git-tool-window" role="application" aria-label="Git Tool Window">
    <!-- Tab Bar -->
    <div class="tab-bar" role="tablist" aria-label="Git views">
      <button 
        class="tab-button ${this._state.activeTab === 'local-changes' ? 'active' : ''}" 
        data-tab="local-changes"
        role="tab"
        aria-selected="${this._state.activeTab === 'local-changes'}"
        aria-controls="panel-local-changes"
        tabindex="${this._state.activeTab === 'local-changes' ? '0' : '-1'}"
      >
        Local Changes
      </button>
      <button 
        class="tab-button ${this._state.activeTab === 'log' ? 'active' : ''}" 
        data-tab="log"
        role="tab"
        aria-selected="${this._state.activeTab === 'log'}"
        aria-controls="panel-log"
        tabindex="${this._state.activeTab === 'log' ? '0' : '-1'}"
      >
        Log
      </button>
      <button 
        class="tab-button ${this._state.activeTab === 'console' ? 'active' : ''}" 
        data-tab="console"
        role="tab"
        aria-selected="${this._state.activeTab === 'console'}"
        aria-controls="panel-console"
        tabindex="${this._state.activeTab === 'console' ? '0' : '-1'}"
      >
        Console
      </button>
    </div>

    <!-- Tab Panels -->
    <div class="tab-panels">
      ${this._getLocalChangesPanel()}
      ${this._getLogPanel()}
      ${this._getConsolePanel()}
    </div>
  </div>

  <script nonce="${nonce}">
    ${this._getInlineScript()}
  </script>
</body>
</html>`;
  }

  /**
   * Get the Local Changes panel HTML
   * Requirement 2.1: Display files grouped by changelist
   * Requirement 17.2: Tree structure with expandable changelists
   */
  private _getLocalChangesPanel(): string {
    const isActive = this._state.activeTab === 'local-changes';

    if (!this._state.hasRepository) {
      return `
        <div 
          id="panel-local-changes" 
          class="tab-panel ${isActive ? 'active' : ''}" 
          role="tabpanel"
          aria-labelledby="tab-local-changes"
          ${isActive ? '' : 'hidden'}
        >
          <div class="no-repository">
            <p>No Git repository found in this workspace.</p>
            <button class="init-repo-button" onclick="initRepository()">
              Initialize Repository
            </button>
          </div>
        </div>
      `;
    }

    const changelists = this._state.localChangesState.changelists;
    const expandedChangelists = this._state.localChangesState.expandedChangelists;
    const selectedFiles = this._state.localChangesState.selectedFiles;

    let changelistsHtml = '';
    if (changelists.length === 0) {
      changelistsHtml = '<p class="empty-message">No changes</p>';
    } else {
      changelistsHtml = changelists
        .map((cl) => {
          const isExpanded = expandedChangelists.has(cl.id);
          const filesHtml = isExpanded
            ? cl.files.map((f) => this._getFileItemHtml(f, selectedFiles.has(f.path))).join('')
            : '';

          return `
            <div class="changelist ${isExpanded ? 'expanded' : ''}" 
                 data-id="${cl.id}"
                 ondragover="handleDragOver(event)"
                 ondrop="handleDrop(event, '${cl.id}')"
                 ondragleave="handleDragLeave(event)">
              <div class="changelist-header" 
                   onclick="toggleChangelist('${cl.id}')" 
                   role="button" 
                   tabindex="0" 
                   aria-expanded="${isExpanded}"
                   onkeydown="handleChangelistKeydown(event, '${cl.id}')">
                <span class="expand-icon">${isExpanded ? '▼' : '▶'}</span>
                <span class="changelist-name">${this._escapeHtml(cl.name)}</span>
                <span class="file-count">(${cl.files.length})</span>
                ${cl.isDefault ? '<span class="default-badge">Default</span>' : ''}
              </div>
              <div class="changelist-files" ${isExpanded ? '' : 'hidden'} role="group">
                ${filesHtml}
              </div>
            </div>
          `;
        })
        .join('');
    }

    return `
      <div 
        id="panel-local-changes" 
        class="tab-panel ${isActive ? 'active' : ''}" 
        role="tabpanel"
        aria-labelledby="tab-local-changes"
        ${isActive ? '' : 'hidden'}
      >
        <div class="local-changes-toolbar">
          <button class="toolbar-button" onclick="refreshLocalChanges()" title="Refresh">
            ↻
          </button>
        </div>
        <div class="local-changes-content" role="tree" aria-label="Local Changes">
          ${changelistsHtml}
        </div>
        ${this._getContextMenuHtml()}
      </div>
    `;
  }

  /**
   * Get HTML for a single file item with IntelliJ-style color coding
   * Requirement 2.6: Color-coded file status
   * Requirement 17.10: IntelliJ-style colors
   */
  private _getFileItemHtml(file: IFileChange, isSelected: boolean): string {
    const statusColor = this._getFileStatusColor(file.status);
    const statusChar = this._getFileStatusChar(file.status);
    const stagedIndicator = file.staged ? '●' : '';

    return `
      <div class="file-item ${isSelected ? 'selected' : ''} ${file.staged ? 'staged' : ''}"
           data-path="${this._escapeHtml(file.path)}"
           data-status="${file.status}"
           draggable="true"
           ondragstart="handleDragStart(event, '${this._escapeHtml(file.path)}')"
           ondragend="handleDragEnd(event)"
           onclick="selectFile('${this._escapeHtml(file.path)}')"
           ondblclick="doubleClickFile('${this._escapeHtml(file.path)}')"
           oncontextmenu="showContextMenu(event, '${this._escapeHtml(file.path)}')"
           role="treeitem"
           tabindex="0"
           aria-selected="${isSelected}"
           onkeydown="handleFileKeydown(event, '${this._escapeHtml(file.path)}')">
        <span class="file-status" style="color: ${statusColor};" title="${file.status}">
          ${statusChar}
        </span>
        <span class="file-path" style="color: ${statusColor};">
          ${this._escapeHtml(this._getFileName(file.path))}
        </span>
        <span class="file-dir" title="${this._escapeHtml(file.path)}">
          ${this._escapeHtml(this._getFileDir(file.path))}
        </span>
        ${stagedIndicator ? `<span class="staged-indicator" title="Staged">${stagedIndicator}</span>` : ''}
      </div>
    `;
  }

  /**
   * Get the context menu HTML
   * Requirement 2.7: Context menu with options
   */
  private _getContextMenuHtml(): string {
    return `
      <div id="context-menu" class="context-menu" hidden>
        <div class="context-menu-item" data-action="showDiff">
          <span class="context-menu-icon">📄</span>
          Show Diff
        </div>
        <div class="context-menu-item" data-action="stage">
          <span class="context-menu-icon">➕</span>
          Stage
        </div>
        <div class="context-menu-item" data-action="unstage">
          <span class="context-menu-icon">➖</span>
          Unstage
        </div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" data-action="revert">
          <span class="context-menu-icon">↩️</span>
          Revert
        </div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item context-menu-submenu" data-action="moveToChangelist">
          <span class="context-menu-icon">📁</span>
          Move to Changelist
          <span class="context-menu-arrow">▶</span>
        </div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" data-action="shelve">
          <span class="context-menu-icon">📦</span>
          Shelve Changes
        </div>
        <div class="context-menu-item context-menu-danger" data-action="delete">
          <span class="context-menu-icon">🗑️</span>
          Delete
        </div>
      </div>
    `;
  }

  /**
   * Get IntelliJ-style color for file status
   * Requirement 17.10: Color coding consistent with IntelliJ's conventions
   */
  private _getFileStatusColor(status: FileStatus): string {
    return INTELLIJ_FILE_STATUS_COLORS[status] || '#FFFFFF';
  }

  /**
   * Get status character for file status
   */
  private _getFileStatusChar(status: FileStatus): string {
    const statusChars: Record<FileStatus, string> = {
      modified: 'M',
      added: 'A',
      deleted: 'D',
      renamed: 'R',
      copied: 'C',
      untracked: 'U',
      ignored: 'I',
      conflicted: '!',
    };
    return statusChars[status] || '?';
  }

  /**
   * Get file name from path
   */
  private _getFileName(path: string): string {
    const parts = path.split('/');
    return parts[parts.length - 1];
  }

  /**
   * Get directory part of path
   */
  private _getFileDir(path: string): string {
    const parts = path.split('/');
    if (parts.length <= 1) {
      return '';
    }
    parts.pop();
    return parts.join('/');
  }

  /**
   * Get the Log panel HTML
   * Requirement 9.1, 9.2, 9.3: Log view with graph, commit details, branch/tag labels
   * Requirement 17.5: IntelliJ-style log layout
   */
  private _getLogPanel(): string {
    const isActive = this._state.activeTab === 'log';

    if (!this._state.hasRepository) {
      return `
        <div 
          id="panel-log" 
          class="tab-panel ${isActive ? 'active' : ''}" 
          role="tabpanel"
          aria-labelledby="tab-log"
          ${isActive ? '' : 'hidden'}
        >
          <div class="no-repository">
            <p>No Git repository found in this workspace.</p>
            <button class="init-repo-button" onclick="initRepository()">
              Initialize Repository
            </button>
          </div>
        </div>
      `;
    }

    const commitNodes = this._extendedLogState.commitNodes;
    const selectedCommits = this._state.logState.selectedCommits;
    const expandedCommit = this._state.logState.expandedCommit;
    const filter = this._state.logState.filter;

    // Compute active lanes and graph width for the entire commit list
    const activeLaneMap = computeActiveLanes(commitNodes);
    const graphWidth = computeGraphWidth(commitNodes, DEFAULT_GRAPH_CONFIG);

    let commitsHtml = '';
    if (commitNodes.length === 0) {
      commitsHtml = '<p class="empty-message">No commits found</p>';
    } else {
      commitsHtml = commitNodes
        .map((node, index) =>
          this._getCommitRowHtml(
            node,
            index,
            selectedCommits,
            expandedCommit,
            activeLaneMap.get(index) || new Set(),
            DEFAULT_GRAPH_CONFIG
          )
        )
        .join('');
    }

    // Get expanded commit details if any
    let detailsHtml = '';
    if (expandedCommit) {
      const expandedNode = commitNodes.find((n) => n.commit.hash === expandedCommit);
      if (expandedNode) {
        detailsHtml = this._getCommitDetailsHtml(expandedNode);
      }
    }

    // Get filter bar HTML
    const filterBarHtml = this._getLogFilterBarHtml(filter);

    return `
      <div 
        id="panel-log" 
        class="tab-panel ${isActive ? 'active' : ''}" 
        role="tabpanel"
        aria-labelledby="tab-log"
        ${isActive ? '' : 'hidden'}
      >
        <div class="log-container">
          <div class="log-toolbar">
            <button class="toolbar-button" onclick="toggleLogFilters()" title="Toggle Filters" id="filter-toggle-btn">
              🔍
            </button>
            <button class="toolbar-button" onclick="refreshLog()" title="Refresh">
              ↻
            </button>
          </div>
          ${filterBarHtml}
          <div class="log-split-view">
            <div class="log-commit-list" role="listbox" aria-label="Commit History" style="--graph-width: ${graphWidth}px">
              ${commitsHtml}
            </div>
            <div class="log-details-panel" ${expandedCommit ? '' : 'hidden'}>
              ${detailsHtml}
            </div>
          </div>
        </div>
        ${this._getLogContextMenuHtml()}
      </div>
    `;
  }

  /**
   * Get HTML for the log filter bar
   * Requirement 9.6: Log filtering by author, date range, file path
   * Requirement 9.7: Log searching commit messages and content
   */
  private _getLogFilterBarHtml(filter?: ILogFilter): string {
    const hasActiveFilters =
      filter &&
      (filter.author ||
        filter.since ||
        filter.until ||
        filter.path ||
        filter.searchText ||
        filter.branch);

    // Format dates for input fields
    const sinceValue = filter?.since ? this._formatDateForInput(filter.since) : '';
    const untilValue = filter?.until ? this._formatDateForInput(filter.until) : '';

    return `
      <div class="log-filter-bar" id="log-filter-bar" ${hasActiveFilters ? '' : 'hidden'}>
        <div class="log-filter-row">
          <div class="log-filter-group">
            <label for="filter-search" class="log-filter-label">Search:</label>
            <input 
              type="text" 
              id="filter-search" 
              class="log-filter-input" 
              placeholder="Search commits..."
              value="${this._escapeHtml(filter?.searchText || '')}"
              onkeyup="handleFilterSearchKeyup(event)"
              aria-label="Search commit messages and content"
            />
          </div>
          <div class="log-filter-group">
            <label for="filter-author" class="log-filter-label">Author:</label>
            <input 
              type="text" 
              id="filter-author" 
              class="log-filter-input" 
              placeholder="Author name or email"
              value="${this._escapeHtml(filter?.author || '')}"
              onkeyup="handleFilterKeyup(event)"
              aria-label="Filter by author"
            />
          </div>
        </div>
        <div class="log-filter-row">
          <div class="log-filter-group">
            <label for="filter-path" class="log-filter-label">Path:</label>
            <input 
              type="text" 
              id="filter-path" 
              class="log-filter-input" 
              placeholder="File or directory path"
              value="${this._escapeHtml(filter?.path || '')}"
              onkeyup="handleFilterKeyup(event)"
              aria-label="Filter by file path"
            />
          </div>
          <div class="log-filter-group log-filter-group-date">
            <label for="filter-since" class="log-filter-label">From:</label>
            <input 
              type="date" 
              id="filter-since" 
              class="log-filter-input log-filter-date" 
              value="${sinceValue}"
              onchange="applyLogFilters()"
              aria-label="Filter commits from date"
            />
          </div>
          <div class="log-filter-group log-filter-group-date">
            <label for="filter-until" class="log-filter-label">To:</label>
            <input 
              type="date" 
              id="filter-until" 
              class="log-filter-input log-filter-date" 
              value="${untilValue}"
              onchange="applyLogFilters()"
              aria-label="Filter commits until date"
            />
          </div>
        </div>
        <div class="log-filter-actions">
          <button class="log-filter-button log-filter-apply" onclick="applyLogFilters()" title="Apply Filters">
            Apply
          </button>
          <button class="log-filter-button log-filter-clear" onclick="clearLogFilters()" title="Clear All Filters" ${hasActiveFilters ? '' : 'disabled'}>
            Clear
          </button>
        </div>
      </div>
    `;
  }

  /**
   * Format a Date object for HTML date input (YYYY-MM-DD)
   */
  private _formatDateForInput(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /**
   * Get HTML for a single commit row with graph visualization
   * Requirement 9.1: Graph visualization
   * Requirement 9.2: Commit hash, author, date, message, branch/tag labels
   */
  private _getCommitRowHtml(
    node: ICommitNode,
    index: number,
    selectedCommits: Set<string>,
    expandedCommit?: string,
    activeLanes?: Set<number>,
    config?: IGraphRenderConfig
  ): string {
    const commit = node.commit;
    const isSelected = selectedCommits.has(commit.hash);
    const isExpanded = expandedCommit === commit.hash;

    // Generate graph SVG using the new renderer
    const graphSvg = renderGraphSvg(
      node,
      index,
      activeLanes || new Set([node.graphColumn]),
      config || DEFAULT_GRAPH_CONFIG
    );

    // Format date
    const relativeDate = this._formatRelativeDate(commit.authorDate);

    // Branch and tag labels
    const labelsHtml = this._getCommitLabelsHtml(node);

    return `
      <div class="commit-row ${isSelected ? 'selected' : ''} ${isExpanded ? 'expanded' : ''}"
           data-hash="${commit.hash}"
           onclick="selectCommit('${commit.hash}')"
           oncontextmenu="showLogContextMenu(event, '${commit.hash}')"
           role="option"
           tabindex="0"
           aria-selected="${isSelected}"
           onkeydown="handleCommitKeydown(event, '${commit.hash}')">
        <div class="commit-graph">
          ${graphSvg}
        </div>
        <div class="commit-info">
          <div class="commit-header">
            <span class="commit-hash" title="${commit.hash}">${commit.shortHash}</span>
            ${labelsHtml}
            <span class="commit-message" title="${this._escapeHtml(commit.message)}">${this._escapeHtml(this._truncateMessage(commit.message, 60))}</span>
          </div>
          <div class="commit-meta">
            <span class="commit-author" title="${this._escapeHtml(commit.author.email)}">${this._escapeHtml(commit.author.name)}</span>
            <span class="commit-date" title="${commit.authorDate.toLocaleString()}">${relativeDate}</span>
          </div>
        </div>
      </div>
    `;
  }



  /**
   * Get HTML for branch and tag labels on a commit
   * Requirement 9.2: Branch/tag labels
   */
  private _getCommitLabelsHtml(node: ICommitNode): string {
    let html = '';

    // Branch labels
    for (const branch of node.branches) {
      const isHead = branch === 'HEAD' || branch.endsWith('/HEAD');
      html += `<span class="commit-label branch-label ${isHead ? 'head-label' : ''}" title="Branch: ${this._escapeHtml(branch)}">${this._escapeHtml(branch)}</span>`;
    }

    // Tag labels
    for (const tag of node.tags) {
      html += `<span class="commit-label tag-label" title="Tag: ${this._escapeHtml(tag)}">${this._escapeHtml(tag)}</span>`;
    }

    return html;
  }

  /**
   * Get HTML for commit details panel
   * Requirement 9.3: Full commit details including changed files
   */
  private _getCommitDetailsHtml(node: ICommitNode): string {
    const commit = node.commit;

    return `
      <div class="commit-details">
        <div class="commit-details-header">
          <h3>Commit Details</h3>
          <button class="close-details-button" onclick="closeCommitDetails()" title="Close">×</button>
        </div>
        <div class="commit-details-content">
          <div class="detail-row">
            <span class="detail-label">Hash:</span>
            <span class="detail-value hash-value" onclick="copyToClipboard('${commit.hash}')" title="Click to copy">${commit.hash}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Author:</span>
            <span class="detail-value">${this._escapeHtml(commit.author.name)} &lt;${this._escapeHtml(commit.author.email)}&gt;</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Date:</span>
            <span class="detail-value">${commit.authorDate.toLocaleString()}</span>
          </div>
          ${
            commit.parents.length > 0
              ? `
          <div class="detail-row">
            <span class="detail-label">Parents:</span>
            <span class="detail-value">${commit.parents.map((p) => `<span class="parent-hash" onclick="selectCommit('${p}')">${p.substring(0, 7)}</span>`).join(', ')}</span>
          </div>
          `
              : ''
          }
          <div class="detail-row message-row">
            <span class="detail-label">Message:</span>
            <pre class="detail-value commit-full-message">${this._escapeHtml(commit.message)}${commit.body ? '\n\n' + this._escapeHtml(commit.body) : ''}</pre>
          </div>
          ${
            this._getCommitLabelsHtml(node)
              ? `
          <div class="detail-row">
            <span class="detail-label">Refs:</span>
            <span class="detail-value">${this._getCommitLabelsHtml(node)}</span>
          </div>
          `
              : ''
          }
          <div class="changed-files-section">
            <h4>Changed Files</h4>
            <div class="changed-files-list" id="changed-files-${commit.hash}">
              <p class="loading-message">Loading changed files...</p>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Get the context menu HTML for Log View
   * Requirement 9.5: Context menu on commits
   */
  private _getLogContextMenuHtml(): string {
    return `
      <div id="log-context-menu" class="context-menu" hidden>
        <div class="context-menu-item" data-action="showDiff">
          <span class="context-menu-icon">📄</span>
          Show Diff
        </div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" data-action="cherryPick">
          <span class="context-menu-icon">🍒</span>
          Cherry-pick
        </div>
        <div class="context-menu-item" data-action="revert">
          <span class="context-menu-icon">↩️</span>
          Revert Commit
        </div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" data-action="createBranch">
          <span class="context-menu-icon">🌿</span>
          Create Branch
        </div>
        <div class="context-menu-item" data-action="createTag">
          <span class="context-menu-icon">🏷️</span>
          Create Tag
        </div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item context-menu-danger" data-action="resetToHere">
          <span class="context-menu-icon">⚠️</span>
          Reset Current Branch to Here
        </div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" data-action="copyHash">
          <span class="context-menu-icon">📋</span>
          Copy Commit Hash
        </div>
      </div>
    `;
  }

  /**
   * Truncate message to specified length
   */
  private _truncateMessage(message: string, maxLength: number): string {
    // Get first line only
    const firstLine = message.split('\n')[0];
    if (firstLine.length <= maxLength) {
      return firstLine;
    }
    return firstLine.substring(0, maxLength - 3) + '...';
  }

  /**
   * Format date as relative time
   */
  private _formatRelativeDate(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);
    const diffWeeks = Math.floor(diffDays / 7);
    const diffMonths = Math.floor(diffDays / 30);
    const diffYears = Math.floor(diffDays / 365);

    if (diffSecs < 60) {
      return 'just now';
    } else if (diffMins < 60) {
      return `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
    } else if (diffHours < 24) {
      return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
    } else if (diffDays < 7) {
      return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
    } else if (diffWeeks < 4) {
      return `${diffWeeks} week${diffWeeks === 1 ? '' : 's'} ago`;
    } else if (diffMonths < 12) {
      return `${diffMonths} month${diffMonths === 1 ? '' : 's'} ago`;
    } else {
      return `${diffYears} year${diffYears === 1 ? '' : 's'} ago`;
    }
  }

  /**
   * Get the Console panel HTML
   */
  private _getConsolePanel(): string {
    const isActive = this._state.activeTab === 'console';
    const entries = this._state.consoleState.entries;

    let entriesHtml = '';
    if (entries.length === 0) {
      entriesHtml = '<p class="empty-message">No console output</p>';
    } else {
      entriesHtml = entries
        .map(
          (entry) => `
          <div class="console-entry ${entry.isError ? 'error' : ''}">
            <div class="console-timestamp">${this._formatTimestamp(entry.timestamp)}</div>
            <div class="console-command">$ ${this._escapeHtml(entry.command)}</div>
            <pre class="console-output">${this._escapeHtml(entry.output)}</pre>
            ${entry.exitCode !== undefined ? `<div class="console-exit-code">Exit code: ${entry.exitCode}</div>` : ''}
          </div>
        `
        )
        .join('');
    }

    return `
      <div 
        id="panel-console" 
        class="tab-panel ${isActive ? 'active' : ''}" 
        role="tabpanel"
        aria-labelledby="tab-console"
        ${isActive ? '' : 'hidden'}
      >
        <div class="console-toolbar">
          <button class="clear-console-button" onclick="clearConsole()" title="Clear Console">
            Clear
          </button>
        </div>
        <div class="console-content">
          ${entriesHtml}
        </div>
      </div>
    `;
  }

  /**
   * Get inline styles for the webview
   */
  private _getInlineStyles(): string {
    return `
      :root {
        --vscode-font-family: var(--vscode-editor-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif);
        --vscode-font-size: var(--vscode-editor-font-size, 13px);
        /* IntelliJ-style file status colors */
        --intellij-modified: #6897BB;
        --intellij-added: #629755;
        --intellij-deleted: #6C6C6C;
        --intellij-untracked: #CC7832;
        --intellij-ignored: #848504;
        --intellij-conflicted: #FF0000;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        padding: 0;
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        background-color: var(--vscode-sideBar-background);
      }

      .git-tool-window {
        display: flex;
        flex-direction: column;
        height: 100vh;
      }

      /* Tab Bar */
      .tab-bar {
        display: flex;
        border-bottom: 1px solid var(--vscode-panel-border);
        background-color: var(--vscode-tab-inactiveBackground);
      }

      .tab-button {
        padding: 8px 16px;
        border: none;
        background: transparent;
        color: var(--vscode-tab-inactiveForeground);
        cursor: pointer;
        font-size: var(--vscode-font-size);
        border-bottom: 2px solid transparent;
        transition: all 0.2s ease;
      }

      .tab-button:hover {
        background-color: var(--vscode-tab-hoverBackground);
        color: var(--vscode-tab-hoverForeground);
      }

      .tab-button:focus {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: -1px;
      }

      .tab-button.active {
        color: var(--vscode-tab-activeForeground);
        background-color: var(--vscode-tab-activeBackground);
        border-bottom-color: var(--vscode-tab-activeBorderTop, var(--vscode-focusBorder));
      }

      /* Tab Panels */
      .tab-panels {
        flex: 1;
        overflow: hidden;
      }

      .tab-panel {
        display: none;
        height: 100%;
        overflow: auto;
        padding: 0;
      }

      .tab-panel.active {
        display: flex;
        flex-direction: column;
      }

      /* No Repository Message */
      .no-repository {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        text-align: center;
        color: var(--vscode-descriptionForeground);
      }

      .init-repo-button {
        margin-top: 16px;
        padding: 8px 16px;
        background-color: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: none;
        border-radius: 2px;
        cursor: pointer;
      }

      .init-repo-button:hover {
        background-color: var(--vscode-button-hoverBackground);
      }

      .init-repo-button:focus {
        outline: 1px solid var(--vscode-focusBorder);
      }

      /* Local Changes Toolbar */
      .local-changes-toolbar {
        display: flex;
        justify-content: flex-end;
        padding: 4px 8px;
        border-bottom: 1px solid var(--vscode-panel-border);
        background-color: var(--vscode-sideBar-background);
      }

      .toolbar-button {
        padding: 4px 8px;
        background: transparent;
        color: var(--vscode-foreground);
        border: none;
        border-radius: 3px;
        cursor: pointer;
        font-size: 14px;
      }

      .toolbar-button:hover {
        background-color: var(--vscode-toolbar-hoverBackground);
      }

      /* Local Changes Content */
      .local-changes-content {
        flex: 1;
        overflow: auto;
        padding: 4px;
      }

      /* Changelist Styles */
      .changelist {
        margin-bottom: 4px;
        border-radius: 3px;
        transition: background-color 0.2s ease;
      }

      .changelist.drag-over {
        background-color: var(--vscode-list-dropBackground);
        outline: 2px dashed var(--vscode-focusBorder);
      }

      .changelist-header {
        display: flex;
        align-items: center;
        padding: 6px 8px;
        cursor: pointer;
        border-radius: 3px;
        user-select: none;
      }

      .changelist-header:hover {
        background-color: var(--vscode-list-hoverBackground);
      }

      .changelist-header:focus {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: -1px;
      }

      .expand-icon {
        width: 16px;
        font-size: 10px;
        color: var(--vscode-foreground);
        flex-shrink: 0;
      }

      .changelist-name {
        flex: 1;
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .file-count {
        color: var(--vscode-descriptionForeground);
        font-size: 0.9em;
        margin-left: 8px;
      }

      .default-badge {
        font-size: 10px;
        padding: 1px 4px;
        margin-left: 8px;
        background-color: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
        border-radius: 3px;
      }

      .changelist-files {
        margin-left: 8px;
        padding-left: 8px;
        border-left: 1px solid var(--vscode-panel-border);
      }

      /* File Item Styles - IntelliJ-style */
      .file-item {
        display: flex;
        align-items: center;
        padding: 3px 8px;
        cursor: pointer;
        border-radius: 3px;
        user-select: none;
        transition: background-color 0.1s ease;
      }

      .file-item:hover {
        background-color: var(--vscode-list-hoverBackground);
      }

      .file-item:focus {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: -1px;
      }

      .file-item.selected {
        background-color: var(--vscode-list-activeSelectionBackground);
        color: var(--vscode-list-activeSelectionForeground);
      }

      .file-item.dragging {
        opacity: 0.5;
      }

      .file-status {
        width: 16px;
        height: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        font-weight: bold;
        margin-right: 6px;
        flex-shrink: 0;
      }

      .file-path {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
      }

      .file-dir {
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        margin-left: 8px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 150px;
      }

      .staged-indicator {
        color: var(--intellij-added);
        margin-left: 4px;
        font-size: 10px;
      }

      /* Context Menu Styles */
      .context-menu {
        position: fixed;
        background-color: var(--vscode-menu-background);
        border: 1px solid var(--vscode-menu-border);
        border-radius: 4px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        min-width: 180px;
        z-index: 1000;
        padding: 4px 0;
      }

      .context-menu-item {
        display: flex;
        align-items: center;
        padding: 6px 12px;
        cursor: pointer;
        color: var(--vscode-menu-foreground);
        font-size: 13px;
      }

      .context-menu-item:hover {
        background-color: var(--vscode-menu-selectionBackground);
        color: var(--vscode-menu-selectionForeground);
      }

      .context-menu-item.context-menu-danger:hover {
        background-color: var(--vscode-inputValidation-errorBackground);
      }

      .context-menu-icon {
        width: 20px;
        margin-right: 8px;
        text-align: center;
        font-size: 12px;
      }

      .context-menu-arrow {
        margin-left: auto;
        font-size: 10px;
        color: var(--vscode-descriptionForeground);
      }

      .context-menu-separator {
        height: 1px;
        background-color: var(--vscode-menu-separatorBackground);
        margin: 4px 0;
      }

      .context-menu-submenu {
        position: relative;
      }

      /* Console Styles */
      .console-toolbar {
        display: flex;
        justify-content: flex-end;
        padding: 4px;
        border-bottom: 1px solid var(--vscode-panel-border);
      }

      .clear-console-button {
        padding: 4px 8px;
        background: transparent;
        color: var(--vscode-foreground);
        border: 1px solid var(--vscode-button-border, transparent);
        border-radius: 2px;
        cursor: pointer;
        font-size: 12px;
      }

      .clear-console-button:hover {
        background-color: var(--vscode-toolbar-hoverBackground);
      }

      .console-content {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 12px;
        padding: 8px;
      }

      .console-entry {
        padding: 8px;
        border-bottom: 1px solid var(--vscode-panel-border);
      }

      .console-entry.error {
        background-color: var(--vscode-inputValidation-errorBackground);
      }

      .console-timestamp {
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        margin-bottom: 4px;
      }

      .console-command {
        color: var(--vscode-terminal-ansiCyan);
        margin-bottom: 4px;
      }

      .console-output {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-all;
      }

      .console-exit-code {
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        margin-top: 4px;
      }

      /* Empty/Placeholder Messages */
      .empty-message, .placeholder-message {
        color: var(--vscode-descriptionForeground);
        text-align: center;
        padding: 16px;
      }

      /* Log View Styles - Requirement 17.5: IntelliJ-style log layout */
      .log-container {
        display: flex;
        flex-direction: column;
        height: 100%;
      }

      .log-toolbar {
        display: flex;
        justify-content: flex-end;
        padding: 4px 8px;
        border-bottom: 1px solid var(--vscode-panel-border);
        background-color: var(--vscode-sideBar-background);
        gap: 4px;
      }

      /* Log Filter Bar Styles - Requirement 9.6, 9.7 */
      .log-filter-bar {
        padding: 8px;
        background-color: var(--vscode-input-background);
        border-bottom: 1px solid var(--vscode-panel-border);
      }

      .log-filter-row {
        display: flex;
        gap: 12px;
        margin-bottom: 8px;
        flex-wrap: wrap;
      }

      .log-filter-row:last-of-type {
        margin-bottom: 0;
      }

      .log-filter-group {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-width: 120px;
      }

      .log-filter-group-date {
        flex: 0 0 auto;
        min-width: 130px;
      }

      .log-filter-label {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        margin-bottom: 2px;
        font-weight: 500;
      }

      .log-filter-input {
        padding: 4px 8px;
        border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
        border-radius: 3px;
        background-color: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        font-size: 12px;
        font-family: var(--vscode-font-family);
      }

      .log-filter-input:focus {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: -1px;
        border-color: var(--vscode-focusBorder);
      }

      .log-filter-input::placeholder {
        color: var(--vscode-input-placeholderForeground);
      }

      .log-filter-date {
        width: 130px;
      }

      .log-filter-actions {
        display: flex;
        gap: 8px;
        margin-top: 8px;
        justify-content: flex-end;
      }

      .log-filter-button {
        padding: 4px 12px;
        border: none;
        border-radius: 3px;
        font-size: 12px;
        cursor: pointer;
        transition: background-color 0.1s ease;
      }

      .log-filter-apply {
        background-color: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
      }

      .log-filter-apply:hover {
        background-color: var(--vscode-button-hoverBackground);
      }

      .log-filter-clear {
        background-color: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
      }

      .log-filter-clear:hover:not(:disabled) {
        background-color: var(--vscode-button-secondaryHoverBackground);
      }

      .log-filter-clear:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .log-filter-button:focus {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: 1px;
      }

      .log-split-view {
        display: flex;
        flex: 1;
        overflow: hidden;
      }

      .log-commit-list {
        flex: 1;
        overflow-y: auto;
        overflow-x: hidden;
        min-width: 300px;
      }

      .log-details-panel {
        width: 350px;
        border-left: 1px solid var(--vscode-panel-border);
        overflow-y: auto;
        background-color: var(--vscode-sideBar-background);
      }

      /* Commit Row Styles */
      .commit-row {
        display: flex;
        align-items: center;
        min-height: 32px;
        padding: 0 8px;
        cursor: pointer;
        border-bottom: 1px solid var(--vscode-panel-border);
        transition: background-color 0.1s ease;
      }

      .commit-row:hover {
        background-color: var(--vscode-list-hoverBackground);
      }

      .commit-row:focus {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: -1px;
      }

      .commit-row.selected {
        background-color: var(--vscode-list-activeSelectionBackground);
        color: var(--vscode-list-activeSelectionForeground);
      }

      .commit-row.expanded {
        background-color: var(--vscode-list-inactiveSelectionBackground);
      }

      /* Graph Styles */
      .commit-graph {
        flex-shrink: 0;
        width: var(--graph-width, 80px);
        height: 32px;
        overflow: hidden;
        display: flex;
        align-items: center;
      }

      .commit-graph svg {
        display: block;
      }

      .commit-graph:empty,
      .commit-graph[data-width="0"] {
        display: none;
      }

      .graph-svg {
        display: block;
      }

      /* Commit Info Styles */
      .commit-info {
        flex: 1;
        min-width: 0;
        overflow: hidden;
      }

      .commit-header {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 2px;
      }

      .commit-hash {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 11px;
        color: var(--vscode-textLink-foreground);
        flex-shrink: 0;
      }

      .commit-message {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
      }

      .commit-meta {
        display: flex;
        gap: 12px;
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
      }

      .commit-author {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 150px;
      }

      .commit-date {
        flex-shrink: 0;
      }

      /* Branch and Tag Labels */
      .commit-label {
        display: inline-block;
        padding: 1px 6px;
        border-radius: 3px;
        font-size: 10px;
        font-weight: 500;
        margin-right: 4px;
        flex-shrink: 0;
      }

      .branch-label {
        background-color: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
      }

      .branch-label.head-label {
        background-color: var(--vscode-gitDecoration-addedResourceForeground, #629755);
        color: white;
      }

      .tag-label {
        background-color: var(--vscode-gitDecoration-modifiedResourceForeground, #6897BB);
        color: white;
      }

      /* Commit Details Panel */
      .commit-details {
        padding: 12px;
      }

      .commit-details-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 12px;
        padding-bottom: 8px;
        border-bottom: 1px solid var(--vscode-panel-border);
      }

      .commit-details-header h3 {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
      }

      .close-details-button {
        background: transparent;
        border: none;
        color: var(--vscode-foreground);
        font-size: 18px;
        cursor: pointer;
        padding: 0 4px;
        line-height: 1;
      }

      .close-details-button:hover {
        color: var(--vscode-errorForeground);
      }

      .commit-details-content {
        font-size: 12px;
      }

      .detail-row {
        margin-bottom: 8px;
      }

      .detail-label {
        display: block;
        font-weight: 600;
        color: var(--vscode-descriptionForeground);
        margin-bottom: 2px;
      }

      .detail-value {
        display: block;
        word-break: break-all;
      }

      .hash-value {
        font-family: var(--vscode-editor-font-family, monospace);
        cursor: pointer;
        color: var(--vscode-textLink-foreground);
      }

      .hash-value:hover {
        text-decoration: underline;
      }

      .parent-hash {
        font-family: var(--vscode-editor-font-family, monospace);
        cursor: pointer;
        color: var(--vscode-textLink-foreground);
      }

      .parent-hash:hover {
        text-decoration: underline;
      }

      .commit-full-message {
        margin: 0;
        white-space: pre-wrap;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 12px;
        background-color: var(--vscode-textBlockQuote-background);
        padding: 8px;
        border-radius: 3px;
        max-height: 150px;
        overflow-y: auto;
      }

      .message-row {
        margin-top: 12px;
      }

      /* Changed Files Section */
      .changed-files-section {
        margin-top: 16px;
        padding-top: 12px;
        border-top: 1px solid var(--vscode-panel-border);
      }

      .changed-files-section h4 {
        margin: 0 0 8px 0;
        font-size: 12px;
        font-weight: 600;
      }

      .changed-files-list {
        max-height: 200px;
        overflow-y: auto;
      }

      .changed-file-item {
        display: flex;
        align-items: center;
        padding: 3px 4px;
        cursor: pointer;
        border-radius: 3px;
      }

      .changed-file-item:hover {
        background-color: var(--vscode-list-hoverBackground);
      }

      .changed-file-status {
        width: 16px;
        font-size: 11px;
        font-weight: bold;
        margin-right: 6px;
        flex-shrink: 0;
      }

      .changed-file-path {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
      }

      .loading-message {
        color: var(--vscode-descriptionForeground);
        font-style: italic;
        padding: 8px;
      }

      /* Drag and Drop Visual Feedback */
      .drag-ghost {
        position: fixed;
        pointer-events: none;
        z-index: 1001;
        background-color: var(--vscode-list-activeSelectionBackground);
        color: var(--vscode-list-activeSelectionForeground);
        padding: 4px 8px;
        border-radius: 3px;
        font-size: 12px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      }
    `;
  }

  /**
   * Get inline script for the webview
   */
  private _getInlineScript(): string {
    return `
      (function() {
        const vscode = acquireVsCodeApi();
        
        // State for drag and drop
        let draggedFiles = [];
        let contextMenuTarget = null;

        // Tab switching with keyboard support
        const tabButtons = document.querySelectorAll('.tab-button');
        tabButtons.forEach(button => {
          button.addEventListener('click', () => {
            const tab = button.dataset.tab;
            vscode.postMessage({ type: 'switchTab', tab });
          });

          // Keyboard navigation for tabs
          button.addEventListener('keydown', (e) => {
            const tabs = Array.from(tabButtons);
            const currentIndex = tabs.indexOf(button);
            let newIndex = currentIndex;

            switch (e.key) {
              case 'ArrowLeft':
                newIndex = currentIndex > 0 ? currentIndex - 1 : tabs.length - 1;
                e.preventDefault();
                break;
              case 'ArrowRight':
                newIndex = currentIndex < tabs.length - 1 ? currentIndex + 1 : 0;
                e.preventDefault();
                break;
              case 'Home':
                newIndex = 0;
                e.preventDefault();
                break;
              case 'End':
                newIndex = tabs.length - 1;
                e.preventDefault();
                break;
            }

            if (newIndex !== currentIndex) {
              tabs[newIndex].focus();
              tabs[newIndex].click();
            }
          });
        });

        // Handle state updates from extension
        window.addEventListener('message', event => {
          const message = event.data;
          if (message.type === 'stateUpdate') {
            updateUI(message.state);
          }
        });

        function updateUI(state) {
          // Update tab buttons
          tabButtons.forEach(button => {
            const isActive = button.dataset.tab === state.activeTab;
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-selected', isActive);
            button.setAttribute('tabindex', isActive ? '0' : '-1');
          });

          // Update tab panels
          document.querySelectorAll('.tab-panel').forEach(panel => {
            const panelTab = panel.id.replace('panel-', '');
            const isActive = panelTab === state.activeTab;
            panel.classList.toggle('active', isActive);
            panel.hidden = !isActive;
          });

          // Update graph width CSS custom property from log state
          if (state.logState && state.logState.graphWidth !== undefined) {
            const commitList = document.querySelector('.log-commit-list');
            if (commitList) {
              commitList.style.setProperty('--graph-width', state.logState.graphWidth + 'px');
            }
          }
        }

        // Hide context menu when clicking elsewhere
        document.addEventListener('click', (e) => {
          const contextMenu = document.getElementById('context-menu');
          if (contextMenu && !contextMenu.contains(e.target)) {
            contextMenu.hidden = true;
          }
        });

        // Handle context menu item clicks
        document.addEventListener('click', (e) => {
          const menuItem = e.target.closest('.context-menu-item');
          if (menuItem && contextMenuTarget) {
            const action = menuItem.dataset.action;
            if (action) {
              vscode.postMessage({
                type: 'contextAction',
                action: action,
                files: [contextMenuTarget]
              });
              document.getElementById('context-menu').hidden = true;
            }
          }
        });

        // Global functions for onclick handlers
        window.toggleChangelist = function(changelistId) {
          vscode.postMessage({ type: 'toggleChangelist', changelistId });
        };

        window.selectFile = function(path) {
          vscode.postMessage({ type: 'selectFile', path });
        };

        window.doubleClickFile = function(path) {
          vscode.postMessage({ type: 'doubleClickFile', path });
        };

        window.clearConsole = function() {
          vscode.postMessage({ type: 'clearConsole' });
        };

        window.initRepository = function() {
          vscode.postMessage({ type: 'initRepository' });
        };

        window.refreshLocalChanges = function() {
          vscode.postMessage({ type: 'refresh' });
        };

        window.refreshLog = function() {
          vscode.postMessage({ type: 'refresh' });
        };

        // Log Filter functions - Requirement 9.6, 9.7
        window.toggleLogFilters = function() {
          const filterBar = document.getElementById('log-filter-bar');
          if (filterBar) {
            filterBar.hidden = !filterBar.hidden;
          }
        };

        window.applyLogFilters = function() {
          const searchInput = document.getElementById('filter-search');
          const authorInput = document.getElementById('filter-author');
          const pathInput = document.getElementById('filter-path');
          const sinceInput = document.getElementById('filter-since');
          const untilInput = document.getElementById('filter-until');

          const filter = {
            searchText: searchInput ? searchInput.value.trim() : '',
            author: authorInput ? authorInput.value.trim() : '',
            path: pathInput ? pathInput.value.trim() : '',
            since: sinceInput && sinceInput.value ? sinceInput.value : null,
            until: untilInput && untilInput.value ? untilInput.value : null
          };

          vscode.postMessage({ 
            type: 'applyLogFilter', 
            filter: filter 
          });
        };

        window.clearLogFilters = function() {
          const searchInput = document.getElementById('filter-search');
          const authorInput = document.getElementById('filter-author');
          const pathInput = document.getElementById('filter-path');
          const sinceInput = document.getElementById('filter-since');
          const untilInput = document.getElementById('filter-until');

          if (searchInput) searchInput.value = '';
          if (authorInput) authorInput.value = '';
          if (pathInput) pathInput.value = '';
          if (sinceInput) sinceInput.value = '';
          if (untilInput) untilInput.value = '';

          vscode.postMessage({ 
            type: 'applyLogFilter', 
            filter: null 
          });
        };

        window.handleFilterKeyup = function(event) {
          // Apply filters on Enter key
          if (event.key === 'Enter') {
            applyLogFilters();
          }
        };

        window.handleFilterSearchKeyup = function(event) {
          // Apply filters on Enter key for search
          if (event.key === 'Enter') {
            applyLogFilters();
          }
        };

        // Log View functions
        window.selectCommit = function(hash) {
          vscode.postMessage({ type: 'selectCommit', commitHash: hash });
        };

        window.toggleCommitSelection = function(hash) {
          vscode.postMessage({ type: 'toggleCommitSelection', commitHash: hash });
        };

        window.closeCommitDetails = function() {
          // Clear selection to close details panel
          vscode.postMessage({ type: 'selectCommit', commitHash: '' });
        };

        window.copyToClipboard = function(text) {
          navigator.clipboard.writeText(text).then(() => {
            // Could show a notification here
          }).catch(err => {
            console.error('Failed to copy:', err);
          });
        };

        // Log context menu
        let logContextMenuTarget = null;

        window.showLogContextMenu = function(event, hash) {
          event.preventDefault();
          event.stopPropagation();
          
          logContextMenuTarget = hash;
          const contextMenu = document.getElementById('log-context-menu');
          if (contextMenu) {
            const x = event.clientX;
            const y = event.clientY;
            
            const menuWidth = 200;
            const menuHeight = 300;
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            
            const left = x + menuWidth > viewportWidth ? viewportWidth - menuWidth - 10 : x;
            const top = y + menuHeight > viewportHeight ? viewportHeight - menuHeight - 10 : y;
            
            contextMenu.style.left = left + 'px';
            contextMenu.style.top = top + 'px';
            contextMenu.hidden = false;
          }
        };

        // Handle log context menu item clicks
        document.addEventListener('click', (e) => {
          const logContextMenu = document.getElementById('log-context-menu');
          if (logContextMenu && !logContextMenu.contains(e.target)) {
            logContextMenu.hidden = true;
          }

          const menuItem = e.target.closest('#log-context-menu .context-menu-item');
          if (menuItem && logContextMenuTarget) {
            const action = menuItem.dataset.action;
            if (action) {
              vscode.postMessage({
                type: 'logContextAction',
                action: action,
                commitHashes: [logContextMenuTarget]
              });
              document.getElementById('log-context-menu').hidden = true;
            }
          }
        });

        // Keyboard handler for commits
        window.handleCommitKeydown = function(event, hash) {
          switch (event.key) {
            case 'Enter':
            case ' ':
              event.preventDefault();
              selectCommit(hash);
              break;
            case 'ContextMenu':
              event.preventDefault();
              showLogContextMenu(event, hash);
              break;
            case 'c':
              if (event.ctrlKey || event.metaKey) {
                event.preventDefault();
                copyToClipboard(hash);
              }
              break;
          }
        };

        // Context menu functions
        window.showContextMenu = function(event, path) {
          event.preventDefault();
          event.stopPropagation();
          
          contextMenuTarget = path;
          const contextMenu = document.getElementById('context-menu');
          if (contextMenu) {
            // Position the menu at the cursor
            const x = event.clientX;
            const y = event.clientY;
            
            // Ensure menu stays within viewport
            const menuWidth = 180;
            const menuHeight = 280;
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            
            const left = x + menuWidth > viewportWidth ? viewportWidth - menuWidth - 10 : x;
            const top = y + menuHeight > viewportHeight ? viewportHeight - menuHeight - 10 : y;
            
            contextMenu.style.left = left + 'px';
            contextMenu.style.top = top + 'px';
            contextMenu.hidden = false;
          }
        };

        // Drag and drop functions
        window.handleDragStart = function(event, path) {
          draggedFiles = [path];
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', path);
          event.target.classList.add('dragging');
          
          // Create custom drag image
          const dragGhost = document.createElement('div');
          dragGhost.className = 'drag-ghost';
          dragGhost.textContent = path.split('/').pop();
          document.body.appendChild(dragGhost);
          event.dataTransfer.setDragImage(dragGhost, 0, 0);
          
          // Remove ghost after drag starts
          setTimeout(() => {
            document.body.removeChild(dragGhost);
          }, 0);
        };

        window.handleDragEnd = function(event) {
          event.target.classList.remove('dragging');
          draggedFiles = [];
          
          // Remove drag-over class from all changelists
          document.querySelectorAll('.changelist').forEach(cl => {
            cl.classList.remove('drag-over');
          });
        };

        window.handleDragOver = function(event) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          
          const changelist = event.target.closest('.changelist');
          if (changelist) {
            changelist.classList.add('drag-over');
          }
        };

        window.handleDragLeave = function(event) {
          const changelist = event.target.closest('.changelist');
          if (changelist && !changelist.contains(event.relatedTarget)) {
            changelist.classList.remove('drag-over');
          }
        };

        window.handleDrop = function(event, targetChangelistId) {
          event.preventDefault();
          
          const changelist = event.target.closest('.changelist');
          if (changelist) {
            changelist.classList.remove('drag-over');
          }
          
          if (draggedFiles.length > 0) {
            vscode.postMessage({
              type: 'fileDrop',
              files: draggedFiles,
              targetChangelistId: targetChangelistId
            });
          }
          
          draggedFiles = [];
        };

        // Keyboard handlers
        window.handleChangelistKeydown = function(event, changelistId) {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggleChangelist(changelistId);
          }
        };

        window.handleFileKeydown = function(event, path) {
          switch (event.key) {
            case 'Enter':
              event.preventDefault();
              doubleClickFile(path);
              break;
            case ' ':
              event.preventDefault();
              selectFile(path);
              break;
            case 'ContextMenu':
              event.preventDefault();
              showContextMenu(event, path);
              break;
          }
        };
      })();
    `;
  }

  /**
   * Escape HTML special characters
   */
  private _escapeHtml(text: string): string {
    const htmlEscapes: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return text.replace(/[&<>"']/g, (char) => htmlEscapes[char]);
  }

  /**
   * Format timestamp for display
   */
  private _formatTimestamp(date: Date): string {
    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }
}

/**
 * Log filter from webview (with string dates)
 */
interface IWebviewLogFilter {
  searchText?: string;
  author?: string;
  path?: string;
  since?: string | null;
  until?: string | null;
}

/**
 * Message types from the webview
 */
interface IWebviewMessage {
  type: string;
  tab?: string;
  path?: string;
  changelistId?: string;
  commitHash?: string;
  commitHashes?: string[];
  action?: string;
  files?: string[];
  targetChangelistId?: string;
  filter?: IWebviewLogFilter | null;
}

/**
 * Type guard for valid tab values
 */
function isValidTab(tab: unknown): tab is GitToolWindowTab {
  return tab === 'local-changes' || tab === 'log' || tab === 'console';
}

/**
 * Generate a nonce for content security policy
 */
function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
