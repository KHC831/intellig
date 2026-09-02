/**
 * The shared context-menu widget's own behaviour.
 *
 * The disabled-row rule is here because neither of the other lanes can hold
 * it: jsdom dispatches `.click()` straight at the element, so it cannot see
 * `pointer-events` at all, and the computed-style lane deliberately refuses to
 * report that property (a value that changes hit-testing cannot be validated
 * by measuring paint — see harness.visual.test.ts). So the stylesheet is
 * asserted as text, next to the behaviour it has to support.
 */

import '../../setup';
import * as assert from 'assert';
import { JSDOM } from 'jsdom';
import { ContextMenu, hideAllContextMenus } from '../../../src/webview-common/contextMenu';
import { contextMenuStyles } from '../../../src/webview-common/contextMenuStyles';

interface IHarness {
  menu: ContextMenu;
  picked: string[];
  document: Document;
  dispose(): void;
}

function open(items: Parameters<ContextMenu['render']>[0]): IHarness {
  const dom = new JSDOM('<!doctype html><body></body>');
  const globals = globalThis as { document?: Document; window?: unknown };
  const priorDocument = globals.document;
  const priorWindow = globals.window;
  globals.document = dom.window.document;
  globals.window = dom.window;

  const picked: string[] = [];
  const menu = new ContextMenu({
    ariaLabel: 'Test actions',
    onPick: (action): void => {
      picked.push(action);
    },
  });
  menu.render(items);
  menu.showAt(20, 20);

  return {
    menu,
    picked,
    document: dom.window.document,
    dispose(): void {
      globals.document = priorDocument;
      globals.window = priorWindow;
      dom.window.close();
    },
  };
}

const ITEMS = [
  { action: 'live', label: 'Live Action' },
  { action: 'greyed', label: 'Greyed Action', disabled: true },
];

