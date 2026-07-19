import * as vscode from 'vscode';
import { generateNonce } from './webviewNonce';
import { dispatchGuardedWebviewMessage } from './webviewMessageGuard';
import { escapeHtml } from './escapeHtml';
import { buildWebviewCsp } from './webviewCsp';

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
export abstract class BaseWebviewPanel<TOutbound = unknown> {
  protected readonly _panel: vscode.WebviewPanel;
  protected readonly _disposables: vscode.Disposable[] = [];
  protected readonly _title: string;
  protected _disposed = false;
  private readonly _onDidDisposeEmitter = new vscode.EventEmitter<void>();

  /**
   * Fires exactly once when the panel is disposed — whether the user closed
   * the tab or `dispose()` was called programmatically. Lets an owner that
   * keys panels by resource (e.g. one merge window per file) drop its
   * registry entry.
   */
  readonly onDidDispose: vscode.Event<void> = this._onDidDisposeEmitter.event;

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
        dispatchGuardedWebviewMessage(() => this._onMessage(message), {
          component: 'BaseWebviewPanel',
          rejectionLabel: `BaseWebviewPanel.onDidReceiveMessage: async _onMessage rejection [${viewType}]`,
          syncThrowMessage: '_onMessage threw synchronously',
          context: { viewType },
        });
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
   * Post a message to the webview. Typed to the panel's declared outbound union
   * (`TOutbound`) so the host can only send on-contract messages; subclasses
   * that have not yet declared a protocol default to `unknown`.
   *
   * Resolves `false` once the panel is disposed — await-then-post paths (a
   * modal, an awaited network call) can complete after the user closed the
   * tab, and the delivery result lets those callers skip their failure toast.
   */
  postMessage(message: TOutbound): Thenable<boolean> {
    if (this._disposed) {
      return Promise.resolve(false);
    }
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
          // eslint-disable-next-line no-restricted-syntax -- swallow disposal errors so one bad disposable doesn't block cleanup of the rest; nothing actionable during teardown.
        } catch {
          // Swallow disposal errors so one bad disposable doesn't block cleanup.
        }
      }
    }

    this._onDidDisposeEmitter.fire();
    this._onDidDisposeEmitter.dispose();
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
   * Build the Content-Security-Policy header value from the shared directive
   * set so every IntelliG webview carries an identical policy.
   */
  protected _buildCsp(nonce: string): string {
    return buildWebviewCsp(this._panel.webview.cspSource, nonce);
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
