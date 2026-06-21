/**
 * Unit tests for `BaseWebviewView` (src/utils/BaseWebviewView.ts).
 *
 * Covers:
 * - Nonce uniqueness, length, and base64url charset.
 * - CSP construction — contains every directive the panel base emits, in the
 *   same nonce-bound shape.
 * - `_wrapHtml` composes `{body, script}` correctly (body appears, script
 *   lives inside the one and only `<script nonce="…">…</script>` tag).
 * - `_render()` is idempotent and no-ops before resolve / after dispose.
 * - Disposal idempotency + clears `_view`.
 *
 * The tests drive a `TestView` concrete subclass. Because VS Code's
 * `WebviewView` cannot be constructed directly, the tests build a minimal
 * `WebviewView`-shaped fake (enough to satisfy `resolveWebviewView`).
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { BaseWebviewView } from '../../../src/utils/BaseWebviewView';
import { EventEmitter, Uri } from '../../mocks/vscode';

/**
 * Concrete subclass for testing. Exposes protected hooks via public wrappers
 * and lets tests swap the `{body, script}` tuple between render calls.
 */
class TestView extends BaseWebviewView {
  public bodyParts: { body: string; script: string } = {
    body: '<div>hello</div>',
    script: 'console.log("ok")',
  };
  public messagesReceived: unknown[] = [];
  public onResolveInvocations = 0;

  protected override _getBodyParts(): { body: string; script: string } {
    return this.bodyParts;
  }

  protected _handleMessage(message: unknown): void {
    this.messagesReceived.push(message);
  }

  protected override _onResolve(): void {
    this.onResolveInvocations++;
  }

  // Test accessors --------------------------------------------------------
  public callGetNonce(): string {
    return this._getNonce();
  }

  public callBuildCsp(nonce: string): string {
    return this._buildCsp(nonce);
  }

  public callWrapHtml(body: string, script: string): string {
    return this._wrapHtml(body, script);
  }

  public callRender(): void {
    this._render();
  }

  public getView(): vscode.WebviewView | undefined {
    return this._view;
  }

  public getDisposed(): boolean {
    return this._disposed;
  }
}

interface FakeWebview {
  html: string;
  options: vscode.WebviewOptions;
  cspSource: string;
  onDidReceiveMessage: vscode.Event<unknown>;
  postMessage: (message: unknown) => Thenable<boolean>;
  asWebviewUri: (localResource: vscode.Uri) => vscode.Uri;
  _messageEmitter: EventEmitter<unknown>;
  _posted: unknown[];
}

interface FakeView {
  webview: FakeWebview;
  visible: boolean;
  onDidChangeVisibility: vscode.Event<void>;
  onDidDispose: vscode.Event<void>;
  _visibilityEmitter: EventEmitter<void>;
  _disposeEmitter: EventEmitter<void>;
  show?: (preserveFocus?: boolean) => void;
}

function makeFakeView(): FakeView {
  const messageEmitter = new EventEmitter<unknown>();
  const visibilityEmitter = new EventEmitter<void>();
  const disposeEmitter = new EventEmitter<void>();
  const posted: unknown[] = [];

  const webview: FakeWebview = {
    html: '',
    options: {},
    cspSource: 'vscode-webview://mock',
    onDidReceiveMessage: messageEmitter.event,
    postMessage: (m: unknown): Promise<boolean> => {
      posted.push(m);
      return Promise.resolve(true);
    },
    asWebviewUri: (localResource: vscode.Uri): vscode.Uri => localResource,
    _messageEmitter: messageEmitter,
    _posted: posted,
  };

  return {
    webview,
    visible: true,
    onDidChangeVisibility: visibilityEmitter.event,
    onDidDispose: disposeEmitter.event,
    _visibilityEmitter: visibilityEmitter,
    _disposeEmitter: disposeEmitter,
  };
}

