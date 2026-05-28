/**
 * Reset Dialog (T1-11).
 *
 * IntelliJ-style "Reset Current Branch to Here…" modal. Replaces the old
 * QuickPick-based reset flow with a webview panel (extends
 * {@link BaseWebviewPanel}) that exposes all four git reset modes as
 * radio buttons (Soft / Mixed / Hard / Keep).
 *
 * Safety policy (see feedback_data_loss_confirms.md):
 *  - Default selection is **Mixed** (non-destructive).
 *  - Hard/Keep → single modal confirm before execution. No double-confirm.
 *  - If the current branch is listed in `intellig.protectedBranches`,
 *    Hard and Keep radios render as disabled with a tooltip; user must
 *    remove the branch from config to use them.
 */

import * as vscode from 'vscode';
import { BaseWebviewPanel } from '../utils/BaseWebviewPanel';
import { IGitService, IRepository, ResetMode } from './interfaces/IGitService';
import { sanitizeGitError } from '../utils/gitError';
import { getLogger } from '../utils/logger';

/**
 * Target commit descriptor passed into the dialog.
 */
export interface IResetTarget {
  /** Full commit hash. Used as the `<commit>` arg to `git reset`. */
  hash: string;
  /** Commit subject line, shown next to the hash in the dialog header. */
  subject: string;
}

/**
 * Options for constructing a {@link ResetDialog}.
 */
export interface IResetDialogOptions {
  /** The repository to reset. */
  repo: IRepository;
  /** The target commit to reset to. */
  target: IResetTarget;
  /** Current branch name (e.g. "main"). Used for the protected-branch guard. */
  currentBranch: string;
  /**
   * Configured protected-branch names. When `currentBranch` is in this
   * list, the Hard and Keep radios are disabled.
   */
  protectedBranches: string[];
  /** GitService used to execute the reset. */
  gitService: IGitService;
  /**
   * Optional callback fired after a successful reset so the caller can
   * refresh any dependent UI (branch tree, graph panel, etc.).
   */
  onResetComplete?: () => void;
}

/**
 * Internal message shape from webview → extension.
 */
interface IResetDialogMessage {
  type: 'reset' | 'cancel';
  mode?: ResetMode;
}

const VIEW_TYPE = 'intellig.resetDialog';
const TITLE = 'Reset Current Branch';

/**
 * Validation guard for commit-hash-ish strings passed to `git reset`.
 * Matches the guard used in {@link GitService.resetToCommit}.
 *
 * **Security:** rejects refs that start with `-` (git would parse as a flag,
 * e.g. `git reset --mixed -foo` becomes `git reset --mixed -f oo`) or `.`
 * (not a valid git-check-ref-format anyway, and prone to accidental relative-
 * path interpretation in downstream tooling). Same policy as
 * {@link validateTagName} in extension.ts.
 */
export function isValidRef(target: string): boolean {
  return /^(?![-.])[A-Za-z0-9_./@:~^-]+$/.test(target);
}

/**
 * Ordered reset-mode preference list. Used by {@link resolveDefaultMode} to
 * choose the fallback when the designated default is disabled by protected-
 * branch policy. "Mixed" is the safest (IntelliJ default + git default).
 */
const RESET_MODE_PREFERENCE: readonly ResetMode[] = ['mixed', 'soft', 'keep', 'hard'];

/**
 * Pick the effective default reset mode, falling back from the designated
 * default (`preferred`) to the first enabled alternative when the designated
 * one is disabled. Keeps the UI from rendering "no radio checked" if someone
 * later flips the default to Hard on a protected branch.
 *
 * @param preferred - The designated default mode.
 * @param disabled  - Set of modes disabled by the protected-branches policy.
 * @returns         A mode guaranteed not to be in `disabled` (or `preferred`
 *                  itself if every mode is disabled, which cannot happen in
 *                  practice because Soft/Mixed are never disabled).
 */
