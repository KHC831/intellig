/**
 * Author filter "me" preset (F-A21) — UserFilterPopupComponent parity.
 *
 * The reference offers a "me" preset when the current user is known,
 * resolving to the configured identity. `authorOptionsReady` carries the
 * resolved identity as `me`; the popup renders a "me" item right after
 * "All users" that applies that identity as the author filter.
 */

import '../../../setup';
import * as assert from 'assert';
import { bootWebviewEntry, IWebviewEntryHarness } from '../../../helpers/bootWebviewEntry';

const ENTRY = 'git-core/gitToolWindow/webview/gitToolWindow';

function boot(): IWebviewEntryHarness {
  return bootWebviewEntry(ENTRY, {
    bodyHtml: `<div class="graph-panel"></div><div id="filter-author-list"></div>`,
  });
}

describe('Author popup — "me" preset (F-A21)', () => {
  let h: IWebviewEntryHarness;

  afterEach(() => {
    if (h) {
      h.dispose();
    }
  });

  it('renders a "me" item after "All users" when the identity is known', () => {
    h = boot();
    h.post({
      type: 'authorOptionsReady',
      authors: ['Alice <alice@a.com>', 'Bob <bob@b.com>'],
      me: 'Alice <alice@a.com>',
    });

    const list = h.document.getElementById('filter-author-list') as HTMLElement;
    const items = Array.from(list.querySelectorAll('button'));
    assert.strictEqual(items[0]?.textContent, 'All users');
    assert.strictEqual(items[1]?.textContent, 'me', 'the "me" preset follows All users');
    assert.strictEqual(
      items[1]?.getAttribute('data-author'),
      'Alice <alice@a.com>',
      'picking "me" applies the resolved identity as the author filter'
    );
    assert.strictEqual(
      items[1]?.getAttribute('data-action'),
      'pickAuthorFilter',
      'the "me" item routes through the same pick action'
    );
  });

  it('omits the "me" item when the identity is unknown', () => {
    h = boot();
    h.post({
      type: 'authorOptionsReady',
      authors: ['Alice <alice@a.com>'],
    });

    const list = h.document.getElementById('filter-author-list') as HTMLElement;
    // Presets are buttons; individual authors are multi-select checkboxes.
    const presets = Array.from(list.querySelectorAll('button')).map((b) => b.textContent);
    assert.deepStrictEqual(presets, ['All users'], 'no "me" preset without an identity');
    const authors = Array.from(
      list.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-author]')
    ).map((b) => b.getAttribute('data-author'));
    assert.deepStrictEqual(authors, ['Alice <alice@a.com>'], 'the author still offered to pick');
  });
});
