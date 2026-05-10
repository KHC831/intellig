/**
 * Apply Patch Dialog (T1-12).
 *
 * IntelliJ-style "Apply Patch…" modal. Extends {@link BaseWebviewPanel}.
 * Offers two input modes for the patch source:
 *   (a) File picker (invokes `vscode.window.showOpenDialog` with diff/patch
 *       filters) — path is surfaced in the dialog once chosen.
 *   (b) Clipboard — reads the system clipboard at apply-time.
 *
 * Controls:
 *   - Patch source (radio): File / Clipboard.
 *   - Chosen file path readonly display + Browse… button.
 *   - Strip-path numeric input (-p<N>). Default 1.
 *   - Base-dir text input (--directory). Blank by default.
 *   - "Use git am (preserve author)" checkbox.
 *   - Diff preview pane (first ~20 hunks) — populated on demand via a Preview
 *     button that issues a `check` pass and surfaces the patch body.
 *   - Apply + Cancel buttons.
 *
 * REVIEW.md §B4: on `--3way` conflicts the dialog delegates to
 * `IConflictResolutionService.openResolveConflictsDialog(repo, conflicts,
 * { operation: 'applyPatch', … })`. No bespoke conflict surface.
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import { BaseWebviewPanel } from '../utils/BaseWebviewPanel';
import { IRepository } from './interfaces/IGitService';
import { IConflictResolutionService } from './interfaces/IConflictResolutionService';
import { IPatchService, IApplyPatchOptions, IApplyPatchResult } from './interfaces/IPatchService';
import { validateStripLevel } from './PatchService';

/**
 * Constructor options for {@link ApplyPatchDialog}.
 */
export interface IApplyPatchDialogOptions {
  /** Target repository. */
  repo: IRepository;
  /** Patch service used to execute apply. */
  patchService: IPatchService;
  /**
   * Conflict resolution service used for the post-apply conflict handoff
   * (REVIEW.md §B4). Optional only to keep construction trivially testable —
   * production callers always wire this.
   */
  conflictResolutionService?: IConflictResolutionService;
  /**
   * Optional callback fired after a successful apply so the caller can refresh
   * dependent UI (e.g. the Git graph / tree). Not called on failure.
   */
  onApplyComplete?: () => void;
  /**
   * Optional pre-filled patch path (e.g. when the command was invoked via
   * "Apply Patch…" on a `.patch` / `.diff` file in the Explorer).
   */
  initialPatchPath?: string;
}

/** Incoming message shapes from webview → extension. */
type IncomingMessage =
  | { type: 'cancel' }
  | { type: 'browse' }
  | { type: 'preview'; patchPath?: string; useClipboard?: boolean }
  | {
      type: 'apply';
      patchPath?: string;
      useClipboard?: boolean;
      useAm?: boolean;
      stripLevel?: number;
      baseDir?: string;
    };

/** Outgoing message shapes from extension → webview. */
type OutgoingMessage =
  | { type: 'patchPathChosen'; patchPath: string }
  | { type: 'preview'; content: string }
  | { type: 'error'; message: string };

const VIEW_TYPE = 'intellig.applyPatchDialog';
const TITLE = 'Apply Patch';

/**
 * Escape HTML special characters for safe injection into text / attribute
 * positions.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Cap preview output at this many lines to keep the webview responsive when
 * users open a 10k-line patch.
 */
const PREVIEW_LINE_CAP = 500;

export class ApplyPatchDialog extends BaseWebviewPanel {
  private readonly _repo: IRepository;
  private readonly _patchService: IPatchService;
  private readonly _conflictResolutionService: IConflictResolutionService | undefined;
  private readonly _onApplyComplete: (() => void) | undefined;
  /** Current patch path displayed in the dialog (may be `undefined`). */
  private _patchPath: string | undefined;
  private _busy = false;

  constructor(context: vscode.ExtensionContext, options: IApplyPatchDialogOptions) {
    super(context, VIEW_TYPE, TITLE, vscode.ViewColumn.One);
    this._repo = options.repo;
    this._patchService = options.patchService;
    this._conflictResolutionService = options.conflictResolutionService;
    this._onApplyComplete = options.onApplyComplete;
    this._patchPath = options.initialPatchPath;

    this._render();
  }

