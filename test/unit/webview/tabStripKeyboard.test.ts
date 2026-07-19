/**
 * Tab strip keyboard navigation (WAI-ARIA tabs pattern).
 *
 * The strip declared role="tablist" but implemented none of the keyboard
 * behaviour that role promises: arrows did nothing, so keyboard users could
 * only reach tabs the roving tabindex excluded from the tab order.
 */

import '../../setup';
import * as assert from 'assert';
import { bootWebviewEntry, type IWebviewEntryHarness } from '../../helpers/bootWebviewEntry';
import { renderTabStrip } from '../../../src/git-core/gitToolWindow/html/commonHtml';
import { initIslandHtml } from '../../../src/utils/webviewInit';

const ENTRY = 'git-core/gitToolWindow/webview/gitToolWindow';

/**
 * The host's init island. `restoreFocus` says this boot was caused by a user
 * gesture the host re-rendered for, which is the only time a persisted focus
 * claim may be honoured.
 */
function island(restoreFocus: boolean): string {
  return initIslandHtml({ initialDetails: null, historyDetails: null, restoreFocus });
}

const harnesses: IWebviewEntryHarness[] = [];
afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.dispose();
  }
});

/** Boot with the strip rendered and `active` selected. */
function bootStrip(
  active: 'log' | 'console' | 'history',
  initialState?: unknown,
  restoreFocus = false
): IWebviewEntryHarness {
  const harness = bootWebviewEntry(ENTRY, {
    bodyHtml: renderTabStrip(active) + island(restoreFocus),
    initialState,
  });
  harnesses.push(harness);
  return harness;
}

/**
 * A tab change re-renders the whole document, so the webview boots again with
 * the new active tab and whatever state the last boot persisted.
 */
function rerenderAfterTabChange(
  previous: IWebviewEntryHarness,
  active: 'log' | 'console' | 'history'
): IWebviewEntryHarness {
  return bootStrip(active, previous.readState(), true);
}

/**
 * Drive `document.hasFocus()`, which separates a window blur (document not
 * focused) from an in-page focus move to a non-focusable region (still
 * focused). Both arrive as a focusout with a null relatedTarget.
 */
function setDocumentFocused(harness: IWebviewEntryHarness, focused: boolean): void {
  harness.document.hasFocus = (): boolean => focused;
}

function pressKey(harness: IWebviewEntryHarness, key: string): void {
  const strip = harness.document.querySelector('.intellig-tab-strip');
  assert.ok(strip, 'sanity: strip rendered');
  strip.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key, bubbles: true }));
}

/** Tabs requested via `tabChange`, in order. */
function requestedTabs(harness: IWebviewEntryHarness): string[] {
  return harness.posted
    .filter((m) => (m as { type?: string }).type === 'tabChange')
    .map((m) => (m as { tab: string }).tab);
}

