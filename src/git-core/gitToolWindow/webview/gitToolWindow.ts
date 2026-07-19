/// <reference lib="dom" />
/**
 * Webview entry for the Git tool window (bundled into media/webview/gitToolWindow.js).
 *
 * The log-graph client: repository/log-filter popups, commit-row selection +
 * range selection, the host-computed menu enable-map, anchor restoration,
 * scroll-to-commit, load-more + graph-scroll persistence, and the commit /
 * collapsed-ref context menus. Reads the initial + History commit-details models
 * from the host's `data-init` island and builds both panels via the shared
 * `buildDetailsPanelDom`. Posts protocol-typed messages on the log channel
 * (GitToolWindowInbound) and the tab channel (GitToolWindowTabsInbound: the
 * tab-strip switch plus every History-tab action).
 *
 * The tab strip, History behavior, and the graph/column dividers all run from
 * this one bundle, so the whole document has a single `acquireVsCodeApi()` and
 * the sibling inline scripts are gone.
 */

import type { GitToolWindowInbound, GitToolWindowOutbound } from '../gitToolWindow.protocol';
import type { GitToolWindowTabsInbound } from '../gitToolWindowTabs.protocol';
import type { DetailsPanelModel } from '../provider/detailsPanelModel.types';
import { isTabId } from '../tabIds';
import { buildDetailsPanelDom } from './detailsPanelDom';
import { INIT_ELEMENT_ID, parseInitIsland } from '../../../utils/webviewInit';
import {
  loadWebviewState,
  saveWebviewState,
  type IWebviewStateSlot,
} from '../../../utils/webviewStateSlot';

interface IVsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): unknown;
}

declare function acquireVsCodeApi(): IVsCodeApi;

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

/** The initial + History commit-details models the host bakes into the island. */
interface IGitToolWindowInit {
  initialDetails: DetailsPanelModel | null;
  historyDetails: DetailsPanelModel | null;
}

/** Bridge the setupLogFilterRow scope exposes to the window-message handlers. */
interface IFilterBridge {
  isBranchChecked(name: string): boolean;
  anyBranchSelected(): boolean;
  branchState(): 'all' | 'subset' | 'none';
  reconcileBranchSelection(): void;
  syncBranchTree(): void;
  getAuthor(): string;
  getAuthors(): string[];
}

const OPEN_FILTER_POPUP_SLOT: IWebviewStateSlot<string | null> = {
  key: 'openFilterPopup',
  version: 1,
  validate: (raw) => (typeof raw === 'string' || raw === null ? raw : undefined),
};

const GRAPH_SCROLL_TOP_SLOT: IWebviewStateSlot<number> = {
  key: 'graphScrollTop',
  version: 1,
  validate: (raw) => (typeof raw === 'number' && isFinite(raw) ? raw : undefined),
};

const vscodeApi: IVsCodeApi | undefined =
  typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;

if (vscodeApi) {
  main(vscodeApi);
}