describe('BaseWebviewView', () => {
  describe('nonce', () => {
    it('produces unique nonces across many calls', () => {
      const view = new TestView(Uri.file('/ext'));
      try {
        const seen = new Set<string>();
        for (let i = 0; i < 100; i++) {
          seen.add(view.callGetNonce());
        }
        assert.strictEqual(seen.size, 100, 'all 100 nonces should be unique');
      } finally {
        view.dispose();
      }
    });

    it('produces nonces of base64url-encoded 16-byte length (22 chars, no padding)', () => {
      const view = new TestView(Uri.file('/ext'));
      try {
        for (let i = 0; i < 10; i++) {
          const nonce = view.callGetNonce();
          assert.strictEqual(nonce.length, 22);
        }
      } finally {
        view.dispose();
      }
    });

    it('produces nonces from the base64url alphabet (A-Z a-z 0-9 - _)', () => {
      const view = new TestView(Uri.file('/ext'));
      try {
        const pattern = /^[A-Za-z0-9_-]{22}$/;
        for (let i = 0; i < 10; i++) {
          const nonce = view.callGetNonce();
          assert.ok(pattern.test(nonce), `nonce "${nonce}" should match /^[A-Za-z0-9_-]{22}$/`);
        }
      } finally {
        view.dispose();
      }
    });
  });

  describe('_buildCsp', () => {
    it('includes every directive the BaseWebviewPanel CSP emits, with the nonce bound to script-src', () => {
      const view = new TestView(Uri.file('/ext'));
      // After resolve, cspSource is filled in from the webview.
      const fake = makeFakeView();
      view.resolveWebviewView(
        fake as unknown as vscode.WebviewView,
        {} as vscode.WebviewViewResolveContext,
        {} as vscode.CancellationToken
      );
      try {
        const csp = view.callBuildCsp('abc123');
        assert.ok(csp.includes("default-src 'none'"), 'CSP should include default-src none');
        assert.ok(csp.includes("'nonce-abc123'"), 'CSP should include the nonce');
        assert.ok(csp.includes('script-src'), 'CSP should include script-src');
        assert.ok(csp.includes('style-src'), 'CSP should include style-src');
        assert.ok(csp.includes('img-src'), 'CSP should include img-src');
        assert.ok(csp.includes('font-src'), 'CSP should include font-src');
        // Match the panel-base shape — script-src binds ONLY the nonce (no
        // unsafe-inline / unsafe-eval / wildcards).
        assert.ok(
          /script-src 'nonce-abc123';/.test(csp),
          `script-src should be nonce-only; got: ${csp}`
        );
        // default-src 'none' should be the first directive (matches panel).
        assert.ok(
          csp.trimStart().startsWith("default-src 'none'"),
          `CSP should start with default-src 'none'; got: ${csp}`
        );
      } finally {
        view.dispose();
      }
    });

    it('returns an empty cspSource substitution before the view is resolved', () => {
      const view = new TestView(Uri.file('/ext'));
      try {
        const csp = view.callBuildCsp('n');
        // cspSource falls back to '' — nothing should throw.
        assert.ok(csp.includes("default-src 'none'"));
        assert.ok(csp.includes("'nonce-n'"));
      } finally {
        view.dispose();
      }
    });
  });

  describe('_wrapHtml / _render', () => {
    it('composes body + script with exactly one nonced <script> tag', () => {
      const view = new TestView(Uri.file('/ext'));
      try {
        const html = view.callWrapHtml('<p>body</p>', 'console.log("s")');
        const scriptMatches = html.match(/<script nonce="[^"]+">/g);
        assert.ok(scriptMatches, 'HTML should contain a nonced <script> tag');
        assert.strictEqual(
          scriptMatches.length,
          1,
          `expected exactly one nonced <script>, got ${scriptMatches.length}`
        );
        assert.ok(html.includes('<p>body</p>'), 'HTML should include the body fragment');
        assert.ok(html.includes('console.log("s")'), 'HTML should include the script body');
      } finally {
        view.dispose();
      }
    });

    it('binds the CSP meta nonce to the same nonce on the <script> tag', () => {
      const view = new TestView(Uri.file('/ext'));
      try {
        const html = view.callWrapHtml('<p>b</p>', 's');
        const cspMatch = html.match(/'nonce-([A-Za-z0-9_-]{22})'/);
        assert.ok(cspMatch, 'CSP meta should contain a 22-char base64url nonce');
        const nonce = cspMatch[1];
        assert.ok(
          html.includes(`<script nonce="${nonce}">`),
          'script tag should carry the same nonce as the CSP meta'
        );
      } finally {
        view.dispose();
      }
    });

    it('_getBodyParts() return is composed into the rendered document', () => {
      const view = new TestView(Uri.file('/ext'));
      view.bodyParts = { body: '<main>stuff</main>', script: 'var x=1;' };

      const fake = makeFakeView();
      view.resolveWebviewView(
        fake as unknown as vscode.WebviewView,
        {} as vscode.WebviewViewResolveContext,
        {} as vscode.CancellationToken
      );
      try {
        const rendered = fake.webview.html;
        assert.ok(rendered.startsWith('<!DOCTYPE html>'), 'html should start with doctype');
        assert.ok(
          rendered.includes('<main>stuff</main>'),
          'body should be composed into the document'
        );
        assert.ok(rendered.includes('var x=1;'), 'script should be composed into the document');
      } finally {
        view.dispose();
      }
    });

    it('_render() is idempotent — two renders produce the same HTML shape (modulo nonce)', () => {
      const view = new TestView(Uri.file('/ext'));
      const fake = makeFakeView();
      view.resolveWebviewView(
        fake as unknown as vscode.WebviewView,
        {} as vscode.WebviewViewResolveContext,
        {} as vscode.CancellationToken
      );
      try {
        view.callRender();
        const html1 = fake.webview.html;
        view.callRender();
        const html2 = fake.webview.html;

        const stripNonce = (h: string): string =>
          h
            .replace(/nonce="[A-Za-z0-9_-]{22}"/g, 'nonce="X"')
            .replace(/'nonce-[A-Za-z0-9_-]{22}'/g, "'nonce-X'");
        assert.strictEqual(stripNonce(html1), stripNonce(html2));
      } finally {
        view.dispose();
      }
    });

    it('_render() no-ops before the view is resolved', () => {
      const view = new TestView(Uri.file('/ext'));
      try {
        // Must not throw even though there is no _view.
        assert.doesNotThrow(() => view.callRender());
      } finally {
        view.dispose();
      }
    });

    it('_render() no-ops after dispose', () => {
      const view = new TestView(Uri.file('/ext'));
      const fake = makeFakeView();
      view.resolveWebviewView(
        fake as unknown as vscode.WebviewView,
        {} as vscode.WebviewViewResolveContext,
        {} as vscode.CancellationToken
      );
      view.dispose();
      // The last assigned html is from the initial resolve render; subsequent
      // renders must be a no-op. Change bodyParts so any accidental render
      // would stamp the difference onto `fake.webview.html`.
      const beforeSecondRender = fake.webview.html;
      view.bodyParts = { body: '<p>LATER</p>', script: '' };
      assert.doesNotThrow(() => view.callRender());
      assert.strictEqual(fake.webview.html, beforeSecondRender);
      assert.ok(!fake.webview.html.includes('LATER'));
    });
  });

  describe('resolveWebviewView', () => {
    it('assigns _view and sets enableScripts + localResourceRoots on the webview', () => {
      const extensionUri = Uri.file('/ext');
      const view = new TestView(extensionUri);
      const fake = makeFakeView();
      view.resolveWebviewView(
        fake as unknown as vscode.WebviewView,
        {} as vscode.WebviewViewResolveContext,
        {} as vscode.CancellationToken
      );
      try {
        assert.strictEqual(view.getView(), fake);
        assert.strictEqual(fake.webview.options.enableScripts, true);
        assert.deepStrictEqual(fake.webview.options.localResourceRoots, [extensionUri]);
      } finally {
        view.dispose();
      }
    });

    it('routes incoming webview messages through _handleMessage', () => {
      const view = new TestView(Uri.file('/ext'));
      const fake = makeFakeView();
      view.resolveWebviewView(
        fake as unknown as vscode.WebviewView,
        {} as vscode.WebviewViewResolveContext,
        {} as vscode.CancellationToken
      );
      try {
        fake.webview._messageEmitter.fire({ type: 'ping' });
        fake.webview._messageEmitter.fire({ type: 'pong' });
        assert.deepStrictEqual(view.messagesReceived, [{ type: 'ping' }, { type: 'pong' }]);
      } finally {
        view.dispose();
      }
    });

    it('clears _view when the view fires onDidDispose', () => {
      const view = new TestView(Uri.file('/ext'));
      const fake = makeFakeView();
      view.resolveWebviewView(
        fake as unknown as vscode.WebviewView,
        {} as vscode.WebviewViewResolveContext,
        {} as vscode.CancellationToken
      );
      try {
        assert.ok(view.getView() !== undefined);
        fake._disposeEmitter.fire();
        assert.strictEqual(view.getView(), undefined);
      } finally {
        view.dispose();
      }
    });

    it('calls subclass _onResolve hook after wiring', () => {
      const view = new TestView(Uri.file('/ext'));
      const fake = makeFakeView();
      view.resolveWebviewView(
        fake as unknown as vscode.WebviewView,
        {} as vscode.WebviewViewResolveContext,
        {} as vscode.CancellationToken
      );
      try {
        assert.strictEqual(view.onResolveInvocations, 1);
      } finally {
        view.dispose();
      }
    });

    it('renders once during resolveWebviewView', () => {
      const view = new TestView(Uri.file('/ext'));
      const fake = makeFakeView();
      view.resolveWebviewView(
        fake as unknown as vscode.WebviewView,
        {} as vscode.WebviewViewResolveContext,
        {} as vscode.CancellationToken
      );
      try {
        assert.ok(
          fake.webview.html.startsWith('<!DOCTYPE html>'),
          'resolve should render initial HTML'
        );
        assert.ok(fake.webview.html.includes('<div>hello</div>'));
      } finally {
        view.dispose();
      }
    });
  });

  describe('dispose', () => {
    it('is idempotent and clears _view', () => {
      const view = new TestView(Uri.file('/ext'));
      const fake = makeFakeView();
      view.resolveWebviewView(
        fake as unknown as vscode.WebviewView,
        {} as vscode.WebviewViewResolveContext,
        {} as vscode.CancellationToken
      );

      assert.doesNotThrow(() => view.dispose());
      assert.doesNotThrow(() => view.dispose());
      assert.doesNotThrow(() => view.dispose());

      assert.strictEqual(view.getDisposed(), true);
      assert.strictEqual(view.getView(), undefined);
    });

    it('drains _disposables on dispose', () => {
      const view = new TestView(Uri.file('/ext'));
      let disposedCount = 0;
      // Reach in and push a disposable; this mirrors what message + visibility
      // wiring does on resolve.
      (view as unknown as { _disposables: vscode.Disposable[] })._disposables.push({
        dispose: () => {
          disposedCount++;
        },
      });
      view.dispose();
      assert.strictEqual(disposedCount, 1);
    });
  });
});
