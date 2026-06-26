/**
 * Builds the inline `<script>` source for the Git tool window webview.
 *
 * Returns a self-contained IIFE (as a template string) that runs in the
 * webview: it reads the shared `vscode` API handle (memoised on
 * `window.__intelligVscodeApi`, acquiring it only if no sibling script has
 * yet), wires the repository selector, commit-row selection + range
 * selection, the menu enable-map,
 * anchor restoration, scroll-to-commit, and the load-more / graph-scroll
 * observers. The string is fully static — it interpolates no host state and
 * carries no color literals — so it is assembled here, independent of the
 * provider instance, and injected verbatim into the rendered HTML.
 *
 * NOTE on the trigger to externalise: this inline script long ago outgrew a
 * handful of helpers. The remaining reason it stays inline is that it carries
 * no async data flow and no host-state interpolation. The moment either is
 * needed, move these functions to a separate `.js` resource served via
 * `webview.asWebviewUri` (so a stricter CSP and source maps apply).
 */
export function buildInlineScript(): string {
  return `
      (function() {
        // Share the one VS Code API handle across the document's inline
        // scripts: reuse the handle memoised on \`window\`, or acquire it here if
        // this script runs first. \`acquireVsCodeApi\` may be called only once
        // per document; the tabbed layout hosts several inline scripts, so only
        // the first to run acquires and the rest read \`window.__intelligVscodeApi\`.
        const vscode = window.__intelligVscodeApi || (typeof acquireVsCodeApi === 'function' ? (window.__intelligVscodeApi = acquireVsCodeApi()) : undefined);
        if (!vscode) return;

        // Repository scope is chosen from the Path filter popup (the repo rows
        // post \`selectRepository\`); see the setupLogFilterRow IIFE below.

        // ─── Log filter row (IntelliJ VcsLogClassicFilterUi) ─────────────
        // A text-search field plus Branch / User / Date / Path popup buttons.
        // The popups are custom styled panels (native <select>/<datalist>
        // popups render in an unstyleable Chromium UA layer). Every control
        // uses data-action — the CSP (script-src 'nonce-…') blocks inline
        // handlers. The active filter is mirrored into data-f-* on the row so
        // this rehydrates after a full host re-render.
        (function setupLogFilterRow() {
          const row = document.querySelector('.log-filter-row');
          if (!row) return;

          const filterState = {
            branch: row.getAttribute('data-f-branch') || '',
            author: row.getAttribute('data-f-author') || '',
            path: row.getAttribute('data-f-path') || '',
            since: row.getAttribute('data-f-since') || '',
            until: row.getAttribute('data-f-until') || '',
          };

          function byId(id) { return document.getElementById(id); }
          function readSearch() { const el = byId('filter-search'); return el ? el.value.trim() : ''; }
          function readToggle(id) { const el = byId(id); return el ? el.classList.contains('active') : false; }

          function applyFilters() {
            vscode.postMessage({
              type: 'applyLogFilter',
              filter: {
                branch: filterState.branch,
                searchText: readSearch(),
                author: filterState.author,
                path: filterState.path,
                since: filterState.since || null,
                until: filterState.until || null,
                searchRegex: readToggle('filter-search-regex'),
                searchCaseSensitive: readToggle('filter-search-case'),
              }
            });
          }

          function setPopValue(key, text) {
            const el = byId('filter-' + key + '-value');
            if (el) el.textContent = (text && text.length > 0) ? text : 'All';
          }
          function dateLabel() {
            const s = filterState.since, u = filterState.until;
            if (s && u) return s + ' – ' + u;
            if (s) return 'Since ' + s;
            if (u) return 'Until ' + u;
            return 'All';
          }
          function pathLeaf(p) {
            const parts = p.split('/').filter(Boolean);
            return parts.length ? parts[parts.length - 1] : p;
          }

          function closeAllPopups() {
            document.querySelectorAll('.log-filter-popup').forEach(function(p) { p.hidden = true; });
            document.querySelectorAll('.log-filter-pop-btn').forEach(function(b) { b.setAttribute('aria-expanded', 'false'); });
          }
          function togglePopup(key) {
            const popup = byId('filter-popup-' + key);
            if (!popup) return;
            const show = popup.hidden;
            closeAllPopups();
            popup.hidden = !show;
            const wrap = popup.closest('.log-filter-pop');
            const btn = wrap ? wrap.querySelector('.log-filter-pop-btn') : null;
            if (btn) btn.setAttribute('aria-expanded', show ? 'true' : 'false');
            if (show) {
              if (key === 'branch') vscode.postMessage({ type: 'requestLogFilterOptions' });
              if (key === 'user') vscode.postMessage({ type: 'requestAuthorOptions' });
              const input = popup.querySelector('input[type="text"]');
              if (input) { try { input.focus(); } catch (err) {} }
            }
          }

          // YYYY-MM-DD for (today - days), used by the Date presets.
          function daysAgoIso(days) {
            const d = new Date();
            d.setDate(d.getDate() - days);
            const m = ('0' + (d.getMonth() + 1)).slice(-2);
            const day = ('0' + d.getDate()).slice(-2);
            return d.getFullYear() + '-' + m + '-' + day;
          }

          document.addEventListener('click', function(e) {
            if (!(e.target instanceof Element)) return;
            // A click outside any popup wrapper dismisses open popups.
            if (!e.target.closest('.log-filter-pop')) closeAllPopups();
            const actionEl = e.target.closest('[data-action]');
            if (!actionEl) return;
            const action = actionEl.getAttribute('data-action');
            if (action === 'toggleFilterPopup') {
              togglePopup(actionEl.getAttribute('data-popup'));
            } else if (action === 'toggleSearchRegex' || action === 'toggleSearchCase') {
              actionEl.classList.toggle('active');
              actionEl.setAttribute('aria-pressed', actionEl.classList.contains('active') ? 'true' : 'false');
              applyFilters();
            } else if (action === 'pickBranchFilter') {
              const b = actionEl.getAttribute('data-branch');
              filterState.branch = (b && b !== '__all__') ? b : '';
              setPopValue('branch', filterState.branch);
              closeAllPopups();
              applyFilters();
            } else if (action === 'pickAuthorFilter') {
              const a = actionEl.getAttribute('data-author');
              filterState.author = (a && a !== '__all__') ? a : '';
              const ai = byId('filter-author-input'); if (ai) ai.value = filterState.author;
              setPopValue('user', filterState.author);
              closeAllPopups();
              applyFilters();
            } else if (action === 'pickDateFilter') {
              const range = actionEl.getAttribute('data-range');
              if (range === '24h') { filterState.since = daysAgoIso(1); filterState.until = ''; }
              else if (range === '7d') { filterState.since = daysAgoIso(7); filterState.until = ''; }
              else { filterState.since = ''; filterState.until = ''; }
              setPopValue('date', dateLabel());
              closeAllPopups();
              applyFilters();
            } else if (action === 'dateSelectCustom') {
              const custom = byId('filter-date-custom');
              if (custom) custom.hidden = false; // keep the Date popup open
            } else if (action === 'applyDateCustom') {
              const afterOn = byId('filter-after-enabled');
              const beforeOn = byId('filter-before-enabled');
              const afterDate = byId('filter-after-date');
              const beforeDate = byId('filter-before-date');
              filterState.since = (afterOn && afterOn.checked && afterDate) ? afterDate.value : '';
              filterState.until = (beforeOn && beforeOn.checked && beforeDate) ? beforeDate.value : '';
              setPopValue('date', dateLabel());
              closeAllPopups();
              applyFilters();
            } else if (action === 'applyPathFilter') {
              const pi = byId('filter-path-input');
              filterState.path = pi ? pi.value.trim() : '';
              setPopValue('path', filterState.path ? pathLeaf(filterState.path) : 'All');
              closeAllPopups();
              applyFilters();
            } else if (action === 'pickRepoScope') {
              const idx = actionEl.getAttribute('data-repo-index');
              vscode.postMessage({ type: 'selectRepository', repositoryIndex: idx === 'all' ? 'all' : Number(idx) });
              closeAllPopups(); // host re-renders the row with the new scope
            }
          });

          // After/Before checkboxes gate their date input (enable on check).
          document.addEventListener('change', function(e) {
            if (!(e.target instanceof Element)) return;
            const el = e.target.closest('[data-action="toggleDateBound"]');
            if (!el) return;
            const dateInput = byId(el.getAttribute('data-bound') === 'after' ? 'filter-after-date' : 'filter-before-date');
            if (dateInput) dateInput.disabled = !el.checked;
          });

          document.addEventListener('keydown', function(e) {
            if (!(e.target instanceof Element)) return;
            if (e.key === 'Escape') { closeAllPopups(); return; }
            if (e.key !== 'Enter') return;
            const a = e.target.getAttribute('data-action');
            if (a === 'filterSearchKeydown') {
              e.preventDefault(); applyFilters();
            } else if (a === 'filterAuthorKeydown') {
              e.preventDefault();
              filterState.author = e.target.value.trim();
              setPopValue('user', filterState.author);
              closeAllPopups();
              applyFilters();
            } else if (a === 'filterPathKeydown') {
              e.preventDefault();
              filterState.path = e.target.value.trim();
              setPopValue('path', filterState.path ? pathLeaf(filterState.path) : 'All');
              closeAllPopups();
              applyFilters();
            }
          });

          // Live-filter the branch list as the user types in the popup search.
          document.addEventListener('input', function(e) {
            if (!(e.target instanceof Element)) return;
            if (e.target.getAttribute('data-action') !== 'filterPopupSearch') return;
            const q = e.target.value.toLowerCase();
            const list = byId('filter-branch-list');
            if (!list) return;
            list.querySelectorAll('.log-filter-popup-item').forEach(function(item) {
              const t = (item.textContent || '').toLowerCase();
              item.hidden = q.length > 0 && t.indexOf(q) === -1;
            });
          });

          // Read accessors for the message handlers that fill the branch /
          // author lists (so they can mark the active item).
          window.__intelligFilter = {
            getBranch: function() { return filterState.branch; },
            getAuthor: function() { return filterState.author; },
          };
        })();

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

        // Build the commit Details Panel DOM from a structured model (see
        // detailsPanelModel.ts). Self-contained (only touches document) so it
        // can be unit-tested in isolation. Returns the .details-panel element.
        function buildDetailsPanelDom(model) {
          const make = function (tag, className) {
            const node = document.createElement(tag);
            if (className) node.className = className;
            return node;
          };
          const panel = make('div', 'details-panel');
          panel.setAttribute('role', 'region');
          panel.setAttribute('aria-label', 'Commit Details');

          if (!model || model.kind === 'placeholder') {
            panel.setAttribute('aria-label', 'Commit Details');
            const ph = make('div', 'details-placeholder');
            const p = make('p', 'placeholder-message');
            p.textContent = 'Select a commit to view details';
            ph.appendChild(p);
            panel.appendChild(ph);
            return panel;
          }

          // Append message tokens (inert text + issue links) into a parent.
          const appendTokens = function (parent, tokens) {
            (tokens || []).forEach(function (tok) {
              if (tok.t === 'link') {
                const a = make('a', 'commit-issue-link');
                a.setAttribute('href', tok.href);
                a.setAttribute('title', tok.title);
                a.textContent = tok.text;
                parent.appendChild(a);
              } else {
                parent.appendChild(document.createTextNode(tok.v));
              }
            });
          };

          // Build the changed-files list (tree | empty | error message).
          const buildChangedFiles = function (count, tree, error) {
            const wrap = make('div', 'details-changed-files');
            const h4 = make('h4');
            h4.textContent = 'Changed Files (' + count + ')';
            wrap.appendChild(h4);
            const list = make('div', 'changed-files-list');
            list.setAttribute('role', 'tree');
            list.setAttribute('aria-label', 'Changed Files');
            if (error) {
              const p = make('p', 'empty-message error-message');
              p.textContent = 'Failed to load changed files: ' + error;
              list.appendChild(p);
            } else if (!tree || tree.length === 0) {
              const p = make('p', 'empty-message');
              p.textContent = 'No changed files';
              list.appendChild(p);
            } else {
              appendTree(list, tree, 0, { next: 0 }, model.kind === 'single' ? model.hash : undefined);
            }
            wrap.appendChild(list);
            return wrap;
          };

          if (model.kind === 'multi') {
            panel.classList.add('multi-commit-details');
            panel.setAttribute('aria-label', 'Multi-Commit Details');
            panel.setAttribute('data-selected-count', String(model.count));
            const header = make('h3', 'multi-commit-header');
            header.textContent = model.count + ' commit' + (model.count !== 1 ? 's' : '') + ' selected';
            panel.appendChild(header);
            const list = make('div', 'multi-commit-list');
            list.setAttribute('role', 'list');
            list.setAttribute('aria-label', 'Selected Commits');
            (model.commits || []).forEach(function (c) {
              const item = make('div', 'multi-commit-item');
              item.setAttribute('role', 'listitem');
              const sh = make('span', 'commit-short-hash');
              sh.textContent = c.shortHash;
              const sm = make('span', 'commit-summary');
              sm.textContent = c.summary;
              item.appendChild(sh);
              item.appendChild(sm);
              list.appendChild(item);
            });
            panel.appendChild(list);
            panel.appendChild(buildChangedFiles(model.changedFilesCount, model.fileTree, undefined));
            return panel;
          }

          // Single-commit panel.
          panel.appendChild(
            buildChangedFiles(model.changedFilesCount, model.fileTree, model.changedFilesError)
          );
          const meta = make('div', 'details-metadata');
          const row = function (labelText) {
            const r = make('div', 'detail-row');
            const l = make('span', 'detail-label');
            l.textContent = labelText;
            r.appendChild(l);
            return r;
          };

          // Commit message — subject in BOLD, body below; no "Message:" label
          // (IntelliJ shows the subject as the header, not a labeled field).
          const msgRow = make('div', 'detail-row message-row');
          const pre = make('pre', 'detail-value commit-full-message');
          const subject = make('span', 'commit-subject');
          appendTokens(subject, model.messageTokens);
          pre.appendChild(subject);
          if (model.bodyTokens) {
            pre.appendChild(document.createTextNode('\\n\\n'));
            appendTokens(pre, model.bodyTokens);
          }
          msgRow.appendChild(pre);
          meta.appendChild(msgRow);

          const hashRow = row('Hash:');
          const hashVal = make('span', 'detail-value hash-value');
          hashVal.setAttribute('data-copy-text', model.hash);
          hashVal.setAttribute('title', 'Click to copy');
          hashVal.textContent = model.hash;
          hashRow.appendChild(hashVal);
          meta.appendChild(hashRow);

          const authorRow = row('Author:');
          const authorVal = make('span', 'detail-value');
          authorVal.textContent = model.authorName + ' <' + model.authorEmail + '>';
          authorRow.appendChild(authorVal);
          meta.appendChild(authorRow);

          const dateRow = row('Date:');
          const dateVal = make('span', 'detail-value');
          dateVal.textContent = model.dateStr;
          dateRow.appendChild(dateVal);
          meta.appendChild(dateRow);

          const parentsRow = row('Parents:');
          const parentsVal = make('span', 'detail-value');
          if (!model.parents || model.parents.length === 0) {
            const none = make('span', 'no-parents');
            none.textContent = 'None (root commit)';
            parentsVal.appendChild(none);
          } else {
            model.parents.forEach(function (p, i) {
              if (i > 0) parentsVal.appendChild(document.createTextNode(', '));
              const span = make('span', 'parent-hash');
              span.setAttribute('data-parent-hash', p.full);
              span.setAttribute('title', p.full);
              span.textContent = p.short;
              parentsVal.appendChild(span);
            });
          }
          parentsRow.appendChild(parentsVal);
          meta.appendChild(parentsRow);

          // "Contained in branches" row (mirrors IntelliJ ContainingBranchesPanel /
          // CommitPresentationUtil.getBranchesLinkText): the header carries the
          // FULL branch count ("In N branch(es):") in both collapsed and expanded
          // states, or a loading / "not in any branch" phrase. Past the threshold
          // the names collapse to the first N + a "Show all" toggle. Branch names
          // cross as DATA (textContent), never interpolated markup.
          const branchesRow = make('div', 'detail-row containing-branches-row');
          const branchesLabel = make('span', 'detail-label');
          const containing = model.containingBranches;
          if (!containing) {
            branchesLabel.textContent = 'In branches: loading…';
            branchesRow.appendChild(branchesLabel);
          } else if (containing.length === 0) {
            branchesLabel.textContent = 'Not in any branch';
            branchesRow.appendChild(branchesLabel);
          } else {
            branchesLabel.textContent =
              'In ' + containing.length + (containing.length === 1 ? ' branch:' : ' branches:');
            branchesRow.appendChild(branchesLabel);
            const branchesVal = make('span', 'detail-value containing-branches-value');
            const threshold = model.branchCollapseThreshold || 3;
            const appendNames = function (parent, names) {
              names.forEach(function (name, i) {
                if (i > 0) parent.appendChild(document.createTextNode(', '));
                const span = make('span', 'containing-branch');
                span.textContent = name;
                parent.appendChild(span);
              });
            };
            if (containing.length <= threshold) {
              const all = make('span', 'branches-collapsed');
              appendNames(all, containing);
              branchesVal.appendChild(all);
            } else {
              const collapsed = make('span', 'branches-collapsed');
              appendNames(collapsed, containing.slice(0, threshold));
              collapsed.appendChild(document.createTextNode(' … '));
              const expanded = make('span', 'branches-expanded');
              expanded.style.display = 'none';
              appendNames(expanded, containing);
              expanded.appendChild(document.createTextNode(' '));

              const toggle = function (showExpanded) {
                collapsed.style.display = showExpanded ? 'none' : '';
                expanded.style.display = showExpanded ? '' : 'none';
              };
              const linkButton = function (className, label, expand) {
                const a = make('a', className);
                a.setAttribute('role', 'button');
                a.setAttribute('tabindex', '0');
                a.textContent = label;
                a.addEventListener('click', function () {
                  toggle(expand);
                });
                a.addEventListener('keydown', function (e) {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggle(expand);
                  }
                });
                return a;
              };
              collapsed.appendChild(linkButton('branches-show-all', 'Show all', true));
              expanded.appendChild(linkButton('branches-hide', 'Hide', false));
              branchesVal.appendChild(collapsed);
              branchesVal.appendChild(expanded);
            }
            branchesRow.appendChild(branchesVal);
          }
          meta.appendChild(branchesRow);

          panel.appendChild(meta);
          return panel;

          // ---- nested file-tree builders (hoisted) ----
          function appendTree(parent, nodes, depth, ids, commitHash) {
            (nodes || []).forEach(function (node) {
              if (node.kind === 'directory') {
                const padding = depth * 16 + 4;
                const dirItem = document.createElement('div');
                dirItem.className = 'changed-dir-item';
                dirItem.setAttribute('role', 'treeitem');
                dirItem.setAttribute('aria-expanded', 'true');
                const containerId = 'dir-children-' + ids.next++;
                dirItem.setAttribute('aria-controls', containerId);
                dirItem.setAttribute('tabindex', '0');
                dirItem.setAttribute('style', 'padding-left: ' + padding + 'px;');
                const chevron = document.createElement('span');
                chevron.className = 'dir-chevron codicon codicon-chevron-down';
                chevron.setAttribute('aria-hidden', 'true');
                dirItem.appendChild(chevron);
                const dirName = document.createElement('span');
                dirName.className = 'dir-name';
                dirName.textContent = node.name;
                dirItem.appendChild(dirName);
                parent.appendChild(dirItem);
                const childrenWrap = document.createElement('div');
                childrenWrap.className = 'changed-dir-children';
                childrenWrap.setAttribute('role', 'group');
                childrenWrap.id = containerId;
                appendTree(childrenWrap, node.children, depth + 1, ids, commitHash);
                parent.appendChild(childrenWrap);
              } else {
                const padding = depth * 16 + 4;
                const item = document.createElement('div');
                item.className = 'changed-file-item';
                item.setAttribute('data-path', node.path);
                item.setAttribute('data-status', node.status);
                if (commitHash !== undefined) item.setAttribute('data-commit-hash', commitHash);
                item.setAttribute('role', 'treeitem');
                item.setAttribute('tabindex', '0');
                item.setAttribute('style', 'padding-left: ' + padding + 'px;');
                // No M/A/D status letter — the file-name colour (+ the per-file
                // line stat below) conveys the change kind. The status still
                // rides as a title for hover / screen readers.
                const nameSpan = document.createElement('span');
                nameSpan.className = 'file-name';
                nameSpan.setAttribute('style', 'color: ' + node.statusColor + ';');
                nameSpan.setAttribute('title', node.status);
                nameSpan.textContent = node.fileName;
                item.appendChild(nameSpan);
                if (node.status === 'renamed' && node.oldPath) {
                  item.appendChild(document.createTextNode(' '));
                  const arrow = document.createElement('span');
                  arrow.className = 'rename-arrow';
                  arrow.textContent = '\\u2190';
                  item.appendChild(arrow);
                  item.appendChild(document.createTextNode(' '));
                  const oldPath = document.createElement('span');
                  oldPath.className = 'old-path';
                  oldPath.setAttribute('title', node.oldPath);
                  oldPath.textContent = node.oldPath;
                  item.appendChild(oldPath);
                }
                // Per-file line diff: "(+N | -M)" with +N green and -M red.
                // Shown only when there is at least one changed line (binary /
                // no-line-change files carry no counts).
                const adds = typeof node.additions === 'number' ? node.additions : 0;
                const dels = typeof node.deletions === 'number' ? node.deletions : 0;
                if (adds > 0 || dels > 0) {
                  const stats = document.createElement('span');
                  stats.className = 'changed-file-stats';
                  stats.appendChild(document.createTextNode('('));
                  const addSpan = document.createElement('span');
                  addSpan.className = 'changed-file-add';
                  addSpan.textContent = '+' + adds;
                  stats.appendChild(addSpan);
                  stats.appendChild(document.createTextNode(' | '));
                  const delSpan = document.createElement('span');
                  delSpan.className = 'changed-file-del';
                  delSpan.textContent = '-' + dels;
                  stats.appendChild(delSpan);
                  stats.appendChild(document.createTextNode(')'));
                  item.appendChild(stats);
                }
                parent.appendChild(item);
              }
            });
          }
        }

        // Handle state updates from extension
        window.addEventListener('message', event => {
          const message = event.data;
          if (message.type === 'scrollToCommit' && message.commitHash) {
            scrollToCommit(message.commitHash);
          }
          if (message.type === 'graphTotalsUpdate') {
            // A late-resolving rev-list count: update ONLY the load-count
            // attributes the scroll load-more reads, so a slow total re-enables
            // load-more without a full re-render (no scroll/layout/selection
            // reset). The "X of Y" text refreshes on the next render.
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
              // Build the panel via createElement from the structured model —
              // no innerHTML, so a hostile message/path/author can't inject markup.
              detailsPanel.replaceChildren(buildDetailsPanelDom(message.model));
            }
          }
          if (message.type === 'selectGraphRow' && message.commitHash) {
            // Update graph row selection highlighting
            document.querySelectorAll('.commit-row.selected').forEach(function(r) {
              r.classList.remove('selected');
              r.setAttribute('aria-selected', 'false');
            });
            const targetRow = document.querySelector('.commit-row[data-hash="' + CSS.escape(message.commitHash) + '"]');
            if (targetRow) {
              targetRow.classList.add('selected');
              targetRow.setAttribute('aria-selected', 'true');
              // Only scroll when the row isn't already fully on-screen. This
              // mirrors scrollToCommit's fullyVisible gate (and shouldScrollToRow
              // in scrollVisibility.ts). selectCommit echoes selectGraphRow on
              // every plain click; an unconditional smooth re-center here made
              // the graph "jerk around" on each selection of an already-visible
              // row. Same bug class as the branch-click "sweep from the top".
              const panel = targetRow.closest('.graph-panel');
              if (panel) {
                const rowTop = targetRow.offsetTop;
                const rowBottom = rowTop + targetRow.offsetHeight;
                const viewportTop = panel.scrollTop;
                const viewportBottom = viewportTop + panel.clientHeight;
                const fullyVisible = rowTop >= viewportTop && rowBottom <= viewportBottom;
                if (!fullyVisible) {
                  targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
              } else {
                targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }
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
          // Branch popup options (lazy, on popup open): fill the Branch list
          // with IntelliJ's grouped layout — "All branches", then a Local
          // group, then one group per remote. Built via createElement so the
          // textContent/data-branch cross as data, never markup.
          if (message.type === 'logFilterOptionsReady') {
            const list = document.getElementById('filter-branch-list');
            const groups = message.branchGroups;
            if (list && groups) {
              const current = window.__intelligFilter ? window.__intelligFilter.getBranch() : '';
              list.replaceChildren();
              function addBranchItem(value, text) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'log-filter-popup-item' + (value === current ? ' active' : '');
                btn.setAttribute('data-action', 'pickBranchFilter');
                btn.setAttribute('data-branch', value);
                btn.textContent = text;
                list.appendChild(btn);
              }
              function addSection(title) {
                const header = document.createElement('div');
                header.className = 'log-filter-popup-section';
                header.textContent = title;
                list.appendChild(header);
              }
              // "All branches" maps to the empty (no-scope) branch — active when
              // no branch is set.
              const allBtn = document.createElement('button');
              allBtn.type = 'button';
              allBtn.className = 'log-filter-popup-item' + (current ? '' : ' active');
              allBtn.setAttribute('data-action', 'pickBranchFilter');
              allBtn.setAttribute('data-branch', '__all__');
              allBtn.textContent = 'All branches';
              list.appendChild(allBtn);
              if (Array.isArray(groups.local) && groups.local.length > 0) {
                addSection('Local');
                groups.local.forEach(function(name) { addBranchItem(name, name); });
              }
              if (Array.isArray(groups.remotes)) {
                groups.remotes.forEach(function(g) {
                  if (!g.branches || g.branches.length === 0) return;
                  addSection(g.remote);
                  g.branches.forEach(function(name) {
                    // Display the short name (strip "remote/"); the value keeps
                    // the full ref the host needs for git log.
                    const display = name.indexOf(g.remote + '/') === 0 ? name.slice(g.remote.length + 1) : name;
                    addBranchItem(name, display);
                  });
                });
              }
            }
          }
          // User popup options (lazy, on popup open): fill the author list.
          if (message.type === 'authorOptionsReady') {
            const list = document.getElementById('filter-author-list');
            if (list && Array.isArray(message.authors)) {
              const current = window.__intelligFilter ? window.__intelligFilter.getAuthor() : '';
              list.replaceChildren();
              const allBtn = document.createElement('button');
              allBtn.type = 'button';
              allBtn.className = 'log-filter-popup-item' + (current ? '' : ' active');
              allBtn.setAttribute('data-action', 'pickAuthorFilter');
              allBtn.setAttribute('data-author', '__all__');
              allBtn.textContent = 'All users';
              list.appendChild(allBtn);
              message.authors.forEach(function(a) {
                const name = String(a);
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'log-filter-popup-item' + (name === current ? ' active' : '');
                btn.setAttribute('data-action', 'pickAuthorFilter');
                btn.setAttribute('data-author', name);
                btn.textContent = name;
                list.appendChild(btn);
              });
            }
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
          // Commit hashes are host-rendered hex, but CSS.escape the value before
          // building the [data-hash] attribute selector so a malformed value
          // (stray quote) degrades to "no match" rather than throwing a
          // querySelector SyntaxError. Mirrors the sibling selectors below.
          const commitRow = document.querySelector('[data-hash="' + CSS.escape(commitHash) + '"]');
          if (!commitRow) { return; }                       // not in DOM: no action

          const panel = commitRow.closest('.graph-panel');
          if (panel) {
            const rowTop = commitRow.offsetTop;
            const rowBottom = rowTop + commitRow.offsetHeight;
            const viewportTop = panel.scrollTop;
            const viewportBottom = viewportTop + panel.clientHeight;
            // Mirror of shouldScrollToRow (scrollVisibility.ts) — ephemeral UI affordance (ADR-009 section 2).
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

        // Navigate to a commit hash in the log by selecting and scrolling to its row.
        // Used by goToParent and goToChild to jump without a host round-trip.
        function jumpToCommitHash(hash) {
          const targetRow = document.querySelector('.commit-row[data-hash="' + CSS.escape(hash) + '"]');
          if (!targetRow) return; // not in visible list — do nothing
          document.querySelectorAll('.commit-row.selected').forEach(function(r) {
            r.classList.remove('selected');
            r.setAttribute('aria-selected', 'false');
          });
          targetRow.classList.add('selected');
          targetRow.setAttribute('aria-selected', 'true');
          targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
          refreshSelectedCount();
          vscode.postMessage({ type: 'selectCommit', commitHash: hash });
        }

        // Show a lightweight pick popup listing short hashes. Used when a commit
        // has multiple parents or children so the user can choose which to jump to.
        // onSelect(hash) is called with the chosen hash.
        function openNavigationPopup(hashes, clientX, clientY, onSelect) {
          const popup = document.getElementById('ref-popup');
          if (!popup) return;

          popup.innerHTML = '';
          hashes.forEach(function(h) {
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

          // Single-use click handler: select a hash row then clean up.
          function pickHandler(e) {
            const row = e.target && e.target.closest
              ? e.target.closest('#ref-popup [data-nav-hash]')
              : null;
            if (!row) {
              // Click outside — dismiss without navigating.
              if (!popup.contains(e.target)) {
                popup.hidden = true;
                document.removeEventListener('click', pickHandler, true);
              }
              return;
            }
            e.stopPropagation();
            const h = row.getAttribute('data-nav-hash');
            popup.hidden = true;
            document.removeEventListener('click', pickHandler, true);
            if (h) onSelect(h);
          }
          document.addEventListener('click', pickHandler, true);
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

        // Restore-or-reset the scroll position on every full re-render.
        // Scroll is preserved by DEFAULT: the host stamps data-preserve-scroll
        // unless the render is navigational. On a preserve render the saved
        // scrollTop (persisted on every scroll above) is reapplied so the user
        // stays where they were across in-place re-renders (load-more, cherry
        // marks, selection) instead of being yanked to the newest commit. On a
        // navigational render (repo switch / filter change / initial load) the
        // attribute is omitted: the panel starts at the top AND the saved
        // position is cleared so a following incidental re-render doesn't
        // restore the now-stale scroll.
        (function restoreOrResetScroll() {
          const graphPanel = document.querySelector('.graph-panel');
          if (!graphPanel || !vscode) return;

          // An explicit jump-to-commit render (handled by autoScrollOnLoad
          // above) wins: never let the preserve-restore override it.
          if (graphPanel.hasAttribute('data-scroll-to-commit')) return;

          if (!graphPanel.hasAttribute('data-preserve-scroll')) {
            // Navigational reset: drop the stale saved position so the next
            // incidental (preserve) render restores the top, not the old view.
            const prev = vscode.getState() || {};
            if (prev.graphScrollTop) {
              prev.graphScrollTop = 0;
              vscode.setState(prev);
            }
            return;
          }

          const state = vscode.getState() || {};
          const saved = state.graphScrollTop;
          if (typeof saved !== 'number' || saved <= 0) return;

          // A synchronous scrollTop assignment during the initial parse can be
          // clamped or discarded before the real webview finishes its first
          // layout pass, so the restore silently fails. Apply it now AND once
          // more on the next animation frame (after layout settles) so it
          // sticks in the Electron webview. jsdom models no layout, so the
          // immediate assignment is what the unit tests observe.
          graphPanel.scrollTop = saved;
          // Exactly ONE retry, on purpose: it targets the Electron first-layout
          // clamp and nothing later. More retries would only widen the window in
          // which a user's in-frame scroll gets clobbered back to the saved
          // value — do not grow this into a loop.
          if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(function () {
              graphPanel.scrollTop = saved;
            });
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

        // (The Branch / User / Date / Path filter controls and the search field
        // are wired in the setupLogFilterRow IIFE near the top of this script.)

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

        // ─── fixup!/squash! link click → jumpToFixupTarget ───────────────
        // Intercept clicks on .log-fixup-link before the commit-row handler
        // fires so only the jump is posted (the row is NOT selected).
        document.addEventListener('click', function(e) {
          if (!(e.target instanceof Element)) return;
          const link = e.target.closest('[data-action="jumpToFixupTarget"]');
          if (link) {
            e.stopPropagation();
            const targetSubject = link.getAttribute('data-target');
            if (targetSubject) {
              vscode.postMessage({ type: 'jumpToFixupTarget', targetSubject: targetSubject });
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

        window.initRepository = function() {
          vscode.postMessage({ type: 'initRepository' });
        };

        window.refreshLocalChanges = function() {
          vscode.postMessage({ type: 'refresh' });
        };

        window.refreshLog = function() {
          vscode.postMessage({ type: 'refresh' });
        };

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
              showCommitContextMenu(event, hash);
              break;
            // G9: ArrowRight → go to parent; ArrowLeft → go to child.
            // Only fires when exactly one commit row is selected.
            case 'ArrowRight': {
              event.preventDefault();
              const selectedRows = document.querySelectorAll('.graph-panel .commit-row.selected');
              if (selectedRows.length !== 1) break;
              const currentRow = document.querySelector('.commit-row[data-hash="' + CSS.escape(hash) + '"]');
              if (!currentRow) break;
              const parentsRaw = currentRow.getAttribute('data-parents') || '';
              const parents = parentsRaw.split(',').filter(function(h) { return h.length > 0; });
              if (parents.length === 0) break; // root commit
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
              if (selectedRowsL.length !== 1) break;
              const allRowsL = Array.from(document.querySelectorAll('.commit-row[data-hash]'));
              const childrenL = allRowsL.filter(function(r) {
                const p = r.getAttribute('data-parents') || '';
                return p.split(',').indexOf(hash) !== -1;
              }).map(function(r) { return r.getAttribute('data-hash'); });
              if (childrenL.length === 0) break;
              if (childrenL.length === 1) {
                jumpToCommitHash(childrenL[0]);
              } else {
                const currentRowL = document.querySelector('.commit-row[data-hash="' + CSS.escape(hash) + '"]');
                const rect = currentRowL ? currentRowL.getBoundingClientRect() : { right: 0, top: 0 };
                openNavigationPopup(childrenL, rect.right, rect.top, jumpToCommitHash);
              }
              break;
            }
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
            const target = document.querySelector('.commit-row[data-hash="' + CSS.escape(hash) + '"]');
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

            // Clamp to >= 8px so the menu never starts off the top/left edge
            // (a short window made the top coordinate negative, pushing the
            // first items off-screen above the viewport).
            const left = Math.max(8, x + menuWidth > viewportWidth ? viewportWidth - menuWidth - 10 : x);
            const top = Math.max(8, y + menuHeight > viewportHeight ? viewportHeight - menuHeight - 10 : y);

            contextMenu.style.left = left + 'px';
            contextMenu.style.top = top + 'px';
            // Cap the menu to the remaining viewport height and scroll the
            // overflow, so a tall menu in a short window keeps every item
            // reachable instead of spilling off the bottom edge.
            contextMenu.style.maxHeight = (viewportHeight - top - 10) + 'px';
            contextMenu.style.overflowY = 'auto';

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
              // G9: goToParent / goToChild are handled purely in the webview.
              // No host round-trip — navigate directly within the rendered rows.
              if (action === 'goToParent' || action === 'goToChild') {
                document.getElementById('commit-context-menu').hidden = true;
                const hash = commitContextMenuHashes[0];
                if (!hash) return;
                if (action === 'goToParent') {
                  const row = document.querySelector('.commit-row[data-hash="' + CSS.escape(hash) + '"]');
                  if (!row) return;
                  const parentsRaw = row.getAttribute('data-parents') || '';
                  const parents = parentsRaw.split(',').filter(function(h) { return h.length > 0; });
                  if (parents.length === 0) return; // root commit
                  if (parents.length === 1) {
                    jumpToCommitHash(parents[0]);
                  } else {
                    openNavigationPopup(parents, e.clientX, e.clientY, jumpToCommitHash);
                  }
                } else {
                  // goToChild: scan all visible rows for those whose data-parents contains hash.
                  const allRows = Array.from(document.querySelectorAll('.commit-row[data-hash]'));
                  const children = allRows.filter(function(r) {
                    const p = r.getAttribute('data-parents') || '';
                    return p.split(',').indexOf(hash) !== -1;
                  }).map(function(r) { return r.getAttribute('data-hash'); });
                  if (children.length === 0) return;
                  if (children.length === 1) {
                    jumpToCommitHash(children[0]);
                  } else {
                    openNavigationPopup(children, e.clientX, e.clientY, jumpToCommitHash);
                  }
                }
                return;
              }
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

        // Hide commit context menu when the webview loses focus. A click in
        // another VS Code panel/editor never reaches this iframe's document, so
        // the outside-click handler above can't fire — only a window blur can
        // close the menu, matching native click-away behaviour.
        window.addEventListener('blur', function() {
          const commitContextMenu = document.getElementById('commit-context-menu');
          if (commitContextMenu) commitContextMenu.hidden = true;
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
          // data-collapsed-branches is a JSON array of the collapsed ref
          // names (see the JSON.stringify in GitToolWindowProvider). Parsing
          // JSON round-trips a name containing any character, including a
          // literal '|'. A malformed or missing attribute yields no rows
          // rather than throwing.
          const raw = chip.getAttribute('data-collapsed-branches') || '';
          let names = [];
          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
              names = parsed.filter(function(n) { return typeof n === 'string' && n.length > 0; });
            }
          } catch (err) {
            names = [];
          }
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
            e.key === 'ArrowRight' || e.key === 'ArrowLeft' ||
            e.key === 'ContextMenu' ||
            (e.key === 'c' && (e.ctrlKey || e.metaKey))
          );
          if (handled) {
            window.handleCommitKeydown(e, hash);
          }
        });

        // Incremental commit loading
        // Monitor the graph panel scroll position and request more commits
        // when the user scrolls within 50px of the bottom.
        let loadMoreCommitsRequested = false;

        function setupGraphPanelScrollListener() {
          const graphPanel = document.querySelector('.graph-panel');
          if (!graphPanel) return;

          // Attach at most once per panel element. The MutationObserver below
          // re-runs this on every DOM mutation; without this guard a fresh
          // scroll listener would leak on each one. A re-rendered panel is a
          // NEW element without the flag, so it re-attaches as intended.
          if (graphPanel.dataset.scrollListenerAttached === 'true') return;
          graphPanel.dataset.scrollListenerAttached = 'true';

          graphPanel.addEventListener('scroll', function() {
            const scrollTop = graphPanel.scrollTop;

            // Persist scroll position so a load-more re-render (which fully
            // replaces the DOM) can restore it instead of snapping to the top.
            // Merged into existing webview state so we don't clobber other keys.
            if (vscode) {
              const prev = vscode.getState() || {};
              prev.graphScrollTop = scrollTop;
              vscode.setState(prev);
            }

            if (loadMoreCommitsRequested) return;

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

        // Re-arm the load-more debounce when the host signals a requested page
        // has finished rendering. The host posts \`commitsLoaded\` after every
        // load-more render (GitToolWindowProvider.notifyCommitsLoaded), so the
        // reset is explicit and does not rely on the full webview.html reload
        // clearing the flag — a future in-place DOM patch keeps working.
        window.addEventListener('message', function(event) {
          const message = event.data;
          if (message.type === 'commitsLoaded') {
            loadMoreCommitsRequested = false;
          }
        });

        // Set up the scroll listener on initial load
        setupGraphPanelScrollListener();

        // Also observe DOM changes to wire the scroll listener when the graph
        // panel is re-rendered as a new element. The attach is idempotent (see
        // the dataset guard above); the load-more debounce flag is reset ONLY
        // by the host's \`commitsLoaded\` message, never here — resetting it on
        // every mutation would let a stray mutation re-fire loadMoreCommits.
        const observer = new MutationObserver(function() {
          setupGraphPanelScrollListener();
        });
        observer.observe(document.body, { childList: true, subtree: true });

        // Build the initial Details Panel from the host-provided model. The body
        // ships #details-panel empty; this mirrors the updateDetailsPanel path so
        // the initial and subsequent renders share one createElement builder
        // (no host-side details-panel HTML string).
        (function() {
          const dp = document.getElementById('details-panel');
          const initialModel = window.__intelligInitialDetails;
          if (dp && initialModel) {
            dp.replaceChildren(buildDetailsPanelDom(initialModel));
          }
        })();
      })();
    `;
}
