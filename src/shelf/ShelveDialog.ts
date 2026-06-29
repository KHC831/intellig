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

/** A file row in the dialog's checkbox list. */
export interface IShelveFileItem {
  path: string;
  fileName: string;
  fileDir: string;
  statusChar: string;
  statusLabel: string;
  statusColor: string;
  selected: boolean;
}

/** Webview → extension message shape. */
interface IShelveDialogMessage {
  type: 'shelve' | 'cancel';
  name?: string;
  files?: string[];
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

export class ShelveDialog extends BaseWebviewPanel {
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
    return this._getBodyParts().body;
  }

  /**
   * Emit body + interactive script separately so `_render` can splice the
   * script into a nonce'd block without regex-extracting it (a nested
   * `</script>` inside a string literal would break the old regex). Mirrors
   * {@link NewBranchDialog}.
   */
  private _getBodyParts(): { body: string; script: string } {
    const body = `<div id="root"></div>`;

    const initJson = JSON.stringify({
      defaultName: this._defaultName,
      files: this._items,
    }).replace(/</g, '\\u003c');

    const script = `
      (function() {
        const vscode = acquireVsCodeApi();
        const INIT = ${initJson};
        const root = document.getElementById('root');
        const el = (tag, props) => Object.assign(document.createElement(tag), props || {});
        const setData = (node, attrs) => { for (const k in attrs) node.setAttribute(k, attrs[k]); return node; };

        // ── Name field ─────────────────────────────────────────────────────
        const field = el('div', { className: 'field' });
        field.append(el('label', { className: 'top', htmlFor: 'shelve-name', textContent: 'Name:' }));
        const nameInput = el('input', { type: 'text', id: 'shelve-name', placeholder: 'Shelf name', value: INIT.defaultName });
        field.append(nameInput);

        // ── Files header (master checkbox + count) ─────────────────────────
        const filesHeader = el('div', { className: 'files-header' });
        const masterLabel = el('label', { style: 'display:flex;align-items:center;gap:6px;cursor:pointer;' });
        const masterCb = el('input', { type: 'checkbox', id: 'shelve-master' });
        masterLabel.append(masterCb, el('span', { textContent: 'Changes' }));
        const countSpan = el('span', { id: 'shelve-count' });
        filesHeader.append(masterLabel, countSpan);

        // ── File list ──────────────────────────────────────────────────────
        const filesBox = el('div', { className: 'files' });
        if (INIT.files.length === 0) {
          filesBox.append(el('div', { className: 'empty', textContent: 'No changes to shelve' }));
        }
        for (const f of INIT.files) {
          const row = el('div', { className: 'file-row' });
          const cb = el('input', { type: 'checkbox', className: 'shelve-file-checkbox' });
          cb.checked = f.selected;
          setData(cb, { 'data-path': f.path });
          const status = el('span', { className: 'file-status', textContent: f.statusChar, title: f.statusLabel });
          status.style.color = f.statusColor;
          row.append(cb, status, el('span', { className: 'file-name', textContent: f.fileName }), el('span', { className: 'file-dir', textContent: f.fileDir }));
          // Clicking the row (not the checkbox itself) toggles the box.
          row.addEventListener('click', (e) => {
            if (e.target !== cb) { cb.checked = !cb.checked; refresh(); }
          });
          cb.addEventListener('change', refresh);
          filesBox.append(row);
        }

        // ── Actions ────────────────────────────────────────────────────────
        const actions = el('div', { className: 'actions' });
        const cancelBtn = el('button', { id: 'shelve-cancel-btn', type: 'button', className: 'secondary', textContent: 'Cancel' });
        const shelveBtn = el('button', { id: 'shelve-btn', type: 'button', textContent: 'Shelve Changes' });
        actions.append(cancelBtn, shelveBtn);

        root.append(field, filesHeader, filesBox, actions);
        nameInput.focus();

        function checkedBoxes() {
          return Array.prototype.slice.call(document.querySelectorAll('input.shelve-file-checkbox')).filter((b) => b.checked);
        }
        function refresh() {
          const all = document.querySelectorAll('input.shelve-file-checkbox');
          const checked = checkedBoxes();
          countSpan.textContent = checked.length + ' of ' + all.length + ' selected';
          masterCb.checked = all.length > 0 && checked.length === all.length;
          masterCb.indeterminate = checked.length > 0 && checked.length < all.length;
          shelveBtn.disabled = nameInput.value.trim().length === 0 || checked.length === 0;
        }

        masterCb.addEventListener('change', () => {
          const target = masterCb.checked;
          document.querySelectorAll('input.shelve-file-checkbox').forEach((b) => { b.checked = target; });
          refresh();
        });
        nameInput.addEventListener('input', refresh);

        function submit() {
          if (shelveBtn.disabled) { return; }
          vscode.postMessage({
            type: 'shelve',
            name: nameInput.value.trim(),
            files: checkedBoxes().map((b) => b.getAttribute('data-path')),
          });
        }
        shelveBtn.addEventListener('click', submit);
        cancelBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

        // Dialog keyboard contract (shared across IntelliG dialogs):
        //   Cmd/Ctrl+Enter → primary (Shelve); Esc → Cancel.
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
          else if (e.key === 'Escape') { e.preventDefault(); cancelBtn.click(); }
        });

        refresh();
      })();
    `;

    return { body, script };
  }

  /**
   * Override the base renderer so the interactive script ships inside the
   * nonce'd `<script>` block (the base `_wrapHtml` emits an empty sentinel
   * script only). Mirrors {@link NewBranchDialog._render}.
   */
  protected override _render(): void {
    if (this._disposed) {
      return;
    }
    const nonce = this._getNonce();
    const csp = this._buildCsp(nonce);
    const styles = this._getStyles();
    const styleBlock = styles.length > 0 ? `<style>${styles}</style>` : '';
    const { body, script } = this._getBodyParts();

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
${body}
<script nonce="${nonce}">${script}</script>
</body>
</html>`;
  }

  protected async _onMessage(raw: unknown): Promise<void> {
    if (this._busy || this._disposed) {
      return;
    }
    const msg = raw as IShelveDialogMessage | undefined;
    if (!msg || typeof msg !== 'object') {
      return;
    }
    switch (msg.type) {
      case 'cancel':
        this.dispose();
        return;
      case 'shelve':
        await this._executeShelve(msg.name ?? '', Array.isArray(msg.files) ? msg.files : []);
        return;
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
