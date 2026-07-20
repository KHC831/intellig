/**
 * Commit Message Dialog.
 *
 * Multi-line modal dialog for editing a commit message — used both when
 * combining messages during a squash and when rewording / editing an existing
 * commit's message. Replaces the single-line `showInputBox` affordance, which
 * rendered (and saved) multi-line messages as one literal line — collapsing a
 * subject + body into a single subject.
 *
 * The dialog hosts a textarea inside a webview panel, returns the user's
 * message via Promise, and matches IntelliJ's commit-message dialog shape:
 * native-feeling modal, Esc cancels, Cmd/Ctrl+Enter submits, plain Enter
 * inserts a newline so subject/body composition works naturally.
 *
 * Callers: {@link CommitContextMenuCommands._handleSquashCommits} (via
 * {@link SquashMessageDialog}) and `_handleEditCommitMessage` (reword).
 */

import * as vscode from 'vscode';
import { BaseWebviewPanel } from '../utils/BaseWebviewPanel';
import { assertNever } from '../utils/assertNever';
import {
  asCommitMessageDialogInbound,
  type ICommitMessageDialogInit,
  type CommitMessageDialogOutbound,
} from './commitMessageDialog.protocol';
import { initIslandHtml } from '../utils/webviewInit';
import { escapeHtml } from '../utils/escapeHtml';

/** Presentation + identity for one dialog instance. */
export interface ICommitMessageDialogOptions {
  /** Initial textarea content (the seed message). */
  seedMessage: string;
  /** Unique webview view type. */
  viewType: string;
  /** Tab/window title. */
  title: string;
  /** Heading shown above the textarea. */
  heading: string;
  /** Submit button label. */
  submitLabel: string;
  /** Verb in the keyboard-hint helper line ("Press Cmd+Enter to <verb>"). */
  submitVerb: string;
}

export class CommitMessageDialog extends BaseWebviewPanel<CommitMessageDialogOutbound> {
  private readonly _seedMessage: string;
  private readonly _heading: string;
  private readonly _submitLabel: string;
  private readonly _submitVerb: string;
  private _resolve: ((value: string | undefined) => void) | undefined;
  private _resolved = false;

  constructor(context: vscode.ExtensionContext, options: ICommitMessageDialogOptions) {
    super(context, options.viewType, options.title, vscode.ViewColumn.Active);
    this._seedMessage = options.seedMessage;
    this._heading = options.heading;
    this._submitLabel = options.submitLabel;
    this._submitVerb = options.submitVerb;
  }

  /**
   * Open the dialog and resolve to the user's message on submit, or
   * `undefined` on cancel / dispose. Single-shot — the caller awaits
   * this Promise to get the message and then disposes the dialog
   * automatically (resolution disposes the panel).
   */
  prompt(): Promise<string | undefined> {
    if (this._resolve) {
      return Promise.resolve(undefined);
    }
    return new Promise<string | undefined>((resolve) => {
      this._resolve = resolve;
      this._render();
      this._panel.reveal(vscode.ViewColumn.Active);
    });
  }

  /**
   * Settle the promise on any teardown, including the user closing the tab
   * via the X. The base class drains `_disposables` from its own
   * onDidDispose listener, so a subscription registered there would be
   * disposed mid-delivery and never fire — resolving from dispose() is the
   * reliable seam.
   */
  override dispose(): void {
    this._settle(undefined);
    super.dispose();
  }

  /** Resolve without tearing down (dispose drives teardown). */
  private _settle(value: string | undefined): void {
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

  private _finish(value: string | undefined): void {
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
      h2 {
        margin: 0 0 8px;
        font-size: 1.1em;
        font-weight: 600;
      }
      .helper {
        color: var(--vscode-descriptionForeground);
        font-size: 0.9em;
        margin-bottom: 12px;
      }
      textarea {
        width: 100%;
        box-sizing: border-box;
        min-height: 240px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent);
        padding: 8px 10px;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: var(--vscode-editor-font-size, inherit);
        line-height: 1.5;
        resize: vertical;
      }
      textarea:focus {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: -1px;
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
      kbd {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 0.85em;
        background: var(--vscode-keybindingLabel-background, var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.18)));
        border: 1px solid var(--vscode-keybindingLabel-border, transparent);
        border-radius: 3px;
        padding: 1px 4px;
      }
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
      vscode.Uri.joinPath(this._context.extensionUri, 'media', 'webview', 'commitMessageDialog.js')
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

  // The body carries an empty mount point + the init island the bundled entry
  // (src/commits/webview/commitMessageDialog.ts) reads on boot.
  protected _getBodyHtml(): string {
    const init: ICommitMessageDialogInit = {
      seedMessage: this._seedMessage,
      heading: this._heading,
      submitLabel: this._submitLabel,
      submitVerb: this._submitVerb,
      isMac: onMacOS(),
    };
    return `<div id="root"></div>${initIslandHtml(init)}`;
  }

  protected _onMessage(raw: unknown): void {
    if (this._disposed || this._resolved) {
      return;
    }
    const msg = asCommitMessageDialogInbound(raw);
    if (!msg) {
      return;
    }
    switch (msg.type) {
      case 'submit': {
        const message = typeof msg.message === 'string' ? msg.message : '';
        // Empty message = cancel (matching the temp-file dialog's
        // close-without-content semantics).
        const trimmed = message.trim();
        this._finish(trimmed.length > 0 ? message : undefined);
        return;
      }
      case 'cancel':
        this._finish(undefined);
        return;
      default:
        assertNever(msg);
    }
  }
}

function onMacOS(): boolean {
  return process.platform === 'darwin';
}
