/// <reference lib="dom" />
/**
 * Tab-channel behaviors for the Git tool window webview: the tab strip
 * (click + WAI-ARIA keyboard pattern), the keyboard-focus claim that survives
 * full-document re-renders, and the Console / Incoming / History tab wiring.
 * Extracted verbatim from the entry; behavior is pinned by the tab webview
 * suites. The entry calls the setups in document order.
 */

import type { GitToolWindowTabsInbound } from '../gitToolWindowTabs.protocol';
import { isTabId } from '../tabIds';
import type { IWebviewStateApi } from '../../../utils/webviewStateSlot';

type PostTabs = (message: GitToolWindowTabsInbound) => void;

/**
 * Who owned keyboard focus when the last document was torn down. A full
 * `_render()` reassigns `webview.html`, destroying the focused element: the tab
 * strip loses its roving tabindex target and a focused `.commit-row` stops
 * being found by the delegated keyboard handler, which keys off
 * `e.target.closest('.commit-row[data-hash]')`. One slot, one restore.
 */
type FocusSlot = { role: 'tabStrip' } | { role: 'commitRow'; hash: string };

/** Record who owns keyboard focus, so the next document can hand it back. */
function writeFocusSlot(api: IWebviewStateApi, slot: FocusSlot): void {
  const state = (api.getState() || {}) as Record<string, unknown>;
  state.focusSlot = slot;
  api.setState(state);
}

/** Release the claim, but only if `role` still holds it. */
function clearFocusSlot(api: IWebviewStateApi, role: FocusSlot['role']): void {
  const state = (api.getState() || {}) as { focusSlot?: FocusSlot };
  if (state.focusSlot?.role !== role) {
    return;
  }
  api.setState({ ...state, focusSlot: undefined });
}

/**
 * Whether a focusout leaves the claim intact.
 *
 * Focus moving within `owner` never releases it. A null relatedTarget covers
 * two opposite cases: alt-tabbing away (the owner keeps the focus it will want
 * back on return) and clicking a non-focusable region of the page, which blurs
 * to `<body>` and IS the user moving focus away. Only the document's own focus
 * separates them.
 */
function focusStayedInside(event: FocusEvent, owner: Element): boolean {
  const to = event.relatedTarget;
  if (to instanceof Node && owner.contains(to)) {
    return true;
  }
  return to === null && !document.hasFocus();
}

/**
 * Hand focus back to whoever held it before this document replaced the last
 * one — but only when the host says this render answers a user gesture. The
 * claim is persisted state and outlives the window, so an unconditional
 * restore would pull focus into a tool window the user merely reopened.
 */
export function restoreFocusClaim(api: IWebviewStateApi, restoreFocus: boolean): void {
  if (restoreFocus !== true) {
    return;
  }
  const slot = ((api.getState() || {}) as { focusSlot?: FocusSlot }).focusSlot;
  if (!slot) {
    return;
  }
  if (slot.role === 'tabStrip') {
    document.querySelector<HTMLElement>('.intellig-tab-strip [data-tab][tabindex="0"]')?.focus();
    return;
  }
  const rows = Array.from(document.querySelectorAll<HTMLElement>('.commit-row[data-hash]'));
  rows.find((row) => row.getAttribute('data-hash') === slot.hash)?.focus();
}

