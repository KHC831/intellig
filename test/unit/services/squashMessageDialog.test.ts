/**
 * Unit tests for the Squash Message Dialog (Bug 5b).
 *
 * Covers:
 *  - `prompt()` resolves to the submitted message on `submit`.
 *  - `prompt()` resolves to `undefined` on `cancel`.
 *  - `prompt()` resolves to `undefined` on panel dispose
 *    (close-the-tab semantics).
 *  - `prompt()` treats whitespace-only submit as cancel
 *    (matches the temp-file fallback's empty-content semantics so
 *    the user can't accidentally land an empty squash message).
 *  - The panel HTML carries:
 *      * a textarea for multi-line composition (NOT an input box);
 *      * the seed message JSON-encoded into the textarea init script;
 *      * the commit count in the title;
 *      * a CSP meta tag (BaseWebviewPanel security invariant).
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { SquashMessageDialog } from '../../../src/commits/SquashMessageDialog';

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
    extensionMode: 3,
    asAbsolutePath: (rel: string): string => `/tmp/ext/${rel}`,
  } as unknown as vscode.ExtensionContext;
}

/**
 * Reach into the dialog to invoke its `_onMessage` handler with a
 * synthetic webview message. Mirrors the pattern in
 * `newBranchDialog.test.ts`. Behaves as if the user clicked
 * Submit / Cancel inside the textarea.
 */
function postMessage(dialog: SquashMessageDialog, msg: unknown): void {
  (dialog as unknown as { _onMessage(m: unknown): void })._onMessage(msg);
}

/**
 * Reach into the dialog's panel to read the rendered webview HTML
 * for assertions. The panel is created by `BaseWebviewPanel`'s
 * constructor; the HTML is set when `prompt()` calls `_render()`.
 */
function getHtml(dialog: SquashMessageDialog): string {
  return (dialog as unknown as { _panel: { webview: { html: string } } })._panel.webview.html;
}

