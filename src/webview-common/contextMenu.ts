/// <reference lib="dom" />
/**
 * The context menu every IntelliG webview draws: a box of rows under the
 * pointer, with the open/close lifecycle, keyboard movement and edge clamping
 * that a menu is expected to have.
 *
 * The widget owns only the drawing and the lifecycle. What a menu CONTAINS is
 * the caller's: the Git tool window passes a fixed item list, the Commit window
 * passes the list the host computed for the row that was clicked. Both are
 * item lists, so both render through here.
 *
 * DOM only, so both webview bundles can import it.
 */

import type { IContextMenuItem, IContextMenuRowState } from './contextMenuItem';
import { placeNearPointer } from './placeNearPointer';

export type { IContextMenuItem, IContextMenuRowState };

export interface IContextMenuOptions {
  /** id the menu element carries, for call sites that look it up. */
  id?: string;
  ariaLabel: string;
  /** Attribute each row carries its action in. Namespaced per menu. */
  actionAttr?: string;
  /** Height the menu is expected to reach once laid out, for edge clamping. */
  expectedHeight?: number;
  /** Called with the action of the row the user picked, and the click. */
  onPick?: (action: string, event: MouseEvent) => void;
  /**
   * Called whenever the menu closes, however it was closed.
   *
   * On the row-click path it runs BEFORE `onPick`: picking hides the menu
   * first, so anything cleared here is already gone by the time the pick runs.
   * State a pick still needs does not belong in this hook.
   */
  onHide?: () => void;
}

const DEFAULT_HEIGHT = 320;

/** Selector for the rows a keyboard user can reach. */
const ENABLED_ROW = '.context-menu-item:not(.disabled):not(.menu-multi-hidden)';

/**
 * The menus built in one document, and whether that document's shared keydown
 * listener is installed.
 *
 * Keyed by document rather than held in a module variable: a webview is its own
 * realm in production, but the module outlives any single document under test,
 * and a plain array would accumulate menus belonging to documents that are gone.
 *
 * INVARIANT: hideAllContextMenus() and routeContextMenuKey() resolve the
 * registry from the AMBIENT document at call time, while each menu's element
 * belongs to the document that was ambient when it was constructed. Those are
 * the same document in production — every menu is constructed synchronously
 * during boot — and this design depends on it. If they ever diverge,
 * hideAllContextMenus() hides nothing rather than failing loudly.
 */
interface IMenuRegistry {
  menus: ContextMenu[];
  listening: boolean;
}

const registries = new WeakMap<Document, IMenuRegistry>();

function registryFor(doc: Document): IMenuRegistry {
  let registry = registries.get(doc);
  if (!registry) {
    registry = { menus: [], listening: false };
    registries.set(doc, registry);
  }
  return registry;
}

/**
 * Dismiss whichever menu or popup is open in this document.
 *
 * `except` spares the menu containing that node. `event` spares a menu opened
 * DURING that same event: several listeners answer one click — the one that
 * opens a popup and the one that dismisses stale ones — and without this the
 * dismisser closes, in the same click, the popup the opener just put up.
 *
 * Identity of the event, not of the control that was clicked. An opener element
 * can be arbitrarily large and can contain other openers — a commit row carries
 * `tabindex` and holds the collapsed-ref chip — so "was the click inside the
 * opener?" would spare a click that landed elsewhere in the same row, and spare
 * a chip opening a different popup. An event has no width and cannot outlive
 * its own dispatch.
 *
 * Using it as the click-away handler also means the action and the "was the
 * click inside a menu?" test are the same code, so they cannot drift into a
 * guard that names three of five menus while the action closes all five.
 */
export function hideAllContextMenus(except?: Node | null, event?: Event | null): void {
  for (const menu of registryFor(document).menus) {
    if (except && menu.contains(except)) {
      continue;
    }
    if (event && menu.openedDuring(event)) {
      continue;
    }
    menu.hide();
  }
}

/** Feed a key to whichever menu is open. True when the key was consumed. */
function routeContextMenuKey(key: string, target: Element | null): boolean {
  const open = registryFor(document).menus.find((m) => m.isOpen);
  if (!open) {
    return false;
  }
  // Escape dismisses from anywhere; movement and picking are scoped to the
  // menu, or the same Enter that opened it would reach the row it just focused,
  // and an arrow pressed in a text field would yank focus out of it.
  if (key === 'Escape') {
    hideAllContextMenus();
    return true;
  }
  return !!target && open.contains(target) && open.handleKey(key);
}