describe('tab strip keyboard navigation', () => {
  it('ArrowRight moves to the next tab', () => {
    const harness = bootStrip('log');

    pressKey(harness, 'ArrowRight');

    assert.deepStrictEqual(requestedTabs(harness), ['console']);
  });

  it('ArrowLeft wraps from the first tab to the last', () => {
    const harness = bootStrip('log');

    pressKey(harness, 'ArrowLeft');

    assert.deepStrictEqual(requestedTabs(harness), ['history']);
  });

  it('Home jumps to the first tab', () => {
    const harness = bootStrip('history');

    pressKey(harness, 'Home');

    assert.deepStrictEqual(requestedTabs(harness), ['log']);
  });

  it('End jumps to the last tab', () => {
    const harness = bootStrip('log');

    pressKey(harness, 'End');

    assert.deepStrictEqual(requestedTabs(harness), ['history']);
  });

  it('ignores keys the pattern does not claim', () => {
    const harness = bootStrip('log');

    pressKey(harness, 'a');

    assert.deepStrictEqual(requestedTabs(harness), []);
  });

  it('keeps moving across the re-render each tab change triggers', () => {
    // The first press worked and then focus fell to <body>, so every press
    // after it was dead.
    const first = bootStrip('log');
    pressKey(first, 'ArrowRight');
    assert.deepStrictEqual(requestedTabs(first), ['console']);

    const second = rerenderAfterTabChange(first, 'console');

    assert.strictEqual(
      second.document.activeElement?.getAttribute('data-tab'),
      'console',
      'the re-rendered document must hand focus back to the active tab'
    );
    pressKey(second, 'ArrowRight');
    assert.deepStrictEqual(requestedTabs(second), ['incoming'], 'the second press still moves');
  });

  it('keeps its focus claim across a window blur', () => {
    // Alt-tabbing away fires focusout with a null relatedTarget while the
    // DOCUMENT loses focus too. Treating that as "focus left the strip" meant a
    // watcher re-render while the window was in the background came back with
    // focus on <body>.
    const first = bootStrip('log');
    pressKey(first, 'ArrowRight');
    const strip = first.document.querySelector('.intellig-tab-strip');
    assert.ok(strip, 'sanity: strip rendered');
    setDocumentFocused(first, false);
    strip.dispatchEvent(
      new first.window.FocusEvent('focusout', { bubbles: true, relatedTarget: null })
    );

    const second = rerenderAfterTabChange(first, 'console');

    assert.strictEqual(
      second.document.activeElement?.getAttribute('data-tab'),
      'console',
      "a blur must not surrender the strip's focus claim"
    );
  });

  it('releases its focus claim when the user clicks dead space in the page', () => {
    // Clicking panel padding, a divider, or any non-focusable region blurs to
    // <body>: relatedTarget is null there too, but the DOCUMENT still has
    // focus. Treating that as a window blur made a later re-render yank focus
    // back to a tab the user had clicked away from.
    const first = bootStrip('log');
    pressKey(first, 'ArrowRight');
    const strip = first.document.querySelector('.intellig-tab-strip');
    setDocumentFocused(first, true);
    strip!.dispatchEvent(
      new first.window.FocusEvent('focusout', { bubbles: true, relatedTarget: null })
    );

    const second = rerenderAfterTabChange(first, 'console');

    assert.notStrictEqual(
      second.document.activeElement?.getAttribute('data-tab'),
      'console',
      'focus the user moved away in-page must not be pulled back'
    );
  });

  it('releases its focus claim when focus moves to another control', () => {
    const first = bootStrip('log');
    pressKey(first, 'ArrowRight');
    const strip = first.document.querySelector('.intellig-tab-strip');
    const elsewhere = first.document.createElement('button');
    first.document.body.appendChild(elsewhere);
    strip!.dispatchEvent(
      new first.window.FocusEvent('focusout', { bubbles: true, relatedTarget: elsewhere })
    );

    const second = rerenderAfterTabChange(first, 'console');

    assert.notStrictEqual(
      second.document.activeElement?.getAttribute('data-tab'),
      'console',
      'focus that genuinely left must not be pulled back'
    );
  });

  it('does not steal focus when the strip never had it', () => {
    const harness = bootStrip('log');

    assert.notStrictEqual(
      harness.document.activeElement?.getAttribute('data-tab'),
      'log',
      'a plain render must not pull focus into the tab strip'
    );
  });

  it('moves focus with the selection so the roving tabindex stays coherent', () => {
    const harness = bootStrip('log');

    pressKey(harness, 'ArrowRight');

    assert.strictEqual(
      harness.document.activeElement?.getAttribute('data-tab'),
      'console',
      'the newly selected tab takes focus'
    );
  });
});

/**
 * Focus restoration is one mechanism with two claimants: the tab strip and the
 * focused commit row.
 *
 * A ctrl-click toggle re-renders the whole document, so the focused
 * `.commit-row` is destroyed — and the delegated keyboard handler keys off
 * `e.target.closest('.commit-row[data-hash]')`, so with focus on <body> the next
 * Shift+Arrow finds no target and the keyboard selection loop is dead. The
 * range-select handlers avoid a full render for exactly this reason; the toggle
 * path re-renders and must hand focus back instead.
 *
 * The claim is only honoured when the HOST says this boot was caused by the
 * gesture it re-rendered for. Persisted webview state outlives the window, so an
 * unconditional restore would pull focus on a cold reopen days later.
 */
