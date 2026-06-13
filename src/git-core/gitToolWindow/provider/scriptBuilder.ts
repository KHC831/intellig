/**
 * Builds the inline `<script>` source for the Git tool window webview.
 *
 * Returns a self-contained IIFE (as a template string) that runs in the
 * webview: it acquires the single `vscode` API handle, wires the repository
 * selector, commit-row selection + range selection, the menu enable-map,
 * anchor restoration, scroll-to-commit, and the load-more / graph-scroll
 * observers. The string is fully static — it interpolates no host state and
 * carries no color literals — so it is assembled here, independent of the
 * provider instance, and injected verbatim into the rendered HTML.
 *
 * NOTE on the trigger to externalise: when the inline-script function count
 * crosses 5 non-trivial functions, or the first inline-script function needs
 * async data flow, move these functions to a separate `.js` resource served
 * via `webview.asWebviewUri`. Current count is 5 (`applyMenuEnableMap`,
 * `applyRangeSelectionDom`, `refreshSelectedCount`, `readInitialAnchor`,
 * `scrollToCommit`); the threshold is imminent.
 */
export function buildInlineScript(): string {
  return `
      (function() {
        const vscode = acquireVsCodeApi();

        // Repository selector wiring. Posts the selectRepository message
        // through the single \`vscode\` instance acquired above. The
        // dropdown intentionally has no inline onchange handler — calling
        // \`acquireVsCodeApi()\` a second time in the same render throws
        // a DOMException and the message would be silently dropped.
        const repoSelect = document.querySelector('.repository-selector');
        if (repoSelect) {
          repoSelect.addEventListener('change', function(e) {
            const target = e.target;
            if (!target) return;
            const value = Number(target.value);
            if (!Number.isFinite(value)) return;
            vscode.postMessage({
              type: 'selectRepository',
              repositoryIndex: value,
            });
          });
        }

        // State for drag and drop
        let draggedFiles = [];
        let contextMenuTarget = null;

        // Multi-select webview state.
        //
        // The HOST is the source of truth for menu visibility/enable
        // state (ADR-009). The webview keeps a tiny mirror of:
        //   - anchorHash    — for immediate range-selection DOM updates
        //                     before the host's response round-trips back
        //   - menuEnableMap — most-recent updateMenuEnableState payload
        //
        // anchorHash is rehydrated from the rendered \`data-anchor-hash\`
        // attribute on script execution, and again on every
        // \`syncSelection\` message (sent by the host after updateLogState
        // prunes a stale anchor).
        let anchorHash = (function readInitialAnchor() {
          const gp = document.querySelector('.graph-panel[data-anchor-hash]');
          if (!gp) return null;
          const v = gp.getAttribute('data-anchor-hash') || '';
          return v.length > 0 ? v : null;
        })();

        // Most-recent enable map posted by the host. Populated on every
        // \`updateMenuEnableState\` message; consumed by
        // \`applyMenuEnableMap\` when the menu opens.
        let menuEnableMap = null;

        // Most-recent branch-focus payload from the host.
        // focusedBranchName toggles the branch-label-focused class on
        // chips matching data-branch-name. null means no focus.
        let branchFocus = null;

        // Reflect \`selectedCommits.size\` onto the graph-panel root's
        // \`data-selected-count\` attribute AND the multi-commit details
        // panel's data-selected-count. Cheap enough to call on
        // every selection change since the graph panel is bounded by the
        // virtualization window.
        function refreshSelectedCount() {
          const graphPanel = document.querySelector('.graph-panel[aria-multiselectable]');
          if (graphPanel) {
            const selected = graphPanel.querySelectorAll('.commit-row.selected');
            graphPanel.setAttribute('data-selected-count', String(selected.length));
            // Mirror onto the details panel root so CSS / test hooks that
            // bind to .multi-commit-details[data-selected-count] also stay
            // in sync.
            const multiDetails = document.querySelector('.multi-commit-details');
            if (multiDetails) {
              multiDetails.setAttribute('data-selected-count', String(selected.length));
            }
          }
        }

        // Apply shift-click DOM mutations: replace (or extend) the
        // \`.selected\` class on rows in the inclusive range from
        // \`anchorHash\` to \`clickHash\`, in display order. Falls back to
        // single-select when the anchor isn't in the rendered DOM
        // (virtualization edge case).
        function applyRangeSelectionDom(clickHash, additive) {
          const rows = Array.from(document.querySelectorAll('.graph-panel .commit-row[data-hash]'));
          const allHashes = rows.map(function(r) { return r.getAttribute('data-hash'); });
          const clickIdx = allHashes.indexOf(clickHash);
          if (clickIdx === -1) {
            return;
          }
          if (anchorHash === null || allHashes.indexOf(anchorHash) === -1) {
            // Anchor-null / virtualized-out fallback → behave as plain-click.
            rows.forEach(function(r) {
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
            rows.forEach(function(r) {
              r.classList.remove('selected');
              r.setAttribute('aria-selected', 'false');
            });
          }
          for (let i = lo; i <= hi; i++) {
            rows[i].classList.add('selected');
            rows[i].setAttribute('aria-selected', 'true');
          }
          refreshSelectedCount();
          // Anchor unchanged — IntelliJ semantics.
        }

        // Handle state updates from extension
        window.addEventListener('message', event => {
          const message = event.data;
          if (message.type === 'scrollToCommit' && message.commitHash) {
            scrollToCommit(message.commitHash);
          }
          if (message.type === 'updateDetailsPanel' && message.html) {
            const detailsPanel = document.getElementById('details-panel');
            if (detailsPanel) {
              detailsPanel.innerHTML = message.html;
            }
          }
          if (message.type === 'selectGraphRow' && message.commitHash) {
            // Update graph row selection highlighting
            document.querySelectorAll('.commit-row.selected').forEach(function(r) {
              r.classList.remove('selected');
              r.setAttribute('aria-selected', 'false');
            });
            const targetRow = document.querySelector('.commit-row[data-hash="' + message.commitHash + '"]');
            if (targetRow) {
              targetRow.classList.add('selected');
              targetRow.setAttribute('aria-selected', 'true');
              targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            refreshSelectedCount();
          }
          // Host pushes the precomputed menu state (visibility +
          // enable per action) so the JS just stores it. The apply happens
          // when the menu opens, against the cached map. Source of truth is
          // the host; ADR-009.
          if (message.type === 'updateMenuEnableState' && message.state) {
            menuEnableMap = message.state;
            // If the menu is currently open, re-apply immediately so a
            // selection change made via keyboard / programmatic call
            // refreshes the visible items live.
            const openMenu = document.getElementById('commit-context-menu');
            if (openMenu && !openMenu.hidden) {
              applyMenuEnableMap(openMenu);
            }
          }
          // Host re-syncs the JS anchor mirror after a
          // selection or commit-list change that may have invalidated it.
          if (message.type === 'syncSelection') {
            anchorHash = typeof message.anchorHash === 'string' && message.anchorHash.length > 0
              ? message.anchorHash
              : null;
            // Reflect host-side selection onto the DOM as well.
            const wantSelected = new Set(Array.isArray(message.selectedHashes)
              ? message.selectedHashes
              : []);
            document.querySelectorAll('.graph-panel .commit-row[data-hash]').forEach(function(r) {
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
          // Partial-update path for branch focus. The
          // render-time \`_getBranchLabelsHtml\` is the source of truth;
          // this handler exists so the chip outline lands without a full
          // DOM rebuild. Toggles \`branch-label-focused\` on every chip
          // matching \`data-branch-name\`. The selector covers all three
          // branch-chip kinds — local, remote, AND the current-branch
          // chip (.branch-label-head). The current branch can also be the
          // focused branch (focusedBranchName and headBranchName are
          // independent), so the head chip must participate in the
          // focus toggle or its outline would go stale on a re-render-less
          // focus change.
          if (message.type === 'updateBranchFocus') {
            branchFocus = {
              focusedBranchName: typeof message.focusedBranchName === 'string' ? message.focusedBranchName : null,
              focusedHash: typeof message.focusedHash === 'string' ? message.focusedHash : null,
            };
            const focusedName = branchFocus.focusedBranchName;
            document.querySelectorAll('.branch-label-local[data-branch-name], .branch-label-remote[data-branch-name], .branch-label-head[data-branch-name]').forEach(function(chip) {
              const name = chip.getAttribute('data-branch-name');
              if (focusedName !== null && name === focusedName) {
                chip.classList.add('branch-label-focused');
              } else {
                chip.classList.remove('branch-label-focused');
              }
            });
          }
        });

        function scrollToCommit(commitHash) {
          const commitRow = document.querySelector('[data-hash="' + commitHash + '"]');
          if (!commitRow) { return; }                       // not in DOM: no action

          const panel = commitRow.closest('.graph-panel');
          if (panel) {
            const rowTop = commitRow.offsetTop;
            const rowBottom = rowTop + commitRow.offsetHeight;
            const viewportTop = panel.scrollTop;
            const viewportBottom = viewportTop + panel.clientHeight;
            // Mirror of shouldScrollToRow (scrollVisibility.ts) — ephemeral UI affordance (ADR-009 §2).
            const fullyVisible = rowTop >= viewportTop && rowBottom <= viewportBottom;
            if (!fullyVisible) {
              // Off-screen: smooth-glide from the CURRENT scroll position to the target.
              commitRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          } else {
            commitRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }

          // Highlight always applies (D4) — visual confirmation regardless of scroll.
          commitRow.classList.add('highlight-scroll');
          setTimeout(function () { commitRow.classList.remove('highlight-scroll'); }, 2000);
        }

        // Auto-scroll to commit on page load when data-scroll-to-commit is set.
        // This handles the case where _updateWebview() fully replaces the DOM
        // (e.g., after a branch click), so a postMessage would arrive too late.
        (function autoScrollOnLoad() {
          const graphPanel = document.querySelector('.graph-panel[data-scroll-to-commit]');
          if (graphPanel) {
            const targetHash = graphPanel.getAttribute('data-scroll-to-commit');
            if (targetHash) {
              scrollToCommit(targetHash);
            }
          }
        })();

        // ─── Empty-state action buttons ──────────────────────────────────
        // The filtered-empty graph state renders a "Clear filter" button
        // (data-action="clearLogFilter"). Route it to the host. Uses the
        // single shared vscode API instance (see L8 invariant) — never
        // re-acquires.
        document.addEventListener('click', function(e) {
          const emptyAction = e.target.closest('.graph-empty-action[data-action]');
          if (emptyAction) {
            const action = emptyAction.getAttribute('data-action');
            if (action === 'clearLogFilter') {
              vscode.postMessage({ type: 'clearLogFilter' });
            }
          }
        });

        // ─── Event delegation for commit rows ────────────────────────────

        // Commit row click → handleCommitClick
        document.addEventListener('click', function(e) {
          const commitRow = e.target.closest('.commit-row[data-hash]');
          if (commitRow) {
            // Don't handle if click was on a context menu or inside details panel
            if (e.target.closest('.context-menu') || e.target.closest('.details-panel')) {
              return;
            }
            const hash = commitRow.getAttribute('data-hash');
            if (hash) {
              // Selection key combos:
              //   Ctrl/Cmd        → toggle (existing) + move anchor
              //   Shift           → range-replace
              //   Shift+Ctrl/Cmd  → range-add
              //   plain           → single-select + set anchor
              if (e.shiftKey && (e.ctrlKey || e.metaKey)) {
                // Message anchor wins; the host treats the
                // JS-side anchor as authoritative for THIS click.
                vscode.postMessage({
                  type: 'addRangeSelectCommit',
                  commitHash: hash,
                  anchorHash: anchorHash,
                });
                applyRangeSelectionDom(hash, /* additive */ true);
              } else if (e.shiftKey) {
                vscode.postMessage({
                  type: 'rangeSelectCommit',
                  commitHash: hash,
                  anchorHash: anchorHash,
                });
                applyRangeSelectionDom(hash, /* additive */ false);
              } else if (e.ctrlKey || e.metaKey) {
                vscode.postMessage({ type: 'toggleCommitSelection', commitHash: hash });
                commitRow.classList.toggle('selected');
                var isNowSelected = commitRow.classList.contains('selected');
                commitRow.setAttribute('aria-selected', String(isNowSelected));
                anchorHash = hash;
                refreshSelectedCount();
              } else {
                vscode.postMessage({ type: 'selectCommit', commitHash: hash });
                document.querySelectorAll('.commit-row.selected').forEach(function(r) {
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

        // Commit row right-click → showCommitContextMenu
        document.addEventListener('contextmenu', function(e) {
          const commitRow = e.target.closest('.commit-row[data-hash]');
          if (commitRow) {
            const hash = commitRow.getAttribute('data-hash');
            if (hash) {
              e.preventDefault();
              e.stopPropagation();
              showCommitContextMenu(e, hash);
            }
          }
        });

        // ─── Event delegation for details panel ──────────────────────────

        // Parent hash click → selectCommit
        document.addEventListener('click', function(e) {
          const parentHash = e.target.closest('.parent-hash[data-parent-hash]');
          if (parentHash) {
            const hash = parentHash.getAttribute('data-parent-hash');
            if (hash) {
              vscode.postMessage({ type: 'selectCommit', commitHash: hash });
            }
          }
        });

        // Hash value click → copy to clipboard
        document.addEventListener('click', function(e) {
          const hashValue = e.target.closest('.hash-value[data-copy-text]');
          if (hashValue) {
            const text = hashValue.getAttribute('data-copy-text');
            if (text) {
              navigator.clipboard.writeText(text).catch(function(_err) {
                // Clipboard writes can fail when the document loses focus
                // mid-call. The hash value remains visible on the chip;
                // the user can re-click to retry. Failure is intentionally
                // silent here — host-side logger isn't reachable from the
                // webview script.
              });
            }
          }
        });

        // Changed file double-click → open diff
        document.addEventListener('dblclick', function(e) {
          const fileItem = e.target.closest('.changed-file-item[data-path][data-commit-hash]');
          if (fileItem) {
            const commitHash = fileItem.getAttribute('data-commit-hash');
            const path = fileItem.getAttribute('data-path');
            if (commitHash && path) {
              vscode.postMessage({ type: 'doubleClickFile', commitHash: commitHash, path: path });
            }
          }
        });

        // Changed Files directory tree collapse/expand (IntelliJ-style).
        // Toggling a directory row flips the visibility of the
        // .changed-dir-children container it controls, the chevron glyph, and
        // aria-expanded. Pure DOM toggle with no persistence: a re-render (new
        // commit selection) resets every directory to expanded.
        function toggleChangedDir(dirItem) {
          const containerId = dirItem.getAttribute('aria-controls');
          if (!containerId) return;
          const container = document.getElementById(containerId);
          if (!container) return;
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

        // Click anywhere on a directory row — its chevron OR its name —
        // toggles it. Scoped to .changed-dir-item so it never fires for
        // .changed-file-item rows (whose dblclick opens the diff); the chevron
        // has no data-path so the file-open delegation can't match it either.
        document.addEventListener('click', function(e) {
          const dirItem = e.target.closest('.changed-dir-item[aria-controls]');
          if (dirItem) {
            toggleChangedDir(dirItem);
          }
        });

        // Keyboard operability for the focusable directory rows (tabindex=0):
        // Enter and Space toggle the focused row, matching the click path.
        // preventDefault on Space stops the row from scrolling the panel.
        document.addEventListener('keydown', function(e) {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          const dirItem = e.target && e.target.closest
            ? e.target.closest('.changed-dir-item[aria-controls]')
            : null;
          if (!dirItem) return;
          e.preventDefault();
          toggleChangedDir(dirItem);
        });

        // Hide context menu when clicking elsewhere
        document.addEventListener('click', (e) => {
          const contextMenu = document.getElementById('context-menu');
          if (contextMenu && !contextMenu.contains(e.target)) {
            contextMenu.hidden = true;
          }
        });

        // Handle context menu item clicks
        document.addEventListener('click', (e) => {
          const menuItem = e.target.closest('.context-menu-item');
          if (menuItem && contextMenuTarget) {
            const action = menuItem.dataset.action;
            if (action) {
              vscode.postMessage({
                type: 'contextAction',
                action: action,
                files: [contextMenuTarget]
              });
              document.getElementById('context-menu').hidden = true;
            }
          }
        });

        // Global functions for onclick handlers
        window.toggleChangelist = function(changelistId) {
          vscode.postMessage({ type: 'toggleChangelist', changelistId });
        };

        window.selectFile = function(path) {
          vscode.postMessage({ type: 'selectFile', path });
        };

        window.doubleClickFile = function(path) {
          vscode.postMessage({ type: 'doubleClickFile', path });
        };

        window.clearConsole = function() {
          vscode.postMessage({ type: 'clearConsole' });
        };

        window.initRepository = function() {
          vscode.postMessage({ type: 'initRepository' });
        };

        window.refreshLocalChanges = function() {
          vscode.postMessage({ type: 'refresh' });
        };

        window.refreshLog = function() {
          vscode.postMessage({ type: 'refresh' });
        };

        // Log Filter functions
        window.toggleLogFilters = function() {
          const filterBar = document.getElementById('log-filter-bar');
          if (filterBar) {
            filterBar.hidden = !filterBar.hidden;
          }
        };

        window.applyLogFilters = function() {
          const searchInput = document.getElementById('filter-search');
          const authorInput = document.getElementById('filter-author');
          const pathInput = document.getElementById('filter-path');
          const sinceInput = document.getElementById('filter-since');
          const untilInput = document.getElementById('filter-until');

          const filter = {
            searchText: searchInput ? searchInput.value.trim() : '',
            author: authorInput ? authorInput.value.trim() : '',
            path: pathInput ? pathInput.value.trim() : '',
            since: sinceInput && sinceInput.value ? sinceInput.value : null,
            until: untilInput && untilInput.value ? untilInput.value : null
          };

          vscode.postMessage({ 
            type: 'applyLogFilter', 
            filter: filter 
          });
        };

        window.clearLogFilters = function() {
          const searchInput = document.getElementById('filter-search');
          const authorInput = document.getElementById('filter-author');
          const pathInput = document.getElementById('filter-path');
          const sinceInput = document.getElementById('filter-since');
          const untilInput = document.getElementById('filter-until');

          if (searchInput) searchInput.value = '';
          if (authorInput) authorInput.value = '';
          if (pathInput) pathInput.value = '';
          if (sinceInput) sinceInput.value = '';
          if (untilInput) untilInput.value = '';

          vscode.postMessage({ 
            type: 'applyLogFilter', 
            filter: null 
          });
        };

        window.handleFilterKeyup = function(event) {
          // Apply filters on Enter key
          if (event.key === 'Enter') {
            applyLogFilters();
          }
        };

        window.handleFilterSearchKeyup = function(event) {
          // Apply filters on Enter key for search
          if (event.key === 'Enter') {
            applyLogFilters();
          }
        };

        // Log context menu
        let logContextMenuTarget = null;

        window.showLogContextMenu = function(event, hash) {
          event.preventDefault();
          event.stopPropagation();
          
          logContextMenuTarget = hash;
          const contextMenu = document.getElementById('log-context-menu');
          if (contextMenu) {
            const x = event.clientX;
            const y = event.clientY;
            
            const menuWidth = 200;
            const menuHeight = 300;
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            
            const left = x + menuWidth > viewportWidth ? viewportWidth - menuWidth - 10 : x;
            const top = y + menuHeight > viewportHeight ? viewportHeight - menuHeight - 10 : y;
            
            contextMenu.style.left = left + 'px';
            contextMenu.style.top = top + 'px';
            contextMenu.hidden = false;
          }
        };

        // Handle log context menu item clicks
        document.addEventListener('click', (e) => {
          const logContextMenu = document.getElementById('log-context-menu');
          if (logContextMenu && !logContextMenu.contains(e.target)) {
            logContextMenu.hidden = true;
          }

          const menuItem = e.target.closest('#log-context-menu .context-menu-item');
          if (menuItem && logContextMenuTarget) {
            const action = menuItem.dataset.action;
            if (action) {
              vscode.postMessage({
                type: 'logContextAction',
                action: action,
                commitHashes: [logContextMenuTarget]
              });
              document.getElementById('log-context-menu').hidden = true;
            }
          }
        });

        // Keyboard handler for commits
        window.handleCommitKeydown = function(event, hash) {
          switch (event.key) {
            case 'Enter':
            case ' ':
              event.preventDefault();
              if (event.ctrlKey || event.metaKey) {
                vscode.postMessage({ type: 'toggleCommitSelection', commitHash: hash });
                const row = event.target.closest('.commit-row');
                if (row) {
                  row.classList.toggle('selected');
                  const isNowSelected = row.classList.contains('selected');
                  row.setAttribute('aria-selected', String(isNowSelected));
                }
                anchorHash = hash;
                refreshSelectedCount();
              } else {
                vscode.postMessage({ type: 'selectCommit', commitHash: hash });
                document.querySelectorAll('.commit-row.selected').forEach(function(r) {
                  r.classList.remove('selected');
                  r.setAttribute('aria-selected', 'false');
                });
                const row = event.target.closest('.commit-row');
                if (row) {
                  row.classList.add('selected');
                  row.setAttribute('aria-selected', 'true');
                }
                anchorHash = hash;
                refreshSelectedCount();
              }
              break;
            // Keyboard range-select.
            //
            //   ArrowUp/Down            : single-select prev/next row
            //   Shift+ArrowUp/Down      : range-replace prev/next row
            //   Ctrl+Shift+ArrowUp/Down : range-add prev/next row
            //
            // Targets are looked up by document order of commit rows;
            // the current graph isn't virtualised, so the rendered DOM
            // already reflects the host's display ordering. Focus is
            // moved to the new row so the next keypress targets it.
            case 'ArrowUp':
            case 'ArrowDown': {
              event.preventDefault();
              const rows = Array.from(document.querySelectorAll(
                '.graph-panel .commit-row[data-hash]'
              ));
              const allHashes = rows.map(function(r) { return r.getAttribute('data-hash'); });
              const curIdx = allHashes.indexOf(hash);
              if (curIdx === -1) break;
              const delta = event.key === 'ArrowDown' ? 1 : -1;
              const targetIdx = curIdx + delta;
              if (targetIdx < 0 || targetIdx >= rows.length) break;
              const targetRow = rows[targetIdx];
              const targetHash = allHashes[targetIdx];
              if (!targetHash) break;
              if (event.shiftKey && (event.ctrlKey || event.metaKey)) {
                // Message anchor wins.
                vscode.postMessage({
                  type: 'addRangeSelectCommit',
                  commitHash: targetHash,
                  anchorHash: anchorHash,
                });
                applyRangeSelectionDom(targetHash, /* additive */ true);
              } else if (event.shiftKey) {
                vscode.postMessage({
                  type: 'rangeSelectCommit',
                  commitHash: targetHash,
                  anchorHash: anchorHash,
                });
                applyRangeSelectionDom(targetHash, /* additive */ false);
              } else {
                vscode.postMessage({ type: 'selectCommit', commitHash: targetHash });
                document.querySelectorAll('.commit-row.selected').forEach(function(r) {
                  r.classList.remove('selected');
                  r.setAttribute('aria-selected', 'false');
                });
                targetRow.classList.add('selected');
                targetRow.setAttribute('aria-selected', 'true');
                anchorHash = targetHash;
                refreshSelectedCount();
              }
              // Move keyboard focus + scroll into view so the user
              // visually tracks the selection even on a virtualised list.
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
              showLogContextMenu(event, hash);
              break;
            case 'c':
              if (event.ctrlKey || event.metaKey) {
                event.preventDefault();
                copyToClipboard(hash);
              }
              break;
          }
        };

        // Commit context menu for Graph Panel
        let commitContextMenuHashes = [];

        window.showCommitContextMenu = function(event, hash) {
          event.preventDefault();
          event.stopPropagation();

          // Determine if the right-clicked commit is part of a multi-select
          const selectedRows = document.querySelectorAll('.graph-panel .commit-row.selected');
          const selectedHashes = Array.from(selectedRows).map(function(row) {
            return row.getAttribute('data-hash');
          });

          // Right-click on a non-selected commit moves the
          // selection to ONLY that commit. Mirrors IntelliJ — the action
          // can never silently target a different set than the user sees
          // highlighted. The host gets the same news via
          // selectIfNotSelected so the host-side state stays in sync and
          // the next updateMenuEnableState reflects the move.
          if (selectedHashes.indexOf(hash) === -1) {
            document.querySelectorAll('.commit-row.selected').forEach(function(r) {
              r.classList.remove('selected');
              r.setAttribute('aria-selected', 'false');
            });
            const target = document.querySelector('.commit-row[data-hash="' + hash + '"]');
            if (target) {
              target.classList.add('selected');
              target.setAttribute('aria-selected', 'true');
            }
            anchorHash = hash;
            refreshSelectedCount();
            vscode.postMessage({ type: 'selectIfNotSelected', commitHash: hash });
            commitContextMenuHashes = [hash];
          } else if (selectedHashes.length > 1) {
            // Multi-select right-click on a member: target the whole set.
            commitContextMenuHashes = selectedHashes;
          } else {
            commitContextMenuHashes = [hash];
          }

          const contextMenu = document.getElementById('commit-context-menu');
          if (contextMenu) {
            const x = event.clientX;
            const y = event.clientY;

            const menuWidth = 220;
            const menuHeight = 400;
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;

            const left = x + menuWidth > viewportWidth ? viewportWidth - menuWidth - 10 : x;
            const top = y + menuHeight > viewportHeight ? viewportHeight - menuHeight - 10 : y;

            contextMenu.style.left = left + 'px';
            contextMenu.style.top = top + 'px';

            applyMenuEnableMap(contextMenu);

            contextMenu.hidden = false;
          }
        };

        // Apply-loop for the host-precomputed menu state.
        //
        // ADR-009: the host computes visibility + enabled per action via
        // \`multiSelect.ts:computeMenuState\` and posts the map as
        // \`updateMenuEnableState\`. The JS does NOT mirror the rules —
        // it just toggles classes per the cached \`menuEnableMap\`. If the
        // map is missing (extremely early page load, before the first
        // host post arrives), we fall back to "enable everything" so the
        // menu remains usable; the host's validation rejects any
        // stale invocation downstream so nothing destructive can slip
        // through that window.
        function applyMenuEnableMap(contextMenu) {
          const map = menuEnableMap;
          const items = contextMenu.querySelectorAll('.context-menu-item');
          items.forEach(function(item) {
            const action = item.getAttribute('data-action');
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
            // Surface entry.reason as a title= tooltip on visible-disabled
            // rows. Defense-in-depth typeof check keeps a malformed payload
            // from rendering "[object Object]" or "undefined" into the
            // user's tooltip.
            //
            // INVARIANT (with multiSelect.ts:computeMenuState): the host
            // sets reason ONLY when visible && !enabled. This gate
            // mirrors that on the wire side. If a future host bug sets
            // reason on a hidden row, the title write would silently
            // emit on a .menu-multi-hidden element — invisible to the
            // user, but a sign that the host invariant has drifted.
            const titleAttr =
              entry && !entry.enabled && typeof entry.reason === 'string'
                ? entry.reason
                : '';
            if (titleAttr) {
              item.setAttribute('title', titleAttr);
            } else {
              item.removeAttribute('title');
            }
          });
        }

        // Handle commit context menu item clicks
        document.addEventListener('click', (e) => {
          const commitContextMenu = document.getElementById('commit-context-menu');
          if (commitContextMenu && !commitContextMenu.contains(e.target)) {
            commitContextMenu.hidden = true;
          }

          const menuItem = e.target.closest('#commit-context-menu .context-menu-item');
          if (menuItem && commitContextMenuHashes.length > 0) {
            if (menuItem.classList.contains('disabled')) return;
            const action = menuItem.dataset.action;
            if (action) {
              vscode.postMessage({
                type: 'commitContextMenu',
                action: action,
                commitHashes: commitContextMenuHashes
              });
              document.getElementById('commit-context-menu').hidden = true;
            }
          }
        });

        // Hide commit context menu on Escape key
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
            const commitContextMenu = document.getElementById('commit-context-menu');
            if (commitContextMenu) commitContextMenu.hidden = true;
          }
        });

        // ─── Collapsed-ref popup (branch label "+N" chip) ────────────────
        // The collapsed-branch chip is a button. Activating it (click or
        // Enter/Space) opens a popup listing every collapsed ref, one row
        // per branch. Each row navigates to that branch via the existing
        // \`branchClick\` message — no new host handler. The popup clones
        // the commit-context-menu overlay primitive: cursor-positioned with
        // the same viewport-clamp, dismissed by click-outside + Escape.
        //
        // Full keyboard operability (WCAG 2.1.1): opening focuses the first
        // row; ArrowUp/Down move between rows; Enter/Space on a row selects
        // it; Escape and select return focus to the +N chip that opened the
        // popup. aria-expanded on the chip tracks open/closed state.
        let refPopupOpener = null;

        function closeRefPopup(restoreFocus) {
          const popup = document.getElementById('ref-popup');
          if (popup) popup.hidden = true;
          if (refPopupOpener) {
            refPopupOpener.setAttribute('aria-expanded', 'false');
            if (restoreFocus && typeof refPopupOpener.focus === 'function') {
              refPopupOpener.focus();
            }
          }
          refPopupOpener = null;
        }

        function openRefPopup(chip, clientX, clientY) {
          const popup = document.getElementById('ref-popup');
          if (!popup) return;
          // data-collapsed-branches is a PIPE-delimited list (see the join
          // in GitToolWindowProvider). A branch name containing a literal
          // '|' would split into spurious rows; hardening the delimiter
          // (JSON / NUL) is deferred as a follow-up — pipe is safe for the
          // common case.
          const raw = chip.getAttribute('data-collapsed-branches') || '';
          const names = raw.split('|').filter(function(n) { return n.length > 0; });
          if (names.length === 0) return;

          // Build one row per ref. textContent assignment escapes the name,
          // so a branch name containing markup cannot inject into the popup.
          popup.innerHTML = '';
          names.forEach(function(name) {
            const row = document.createElement('div');
            row.className = 'context-menu-item';
            row.setAttribute('role', 'menuitem');
            row.setAttribute('tabindex', '0');
            row.setAttribute('data-branch-name', name);
            row.textContent = name;
            popup.appendChild(row);
          });

          // Same clamp math as the commit context menu.
          const menuWidth = 220;
          const menuHeight = 400;
          const viewportWidth = window.innerWidth;
          const viewportHeight = window.innerHeight;
          const left = clientX + menuWidth > viewportWidth ? viewportWidth - menuWidth - 10 : clientX;
          const top = clientY + menuHeight > viewportHeight ? viewportHeight - menuHeight - 10 : clientY;
          popup.style.left = left + 'px';
          popup.style.top = top + 'px';
          popup.hidden = false;

          // Track the opener so dismiss can restore focus + flip
          // aria-expanded, then move focus to the first row so a keyboard
          // user lands inside the menu.
          refPopupOpener = chip;
          chip.setAttribute('aria-expanded', 'true');
          const firstRow = popup.querySelector('.context-menu-item');
          if (firstRow && typeof firstRow.focus === 'function') {
            firstRow.focus();
          }
        }

        // Emit branchClick for a popup row, then dismiss + restore focus.
        function selectRefRow(row) {
          const name = row.getAttribute('data-branch-name');
          if (name) {
            vscode.postMessage({ type: 'branchClick', branchName: name });
          }
          closeRefPopup(true);
        }

        // Single click handler for the ref popup, in priority order so the
        // open / row-select / dismiss paths never race each other:
        //   1. click on the collapsed chip   → open the popup
        //   2. click on a popup row           → navigate + dismiss
        //   3. click anywhere else            → dismiss
        document.addEventListener('click', function(e) {
          const target = e.target && e.target.closest ? e.target : null;
          const popup = document.getElementById('ref-popup');
          if (!popup) return;

          const chip = target ? target.closest('.branch-label-collapsed[data-collapsed-branches]') : null;
          if (chip) {
            openRefPopup(chip, e.clientX, e.clientY);
            return;
          }

          if (popup.hidden) return;

          const row = target ? target.closest('#ref-popup .context-menu-item') : null;
          if (row) {
            selectRefRow(row);
            return;
          }

          // Click anywhere outside the popup dismisses it (no focus
          // restore — the user clicked elsewhere on purpose).
          if (!popup.contains(e.target)) {
            closeRefPopup(false);
          }
        });

        // Open on Enter/Space when the chip is keyboard-focused.
        document.addEventListener('keydown', function(e) {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          const chip = e.target && e.target.closest
            ? e.target.closest('.branch-label-collapsed[data-collapsed-branches]')
            : null;
          if (!chip) return;
          e.preventDefault();
          // Anchor the popup at the chip's own position (no pointer coords
          // for a keyboard activation).
          const rect = chip.getBoundingClientRect();
          openRefPopup(chip, rect.left, rect.bottom);
        });

        // Keyboard operation INSIDE the open popup: Enter/Space selects the
        // focused row; ArrowUp/Down move focus between rows (wrapping);
        // Escape dismisses + returns focus to the +N chip.
        document.addEventListener('keydown', function(e) {
          const popup = document.getElementById('ref-popup');
          if (!popup || popup.hidden) return;

          if (e.key === 'Escape') {
            e.preventDefault();
            closeRefPopup(true);
            return;
          }

          const row = e.target && e.target.closest
            ? e.target.closest('#ref-popup .context-menu-item')
            : null;
          if (!row) return;

          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            selectRefRow(row);
            return;
          }

          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const rows = Array.from(popup.querySelectorAll('.context-menu-item'));
            const idx = rows.indexOf(row);
            if (idx === -1) return;
            const nextIdx = e.key === 'ArrowDown'
              ? (idx + 1) % rows.length
              : (idx - 1 + rows.length) % rows.length;
            const next = rows[nextIdx];
            if (next && typeof next.focus === 'function') {
              next.focus();
            }
          }
        });

        // Delegate keyboard handling to focused commit
        // rows so the arrow-key range-select works without per-row
        // \`onkeydown\` attributes (which would inflate the rendered HTML).
        document.addEventListener('keydown', function(e) {
          const focused = e.target && e.target.closest
            ? e.target.closest('.commit-row[data-hash]')
            : null;
          if (!focused) return;
          const hash = focused.getAttribute('data-hash');
          if (!hash) return;
          // Only intercept the keys the handler cares about — leave
          // everything else (Tab, Esc, plain typing) untouched.
          const handled = (
            e.key === 'Enter' || e.key === ' ' ||
            e.key === 'ArrowUp' || e.key === 'ArrowDown' ||
            e.key === 'ContextMenu' ||
            (e.key === 'c' && (e.ctrlKey || e.metaKey))
          );
          if (handled) {
            window.handleCommitKeydown(e, hash);
          }
        });

        // Context menu functions
        window.showContextMenu = function(event, path) {
          event.preventDefault();
          event.stopPropagation();
          
          contextMenuTarget = path;
          const contextMenu = document.getElementById('context-menu');
          if (contextMenu) {
            // Position the menu at the cursor
            const x = event.clientX;
            const y = event.clientY;
            
            // Ensure menu stays within viewport
            const menuWidth = 180;
            const menuHeight = 280;
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            
            const left = x + menuWidth > viewportWidth ? viewportWidth - menuWidth - 10 : x;
            const top = y + menuHeight > viewportHeight ? viewportHeight - menuHeight - 10 : y;
            
            contextMenu.style.left = left + 'px';
            contextMenu.style.top = top + 'px';
            contextMenu.hidden = false;
          }
        };

        // Drag and drop functions
        window.handleDragStart = function(event, path) {
          draggedFiles = [path];
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', path);
          event.target.classList.add('dragging');
          
          // Create custom drag image
          const dragGhost = document.createElement('div');
          dragGhost.className = 'drag-ghost';
          dragGhost.textContent = path.split('/').pop();
          document.body.appendChild(dragGhost);
          event.dataTransfer.setDragImage(dragGhost, 0, 0);
          
          // Remove ghost after drag starts
          setTimeout(() => {
            document.body.removeChild(dragGhost);
          }, 0);
        };

        window.handleDragEnd = function(event) {
          event.target.classList.remove('dragging');
          draggedFiles = [];
          
          // Remove drag-over class from all changelists
          document.querySelectorAll('.changelist').forEach(cl => {
            cl.classList.remove('drag-over');
          });
        };

        window.handleDragOver = function(event) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          
          const changelist = event.target.closest('.changelist');
          if (changelist) {
            changelist.classList.add('drag-over');
          }
        };

        window.handleDragLeave = function(event) {
          const changelist = event.target.closest('.changelist');
          if (changelist && !changelist.contains(event.relatedTarget)) {
            changelist.classList.remove('drag-over');
          }
        };

        window.handleDrop = function(event, targetChangelistId) {
          event.preventDefault();
          
          const changelist = event.target.closest('.changelist');
          if (changelist) {
            changelist.classList.remove('drag-over');
          }
          
          if (draggedFiles.length > 0) {
            vscode.postMessage({
              type: 'fileDrop',
              files: draggedFiles,
              targetChangelistId: targetChangelistId
            });
          }
          
          draggedFiles = [];
        };

        // Keyboard handlers
        window.handleChangelistKeydown = function(event, changelistId) {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggleChangelist(changelistId);
          }
        };

        window.handleFileKeydown = function(event, path) {
          switch (event.key) {
            case 'Enter':
              event.preventDefault();
              doubleClickFile(path);
              break;
            case ' ':
              event.preventDefault();
              selectFile(path);
              break;
            case 'ContextMenu':
              event.preventDefault();
              showContextMenu(event, path);
              break;
          }
        };

        // Incremental commit loading
        // Monitor the graph panel scroll position and request more commits
        // when the user scrolls within 50px of the bottom.
        let loadMoreCommitsRequested = false;

        function setupGraphPanelScrollListener() {
          const graphPanel = document.querySelector('.graph-panel');
          if (!graphPanel) return;

          graphPanel.addEventListener('scroll', function() {
            if (loadMoreCommitsRequested) return;

            const scrollTop = graphPanel.scrollTop;
            const scrollHeight = graphPanel.scrollHeight;
            const clientHeight = graphPanel.clientHeight;
            const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

            // Check if we have more commits to load
            const loadedCount = parseInt(graphPanel.getAttribute('data-loaded-count') || '0', 10);
            const totalAvailable = parseInt(graphPanel.getAttribute('data-total-available') || '0', 10);
            const hasMore = loadedCount < totalAvailable;

            if (hasMore && distanceFromBottom <= 50) {
              loadMoreCommitsRequested = true;
              vscode.postMessage({ type: 'loadMoreCommits' });
            }
          });
        }

        // Reset the loadMoreCommitsRequested flag when new content is loaded
        window.addEventListener('message', function(event) {
          const message = event.data;
          if (message.type === 'commitsLoaded') {
            loadMoreCommitsRequested = false;
          }
        });

        // Set up the scroll listener on initial load
        setupGraphPanelScrollListener();

        // Also observe DOM changes to re-attach the scroll listener if the graph panel is re-rendered
        const observer = new MutationObserver(function() {
          setupGraphPanelScrollListener();
          loadMoreCommitsRequested = false;
        });
        observer.observe(document.body, { childList: true, subtree: true });
      })();
    `;
}
