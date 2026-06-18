import * as vscode from 'vscode';
import type { IGtwControllerContext } from './IGtwControllerContext';
import type { IChangedFile, ICommitDetails } from '../../../services/interfaces';
import { FileStatus } from '../../interfaces/IGitService';
import { FILE_STATUS_THEME_VARS, INTELLIJ_FILE_STATUS_COLORS } from '../GitToolWindowProvider';
import { buildFileTree, renderFileTree } from '../html/fileTree';
import { renderCommitMessageHtml } from '../../../utils/commitMessageHtml';

/**
 * Webview HTML view builders for the transient states the Git tool window
 * shows before the commit graph is ready: the loading spinner and the
 * no-repository prompt. Each returns a complete HTML document string,
 * reaching the per-render nonce and the shared inline stylesheet through the
 * controller context; the Content-Security-Policy source comes off the
 * passed webview.
 */

/**
 * The loading HTML shown while initial data is being fetched.
 */
export function buildLoadingHtml(ctx: IGtwControllerContext, webview: vscode.Webview): string {
  const nonce = ctx.getNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Git Tool Window</title>
  <style>
    ${ctx.getInlineStyles()}
    .loading-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      color: var(--vscode-descriptionForeground);
      font-size: 13px;
    }
    .loading-spinner-icon {
      font-size: 24px;
      animation: spin 1.5s linear infinite;
      margin-bottom: 12px;
    }
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="loading-container">
    <span class="loading-spinner-icon">&#x27F3;</span>
    <p>Loading git graph\u2026</p>
  </div>
</body>
</html>`;
}

/**
 * The HTML for the no-repository state. Displays a single prompt inviting the
 * user to initialize a repository.
 */
export function buildNoRepositoryHtml(ctx: IGtwControllerContext, webview: vscode.Webview): string {
  const nonce = ctx.getNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Git Tool Window</title>
  <style>
    ${ctx.getInlineStyles()}
  </style>
</head>
<body>
  <div class="no-repository">
    <p>No Git repository found in this workspace.</p>
    <button class="init-repo-button" id="init-repo-btn">Initialize Repository</button>
  </div>
  <script nonce="${nonce}">
    (function() {
      const vscode = acquireVsCodeApi();
      const btn = document.getElementById('init-repo-btn');
      if (btn) {
        btn.addEventListener('click', function() {
          vscode.postMessage({ type: 'initRepository' });
        });
      }
    })();
  </script>
</body>
</html>`;
}

/**
 * Escape HTML special characters
 */
export function escapeHtml(text: string): string {
  const htmlEscapes: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return text.replace(/[&<>"']/g, (char) => htmlEscapes[char]);
}

/**
 * Return a `var(--vscode-gitDecoration-*, #hex)` expression
 * for the given file status, so the colour follows the user's theme
 * (especially high-contrast) instead of the bare IntelliJ hex. The
 * Hex literal is retained as the CSS-var fallback (defence
 * in depth + dev-mode jsdom test surface). Pinned by
 * `fileStatusTheme-1..8` in detailsPanel.test.ts.
 */
export function getFileStatusColor(status: FileStatus): string {
  const cssVar = FILE_STATUS_THEME_VARS[status];
  const fallback = INTELLIJ_FILE_STATUS_COLORS[status] || '#FFFFFF';
  return cssVar ? `var(${cssVar}, ${fallback})` : fallback;
}

/**
 * Get status character for file status
 */
export function getFileStatusChar(status: FileStatus): string {
  const statusChars: Record<FileStatus, string> = {
    modified: 'M',
    added: 'A',
    deleted: 'D',
    renamed: 'R',
    copied: 'C',
    untracked: 'U',
    ignored: 'I',
    conflicted: '!',
  };
  return statusChars[status] || '?';
}

/**
 * Get file name from path
 */
export function getFileName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1];
}

/**
 * Merge changed files from multiple commit details into a single deduplicated list.
 * When the same file appears in multiple commits, the last occurrence's status is kept.
 * Files are sorted alphabetically by path.
 *
 * @param commitDetailsList - Array of commit details to merge files from
 * @returns Deduplicated and sorted array of changed files
 */
