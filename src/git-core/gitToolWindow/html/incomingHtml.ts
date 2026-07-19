/**
 * Renders the HTML body for the Incoming tab in the Git tool window.
 *
 * Replaces the placeholder stub with a real list of incoming commits
 * sourced from {@link IIncomingTabState}. The renderer is intentionally
 * simple (no full graph): it shows a commit list with short hash, author,
 * date, and subject, matching the style of the other minimal tab renderers
 * (`renderHistoryTabBody`, `renderUpdateInfoTabBody`).
 */

import { escapeHtml } from '../provider/htmlBuilders';
import type { IIncomingTabState } from '../tabs/IncomingTab';
import type { ICommit } from '../../interfaces/IGitService';

/**
 * Render a short absolute date from a Date object (YYYY-MM-DD).
 */
function renderDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Render a single commit row for the incoming list.
 */
function renderCommitRow(commit: ICommit): string {
  const shortHash = escapeHtml(commit.hash.slice(0, 7));
  const author = escapeHtml(commit.author.name);
  const date = escapeHtml(renderDate(commit.authorDate));
  const subject = escapeHtml(commit.message.split('\n')[0]);
  return `
    <div class="incoming-commit-row" data-hash="${escapeHtml(commit.hash)}" role="listitem">
      <span class="incoming-commit-hash">${shortHash}</span>
      <span class="incoming-commit-subject">${subject}</span>
      <span class="incoming-commit-author">${author}</span>
      <span class="incoming-commit-date">${date}</span>
    </div>`;
}

/**
 * Render the Incoming tab body.
 *
 * States (in priority order):
 *  - `state === undefined`    → safe fallback (same as initial/no-data)
 *  - `state.loading`          → loading indicator
 *  - `state.error`            → error message
 *  - `state.noUpstream`       → no upstream configured
 *  - `commits.length === 0`   → up to date
 *  - `commits.length > 0`     → commit list (hash, author, date, subject)
 */
export function renderIncomingTabBody(state?: IIncomingTabState): string {
  if (!state || state.loading) {
    return `
    <div class="incoming-tab-body incoming-loading" role="status" aria-live="polite">
      <span class="incoming-spinner">Loading incoming commits…</span>
    </div>`;
  }

  if (state.error) {
    return `
    <div class="incoming-tab-body incoming-error" role="alert">
      <p class="incoming-error-message">${escapeHtml(state.error)}</p>
    </div>`;
  }

  if (state.noUpstream) {
    const branch = state.branch ? escapeHtml(state.branch) : 'current branch';
    return `
    <div class="incoming-tab-body incoming-no-upstream" role="status">
      <p class="incoming-no-upstream-message">
        No upstream tracking branch configured for <code>${branch}</code>.
        Set a remote upstream to see incoming commits.
      </p>
    </div>`;
  }

  if (state.commits.length === 0) {
    const upstream = state.upstream ? escapeHtml(state.upstream) : 'upstream';
    return `
    <div class="incoming-tab-body incoming-up-to-date" role="status">
      <p class="incoming-up-to-date-message">Up to date with <code>${upstream}</code>. No incoming commits.</p>
    </div>`;
  }

  const rows = state.commits.map(renderCommitRow).join('');
  const count = state.commits.length;
  const upstream = state.upstream ? escapeHtml(state.upstream) : 'upstream';
  return `
    <div class="incoming-tab-body">
      <div class="incoming-header">
        <span class="incoming-count">${count} incoming commit${count === 1 ? '' : 's'} from <code>${upstream}</code></span>
      </div>
      <div class="incoming-commit-list" role="list" aria-label="Incoming commits">
        ${rows}
      </div>
    </div>`;
}

/**
 * Styles for the Incoming tab body. Folded into the tool window's extraStyles
 * alongside the sibling tab stylesheets; the row grid mirrors the History
 * tab's so the two lists read as the same control.
 */
export function incomingTabStyles(): string {
  return `
    .incoming-tab-body { display: flex; flex-direction: column; height: 100%; min-height: 0; }
    .incoming-header { padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c); }
    .incoming-count { color: var(--vscode-descriptionForeground); }
    .incoming-loading, .incoming-up-to-date, .incoming-no-upstream { padding: 16px; color: var(--vscode-descriptionForeground); }
    .incoming-spinner { font-style: italic; }
    .incoming-up-to-date-message, .incoming-no-upstream-message { margin: 0; }
    .incoming-error { padding: 6px 8px; background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,0.1)); color: var(--vscode-errorForeground, #f48771); }
    .incoming-error-message { margin: 0; }
    .incoming-commit-list { flex: 1 1 auto; overflow: auto; }
    .incoming-commit-row { display: grid; grid-template-columns: 7ch minmax(0, 1fr) minmax(0, 14ch) minmax(0, 10ch); gap: 8px; padding: 2px 8px; cursor: pointer; align-items: center; }
    .incoming-commit-row:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.15)); }
    .incoming-commit-row.incoming-selected { background: var(--vscode-list-activeSelectionBackground, rgba(14,99,156,0.5)); color: var(--vscode-list-activeSelectionForeground); }
    .incoming-commit-hash { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-textLink-foreground, #3794ff); }
    .incoming-commit-subject { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .incoming-commit-author, .incoming-commit-date { color: var(--vscode-descriptionForeground); font-size: 0.9em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  `;
}
