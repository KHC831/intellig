/**
 * Shelve Changes dialog.
 *
 * IntelliJ-parity "Shelve Changes" surface. IntelliJ's `ShelveChangesAction`
 * (platform/vcs-impl/.../shelf/ShelveChangesAction.kt) extends
 * `AbstractCommitChangesAction` and runs a `ShelveChangesCommitExecutor` over
 * the commit change-selection dialog: a checkbox list of changes plus a commit
 * message used as the shelf comment. `ShelveChangesCommitExecutor` (getActionText
 * = "Shelve Changes…") calls
 * `ShelveChangesManager.shelveChanges(changes, commitMessage, …)`.
 *
 * This is the VS Code analogue: a dedicated webview panel (NOT the docked Commit
 * tool window) with a checkbox file list + a name field + a "Shelve Changes"
 * button. It is the single source of truth behind both entry points — a
 * single-file right-click (only that file pre-checked) and the `Shelve Changes…`
 * command (all files pre-checked).
 *
 * Follows the post-DOM-migration webview contract established by
 * {@link NewBranchDialog}: the body ships an empty `#root`; a nonce'd inline
 * script builds every control via `document.createElement` from a JSON init
 * island, so host data reaches the DOM only through `.value` / `.textContent`
 * (injection-proof).
 */

import * as vscode from 'vscode';
import { BaseWebviewPanel } from '../utils/BaseWebviewPanel';
import { assertNever } from '../utils/assertNever';
import {
  asShelveDialogInbound,
  type IShelveDialogInit,
  type IShelveFileItem,
  type ShelveDialogOutbound,
} from './shelveDialog.protocol';
import { initIslandHtml } from '../utils/webviewInit';
import { IFileStatus, IRepository } from '../git-core/interfaces/IGitService';
import { IShelfItem } from './interfaces/IShelfService';
import { sanitizeGitError } from '../git-core/gitError';
import { escapeHtml } from '../utils/escapeHtml';

/** Minimal shelf-service surface the dialog needs (the real ShelfService satisfies it). */
export interface IShelveDialogShelfService {
  shelve(repo: IRepository, name: string, changes: { files?: string[] }): Promise<IShelfItem>;
}

/** Options for constructing a {@link ShelveDialog}. */
export interface IShelveDialogOptions {
  repo: IRepository;
  shelfService: IShelveDialogShelfService;
  /** Working-tree changes (staged + unstaged + untracked) to offer for shelving. */
  changedFiles: IFileStatus[];
  /**
   * Repo-relative paths to pre-check. When provided only these are checked
   * (single-file entry point); when omitted every file is checked (the
   * command / "shelve everything" entry point).
   */
  preSelectedPaths?: string[];
  /** Pre-fill the name field. */
  defaultName?: string;
  /** Fired after a successful shelve, with the created entry (e.g. to refresh the shelf view). */
  onShelved?: (item: IShelfItem) => void;
}

const VIEW_TYPE = 'intellig.shelveDialog';
const TITLE = 'Shelve Changes';

/**
 * Validate a shelf name. Returns an error string when invalid, or `undefined`
 * when valid. Mirrors {@link IShelfService.shelve}'s own non-empty guard so the
 * dialog rejects at the boundary before any git work.
 */
export function validateShelfName(name: string | undefined): string | undefined {
  if (!name || name.trim().length === 0) {
    return 'Shelf name cannot be empty';
  }
  return undefined;
}

/**
 * The effective single-letter status for display. Prefers the work-tree status
 * (the user's live edit) and falls back to the index status, so a staged-only
 * change still shows its letter. Untracked (`?`) maps through to "Untracked".
 */
function effectiveStatusCode(f: IFileStatus): string {
  if (f.workTreeStatus && f.workTreeStatus !== ' ') {
    return f.workTreeStatus;
  }
  if (f.indexStatus && f.indexStatus !== ' ') {
    return f.indexStatus;
  }
  return ' ';
}

const STATUS_LABELS: Record<string, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  U: 'Unmerged',
  '?': 'Untracked',
  '!': 'Ignored',
};

const STATUS_COLORS: Record<string, string> = {
  Modified: 'var(--vscode-gitDecoration-modifiedResourceForeground, #6897BB)',
  Added: 'var(--vscode-gitDecoration-addedResourceForeground, #629755)',
  Deleted: 'var(--vscode-gitDecoration-deletedResourceForeground, #6C6C6C)',
  Renamed: 'var(--vscode-gitDecoration-renamedResourceForeground, #6897BB)',
  Copied: 'var(--vscode-gitDecoration-addedResourceForeground, #629755)',
  Untracked: 'var(--vscode-gitDecoration-untrackedResourceForeground, #CC7832)',
  Unmerged: 'var(--vscode-gitDecoration-conflictingResourceForeground, #FF0000)',
};

function fileName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1];
}

function fileDir(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 1) {
    return '';
  }
  parts.pop();
  return parts.join('/');
}

/**
 * Build the dialog's file rows from a status list. Files with no change
 * (both statuses blank) are dropped. A row is `selected` when `preSelectedPaths`
 * is omitted (select-all) or contains its path (single-file pre-check).
 */
export function buildShelveFileItems(
  files: IFileStatus[],
  preSelectedPaths?: string[]
): IShelveFileItem[] {
  const preSet = preSelectedPaths ? new Set(preSelectedPaths) : undefined;
  const items: IShelveFileItem[] = [];
  for (const f of files) {
    const code = effectiveStatusCode(f);
    if (code === ' ') {
      continue; // unchanged — nothing to shelve
    }
    const statusLabel = STATUS_LABELS[code] ?? code;
    items.push({
      path: f.path,
      fileName: fileName(f.path),
      fileDir: fileDir(f.path),
      statusChar: code,
      statusLabel,
      statusColor: STATUS_COLORS[statusLabel] ?? 'var(--vscode-foreground, #FFFFFF)',
      selected: preSet ? preSet.has(f.path) : true,
    });
  }
  return items;
}

