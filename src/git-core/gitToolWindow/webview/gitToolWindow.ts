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
import { buildDetailsPanelDom } from './detailsPanelDom';
import { setupLogFilterRow } from './logFilterRow';
import { applyFilterOptionsMessage } from './logFilterLists';
import {
  restoreFocusClaim,
  setupCommitRowFocusClaim,
  setupConsoleTab,
  setupHistoryTab,
  setupIncomingTab,
  setupTabStrip,
} from './tabs';
import { setupColumnResize, setupDividerDrag } from './panelLayout';
import { setupRefPopup } from './refPopup';
import {
  createSelectionState,
  cssEscapeHash,
  GRAPH_SCROLL_TOP_SLOT,
  setupLogSelection,
} from './logSelection';
import { setupCommitRowMenus } from './commitRowMenus';
import { INIT_ELEMENT_ID, parseInitIsland } from '../../../utils/webviewInit';
import { saveWebviewState } from '../../../utils/webviewStateSlot';

interface IVsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): unknown;
}

declare function acquireVsCodeApi(): IVsCodeApi;

/** The initial + History commit-details models the host bakes into the island. */
interface IGitToolWindowInit {
  initialDetails: DetailsPanelModel | null;
  historyDetails: DetailsPanelModel | null;
  /**
   * Whether this document replaced one the host re-rendered for a user gesture.
   * A focus claim persisted via `vscode.setState` outlives the window, so only
   * the host can say whether restoring it answers the user's own action or
   * yanks focus into a tool window they merely reopened.
   */
  restoreFocus?: boolean;
}

const vscodeApi: IVsCodeApi | undefined =
  typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;

if (vscodeApi) {
  main(vscodeApi);
}

function main(vscode: IVsCodeApi): void {
  function post(message: GitToolWindowInbound | GitToolWindowTabsInbound): void {
    vscode.postMessage(message);
  }

  // ─── Log filter row (IntelliJ VcsLogClassicFilterUi) ─────────────
  const filterBridge = setupLogFilterRow({ state: vscode, post: post });

  // ─── Multi-select webview state ──────────────────────────────────
  // One shared mutable object: the message handler below, the selection
  // core, and the row/menu module all read and write the same properties.
  const sel = createSelectionState();
  const selection = setupLogSelection(post, vscode, sel);
  const rowMenus = setupCommitRowMenus(post, sel, selection);

  // Handle state updates from the extension host.
  window.addEventListener('message', function (event: MessageEvent) {
    const message = event.data as GitToolWindowOutbound | null;
    if (!message || typeof message !== 'object') {
      return;
    }
    if (message.type === 'scrollToCommit' && message.commitHash) {
      selection.scrollToCommit(message.commitHash);
    }
    if (message.type === 'focusTextFilter') {
      // Select the current text too: the shortcut's job is to start a new
      // query, so typing should replace what's there rather than append.
      const input = document.getElementById('filter-search') as HTMLInputElement | null;
      if (input) {
        input.focus();
        input.select();
      }
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
        // Only the changed-file menu: it remembers the commit and path it was
        // opened on, and both are about to be replaced. Closing every menu here
        // would dismiss the commit menu the user just opened — selecting an
        // unselected commit posts this in the same tick.
        rowMenus.hideChangedFileMenu();
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
        selection.scrollRowIntoViewIfNeeded(targetRow);
      }
      selection.refreshSelectedCount();
    }
    if (message.type === 'updateMenuEnableState' && message.state) {
      sel.menuEnableMap = message.state as typeof sel.menuEnableMap;
      rowMenus.applyMenuEnableMap();
    }
    if (message.type === 'syncSelection') {
      // The selection an open commit menu was built for no longer holds.
      rowMenus.dropStaleCommitMenu();
      sel.anchorHash =
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
      selection.refreshSelectedCount();
    }
    applyFilterOptionsMessage(message, function () {
      return filterBridge;
    });
    if (message.type === 'updateBranchFocus') {
      sel.branchFocus = {
        focusedBranchName:
          typeof message.focusedBranchName === 'string' ? message.focusedBranchName : null,
        focusedHash: typeof message.focusedHash === 'string' ? message.focusedHash : null,
      };
      const focusedName = sel.branchFocus.focusedBranchName;
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

  // ─── Collapsed-ref popup (branch label "+N" chip) ────────────────
  setupRefPopup(post);

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
      rowMenus.handleCommitKeydown(e, hash);
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
  setupTabStrip(vscode, post);

  setupCommitRowFocusClaim(vscode);

  restoreFocusClaim(vscode, readInitIsland().restoreFocus === true);

  // ─── Console tab behavior ────────────────────────────────────────
  setupConsoleTab(vscode, post);

  // ─── Incoming tab behavior ───────────────────────────────────────
  setupIncomingTab(post);

  // ─── History tab behavior ────────────────────────────────────────
  setupHistoryTab(post);

  // ─── Panel divider drag (graph ↔ details) ────────────────────────
  setupDividerDrag(post);

  // ─── Log column resize (Author / Date) ───────────────────────────
  setupColumnResize(post);

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
