/**
 * Rebase Progress View implementation.
 * Displays the current rebase progress during an active rebase operation.
 * Shows current step, conflict resolution prompts, and control buttons.
 */

import * as vscode from 'vscode';
import {
  IRebaseService,
  IRebaseSession,
  IRebaseResult,
  RebaseStatus,
} from '../git-core/interfaces/IRebaseService';
import { IRepository } from '../git-core/interfaces/IGitService';
import { generateNonce } from '../utils/webviewNonce';
import { buildWebviewCsp } from '../utils/webviewCsp';
import { sanitizeGitError } from '../git-core/gitError';
import { assertNever } from '../utils/assertNever';
import { dispatchGuardedWebviewMessage } from '../utils/webviewMessageGuard';
import {
  asRebaseProgressViewInbound,
  type IRebaseProgressDetail,
  type IRebaseProgressViewInit,
} from './rebaseProgressView.protocol';
import { initIslandHtml } from '../utils/webviewInit';

/**
 * Message types from webview to extension
 */

/**
 * Rebase Progress View class.
 * Provides a webview panel for monitoring and controlling an active rebase.
 *
 * - Continue rebase after resolving conflicts
 * - Abort rebase and restore original state
 * - Skip problematic commits
 */
export class RebaseProgressView implements vscode.Disposable {
  private _panel: vscode.WebviewPanel | undefined;
  private _disposables: vscode.Disposable[] = [];
  private _rebaseService: IRebaseService;
  private _repository: IRepository | undefined;
  private _session: IRebaseSession | undefined;
  private _conflictedFiles: string[] = [];
  /**
   * Whether the current conflict is continuable (a live rebase is in
   * progress). `false` for an `--autostash` pop conflict surfaced after the
   * rebase already completed, where continue/abort would dead-end on "no
   * rebase in progress". Defaults to `true` so externally-driven shows (which
   * arise from genuine mid-rebase conflicts) keep the continue/abort UI.
   */
  private _rebaseInProgress = true;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    rebaseService: IRebaseService
  ) {
    this._rebaseService = rebaseService;

    // Listen for rebase session changes
    this._disposables.push(
      this._rebaseService.onDidChangeRebaseSession((session) => {
        this._session = session;
        this._updateWebview();
      })
    );
  }

  /**
   * Show the rebase progress view.
   *
   * @param repository - The repository with an active rebase
   * @param conflictedFiles - Optional list of conflicted files
   */
  show(repository: IRepository, conflictedFiles?: string[]): void {
    this._repository = repository;
    this._session = this._rebaseService.getRebaseSession(repository);
    this._conflictedFiles = conflictedFiles || [];

    // Create or reveal the panel
    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.One);
    } else {
      this._panel = vscode.window.createWebviewPanel(
        'intellig.rebaseProgress',
        'Rebase Progress',
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
        },
        null,
        this._disposables
      );

      // Handle messages from webview. Standalone panel (no Base envelope), so
      // the guarded-dispatch wrapper is applied here directly.
      // typed-messages-exempt: permanently standalone — this view has a lazy,
      // re-showable lifecycle (creates its panel on show(), recreates after
      // dispose, and is an activation-time singleton), incompatible with
      // BaseWebviewPanel's eager one-shot constructor creation.
      this._panel.webview.onDidReceiveMessage(
        (message: unknown) =>
          dispatchGuardedWebviewMessage(() => this._handleMessage(message), {
            component: 'RebaseProgressView',
            rejectionLabel:
              'RebaseProgressView.onDidReceiveMessage: async _handleMessage rejection',
            syncThrowMessage: '_handleMessage threw synchronously',
          }),
        null,
        this._disposables
      );
    }

    // Update the webview content
    this._updateWebview();
  }

  /**
   * Hide the rebase progress view.
   */
  hide(): void {
    if (this._panel) {
      this._panel.dispose();
    }
  }

  /**
   * Update the conflicted files list.
   *
   * @param files - List of conflicted file paths
   */
  updateConflictedFiles(files: string[]): void {
    this._conflictedFiles = files;
    this._updateWebview();
  }

  /**
   * Refresh the view with the latest session state.
   */
  refresh(): void {
    if (this._repository) {
      this._session = this._rebaseService.getRebaseSession(this._repository);
      this._updateWebview();
    }
  }

  /**
   * Handle messages from the webview.
   */
  private async _handleMessage(raw: unknown): Promise<void> {
    if (!this._repository) {
      return;
    }
    const message = asRebaseProgressViewInbound(raw);
    if (!message) {
      return;
    }

    switch (message.type) {
      case 'continue':
        await this._handleContinue();
        break;
      case 'abort':
        await this._handleAbort();
        break;
      case 'skip':
        await this._handleSkip();
        break;
      case 'refresh':
        this.refresh();
        break;
      default:
        assertNever(message);
    }
  }

  /**
   * Handle continue rebase action.
   */
  private async _handleContinue(): Promise<void> {
    if (!this._repository) {
      return;
    }

    try {
      const result = await this._rebaseService.continueRebase(this._repository);
      this._handleRebaseResult(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to continue rebase: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * Handle abort rebase action.
   */
  private async _handleAbort(): Promise<void> {
    if (!this._repository) {
      return;
    }

    // Confirm abort with user
    const confirm = await vscode.window.showWarningMessage(
      'Are you sure you want to abort the rebase? This will restore the repository to its pre-rebase state.',
      { modal: true },
      'Abort Rebase'
    );

    if (confirm !== 'Abort Rebase') {
      return;
    }

    try {
      await this._rebaseService.abortRebase(this._repository);
      void vscode.window.showInformationMessage(
        'Rebase aborted. Repository restored to pre-rebase state.'
      );
      this.hide();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to abort rebase: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * Handle skip commit action.
   */
  private async _handleSkip(): Promise<void> {
    if (!this._repository) {
      return;
    }

    // Confirm skip with user
    const confirm = await vscode.window.showWarningMessage(
      'Are you sure you want to skip this commit? The changes from this commit will not be included.',
      { modal: true },
      'Skip Commit'
    );

    if (confirm !== 'Skip Commit') {
      return;
    }

    try {
      const result = await this._rebaseService.skipCommit(this._repository);
      this._handleRebaseResult(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to skip commit: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * Handle the result of a rebase operation.
   */
  private _handleRebaseResult(result: IRebaseResult): void {
    if (result.success) {
      if (result.status === 'completed') {
        void vscode.window.showInformationMessage('Rebase completed successfully!');
        this.hide();
      } else if (result.status === 'cleared-stale') {
        // The op found no live rebase and self-cleared a phantom (stale)
        // session — no commits were replayed. Report it honestly instead of
        // claiming the rebase completed.
        void vscode.window.showInformationMessage(
          'No rebase in progress — cleared a stale session.'
        );
        this.hide();
      } else if (result.status === 'paused') {
        void vscode.window.showInformationMessage('Rebase paused. Make your changes and continue.');
        this._updateWebview();
      } else if (result.status === 'in-progress') {
        this._updateWebview();
      }
    } else {
      if (result.status === 'conflict') {
        this._conflictedFiles = result.conflictedFiles || [];
        this._rebaseInProgress = result.rebaseInProgress !== false;
        if (this._rebaseInProgress) {
          void vscode.window.showWarningMessage(
            `Conflicts detected in: ${this._conflictedFiles.join(', ')}. Resolve conflicts and continue.`
          );
        } else {
          // Autostash pop conflict after the rebase already completed: there
          // is no rebase to continue or abort. Tell the user to resolve and
          // stage the files instead.
          void vscode.window.showWarningMessage(
            `Rebase succeeded, but re-applying your stashed changes conflicted in: ` +
              `${this._conflictedFiles.join(', ')}. Resolve them and \`git add\` them. ` +
              `Do not continue or abort — the rebase is already complete.`
          );
        }
        this._updateWebview();
      }
    }
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
    const bundleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'webview', 'rebaseProgressView.js')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${buildWebviewCsp(webview.cspSource, nonce, { images: false, fonts: false })}">
  <title>Rebase Progress</title>
  <style>
    ${this._getStyles()}
  </style>
</head>
<body>
  <div class="rebase-progress" id="progress-root"></div>
  ${initIslandHtml(this._getInit())}
  <script nonce="${nonce}" src="${bundleUri.toString()}"></script>
</body>
</html>`;
  }

  /**
   * Get human-readable status text.
   */
  private _getStatusText(status: RebaseStatus | 'unknown'): string {
    switch (status) {
      case 'planning':
        return 'Planning';
      case 'in-progress':
        return 'In Progress';
      case 'paused':
        return 'Paused';
      case 'conflict':
        return 'Conflicts Detected';
      case 'completed':
        return 'Completed';
      case 'cleared-stale':
        return 'Stale Session Cleared';
      default:
        return 'Unknown';
    }
  }

  /**
   * Get CSS class for status.
   */
  private _getStatusClass(status: RebaseStatus | 'unknown'): string {
    switch (status) {
      case 'in-progress':
        return 'status-progress';
      case 'paused':
        return 'status-paused';
      case 'conflict':
        return 'status-conflict';
      case 'completed':
        return 'status-completed';
      case 'cleared-stale':
        return 'status-completed';
      default:
        return 'status-unknown';
    }
  }

  /**
   * Build the host-side rebase progress state the bundled entry reads from the
   * body's `data-init` island to build the DOM. Every dynamic value reaches the
   * DOM via .textContent / element props (injection-proof) — never markup.
   */
  private _getInit(): IRebaseProgressViewInit {
    const status = this._session?.status || 'unknown';

    let progress: IRebaseProgressDetail | null = null;
    if (this._session) {
      const { commits, currentStep, onto, originalBranch } = this._session;
      const totalSteps = commits.length;
      const progressPercent = totalSteps > 0 ? Math.round((currentStep / totalSteps) * 100) : 0;
      const cc = commits[currentStep];
      progress = {
        originalBranch,
        onto,
        currentStep,
        totalSteps,
        progressPercent,
        currentCommit: cc
          ? { shortHash: cc.hash.substring(0, 7), action: cc.action, message: cc.message }
          : null,
        commits: commits.map((commit, index) => ({
          shortHash: commit.hash.substring(0, 7),
          action: commit.action,
          message: commit.message,
          statusIcon: index < currentStep ? '✓' : index === currentStep ? '▶' : '○',
          statusClass:
            index < currentStep ? 'completed' : index === currentStep ? 'current' : 'pending',
        })),
      };
    }

    const isConflict = status === 'conflict' || this._conflictedFiles.length > 0;
    const isPaused = status === 'paused';
    const isInProgress = status === 'in-progress';
    // A non-continuable conflict (autostash pop after the rebase completed)
    // has no live rebase, so continue/abort/skip would dead-end on "no rebase
    // in progress". Suppress those affordances — the user resolves and stages
    // the files instead.
    const continuable = this._rebaseInProgress;

    return {
      statusText: this._getStatusText(status),
      statusClass: this._getStatusClass(status),
      hasSession: !!this._session,
      progress,
      isConflict,
      conflictFiles: this._conflictedFiles,
      rebaseInProgress: this._rebaseInProgress,
      showContinue: (isConflict || isPaused) && continuable,
      showSkip: isConflict && continuable,
      showAbort: (isConflict || isPaused || isInProgress) && continuable,
    };
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
        overflow-y: auto;
      }

      .rebase-progress {
        display: flex;
        flex-direction: column;
        gap: 20px;
        max-width: 800px;
        margin: 0 auto;
      }

      /* Header styles */
      .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding-bottom: 12px;
        border-bottom: 1px solid var(--vscode-panel-border);
      }

      .header h2 {
        font-size: 18px;
        font-weight: 600;
        color: var(--vscode-foreground);
      }

      .status-badge {
        padding: 4px 12px;
        border-radius: 12px;
        font-size: 12px;
        font-weight: 500;
      }

      .status-progress {
        background-color: #4fc3f7;
        color: #000;
      }

      .status-paused {
        background-color: #ffb74d;
        color: #000;
      }

      .status-conflict {
        background-color: #ef5350;
        color: #fff;
      }

      .status-completed {
        background-color: #81c784;
        color: #000;
      }

      .status-unknown {
        background-color: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
      }

      /* Progress section styles */
      .progress-section {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }

      .no-session {
        color: var(--vscode-descriptionForeground);
        font-style: italic;
        text-align: center;
        padding: 20px;
      }

      .rebase-info {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 12px;
        background-color: var(--vscode-editor-inactiveSelectionBackground);
        border-radius: 4px;
      }

      .info-row {
        display: flex;
        gap: 8px;
        align-items: center;
      }

      .info-label {
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
        min-width: 80px;
      }

      .info-value {
        font-weight: 500;
      }

      .branch-name {
        font-family: var(--vscode-editor-font-family);
        background-color: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
        padding: 2px 8px;
        border-radius: 4px;
      }

      ${this._getStylesContinued()}
      ${this._getConflictAndActionStyles()}
    `;
  }

  /**
   * Get additional CSS styles (continued).
   */
  private _getStylesContinued(): string {
    return `
      /* Progress bar styles */
      .progress-bar-container {
        display: flex;
        align-items: center;
        gap: 12px;
      }

      .progress-label {
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
        min-width: 100px;
      }

      .progress-bar {
        flex: 1;
        height: 8px;
        background-color: var(--vscode-progressBar-background);
        border-radius: 4px;
        overflow: hidden;
      }

      .progress-fill {
        height: 100%;
        background-color: var(--vscode-progressBar-background);
        background-color: #4fc3f7;
        transition: width 0.3s ease;
      }

      .progress-percent {
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
        min-width: 40px;
        text-align: right;
      }

      /* Current commit styles */
      .current-commit {
        padding: 12px;
        background-color: var(--vscode-editor-selectionBackground);
        border-radius: 4px;
        border-left: 3px solid #4fc3f7;
      }

      .commit-label {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        margin-bottom: 4px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      .commit-info {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }

      .commit-hash {
        font-family: var(--vscode-editor-font-family);
        font-size: 12px;
        color: var(--vscode-textLink-foreground);
      }

      .commit-action {
        font-size: 11px;
        padding: 2px 6px;
        border-radius: 3px;
        font-weight: 500;
      }

      .action-pick { background-color: #4fc3f7; color: #000; }
      .action-reword { background-color: #ffb74d; color: #000; }
      .action-edit { background-color: #81c784; color: #000; }
      .action-squash { background-color: #ba68c8; color: #fff; }
      .action-fixup { background-color: #9575cd; color: #fff; }
      .action-drop { background-color: #ef5350; color: #fff; }

      .commit-message {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* Commits list styles */
      .commits-list {
        border: 1px solid var(--vscode-panel-border);
        border-radius: 4px;
        overflow: hidden;
      }

      .commits-header {
        padding: 8px 12px;
        background-color: var(--vscode-editor-inactiveSelectionBackground);
        font-size: 12px;
        font-weight: 500;
        border-bottom: 1px solid var(--vscode-panel-border);
      }

      .commit-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-bottom: 1px solid var(--vscode-panel-border);
      }

      .commit-item:last-child {
        border-bottom: none;
      }

      .commit-item.completed {
        opacity: 0.6;
      }

      .commit-item.current {
        background-color: var(--vscode-list-activeSelectionBackground);
      }

      .commit-item.pending {
        opacity: 0.8;
      }

      .commit-status {
        width: 16px;
        text-align: center;
        font-size: 12px;
      }

      .commit-item.completed .commit-status {
        color: #81c784;
      }

      .commit-item.current .commit-status {
        color: #4fc3f7;
      }

      .empty-commits {
        padding: 12px;
        color: var(--vscode-descriptionForeground);
        font-style: italic;
        text-align: center;
      }
    `;
  }

  /**
   * Get conflict and action section styles.
   */
  private _getConflictAndActionStyles(): string {
    return `
      /* Conflict section styles */
      .conflict-section {
        padding: 16px;
        background-color: rgba(239, 83, 80, 0.1);
        border: 1px solid #ef5350;
        border-radius: 4px;
      }

      .conflict-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 12px;
      }

      .conflict-warning-icon {
        font-size: 20px;
      }

      .conflict-title {
        font-size: 16px;
        font-weight: 600;
        color: #ef5350;
      }

      .conflict-instructions {
        margin-bottom: 12px;
        color: var(--vscode-foreground);
      }

      .conflict-files {
        margin-bottom: 16px;
      }

      .conflict-file {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 8px;
        background-color: var(--vscode-editor-background);
        border-radius: 4px;
        margin-bottom: 4px;
      }

      .conflict-icon {
        color: #ef5350;
      }

      .conflict-path {
        font-family: var(--vscode-editor-font-family);
        font-size: 13px;
      }

      .no-conflicts {
        color: var(--vscode-descriptionForeground);
        font-style: italic;
      }

      .conflict-help {
        font-size: 13px;
        line-height: 1.6;
      }

      .conflict-help ol {
        margin-left: 20px;
        margin-top: 8px;
        margin-bottom: 8px;
      }

      .conflict-help code {
        font-family: var(--vscode-editor-font-family);
        background-color: var(--vscode-textCodeBlock-background);
        padding: 2px 4px;
        border-radius: 3px;
      }

      /* Actions section styles */
      .actions-section {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding-top: 12px;
        border-top: 1px solid var(--vscode-panel-border);
      }

      .button-row {
        display: flex;
        justify-content: flex-end;
        gap: 12px;
      }

      .refresh-row {
        display: flex;
        justify-content: flex-start;
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

      .button:focus {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: 2px;
      }

      .continue-button {
        background-color: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
      }

      .continue-button:hover {
        background-color: var(--vscode-button-hoverBackground);
      }

      .abort-button {
        background-color: #ef5350;
        color: #fff;
      }

      .abort-button:hover {
        background-color: #e53935;
      }

      .skip-button {
        background-color: #ffb74d;
        color: #000;
      }

      .skip-button:hover {
        background-color: #ffa726;
      }

      .refresh-button {
        background-color: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
      }

      .refresh-button:hover {
        background-color: var(--vscode-button-secondaryHoverBackground);
      }
    `;
  }

  /**
   * Generate a nonce for content security policy. Delegates to the shared
   * CSPRNG-backed helper (`generateNonce`, base64url, 128-bit entropy) so
   * every IntelliG webview uses the same nonce strategy. Replaces a former
   * inline `Math.random()`-based generator so nonces are cryptographically
   * random instead of predictable.
   */
  private _getNonce(): string {
    return generateNonce();
  }

  /**
   * Dispose of resources.
   */
  dispose(): void {
    this.hide();
    for (const disposable of this._disposables) {
      disposable.dispose();
    }
    this._disposables = [];
    this._session = undefined;
    this._repository = undefined;
  }
}

/**
 * Create a new RebaseProgressView instance.
 *
 * @param extensionUri - The extension URI for resource loading
 * @param rebaseService - The rebase service to use
 * @returns A new RebaseProgressView instance
 */
export function createRebaseProgressView(
  extensionUri: vscode.Uri,
  rebaseService: IRebaseService
): RebaseProgressView {
  return new RebaseProgressView(extensionUri, rebaseService);
}
