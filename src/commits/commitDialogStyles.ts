/**
 * The commit dialog's stylesheet.
 *
 * Inlined into a `<style>` block by `CommitDialog._getHtmlContent`, which is
 * the only thing that renders it. Takes no arguments and reads no dialog
 * state: every rule is static, and the dynamic parts of the dialog reach the
 * DOM as element properties from the data-init island instead.
 */
export function commitDialogStyles(): string {
  return `
    :root {
      --vscode-font-family: var(--vscode-editor-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
      --vscode-font-size: var(--vscode-editor-font-size, 13px);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      padding: 0;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
    }

    .commit-dialog {
      display: flex;
      flex-direction: column;
      height: 100vh;
      padding: 12px;
    }

    .commit-main {
      display: flex;
      flex: 1;
      gap: 12px;
      min-height: 0;
    }

    .commit-left {
      display: flex;
      flex-direction: column;
      width: 40%;
      min-width: 300px;
      gap: 12px;
    }

    .commit-right {
      flex: 1;
      min-width: 0;
    }

    .section {
      display: flex;
      flex-direction: column;
      background-color: var(--vscode-sideBar-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      overflow: hidden;
    }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      background-color: var(--vscode-sideBarSectionHeader-background);
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .section-title {
      font-weight: 600;
      font-size: 12px;
      text-transform: uppercase;
      color: var(--vscode-sideBarSectionHeader-foreground);
    }

    .message-section {
      flex-shrink: 0;
    }

    .commit-message-input {
      width: 100%;
      min-height: 100px;
      padding: 8px;
      border: none;
      background-color: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      resize: vertical;
    }

    .commit-message-input:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }

    .commit-message-input::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }

    /* section-header-actions ─────────────────────────────────────────── */
    .section-header-actions {
      display: inline-flex;
      gap: 4px;
    }
    .header-action-button {
      min-width: 22px;
      height: 22px;
      padding: 0 6px;
      border: 1px solid transparent;
      background: transparent;
      color: var(--vscode-foreground);
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
    }
    .header-action-button:hover:not(:disabled) {
      background: var(--vscode-toolbar-hoverBackground);
      border-color: var(--vscode-focusBorder);
    }
    .header-action-button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .author-section {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 8px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .author-label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .author-input {
      width: 100%;
      padding: 4px 6px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .author-input:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }
    .author-error {
      color: var(--vscode-errorForeground);
      font-size: 11px;
    }
    .no-verify-badge {
      padding: 6px 8px;
      font-size: 11px;
      color: var(--vscode-editorWarning-foreground);
      background: var(--vscode-inputValidation-warningBackground, transparent);
      border-top: 1px solid var(--vscode-panel-border);
    }
    /* ─── end section-header-actions ──────────────────────────────────── */

    .files-section {
      flex: 1;
      min-height: 150px;
    }

    .files-list {
      flex: 1;
      overflow-y: auto;
      padding: 4px;
    }

    .file-group {
      margin-bottom: 8px;
    }

    .file-group-header {
      padding: 4px 8px;
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
    }

    .file-item {
      display: flex;
      align-items: center;
      padding: 4px 8px;
      cursor: pointer;
      border-radius: 3px;
      gap: 8px;
    }

    .file-item:hover {
      background-color: var(--vscode-list-hoverBackground);
    }

    .file-item.selected {
      background-color: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }

    .file-checkbox {
      flex-shrink: 0;
    }

    .file-status {
      width: 16px;
      font-weight: bold;
      font-size: 11px;
      flex-shrink: 0;
    }

    .file-path {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .file-dir {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 100px;
    }

    .stage-button {
      padding: 2px 6px;
      border: none;
      border-radius: 3px;
      cursor: pointer;
      font-size: 12px;
      font-weight: bold;
      opacity: 0;
      transition: opacity 0.2s;
    }

    .file-item:hover .stage-button {
      opacity: 1;
    }

    .stage-button.stage {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .stage-button.unstage {
      background-color: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    .refresh-button {
      padding: 2px 6px;
      border: none;
      background: transparent;
      color: var(--vscode-foreground);
      cursor: pointer;
      font-size: 14px;
    }

    .refresh-button:hover {
      background-color: var(--vscode-toolbar-hoverBackground);
      border-radius: 3px;
    }

    .diff-section {
      height: 100%;
    }

    .diff-content {
      flex: 1;
      overflow: auto;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
    }

    .diff-content.empty {
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .empty-message {
      color: var(--vscode-descriptionForeground);
      text-align: center;
      padding: 20px;
    }

    .diff-hunk {
      margin-bottom: 8px;
    }

    .hunk-header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background-color: var(--vscode-diffEditor-insertedTextBackground);
    }

    .hunk-header {
      padding: 4px 8px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      flex: 1;
    }

    .hunk-controls {
      display: flex;
      gap: 4px;
      padding: 4px 8px;
    }

    .hunk-button {
      padding: 2px 8px;
      border: none;
      border-radius: 3px;
      cursor: pointer;
      font-size: 11px;
      font-weight: 500;
    }

    .hunk-button.stage-hunk {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .hunk-button.stage-hunk:hover {
      background-color: var(--vscode-button-hoverBackground);
    }

    .hunk-button.unstage-hunk {
      background-color: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    .hunk-button.unstage-hunk:hover {
      background-color: var(--vscode-button-secondaryHoverBackground);
    }

    .hunk-button.stage-selected {
      background-color: #4CAF50;
      color: white;
    }

    .hunk-button.stage-selected:hover {
      background-color: #45a049;
    }

    .hunk-button.select-all,
    .hunk-button.deselect-all {
      background-color: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    .line-selection-controls {
      display: flex;
      gap: 4px;
      padding: 4px 8px;
      background-color: var(--vscode-editor-inactiveSelectionBackground);
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .diff-header-controls {
      display: flex;
      gap: 8px;
    }

    .partial-staging-toggle {
      padding: 2px 8px;
      border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
      border-radius: 3px;
      cursor: pointer;
      font-size: 11px;
      background-color: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    .partial-staging-toggle:hover {
      background-color: var(--vscode-button-secondaryHoverBackground);
    }

    .partial-staging-toggle.active {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-button-background);
    }

    .diff-line {
      display: flex;
      white-space: pre;
      line-height: 1.4;
    }

    .diff-line.selectable {
      cursor: pointer;
    }

    .diff-line.selectable:hover {
      background-color: var(--vscode-list-hoverBackground);
    }

    .diff-line.line-selected {
      background-color: var(--vscode-editor-selectionBackground) !important;
    }

    .line-checkbox {
      width: 20px;
      text-align: center;
      flex-shrink: 0;
      user-select: none;
    }

    .diff-add {
      background-color: var(--vscode-diffEditor-insertedLineBackground, rgba(155, 185, 85, 0.2));
    }

    .diff-delete {
      background-color: var(--vscode-diffEditor-removedLineBackground, rgba(255, 0, 0, 0.2));
    }

    .line-num {
      width: 40px;
      padding: 0 4px;
      text-align: right;
      color: var(--vscode-editorLineNumber-foreground);
      user-select: none;
      flex-shrink: 0;
    }

    .line-prefix {
      width: 16px;
      text-align: center;
      flex-shrink: 0;
    }

    .line-content {
      flex: 1;
      padding-right: 8px;
    }

    .binary-file {
      padding: 20px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }

    .commit-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-top: 12px;
      border-top: 1px solid var(--vscode-panel-border);
      margin-top: 12px;
    }

    .options-section {
      display: flex;
      gap: 16px;
    }

    .option-label {
      display: flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      font-size: 12px;
    }

    .buttons-section {
      display: flex;
      gap: 8px;
    }

    .button {
      padding: 6px 14px;
      border: none;
      border-radius: 2px;
      cursor: pointer;
      font-size: 13px;
    }

    .button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .cancel-button {
      background-color: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    .cancel-button:hover:not(:disabled) {
      background-color: var(--vscode-button-secondaryHoverBackground);
    }

    .commit-button {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .commit-button:hover:not(:disabled) {
      background-color: var(--vscode-button-hoverBackground);
    }
  `;
}
