/**
 * Merge Dialog.
 *
 * IntelliJ-style "Merge Branch" modal. Replaces the direct
 * `gitService.mergeBranch(repo, branch)` call with a webview panel
 * (extends {@link BaseWebviewPanel}) that exposes the full CLI option
 * surface as check-boxes + an optional commit-message textarea.
 *
 * Fields:
 *  - Source branch (read-only, passed in via constructor).
 *  - Target branch (read-only, computed from `repo.head`).
 *  - `--ff-only` checkbox — require a fast-forward.
 *  - `--no-ff`   checkbox — always create a merge commit.
 *  - `--squash`  checkbox — stage changes without creating a commit.
 *  - `--no-commit` checkbox — merge but don't commit.
 *  - Commit message textarea — passed as `-m <msg>`.
 *
 * Mutex:
 *  - `--ff-only` clears `--no-ff` and `--squash` (CLI-incompatible).
 *  - `--squash`  clears `--no-ff` and `--ff-only`.
 *  - `--no-ff`   clears `--ff-only` and `--squash`.
 *
 * Conflict handoff: on non-success with conflicts, invokes
 * {@link IConflictResolutionService.openResolveConflictsDialog} with
 * `operation: 'merge'`, matching the caller-invoked pattern.
 *
 * No destructive-op confirm — merge is recoverable via `git merge --abort`.
 */

import * as vscode from 'vscode';
import { BaseWebviewPanel } from '../utils/BaseWebviewPanel';
import { assertNever } from '../utils/assertNever';
import {
  asMergeDialogInbound,
  type IMergeDialogInit,
  type MergeDialogOutbound,
} from './mergeDialog.protocol';
import { initIslandHtml } from '../utils/webviewInit';
import { IGitService, IMergeOptions, IRepository } from '../git-core/interfaces/IGitService';
import { IConflictResolutionService } from './interfaces/IConflictResolutionService';
import { sanitizeGitError } from '../git-core/gitError';
import { getLogger } from '../utils/logger';
import { escapeHtml } from '../utils/escapeHtml';
import { proposeDeleteMergedBranch } from '../branches/deleteOnMerge';

/** Options for constructing a {@link MergeDialog}. */
export interface IMergeDialogOptions {
  repo: IRepository;
  /** The branch being merged INTO the current branch. */
  sourceBranch: string;
  gitService: IGitService;
  /** Optional — used for the conflict handoff. */
  conflictResolutionService?: IConflictResolutionService;
  /** Optional callback fired after a successful merge. */
  onMergeComplete?: () => void;
  /**
   * deleteOnMerge PROPOSE (git4idea GitBrancher.DeleteOnMergeOption): when
   * true, the success toast offers deleting the merged source branch. The
   * caller computes eligibility — non-protected LOCAL branches only.
   */
  proposeDeleteOnMerge?: boolean;
}

/** Strategy flags that are mutually exclusive. Used by the UI mutex resolver. */
export type MergeStrategyFlag = 'ffOnly' | 'noFf' | 'squash';

/**
 * Pure flag-state type. Mirrors {@link IMergeOptions} minus `message`,
 * which lives in the textarea.
 */
export interface IMergeFlagState {
  ffOnly: boolean;
  noFf: boolean;
  squash: boolean;
  noCommit: boolean;
}

/**
 * Pure mutex resolver — when a strategy flag is freshly enabled, clear
 * the other strategy flags so the CLI-incompatible combinations can't
 * reach {@link GitService.mergeBranch}.
 *
 * Exported for focused unit testing.
 */
export function resolveMergeMutex(
  flags: IMergeFlagState,
  lastToggled?: MergeStrategyFlag
): IMergeFlagState {
  const strategy: MergeStrategyFlag[] = ['ffOnly', 'noFf', 'squash'];
  const next: IMergeFlagState = { ...flags };

  if (lastToggled && strategy.includes(lastToggled) && next[lastToggled]) {
    for (const other of strategy) {
      if (other !== lastToggled) {
        next[other] = false;
      }
    }
    return next;
  }

  // No explicit `lastToggled` — enforce "at most one strategy flag" by
  // keeping the first enabled one (in declaration order).
  let seen = false;
  for (const key of strategy) {
    if (next[key]) {
      if (seen) {
        next[key] = false;
      } else {
        seen = true;
      }
    }
  }
  return next;
}

/** Webview → extension message shape. */

const VIEW_TYPE = 'intellig.mergeDialog';
const TITLE = 'Merge Branch';

export class MergeDialog extends BaseWebviewPanel<MergeDialogOutbound> {
  private readonly _repo: IRepository;
  private readonly _sourceBranch: string;
  private readonly _targetBranch: string;
  private readonly _gitService: IGitService;
  private readonly _conflictResolutionService?: IConflictResolutionService;
  private readonly _onMergeComplete?: () => void;
  private readonly _proposeDeleteOnMerge: boolean;
  private _busy = false;

