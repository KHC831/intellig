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

import type { FileStatus, IBranch, ICommit } from '../../interfaces/IGitService';
import { buildHistoryDetails, type IHistoryTabState } from '../tabs/HistoryTab';
import { generateCommitGraph, getColumnColor, type ICommitNode } from '../../commitGraph';

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
  const details = renderHistoryDetails(state);
  const affected = renderAffectedPaths(state);
  // Layout mirrors IntelliJ's file-history panel: the revision list sits on
  // top, the commit-details pane and the affected-paths pane below it.
  return `
    <div class="history-tab">
      ${header}
      ${toolbar}
      ${error}
      ${list}
      <div class="history-bottom">
        ${details}
        ${affected}
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
 * Render the commit-details pane for the selected revision: full message,
 * author (name + email), authored/committed dates, full hash with a copy
 * affordance, and parent hashes.
 *
 * Mirrors IntelliJ's file-history details pane
 * (`CommitPresentationUtil.formatCommitHashAndAuthor` /
 * `getAuthorAndCommitterText`): the committer line appears only when the
 * committer is a different person from the author. Read-only and fully
 * HTML-escaped — this renderer is the single escaping boundary over the raw
 * model produced by {@link buildHistoryDetails}.
 */
export function renderHistoryDetails(state: IHistoryTabState): string {
  const selected = state.selectedCommit
    ? state.commits.find((c) => c.hash === state.selectedCommit)
    : undefined;
  const details = buildHistoryDetails(selected);
  const body = details ? renderHistoryDetailsBody(details) : renderHistoryDetailsEmpty();
  return `
    <div class="history-details" role="group" aria-label="Commit details">
      <div class="history-details-header">Commit Details</div>
      ${body}
    </div>
  `;
}

function renderHistoryDetailsEmpty(): string {
  return `<div class="history-details-empty" role="status">Select a revision to view its details.</div>`;
}

function renderHistoryDetailsBody(d: import('../tabs/HistoryTab').IHistoryCommitDetails): string {
  const message = escapeHtml(d.message).replace(/\n/g, '<br>');
  const authored = formatHistoryDate(d.authorDate);
  const committerRow = d.committer
    ? `<div class="history-details-row"><span class="history-details-label">Committer</span><span class="history-details-value">${escapeHtml(
        d.committer.name
      )} &lt;${escapeHtml(d.committer.email)}&gt; on ${escapeHtml(
        formatHistoryDate(d.commitDate)
      )}</span></div>`
    : '';
  const parentsRow =
    d.parents.length > 0
      ? `<div class="history-details-row"><span class="history-details-label">Parent${
          d.parents.length > 1 ? 's' : ''
        }</span><span class="history-details-value history-details-hashes">${d.parents
          .map((p) => `<code>${escapeHtml(p)}</code>`)
          .join(' ')}</span></div>`
      : '';
  return `
    <div class="history-details-body">
      <div class="history-details-message">${message}</div>
      <div class="history-details-row">
        <span class="history-details-label">Author</span>
        <span class="history-details-value">${escapeHtml(d.authorName)} &lt;${escapeHtml(
          d.authorEmail
        )}&gt; on ${escapeHtml(authored)}</span>
      </div>
      ${committerRow}
      <div class="history-details-row">
        <span class="history-details-label">Hash</span>
        <span class="history-details-value history-details-hashes">
          <code>${escapeHtml(d.fullHash)}</code>
          <button type="button" class="history-details-copy" data-copy-hash="${escapeHtml(
            d.fullHash
          )}" title="Copy commit hash">Copy</button>
        </span>
      </div>
      ${parentsRow}
    </div>
  `;
}

/**
 * Format a commit timestamp for the details pane. Locale string keeps parity
 * with the date column in the revision list; falls back to an empty string for
 * a missing/invalid date rather than rendering `Invalid Date`.
 */
function formatHistoryDate(date: Date | undefined): string {
  if (!date) {
    return '';
  }
  const ms = date.getTime();
  if (Number.isNaN(ms)) {
    return '';
  }
  return date.toLocaleString();
}

/**
 * Map a {@link FileStatus} to the single-letter git status code shown in the
 * affected-paths badge — the same M/A/D/R/C/U vocabulary IntelliJ renders for a
 * commit's changed files.
 */
export function affectedPathStatusLabel(status: FileStatus): string {
  switch (status) {
    case 'modified':
      return 'M';
    case 'added':
      return 'A';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    case 'copied':
      return 'C';
    case 'untracked':
      return 'U';
    case 'ignored':
      return 'I';
    case 'conflicted':
      return 'U';
    default:
      return '?';
  }
}

/**
 * Render the "affected paths" pane — the list of files changed by the selected
 * revision. Mirrors IntelliJ's commit changed-files view
 * (`VcsLogChangesBrowser` / the file-history details pane). Read-only: scope is
 * to *show* the affected paths, not to diff or open them.
 */
export function renderAffectedPaths(state: IHistoryTabState): string {
  const body = renderAffectedPathsBody(state);
  return `
    <div class="history-affected" role="group" aria-label="Affected paths">
      <div class="history-affected-header">Affected Paths</div>
      ${body}
    </div>
  `;
}

function renderAffectedPathsBody(state: IHistoryTabState): string {
  if (state.affectedPathsError) {
    return `<div class="history-affected-error" role="alert">${escapeHtml(
      state.affectedPathsError
    )}</div>`;
  }
  if (state.affectedPathsLoading) {
    return `<div class="history-affected-empty">Loading changed files…</div>`;
  }
  if (state.affectedPaths.length === 0) {
    return `<div class="history-affected-empty" role="status">No changed files for this revision.</div>`;
  }
  const rows = state.affectedPaths.map(renderAffectedPathRow).join('');
  return `<div class="history-affected-list" role="list">${rows}</div>`;
}

function renderAffectedPathRow(file: IHistoryTabState['affectedPaths'][number]): string {
  const label = affectedPathStatusLabel(file.status);
  const status = escapeHtml(file.status);
  const pathHtml =
    file.oldPath && (file.status === 'renamed' || file.status === 'copied')
      ? `${escapeHtml(file.oldPath)} → ${escapeHtml(file.path)}`
      : escapeHtml(file.path);
  return `
    <div class="history-affected-row" role="listitem" title="${escapeHtml(file.path)}">
      <span class="history-affected-status history-affected-status-${status}">${escapeHtml(
        label
      )}</span>
      <span class="history-affected-path">${pathHtml}</span>
    </div>
  `;
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
    .history-bottom { display: flex; flex-direction: column; min-height: 0; max-height: 50%; border-top: 1px solid var(--vscode-panel-border, #3c3c3c); overflow: auto; }
    .history-details { display: flex; flex-direction: column; border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c); }
    .history-details-header { padding: 4px 8px; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); }
    .history-details-empty { padding: 8px; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
    .history-details-body { padding: 4px 8px 8px; display: flex; flex-direction: column; gap: 4px; }
    .history-details-message { white-space: pre-wrap; word-break: break-word; }
    .history-details-row { display: flex; gap: 8px; align-items: baseline; font-size: 0.9em; }
    .history-details-label { color: var(--vscode-descriptionForeground); min-width: 8ch; flex: 0 0 auto; }
    .history-details-value { color: var(--vscode-foreground); overflow-wrap: anywhere; }
    .history-details-hashes code { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-textLink-foreground, #3794ff); }
    .history-details-copy { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 0 6px; margin-left: 6px; cursor: pointer; font-size: 0.85em; }
    .history-affected { display: flex; flex-direction: column; min-height: 0; border-top: 1px solid var(--vscode-panel-border, #3c3c3c); }
    .history-affected-header { padding: 4px 8px; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); }
    .history-affected-list { flex: 1 1 auto; overflow: auto; }
    .history-affected-empty { padding: 8px; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
    .history-affected-error { padding: 6px 8px; background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,0.1)); color: var(--vscode-errorForeground, #f48771); }
    .history-affected-row { display: grid; grid-template-columns: 2ch minmax(0, 1fr); gap: 8px; align-items: baseline; padding: 1px 8px; }
    .history-affected-status { font-family: var(--vscode-editor-font-family, monospace); font-weight: 600; text-align: center; }
    .history-affected-status-added { color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); }
    .history-affected-status-modified { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
    .history-affected-status-deleted { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }
    .history-affected-status-renamed, .history-affected-status-copied { color: var(--vscode-gitDecoration-renamedResourceForeground, #73c991); }
    .history-affected-status-conflicted { color: var(--vscode-gitDecoration-conflictingResourceForeground, #e4676b); }
    .history-affected-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `;
}

/**
 * Behaviour script for the History tab. Binds clicks on the commit list,
 * toolbar toggles, and dropdown changes to postMessage calls.
 */
export function historyTabBehaviorScript(): string {
  return `
    (function () {
      const vscode = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : undefined;
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
