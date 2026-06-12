/**
 * ResolveConflictsDialog — modal webview surfaced whenever a merge / rebase /
 * cherry-pick / revert / unshelve / unstash operation leaves the working tree
 * in a conflicted state.
 *
 * Layout (matches IntelliJ "Resolve Conflicts" dialog, see
 * INTELLIJ_REFERENCE.md §"Resolve Conflicts dialog"):
 *
 * ```
 * ┌ Resolve Conflicts — merge from 'feature/x' ─────────────┐
 * │  ⚠  path/a.ts    [Accept Yours][Accept Theirs][Merge…]  │
 * │  ✓  path/b.ts    resolved                               │
 * │                                                         │
 * │  [ Apply Non-Conflicting Changes from Both Sides ]      │
 * │                                                         │
 * │         [ Abort {Op} ]  [ Continue ]                    │
 * └─────────────────────────────────────────────────────────┘
 * ```
 *
 * Caller-invoked pattern (the caller wires `openResolveConflictsDialog`),
 * not event-based.
 */

import * as vscode from 'vscode';
import { BaseWebviewPanel } from '../utils/BaseWebviewPanel';
import { sanitizeGitError } from '../git-core/gitError';
import { IGitService, IRepository } from '../git-core/interfaces/IGitService';
import {
  IConflictResolutionService,
  IConflictedFile,
  IConflictOpContext,
} from './interfaces/IConflictResolutionService';
import { IMergeView } from './interfaces/IMergeView';

/**
 * Re-export for callers that prefer to import the op context from the dialog
 * module itself (the canonical home is the service interface).
 */
export { IConflictOpContext } from './interfaces/IConflictResolutionService';

/**
 * Status of a single file row in the dialog.
 */
export type ConflictFileStatus = 'unresolved' | 'resolved';

/**
 * Message protocol: webview → host.
 */
type IncomingMessage =
  | { type: 'acceptYours'; path: string }
  | { type: 'acceptTheirs'; path: string }
  | { type: 'openMergeView'; path: string }
  | { type: 'abort' }
  | { type: 'continue' }
  /** Skip This Commit — rebase-only; drops the conflicting commit. */
  | { type: 'skip' };

/**
 * Message protocol: host → webview.
 */
type OutgoingMessage =
  | { type: 'updateFileStatus'; path: string; status: ConflictFileStatus }
  | { type: 'closeDialog'; reason: 'completed' | 'aborted' | 'cancelled' };

/**
 * Human-readable label per operation — used for the title bar and the Abort
 * button. Matches the IntelliJ labels (see INTELLIJ_REFERENCE.md).
 */
const OP_LABELS: Record<IConflictOpContext['operation'], string> = {
  merge: 'Merge',
  rebase: 'Rebase',
  cherryPick: 'Cherry-Pick',
  revert: 'Revert',
  unshelve: 'Unshelve',
  unstash: 'Apply Stash',
  applyPatch: 'Apply Patch',
};

/**
 * Inline CSS for the Resolve Conflicts dialog. Mirrors the visual language of
 * existing IntelliG webviews (CommitDialog / RebaseEditor): VS Code theme
 * variables, subtle borders, IntelliJ-spec row layout.
 */
const STYLES = `
* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background-color: var(--vscode-editor-background);
  padding: 16px;
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.header {
  font-weight: bold;
  font-size: 14px;
  margin-bottom: 12px;
}

.file-list {
  flex: 1;
  overflow: auto;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  padding: 4px 0;
  margin-bottom: 12px;
}

.file-row {
  display: flex;
  align-items: center;
  padding: 6px 12px;
  gap: 8px;
  border-bottom: 1px solid var(--vscode-panel-border);
}
.file-row:last-child { border-bottom: none; }

.file-status {
  width: 16px;
  text-align: center;
  font-weight: bold;
}
.file-status.unresolved { color: var(--vscode-editorWarning-foreground); }
.file-status.resolved   { color: var(--vscode-testing-iconPassed, #89d185); }

.file-path {
  flex: 1;
  font-family: var(--vscode-editor-font-family);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-actions { display: flex; gap: 4px; }

.btn {
  padding: 4px 10px;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  border-radius: 2px;
  cursor: pointer;
  font-size: 12px;
}
.btn:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn.secondary {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}
.btn.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }

.bulk-row {
  padding: 8px 12px;
  margin-bottom: 12px;
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--vscode-panel-border);
}

.resolved-label {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  font-style: italic;
}
`;

