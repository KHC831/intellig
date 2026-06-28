/**
 * History tab HTML.
 *
 * Pure render — no side effects, no DOM APIs used. Takes the tab's state
 * as input and returns the body-level HTML the provider splices into the
 * tabbed wrapper.
 *
 * Current callers still pass zero arguments; we render an empty-state
 * placeholder in that case so behaviour is unchanged until the provider
 * starts feeding real state in.
 */

import type { IBranch, ICommit } from '../../interfaces/IGitService';
import type { IHistoryTabState } from '../tabs/HistoryTab';
import { generateCommitGraph, getColumnColor, type ICommitNode } from '../../commitGraph';
import { escapeHtml } from '../../../utils/escapeHtml';

/**
 * Render the History tab body.
 *
 * @param state  Optional state; when omitted, renders the empty shell.
 */
export function renderHistoryTabBody(state?: IHistoryTabState): string {
  if (!state || !state.filePath) {
    return renderEmptyState();
  }
  return renderLoadedState(state);
}

function renderEmptyState(): string {
  return `
    <div class="history-tab">
      <div class="history-empty" role="status">
        <h3>File History</h3>
        <p>No file loaded. Use <code>IntelliG: Show History</code> on a file to populate this tab.</p>
      </div>
    </div>
  `;
}

function renderLoadedState(state: IHistoryTabState): string {
  const header = renderHeader(state);
  const toolbar = renderToolbar(state);
  // Synchronous read of the `error` sideband is the structurally correct
  // shape for HTML / template-rendering views per ADR-006
  // (`docs/adr/ADR-006-error-state-binding-by-view-type.md`). The
  // canonical-channel `Promise<{ error? }>` pattern used by ShelfView /
  // StashView / BranchComparisonView does not apply here — this
  // renderer cannot await mid-template. See the JSDoc on
  // `IHistoryTabState.error` for the full reasoning.
  const error = state.error ? renderError(state.error) : '';
  const list = renderCommitList(state);
  // The commit-details panel reuses the Log page's renderer: it ships empty and
  // is filled client-side by buildDetailsPanelDom from window.__intelligHistoryDetails
  // (single source of truth for the commit-details format + changed-files tree).
  return `
    <div class="history-tab">
      ${header}
      ${toolbar}
      ${error}
      <div class="history-main">
        <div class="history-list-panel">${list}</div>
        <div id="history-details-panel" class="details-panel"></div>
      </div>
    </div>
  `;
}

function renderHeader(state: IHistoryTabState): string {
  const path = escapeHtml(state.filePath ?? '');
  const subtitle = state.loading ? '<span class="history-loading">Loading…</span>' : '';
  return `
    <div class="history-header">
      <span class="history-path" title="${path}">${path}</span>
      ${subtitle}
    </div>
  `;
}

function renderToolbar(state: IHistoryTabState): string {
  const followChecked = state.followRenames ? 'checked' : '';
  const branchDropdown = renderBranchDropdown(state.availableBranches, state.branchFilter);
  const compareEnabled = Boolean(state.selectedCommit);
  const diffTwoEnabled = Boolean(state.selectedCommit && state.compareCommit);

  return `
    <div class="history-toolbar" role="toolbar">
      <label class="history-toolbar-follow">
        <input type="checkbox" class="history-follow-chk" ${followChecked} />
        Follow renames
      </label>
      <label class="history-toolbar-branch">
        Branch:
        <select class="history-branch-select">${branchDropdown}</select>
      </label>
      <button type="button" class="history-btn-get-version" ${compareEnabled ? '' : 'disabled'} title="Open the file's content as of the selected revision">
        Get Version
      </button>
      <button type="button" class="history-btn-compare-local" ${compareEnabled ? '' : 'disabled'} title="Compare the selected revision with the working-copy file">
        Compare with Local
      </button>
      <button type="button" class="history-btn-diff-two" ${diffTwoEnabled ? '' : 'disabled'} title="Diff the two selected revisions">
        Diff Revisions
      </button>
    </div>
  `;
}

function renderBranchDropdown(branches: readonly IBranch[], current: string | undefined): string {
  const currentOption = `<option value="" ${current === undefined ? 'selected' : ''}>HEAD (default)</option>`;
  const options = branches.map((b) => {
    const selected = b.name === current ? 'selected' : '';
    const label = escapeHtml(b.name);
    return `<option value="${label}" ${selected}>${label}</option>`;
  });
  return [currentOption, ...options].join('');
}

function renderError(err: string): string {
  return `<div class="history-error" role="alert">${escapeHtml(err)}</div>`;
}

function renderCommitList(state: IHistoryTabState): string {
  if (state.commits.length === 0) {
    if (state.loading) {
      return `<div class="history-empty-commits">Loading commits…</div>`;
    }
    return `
      <div class="history-empty-commits" role="status">
        <p>No commits found for this file${state.branchFilter ? ` on ${escapeHtml(state.branchFilter)}` : ''}.</p>
      </div>
    `;
  }
  // Build the lane/line model once for the whole window via the shared
  // `commitGraph.ts` engine (reused, not reinvented), then look each row's node
  // up by hash so the per-row mini-graph cell can draw its lane + edges.
  const nodesByHash = buildGraphNodeMap(state.commits);
  const rows = state.commits
    .map((commit) => renderCommitRow(commit, state, nodesByHash.get(commit.hash)))
    .join('');
  return `<div class="history-commit-list" role="list">${rows}</div>`;
}

