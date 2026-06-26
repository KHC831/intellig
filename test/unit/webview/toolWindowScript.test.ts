/**
 * Webview client-script test — the Git tool-window inline script
 * (`buildInlineScript`). Runs the actual browser-side script under jsdom and
 * asserts it loads without throwing and tolerates extension→webview messages
 * without throwing. This is the layer that catches "the webview script threw"
 * regressions (e.g. a createElement-migration slip), which are invisible to
 * every other test lane.
 */

import '../../setup';
import * as assert from 'assert';
import { buildInlineScript } from '../../../src/git-core/gitToolWindow/provider/scriptBuilder';
import { runWebviewScript, IWebviewHarness } from '../../helpers/webviewHarness';

describe('webview: git tool-window inline script (jsdom)', () => {
  let h: IWebviewHarness;

  afterEach(() => {
    if (h) {
      h.dispose();
    }
  });

  it('loads without throwing a script error', () => {
    h = runWebviewScript(buildInlineScript());
    assert.deepStrictEqual(
      h.errors.map((e) => e.message),
      [],
      'the tool-window script must parse and run without errors'
    );
  });

  it('handles representative extension→webview messages without throwing', () => {
    h = runWebviewScript(buildInlineScript());

    // A spread of message shapes the script dispatches on. The point is that
    // none of them throws (the handler chain is defensive), not that each
    // renders specific DOM — that is asserted per-message elsewhere.
    const messages: unknown[] = [
      { type: 'update', commits: [], branches: [], tags: [] },
      { type: 'loading' },
      { type: 'noRepository' },
      { command: 'refresh' },
      { type: 'totally-unknown-message' },
      {},
    ];
    for (const msg of messages) {
      h.post(msg);
    }

    assert.deepStrictEqual(
      h.errors.map((e) => e.message),
      [],
      'message handling must not throw on any representative or unknown message'
    );
  });

  it('wraps every interpolated hash in a [data-hash] selector with CSS.escape (L-T3)', () => {
    // A host SHA spliced raw into '[data-hash="' + hash + '"]' would throw a
    // SyntaxError / mis-select if it ever contained a quote. Every such selector
    // must escape the value (matching the ResolveConflictsDialog/PushDialog
    // pattern), so a malformed value degrades to "no match", not a thrown
    // querySelector.
    const script = buildInlineScript();
    const matches = [...script.matchAll(/\[data-hash="'\s*\+\s*([\s\S]+?)\s*\+\s*'"\]/g)];
    assert.ok(
      matches.length >= 5,
      `sanity: expected several data-hash selectors, got ${matches.length}`
    );
    for (const m of matches) {
      assert.ok(
        m[1].startsWith('CSS.escape('),
        `data-hash selector value must be CSS.escape-wrapped; got: ${m[1]}`
      );
    }
  });
});
