/**
 * "Go to Parent Commit" on a merge commit offers a choice of parents.
 *
 * A commit with one parent jumps straight there; a merge has two or more, so
 * the menu answers with a small popup of the candidates. The popup is built
 * on the shared widget, so its placement and row markup are the widget's.
 */

import '../../setup';
import * as assert from 'assert';
import { bootWebviewEntry, IWebviewEntryHarness } from '../../helpers/bootWebviewEntry';

const ENTRY = 'git-core/gitToolWindow/webview/gitToolWindow';
const MERGE = 'm'.repeat(40);
const PARENT_A = 'a'.repeat(40);
const PARENT_B = 'b'.repeat(40);

function boot(parents: string): IWebviewEntryHarness {
  return bootWebviewEntry(ENTRY, {
    bodyHtml:
      `<div class="graph-panel">` +
      `<div class="commit-row" data-hash="${MERGE}" data-parents="${parents}" tabindex="0"></div>` +
      `<div class="commit-row" data-hash="${PARENT_A}" data-parents=""></div>` +
      `<div class="commit-row" data-hash="${PARENT_B}" data-parents=""></div>` +
      `</div>`,
  });
}

/** Right-click the merge row, then pick an entry from the commit menu. */
function pick(h: IWebviewEntryHarness, action: string): void {
  const row = h.document.querySelector<HTMLElement>(`.commit-row[data-hash="${MERGE}"]`);
  assert.ok(row, 'the merge row must exist');
  row.dispatchEvent(
    new h.window.MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 60,
      clientY: 80,
    })
  );
  const entry = h.document.querySelector<HTMLElement>(
    `#commit-context-menu .context-menu-item[data-action="${action}"]`
  );
  assert.ok(entry, `the menu must offer ${action}`);
  entry.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

describe('webview: parent/child navigation popup (jsdom)', () => {
  let h: IWebviewEntryHarness;

  afterEach(() => {
    if (h) {
      h.dispose();
    }
  });

  it('offers one row per parent of a merge commit', () => {
    h = boot(`${PARENT_A},${PARENT_B}`);
    pick(h, 'goToParent');

    const popup = h.document.getElementById('nav-popup');
    assert.ok(popup && !popup.hidden, 'the popup must be shown');
    assert.deepStrictEqual(
      Array.from(popup.querySelectorAll('.context-menu-item')).map((r) => r.textContent),
      [PARENT_A.substring(0, 8), PARENT_B.substring(0, 8)],
      'one row per parent, labelled by short hash'
    );
  });

  it('jumps to the parent that was picked', () => {
    h = boot(`${PARENT_A},${PARENT_B}`);
    pick(h, 'goToParent');
    h.posted.length = 0;

    const rows = h.document.querySelectorAll<HTMLElement>('#nav-popup .context-menu-item');
    rows[1].dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    const selected = h.posted.filter(
      (m) => (m as { type?: string }).type === 'selectCommit'
    ) as Array<{ commitHash?: string }>;
    assert.strictEqual(selected.length, 1, 'picking a row jumps once');
    assert.strictEqual(selected[0].commitHash, PARENT_B);
    assert.strictEqual(h.document.getElementById('nav-popup')?.hidden, true, 'and dismisses');
  });

  it('skips the popup when a commit has a single parent', () => {
    h = boot(PARENT_A);
    h.posted.length = 0;
    pick(h, 'goToParent');

    assert.ok(
      !h.document.getElementById('nav-popup') || h.document.getElementById('nav-popup')?.hidden,
      'one candidate needs no choice'
    );
    const selected = h.posted.filter((m) => (m as { type?: string }).type === 'selectCommit');
    assert.strictEqual(selected.length, 1, 'it jumps straight there');
  });

  it('dismisses on a click away, without jumping', () => {
    h = boot(`${PARENT_A},${PARENT_B}`);
    pick(h, 'goToParent');
    h.posted.length = 0;

    h.document.body.click();

    assert.strictEqual(h.document.getElementById('nav-popup')?.hidden, true);
    assert.deepStrictEqual(
      h.posted.filter((m) => (m as { type?: string }).type === 'selectCommit'),
      [],
      'dismissing is not choosing'
    );
  });
});
