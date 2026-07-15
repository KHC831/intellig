/**
 * Runtime (jsdom) regression test for dismissing the commit context menu in the
 * Git tool window entry.
 *
 * Two dismissal paths must hold:
 *   1. A click anywhere in the webview document OUTSIDE the menu hides it.
 *   2. The webview losing focus (a click in another VS Code panel/editor) hides
 *      it — that click never reaches the webview's document, so only a `window`
 *      blur can close the menu. Without it the menu lingers when the user clicks
 *      away from the webview entirely.
 */

import '../setup';
import * as assert from 'assert';
import { bootWebviewEntry, IWebviewEntryHarness } from '../helpers/bootWebviewEntry';

const ENTRY = 'git-core/gitToolWindow/webview/gitToolWindow';

const BODY =
  `<div class="graph-panel">` +
  `<div class="commit-row" data-hash="abc1234567890" tabindex="0"></div>` +
  `</div>` +
  `<div id="commit-context-menu" class="commit-context-menu context-menu" hidden>` +
  `<div class="context-menu-item" data-action="copyHash">Copy Hash</div>` +
  `</div>`;

function openMenu(h: IWebviewEntryHarness): HTMLElement {
  const window = h.window;
  const row = h.document.querySelector('.commit-row') as HTMLElement;
  const menu = h.document.getElementById('commit-context-menu') as HTMLElement;
  assert.strictEqual(menu.hidden, true, 'menu starts hidden');
  row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));
  assert.strictEqual(menu.hidden, false, 'right-click should reveal the menu');
  return menu;
}

describe('Git tool window entry — commit-context-menu dismissal (jsdom)', () => {
  let h: IWebviewEntryHarness;

  afterEach(() => {
    if (h) {
      h.dispose();
    }
  });

  it('hides the menu on a click in the document outside the menu', () => {
    h = bootWebviewEntry(ENTRY, { bodyHtml: BODY });
    const menu = openMenu(h);

    h.document.body.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));

    assert.strictEqual(menu.hidden, true, 'clicking away in the webview must hide the menu');
  });

  it('hides the menu when the webview loses focus (window blur)', () => {
    h = bootWebviewEntry(ENTRY, { bodyHtml: BODY });
    const menu = openMenu(h);

    h.window.dispatchEvent(new h.window.Event('blur'));

    assert.strictEqual(
      menu.hidden,
      true,
      'losing webview focus must hide the menu (click landed outside the iframe)'
    );
  });
});
