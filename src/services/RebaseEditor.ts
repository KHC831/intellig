/**
 * Rebase Editor implementation.
 * Provides a webview panel for interactive rebase operations.
 * Allows users to reorder commits, change actions, and execute the rebase.
 *
 * Requirements: 6.1, 6.2, 6.3
 */

import * as vscode from 'vscode';
import {
  IRebaseService,
  IRebaseSession,
  IRebaseCommit,
  IRebaseAction,
  RebaseAction,
} from './interfaces/IRebaseService';
import { IRepository } from './interfaces/IGitService';

/**
 * Options for opening the rebase editor
 */
export interface IRebaseEditorOptions {
  /** The commit/branch to rebase onto */
  onto: string;
}

/**
 * Result from the rebase editor
 */
export interface IRebaseEditorResult {
  /** Whether the rebase was executed */
  executed: boolean;
  /** Whether the rebase completed successfully */
  success?: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Message types from webview to extension
 */
interface IWebviewMessage {
  type: string;
  commits?: IRebaseCommit[];
  hash?: string;
  action?: RebaseAction;
  fromIndex?: number;
  toIndex?: number;
}

/**
 * Rebase Editor class.
 * Provides a webview panel for interactive rebase planning and execution.
 *
 * Requirements:
 * - 6.1: Display rebase editor showing commits to be rebased
 * - 6.2: Allow reordering commits via drag-and-drop
 * - 6.3: Support pick, reword, edit, squash, fixup, and drop operations
 */
export class RebaseEditor {
  private _panel: vscode.WebviewPanel | undefined;
  private _disposables: vscode.Disposable[] = [];
  private _rebaseService: IRebaseService;
  private _repository: IRepository | undefined;
  private _session: IRebaseSession | undefined;
  private _resolvePromise: ((result: IRebaseEditorResult) => void) | undefined;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    rebaseService: IRebaseService
  ) {
    this._rebaseService = rebaseService;
  }

  /**
   * Show the rebase editor.
   *
   * @param repository - The repository to rebase in
   * @param options - Editor options including the target to rebase onto
   * @returns Promise resolving to the editor result
   *
   * Requirement 6.1: Display rebase editor showing commits to be rebased
   */
  async show(repository: IRepository, options: IRebaseEditorOptions): Promise<IRebaseEditorResult> {
    this._repository = repository;

    try {
      // Start the interactive rebase session
      this._session = await this._rebaseService.startInteractiveRebase(repository, options.onto);

      if (!this._session || this._session.commits.length === 0) {
        void vscode.window.showWarningMessage('No commits to rebase');
        return { executed: false };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to start rebase: ${errorMessage}`);
      return { executed: false, error: errorMessage };
    }

    // Create or reveal the panel
    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.One);
    } else {
      this._panel = vscode.window.createWebviewPanel(
        'intellij-git.rebaseEditor',
        'Interactive Rebase',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [this._extensionUri],
        }
      );

      // Handle panel disposal
      this._panel.onDidDispose(
        () => {
          this._panel = undefined;
          this._dispose();
          if (this._resolvePromise) {
            this._resolvePromise({ executed: false });
            this._resolvePromise = undefined;
          }
        },
        null,
        this._disposables
      );

      // Handle messages from webview
      this._panel.webview.onDidReceiveMessage(
        (message: IWebviewMessage) => this._handleMessage(message),
        null,
        this._disposables
      );
    }

    // Update the webview content
    this._updateWebview();

    // Return a promise that resolves when the editor is closed
    return new Promise((resolve) => {
      this._resolvePromise = resolve;
    });
  }

  /**
   * Hide the rebase editor.
   */
  hide(): void {
    if (this._panel) {
      this._panel.dispose();
    }
  }

  /**
   * Handle messages from the webview.
   */
  private async _handleMessage(message: IWebviewMessage): Promise<void> {
    switch (message.type) {
      case 'execute':
        await this._handleExecute();
        break;
      case 'cancel':
        this._handleCancel();
        break;
      case 'updateAction':
        if (message.hash && message.action) {
          this._handleUpdateAction(message.hash, message.action);
        }
        break;
      case 'reorder':
        if (message.fromIndex !== undefined && message.toIndex !== undefined) {
          this._handleReorder(message.fromIndex, message.toIndex);
        }
        break;
      case 'updatePlan':
        if (message.commits) {
          this._handleUpdatePlan(message.commits);
        }
        break;
    }
  }

  /**
   * Handle execute rebase action.
   */
  private async _handleExecute(): Promise<void> {
    if (!this._repository || !this._session) {
      return;
    }

    try {
      // Update the plan with current commits
      const plan: IRebaseAction[] = this._session.commits.map((commit) => ({
        hash: commit.hash,
        action: commit.action,
      }));

      this._rebaseService.updateRebasePlan(this._repository, plan);

      // Execute the rebase
      const result = await this._rebaseService.executeRebase(this._repository);

      if (result.success) {
        if (result.status === 'completed') {
          void vscode.window.showInformationMessage('Rebase completed successfully');
          if (this._resolvePromise) {
            this._resolvePromise({ executed: true, success: true });
            this._resolvePromise = undefined;
          }
          this.hide();
        } else if (result.status === 'paused') {
          void vscode.window.showInformationMessage(
            'Rebase paused. Use the Rebase Progress panel to continue.'
          );
          if (this._resolvePromise) {
            this._resolvePromise({ executed: true, success: true });
            this._resolvePromise = undefined;
          }
          this.hide();
        } else if (result.status === 'conflict') {
          void vscode.window.showWarningMessage(
            `Rebase has conflicts in: ${result.conflictedFiles?.join(', ')}`
          );
          if (this._resolvePromise) {
            this._resolvePromise({ executed: true, success: false, error: 'Conflicts detected' });
            this._resolvePromise = undefined;
          }
          this.hide();
        }
      } else {
        if (result.status === 'conflict') {
          void vscode.window.showWarningMessage(
            `Rebase has conflicts in: ${result.conflictedFiles?.join(', ')}`
          );
        } else {
          void vscode.window.showErrorMessage('Rebase failed');
        }
        if (this._resolvePromise) {
          this._resolvePromise({ executed: true, success: false });
          this._resolvePromise = undefined;
        }
        this.hide();
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Rebase failed: ${errorMessage}`);
      if (this._resolvePromise) {
        this._resolvePromise({ executed: true, success: false, error: errorMessage });
        this._resolvePromise = undefined;
      }
    }
  }

