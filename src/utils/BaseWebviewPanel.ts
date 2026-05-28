import * as vscode from 'vscode';
import { generateNonce } from './webviewNonce';
import { safeFireAndForget } from './safeFireAndForget';
import { getLogger } from './logger';

/**
 * Abstract base class for IntelliG webview panels.
 *
 * Centralizes the CSP + nonce + HTML scaffolding that every webview-based
 * dialog needs, following the pattern established by `CommitDialog`,
 * `RebaseEditor`, and `MergeView`. Subclasses implement `_getBodyHtml()` and
 * `_onMessage()`; optionally override `_getStyles()` for custom CSS.
 *
 * Usage:
 * ```ts
 * class MyDialog extends BaseWebviewPanel {
 *   constructor(ctx: vscode.ExtensionContext) {
 *     super(ctx, 'intellig.myDialog', 'My Dialog');
 *     this._render();
 *   }
 *   protected _getBodyHtml(): string { return '<div>hello</div>'; }
 *   protected _onMessage(msg: unknown): void { ... }
 * }
 * ```
 */
export abstract class BaseWebviewPanel {
  protected readonly _panel: vscode.WebviewPanel;
  protected readonly _disposables: vscode.Disposable[] = [];
  protected readonly _title: string;
  protected _disposed = false;

  constructor(
    protected readonly _context: vscode.ExtensionContext,
    viewType: string,
    title: string,
    column: vscode.ViewColumn = vscode.ViewColumn.One
  ) {
    this._title = title;
    this._panel = vscode.window.createWebviewPanel(viewType, title, column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [_context.extensionUri],
    });

    this._panel.webview.onDidReceiveMessage(
      (message: unknown) => {
        // Route async rejections through the shared helper so a subclass
        // handler that rejects (e.g. a failed `gitService.push()` awaited
        // inside PushDialog._onMessage) gets logged to the extension host
        // console instead of silently dropped. Subclass handlers
        // (PushDialog, MergeDialog, ResolveConflictsDialog, ResetDialog,
        // ApplyPatchDialog, NewBranchDialog) each surface user-visible
        // errors via toasts from inside their `_onMessage` implementations,
        // so a reject that reaches this layer is a bug signal rather than a
        // direct data-safety regression.
        //
        // Also guard against sync-throws. Mirrors BaseWebviewView's
        // pattern — a synchronously-thrown error from a future sync
        // `_onMessage` override must not take down the extension host.
        // `safeFireAndForget` only catches async rejections, so sync throws
        // need this outer try/catch.
        try {
          safeFireAndForget(
            Promise.resolve(this._onMessage(message)),
            `BaseWebviewPanel.onDidReceiveMessage: async _onMessage rejection [${viewType}]`
          );
        } catch (error) {
          getLogger()
            .child({ component: 'BaseWebviewPanel' })
            .error(
              '_onMessage threw synchronously',
              { viewType },
              error instanceof Error ? error : undefined
            );
        }
      },
      null,
      this._disposables
    );

    this._panel.onDidDispose(
      () => {
        this.dispose();
      },
      null,
      this._disposables
    );
  }

  /**
   * Reveal the panel.
   *
   * Note: this helper deliberately forces `ViewColumn.One` when the caller
   * omits `column`. VS Code's own `WebviewPanel.reveal` defaults to the
   * panel's current column, which is different — so don't assume the native
   * contract applies here. Pass an explicit column to override.
   */
  reveal(column?: vscode.ViewColumn): void {
    this._panel.reveal(column ?? vscode.ViewColumn.One);
  }

  /**
   * Post a message to the webview.
   */
  postMessage(message: unknown): Thenable<boolean> {
    return this._panel.webview.postMessage(message);
  }

  /**
   * Dispose the panel and all registered disposables. Idempotent.
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;

    this._panel.dispose();

    while (this._disposables.length > 0) {
      const d = this._disposables.pop();
      if (d) {
        try {
          d.dispose();
        } catch {
          // Swallow disposal errors so one bad disposable doesn't block cleanup.
        }
      }
    }
  }

  /**
   * Render the current body + styles into `_panel.webview.html`.
   * Subclasses call this after state changes that require a full HTML rebuild.
   */
  protected _render(): void {
    if (this._disposed) {
      return;
    }
    this._panel.webview.html = this._wrapHtml(this._getBodyHtml(), this._getStyles());
  }

  /**
   * Subclass hook: return the `<body>` inner HTML for the current state.
   */
  protected abstract _getBodyHtml(): string;

  /**
   * Handle a message from the webview.
   *
   * Must not reject with user-facing errors — surface failures via toast
   * inside the handler. Rejections reaching the base class are
   * console-logged only (via `safeFireAndForget`) and will NOT produce
   * user-visible feedback.
   */
  protected abstract _onMessage(message: unknown): void | Promise<void>;

  /**
   * Subclass hook: return CSS to inject into `<style>` in the document head.
   * Default is empty; override to provide dialog-specific styling.
   */
  protected _getStyles(): string {
    return '';
  }

  /**
   * Build the full HTML document around a body fragment, injecting the CSP
   * meta tag, title, optional styles, and a nonced sentinel script so CSP is
   * parsed without warnings.
   */
  protected _wrapHtml(body: string, extraStyles?: string): string {
    const nonce = this._getNonce();
    const csp = this._buildCsp(nonce);
    const styleBlock = extraStyles && extraStyles.length > 0 ? `<style>${extraStyles}</style>` : '';

    return `<!DOCTYPE html>
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
<script nonce="${nonce}"></script>
</body>
</html>`;
  }

  /**
   * Build the Content-Security-Policy header value. Matches the CSP used by
   * existing IntelliG webviews, extended with `img-src` and `font-src`
   * directives for dialogs that render icons or custom fonts.
   */
  protected _buildCsp(nonce: string): string {
    const src = this._panel.webview.cspSource;
    return (
      `default-src 'none'; ` +
      `style-src ${src} 'unsafe-inline'; ` +
      `script-src 'nonce-${nonce}'; ` +
      `img-src ${src} data:; ` +
      `font-src ${src};`
    );
  }

  /**
   * Generate a CSP nonce. Delegates to the shared {@link generateNonce}
   * helper in `utils/webviewNonce.ts` so every IntelliG webview produces
   * nonces with identical shape + entropy.
   */
  protected _getNonce(): string {
    return generateNonce();
  }
}

/**
 * Escape HTML special characters for safe injection into attribute/text
 * positions. Module-private helper for the title.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