/**
 * Compute the commit-graph nodes for the revision window and index them by
 * hash. Returns an empty map when there are no commits so callers can render a
 * placeholder cell without a guard. The history list is linear in the common
 * case; the engine still draws merge/fork lanes correctly when present.
 */
function buildGraphNodeMap(commits: readonly ICommit[]): Map<string, ICommitNode> {
  const map = new Map<string, ICommitNode>();
  if (commits.length === 0) {
    return map;
  }
  for (const node of generateCommitGraph([...commits])) {
    map.set(node.commit.hash, node);
  }
  return map;
}

export function renderCommitRow(
  commit: ICommit,
  state: IHistoryTabState,
  node?: ICommitNode
): string {
  const classes = ['history-commit-row'];
  if (commit.hash === state.selectedCommit) {
    classes.push('history-selected');
  }
  if (commit.hash === state.compareCommit) {
    classes.push('history-compare');
  }
  const subject = escapeHtml((commit.message ?? '').split('\n')[0]);
  const author = escapeHtml(commit.author?.name ?? '');
  const date = commit.authorDate ? new Date(commit.authorDate).toLocaleDateString() : '';
  return `
    <div class="${classes.join(' ')}" data-rev="${escapeHtml(commit.hash)}" role="listitem" title="${escapeHtml(commit.message ?? '')}">
      ${renderGraphCell(node)}
      <span class="history-commit-hash">${escapeHtml(commit.shortHash ?? commit.hash.substring(0, 7))}</span>
      <span class="history-commit-subject">${subject}</span>
      <span class="history-commit-author">${author}</span>
      <span class="history-commit-date">${escapeHtml(date)}</span>
    </div>
  `;
}

/** Fixed geometry for the mini-graph gutter (one row tall). */
const GRAPH_LANE_WIDTH = 12;
const GRAPH_ROW_HEIGHT = 20;
const GRAPH_DOT_RADIUS = 3.5;

/**
 * Render the per-row mini commit-graph cell: the commit's dot plus its outgoing
 * lane lines, using the lane assignment from `generateCommitGraph`. Kept
 * deliberately compact (a one-row SVG) — it's a gutter affordance signalling the
 * commit's lane and merge/fork edges, not the full scrollable graph of the Log
 * tab. Off-window (`dashed`) parent stubs are drawn dashed, matching the engine
 * invariant and IntelliJ's "history continues below" affordance.
 */
function renderGraphCell(node: ICommitNode | undefined): string {
  if (!node) {
    return `<span class="history-commit-graph" aria-hidden="true"></span>`;
  }
  const lanes = new Set<number>([node.graphColumn]);
  for (const line of node.graphLines) {
    lanes.add(line.fromColumn);
    lanes.add(line.toColumn);
  }
  const maxLane = Math.max(0, ...lanes);
  const width = (maxLane + 1) * GRAPH_LANE_WIDTH;
  const laneX = (lane: number): number => lane * GRAPH_LANE_WIDTH + GRAPH_LANE_WIDTH / 2;
  const centerY = GRAPH_ROW_HEIGHT / 2;

  const segments = node.graphLines
    .map((line) => {
      const dash = line.style === 'dashed' ? ' stroke-dasharray="2 2"' : '';
      return `<line x1="${laneX(line.fromColumn)}" y1="${centerY}" x2="${laneX(
        line.toColumn
      )}" y2="${GRAPH_ROW_HEIGHT}" stroke="${getColumnColor(line.fromColumn)}" stroke-width="1.5"${dash} />`;
    })
    .join('');
  const dot = `<circle cx="${laneX(node.graphColumn)}" cy="${centerY}" r="${GRAPH_DOT_RADIUS}" fill="${getColumnColor(
    node.graphColumn
  )}" />`;

  return `<span class="history-commit-graph" aria-hidden="true"><svg width="${width}" height="${GRAPH_ROW_HEIGHT}" viewBox="0 0 ${width} ${GRAPH_ROW_HEIGHT}">${segments}${dot}</svg></span>`;
}

/**
 * CSS for the History tab. Emitted alongside the existing provider styles
 * when the tabbed layout flag is on (see GitToolWindowProvider).
 */
