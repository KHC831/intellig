/**
 * Apply Patch Dialog.
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
 * On `--3way` conflicts the dialog delegates to
 * `IConflictResolutionService.openResolveConflictsDialog(repo, conflicts,
 * { operation: 'applyPatch', … })`. No bespoke conflict surface.
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import { BaseWebviewPanel } from '../utils/BaseWebviewPanel';
import { escapeHtml } from '../utils/escapeHtml';
import { IRepository } from '../git-core/interfaces/IGitService';
import { IConflictResolutionService } from '../conflicts/interfaces/IConflictResolutionService';
import { sanitizeGitError } from '../git-core/gitError';
import { IPatchService, IApplyPatchOptions, IApplyPatchResult } from './interfaces/IPatchService';
import { filterPatchByFiles, splitPatchByFile, validateStripLevel } from './PatchService';

/**
 * Constructor options for {@link ApplyPatchDialog}.
 */
export interface IApplyPatchDialogOptions {
  /** Target repository. */
  repo: IRepository;
  /** Patch service used to execute apply. */
  patchService: IPatchService;
  /**
   * Conflict resolution service used for the post-apply conflict handoff.
   * Optional only to keep construction trivially testable — production
   * callers always wire this.
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
   * regex extraction — nested `</script>` inside any future string literal
   * would break a regex-based extractor.
   */
  private _getBodyParts(): { body: string; script: string } {
    // Body ships an empty root; the script builds every control via
    // document.createElement. Host data crosses as a JSON init island and
    // reaches the DOM via .value / .textContent (injection-proof).
    const body = `<div id="root"></div>`;

    const initJson = JSON.stringify({
      patchPath: this._patchPath ?? '',
      previewLineCap: PREVIEW_LINE_CAP,
    }).replace(/</g, '\\u003c');

    const script = `
      (function() {
        const vscode = acquireVsCodeApi();
        const INIT = ${initJson};
        const root = document.getElementById('root');
        const el = (tag, props) => Object.assign(document.createElement(tag), props || {});
        const radioLabel = (value, text, checked) => {
          const label = el('label');
          const input = el('input', { type: 'radio', name: 'source', value: value });
          input.checked = checked;
          label.append(input, ' ' + text);
          return label;
        };
        const row = (children, cls) => {
          const div = el('div', { className: cls || 'row' });
          div.append(...children);
          return div;
        };

        root.append(el('h3', { textContent: 'Apply Patch' }));

        // ── Source radios ──────────────────────────────────────────────────
        root.append(
          row(
            [radioLabel('file', 'From file', true), radioLabel('clipboard', 'From clipboard', false)],
            'source-row'
          )
        );

        // ── File row ───────────────────────────────────────────────────────
        const fileRow = el('div', { className: 'row' });
        fileRow.setAttribute('data-row', 'file');
        const patchPathInput = el('input', {
          type: 'text',
          id: 'patchPath',
          readOnly: true,
          placeholder: '(none selected)',
          value: INIT.patchPath,
        });
        fileRow.append(
          el('label', { className: 'block', textContent: 'Patch file:' }),
          patchPathInput,
          el('button', { id: 'browseBtn', className: 'secondary', type: 'button', textContent: 'Browse…' })
        );
        root.append(fileRow);

        // ── Strip level ────────────────────────────────────────────────────
        const stripInput = el('input', { type: 'number', id: 'stripLevel', min: '0', max: '10', value: '1' });
        root.append(
          row([
            el('label', { className: 'block', htmlFor: 'stripLevel', textContent: 'Strip level (-p):' }),
            stripInput,
            el('span', { className: 'hint', textContent: 'Leading path components to strip.' }),
          ])
        );

        // ── Base directory ─────────────────────────────────────────────────
        root.append(
          row([
            el('label', { className: 'block', htmlFor: 'baseDir', textContent: 'Base directory:' }),
            el('input', { type: 'text', id: 'baseDir', placeholder: '(repository root)' }),
          ])
        );

        // ── Use git am ─────────────────────────────────────────────────────
        const amLabel = el('label');
        const amInput = el('input', { type: 'checkbox', id: 'useAm' });
        amLabel.append(amInput, ' Use ', el('code', { textContent: 'git am' }), ' (preserve author)');
        root.append(row([amLabel]));

        // ── Preview button ─────────────────────────────────────────────────
        root.append(
          row([
            el('button', { id: 'previewBtn', className: 'secondary', type: 'button', textContent: 'Preview…' }),
            el('span', { className: 'hint', textContent: 'Shows the first ' + INIT.previewLineCap + ' lines of the patch.' }),
          ])
        );

        // ── Preview pane ───────────────────────────────────────────────────
        const previewPane = el('div', { className: 'preview', id: 'preview' });
        previewPane.append(
          el('span', { className: 'placeholder', textContent: 'No preview yet. Click “Preview…” to inspect the patch body.' })
        );
        root.append(previewPane);

        // ── Actions ────────────────────────────────────────────────────────
        root.append(
          row(
            [
              el('button', { id: 'cancelBtn', className: 'secondary', type: 'button', textContent: 'Cancel' }),
              el('button', { id: 'applyBtn', type: 'button', textContent: 'Apply' }),
            ],
            'actions'
          )
        );

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

        const cancel = () => {
          vscode.postMessage({ type: 'cancel' });
        };
        const apply = () => {
          const stripLevelEl = document.getElementById('stripLevel');
          const baseDirEl = document.getElementById('baseDir');
          const useAmEl = document.getElementById('useAm');
          const payload = Object.assign({ type: 'apply' }, basePayload(), {
            useAm: !!(useAmEl && useAmEl.checked),
            stripLevel: stripLevelEl && stripLevelEl.value ? parseInt(stripLevelEl.value, 10) : 1,
            baseDir: baseDirEl && baseDirEl.value ? baseDirEl.value : undefined,
          });
          vscode.postMessage(payload);
        };

        document.getElementById('cancelBtn').addEventListener('click', cancel);

        document.getElementById('previewBtn').addEventListener('click', () => {
          vscode.postMessage(Object.assign({ type: 'preview' }, basePayload()));
        });

        document.getElementById('applyBtn').addEventListener('click', apply);

        // Dialog keyboard contract (shared across all dialogs):
        //   Cmd+Enter / Ctrl+Enter → primary action (Apply)
        //   Esc                    → cancel
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            apply();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
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
   * with the CSP nonce. Receives body + script as an explicit tuple from
   * `_getBodyParts()` instead of regex-extracting the script block.
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
      void vscode.window.showErrorMessage(`Apply Patch: ${sanitizeGitError(errMsg)}`);
      return;
    }

    // Per-file selection: a multi-file patch is presented as a multi-select
    // pick so the user can apply a subset. `'aborted'` means the user
    // dismissed the pick (or checked nothing) — leave the dialog open.
    const selection = await this._selectPatchSubset(applyOptions);
    if (selection === 'aborted') {
      return;
    }
    applyOptions = selection;

    let result: IApplyPatchResult;
    try {
      result = await this._patchService.applyPatch(this._repo, applyOptions);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Apply Patch failed: ${sanitizeGitError(errMsg)}`);
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

