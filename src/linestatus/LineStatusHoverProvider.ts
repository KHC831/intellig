import * as vscode from 'vscode';
import { readConfig } from '../config/configKeys';
import { IGitService } from '../git-core/interfaces/IGitService';
import { computeLineStatusRanges, ILineStatusRange, splitLines } from './lineStatusDiff';
import { fetchHeadContent } from './lineStatusHead';
import {
  buildHoverModel,
  computeRevertEdit,
  renderHoverMarkdown,
  IRevertEdit,
} from './lineStatusHover';
import { safeFireAndForget } from '../utils/safeFireAndForget';

const REVERT_COMMAND = 'intellig.lineStatus.revertRange';
const COPY_COMMAND = 'intellig.lineStatus.copyOldContent';

/**
 * Inline-diff hover popup on a change marker (slice F-8b).
 *
 * Mirrors IntelliJ's `LineStatusMarkerPopup` /
 * `LineStatusMarkerPopupActions` (platform/diff-impl/.../vcs/ex/
 * LineStatusMarkerPopupActions.kt): hovering a changed line shows the previous
 * (committed) content for that range and offers a "Rollback" (revert hunk) and
 * "Copy old content" action. We reuse the gutter's change-range model
 * ({@link computeLineStatusRanges}) and never recompute a different diff.
 *
 * Revert edits the in-memory buffer only (a `WorkspaceEdit`); the user still
 * saves — so the popup is read-only-safe with respect to the working tree.
 */
export class LineStatusHoverProvider implements vscode.Disposable {
  private readonly _gitService: IGitService;
  private readonly _disposables: vscode.Disposable[] = [];

  constructor(gitService: IGitService) {
    this._gitService = gitService;
    this._disposables.push(
      vscode.languages.registerHoverProvider({ scheme: 'file' }, this),
      vscode.commands.registerCommand(REVERT_COMMAND, (uri: string, line: number) =>
        safeFireAndForget(this.revert(uri, line), 'LineStatusHoverProvider.revert')
      ),
      vscode.commands.registerCommand(COPY_COMMAND, (uri: string, line: number) =>
        safeFireAndForget(this.copyOldContent(uri, line), 'LineStatusHoverProvider.copyOldContent')
      )
    );
  }

  private isEnabled(): boolean {
    return readConfig('lineStatus.enabled');
  }

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Hover | undefined> {
    if (!this.isEnabled() || document.uri.scheme !== 'file') {
      return undefined;
    }

    const resolved = await this.rangesFor(document);
    if (!resolved) {
      return undefined;
    }
    const range = findRangeAt(resolved.ranges, position.line);
    if (!range) {
      return undefined;
    }

    const model = buildHoverModel(range, resolved.headLines);
    const args = encodeURIComponent(JSON.stringify([document.uri.toString(), position.line]));
    const markdown = new vscode.MarkdownString(
      renderHoverMarkdown(
        model,
        `command:${REVERT_COMMAND}?${args}`,
        `command:${COPY_COMMAND}?${args}`
      )
    );
    // Required for the `command:` action links to be clickable.
    markdown.isTrusted = { enabledCommands: [REVERT_COMMAND, COPY_COMMAND] };
    return new vscode.Hover(markdown);
  }

  /** Apply the revert edit for the change range under `line` to the buffer. */
  private async revert(uriString: string, line: number): Promise<void> {
    const located = await this.locate(uriString, line);
    if (!located) {
      return;
    }
    const { document, range, headLines } = located;
    const edit = computeRevertEdit(range, headLines);
    const replacement = buildReplacement(document, edit);
    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.replace(document.uri, replacement.range, replacement.text);
    await vscode.workspace.applyEdit(workspaceEdit);
  }

  /** Copy the old (HEAD) content of the change range under `line` to the clipboard. */
  private async copyOldContent(uriString: string, line: number): Promise<void> {
    const located = await this.locate(uriString, line);
    if (!located) {
      return;
    }
    const { range, headLines } = located;
    const model = buildHoverModel(range, headLines);
    if (model.oldLines.length === 0) {
      return;
    }
    await vscode.env.clipboard.writeText(`${model.oldLines.join('\n')}\n`);
  }

  /** Resolve a command's (uri, line) back to its document + change range + HEAD lines. */
  private async locate(
    uriString: string,
    line: number
  ): Promise<
    { document: vscode.TextDocument; range: ILineStatusRange; headLines: string[] } | undefined
  > {
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uriString));
    } catch {
      return undefined;
    }
    const resolved = await this.rangesFor(document);
    if (!resolved) {
      return undefined;
    }
    const range = findRangeAt(resolved.ranges, line);
    if (!range) {
      return undefined;
    }
    return { document, range, headLines: resolved.headLines };
  }

  /** Compute the current change ranges + HEAD lines for a document, or undefined. */
  private async rangesFor(
    document: vscode.TextDocument
  ): Promise<{ ranges: ILineStatusRange[]; headLines: string[] } | undefined> {
    let head: string | undefined;
    try {
      head = await fetchHeadContent(this._gitService, document.uri);
    } catch {
      return undefined;
    }
    if (head === undefined) {
      return undefined;
    }
    const ranges = computeLineStatusRanges(head, document.getText());
    return { ranges, headLines: splitLines(head) };
  }

  dispose(): void {
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables.length = 0;
  }
}

/**
 * Find the change range whose marker sits on `line`. Added/modified markers
 * span their buffer lines; a deleted marker is anchored to a single line.
 */
function findRangeAt(ranges: ILineStatusRange[], line: number): ILineStatusRange | undefined {
  return ranges.find((r) =>
    r.kind === 'deleted' ? line === r.start : line >= r.start && line <= r.end
  );
}

/**
 * Translate a pure {@link IRevertEdit} into a concrete document range +
 * replacement text. The half-open buffer span `[startLine, endLine)` covers
 * whole lines including their trailing newline, so the old lines are emitted
 * each followed by `\n`. The only special case is inserting past the last line
 * of a file with no final newline, where the newline must precede the content
 * so the existing last line keeps its own line.
 */
function buildReplacement(
  document: vscode.TextDocument,
  edit: IRevertEdit
): { range: vscode.Range; text: string } {
  const lineCount = document.lineCount;

  if (edit.startLine >= lineCount) {
    const end = document.lineAt(lineCount - 1).range.end;
    const text = edit.lines.length === 0 ? '' : `\n${edit.lines.join('\n')}`;
    return { range: new vscode.Range(end, end), text };
  }

  const start = new vscode.Position(edit.startLine, 0);
  const end =
    edit.endLine <= lineCount - 1
      ? new vscode.Position(edit.endLine, 0)
      : document.lineAt(lineCount - 1).range.end;
  const text = edit.lines.length === 0 ? '' : `${edit.lines.map((l) => `${l}\n`).join('')}`;
  return { range: new vscode.Range(start, end), text };
}

/** Create a LineStatusHoverProvider wired to the given git service. */
export function createLineStatusHoverProvider(gitService: IGitService): LineStatusHoverProvider {
  return new LineStatusHoverProvider(gitService);
}