function main(vscode: IVsCodeApi): void {
  function post(message: GitToolWindowInbound | GitToolWindowTabsInbound): void {
    vscode.postMessage(message);
  }

  // Escape a value before splicing it into an attribute selector
  // ([data-hash="<sha>"]). Prefers the native CSS.escape (present in the
  // Chromium webview); falls back to a minimal escaper so the script also runs
  // under test DOMs that lack the global CSS object. Keeps a malformed value
  // from throwing a querySelector SyntaxError / mis-selecting.
  function cssEscapeHash(value: string): string {
    const s = String(value);
    if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') {
      return CSS.escape(s);
    }
    return s.replace(/[^a-zA-Z0-9_-]/g, function (ch) {
      return '\\' + ch;
    });
  }

  /** Read accessors the window-message handlers use to mark the active branch/author. */
  let filterBridge: IFilterBridge | null = null;

  // ─── Log filter row (IntelliJ VcsLogClassicFilterUi) ─────────────
  setupLogFilterRow();

  function setupLogFilterRow(): void {
    const row = document.querySelector('.log-filter-row');
    if (!row) {
      return;
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
          const present: Record<string, boolean> = {};
          leaves.forEach(function (cb) {
            present[cb.getAttribute('data-branch') || ''] = true;
          });
          const kept = filterState.branches.filter(function (r) {
            return present[r];
          });
          if (kept.length === 0 || kept.length === leaves.length) {
            filterState.branchMode = 'all';
            filterState.branches = [];
          } else {
            filterState.branches = kept;
          }
          leaves.forEach(function (cb) {
            (cb as HTMLInputElement).checked = isBranchChecked(
              cb.getAttribute('data-branch') || ''
            );
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
    function readSearch(): string {
      const el = byId('filter-search') as HTMLInputElement | null;
      return el ? el.value.trim() : '';
    }
    function readToggle(id: string): boolean {
      const el = byId(id);
      return el ? el.classList.contains('active') : false;
    }

    function applyFilters(): void {
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
      saveWebviewState(vscode, OPEN_FILTER_POPUP_SLOT, key);
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
      const key = loadWebviewState(vscode, OPEN_FILTER_POPUP_SLOT);
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
      closeAllPopups();
      const menu = document.getElementById('commit-context-menu');
      if (menu) {
        menu.hidden = true;
      }
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
          setPopValue('date', 'Last 24 Hours');
        } else if (range === '7d') {
          filterState.since = daysAgoIso(7);
          filterState.until = '';
          setPopValue('date', 'Last 7 Days');
        } else {
          filterState.since = '';
          filterState.until = '';
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
        filterState.searchText = readSearch();
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

    filterBridge = {
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
    window.__intelligFilter = filterBridge;

    restoreOpenFilterPopup();
  }

  // ─── Multi-select webview state ──────────────────────────────────
  let anchorHash: string | null = (function readInitialAnchor(): string | null {
    const gp = document.querySelector('.graph-panel[data-anchor-hash]');
    if (!gp) {
      return null;
    }
    const v = gp.getAttribute('data-anchor-hash') || '';
    return v.length > 0 ? v : null;
  })();

  let menuEnableMap: Record<
    string,
    { visible?: boolean; enabled?: boolean; reason?: string }
  > | null = null;

  let branchFocus: { focusedBranchName: string | null; focusedHash: string | null } | null = null;

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
    if (anchorHash === null || allHashes.indexOf(anchorHash) === -1) {
      rows.forEach(function (r) {
        r.classList.remove('selected');
        r.setAttribute('aria-selected', 'false');
      });
      const target = rows[clickIdx];
      target.classList.add('selected');
      target.setAttribute('aria-selected', 'true');
      anchorHash = clickHash;
      refreshSelectedCount();
      return;
    }
    const anchorIdx = allHashes.indexOf(anchorHash);
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

  // Handle state updates from the extension host.
  window.addEventListener('message', function (event: MessageEvent) {
    const message = event.data as GitToolWindowOutbound | null;
    if (!message || typeof message !== 'object') {
      return;
    }
    if (message.type === 'scrollToCommit' && message.commitHash) {
      scrollToCommit(message.commitHash);
    }
    if (message.type === 'graphTotalsUpdate') {
      const gp = document.querySelector('.graph-panel');
      if (gp) {
        if (typeof message.total === 'number') {
          gp.setAttribute('data-total-available', String(message.total));
        }
        if (typeof message.loaded === 'number') {
          gp.setAttribute('data-loaded-count', String(message.loaded));
        }
      }
    }
    if (message.type === 'updateDetailsPanel' && message.model) {
      const detailsPanel = document.getElementById('details-panel');
      if (detailsPanel) {
        detailsPanel.replaceChildren(buildDetailsPanelDom(message.model));
      }
    }
    if (message.type === 'selectGraphRow' && message.commitHash) {
      document.querySelectorAll('.commit-row.selected').forEach(function (r) {
        r.classList.remove('selected');
        r.setAttribute('aria-selected', 'false');
      });
      const targetRow = document.querySelector<HTMLElement>(
        '.commit-row[data-hash="' + cssEscapeHash(message.commitHash) + '"]'
      );
      if (targetRow) {
        targetRow.classList.add('selected');
        targetRow.setAttribute('aria-selected', 'true');
        scrollRowIntoViewIfNeeded(targetRow);
      }
      refreshSelectedCount();
    }
    if (message.type === 'updateMenuEnableState' && message.state) {
      menuEnableMap = message.state as typeof menuEnableMap;
      const openMenu = document.getElementById('commit-context-menu');
      if (openMenu && !openMenu.hidden) {
        applyMenuEnableMap(openMenu);
      }
    }
    if (message.type === 'syncSelection') {
      anchorHash =
        typeof message.anchorHash === 'string' && message.anchorHash.length > 0
          ? message.anchorHash
          : null;
      const wantSelected = new Set(
        Array.isArray(message.selectedHashes) ? message.selectedHashes : []
      );
      document.querySelectorAll('.graph-panel .commit-row[data-hash]').forEach(function (r) {
        const h = r.getAttribute('data-hash');
        if (h && wantSelected.has(h)) {
          r.classList.add('selected');
          r.setAttribute('aria-selected', 'true');
        } else {
          r.classList.remove('selected');
          r.setAttribute('aria-selected', 'false');
        }
      });
      refreshSelectedCount();
    }
    if (message.type === 'logFilterOptionsReady') {
      const list = document.getElementById('filter-branch-list');
      const groups = message.branchGroups;
      if (list && groups) {
        const intf = filterBridge;
        const checked = (name: string): boolean => (intf ? intf.isBranchChecked(name) : false);
        list.replaceChildren();
        const addSection = function (title: string): void {
          const header = document.createElement('div');
          header.className = 'log-filter-popup-section';
          header.textContent = title;
          list.appendChild(header);
        };
        interface ITreeNode {
          children: Record<string, ITreeNode>;
          order: string[];
          leaf: string | null;
        }
        const buildTree = function (names: string[], stripPrefix: string): ITreeNode {
          const root: ITreeNode = { children: {}, order: [], leaf: null };
          names.forEach(function (full) {
            const shown =
              stripPrefix && full.indexOf(stripPrefix) === 0
                ? full.slice(stripPrefix.length)
                : full;
            const parts = shown.split('/').filter(Boolean);
            let node = root;
            parts.forEach(function (seg, i) {
              if (!node.children[seg]) {
                node.children[seg] = { children: {}, order: [], leaf: null };
                node.order.push(seg);
              }
              node = node.children[seg];
              if (i === parts.length - 1) {
                node.leaf = full;
              }
            });
          });
          return root;
        };
        const renderTree = function (container: HTMLElement, node: ITreeNode, depth: number): void {
          node.order.sort();
          node.order.forEach(function (seg) {
            const child = node.children[seg];
            const hasChildren = child.order.length > 0;
            const wrap = document.createElement('div');
            wrap.className = 'log-filter-tree-node';
            const rowLabel = document.createElement('label');
            rowLabel.className = 'log-filter-tree-row';
            rowLabel.style.paddingLeft = depth * 14 + 8 + 'px';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            if (child.leaf) {
              cb.setAttribute('data-action', 'toggleBranchCheckbox');
              cb.setAttribute('data-branch', child.leaf);
              cb.checked = !!checked(child.leaf);
            } else {
              cb.setAttribute('data-action', 'toggleBranchFolder');
            }
            const text = document.createElement('span');
            text.className = hasChildren ? 'log-filter-tree-folder' : 'log-filter-tree-leaf';
            text.textContent = seg;
            rowLabel.appendChild(cb);
            rowLabel.appendChild(text);
            wrap.appendChild(rowLabel);
            container.appendChild(wrap);
            if (hasChildren) {
              renderTree(wrap, child, depth + 1);
            }
          });
        };
        const masterRow = document.createElement('label');
        masterRow.className = 'log-filter-tree-row';
        const masterCb = document.createElement('input');
        masterCb.type = 'checkbox';
        masterCb.className = 'log-filter-tree-check';
        masterCb.setAttribute('data-action', 'toggleAllBranches');
        masterCb.checked = (intf ? intf.branchState() : 'all') === 'all';
        const masterText = document.createElement('span');
        masterText.className = 'log-filter-tree-leaf';
        masterText.textContent = 'All branches';
        masterRow.appendChild(masterCb);
        masterRow.appendChild(masterText);
        list.appendChild(masterRow);
        if (Array.isArray(groups.local) && groups.local.length > 0) {
          addSection('Local');
          renderTree(list, buildTree(groups.local, ''), 0);
        }
        if (Array.isArray(groups.remotes)) {
          groups.remotes.forEach(function (g) {
            if (!g.branches || g.branches.length === 0) {
              return;
            }
            addSection(g.remote);
            renderTree(list, buildTree(g.branches, g.remote + '/'), 0);
          });
        }
        if (intf && intf.reconcileBranchSelection) {
          intf.reconcileBranchSelection();
        }
        if (intf && intf.syncBranchTree) {
          intf.syncBranchTree();
        }
      }
    }
    if (message.type === 'authorOptionsReady') {
      const list = document.getElementById('filter-author-list');
      if (list && Array.isArray(message.authors)) {
        const current = filterBridge ? filterBridge.getAuthor() : '';
        list.replaceChildren();
        const allBtn = document.createElement('button');
        allBtn.type = 'button';
        allBtn.className = 'log-filter-popup-item' + (current ? '' : ' active');
        allBtn.setAttribute('data-action', 'pickAuthorFilter');
        allBtn.setAttribute('data-author', '__all__');
        allBtn.textContent = 'All users';
        list.appendChild(allBtn);
        // "me" preset — applies the resolved configured identity as the
        // author filter; omitted when the identity is unknown.
        if (typeof message.me === 'string' && message.me.length > 0) {
          const meBtn = document.createElement('button');
          meBtn.type = 'button';
          meBtn.className = 'log-filter-popup-item' + (message.me === current ? ' active' : '');
          meBtn.setAttribute('data-action', 'pickAuthorFilter');
          meBtn.setAttribute('data-author', message.me);
          meBtn.textContent = 'me';
          list.appendChild(meBtn);
        }
        // Each author is a CHECKBOX (IntelliJ multi-user filter): checking
        // several unions them; All users / me stay one-click buttons above.
        message.authors.forEach(function (a) {
          const name = String(a);
          const label = document.createElement('label');
          label.className = 'log-filter-tree-row';
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.setAttribute('data-action', 'toggleAuthorCheckbox');
          box.setAttribute('data-author', name);
          const bridge = window.__intelligFilter;
          box.checked = bridge ? bridge.getAuthors().indexOf(name) !== -1 : name === current;
          const text = document.createElement('span');
          text.className = 'log-filter-tree-leaf';
          text.textContent = name;
          label.appendChild(box);
          label.appendChild(text);
          list.appendChild(label);
        });
      }
    }
    if (message.type === 'updateBranchFocus') {
      branchFocus = {
        focusedBranchName:
          typeof message.focusedBranchName === 'string' ? message.focusedBranchName : null,
        focusedHash: typeof message.focusedHash === 'string' ? message.focusedHash : null,
      };
      const focusedName = branchFocus.focusedBranchName;
      document
        .querySelectorAll(
          '.branch-label-local[data-branch-name], .branch-label-remote[data-branch-name], .branch-label-head[data-branch-name]'
        )
        .forEach(function (chip) {
          const name = chip.getAttribute('data-branch-name');
          if (focusedName !== null && name === focusedName) {
            chip.classList.add('branch-label-focused');
          } else {
            chip.classList.remove('branch-label-focused');
          }
        });
    }
  });

  function scrollRowIntoViewIfNeeded(row: HTMLElement): void {
    const panel = row.closest('.graph-panel');
    if (panel) {
      const rowTop = row.offsetTop;
      const rowBottom = rowTop + row.offsetHeight;
      const viewportTop = panel.scrollTop;
      const viewportBottom = viewportTop + panel.clientHeight;
      const fullyVisible = rowTop >= viewportTop && rowBottom <= viewportBottom;
      if (!fullyVisible) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
    setTimeout(function (): void {
      commitRow.classList.remove('highlight-scroll');
    }, 2000);
  }

  function jumpToCommitHash(hash: string): void {
    const targetRow = document.querySelector(
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
    targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
    refreshSelectedCount();
    post({ type: 'selectCommit', commitHash: hash });
  }

  function openNavigationPopup(
    hashes: string[],
    clientX: number,
    clientY: number,
    onSelect: (hash: string) => void
  ): void {
    const popup = document.getElementById('ref-popup');
    if (!popup) {
      return;
    }

    popup.innerHTML = '';
    hashes.forEach(function (h) {
      const row = document.createElement('div');
      row.className = 'context-menu-item';
      row.setAttribute('role', 'menuitem');
      row.setAttribute('tabindex', '0');
      row.setAttribute('data-nav-hash', h);
      row.textContent = h.substring(0, 8);
      popup.appendChild(row);
    });

    const menuWidth = 220;
    const menuHeight = 200;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = clientX + menuWidth > vw ? vw - menuWidth - 10 : clientX;
    const top = clientY + menuHeight > vh ? vh - menuHeight - 10 : clientY;
    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
    popup.hidden = false;

    function pickHandler(e: Event): void {
      const target = e.target instanceof Element ? e.target : null;
      const row = target ? target.closest('#ref-popup [data-nav-hash]') : null;
      if (!row) {
        if (!popup!.contains(e.target as Node)) {
          popup!.hidden = true;
          document.removeEventListener('click', pickHandler, true);
        }
        return;
      }
      e.stopPropagation();
      const h = row.getAttribute('data-nav-hash');
      popup!.hidden = true;
      document.removeEventListener('click', pickHandler, true);
      if (h) {
        onSelect(h);
      }
    }
    document.addEventListener('click', pickHandler, true);
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
      const prev = loadWebviewState(vscode, GRAPH_SCROLL_TOP_SLOT);
      if (prev) {
        saveWebviewState(vscode, GRAPH_SCROLL_TOP_SLOT, 0);
      }
      return;
    }

    const saved = loadWebviewState(vscode, GRAPH_SCROLL_TOP_SLOT);
    if (typeof saved !== 'number' || saved <= 0) {
      return;
    }

    graphPanel.scrollTop = saved;
    if (typeof requestAnimationFrame === 'function') {
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

  // ─── Event delegation for commit rows ────────────────────────────
  document.addEventListener('click', function (e) {
    const target = e.target instanceof Element ? e.target : null;
    const commitRow = target ? target.closest('.commit-row[data-hash]') : null;
    if (commitRow) {
      if (target && (target.closest('.context-menu') || target.closest('.details-panel'))) {
        return;
      }
      const hash = commitRow.getAttribute('data-hash');
      if (hash) {
        const me = e as MouseEvent;
        if (me.shiftKey && (me.ctrlKey || me.metaKey)) {
          post({ type: 'addRangeSelectCommit', commitHash: hash, anchorHash: anchorHash });
          applyRangeSelectionDom(hash, true);
        } else if (me.shiftKey) {
          post({ type: 'rangeSelectCommit', commitHash: hash, anchorHash: anchorHash });
          applyRangeSelectionDom(hash, false);
        } else if (me.ctrlKey || me.metaKey) {
          post({ type: 'toggleCommitSelection', commitHash: hash });
          commitRow.classList.toggle('selected');
          const isNowSelected = commitRow.classList.contains('selected');
          commitRow.setAttribute('aria-selected', String(isNowSelected));
          anchorHash = hash;
          refreshSelectedCount();
        } else {
          post({ type: 'selectCommit', commitHash: hash });
          document.querySelectorAll('.commit-row.selected').forEach(function (r) {
            r.classList.remove('selected');
            r.setAttribute('aria-selected', 'false');
          });
          commitRow.classList.add('selected');
          commitRow.setAttribute('aria-selected', 'true');
          anchorHash = hash;
          refreshSelectedCount();
        }
      }
    }
  });

  document.addEventListener('contextmenu', function (e) {
    const target = e.target instanceof Element ? e.target : null;
    // Only one context menu at a time: hide all three, then re-show the
    // matching one below.
    ['commit-context-menu', 'file-context-menu', 'history-context-menu'].forEach(function (id) {
      const m = document.getElementById(id);
      if (m) {
        m.hidden = true;
      }
    });
    const commitRow = target ? target.closest('.commit-row[data-hash]') : null;
    if (commitRow) {
      const hash = commitRow.getAttribute('data-hash');
      if (hash) {
        e.preventDefault();
        e.stopPropagation();
        showCommitContextMenu(e as MouseEvent, hash);
      }
      return;
    }
    const fileItem = target
      ? target.closest('.changed-file-item[data-path][data-commit-hash]')
      : null;
    if (fileItem) {
      const commitHash = fileItem.getAttribute('data-commit-hash');
      const path = fileItem.getAttribute('data-path');
      const menu = document.getElementById('file-context-menu');
      if (commitHash && path && menu) {
        e.preventDefault();
        e.stopPropagation();
        fileContextTarget = { commitHash: commitHash, path: path };
        positionContextMenu(menu, e as MouseEvent);
      }
      return;
    }
    const historyRow = target ? target.closest('.history-commit-row[data-rev]') : null;
    if (historyRow) {
      const rev = historyRow.getAttribute('data-rev');
      const menu = document.getElementById('history-context-menu');
      if (rev && menu) {
        e.preventDefault();
        e.stopPropagation();
        historyContextRev = rev;
        positionContextMenu(menu, e as MouseEvent);
      }
    }
  });

  // Details-panel file context menu → fileContextAction relay; History-tab
  // revision context menu → history.compareWith* relay. Click-away hides both.
  let fileContextTarget: { commitHash: string; path: string } | null = null;
  let historyContextRev: string | null = null;

  document.addEventListener('click', function (e) {
    const target = e.target instanceof Element ? e.target : null;
    const fileMenu = document.getElementById('file-context-menu');
    if (fileMenu && target && !fileMenu.contains(target)) {
      fileMenu.hidden = true;
    }
    const historyMenu = document.getElementById('history-context-menu');
    if (historyMenu && target && !historyMenu.contains(target)) {
      historyMenu.hidden = true;
    }

    const fileEntry = target
      ? target.closest('#file-context-menu .context-menu-item[data-file-action]')
      : null;
    if (fileEntry && fileMenu && fileContextTarget) {
      const action = fileEntry.getAttribute('data-file-action');
      if (action) {
        post({
          type: 'fileContextAction',
          action: action,
          commitHash: fileContextTarget.commitHash,
          path: fileContextTarget.path,
        });
      }
      fileMenu.hidden = true;
      return;
    }

    const historyEntry = target
      ? target.closest('#history-context-menu .context-menu-item[data-history-action]')
      : null;
    if (historyEntry && historyMenu && historyContextRev) {
      const action = historyEntry.getAttribute('data-history-action');
      if (action === 'compareWithHead') {
        post({ type: 'history.compareWithHead', rev: historyContextRev });
      } else if (action === 'compareWithRef') {
        post({ type: 'history.compareWithRef', rev: historyContextRev });
      }
      historyMenu.hidden = true;
    }
  });

  // ─── fixup!/squash! link click → jumpToFixupTarget ───────────────
  document.addEventListener('click', function (e) {
    if (!(e.target instanceof Element)) {
      return;
    }
    const link = e.target.closest('[data-action="jumpToFixupTarget"]');
    if (link) {
      e.stopPropagation();
      const targetSubject = link.getAttribute('data-target');
      if (targetSubject) {
        post({ type: 'jumpToFixupTarget', targetSubject: targetSubject });
      }
    }
  });

  // ─── Event delegation for details panel ──────────────────────────
  document.addEventListener('click', function (e) {
    const target = e.target instanceof Element ? e.target : null;
    const parentHash = target ? target.closest('.parent-hash[data-parent-hash]') : null;
    if (parentHash) {
      const hash = parentHash.getAttribute('data-parent-hash');
      if (hash) {
        if (parentHash.closest('#history-details-panel')) {
          const rowSel = '.history-commit-row[data-rev="' + hash + '"]';
          if (document.querySelector(rowSel)) {
            post({ type: 'history.selectRevision', rev: hash });
          }
        } else {
          post({ type: 'selectCommit', commitHash: hash });
        }
      }
    }
  });

  document.addEventListener('click', function (e) {
    const target = e.target instanceof Element ? e.target : null;
    const hashValue = target ? target.closest('.hash-value[data-copy-text]') : null;
    if (hashValue) {
      const text = hashValue.getAttribute('data-copy-text');
      if (text) {
        navigator.clipboard.writeText(text).catch(function (_err) {
          /* clipboard writes can fail on focus loss; the chip stays visible for retry */
        });
      }
    }
  });

  document.addEventListener('dblclick', function (e) {
    const target = e.target instanceof Element ? e.target : null;
    const fileItem = target
      ? target.closest('.changed-file-item[data-path][data-commit-hash]')
      : null;
    if (fileItem) {
      const commitHash = fileItem.getAttribute('data-commit-hash');
      const path = fileItem.getAttribute('data-path');
      if (commitHash && path) {
        post({ type: 'doubleClickFile', commitHash: commitHash, path: path });
      }
    }
  });

  // Changed Files directory tree collapse/expand.
  function toggleChangedDir(dirItem: Element): void {
    const containerId = dirItem.getAttribute('aria-controls');
    if (!containerId) {
      return;
    }
    const container = document.getElementById(containerId);
    if (!container) {
      return;
    }
    const expanded = dirItem.getAttribute('aria-expanded') !== 'false';
    const nowExpanded = !expanded;
    dirItem.setAttribute('aria-expanded', String(nowExpanded));
    container.classList.toggle('changed-dir-collapsed', !nowExpanded);
    const chevron = dirItem.querySelector('.dir-chevron');
    if (chevron) {
      chevron.classList.toggle('codicon-chevron-down', nowExpanded);
      chevron.classList.toggle('codicon-chevron-right', !nowExpanded);
    }
  }

  document.addEventListener('click', function (e) {
    const target = e.target instanceof Element ? e.target : null;
    const dirItem = target ? target.closest('.changed-dir-item[aria-controls]') : null;
    if (dirItem) {
      toggleChangedDir(dirItem);
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') {
      return;
    }
    const target = e.target instanceof Element ? e.target : null;
    const dirItem = target ? target.closest('.changed-dir-item[aria-controls]') : null;
    if (!dirItem) {
      return;
    }
    e.preventDefault();
    toggleChangedDir(dirItem);
  });

  // Keyboard handler for commits.
  function handleCommitKeydown(event: KeyboardEvent, hash: string): void {
    switch (event.key) {
      case 'Enter':
      case ' ': {
        event.preventDefault();
        const evtTarget = event.target instanceof Element ? event.target : null;
        if (event.ctrlKey || event.metaKey) {
          post({ type: 'toggleCommitSelection', commitHash: hash });
          const row = evtTarget ? evtTarget.closest('.commit-row') : null;
          if (row) {
            row.classList.toggle('selected');
            const isNowSelected = row.classList.contains('selected');
            row.setAttribute('aria-selected', String(isNowSelected));
          }
          anchorHash = hash;
          refreshSelectedCount();
        } else {
          post({ type: 'selectCommit', commitHash: hash });
          document.querySelectorAll('.commit-row.selected').forEach(function (r) {
            r.classList.remove('selected');
            r.setAttribute('aria-selected', 'false');
          });
          const row = evtTarget ? evtTarget.closest('.commit-row') : null;
          if (row) {
            row.classList.add('selected');
            row.setAttribute('aria-selected', 'true');
          }
          anchorHash = hash;
          refreshSelectedCount();
        }
        break;
      }
      case 'ArrowUp':
      case 'ArrowDown': {
        event.preventDefault();
        const rows = Array.from(
          document.querySelectorAll<HTMLElement>('.graph-panel .commit-row[data-hash]')
        );
        const allHashes = rows.map(function (r) {
          return r.getAttribute('data-hash');
        });
        const curIdx = allHashes.indexOf(hash);
        if (curIdx === -1) {
          break;
        }
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        const targetIdx = curIdx + delta;
        if (targetIdx < 0 || targetIdx >= rows.length) {
          break;
        }
        const targetRow = rows[targetIdx];
        const targetHash = allHashes[targetIdx];
        if (!targetHash) {
          break;
        }
        if (event.shiftKey && (event.ctrlKey || event.metaKey)) {
          post({ type: 'addRangeSelectCommit', commitHash: targetHash, anchorHash: anchorHash });
          applyRangeSelectionDom(targetHash, true);
        } else if (event.shiftKey) {
          post({ type: 'rangeSelectCommit', commitHash: targetHash, anchorHash: anchorHash });
          applyRangeSelectionDom(targetHash, false);
        } else {
          post({ type: 'selectCommit', commitHash: targetHash });
          document.querySelectorAll('.commit-row.selected').forEach(function (r) {
            r.classList.remove('selected');
            r.setAttribute('aria-selected', 'false');
          });
          targetRow.classList.add('selected');
          targetRow.setAttribute('aria-selected', 'true');
          anchorHash = targetHash;
          refreshSelectedCount();
        }
        if (targetRow.focus) {
          targetRow.focus();
        }
        if (targetRow.scrollIntoView) {
          targetRow.scrollIntoView({ block: 'nearest' });
        }
        break;
      }
      case 'ContextMenu':
        event.preventDefault();
        showCommitContextMenu(event, hash);
        break;
      case 'ArrowRight': {
        event.preventDefault();
        const selectedRows = document.querySelectorAll('.graph-panel .commit-row.selected');
        if (selectedRows.length !== 1) {
          break;
        }
        const currentRow = document.querySelector(
          '.commit-row[data-hash="' + cssEscapeHash(hash) + '"]'
        );
        if (!currentRow) {
          break;
        }
        const parentsRaw = currentRow.getAttribute('data-parents') || '';
        const parents = parentsRaw.split(',').filter(function (h) {
          return h.length > 0;
        });
        if (parents.length === 0) {
          break;
        }
        if (parents.length === 1) {
          jumpToCommitHash(parents[0]);
        } else {
          const rect = currentRow.getBoundingClientRect();
          openNavigationPopup(parents, rect.right, rect.top, jumpToCommitHash);
        }
        break;
      }
      case 'ArrowLeft': {
        event.preventDefault();
        const selectedRowsL = document.querySelectorAll('.graph-panel .commit-row.selected');
        if (selectedRowsL.length !== 1) {
          break;
        }
        const allRowsL = Array.from(document.querySelectorAll('.commit-row[data-hash]'));
        const childrenL = allRowsL
          .filter(function (r) {
            const p = r.getAttribute('data-parents') || '';
            return p.split(',').indexOf(hash) !== -1;
          })
          .map(function (r) {
            return r.getAttribute('data-hash') as string;
          });
        if (childrenL.length === 0) {
          break;
        }
        if (childrenL.length === 1) {
          jumpToCommitHash(childrenL[0]);
        } else {
          const currentRowL = document.querySelector(
            '.commit-row[data-hash="' + cssEscapeHash(hash) + '"]'
          );
          const rect = currentRowL
            ? currentRowL.getBoundingClientRect()
            : ({ right: 0, top: 0 } as DOMRect);
          openNavigationPopup(childrenL, rect.right, rect.top, jumpToCommitHash);
        }
        break;
      }
      case 'c':
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          // CopyRevisionNumberAction parity: act on the SELECTION when the
          // focused row is part of it — oldest-first (reverse of the
          // newest-first DOM order), space-joined for terminal paste. An
          // unselected focused row copies just itself.
          const selectedHashesForCopy = Array.from(
            document.querySelectorAll('.graph-panel .commit-row.selected')
          )
            .map(function (r) {
              return r.getAttribute('data-hash') || '';
            })
            .filter(function (h) {
              return h.length > 0;
            });
          const copyText =
            selectedHashesForCopy.indexOf(hash) !== -1
              ? selectedHashesForCopy.reverse().join(' ')
              : hash;
          navigator.clipboard.writeText(copyText).catch(function (_err) {
            /* clipboard writes can fail on focus loss; the user can re-copy */
          });
        }
        break;
    }
  }

  // Commit context menu for the Graph Panel.
  let commitContextMenuHashes: string[] = [];

  function showCommitContextMenu(event: MouseEvent | KeyboardEvent, hash: string): void {
    event.preventDefault();
    event.stopPropagation();

    const selectedRows = document.querySelectorAll('.graph-panel .commit-row.selected');
    const selectedHashes = Array.from(selectedRows).map(function (row) {
      return row.getAttribute('data-hash') || '';
    });

    if (selectedHashes.indexOf(hash) === -1) {
      document.querySelectorAll('.commit-row.selected').forEach(function (r) {
        r.classList.remove('selected');
        r.setAttribute('aria-selected', 'false');
      });
      const target = document.querySelector('.commit-row[data-hash="' + cssEscapeHash(hash) + '"]');
      if (target) {
        target.classList.add('selected');
        target.setAttribute('aria-selected', 'true');
      }
      anchorHash = hash;
      refreshSelectedCount();
      post({ type: 'selectIfNotSelected', commitHash: hash });
      commitContextMenuHashes = [hash];
    } else if (selectedHashes.length > 1) {
      commitContextMenuHashes = selectedHashes;
    } else {
      commitContextMenuHashes = [hash];
    }

    const contextMenu = document.getElementById('commit-context-menu');
    if (contextMenu) {
      applyMenuEnableMap(contextMenu);
      positionContextMenu(contextMenu, event as MouseEvent);
    }
  }

  /** Clamp a context menu near the pointer, then show it. Shared skeleton. */
  function positionContextMenu(menu: HTMLElement, event: MouseEvent): void {
    const x = event.clientX || 0;
    const y = event.clientY || 0;

    const menuWidth = 220;
    const menuHeight = 400;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const left = Math.max(8, x + menuWidth > viewportWidth ? viewportWidth - menuWidth - 10 : x);
    const top = Math.max(8, y + menuHeight > viewportHeight ? viewportHeight - menuHeight - 10 : y);

    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    menu.style.maxHeight = viewportHeight - top - 10 + 'px';
    menu.style.overflowY = 'auto';
    menu.hidden = false;
  }

  function applyMenuEnableMap(contextMenu: HTMLElement): void {
    const map = menuEnableMap;
    const items = contextMenu.querySelectorAll('.context-menu-item');
    items.forEach(function (item) {
      const action = item.getAttribute('data-action') || '';
      const entry = map ? map[action] : null;
      const visible = entry ? entry.visible : true;
      const enabled = entry ? entry.enabled : true;
      if (visible) {
        item.classList.remove('menu-multi-hidden');
      } else {
        item.classList.add('menu-multi-hidden');
      }
      if (enabled) {
        item.classList.remove('disabled');
      } else {
        item.classList.add('disabled');
      }
      // Surface entry.reason as a title= tooltip on visible-disabled rows. The
      // typeof check keeps a malformed payload from rendering "[object Object]"
      // or "undefined" into the user's tooltip.
      //
      // INVARIANT (with multiSelect.ts:computeMenuState): the host sets reason
      // ONLY when visible && !enabled. This gate mirrors that on the wire side.
      // If a future host bug set reason on a hidden row, the title write would
      // silently emit on a .menu-multi-hidden element — a sign the host
      // invariant has drifted.
      const titleAttr =
        entry && !entry.enabled && typeof entry.reason === 'string' ? entry.reason : '';
      if (titleAttr) {
        item.setAttribute('title', titleAttr);
      } else {
        item.removeAttribute('title');
      }
    });
  }

  document.addEventListener('click', function (e) {
    const target = e.target instanceof Element ? e.target : null;
    const commitContextMenu = document.getElementById('commit-context-menu');
    if (commitContextMenu && target && !commitContextMenu.contains(target)) {
      commitContextMenu.hidden = true;
    }

    const menuItem = target ? target.closest('#commit-context-menu .context-menu-item') : null;
    if (menuItem && commitContextMenuHashes.length > 0) {
      if (menuItem.classList.contains('disabled')) {
        return;
      }
      const action = (menuItem as HTMLElement).dataset.action;
      if (action) {
        if (action === 'goToParent' || action === 'goToChild') {
          const menu = document.getElementById('commit-context-menu');
          if (menu) {
            menu.hidden = true;
          }
          const hash = commitContextMenuHashes[0];
          if (!hash) {
            return;
          }
          if (action === 'goToParent') {
            const row = document.querySelector(
              '.commit-row[data-hash="' + cssEscapeHash(hash) + '"]'
            );
            if (!row) {
              return;
            }
            const parentsRaw = row.getAttribute('data-parents') || '';
            const parents = parentsRaw.split(',').filter(function (h) {
              return h.length > 0;
            });
            if (parents.length === 0) {
              return;
            }
            if (parents.length === 1) {
              jumpToCommitHash(parents[0]);
            } else {
              openNavigationPopup(
                parents,
                (e as MouseEvent).clientX,
                (e as MouseEvent).clientY,
                jumpToCommitHash
              );
            }
          } else {
            const allRows = Array.from(document.querySelectorAll('.commit-row[data-hash]'));
            const children = allRows
              .filter(function (r) {
                const p = r.getAttribute('data-parents') || '';
                return p.split(',').indexOf(hash) !== -1;
              })
              .map(function (r) {
                return r.getAttribute('data-hash') as string;
              });
            if (children.length === 0) {
              return;
            }
            if (children.length === 1) {
              jumpToCommitHash(children[0]);
            } else {
              openNavigationPopup(
                children,
                (e as MouseEvent).clientX,
                (e as MouseEvent).clientY,
                jumpToCommitHash
              );
            }
          }
          return;
        }
        post({
          type: 'commitContextMenu',
          action: action,
          commitHashes: commitContextMenuHashes,
        });
        const menu = document.getElementById('commit-context-menu');
        if (menu) {
          menu.hidden = true;
        }
      }
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      const commitContextMenu = document.getElementById('commit-context-menu');
      if (commitContextMenu) {
        commitContextMenu.hidden = true;
      }
    }
  });

  window.addEventListener('blur', function () {
    const commitContextMenu = document.getElementById('commit-context-menu');
    if (commitContextMenu) {
      commitContextMenu.hidden = true;
    }
  });

  // ─── Collapsed-ref popup (branch label "+N" chip) ────────────────
  let refPopupOpener: HTMLElement | null = null;

  function closeRefPopup(restoreFocus: boolean): void {
    const popup = document.getElementById('ref-popup');
    if (popup) {
      popup.hidden = true;
    }
    if (refPopupOpener) {
      refPopupOpener.setAttribute('aria-expanded', 'false');
      if (restoreFocus && typeof refPopupOpener.focus === 'function') {
        refPopupOpener.focus();
      }
    }
    refPopupOpener = null;
  }

  function openRefPopup(chip: HTMLElement, clientX: number, clientY: number): void {
    const popup = document.getElementById('ref-popup');
    if (!popup) {
      return;
    }
    const raw = chip.getAttribute('data-collapsed-branches') || '';
    let names: string[] = [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        names = (parsed as unknown[]).filter(
          (n): n is string => typeof n === 'string' && n.length > 0
        );
      }
    } catch (err) {
      names = [];
    }
    if (names.length === 0) {
      return;
    }

    popup.innerHTML = '';
    names.forEach(function (name) {
      const row = document.createElement('div');
      row.className = 'context-menu-item';
      row.setAttribute('role', 'menuitem');
      row.setAttribute('tabindex', '0');
      row.setAttribute('data-branch-name', name);
      row.textContent = name;
      popup.appendChild(row);
    });

    const menuWidth = 220;
    const menuHeight = 400;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const left = clientX + menuWidth > viewportWidth ? viewportWidth - menuWidth - 10 : clientX;
    const top = clientY + menuHeight > viewportHeight ? viewportHeight - menuHeight - 10 : clientY;
    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
    popup.hidden = false;

    refPopupOpener = chip;
    chip.setAttribute('aria-expanded', 'true');
    const firstRow = popup.querySelector<HTMLElement>('.context-menu-item');
    if (firstRow && typeof firstRow.focus === 'function') {
      firstRow.focus();
    }
  }

  function selectRefRow(row: Element): void {
    const name = row.getAttribute('data-branch-name');
    if (name) {
      post({ type: 'branchClick', branchName: name });
    }
    closeRefPopup(true);
  }

  document.addEventListener('click', function (e) {
    const target = e.target instanceof Element ? e.target : null;
    const popup = document.getElementById('ref-popup');
    if (!popup) {
      return;
    }

    const chip = target
      ? target.closest<HTMLElement>('.branch-label-collapsed[data-collapsed-branches]')
      : null;
    if (chip) {
      openRefPopup(chip, (e as MouseEvent).clientX, (e as MouseEvent).clientY);
      return;
    }

    if (popup.hidden) {
      return;
    }

    const row = target ? target.closest('#ref-popup .context-menu-item') : null;
    if (row) {
      selectRefRow(row);
      return;
    }

    if (!popup.contains(target as Node)) {
      closeRefPopup(false);
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') {
      return;
    }
    const target = e.target instanceof Element ? e.target : null;
    const chip = target
      ? target.closest<HTMLElement>('.branch-label-collapsed[data-collapsed-branches]')
      : null;
    if (!chip) {
      return;
    }
    e.preventDefault();
    const rect = chip.getBoundingClientRect();
    openRefPopup(chip, rect.left, rect.bottom);
  });

  document.addEventListener('keydown', function (e) {
    const popup = document.getElementById('ref-popup');
    if (!popup || popup.hidden) {
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      closeRefPopup(true);
      return;
    }

    const target = e.target instanceof Element ? e.target : null;
    const row = target ? target.closest('#ref-popup .context-menu-item') : null;
    if (!row) {
      return;
    }

    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      selectRefRow(row);
      return;
    }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const rows = Array.from(popup.querySelectorAll<HTMLElement>('.context-menu-item'));
      const idx = rows.indexOf(row as HTMLElement);
      if (idx === -1) {
        return;
      }
      const nextIdx =
        e.key === 'ArrowDown' ? (idx + 1) % rows.length : (idx - 1 + rows.length) % rows.length;
      const next = rows[nextIdx];
      if (next && typeof next.focus === 'function') {
        next.focus();
      }
    }
  });

  // Delegate keyboard handling to focused commit rows.
  document.addEventListener('keydown', function (e) {
    const target = e.target instanceof Element ? e.target : null;
    const focused = target ? target.closest('.commit-row[data-hash]') : null;
    if (!focused) {
      return;
    }
    const hash = focused.getAttribute('data-hash');
    if (!hash) {
      return;
    }
    const handled =
      e.key === 'Enter' ||
      e.key === ' ' ||
      e.key === 'ArrowUp' ||
      e.key === 'ArrowDown' ||
      e.key === 'ArrowRight' ||
      e.key === 'ArrowLeft' ||
      e.key === 'ContextMenu' ||
      (e.key === 'c' && (e.ctrlKey || e.metaKey));
    if (handled) {
      handleCommitKeydown(e, hash);
    }
  });

  // Incremental commit loading.
  let loadMoreCommitsRequested = false;

  function setupGraphPanelScrollListener(): void {
    const graphPanel = document.querySelector<HTMLElement>('.graph-panel');
    if (!graphPanel) {
      return;
    }

    if (graphPanel.dataset.scrollListenerAttached === 'true') {
      return;
    }
    graphPanel.dataset.scrollListenerAttached = 'true';

    graphPanel.addEventListener('scroll', function () {
      const scrollTop = graphPanel.scrollTop;

      saveWebviewState(vscode, GRAPH_SCROLL_TOP_SLOT, scrollTop);

      if (loadMoreCommitsRequested) {
        return;
      }

      const scrollHeight = graphPanel.scrollHeight;
      const clientHeight = graphPanel.clientHeight;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

      const loadedCount = parseInt(graphPanel.getAttribute('data-loaded-count') || '0', 10);
      const totalAvailable = parseInt(graphPanel.getAttribute('data-total-available') || '0', 10);
      const hasMore = loadedCount < totalAvailable;

      if (hasMore && distanceFromBottom <= 50) {
        loadMoreCommitsRequested = true;
        post({ type: 'loadMoreCommits' });
      }
    });
  }

  window.addEventListener('message', function (event: MessageEvent) {
    const message = event.data as GitToolWindowOutbound | null;
    if (!message || typeof message !== 'object') {
      return;
    }
    if (message.type === 'commitsLoaded') {
      loadMoreCommitsRequested = false;
    }
  });

  setupGraphPanelScrollListener();

  const observer = new MutationObserver(function (): void {
    setupGraphPanelScrollListener();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // ─── Tab strip ───────────────────────────────────────────────────
  // Clicks on the tab strip post `tabChange`; the host re-renders with the
  // chosen tab active. No-ops when the tabbed layout is off (no strip).
  (function setupTabStrip(): void {
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
  })();

  // ─── Console tab behavior ────────────────────────────────────────
  // Clear drops the captured entries host-side. The log is bottom-pinned on
  // open and its offset persisted, because every git command re-renders the
  // whole document while this tab is active — without this the view snapped
  // back to the top on each one and never followed new output.
  (function setupConsoleTab(): void {
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

    const persisted = (vscode.getState() || {}) as { consoleScrollTop?: number };
    if (typeof persisted.consoleScrollTop === 'number') {
      log.scrollTop = persisted.consoleScrollTop;
    } else {
      // No remembered position: show the newest output.
      log.scrollTop = log.scrollHeight - log.clientHeight;
    }

    log.addEventListener('scroll', function () {
      const state = (vscode.getState() || {}) as Record<string, unknown>;
      state.consoleScrollTop = log.scrollTop;
      vscode.setState(state);
    });
  })();

  // ─── Incoming tab behavior ───────────────────────────────────────
  // Click selects a row, double-click routes to that commit in the Log tab —
  // the same gesture pair the History rows use. Delegated off the list so rows
  // re-rendered by `incoming.updateState` stay live. No-ops when the Incoming
  // tab isn't rendered.
  (function setupIncomingTab(): void {
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
  })();

  // ─── History tab behavior ────────────────────────────────────────
  // Binds the History tab's commit list, toolbar buttons, and dropdowns to the
  // tab-channel messages. No-ops when the History tab isn't rendered.
  (function setupHistoryTab(): void {
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
  })();

  // ─── Panel divider drag (graph ↔ details) ────────────────────────
  // Drag or arrow-key the `.panel-divider` to repartition the two panels; the
  // final percentages post as `panelResize` so they persist across renders.
  (function setupDividerDrag(): void {
    const layoutMaybe = document.querySelector<HTMLElement>('.three-panel-layout');
    if (!layoutMaybe) {
      return;
    }
    // Bind a non-null local: the hoisted `checkVerticalLayout` closure below
    // otherwise re-widens the guarded const back to `HTMLElement | null`.
    const layout: HTMLElement = layoutMaybe;
    const panels = layout.querySelectorAll<HTMLElement>('.panel');
    const dividers = layout.querySelectorAll<HTMLElement>('.panel-divider');
    let activeDivider: HTMLElement | null = null;
    let startX = 0;
    let startWidths: number[] = [];
    const MIN_PANEL_PX = 100;

    function checkVerticalLayout(): void {
      const width = layout.getBoundingClientRect().width;
      if (width < 500) {
        layout.classList.add('vertical-layout');
      } else {
        layout.classList.remove('vertical-layout');
      }
    }
    checkVerticalLayout();
    window.addEventListener('resize', checkVerticalLayout);
    if (typeof ResizeObserver !== 'undefined') {
      const resizeObserver = new ResizeObserver(function () {
        checkVerticalLayout();
      });
      resizeObserver.observe(layout);
    }

    function panelWidths(): [number, number] {
      const w = Array.from(panels).map(function (p) {
        return parseFloat(p.style.width) || 0;
      });
      return [w[0] ?? 0, w[1] ?? 0];
    }

    dividers.forEach(function (divider) {
      divider.addEventListener('mousedown', function (e) {
        e.preventDefault();
        activeDivider = divider;
        startX = e.clientX;
        startWidths = Array.from(panels).map(function (p) {
          return p.getBoundingClientRect().width;
        });
        document.body.classList.add('resizing');
        divider.classList.add('dragging');
      });

      divider.addEventListener('keydown', function (e) {
        const dividerIndex = parseInt(divider.getAttribute('data-divider') || '0', 10);
        const leftPanel = panels[dividerIndex];
        const rightPanel = panels[dividerIndex + 1];
        if (!leftPanel || !rightPanel) {
          return;
        }
        const step = 10;
        let delta = 0;
        switch (e.key) {
          case 'ArrowLeft':
            delta = -step;
            e.preventDefault();
            break;
          case 'ArrowRight':
            delta = step;
            e.preventDefault();
            break;
          default:
            return;
        }
        const leftWidth = leftPanel.getBoundingClientRect().width + delta;
        const rightWidth = rightPanel.getBoundingClientRect().width - delta;
        if (leftWidth >= MIN_PANEL_PX && rightWidth >= MIN_PANEL_PX) {
          const totalWidth = layout.getBoundingClientRect().width;
          leftPanel.style.width = (leftWidth / totalWidth) * 100 + '%';
          rightPanel.style.width = (rightWidth / totalWidth) * 100 + '%';
          post({ type: 'panelResize', widths: panelWidths() });
        }
      });
    });

    document.addEventListener('mousemove', function (e) {
      if (!activeDivider) {
        return;
      }
      const dividerIndex = parseInt(activeDivider.getAttribute('data-divider') || '0', 10);
      const delta = e.clientX - startX;
      const leftWidth = startWidths[dividerIndex] + delta;
      const rightWidth = startWidths[dividerIndex + 1] - delta;
      if (leftWidth >= MIN_PANEL_PX && rightWidth >= MIN_PANEL_PX) {
        const totalWidth = layout.getBoundingClientRect().width;
        panels[dividerIndex].style.width = (leftWidth / totalWidth) * 100 + '%';
        panels[dividerIndex + 1].style.width = (rightWidth / totalWidth) * 100 + '%';
      }
    });

    document.addEventListener('mouseup', function () {
      if (!activeDivider) {
        return;
      }
      document.body.classList.remove('resizing');
      activeDivider.classList.remove('dragging');
      activeDivider = null;
      post({ type: 'panelResize', widths: panelWidths() });
    });
  })();

  // ─── Log column resize (Author / Date) ───────────────────────────
  // Drag or arrow-key the `.log-column-resize-handle` to resize the fixed
  // Author/Date columns via the panel's CSS custom properties; the clamped
  // widths post as `columnResize` so they persist across renders.
  (function setupColumnResize(): void {
    const MIN_COL = 40;
    const MAX_COL = 600;
    const VAR_BY_COLUMN: Record<string, string> = {
      author: '--col-author-width',
      date: '--col-date-width',
    };

    function panelFor(el: Element): HTMLElement | null {
      return el.closest<HTMLElement>('.graph-panel');
    }
    function currentWidth(panel: HTMLElement, column: string): number {
      const raw = window.getComputedStyle(panel).getPropertyValue(VAR_BY_COLUMN[column]);
      const n = parseFloat(raw);
      return isFinite(n) ? n : column === 'author' ? 120 : 145;
    }
    function clamp(px: number): number {
      return Math.round(Math.min(MAX_COL, Math.max(MIN_COL, px)));
    }
    function applyAndPost(panel: HTMLElement, column: string, px: number): number {
      const clamped = clamp(px);
      panel.style.setProperty(VAR_BY_COLUMN[column], clamped + 'px');
      post({
        type: 'columnResize',
        widths: [currentWidth(panel, 'author'), currentWidth(panel, 'date')],
      });
      return clamped;
    }

    let active: HTMLElement | null = null;
    let activePanel: HTMLElement | null = null;
    let activeColumn: string | null = null;
    let startX = 0;
    let startWidth = 0;

    document.addEventListener('mousedown', function (e) {
      const target = e.target instanceof Element ? e.target : null;
      const handle = target ? target.closest<HTMLElement>('.log-column-resize-handle') : null;
      if (!handle) {
        return;
      }
      const panel = panelFor(handle);
      if (!panel) {
        return;
      }
      e.preventDefault();
      active = handle;
      activePanel = panel;
      activeColumn = handle.getAttribute('data-column-resize');
      startX = e.clientX;
      startWidth = currentWidth(panel, activeColumn || '');
      document.body.classList.add('resizing-column');
      handle.classList.add('dragging');
    });

    document.addEventListener('mousemove', function (e) {
      if (!active || !activePanel || activeColumn === null) {
        return;
      }
      const delta = e.clientX - startX;
      applyAndPost(activePanel, activeColumn, startWidth - delta);
    });

    document.addEventListener('mouseup', function () {
      if (!active) {
        return;
      }
      document.body.classList.remove('resizing-column');
      active.classList.remove('dragging');
      active = null;
      activePanel = null;
      activeColumn = null;
    });

    document.addEventListener('keydown', function (e) {
      const target = e.target instanceof Element ? e.target : null;
      const handle = target ? target.closest<HTMLElement>('.log-column-resize-handle') : null;
      if (!handle) {
        return;
      }
      let step = 0;
      if (e.key === 'ArrowLeft') {
        step = -10;
      } else if (e.key === 'ArrowRight') {
        step = 10;
      } else {
        return;
      }
      e.preventDefault();
      const panel = panelFor(handle);
      if (!panel) {
        return;
      }
      const column = handle.getAttribute('data-column-resize') || '';
      applyAndPost(panel, column, currentWidth(panel, column) + step);
    });
  })();

  // ─── Static-document action buttons ──────────────────────────────
  // The pre-graph documents (no-repository prompt, undocked placeholder) load
  // this same bundle so the whole tool window ships one client script; wire
  // their single action buttons here. No-ops when neither button is present.
  (function setupStaticButtons(): void {
    const initBtn = document.getElementById('init-repo-btn');
    if (initBtn) {
      initBtn.addEventListener('click', function () {
        post({ type: 'initRepository' });
      });
    }
    const focusBtn = document.getElementById('focus-undocked-panel');
    if (focusBtn) {
      focusBtn.addEventListener('click', function () {
        post({ type: 'focusUndockedPanel' });
      });
    }
  })();

  // Build the initial + History Details panels from the host-provided island.
  const island = readInitIsland();

  (function (): void {
    const dp = document.getElementById('details-panel');
    const initialModel = island.initialDetails;
    if (dp && initialModel) {
      dp.replaceChildren(buildDetailsPanelDom(initialModel));
    }
  })();

  (function (): void {
    const hdp = document.getElementById('history-details-panel');
    const historyModel = island.historyDetails;
    if (hdp && historyModel) {
      hdp.replaceChildren(buildDetailsPanelDom(historyModel));
    }
  })();
}

/** Read the host's init island, tolerating a missing/malformed payload. */
function readInitIsland(): IGitToolWindowInit {
  const el = document.getElementById(INIT_ELEMENT_ID);
  const raw = el ? el.getAttribute('data-init') : null;
  if (!raw) {
    return { initialDetails: null, historyDetails: null };
  }
  try {
    return parseInitIsland<IGitToolWindowInit>(raw);
  } catch (err) {
    return { initialDetails: null, historyDetails: null };
  }
}