export function mergeChangedFiles(commitDetailsList: ICommitDetails[]): IChangedFile[] {
  const fileMap = new Map<string, IChangedFile>();

  for (const details of commitDetailsList) {
    for (const file of details.changedFiles) {
      // Later commits override earlier ones for the same path
      fileMap.set(file.path, { ...file });
    }
  }

  // Sort alphabetically by path
  return Array.from(fileMap.values()).sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Truncate message to specified length
 */
export function truncateMessage(message: string, maxLength: number): string {
  // Get first line only
  const firstLine = message.split('\n')[0];
  if (firstLine.length <= maxLength) {
    return firstLine;
  }
  return firstLine.substring(0, maxLength - 3) + '...';
}

/**
 * Get the commit context menu HTML overlay for the Graph Panel.
 * Renders a context menu with all 7 required options:
 * Copy Revision Number, Create Patch, Cherry-Pick, Checkout Revision,
 * Show Repository at Revision, Compare with Local, Reset Current Branch to Here,
 * Revert Commit, Undo Commit, Drop Commit, Edit Commit Message,
 * Merge into Current Branch, Interactively Rebase from Here.
 *
 * Section ordering mirrors git4idea's `Git.Log.ContextMenu` group
 * (intellij.vcs.git.backend.xml): inspect/copy utilities, then checkout &
 * compare, then the destructive trio (Reset / Revert / Undo) at the head of
 * the history block, then history-rewrite actions, then branch integration,
 * then Push-up-to-here, then graph navigation.
 *
 * The menu is hidden by default and shown on right-click via JS handlers.
 * The data-head-hash attribute stores the HEAD commit hash for disabled state logic.
 *
 * @returns HTML string for the commit context menu overlay
 */
export function buildCommitContextMenuHtml(ctx: IGtwControllerContext): string {
  const headHash =
    ctx.extendedLogState.commitNodes.length > 0
      ? ctx.extendedLogState.commitNodes[0].commit.hash
      : '';

  // \u2014 A2: items marked with `menu-multi-hidden` default to hidden;
  // the inline-script `updateContextMenuState` JS toggles the class based
  // on `selectedCount`. This keeps the visibility rules in one
  // declarative place rather than string-rebuilding the menu each time.
  //
  // Single-only items render the `data-multi-action="single-only"` data
  // attribute so the JS can locate them without hardcoding the action
  // list. Multi-only items get `data-multi-action="multi-only"`.
  return `
      <div id="commit-context-menu" class="commit-context-menu context-menu" hidden role="menu" aria-label="Commit actions" data-head-hash="${escapeHtml(headHash)}">
        <div class="context-menu-item" data-action="copyHash" role="menuitem" tabindex="0">Copy Revision Number</div>
        <div class="context-menu-item" data-action="copyCommitMessage" role="menuitem" tabindex="0">Copy Commit Message</div>
        <div class="context-menu-item" data-action="createPatch" role="menuitem" tabindex="0">Create Patch\u2026</div>
        <div class="context-menu-item" data-action="cherryPick" role="menuitem" tabindex="0">Cherry-Pick</div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" data-action="checkoutRevision" data-multi-action="single-only" role="menuitem" tabindex="0">Checkout Revision</div>
        <div class="context-menu-item" data-action="showRepoAtRevision" data-multi-action="single-only" role="menuitem" tabindex="0">Show Repository at Revision</div>
        <div class="context-menu-item" data-action="compareWithLocal" data-multi-action="single-only" role="menuitem" tabindex="0">Compare with Local</div>
        <div class="context-menu-item menu-multi-hidden" data-action="compareVersions" data-multi-action="multi-only" role="menuitem" tabindex="0">Compare Versions</div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item context-menu-danger" data-action="resetToHere" data-multi-action="single-only" role="menuitem" tabindex="0">Reset Current Branch to Here\u2026</div>
        <div class="context-menu-item" data-action="revert" role="menuitem" tabindex="0">Revert Commit</div>
        <div class="context-menu-item" data-action="undoCommit" data-multi-action="single-only" role="menuitem" tabindex="0">Undo Commit</div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" data-action="editCommitMessage" data-multi-action="single-only" role="menuitem" tabindex="0">Edit Commit Message</div>
        <div class="context-menu-item" data-action="fixupWithPrevious" data-multi-action="single-only" role="menuitem" tabindex="0">Fixup with Previous</div>
        <div class="context-menu-item" data-action="squashWithPrevious" data-multi-action="single-only" role="menuitem" tabindex="0">Squash with Previous</div>
        <div class="context-menu-item menu-multi-hidden" data-action="squashCommits" data-multi-action="multi-only" role="menuitem" tabindex="0">Squash Commits</div>
        <div class="context-menu-item context-menu-danger" data-action="dropCommit" role="menuitem" tabindex="0">Drop Commit</div>
        <div class="context-menu-item" data-action="interactiveRebase" data-multi-action="single-only" role="menuitem" tabindex="0">Interactively Rebase from Here\u2026</div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" data-action="compareWithBranch" data-multi-action="single-only" role="menuitem" tabindex="0">Compare with Branch\u2026</div>
        <div class="context-menu-item" data-action="mergeIntoCurrent" data-multi-action="single-only" role="menuitem" tabindex="0">Merge into Current Branch</div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" data-action="pushUpToCommit" data-multi-action="single-only" role="menuitem" tabindex="0">Push up to here\u2026</div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" data-action="goToParent" data-multi-action="single-only" role="menuitem" tabindex="0">Go to Parent</div>
        <div class="context-menu-item" data-action="goToChild" data-multi-action="single-only" role="menuitem" tabindex="0">Go to Child</div>
      </div>`;
}

/**
 * Get placeholder HTML for the Details Panel when no commit is selected.
 *
 * a placeholder message indicating that a commit should be selected.
 *
 * @returns HTML string for the placeholder state
 */
export function buildDetailsPanelPlaceholderHtml(): string {
  return `
      <div class="details-panel" role="region" aria-label="Commit Details">
        <div class="details-placeholder">
          <p class="placeholder-message">Select a commit to view details</p>
        </div>
      </div>`;
}

/**
 * Generate the Details Panel HTML for the 2-panel layout.
 *
 * Displays full commit metadata and a list of changed files with
 * IntelliJ-style color-coded status indicators.
 *
 * Commit metadata displayed:
 * - Commit message (and body if present)
 * - Full hash
 * - Author name and email
 * - Commit date-time
 * - Parent commit hashes
 *
 * Changed files list:
 * - Each file shows a color-coded status letter (M, A, D, R, etc.)
 * - File name and directory path are displayed separately
 * - Colors follow IntelliJ conventions via INTELLIJ_FILE_STATUS_COLORS
 *
 * @param commitDetails - The commit details data to render
 * @returns HTML string for the details panel content
 */
export function buildDetailsPanelHtml(
  ctx: IGtwControllerContext,
  commitDetails: ICommitDetails
): string {
  // --- Commit metadata section ---
  // Render the commit message and body with issue/PR references
  // converted to clickable links, gated by the
  // `intellig.commitMessageIssueLinks` config (default true).
  // When the flag is off, or when no remote URL is parseable for the
  // current repository, we fall back to pure HTML-escape as before.
  const issueLinksEnabled = ctx.isIssueLinkingEnabled();
  const remote = issueLinksEnabled ? ctx.getSelectedRepoRemote() : undefined;
  const escape = (s: string): string => escapeHtml(s);
  const messageHtml = issueLinksEnabled
    ? renderCommitMessageHtml(commitDetails.message, remote, escape)
    : escapeHtml(commitDetails.message);
  const bodyHtml = commitDetails.body
    ? issueLinksEnabled
      ? renderCommitMessageHtml(commitDetails.body, remote, escape)
      : escapeHtml(commitDetails.body)
    : '';
  const fullHash = escapeHtml(commitDetails.hash);
  const authorName = escapeHtml(commitDetails.author.name);
  const authorEmail = escapeHtml(commitDetails.author.email);
  const dateStr = commitDetails.date.toLocaleString();

  // Parent hashes
  const parentsHtml =
    commitDetails.parents.length > 0
      ? commitDetails.parents
          .map(
            (p) =>
              `<span class="parent-hash" data-parent-hash="${escapeHtml(p)}" title="${escapeHtml(p)}">${escapeHtml(p.substring(0, 7))}</span>`
          )
          .join(', ')
      : '<span class="no-parents">None (root commit)</span>';

  // --- Changed files section ---
  let changedFilesHtml: string;
  if (commitDetails.changedFilesError) {
    changedFilesHtml = `<p class="empty-message error-message">Failed to load changed files: ${escapeHtml(commitDetails.changedFilesError)}</p>`;
  } else if (commitDetails.changedFiles.length === 0) {
    changedFilesHtml = '<p class="empty-message">No changed files</p>';
  } else {
    changedFilesHtml = renderFileTree(buildFileTree(commitDetails.changedFiles), 0, {
      escapeHtml: (s) => escapeHtml(s),
      statusColor: (st) => getFileStatusColor(st),
      statusChar: (st) => getFileStatusChar(st),
      fileName: (p) => getFileName(p),
      commitHash: commitDetails.hash,
    });
  }

  return `
      <div class="details-panel" role="region" aria-label="Commit Details">
        <div class="details-changed-files">
          <h4>Changed Files (${commitDetails.changedFiles.length})</h4>
          <div class="changed-files-list" role="tree" aria-label="Changed Files">
            ${changedFilesHtml}
          </div>
        </div>
        <div class="details-metadata">
          <div class="detail-row message-row">
            <span class="detail-label">Message:</span>
            <pre class="detail-value commit-full-message">${messageHtml}${bodyHtml ? '\n\n' + bodyHtml : ''}</pre>
          </div>
          <div class="detail-row">
            <span class="detail-label">Hash:</span>
            <span class="detail-value hash-value" data-copy-text="${fullHash}" title="Click to copy">${fullHash}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Author:</span>
            <span class="detail-value">${authorName} &lt;${authorEmail}&gt;</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Date:</span>
            <span class="detail-value">${dateStr}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Parents:</span>
            <span class="detail-value">${parentsHtml}</span>
          </div>
        </div>
      </div>`;
}

/**
 * Generate HTML for the Details Panel when multiple commits are selected.
 * Displays a header showing how many commits are selected, a list of selected
 * commit hashes/messages, and the combined changed files list with IntelliJ-style
 * color coding.
 *
 * The combined changed files are computed by merging the changed files from all
 * selected commits, deduplicating by path and keeping the most recent status.
 *
 * display the combined changes across all selected commits.
 *
 * @param commitDetailsList - Array of commit details for the selected commits
 * @param combinedChangedFiles - Optional pre-computed combined changed files
 *   (e.g., from GitService.getMultiCommitDiff()). If not provided, the method
 *   merges changed files from the individual commit details.
 * @returns HTML string for the multi-commit details panel
 */
export function buildMultiCommitDetailsPanelHtml(
  commitDetailsList: ICommitDetails[],
  combinedChangedFiles?: IChangedFile[]
): string {
  const commitCount = commitDetailsList.length;

  // --- Header section: "N commits selected" ---
  const headerHtml = `<h3 class="multi-commit-header">${commitCount} commit${commitCount !== 1 ? 's' : ''} selected</h3>`;

  // --- Selected commits list ---
  const commitsListHtml = commitDetailsList
    .map((details) => {
      const shortHash = escapeHtml(details.hash.substring(0, 7));
      const message = escapeHtml(truncateMessage(details.message, 60));
      return `
          <div class="multi-commit-item" role="listitem">
            <span class="commit-short-hash">${shortHash}</span>
            <span class="commit-summary">${message}</span>
          </div>`;
    })
    .join('');

  // --- Combined changed files ---
  // Use pre-computed combined files if provided, otherwise merge from individual commits
  const mergedFiles = combinedChangedFiles ?? mergeChangedFiles(commitDetailsList);

  let changedFilesHtml: string;
  if (mergedFiles.length === 0) {
    changedFilesHtml = '<p class="empty-message">No changed files</p>';
  } else {
    changedFilesHtml = renderFileTree(buildFileTree(mergedFiles), 0, {
      escapeHtml: (s) => escapeHtml(s),
      statusColor: (st) => getFileStatusColor(st),
      statusChar: (st) => getFileStatusChar(st),
      fileName: (p) => getFileName(p),
    });
  }

  return `
      <div class="details-panel multi-commit-details" role="region" aria-label="Multi-Commit Details" data-selected-count="${commitCount}">
        ${headerHtml}
        <div class="multi-commit-list" role="list" aria-label="Selected Commits">
          ${commitsListHtml}
        </div>
        <div class="details-changed-files">
          <h4>Changed Files (${mergedFiles.length})</h4>
          <div class="changed-files-list" role="tree" aria-label="Changed Files">
            ${changedFilesHtml}
          </div>
        </div>
      </div>`;
}