export function resolveDefaultMode(
  preferred: ResetMode,
  disabled: ReadonlySet<ResetMode>
): ResetMode {
  if (!disabled.has(preferred)) {
    return preferred;
  }
  for (const candidate of RESET_MODE_PREFERENCE) {
    if (!disabled.has(candidate)) {
      return candidate;
    }
  }
  // Degenerate case: all four modes disabled. Return preferred so the caller
  // at least has a valid ResetMode; the disabled attribute will keep it
  // inert in the DOM.
  return preferred;
}

export class ResetDialog extends BaseWebviewPanel {
  private readonly _repo: IRepository;
  private readonly _target: IResetTarget;
  private readonly _currentBranch: string;
  private readonly _protectedBranches: ReadonlySet<string>;
  private readonly _gitService: IGitService;
  private readonly _onResetComplete?: () => void;
  private _busy = false;

  constructor(context: vscode.ExtensionContext, options: IResetDialogOptions) {
    super(context, VIEW_TYPE, TITLE, vscode.ViewColumn.One);
    this._repo = options.repo;
    this._target = options.target;
    this._currentBranch = options.currentBranch;
    this._protectedBranches = new Set(options.protectedBranches);
    this._gitService = options.gitService;
    this._onResetComplete = options.onResetComplete;

    this._render();
  }