// ─── Tab strip ───────────────────────────────────────────────────
// Clicks on the tab strip post `tabChange`; the host re-renders with the
// chosen tab active. No-ops when the tabbed layout is off (no strip).
export function setupTabStrip(state: IWebviewStateApi, post: PostTabs): void {
  const strip = document.querySelector('.intellig-tab-strip');
  if (!strip) {
    return;
  }
  strip.addEventListener('click', function (event) {
    const target = event.target instanceof Element ? event.target : null;
    const btn = target ? target.closest('[data-tab]') : null;
    if (!btn) {
      return;
    }
    const tab = btn.getAttribute('data-tab');
    if (!tab || !isTabId(tab)) {
      return;
    }
    post({ type: 'tabChange', tab: tab });
  });

  // WAI-ARIA tabs keyboard pattern: arrows move between tabs (wrapping),
  // Home/End jump to the ends. Selection follows focus, which is what the
  // pattern prescribes for tab lists whose panels are already loaded.
  strip.addEventListener('keydown', function (event) {
    const key = (event as KeyboardEvent).key;
    const offsets: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1 };
    if (!(key in offsets) && key !== 'Home' && key !== 'End') {
      return;
    }
    const buttons = Array.from(strip.querySelectorAll<HTMLElement>('[data-tab]'));
    if (buttons.length === 0) {
      return;
    }
    const current = buttons.findIndex((b) => b.getAttribute('tabindex') === '0');
    const next =
      key === 'Home'
        ? 0
        : key === 'End'
          ? buttons.length - 1
          : (Math.max(current, 0) + offsets[key] + buttons.length) % buttons.length;

    const tab = buttons[next].getAttribute('data-tab');
    if (!tab || !isTabId(tab)) {
      return;
    }
    event.preventDefault();
    buttons[next].focus();
    post({ type: 'tabChange', tab: tab });
  });

  // A tab change re-renders the whole document, so the focus set above dies
  // with the old DOM and the next arrow press has nothing to move from.
  strip.addEventListener('focusin', function () {
    writeFocusSlot(state, { role: 'tabStrip' });
  });
  strip.addEventListener('focusout', function (event) {
    if (focusStayedInside(event as FocusEvent, strip)) {
      return;
    }
    clearFocusSlot(state, 'tabStrip');
  });
}

// The same claim for commit rows: a ctrl-click toggle re-renders the whole
// document, and the delegated keyboard handler needs a focused row to act on.
export function setupCommitRowFocusClaim(state: IWebviewStateApi): void {
  document.addEventListener('focusin', function (event) {
    const target = event.target instanceof Element ? event.target : null;
    const row = target ? target.closest('.commit-row[data-hash]') : null;
    const hash = row ? row.getAttribute('data-hash') : null;
    if (hash) {
      writeFocusSlot(state, { role: 'commitRow', hash: hash });
    }
  });
  document.addEventListener('focusout', function (event) {
    const target = event.target instanceof Element ? event.target : null;
    const row = target ? target.closest('.commit-row[data-hash]') : null;
    if (!row || focusStayedInside(event, row)) {
      return;
    }
    clearFocusSlot(state, 'commitRow');
  });
}

// ─── Console tab behavior ────────────────────────────────────────
// Clear drops the captured entries host-side. The log is bottom-pinned on
// open and its offset persisted, because every git command re-renders the
// whole document while this tab is active — without this the view snapped
// back to the top on each one and never followed new output.
export function setupConsoleTab(api: IWebviewStateApi, post: PostTabs): void {
  document.addEventListener('click', function (event) {
    const target = event.target;
    if (target instanceof Element && target.closest('.console-clear-btn')) {
      post({ type: 'console.clear' });
    }
  });

  const log = document.querySelector<HTMLElement>('.console-log');
  if (!log) {
    return;
  }

  // Sticky bottom: a console that is at the bottom FOLLOWS new output, and
  // one the user scrolled up stays where they left it. Every git command
  // rebuilds the webview, so "at the bottom" has to survive the reboot as
  // its own flag — restoring a saved offset alone left the log frozen above
  // every subsequent line.
  const BOTTOM_EPSILON = 4;
  const maxScrollTop = (): number => Math.max(0, log.scrollHeight - log.clientHeight);
  const isAtBottom = (): boolean => maxScrollTop() - log.scrollTop <= BOTTOM_EPSILON;
  const scrollToBottom = (): void => {
    log.scrollTop = maxScrollTop();
  };

  const persisted = (api.getState() || {}) as {
    consoleScrollTop?: number;
    consolePinnedToBottom?: boolean;
  };
  // Absent state is a fresh console: pin it.
  let pinned = persisted.consolePinnedToBottom !== false;
  if (pinned) {
    scrollToBottom();
  } else if (typeof persisted.consoleScrollTop === 'number') {
    log.scrollTop = persisted.consoleScrollTop;
  }

  // Position alone decides: land at the bottom and the log follows again,
  // scroll away and it stays put. That holds for programmatic scrolls too,
  // so no event bookkeeping is needed.
  log.addEventListener('scroll', function () {
    pinned = isAtBottom();
    const state = (api.getState() || {}) as Record<string, unknown>;
    state.consoleScrollTop = log.scrollTop;
    state.consolePinnedToBottom = pinned;
    api.setState(state);
  });

  // New output appended while pinned keeps the newest line in view.
  if (typeof MutationObserver === 'function') {
    new MutationObserver(function () {
      if (pinned) {
        scrollToBottom();
      }
    }).observe(log, { childList: true, subtree: true });
  }
}