describe('ContextMenu widget', () => {
  let h: IHarness;

  afterEach(() => {
    if (h) {
      h.dispose();
    }
  });

  it('renders the menu box with its accessibility contract', () => {
    // The menu is built client-side, so its accessibility contract — the
    // id, the class, hidden-by-default, role=menu, the aria-label, and
    // role=menuitem on the rows — is pinned here, where it covers every menu
    // built on this widget at once.
    const dom = new JSDOM('<!doctype html><body></body>');
    const globals = globalThis as { document?: Document; window?: unknown };
    const priorDocument = globals.document;
    const priorWindow = globals.window;
    globals.document = dom.window.document;
    globals.window = dom.window;
    try {
      const menu = new ContextMenu({ id: 'test-menu', ariaLabel: 'Commit actions' });
      menu.render(ITEMS);
      const box = dom.window.document.getElementById('test-menu');
      assert.ok(box, 'the menu carries the id call sites look it up by');
      assert.ok(box.classList.contains('context-menu'), 'and the class the stylesheet targets');
      assert.strictEqual(box.hidden, true, 'a menu starts closed');
      assert.strictEqual(box.getAttribute('role'), 'menu');
      assert.strictEqual(box.getAttribute('aria-label'), 'Commit actions');
      assert.deepStrictEqual(
        Array.from(box.querySelectorAll('.context-menu-item')).map((r) => r.getAttribute('role')),
        ITEMS.map(() => 'menuitem'),
        'every row announces itself as a menu item'
      );
    } finally {
      globals.document = priorDocument;
      globals.window = priorWindow;
      dom.window.close();
    }
  });

  it('spares a menu opened during the very event being dispatched', () => {
    // Several listeners answer one click: one opens a popup, another dismisses
    // stale ones. Whether the opener happens to run first is registration
    // order in a different module, so the widget does not rely on it.
    //
    // Identity of the EVENT, not of the control. An opener element can be
    // arbitrarily large and can contain other openers — a commit row carries
    // tabindex and holds the collapsed-ref chip — so an element-scoped test
    // spared clicks that landed elsewhere in the same row. That mistake left a
    // menu open across a selection change and dropped three commits with one
    // row highlighted.
    const dom = new JSDOM('<!doctype html><body><button id="opener"></button></body>');
    const globals = globalThis as { document?: Document; window?: unknown };
    const priorDocument = globals.document;
    const priorWindow = globals.window;
    globals.document = dom.window.document;
    globals.window = dom.window;
    try {
      const menu = new ContextMenu({ id: 'spared', ariaLabel: 'Test actions' });
      menu.render(ITEMS);
      const opener = dom.window.document.getElementById('opener') as HTMLElement;
      const click = new dom.window.MouseEvent('click', { bubbles: true });

      menu.showAt(10, 10, opener, click);
      hideAllContextMenus(opener, click);
      assert.strictEqual(menu.isOpen, true, 'the gesture that opened it does not close it');

      // A later click anywhere — including inside the opener — does close it.
      const next = new dom.window.MouseEvent('click', { bubbles: true });
      hideAllContextMenus(opener, next);
      assert.strictEqual(menu.isOpen, false, 'a different gesture is a click away');
    } finally {
      globals.document = priorDocument;
      globals.window = priorWindow;
      dom.window.close();
    }
  });

  it('closes on a click on a disabled row, and fires nothing', () => {
    h = open(ITEMS);
    const greyed = h.document.querySelector<HTMLElement>('.context-menu-item.disabled');
    assert.ok(greyed, 'the disabled row must render');

    greyed.click();

    assert.strictEqual(h.menu.isOpen, false, 'a click on a greyed row closes the menu');
    assert.deepStrictEqual(h.picked, [], 'and picks nothing');
  });

  it('does not lift disabled rows out of hit-testing', () => {
    // `pointer-events: none` would retarget the click to the menu box, which
    // every click-away handler reads as a click INSIDE the menu — so the menu
    // would swallow the click and stay open. The test above cannot catch that:
    // jsdom's .click() bypasses hit-testing entirely.
    const disabledRule = /\.context-menu-item\.disabled\s*\{[^}]*\}/.exec(contextMenuStyles());
    assert.ok(disabledRule, 'the stylesheet must style disabled rows');
    assert.ok(
      !/pointer-events\s*:\s*none/.test(disabledRule[0]),
      `disabled rows must stay clickable so the menu can close on them; got ${disabledRule[0]}`
    );
  });

  it('still fires an enabled row', () => {
    h = open(ITEMS);
    h.document.querySelector<HTMLElement>('.context-menu-item:not(.disabled)')?.click();

    assert.deepStrictEqual(h.picked, ['live']);
    assert.strictEqual(h.menu.isOpen, false);
  });

  it('keeps a disabled row off the keyboard path', () => {
    h = open(ITEMS);
    // ArrowDown from the focused first row wraps back to it: the greyed row is
    // the only other one, and it is not a stop.
    h.menu.handleKey('ArrowDown');
    assert.strictEqual(
      (h.document.activeElement as HTMLElement)?.getAttribute('data-action'),
      'live',
      'arrow movement skips greyed rows'
    );
  });

  it('applyStates(null) falls back to the declared enabled state, never to "everything allowed"', () => {
    // No live menu item in the codebase declares `disabled` elsewhere, so
    // without this case nothing proves the fallback actually reads it
    // rather than defaulting everything to enabled. This is the live
    // instance: a rendered item that DOES declare it.
    h = open(ITEMS);
    const greyed = h.document.querySelector<HTMLElement>('[data-action="greyed"]');
    const live = h.document.querySelector<HTMLElement>('[data-action="live"]');
    assert.ok(greyed && live, 'both rows must render');

    h.menu.applyStates(null);

    assert.ok(
      greyed.classList.contains('disabled'),
      'a declared-disabled row must stay disabled when the host sends no gating map'
    );
    assert.strictEqual(greyed.getAttribute('aria-disabled'), 'true');
    assert.strictEqual(greyed.getAttribute('tabindex'), '-1');
    assert.ok(
      !live.classList.contains('disabled'),
      'a row with no declared disabled flag stays enabled'
    );
  });
});

describe('context menu widget — destructive rows', () => {
  let h: IHarness | undefined;

  afterEach(() => {
    h?.dispose();
    h = undefined;
  });

  // The tint is what separates Rollback / Drop Commit / Remove Changelist from
  // an ordinary row before the click lands. Its stylesheet rule is checked in
  // the visual lane, which the merge gate does not run, so the class that rule
  // hangs off is pinned here.
  it('marks a danger item and leaves an ordinary one alone', () => {
    h = open([
      { action: 'rollback', label: 'Rollback…', danger: true },
      { action: 'open', label: 'Open' },
    ]);

    const danger = h.document.querySelector<HTMLElement>('[data-action="rollback"]');
    const plain = h.document.querySelector<HTMLElement>('[data-action="open"]');

    assert.ok(
      danger?.classList.contains('context-menu-danger'),
      'a destructive row must carry the class its tint hangs off'
    );
    assert.ok(
      !plain?.classList.contains('context-menu-danger'),
      'an ordinary row must not be tinted as destructive'
    );
  });

  it('styles the danger class it stamps', () => {
    assert.match(
      contextMenuStyles(),
      /\.context-menu-danger/,
      'the stamped class needs a rule, or destructive rows render like any other'
    );
  });
});
