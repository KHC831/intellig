/**
 * The commit menu's rows are gated by a map the host computes for the current
 * selection. Two ways that gating can silently lapse:
 *
 *  - the map is null (a fresh render has not been followed by a selection
 *    change), and every row is treated as visible and enabled — including the
 *    multi-only rows and the destructive ones;
 *  - the map greys a row by class only, leaving aria-disabled and tabindex
 *    saying the opposite, so the row is announced as available and is still a
 *    Tab stop.
 */

import '../../setup';
import * as assert from 'assert';
import { bootWebviewEntry, IWebviewEntryHarness } from '../../helpers/bootWebviewEntry';

const ENTRY = 'git-core/gitToolWindow/webview/gitToolWindow';
const HASH = 'd'.repeat(40);

function boot(): IWebviewEntryHarness {
  return bootWebviewEntry(ENTRY, {
    bodyHtml:
      `<div class="graph-panel">` +
      `<div class="commit-row selected" data-hash="${HASH}" data-parents="" tabindex="0"></div>` +
      `</div>`,
  });
}

function openMenu(h: IWebviewEntryHarness): HTMLElement {
  const row = h.document.querySelector<HTMLElement>('.commit-row');
  assert.ok(row);
  row.dispatchEvent(
    new h.window.MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 20,
    })
  );
  const menu = h.document.getElementById('commit-context-menu');
  assert.ok(menu && !menu.hidden);
  return menu;
}

function rowFor(menu: HTMLElement, action: string): HTMLElement {
  const row = menu.querySelector<HTMLElement>(`.context-menu-item[data-action="${action}"]`);
  assert.ok(row, `${action} must render`);
  return row;
}

const OTHER = 'e'.repeat(40);
const THIRD = 'f'.repeat(40);

/** Two commits selected, a third one not — the shape a right-click retargets. */
function bootMultiSelection(): IWebviewEntryHarness {
  const row = (hash: string, selected: boolean): string =>
    `<div class="commit-row${selected ? ' selected' : ''}" data-hash="${hash}" ` +
    `data-parents="" tabindex="0"></div>`;
  return bootWebviewEntry(ENTRY, {
    bodyHtml:
      `<div class="graph-panel">` +
      row(HASH, true) +
      row(OTHER, true) +
      row(THIRD, false) +
      `</div>`,
  });
}

function rightClickRow(h: IWebviewEntryHarness, hash: string): HTMLElement {
  const row = h.document.querySelector<HTMLElement>(`.commit-row[data-hash="${hash}"]`);
  assert.ok(row, 'the row must exist');
  row.dispatchEvent(
    new h.window.MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 20,
    })
  );
  const menu = h.document.getElementById('commit-context-menu');
  assert.ok(menu && !menu.hidden, 'the menu opens');
  return menu;
}

describe('webview: Git tool window commit-menu gating (jsdom)', () => {
  let h: IWebviewEntryHarness;

  afterEach(() => {
    if (h) {
      h.dispose();
    }
  });

  it('keeps the multi-only rows hidden when no enable map has arrived', () => {
    // Nothing has changed the selection since the render, so the map is null.
    // Treating that as "everything allowed" offers Compare Versions and Squash
    // Commits on a single commit.
    h = boot();
    const menu = openMenu(h);

    for (const action of ['compareVersions', 'squashCommits']) {
      assert.ok(
        rowFor(menu, action).classList.contains('menu-multi-hidden'),
        `${action} is multi-only and must stay hidden without a map`
      );
    }
  });

  it('asks the host for a fresh map when the menu opens on an already-selected commit', () => {
    // The re-render path: the row is restored as .selected, so the menu opens
    // without posting a selection change — and without one, the host never
    // recomputes and the map stays null for good.
    h = boot();
    h.posted.length = 0;
    openMenu(h);

    assert.ok(
      h.posted.some((m) => (m as { type?: string }).type === 'selectIfNotSelected'),
      'opening the menu must make the host recompute the gating'
    );
  });

  it('keeps aria-disabled and tabindex in step with a host-greyed row', () => {
    h = boot();
    h.post({
      type: 'updateMenuEnableState',
      state: { cherryPick: { visible: true, enabled: false, reason: 'not on this branch' } },
    });
    const menu = openMenu(h);
    const greyed = rowFor(menu, 'cherryPick');

    assert.ok(greyed.classList.contains('disabled'), 'greyed by class');
    assert.strictEqual(greyed.getAttribute('aria-disabled'), 'true', 'and announced as disabled');
    assert.strictEqual(greyed.getAttribute('tabindex'), '-1', 'and off the Tab order');
  });

  it('puts a row back in the Tab order when the host re-enables it', () => {
    h = boot();
    h.post({
      type: 'updateMenuEnableState',
      state: { cherryPick: { visible: true, enabled: false } },
    });
    openMenu(h);
    h.post({
      type: 'updateMenuEnableState',
      state: { cherryPick: { visible: true, enabled: true } },
    });

    const menu = h.document.getElementById('commit-context-menu');
    assert.ok(menu);
    const row = rowFor(menu, 'cherryPick');
    assert.ok(!row.classList.contains('disabled'));
    assert.strictEqual(row.getAttribute('aria-disabled'), null, 'no longer announced as disabled');
    assert.strictEqual(row.getAttribute('tabindex'), '0', 'and reachable again');
  });

  it("drops the previous selection's gating when the right-click moves the selection", () => {
    // The webview collapses the selection to the clicked commit itself, then
    // asks the host to recompute. The map in hand still describes the OLD
    // selection, and the menu is drawn from it a full round-trip before the
    // real one lands — offering multi-only and history-rewriting rows the host
    // would have greyed for this commit.
    h = bootMultiSelection();
    h.post({
      type: 'updateMenuEnableState',
      state: {
        squashCommits: { visible: true, enabled: true },
        dropCommit: { visible: true, enabled: true },
      },
    });

    const menu = rightClickRow(h, THIRD);

    assert.ok(
      rowFor(menu, 'squashCommits').classList.contains('menu-multi-hidden'),
      'a multi-only row is hidden again the moment the selection collapses to one'
    );
    // Hidden is the whole defence at this layer: the row is display:none, so
    // no pointer reaches it and the keyboard walks only reachable rows. The
    // rows that stay ENABLED under a null map — Drop Commit and friends carry
    // no declared disabled state — are re-checked against the rules host-side
    // before the action fires (webviewMessageRouting).
  });

  it('moves focus off a row that a late map greys out', () => {
    // showAt focuses the first enabled row. When the host's map arrives and
    // disables exactly that row, focus is left on a disabled tabindex="-1"
    // row, where Enter does nothing and the user has no idea why.
    h = bootMultiSelection();
    const menu = rightClickRow(h, THIRD);
    const focused = h.document.activeElement as HTMLElement | null;
    assert.ok(focused && focused.classList.contains('context-menu-item'), 'a row has focus');
    const action = focused.getAttribute('data-action');
    assert.ok(action, 'the focused row carries an action');

    h.post({
      type: 'updateMenuEnableState',
      state: { [action]: { visible: true, enabled: false } },
    });

    const nowFocused = h.document.activeElement as HTMLElement | null;
    assert.ok(nowFocused, 'focus is somewhere');
    assert.ok(
      !nowFocused.classList.contains('disabled'),
      'focus does not sit on a row that cannot be picked'
    );
    assert.ok(
      menu.contains(nowFocused),
      'and it stays in the menu rather than falling back to <body>'
    );
  });
});