/**
 * Escape HTML special characters for safe injection into element text/attrs.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Resolve Conflicts dialog.
 *
 * Construct with the list of conflict files produced by the git operation.
 * The dialog delegates per-file actions to `IConflictResolutionService` and
 * `IMergeView` — it does NOT duplicate conflict-mutation logic.
 */
export class ResolveConflictsDialog extends BaseWebviewPanel {
  private readonly _repo: IRepository;
  private readonly _opContext: IConflictOpContext;
  private readonly _conflictResolutionService: IConflictResolutionService;
  private readonly _mergeView: IMergeView;
  private readonly _gitService: IGitService;
  /** Mutable per-file status tracker. Keyed by the conflict file path. */
  private readonly _statuses: Map<string, ConflictFileStatus> = new Map();

  private _onDidClose: vscode.EventEmitter<'completed' | 'aborted' | 'cancelled'>;
  /** Fires once when the dialog finishes (completion, abort, or user close). */
  readonly onDidClose: vscode.Event<'completed' | 'aborted' | 'cancelled'>;

  constructor(
    context: vscode.ExtensionContext,
    repo: IRepository,
    conflicts: IConflictedFile[],
    opContext: IConflictOpContext,
    conflictResolutionService: IConflictResolutionService,
    mergeView: IMergeView,
    gitService: IGitService
  ) {
    super(
      context,
      'intellig.resolveConflictsDialog',
      `Resolve Conflicts — ${ResolveConflictsDialog.describeOp(opContext)}`
    );

    this._repo = repo;
    this._opContext = opContext;
    this._conflictResolutionService = conflictResolutionService;
    this._mergeView = mergeView;
    this._gitService = gitService;

    this._onDidClose = new vscode.EventEmitter();
    this.onDidClose = this._onDidClose.event;
    this._disposables.push(this._onDidClose);

    // Seed status map. Pre-resolved files preserve their state so reopening
    // the dialog after partial resolution reflects what the caller already did.
    for (const c of conflicts) {
      this._statuses.set(c.path, c.resolved ? 'resolved' : 'unresolved');
    }

    // Flip resolved rows whenever MergeView finishes a file. We filter by path
    // since MergeView is shared across invocations.
    this._disposables.push(
      this._mergeView.onDidResolve((filePath) => {
        this.updateFileStatus(filePath, 'resolved');
      })
    );

    this._render();
  }

  /**
   * Update an existing dialog with a newer conflict list (e.g. after
   * `cherry-pick --continue` surfaces the next commit's conflicts).
   */
  updateConflicts(conflicts: IConflictedFile[]): void {
    this._statuses.clear();
    for (const c of conflicts) {
      this._statuses.set(c.path, c.resolved ? 'resolved' : 'unresolved');
    }
    this._render();
  }

  /**
   * Update a single file's status and patch the DOM via postMessage. Caller
   * typically invokes this indirectly via the MergeView resolve event or the
   * per-row accept handlers.
   */
  updateFileStatus(path: string, status: ConflictFileStatus): void {
    if (!this._statuses.has(path)) {
      return;
    }
    this._statuses.set(path, status);
    void this.postMessage({ type: 'updateFileStatus', path, status } as OutgoingMessage);
  }

  /**
   * Return a snapshot of the current dialog file status map. Exposed for tests
   * and for the owning service to audit state.
   */
  getFileStatuses(): ReadonlyMap<string, ConflictFileStatus> {
    return new Map(this._statuses);
  }

  /**
   * Return the operation context. Exposed for tests.
   */
  getOpContext(): IConflictOpContext {
    return this._opContext;
  }

  /**
   * Whether all files are currently marked resolved.
   */
  allResolved(): boolean {
    if (this._statuses.size === 0) {
      // No conflict rows means the operation already completed (edge case).
      return true;
    }
    for (const status of this._statuses.values()) {
      if (status !== 'resolved') {
        return false;
      }
    }
    return true;
  }

