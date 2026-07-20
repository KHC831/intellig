/**
 * Define Remote dialog — IntelliJ's GitDefineRemoteDialog (git4idea
 * backend/src/remote/GitDefineRemoteDialog.kt) as a webview panel. Name and URL
 * are collected together with always-visible validation; OK runs the
 * `git ls-remote` reachability probe and, on failure, reports it IN the dialog
 * and stays open so the URL can be corrected.
 *
 * Used for both add and edit by the Configure Remotes flow, which owns the
 * actual git mutations (this dialog never spawns git itself — the probe is an
 * injected seam).
 */

import * as vscode from 'vscode';
import { BaseWebviewPanel } from '../utils/BaseWebviewPanel';
import { assertNever } from '../utils/assertNever';
import { escapeHtml } from '../utils/escapeHtml';
import { initIslandHtml } from '../utils/webviewInit';
import { sanitizeGitError } from '../git-core/gitError';
import { validateRemoteName, validateRemoteUrl } from './remoteValidation';
import {
  asDefineRemoteDialogInbound,
  type IDefineRemoteDialogInit,
  type IDefineRemoteRequest,
  type IDefineRemoteResult,
  type DefineRemoteDialogOutbound,
} from './defineRemoteDialog.protocol';

/** Construction options for {@link DefineRemoteDialog}. */
export interface IDefineRemoteDialogOptions {
  request: IDefineRemoteRequest;
  /**
   * URL reachability probe (`git ls-remote <url>`). Optional: without it the
   * dialog accepts a well-formed URL unverified.
   */
  probeUrl?: (url: string) => Promise<{ ok: boolean; message?: string }>;
}

const VIEW_TYPE = 'intellig.defineRemoteDialog';

export class DefineRemoteDialog extends BaseWebviewPanel<DefineRemoteDialogOutbound> {
  private readonly _request: IDefineRemoteRequest;
  private readonly _probeUrl: IDefineRemoteDialogOptions['probeUrl'];
  private _resolve: ((value: IDefineRemoteResult | undefined) => void) | undefined;
  private _resolved = false;
  private _probing = false;

  constructor(context: vscode.ExtensionContext, options: IDefineRemoteDialogOptions) {
    super(context, VIEW_TYPE, options.request.title, vscode.ViewColumn.Active);
    this._request = options.request;
    this._probeUrl = options.probeUrl;
  }

  /**
   * Open the dialog and resolve with the confirmed remote, or `undefined` on
   * cancel / close. Single-shot — resolution disposes the panel.
   */
  prompt(): Promise<IDefineRemoteResult | undefined> {
    if (this._resolve) {
      return Promise.resolve(undefined);
    }
    return new Promise<IDefineRemoteResult | undefined>((resolve) => {
      this._resolve = resolve;
      this._render();
      this._panel.reveal(vscode.ViewColumn.Active);
    });
  }

  /**
   * Settle the promise on any teardown, including the user closing the tab.
   * The base class drains `_disposables` from its own onDidDispose listener,
   * so a subscription registered there would be disposed mid-delivery and
   * never fire — resolving from dispose() is the reliable seam.
   */
  override dispose(): void {
    this._settle(undefined);
    super.dispose();
  }

  /** Resolve without tearing down (dispose drives teardown). */
  private _settle(value: IDefineRemoteResult | undefined): void {
    if (this._resolved) {
      return;
    }
    this._resolved = true;
    const r = this._resolve;
    this._resolve = undefined;
    if (r) {
      r(value);
    }
  }

  private _finish(value: IDefineRemoteResult | undefined): void {
    this._settle(value);
    this.dispose();
  }

  protected override _getStyles(): string {
    return `
      body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        padding: 16px 20px;
        font-size: var(--vscode-font-size);
        margin: 0;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .row label.block {
        flex: 0 0 60px;
      }
      .row input[type="text"] {
        flex: 1;
        padding: 4px 6px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent);
        font-family: var(--vscode-editor-font-family, monospace);
      }
      .row input:focus {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: -1px;
      }
      .field-error, .form-error {
        color: var(--vscode-inputValidation-errorForeground, var(--vscode-errorForeground));
        font-size: 0.9em;
        min-height: 1.2em;
        margin: 2px 0 6px 68px;
        white-space: pre-wrap;
      }
      .form-error { margin-left: 0; }
      label.checkbox {
        display: flex;
        align-items: center;
        gap: 6px;
        margin: 4px 0 8px;
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

  protected override _render(): void {
    if (this._disposed) {
      return;
    }
    const nonce = this._getNonce();
    const csp = this._buildCsp(nonce);
    const styles = this._getStyles();
    const bundleUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'media', 'webview', 'defineRemoteDialog.js')
    );

    this._panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>${escapeHtml(this._title)}</title>
  <style>${styles}</style>
</head>
<body>
  ${this._getBodyHtml()}
  <script nonce="${nonce}" src="${bundleUri.toString()}"></script>
</body>
</html>`;
  }

  protected _getBodyHtml(): string {
    const init: IDefineRemoteDialogInit = {
      name: this._request.name,
      url: this._request.url,
      existingNames: this._request.existingNames,
      originalName: this._request.originalName ?? null,
      fetch: true,
      submitLabel: this._request.originalName ? 'Save' : 'Add',
    };
    return `<div id="root"></div>${initIslandHtml(init)}`;
  }

  protected async _onMessage(raw: unknown): Promise<void> {
    if (this._disposed || this._resolved) {
      return;
    }
    const msg = asDefineRemoteDialogInbound(raw);
    if (!msg) {
      return;
    }
    switch (msg.type) {
      case 'cancel':
        this._finish(undefined);
        return;
      case 'submit':
        await this._handleSubmit({
          name: typeof msg.name === 'string' ? msg.name.trim() : '',
          url: typeof msg.url === 'string' ? msg.url.trim() : '',
          fetch: msg.fetch !== false,
        });
        return;
      default:
        assertNever(msg);
    }
  }

  /**
   * Verify the URL is reachable before resolving. A failed probe keeps the
   * dialog open with the sanitized git output shown inline, matching
   * GitDefineRemoteDialog.checkUrlAccess.
   */
  private async _handleSubmit(candidate: IDefineRemoteResult): Promise<void> {
    if (this._probing) {
      return;
    }
    // The webview validates for feedback, but it is a separate scripting
    // context: these values become git arguments, so the host re-checks them.
    const invalid =
      validateRemoteName(candidate.name, this._request.existingNames, this._request.originalName) ??
      validateRemoteUrl(candidate.url);
    if (invalid) {
      await this.postMessage({ type: 'error', message: invalid });
      return;
    }
    if (!this._probeUrl) {
      this._finish(candidate);
      return;
    }
    this._probing = true;
    await this.postMessage({ type: 'busy', busy: true });
    try {
      const probe = await this._probeUrl(candidate.url);
      if (probe.ok) {
        this._finish(candidate);
        return;
      }
      await this.postMessage({
        type: 'error',
        message: `Remote URL is not accessible: ${sanitizeGitError(probe.message ?? 'unknown error')}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      await this.postMessage({
        type: 'error',
        message: `Remote URL is not accessible: ${sanitizeGitError(message)}`,
      });
    } finally {
      this._probing = false;
    }
  }
}

/** Open the dialog and await the user's answer. */
export function showDefineRemoteDialog(
  context: vscode.ExtensionContext,
  options: IDefineRemoteDialogOptions
): Promise<IDefineRemoteResult | undefined> {
  return new DefineRemoteDialog(context, options).prompt();
}
