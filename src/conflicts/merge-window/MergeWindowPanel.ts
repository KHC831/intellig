import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { BaseWebviewPanel } from '../../utils/BaseWebviewPanel';
import { IGitService, IRepository } from '../../git-core/interfaces/IGitService';
import { GitCli } from '../../git-core/gitCli';
import { sanitizeGitError } from '../../git-core/gitError';
import { atomicWriteFileSync } from '../../utils/atomicWrite';
import { getLogger } from '../../utils/logger';
import { loadMergeStageContents } from './mergeStages';
import { mergeWindowStyles } from './mergeWindowHtml';
import { buildCodiconFontFaceCss } from '../../git-core/gitToolWindow/provider/stylesBuilder';
import { detectEol, normalizeToLf, restoreEol } from './mergeWindowText';

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
export class MergeWindowPanel extends BaseWebviewPanel {
  private _eol: '\n' | '\r\n' = '\n';
  private _modified = false;

  constructor(
    context: vscode.ExtensionContext,
    private readonly _opts: {
      repository: IRepository;
      relPath: string;
      absolutePath: string;
      leftLabel: string;
      rightLabel: string;
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
    const msg = message as Partial<{
      type: string;
      resultText: string;
      modified: boolean;
      level: string;
      text: string;
      unresolved: number;
    }>;
    switch (msg.type) {
      case 'ready':
        await this._sendInit();
        return;
      case 'apply':
        await this._apply(typeof msg.resultText === 'string' ? msg.resultText : '');
        return;
      case 'abort':
        await this._abort(msg.modified === true);
        return;
      case 'state':
        this._modified = msg.modified === true;
        return;
      case 'log': {
        const logger = getLogger().child({ component: 'MergeWindowPanel' });
        if (msg.level === 'error') {
          logger.error(String(msg.text));
        } else {
          logger.warn(String(msg.text));
        }
        return;
      }
    }
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

      await this.postMessage({
        type: 'init',
        left: normalizeToLf(stages.ours),
        base: normalizeToLf(stages.base),
        right: normalizeToLf(stages.theirs),
        leftLabel: this._opts.leftLabel,
        rightLabel: this._opts.rightLabel,
        fileName: path.basename(absolutePath),
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
    onApplied(relPath);
    this.dispose();
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
    const vsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'node_modules', 'monaco-editor', 'min', 'vs')
    );
    const bundleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'media', 'mergeWindow.js')
    );
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
  <title>${this._title}</title>
  ${styleBlock}
</head>
<body>
${body}
<script nonce="${nonce}" src="${vsUri.toString()}/loader.js"></script>
<script nonce="${nonce}" src="${bundleUri.toString()}"></script>
<script nonce="${nonce}">
  require.config({ paths: { vs: '${vsUri.toString()}' } });
  window.MonacoEnvironment = { getWorker: function () { throw new Error('workers disabled in webview'); } };
  require(['vs/editor/editor.main'], function () { intelligMergeWindow.boot(); });
</script>
</body>
</html>`;
  }
}