  /**
   * Expose the current dialog state for tests.
   */
  getPatchPath(): string | undefined {
    return this._patchPath;
  }

  protected override _getStyles(): string {
    return `
      body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        padding: 16px 20px;
        font-size: var(--vscode-font-size);
        display: flex;
        flex-direction: column;
        height: 100vh;
        box-sizing: border-box;
      }
      h3 {
        margin: 0 0 12px 0;
        font-size: 14px;
        font-weight: 600;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
      }
      .row label.block {
        flex: 0 0 140px;
      }
      .row input[type="text"], .row input[type="number"] {
        flex: 1;
        padding: 4px 6px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent);
        font-family: var(--vscode-editor-font-family, monospace);
      }
      .row input[type="number"] { max-width: 80px; flex: 0; }
      .source-row {
        display: flex;
        gap: 16px;
        margin-bottom: 10px;
      }
      .preview {
        flex: 1;
        margin: 12px 0;
        padding: 8px;
        overflow: auto;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 12px;
        white-space: pre;
        background: var(--vscode-editor-background);
        border: 1px solid var(--vscode-panel-border);
        color: var(--vscode-foreground);
        min-height: 120px;
      }
      .preview .placeholder {
        color: var(--vscode-descriptionForeground);
        font-style: italic;
      }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding-top: 8px;
        border-top: 1px solid var(--vscode-panel-border);
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
      .hint {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        margin-left: 148px;
      }
    `;
  }

  protected _getBodyHtml(): string {
    return this._getBodyParts().body;
  }

  /**
   * Emit the body HTML and the interactive script separately so `_render()`
   * can splice the script into a nonced `<script>` block without fragile
   * regex extraction (LOW-1 — nested `</script>` inside any future string
   * literal would break the old regex).
   */
  private _getBodyParts(): { body: string; script: string } {
    const escapedPath = escapeHtml(this._patchPath ?? '');

    const body = `
      <h3>Apply Patch</h3>

      <div class="source-row">
        <label><input type="radio" name="source" value="file" checked /> From file</label>
        <label><input type="radio" name="source" value="clipboard" /> From clipboard</label>
      </div>

      <div class="row" data-row="file">
        <label class="block">Patch file:</label>
        <input type="text" id="patchPath" readonly value="${escapedPath}" placeholder="(none selected)" />
        <button id="browseBtn" class="secondary" type="button">Browse…</button>
      </div>

      <div class="row">
        <label class="block" for="stripLevel">Strip level (-p):</label>
        <input type="number" id="stripLevel" min="0" max="10" value="1" />
        <span class="hint">Leading path components to strip.</span>
      </div>

      <div class="row">
        <label class="block" for="baseDir">Base directory:</label>
        <input type="text" id="baseDir" placeholder="(repository root)" />
      </div>

      <div class="row">
        <label><input type="checkbox" id="useAm" /> Use <code>git am</code> (preserve author)</label>
      </div>

      <div class="row">
        <button id="previewBtn" class="secondary" type="button">Preview…</button>
        <span class="hint">Shows the first ${PREVIEW_LINE_CAP} lines of the patch.</span>
      </div>

      <div class="preview" id="preview">
        <span class="placeholder">No preview yet. Click “Preview…” to inspect the patch body.</span>
      </div>

      <div class="actions">
        <button id="cancelBtn" class="secondary" type="button">Cancel</button>
        <button id="applyBtn" type="button">Apply</button>
      </div>
    `;

    const script = `
      (function() {
        const vscode = acquireVsCodeApi();

        function source() {
          const sel = document.querySelector('input[name="source"]:checked');
          return sel ? sel.value : 'file';
        }
        function patchPath() {
          const el = document.getElementById('patchPath');
          return el && el.value ? el.value : undefined;
        }
        function basePayload() {
          const src = source();
          return {
            patchPath: src === 'file' ? patchPath() : undefined,
            useClipboard: src === 'clipboard',
          };
        }

        document.getElementById('browseBtn').addEventListener('click', () => {
          vscode.postMessage({ type: 'browse' });
        });

        document.getElementById('cancelBtn').addEventListener('click', () => {
          vscode.postMessage({ type: 'cancel' });
        });

        document.getElementById('previewBtn').addEventListener('click', () => {
          vscode.postMessage(Object.assign({ type: 'preview' }, basePayload()));
        });

        document.getElementById('applyBtn').addEventListener('click', () => {
          const stripLevelEl = document.getElementById('stripLevel');
          const baseDirEl = document.getElementById('baseDir');
          const useAmEl = document.getElementById('useAm');
          const payload = Object.assign({ type: 'apply' }, basePayload(), {
            useAm: !!(useAmEl && useAmEl.checked),
            stripLevel: stripLevelEl && stripLevelEl.value ? parseInt(stripLevelEl.value, 10) : 1,
            baseDir: baseDirEl && baseDirEl.value ? baseDirEl.value : undefined,
          });
          vscode.postMessage(payload);
        });

        // Source radio toggles the file row's enabled state.
        document.querySelectorAll('input[name="source"]').forEach((r) => {
          r.addEventListener('change', () => {
            const fileRow = document.querySelector('[data-row="file"]');
            if (!fileRow) return;
            const input = fileRow.querySelector('input[type="text"]');
            const browse = document.getElementById('browseBtn');
            const disabled = source() !== 'file';
            if (input) input.disabled = disabled;
            if (browse) browse.disabled = disabled;
          });
        });

        // Host-sent message handling.
        window.addEventListener('message', (ev) => {
          const msg = ev.data;
          if (!msg) return;
          if (msg.type === 'patchPathChosen') {
            const el = document.getElementById('patchPath');
            if (el) el.value = msg.patchPath;
          } else if (msg.type === 'preview') {
            const el = document.getElementById('preview');
            if (el) el.textContent = msg.content;
          } else if (msg.type === 'error') {
            const el = document.getElementById('preview');
            if (el) el.textContent = '⚠ ' + msg.message;
          }
        });
      })();
    `;

    return { body, script };
  }