  /**
   * Reveal (show) the dialog. Thin delegate over BaseWebviewPanel.reveal.
   */
  override reveal(): void {
    super.reveal();
  }

  protected override _getStyles(): string {
    return STYLES;
  }

  /**
   * BaseWebviewPanel auto-injects an empty nonce-sentinel script. Our dialog
   * needs an interactive script too, so we override `_render()` below to wrap
   * the body ourselves and splice the interactive script in with the same
   * nonce. `_getBodyHtml()` therefore emits only the body markup; the script
   * block is appended in `_render()`.
   */
  protected _getBodyHtml(): string {
    const title = ResolveConflictsDialog.describeOp(this._opContext);
    const opLabel = OP_LABELS[this._opContext.operation];
    const allResolved = this.allResolved();

    const rows = Array.from(this._statuses.entries())
      .map(([path, status]) => this._renderRow(path, status))
      .join('');

    const abortButton = this._opContext.canAbort
      ? `<button class="btn secondary" data-action="abort">Abort ${escapeHtml(opLabel)}</button>`
      : '';

    // Skip This Commit — only meaningful during a rebase. Sits between
    // Abort and Continue to match IntelliJ's Resolve Conflicts layout.
    const skipButton =
      this._opContext.operation === 'rebase'
        ? `<button class="btn secondary" data-action="skip" title="Drop the current commit and move on to the next one in the rebase sequence. The commit's changes will NOT be applied.">Skip This Commit</button>`
        : '';

    const continueButton = this._opContext.canContinue
      ? `<button class="btn" data-action="continue" ${allResolved ? '' : 'disabled'}>Continue</button>`
      : '';

    return `
      <div class="header">${escapeHtml(title)}</div>
      <div class="file-list" data-role="file-list">
        ${rows || '<div class="file-row"><span class="file-path">No conflicted files.</span></div>'}
      </div>
      <div class="bulk-row">
        Tip: use <strong>Merge…</strong> for per-file three-way review;
        <em>Apply Non-Conflicting Changes</em> will land in T2 (tracked).
      </div>
      <div class="footer">
        ${abortButton}
        ${skipButton}
        ${continueButton}
      </div>
    `;
  }