  /**
   * Whether the current branch is protected (Hard/Keep disabled).
   */
  get isProtected(): boolean {
    return this._protectedBranches.has(this._currentBranch);
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
      .target {
        margin-bottom: 16px;
        padding: 8px 10px;
        background: var(--vscode-editor-inactiveSelectionBackground);
        border-left: 3px solid var(--vscode-focusBorder);
        font-family: var(--vscode-editor-font-family, monospace);
      }
      .target .hash { font-weight: bold; margin-right: 8px; }
      .modes {
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin-bottom: 20px;
      }
      label.mode {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        cursor: pointer;
      }
      label.mode input[disabled] + .label-text {
        opacity: 0.55;
        cursor: not-allowed;
      }
      label.mode .label-text {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      label.mode .label-text .title-line {
        font-weight: 600;
      }
      label.mode .label-text .desc {
        font-size: 0.9em;
        color: var(--vscode-descriptionForeground);
      }
      .warn { color: var(--vscode-editorWarning-foreground); }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 8px;
      }
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
      button:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
    `;
  }

  protected _getBodyHtml(): string {
    return this._getBodyParts().body;
  }

  /**
   * Emit the body HTML and the interactive script separately. Used by
   * `_wrapHtml` so it can splice the script into a nonced `<script>` block
   * without regex-extracting it from the body (LOW-1 — nested `</script>`
   * inside a string literal would break the old regex).
   */
  private _getBodyParts(): { body: string; script: string } {
    const shortHash = this._target.hash.substring(0, 8);
    const subject = escapeHtml(this._target.subject);
    const protectedTooltip = 'Protected branch — remove from intellig.protectedBranches to enable';

    // MEDIUM-6: compute the effective default explicitly instead of leaning
    // on the brittle `checked && !disabled` trick. If someone later flips
    // the designated default to Hard, a protected branch will now fall back
    // to the first enabled mode (Soft) rather than render no radio checked.
    const disabledSet = new Set<ResetMode>(this.isProtected ? ['hard', 'keep'] : []);
    const effectiveDefault = resolveDefaultMode('mixed', disabledSet);

    const radio = (mode: ResetMode, label: string, desc: string, warn: boolean): string => {
      const disabled = disabledSet.has(mode);
      const disabledAttr = disabled ? 'disabled' : '';
      const titleAttr = disabled ? ` title="${escapeHtml(protectedTooltip)}"` : '';
      const checkedAttr = mode === effectiveDefault ? 'checked' : '';
      const warnClass = warn ? ' warn' : '';
      return `
        <label class="mode"${titleAttr} data-mode="${mode}">
          <input type="radio" name="reset-mode" value="${mode}" ${checkedAttr} ${disabledAttr} />
          <span class="label-text">
            <span class="title-line${warnClass}">${label}</span>
            <span class="desc">${desc}</span>
          </span>
        </label>
      `;
    };

    const body = `
      <div class="target">
        <span class="hash">${escapeHtml(shortHash)}</span>
        <span class="subject">${subject}</span>
      </div>

      <div class="modes" role="radiogroup" aria-label="Reset mode">
        ${radio('soft', 'Soft', 'Keep changes staged', false)}
        ${radio('mixed', 'Mixed', 'Keep changes unstaged (default)', false)}
        ${radio('hard', 'Hard', 'Discard all changes', true)}
        ${radio('keep', 'Keep', 'Discard committed, keep local', true)}
      </div>

      <div class="actions">
        <button id="cancel-btn" class="secondary" type="button">Cancel</button>
        <button id="reset-btn" type="button">Reset</button>
      </div>
    `;

    const script = `
      (function() {
        const vscode = acquireVsCodeApi();
        document.getElementById('reset-btn').addEventListener('click', () => {
          const checked = document.querySelector('input[name="reset-mode"]:checked');
          const mode = checked ? checked.value : 'mixed';
          vscode.postMessage({ type: 'reset', mode });
        });
        document.getElementById('cancel-btn').addEventListener('click', () => {
          vscode.postMessage({ type: 'cancel' });
        });
      })();
    `;

    return { body, script };
  }

  /**
   * Override the base renderer entirely so we can emit the interactive
   * script with the CSP nonce. LOW-1: we pass body+script as an explicit
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
    const msg = raw as IResetDialogMessage | undefined;
    if (!msg || typeof msg !== 'object') {
      return;
    }

    switch (msg.type) {
      case 'cancel':
        this.dispose();
        return;

      case 'reset': {
        const mode = msg.mode;
        if (!mode || !isResetMode(mode)) {
          return;
        }
        // Protected-branch guard at the message boundary: even if a
        // malicious webview somehow bypassed `disabled`, we refuse
        // Hard/Keep on a protected branch.
        if (this.isProtected && (mode === 'hard' || mode === 'keep')) {
          void vscode.window.showWarningMessage(
            `Reset --${mode} blocked: '${this._currentBranch}' is a protected branch. ` +
              `Remove it from intellig.protectedBranches to enable.`
          );
          return;
        }

        if (mode === 'hard' || mode === 'keep') {
          const confirmed = await this._confirmDestructive();
          if (!confirmed) {
            return;
          }
        }

        await this._executeReset(mode);
        return;
      }
    }
  }

  /**
   * Show the single destructive-op confirm modal.
   * Returns true if the user clicked "Reset", false otherwise.
   */
  private async _confirmDestructive(): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(
      'This will discard local changes. Continue?',
      { modal: true },
      'Reset',
      'Cancel'
    );
    return choice === 'Reset';
  }

  /**
   * Execute the reset and show toast / error. Disposes the dialog on
   * success; leaves it open on failure so the user can retry or cancel.
   */
  private async _executeReset(mode: ResetMode): Promise<void> {
    this._busy = true;
    try {
      if (!isValidRef(this._target.hash)) {
        throw new Error(`Invalid commit reference: ${this._target.hash}`);
      }
      await this._gitService.resetToCommit(this._repo, this._target.hash, mode);
      const shortHash = this._target.hash.substring(0, 8);
      void vscode.window.showInformationMessage(`Reset to ${shortHash}`);
      if (this._onResetComplete) {
        try {
          this._onResetComplete();
        } catch (err) {
          getLogger()
            .child({ component: 'ResetDialog' })
            .error(
              'onResetComplete callback threw',
              err instanceof Error ? err : undefined
            );
        }
      }
      this.dispose();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to reset: ${sanitizeGitError(errorMessage)}`);
      this._busy = false;
    }
  }
}

/**
 * Convenience factory: show a Reset dialog for the given target.
 *
 * Kept as a module-level function so callers don't need to import
 * {@link ResetDialog} directly and so tests can stub this single entry
 * point if needed.
 */
export function showResetDialog(
  context: vscode.ExtensionContext,
  options: IResetDialogOptions
): ResetDialog {
  return new ResetDialog(context, options);
}

function isResetMode(x: unknown): x is ResetMode {
  return x === 'soft' || x === 'mixed' || x === 'hard' || x === 'keep';
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
