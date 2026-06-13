/**
 * Collapsed-ref popup behavior.
 *
 * The branch-label "+N" collapsed chip is a button. Activating it opens a
 * popup (#ref-popup) listing every collapsed ref; each row navigates to
 * that branch via the existing `branchClick` message — no new host
 * handler, no new message type. This suite executes the real inline
 * `buildInlineScript()` source inside jsdom (with a stubbed
 * `acquireVsCodeApi`) and drives the actual click / keyboard / dismiss
 * paths, so it pins runtime behavior, not just markup.
 */

import '../../../setup';
import * as assert from 'assert';
import { JSDOM } from 'jsdom';
import { buildInlineScript } from '../../../../git-core/gitToolWindow/provider/scriptBuilder';

interface PostedMessage {
  type: string;
  branchName?: string;
}

/**
 * Spin up a jsdom document carrying a collapsed chip + the #ref-popup
 * overlay, then execute the real inline script against it. Returns the
 * window/document plus the captured postMessage log.
 */
function bootDom(collapsedBranches: string): {
  window: JSDOM['window'];
  document: Document;
  posted: PostedMessage[];
} {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <div class="graph-panel">
        <span class="branch-label-collapsed" data-collapsed-branches="${collapsedBranches}"
              role="button" tabindex="0" aria-haspopup="true">+2</span>
      </div>
      <div id="ref-popup" class="context-menu" hidden role="menu"></div>
    </body></html>`,
    { runScripts: 'outside-only', pretendToBeVisual: true }
  );

  const posted: PostedMessage[] = [];
  // Stub the VS Code webview API the inline script acquires at startup.
  (dom.window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: (msg: PostedMessage) => posted.push(msg),
    getState: () => undefined,
    setState: () => undefined,
  });

  // Execute the real inline script in the jsdom realm.
  dom.window.eval(buildInlineScript());

  return { window: dom.window, document: dom.window.document, posted };
}

function clickChip(window: JSDOM['window'], chip: Element): void {
  const evt = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  // jsdom MouseEvent ignores clientX/Y constructor args in some versions;
  // assign them so the popup positioning math reads finite numbers.
  Object.defineProperty(evt, 'clientX', { value: 50 });
  Object.defineProperty(evt, 'clientY', { value: 60 });
  chip.dispatchEvent(evt);
}

describe('Collapsed-ref popup (branch-label +N chip)', () => {
  it('opens the popup with one row per collapsed ref on chip click', () => {
    const { window, document } = bootDom('origin/main|upstream/main');
    const chip = document.querySelector('.branch-label-collapsed')!;
    const popup = document.getElementById('ref-popup')!;

    assert.strictEqual(popup.hidden, true, 'popup starts hidden');
    clickChip(window, chip);
    assert.strictEqual(popup.hidden, false, 'popup is shown after chip click');

    const rows = popup.querySelectorAll('.context-menu-item');
    assert.strictEqual(rows.length, 2, 'one row per collapsed ref');
    assert.strictEqual(rows[0].getAttribute('data-branch-name'), 'origin/main');
    assert.strictEqual(rows[1].getAttribute('data-branch-name'), 'upstream/main');
    assert.strictEqual(rows[0].textContent, 'origin/main');
    // Each row is a keyboard-focusable menuitem.
    assert.strictEqual(rows[0].getAttribute('role'), 'menuitem');
    assert.strictEqual(rows[0].getAttribute('tabindex'), '0');
  });

  it('opens the popup on Enter when the chip is keyboard-focused', () => {
    const { window, document } = bootDom('origin/main|upstream/main');
    const chip = document.querySelector('.branch-label-collapsed')!;
    const popup = document.getElementById('ref-popup')!;

    const evt = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    chip.dispatchEvent(evt);
    assert.strictEqual(popup.hidden, false, 'popup opens on Enter');
    assert.strictEqual(popup.querySelectorAll('.context-menu-item').length, 2);
  });

  it('emits branchClick for the chosen ref and dismisses the popup on row click', () => {
    const { window, document, posted } = bootDom('origin/main|upstream/main');
    const chip = document.querySelector('.branch-label-collapsed')!;
    const popup = document.getElementById('ref-popup')!;

    clickChip(window, chip);
    const row = popup.querySelector('.context-menu-item[data-branch-name="upstream/main"]')!;
    const rowEvt = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    row.dispatchEvent(rowEvt);

    const branchClicks = posted.filter((m) => m.type === 'branchClick');
    assert.strictEqual(branchClicks.length, 1, 'exactly one branchClick emitted');
    assert.strictEqual(branchClicks[0].branchName, 'upstream/main', 'navigates to the chosen ref');
    assert.strictEqual(popup.hidden, true, 'popup dismisses after row click');
  });

  it('dismisses the popup on click-outside', () => {
    const { window, document } = bootDom('origin/main|upstream/main');
    const chip = document.querySelector('.branch-label-collapsed')!;
    const popup = document.getElementById('ref-popup')!;

    clickChip(window, chip);
    assert.strictEqual(popup.hidden, false);

    const outside = document.querySelector('.graph-panel')!;
    const evt = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    outside.dispatchEvent(evt);
    assert.strictEqual(popup.hidden, true, 'click outside dismisses the popup');
  });

  it('dismisses the popup on Escape', () => {
    const { window, document } = bootDom('origin/main|upstream/main');
    const chip = document.querySelector('.branch-label-collapsed')!;
    const popup = document.getElementById('ref-popup')!;

    clickChip(window, chip);
    assert.strictEqual(popup.hidden, false);

    const evt = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    document.dispatchEvent(evt);
    assert.strictEqual(popup.hidden, true, 'Escape dismisses the popup');
  });

  it('renders ref names via textContent so markup in a branch name cannot inject', () => {
    const { window, document } = bootDom('a|&lt;img src=x onerror=alert(1)&gt;');
    const chip = document.querySelector('.branch-label-collapsed')!;
    const popup = document.getElementById('ref-popup')!;

    clickChip(window, chip);
    // The chip's data attribute carries the already-escaped name; the popup
    // assigns it via textContent, so no <img> element is ever created.
    assert.strictEqual(popup.querySelectorAll('img').length, 0, 'no injected <img> element');
    const rows = popup.querySelectorAll('.context-menu-item');
    assert.strictEqual(rows.length, 2, 'two rows including the escaped name');
  });
});
