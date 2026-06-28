/**
 * Merge Dialog.
 *
 * IntelliJ-style "Merge Branch" modal. Replaces the direct
 * `gitService.mergeBranch(repo, branch)` call with a webview panel
 * (extends {@link BaseWebviewPanel}) that exposes the full CLI option
 * surface as check-boxes + an optional commit-message textarea.
 *
 * Fields:
 *  - Source branch (read-only, passed in via constructor).
 *  - Target branch (read-only, computed from `repo.head`).
 *  - `--ff-only` checkbox — require a fast-forward.
 *  - `--no-ff`   checkbox — always create a merge commit.
 *  - `--squash`  checkbox — stage changes without creating a commit.
 *  - `--no-commit` checkbox — merge but don't commit.
 *  - Commit message textarea — passed as `-m <msg>`.
 *
 * Mutex:
 *  - `--ff-only` clears `--no-ff` and `--squash` (CLI-incompatible).
 *  - `--squash`  clears `--no-ff` and `--ff-only`.
 *  - `--no-ff`   clears `--ff-only` and `--squash`.
 *
 * Conflict handoff: on non-success with conflicts, invokes
 * {@link IConflictResolutionService.openResolveConflictsDialog} with
 * `operation: 'merge'`, matching the caller-invoked pattern.
 *
 * No destructive-op confirm — merge is recoverable via `git merge --abort`.
 */

import * as vscode from 'vscode';
import { BaseWebviewPanel } from '../utils/BaseWebviewPanel';
import { IGitService, IMergeOptions, IRepository } from '../git-core/interfaces/IGitService';
import { IConflictResolutionService } from './interfaces/IConflictResolutionService';
import { sanitizeGitError } from '../git-core/gitError';
import { getLogger } from '../utils/logger';
import { escapeHtml } from '../utils/escapeHtml';

/** Options for constructing a {@link MergeDialog}. */
export interface IMergeDialogOptions {
  repo: IRepository;
  /** The branch being merged INTO the current branch. */
  sourceBranch: string;
  gitService: IGitService;
  /** Optional — used for the conflict handoff. */
  conflictResolutionService?: IConflictResolutionService;
  /** Optional callback fired after a successful merge. */
  onMergeComplete?: () => void;
}

/** Strategy flags that are mutually exclusive. Used by the UI mutex resolver. */
export type MergeStrategyFlag = 'ffOnly' | 'noFf' | 'squash';

/**
 * Pure flag-state type. Mirrors {@link IMergeOptions} minus `message`,
 * which lives in the textarea.
 */
export interface IMergeFlagState {
  ffOnly: boolean;
  noFf: boolean;
  squash: boolean;
  noCommit: boolean;
}

/**
 * Pure mutex resolver — when a strategy flag is freshly enabled, clear
 * the other strategy flags so the CLI-incompatible combinations can't
 * reach {@link GitService.mergeBranch}.
 *
 * Exported for focused unit testing.
 */
export function resolveMergeMutex(
  flags: IMergeFlagState,
  lastToggled?: MergeStrategyFlag
): IMergeFlagState {
  const strategy: MergeStrategyFlag[] = ['ffOnly', 'noFf', 'squash'];
  const next: IMergeFlagState = { ...flags };

  if (lastToggled && strategy.includes(lastToggled) && next[lastToggled]) {
    for (const other of strategy) {
      if (other !== lastToggled) {
        next[other] = false;
      }
    }
    return next;
  }

  // No explicit `lastToggled` — enforce "at most one strategy flag" by
  // keeping the first enabled one (in declaration order).
  let seen = false;
  for (const key of strategy) {
    if (next[key]) {
      if (seen) {
        next[key] = false;
      } else {
        seen = true;
      }
    }
  }
  return next;
}

/** Webview → extension message shape. */
interface IMergeDialogMessage {
  type: 'merge' | 'cancel';
  flags?: Partial<IMergeFlagState>;
  /**
   * Independent (non-strategy, non-mutex) flags carried alongside
   * {@link IMergeFlagState}. Kept off `IMergeFlagState` so the pure mutex
   * resolver and its tests stay scoped to the strategy flags.
   */
  noVerify?: boolean;
  allowUnrelatedHistories?: boolean;
  message?: string;
}