export class ShelveDialog extends BaseWebviewPanel<ShelveDialogOutbound> {
  private readonly _repo: IRepository;
  private readonly _shelfService: IShelveDialogShelfService;
  private readonly _items: IShelveFileItem[];
  private readonly _defaultName: string;
  private readonly _onShelved?: (item: IShelfItem) => void;
  private _busy = false;

  constructor(context: vscode.ExtensionContext, options: IShelveDialogOptions) {
    super(context, VIEW_TYPE, TITLE, vscode.ViewColumn.One);
    this._repo = options.repo;
    this._shelfService = options.shelfService;
    this._items = buildShelveFileItems(options.changedFiles, options.preSelectedPaths);
    this._defaultName = options.defaultName ?? '';
    this._onShelved = options.onShelved;
    this._render();
  }

  protected override _getStyles(): string {
    return `
      body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        padding: 16px 20px;
        font-size: var(--vscode-font-size);
      }
      .field { margin-bottom: 12px; }
      .field label.top {
        display: block;
        margin-bottom: 4px;
        color: var(--vscode-descriptionForeground);
      }
      input[type=text] {
        width: 100%;
        box-sizing: border-box;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent);
        padding: 4px 6px;
        font-family: inherit;
        font-size: inherit;
      }
      input[type=text]:focus { outline: 1px solid var(--vscode-focusBorder); }
      .files-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 4px;
        color: var(--vscode-descriptionForeground);
      }
      .files {
        border: 1px solid var(--vscode-panel-border);
        border-radius: 4px;
        max-height: 320px;
        overflow-y: auto;
        background: var(--vscode-sideBar-background);
      }
      .file-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 8px;
        cursor: pointer;
      }
      .file-row:hover { background: var(--vscode-list-hoverBackground); }
      .file-status { width: 14px; font-weight: bold; font-size: 11px; flex-shrink: 0; }
      .file-name { flex-shrink: 0; }
      .file-dir {
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .empty { padding: 12px; color: var(--vscode-descriptionForeground); }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 14px;
      }
      button {
        font-family: inherit;
        font-size: inherit;
        padding: 4px 14px;
        border: 1px solid var(--vscode-button-border, transparent);
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        cursor: pointer;
      }
      button.secondary {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
      }
      button:disabled { opacity: 0.55; cursor: not-allowed; }
    `;
  }

  protected _getBodyHtml(): string {
    const init: IShelveDialogInit = { defaultName: this._defaultName, files: this._items };
    return `<div id="root"></div>${initIslandHtml(init)}`;
  }

  /**
   * Override the base renderer so the body ships alongside an EXTERNAL bundle tag
   * (`media/webview/shelveDialog.js`) instead of the base's empty sentinel. The
   * interactive logic lives in the bundled TS entry (src/shelf/webview/main.ts),
   * which reads its init from the body's `data-init` island.
   */
  protected override _render(): void {
    if (this._disposed) {
      return;
    }
    const nonce = this._getNonce();
    const csp = this._buildCsp(nonce);
    const styles = this._getStyles();
    const styleBlock = styles.length > 0 ? `<style>${styles}</style>` : '';
    const bundleUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'media', 'webview', 'shelveDialog.js')
    );

    this._panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>${escapeHtml(this._title)}</title>
  ${styleBlock}
</head>
<body>
${this._getBodyHtml()}
<script nonce="${nonce}" src="${bundleUri.toString()}"></script>
</body>
</html>`;
  }

  protected async _onMessage(raw: unknown): Promise<void> {
    if (this._busy || this._disposed) {
      return;
    }
    const msg = asShelveDialogInbound(raw);
    if (!msg) {
      return;
    }
    switch (msg.type) {
      case 'cancel':
        this.dispose();
        return;
      case 'shelve':
        await this._executeShelve(msg.name ?? '', Array.isArray(msg.files) ? msg.files : []);
        return;
      default:
        assertNever(msg);
    }
  }

  private async _executeShelve(name: string, files: string[]): Promise<void> {
    const nameError = validateShelfName(name);
    if (nameError) {
      void vscode.window.showErrorMessage(nameError);
      return;
    }
    if (files.length === 0) {
      void vscode.window.showErrorMessage('Select at least one file to shelve');
      return;
    }

    this._busy = true;
    try {
      const item = await this._shelfService.shelve(this._repo, name.trim(), { files });
      if (item.partialCleanupFailures && item.partialCleanupFailures.length > 0) {
        const count = item.partialCleanupFailures.length;
        const paths = item.partialCleanupFailures.join(', ');
        void vscode.window.showWarningMessage(
          `Shelved ${item.files.length} file(s) to '${item.name}', but ${count} file(s) could not be removed from your working tree and are still present: ${paths}`
        );
      } else {
        void vscode.window.showInformationMessage(
          `Shelved ${item.files.length} file(s) to '${item.name}'`
        );
      }
      if (this._onShelved) {
        this._onShelved(item);
      }
      this.dispose();
    } catch (error) {
      const m = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to shelve changes: ${sanitizeGitError(m)}`);
      this._busy = false;
    }
  }
}

/**
 * Convenience factory — opens a {@link ShelveDialog}.
 */
export function showShelveDialog(
  context: vscode.ExtensionContext,
  options: IShelveDialogOptions
): ShelveDialog {
  return new ShelveDialog(context, options);
}
