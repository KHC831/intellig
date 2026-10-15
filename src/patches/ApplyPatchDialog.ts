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
 *   - Preview button: dry-runs the apply per file and lists the per-file
 *     verdict, above a capped dump of the patch body. Re-runnable, since the
 *     verdict describes the working tree at the moment it ran.
 *   - Apply + Cancel buttons; Apply is gated on the form validating.
 *
 * On `--3way` conflicts the dialog delegates to
 * `IConflictResolutionService.openResolveConflictsDialog(repo, conflicts,
 * { operation: 'applyPatch', … })`. No bespoke conflict surface.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { BaseWebviewPanel } from '../utils/BaseWebviewPanel';
import { assertNever } from '../utils/assertNever';
import {
  asApplyPatchDialogInbound,
  type IApplyPatchDialogInit,
  type ApplyPatchDialogInbound,
  type ApplyPatchDialogOutbound,
} from './applyPatchDialog.protocol';
import { initIslandHtml } from '../utils/webviewInit';
import { escapeHtml } from '../utils/escapeHtml';
import { IRepository } from '../git-core/interfaces/IGitService';
import { IConflictResolutionService } from '../conflicts/interfaces/IConflictResolutionService';
import { sanitizeGitError } from '../git-core/gitError';
import { IPatchService, IApplyPatchOptions, IApplyPatchResult } from './interfaces/IPatchService';
import {
  extractMailboxPreamble,
  filterPatchByFiles,
  uniquePatchPaths,
  validateBaseDir,
  validateStripLevel,
} from './PatchService';
import {
  applyPatchSettingsSlot,
  previewFileResult,
  PREVIEW_CHECK_CONCURRENCY,
  PREVIEW_FILE_CAP,
  type IApplyPatchSettings,
  type IPatchPreviewFile,
} from './applyPatchSettings';
import { createStalenessGuard } from '../registration/stalenessGuard';
import { mapWithLimit } from '../utils/mapWithLimit';
import { loadPersisted, savePersisted, type PersistedSlot } from '../utils/persistedState';

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

const VIEW_TYPE = 'intellig.applyPatchDialog';
const TITLE = 'Apply Patch';

/**
 * Cap preview output at this many lines to keep the webview responsive when
 * users open a 10k-line patch.
 */
const PREVIEW_LINE_CAP = 500;

export class ApplyPatchDialog extends BaseWebviewPanel<ApplyPatchDialogOutbound> {
  private readonly _repo: IRepository;
  private readonly _patchService: IPatchService;
  private readonly _conflictResolutionService: IConflictResolutionService | undefined;
  private readonly _onApplyComplete: (() => void) | undefined;
  /** Current patch path displayed in the dialog (may be `undefined`). */
  private _patchPath: string | undefined;
  private _busy = false;
  private readonly _workspaceState: vscode.Memento;
  private readonly _settings: IApplyPatchSettings;
  private readonly _settingsSlot: PersistedSlot<IApplyPatchSettings>;
  /** Supersedes an in-flight preview when a newer one starts. */
  private readonly _previewGuard = createStalenessGuard();
  /**
   * The latest Preview requested while one was already running. Only the most
   * recent is kept — intermediate clicks describe trees already superseded.
   */
  private _pendingPreview:
    { msg: Extract<ApplyPatchDialogInbound, { type: 'preview' }>; generation: number } | undefined;

