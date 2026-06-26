/**
 * Runtime (jsdom) regression test for the keyboard ContextMenu-key redirect
 * in the Git tool window inline script.
 *
 * The keyboard `ContextMenu` key on a focused commit row must call the LIVE
 * `showCommitContextMenu` (which reveals the rendered `#commit-context-menu`),
 * not the dead `showLogContextMenu` (which targets a `#log-context-menu`
 * element this provider never renders, making the key a silent no-op). This
 * pins that behaviour so the redirect can't silently regress to the dead menu.
 */

import '../setup';
import * as assert from 'assert';
import { JSDOM } from 'jsdom';
import { buildInlineScript } from '../../src/git-core/gitToolWindow/provider/scriptBuilder';

describe('Git tool window inline script — keyboard ContextMenu key (W1, jsdom)', () => {
  it('opens the LIVE commit-context-menu (not the removed log menu) on the ContextMenu key', () => {
    const dom = new JSDOM(
      `<!doctype html><html><body>` +
        `<div class="graph-panel">` +
        `<div class="commit-row" data-hash="abc1234567890" tabindex="0"></div>` +
        `</div>` +
        `<div id="commit-context-menu" class="commit-context-menu context-menu" hidden></div>` +
        `</body></html>`,
      { runScripts: 'outside-only' }
    );
    const window = dom.window;
    (window as unknown as { acquireVsCodeApi: () => Record<string, () => void> }).acquireVsCodeApi =
      () => ({
        postMessage: () => {},
        getState: () => {},
        setState: () => {},
      });

    window.eval(buildInlineScript());

    const row = window.document.querySelector('.commit-row') as HTMLElement;
    const menu = window.document.getElementById('commit-context-menu') as HTMLElement;
    assert.strictEqual(menu.hidden, true, 'menu starts hidden');

    row.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }));

    assert.strictEqual(
      menu.hidden,
      false,
      'ContextMenu key must reveal the live #commit-context-menu (redirect intact)'
    );
  });
});