describe('SquashMessageDialog', () => {
  describe('prompt() resolution', () => {
    it('resolves to the message on submit', async () => {
      const dialog = new SquashMessageDialog(makeContext(), {
        seedMessage: 'first commit\n\nbody',
        commitCount: 3,
      });
      const promised = dialog.prompt();

      postMessage(dialog, { type: 'submit', message: 'combined message\n\nfull body' });

      const result = await promised;
      assert.strictEqual(result, 'combined message\n\nfull body');
    });

    it('resolves to undefined on cancel', async () => {
      const dialog = new SquashMessageDialog(makeContext(), {
        seedMessage: 'seed',
        commitCount: 2,
      });
      const promised = dialog.prompt();

      postMessage(dialog, { type: 'cancel' });

      const result = await promised;
      assert.strictEqual(result, undefined);
    });

    it('resolves to undefined when the panel is disposed externally (close-the-tab)', async () => {
      const dialog = new SquashMessageDialog(makeContext(), {
        seedMessage: 'seed',
        commitCount: 2,
      });
      const promised = dialog.prompt();

      // Simulate the user closing the tab.
      dialog.dispose();

      const result = await promised;
      assert.strictEqual(result, undefined);
    });

    it('treats whitespace-only submit as cancel (no empty squash message)', async () => {
      const dialog = new SquashMessageDialog(makeContext(), {
        seedMessage: 'seed',
        commitCount: 2,
      });
      const promised = dialog.prompt();

      postMessage(dialog, { type: 'submit', message: '   \n\t\n  ' });

      const result = await promised;
      assert.strictEqual(
        result,
        undefined,
        'whitespace-only submit must resolve as cancel; empty messages would land a useless squash commit'
      );
    });

    it('preserves leading/trailing whitespace in non-empty messages', async () => {
      // The trim is for the cancel-detection only; the user's actual
      // message must be preserved verbatim (some commit-message
      // conventions intentionally include trailing newlines).
      const dialog = new SquashMessageDialog(makeContext(), {
        seedMessage: 'seed',
        commitCount: 2,
      });
      const promised = dialog.prompt();

      postMessage(dialog, { type: 'submit', message: 'real message\n\n' });

      const result = await promised;
      assert.strictEqual(result, 'real message\n\n');
    });
  });

  describe('rendered HTML', () => {
    it('includes a textarea for multi-line composition (not an input box)', async () => {
      const dialog = new SquashMessageDialog(makeContext(), {
        seedMessage: 'seed',
        commitCount: 4,
      });
      // Drive _render via prompt(); we don't await because the panel
      // is captured below.
      void dialog.prompt();

      const html = getHtml(dialog);
      assert.ok(html.includes('<textarea'), 'rendered HTML must contain a <textarea>');
      assert.ok(
        !/<input\s+type="text"/.test(html),
        'rendered HTML must NOT contain a single-line <input type="text"> for the message'
      );

      // Cleanup — let the prompt() resolve via dispose so we don't leak.
      dialog.dispose();
    });

    it('JSON-encodes the seed message so newlines and quotes in commit messages survive interpolation', async () => {
      const seedMessage = 'first line\n\n"quoted body" with newlines\nand backslashes \\n in text';
      const dialog = new SquashMessageDialog(makeContext(), {
        seedMessage,
        commitCount: 2,
      });
      void dialog.prompt();

      const html = getHtml(dialog);
      // The JSON encoding is the load-bearing thing — without it,
      // a commit message containing a quote or a newline would break
      // the inline script's `msgEl.value = "<seed>";` assignment.
      const expectedJsonEncoded = JSON.stringify(seedMessage);
      assert.ok(
        html.includes(`msgEl.value = ${expectedJsonEncoded};`),
        `rendered HTML must include JSON-encoded seed (got HTML; expected substring: ${expectedJsonEncoded})`
      );

      dialog.dispose();
    });

    it('unicode-escapes "<" in the seed so a "</script>" cannot break out of the inline script', async () => {
      const seedMessage = '</script><img src=x onerror=alert(1)> done';
      const dialog = new SquashMessageDialog(makeContext(), {
        seedMessage,
        commitCount: 2,
      });
      void dialog.prompt();

      const html = getHtml(dialog);
      // The seed's literal "</script>" must NOT survive into the markup — it
      // would close the inline <script> early and inject the trailing markup.
      assert.ok(
        !html.includes('</script><img'),
        'seed must not be able to break out of the inline script'
      );
      // It is escaped to <, which the JS string decodes back to "<".
      assert.ok(
        html.includes('\\u003c/script>'),
        'the seed "<" must be unicode-escaped in the embedded JSON'
      );
      assert.ok(html.includes('msgEl.value = '), 'the seed is still assigned to the textarea');

      dialog.dispose();
    });

    it('includes the commit count in the dialog title', async () => {
      const dialog = new SquashMessageDialog(makeContext(), {
        seedMessage: 'seed',
        commitCount: 7,
      });
      void dialog.prompt();

      const html = getHtml(dialog);
      assert.ok(
        html.includes('Squash 7 commits'),
        'rendered HTML must show the commit count in the heading'
      );

      dialog.dispose();
    });

    it('emits a CSP meta tag (BaseWebviewPanel security invariant)', async () => {
      const dialog = new SquashMessageDialog(makeContext(), {
        seedMessage: 'seed',
        commitCount: 2,
      });
      void dialog.prompt();

      const html = getHtml(dialog);
      assert.ok(
        /<meta http-equiv="Content-Security-Policy"/i.test(html),
        'rendered HTML must carry a CSP meta tag'
      );
      assert.ok(
        /script-src 'nonce-[A-Za-z0-9_-]+'/.test(html),
        'CSP must restrict script-src to a nonce'
      );

      dialog.dispose();
    });
  });

  describe('idempotency', () => {
    it('a second submit after the first is ignored (resolution is single-shot)', async () => {
      const dialog = new SquashMessageDialog(makeContext(), {
        seedMessage: 'seed',
        commitCount: 2,
      });
      const promised = dialog.prompt();

      postMessage(dialog, { type: 'submit', message: 'first' });
      // Even though the dialog is already disposed via _finish,
      // a follow-up message must not throw.
      postMessage(dialog, { type: 'submit', message: 'second' });

      const result = await promised;
      assert.strictEqual(result, 'first', 'only the first submit wins');
    });

    it('calling prompt() twice on the same dialog resolves the second call to undefined', async () => {
      // Single-shot contract — protects callers from accidentally
      // re-prompting after the dialog has already closed.
      const dialog = new SquashMessageDialog(makeContext(), {
        seedMessage: 'seed',
        commitCount: 2,
      });
      void dialog.prompt();
      const second = await dialog.prompt();
      assert.strictEqual(second, undefined);
      dialog.dispose();
    });
  });
});
