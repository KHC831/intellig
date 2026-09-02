/**
 * Stylesheet for the Commit Tool Window webview, split out of
 * {@link import('./CommitToolWindow').CommitToolWindow} so the panel file holds
 * behaviour and the presentation lives on its own (mirrors
 * {@link import('./commitDialogStyles')}).
 */

import { contextMenuStyles } from '../webview-common/contextMenuStyles';

export function commitToolWindowStyles(): string {
  return `
    ${contextMenuStyles()}
    /* No background: VS Code's injected _defaultStyles paints the webview body
       transparent, so it composites over whatever container hosts the view. Naming
       any surface token here overrides that (an unlayered author rule beats
       @layer vscode-default) and hard-codes one container. */
    body { margin: 0; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); }
    .ctw-tab-strip { display: flex; align-items: center; border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c); padding: 0 4px; }
    .ctw-tab { background: transparent; border: none; border-bottom: 2px solid transparent; padding: 6px 12px; color: inherit; font: inherit; cursor: pointer; }
    .ctw-tab:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
    .ctw-tab-active { border-bottom-color: var(--vscode-focusBorder, #0078d4); font-weight: 600; }
    .ctw-tab-spacer { flex: 1; }
    .ctw-gear { background: transparent; border: none; color: inherit; cursor: pointer; padding: 4px 8px; }
    .ctw-gear-wrap { position: relative; }
    .ctw-gear-menu { position: absolute; right: 0; top: 100%; background: var(--vscode-menu-background, #252526); border: 1px solid var(--vscode-menu-border, #454545); box-shadow: 0 4px 8px rgba(0,0,0,0.4); min-width: 220px; z-index: 10; }
    .ctw-gear-item { display: block; width: 100%; text-align: left; background: transparent; border: none; padding: 6px 12px; color: var(--vscode-disabledForeground, #888); cursor: not-allowed; }
    .ctw-body { display: flex; flex-direction: column; height: calc(100vh - 32px); }
    .ctw-panel { flex: 1 1 auto; flex-direction: column; overflow: auto; }
    .ctw-empty { padding: 16px; color: var(--vscode-descriptionForeground); }
    .ctw-changelist-tree { padding: 4px 0; }
    .ctw-changelist-row { display: flex; align-items: center; padding: 2px 8px; font-weight: 600; cursor: pointer; user-select: none; }
    .ctw-chevron { margin-right: 4px; }
    .ctw-changelist-name { flex: 1; }
    .ctw-changelist-active { font-style: italic; }
    .ctw-active-tag { color: var(--vscode-descriptionForeground); font-weight: normal; }
    .ctw-count { color: var(--vscode-descriptionForeground); font-weight: normal; font-size: 0.9em; }
    .ctw-file-row { display: flex; align-items: center; padding: 1px 8px 1px 28px; cursor: pointer; user-select: none; }
    .ctw-file-row:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.15)); }
    .ctw-file-status { width: 18px; color: var(--vscode-gitDecoration-modifiedResourceForeground); font-family: var(--vscode-editor-font-family, monospace); }
    .ctw-conflicts-block { margin-bottom: 2px; }
    .ctw-conflicts-row { display: flex; align-items: center; gap: 6px; padding: 2px 8px; font-weight: 600; user-select: none; }
    .ctw-conflicts-name { color: var(--vscode-gitDecoration-conflictingResourceForeground); }
    .ctw-conflicts-resolve { background: transparent; border: none; padding: 0; font: inherit; font-weight: 600; cursor: pointer; color: var(--vscode-textLink-foreground); }
    .ctw-conflicts-resolve:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
    .ctw-file-conflicted .ctw-file-path { color: var(--vscode-gitDecoration-conflictingResourceForeground); }
    .ctw-file-conflicted .ctw-file-status { color: var(--vscode-gitDecoration-conflictingResourceForeground); }
    .ctw-file-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ctw-file-conflict-count { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 0.85em; white-space: nowrap; }
    .ctw-file-resolve { margin-left: auto; flex: none; background: transparent; border: 1px solid var(--vscode-button-border, var(--vscode-textLink-foreground)); border-radius: 3px; padding: 0 6px; font: inherit; font-size: 0.85em; cursor: pointer; color: var(--vscode-textLink-foreground); }
    .ctw-file-conflict-count + .ctw-file-resolve { margin-left: 8px; }
    .ctw-file-resolve:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.2)); color: var(--vscode-textLink-activeForeground); }
    .ctw-grouping { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c); }
    .ctw-grouping-label { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-right: 4px; }
    .ctw-grouping-btn { background: transparent; border: 1px solid transparent; color: inherit; padding: 2px 10px; cursor: pointer; font: inherit; border-radius: 3px; }
    .ctw-grouping-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
    .ctw-grouping-active { background: var(--vscode-inputOption-activeBackground, rgba(100,150,220,0.25)); border-color: var(--vscode-inputOption-activeBorder, var(--vscode-focusBorder, #0078d4)); }
    .ctw-dir-row { display: flex; align-items: center; padding: 1px 8px 1px 20px; color: var(--vscode-descriptionForeground); font-size: 0.9em; user-select: none; }
    .ctw-dir-chevron { margin-right: 4px; }
    .ctw-dir-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ctw-dir-group .ctw-file-row { padding-left: 40px; }
    .ctw-diff-preview { border-top: 1px solid var(--vscode-panel-border, #3c3c3c); max-height: 40%; overflow: auto; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.92em; }
    .ctw-diff-preview-empty { padding: 12px; color: var(--vscode-descriptionForeground); text-align: center; }
    .ctw-diff-preview-head { padding: 4px 8px; font-weight: 600; border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c); }
    .ctw-diff-preview-body { margin: 0; padding: 4px 8px; white-space: pre; }
    .ctw-diff-hunk-header { color: var(--vscode-descriptionForeground); }
    .ctw-diff-line { white-space: pre; }
    .ctw-diff-add { background: var(--vscode-diffEditor-insertedLineBackground, rgba(155,185,85,0.2)); }
    .ctw-diff-del { background: var(--vscode-diffEditor-removedLineBackground, rgba(255,0,0,0.2)); }
    .ctw-shelf-list { padding: 4px 0; }
    .ctw-shelf-row { display: flex; align-items: center; padding: 4px 8px; cursor: pointer; gap: 6px; }
    .ctw-shelf-row:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.15)); }
    .ctw-shelf-badge { width: 20px; text-align: center; opacity: 0.85; font-size: 0.95em; }
    .ctw-shelf-name { flex: 1; }
    .ctw-shelf-count { color: var(--vscode-descriptionForeground); font-size: 0.9em; font-family: var(--vscode-editor-font-family, monospace); }
    .ctw-shelf-alreadyUnshelved { color: var(--vscode-descriptionForeground); font-size: 0.85em; font-style: italic; margin-left: 4px; }
    .ctw-shelf-filter { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c); }
    .ctw-shelf-filter-label { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-right: 4px; }
    .ctw-shelf-filter-btn { background: transparent; border: 1px solid transparent; color: inherit; padding: 2px 10px; cursor: pointer; font: inherit; border-radius: 3px; }
    .ctw-shelf-filter-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
    .ctw-shelf-filter-active { background: var(--vscode-inputOption-activeBackground, rgba(100,150,220,0.25)); border-color: var(--vscode-inputOption-activeBorder, var(--vscode-focusBorder, #0078d4)); }
    .ctw-composer { border-top: 1px solid var(--vscode-panel-border, #3c3c3c); padding: 8px; display: flex; flex-direction: column; gap: 6px; }
    .ctw-composer-row { display: flex; gap: 4px; }
    .ctw-composer-msg { flex: 1; min-height: 60px; resize: vertical; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 4px 6px; font: inherit; }
    .ctw-composer-options { display: flex; gap: 16px; }
    .ctw-composer-actions { display: flex; justify-content: flex-end; position: relative; }
    .ctw-primary-group { display: flex; }
    .ctw-btn-commit, .ctw-btn-commit-dropdown, .ctw-btn-commit-and-push { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 12px; cursor: pointer; }
    .ctw-btn-commit-dropdown { border-left: 1px solid var(--vscode-button-separator, rgba(0,0,0,0.2)); padding: 4px 6px; }
    .ctw-primary-menu { position: absolute; right: 0; bottom: 100%; background: var(--vscode-menu-background); border: 1px solid var(--vscode-menu-border); min-width: 180px; z-index: 10; }
  `;
}
