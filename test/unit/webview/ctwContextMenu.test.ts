/**
 * A real context menu for the Commit tool window (issue #5, route 4).
 *
 * A QuickPick is not a context menu — VS Code's command-palette widget opens
 * at the top-centre of the window regardless of where it was triggered, so
 * it appears nowhere near the row and loses the pointer entirely.
 *
 * The Git tool window already draws a proper menu under the pointer
 * (`positionContextMenu` in commitRowMenus.ts); the Commit window is the one
 * place that never got one. These tests cover the webview half: the menu
 * renders where you clicked, from items the host supplies, and dismisses the
 * way a menu should.
 */

import '../../setup';
import * as assert from 'assert';
import {
  buildCommitToolWindowBodyParts,
  buildCommitToolWindowInitModel,
} from '../../../src/commits/CommitToolWindow';
import type {
  IChangelist,
  IFileChange,
} from '../../../src/changelists/interfaces/IChangelistService';
import { bootWebviewEntry, IWebviewEntryHarness } from '../../helpers/bootWebviewEntry';

function file(path: string, status: IFileChange['status']): IFileChange {
  return { path, status, staged: false };
}

function boot(files: IFileChange[]): IWebviewEntryHarness {
  const changelist: IChangelist = {
    id: 'default',
    name: 'Changes',
    isDefault: true,
    isActive: true,
    files,
  };
  const { body } = buildCommitToolWindowBodyParts({
    activeTab: 'localChanges',
    changelists: [changelist],
    shelfItems: [],
    composer: { message: '', amend: false, signOff: false },
    activeChangelistId: 'default',
  });
  return bootWebviewEntry('commits/webview/commitToolWindow', { bodyHtml: body });
}

const FILES = [file('pom.xml', 'modified'), file('Service.java', 'conflicted')];

const ITEMS = [
  { label: 'Resolve…', action: 'resolveConflictFile' },
  { label: 'Accept Yours', action: 'acceptYours' },
  { label: 'Show Diff', action: 'showDiff', shortcut: 'Ctrl+D' },
];

/** Right-click a row and hand back the host's menu reply. */
function openMenuOn(h: IWebviewEntryHarness, path: string, x = 120, y = 90): void {
  const row = h.document.querySelector<HTMLElement>(`.ctw-file-row[data-path="${path}"]`);
  assert.ok(row, `row for ${path} must exist`);
  const ev = new h.window.MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  });
  row.dispatchEvent(ev);
  h.post({ type: 'showRowContextMenu', path, changelistId: 'default', items: ITEMS });
}

