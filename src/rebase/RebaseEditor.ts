/**
 * Rebase Editor implementation.
 * Provides a webview panel for interactive rebase operations.
 * Allows users to reorder commits, change actions, and execute the rebase.
 */

import * as vscode from 'vscode';
import {
  IRebaseService,
  IRebaseSession,
  IRebaseCommit,
  IRebaseAction,
  IRebaseResult,
  RebaseAction,
} from '../git-core/interfaces/IRebaseService';
import { IRepository } from '../git-core/interfaces/IGitService';
import { generateNonce } from '../utils/webviewNonce';
import { sanitizeGitError } from '../git-core/gitError';
import { isRebaseAction } from '../git-core/rebaseTodo';

/**
 * Maximum length (in characters) for a rebase commit message accepted from
 * the webview. Defense-in-depth: the webview is untrusted input, so cap the
 * value before it reaches the git todo-file writer. 64 KiB is well above any
 * practical commit-message length; messages beyond this are silently truncated.
 */
export const MAX_REBASE_MESSAGE_LENGTH = 65536;

/**
 * Options for opening the rebase editor
 */
export interface IRebaseEditorOptions {
  /** The commit/branch to rebase onto */
  onto: string;
}

/**
 * Minimal surface of the Rebase Progress panel the editor needs: the ability
 * to reveal it when a rebase pauses (edit/reword) or is left mid-flight.
 * Kept as a structural type so the editor doesn't hard-depend on the concrete
 * RebaseProgressView (avoids a cyclic import and eases testing).
 */
export interface IRebasePausedView {
  show(repository: IRepository, conflictedFiles?: string[]): void;
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
  message?: string;
  fromIndex?: number;
  toIndex?: number;
}

/**
 * Rebase Editor class.
 * Provides a webview panel for interactive rebase planning and execution.
 *
 * - Display rebase editor showing commits to be rebased
 * - Allow reordering commits via drag-and-drop
 * - Support pick, reword, edit, squash, fixup, and drop operations
 */
export class RebaseEditor {
  private _panel: vscode.WebviewPanel | undefined;
  private _disposables: vscode.Disposable[] = [];
  private _rebaseService: IRebaseService;
  private _repository: IRepository | undefined;
  private _session: IRebaseSession | undefined;
  private _resolvePromise: ((result: IRebaseEditorResult) => void) | undefined;
  /**
   * True once the user commits to executing the rebase. Distinguishes a
   * normal completion (the service drives its own session lifecycle) from an
   * abandoned editor — a 'planning' session closed before execution, which we
   * must clear so it can't poison later branch ops.
   */
  private _executed = false;

  /**
   * False until the editor has painted once for the current rebase. Every
   * action change / reorder re-templates the whole webview; without this the
   * commit list would snap back to the top on each interaction. The first
   * render of a fresh rebase starts at the top (and drops any stale saved
   * scroll); every later render preserves the user's scroll position. Reset in
   * `show()` so a new rebase begins at the top again.
   */
  private _hasRendered = false;

