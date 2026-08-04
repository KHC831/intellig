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
import { cssEscapeHash, type ILogSelection, type ISelectionState } from './logSelection';

type PostLog = (message: GitToolWindowInbound | GitToolWindowTabsInbound) => void;

/** The keyboard hook the entry's delegated keydown listener drives. */
export interface ICommitRowMenus {
  handleCommitKeydown: (event: KeyboardEvent, hash: string) => void;
  applyMenuEnableMap: (contextMenu: HTMLElement) => void;
}

export function setupCommitRowMenus(
  post: PostLog,
  sel: ISelectionState,
  selection: ILogSelection
): ICommitRowMenus {
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
          selection.openNavigationPopup(parents, rect.right, rect.top, selection.jumpToCommitHash);
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
            selection.jumpToCommitHash
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
    const map = sel.menuEnableMap;
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
              selection.jumpToCommitHash(parents[0]);
            } else {
              selection.openNavigationPopup(
                parents,
                (e as MouseEvent).clientX,
                (e as MouseEvent).clientY,
                selection.jumpToCommitHash
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
              selection.jumpToCommitHash(children[0]);
            } else {
              selection.openNavigationPopup(
                children,
                (e as MouseEvent).clientX,
                (e as MouseEvent).clientY,
                selection.jumpToCommitHash
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

  return {
    handleCommitKeydown: handleCommitKeydown,
    applyMenuEnableMap: applyMenuEnableMap,
  };
}
