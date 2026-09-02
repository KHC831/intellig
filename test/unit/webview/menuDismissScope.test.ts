/**
 * Dismissing one menu must not dismiss the others.
 *
 * The registry gave every module a way to close every menu, and two call sites
 * reached for it where they meant something narrower — a details-panel swap,
 * and a click-away test that still named three of the five menus. Both turn
 * into a menu that opens and closes on its own.
 */

import '../../setup';
import * as assert from 'assert';
import { bootWebviewEntry, IWebviewEntryHarness } from '../../helpers/bootWebviewEntry';

const ENTRY = 'git-core/gitToolWindow/webview/gitToolWindow';
const HASH = 'f'.repeat(40);

function boot(): IWebviewEntryHarness {
  return bootWebviewEntry(ENTRY, {
    bodyHtml:
      `<div class="graph-panel">` +
      `<div class="commit-row" data-hash="${HASH}" data-parents="" tabindex="0">` +
      `<span class="branch-label-collapsed" data-collapsed-branches='["main","dev"]' tabindex="0"></span>` +
      `</div>` +
      `</div>` +
      `<div id="details-panel"></div>`,
  });
}

function rightClickCommit(h: IWebviewEntryHarness): HTMLElement {
  const row = h.document.querySelector<HTMLElement>(`.commit-row[data-hash="${HASH}"]`);
  assert.ok(row);
  row.dispatchEvent(
    new h.window.MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 30,
      clientY: 30,
    })
  );
  const menu = h.document.getElementById('commit-context-menu');
  assert.ok(menu && !menu.hidden, 'the commit menu opens');
  return menu;
}

describe('webview: menu dismissal scope (jsdom)', () => {
  let h: IWebviewEntryHarness;

  afterEach(() => {
    if (h) {
      h.dispose();
    }
  });

  it('leaves the commit menu open when the details panel is rebuilt underneath it', () => {
    // Right-clicking an UNSELECTED commit posts selectIfNotSelected, the host
    // selects it, and selecting posts updateDetailsPanel in the same tick. If
    // that swap closes every menu, the menu the user just opened vanishes on
    // its own — for every commit that was not already selected, which is the
    // normal case.
    h = boot();
    const menu = rightClickCommit(h);

    h.post({ type: 'updateDetailsPanel', model: { commitHash: HASH, files: [] } });

    assert.strictEqual(menu.hidden, false, 'the menu the user opened must still be up');
  });

  it('closes the changed-file menu when the panel it is anchored in is rebuilt', () => {
    // The narrow thing the panel swap does need: this menu remembers the commit
    // and path it was opened on, and both are about to be replaced.
    h = boot();
    const panel = h.document.getElementById('details-panel');
    assert.ok(panel);
    panel.innerHTML = `<div class="changed-file-item" data-path="a.ts" data-commit-hash="${HASH}">a.ts</div>`;
    const item = panel.querySelector<HTMLElement>('.changed-file-item');
    assert.ok(item);
    item.dispatchEvent(
      new h.window.MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 40,
        clientY: 40,
      })
    );
    const fileMenu = h.document.getElementById('file-context-menu');
    assert.ok(fileMenu && !fileMenu.hidden, 'the file menu opens');

    h.post({ type: 'updateDetailsPanel', model: { commitHash: HASH, files: [] } });

    assert.strictEqual(fileMenu.hidden, true, 'it has nothing left to act on');
  });

  it('keeps the ref popup open when the click lands on its own padding', () => {
    // .context-menu has 4px of vertical padding, so there is a strip inside the
    // box that is not on any row. A click-away test that names only three of
    // the five menus reads that strip as "outside" and closes the popup.
    h = boot();
    const chip = h.document.querySelector<HTMLElement>('.branch-label-collapsed');
    assert.ok(chip);
    chip.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    const popup = h.document.getElementById('ref-popup');
    assert.ok(popup && !popup.hidden, 'the ref popup opens');

    // A click on the popup box itself, not on a row.
    popup.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    assert.strictEqual(popup.hidden, false, 'a click inside the popup is not a click away');
  });
});

