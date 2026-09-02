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
import { bootWebviewEntry, IWebviewEntryHarness } from '../../../helpers/bootWebviewEntry';
import { escapeHtml } from '../../../../src/git-core/gitToolWindow/provider/htmlBuilders';

interface PostedMessage {
  type: string;
  branchName?: string;
}

/**
 * Encode collapsed ref names exactly as the producer
 * (GitToolWindowProvider) does: a JSON array, then HTML-escaped so it is
 * safe inside the double-quoted `data-collapsed-branches` attribute. The
 * jsdom parser decodes the entities back to valid JSON, mirroring how the
 * real webview hands the string to the entry's `JSON.parse`.
 */
function encodeCollapsed(names: string[]): string {
  return escapeHtml(JSON.stringify(names));
}

let harness: IWebviewEntryHarness;

/**
 * Boot the entry over a document carrying a collapsed chip. The #ref-popup
 * overlay is NOT pre-rendered here: the host never renders it (pinned by
 * GitToolWindowProvider.test.ts's `!html.includes('id="ref-popup"')`) — the
 * shared ContextMenu widget creates it on first open, the same as it does
 * for every other menu.
 */
function bootDom(branchNames: string[]): {
  window: IWebviewEntryHarness['window'];
  document: Document;
  posted: PostedMessage[];
} {
  harness = bootWebviewEntry('git-core/gitToolWindow/webview/gitToolWindow', {
    bodyHtml: `
      <div class="graph-panel">
        <span class="branch-label-collapsed" data-collapsed-branches="${encodeCollapsed(branchNames)}"
              role="button" tabindex="0" aria-haspopup="true" aria-expanded="false">+${branchNames.length}</span>
      </div>`,
  });
  return {
    window: harness.window,
    document: harness.document,
    posted: harness.posted as PostedMessage[],
  };
}

function clickChip(window: IWebviewEntryHarness['window'], chip: Element): void {
  const evt = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  // jsdom MouseEvent ignores clientX/Y constructor args in some versions;
  // assign them so the popup positioning math reads finite numbers.
  Object.defineProperty(evt, 'clientX', { value: 50 });
  Object.defineProperty(evt, 'clientY', { value: 60 });
  chip.dispatchEvent(evt);
}

