/// <reference lib="dom" />
/**
 * Selection + navigation core for the Git tool window webview: the shared
 * multi-select state, range selection, selected-count mirror, scroll-to-commit
 * and row-reveal, the jump/navigation popup, load-time scroll restore, and the
 * empty-state action. Extracted verbatim from the entry; the entry's message
 * handler and the row/menu module mutate the same {@link ISelectionState}.
 */

import type { GitToolWindowInbound } from '../gitToolWindow.protocol';
import { ContextMenu } from '../../../webview-common/contextMenu';

/** Height the parent-navigation popup is expected to reach once laid out. */
const POPUP_HEIGHT = 200;
import {
  loadWebviewState,
  saveWebviewState,
  type IWebviewStateApi,
  type IWebviewStateSlot,
} from '../../../utils/webviewStateSlot';

type PostLog = (message: GitToolWindowInbound) => void;

export const GRAPH_SCROLL_TOP_SLOT: IWebviewStateSlot<number> = {
  key: 'graphScrollTop',
  version: 1,
  validate: (raw) => (typeof raw === 'number' && isFinite(raw) ? raw : undefined),
};

// Escape a value before splicing it into an attribute selector
// ([data-hash="<sha>"]). Prefers the native CSS.escape (present in the
// Chromium webview); falls back to a minimal escaper so the script also runs
// under test DOMs that lack the global CSS object. Keeps a malformed value
// from throwing a querySelector SyntaxError / mis-selecting.
export function cssEscapeHash(value: string): string {
  const s = String(value);
  if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') {
    return CSS.escape(s);
  }
  return s.replace(/[^a-zA-Z0-9_-]/g, function (ch) {
    return '\\' + ch;
  });
}

/**
 * Mutable interaction state shared between the entry's message handler, the
 * selection core, and the row/menu module. One object, property mutation only,
 * so every reader sees live values.
 */
export interface ISelectionState {
  anchorHash: string | null;
  menuEnableMap: Record<string, { visible?: boolean; enabled?: boolean; reason?: string }> | null;
  branchFocus: { focusedBranchName: string | null; focusedHash: string | null } | null;
}

/** Fresh interaction state (the setup seeds the anchor from the DOM). */
export function createSelectionState(): ISelectionState {
  return { anchorHash: null, menuEnableMap: null, branchFocus: null };
}

/** The selection/navigation API the entry and the row/menu module drive. */
export interface ILogSelection {
  refreshSelectedCount: () => void;
  applyRangeSelectionDom: (clickHash: string, additive: boolean) => void;
  scrollRowIntoViewIfNeeded: (row: HTMLElement) => void;
  scrollToCommit: (commitHash: string) => void;
  jumpToCommitHash: (hash: string) => void;
  openNavigationPopup: (
    hashes: string[],
    clientX: number,
    clientY: number,
    onSelect: (hash: string) => void,
    opener?: HTMLElement
  ) => void;
}

