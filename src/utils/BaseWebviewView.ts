import * as vscode from 'vscode';
import { generateNonce } from './webviewNonce';
import { safeFireAndForget } from './safeFireAndForget';

/**
 * Abstract base class for IntelliG `WebviewViewProvider`s.
 *
 * Centralizes the CSP + nonce + HTML-wrapping + disposal scaffolding that every
 * sidebar-style webview view needs. Mirrors the shape of {@link
 * import('./BaseWebviewPanel').BaseWebviewPanel} on the panel side, with the
 * difference that views are resolved by VS Code on demand via
 * {@link vscode.WebviewViewProvider.resolveWebviewView} rather than created
 * imperatively.
 *
 * ### Scope of ownership
 *
 * The base class owns:
 *   - Assigning `this._view` on resolve and clearing it on dispose.
 *   - Wiring `onDidReceiveMessage` to the subclass's {@link _handleMessage}.
 *   - Wiring `onDidDispose` to {@link dispose}, so teardown is idempotent.
 *   - Setting webview options (`enableScripts`, `localResourceRoots`).
 *   - Constructing the CSP header value — {@link _buildCsp} — with exactly the
 *     same directives as the panel base (default-src 'none'; nonce-bound
 *     script-src; whitelisted style/img/font-src against the webview's
 *     cspSource).
 *   - Generating the nonce via the shared {@link generateNonce} helper.
 *   - Producing the authoritative `<!DOCTYPE html>…</html>` wrapper
 *     ({@link _wrapHtml}) so subclasses can never drift on the CSP meta tag
 *     or the nonce-script binding.
 *   - Rendering — {@link _render} — with an idempotent, dispose-safe guard.
 *
 * Subclasses own:
 *   - State (tabs, repositories, selections).
 *   - The `{body, script}` tuple — {@link _getBodyParts} — that the template
 *     uses. `body` is the inner HTML; `script` is the inline JS body that the
 *     template will wrap in a nonced `<script>` tag.
 *   - Message dispatch — {@link _handleMessage}.
 *
 * ### Usage
 * ```ts
 * class MyView extends BaseWebviewView {
 *   constructor(extensionUri: vscode.Uri) { super(extensionUri); }
 *
 *   protected _getBodyParts() {
 *     return { body: '<div>hello</div>', script: 'console.log("ready")' };
 *   }
 *
 *   protected _handleMessage(msg: unknown) { … }
 * }
 * ```
 *
 * When the subclass needs to extend the resolve hook (e.g. to wire
 * `onDidChangeVisibility` or fire an initial-data event), it overrides
 * {@link _onResolve}; super's `resolveWebviewView` will call it after the
 * standard wiring.
 */
export abstract class BaseWebviewView implements vscode.WebviewViewProvider {
  /** Current webview view handle, or `undefined` when not resolved / disposed. */
  protected _view: vscode.WebviewView | undefined;

  /** Tracks teardown so repeated disposes + post-dispose renders no-op. */
  protected _disposed = false;

  /** Subclass + base-class disposables. Drained by {@link dispose}. */
  protected _disposables: vscode.Disposable[] = [];

  constructor(protected readonly _extensionUri: vscode.Uri) {}

  /**
   * Called by VS Code when the view becomes visible. Sets options, wires
   * message + dispose handlers, renders the initial HTML, then hands off to
   * {@link _onResolve} for subclass-specific wiring.
   */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.onDidReceiveMessage(
      (message: unknown) => {
        // A `void this._handleMessage(message)` used to silently swallow
        // async rejections here. Audit of subclass handlers
        // (CommitToolWindow._handleWebviewMessage and
        // GitToolWindowProvider._handleWebviewMessage) showed they each
        // internalise user-visible errors already (toasts surfaced from
        // within the handler + postMessage failure results), so a
        // handler-level reject is a bug signal rather than a direct
        // user-facing failure — log with context so it's grep-able in
        // the extension host output.
        try {
          safeFireAndForget(
            Promise.resolve(this._handleMessage(message)),
            'BaseWebviewView.resolveWebviewView: async _handleMessage rejection'
          );
        } catch (error) {
          // Defensive: a synchronously-thrown error from a handler must not
          // take down the host. safeFireAndForget only catches async
          // rejections — sync throws are handled here.
          console.error('BaseWebviewView: message handler threw', error);
        }
      },
      undefined,
      this._disposables
    );

