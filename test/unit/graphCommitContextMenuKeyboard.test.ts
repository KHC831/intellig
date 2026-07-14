/**
 * Runtime (jsdom) regression test for the keyboard ContextMenu-key redirect
 * in the Git tool window entry.
 *
 * The keyboard `ContextMenu` key on a focused commit row must call the LIVE
 * `showCommitContextMenu` (which reveals the rendered `#commit-context-menu`),
 * not the dead `showLogContextMenu` (which targets a `#log-context-menu`
 * element this provider never renders, making the key a silent no-op). This
 * pins that behaviour so the redirect can't silently regress to the dead menu.
 */

import '../setup';
import * as assert from 'assert';
import { bootWebviewEntry, IWebviewEntryHarness } from '../helpers/bootWebviewEntry';

describe('Git tool window entry — keyboard ContextMenu key (W1, jsdom)', () => {
  let h: IWebviewEntryHarness;

  afterEach(() => {
    if (h) {
      h.dispose();
    }
  });

  it('opens the LIVE commit-context-menu (not the removed log menu) on the ContextMenu key', () => {
    h = bootWebviewEntry('git-core/gitToolWindow/webview/gitToolWindow', {
      bodyHtml:
        `<div class="graph-panel">` +
        `<div class="commit-row" data-hash="abc1234567890" tabindex="0"></div>` +
        `</div>` +
        `<div id="commit-context-menu" class="commit-context-menu context-menu" hidden></div>`,
    });

    const row = h.document.querySelector('.commit-row') as HTMLElement;
    const menu = h.document.getElementById('commit-context-menu') as HTMLElement;
    assert.strictEqual(menu.hidden, true, 'menu starts hidden');

    row.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }));

    assert.strictEqual(
      menu.hidden,
      false,
      'ContextMenu key must reveal the live #commit-context-menu (redirect intact)'
    );
  });
});
