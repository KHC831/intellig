/**
 * Ctrl+L focuses the log's text filter (IntelliJ Vcs.Log.FocusTextFilter,
 * platform/vcs-log/impl/resources/intellij.platform.vcs.log.impl.xml:198-199 —
 * `control L` on $default with no macOS override).
 *
 * The keybinding is only half the feature: the host has to reach the search
 * input inside the webview, so this drives the real entry.
 */

import '../../setup';
import * as assert from 'assert';
import { bootWebviewEntry, type IWebviewEntryHarness } from '../../helpers/bootWebviewEntry';

const ENTRY = 'git-core/gitToolWindow/webview/gitToolWindow';

const harnesses: IWebviewEntryHarness[] = [];
afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.dispose();
  }
});

/** Body carrying the log filter's search input, as the host renders it. */
const FILTER_BODY = `
  <div class="log-filter-search">
    <input id="filter-search" class="log-filter-search-input" type="text" value="wip" />
  </div>`;

function boot(bodyHtml = FILTER_BODY): IWebviewEntryHarness {
  const harness = bootWebviewEntry(ENTRY, { bodyHtml });
  harnesses.push(harness);
  return harness;
}

describe('focusTextFilter', () => {
  it('focuses the search input when the host asks', () => {
    const harness = boot();

    harness.post({ type: 'focusTextFilter' });

    assert.strictEqual(harness.document.activeElement?.id, 'filter-search');
  });

  it('selects the existing text so typing replaces the current filter', () => {
    const harness = boot();

    harness.post({ type: 'focusTextFilter' });

    const input = harness.document.getElementById('filter-search') as HTMLInputElement;
    assert.strictEqual(input.selectionStart, 0);
    assert.strictEqual(input.selectionEnd, 'wip'.length);
  });

  it('is a no-op when the filter input is absent', () => {
    const harness = boot('<div class="no-filter-here"></div>');

    harness.post({ type: 'focusTextFilter' });

    assert.deepStrictEqual(harness.errors, []);
  });
});