    webviewView.onDidDispose(
      () => {
        // View-side dispose is cooperative — VS Code reclaims the webview but
        // leaves the provider alive. Tear down our own bookkeeping + clear
        // the handle; callers that re-resolve later get a fresh one.
        this._view = undefined;
      },
      undefined,
      this._disposables
    );

    this._render();

    this._onResolve(webviewView, _context, _token);
  }

  /**
   * Subclass hook called after the base class has wired the view but before
   * resolve returns. Default is no-op; overrides typically wire extra events
   * (visibility, focus) or fire an initial-data request.
   */
  protected _onResolve(
    _webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    // Default no-op.
  }

  /**
   * Subclass hook: return the current `{body, script}` tuple. The base class
   * wraps both in the authoritative CSP + nonce template. `body` is the
   * `<body>` inner HTML (subclasses may include their own `<style>` blocks
   * inside it); `script` is the inline JS body, injected as
   * `<script nonce="…">${script}</script>` at end-of-body.
   *
   * Subclasses that instead produce a full `<!DOCTYPE html>…</html>` document
   * on their own (for tests that assert against the complete envelope — see
   * {@link import('../services/gitToolWindow/GitToolWindowProvider').GitToolWindowProvider._getThreePanelHtmlContent})
   * may override {@link _render} directly and leave `_getBodyParts` unused.
   * The default returns an empty `{body, script}` to satisfy the contract.
   */
  protected _getBodyParts(): { body: string; script: string } {
    return { body: '', script: '' };
  }

  /**
   * Handle a message from the webview.
   *
   * Must not reject with user-facing errors — surface failures via toast
   * inside the handler. Rejections reaching the base class are
   * console-logged only (via `safeFireAndForget`) and will NOT produce
   * user-visible feedback.
   */
  protected abstract _handleMessage(message: unknown): void | Promise<void>;

  /**
   * Subclass hook: the `<title>` for the wrapper document. Most views leave
   * this as the default — the browser-style title is invisible for views
   * (VS Code owns the view's display title via the view contribution).
   */
  protected _getDocumentTitle(): string {
    return 'IntelliG';
  }

  /**
   * Render the current body + script into `_view.webview.html`. Idempotent —
   * a no-op after {@link dispose} or before the view has been resolved.
   */
  protected _render(): void {
    if (this._disposed) {
      return;
    }
    const view = this._view;
    if (!view) {
      return;
    }
    const { body, script } = this._getBodyParts();
    view.webview.html = this._wrapHtml(body, script);
  }

  /**
   * Generate a CSP nonce. Delegates to the shared {@link generateNonce} helper
   * so every IntelliG webview produces nonces with identical shape + entropy.
   */
  protected _getNonce(): string {
    return generateNonce();
  }

  /**
   * Build the Content-Security-Policy header value. Mirrors
   * {@link import('./BaseWebviewPanel').BaseWebviewPanel._buildCsp} exactly —
   * same directives, same order, same nonce binding, same `default-src 'none'`.
   */
  protected _buildCsp(nonce: string): string {
    const src = this._view?.webview.cspSource ?? '';
    return (
      `default-src 'none'; ` +
      `style-src ${src} 'unsafe-inline'; ` +
      `script-src 'nonce-${nonce}'; ` +
      `img-src ${src} data:; ` +
      `font-src ${src};`
    );
  }

  /**
   * Authoritative HTML document template. Emits the CSP meta tag, binds the
   * caller-supplied `script` to the nonce, and wraps `body` as-is. Subclasses
   * must not re-template the document — they produce `{body, script}` via
   * {@link _getBodyParts} and let this method stamp the envelope.
   */
  protected _wrapHtml(body: string, script: string): string {
    const nonce = this._getNonce();
    const csp = this._buildCsp(nonce);
    const title = this._getDocumentTitle();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>${escapeHtml(title)}</title>
</head>
<body>
${body}
<script nonce="${nonce}">${script}</script>
</body>
</html>`;
  }

  /**
   * Tear down listeners + clear the view handle. Idempotent.
   */
  public dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;

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

    this._view = undefined;
  }
}

/**
 * Escape HTML special characters for safe injection into attribute/text
 * positions. Module-private helper for the `<title>` tag.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