const VIEW_TYPE = 'intellig.mergeDialog';
const TITLE = 'Merge Branch';

export class MergeDialog extends BaseWebviewPanel {
  private readonly _repo: IRepository;
  private readonly _sourceBranch: string;
  private readonly _targetBranch: string;
  private readonly _gitService: IGitService;
  private readonly _conflictResolutionService?: IConflictResolutionService;
  private readonly _onMergeComplete?: () => void;
  private _busy = false;

  constructor(context: vscode.ExtensionContext, options: IMergeDialogOptions) {
    super(context, VIEW_TYPE, TITLE, vscode.ViewColumn.One);
    this._repo = options.repo;
    this._sourceBranch = options.sourceBranch;
    this._targetBranch = options.repo.head?.name?.replace(/^refs\/heads\//, '') ?? 'HEAD';
    this._gitService = options.gitService;
    this._conflictResolutionService = options.conflictResolutionService;
    this._onMergeComplete = options.onMergeComplete;
    this._render();
  }

  protected override _getStyles(): string {
    return `
      body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        padding: 16px 20px;
        font-size: var(--vscode-font-size);
      }
      .summary {
        margin-bottom: 16px;
        padding: 8px 10px;
        background: var(--vscode-editor-inactiveSelectionBackground);
        border-left: 3px solid var(--vscode-focusBorder);
        font-family: var(--vscode-editor-font-family, monospace);
      }
      .summary .label { color: var(--vscode-descriptionForeground); margin-right: 6px; }
      .flags { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
      label.flag { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; }
      label.flag input[disabled] + .label-text { opacity: 0.55; cursor: not-allowed; }
      label.flag .label-text { display: flex; flex-direction: column; gap: 2px; }
      label.flag .label-text .title-line { font-weight: 600; }
      label.flag .label-text .desc {
        font-size: 0.9em;
        color: var(--vscode-descriptionForeground);
      }
      .message-area {
        margin: 16px 0 10px;
      }
      .message-area label {
        display: block;
        margin-bottom: 4px;
        color: var(--vscode-descriptionForeground);
      }
      textarea {
        width: 100%;
        min-height: 60px;
        box-sizing: border-box;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent);
        padding: 4px 6px;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: var(--vscode-font-size);
      }
      .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
      button {
        font-family: inherit;
        font-size: inherit;
        padding: 4px 14px;
        border: 1px solid var(--vscode-button-border, transparent);
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        cursor: pointer;
      }
      button.secondary {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
      }
      button:disabled { opacity: 0.55; cursor: not-allowed; }
    `;
  }

  protected _getBodyHtml(): string {
    return this._getBodyParts().body;
  }

  /**
   * Emit the body HTML and the interactive script separately. Used by
   * `_render` so it can splice the script into a nonced `<script>` block
   * without regex-extracting it from the body (nested `</script>`
   * inside a string literal would break the old regex).
   */
  private _getBodyParts(): { body: string; script: string } {
    // Body ships an empty root; the script builds every control via
    // document.createElement. Host data crosses as a JSON init island and
    // reaches the DOM via .textContent (injection-proof) — never markup.
    const body = `<div id="root"></div>`;

    const initJson = JSON.stringify({
      sourceBranch: this._sourceBranch,
      targetBranch: this._targetBranch,
    }).replace(/</g, '\\u003c');

    const script = `
      (function() {
        const vscode = acquireVsCodeApi();
        const INIT = ${initJson};
        const root = document.getElementById('root');
        const el = (tag, props) => Object.assign(document.createElement(tag), props || {});

        // ── Summary (source → target) ──────────────────────────────────────
        const summary = el('div', { className: 'summary' });
        const summaryRow = (label, value) => {
          const row = el('div');
          row.append(el('span', { className: 'label', textContent: label }), value);
          return row;
        };
        summary.append(
          summaryRow('Source:', INIT.sourceBranch),
          summaryRow('Target:', INIT.targetBranch)
        );

        // ── Option checkboxes ──────────────────────────────────────────────
        const FLAGS = [
          { id: 'ffOnly', title: '--ff-only', desc: 'Require a fast-forward merge; abort if not possible.' },
          { id: 'noFf', title: '--no-ff', desc: 'Always create a merge commit (even when fast-forward is possible).' },
          { id: 'squash', title: '--squash', desc: 'Stage changes from the merge without creating a commit.' },
          { id: 'noCommit', title: '--no-commit', desc: 'Stop before committing so the merge can be reviewed.' },
          { id: 'noVerify', title: '--no-verify', desc: 'Bypass the pre-merge and commit-message hooks.' },
          { id: 'allowUnrelatedHistories', title: '--allow-unrelated-histories', desc: 'Merge two branches that share no common history.' },
        ];
        const flagsBox = el('div', { className: 'flags' });
        for (const f of FLAGS) {
          const label = el('label', { className: 'flag' });
          label.setAttribute('data-flag', f.id);
          const input = el('input', { type: 'checkbox', id: 'flag-' + f.id });
          const text = el('span', { className: 'label-text' });
          text.append(
            el('span', { className: 'title-line', textContent: f.title }),
            el('span', { className: 'desc', textContent: f.desc })
          );
          label.append(input, text);
          flagsBox.append(label);
        }

        // ── Merge-message textarea ─────────────────────────────────────────
        const messageArea = el('div', { className: 'message-area' });
        const messageLabel = el('label', { htmlFor: 'merge-message' });
        messageLabel.append(
          'Merge commit message (optional, maps to ',
          el('code', { textContent: '-m' }),
          '):'
        );
        const messageEl = el('textarea', {
          id: 'merge-message',
          placeholder: 'Enter a merge commit message, or leave blank for git default',
        });
        messageArea.append(messageLabel, messageEl);

        // ── Actions ────────────────────────────────────────────────────────
        const actions = el('div', { className: 'actions' });
        const cancelBtn = el('button', {
          id: 'cancel-btn',
          type: 'button',
          className: 'secondary',
          textContent: 'Cancel',
        });
        const mergeBtn = el('button', { id: 'merge-btn', type: 'button', textContent: 'Merge' });
        actions.append(cancelBtn, mergeBtn);

        root.append(summary, flagsBox, messageArea, actions);

        const strategyFlags = ['ffOnly', 'noFf', 'squash'];
        const readFlags = () => ({
          ffOnly: document.getElementById('flag-ffOnly').checked,
          noFf: document.getElementById('flag-noFf').checked,
          squash: document.getElementById('flag-squash').checked,
          noCommit: document.getElementById('flag-noCommit').checked,
        });
        const applyMutex = (lastToggled) => {
          if (!strategyFlags.includes(lastToggled)) return;
          const el = document.getElementById('flag-' + lastToggled);
          if (!el || !el.checked) return;
          for (const other of strategyFlags) {
            if (other !== lastToggled) {
              document.getElementById('flag-' + other).checked = false;
            }
          }
        };
        for (const flag of strategyFlags) {
          document.getElementById('flag-' + flag).addEventListener('change', () => {
            applyMutex(flag);
          });
        }
        const submit = () => {
          vscode.postMessage({
            type: 'merge',
            flags: readFlags(),
            noVerify: document.getElementById('flag-noVerify').checked,
            allowUnrelatedHistories: document.getElementById('flag-allowUnrelatedHistories').checked,
            message: document.getElementById('merge-message').value,
          });
        };
        const cancel = () => {
          vscode.postMessage({ type: 'cancel' });
        };
        document.getElementById('merge-btn').addEventListener('click', submit);
        document.getElementById('cancel-btn').addEventListener('click', cancel);

        // Dialog keyboard contract (spec 5.1 — shared across all dialogs):
        //   Cmd+Enter / Ctrl+Enter → primary action (Merge)
        //   Esc                    → cancel
        // Plain Enter inside the merge-message textarea inserts a newline,
        // so only the modified Enter submits.
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        });
      })();
    `;

    return { body, script };
  }

  /**
   * Override the base renderer entirely so we can emit the interactive
   * script with the CSP nonce. We pass body+script as an explicit
   * tuple from `_getBodyParts()` instead of regex-extracting the script
   * from the serialized body (which would break on nested `</script>`
   * substrings inside string literals).
   */
  protected override _render(): void {
    if (this._disposed) {
      return;
    }

    const nonce = this._getNonce();
    const csp = this._buildCsp(nonce);
    const styles = this._getStyles();
    const styleBlock = styles.length > 0 ? `<style>${styles}</style>` : '';
    const { body, script } = this._getBodyParts();

    this._panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>${escapeHtml(this._title)}</title>
  ${styleBlock}
</head>
<body>
${body}
<script nonce="${nonce}">${script}</script>
</body>
</html>`;
  }

  protected async _onMessage(raw: unknown): Promise<void> {
    if (this._busy || this._disposed) {
      return;
    }
    const msg = raw as IMergeDialogMessage | undefined;
    if (!msg || typeof msg !== 'object') {
      return;
    }

    switch (msg.type) {
      case 'cancel':
        this.dispose();
        return;

      case 'merge': {
        const flagsIn: IMergeFlagState = {
          ffOnly: msg.flags?.ffOnly === true,
          noFf: msg.flags?.noFf === true,
          squash: msg.flags?.squash === true,
          noCommit: msg.flags?.noCommit === true,
        };
        // Defensive mutex resolution: even if the webview bypasses the UI
        // mutex, the strategy flags must be CLI-compatible.
        const flags = resolveMergeMutex(flagsIn);
        const options: IMergeOptions = {
          ffOnly: flags.ffOnly || undefined,
          noFf: flags.noFf || undefined,
          squash: flags.squash || undefined,
          noCommit: flags.noCommit || undefined,
          noVerify: msg.noVerify === true || undefined,
          allowUnrelatedHistories: msg.allowUnrelatedHistories === true || undefined,
          message: msg.message && msg.message.trim().length > 0 ? msg.message : undefined,
        };
        await this._executeMerge(options);
        return;
      }
    }
  }

  private async _executeMerge(options: IMergeOptions): Promise<void> {
    this._busy = true;
    try {
      const result = await this._gitService.mergeBranch(this._repo, this._sourceBranch, options);
      if (result.success) {
        const verb = options.squash
          ? 'Squash-merged'
          : options.noCommit
            ? 'Merged (no commit)'
            : 'Merged';
        void vscode.window.showInformationMessage(
          `${verb} '${this._sourceBranch}' into '${this._targetBranch}'`
        );
        if (this._onMergeComplete) {
          try {
            this._onMergeComplete();
          } catch (err) {
            getLogger()
              .child({ component: 'MergeDialog' })
              .error('onMergeComplete threw', err instanceof Error ? err : undefined);
          }
        }
        this.dispose();
        return;
      }
      if (result.conflicts && result.conflicts.length > 0 && this._conflictResolutionService) {
        await this._conflictResolutionService.openResolveConflictsDialog(
          this._repo,
          result.conflicts.map((p) => ({ path: p, resolved: false })),
          {
            operation: 'merge',
            target: this._sourceBranch,
            canAbort: true,
            canContinue: true,
          }
        );
        this.dispose();
        return;
      }
      // No conflict service wired OR no conflicts: fall back to a warning.
      void vscode.window.showWarningMessage(
        `Merge of '${this._sourceBranch}' did not complete cleanly. Run 'git status' for details.`
      );
      this._busy = false;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to merge: ${sanitizeGitError(msg)}`);
      this._busy = false;
    }
  }
}

/**
 * Convenience factory.
 */
export function showMergeDialog(
  context: vscode.ExtensionContext,
  options: IMergeDialogOptions
): MergeDialog {
  return new MergeDialog(context, options);
}
