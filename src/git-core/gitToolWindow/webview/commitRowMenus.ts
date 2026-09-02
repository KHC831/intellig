/// <reference lib="dom" />
/**
 * Commit-row and details-panel interaction for the Git tool window webview:
 * row click/double-click/context-menu delegation, the fixup!/squash! jump
 * link, the details-panel file actions, the commit keyboard pattern, and the
 * commit context menu (positioning + the host-computed enable map). Extracted
 * verbatim from the entry; shares {@link ISelectionState} with the entry's
 * message handler and drives the selection core through {@link ILogSelection}.
 */

import type { GitToolWindowInbound } from '../gitToolWindow.protocol';
import type { GitToolWindowTabsInbound } from '../gitToolWindowTabs.protocol';
import { ContextMenu, hideAllContextMenus } from '../../../webview-common/contextMenu';
import {
  COMMIT_MENU,
  COMMIT_MENU_ITEMS,
  FILE_MENU,
  FILE_MENU_ITEMS,
  HISTORY_MENU,
  HISTORY_MENU_ITEMS,
} from './menuDefinitions';
import { cssEscapeHash, type ILogSelection, type ISelectionState } from './logSelection';

type PostLog = (message: GitToolWindowInbound | GitToolWindowTabsInbound) => void;

/** The keyboard hook the entry's delegated keydown listener drives. */
export interface ICommitRowMenus {
  handleCommitKeydown: (event: KeyboardEvent, hash: string) => void;
  /**
   * Drop an open commit menu because the selection changed underneath it.
   *
   * The hashes a pick acts on are captured when the menu OPENS. A host-pushed
   * selection change leaves the menu showing, still holding the old set — so a
   * Drop Commit picked afterwards would act on commits that are no longer
   * selected, with a different row highlighted.
   */
  dropStaleCommitMenu: () => void;
  applyMenuEnableMap: () => void;
  /**
   * Close the changed-file menu, before the rows it points at are rebuilt.
   *
   * Named for the menu rather than the panel because it serves BOTH details
   * panels: the file-row selector is not scoped to `#details-panel`, and
   * buildDetailsPanelDom builds the History tab's panel too. Only the Log tab
   * rebuilds incrementally today, so only it has to call this — but a future
   * incremental History update needs the same call.
   */
  hideChangedFileMenu: () => void;
}