  /**
   * Resolver for the Rebase Progress panel. A thunk (not a stored reference)
   * so a panel recreated after a deactivate/reactivate cycle is always the
   * live one at paused-time. Optional — when absent the editor degrades to a
   * toast-only paused message.
   */
  private _getProgressView: (() => IRebasePausedView | undefined) | undefined;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    rebaseService: IRebaseService,
    progressView?: IRebasePausedView | (() => IRebasePausedView | undefined)
  ) {
    this._rebaseService = rebaseService;
    if (typeof progressView === 'function') {
      this._getProgressView = progressView;
    } else if (progressView) {
      this._getProgressView = (): IRebasePausedView => progressView;
    }
  }

  /**
   * Show the rebase editor.
   *
   * @param repository - The repository to rebase in
   * @param options - Editor options including the target to rebase onto
   * @returns Promise resolving to the editor result
   */
  async show(repository: IRepository, options: IRebaseEditorOptions): Promise<IRebaseEditorResult> {
    this._repository = repository;
    // A fresh rebase must open at the top, not wherever the previous rebase's
    // list was left scrolled.
    this._hasRendered = false;

    try {
      // Start the interactive rebase session
      this._session = await this._rebaseService.startInteractiveRebase(repository, options.onto);

      if (!this._session || this._session.commits.length === 0) {
        void vscode.window.showWarningMessage('No commits to rebase');
        // This early return is before the panel + onDidDispose cleanup are
        // wired, so the planning session stored by startInteractiveRebase
        // (before any git ran) would leak and poison later branch ops. Clear
        // it on the way out.
        this._rebaseService.clearSession(repository);
        this._session = undefined;
        return { executed: false };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to start rebase: ${sanitizeGitError(errorMessage)}`
      );
      return { executed: false, error: errorMessage };
    }

    // Create or reveal the panel
    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.One);
    } else {
      this._panel = vscode.window.createWebviewPanel(
        'intellig.rebaseEditor',
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
          // The editor closed without executing — clear the abandoned planning
          // session so it can't poison later branch ops.
          this._clearAbandonedSession();
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
      case 'updateMessage':
        if (message.hash !== undefined && message.message !== undefined) {
          this._handleUpdateMessage(message.hash, message.message);
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

    // The user committed to running the rebase: from here the service owns the
    // session lifecycle (completion, pause, conflict). Closing the panel after
    // this must NOT clear the session as an abandonment.
    this._executed = true;

    try {
      // Update the plan with current commits
      const plan: IRebaseAction[] = this._session.commits.map((commit) => ({
        hash: commit.hash,
        action: commit.action,
        newMessage: commit.newMessage,
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
        } else {
          // 'paused' (edit/reword) or 'in-progress' (e.g. an inline-amend exec
          // failure left the rebase mid-flight). Both hand control to the
          // Rebase Progress panel so the user can continue/skip/abort. The
          // 'in-progress' arm in particular MUST resolve the promise: pre-fix
          // it fell through with no toast and never resolved, hanging the
          // RebaseDialog (`_busy` stuck) forever.
          this._getProgressView?.()?.show(this._repository);
          void vscode.window.showInformationMessage(
            'Rebase paused. Use the Rebase Progress panel to continue.'
          );
          if (this._resolvePromise) {
            this._resolvePromise({ executed: true, success: true });
            this._resolvePromise = undefined;
          }
          this.hide();
        }
      } else {
        if (result.status === 'conflict') {
          void vscode.window.showWarningMessage(this._conflictMessage(result));
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
      void vscode.window.showErrorMessage(`Rebase failed: ${sanitizeGitError(errorMessage)}`);
      if (this._resolvePromise) {
        this._resolvePromise({ executed: true, success: false, error: errorMessage });
        this._resolvePromise = undefined;
      }
    }
  }

  /**
   * Build the conflict warning toast, distinguishing a continuable mid-rebase
   * conflict from a terminal autostash-pop conflict (rebaseInProgress:false).
   * The latter has no rebase to continue or abort — the user resolves the
   * files and `git add`s them.
   */
  private _conflictMessage(result: IRebaseResult): string {
    const files = result.conflictedFiles?.join(', ') ?? '';
    if (result.rebaseInProgress === false) {
      return (
        `Rebase succeeded, but re-applying your stashed changes conflicted in: ${files}. ` +
        `Resolve them and \`git add\` them. Do not continue or abort — the rebase is already complete.`
      );
    }
    return `Rebase has conflicts in: ${files}`;
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
   */
  private _handleUpdateAction(hash: string, action: RebaseAction): void {
    if (!this._session) {
      return;
    }

    // The action arrives from the webview and is later emitted verbatim into
    // git's rebase todo; reject anything outside the six valid commands so a
    // forged `exec …` can't be injected. The hash is constrained below by
    // requiring it to match an existing session commit.
    if (!isRebaseAction(action)) {
      return;
    }

    const commit = this._session.commits.find((c) => c.hash === hash);
    if (commit) {
      commit.action = action;
      // Clear the pre-set message when switching to an action that can't carry
      // one inline, so stale overrides don't accidentally apply later. reword
      // and squash both collect a message inline (H1).
      if (action !== 'reword' && action !== 'squash') {
        commit.newMessage = undefined;
      }
      // No re-render: the webview updates the affected row in place (color
      // class + reword/squash message box). Rebuilding the whole document here
      // would reset the list scroll and tear down drag wiring for a one-row
      // change.
    }
  }

  private _handleUpdateMessage(hash: string, newMessage: string): void {
    if (!this._session) {
      return;
    }
    const commit = this._session.commits.find((c) => c.hash === hash);
    if (commit) {
      // Cap the message length before storing: the webview is untrusted input
      // and an unbounded string would be written verbatim to the todo file.
      commit.newMessage = newMessage.slice(0, MAX_REBASE_MESSAGE_LENGTH);
    }
  }

  /**
   * Handle reordering commits via drag-and-drop.
   */
  private _handleReorder(fromIndex: number, toIndex: number): void {
    if (!this._session) {
      return;
    }

    // Fail-closed: reject out-of-range or non-integer indices from the
    // (untrusted) webview — mirroring _handleUpdatePlan's posture.
    // splice() with a negative or non-integer index silently moves the
    // wrong element or inserts `undefined`, corrupting the plan.
    const len = this._session.commits.length;
    if (
      !Number.isInteger(fromIndex) ||
      fromIndex < 0 ||
      fromIndex >= len ||
      !Number.isInteger(toIndex) ||
      toIndex < 0 ||
      toIndex >= len
    ) {
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

    // The webview may only reorder, re-action, or re-message the commits it was
    // given — never introduce new hashes. Validate the incoming plan against
    // the known session hashes and the valid action set; reject the whole
    // update if anything is off so a forged hash (path-traversal sink) or a
    // forged action (todo-injection sink) can't reach git. Fail closed: keep
    // the prior plan rather than applying a partially-trusted one.
    if (!Array.isArray(commits)) {
      return;
    }
    const knownHashes = new Set(this._session.commits.map((c) => c.hash));
    const allValid = commits.every((c) => c && knownHashes.has(c.hash) && isRebaseAction(c.action));
    if (!allValid) {
      return;
    }

    // Require the plan to be a PERMUTATION of the known commit set: same
    // length and every known hash appears exactly once. A shorter plan drops
    // commits silently; a plan with duplicates would apply one commit twice and
    // skip another. Both pass the per-entry hash check above because all hashes
    // are in knownHashes, so a separate set-size check is needed.
    if (commits.length !== knownHashes.size) {
      return;
    }
    const planHashes = new Set(commits.map((c) => c.hash));
    if (planHashes.size !== knownHashes.size) {
      // Duplicate hashes: the Set collapses them, so the plan set is smaller.
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

    // Preserve scroll on every render but the first of this rebase (see
    // `_hasRendered`): action changes and reorders re-template the DOM and must
    // not yank the list back to the top.
    const preserveScroll = this._hasRendered;
    this._hasRendered = true;
    this._panel.webview.html = this._getHtmlContent(this._panel.webview, preserveScroll);
  }

  /**
   * Get the HTML content for the webview.
   */
  private _getHtmlContent(webview: vscode.Webview, preserveScroll = false): string {
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
  <div class="rebase-editor" id="rebase-root"></div>
  <script nonce="${nonce}">
    ${this._getScript(preserveScroll)}
  </script>
</body>
</html>`;
  }

  /**
   * Serialize the host-side rebase session into the JSON init island the
   * inline script reads to build the DOM. Every dynamic value reaches the DOM
   * via .value / .textContent / element props (injection-proof) — never markup.
   */
  private _getInitJson(preserveScroll = false): string {
    const ACTIONS: { value: RebaseAction; label: string; description: string }[] = [
      { value: 'pick', label: 'pick', description: 'use commit' },
      { value: 'reword', label: 'reword', description: 'use commit, but edit the commit message' },
      { value: 'edit', label: 'edit', description: 'use commit, but stop for amending' },
      {
        value: 'squash',
        label: 'squash',
        description: 'meld into the commit above (keeps both messages)',
      },
      {
        value: 'fixup',
        label: 'fixup',
        description: "meld into the commit above, discard this commit's message",
      },
      { value: 'drop', label: 'drop', description: 'remove commit' },
    ];
    // reword and squash both collect the message IN-UI (git4idea parity — we
    // never punt to an external editor). The rebase runs with GIT_EDITOR
    // suppressed, so a blank value does NOT open an editor: a blank reword
    // keeps the commit's original message; a blank squash takes git's
    // auto-combined message. The placeholders state that explicitly. Keyed by
    // action so both the initial build and the in-place action switch read the
    // same string (no drift).
    const placeholders: Partial<Record<RebaseAction, string>> = {
      reword: 'New commit message (leave blank to keep the original)',
      squash: 'Combined commit message (leave blank to auto-combine the messages)',
    };
    const commits = (this._session?.commits ?? []).map((commit) => {
      const showMessageEditor = commit.action === 'reword' || commit.action === 'squash';
      return {
        hash: commit.hash,
        shortHash: commit.hash.substring(0, 7),
        message: commit.message,
        action: commit.action,
        actionClass: `action-${commit.action}`,
        showMessageEditor,
        rewordValue: commit.newMessage ?? commit.message,
      };
    });
    return JSON.stringify({
      originalBranch: this._session?.originalBranch || '',
      onto: this._session?.onto || '',
      commitCount: this._session?.commits.length || 0,
      preserveScroll,
      placeholders,
      actions: ACTIONS,
      commits,
    }).replace(/</g, '\\u003c');
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
        flex-wrap: wrap;
      }

      .commit-item.action-edit {
        border-left: 3px solid #81c784;
      }

      .commit-item.action-squash {
        border-left: 3px solid #ba68c8;
        flex-wrap: wrap;
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

      .reword-message-editor {
        width: 100%;
        padding: 4px 0 4px 8px;
        box-sizing: border-box;
      }

      .reword-message-input {
        width: 100%;
        box-sizing: border-box;
        font-family: var(--vscode-editor-font-family);
        font-size: 12px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, var(--vscode-focusBorder));
        border-radius: 3px;
        padding: 4px 6px;
        resize: vertical;
        outline: none;
      }

      .reword-message-input:focus {
        border-color: var(--vscode-focusBorder);
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
  private _getScript(preserveScroll = false): string {
    return `
      const vscode = acquireVsCodeApi();
      const INIT = ${this._getInitJson(preserveScroll)};
      const el = (tag, props) => Object.assign(document.createElement(tag), props || {});

      // ── Build the body via createElement (no HTML-string injection) ────────
      (function buildBody() {
        const root = document.getElementById('rebase-root');
        if (!root) return;

        // Header
        const header = el('div', { className: 'header' });
        header.append(el('h2', { textContent: 'Interactive Rebase' }));
        const info = el('div', { className: 'rebase-info' });
        const infoItem = (label, value) => {
          const span = el('span', { className: 'info-item' });
          span.append(
            el('span', { className: 'info-label', textContent: label }),
            el('span', { className: 'info-value', textContent: String(value) })
          );
          return span;
        };
        info.append(
          infoItem('Rebasing:', INIT.originalBranch),
          infoItem('Onto:', INIT.onto),
          infoItem('Commits:', INIT.commitCount)
        );
        header.append(info);
        const instructions = el('div', { className: 'instructions' });
        instructions.append(
          el('p', { textContent: 'Drag commits to reorder. Select an action for each commit.' }),
          el('p', {
            className: 'hint',
            textContent:
              'Order: oldest at the top, newest at the bottom — commits are applied top to bottom.',
          }),
          el('p', {
            className: 'hint',
            textContent:
              'squash and fixup meld a commit into the one directly above it (the previous, older commit).',
          })
        );
        header.append(instructions);
        root.append(header);

        // Commit list
        if (INIT.commits.length === 0) {
          const empty = el('div', { className: 'commit-list empty' });
          empty.append(el('p', { className: 'empty-message', textContent: 'No commits to rebase' }));
          root.append(empty);
        } else {
          const list = el('div', { className: 'commit-list', id: 'commit-list' });
          INIT.commits.forEach((commit, index) => {
            const item = el('div', { className: 'commit-item ' + commit.actionClass, draggable: true });
            item.setAttribute('data-hash', commit.hash);
            item.setAttribute('data-index', String(index));
            item.append(el('div', { className: 'drag-handle', title: 'Drag to reorder', textContent: '⋮⋮' }));

            const selector = el('div', { className: 'action-selector' });
            const select = el('select', { className: 'action-dropdown' });
            select.setAttribute('data-hash', commit.hash);
            for (const a of INIT.actions) {
              const opt = el('option', { value: a.value, title: a.description, textContent: a.label });
              opt.selected = a.value === commit.action;
              select.append(opt);
            }
            selector.append(select);
            item.append(selector);

            const hashEl = el('div', { className: 'commit-hash', title: commit.hash, textContent: commit.shortHash });
            const msgEl = el('div', { className: 'commit-message', title: commit.message, textContent: commit.message });
            item.append(hashEl, msgEl);

            if (commit.showMessageEditor) {
              item.append(buildMessageEditor(commit.hash, commit.action, commit.rewordValue));
            }
            list.append(item);
          });
          root.append(list);
          wireScroll(list);
        }

        // Footer
        const footer = el('div', { className: 'footer' });
        const legend = el('div', { className: 'action-legend' });
        const LEGEND = [
          ['pick', 'pick - use commit'],
          ['reword', 'reword - edit message'],
          ['edit', 'edit - stop for amending'],
          ['squash', 'squash - meld into commit above'],
          ['fixup', 'fixup - meld into above, drop message'],
          ['drop', 'drop - remove commit'],
        ];
        for (const [cls, text] of LEGEND) {
          legend.append(el('span', { className: 'legend-item ' + cls, textContent: text }));
        }
        footer.append(legend);
        const buttonRow = el('div', { className: 'button-row' });
        const cancelBtn = el('button', { className: 'button cancel-button', textContent: 'Cancel' });
        cancelBtn.setAttribute('data-action', 'cancel');
        const executeBtn = el('button', { className: 'button execute-button', textContent: 'Start Rebase' });
        executeBtn.setAttribute('data-action', 'execute');
        buttonRow.append(cancelBtn, executeBtn);
        footer.append(buttonRow);
        root.append(footer);
      })();

      // Persist the commit-list scroll position and restore it across the full
      // re-renders the host does on every action change / reorder — otherwise a
      // selection near the bottom snaps the list back to the top. Scroll is
      // preserved by DEFAULT; the host clears INIT.preserveScroll only on the
      // first render of a fresh rebase, which starts at the top and drops any
      // stale saved position. Mirrors the Git tool window graph restore.
      function wireScroll(list) {
        if (!list || !vscode || typeof vscode.getState !== 'function') return;

        list.addEventListener('scroll', function () {
          const prev = vscode.getState() || {};
          prev.rebaseScrollTop = list.scrollTop;
          vscode.setState(prev);
        });

        if (!INIT.preserveScroll) {
          const prev = vscode.getState() || {};
          if (prev.rebaseScrollTop) {
            prev.rebaseScrollTop = 0;
            vscode.setState(prev);
          }
          return;
        }

        const saved = (vscode.getState() || {}).rebaseScrollTop;
        if (typeof saved !== 'number' || saved <= 0) return;
        // Apply now AND once on the next frame: the Electron webview can clamp a
        // synchronous scrollTop set before its first layout pass. Exactly one
        // retry (see the graph restore) — more would widen the window in which a
        // user's in-frame scroll gets clobbered back to the saved value.
        list.scrollTop = saved;
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(function () {
            list.scrollTop = saved;
          });
        }
      }

      // Build a reword/squash message box wired to post edits to the host. Used
      // by the initial render AND the in-place action switch so both produce an
      // identically-wired textarea (single wiring site — do NOT also wire these
      // in initControls, or newly-switched rows would double-post).
      function buildMessageEditor(hash, action, value) {
        const editor = el('div', { className: 'reword-message-editor' });
        const ta = el('textarea', {
          className: 'reword-message-input',
          rows: 3,
          placeholder: (INIT.placeholders && INIT.placeholders[action]) || '',
        });
        ta.setAttribute('data-hash', hash);
        ta.value = value;
        ta.addEventListener('input', function () { updateMessage(hash, ta.value); });
        editor.append(ta);
        return editor;
      }

      // Apply an action change to a single row in place: swap its color class
      // and show/hide the reword/squash message box. The host is notified
      // separately (updateAction) and does NOT re-render, so this is the only
      // thing that reflects the change visually.
      function applyActionToItem(item, hash, action) {
        if (!item) return;
        Array.from(item.classList).forEach(function (cls) {
          if (cls.indexOf('action-') === 0) item.classList.remove(cls);
        });
        item.classList.add('action-' + action);

        const showEditor = action === 'reword' || action === 'squash';
        const editor = item.querySelector('.reword-message-editor');
        if (showEditor && !editor) {
          // Fresh box: seed with the commit's original message — the host clears
          // any prior override when the action leaves reword/squash, so the
          // default here matches the host's (message, not the old edit).
          const orig = INIT.commits.find(function (c) { return c.hash === hash; });
          item.append(buildMessageEditor(hash, action, orig ? orig.message : ''));
        } else if (showEditor && editor) {
          // reword ⇄ squash: keep the typed text, just correct the placeholder.
          const ta = editor.querySelector('.reword-message-input');
          if (ta) ta.placeholder = (INIT.placeholders && INIT.placeholders[action]) || '';
        } else if (editor) {
          editor.remove();
        }
      }

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
        draggedIndex = parseInt(draggedElement.dataset.index, 10);
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

        const toIndex = parseInt(target.dataset.index, 10);
        
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

      function updateMessage(hash, newMessage) {
        vscode.postMessage({ type: 'updateMessage', hash: hash, message: newMessage });
      }

      function execute() {
        vscode.postMessage({ type: 'execute' });
      }

      function cancel() {
        vscode.postMessage({ type: 'cancel' });
      }

      // Wire the action dropdowns and footer buttons via addEventListener /
      // delegation. They were inline onchange/onclick attributes, which the
      // nonce-only CSP (no 'unsafe-inline') blocks — leaving the action selector
      // and Cancel / Start Rebase buttons dead. Reading the hash from data-hash
      // (DOM property channel) also removes the attribute quote-breakout footgun.
      // (Reword textareas wire their own input handler in buildMessageEditor.)
      function initControls() {
        document.querySelectorAll('.action-dropdown').forEach((sel) => {
          sel.addEventListener('change', () => {
            updateAction(sel.dataset.hash, sel.value);
            applyActionToItem(sel.closest('.commit-item'), sel.dataset.hash, sel.value);
          });
        });
        document.addEventListener('click', (e) => {
          const target = e.target.closest('[data-action]');
          if (!target) return;
          if (target.dataset.action === 'cancel') cancel();
          else if (target.dataset.action === 'execute') execute();
        });
      }

      // Initialize on load
      initDragAndDrop();
      initControls();
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
   * Clear a planning session abandoned by closing/cancelling the editor before
   * the rebase was executed. No-op once the rebase has been executed (the
   * service then owns the session lifecycle) or when there is no session.
   */
  private _clearAbandonedSession(): void {
    if (this._executed || !this._repository || !this._session) {
      return;
    }
    this._rebaseService.clearSession(this._repository);
    this._session = undefined;
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
  rebaseService: IRebaseService,
  progressView?: IRebasePausedView | (() => IRebasePausedView | undefined)
): RebaseEditor {
  return new RebaseEditor(extensionUri, rebaseService, progressView);
}
