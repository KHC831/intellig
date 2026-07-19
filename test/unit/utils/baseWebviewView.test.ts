/**
 * Unit tests for `BaseWebviewView` (src/utils/BaseWebviewView.ts).
 *
 * Covers:
 * - Nonce uniqueness, length, and base64url charset.
 * - CSP construction — contains every directive the panel base emits, in the
 *   same nonce-bound shape.
 * - `_wrapHtml` composes `{ body }` correctly (body appears; the end-of-body
 *   script tag is an empty nonced sentinel, or an external bundle `src` tag when
 *   the subclass sets a bundle name — never an inline script body).
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
 * and lets tests swap the `{ body }` between render calls. `bundleName` drives
 * {@link _getBundleName}: left `undefined` the base emits the empty sentinel;
 * set, it emits the external `<script src>` bundle tag.
 */
class TestView extends BaseWebviewView {
  public bodyParts: { body: string } = { body: '<div>hello</div>' };
  public bundleName: string | undefined = undefined;
  public messagesReceived: unknown[] = [];
  public onResolveInvocations = 0;
  public perResolveDrains = 0;

  protected override _getBodyParts(): { body: string } {
    return this.bodyParts;
  }

  protected override _getBundleName(): string | undefined {
    return this.bundleName;
  }

  protected _handleMessage(message: unknown): void {
    this.messagesReceived.push(message);
  }

  protected override _onResolve(): void {
    this.onResolveInvocations++;
    // Mirror a subclass that wires a per-resolve listener (e.g.
    // onDidChangeVisibility): register it through the per-resolve seam so a
    // re-resolve cycle drains it rather than leaking.
    this._registerPerResolve({
      dispose: () => {
        this.perResolveDrains++;
      },
    });
  }

  // Test accessors --------------------------------------------------------
  public callGetNonce(): string {
    return this._getNonce();
  }

  public callBuildCsp(nonce: string): string {
    return this._buildCsp(nonce);
  }

  public callWrapHtml(body: string): string {
    return this._wrapHtml(body);
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

  public callPostMessage(message: unknown): Thenable<boolean> {
    return this.postMessage(message);
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
    it('composes body + exactly one nonced <script> tag (empty sentinel, no inline body)', () => {
      const view = new TestView(Uri.file('/ext'));
      try {
        const html = view.callWrapHtml('<p>body</p>');
        const scriptMatches = html.match(/<script nonce="[^"]+"[^>]*>/g);
        assert.ok(scriptMatches, 'HTML should contain a nonced <script> tag');
        assert.strictEqual(
          scriptMatches.length,
          1,
          `expected exactly one nonced <script>, got ${scriptMatches.length}`
        );
        assert.ok(html.includes('<p>body</p>'), 'HTML should include the body fragment');
        // No bundle → empty sentinel, never an inline body / src.
        assert.ok(/<script nonce="[^"]+"><\/script>/.test(html), 'empty sentinel tag emitted');
        assert.ok(!/<script[^>]*\ssrc=/.test(html), 'no external src without a bundle name');
      } finally {
        view.dispose();
      }
    });

    it('emits an external bundle <script src> tag when the subclass sets a bundle name', () => {
      const view = new TestView(Uri.file('/ext'));
      view.bundleName = 'testView.js';
      const fake = makeFakeView();
      view.resolveWebviewView(
        fake as unknown as vscode.WebviewView,
        {} as vscode.WebviewViewResolveContext,
        {} as vscode.CancellationToken
      );
      try {
        const html = view.callWrapHtml('<p>body</p>');
        assert.ok(
          /<script nonce="[^"]+" src="[^"]*media\/webview\/testView\.js"><\/script>/.test(html),
          `expected the external bundle tag; got: ${html}`
        );
        assert.ok(!/<script nonce="[^"]+">[^<]/.test(html), 'must not emit an inline script body');
      } finally {
        view.dispose();
      }
    });

    it('binds the CSP meta nonce to the same nonce on the <script> tag', () => {
      const view = new TestView(Uri.file('/ext'));
      try {
        const html = view.callWrapHtml('<p>b</p>');
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
      view.bodyParts = { body: '<main>stuff</main>' };

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
      view.bodyParts = { body: '<p>LATER</p>' };
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

    it('drains per-resolve listeners on view dispose (no accumulation across re-resolve cycles)', () => {
      const view = new TestView(Uri.file('/ext'));
      const messageListenerCount = (f: FakeView): number =>
        (f.webview._messageEmitter as unknown as { listeners: unknown[] }).listeners.length;

      try {
        // A sidebar view hidden then re-shown is re-resolved each cycle. Each
        // cycle gets a FRESH WebviewView (as VS Code does); the per-resolve
        // listeners of the disposed view must be torn down, not leaked.
        for (let cycle = 0; cycle < 5; cycle++) {
          const fake = makeFakeView();
          view.resolveWebviewView(
            fake as unknown as vscode.WebviewView,
            {} as vscode.WebviewViewResolveContext,
            {} as vscode.CancellationToken
          );
          assert.strictEqual(
            messageListenerCount(fake),
            1,
            `cycle ${cycle}: resolve wires exactly one message listener`
          );

          fake._disposeEmitter.fire();

          assert.strictEqual(
            messageListenerCount(fake),
            0,
            `cycle ${cycle}: onDidDispose must drain the per-resolve message listener`
          );
          assert.strictEqual(
            view.perResolveDrains,
            cycle + 1,
            `cycle ${cycle}: the subclass per-resolve listener must be drained exactly once per cycle`
          );
        }
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

    it('drops a postMessage sent after dispose', async () => {
      const view = new TestView(Uri.file('/ext'));
      const fake = makeFakeView();
      view.resolveWebviewView(
        fake as unknown as vscode.WebviewView,
        {} as vscode.WebviewViewResolveContext,
        {} as vscode.CancellationToken
      );
      fake.webview._posted.length = 0;
      view.dispose();

      const delivered = await view.callPostMessage({ type: 'late' });

      assert.strictEqual(delivered, false, 'delivery must report failure, not throw');
      assert.deepStrictEqual(fake.webview._posted, [], 'nothing reaches a disposed view');
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