/**
 * One keydown listener per document, installed when its first menu is built.
 * Owned here rather than by each host: a webview has several menus from
 * different modules, and a listener per module would feed the SAME open menu
 * the same arrow key twice, moving the selection two rows per press.
 */
function register(menu: ContextMenu): void {
  const registry = registryFor(document);
  registry.menus.push(menu);
  if (registry.listening) {
    return;
  }
  registry.listening = true;
  document.addEventListener('keydown', (e) => {
    if (routeContextMenuKey(e.key, e.target instanceof Element ? e.target : null)) {
      e.preventDefault();
    }
  });
}

export class ContextMenu {
  private _menu: HTMLDivElement | undefined;
  /** What was last rendered, so a cleared gating map can fall back to it. */
  private _items: readonly IContextMenuItem[] = [];
  /** What the user was on when they opened it, so focus has somewhere to go. */
  private _opener: HTMLElement | undefined;
  /** The gesture that opened it, so a dismisser answering the same one skips it. */
  private _openedFor: Event | undefined;

  constructor(private readonly _options: IContextMenuOptions) {
    register(this);
  }

  /**
   * The menu element, created on first use and appended to `<body>`, tagged
   * with the configured id (if any) so a call site that looks it up by id
   * finds it after the first render.
   */
  get element(): HTMLDivElement {
    if (this._menu) {
      return this._menu;
    }
    const menu = document.createElement('div');
    if (this._options.id) {
      menu.id = this._options.id;
    }
    document.body.appendChild(menu);
    menu.className = 'context-menu';
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', this._options.ariaLabel);
    this._menu = menu;
    return menu;
  }

  get isOpen(): boolean {
    return !!this._menu && !this._menu.hidden;
  }

  /** True when `node` is inside the menu, so a click on it is not click-away. */
  contains(node: Node): boolean {
    return !!this._menu && this._menu.contains(node);
  }

  /** True when this menu was opened while `event` was being dispatched. */
  openedDuring(event: Event): boolean {
    return this.isOpen && this._openedFor === event;
  }

  /** Replace the rows. Safe to call on every open. */
  render(items: readonly IContextMenuItem[]): void {
    this._items = items;
    const menu = this.element;
    while (menu.firstChild) {
      menu.removeChild(menu.firstChild);
    }
    for (const item of items) {
      menu.appendChild(item.separator ? this._buildSeparator() : this._buildItem(item));
    }
  }

  /**
   * Draw the menu at the pointer and focus its first reachable row. The menu
   * is appended to the body, so without that focus a keyboard user who opened
   * it with the Menu key would have to Tab through the whole document.
   */
  showAt(x: number, y: number, opener?: HTMLElement, openedFor?: Event): void {
    const menu = this.element;
    this._opener = opener;
    this._openedFor = openedFor;
    placeNearPointer(menu, x, y, this._options.expectedHeight ?? DEFAULT_HEIGHT);
    menu.hidden = false;
    menu.querySelector<HTMLElement>(ENABLED_ROW)?.focus();
  }

  hide(): void {
    if (!this._menu || this._menu.hidden) {
      return;
    }
    // Hand focus back before hiding. A focused element inside a display:none
    // subtree is reset to <body> by the browser, which silently kills whatever
    // keyboard navigation the opener belonged to. Only when focus is actually
    // in here: a click elsewhere has already put it where the user wants it.
    const hadFocus = !!document.activeElement && this._menu.contains(document.activeElement);
    this._menu.hidden = true;
    if (hadFocus && this._opener && typeof this._opener.focus === 'function') {
      this._opener.focus();
    }
    this._opener = undefined;
    this._openedFor = undefined;
    this._options.onHide?.();
  }

