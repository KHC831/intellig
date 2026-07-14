/**
 * Webview client-script test — the Git tool-window bundled entry
 * (`git-core/gitToolWindow/webview/gitToolWindow`). Boots the actual browser-side
 * entry under jsdom and asserts it loads without throwing and tolerates
 * extension→webview messages without throwing. This is the layer that catches
 * "the webview script threw" regressions (e.g. a createElement-migration slip),
 * which are invisible to every other test lane.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { bootWebviewEntry, IWebviewEntryHarness } from '../../helpers/bootWebviewEntry';

const ENTRY = 'git-core/gitToolWindow/webview/gitToolWindow';

describe('webview: git tool-window entry (jsdom)', () => {
  let h: IWebviewEntryHarness;

  afterEach(() => {
    if (h) {
      h.dispose();
    }
  });

  it('loads without throwing a script error', () => {
    h = bootWebviewEntry(ENTRY);
    assert.deepStrictEqual(
      h.errors.map((e) => e.message),
      [],
      'the tool-window entry must parse and run without errors'
    );
  });

  it('handles representative extension→webview messages without throwing', () => {
    h = bootWebviewEntry(ENTRY);

    // A spread of message shapes the entry dispatches on. The point is that
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

  it('escapes every interpolated hash in a [data-hash] selector via cssEscapeHash', () => {
    // A host SHA spliced raw into '[data-hash="' + hash + '"]' would throw a
    // SyntaxError / mis-select if it ever contained a quote. Every such selector
    // must route the value through the entry's cssEscapeHash helper (which
    // prefers the native CSS.escape and falls back when the global CSS is
    // absent), so a malformed value degrades to "no match", not a thrown
    // querySelector.
    const entrySource = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'src', ENTRY + '.ts'),
      'utf8'
    );
    const matches = [...entrySource.matchAll(/\[data-hash="'\s*\+\s*([\s\S]+?)\s*\+\s*'"\]/g)];
    assert.ok(
      matches.length >= 5,
      `sanity: expected several data-hash selectors, got ${matches.length}`
    );
    for (const m of matches) {
      assert.ok(
        m[1].startsWith('cssEscapeHash('),
        `data-hash selector value must be cssEscapeHash-wrapped; got: ${m[1]}`
      );
    }
  });
});
