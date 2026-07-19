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

const ENTRY = 'git-core/gitToolWindow/webview/gitToolWindow';

const harnesses: IWebviewEntryHarness[] = [];
afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.dispose();
  }
});

/** Boot with the strip rendered and `active` selected. */
function bootStrip(
  active: 'log' | 'console' | 'history',
  initialState?: unknown
): IWebviewEntryHarness {
  const harness = bootWebviewEntry(ENTRY, { bodyHtml: renderTabStrip(active), initialState });
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
  return bootStrip(active, previous.readState());
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
