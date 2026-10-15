/**
 * Details-panel changed-file context menu + History-tab revision context menu.
 *
 * Right-clicking a changed file in the log details panel opens a file menu
 * whose entries relay to the registered `intellig.commit.*` commands (host
 * side), mirroring IntelliJ's Vcs.RepositoryChangesBrowserMenu; right-clicking
 * a history revision row opens the compare menu. This drives the real bundled
 * entry under jsdom over the real host-built menu markup.
 */

import '../../setup';
import * as assert from 'assert';
import { bootWebviewEntry, IWebviewEntryHarness } from '../../helpers/bootWebviewEntry';

const ENTRY = 'git-core/gitToolWindow/webview/gitToolWindow';
const SHA = 'a'.repeat(40);

function rightClick(h: IWebviewEntryHarness, el: Element): void {
  el.dispatchEvent(
    new h.window.MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 5,
      clientY: 5,
    })
  );
}

function click(h: IWebviewEntryHarness, el: Element): void {
  el.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

describe('webview: details-panel file context menu', () => {
  let h: IWebviewEntryHarness;

  afterEach(() => {
    h.dispose();
  });

  function boot(): void {
    h = bootWebviewEntry(ENTRY, {
      // No menu markup is seeded: the webview builds its own menus at boot.
      bodyHtml: `<div class="changed-file-item" data-path="src/a.ts" data-commit-hash="${SHA}">a.ts</div>`,
    });
    assert.deepStrictEqual(
      h.errors.map((e) => e.message),
      [],
      'entry must boot clean'
    );
  }

  it('right-click on a changed file shows the menu', () => {
    boot();
    const item = h.document.querySelector('.changed-file-item');
    assert.ok(item);
    rightClick(h, item);
    const menu = h.document.getElementById('file-context-menu');
    assert.ok(menu, 'menu element must exist');
    assert.strictEqual(menu.hidden, false, 'menu must be shown on right-click');
  });

  for (const [action, label] of [
    ['showDiff', 'Show Diff'],
    ['openRepositoryVersion', 'Open Repository Version'],
    ['fileHistoryFromHere', 'Show History for Revision'],
  ] as const) {
    it(`clicking "${label}" posts fileContextAction/${action} with hash + path`, () => {
      boot();
      const item = h.document.querySelector('.changed-file-item');
      assert.ok(item);
      rightClick(h, item);
      const entry = h.document.querySelector(
        `#file-context-menu .context-menu-item[data-file-action="${action}"]`
      );
      assert.ok(entry, `menu must carry a ${action} entry`);
      click(h, entry);
      const msg = h.posted.find((m) => (m as { type?: string }).type === 'fileContextAction') as
        { action?: string; commitHash?: string; path?: string } | undefined;
      assert.ok(msg, `clicking must post fileContextAction; posted: ${JSON.stringify(h.posted)}`);
      assert.strictEqual(msg.action, action);
      assert.strictEqual(msg.commitHash, SHA);
      assert.strictEqual(msg.path, 'src/a.ts');
      const menu = h.document.getElementById('file-context-menu');
      assert.strictEqual(menu?.hidden, true, 'menu must close after dispatch');
    });
  }
});

describe('webview: history-tab revision context menu', () => {
  let h: IWebviewEntryHarness;

  afterEach(() => {
    h.dispose();
  });

  function boot(): void {
    h = bootWebviewEntry(ENTRY, {
      bodyHtml: `<div class="history-commit-row" data-rev="${SHA}">row</div>`,
    });
    assert.deepStrictEqual(
      h.errors.map((e) => e.message),
      [],
      'entry must boot clean'
    );
  }

  it('right-click on a revision row shows the menu', () => {
    boot();
    const row = h.document.querySelector('.history-commit-row');
    assert.ok(row);
    rightClick(h, row);
    const menu = h.document.getElementById('history-context-menu');
    assert.ok(menu);
    assert.strictEqual(menu.hidden, false);
  });

  for (const [action, type] of [
    ['compareWithHead', 'history.compareWithHead'],
    ['compareWithRef', 'history.compareWithRef'],
  ] as const) {
    it(`clicking ${action} posts ${type} with the revision`, () => {
      boot();
      const row = h.document.querySelector('.history-commit-row');
      assert.ok(row);
      rightClick(h, row);
      const entry = h.document.querySelector(
        `#history-context-menu .context-menu-item[data-history-action="${action}"]`
      );
      assert.ok(entry, `menu must carry a ${action} entry`);
      click(h, entry);
      const msg = h.posted.find((m) => (m as { type?: string }).type === type) as
        { rev?: string } | undefined;
      assert.ok(msg, `clicking must post ${type}; posted: ${JSON.stringify(h.posted)}`);
      assert.strictEqual(msg.rev, SHA);
      const menu = h.document.getElementById('history-context-menu');
      assert.strictEqual(menu?.hidden, true, 'menu must close after dispatch');
    });
  }
});
