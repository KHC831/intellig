/**
 * T2-07 — History tab HTML.
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
  return `
    <div class="history-tab">
      ${header}
      ${toolbar}
      ${error}
      ${list}
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
  const rows = state.commits.map((commit) => renderCommitRow(commit, state)).join('');
  return `<div class="history-commit-list" role="list">${rows}</div>`;
}

function renderCommitRow(commit: ICommit, state: IHistoryTabState): string {
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
      <span class="history-commit-hash">${escapeHtml(commit.shortHash ?? commit.hash.substring(0, 7))}</span>
      <span class="history-commit-subject">${subject}</span>
      <span class="history-commit-author">${author}</span>
      <span class="history-commit-date">${escapeHtml(date)}</span>
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
    .history-commit-row { display: grid; grid-template-columns: 7ch 1fr 14ch 10ch; gap: 8px; padding: 2px 8px; cursor: pointer; }
    .history-commit-row:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.15)); }
    .history-commit-row.history-selected { background: var(--vscode-list-activeSelectionBackground, rgba(14,99,156,0.5)); color: var(--vscode-list-activeSelectionForeground); }
    .history-commit-row.history-compare { outline: 1px dashed var(--vscode-focusBorder, #0078d4); outline-offset: -2px; }
    .history-commit-hash { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-textLink-foreground, #3794ff); }
    .history-commit-author, .history-commit-date { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
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