  /**
   * Arrow/Home/End movement between reachable rows, and Enter/Space to pick.
   * Returns true when the key was consumed.
   */
  handleKey(key: string): boolean {
    if (!this.isOpen || !this._menu) {
      return false;
    }
    const rows = Array.from(this._menu.querySelectorAll<HTMLElement>(ENABLED_ROW));
    if (rows.length === 0) {
      return false;
    }
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      const step = key === 'ArrowDown' ? 1 : -1;
      rows[at === -1 ? 0 : (at + step + rows.length) % rows.length].focus();
      return true;
    }
    if (key === 'Home') {
      rows[0].focus();
      return true;
    }
    if (key === 'End') {
      rows[rows.length - 1].focus();
      return true;
    }
    if ((key === 'Enter' || key === ' ') && at >= 0) {
      rows[at].click();
      return true;
    }
    return false;
  }

  /**
   * Apply a host's per-action gating to the rendered rows.
   *
   * A null map means the host has not computed one for the current selection.
   * That falls back to each row's DECLARED state, never to "everything
   * allowed": the multi-only rows would otherwise appear on a single commit,
   * and the destructive ones would render enabled with nothing gating them.
   *
   * Class, aria-disabled and tabindex move together here. Toggling only the
   * class leaves a greyed row announcing itself as available and still a Tab
   * stop, which no test looking at the class can see.
   */
  applyStates(states: Readonly<Record<string, IContextMenuRowState>> | null): void {
    // Rows and items are matched by POSITION, not by action string: render()
    // emits exactly one row per non-separator item in order, and keying on the
    // action would silently fall back to visible+enabled for a row whose item
    // declared none — the permissive default this fallback exists to remove.
    const declaredRows = this._items.filter((i) => !i.separator);
    const rows = this.element.querySelectorAll<HTMLElement>('.context-menu-item');
    rows.forEach((row, index) => {
      const action = row.getAttribute(this._options.actionAttr ?? 'data-action') ?? '';
      const declared = declaredRows[index];
      const state = states ? states[action] : undefined;
      const visible = state ? state.visible !== false : !declared?.hiddenByDefault;
      const enabled = state ? state.enabled !== false : !declared?.disabled;

      row.classList.toggle('menu-multi-hidden', !visible);
      row.classList.toggle('disabled', !enabled);
      row.setAttribute('tabindex', enabled ? '0' : '-1');
      if (enabled) {
        row.removeAttribute('aria-disabled');
      } else {
        row.setAttribute('aria-disabled', 'true');
      }

      // A tooltip only where there is a surface to show it: a visible row that
      // is disabled. The typeof check keeps a malformed payload from rendering
      // "[object Object]" into the user's tooltip.
      //
      // INVARIANT (with multiSelect.ts:computeMenuState): the host populates
      // reason ONLY when visible && !enabled. This mirrors that gate on the
      // wire side, so a host bug that set reason on a hidden row shows up as a
      // dropped tooltip rather than a tooltip nobody can see.
      const reason =
        visible && !enabled && state && typeof state.reason === 'string' ? state.reason : '';
      if (reason) {
        row.setAttribute('title', reason);
      } else {
        row.removeAttribute('title');
      }
    });

    // States can land while the menu is open — the host answers a right-click
    // a round-trip after the rows were drawn and focused. A row greyed out
    // from under the keyboard leaves focus on something Enter cannot pick and
    // arrows cannot leave, since both only walk reachable rows.
    const menu = this._menu;
    const active = document.activeElement as HTMLElement | null;
    if (
      menu &&
      active &&
      typeof active.matches === 'function' &&
      menu.contains(active) &&
      active.classList.contains('context-menu-item') &&
      !active.matches(ENABLED_ROW)
    ) {
      menu.querySelector<HTMLElement>(ENABLED_ROW)?.focus();
    }
  }

  private _buildSeparator(): HTMLDivElement {
    const rule = document.createElement('div');
    rule.className = 'context-menu-separator';
    return rule;
  }

  private _buildItem(item: IContextMenuItem): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'context-menu-item';
    row.classList.toggle('disabled', !!item.disabled);
    row.classList.toggle('context-menu-danger', !!item.danger);
    row.classList.toggle('menu-multi-hidden', !!item.hiddenByDefault);
    row.setAttribute('role', 'menuitem');
    row.setAttribute('tabindex', item.disabled ? '-1' : '0');
    if (item.disabled) {
      row.setAttribute('aria-disabled', 'true');
    }
    if (item.action !== undefined) {
      row.setAttribute(this._options.actionAttr ?? 'data-action', item.action);
    }

    const label = document.createElement('span');
    label.className = 'context-menu-label';
    label.textContent = item.label ?? '';
    row.appendChild(label);
    if (item.shortcut) {
      const hint = document.createElement('span');
      hint.className = 'context-menu-shortcut';
      hint.textContent = item.shortcut;
      row.appendChild(hint);
    }

    // Every row takes its click, disabled ones included: a greyed row fires
    // nothing, but the menu still closes on it. Without a handler here the
    // click reaches the click-away listeners, which see a target inside the
    // menu and leave it open — the click would vanish with nothing to show.
    //
    // Whether the row is live is read off the LIVE class, not off `item`: the
    // Git tool window greys rows after render, from the host's per-selection
    // enable map, and a row disabled that way must not act either.
    const action = item.action;
    row.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.hide();
      if (action !== undefined && !row.classList.contains('disabled')) {
        this._options.onPick?.(action, e as MouseEvent);
      }
    });
    return row;
  }
}
