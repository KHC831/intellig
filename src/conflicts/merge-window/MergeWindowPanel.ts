import * as vscode from 'vscode';
import { readConfig } from '../../config/configKeys';
import * as path from 'path';
import * as fs from 'fs';
import { BaseWebviewPanel } from '../../utils/BaseWebviewPanel';
import { assertNever } from '../../utils/assertNever';
import {
  asMergeWindowInbound,
  type MergeWindowConfirmAction,
  type MergeWindowOutbound,
} from './mergeWindow.protocol';
import { IGitService, IRepository } from '../../git-core/interfaces/IGitService';
import { GitCli } from '../../git-core/gitCli';
import { sanitizeGitError } from '../../git-core/gitError';
import { atomicWriteFileSync } from '../../utils/atomicWrite';
import { escapeHtml } from '../../utils/escapeHtml';
import { getLogger } from '../../utils/logger';
import { assignMergePanes, loadMergeStageContents, stageIdentityOf } from './mergeStages';
import { IStageNames } from '../conflictSideNames';
import { IConflictOpContext } from '../interfaces/IConflictResolutionService';
import { mergeWindowStyles } from './mergeWindowHtml';
import { buildCodiconFontFaceCss } from '../../git-core/gitToolWindow/provider/stylesBuilder';
import { detectEol, normalizeToLf, restoreEol } from './mergeWindowText';
import { loadPersisted, savePersisted, type PersistedSlot } from '../../utils/persistedState';

/** "1 change and 2 conflicts" — zero parts drop out; never empty for a real confirm. */
export function unprocessedPhrase(changes: number, conflicts: number): string {
  const parts: string[] = [];
  if (changes > 0) {
    parts.push(`${changes} ${changes === 1 ? 'change' : 'changes'}`);
  }
  if (conflicts > 0) {
    parts.push(`${conflicts} ${conflicts === 1 ? 'conflict' : 'conflicts'}`);
  }
  return parts.join(' and ') || 'no changes';
}

/** How long the host coalesces per-keystroke result posts before persisting. */
const PERSIST_DEBOUNCE_MS = 400;

/**
 * A restorable merge result, bound to the index stages it was produced
 * from. Offering it against different stages would seed an unrelated later
 * conflict on the same path with the wrong content.
 */
interface IUnsavedMergeResult {
  readonly text: string;
  readonly stages: string;
}

/**
 * The conflict operation and raw stage names the pane assignment maps to
 * user sides. Kept raw (per git stage) so the panel can run stage contents
 * and names through one reversal decision.
 */
export interface IMergeWindowConflictContext {
  readonly stageNames: IStageNames;
  readonly operation: IConflictOpContext['operation'] | undefined;
}

/**
 * The IntelliG merge window: an IntelliJ-style three-pane conflict resolver
 * (yours | editable result | theirs) on Monaco, powered by the ported merge
 * engine. The whole merge model runs inside the webview
 * (media/mergeWindow.js); this panel loads the three index stages, supplies
 * labels, and finalizes the result (write + stage) on Apply.
 *
 * Opened by MergeView.show() only when `intellig.mergeWindow.enabled` is on —
 * the VS Code merge editor remains the default path.
 */
