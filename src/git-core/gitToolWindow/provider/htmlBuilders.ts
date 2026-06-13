import * as vscode from 'vscode';
import type { IGtwControllerContext } from './IGtwControllerContext';
import type { IChangedFile, ICommitDetails } from '../../../services/interfaces';
import { FileStatus } from '../../interfaces/IGitService';
import { FILE_STATUS_THEME_VARS, INTELLIJ_FILE_STATUS_COLORS } from '../GitToolWindowProvider';

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
 * Escape HTML special characters.
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
 * Get status character for file status.
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
 * Get file name from path.
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
 * Truncate message to specified length.
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
 * Items are organized into four sections separated by dividers:
 * Navigation & Inspection, Branch Operations, History Manipulation, Merge & Integration.
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
        <div class="context-menu-item" data-action="createPatch" role="menuitem" tabindex="0">Create Patch\u2026</div>
        <div class="context-menu-item" data-action="cherryPick" role="menuitem" tabindex="0">Cherry-Pick</div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" data-action="checkoutRevision" data-multi-action="single-only" role="menuitem" tabindex="0">Checkout Revision</div>
        <div class="context-menu-item" data-action="showRepoAtRevision" data-multi-action="single-only" role="menuitem" tabindex="0">Show Repository at Revision</div>
        <div class="context-menu-item" data-action="compareWithLocal" data-multi-action="single-only" role="menuitem" tabindex="0">Compare with Local</div>
        <div class="context-menu-item menu-multi-hidden" data-action="compareVersions" data-multi-action="multi-only" role="menuitem" tabindex="0">Compare Versions</div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" data-action="editCommitMessage" data-multi-action="single-only" role="menuitem" tabindex="0">Edit Commit Message</div>
        <div class="context-menu-item context-menu-danger" data-action="resetToHere" data-multi-action="single-only" role="menuitem" tabindex="0">Reset Current Branch to Here\u2026</div>
        <div class="context-menu-item" data-action="revert" role="menuitem" tabindex="0">Revert Commit</div>
        <div class="context-menu-item" data-action="undoCommit" data-multi-action="single-only" role="menuitem" tabindex="0">Undo Commit</div>
        <div class="context-menu-item context-menu-danger" data-action="dropCommit" role="menuitem" tabindex="0">Drop Commit</div>
        <div class="context-menu-item menu-multi-hidden" data-action="squashCommits" data-multi-action="multi-only" role="menuitem" tabindex="0">Squash Commits</div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" data-action="squashWithPrevious" data-multi-action="single-only" role="menuitem" tabindex="0">Squash with Previous</div>
        <div class="context-menu-item" data-action="fixupWithPrevious" data-multi-action="single-only" role="menuitem" tabindex="0">Fixup with Previous</div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" data-action="compareWithBranch" data-multi-action="single-only" role="menuitem" tabindex="0">Compare with Branch\u2026</div>
        <div class="context-menu-item" data-action="mergeIntoCurrent" data-multi-action="single-only" role="menuitem" tabindex="0">Merge into Current Branch</div>
        <div class="context-menu-item" data-action="interactiveRebase" data-multi-action="single-only" role="menuitem" tabindex="0">Interactively Rebase from Here\u2026</div>
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
