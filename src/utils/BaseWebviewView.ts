import * as vscode from 'vscode';
import { generateNonce } from './webviewNonce';
import { dispatchGuardedWebviewMessage } from './webviewMessageGuard';
import { escapeHtml } from './escapeHtml';
import { buildWebviewCsp } from './webviewCsp';

/**
 * Dispose and clear every disposable in the list, swallowing individual
 * disposal errors so one bad disposable doesn't block cleanup of the rest.
 * Shared by the per-resolve scoping here and per-attachment scopes elsewhere
 * (e.g. the git tool window's undocked-panel listeners).
 */
export function drainDisposables(disposables: vscode.Disposable[]): void {
  while (disposables.length > 0) {
    const d = disposables.pop();
    if (d) {
      try {
        d.dispose();
        // eslint-disable-next-line no-restricted-syntax -- swallow disposal errors so one bad disposable doesn't block cleanup of the rest; nothing actionable during cleanup (this drains both teardown and per-attachment detach scopes).
      } catch {
        // Swallow disposal errors so one bad disposable doesn't block cleanup.
      }
    }
  }
}

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
 *   - Constructing the CSP header value — {@link _buildCsp} — by delegating to
 *     the shared {@link import('./webviewCsp').buildWebviewCsp}, the single
 *     policy source for every IntelliG webview.
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
export abstract class BaseWebviewView<TOutbound = unknown> implements vscode.WebviewViewProvider {
  /** Current webview view handle, or `undefined` when not resolved / disposed. */
  protected _view: vscode.WebviewView | undefined;

  /** Tracks teardown so repeated disposes + post-dispose renders no-op. */
  protected _disposed = false;

  /** Provider-lifetime disposables (event emitters etc.). Drained by {@link dispose}. */
  protected _disposables: vscode.Disposable[] = [];

  /**
   * Disposables scoped to the CURRENT resolve cycle (message + dispose handlers,
   * and any per-resolve subclass listeners registered via
   * {@link _registerPerResolve}). Drained by the view's `onDidDispose` and by
   * {@link dispose}. A sidebar view that is hidden then re-shown is re-resolved,
   * so scoping these here — rather than the provider-lifetime {@link _disposables}
   * — keeps hide/show cycles from leaking a fresh set of listeners each time.
   */
  protected _perResolveDisposables: vscode.Disposable[] = [];

  constructor(protected readonly _extensionUri: vscode.Uri) {}

  /**
   * Register a disposable scoped to the current resolve cycle. Subclasses that
   * wire per-resolve listeners (e.g. `onDidChangeVisibility` in
   * {@link _onResolve}) MUST use this instead of pushing into
   * {@link _disposables}, so a hide→show re-resolve drains the previous cycle's
   * listeners rather than accumulating them for the provider's whole lifetime.
   */
  protected _registerPerResolve(disposable: vscode.Disposable): void {
    this._perResolveDisposables.push(disposable);
  }

  /** Dispose + clear every per-resolve disposable. Safe to call repeatedly. */
  private _drainPerResolve(): void {
    drainDisposables(this._perResolveDisposables);
  }

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
    // A re-resolve (sidebar hide→show) lands here again without necessarily an
    // intervening onDidDispose in every host; drain any stale per-resolve
    // listeners defensively so they can't accumulate.
    this._drainPerResolve();

    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    const messageSubscription = webviewView.webview.onDidReceiveMessage((message: unknown) => {
      // Log async rejections from `_handleMessage` rather than swallowing them.
      // Subclass handlers (CommitToolWindow._handleWebviewMessage and
      // GitToolWindowProvider._handleWebviewMessage) each internalise
      // user-visible errors already (toasts surfaced from within the handler +
      // postMessage failure results), so a handler-level reject is a bug signal
      // rather than a direct user-facing failure — log with context so it's
      // grep-able in the extension host output.
      dispatchGuardedWebviewMessage(() => this._handleMessage(message), {
        component: 'BaseWebviewView',
        rejectionLabel: 'BaseWebviewView.resolveWebviewView: async _handleMessage rejection',
        syncThrowMessage: 'message handler threw',
      });
    });
    this._perResolveDisposables.push(messageSubscription);

    const disposeSubscription = webviewView.onDidDispose(() => {
      // View-side dispose is cooperative — VS Code reclaims the webview but
      // leaves the provider alive. Tear down THIS resolve cycle's listeners
      // (so a later re-resolve doesn't accumulate them) + clear the handle;
      // callers that re-resolve later get a fresh one.
      this._view = undefined;
      this._drainPerResolve();
    });
    this._perResolveDisposables.push(disposeSubscription);

    this._renderOnResolve();

    this._onResolve(webviewView, _context, _token);
  }

  /**
   * Render hook invoked once at the end of {@link resolveWebviewView}. Default
   * is a plain {@link _render}. Subclasses whose `_render` drives hosts beyond
   * the resolving sidebar view (e.g. the git tool window's undocked panel)
   * override this to keep the resolve path from rewriting those other hosts —
   * so `_render` stays "rebuild content everywhere" and the resolve is the
   * special case.
   */
  protected _renderOnResolve(): void {
    this._render();
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
   * Subclass hook: when a bundle file name is returned, the view renders an
   * EXTERNAL `<script nonce src=media/webview/<name>>` tag (paired with an init
   * island the subclass bakes into its `body`) instead of the inline
   * `${script}` block. Ported views return their bundle basename (e.g.
   * `commitToolWindow.js`); legacy inline-script views leave the default
   * `undefined`. A view that overrides {@link _render} directly (e.g. the git
   * tool window provider, which builds its own document) is unaffected.
   */
  protected _getBundleName(): string | undefined {
    return undefined;
  }

  /**
   * Subclass hook: the `<title>` for the wrapper document. Most views leave
   * this as the default — the browser-style title is invisible for views
   * (VS Code owns the view's display title via the view contribution).
   */
  protected _getDocumentTitle(): string {
    return 'IntelliG';
  }

  /**
   * Post a message to the resolved webview. Typed to the view's declared
   * outbound union (`TOutbound`) so the host can only send on-contract messages;
   * subclasses that have not yet declared a protocol default to `unknown`. No-op
   * when the view is unresolved / disposed.
   */
  protected postMessage(message: TOutbound): void {
    void this._view?.webview.postMessage(message);
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
   * Build the Content-Security-Policy header value by delegating to the shared
   * {@link import('./webviewCsp').buildWebviewCsp} — the single policy source
   * every IntelliG webview binds to, so directives cannot drift between them.
   */
  protected _buildCsp(nonce: string): string {
    return buildWebviewCsp(this._view?.webview.cspSource ?? '', nonce);
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
${this._buildScriptTag(nonce, script)}
</body>
</html>`;
  }

  /**
   * The end-of-body script tag. An external bundle tag when
   * {@link _getBundleName} is set (nonce authorizes the external `src` exactly
   * as it does an inline block, so no CSP change is needed); otherwise the
   * inline `${script}` block the legacy inline-script views still use.
   */
  private _buildScriptTag(nonce: string, script: string): string {
    const bundle = this._getBundleName();
    if (bundle !== undefined) {
      const uri = this._view?.webview.asWebviewUri(
        vscode.Uri.joinPath(this._extensionUri, 'media', 'webview', bundle)
      );
      return `<script nonce="${nonce}" src="${uri?.toString() ?? ''}"></script>`;
    }
    return `<script nonce="${nonce}">${script}</script>`;
  }

  /**
   * Tear down listeners + clear the view handle. Idempotent.
   */
  public dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;

    this._drainPerResolve();
    drainDisposables(this._disposables);

    this._view = undefined;
  }
}
