/**
 * Renders the HTML body for the Update Info tab in the Git tool window —
 * git4idea's post-Update-Project "Update Info" tree: per repository, the
 * branch that was updated, the strategy used, how many commits came in, and
 * the outcome (updated / up-to-date / conflict / error) with any detail.
 *
 * The summary is produced by {@link runUpdateProject} and held by
 * {@link UpdateInfoTab}; this renderer is the view. Style matches the other
 * minimal tab renderers (`renderIncomingTabBody`, `renderHistoryTabBody`).
 */

import { escapeHtml } from '../provider/htmlBuilders';
import { updateInfoHeadline } from '../tabs/UpdateInfoTab';
import type { IUpdateInfoTabState } from '../tabs/UpdateInfoTab';
import type { IUpdateRepoResult } from '../../../sync/updateProject';

/** Human label + CSS status class for a per-repo outcome. */
function statusLabel(status: IUpdateRepoResult['status']): { text: string; cls: string } {
  switch (status) {
    case 'updated':
      return { text: 'Updated', cls: 'updated' };
    case 'up-to-date':
      return { text: 'Up to date', cls: 'up-to-date' };
    case 'conflict':
      return { text: 'Conflict', cls: 'conflict' };
    case 'error':
      return { text: 'Error', cls: 'error' };
    case 'skipped':
      return { text: 'Skipped', cls: 'skipped' };
  }
}

/** One repository row in the update summary. */
function renderRepoRow(repo: IUpdateRepoResult): string {
  const status = statusLabel(repo.status);
  const branch = repo.branch ? escapeHtml(repo.branch) : '—';
  const strategy = repo.rebase ? 'Rebase' : 'Merge';
  const incoming = repo.incoming > 0 ? String(repo.incoming) : '—';
  const detail = repo.detail
    ? `<div class="update-info-detail">${escapeHtml(repo.detail)}</div>`
    : '';
  return `
    <div class="update-info-row" role="listitem">
      <div class="update-info-row-main">
        <span class="update-info-repo" title="${escapeHtml(repo.rootPath)}">${escapeHtml(repo.name)}</span>
        <span class="update-info-branch"><code>${branch}</code></span>
        <span class="update-info-strategy">${strategy}</span>
        <span class="update-info-incoming">${incoming}${repo.incoming > 0 ? ' in' : ''}</span>
        <span class="update-info-status update-info-status-${status.cls}">${status.text}</span>
      </div>
      ${detail}
    </div>`;
}

/**
 * Render the Update Info tab body.
 *
 * States:
 *  - no summary (before any run) → empty state.
 *  - summary present            → headline + per-repo rows.
 */
export function renderUpdateInfoTabBody(state?: IUpdateInfoTabState): string {
  const summary = state?.summary;
  if (!summary) {
    return `
    <div class="update-info-tab-body update-info-empty" role="status">
      <p class="update-info-empty-message">No update has run yet. Run <strong>Update Project</strong> to see the summary here.</p>
    </div>`;
  }

  const headline = escapeHtml(updateInfoHeadline(summary));
  const rows = summary.repos.map(renderRepoRow).join('');
  return `
    <div class="update-info-tab-body">
      <div class="update-info-headline" role="status">${headline}</div>
      <div class="update-info-list" role="list" aria-label="Update results per repository">
        ${rows}
      </div>
    </div>`;
}

/**
 * Scoped CSS for the Update Info tab. Emitted alongside the other tab styles
 * when the tabbed layout is on. Uses VS Code theme variables so it tracks the
 * active theme; status colors reuse the git-decoration tokens.
 */
export function updateInfoTabStyles(): string {
  return `
    .update-info-tab-body { padding: 8px 12px; font-size: var(--vscode-font-size); }
    .update-info-empty-message { color: var(--vscode-descriptionForeground); }
    .update-info-headline { font-weight: 600; margin-bottom: 8px; }
    .update-info-row {
      padding: 6px 4px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .update-info-row:last-child { border-bottom: none; }
    .update-info-row-main {
      display: flex;
      align-items: baseline;
      gap: 12px;
    }
    .update-info-repo { font-weight: 600; }
    .update-info-branch code { color: var(--vscode-textPreformat-foreground); }
    .update-info-strategy,
    .update-info-incoming {
      color: var(--vscode-descriptionForeground);
      font-size: 0.92em;
    }
    .update-info-status {
      margin-left: auto;
      font-size: 0.85em;
      padding: 1px 8px;
      border-radius: 8px;
    }
    .update-info-status-updated { color: var(--vscode-gitDecoration-addedResourceForeground); }
    .update-info-status-up-to-date { color: var(--vscode-descriptionForeground); }
    .update-info-status-skipped { color: var(--vscode-descriptionForeground); }
    .update-info-status-conflict { color: var(--vscode-gitDecoration-conflictingResourceForeground); }
    .update-info-status-error { color: var(--vscode-errorForeground); }
    .update-info-detail {
      margin-top: 3px;
      color: var(--vscode-errorForeground);
      font-size: 0.9em;
      white-space: pre-wrap;
    }
  `;
}