export function setupLogSelection(
  post: PostLog,
  state: IWebviewStateApi,
  sel: ISelectionState
): ILogSelection {
  sel.anchorHash = (function readInitialAnchor(): string | null {
    const gp = document.querySelector('.graph-panel[data-anchor-hash]');
    if (!gp) {
      return null;
    }
    const v = gp.getAttribute('data-anchor-hash') || '';
    return v.length > 0 ? v : null;
  })();

  function refreshSelectedCount(): void {
    const graphPanel = document.querySelector('.graph-panel[aria-multiselectable]');
    if (graphPanel) {
      const selected = graphPanel.querySelectorAll('.commit-row.selected');
      graphPanel.setAttribute('data-selected-count', String(selected.length));
      const multiDetails = document.querySelector('.multi-commit-details');
      if (multiDetails) {
        multiDetails.setAttribute('data-selected-count', String(selected.length));
      }
    }
  }

  function applyRangeSelectionDom(clickHash: string, additive: boolean): void {
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>('.graph-panel .commit-row[data-hash]')
    );
    const allHashes = rows.map(function (r) {
      return r.getAttribute('data-hash');
    });
    const clickIdx = allHashes.indexOf(clickHash);
    if (clickIdx === -1) {
      return;
    }
    if (sel.anchorHash === null || allHashes.indexOf(sel.anchorHash) === -1) {
      // No range to draw. An additive click still ADDS, matching the host's
      // toggle fallback — clearing here would paint a collapse the host then
      // repaints away. A plain click collapses to the clicked row.
      if (!additive) {
        rows.forEach(function (r) {
          r.classList.remove('selected');
          r.setAttribute('aria-selected', 'false');
        });
      }
      const target = rows[clickIdx];
      target.classList.add('selected');
      target.setAttribute('aria-selected', 'true');
      sel.anchorHash = clickHash;
      refreshSelectedCount();
      return;
    }
    const anchorIdx = allHashes.indexOf(sel.anchorHash);
    const lo = Math.min(anchorIdx, clickIdx);
    const hi = Math.max(anchorIdx, clickIdx);
    if (!additive) {
      rows.forEach(function (r) {
        r.classList.remove('selected');
        r.setAttribute('aria-selected', 'false');
      });
    }
    for (let i = lo; i <= hi; i++) {
      rows[i].classList.add('selected');
      rows[i].setAttribute('aria-selected', 'true');
    }
    refreshSelectedCount();
  }

  function scrollRowIntoViewIfNeeded(row: HTMLElement): void {
    const panel = row.closest('.graph-panel');
    if (panel) {
      const rowTop = row.offsetTop;
      const rowBottom = rowTop + row.offsetHeight;
      const viewportTop = panel.scrollTop;
      const viewportBottom = viewportTop + panel.clientHeight;
      const fullyVisible = rowTop >= viewportTop && rowBottom <= viewportBottom;
      if (!fullyVisible) {
        // Scroll ONLY the graph panel to center the row. `scrollIntoView` also
        // scrolls the OUTER tab container, which drags the log filter bar up
        // behind the tab strip.
        const centered = rowTop - (panel.clientHeight - row.offsetHeight) / 2;
        const maxTop = panel.scrollHeight - panel.clientHeight;
        const clamped = Math.max(0, Math.min(centered, maxTop));
        panel.scrollTo({ top: clamped, behavior: 'smooth' });
      }
    } else {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function scrollToCommit(commitHash: string): void {
    const commitRow = document.querySelector<HTMLElement>(
      '[data-hash="' + cssEscapeHash(commitHash) + '"]'
    );
    if (!commitRow) {
      return;
    }
    scrollRowIntoViewIfNeeded(commitRow);
    commitRow.classList.add('highlight-scroll');
    // async-guard-exempt: removes a class from an element captured above; nothing here can throw.
    setTimeout(function (): void {
      commitRow.classList.remove('highlight-scroll');
    }, 2000);
  }

  function jumpToCommitHash(hash: string): void {
    const targetRow = document.querySelector<HTMLElement>(
      '.commit-row[data-hash="' + cssEscapeHash(hash) + '"]'
    );
    if (!targetRow) {
      return;
    }
    document.querySelectorAll('.commit-row.selected').forEach(function (r) {
      r.classList.remove('selected');
      r.setAttribute('aria-selected', 'false');
    });
    targetRow.classList.add('selected');
    targetRow.setAttribute('aria-selected', 'true');
    // Scroll within the graph panel only, so the filter bar stays put.
    scrollRowIntoViewIfNeeded(targetRow);
    refreshSelectedCount();
    post({ type: 'selectCommit', commitHash: hash });
  }

  /**
   * Whoever last opened the popup. The caller supplies the jump per opening —
   * parents from the commit menu, children from the same menu's other entry —
   * so the widget's single pick handler routes through this.
   */
  let onNavigationPick: ((hash: string) => void) | undefined;

  const navigationPopup = new ContextMenu({
    id: 'nav-popup',
    ariaLabel: 'Commits to jump to',
    actionAttr: 'data-nav-hash',
    expectedHeight: POPUP_HEIGHT,
    onPick: (hash): void => onNavigationPick?.(hash),
  });

  document.addEventListener(
    'click',
    function (e) {
      const target = e.target instanceof Element ? e.target : null;
      if (navigationPopup.isOpen && target && !navigationPopup.contains(target)) {
        navigationPopup.hide();
      }
    },
    true
  );

  function openNavigationPopup(
    hashes: string[],
    clientX: number,
    clientY: number,
    onSelect: (hash: string) => void,
    opener?: HTMLElement
  ): void {
    onNavigationPick = onSelect;
    navigationPopup.render(
      hashes.map(function (h) {
        return { action: h, label: h.substring(0, 8) };
      })
    );
    navigationPopup.showAt(clientX, clientY, opener);
  }

  // Auto-scroll to commit on page load when data-scroll-to-commit is set.
  (function autoScrollOnLoad(): void {
    const graphPanel = document.querySelector('.graph-panel[data-scroll-to-commit]');
    if (graphPanel) {
      const targetHash = graphPanel.getAttribute('data-scroll-to-commit');
      if (targetHash) {
        scrollToCommit(targetHash);
      }
    }
  })();

  // Restore-or-reset the scroll position on every full re-render.
  (function restoreOrResetScroll(): void {
    const graphPanel = document.querySelector<HTMLElement>('.graph-panel');
    if (!graphPanel) {
      return;
    }

    if (graphPanel.hasAttribute('data-scroll-to-commit')) {
      return;
    }

    if (!graphPanel.hasAttribute('data-preserve-scroll')) {
      const prev = loadWebviewState(state, GRAPH_SCROLL_TOP_SLOT);
      if (prev) {
        saveWebviewState(state, GRAPH_SCROLL_TOP_SLOT, 0);
      }
      return;
    }

    const saved = loadWebviewState(state, GRAPH_SCROLL_TOP_SLOT);
    if (typeof saved !== 'number' || saved <= 0) {
      return;
    }

    graphPanel.scrollTop = saved;
    if (typeof requestAnimationFrame === 'function') {
      // async-guard-exempt: a single scrollTop write on an element captured above.
      requestAnimationFrame(function (): void {
        graphPanel.scrollTop = saved;
      });
    }
  })();

  // ─── Empty-state action buttons ──────────────────────────────────
  document.addEventListener('click', function (e) {
    const target = e.target instanceof Element ? e.target : null;
    const emptyAction = target ? target.closest('.graph-empty-action[data-action]') : null;
    if (emptyAction) {
      const action = emptyAction.getAttribute('data-action');
      if (action === 'clearLogFilter') {
        post({ type: 'clearLogFilter' });
      }
    }
  });

  return {
    refreshSelectedCount: refreshSelectedCount,
    applyRangeSelectionDom: applyRangeSelectionDom,
    scrollRowIntoViewIfNeeded: scrollRowIntoViewIfNeeded,
    scrollToCommit: scrollToCommit,
    jumpToCommitHash: jumpToCommitHash,
    openNavigationPopup: openNavigationPopup,
  };
}