describe('webview: Commit window context menu (jsdom)', () => {
  let h: IWebviewEntryHarness;

  afterEach(() => {
    if (h) {
      h.dispose();
    }
  });

  it('renders nothing until a right-click is answered', () => {
    h = boot(FILES);
    const menu = h.document.querySelector<HTMLElement>('.context-menu');
    assert.ok(!menu || menu.hidden, 'the menu starts hidden');
  });

  it('renders the host-supplied items in order', () => {
    h = boot(FILES);
    openMenuOn(h, 'Service.java');

    const menu = h.document.querySelector<HTMLElement>('.context-menu');
    assert.ok(menu && !menu.hidden, 'menu must be visible after the host replies');
    assert.deepStrictEqual(
      Array.from(menu.querySelectorAll('.context-menu-item')).map((i) =>
        (i.textContent ?? '').replace(/Ctrl\+D/, '').trim()
      ),
      ['Resolve…', 'Accept Yours', 'Show Diff']
    );
  });

  it('places the menu at the pointer', () => {
    h = boot(FILES);
    openMenuOn(h, 'Service.java', 140, 200);

    const menu = h.document.querySelector<HTMLElement>('.context-menu');
    assert.ok(menu);
    assert.strictEqual(menu.style.left, '140px');
    assert.strictEqual(menu.style.top, '200px');
  });

  it('keeps the menu inside the window when the click is near an edge', () => {
    h = boot(FILES);
    // jsdom reports 1024x768 by default; a click at the far right must not
    // place a 220px-wide menu off-screen.
    openMenuOn(h, 'Service.java', 1020, 60);

    const menu = h.document.querySelector<HTMLElement>('.context-menu');
    assert.ok(menu);
    const left = parseInt(menu.style.left, 10);
    assert.ok(
      left + 220 <= h.window.innerWidth,
      `menu at left=${left} would overflow a ${h.window.innerWidth}px window`
    );
  });

  it('budgets height from the clamped top, not the raw pointer', () => {
    // A click low in a short panel is pulled upward by the clamp. Measuring the
    // height budget from where the pointer WAS then leaves the menu drawn high
    // with a sliver of the room it actually has, and a scrollbar.
    h = boot(FILES);
    const shortPanel = 500;
    Object.defineProperty(h.window, 'innerHeight', { value: shortPanel, configurable: true });
    openMenuOn(h, 'Service.java', 100, 400);

    const menu = h.document.querySelector<HTMLElement>('.context-menu');
    assert.ok(menu);
    const top = parseInt(menu.style.top, 10);
    const maxHeight = parseInt(menu.style.maxHeight, 10);
    assert.ok(
      top + maxHeight <= shortPanel,
      `menu at top=${top} with maxHeight=${maxHeight} overflows a ${shortPanel}px panel`
    );
    assert.ok(
      maxHeight >= shortPanel - top - 16,
      `menu was given ${maxHeight}px when roughly ${shortPanel - top}px were available`
    );
  });

  it('posts the picked action with the row it was opened on', () => {
    h = boot(FILES);
    openMenuOn(h, 'Service.java');
    h.posted.length = 0;

    h.document.querySelector<HTMLElement>('.context-menu-item')?.click();

    const sent = h.posted.filter(
      (m) => (m as { type?: string }).type === 'changelistContextAction'
    ) as Array<{ action?: string; path?: string }>;
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].action, 'resolveConflictFile');
    assert.strictEqual(sent[0].path, 'Service.java');
  });

  it('hides after a pick', () => {
    h = boot(FILES);
    openMenuOn(h, 'Service.java');
    h.document.querySelector<HTMLElement>('.context-menu-item')?.click();

    const menu = h.document.querySelector<HTMLElement>('.context-menu');
    assert.ok(menu?.hidden, 'a menu stays open after a pick only if something is broken');
  });

  it('hides on a click elsewhere, without firing an action', () => {
    h = boot(FILES);
    openMenuOn(h, 'Service.java');
    h.posted.length = 0;

    h.document.body.click();

    const menu = h.document.querySelector<HTMLElement>('.context-menu');
    assert.ok(menu?.hidden, 'click-away must dismiss');
    assert.deepStrictEqual(
      h.posted.filter((m) => (m as { type?: string }).type === 'changelistContextAction'),
      [],
      'dismissing is not choosing'
    );
  });

  it('hides on Escape', () => {
    h = boot(FILES);
    openMenuOn(h, 'Service.java');

    h.document.dispatchEvent(
      new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );

    const menu = h.document.querySelector<HTMLElement>('.context-menu');
    assert.ok(menu?.hidden, 'Escape must dismiss');
  });

  it('retargets when a second row is right-clicked', () => {
    h = boot(FILES);
    openMenuOn(h, 'Service.java');
    openMenuOn(h, 'pom.xml', 200, 300);
    h.posted.length = 0;

    h.document.querySelector<HTMLElement>('.context-menu-item')?.click();

    const sent = h.posted.filter(
      (m) => (m as { type?: string }).type === 'changelistContextAction'
    ) as Array<{ path?: string }>;
    assert.strictEqual(sent[0]?.path, 'pom.xml', 'the second right-click owns the menu');
  });

  it('drops an unanswered right-click when the user clicks away', () => {
    // The host's reply is async. A user who right-clicks, changes their mind
    // and clicks elsewhere must not have the menu appear afterwards at the
    // pointer position of the gesture they abandoned.
    h = boot(FILES);
    const row = h.document.querySelector<HTMLElement>('.ctw-file-row[data-path="pom.xml"]');
    row?.dispatchEvent(
      new h.window.MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 90,
        clientY: 90,
      })
    );
    h.document.body.click();

    // The reply lands late.
    h.post({ type: 'showRowContextMenu', path: 'pom.xml', changelistId: 'default', items: ITEMS });

    const menu = h.document.querySelector<HTMLElement>('.context-menu');
    assert.ok(!menu || menu.hidden, 'a reply for an abandoned right-click must not open a menu');
  });

  it('a stale reply for an ABANDONED right-click does not replace the menu open for a later one', () => {
    // A right-click hides whatever menu is open, so a second right-click
    // always supersedes an unanswered first one. What still has to hold: a
    // stale, out-of-order reply must never clobber the menu the user is
    // CURRENTLY looking at — right-click Service.java (no reply yet),
    // right-click pom.xml (no reply
    // yet either — supersedes Service.java's pending click), pom.xml's reply
    // lands and opens its menu, and Service.java's reply, arriving even
    // later, must not reopen or replace it.
    h = boot(FILES);
    const serviceRow = h.document.querySelector<HTMLElement>(
      '.ctw-file-row[data-path="Service.java"]'
    );
    serviceRow?.dispatchEvent(
      new h.window.MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY: 10,
      })
    );
    const pomRow = h.document.querySelector<HTMLElement>('.ctw-file-row[data-path="pom.xml"]');
    pomRow?.dispatchEvent(
      new h.window.MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 200,
        clientY: 300,
      })
    );

    h.post({ type: 'showRowContextMenu', path: 'pom.xml', changelistId: 'default', items: ITEMS });
    const openMenu = h.document.querySelector<HTMLElement>('.context-menu');
    assert.ok(openMenu && !openMenu.hidden, "pom.xml's menu must be open once its reply lands");

    // Service.java's reply, for the right-click the second one superseded,
    // lands late.
    h.post({
      type: 'showRowContextMenu',
      path: 'Service.java',
      changelistId: 'default',
      items: ITEMS,
    });

    h.posted.length = 0;
    h.document.querySelector<HTMLElement>('.context-menu-item')?.click();
    const picked = h.posted.filter(
      (m) => (m as { type?: string }).type === 'changelistContextAction'
    ) as Array<{ path?: string }>;
    assert.strictEqual(
      picked[0]?.path,
      'pom.xml',
      "Service.java's stale reply must not have replaced pom.xml's open menu"
    );
  });

  it('focuses the first item on open, so a keyboard user reaches it', () => {
    h = boot(FILES);
    openMenuOn(h, 'Service.java');
    const first = h.document.querySelector('.context-menu-item');
    assert.strictEqual(
      h.document.activeElement,
      first,
      'the menu is appended to body — without focus a keyboard user must Tab the whole document'
    );
  });

  it('moves between items with the arrow keys and picks with Enter', () => {
    h = boot(FILES);
    openMenuOn(h, 'Service.java');
    h.posted.length = 0;

    // Dispatched at the focused row, the way the browser delivers a keypress:
    // the menu only answers movement keys aimed inside it.
    const key = (k: string): void => {
      (h.document.activeElement ?? h.document).dispatchEvent(
        new h.window.KeyboardEvent('keydown', { key: k, bubbles: true })
      );
    };
    key('ArrowDown');
    key('Enter');

    const sent = h.posted.filter(
      (m) => (m as { type?: string }).type === 'changelistContextAction'
    ) as Array<{ action?: string }>;
    assert.strictEqual(sent.length, 1, 'Enter picks the focused item');
    assert.strictEqual(sent[0].action, 'acceptYours', 'ArrowDown moved to the second item');
  });

  it('leaves the composer alone when an arrow key is pressed while typing', () => {
    // The menu takes focus when it opens, but the user can Tab or click into
    // the message field with it still up. An unscoped key handler answers that
    // ArrowDown by yanking focus back into the menu and swallowing the caret
    // move.
    h = boot(FILES);
    openMenuOn(h, 'Service.java');
    const composer = h.document.querySelector<HTMLTextAreaElement>('.ctw-composer-msg');
    assert.ok(composer, 'the composer must exist');
    composer.focus();

    composer.dispatchEvent(
      new h.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
    );

    assert.strictEqual(h.document.activeElement, composer, 'focus stays in the message field');
  });

  it('closes on a click on a disabled item, without firing it', () => {
    h = boot(FILES);
    const row = h.document.querySelector<HTMLElement>('.ctw-file-row[data-path="pom.xml"]');
    row?.dispatchEvent(
      new h.window.MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 50,
        clientY: 50,
      })
    );
    h.post({
      type: 'showRowContextMenu',
      path: 'pom.xml',
      changelistId: 'default',
      items: [{ label: 'Set Active Changelist', action: 'setActive', disabled: true }],
    });
    h.posted.length = 0;

    h.document.querySelector<HTMLElement>('.context-menu-item')?.click();

    // A click that lands on a greyed row is a click on nothing actionable, and
    // a menu closes on that the same as it closes on a click outside. Leaving
    // it open strands the user with a menu that swallowed their click.
    const menu = h.document.querySelector<HTMLElement>('.context-menu');
    assert.ok(menu?.hidden, 'a disabled pick still closes the menu');
    assert.deepStrictEqual(
      h.posted.filter((m) => (m as { type?: string }).type === 'changelistContextAction'),
      [],
      'and fires nothing'
    );
  });

  it('closes when its row flips untracked-ness underneath it, changelist and path unchanged', () => {
    // This is defence-in-depth, not a fix for a reachable bug: an untracked
    // file always lives in the unversioned pseudo-changelist
    // (partitionUnversionedFiles), so a real tracked<->untracked flip also
    // changes data-changelist, which the pre-existing changelist match in
    // rowSignature already catches on its own. The untracked-ness arm exists
    // because rowSignature's contract is that every arm carries the state
    // its own menu's contents depend on (here, the "Add to VCS" item
    // fileContextMenuLabels branches on) — so the arm stays correct if the
    // unversioned hoist ever becomes conditional. To pin the untracked-ness
    // encoding itself, the render model below is hand-edited to hold path
    // AND changelist fixed and flip only `untracked`, isolating exactly the
    // state this arm depends on.
    h = boot([file('a.txt', 'modified')]);
    const row = h.document.querySelector<HTMLElement>('.ctw-file-row[data-path="a.txt"]');
    assert.ok(row, 'row for a.txt must exist');
    row.dispatchEvent(
      new h.window.MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 80,
        clientY: 80,
      })
    );
    h.post({
      type: 'showRowContextMenu',
      path: 'a.txt',
      changelistId: 'default',
      items: [{ label: 'Show Diff', action: 'showDiff' }],
    });
    const openMenu = h.document.querySelector<HTMLElement>('.context-menu');
    assert.ok(openMenu && !openMenu.hidden, "a.txt's menu must be open before the update");

    const model = buildCommitToolWindowInitModel({
      activeTab: 'localChanges',
      changelists: [
        {
          id: 'default',
          name: 'Changes',
          isDefault: true,
          isActive: true,
          files: [file('a.txt', 'modified')],
        },
      ],
      shelfItems: [],
      composer: { message: '', amend: false, signOff: false },
      activeChangelistId: 'default',
    });
    const entry = model.local.changelists[0]?.files?.[0];
    assert.ok(entry, 'the built model must carry a.txt as a flat file entry');
    entry.untracked = true;
    h.post({ type: 'updateModel', model });

    const menu = h.document.querySelector<HTMLElement>('.context-menu');
    assert.ok(
      menu && menu.hidden,
      'an untracked-ness flip on the SAME row must close the stale menu, not leave a menu built ' +
        'for one state showing over the other'
    );
  });

  it('still asks the host for the menu on right-click', () => {
    h = boot(FILES);
    h.posted.length = 0;
    const row = h.document.querySelector<HTMLElement>('.ctw-file-row[data-path="pom.xml"]');
    row?.dispatchEvent(new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

    const asks = h.posted.filter(
      (m) => (m as { action?: string }).action === 'contextOpen'
    ) as Array<{ path?: string }>;
    assert.strictEqual(asks.length, 1, 'the host still owns what the menu contains');
    assert.strictEqual(asks[0].path, 'pom.xml');
  });

  it('closes an open menu on a second right-click even when the host never answers it', () => {
    // When the host bails on the reply (CONTEXT_OPEN_BAIL, e.g. a shelf
    // entry deleted since the click), the common "reply lands and show()
    // redraws" path never runs — rememberClick's own hide() must close the
    // previous row's menu instead, or it stays painted.
    h = boot(FILES);
    openMenuOn(h, 'Service.java');
    assert.ok(
      !h.document.querySelector<HTMLElement>('.context-menu')?.hidden,
      "Service.java's menu must be open before the second right-click"
    );

    // Right-click pom.xml but never answer it — simulates the host bailing.
    const pomRow = h.document.querySelector<HTMLElement>('.ctw-file-row[data-path="pom.xml"]');
    assert.ok(pomRow);
    pomRow.dispatchEvent(
      new h.window.MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY: 10,
      })
    );

    const menu = h.document.querySelector<HTMLElement>('.context-menu');
    assert.ok(
      menu && menu.hidden,
      "Service.java's stale menu must close on the second right-click, not wait for a reply that never comes"
    );
  });
});
