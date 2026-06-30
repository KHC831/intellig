/**
 * ResolveConflictsDialog — modal webview surfaced whenever a merge / rebase /
 * cherry-pick / revert / unshelve / unstash operation leaves the working tree
 * in a conflicted state.
 *
 * Layout (matches IntelliJ "Resolve Conflicts" dialog, see
 * INTELLIJ_REFERENCE.md section "Resolve Conflicts dialog"):
 *
 * ```
 * ┌ Resolve Conflicts — merge from 'feature/x' ──────────────────────────┐
 * │  ⚠  path/a.ts  [Accept Yours][Accept Theirs][Merge…][Apply Non-Conf.] │
 * │  ✓  path/b.ts  resolved                                              │
 * │                                                                      │
 * │         [ Abort {Op} ]  [ Continue ]                                 │
 * └──────────────────────────────────────────────────────────────────────┘
 * ```
 *
 * Caller-invoked pattern (the caller wires `openResolveConflictsDialog`),
 * not event-based.
 */

import * as vscode from 'vscode';
import { BaseWebviewPanel } from '../utils/BaseWebviewPanel';
import { sanitizeGitError } from '../git-core/gitError';
import { IGitService, IRepository } from '../git-core/interfaces/IGitService';
import { escapeHtml } from '../utils/escapeHtml';
import {
  IConflictResolutionService,
  IConflictedFile,
  IConflictOpContext,
} from './interfaces/IConflictResolutionService';
import { IMergeView } from './interfaces/IMergeView';
import { isReversedOperation } from './conflictReversal';

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
  /** Apply only the non-conflicting (one-sided) changes in a file. */
  | { type: 'applyNonConflicting'; path: string }
  /** Take the user's ("Yours") side for every remaining unresolved file. */
  | { type: 'acceptAllYours' }
  /** Take the incoming ("Theirs") side for every remaining unresolved file. */
  | { type: 'acceptAllTheirs' }
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
  /**
   * In-flight guard for the terminal ops (continue/abort/skip). The Continue
   * button's `disabled` state is webview-driven, so a fast double-click could
   * otherwise fire two concurrent `rebase --continue`/`--abort` runs on one
   * repo — the second dead-ends on "no rebase in progress". Mirrors the
   * Push/Rebase dialogs' `_busy` gate.
   */
  private _busy = false;

  /**
   * The terminal reason this dialog closed, set once. Guards against firing
   * `_onDidClose` twice: `_close()` sets it before disposing, and the
   * dispose() override fires a fallback `'cancelled'` only when it is still
   * unset (the user closed the editor tab without Continue/Abort/Skip).
   */
  private _closeReason: 'completed' | 'aborted' | 'cancelled' | undefined;

  /**
   * Repo-relative paths whose per-file accept op is currently in flight. Guards
   * against a second click on the same row resolving it to the other side
   * mid-operation. See {@link _runPerFileExclusive}.
   */
  private readonly _inFlightPaths = new Set<string>();

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
   * Reconcile dialog rows against the set of paths git still reports as
   * unmerged. Any row currently `unresolved` whose path is NOT in the set has
   * been resolved outside the dialog (e.g. the user finished the file in VS
   * Code's native merge editor, which stages it) — flip it to resolved.
   *
   * Mirrors IntelliJ `MultipleFileMergeDialog.markFilesProcessed` /
   * `updateModelFromFiles` (platform/vcs-impl), which drops files that
   * `git ls-files --unmerged` (GitMergeProvider) no longer reports. Rows
   * already resolved, and paths outside the dialog model, are left untouched.
   */
  reconcileResolved(unmergedPaths: ReadonlySet<string>): void {
    for (const [path, status] of this._statuses) {
      if (status === 'unresolved' && !unmergedPaths.has(path)) {
        this.updateFileStatus(path, 'resolved');
      }
    }
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
    // Body ships an empty root; the script builds the header, file rows,
    // bulk-row, and footer via document.createElement from a JSON init island.
    return `<div id="root"></div>`;
  }

  /**
   * Override the base renderer so we can embed a real (non-sentinel) script
   * carrying the CSP nonce. The script builds the body via createElement from a
   * JSON init island, then handles click dispatch and incremental DOM updates
   * on host-originated postMessages.
   */
  protected override _render(): void {
    if (this._disposed) {
      return;
    }

    const nonce = this._getNonce();
    const csp = this._buildCsp(nonce);
    const styles = this._getStyles();
    const title = `Resolve Conflicts — ${ResolveConflictsDialog.describeOp(this._opContext)}`;

    // Host data crosses as a JSON init island; every dynamic value reaches the
    // DOM via .textContent / element props (injection-proof) — never markup.
    const initJson = JSON.stringify({
      headerText: ResolveConflictsDialog.describeOp(this._opContext),
      opLabel: OP_LABELS[this._opContext.operation],
      files: Array.from(this._statuses.entries()).map(([path, status]) => ({ path, status })),
      canAbort: this._opContext.canAbort,
      // Skip This Commit — only meaningful during a LIVE rebase. Skip's
      // precondition is identical to Continue's (a rebase in progress), so it
      // is gated on `canContinue` too; a post-completion autostash-pop conflict
      // (operation:'rebase' but canContinue:false) would dead-end on "no rebase
      // in progress".
      skipVisible: this._opContext.operation === 'rebase' && this._opContext.canContinue === true,
      continueVisible: this._opContext.canContinue,
      allResolved: this.allResolved(),
      // Whether any row is still unresolved — gates the bulk "Accept … for All"
      // buttons (no point offering them once everything is resolved).
      hasUnresolved: !this.allResolved(),
    }).replace(/</g, '\\u003c');

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
<div id="root"></div>
<script nonce="${nonce}">
(function() {
  const vscode = acquireVsCodeApi();
  const INIT = ${initJson};
  const el = (tag, props) => Object.assign(document.createElement(tag), props || {});

  // ── Build the body ────────────────────────────────────────────────────────
  const root = document.getElementById('root');
  root.append(el('div', { className: 'header', textContent: INIT.headerText }));

  const fileList = el('div', { className: 'file-list' });
  fileList.setAttribute('data-role', 'file-list');
  const buildRow = (path, status) => {
    const row = el('div', { className: 'file-row' });
    row.setAttribute('data-row-path', path);
    row.append(
      el('span', { className: 'file-status ' + status, textContent: status === 'resolved' ? '✓' : '⚠' }),
      el('span', { className: 'file-path', textContent: path })
    );
    const actions = el('span', { className: 'file-actions' });
    if (status === 'resolved') {
      actions.append(el('span', { className: 'resolved-label', textContent: 'resolved' }));
    } else {
      const btn = (cls, action, text, title) => {
        const b = el('button', { className: 'btn' + (cls ? ' ' + cls : ''), textContent: text });
        b.setAttribute('data-action', action);
        b.setAttribute('data-path', path);
        if (title) b.setAttribute('title', title);
        return b;
      };
      actions.append(
        btn('secondary', 'acceptYours', 'Accept Yours'),
        btn('secondary', 'acceptTheirs', 'Accept Theirs'),
        btn('', 'openMergeView', 'Merge…'),
        btn('secondary', 'applyNonConflicting', 'Apply Non-Conflicting', "Apply changes that don't conflict, leaving the true conflicts to resolve")
      );
    }
    row.append(actions);
    return row;
  };
  if (INIT.files.length > 0) {
    for (const f of INIT.files) fileList.append(buildRow(f.path, f.status));
  } else {
    const empty = el('div', { className: 'file-row' });
    empty.append(el('span', { className: 'file-path', textContent: 'No conflicted files.' }));
    fileList.append(empty);
  }
  root.append(fileList);

  if (INIT.hasUnresolved) {
    const bulkActions = el('div', { className: 'bulk-row' });
    const bulkBtn = (action, text, title) => {
      const b = el('button', { className: 'btn secondary', textContent: text });
      b.setAttribute('data-action', action);
      b.setAttribute('title', title);
      return b;
    };
    bulkActions.append(
      el('span', { textContent: 'For all remaining files:' }),
      bulkBtn('acceptAllYours', 'Accept Yours', 'Take your side for every unresolved file'),
      bulkBtn('acceptAllTheirs', 'Accept Theirs', 'Take the incoming side for every unresolved file')
    );
    root.append(bulkActions);
  }

  const bulk = el('div', { className: 'bulk-row' });
  bulk.append(
    'Tip: use ',
    el('strong', { textContent: 'Apply Non-Conflicting' }),
    ' to take every one-sided change automatically, then ',
    el('strong', { textContent: 'Merge…' }),
    ' for the true conflicts.'
  );
  root.append(bulk);

  const footer = el('div', { className: 'footer' });
  if (INIT.canAbort) {
    const b = el('button', { className: 'btn secondary', textContent: 'Abort ' + INIT.opLabel });
    b.setAttribute('data-action', 'abort');
    footer.append(b);
  }
  if (INIT.skipVisible) {
    const b = el('button', { className: 'btn secondary', textContent: 'Skip This Commit' });
    b.setAttribute('data-action', 'skip');
    b.setAttribute('title', "Drop the current commit and move on to the next one in the rebase sequence. The commit's changes will NOT be applied.");
    footer.append(b);
  }
  if (INIT.continueVisible) {
    const b = el('button', { className: 'btn', textContent: 'Continue' });
    b.setAttribute('data-action', 'continue');
    if (!INIT.allResolved) b.setAttribute('disabled', 'disabled');
    footer.append(b);
  }
  root.append(footer);

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
      case 'applyNonConflicting':
        if (path) send({ type: action, path: path });
        break;
      case 'acceptAllYours':
      case 'acceptAllTheirs':
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
        actionsEl.textContent = '';
        const lbl = document.createElement('span');
        lbl.className = 'resolved-label';
        lbl.textContent = 'resolved';
        actionsEl.appendChild(lbl);
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
        await this._runPerFileExclusive(msg.path, () => this._handleAcceptYours(msg.path));
        break;
      case 'acceptTheirs':
        await this._runPerFileExclusive(msg.path, () => this._handleAcceptTheirs(msg.path));
        break;
      case 'openMergeView':
        // Guarded on the same per-path key as the accept handlers: opening the
        // merge view can inject a synthetic stage-1 (rewriting the index entry),
        // which must not interleave with a same-row Accept that just staged a
        // resolution.
        await this._runPerFileExclusive(msg.path, () => this._handleOpenMergeView(msg.path));
        break;
      case 'applyNonConflicting':
        await this._runPerFileExclusive(msg.path, () => this._handleApplyNonConflicting(msg.path));
        break;
      case 'acceptAllYours':
        await this._runExclusive(() => this._handleAcceptAll('yours'));
        break;
      case 'acceptAllTheirs':
        await this._runExclusive(() => this._handleAcceptAll('theirs'));
        break;
      case 'abort':
        await this._runExclusive(() => this._handleAbort());
        break;
      case 'continue':
        await this._runExclusive(() => this._handleContinue());
        break;
      case 'skip':
        await this._runExclusive(() => this._handleSkip());
        break;
      default:
        // Unknown message — silently drop. The router property test confirms
        // no valid message reaches this branch.
        break;
    }
  }

  /**
   * Run a terminal op (continue/abort/skip) under the {@link _busy} guard so a
   * double-click can't launch two concurrent destructive git runs. A click that
   * arrives while one is in flight is dropped; the gate clears in `finally` even
   * if the op throws.
   */
  private async _runExclusive(op: () => Promise<void>): Promise<void> {
    if (this._busy) {
      return;
    }
    this._busy = true;
    try {
      await op();
    } finally {
      this._busy = false;
    }
  }

  /**
   * Run a per-file accept op (acceptYours/acceptTheirs/applyNonConflicting)
   * under a per-PATH in-flight guard: each of these checks out a side and
   * stages the file, so two concurrent runs on the SAME row could interleave
   * their `checkout`+`stage` and leave the file staged with the side the user
   * did NOT click last. A second click on a row already in flight is dropped;
   * the gate clears in `finally` even if the op throws. Different rows stay
   * independent (the key is the path), so resolving several files in quick
   * succession is unaffected.
   */
  private async _runPerFileExclusive(path: string, op: () => Promise<void>): Promise<void> {
    if (this._inFlightPaths.has(path)) {
      return;
    }
    this._inFlightPaths.add(path);
    try {
      await op();
    } finally {
      this._inFlightPaths.delete(path);
    }
  }

  /**
   * Whether ours/theirs are swapped for this operation. A rebase or
   * unstash/unshelve replays the user's work as "theirs", so "Accept Yours"
   * must take stage 3 (`--theirs`). Delegates to the shared
   * {@link isReversedOperation} so the dialog and the service's bulk-accept
   * auto-detect stay in lockstep.
   */
  private _isReversed(): boolean {
    return isReversedOperation(this._opContext.operation);
  }

  /**
   * Take one side ("Yours"/"Theirs") for every still-unresolved file. Confirms
   * once (it discards the other side across all files), then delegates to the
   * service's bulk accept-all with this dialog's explicit reversal so it matches
   * the per-row buttons. Already-resolved rows are untouched (the service only
   * acts on git's unmerged set). On success every row that left the unmerged set
   * flips to resolved, enabling Continue.
   */
  private async _handleAcceptAll(side: 'yours' | 'theirs'): Promise<void> {
    const unresolved = [...this._statuses.entries()].filter(([, s]) => s === 'unresolved').length;
    if (unresolved === 0) {
      return;
    }
    const label = side === 'yours' ? 'Yours' : 'Theirs';
    const choice = await vscode.window.showWarningMessage(
      `Accept ${label} for all ${unresolved} unresolved file(s)? The other side will be discarded.`,
      { modal: true },
      `Accept ${label}`
    );
    if (choice !== `Accept ${label}`) {
      return;
    }

    const reversed = this._isReversed();
    const result =
      side === 'yours'
        ? await this._conflictResolutionService.acceptAllCurrent(this._repo, reversed)
        : await this._conflictResolutionService.acceptAllIncoming(this._repo, reversed);
    if (!result.success) {
      void vscode.window.showErrorMessage(
        sanitizeGitError(result.error || `Failed to accept ${label.toLowerCase()} for all files`)
      );
      return;
    }

    // Flip every row that git no longer reports as unmerged to resolved (some
    // may remain — e.g. a binary the bulk op could not check out).
    const stillConflicted = new Set(
      (await this._conflictResolutionService.getConflictedFiles(this._repo)).map((c) => c.path)
    );
    for (const [path, status] of this._statuses) {
      if (status === 'unresolved' && !stillConflicted.has(path)) {
        this.updateFileStatus(path, 'resolved');
      }
    }
  }

  private async _handleAcceptYours(path: string): Promise<void> {
    const result = await this._conflictResolutionService.acceptCurrent(
      this._repo,
      path,
      this._isReversed()
    );
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
    const result = await this._conflictResolutionService.acceptIncoming(
      this._repo,
      path,
      this._isReversed()
    );
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

  private async _handleApplyNonConflicting(path: string): Promise<void> {
    const result = await this._conflictResolutionService.acceptNonConflictingChanges(
      this._repo,
      path
    );
    if (!result.success) {
      // `result.error` may include git stderr which can embed credentials in
      // remote URLs — scrub before surfacing.
      void vscode.window.showErrorMessage(
        sanitizeGitError(result.error || `Failed to apply non-conflicting changes for ${path}`)
      );
      return;
    }

    // When every region was non-conflicting the file is fully merged and now
    // staged — reflect that as resolved.
    if (result.fullyResolved) {
      this.updateFileStatus(path, 'resolved');
      void vscode.window.showInformationMessage(`Resolved ${path}.`);
      return;
    }

    // True conflicts remain; the row stays unresolved. Always give feedback so
    // the button never looks dead — a pure conflict (or an add/add with no
    // common base) has nothing one-sided to apply, which previously did nothing
    // visible at all.
    const n = result.remainingHunks ?? 0;
    const plural = n === 1 ? 'conflict' : 'conflicts';
    // `git merge-file` caps its exit-code hunk count at 127, so a file with more
    // than that many conflict regions reports "127+".
    const count = n >= 127 ? '127+' : `${n}`;
    void vscode.window.showInformationMessage(
      `${path}: ${count} ${plural} still need${n === 1 ? 's' : ''} resolving. Use Merge… to finish.`
    );
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
          await this._gitService.cherryPickAbort(this._repo).match(
            () => undefined,
            (e) => {
              throw e;
            }
          );
          break;
        case 'revert':
          await this._gitService.revertAbort(this._repo).match(
            () => undefined,
            (e) => {
              throw e;
            }
          );
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
          // `git merge --continue` opens $EDITOR for the merge message; under
          // VS Code's non-TTY spawn that hangs/fails. `--no-edit` is rejected
          // ("--continue expects no arguments"), so suppress the editor via
          // GIT_EDITOR=true — the prepared MERGE_MSG is committed verbatim.
          await this._execGit(['merge', '--continue'], { GIT_EDITOR: 'true' });
          break;
        }
        case 'rebase': {
          // Route through gitService.rebaseContinue (NOT a raw
          // `rebase --continue` exec): when the rebase stops at the next
          // commit's conflicts git exits non-zero, which the raw exec would
          // throw on — dead-ending a multi-commit rebase with an error toast
          // and a stale "all resolved" dialog. rebaseContinue returns those
          // conflicts as data so we can re-populate the dialog in place,
          // mirroring the cherryPick/revert continue loops above.
          const res = await this._gitService.rebaseContinue(this._repo);
          if (!res.success && res.conflicts && res.conflicts.length > 0) {
            this.updateConflicts(res.conflicts.map((p) => ({ path: p, resolved: false })));
            void vscode.window.showWarningMessage(
              `Additional conflicts in ${res.conflicts.length} file(s). Please resolve.`
            );
            return;
          }
          if (!res.success) {
            // Non-conflict failure (e.g. nothing staged, no rebase in
            // progress). Surface git's reason rather than a false "completed".
            throw new Error(res.failureReason ?? 'Failed to continue rebase');
          }
          break;
        }
        case 'cherryPick': {
          const res = await this._gitService.cherryPickContinue(this._repo).match(
            (r) => r,
            (e) => {
              throw e;
            }
          );
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
          const res = await this._gitService.revertContinue(this._repo).match(
            (r) => r,
            (e) => {
              throw e;
            }
          );
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
    if (this._opContext.operation !== 'rebase' || !this._opContext.canContinue) {
      // Defensive: skip requires a continuable (in-progress) rebase — its
      // precondition is identical to Continue's. Render-side already hides
      // the button for non-rebase ops AND for a completed rebase (an
      // autostash-pop conflict, where `canContinue` is false), but mirror the
      // render gate here so a forged webview message can't drive
      // `git rebase --skip` into a "no rebase in progress" dead-end.
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
  private async _execGit(args: string[], envOverride?: NodeJS.ProcessEnv): Promise<void> {
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
    const options: { cwd: string; env?: NodeJS.ProcessEnv } = {
      cwd: this._repo.rootUri.fsPath,
    };
    if (envOverride) {
      // Merge over the ambient env so PATH/HOME survive; the override only
      // pins editor-suppression vars (GIT_EDITOR) for non-interactive runs.
      options.env = { ...process.env, ...envOverride };
    }
    const result = await gitCli.exec(args, options);
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
    if (this._closeReason !== undefined) {
      return;
    }
    this._closeReason = reason;
    void this.postMessage({ type: 'closeDialog', reason } as OutgoingMessage);
    this._onDidClose.fire(reason);
    this.dispose();
  }

  /**
   * Fire `onDidClose('cancelled')` when the editor tab is closed directly
   * (BaseWebviewPanel routes `panel.onDidDispose` here) so the owner clears its
   * per-repo registry and recorded operation. Without this, closing the tab
   * instead of clicking Continue/Abort would leave a disposed dialog stranded in
   * the service's `_activeDialogs`/`_opByRepo` maps.
   */
  override dispose(): void {
    if (this._closeReason === undefined && !this._disposed) {
      this._closeReason = 'cancelled';
      this._onDidClose.fire('cancelled');
    }
    super.dispose();
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
