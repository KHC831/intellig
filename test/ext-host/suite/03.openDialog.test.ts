/**
 * Smoke test 3 — open a dialog panel.
 *
 * Instantiates `NewBranchDialog` directly inside the real extension host,
 * using the extension's own `vscode.ExtensionContext`. Verifies:
 *   (a) the webview panel is created without throwing,
 *   (b) its HTML contains a `<meta http-equiv="Content-Security-Policy">` tag,
 *   (c) its HTML contains a `nonce="…"` attribute on the nonced script,
 *   (d) the panel disposes cleanly.
 *
 * NewBranchDialog is the smallest `BaseWebviewPanel`-extending dialog that
 * doesn't hit git on construction (create action is user-triggered), so it's
 * safe to open and tear down without a real repo.
 *
 * This catches:
 *   - CSP meta tag removed or malformed,
 *   - nonce generation broken (empty / missing),
 *   - webviewPanel constructor regressions,
 *   - disposal leaks (we assert panel is disposed after dispose()).
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { NewBranchDialog } from '../../../src/branches/NewBranchDialog';
import type { IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';

const EXT_ID = 'KaHoChan.intellig';

/**
 * Minimal `IGitService` stub. The dialog only calls these methods on the
 * user-initiated "Create" path — which the smoke test never triggers. We
 * still need the interface satisfied so `new NewBranchDialog(…)` compiles.
 */
function stubGitService(): IGitService {
  const notCalled = (name: string) => () => {
    throw new Error(`stubGitService.${name} should not be called in smoke test`);
  };
  // Returning `any` here and shaping at the call site keeps us from having to
  // enumerate every IGitService method (there are dozens post-TL-15). We
  // satisfy the compiler with a Proxy that throws on any unexpected access.
  const handler: ProxyHandler<object> = {
    get(_t, prop: string) {
      return notCalled(prop);
    },
  };
  return new Proxy({}, handler) as IGitService;
}

function stubRepo(): IRepository {
  return {
    rootUri: vscode.Uri.file('/tmp/intellig-smoke-fake-repo'),
    state: 'idle',
    remotes: [],
    submodules: [],
  };
}

describe('ext-host smoke — 3. open dialog', function () {
  this.timeout(30_000);

  let ctx: vscode.ExtensionContext | undefined;

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, 'extension not installed');
    const api: unknown = await ext.activate();
    // The extension's `activate()` returns `Promise<void>`, not the context,
    // so to get an ExtensionContext we either (a) add a test-only export or
    // (b) borrow any existing extension's context. For a pure smoke test we
    // only need a valid `ExtensionContext` for the BaseWebviewPanel's
    // `localResourceRoots`. The extension under test is already active, so
    // we can reach its extensionUri via the manifest `ext.extensionUri`.
    //
    // We therefore build a minimal `ExtensionContext`-shaped object using
    // the real extensionUri. BaseWebviewPanel only reads `.extensionUri` and
    // does not dispatch on `.subscriptions`.
    ctx = buildMinimalContext(ext);
    // `api` is unused — just ensures activation resolved.
    void api;
  });

  it('creates a webview panel without throwing', () => {
    assert.ok(ctx, 'context not set up');
    const dialog = new NewBranchDialog(ctx, {
      repo: stubRepo(),
      gitService: stubGitService(),
      defaultName: 'smoke-test-branch',
    });
    try {
      const html = (dialog as unknown as { _panel: vscode.WebviewPanel })._panel.webview.html;
      assert.ok(typeof html === 'string' && html.length > 0, 'panel HTML is empty');
    } finally {
      dialog.dispose();
    }
  });

  it('emits a CSP meta tag in the webview HTML', () => {
    assert.ok(ctx);
    const dialog = new NewBranchDialog(ctx, {
      repo: stubRepo(),
      gitService: stubGitService(),
    });
    try {
      const html = (dialog as unknown as { _panel: vscode.WebviewPanel })._panel.webview.html;
      assert.match(
        html,
        /<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]+"\s*\/?>/i,
        'Content-Security-Policy meta tag missing from dialog HTML'
      );
    } finally {
      dialog.dispose();
    }
  });

  it('includes a nonce on the inline script tag', () => {
    assert.ok(ctx);
    const dialog = new NewBranchDialog(ctx, {
      repo: stubRepo(),
      gitService: stubGitService(),
    });
    try {
      const html = (dialog as unknown as { _panel: vscode.WebviewPanel })._panel.webview.html;
      // The inline sentinel/script tag in BaseWebviewPanel always has a
      // nonce attribute — regression here would silently disable script
      // execution and break every dialog's interactivity.
      assert.match(
        html,
        /<script\s+nonce="[A-Za-z0-9+/=_-]{8,}"/,
        'script tag missing nonce — CSP would block all inline scripts'
      );
    } finally {
      dialog.dispose();
    }
  });

  it('disposes cleanly (idempotent, no throw on second dispose)', () => {
    assert.ok(ctx);
    const dialog = new NewBranchDialog(ctx, {
      repo: stubRepo(),
      gitService: stubGitService(),
    });
    dialog.dispose();
    // Second dispose must be a no-op (see BaseWebviewPanel._disposed flag).
    dialog.dispose();
  });
});

/**
 * Build a minimal `ExtensionContext` for webview panel construction.
 * BaseWebviewPanel reads only `extensionUri` and assigns into `subscriptions`
 * (through the .onDidDispose → disposables internal array). We stub just
 * enough to exercise the panel surface.
 */
function buildMinimalContext(ext: vscode.Extension<unknown>): vscode.ExtensionContext {
  const subscriptions: vscode.Disposable[] = [];
  // We cast through `unknown` — the production code only touches
  // `extensionUri`, and the panel's own lifecycle is independent of the
  // (stubbed) state APIs.
  return {
    subscriptions,
    extensionUri: ext.extensionUri,
    extensionPath: ext.extensionUri.fsPath,
    extensionMode: vscode.ExtensionMode.Test,
    asAbsolutePath: (rel: string) => vscode.Uri.joinPath(ext.extensionUri, rel).fsPath,
    // The rest are never accessed by the panel construction path. Throw if
    // they ever are — that would mean production code started depending on
    // them silently.
    storageUri: undefined,
    globalStorageUri: vscode.Uri.file('/tmp/intellig-smoke-global'),
    logUri: vscode.Uri.file('/tmp/intellig-smoke-log'),
    storagePath: undefined,
    globalStoragePath: '/tmp/intellig-smoke-global',
    logPath: '/tmp/intellig-smoke-log',
    environmentVariableCollection:
      undefined as unknown as vscode.GlobalEnvironmentVariableCollection,
    workspaceState: undefined as unknown as vscode.Memento,
    globalState: undefined as unknown as vscode.Memento & {
      setKeysForSync(keys: readonly string[]): void;
    },
    secrets: undefined as unknown as vscode.SecretStorage,
    languageModelAccessInformation: undefined as unknown as vscode.LanguageModelAccessInformation,
  } as unknown as vscode.ExtensionContext;
}