// ─── Incoming tab behavior ───────────────────────────────────────
// Click selects a row, double-click routes to that commit in the Log tab —
// the same gesture pair the History rows use. Delegated off the list so rows
// re-rendered by `incoming.updateState` stay live. No-ops when the Incoming
// tab isn't rendered.
export function setupIncomingTab(post: PostTabs): void {
  const hashOf = (target: EventTarget | null): string | null => {
    const el = target instanceof Element ? target.closest('.incoming-commit-row') : null;
    return el ? el.getAttribute('data-hash') : null;
  };

  document.addEventListener('click', function (event) {
    const hash = hashOf(event.target);
    if (hash) {
      post({ type: 'incoming.selectCommit', hash: hash });
    }
  });

  document.addEventListener('dblclick', function (event) {
    const hash = hashOf(event.target);
    if (hash) {
      post({ type: 'incoming.jumpToCommit', hash: hash });
    }
  });
}

// ─── History tab behavior ────────────────────────────────────────
// Binds the History tab's commit list, toolbar buttons, and dropdowns to the
// tab-channel messages. No-ops when the History tab isn't rendered.
export function setupHistoryTab(post: PostTabs): void {
  document.querySelectorAll('.history-commit-row').forEach(function (row) {
    row.addEventListener('click', function (event) {
      const rev = row.getAttribute('data-rev');
      if (!rev) {
        return;
      }
      const me = event as MouseEvent;
      post({
        type: 'history.selectRevision',
        rev: rev,
        additive: Boolean(me.ctrlKey || me.metaKey),
      });
    });
    row.addEventListener('dblclick', function () {
      const rev = row.getAttribute('data-rev');
      if (!rev) {
        return;
      }
      post({ type: 'history.openAtRevision', rev: rev });
    });
  });

  const followChk = document.querySelector<HTMLInputElement>('.history-follow-chk');
  if (followChk) {
    followChk.addEventListener('change', function () {
      post({ type: 'history.toggleFollowRenames', value: followChk.checked });
    });
  }

  const branchSel = document.querySelector<HTMLSelectElement>('.history-branch-select');
  if (branchSel) {
    branchSel.addEventListener('change', function () {
      const value = branchSel.value;
      post({ type: 'history.setBranchFilter', branch: value || undefined });
    });
  }

  const getVersionBtn = document.querySelector('.history-btn-get-version');
  if (getVersionBtn) {
    getVersionBtn.addEventListener('click', function () {
      const selected = document.querySelector('.history-commit-row.history-selected');
      const rev = selected ? selected.getAttribute('data-rev') : null;
      if (rev) {
        post({ type: 'history.getVersion', rev: rev });
      }
    });
  }

  const compareLocalBtn = document.querySelector('.history-btn-compare-local');
  if (compareLocalBtn) {
    compareLocalBtn.addEventListener('click', function () {
      const selected = document.querySelector('.history-commit-row.history-selected');
      const rev = selected ? selected.getAttribute('data-rev') : null;
      if (rev) {
        post({ type: 'history.compareWithLocal', rev: rev });
      }
    });
  }

  const copyBtn = document.querySelector('.history-details-copy');
  if (copyBtn) {
    copyBtn.addEventListener('click', function () {
      const hash = copyBtn.getAttribute('data-copy-hash');
      if (hash && navigator.clipboard) {
        navigator.clipboard.writeText(hash).catch(function (_err) {
          /* clipboard writes can fail on focus loss; the hash stays visible */
        });
      }
    });
  }

  const diffTwoBtn = document.querySelector('.history-btn-diff-two');
  if (diffTwoBtn) {
    diffTwoBtn.addEventListener('click', function () {
      const selected = document.querySelector('.history-commit-row.history-selected');
      const compare = document.querySelector('.history-commit-row.history-compare');
      const to = selected ? selected.getAttribute('data-rev') : null;
      const from = compare ? compare.getAttribute('data-rev') : null;
      if (from && to) {
        post({ type: 'history.compareWith', from: from, to: to });
      }
    });
  }
}