    // Conflict path: delegate to the Resolve Conflicts dialog.
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
    const detail = result.stderr ? `: ${sanitizeGitError(result.stderr)}` : '';
    void vscode.window.showErrorMessage(`Apply Patch failed${detail}`);
  }

  /**
   * Offer per-file selection for a multi-file patch.
   *
   * Mirrors IntelliJ `ApplyPatchDifferentiatedDialog` (platform/vcs-impl/.../
   * patch/ApplyPatchDifferentiatedDialog.java), which lists the patch's files
   * in a checkbox tree and applies only the checked rows
   * (`getIncludedChanges()`). We resolve the raw patch text, split it per file,
   * and — when more than one file is present — present a multi-select pick
   * (all pre-checked). Only the chosen files' blocks are reassembled (via
   * `filterPatchByFiles`) and applied inline as `patchContent`.
   *
   * Returns:
   *  - the original options unchanged when the patch touches ≤ 1 file, when the
   *    user keeps every file checked, or when the raw text can't be read
   *    (fall through to a whole-patch apply);
   *  - new options carrying the reassembled subset when a strict subset is
   *    chosen;
   *  - `'aborted'` when the user dismisses the pick or checks nothing.
   */
  private async _selectPatchSubset(
    options: IApplyPatchOptions
  ): Promise<IApplyPatchOptions | 'aborted'> {
    // Resolve the raw patch text without disturbing the apply source. Inline
    // content is already in hand; a file source is read best-effort.
    let content = options.patchContent;
    if (content === undefined && options.patchPath) {
      try {
        content = await fs.promises.readFile(options.patchPath, 'utf-8');
      } catch {
        // Can't read the patch here — let `git apply` surface the real error.
        return options;
      }
    }
    if (content === undefined) {
      return options;
    }

    const segments = splitPatchByFile(content);
    if (segments.length <= 1) {
      // Headerless or single-file patch: nothing to subset.
      return options;
    }

    const picked = await vscode.window.showQuickPick(
      segments.map((segment) => ({ label: segment.path, picked: true })),
      {
        canPickMany: true,
        title: 'Apply Patch — Select Files',
        placeHolder: 'Choose which files to apply (all selected by default)',
      }
    );
    if (picked === undefined) {
      return 'aborted';
    }
    const selectedPaths = picked.map((item) => item.label);
    if (selectedPaths.length === 0) {
      return 'aborted';
    }
    if (selectedPaths.length === segments.length) {
      // Every file checked → today's behavior; keep the original source.
      return options;
    }

    // Strict subset: reassemble only the chosen files' blocks and apply inline.
    const subset = filterPatchByFiles(content, selectedPaths);
    return { ...options, patchPath: undefined, patchContent: subset };
  }

  /**
   * Resolve the webview apply payload into a concrete IApplyPatchOptions.
   * Reads clipboard when requested; validates that exactly one source was
   * supplied.
   */
  private async _buildApplyOptions(
    msg: Extract<IncomingMessage, { type: 'apply' }>
  ): Promise<IApplyPatchOptions> {
    // Validate at the webview boundary as defense-in-depth. The
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