export function historyTabStyles(): string {
  return `
    .history-tab { display: flex; flex-direction: column; height: 100%; min-height: 0; }
    .history-header { padding: 6px 8px; display: flex; gap: 8px; align-items: center; border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c); }
    .history-path { font-family: var(--vscode-editor-font-family, monospace); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .history-loading { color: var(--vscode-descriptionForeground); font-style: italic; font-size: 0.9em; }
    .history-toolbar { display: flex; align-items: center; gap: 12px; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c); flex-wrap: wrap; }
    .history-toolbar label { display: inline-flex; align-items: center; gap: 4px; }
    .history-branch-select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 2px 4px; font: inherit; }
    .history-toolbar button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 2px 8px; cursor: pointer; }
    .history-toolbar button[disabled] { background: var(--vscode-button-secondaryBackground); color: var(--vscode-disabledForeground); cursor: not-allowed; }
    .history-error { padding: 6px 8px; background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,0.1)); color: var(--vscode-errorForeground, #f48771); }
    .history-empty, .history-empty-commits { padding: 16px; color: var(--vscode-descriptionForeground); }
    .history-commit-list { flex: 1 1 auto; overflow: auto; }
    .history-commit-row { display: grid; grid-template-columns: auto 7ch minmax(0, 1fr) minmax(0, 14ch) minmax(0, 10ch); gap: 8px; padding: 2px 8px; cursor: pointer; align-items: center; }
    .history-commit-graph { display: inline-flex; align-items: center; min-width: 12px; }
    .history-commit-graph svg { display: block; }
    .history-commit-row:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.15)); }
    .history-commit-row.history-selected { background: var(--vscode-list-activeSelectionBackground, rgba(14,99,156,0.5)); color: var(--vscode-list-activeSelectionForeground); }
    .history-commit-row.history-compare { outline: 1px dashed var(--vscode-focusBorder, #0078d4); outline-offset: -2px; }
    .history-commit-hash { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-textLink-foreground, #3794ff); }
    .history-commit-author, .history-commit-date { color: var(--vscode-descriptionForeground); font-size: 0.9em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    /* Side-by-side layout matching the Log page: commit list on the left, the
       commit-details panel on the right (not stacked below the list). */
    .history-main { display: flex; flex-direction: row; flex: 1 1 auto; min-height: 0; }
    .history-list-panel { display: flex; flex-direction: column; flex: 3 1 0; min-width: 0; overflow: hidden; }
    .history-main > #history-details-panel { flex: 2 1 0; min-width: 0; overflow: auto; border-left: 1px solid var(--vscode-panel-border, #3c3c3c); }
  `;
}

/**
 * Behaviour script for the History tab. Binds clicks on the commit list,
 * toolbar toggles, and dropdown changes to postMessage calls.
 */
export function historyTabBehaviorScript(): string {
  return `
    (function () {
      // Share the one VS Code API handle across the document's inline scripts:
      // reuse the handle memoised on \`window\`, or acquire it here if this
      // script runs first. \`acquireVsCodeApi\` throws if called more than once.
      const vscode = window.__intelligVscodeApi || (typeof acquireVsCodeApi === 'function' ? (window.__intelligVscodeApi = acquireVsCodeApi()) : undefined);
      if (!vscode) return;

      document.querySelectorAll('.history-commit-row').forEach(function (row) {
        row.addEventListener('click', function (event) {
          const rev = row.getAttribute('data-rev');
          if (!rev) return;
          vscode.postMessage({
            type: 'history.selectRevision',
            rev: rev,
            additive: Boolean(event.ctrlKey || event.metaKey),
          });
        });
        row.addEventListener('dblclick', function () {
          const rev = row.getAttribute('data-rev');
          if (!rev) return;
          vscode.postMessage({ type: 'history.openAtRevision', rev: rev });
        });
      });

      const followChk = document.querySelector('.history-follow-chk');
      if (followChk) {
        followChk.addEventListener('change', function () {
          vscode.postMessage({
            type: 'history.toggleFollowRenames',
            value: followChk.checked,
          });
        });
      }

      const branchSel = document.querySelector('.history-branch-select');
      if (branchSel) {
        branchSel.addEventListener('change', function () {
          const value = branchSel.value;
          vscode.postMessage({
            type: 'history.setBranchFilter',
            branch: value || undefined,
          });
        });
      }

      const getVersionBtn = document.querySelector('.history-btn-get-version');
      if (getVersionBtn) {
        getVersionBtn.addEventListener('click', function () {
          const selected = document.querySelector('.history-commit-row.history-selected');
          const rev = selected ? selected.getAttribute('data-rev') : null;
          if (rev) {
            vscode.postMessage({ type: 'history.getVersion', rev: rev });
          }
        });
      }

      const compareLocalBtn = document.querySelector('.history-btn-compare-local');
      if (compareLocalBtn) {
        compareLocalBtn.addEventListener('click', function () {
          const selected = document.querySelector('.history-commit-row.history-selected');
          const rev = selected ? selected.getAttribute('data-rev') : null;
          if (rev) {
            vscode.postMessage({ type: 'history.compareWithLocal', rev: rev });
          }
        });
      }

      const copyBtn = document.querySelector('.history-details-copy');
      if (copyBtn) {
        copyBtn.addEventListener('click', function () {
          const hash = copyBtn.getAttribute('data-copy-hash');
          if (hash && navigator.clipboard) {
            navigator.clipboard.writeText(hash);
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
            vscode.postMessage({
              type: 'history.compareWith',
              from: from,
              to: to,
            });
          }
        });
      }
    })();
  `;
}