  /**
   * Handle cancel action.
   */
  private _handleCancel(): void {
    if (this._resolvePromise) {
      this._resolvePromise({ executed: false });
      this._resolvePromise = undefined;
    }
    this.hide();
  }

  /**
   * Handle updating a commit's action.
   *
   * Requirement 6.3: Support pick, reword, edit, squash, fixup, and drop operations
   */
  private _handleUpdateAction(hash: string, action: RebaseAction): void {
    if (!this._session) {
      return;
    }

    const commit = this._session.commits.find((c) => c.hash === hash);
    if (commit) {
      commit.action = action;
      this._updateWebview();
    }
  }

  /**
   * Handle reordering commits via drag-and-drop.
   *
   * Requirement 6.2: Allow reordering commits via drag-and-drop
   */
  private _handleReorder(fromIndex: number, toIndex: number): void {
    if (!this._session) {
      return;
    }

    const commits = [...this._session.commits];
    const [removed] = commits.splice(fromIndex, 1);
    commits.splice(toIndex, 0, removed);
    this._session.commits = commits;
    this._updateWebview();
  }

  /**
   * Handle updating the entire plan from the webview.
   */
  private _handleUpdatePlan(commits: IRebaseCommit[]): void {
    if (!this._session) {
      return;
    }

    this._session.commits = commits;
  }

  /**
   * Update the webview content.
   */
  private _updateWebview(): void {
    if (!this._panel) {
      return;
    }

    this._panel.webview.html = this._getHtmlContent(this._panel.webview);
  }

