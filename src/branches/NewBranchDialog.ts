/**
 * New Branch Dialog (T3-03).
 *
 * IntelliJ-style "Create New Branch" modal. Replaces the
 * `showInputBox`-based flow with a webview panel (extends
 * {@link BaseWebviewPanel}) that exposes the full option surface:
 *
 *  - Name (text, validated via {@link validateNewBranchName}).
 *  - Start point (read-only, passed in via constructor or HEAD).
 *  - Track remote (checkbox; defaults to true when start point looks
 *    remote, e.g. `origin/main`).
 *  - Overwrite if exists (checkbox, default false; maps to `git branch -f` or
 *    `git checkout -B`).
 *  - Checkout after create (checkbox, default true).
 *  - Create + Cancel buttons.
 *
 * No destructive-op confirm — branch creation is recoverable via
 * `git branch -D` or reflog.
 */

import * as vscode from 'vscode';
import { BaseWebviewPanel } from '../utils/BaseWebviewPanel';
import { IGitService, IRepository } from '../git-core/interfaces/IGitService';
import { sanitizeGitError } from '../git-core/gitError';
import { getLogger } from '../utils/logger';

/** Options for constructing a {@link NewBranchDialog}. */
export interface INewBranchDialogOptions {
  repo: IRepository;
  gitService: IGitService;
  /** Start point (commit hash, branch, tag). Defaults to HEAD. */
  startPoint?: string;
  /** Default branch name to pre-fill. */
  defaultName?: string;
  /** Fired after a successful create (and checkout, when enabled). */
  onBranchCreated?: () => void;
}

/**
 * Validate a branch name. Matches the regex used by the existing
 * `validateBranchName` in extension.ts so behaviour stays consistent
 * across all entry points.
 *
 * Returns an error string when invalid, or `undefined` when valid.
 */
export function validateNewBranchName(value: string): string | undefined {
  if (!value || !value.trim()) {
    return 'Branch name cannot be empty';
  }
  // Security: reject leading `-` (git parses `-foo` as a CLI flag) and
  // leading `.` (invalid per git-check-ref-format).
  if (!/^(?![-.])[\w\-./]+$/.test(value)) {
    return 'Branch name contains invalid characters';
  }
  return undefined;
}

/**
 * Pure helper: does this start point look like a remote-tracking ref?
 * Matches `origin/main`, `upstream/feature/x`, etc. Used by the dialog
 * to default `--track` to checked when it would be useful.
 */
export function looksRemoteStartPoint(startPoint: string | undefined): boolean {
  if (!startPoint) {
    return false;
  }
  // Heuristic: one or more non-slash chars, then a slash, then anything.
  // Full refs like `refs/remotes/origin/main` also qualify.
  if (startPoint.startsWith('refs/remotes/')) {
    return true;
  }
  const slash = startPoint.indexOf('/');
  if (slash < 1 || slash === startPoint.length - 1) {
    return false;
  }
  // Exclude commit hashes (hex-only, no slash actually — the early check
  // catches those) and tag-like "v1.2.3" paths where the first segment
  // isn't a remote name. Best we can do without a getRemotes round-trip.
  const first = startPoint.substring(0, slash);
  if (/^[0-9a-f]{7,40}$/.test(first)) {
    return false;
  }
  return true;
}

/** Webview → extension message shape. */
interface INewBranchDialogMessage {
  type: 'create' | 'cancel';
  name?: string;
  track?: boolean;
  overwrite?: boolean;
  checkout?: boolean;
}

const VIEW_TYPE = 'intellig.newBranchDialog';
const TITLE = 'Create New Branch';

export class NewBranchDialog extends BaseWebviewPanel {
  private readonly _repo: IRepository;
  private readonly _gitService: IGitService;
  private readonly _startPoint: string | undefined;
  private readonly _startPointLabel: string;
  private readonly _defaultTrack: boolean;
  private readonly _defaultName: string;
  private readonly _onBranchCreated?: () => void;
  private _busy = false;

