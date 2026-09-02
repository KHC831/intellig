/**
 * The Git tool window's menus and popups take focus when they open, so they
 * owe the keyboard an exit.
 *
 * Opening a menu moves focus into it. Without arrow/Enter/Escape handling that
 * focus is a trap: the log's own arrow-key navigation is dead while the menu is
 * up, and dismissing leaves focus inside a display:none container, which the
 * browser resets to <body> — so the log stays dead afterwards too.
 */

import '../../setup';
import * as assert from 'assert';
import { bootWebviewEntry, IWebviewEntryHarness } from '../../helpers/bootWebviewEntry';
import { COMMIT_MENU_ITEMS } from '../../../src/git-core/gitToolWindow/webview/menuDefinitions';

const ENTRY = 'git-core/gitToolWindow/webview/gitToolWindow';
const HASH = 'c'.repeat(40);
const PARENT_A = 'a'.repeat(40);
const PARENT_B = 'b'.repeat(40);

function boot(parents = ''): IWebviewEntryHarness {
  return bootWebviewEntry(ENTRY, {
    bodyHtml:
      // The filter row belongs in this fixture: it is present in every real
      // render, and it registers its own dismissal handlers. A fixture without
      // it exercises a document the user never has.
      `<div class="log-filter-row"></div>` +
      `<div class="graph-panel">` +
      `<div class="commit-row" data-hash="${HASH}" data-parents="${parents}" tabindex="0"></div>` +
      `<div class="commit-row" data-hash="${PARENT_A}" data-parents=""></div>` +
      `<div class="commit-row" data-hash="${PARENT_B}" data-parents=""></div>` +
      `<span class="branch-label-collapsed" data-collapsed-branches='["main","dev"]' tabindex="0"></span>` +
      `</div>`,
  });
}

function key(h: IWebviewEntryHarness, k: string, target?: Element): void {
  (target ?? h.document).dispatchEvent(
    new h.window.KeyboardEvent('keydown', { key: k, bubbles: true })
  );
}

function openCommitMenu(h: IWebviewEntryHarness): HTMLElement {
  const row = h.document.querySelector<HTMLElement>(`.commit-row[data-hash="${HASH}"]`);
  assert.ok(row);
  row.dispatchEvent(
    new h.window.MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 40,
      clientY: 40,
    })
  );
  const menu = h.document.getElementById('commit-context-menu');
  assert.ok(menu && !menu.hidden, 'the commit menu must open');
  return menu;
}

function rows(menu: HTMLElement): HTMLElement[] {
  return Array.from(
    menu.querySelectorAll<HTMLElement>('.context-menu-item:not(.disabled):not(.menu-multi-hidden)')
  );
}

