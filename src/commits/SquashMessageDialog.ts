/**
 * Squash Message Dialog (Bug 5b).
 *
 * Multi-line modal dialog for editing the combined commit message
 * during a squash operation. Replaces the previous temp-file editor
 * (`_promptForSquashMessage`), which opened a separate VS Code
 * editor tab in `ViewColumn.Beside` — a UX that confused users
 * because it landed far from the IntelliG panel and didn't make it
 * obvious how to commit (save the file? close the tab?).
 *
 * This dialog hosts a textarea inside a webview panel, returns the
 * user's message via Promise, and matches IntelliJ's "Squash
 * Commits" dialog shape: native-feeling modal, Esc cancels,
 * Cmd/Ctrl+Enter submits.
 *
 * Production caller: {@link CommitContextMenuCommands._handleSquashCommits}.
 */

import * as vscode from 'vscode';
import { BaseWebviewPanel } from '../utils/BaseWebviewPanel';

interface ISquashMessageDialogMessage {
  type: 'submit' | 'cancel';
  message?: string;
}

const VIEW_TYPE = 'intellig.squashMessageDialog';
const TITLE = 'Squash Commits';

export class SquashMessageDialog extends BaseWebviewPanel {
  private readonly _seedMessage: string;
  private readonly _commitCount: number;
  private _resolve: ((value: string | undefined) => void) | undefined;
  private _resolved = false;

  constructor(
    context: vscode.ExtensionContext,
    options: { seedMessage: string; commitCount: number }
  ) {
    super(context, VIEW_TYPE, TITLE, vscode.ViewColumn.Active);
    this._seedMessage = options.seedMessage;
    this._commitCount = options.commitCount;
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
      // If the user closes the panel via the tab's X (or the host
      // disposes it for any reason), resolve with undefined so the
      // caller's `if (msg === undefined) return;` branch fires.
      this._panel.onDidDispose(
        () => {
          this._finish(undefined);
        },
        null,
        this._disposables
      );
      this._render();
      this._panel.reveal(vscode.ViewColumn.Active);
    });
  }

  private _finish(value: string | undefined): void {
    if (this._resolved) {
      return;
    }
    this._resolved = true;
    const r = this._resolve;
    this._resolve = undefined;
    if (r) {
      r(value);
    }
    // Dispose only once — onDidDispose feeds back into _finish via
    // the `undefined` path, which is a no-op because `_resolved` is
    // true.
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
    // Cross host→script data as a JSON island read by the script. JSON.stringify
    // alone does not escape `<`, so a seed containing `</script>` would close the
    // inline script tag early (the HTML parser ignores JS string context) and
    // inject the trailing markup. Unicode-escape `<`; the JS string decodes it
    // back to `<`, so the values are unchanged. Every dynamic value reaches the
    // DOM via `.value` / `.textContent` (injection-proof) — never HTML markup.
    const initJson = JSON.stringify({
      seedMessage: this._seedMessage,
      commitCount: this._commitCount,
      submitLabel: this._commitCount > 0 ? `Squash ${this._commitCount} commits` : 'Squash',
      isMac: onMacOS(),
    }).replace(/</g, '\\u003c');

    this._panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>${escapeHtml(TITLE)}</title>
  <style>${styles}</style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">
    (function() {
      const vscode = acquireVsCodeApi();
      const INIT = ${initJson};
      const root = document.getElementById('root');

      const el = (tag, props) => Object.assign(document.createElement(tag), props || {});

      const heading = el('h2', { textContent: 'Squash ' + INIT.commitCount + ' commits' });

      // Helper line with two <kbd> hints. Built from text nodes + elements so
      // no markup interpolation is needed.
      const helper = el('p', { className: 'helper' });
      helper.append(
        'Edit the combined commit message below. Press ',
        el('kbd', { textContent: (INIT.isMac ? 'Cmd' : 'Ctrl') + '+Enter' }),
        ' to squash, or ',
        el('kbd', { textContent: 'Esc' }),
        ' to cancel.'
      );

      const msgEl = el('textarea', { id: 'msg', spellcheck: false });
      msgEl.value = INIT.seedMessage;

      const actions = el('div', { className: 'actions' });
      const cancelBtn = el('button', {
        id: 'cancel-btn',
        type: 'button',
        className: 'secondary',
        textContent: 'Cancel',
      });
      const submitBtn = el('button', {
        id: 'submit-btn',
        type: 'button',
        textContent: INIT.submitLabel,
      });
      actions.append(cancelBtn, submitBtn);

      root.append(heading, helper, msgEl, actions);

      // Place caret at the end of the seed so the user can keep typing.
      msgEl.setSelectionRange(msgEl.value.length, msgEl.value.length);
      msgEl.focus();

      const submit = () => {
        vscode.postMessage({ type: 'submit', message: msgEl.value });
      };
      const cancel = () => {
        vscode.postMessage({ type: 'cancel' });
      };

      submitBtn.addEventListener('click', submit);
      cancelBtn.addEventListener('click', cancel);

      // Keyboard shortcuts:
      //   Cmd+Enter / Ctrl+Enter → submit (IntelliJ + git commit-template parity)
      //   Esc                    → cancel
      // Plain Enter inserts a newline (textarea default) so multi-line
      // composition works naturally.
      msgEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          submit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
        }
      });
      // Esc anywhere on the page also cancels.
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && document.activeElement !== msgEl) {
          e.preventDefault();
          cancel();
        }
      });
    })();
  </script>
</body>
</html>`;
  }

  // BaseWebviewPanel requires _getBodyHtml even though we override
  // _render. Return an empty body — _render builds the full document
  // directly so this is dead code in practice.
  protected _getBodyHtml(): string {
    return '';
  }

  protected _onMessage(raw: unknown): void {
    if (this._disposed || this._resolved) {
      return;
    }
    const msg = raw as ISquashMessageDialogMessage | undefined;
    if (!msg || typeof msg !== 'object') {
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
    }
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function onMacOS(): boolean {
  return process.platform === 'darwin';
}