export function setupCommitRowMenus(
  post: PostLog,
  sel: ISelectionState,
  selection: ILogSelection
): ICommitRowMenus {
  // ─── The three menus ─────────────────────────────────────────────
  // Their rows are fixed, so they render once here; only the enable map and
  // the pointer position change between openings.
  const commitMenu = new ContextMenu({ ...COMMIT_MENU, onPick: pickCommitAction });
  const fileMenu = new ContextMenu({ ...FILE_MENU, onPick: pickFileAction });
  const historyMenu = new ContextMenu({ ...HISTORY_MENU, onPick: pickHistoryAction });
  commitMenu.render(COMMIT_MENU_ITEMS);
  fileMenu.render(FILE_MENU_ITEMS);
  historyMenu.render(HISTORY_MENU_ITEMS);

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
          post({ type: 'addRangeSelectCommit', commitHash: hash, anchorHash: sel.anchorHash });
          selection.applyRangeSelectionDom(hash, true);
        } else if (me.shiftKey) {
          post({ type: 'rangeSelectCommit', commitHash: hash, anchorHash: sel.anchorHash });
          selection.applyRangeSelectionDom(hash, false);
        } else if (me.ctrlKey || me.metaKey) {
          post({ type: 'toggleCommitSelection', commitHash: hash });
          commitRow.classList.toggle('selected');
          const isNowSelected = commitRow.classList.contains('selected');
          commitRow.setAttribute('aria-selected', String(isNowSelected));
          sel.anchorHash = hash;
          selection.refreshSelectedCount();
        } else {
          post({ type: 'selectCommit', commitHash: hash });
          document.querySelectorAll('.commit-row.selected').forEach(function (r) {
            r.classList.remove('selected');
            r.setAttribute('aria-selected', 'false');
          });
          commitRow.classList.add('selected');
          commitRow.setAttribute('aria-selected', 'true');
          sel.anchorHash = hash;
          selection.refreshSelectedCount();
        }
      }
    }
  });

  document.addEventListener('contextmenu', function (e) {
    const target = e.target instanceof Element ? e.target : null;
    // Goes through the widget registry rather than this module's three
    // menus by name, so the ref popup and the navigation popup — owned by
    // other modules — close too instead of staying painted underneath.
    hideAllContextMenus();
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
      if (commitHash && path) {
        e.preventDefault();
        e.stopPropagation();
        fileContextTarget = { commitHash: commitHash, path: path };
        showAtPointer(fileMenu, e as MouseEvent);
      }
      return;
    }
    const historyRow = target ? target.closest('.history-commit-row[data-rev]') : null;
    if (historyRow) {
      const rev = historyRow.getAttribute('data-rev');
      if (rev) {
        e.preventDefault();
        e.stopPropagation();
        historyContextRev = rev;
        showAtPointer(historyMenu, e as MouseEvent);
      }
    }
  });

  // Details-panel file context menu → fileContextAction relay; History-tab
  // revision context menu → history.compareWith* relay.
  let fileContextTarget: { commitHash: string; path: string } | null = null;
  let historyContextRev: string | null = null;

  function pickFileAction(action: string): void {
    if (!fileContextTarget) {
      return;
    }
    post({
      type: 'fileContextAction',
      action: action,
      commitHash: fileContextTarget.commitHash,
      path: fileContextTarget.path,
    });
  }

  function pickHistoryAction(action: string): void {
    if (!historyContextRev) {
      return;
    }
    if (action === 'compareWithHead') {
      post({ type: 'history.compareWithHead', rev: historyContextRev });
    } else if (action === 'compareWithRef') {
      post({ type: 'history.compareWithRef', rev: historyContextRev });
    }
  }

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
    const groupByBtn = target ? target.closest('.details-groupby-toggle[data-groupby]') : null;
    if (groupByBtn) {
      const mode = groupByBtn.getAttribute('data-groupby');
      if (mode === 'tree' || mode === 'flat') {
        post({ type: 'setDetailsGroupBy', groupBy: mode });
      }
      return;
    }
    // A hash referenced in the commit message: same jump as a parent hash.
    const messageHash = target ? target.closest('.commit-hash-link[data-commit-hash]') : null;
    if (messageHash) {
      const hash = messageHash.getAttribute('data-commit-hash');
      if (hash) {
        post({ type: 'selectCommit', commitHash: hash, viaHashLink: true });
      }
      return;
    }
    const parentHash = target ? target.closest('.parent-hash[data-parent-hash]') : null;
    if (parentHash) {
      const hash = parentHash.getAttribute('data-parent-hash');
      if (hash) {
        if (parentHash.closest('#history-details-panel')) {
          const rowSel = '.history-commit-row[data-rev="' + cssEscapeHash(hash) + '"]';
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
          sel.anchorHash = hash;
          selection.refreshSelectedCount();
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
          sel.anchorHash = hash;
          selection.refreshSelectedCount();
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
          post({
            type: 'addRangeSelectCommit',
            commitHash: targetHash,
            anchorHash: sel.anchorHash,
          });
          selection.applyRangeSelectionDom(targetHash, true);
        } else if (event.shiftKey) {
          post({ type: 'rangeSelectCommit', commitHash: targetHash, anchorHash: sel.anchorHash });
          selection.applyRangeSelectionDom(targetHash, false);
        } else {
          post({ type: 'selectCommit', commitHash: targetHash });
          document.querySelectorAll('.commit-row.selected').forEach(function (r) {
            r.classList.remove('selected');
            r.setAttribute('aria-selected', 'false');
          });
          targetRow.classList.add('selected');
          targetRow.setAttribute('aria-selected', 'true');
          sel.anchorHash = targetHash;
          selection.refreshSelectedCount();
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
          selection.jumpToCommitHash(parents[0]);
        } else {
          const rect = currentRow.getBoundingClientRect();
          selection.openNavigationPopup(
            parents,
            rect.right,
            rect.top,
            selection.jumpToCommitHash,
            currentRow as HTMLElement
          );
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
          selection.jumpToCommitHash(childrenL[0]);
        } else {
          const currentRowL = document.querySelector(
            '.commit-row[data-hash="' + cssEscapeHash(hash) + '"]'
          );
          const rect = currentRowL
            ? currentRowL.getBoundingClientRect()
            : ({ right: 0, top: 0 } as DOMRect);
          selection.openNavigationPopup(
            childrenL,
            rect.right,
            rect.top,
            selection.jumpToCommitHash,
            (currentRowL as HTMLElement) ?? undefined
          );
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
      sel.anchorHash = hash;
      selection.refreshSelectedCount();
      commitContextMenuHashes = [hash];
      // The map in hand was computed for the selection this click just
      // replaced, and would gate the rows by it for the round-trip it takes
      // the host to answer. Dropping it falls the rows back to their declared
      // state, which is the single-selection default and so is right for the
      // one commit now selected. Deliberately NOT done when a right-click
      // lands inside a selection painted here (a shift-click range). The map
      // is then wrong in one direction only: it still hides the multi-only
      // rows, which declare themselves hidden anyway, whereas dropping it
      // would ALSO re-enable a row the map disables for a repo-state reason no
      // declared state can express, such as a rewrite blocked by a merge commit
      // in the range. That window is covered where the rules actually live, in
      // the host's own re-check before it acts.
      sel.menuEnableMap = null;
    } else if (selectedHashes.length > 1) {
      commitContextMenuHashes = selectedHashes;
    } else {
      commitContextMenuHashes = [hash];
    }

    // Always ask the host to recompute for this selection. Without it, a menu
    // opened on an ALREADY-selected commit posts nothing, so after a re-render
    // (which resets the map but restores the .selected rows) no map ever
    // arrives and the rows stay at their declared state for good.
    post({ type: 'selectIfNotSelected', commitHash: hash });
    applyMenuEnableMap();
    showAtPointer(commitMenu, event as MouseEvent);
  }

  /**
   * Open `menu` where the gesture landed. A keyboard ContextMenu press has no
   * pointer, and its synthesized event reports 0,0 — the menu then opens in the
   * top-left corner, which is where it belongs for a keyboard user anyway.
   *
   * The row that was clicked becomes the menu's opener, so dismissing hands
   * focus back to it rather than dropping it on <body>.
   */
  function showAtPointer(menu: ContextMenu, event: MouseEvent): void {
    const opener = event.target instanceof Element ? event.target.closest('[tabindex]') : null;
    menu.showAt(
      event.clientX || 0,
      event.clientY || 0,
      (opener as HTMLElement) ?? undefined,
      event
    );
  }

  /**
   * Push the host's per-selection gating onto the commit menu's rows. The
   * widget owns how a row is greyed so the class, aria-disabled and tabindex
   * cannot drift apart, and so a null map falls back to each row's declared
   * state rather than to "everything allowed".
   */
  function applyMenuEnableMap(): void {
    commitMenu.applyStates(sel.menuEnableMap);
  }

  /** Jump to the single parent/child, or offer the choice when there are several. */
  function navigateFrom(action: string, event: MouseEvent): void {
    const hash = commitContextMenuHashes[0];
    if (!hash) {
      return;
    }
    let hashes: string[];
    if (action === 'goToParent') {
      const row = document.querySelector('.commit-row[data-hash="' + cssEscapeHash(hash) + '"]');
      if (!row) {
        return;
      }
      hashes = (row.getAttribute('data-parents') || '').split(',').filter(function (h) {
        return h.length > 0;
      });
    } else {
      hashes = Array.from(document.querySelectorAll('.commit-row[data-hash]'))
        .filter(function (r) {
          return (r.getAttribute('data-parents') || '').split(',').indexOf(hash) !== -1;
        })
        .map(function (r) {
          return r.getAttribute('data-hash') as string;
        });
    }
    if (hashes.length === 0) {
      return;
    }
    if (hashes.length === 1) {
      selection.jumpToCommitHash(hashes[0]);
      return;
    }
    // The row the menu was opened on, not the menu row that was clicked: the
    // menu is already closing, so focus has to come back to the graph.
    const opener = document.querySelector<HTMLElement>(
      '.commit-row[data-hash="' + cssEscapeHash(hash) + '"]'
    );
    selection.openNavigationPopup(
      hashes,
      event.clientX,
      event.clientY,
      selection.jumpToCommitHash,
      opener ?? undefined
    );
  }

  /** The hashes the graph currently shows as selected. */
  function renderedSelection(): string[] {
    return Array.from(document.querySelectorAll('.graph-panel .commit-row.selected'))
      .map((row) => row.getAttribute('data-hash') || '')
      .filter((hash) => hash.length > 0)
      .sort(); // ref-sort-exempt: commit hashes, compared for set equality below
  }

  function pickCommitAction(action: string, event: MouseEvent): void {
    if (commitContextMenuHashes.length === 0) {
      return;
    }
    // The hashes were captured when the menu opened. Anything that rewrites the
    // rendered selection while it is up — syncSelection, selectGraphRow, or a
    // message not yet written — leaves the menu describing commits that are no
    // longer the ones selected, and a Drop Commit would act on them. Comparing
    // here covers the whole class, so which messages move the selection stops
    // being something a future author has to enumerate correctly.
    const live = renderedSelection();
    const captured = commitContextMenuHashes.slice().sort(); // ref-sort-exempt: commit hashes
    if (live.length !== captured.length || live.some((hash, i) => hash !== captured[i])) {
      return;
    }
    // Both navigation entries are answered in the webview: the rows are
    // already here, so the host would only be asked to send them back.
    if (action === 'goToParent' || action === 'goToChild') {
      navigateFrom(action, event);
      return;
    }
    post({ type: 'commitContextMenu', action: action, commitHashes: commitContextMenuHashes });
  }

  // Click-away, Escape and losing the window all dismiss whichever menu is up.
  document.addEventListener('click', function (e) {
    const target = e.target instanceof Element ? e.target : null;
    // The widget decides what counts as "inside": every box has a few pixels of
    // padding that belong to it but sit on no row, and naming the menus here
    // let that strip read as a click away. It also spares the control that
    // opened a menu, so this listener cannot close, in the same click, a popup
    // another listener just put up.
    hideAllContextMenus(target, e);
  });

  window.addEventListener('blur', function () {
    hideAllContextMenus();
  });

  return {
    handleCommitKeydown: handleCommitKeydown,
    applyMenuEnableMap: applyMenuEnableMap,
    dropStaleCommitMenu: (): void => {
      commitMenu.hide();
      commitContextMenuHashes = [];
    },
    hideChangedFileMenu: (): void => {
      fileMenu.hide();
      fileContextTarget = null;
    },
  };
}