export class MergeWindowPanel extends BaseWebviewPanel<MergeWindowOutbound> {
  private _eol: '\n' | '\r\n' = '\n';
  private _modified = false;
  private _stageIdentity = '';
  private _pendingResult: { text: string | undefined } | undefined;
  private _persistTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    context: vscode.ExtensionContext,
    private readonly _opts: {
      repository: IRepository;
      relPath: string;
      absolutePath: string;
      conflictContext: IMergeWindowConflictContext;
      gitCli: GitCli;
      gitService: IGitService;
      onApplied: (relPath: string) => void;
    }
  ) {
    super(
      context,
      'intellig.mergeWindow',
      `Merge: ${path.basename(_opts.absolutePath)}`,
      vscode.ViewColumn.Active
    );
    this._render();
  }

  protected override async _onMessage(message: unknown): Promise<void> {
    const msg = asMergeWindowInbound(message);
    if (!msg) {
      getLogger()
        .child({ component: 'MergeWindowPanel' })
        .warn('merge window posted an unknown message type; ignoring');
      return;
    }
    switch (msg.type) {
      case 'ready':
        await this._sendInit();
        return;
      case 'apply':
        // Fail closed: a malformed message must not become an empty-file
        // write + stage. Only our own bundle posts 'apply', so a missing
        // resultText is a protocol bug to surface, not a state to default.
        if (typeof msg.resultText !== 'string') {
          getLogger()
            .child({ component: 'MergeWindowPanel' })
            .error("merge window posted 'apply' without resultText; ignoring");
          return;
        }
        await this._apply(msg.resultText);
        return;
      case 'abort':
        await this._abort(msg.modified === true);
        return;
      case 'confirm':
        // A malformed requestId cannot be answered; drop rather than reply
        // with an id the webview never issued.
        if (typeof msg.requestId !== 'number') {
          getLogger()
            .child({ component: 'MergeWindowPanel' })
            .error("merge window posted 'confirm' without a numeric requestId; ignoring");
          return;
        }
        await this._confirm(msg.requestId, msg.action, msg.changes, msg.conflicts);
        return;
      case 'state':
        this._modified = msg.modified === true;
        // VS Code cannot veto a webview tab close (IntelliJ's close-confirm
        // has no equivalent hook), so the latest modified result is
        // persisted and offered for restore when the file reopens.
        if (msg.pristine === true) {
          // Nothing the user authored: the result is the base plus whatever
          // auto-apply landed, which reopening reproduces. Skip the write
          // rather than erasing — a fresh webview reports pristine too, and a
          // result the user kept by dismissing the restore prompt must survive
          // that.
          return;
        }
        if (this._modified && typeof msg.resultText === 'string') {
          this._saveUnsavedResult(msg.resultText);
        }
        return;
      case 'log': {
        const logger = getLogger().child({ component: 'MergeWindowPanel' });
        if (msg.level === 'fatal') {
          // A half-built webview can neither Apply nor Abort, so leaving the
          // tab open reads as a hung merge. Say so and close it.
          logger.error(String(msg.text));
          void vscode.window.showErrorMessage(
            `The merge window for ${path.basename(this._opts.absolutePath)} could not run. ` +
              'The conflict is unchanged; reopen it to try again.'
          );
          this.dispose();
        } else if (msg.level === 'error') {
          logger.error(String(msg.text));
        } else {
          logger.warn(String(msg.text));
        }
        return;
      }
      default:
        assertNever(msg);
    }
  }

  private get _unsavedResultSlot(): PersistedSlot<IUnsavedMergeResult> {
    return {
      key: `intellig.mergeWindow.unsavedResult:${this._opts.repository.rootUri.fsPath}:${this._opts.relPath}`,
      version: 2,
      validate: (raw): IUnsavedMergeResult | undefined => {
        if (typeof raw !== 'object' || raw === null) {
          return undefined;
        }
        const { text, stages } = raw as Record<string, unknown>;
        // An empty result (everything deleted) is restorable too, so only the
        // type is checked, not the length.
        return typeof text === 'string' && typeof stages === 'string'
          ? { text, stages }
          : undefined;
      },
    };
  }

  private _saveUnsavedResult(text: string | undefined): void {
    // The webview posts state per keystroke; writing the whole conflicted
    // file to the Memento each time is the same write amplification a
    // refresh storm causes. Coalesce and let dispose() flush the tail.
    this._pendingResult = { text };
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
    }
    this._persistTimer = setTimeout(() => {
      this._persistTimer = undefined;
      this._flushUnsavedResult();
    }, PERSIST_DEBOUNCE_MS);
  }

  /** Drop the saved result immediately — user-explicit, never coalesced. */
  private _clearUnsavedResult(): void {
    this._pendingResult = { text: undefined };
    this._flushUnsavedResult();
  }

  /** Write the coalesced result now. Idempotent when nothing is pending. */
  protected _flushUnsavedResult(): void {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = undefined;
    }
    const pending = this._pendingResult;
    if (!pending) {
      return;
    }
    this._pendingResult = undefined;
    const value =
      pending.text === undefined ? undefined : { text: pending.text, stages: this._stageIdentity };
    void savePersisted(this._context.workspaceState, this._unsavedResultSlot, value);
  }

  override dispose(): void {
    // A closed tab must not lose the latest text the debounce was holding.
    this._flushUnsavedResult();
    super.dispose();
  }

  /**
   * Offer the result text a previously closed window left behind. Explicit
   * discard drops the copy; dismissing the prompt keeps it for a later
   * reopen without restoring now. A result saved against DIFFERENT index
   * stages belongs to a conflict that has since been resolved another way —
   * it is dropped rather than offered for an unrelated later conflict on the
   * same path. A result identical to the base carries no merge work (the
   * model stays flagged modified even after an undo back to the start), so it
   * is dropped rather than prompted for.
   */
  private async _promptForSavedResult(baseText: string): Promise<string | undefined> {
    const saved = loadPersisted(this._context.workspaceState, this._unsavedResultSlot);
    if (!saved) {
      return undefined;
    }
    if (saved.stages !== this._stageIdentity || normalizeToLf(saved.text) === baseText) {
      this._clearUnsavedResult();
      return undefined;
    }
    const restore = 'Restore';
    const discard = 'Discard Saved Result';
    const choice = await vscode.window.showInformationMessage(
      `${path.basename(this._opts.absolutePath)} has an unsaved merge result from a closed merge window. Restore it?`,
      { modal: true },
      restore,
      discard
    );
    if (choice === restore) {
      return saved.text;
    }
    if (choice === discard) {
      this._clearUnsavedResult();
    }
    return undefined;
  }

  private async _sendInit(): Promise<void> {
    const { repository, relPath, absolutePath, gitCli } = this._opts;
    try {
      const stages = await loadMergeStageContents(gitCli, repository.rootUri.fsPath, relPath);
      if (!stages) {
        void vscode.window.showInformationMessage(
          `${path.basename(absolutePath)} has no unmerged conflict entries.`
        );
        this.dispose();
        return;
      }

      // Restore the file's own separator on Apply; the engine works on LF.
      let eolSource = stages.ours;
      try {
        eolSource = fs.readFileSync(absolutePath, 'utf8');
        // eslint-disable-next-line no-restricted-syntax -- file deleted from the worktree (delete/modify conflict); the "ours" stage is the intended fallback for EOL detection.
      } catch {
        // Deleted from the worktree — fall back to the "ours" stage.
      }
      this._eol = detectEol(eolSource);
      this._stageIdentity = stageIdentityOf(stages.stageShas);

      // One reversal decision assigns contents and labels together — a
      // rebase/unstash/unshelve swaps both, so the pane titled with the
      // user's branch always shows the user's content.
      const { stageNames, operation } = this._opts.conflictContext;
      const panes = assignMergePanes(stages, stageNames, operation);
      const baseText = normalizeToLf(panes.base);
      const restoredResult = await this._promptForSavedResult(baseText);

      await this.postMessage({
        type: 'init',
        left: normalizeToLf(panes.left.content),
        base: baseText,
        right: normalizeToLf(panes.right.content),
        leftLabel: panes.left.label,
        rightLabel: panes.right.label,
        fileName: path.basename(absolutePath),
        // IntelliJ's "Automatically apply non-conflicting changes" (opt-in,
        // off by default there too).
        autoApplyNonConflicting: readConfig('mergeWindow.autoApplyNonConflicting'),
        ...(restoredResult !== undefined ? { restoredResult: normalizeToLf(restoredResult) } : {}),
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Failed to load merge data: ${sanitizeGitError(raw)}`);
      this.dispose();
    }
  }

  private async _apply(resultText: string): Promise<void> {
    const { repository, relPath, absolutePath, gitService, onApplied } = this._opts;
    try {
      atomicWriteFileSync(absolutePath, restoreEol(resultText, this._eol));
      await gitService.stage(repository, [relPath]).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Failed to apply merge result: ${sanitizeGitError(raw)}`);
      return;
    }
    this._clearUnsavedResult();
    onApplied(relPath);
    this.dispose();
  }

  /**
   * The webview asks before a destructive toolbar action: a whole-side
   * accept over a modified result (IntelliJ's
   * MergeUtil.showConfirmDiscardChangesDialog) or an Apply with changes
   * still unresolved (IntelliJ's handleResolvedCase counted confirm). The
   * answer rides back on the same requestId.
   */
  private async _confirm(
    requestId: number,
    action: MergeWindowConfirmAction,
    changes?: number,
    conflicts?: number
  ): Promise<void> {
    let message: string;
    let confirmLabel: string;
    if (action === 'applyUnresolved') {
      message = `There are ${unprocessedPhrase(changes ?? 0, conflicts ?? 0)} left unprocessed. Save changes and mark the conflict resolved anyway?`;
      confirmLabel = 'Apply Changes and Mark Resolved';
    } else {
      const actionName = action === 'acceptLeft' ? 'Accept Yours' : 'Accept Theirs';
      message = `There are unsaved changes in the result file. Discard changes and ${actionName.toLowerCase()} anyway?`;
      confirmLabel = `Discard Changes and ${actionName}`;
    }
    const choice = await vscode.window.showWarningMessage(message, { modal: true }, confirmLabel);
    await this.postMessage({ type: 'confirmResult', requestId, confirmed: choice !== undefined });
  }

  private async _abort(modified: boolean): Promise<void> {
    if (modified || this._modified) {
      const choice = await vscode.window.showWarningMessage(
        `Discard the merge result for ${path.basename(this._opts.absolutePath)}? The conflict stays unresolved.`,
        { modal: true },
        'Discard'
      );
      if (choice !== 'Discard') {
        return;
      }
    }
    this._clearUnsavedResult();
    this.dispose();
  }

  protected override _getBodyHtml(): string {
    // Empty body: the skeleton is DOM-built (createElement) by
    // media/mergeWindow.js at boot, per the repo webview convention.
    return '';
  }

  protected override _getStyles(): string {
    return mergeWindowStyles();
  }

  /**
   * Custom document wrapper: same CSP/nonce scaffolding as the base class,
   * plus the Monaco AMD loader and the bundled merge-window script. The AMD
   * loader injects further script/style tags itself, so `script-src` and
   * `style-src` must allow the webview resource origin, not just the nonce.
   */
  protected override _wrapHtml(body: string, extraStyles?: string): string {
    const webview = this._panel.webview;
    const nonce = this._getNonce();
    const src = webview.cspSource;
    // media/monaco/vs is the Monaco AMD build, copied from monaco-editor by
    // scripts/copy-monaco-assets.mjs at compile time (node_modules does not
    // ship in the .vsix).
    const vsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'media', 'monaco', 'vs')
    );
    const bundleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'media', 'mergeWindow.js')
    );
    // csp-exempt: Monaco loads its editor + worker scripts from the bundled
    // media/monaco dir, so script-src must whitelist `${src}` in addition to
    // the nonce — a policy the shared nonce-only buildWebviewCsp can't express.
    const csp =
      `default-src 'none'; ` +
      `style-src ${src} 'unsafe-inline'; ` +
      `script-src ${src} 'nonce-${nonce}'; ` +
      `img-src ${src} data:; ` +
      `font-src ${src};`;
    // The gutter/wand symbols render from the bundled codicon font — a
    // unicode arrow here falls back to an arbitrary system font and can come
    // out visibly rotated.
    const codiconCss = buildCodiconFontFaceCss(this._context.extensionUri, webview);
    const styleBlock = `<style>${codiconCss}${extraStyles ?? ''}</style>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>${escapeHtml(this._title)}</title>
  ${styleBlock}
</head>
<body>
${body}
<script nonce="${nonce}" src="${vsUri.toString()}/loader.js"></script>
<script nonce="${nonce}" src="${bundleUri.toString()}"></script>
<!-- no-string-script-exempt: Monaco's AMD require(['vs/...']) boot deferral is irreducible inline (Monaco-specific, needs the loaded --global-name); the merge window is the ported template, not a ratchet item -->
<script nonce="${nonce}">
  require.config({ paths: { vs: '${vsUri.toString()}' } });
  window.MonacoEnvironment = { getWorker: function () { throw new Error('workers disabled in webview'); } };
  require(['vs/editor/editor.main'], function () { intelligMergeWindow.boot(); });
</script>
</body>
</html>`;
  }
}
