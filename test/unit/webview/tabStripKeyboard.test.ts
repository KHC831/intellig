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
function bootStrip(active: 'log' | 'console' | 'history'): IWebviewEntryHarness {
  const harness = bootWebviewEntry(ENTRY, { bodyHtml: renderTabStrip(active) });
  harnesses.push(harness);
  return harness;
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
