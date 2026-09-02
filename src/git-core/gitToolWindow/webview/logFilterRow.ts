/// <reference lib="dom" />
/**
 * Log filter row for the Git tool window webview (IntelliJ
 * VcsLogClassicFilterUi): the branch/user/date/path filter popups, the search
 * box, the repository selector, and the two host-message list builders
 * (branch tree + author list). Extracted verbatim from the entry; behavior is
 * pinned by the filter-row webview suites.
 */

import type { GitToolWindowInbound } from '../gitToolWindow.protocol';
import {
  loadWebviewState,
  saveWebviewState,
  type IWebviewStateApi,
  type IWebviewStateSlot,
} from '../../../utils/webviewStateSlot';

/** Read accessors the window-message handlers use to mark the active branch/author. */
export interface IFilterBridge {
  isBranchChecked(name: string): boolean;
  anyBranchSelected(): boolean;
  branchState(): 'all' | 'subset' | 'none';
  reconcileBranchSelection(): void;
  syncBranchTree(): void;
  getAuthor(): string;
  getAuthors(): string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- augmenting the built-in `Window` lib interface (declaration merging)
  interface Window {
    /**
     * Read accessors for the branch/author filter state, exposed for the
     * message handlers that fill the branch/author lists (and pinned by the
     * provider-document jsdom tests). Set once `setupLogFilterRow` runs.
     */
    __intelligFilter?: IFilterBridge;
  }
}

const OPEN_FILTER_POPUP_SLOT: IWebviewStateSlot<string | null> = {
  key: 'openFilterPopup',
  version: 1,
  validate: (raw) => (typeof raw === 'string' || raw === null ? raw : undefined),
};

/** The two seams the filter row reaches the host through. */
export interface ILogFilterRowDeps {
  state: IWebviewStateApi;
  post: (message: GitToolWindowInbound) => void;
}

/**
 * Wire the filter row. Returns the bridge the message handlers read (also
 * mirrored onto `window.__intelligFilter`), or `null` when the document has no
 * filter row.
 */
