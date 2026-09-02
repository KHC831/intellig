/**
 * The Commit window's button-anchored menus: which panels closeButtonMenus
 * dismisses.
 *
 * Panels are found by a `data-ctw-button-menu` attribute stamped on them at
 * construction, not by a hard-coded selector list — a third button-anchored
 * panel added later is discovered the same way the first two are, with
 * nothing to update in this file.
 */
import '../../setup';
import * as assert from 'assert';
import { JSDOM } from 'jsdom';
import {
  closeButtonMenus,
  buttonMenuTrigger,
  createButtonMenuPanel,
} from '../../../src/commits/webview/ctwButtonMenus';

interface IHarness {
  document: Document;
  dispose(): void;
}

interface IWebviewGlobals {
  document?: Document;
  window?: unknown;
  Element?: unknown;
  HTMLElement?: unknown;
  Node?: unknown;
}

function boot(bodyHtml: string): IHarness {
  const dom = new JSDOM(`<!doctype html><body>${bodyHtml}</body>`);
  const globals = globalThis as IWebviewGlobals;
  const prior: IWebviewGlobals = {
    document: globals.document,
    window: globals.window,
    Element: globals.Element,
    HTMLElement: globals.HTMLElement,
    Node: globals.Node,
  };
  globals.document = dom.window.document;
  globals.window = dom.window;
  globals.Element = dom.window.Element;
  globals.HTMLElement = dom.window.HTMLElement;
  globals.Node = dom.window.Node;
  return {
    document: dom.window.document,
    dispose(): void {
      Object.assign(globals, prior);
    },
  };
}

describe('webview: Commit window button-menu panel discovery (jsdom)', () => {
  let h: IHarness;

  afterEach(() => {
    h?.dispose();
  });

  it('closes a panel stamped data-ctw-button-menu even though it is not one of the two originally-known panels', () => {
    h = boot(`
      <div class="ctw-gear-menu" data-ctw-button-menu></div>
      <div class="ctw-primary-menu" data-ctw-button-menu></div>
      <div class="ctw-third-menu" data-ctw-button-menu></div>
    `);
    const third = h.document.querySelector<HTMLElement>('.ctw-third-menu');
    assert.ok(third);
    third.hidden = false;

    closeButtonMenus();

    assert.ok(third.hidden, 'a third stamped panel must close like the first two');
  });

  it('does not touch a plain div that carries no data-ctw-button-menu attribute', () => {
    h = boot(`<div class="ctw-not-a-menu"></div>`);
    const other = h.document.querySelector<HTMLElement>('.ctw-not-a-menu');
    assert.ok(other);
    other.hidden = false;

    closeButtonMenus();

    assert.strictEqual(other.hidden, false, 'an unstamped element is out of scope');
  });

  it('spares the panel the click landed inside', () => {
    h = boot(
      `<div class="ctw-gear-menu" data-ctw-button-menu><button class="item"></button></div>`
    );
    const panel = h.document.querySelector<HTMLElement>('.ctw-gear-menu');
    const item = h.document.querySelector<HTMLElement>('.item');
    assert.ok(panel && item);
    panel.hidden = false;

    closeButtonMenus(item);

    assert.strictEqual(panel.hidden, false, 'a click inside the panel must not close it');
  });

  it('spares the panel whose own trigger was clicked', () => {
    h = boot(`
      <div class="ctw-gear-wrap"><button class="ctw-gear"></button></div>
      <div class="ctw-gear-menu" data-ctw-button-menu></div>
    `);
    const panel = h.document.querySelector<HTMLElement>('.ctw-gear-menu');
    const trigger = h.document.querySelector<HTMLElement>('.ctw-gear');
    assert.ok(panel && trigger);
    panel.hidden = false;

    closeButtonMenus(undefined, trigger);

    assert.strictEqual(panel.hidden, false, "the trigger's own click must not close its panel");
  });

  it('buttonMenuTrigger finds the closest .ctw-gear or .ctw-btn-commit-dropdown ancestor', () => {
    h = boot(`<button class="ctw-gear"><span class="inner"></span></button>`);
    const inner = h.document.querySelector<HTMLElement>('.inner');
    assert.ok(inner);

    const trigger = buttonMenuTrigger(inner);

    assert.ok(trigger?.classList.contains('ctw-gear'));
  });

  it('buttonMenuTrigger returns null for a click outside any trigger', () => {
    h = boot(`<div class="elsewhere"></div>`);
    const elsewhere = h.document.querySelector<HTMLElement>('.elsewhere');
    assert.ok(elsewhere);

    assert.strictEqual(buttonMenuTrigger(elsewhere), null);
  });

  it('createButtonMenuPanel stamps the panel it builds, so closeButtonMenus finds it with no separate step', () => {
    h = boot('');
    const panel = createButtonMenuPanel('ctw-third-menu');
    h.document.body.appendChild(panel);
    panel.hidden = false;

    closeButtonMenus();

    assert.ok(panel.hidden, 'a panel built by createButtonMenuPanel must be discoverable');
    assert.ok(panel.classList.contains('ctw-third-menu'));
  });

  it('createButtonMenuPanel starts hidden', () => {
    h = boot('');
    const panel = createButtonMenuPanel('ctw-third-menu');

    assert.strictEqual(panel.hidden, true);
  });
});