describe('webview: an open menu does not outlive its gesture (jsdom)', () => {
  let h: IWebviewEntryHarness;

  afterEach(() => {
    if (h) {
      h.dispose();
    }
  });

  it('closes when the row it was opened on is left-clicked', () => {
    // Sparing "the control this menu was opened from" is a subtree test, and a
    // commit row is a big subtree: a click anywhere in it read as a click on
    // the opener and left the menu up.
    h = boot();
    const menu = rightClickCommit(h);
    const row = h.document.querySelector<HTMLElement>(`.commit-row[data-hash="${HASH}"]`);
    assert.ok(row);

    row.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    assert.strictEqual(menu.hidden, true, 'clicking away closes it, even inside the opener');
  });

  it('closes the commit menu when a popup inside its opener row opens', () => {
    // The "+N" chip lives inside the commit row, so the chip click was spared
    // as "a click on the opener" and both boxes ended up painted at once.
    h = boot();
    const menu = rightClickCommit(h);
    const chip = h.document.querySelector<HTMLElement>('.branch-label-collapsed');
    assert.ok(chip);

    chip.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    const popup = h.document.getElementById('ref-popup');
    assert.ok(popup && !popup.hidden, 'the ref popup opens');
    assert.strictEqual(menu.hidden, true, 'and only one box is up at a time');
  });

  it('acts on the commits it was opened for while it is still open', () => {
    // The positive control for the test below. That one asserts a menu posts
    // NOTHING after the selection moved, which a menu that can never act on
    // anything satisfies just as well — and the only test that would have
    // caught that lives in another file.
    h = boot();
    const menu = rightClickCommit(h);
    h.posted.length = 0;

    menu
      .querySelector<HTMLElement>('.context-menu-item[data-action="dropCommit"]')
      ?.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    const acted = h.posted.filter(
      (m) => (m as { type?: string }).type === 'commitContextMenu'
    ) as Array<{ action?: string; commitHashes?: string[] }>;
    assert.strictEqual(acted.length, 1, 'a pick reaches the host');
    assert.strictEqual(acted[0].action, 'dropCommit');
    assert.deepStrictEqual(acted[0].commitHashes, [HASH], 'carrying the row it was opened on');
  });

  it('refuses a pick whose commits are no longer the ones selected', () => {
    // The eager close covers syncSelection. selectGraphRow ALSO rewrites the
    // rendered selection, and it cannot be closed on — the menu-open path posts
    // it, so closing there would dismiss the menu the user just opened.
    // Checking at pick time instead covers every message that moves the
    // selection, including ones not yet written.
    h = boot();
    const menu = rightClickCommit(h);
    const item = menu.querySelector<HTMLElement>('.context-menu-item[data-action="dropCommit"]');
    assert.ok(item);

    // The host reveals a different commit; the menu stays up holding the old set.
    h.post({ type: 'selectGraphRow', commitHash: 'a'.repeat(40) });
    h.posted.length = 0;

    item.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    assert.deepStrictEqual(
      h.posted.filter((m) => (m as { type?: string }).type === 'commitContextMenu'),
      [],
      'a pick must act on the selection the menu reflects, or on nothing'
    );
  });

  it('drops an open commit menu when the host changes the selection under it', () => {
    // The hashes a pick acts on are captured when the menu OPENS. A menu left
    // showing across a selection change still holds the old set, so a Drop
    // Commit picked afterwards would act on commits that are no longer
    // selected, with a different row highlighted.
    h = boot();
    const menu = rightClickCommit(h);
    const item = menu.querySelector<HTMLElement>('.context-menu-item[data-action="dropCommit"]');
    assert.ok(item);

    h.post({ type: 'syncSelection', selectedHashes: ['other'], anchorHash: 'other' });
    assert.strictEqual(menu.hidden, true, 'the menu no longer reflects the selection');

    h.posted.length = 0;
    item.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.deepStrictEqual(
      h.posted.filter((m) => (m as { type?: string }).type === 'commitContextMenu'),
      [],
      'and it acts on nothing'
    );
  });
});