export function setupLogFilterRow(deps: ILogFilterRowDeps): IFilterBridge | null {
  const { post, state } = deps;
  const row = document.querySelector('.log-filter-row');
  if (!row) {
    return null;
  }

  function readJsonList(attr: string, fallbackSingle: string): string[] {
    try {
      const parsed: unknown = JSON.parse(row!.getAttribute(attr) || '[]');
      if (Array.isArray(parsed) && parsed.length) {
        return (parsed as unknown[]).filter((x): x is string => typeof x === 'string');
      }
      // eslint-disable-next-line no-restricted-syntax -- a malformed data-attr JSON degrades to the empty/single fallback
    } catch (e) {
      /* fall through to the single/empty fallback */
    }
    return fallbackSingle ? [fallbackSingle] : [];
  }
  const initBranch = row.getAttribute('data-f-branch') || '';
  const initPath = row.getAttribute('data-f-path') || '';
  const seededBranches = readJsonList('data-f-branches', initBranch);
  const filterState = {
    // COMMITTED search text (what the applied filter uses). The input box
    // holds the live draft; non-search actions must apply this, not the
    // draft — a date-preset click must not silently commit half-typed text.
    searchText: row.getAttribute('data-f-search') || '',
    branches: seededBranches,
    branchMode: (row.getAttribute('data-f-branches-none') === 'true'
      ? 'none'
      : seededBranches.length
        ? 'subset'
        : 'all') as 'all' | 'subset' | 'none',
    paths: readJsonList('data-f-paths', initPath),
    // Multi-select author filter (IntelliJ multi-user); the single legacy
    // attr seeds a one-element list.
    authors: readJsonList('data-f-authors', row.getAttribute('data-f-author') || ''),
    since: row.getAttribute('data-f-since') || '',
    until: row.getAttribute('data-f-until') || '',
    datePreset: row.getAttribute('data-f-date-preset') || '',
  };
  function branchLeaf(name: string): string {
    const parts = String(name).split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(name);
  }
  function isBranchChecked(name: string): boolean {
    if (filterState.branchMode === 'all') {
      return true;
    }
    if (filterState.branchMode === 'none') {
      return false;
    }
    return filterState.branches.indexOf(name) !== -1;
  }
  function branchSummary(): string {
    if (filterState.branchMode === 'all') {
      return 'All';
    }
    if (filterState.branchMode === 'none') {
      return 'None';
    }
    const n = filterState.branches.length;
    if (n === 1) {
      return branchLeaf(filterState.branches[0]);
    }
    return n + ' branches';
  }
  function recomputeBranchState(): void {
    const list = byId('filter-branch-list');
    if (!list) {
      return;
    }
    const leaves = list.querySelectorAll('input[data-branch]');
    if (leaves.length === 0) {
      return;
    }
    const checkedRefs: string[] = [];
    leaves.forEach(function (cb) {
      if ((cb as HTMLInputElement).checked) {
        checkedRefs.push(cb.getAttribute('data-branch') || '');
      }
    });
    if (checkedRefs.length === leaves.length) {
      filterState.branchMode = 'all';
      filterState.branches = [];
    } else if (checkedRefs.length === 0) {
      filterState.branchMode = 'none';
      filterState.branches = [];
    } else {
      filterState.branchMode = 'subset';
      filterState.branches = checkedRefs;
    }
    syncBranchFolderChecks(list);
    setPopValue('branch', branchSummary());
  }
  function reconcileBranchSelection(): void {
    const list = byId('filter-branch-list');
    if (!list) {
      return;
    }
    if (filterState.branchMode === 'subset') {
      const leaves = list.querySelectorAll('input[data-branch]');
      if (leaves.length > 0) {
        // A Set, not an object: an inherited key (`toString`) would report a
        // deleted branch as still on offer, the kept count would reach the leaf
        // count, and the filter would reset itself to "all branches".
        const present = new Set<string>();
        leaves.forEach(function (cb) {
          present.add(cb.getAttribute('data-branch') || '');
        });
        const kept = filterState.branches.filter(function (r) {
          return present.has(r);
        });
        if (kept.length === 0 || kept.length === leaves.length) {
          filterState.branchMode = 'all';
          filterState.branches = [];
        } else {
          filterState.branches = kept;
        }
        leaves.forEach(function (cb) {
          (cb as HTMLInputElement).checked = isBranchChecked(cb.getAttribute('data-branch') || '');
        });
        setPopValue('branch', branchSummary());
      }
    }
    syncBranchFolderChecks(list);
  }
  function syncBranchFolderChecks(list: Element): void {
    list.querySelectorAll('input[data-action="toggleBranchFolder"]').forEach(function (folder) {
      const wrap = folder.closest('.log-filter-tree-node');
      const leaves = wrap ? wrap.querySelectorAll('input[data-branch]') : [];
      let on = 0;
      leaves.forEach(function (l) {
        if ((l as HTMLInputElement).checked) {
          on++;
        }
      });
      (folder as HTMLInputElement).checked = leaves.length > 0 && on === leaves.length;
      (folder as HTMLInputElement).indeterminate = on > 0 && on < leaves.length;
    });
    const master = list.querySelector<HTMLInputElement>('input[data-action="toggleAllBranches"]');
    if (master) {
      master.checked = filterState.branchMode === 'all';
      master.indeterminate = filterState.branchMode === 'subset';
    }
  }

  function byId(id: string): HTMLElement | null {
    return document.getElementById(id);
  }
  function readToggle(id: string): boolean {
    const el = byId(id);
    return el ? el.classList.contains('active') : false;
  }

  /**
   * Adopt whatever the search box currently shows as the query to apply.
   * Every filter gesture applies what the user can SEE — toggling regex or
   * picking an author filters the typed text, it does not silently apply an
   * older query. Skipped when the box is not rendered, so a programmatic
   * filter is not wiped by a missing input.
   */
  function commitSearchText(): void {
    const el = byId('filter-search') as HTMLInputElement | null;
    if (el) {
      filterState.searchText = el.value.trim();
    }
  }

  function applyFilters(): void {
    commitSearchText();
    post({
      type: 'applyLogFilter',
      filter: {
        branches: filterState.branchMode === 'subset' ? filterState.branches.slice() : [],
        branchesNone: filterState.branchMode === 'none',
        searchText: filterState.searchText,
        author: filterState.authors[0] || '',
        authors: filterState.authors.slice(),
        paths: filterState.paths.slice(),
        since: filterState.since || null,
        until: filterState.until || null,
        datePreset: filterState.datePreset || null,
        searchRegex: readToggle('filter-search-regex'),
        searchCaseSensitive: readToggle('filter-search-case'),
      },
    });
  }

  function authorSummary(): string {
    const n = filterState.authors.length;
    if (n === 0) {
      return 'All';
    }
    if (n === 1) {
      return filterState.authors[0];
    }
    return n + ' users';
  }
  /** Mirror `filterState.authors` onto the User-popup checkboxes. */
  function syncAuthorChecks(): void {
    const list = byId('filter-author-list');
    if (!list) {
      return;
    }
    list.querySelectorAll<HTMLInputElement>('input[data-author]').forEach(function (box) {
      box.checked = filterState.authors.indexOf(box.getAttribute('data-author') || '') !== -1;
    });
  }
  function setPopValue(key: string, text: string): void {
    const el = byId('filter-' + key + '-value');
    if (el) {
      el.textContent = text && text.length > 0 ? text : 'All';
    }
  }
  function dateLabel(): string {
    const s = filterState.since,
      u = filterState.until;
    if (s && u) {
      return s + ' – ' + u;
    }
    if (s) {
      return 'Since ' + s;
    }
    if (u) {
      return 'Until ' + u;
    }
    return 'All';
  }
  function repoSummary(checkedCount: number, total: number): string {
    if (checkedCount === 0) {
      return 'None';
    }
    if (checkedCount === total) {
      return 'All';
    }
    if (checkedCount === 1) {
      const only = document.querySelector('#filter-repo-list input[data-repo-root]:checked');
      const root = only ? only.getAttribute('data-repo-root') || '' : '';
      const parts = root.split('/').filter(Boolean);
      return parts.length ? parts[parts.length - 1] : 'All';
    }
    return checkedCount + ' repositories';
  }

  function persistOpenPopup(key: string | null): void {
    saveWebviewState(state, OPEN_FILTER_POPUP_SLOT, key);
  }
  function closeAllPopups(): void {
    document.querySelectorAll('.log-filter-popup').forEach(function (p) {
      (p as HTMLElement).hidden = true;
    });
    document.querySelectorAll('.log-filter-pop-btn').forEach(function (b) {
      b.setAttribute('aria-expanded', 'false');
    });
    persistOpenPopup(null);
  }
  function togglePopup(key: string | null): void {
    if (!key) {
      return;
    }
    const popup = byId('filter-popup-' + key);
    if (!popup) {
      return;
    }
    const show = popup.hidden;
    closeAllPopups();
    popup.hidden = !show;
    const wrap = popup.closest('.log-filter-pop');
    const btn = wrap ? wrap.querySelector('.log-filter-pop-btn') : null;
    if (btn) {
      btn.setAttribute('aria-expanded', show ? 'true' : 'false');
    }
    if (show) {
      persistOpenPopup(key);
      if (key === 'branch') {
        post({ type: 'requestLogFilterOptions' });
      }
      if (key === 'user') {
        post({ type: 'requestAuthorOptions' });
      }
      const input = popup.querySelector<HTMLInputElement>('input[type="text"]');
      if (input) {
        try {
          input.focus();
          // eslint-disable-next-line no-restricted-syntax -- focus() can throw on a detached node; the popup still opens
        } catch (err) {
          /* focus can throw on a detached node */
        }
      }
    }
  }
  function restoreOpenFilterPopup(): void {
    const key = loadWebviewState(state, OPEN_FILTER_POPUP_SLOT);
    if (!key) {
      return;
    }
    const popup = byId('filter-popup-' + key);
    if (!popup || !popup.hidden) {
      return;
    }
    popup.hidden = false;
    const wrap = popup.closest('.log-filter-pop');
    const btn = wrap ? wrap.querySelector('.log-filter-pop-btn') : null;
    if (btn) {
      btn.setAttribute('aria-expanded', 'true');
    }
    if (key === 'branch') {
      post({ type: 'requestLogFilterOptions' });
    }
    if (key === 'user') {
      post({ type: 'requestAuthorOptions' });
    }
  }

  /** Exact instant N days ago (IntelliJ presets are timestamps, not days). */
  function daysAgoIso(days: number): string {
    return new Date(Date.now() - days * 86400000).toISOString();
  }
  /** Today as a `yyyy-mm-dd` date-input value (custom range stays date-only). */
  function todayDateValue(): string {
    const d = new Date();
    const m = ('0' + (d.getMonth() + 1)).slice(-2);
    const day = ('0' + d.getDate()).slice(-2);
    return d.getFullYear() + '-' + m + '-' + day;
  }

  window.addEventListener('blur', function () {
    // This module's own popups only. The context menus dismiss themselves
    // through the shared widget, which also hands focus back to the row that
    // opened them; hiding one from here would skip that.
    closeAllPopups();
  });

  document.addEventListener('click', function (e) {
    if (!(e.target instanceof Element)) {
      return;
    }
    if (!e.target.closest('.log-filter-pop')) {
      closeAllPopups();
    }
    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) {
      return;
    }
    const action = actionEl.getAttribute('data-action');
    if (action === 'toggleFilterPopup') {
      togglePopup(actionEl.getAttribute('data-popup'));
    } else if (action === 'jumpToCommit') {
      post({ type: 'jumpToCommitRequest' });
    } else if (action === 'toggleSearchRegex' || action === 'toggleSearchCase') {
      actionEl.classList.toggle('active');
      actionEl.setAttribute(
        'aria-pressed',
        actionEl.classList.contains('active') ? 'true' : 'false'
      );
      applyFilters();
    } else if (action === 'pickAuthorFilter') {
      const a = actionEl.getAttribute('data-author');
      filterState.authors = a && a !== '__all__' ? [a] : [];
      const ai = byId('filter-author-input') as HTMLInputElement | null;
      if (ai) {
        ai.value = filterState.authors[0] || '';
      }
      syncAuthorChecks();
      setPopValue('user', authorSummary());
      closeAllPopups();
      applyFilters();
    } else if (action === 'pickDateFilter') {
      const range = actionEl.getAttribute('data-range');
      if (range === '24h') {
        filterState.since = daysAgoIso(1);
        filterState.until = '';
        filterState.datePreset = '24h';
        setPopValue('date', 'Last 24 Hours');
      } else if (range === '7d') {
        filterState.since = daysAgoIso(7);
        filterState.until = '';
        filterState.datePreset = '7d';
        setPopValue('date', 'Last 7 Days');
      } else {
        filterState.since = '';
        filterState.until = '';
        filterState.datePreset = '';
        setPopValue('date', dateLabel());
      }
      closeAllPopups();
      applyFilters();
    } else if (action === 'dateSelectCustom') {
      const custom = byId('filter-date-custom');
      if (custom) {
        custom.hidden = false;
      }
    } else if (action === 'applyDateCustom') {
      const afterOn = byId('filter-after-enabled') as HTMLInputElement | null;
      const beforeOn = byId('filter-before-enabled') as HTMLInputElement | null;
      const afterDate = byId('filter-after-date') as HTMLInputElement | null;
      const beforeDate = byId('filter-before-date') as HTMLInputElement | null;
      // A checked bound with an empty date is not a range — rejecting keeps
      // the popup open instead of silently clearing the filter.
      if (afterOn?.checked && !afterDate?.value) {
        return;
      }
      if (beforeOn?.checked && !beforeDate?.value) {
        return;
      }
      filterState.since = afterOn && afterOn.checked && afterDate ? afterDate.value : '';
      filterState.until = beforeOn && beforeOn.checked && beforeDate ? beforeDate.value : '';
      // An explicit range replaces whatever preset was active.
      filterState.datePreset = '';
      setPopValue('date', dateLabel());
      closeAllPopups();
      applyFilters();
    }
  });

  document.addEventListener('change', function (e) {
    if (!(e.target instanceof Element)) {
      return;
    }
    const el = e.target.closest<HTMLInputElement>('[data-action="toggleDateBound"]');
    if (!el) {
      return;
    }
    const dateInput = byId(
      el.getAttribute('data-bound') === 'after' ? 'filter-after-date' : 'filter-before-date'
    ) as HTMLInputElement | null;
    if (dateInput) {
      dateInput.disabled = !el.checked;
      if (el.checked && !dateInput.value) {
        dateInput.value = todayDateValue();
      }
    }
  });

  document.addEventListener('keydown', function (e) {
    if (!(e.target instanceof Element)) {
      return;
    }
    if (e.key === 'Escape') {
      closeAllPopups();
      return;
    }
    if (e.key !== 'Enter') {
      return;
    }
    const a = e.target.getAttribute('data-action');
    if (a === 'filterSearchKeydown') {
      e.preventDefault();
      applyFilters();
    } else if (a === 'filterAuthorKeydown') {
      e.preventDefault();
      const typed = (e.target as HTMLInputElement).value.trim();
      filterState.authors = typed ? [typed] : [];
      syncAuthorChecks();
      setPopValue('user', authorSummary());
      closeAllPopups();
      applyFilters();
    }
  });

  document.addEventListener('change', function (e) {
    if (!(e.target instanceof Element)) {
      return;
    }
    const action = e.target.getAttribute('data-action');
    if (action === 'toggleAuthorCheckbox') {
      const list = byId('filter-author-list');
      if (list) {
        const checked: string[] = [];
        list.querySelectorAll<HTMLInputElement>('input[data-author]').forEach(function (box) {
          if (box.checked) {
            checked.push(box.getAttribute('data-author') || '');
          }
        });
        filterState.authors = checked.filter(function (n) {
          return n.length > 0;
        });
      }
      setPopValue('user', authorSummary());
      applyFilters();
    } else if (action === 'toggleBranchCheckbox') {
      recomputeBranchState();
      applyFilters();
    } else if (action === 'toggleBranchFolder') {
      const wrap = e.target.closest('.log-filter-tree-node');
      const on = (e.target as HTMLInputElement).checked;
      if (wrap) {
        wrap.querySelectorAll('input[data-branch]').forEach(function (leaf) {
          (leaf as HTMLInputElement).checked = on;
        });
      }
      recomputeBranchState();
      applyFilters();
    } else if (action === 'toggleAllBranches') {
      const on = (e.target as HTMLInputElement).checked;
      const list = byId('filter-branch-list');
      if (list) {
        list.querySelectorAll('input[data-branch]').forEach(function (leaf) {
          (leaf as HTMLInputElement).checked = on;
        });
      }
      recomputeBranchState();
      applyFilters();
    } else if (action === 'toggleRepoCheckbox' || action === 'toggleAllRepos') {
      const list = byId('filter-repo-list');
      if (!list) {
        return;
      }
      if (action === 'toggleAllRepos') {
        const on = (e.target as HTMLInputElement).checked;
        list.querySelectorAll('input[data-repo-root]').forEach(function (cb) {
          (cb as HTMLInputElement).checked = on;
        });
      }
      const checks = list.querySelectorAll('input[data-repo-root]');
      const roots: string[] = [];
      checks.forEach(function (cb) {
        if ((cb as HTMLInputElement).checked) {
          roots.push(cb.getAttribute('data-repo-root') || '');
        }
      });
      const allBox = list.querySelector<HTMLInputElement>('input[data-action="toggleAllRepos"]');
      if (allBox) {
        allBox.checked = roots.length === checks.length;
      }
      setPopValue('repo', repoSummary(roots.length, checks.length));
      post({ type: 'selectRepositories', roots: roots });
    }
  });

  document.addEventListener('input', function (e) {
    if (!(e.target instanceof Element)) {
      return;
    }
    if (e.target.getAttribute('data-action') === 'filterSearchKeydown') {
      // Live draft — the host mirrors it so a background re-render restores
      // the in-flight text instead of resetting to the applied filter.
      post({ type: 'logSearchDraft', text: (e.target as HTMLInputElement).value });
      return;
    }
    if (e.target.getAttribute('data-action') !== 'filterPopupSearch') {
      return;
    }
    const q = (e.target as HTMLInputElement).value.toLowerCase();
    const list = byId('filter-branch-list');
    if (!list) {
      return;
    }
    list.querySelectorAll('.log-filter-tree-row').forEach(function (rowLabel) {
      const leaf = rowLabel.querySelector('input[data-branch]');
      const node = rowLabel.closest<HTMLElement>('.log-filter-tree-node');
      if (!leaf || !node) {
        return;
      }
      const ref = (leaf.getAttribute('data-branch') || '').toLowerCase();
      node.hidden = q.length > 0 && ref.indexOf(q) === -1;
    });
  });

  const bridge: IFilterBridge = {
    isBranchChecked: isBranchChecked,
    anyBranchSelected: function (): boolean {
      return filterState.branchMode !== 'all';
    },
    branchState: function (): 'all' | 'subset' | 'none' {
      return filterState.branchMode;
    },
    reconcileBranchSelection: reconcileBranchSelection,
    syncBranchTree: function (): void {
      const l = byId('filter-branch-list');
      if (l) {
        syncBranchFolderChecks(l);
      }
    },
    getAuthor: function (): string {
      return filterState.authors[0] || '';
    },
    getAuthors: function (): string[] {
      return filterState.authors.slice();
    },
  };
  window.__intelligFilter = bridge;

  restoreOpenFilterPopup();
  return bridge;
}
