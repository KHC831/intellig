/**
 * Unit tests for `BaseWebviewPanel` (src/utils/BaseWebviewPanel.ts).
 *
 * Covers:
 * - Nonce uniqueness, length, and charset
 * - CSP construction (contains required directives)
 * - Dispose idempotency (underlying panel disposed only once)
 * - Rendered HTML contains the nonce on a script tag
 * - `_render()` assigns to `_panel.webview.html`
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { BaseWebviewPanel } from '../../../src/utils/BaseWebviewPanel';

/**
 * Concrete subclass used only for testing. Exposes the protected helpers via
 * public wrappers so tests can exercise them without type gymnastics.
 */
class TestPanel extends BaseWebviewPanel {
  public messagesReceived: unknown[] = [];

  constructor(context: vscode.ExtensionContext, title = 'Test Panel') {
    super(context, 'intellig.test.panel', title);
  }

  protected _getBodyHtml(): string {
    return '<div>test</div>';
  }

  protected _onMessage(message: unknown): void {
    this.messagesReceived.push(message);
  }

  // Test accessors --------------------------------------------------------
  public callGetNonce(): string {
    return this._getNonce();
  }

  public callBuildCsp(nonce: string): string {
    return this._buildCsp(nonce);
  }

  public callRender(): void {
    this._render();
  }

  public getPanel(): vscode.WebviewPanel {
    return this._panel;
  }

  public getDisposed(): boolean {
    return this._disposed;
  }
}

/**
 * Build a minimal `ExtensionContext` stub sufficient for the base class.
 */
function makeContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    workspaceState: {} as vscode.Memento,
    globalState: {} as vscode.Memento,
    extensionPath: '/tmp/ext',
    storagePath: undefined,
    globalStoragePath: '/tmp/global',
    logPath: '/tmp/log',
    extensionUri: vscode.Uri.file('/tmp/ext'),
    storageUri: undefined,
    globalStorageUri: vscode.Uri.file('/tmp/global'),
    logUri: vscode.Uri.file('/tmp/log'),
    extensionMode: 3, // Test
    asAbsolutePath: (relativePath: string): string => `/tmp/ext/${relativePath}`,
  } as unknown as vscode.ExtensionContext;
}

describe('BaseWebviewPanel', () => {
  let ctx: vscode.ExtensionContext;

  beforeEach(() => {
    ctx = makeContext();
  });

  it('produces unique nonces across many calls', () => {
    const panel = new TestPanel(ctx);
    try {
      const seen = new Set<string>();
      for (let i = 0; i < 100; i++) {
        seen.add(panel.callGetNonce());
      }
      assert.strictEqual(seen.size, 100, 'all 100 nonces should be unique');
    } finally {
      panel.dispose();
    }
  });

  it('produces nonces of base64url-encoded 16-byte length (22 chars, no padding)', () => {
    const panel = new TestPanel(ctx);
    try {
      for (let i = 0; i < 10; i++) {
        const nonce = panel.callGetNonce();
        assert.strictEqual(nonce.length, 22, `nonce length should be 22, got ${nonce.length}`);
      }
    } finally {
      panel.dispose();
    }
  });

  it('produces nonces from the base64url alphabet (A-Z a-z 0-9 - _)', () => {
    const panel = new TestPanel(ctx);
    try {
      // SR-6: switched from Math.random() alphanumerics to crypto.randomBytes
      // + base64url. Alphabet is URL-safe — no `+`, `/`, or `=`.
      const pattern = /^[A-Za-z0-9_-]{22}$/;
      for (let i = 0; i < 10; i++) {
        const nonce = panel.callGetNonce();
        assert.ok(pattern.test(nonce), `nonce "${nonce}" should match /^[A-Za-z0-9_-]{22}$/`);
      }
    } finally {
      panel.dispose();
    }
  });

  it('builds a CSP containing default-src none and the nonce', () => {
    const panel = new TestPanel(ctx);
    try {
      const nonce = 'abc123';
      const csp = panel.callBuildCsp(nonce);
      assert.ok(csp.includes("default-src 'none'"), 'CSP should include default-src none');
      assert.ok(csp.includes(`'nonce-${nonce}'`), 'CSP should include the nonce');
      assert.ok(csp.includes('script-src'), 'CSP should include script-src');
      assert.ok(csp.includes('style-src'), 'CSP should include style-src');
    } finally {
      panel.dispose();
    }
  });

  it('dispose is idempotent and only calls underlying panel.dispose once', () => {
    const panel = new TestPanel(ctx);
    const underlying = panel.getPanel() as vscode.WebviewPanel & { _disposeCallCount: number };

    assert.doesNotThrow(() => panel.dispose());
    assert.doesNotThrow(() => panel.dispose());
    assert.doesNotThrow(() => panel.dispose());

    assert.strictEqual(panel.getDisposed(), true, 'panel should be marked disposed');
    assert.strictEqual(
      underlying._disposeCallCount,
      1,
      'underlying panel.dispose should be called exactly once'
    );
  });

  it('rendered HTML includes a <script> tag carrying the CSP nonce', () => {
    const panel = new TestPanel(ctx);
    try {
      panel.callRender();
      const html = panel.getPanel().webview.html;

      // Extract nonce from the CSP meta tag (SR-6: base64url 22-char nonce).
      const cspMatch = html.match(/'nonce-([A-Za-z0-9_-]{22})'/);
      assert.ok(cspMatch, 'HTML should contain a CSP meta tag with a nonce');
      const nonce = cspMatch[1];

      // Confirm the same nonce is on a script tag
      assert.ok(
        html.includes(`<script nonce="${nonce}"`),
        'rendered HTML should contain a <script> tag with the CSP nonce'
      );

      // Sanity: body content was included
      assert.ok(html.includes('<div>test</div>'), 'rendered HTML should include the body fragment');
    } finally {
      panel.dispose();
    }
  });

  it('_render() assigns the wrapped HTML to _panel.webview.html', () => {
    const panel = new TestPanel(ctx, 'My Title');
    try {
      const before = panel.getPanel().webview.html;
      assert.strictEqual(before, '', 'webview html should start empty');

      panel.callRender();
      const after = panel.getPanel().webview.html;

      assert.ok(after.startsWith('<!DOCTYPE html>'), 'html should start with a doctype');
      assert.ok(after.includes('<title>My Title</title>'), 'html should include the title');
      assert.ok(after.includes('Content-Security-Policy'), 'html should include the CSP meta tag');
      assert.ok(after.includes('<div>test</div>'), 'html should include the body');
    } finally {
      panel.dispose();
    }
  });

  it('escapes HTML special characters in the title', () => {
    const panel = new TestPanel(ctx, 'A & B <c> "d"');
    try {
      panel.callRender();
      const html = panel.getPanel().webview.html;
      assert.ok(
        html.includes('<title>A &amp; B &lt;c&gt; &quot;d&quot;</title>'),
        'title should be HTML-escaped'
      );
    } finally {
      panel.dispose();
    }
  });
});