  /**
   * Override the base renderer so we can embed a real (non-sentinel) script
   * carrying the CSP nonce. The script handles click dispatch and incremental
   * DOM updates on host-originated postMessages.
   */
  protected override _render(): void {
    if (this._disposed) {
      return;
    }

    const nonce = this._getNonce();
    const csp = this._buildCsp(nonce);
    const styles = this._getStyles();
    const body = this._getBodyHtml();
    const title = `Resolve Conflicts — ${ResolveConflictsDialog.describeOp(this._opContext)}`;

    this._panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>${escapeHtml(title)}</title>
  <style>${styles}</style>
</head>
<body>
${body}
<script nonce="${nonce}">
(function() {
  const vscode = acquireVsCodeApi();

  function send(msg) { vscode.postMessage(msg); }

  document.addEventListener('click', function(e) {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    const action = t.getAttribute('data-action');
    if (!action) return;
    const path = t.getAttribute('data-path') || undefined;
    switch (action) {
      case 'acceptYours':
      case 'acceptTheirs':
      case 'openMergeView':
        if (path) send({ type: action, path: path });
        break;
      case 'abort':
      case 'continue':
      case 'skip':
        send({ type: action });
        break;
    }
  });

  window.addEventListener('message', function(event) {
    const msg = event.data;
    if (!msg) return;
    if (msg.type === 'updateFileStatus') {
      const row = document.querySelector('[data-row-path="' + CSS.escape(msg.path) + '"]');
      if (!row) return;
      const statusEl = row.querySelector('.file-status');
      if (statusEl) {
        statusEl.classList.remove('unresolved', 'resolved');
        statusEl.classList.add(msg.status);
        statusEl.textContent = msg.status === 'resolved' ? '✓' : '⚠';
      }
      const actionsEl = row.querySelector('.file-actions');
      if (actionsEl && msg.status === 'resolved') {
        actionsEl.innerHTML = '<span class="resolved-label">resolved</span>';
      }
      const rows = document.querySelectorAll('[data-row-path]');
      let allResolved = rows.length > 0;
      rows.forEach(function(r) {
        const s = r.querySelector('.file-status');
        if (!s || !s.classList.contains('resolved')) allResolved = false;
      });
      const continueBtn = document.querySelector('[data-action="continue"]');
      if (continueBtn) {
        if (allResolved) continueBtn.removeAttribute('disabled');
        else continueBtn.setAttribute('disabled', 'disabled');
      }
    }
  });
})();
</script>
</body>
</html>`;
  }

  /**
   * Render a single file row.
   */
  private _renderRow(path: string, status: ConflictFileStatus): string {
    const icon = status === 'resolved' ? '✓' : '⚠';
    const escapedPath = escapeHtml(path);

    const actions =
      status === 'resolved'
        ? '<span class="resolved-label">resolved</span>'
        : [
            `<button class="btn secondary" data-action="acceptYours" data-path="${escapedPath}">Accept Yours</button>`,
            `<button class="btn secondary" data-action="acceptTheirs" data-path="${escapedPath}">Accept Theirs</button>`,
            `<button class="btn" data-action="openMergeView" data-path="${escapedPath}">Merge…</button>`,
            // Visibly-disabled Apply Non-Conflicting stub. The tooltip
            // communicates the state so users don't keep clicking.
            `<button class="btn secondary disabled" data-action="applyAllNonConflicting" data-path="${escapedPath}" disabled aria-disabled="true" title="Landing in Tier-2 follow-up">Apply Non-Conflicting</button>`,
          ].join('');

    return `
      <div class="file-row" data-row-path="${escapedPath}">
        <span class="file-status ${status}">${icon}</span>
        <span class="file-path">${escapedPath}</span>
        <span class="file-actions">${actions}</span>
      </div>
    `;
  }

  /**
   * Handle incoming messages from the webview. Narrows the untyped payload to
   * the discriminated union, then delegates to the matching async handler.
   *
   * Exactly one handler runs per well-formed message (property-tested in
   * `resolveConflictsDialogRouter.property.test.ts`).
   */
  protected async _onMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') {
      return;
    }
    const msg = message as IncomingMessage;

    switch (msg.type) {
      case 'acceptYours':
        await this._handleAcceptYours(msg.path);
        break;
      case 'acceptTheirs':
        await this._handleAcceptTheirs(msg.path);
        break;
      case 'openMergeView':
        await this._handleOpenMergeView(msg.path);
        break;
      case 'abort':
        await this._handleAbort();
        break;
      case 'continue':
        await this._handleContinue();
        break;
      case 'skip':
        await this._handleSkip();
        break;
      default:
        // Unknown message — silently drop. The router property test confirms
        // no valid message reaches this branch.
        break;
    }
  }

  private async _handleAcceptYours(path: string): Promise<void> {
    const result = await this._conflictResolutionService.acceptCurrent(this._repo, path);
    if (result.success) {
      this.updateFileStatus(path, 'resolved');
    } else {
      // `result.error` may include git stderr which can embed credentials in
      // remote URLs — scrub before surfacing.
      void vscode.window.showErrorMessage(
        sanitizeGitError(result.error || `Failed to accept current version for ${path}`)
      );
    }
  }

  private async _handleAcceptTheirs(path: string): Promise<void> {
    const result = await this._conflictResolutionService.acceptIncoming(this._repo, path);
    if (result.success) {
      this.updateFileStatus(path, 'resolved');
    } else {
      // `result.error` may include git stderr which can embed credentials in
      // remote URLs — scrub before surfacing.
      void vscode.window.showErrorMessage(
        sanitizeGitError(result.error || `Failed to accept incoming version for ${path}`)
      );
    }
  }

  private async _handleOpenMergeView(path: string): Promise<void> {
    // MergeView.show expects an absolute or repo-relative path; pass repo-relative.
    try {
      await this._mergeView.show(path);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // Scrub credentials from any embedded remote URL before surfacing.
      void vscode.window.showErrorMessage(`Failed to open merge view: ${sanitizeGitError(msg)}`);
    }
  }

  private async _handleAbort(): Promise<void> {
    const op = this._opContext.operation;
    try {
      switch (op) {
        case 'merge':
          // No IGitService.mergeAbort — shell out via gitCli (existing pattern
          // used by CommitContextMenuCommands._handleMergeIntoCurrent).
          await this._execGit(['merge', '--abort']);
          break;
        case 'rebase':
          await this._execGit(['rebase', '--abort']);
          break;
        case 'cherryPick':
          await this._gitService.cherryPickAbort(this._repo);
          break;
        case 'revert':
          await this._gitService.revertAbort(this._repo);
          break;
        case 'unshelve':
          // Unshelve doesn't leave git in a well-known "aborting" state (it
          // applies patches directly). Restrict the checkout to only the
          // conflicted paths — a bare `checkout -- .` would wipe unrelated
          // working-tree changes the user made before/around the unshelve.
          await this._abortConflictedPaths();
          break;
        case 'unstash':
          // Stash apply/pop that conflicts leaves markers in the working tree
          // and the stash entry intact (for `apply`). Restrict the reset to
          // conflicted paths only — see `unshelve` note above for rationale.
          await this._abortConflictedPaths();
          break;
        case 'applyPatch':
          // `git apply` with --3way leaves conflict markers in the working
          // tree; there's no `--abort`. Restrict the reset to conflicted
          // paths only so we don't wipe unrelated working-tree changes.
          await this._abortConflictedPaths();
          break;
        default:
          // Unreachable.
          return;
      }
      void vscode.window.showInformationMessage(`${OP_LABELS[op]} aborted.`);
      this._close('aborted');
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      // Scrub credentials from git stderr before surfacing (LOW finding).
      void vscode.window.showErrorMessage(
        `Failed to abort ${OP_LABELS[op].toLowerCase()}: ${sanitizeGitError(errMsg)}`
      );
    }
  }

  private async _handleContinue(): Promise<void> {
    if (!this.allResolved()) {
      return;
    }
    const op = this._opContext.operation;
    try {
      switch (op) {
        case 'merge': {
          // Prefer `git merge --continue` (honors merge-specific hooks and
          // MERGE_MSG) over `git commit --no-edit`. Available since git 2.12.
          await this._execGit(['merge', '--continue']);
          break;
        }
        case 'rebase': {
          await this._execGit(['rebase', '--continue']);
          break;
        }
        case 'cherryPick': {
          const res = await this._gitService.cherryPickContinue(this._repo);
          if (!res.success && res.conflicts && res.conflicts.length > 0) {
            // More commits to cherry-pick with further conflicts — refresh the
            // dialog rather than closing.
            this.updateConflicts(res.conflicts.map((p) => ({ path: p, resolved: false })));
            void vscode.window.showWarningMessage(
              `Additional conflicts in ${res.conflicts.length} file(s). Please resolve.`
            );
            return;
          }
          break;
        }
        case 'revert': {
          const res = await this._gitService.revertContinue(this._repo);
          if (!res.success && res.conflicts && res.conflicts.length > 0) {
            this.updateConflicts(res.conflicts.map((p) => ({ path: p, resolved: false })));
            void vscode.window.showWarningMessage(
              `Additional conflicts in ${res.conflicts.length} file(s). Please resolve.`
            );
            return;
          }
          break;
        }
        case 'unshelve':
        case 'unstash':
        case 'applyPatch': {
          // Unshelve / unstash / apply-patch already applied the patch;
          // continue == commit the now-resolved working tree via the normal
          // user workflow. Nothing extra to dispatch.
          break;
        }
        default:
          return;
      }
      void vscode.window.showInformationMessage(`${OP_LABELS[op]} completed.`);
      this._close('completed');
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      // Scrub credentials from git stderr before surfacing (LOW finding).
      void vscode.window.showErrorMessage(
        `Failed to continue ${OP_LABELS[op].toLowerCase()}: ${sanitizeGitError(errMsg)}`
      );
    }
  }

  /**
   * Handle the Skip This Commit button (rebase-only).
   *
   * Issues a single confirm modal — the button is destructive but the
   * dialog is the only guard (IntelliJ-minimal policy,
   * feedback_data_loss_confirms.md). On confirmation delegates to
   * `IGitService.rebaseSkip`.
   *
   * If `rebase --skip` surfaces fresh conflicts on the next commit, the
   * dialog refreshes its file list in place rather than closing — mirrors
   * the cherry-pick continue loop path.
   */
  private async _handleSkip(): Promise<void> {
    if (this._opContext.operation !== 'rebase') {
      // Defensive: skip is rebase-only. Render-side already filters, but
      // keep the host-side guard so a forged webview message can't take
      // a non-rebase op down this path.
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      'Skip this commit? The changes will NOT be applied.',
      { modal: true },
      'Skip'
    );
    if (choice !== 'Skip') {
      return;
    }

    try {
      const res = await this._gitService.rebaseSkip(this._repo);
      if (!res.success && res.conflicts && res.conflicts.length > 0) {
        // The next commit also hit conflicts — refresh the file list.
        this.updateConflicts(res.conflicts.map((p) => ({ path: p, resolved: false })));
        void vscode.window.showWarningMessage(
          `Additional conflicts in ${res.conflicts.length} file(s). Please resolve.`
        );
        return;
      }
      void vscode.window.showInformationMessage('Commit skipped.');
      this._close('completed');
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      // Scrub credentials from git stderr before surfacing.
      void vscode.window.showErrorMessage(`Failed to skip commit: ${sanitizeGitError(errMsg)}`);
    }
  }

  /**
   * Execute a git command in the dialog's repository using the underlying
   * GitService's git CLI. Mirrors the existing pattern used by
   * ConflictResolutionService for `commit` / `rebase --continue`.
   */
  private async _execGit(args: string[]): Promise<void> {
    const gitCli = (
      this._gitService as unknown as {
        gitCli: {
          exec: (
            a: string[],
            o: object
          ) => Promise<{ exitCode: number; stderr: string; stdout: string }>;
        };
      }
    ).gitCli;
    const result = await gitCli.exec(args, { cwd: this._repo.rootUri.fsPath });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
    }
  }

  /**
   * Abort an unshelve / unstash / applyPatch by restoring ONLY the currently
   * conflicted paths to HEAD. A bare `git checkout -- .` would wipe unrelated
   * working-tree changes the user made around the failing op — hence this
   * narrower form. Paths are passed via `--` so a leading `-` in a filename
   * can never be interpreted as a flag.
   */
  private async _abortConflictedPaths(): Promise<void> {
    const paths: string[] = [];
    for (const [path, status] of this._statuses) {
      if (status === 'unresolved') {
        paths.push(path);
      }
    }
    if (paths.length === 0) {
      return;
    }
    await this._execGit(['checkout', 'HEAD', '--', ...paths]);
  }

  /**
   * Tear the dialog down with the given reason, notifying subscribers.
   */
  private _close(reason: 'completed' | 'aborted' | 'cancelled'): void {
    void this.postMessage({ type: 'closeDialog', reason } as OutgoingMessage);
    this._onDidClose.fire(reason);
    this.dispose();
  }

  /**
   * Build the title fragment shown after the fixed "Resolve Conflicts —".
   * Isolated as a static helper so the ctor can compose the title before `this`.
   */
  private static describeOp(opContext: IConflictOpContext): string {
    const label = OP_LABELS[opContext.operation];
    if (opContext.target) {
      return `${label} from '${opContext.target}'`;
    }
    return label;
  }
}

/**
 * Factory for the ResolveConflictsDialog. Mirrors the factory pattern used by
 * MergeView / BranchPopup / ShelfView.
 */
export function createResolveConflictsDialog(
  context: vscode.ExtensionContext,
  repo: IRepository,
  conflicts: IConflictedFile[],
  opContext: IConflictOpContext,
  conflictResolutionService: IConflictResolutionService,
  mergeView: IMergeView,
  gitService: IGitService
): ResolveConflictsDialog {
  return new ResolveConflictsDialog(
    context,
    repo,
    conflicts,
    opContext,
    conflictResolutionService,
    mergeView,
    gitService
  );
}