describe('webview: Git tool window menu keyboard (jsdom)', () => {
  let h: IWebviewEntryHarness;

  afterEach(() => {
    if (h) {
      h.dispose();
    }
  });

  it('hands focus back to the commit row when the window is lost', () => {
    // Losing the window closes the menu, and closing it owes the keyboard the
    // same exit Escape does. A dismisser that hides the box directly, without
    // going through the widget, leaves focus inside a hidden subtree — the
    // browser drops it on <body> and the log's arrow keys are dead.
    h = boot();
    const row = h.document.querySelector<HTMLElement>(`.commit-row[data-hash="${HASH}"]`);
    assert.ok(row);
    const menu = openCommitMenu(h);
    assert.ok(menu.contains(h.document.activeElement), 'the menu has focus while open');

    h.window.dispatchEvent(new h.window.Event('blur'));

    assert.ok(menu.hidden, 'the menu closes');
    assert.strictEqual(h.document.activeElement, row, 'and focus goes back to the row');
  });

  it('hands focus back to the row when the parent-choice popup is dismissed', () => {
    // ArrowRight on a merge commit offers the parents. The popup takes focus
    // like every other menu, so Escape owes it back to the row the user was
    // navigating from — otherwise the arrow keys that opened it are dead.
    h = boot(`${PARENT_A},${PARENT_B}`);
    const row = h.document.querySelector<HTMLElement>(`.commit-row[data-hash="${HASH}"]`);
    assert.ok(row);
    row.click();
    key(h, 'ArrowRight', row);

    const popup = h.document.getElementById('nav-popup');
    assert.ok(popup && !popup.hidden, 'the parent-choice popup opens');
    assert.ok(popup.contains(h.document.activeElement), 'and takes focus');

    key(h, 'Escape', h.document.activeElement ?? undefined);

    assert.ok(popup.hidden, 'Escape closes it');
    assert.strictEqual(h.document.activeElement, row, 'and focus goes back to the row');
  });

  it('moves between commit-menu rows with the arrow keys', () => {
    h = boot();
    const menu = openCommitMenu(h);
    const items = rows(menu);
    assert.strictEqual(h.document.activeElement, items[0], 'opening focuses the first row');

    key(h, 'ArrowDown', h.document.activeElement ?? undefined);
    assert.strictEqual(h.document.activeElement, items[1], 'ArrowDown moves to the next row');

    key(h, 'ArrowUp', h.document.activeElement ?? undefined);
    assert.strictEqual(h.document.activeElement, items[0], 'ArrowUp moves back');
  });

  it('picks the focused commit-menu row with Enter', () => {
    h = boot();
    const menu = openCommitMenu(h);
    h.posted.length = 0;

    key(h, 'Enter', h.document.activeElement ?? undefined);

    const acted = h.posted.filter(
      (m) => (m as { type?: string }).type === 'commitContextMenu'
    ) as Array<{ action?: string }>;
    assert.strictEqual(acted.length, 1, 'Enter picks the focused row');
    assert.strictEqual(acted[0].action, rows(menu)[0].getAttribute('data-action'));
  });

  it('returns focus to the commit row when the menu is dismissed', () => {
    h = boot();
    const menu = openCommitMenu(h);

    key(h, 'Escape', h.document.activeElement ?? undefined);

    assert.strictEqual(menu.hidden, true, 'Escape dismisses');
    assert.strictEqual(
      h.document.activeElement,
      h.document.querySelector(`.commit-row[data-hash="${HASH}"]`),
      'focus goes back to the row, not to <body> — the log navigates by arrow keys'
    );
  });

  it('renders one row per defined commit-menu item', () => {
    // Two halves. Rendered-vs-defined catches the widget dropping rows; the
    // literal catches a row ARRIVING unnoticed, which matters because a new
    // action that nobody adds to the multi-select gating map falls back to
    // visible+enabled and stays clickable across a multi-selection.
    h = boot();
    const menu = openCommitMenu(h);
    const rendered = menu.querySelectorAll('[role="menuitem"]').length;
    const defined = COMMIT_MENU_ITEMS.filter((i) => !i.separator).length;

    assert.strictEqual(rendered, defined, 'every non-separator item renders a row');
    assert.strictEqual(
      defined,
      22,
      'commit-menu item count changed — update the multi-select gating map, then this number'
    );
  });

  it('dismisses the navigation popup on Escape', () => {
    h = boot(`${PARENT_A},${PARENT_B}`);
    const menu = openCommitMenu(h);
    menu
      .querySelector<HTMLElement>('.context-menu-item[data-action="goToParent"]')
      ?.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    const popup = h.document.getElementById('nav-popup');
    assert.ok(popup && !popup.hidden, 'the popup opens for a merge commit');

    key(h, 'Escape', h.document.activeElement ?? undefined);
    assert.strictEqual(popup.hidden, true, 'Escape dismisses the navigation popup');
  });

  it('dismisses the navigation popup when the window loses focus', () => {
    // A popup hanging off <body> outlives the window going to the background:
    // it would still be up, over a log the user has moved away from, and a
    // stray click on it would act on a commit they can no longer see.
    h = boot(`${PARENT_A},${PARENT_B}`);
    const menu = openCommitMenu(h);
    menu
      .querySelector<HTMLElement>('.context-menu-item[data-action="goToParent"]')
      ?.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    const popup = h.document.getElementById('nav-popup');
    assert.ok(popup && !popup.hidden, 'the popup opens for a merge commit');

    h.window.dispatchEvent(new h.window.Event('blur'));

    assert.strictEqual(popup.hidden, true, 'losing the window dismisses the navigation popup');
  });

  it('closes an open ref popup when a context menu opens over it', () => {
    h = boot();
    const chip = h.document.querySelector<HTMLElement>('.branch-label-collapsed');
    assert.ok(chip);
    chip.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    const refPopup = h.document.getElementById('ref-popup');
    assert.ok(refPopup && !refPopup.hidden, 'the ref popup opens');

    openCommitMenu(h);

    assert.strictEqual(refPopup.hidden, true, 'only one popup is up at a time');
    assert.strictEqual(
      chip.getAttribute('aria-expanded'),
      'false',
      'and the chip stops claiming it is expanded'
    );
  });
});
