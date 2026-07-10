import * as vscode from 'vscode';
import type { IGtwControllerContext } from './IGtwControllerContext';
import type { IChangedFile, ICommitDetails } from '../../../services/interfaces';
import { FileStatus } from '../../interfaces/IGitService';
import { FILE_STATUS_THEME_VARS, INTELLIJ_FILE_STATUS_COLORS } from '../GitToolWindowProvider';
import { escapeHtml } from '../../../utils/escapeHtml';

export { escapeHtml };

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
 * Get the commit context menu HTML overlay for the Graph Panel.
 * Renders a context menu with all 7 required options:
 * Copy Revision Number, Create Patch, Cherry-Pick, Checkout Revision,
 * Show Repository at Revision, Compare with Local, Reset Current Branch to Here,
 * Revert Commit, Undo Commit, Drop Commit, Edit Commit Message…,
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

  // Menu-item visibility and enabled state are host-computed (ADR-009): the
  // host calls computeMenuState (multiSelect.ts) for the current selection and
  // posts the per-action (visible, enabled) map; the inline-script
  // applyMenuEnableMap toggles `menu-multi-hidden` / `disabled` per row keyed
  // on `data-action`. Every `data-action` here MUST be a member of
  // MultiSelectMenuAction \u2014 an unknown action falls back to visible+enabled, so
  // a missing entry silently leaves the row clickable in multi-select
  // (menuActionParity.test.ts pins data-action \u2286 computeMenuVisibility keys).
  // `menu-multi-hidden` is the default-hidden class for multi-only rows.
  return `
      <div id="commit-context-menu" class="commit-context-menu context-menu" hidden role="menu" aria-label="Commit actions" data-head-hash="${escapeHtml(headHash)}">
        <div class="context-menu-item" data-action="copyHash" role="menuitem" tabindex="0">Copy Revision Number</div>
        <div class="context-menu-item" data-action="createPatch" role="menuitem" tabindex="0">Create Patch\u2026</div>
        <div class="context-menu-item" data-action="cherryPick" role="menuitem" tabindex="0">Cherry-Pick</div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" data-action="checkoutRevision" role="menuitem" tabindex="0">Checkout Revision</div>
        <div class="context-menu-item" data-action="showRepoAtRevision" role="menuitem" tabindex="0">Show Repository at Revision</div>
        <div class="context-menu-item" data-action="compareWithLocal" role="menuitem" tabindex="0">Compare with Local</div>
        <div class="context-menu-item menu-multi-hidden" data-action="compareVersions" role="menuitem" tabindex="0">Compare Versions</div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item context-menu-danger" data-action="resetToHere" role="menuitem" tabindex="0">Reset Current Branch to Here\u2026</div>
        <div class="context-menu-item" data-action="revert" role="menuitem" tabindex="0">Revert Commit</div>
        <div class="context-menu-item" data-action="undoCommit" role="menuitem" tabindex="0">Undo Commit</div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" data-action="editCommitMessage" role="menuitem" tabindex="0">Edit Commit Message\u2026</div>
        <div class="context-menu-item" data-action="fixup" role="menuitem" tabindex="0">Fixup\u2026</div>
        <div class="context-menu-item" data-action="squashInto" role="menuitem" tabindex="0">Squash Into\u2026</div>
        <div class="context-menu-item menu-multi-hidden" data-action="squashCommits" role="menuitem" tabindex="0">Squash Commits</div>
        <div class="context-menu-item context-menu-danger" data-action="dropCommit" role="menuitem" tabindex="0">Drop Commit</div>
        <div class="context-menu-item" data-action="interactiveRebase" role="menuitem" tabindex="0">Interactively Rebase from Here\u2026</div>
        <div class="context-menu-item" data-action="pushUpToCommit" role="menuitem" tabindex="0">Push All up to Here\u2026</div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" data-action="newBranch" role="menuitem" tabindex="0">New Branch\u2026</div>
        <div class="context-menu-item" data-action="newTag" role="menuitem" tabindex="0">New Tag\u2026</div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" data-action="goToChild" role="menuitem" tabindex="0">Go to Child Commit</div>
        <div class="context-menu-item" data-action="goToParent" role="menuitem" tabindex="0">Go to Parent Commit</div>
      </div>`;
}
