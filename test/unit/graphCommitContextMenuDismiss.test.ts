/**
 * Runtime (jsdom) regression test for dismissing the commit context menu in the
 * Git tool window inline script.
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
import { JSDOM } from 'jsdom';
import { buildInlineScript } from '../../src/git-core/gitToolWindow/provider/scriptBuilder';

function makeDom(): JSDOM {
  const dom = new JSDOM(
    `<!doctype html><html><body>` +
      `<div class="graph-panel">` +
      `<div class="commit-row" data-hash="abc1234567890" tabindex="0"></div>` +
      `</div>` +
      `<div id="commit-context-menu" class="commit-context-menu context-menu" hidden>` +
      `<div class="context-menu-item" data-action="copyHash">Copy Hash</div>` +
      `</div>` +
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
  return dom;
}

function openMenu(dom: JSDOM): HTMLElement {
  const window = dom.window;
  const row = window.document.querySelector('.commit-row') as HTMLElement;
  const menu = window.document.getElementById('commit-context-menu') as HTMLElement;
  assert.strictEqual(menu.hidden, true, 'menu starts hidden');
  row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));
  assert.strictEqual(menu.hidden, false, 'right-click should reveal the menu');
  return menu;
}

describe('Git tool window inline script — commit-context-menu dismissal (jsdom)', () => {
  it('hides the menu on a click in the document outside the menu', () => {
    const dom = makeDom();
    const menu = openMenu(dom);

    dom.window.document.body.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

    assert.strictEqual(menu.hidden, true, 'clicking away in the webview must hide the menu');
  });

  it('hides the menu when the webview loses focus (window blur)', () => {
    const dom = makeDom();
    const menu = openMenu(dom);

    dom.window.dispatchEvent(new dom.window.Event('blur'));

    assert.strictEqual(
      menu.hidden,
      true,
      'losing webview focus must hide the menu (click landed outside the iframe)'
    );
  });
});