  /**
   * Override the base renderer entirely so we emit the interactive script
   * with the CSP nonce. LOW-1: receives body + script as an explicit tuple
   * from `_getBodyParts()` instead of regex-extracting the script block.
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

  /**
   * Route incoming webview messages. See IncomingMessage for the full
   * discriminated union.
   */
  protected async _onMessage(raw: unknown): Promise<void> {
    if (this._disposed) {
      return;
    }
    const msg = raw as IncomingMessage | undefined;
    if (!msg || typeof msg !== 'object') {
      return;
    }

    switch (msg.type) {
      case 'cancel':
        this.dispose();
        return;
      case 'browse':
        await this._handleBrowse();
        return;
      case 'preview':
        await this._handlePreview(msg);
        return;
      case 'apply':
        if (this._busy) {
          return;
        }
        this._busy = true;
        try {
          await this._handleApply(msg);
        } finally {
          this._busy = false;
        }
        return;
    }
  }

  /**
   * Show a file-open dialog filtered to `.patch` / `.diff` files. Updates the
   * dialog's internal patch path on selection.
   */
  private async _handleBrowse(): Promise<void> {
    const uri = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: 'Select Patch',
      filters: {
        'Patch files': ['patch', 'diff'],
        'All files': ['*'],
      },
    });
    if (!uri || uri.length === 0) {
      return;
    }
    this._patchPath = uri[0].fsPath;
    await this.postMessage({
      type: 'patchPathChosen',
      patchPath: this._patchPath,
    } as OutgoingMessage);
  }

  /**
   * Load the patch contents for preview. Capped at PREVIEW_LINE_CAP lines.
   */
  private async _handlePreview(msg: Extract<IncomingMessage, { type: 'preview' }>): Promise<void> {
    try {
      const text = await this._readPatchContent(msg.patchPath, msg.useClipboard);
      const lines = text.split('\n');
      const overflow = lines.length - PREVIEW_LINE_CAP;
      const capped =
        overflow > 0
          ? lines.slice(0, PREVIEW_LINE_CAP).join('\n') +
            `\n\n… (${overflow} more ${overflow === 1 ? 'line' : 'lines'} truncated)`
          : text;
      await this.postMessage({ type: 'preview', content: capped } as OutgoingMessage);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      await this.postMessage({
        type: 'error',
        message: `Preview failed: ${errMsg}`,
      } as OutgoingMessage);
    }
  }

  /**
   * Build the {@link IApplyPatchOptions} bag from a webview apply message
   * and invoke the PatchService. Handles success, conflict, and hard-error
   * paths.
   */
  private async _handleApply(msg: Extract<IncomingMessage, { type: 'apply' }>): Promise<void> {
    let applyOptions: IApplyPatchOptions;
    try {
      applyOptions = await this._buildApplyOptions(msg);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Apply Patch: ${errMsg}`);
      return;
    }

    let result: IApplyPatchResult;
    try {
      result = await this._patchService.applyPatch(this._repo, applyOptions);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Apply Patch failed: ${errMsg}`);
      return;
    }

    if (result.success) {
      const n = result.appliedFiles.length;
      void vscode.window.showInformationMessage(
        n > 0 ? `Patch applied (${n} file${n === 1 ? '' : 's'}).` : 'Patch applied.'
      );
      this._onApplyComplete?.();
      this.dispose();
      return;
    }

    // Conflict path: delegate to T1-08 Resolve Conflicts dialog (REVIEW.md §B4).
    if (result.conflicts && result.conflicts.length > 0) {
      if (this._conflictResolutionService) {
        await this._conflictResolutionService.openResolveConflictsDialog(
          this._repo,
          result.conflicts,
          {
            operation: 'applyPatch',
            canAbort: true,
            canContinue: true,
          }
        );
        // Close the apply dialog once the conflict dialog takes over — the
        // user's focus shifts there. The patch is already partially on-disk,
        // so there's nothing left to configure here.
        this._onApplyComplete?.();
        this.dispose();
        return;
      }
      // Fallback when conflictResolutionService isn't wired (tests, etc).
      void vscode.window.showWarningMessage(
        `Patch applied with conflicts in ${result.conflicts.length} file(s).`
      );
      this.dispose();
      return;
    }

    // Hard failure: surface git stderr.
    const detail = result.stderr ? `: ${result.stderr}` : '';
    void vscode.window.showErrorMessage(`Apply Patch failed${detail}`);
  }

  /**
   * Resolve the webview apply payload into a concrete IApplyPatchOptions.
   * Reads clipboard when requested; validates that exactly one source was
   * supplied.
   */
  private async _buildApplyOptions(
    msg: Extract<IncomingMessage, { type: 'apply' }>
  ): Promise<IApplyPatchOptions> {
    // SR-7: validate at the webview boundary as defense-in-depth. The
    // webview sends `parseInt(..., 10)` which returns NaN on non-numeric
    // values; PatchService would catch that too, but surfacing here produces
    // a cleaner error message.
    const stripErr = validateStripLevel(msg.stripLevel);
    if (stripErr) {
      throw new Error(stripErr);
    }
    if (msg.useClipboard) {
      const content = await vscode.env.clipboard.readText();
      if (!content || content.trim().length === 0) {
        throw new Error('Clipboard is empty.');
      }
      return {
        patchContent: content,
        useAm: msg.useAm,
        stripLevel: msg.stripLevel,
        baseDir: msg.baseDir,
      };
    }
    const patchPath = msg.patchPath ?? this._patchPath;
    if (!patchPath) {
      throw new Error('No patch file selected.');
    }
    return {
      patchPath,
      useAm: msg.useAm,
      stripLevel: msg.stripLevel,
      baseDir: msg.baseDir,
    };
  }

  /**
   * Read patch content from either the chosen file or the clipboard. Used by
   * the preview handler.
   */
  private async _readPatchContent(
    patchPath: string | undefined,
    useClipboard: boolean | undefined
  ): Promise<string> {
    if (useClipboard) {
      const content = await vscode.env.clipboard.readText();
      if (!content || content.trim().length === 0) {
        throw new Error('Clipboard is empty.');
      }
      return content;
    }
    const path = patchPath ?? this._patchPath;
    if (!path) {
      throw new Error('No patch file selected.');
    }
    return fs.promises.readFile(path, 'utf-8');
  }
}

/**
 * Factory convenience — opens an Apply Patch dialog.
 */
export function showApplyPatchDialog(
  context: vscode.ExtensionContext,
  options: IApplyPatchDialogOptions
): ApplyPatchDialog {
  return new ApplyPatchDialog(context, options);
}