  constructor(context: vscode.ExtensionContext, options: IApplyPatchDialogOptions) {
    super(context, VIEW_TYPE, TITLE, vscode.ViewColumn.One);
    this._repo = options.repo;
    this._patchService = options.patchService;
    this._conflictResolutionService = options.conflictResolutionService;
    this._onApplyComplete = options.onApplyComplete;
    this._patchPath = options.initialPatchPath;
    this._workspaceState = context.workspaceState;
    this._settingsSlot = applyPatchSettingsSlot(this._repo.rootUri.fsPath);
    this._settings = loadPersisted(context.workspaceState, this._settingsSlot) ?? {};

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
      .check-list:not(:empty) {
        margin: 8px 0;
        padding: 6px 8px;
        border: 1px solid var(--vscode-panel-border);
        max-height: 140px;
        overflow: auto;
      }
      .check {
        display: flex;
        gap: 8px;
        align-items: baseline;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 12px;
      }
      .check.ok .check-icon { color: var(--vscode-testing-iconPassed, #89d185); }
      .check.conflicts .check-icon { color: var(--vscode-editorWarning-foreground, #cca700); }
      .check.fails .check-icon { color: var(--vscode-testing-iconFailed, #f14c4c); }
      .check-msg { color: var(--vscode-descriptionForeground); }
      .check-cap {
        color: var(--vscode-descriptionForeground);
        font-style: italic;
        margin-bottom: 4px;
      }
      .check-list[data-stale] { opacity: 0.6; }
      .stale {
        color: var(--vscode-editorWarning-foreground);
        font-style: italic;
        margin-bottom: 4px;
      }
      .validation:not(:empty) {
        color: var(--vscode-inputValidation-errorForeground, var(--vscode-editorError-foreground));
        font-size: 12px;
        padding: 4px 0;
      }
    `;
  }

  protected _getBodyHtml(): string {
    const init: IApplyPatchDialogInit = {
      patchPath: this._patchPath ?? '',
      previewLineCap: PREVIEW_LINE_CAP,
      stripLevel: this._settings.stripLevel ?? 1,
      baseDir: this._settings.baseDir ?? '',
      useAm: this._settings.useAm ?? false,
    };
    return `<div id="root"></div>${initIslandHtml(init)}`;
  }

  /**
   * Override the base renderer so the body ships with an EXTERNAL bundle tag
   * (media/webview/applyPatchDialog.js) instead of the base's empty sentinel.
   * The interactive logic lives in the bundled entry
   * (src/patches/webview/applyPatchDialog.ts), which reads its init from the
   * body island.
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
      vscode.Uri.joinPath(this._context.extensionUri, 'media', 'webview', 'applyPatchDialog.js')
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

  /**
   * Route incoming webview messages. See ApplyPatchDialogInbound for the full
   * discriminated union.
   */
  protected async _onMessage(raw: unknown): Promise<void> {
    if (this._disposed) {
      return;
    }
    const msg = asApplyPatchDialogInbound(raw);
    if (!msg) {
      return;
    }

    switch (msg.type) {
      case 'cancel':
        this.dispose();
        return;
      case 'browse':
        await this._handleBrowse();
        return;
      // Preview and apply share the guard: two previews would race each
      // other's dry-run verdicts, and a preview started before an apply
      // would report on a tree the apply has already changed.
      // A newer Preview supersedes the running one: the generation is bumped
      // BEFORE the mutex, so the in-flight pass sees itself stale and stops
      // before its next spawn instead of running to completion. The request
      // is then queued rather than dropped — silently ignoring the click
      // would leave the user with verdicts they just asked to replace.
      case 'preview': {
        const generation = this._previewGuard.bump();
        if (this._busy) {
          this._pendingPreview = { msg, generation };
          await this.postMessage({
            type: 'previewStatus',
            message: 'Re-running preview…',
          });
          return;
        }
        this._busy = true;
        try {
          let next: { msg: typeof msg; generation: number } | undefined = { msg, generation };
          while (next) {
            await this._handlePreview(next.msg, next.generation);
            next = this._pendingPreview;
            this._pendingPreview = undefined;
          }
        } finally {
          this._busy = false;
        }
        return;
      }
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
      default:
        assertNever(msg);
    }
  }

  /**
   * Merge `changes` into the remembered dialog settings and persist them, so
   * the next open starts from the user's last form rather than the defaults.
   */
  private async _rememberSettings(changes: IApplyPatchSettings): Promise<void> {
    Object.assign(this._settings, changes);
    await savePersisted(this._workspaceState, this._settingsSlot, this._settings);
  }

  /**
   * Show a file-open dialog filtered to `.patch` / `.diff` files. Updates the
   * dialog's internal patch path on selection.
   */
  private async _handleBrowse(): Promise<void> {
    const uri = await vscode.window.showOpenDialog({
      defaultUri:
        this._settings.lastPatchDir === undefined
          ? this._repo.rootUri
          : vscode.Uri.file(this._settings.lastPatchDir),
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
    await this._rememberSettings({ lastPatchDir: path.dirname(this._patchPath) });
    await this.postMessage({
      type: 'patchPathChosen',
      patchPath: this._patchPath,
      ...(await this._probeMailboxEnvelope(this._patchPath, false)),
    });
  }

  /**
   * Report whether the patch opens with a `git am` envelope, for the form's
   * pre-flight gate. Best effort: an unreadable patch yields no fact rather
   * than a wrong one, and the preview/apply paths surface the read error.
   */
  private async _probeMailboxEnvelope(
    patchPath: string | undefined,
    useClipboard: boolean | undefined
  ): Promise<{ hasMailboxEnvelope?: boolean }> {
    try {
      const text = await this._readPatchContent(patchPath, useClipboard);
      return { hasMailboxEnvelope: extractMailboxPreamble(text) !== undefined };
    } catch {
      return {};
    }
  }

  /**
   * Load the patch for preview: the (capped) body plus a per-file dry-run
   * verdict, so the user sees which files will actually apply before
   * committing to it. Re-run on demand, which is also how a preview that went
   * stale against the working tree is refreshed.
   */
  private async _handlePreview(
    msg: Extract<ApplyPatchDialogInbound, { type: 'preview' }>,
    generation: number
  ): Promise<void> {
    try {
      const text = await this._readPatchContent(msg.patchPath, msg.useClipboard);
      const lines = text.split('\n');
      const overflow = lines.length - PREVIEW_LINE_CAP;
      const capped =
        overflow > 0
          ? lines.slice(0, PREVIEW_LINE_CAP).join('\n') +
            `\n\n… (${overflow} more ${overflow === 1 ? 'line' : 'lines'} truncated)`
          : text;
      const { files, checked, total } = await this._runPreviewChecks(text, msg, generation);
      // A superseded pass must not paint: its verdicts describe inputs the
      // user has already replaced, and the queued run will post its own.
      if (!this._previewGuard.isCurrent(generation)) {
        return;
      }
      await this.postMessage({
        type: 'preview',
        content: capped,
        files,
        checkedFiles: checked,
        totalFiles: total,
        hasMailboxEnvelope: extractMailboxPreamble(text) !== undefined,
      });
    } catch (error) {
      if (!this._previewGuard.isCurrent(generation)) {
        return;
      }
      const errMsg = error instanceof Error ? error.message : String(error);
      await this.postMessage({
        type: 'error',
        message: `Preview failed: ${errMsg}`,
      });
    }
  }

  /**
   * Run a dry-run apply per file in the patch and collect the verdicts.
   *
   * Checking each file separately (rather than reading git's prose from one
   * whole-patch run) is what makes the result attributable to a file. The
   * dry run uses the same 3-way strategy the real apply does, so a verdict
   * predicts the apply outcome — including the conflicted-but-appliable case.
   * It writes nothing. A headerless patch yields a single whole-patch verdict.
   *
   * One verdict per DISTINCT path, matching the per-file selection the apply
   * pick offers: a path carried by several commits applies or conflicts as
   * one unit.
   *
   * Each verdict costs a git process, so the pass is bounded three ways: at
   * most {@link PREVIEW_FILE_CAP} paths, at most
   * {@link PREVIEW_CHECK_CONCURRENCY} processes in flight, and a staleness
   * generation so a newer Preview stops the one the user superseded before
   * its next spawn rather than after all of them.
   */
  private async _runPreviewChecks(
    content: string,
    msg: Extract<ApplyPatchDialogInbound, { type: 'preview' }>,
    generation: number
  ): Promise<{ files: IPatchPreviewFile[]; checked: number; total: number }> {
    const common = {
      useAm: msg.useAm,
      stripLevel: msg.stripLevel,
      baseDir: msg.baseDir,
      check: true,
    };
    const paths = uniquePatchPaths(content);
    if (paths.length === 0) {
      const result = await this._patchService.applyPatch(this._repo, {
        ...common,
        patchContent: content,
      });
      return { files: [previewFileResult('(whole patch)', result)], checked: 1, total: 1 };
    }

    const checkedPaths = paths.slice(0, PREVIEW_FILE_CAP);
    const verdicts = await mapWithLimit(
      checkedPaths,
      PREVIEW_CHECK_CONCURRENCY,
      async ({ path: filePath }) => {
        // Disposal or a newer preview must stop the run before the next
        // spawn: the panel these verdicts would post to is gone or stale.
        if (this._disposed || !this._previewGuard.isCurrent(generation)) {
          return undefined;
        }
        const result = await this._patchService.applyPatch(this._repo, {
          ...common,
          patchContent: filterPatchByFiles(content, [filePath]),
        });
        return previewFileResult(filePath, result);
      }
    );

    const files = verdicts.filter((v): v is IPatchPreviewFile => v !== undefined);
    // `checked` describes what the CAP admitted, not what survived — a
    // cancelled pass never paints, so conflating the two would let a
    // superseded run report itself as merely capped.
    return { files, checked: checkedPaths.length, total: paths.length };
  }

  /**
   * Build the {@link IApplyPatchOptions} bag from a webview apply message
   * and invoke the PatchService. Handles success, conflict, and hard-error
   * paths.
   */
  private async _handleApply(
    msg: Extract<ApplyPatchDialogInbound, { type: 'apply' }>
  ): Promise<void> {
    let applyOptions: IApplyPatchOptions;
    try {
      applyOptions = await this._buildApplyOptions(msg);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Apply Patch: ${sanitizeGitError(errMsg)}`);
      return;
    }
    // Only a form the apply path accepts is worth remembering; persisting
    // first would re-seed a rejected value on every later open.
    await this._rememberSettings({
      stripLevel: msg.stripLevel,
      baseDir: msg.baseDir,
      useAm: msg.useAm,
    });

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

    // Conflict path: delegate to the Resolve Conflicts dialog. The pre-apply
    // bracket token rides along so the dialog's Abort can restore the FULL
    // pre-apply state (cleanly-applied siblings included).
    if (result.conflicts && result.conflicts.length > 0) {
      if (this._conflictResolutionService) {
        await this._conflictResolutionService.openResolveConflictsDialog(
          this._repo,
          result.conflicts,
          {
            operation: 'applyPatch',
            canAbort: true,
            canContinue: true,
            ...(result.preApplyState ? { preApplyState: result.preApplyState } : {}),
            ...(result.preApplySnapshotFailed ? { preApplySnapshotFailed: true } : {}),
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

    // Hard failure: surface git stderr. A failed `git am` that left a paused
    // session on disk gets the am recovery actions — a plain toast would
    // strand the user in a session only `git am --continue/--skip/--abort`
    // can end (git refuses the rebase recovery commands during am).
    const detail = result.stderr ? `: ${sanitizeGitError(result.stderr)}` : '';
    if (result.amSessionActive) {
      await this._offerAmRecovery(detail);
      return;
    }
    void vscode.window.showErrorMessage(`Apply Patch failed${detail}`);
  }

  /**
   * Failure arm for a `useAm` apply that paused with a live `git am` session:
   * offer the session's own recovery ops. Skip and Abort are destructive and
   * confirm once (modal), matching the rebase recovery commands' policy.
   * Continue/Skip outcomes mirror the primary apply arms: success completes
   * the dialog, further conflicts hand off to the Resolve Conflicts dialog.
   * After an abort the dialog stays open so the user can adjust and retry.
   */
  private async _offerAmRecovery(detail: string): Promise<void> {
    const choice = await vscode.window.showErrorMessage(
      `Apply Patch failed${detail} — the patch apply (git am) is paused. ` +
        `Continue after resolving, skip the failing patch, or abort to restore the pre-apply state.`,
      'Continue',
      'Skip Patch',
      'Abort'
    );
    if (choice === 'Continue') {
      await this._finishAmSession(await this._patchService.amContinue(this._repo), 'continue');
      return;
    }
    if (choice === 'Skip Patch') {
      const confirm = await vscode.window.showWarningMessage(
        'Skip this patch? Its changes will NOT be applied.',
        { modal: true },
        'Skip'
      );
      if (confirm !== 'Skip') {
        return;
      }
      await this._finishAmSession(await this._patchService.amSkip(this._repo), 'skip patch');
      return;
    }
    if (choice === 'Abort') {
      const confirm = await vscode.window.showWarningMessage(
        'Abort the patch apply? Your working tree will be restored to its pre-apply state.',
        { modal: true },
        'Abort'
      );
      if (confirm !== 'Abort') {
        return;
      }
      const res = await this._patchService.amAbort(this._repo);
      if (res.success) {
        void vscode.window.showInformationMessage('Patch apply aborted.');
      } else {
        void vscode.window.showErrorMessage(
          `Failed to abort patch apply: ${sanitizeGitError(res.failureReason ?? 'unknown error (no output from git)')}`
        );
      }
    }
    // Dismissed (Esc): the session stays paused; the paused-operation toast
    // and the intellig.am.* palette commands remain the recovery route.
  }

  /**
   * Route an am continue/skip outcome through the same three arms as the
   * primary apply: completed, further conflicts (Resolve Conflicts handoff),
   * or a hard error toast.
   */
  private async _finishAmSession(
    res: Awaited<ReturnType<IPatchService['amContinue']>>,
    verb: string
  ): Promise<void> {
    if (res.success) {
      void vscode.window.showInformationMessage('Patch applied.');
      this._onApplyComplete?.();
      this.dispose();
      return;
    }
    if (res.conflicts && res.conflicts.length > 0 && this._conflictResolutionService) {
      await this._conflictResolutionService.openResolveConflictsDialog(this._repo, res.conflicts, {
        operation: 'applyPatch',
        canAbort: true,
        canContinue: true,
      });
      this._onApplyComplete?.();
      this.dispose();
      return;
    }
    void vscode.window.showErrorMessage(
      `Failed to ${verb}: ${sanitizeGitError(res.failureReason ?? 'unknown error (no output from git)')}`
    );
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

    // One row per distinct path: selection is per file, so a path touched by
    // several commits gets a single row annotated with its block count rather
    // than identical rows whose individual states the apply cannot honour.
    const paths = uniquePatchPaths(content);
    if (paths.length <= 1) {
      // Headerless or single-file patch: nothing to subset.
      return options;
    }

    const picked = await vscode.window.showQuickPick(
      paths.map(({ path: filePath, count }) => ({
        label: filePath,
        picked: true,
        ...(count > 1 ? { description: `${count} changes` } : {}),
      })),
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
    if (selectedPaths.length === paths.length) {
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
    msg: Extract<ApplyPatchDialogInbound, { type: 'apply' }>
  ): Promise<IApplyPatchOptions> {
    // Validate at the webview boundary as defense-in-depth. The
    // webview sends `parseInt(..., 10)` which returns NaN on non-numeric
    // values; PatchService would catch that too, but surfacing here produces
    // a cleaner error message.
    const stripErr = validateStripLevel(msg.stripLevel);
    if (stripErr) {
      throw new Error(stripErr);
    }
    const baseDirErr = validateBaseDir(msg.baseDir, this._repo.rootUri.fsPath);
    if (baseDirErr) {
      throw new Error(baseDirErr);
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
