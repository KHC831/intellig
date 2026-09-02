/**
 * The Commit window's button-anchored menus: the gear's settings list and the
 * commit button's dropdown.
 *
 * Not context menus — no pointer placement, no host round-trip, no item list
 * from the host — so they do not go through the shared widget. They are still
 * menus, though, and answer the same dismissals every other menu does: a
 * click outside, losing the window, and Escape.
 */

import { el, setAttrs } from './ctwDom';

/**
 * Selector for a panel this module owns. Every button-anchored panel is
 * built by {@link createButtonMenuPanel}, which stamps this attribute, so a
 * panel added later is discovered here with nothing to update in this file.
 */
const PANEL_SELECTOR = '[data-ctw-button-menu]';

/** The buttons that toggle them. */
const TRIGGERS = '.ctw-gear, .ctw-btn-commit-dropdown';

/**
 * Build a hidden button-anchored panel stamped so {@link closeButtonMenus}
 * discovers it. The one constructor every such panel goes through, so
 * `data-ctw-button-menu` cannot be forgotten at a call site the way a
 * separate `setAttrs` line could.
 */
export function createButtonMenuPanel(className: string): HTMLDivElement {
  const panel = el('div', { className, hidden: true });
  setAttrs(panel, { 'data-ctw-button-menu': '' });
  return panel;
}

/**
 * Close every open panel except the one the click belongs to.
 *
 * Two clicks are spared: one that landed INSIDE a panel, or its items could
 * never be used; and one on a panel's own trigger, because that click is a
 * toggle and owns the outcome. Sparing the trigger does not spare the other
 * panels, so opening one menu puts the other away.
 */
export function closeButtonMenus(clicked?: Node | null, trigger?: Element | null): void {
  for (const panel of document.querySelectorAll<HTMLElement>(PANEL_SELECTOR)) {
    if (panel.hidden) {
      continue;
    }
    const reachedInto = clicked && panel.contains(clicked);
    const ownTrigger = trigger && panel.parentElement?.contains(trigger);
    if (!reachedInto && !ownTrigger) {
      panel.hidden = true;
    }
  }
}

/** The trigger a click landed on, if any — what {@link closeButtonMenus} spares. */
export function buttonMenuTrigger(clicked: Node | null): Element | null {
  return clicked instanceof Element ? clicked.closest(TRIGGERS) : null;
}