  /**
   * Get the HTML content for the webview.
   */
  private _getHtmlContent(webview: vscode.Webview): string {
    const nonce = this._getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Interactive Rebase</title>
  <style>
    ${this._getStyles()}
  </style>
</head>
<body>
  <div class="rebase-editor">
    ${this._getHeaderSection()}
    ${this._getCommitListSection()}
    ${this._getFooterSection()}
  </div>
  <script nonce="${nonce}">
    ${this._getScript()}
  </script>
</body>
</html>`;
  }

  /**
   * Get the header section HTML.
   */
  private _getHeaderSection(): string {
    const onto = this._session?.onto || '';
    const originalBranch = this._session?.originalBranch || '';
    const commitCount = this._session?.commits.length || 0;

    return `
      <div class="header">
        <h2>Interactive Rebase</h2>
        <div class="rebase-info">
          <span class="info-item">
            <span class="info-label">Rebasing:</span>
            <span class="info-value">${this._escapeHtml(originalBranch)}</span>
          </span>
          <span class="info-item">
            <span class="info-label">Onto:</span>
            <span class="info-value">${this._escapeHtml(onto)}</span>
          </span>
          <span class="info-item">
            <span class="info-label">Commits:</span>
            <span class="info-value">${commitCount}</span>
          </span>
        </div>
        <div class="instructions">
          <p>Drag commits to reorder. Select an action for each commit.</p>
          <p class="hint">Commits will be applied from top to bottom.</p>
        </div>
      </div>
    `;
  }

  /**
   * Get the commit list section HTML.
   *
   * Requirement 6.1: Display commits to be rebased
   * Requirement 6.2: Drag-and-drop reordering
   * Requirement 6.3: Action dropdown for each commit
   */
  private _getCommitListSection(): string {
    if (!this._session || this._session.commits.length === 0) {
      return `
        <div class="commit-list empty">
          <p class="empty-message">No commits to rebase</p>
        </div>
      `;
    }

    const commitsHtml = this._session.commits
      .map((commit, index) => this._getCommitItemHtml(commit, index))
      .join('');

    return `
      <div class="commit-list" id="commit-list">
        ${commitsHtml}
      </div>
    `;
  }

  /**
   * Get HTML for a single commit item.
   */
  private _getCommitItemHtml(commit: IRebaseCommit, index: number): string {
    const shortHash = commit.hash.substring(0, 7);
    const actionClass = this._getActionClass(commit.action);

    return `
      <div class="commit-item ${actionClass}" 
           data-hash="${commit.hash}" 
           data-index="${index}"
           draggable="true">
        <div class="drag-handle" title="Drag to reorder">⋮⋮</div>
        <div class="action-selector">
          <select class="action-dropdown" 
                  data-hash="${commit.hash}"
                  onchange="updateAction('${commit.hash}', this.value)">
            ${this._getActionOptions(commit.action)}
          </select>
        </div>
        <div class="commit-hash" title="${commit.hash}">${shortHash}</div>
        <div class="commit-message" title="${this._escapeHtml(commit.message)}">
          ${this._escapeHtml(commit.message)}
        </div>
      </div>
    `;
  }

  /**
   * Get the action options HTML for the dropdown.
   *
   * Requirement 6.3: Support pick, reword, edit, squash, fixup, and drop operations
   */
  private _getActionOptions(currentAction: RebaseAction): string {
    const actions: { value: RebaseAction; label: string; description: string }[] = [
      { value: 'pick', label: 'pick', description: 'use commit' },
      { value: 'reword', label: 'reword', description: 'use commit, but edit the commit message' },
      { value: 'edit', label: 'edit', description: 'use commit, but stop for amending' },
      {
        value: 'squash',
        label: 'squash',
        description: 'use commit, but meld into previous commit',
      },
      {
        value: 'fixup',
        label: 'fixup',
        description: "like squash, but discard this commit's message",
      },
      { value: 'drop', label: 'drop', description: 'remove commit' },
    ];

    return actions
      .map(
        (action) =>
          `<option value="${action.value}" ${action.value === currentAction ? 'selected' : ''} title="${action.description}">${action.label}</option>`
      )
      .join('');
  }

  /**
   * Get CSS class for an action.
   */
  private _getActionClass(action: RebaseAction): string {
    return `action-${action}`;
  }

  /**
   * Get the footer section HTML.
   */
  private _getFooterSection(): string {
    return `
      <div class="footer">
        <div class="action-legend">
          <span class="legend-item pick">pick - use commit</span>
          <span class="legend-item reword">reword - edit message</span>
          <span class="legend-item edit">edit - stop for amending</span>
          <span class="legend-item squash">squash - meld into previous</span>
          <span class="legend-item fixup">fixup - meld, discard message</span>
          <span class="legend-item drop">drop - remove commit</span>
        </div>
        <div class="button-row">
          <button class="button cancel-button" onclick="cancel()">Cancel</button>
          <button class="button execute-button" onclick="execute()">Start Rebase</button>
        </div>
      </div>
    `;
  }

  /**
   * Get the CSS styles for the webview.
   */
  private _getStyles(): string {
    return `
      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }

      body {
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        background-color: var(--vscode-editor-background);
        padding: 16px;
        height: 100vh;
        display: flex;
        flex-direction: column;
      }

      .rebase-editor {
        display: flex;
        flex-direction: column;
        height: 100%;
        gap: 16px;
      }

      /* Header styles */
      .header {
        flex-shrink: 0;
      }

      .header h2 {
        margin-bottom: 12px;
        color: var(--vscode-foreground);
        font-size: 18px;
        font-weight: 600;
      }

      .rebase-info {
        display: flex;
        gap: 24px;
        margin-bottom: 12px;
        flex-wrap: wrap;
      }

      .info-item {
        display: flex;
        gap: 8px;
        align-items: center;
      }

      .info-label {
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
      }

      .info-value {
        color: var(--vscode-foreground);
        font-weight: 500;
        font-family: var(--vscode-editor-font-family);
        background-color: var(--vscode-badge-background);
        padding: 2px 8px;
        border-radius: 4px;
      }

      .instructions {
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
        line-height: 1.5;
      }

      .instructions .hint {
        font-style: italic;
        margin-top: 4px;
      }

      /* Commit list styles */
      .commit-list {
        flex: 1;
        overflow-y: auto;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 4px;
        background-color: var(--vscode-editor-background);
      }

      .commit-list.empty {
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .empty-message {
        color: var(--vscode-descriptionForeground);
        font-style: italic;
      }

      .commit-item {
        display: flex;
        align-items: center;
        padding: 8px 12px;
        border-bottom: 1px solid var(--vscode-panel-border);
        gap: 12px;
        transition: background-color 0.1s ease;
      }

      .commit-item:last-child {
        border-bottom: none;
      }

      .commit-item:hover {
        background-color: var(--vscode-list-hoverBackground);
      }

      .commit-item.dragging {
        opacity: 0.5;
        background-color: var(--vscode-list-activeSelectionBackground);
      }

      .commit-item.drag-over {
        border-top: 2px solid var(--vscode-focusBorder);
      }

      /* Action-specific styles */
      .commit-item.action-pick {
        border-left: 3px solid #4fc3f7;
      }

      .commit-item.action-reword {
        border-left: 3px solid #ffb74d;
      }

      .commit-item.action-edit {
        border-left: 3px solid #81c784;
      }

      .commit-item.action-squash {
        border-left: 3px solid #ba68c8;
      }

      .commit-item.action-fixup {
        border-left: 3px solid #9575cd;
      }

      .commit-item.action-drop {
        border-left: 3px solid #ef5350;
        opacity: 0.6;
        text-decoration: line-through;
      }

      .drag-handle {
        cursor: grab;
        color: var(--vscode-descriptionForeground);
        font-size: 14px;
        user-select: none;
        padding: 4px;
      }

      .drag-handle:active {
        cursor: grabbing;
      }

      .action-selector {
        flex-shrink: 0;
      }

      .action-dropdown {
        padding: 4px 8px;
        border: 1px solid var(--vscode-dropdown-border);
        border-radius: 4px;
        background-color: var(--vscode-dropdown-background);
        color: var(--vscode-dropdown-foreground);
        font-family: var(--vscode-font-family);
        font-size: 12px;
        cursor: pointer;
        min-width: 80px;
      }

      .action-dropdown:focus {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: -1px;
      }

      .commit-hash {
        font-family: var(--vscode-editor-font-family);
        font-size: 12px;
        color: var(--vscode-textLink-foreground);
        flex-shrink: 0;
        min-width: 60px;
      }

      .commit-message {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
      }

      /* Footer styles */
      .footer {
        flex-shrink: 0;
      }

      .action-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-bottom: 16px;
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
      }

      .legend-item {
        display: flex;
        align-items: center;
        gap: 4px;
      }

      .legend-item::before {
        content: '';
        display: inline-block;
        width: 12px;
        height: 12px;
        border-radius: 2px;
      }

      .legend-item.pick::before {
        background-color: #4fc3f7;
      }

      .legend-item.reword::before {
        background-color: #ffb74d;
      }

      .legend-item.edit::before {
        background-color: #81c784;
      }