describe('commit-row focus survives the re-render a selection toggle triggers', () => {
  const ROW = 'a'.repeat(40);

  /** A log body with two focusable commit rows. */
  function rowsHtml(): string {
    return (
      `<div class="commit-row" data-hash="${ROW}" role="option" tabindex="0"></div>` +
      `<div class="commit-row" data-hash="${'b'.repeat(40)}" role="option" tabindex="0"></div>`
    );
  }

  function bootRows(initialState?: unknown, restoreFocus = false): IWebviewEntryHarness {
    const harness = bootWebviewEntry(ENTRY, {
      bodyHtml: rowsHtml() + island(restoreFocus),
      initialState,
    });
    harnesses.push(harness);
    return harness;
  }

  it('hands focus back to the row that had it', () => {
    const first = bootRows();
    const row = first.document.querySelector(`.commit-row[data-hash="${ROW}"]`) as HTMLElement;
    assert.ok(row, 'sanity: row rendered');
    row.focus();
    row.dispatchEvent(new first.window.FocusEvent('focusin', { bubbles: true }));

    const second = bootRows(first.readState(), true);

    assert.strictEqual(
      second.document.activeElement?.getAttribute('data-hash'),
      ROW,
      'the re-rendered document must hand focus back to the focused commit row'
    );
  });

  it('does not steal focus when no row ever had it', () => {
    const harness = bootRows(undefined, true);

    assert.strictEqual(
      harness.document.activeElement?.closest?.('.commit-row') ?? null,
      null,
      'a render with no focus claim must not pull focus into the graph'
    );
  });

  it('drops the claim when focus moves off the row', () => {
    const first = bootRows();
    const row = first.document.querySelector(`.commit-row[data-hash="${ROW}"]`) as HTMLElement;
    row.focus();
    row.dispatchEvent(new first.window.FocusEvent('focusin', { bubbles: true }));
    const elsewhere = first.document.createElement('button');
    first.document.body.appendChild(elsewhere);
    setDocumentFocused(first, true);
    row.dispatchEvent(
      new first.window.FocusEvent('focusout', { bubbles: true, relatedTarget: elsewhere })
    );

    const second = bootRows(first.readState(), true);

    assert.notStrictEqual(
      second.document.activeElement?.getAttribute('data-hash'),
      ROW,
      'focus that genuinely left must not be pulled back'
    );
  });

  it('keeps its claim across a window blur', () => {
    // The tab strip's counterpart: alt-tabbing away fires focusout with a null
    // relatedTarget while the DOCUMENT loses focus too. The row keeps the focus
    // it will want back, so a watcher re-render while the window is in the
    // background does not come back with focus on <body>.
    const first = bootRows();
    const row = first.document.querySelector(`.commit-row[data-hash="${ROW}"]`) as HTMLElement;
    row.focus();
    row.dispatchEvent(new first.window.FocusEvent('focusin', { bubbles: true }));
    setDocumentFocused(first, false);
    row.dispatchEvent(
      new first.window.FocusEvent('focusout', { bubbles: true, relatedTarget: null })
    );

    const second = bootRows(first.readState(), true);

    assert.strictEqual(
      second.document.activeElement?.getAttribute('data-hash'),
      ROW,
      "a blur must not surrender the row's focus claim"
    );
  });

  it('releases its claim when the user clicks dead space in the page', () => {
    // Same null relatedTarget, but the DOCUMENT still has focus — the user
    // moved focus away in-page, so pulling it back would fight them.
    const first = bootRows();
    const row = first.document.querySelector(`.commit-row[data-hash="${ROW}"]`) as HTMLElement;
    row.focus();
    row.dispatchEvent(new first.window.FocusEvent('focusin', { bubbles: true }));
    setDocumentFocused(first, true);
    row.dispatchEvent(
      new first.window.FocusEvent('focusout', { bubbles: true, relatedTarget: null })
    );

    const second = bootRows(first.readState(), true);

    assert.notStrictEqual(
      second.document.activeElement?.getAttribute('data-hash'),
      ROW,
      'focus the user moved away in-page must not be pulled back'
    );
  });

  it('ignores a persisted claim when the boot was not gesture-caused', () => {
    // vscode.setState survives the window, so reopening the tool window days
    // later boots with the claim still set. Only the host knows whether this
    // render answers a gesture.
    const first = bootStrip('log');
    pressKey(first, 'ArrowRight');

    const reopened = bootStrip('console', first.readState(), false);

    assert.notStrictEqual(
      reopened.document.activeElement?.getAttribute('data-tab'),
      'console',
      'a cold reopen must not pull focus into the tab strip'
    );
  });
});