/** Dispatch a bubbling keydown from a specific element (the focus target). */
function keydown(window: IWebviewEntryHarness['window'], from: Element, key: string): void {
  from.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

describe('Collapsed-ref popup (branch-label +N chip)', () => {
  afterEach(() => {
    if (harness) {
      harness.dispose();
    }
  });

  it('opens the popup with one row per collapsed ref on chip click', () => {
    const { window, document } = bootDom(['origin/main', 'upstream/main']);
    const chip = document.querySelector('.branch-label-collapsed')!;

    assert.strictEqual(
      document.getElementById('ref-popup'),
      null,
      'the widget creates the popup on first open, not before'
    );
    clickChip(window, chip);
    const popup = document.getElementById('ref-popup')!;
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
    const { window, document } = bootDom(['origin/main', 'upstream/main']);
    const chip = document.querySelector('.branch-label-collapsed')!;

    const evt = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    chip.dispatchEvent(evt);
    const popup = document.getElementById('ref-popup')!;
    assert.strictEqual(popup.hidden, false, 'popup opens on Enter');
    assert.strictEqual(popup.querySelectorAll('.context-menu-item').length, 2);
  });

  it('emits branchClick for the chosen ref and dismisses the popup on row click', () => {
    const { window, document, posted } = bootDom(['origin/main', 'upstream/main']);
    const chip = document.querySelector('.branch-label-collapsed')!;

    clickChip(window, chip);
    const popup = document.getElementById('ref-popup')!;
    const row = popup.querySelector('.context-menu-item[data-branch-name="upstream/main"]')!;
    const rowEvt = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    row.dispatchEvent(rowEvt);

    const branchClicks = posted.filter((m) => m.type === 'branchClick');
    assert.strictEqual(branchClicks.length, 1, 'exactly one branchClick emitted');
    assert.strictEqual(branchClicks[0].branchName, 'upstream/main', 'navigates to the chosen ref');
    assert.strictEqual(popup.hidden, true, 'popup dismisses after row click');
  });

  it('dismisses the popup on click-outside', () => {
    const { window, document } = bootDom(['origin/main', 'upstream/main']);
    const chip = document.querySelector('.branch-label-collapsed')!;

    clickChip(window, chip);
    const popup = document.getElementById('ref-popup')!;
    assert.strictEqual(popup.hidden, false);

    const outside = document.querySelector('.graph-panel')!;
    const evt = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    outside.dispatchEvent(evt);
    assert.strictEqual(popup.hidden, true, 'click outside dismisses the popup');
  });

  it('dismisses the popup on Escape', () => {
    const { window, document } = bootDom(['origin/main', 'upstream/main']);
    const chip = document.querySelector('.branch-label-collapsed')!;

    clickChip(window, chip);
    const popup = document.getElementById('ref-popup')!;
    assert.strictEqual(popup.hidden, false);

    const evt = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    document.dispatchEvent(evt);
    assert.strictEqual(popup.hidden, true, 'Escape dismisses the popup');
  });

  it('renders ref names via textContent so markup in a branch name cannot inject', () => {
    const { window, document } = bootDom(['a', '<img src=x onerror=alert(1)>']);
    const chip = document.querySelector('.branch-label-collapsed')!;

    clickChip(window, chip);
    const popup = document.getElementById('ref-popup')!;
    // The name round-trips raw through JSON; the popup assigns it via
    // textContent, so no <img> element is ever created.
    assert.strictEqual(popup.querySelectorAll('img').length, 0, 'no injected <img> element');
    const rows = popup.querySelectorAll('.context-menu-item');
    assert.strictEqual(rows.length, 2, 'two rows including the markup-bearing name');
    assert.strictEqual(
      rows[1].getAttribute('data-branch-name'),
      '<img src=x onerror=alert(1)>',
      'the raw name round-trips intact through JSON (no double-escaping, no injection)'
    );
  });

  it('keeps a branch name containing a literal pipe as ONE row (issue #23)', () => {
    // A branch name containing a pipe must round-trip as a single ref, not
    // split into two spurious rows.
    const { window, document } = bootDom(['origin/main', 'feat|x']);
    const chip = document.querySelector('.branch-label-collapsed')!;

    clickChip(window, chip);
    const popup = document.getElementById('ref-popup')!;
    const rows = popup.querySelectorAll('.context-menu-item');
    assert.strictEqual(rows.length, 2, 'a pipe in a name must NOT create an extra row');
    assert.strictEqual(rows[1].getAttribute('data-branch-name'), 'feat|x');
    assert.strictEqual(rows[1].textContent, 'feat|x', 'the pipe survives intact in the row');
  });

  // ─── Keyboard operability (WCAG 2.1.1) ──────────────────────────────
  it('moves focus to the first row when the popup opens', () => {
    const { window, document } = bootDom(['origin/main', 'upstream/main']);
    const chip = document.querySelector('.branch-label-collapsed')!;

    clickChip(window, chip);
    const popup = document.getElementById('ref-popup')!;
    const firstRow = popup.querySelector('.context-menu-item');
    assert.strictEqual(
      document.activeElement,
      firstRow,
      'opening the popup focuses the first row so a keyboard user lands inside the menu'
    );
  });

  it('selects the focused row on Enter — emits branchClick + dismisses (the WCAG 2.1.1 regression)', () => {
    const { window, document, posted } = bootDom(['origin/main', 'upstream/main']);
    const chip = document.querySelector('.branch-label-collapsed')!;

    clickChip(window, chip);
    const popup = document.getElementById('ref-popup')!;
    const firstRow = popup.querySelector<HTMLElement>('.context-menu-item')!;
    // Keyboard activation on the focused row — must navigate, not no-op.
    keydown(window, firstRow, 'Enter');

    const branchClicks = posted.filter((m) => m.type === 'branchClick');
    assert.strictEqual(branchClicks.length, 1, 'Enter on a focused row must emit branchClick');
    assert.strictEqual(branchClicks[0].branchName, 'origin/main');
    assert.strictEqual(popup.hidden, true, 'selecting via keyboard dismisses the popup');
  });

  it('selects the focused row on Space too', () => {
    const { window, document, posted } = bootDom(['origin/main', 'upstream/main']);
    const chip = document.querySelector('.branch-label-collapsed')!;

    clickChip(window, chip);
    const popup = document.getElementById('ref-popup')!;
    const firstRow = popup.querySelector<HTMLElement>('.context-menu-item')!;
    keydown(window, firstRow, ' ');
    assert.strictEqual(posted.filter((m) => m.type === 'branchClick').length, 1, 'Space selects');
  });

  it('moves focus between rows with ArrowDown / ArrowUp (wrapping)', () => {
    const { window, document } = bootDom(['origin/main', 'upstream/main']);
    const chip = document.querySelector('.branch-label-collapsed')!;

    clickChip(window, chip);
    const popup = document.getElementById('ref-popup')!;
    const rows = popup.querySelectorAll<HTMLElement>('.context-menu-item');
    assert.strictEqual(document.activeElement, rows[0], 'starts on first row');

    keydown(window, rows[0], 'ArrowDown');
    assert.strictEqual(document.activeElement, rows[1], 'ArrowDown moves to the second row');

    keydown(window, rows[1], 'ArrowDown');
    assert.strictEqual(document.activeElement, rows[0], 'ArrowDown from last wraps to first');

    keydown(window, rows[0], 'ArrowUp');
    assert.strictEqual(document.activeElement, rows[1], 'ArrowUp from first wraps to last');
  });

  it('returns focus to the +N chip on Escape and flips aria-expanded back to false', () => {
    const { window, document } = bootDom(['origin/main', 'upstream/main']);
    const chip = document.querySelector<HTMLElement>('.branch-label-collapsed')!;

    clickChip(window, chip);
    const popup = document.getElementById('ref-popup')!;
    assert.strictEqual(chip.getAttribute('aria-expanded'), 'true', 'chip is expanded while open');
    const firstRow = popup.querySelector<HTMLElement>('.context-menu-item')!;

    keydown(window, firstRow, 'Escape');
    assert.strictEqual(popup.hidden, true, 'Escape dismisses');
    assert.strictEqual(document.activeElement, chip, 'focus returns to the opening +N chip');
    assert.strictEqual(chip.getAttribute('aria-expanded'), 'false', 'aria-expanded flips back');
  });

  it('returns focus to the +N chip after selecting a row', () => {
    const { window, document } = bootDom(['origin/main', 'upstream/main']);
    const chip = document.querySelector<HTMLElement>('.branch-label-collapsed')!;

    clickChip(window, chip);
    const popup = document.getElementById('ref-popup')!;
    const firstRow = popup.querySelector<HTMLElement>('.context-menu-item')!;
    keydown(window, firstRow, 'Enter');
    assert.strictEqual(document.activeElement, chip, 'focus returns to the opener after select');
    assert.strictEqual(chip.getAttribute('aria-expanded'), 'false', 'aria-expanded flips back');
  });

  it('toggles aria-expanded true on open', () => {
    const { window, document } = bootDom(['origin/main', 'upstream/main']);
    const chip = document.querySelector<HTMLElement>('.branch-label-collapsed')!;
    assert.strictEqual(chip.getAttribute('aria-expanded'), 'false', 'starts collapsed');
    clickChip(window, chip);
    assert.strictEqual(chip.getAttribute('aria-expanded'), 'true', 'aria-expanded true while open');
  });
});