  constructor(context: vscode.ExtensionContext, options: IMergeDialogOptions) {
    super(context, VIEW_TYPE, TITLE, vscode.ViewColumn.One);
    this._repo = options.repo;
    this._sourceBranch = options.sourceBranch;
    this._targetBranch = options.repo.head?.name?.replace(/^refs\/heads\//, '') ?? 'HEAD';
    this._gitService = options.gitService;
    this._conflictResolutionService = options.conflictResolutionService;
    this._onMergeComplete = options.onMergeComplete;
    this._proposeDeleteOnMerge = options.proposeDeleteOnMerge === true;
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
      .summary {
        margin-bottom: 16px;
        padding: 8px 10px;
        background: var(--vscode-editor-inactiveSelectionBackground);
        border-left: 3px solid var(--vscode-focusBorder);
        font-family: var(--vscode-editor-font-family, monospace);
      }
      .summary .label { color: var(--vscode-descriptionForeground); margin-right: 6px; }
      .flags { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
      label.flag { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; }
      label.flag input[disabled] + .label-text { opacity: 0.55; cursor: not-allowed; }
      label.flag .label-text { display: flex; flex-direction: column; gap: 2px; }
      label.flag .label-text .title-line { font-weight: 600; }
      label.flag .label-text .desc {
        font-size: 0.9em;
        color: var(--vscode-descriptionForeground);
      }
      .message-area {
        margin: 16px 0 10px;
      }
      .message-area label {
        display: block;
        margin-bottom: 4px;
        color: var(--vscode-descriptionForeground);
      }
      textarea {
        width: 100%;
        min-height: 60px;
        box-sizing: border-box;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent);
        padding: 4px 6px;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: var(--vscode-font-size);
      }
      .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
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
    const init: IMergeDialogInit = {
      sourceBranch: this._sourceBranch,
      targetBranch: this._targetBranch,
    };
    return `<div id="root"></div>${initIslandHtml(init)}`;
  }

  /**
   * Override the base renderer so the body ships with an EXTERNAL bundle tag
   * (media/webview/mergeDialog.js) instead of the base's empty sentinel. The
   * interactive logic lives in the bundled TS entry (src/conflicts/webview/main.ts),
   * which reads its init from the body island.
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
      vscode.Uri.joinPath(this._context.extensionUri, 'media', 'webview', 'mergeDialog.js')
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
    const msg = asMergeDialogInbound(raw);
    if (!msg) {
      return;
    }

    switch (msg.type) {
      case 'cancel':
        this.dispose();
        return;

      case 'merge': {
        const flagsIn: IMergeFlagState = {
          ffOnly: msg.flags?.ffOnly === true,
          noFf: msg.flags?.noFf === true,
          squash: msg.flags?.squash === true,
          noCommit: msg.flags?.noCommit === true,
        };
        // Defensive mutex resolution: even if the webview bypasses the UI
        // mutex, the strategy flags must be CLI-compatible.
        const flags = resolveMergeMutex(flagsIn);
        const options: IMergeOptions = {
          ffOnly: flags.ffOnly || undefined,
          noFf: flags.noFf || undefined,
          squash: flags.squash || undefined,
          noCommit: flags.noCommit || undefined,
          noVerify: msg.noVerify === true || undefined,
          allowUnrelatedHistories: msg.allowUnrelatedHistories === true || undefined,
          message: msg.message && msg.message.trim().length > 0 ? msg.message : undefined,
        };
        await this._executeMerge(options);
        return;
      }
      default:
        assertNever(msg);
    }
  }

  private async _executeMerge(options: IMergeOptions): Promise<void> {
    this._busy = true;
    try {
      const result = await this._gitService.mergeBranch(this._repo, this._sourceBranch, options);
      if (result.success) {
        const verb = options.squash
          ? 'Squash-merged'
          : options.noCommit
            ? 'Merged (no commit)'
            : 'Merged';
        const successMessage = `${verb} '${this._sourceBranch}' into '${this._targetBranch}'`;
        if (this._proposeDeleteOnMerge) {
          // deleteOnMerge PROPOSE: the success toast carries a
          // "Delete <branch>" action. Fire-and-forget — it outlives this
          // dialog's dispose below.
          void proposeDeleteMergedBranch(
            { gitService: this._gitService, onDeleted: this._onMergeComplete },
            this._repo,
            this._sourceBranch,
            successMessage
          );
        } else {
          void vscode.window.showInformationMessage(successMessage);
        }
        if (this._onMergeComplete) {
          try {
            this._onMergeComplete();
          } catch (err) {
            getLogger()
              .child({ component: 'MergeDialog' })
              .error('onMergeComplete threw', err instanceof Error ? err : undefined);
          }
        }
        this.dispose();
        return;
      }
      if (result.conflicts && result.conflicts.length > 0 && this._conflictResolutionService) {
        await this._conflictResolutionService.openResolveConflictsDialog(
          this._repo,
          result.conflicts.map((p) => ({ path: p, resolved: false })),
          {
            operation: 'merge',
            target: this._sourceBranch,
            canAbort: true,
            canContinue: true,
          }
        );
        this.dispose();
        return;
      }
      // No conflict service wired OR no conflicts: fall back to a warning.
      // Surface git's own reason (already sanitized by the ops layer) when it
      // gave one — "refusing to merge unrelated histories", "local changes
      // would be overwritten", etc. — rather than the generic run-git-status.
      const reason = result.failureReason
        ? `: ${result.failureReason}`
        : ". Run 'git status' for details.";
      // sanitize-exempt: pre-sanitized: `reason` embeds result.failureReason, which BranchOps._mergeBranch already runs through sanitizeGitError; `sourceBranch` is a validated branch name, not git stderr.
      void vscode.window.showWarningMessage(
        `Merge of '${this._sourceBranch}' did not complete cleanly${reason}`
      );
      this._busy = false;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to merge: ${sanitizeGitError(msg)}`);
      this._busy = false;
    }
  }
}

/**
 * Convenience factory.
 */
export function showMergeDialog(
  context: vscode.ExtensionContext,
  options: IMergeDialogOptions
): MergeDialog {
  return new MergeDialog(context, options);
}
