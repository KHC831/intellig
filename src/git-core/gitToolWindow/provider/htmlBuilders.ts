import * as vscode from 'vscode';
import type { IGtwControllerContext } from './IGtwControllerContext';

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