  constructor(context: vscode.ExtensionContext, options: INewBranchDialogOptions) {
    super(context, VIEW_TYPE, TITLE, vscode.ViewColumn.One);
    this._repo = options.repo;
    this._gitService = options.gitService;
    this._startPoint = options.startPoint;
    this._startPointLabel = options.startPoint ?? 'HEAD';
    this._defaultTrack = looksRemoteStartPoint(options.startPoint);
    this._defaultName = options.defaultName ?? '';
    this._onBranchCreated = options.onBranchCreated;
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
        margin-bottom: 12px;
        padding: 6px 10px;
        background: var(--vscode-editor-inactiveSelectionBackground);
        border-left: 3px solid var(--vscode-focusBorder);
        font-family: var(--vscode-editor-font-family, monospace);
      }
      .summary .label {
        color: var(--vscode-descriptionForeground);
        margin-right: 6px;
      }
      .field { margin-bottom: 12px; }
      .field label.top {
        display: block;
        margin-bottom: 4px;
        color: var(--vscode-descriptionForeground);
      }
      input[type=text] {
        width: 100%;
        box-sizing: border-box;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent);
        padding: 4px 6px;
        font-family: inherit;
        font-size: inherit;
      }
      .error {
        color: var(--vscode-errorForeground);
        font-size: 0.9em;
        margin-top: 4px;
        min-height: 1.1em;
      }
      .flags { display: flex; flex-direction: column; gap: 6px; margin: 12px 0; }
      label.flag {
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
      }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 12px;
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
      button:disabled { opacity: 0.55; cursor: not-allowed; }
    `;
  }

  protected _getBodyHtml(): string {
    return this._getBodyParts().body;
  }

  /**
   * Emit the body HTML and the interactive script separately. Used by
   * `_render` so it can splice the script into a nonced `<script>` block
   * without regex-extracting it from the body (LOW-1 — nested `</script>`
   * inside a string literal would break the old regex).
   */
  private _getBodyParts(): { body: string; script: string } {
    const body = `
      <div class="summary">
        <span class="label">Start point:</span>${escapeHtml(this._startPointLabel)}
      </div>

      <div class="field">
        <label class="top" for="branch-name">New branch name:</label>
        <input type="text" id="branch-name" value="${escapeHtml(this._defaultName)}"
               placeholder="feature/my-new-branch" autofocus />
        <div id="name-error" class="error"></div>
      </div>

      <div class="flags">
        <label class="flag">
          <input type="checkbox" id="flag-track" ${this._defaultTrack ? 'checked' : ''} />
          Track remote (<code>--track</code>)
        </label>
        <label class="flag">
          <input type="checkbox" id="flag-overwrite" />
          Overwrite if exists (<code>-f</code> / <code>-B</code>)
        </label>
        <label class="flag">
          <input type="checkbox" id="flag-checkout" checked />
          Checkout after create
        </label>
      </div>

      <div class="actions">
        <button id="cancel-btn" class="secondary" type="button">Cancel</button>
        <button id="create-btn" type="button">Create</button>
      </div>
    `;

    const script = `
      (function() {
        const vscode = acquireVsCodeApi();
        const nameEl = document.getElementById('branch-name');
        const errorEl = document.getElementById('name-error');

        const validate = () => {
          const v = nameEl.value;
          if (!v || !v.trim()) return 'Branch name cannot be empty';
          // Mirror validateNewBranchName: reject leading '-' / '.'.
          if (!/^(?![-.])[\\w\\-.\\/]+$/.test(v)) return 'Branch name contains invalid characters';
          return '';
        };

        nameEl.addEventListener('input', () => {
          errorEl.textContent = validate();
        });

        document.getElementById('create-btn').addEventListener('click', () => {
          const err = validate();
          if (err) {
            errorEl.textContent = err;
            nameEl.focus();
            return;
          }
          vscode.postMessage({
            type: 'create',
            name: nameEl.value.trim(),
            track: document.getElementById('flag-track').checked,
            overwrite: document.getElementById('flag-overwrite').checked,
            checkout: document.getElementById('flag-checkout').checked,
          });
        });
        document.getElementById('cancel-btn').addEventListener('click', () => {
          vscode.postMessage({ type: 'cancel' });
        });
        nameEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            document.getElementById('create-btn').click();
          }
        });

        // Dialog keyboard contract (spec 5.1 — shared across all dialogs):
        //   Cmd+Enter / Ctrl+Enter → primary action (Create)
        //   Esc                    → cancel
        // Plain Enter on the single-line name field already submits (above);
        // this adds the modified-Enter alias and the page-wide Esc handler.
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            document.getElementById('create-btn').click();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            document.getElementById('cancel-btn').click();
          }
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
    const msg = raw as INewBranchDialogMessage | undefined;
    if (!msg || typeof msg !== 'object') {
      return;
    }
    switch (msg.type) {
      case 'cancel':
        this.dispose();
        return;
      case 'create':
        await this._executeCreate({
          name: msg.name ?? '',
          track: msg.track === true,
          overwrite: msg.overwrite === true,
          checkout: msg.checkout === true,
        });
        return;
    }
  }

  private async _executeCreate(params: {
    name: string;
    track: boolean;
    overwrite: boolean;
    checkout: boolean;
  }): Promise<void> {
    const error = validateNewBranchName(params.name);
    if (error) {
      void vscode.window.showErrorMessage(error);
      return;
    }
    this._busy = true;
    try {
      await this._gitService.createBranch(this._repo, params.name, {
        startPoint: this._startPoint,
        force: params.overwrite,
        track: params.track,
        checkout: params.checkout,
      });
      const verb = params.checkout ? 'Created and switched to' : 'Created';
      void vscode.window.showInformationMessage(`${verb} branch '${params.name}'`);
      if (this._onBranchCreated) {
        try {
          this._onBranchCreated();
        } catch (err) {
          getLogger()
            .child({ component: 'NewBranchDialog' })
            .error('onBranchCreated threw', err instanceof Error ? err : undefined);
        }
      }
      this.dispose();
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to create branch: ${sanitizeGitError(msg)}`);
      this._busy = false;
    }
  }
}

/**
 * Convenience factory.
 */
export function showNewBranchDialog(
  context: vscode.ExtensionContext,
  options: INewBranchDialogOptions
): NewBranchDialog {
  return new NewBranchDialog(context, options);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
