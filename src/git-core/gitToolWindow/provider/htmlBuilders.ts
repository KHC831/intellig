import * as vscode from 'vscode';
import type { IGtwControllerContext } from './IGtwControllerContext';
import type { IChangedFile, ICommitDetails } from '../../../services/interfaces';
import { FileStatus } from '../../interfaces/IGitService';
import { FILE_STATUS_THEME_VARS, INTELLIJ_FILE_STATUS_COLORS } from './fileStatusTheme';
import { escapeHtml } from '../../../utils/escapeHtml';
import { buildWebviewCsp } from '../../../utils/webviewCsp';

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
 * Shared document envelope for the tool window's static, pre-graph documents
 * (loading, no-repository, undocked placeholder): one copy of the CSP meta tag
 * and head boilerplate so the policy cannot drift between the builders. When
 * `bundle` is set the document loads the same external `gitToolWindow.js` entry
 * the graph document does (nonce-authorized `src`, no CSP change) — the entry
 * no-ops on the panels these documents lack and wires their action buttons
 * (init-repo / focus-undocked). Client JS ships as the bundle, never inline.
 */
function buildStaticDocumentHtml(
  ctx: IGtwControllerContext,
  webview: vscode.Webview,
  parts: { styles: string; body: string; bundle?: boolean }
): string {
  const nonce = ctx.getNonce();
  const scriptTag = parts.bundle
    ? `\n  <script nonce="${nonce}" src="${ctx.getWebviewBundleUri(webview)}"></script>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${buildWebviewCsp(webview.cspSource, nonce, { images: false, fonts: false })}">
  <title>Git Tool Window</title>
  <style>
    ${parts.styles}
  </style>
</head>
<body>
  ${parts.body}${scriptTag}
</body>
</html>`;
}

/**
 * The loading HTML shown while initial data is being fetched.
 */
export function buildLoadingHtml(ctx: IGtwControllerContext, webview: vscode.Webview): string {
  return buildStaticDocumentHtml(ctx, webview, {
    styles: `${ctx.getInlineStyles()}
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
    }`,
    body: `<div class="loading-container">
    <span class="loading-spinner-icon">&#x27F3;</span>
    <p>Loading git graph\u2026</p>
  </div>`,
  });
}

/**
 * The HTML the SIDEBAR view shows while the log is undocked into an editor
 * tab. The provider keeps a single live follower webview, so the sidebar gets
 * this placeholder instead of a second copy of the document; the button asks
 * the host to reveal the panel.
 */
export function buildUndockedPlaceholderHtml(
  ctx: IGtwControllerContext,
  webview: vscode.Webview
): string {
  return buildStaticDocumentHtml(ctx, webview, {
    styles: `.undocked-placeholder {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      gap: 12px;
      color: var(--vscode-descriptionForeground);
      font-size: 13px;
      text-align: center;
      padding: 0 16px;
    }
    .undocked-placeholder button {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: none;
      padding: 6px 14px;
      border-radius: 2px;
      cursor: pointer;
    }
    .undocked-placeholder button:hover {
      background: var(--vscode-button-hoverBackground);
    }`,
    body: `<div class="undocked-placeholder">
    <p>The Git log is open as an editor tab. Close the tab to dock it back here.</p>
    <button id="focus-undocked-panel">Show Editor Tab</button>
  </div>`,
    bundle: true,
  });
}

/**
 * The HTML for the no-repository state. Displays a single prompt inviting the
 * user to initialize a repository.
 */
export function buildNoRepositoryHtml(ctx: IGtwControllerContext, webview: vscode.Webview): string {
  return buildStaticDocumentHtml(ctx, webview, {
    styles: ctx.getInlineStyles(),
    body: `<div class="no-repository">
    <p>No Git repository found in this workspace.</p>
    <button class="init-repo-button" id="init-repo-btn">Initialize Repository</button>
  </div>`,
    bundle: true,
  });
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
 * Merge changed files from multiple commit details into a single deduplicated
 * list, sorted alphabetically by path.
 *
 * `commitDetailsList` arrives in graph order — NEWEST FIRST — and a path
 * touched by several of the selected commits gets one row, owned by the newest
 * commit that touched it. That is the selection's latest state of the file: a
 * path the newest commit deleted and an older one added is deleted, and showing
 * the add would report the opposite of what the selection did while offering a
 * diff of a change that was undone.
 *
 * Each entry names the commit its record came from, so the row can be diffed
 * and right-clicked against the same commit whose status it displays.
 *
 * @param commitDetailsList - Commit details to merge files from, newest first
 * @returns Deduplicated and sorted array of changed files
 */
export function mergeChangedFiles(
  commitDetailsList: ICommitDetails[]
): Array<IChangedFile & { commitHash: string }> {
  const fileMap = new Map<string, IChangedFile & { commitHash: string }>();

  for (const details of commitDetailsList) {
    for (const file of details.changedFiles) {
      // Newest first, so the first entry for a path is the one that wins;
      // later (older) commits do not overwrite it.
      if (!fileMap.has(file.path)) {
        fileMap.set(file.path, { ...file, commitHash: details.hash });
      }
    }
  }

  // Sort alphabetically by path
  return Array.from(fileMap.values()).sort((a, b) => a.path.localeCompare(b.path));
}
