/**
 * The markup a context menu actually renders, produced by the real widget.
 *
 * The menus are built with createElement in the webview, so there is no HTML
 * string to assert against. Rather than hand-write a second renderer for tests
 * (which would drift from the one users see), this drives
 * {@link ContextMenu} under jsdom and serializes what it produced. Specs that
 * assert on menu markup — including the computed-style lane, which needs a
 * string to hand a real browser — go through here.
 */

import { JSDOM } from 'jsdom';
import {
  ContextMenu,
  type IContextMenuItem,
  type IContextMenuOptions,
} from '../../src/webview-common/contextMenu';

export function renderMenuMarkup(
  items: readonly IContextMenuItem[],
  options: IContextMenuOptions
): string {
  const dom = new JSDOM('<!doctype html><body></body>');
  const globals = globalThis as { document?: Document; window?: unknown };
  const priorDocument = globals.document;
  const priorWindow = globals.window;
  globals.document = dom.window.document;
  globals.window = dom.window;
  try {
    const menu = new ContextMenu(options);
    menu.render(items);
    return menu.element.outerHTML;
  } finally {
    globals.document = priorDocument;
    globals.window = priorWindow;
    dom.window.close();
  }
}