      .legend-item.squash::before {
        background-color: #ba68c8;
      }

      .legend-item.fixup::before {
        background-color: #9575cd;
      }

      .legend-item.drop::before {
        background-color: #ef5350;
      }

      .button-row {
        display: flex;
        justify-content: flex-end;
        gap: 12px;
      }

      .button {
        padding: 8px 16px;
        border: none;
        border-radius: 4px;
        font-family: var(--vscode-font-family);
        font-size: 13px;
        cursor: pointer;
        transition: background-color 0.1s ease;
      }

      .cancel-button {
        background-color: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
      }

      .cancel-button:hover {
        background-color: var(--vscode-button-secondaryHoverBackground);
      }

      .execute-button {
        background-color: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
      }

      .execute-button:hover {
        background-color: var(--vscode-button-hoverBackground);
      }

      .button:focus {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: 2px;
      }
    `;
  }

  /**
   * Get the JavaScript for the webview.
   */
  private _getScript(): string {
    return `
      const vscode = acquireVsCodeApi();
      let draggedElement = null;
      let draggedIndex = -1;

      // Initialize drag and drop
      document.addEventListener('DOMContentLoaded', () => {
        initDragAndDrop();
      });

      function initDragAndDrop() {
        const commitList = document.getElementById('commit-list');
        if (!commitList) return;

        const items = commitList.querySelectorAll('.commit-item');
        
        items.forEach((item, index) => {
          item.addEventListener('dragstart', handleDragStart);
          item.addEventListener('dragend', handleDragEnd);
          item.addEventListener('dragover', handleDragOver);
          item.addEventListener('dragenter', handleDragEnter);
          item.addEventListener('dragleave', handleDragLeave);
          item.addEventListener('drop', handleDrop);
        });
      }

      function handleDragStart(e) {
        draggedElement = e.target.closest('.commit-item');
        draggedIndex = parseInt(draggedElement.dataset.index);
        draggedElement.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', draggedIndex.toString());
      }

      function handleDragEnd(e) {
        if (draggedElement) {
          draggedElement.classList.remove('dragging');
        }
        document.querySelectorAll('.commit-item').forEach(item => {
          item.classList.remove('drag-over');
        });
        draggedElement = null;
        draggedIndex = -1;
      }

      function handleDragOver(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }

      function handleDragEnter(e) {
        e.preventDefault();
        const target = e.target.closest('.commit-item');
        if (target && target !== draggedElement) {
          target.classList.add('drag-over');
        }
      }

      function handleDragLeave(e) {
        const target = e.target.closest('.commit-item');
        if (target) {
          target.classList.remove('drag-over');
        }
      }

      function handleDrop(e) {
        e.preventDefault();
        const target = e.target.closest('.commit-item');
        if (!target || target === draggedElement) return;

        const toIndex = parseInt(target.dataset.index);
        
        if (draggedIndex !== -1 && toIndex !== draggedIndex) {
          vscode.postMessage({
            type: 'reorder',
            fromIndex: draggedIndex,
            toIndex: toIndex
          });
        }

        target.classList.remove('drag-over');
      }

      function updateAction(hash, action) {
        vscode.postMessage({
          type: 'updateAction',
          hash: hash,
          action: action
        });
      }

      function execute() {
        vscode.postMessage({ type: 'execute' });
      }

      function cancel() {
        vscode.postMessage({ type: 'cancel' });
      }

      // Initialize on load
      initDragAndDrop();
    `;
  }

  /**
   * Generate a nonce for content security policy.
   */
  private _getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  /**
   * Escape HTML special characters.
   */
  private _escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /**
   * Dispose of resources.
   */
  private _dispose(): void {
    for (const disposable of this._disposables) {
      disposable.dispose();
    }
    this._disposables = [];
    this._session = undefined;
    this._repository = undefined;
  }

  /**
   * Dispose of the editor.
   */
  dispose(): void {
    this.hide();
    this._dispose();
  }
}

/**
 * Create a new RebaseEditor instance.
 *
 * @param extensionUri - The extension URI for resource loading
 * @param rebaseService - The rebase service to use
 * @returns A new RebaseEditor instance
 */
export function createRebaseEditor(
  extensionUri: vscode.Uri,
  rebaseService: IRebaseService
): RebaseEditor {
  return new RebaseEditor(extensionUri, rebaseService);
}
