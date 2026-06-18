import * as vscode from 'vscode';
import { IGitService } from '../git-core/interfaces/IGitService';
import { computeLineStatusRanges, LineStatusKind, ILineStatusRange } from './lineStatusDiff';
import { fetchHeadContent } from './lineStatusHead';
import { safeFireAndForget } from '../utils/safeFireAndForget';

/**
 * Live changed-line gutter tracker (workstream A, slice A-2).
 *
 * Tracks each open file's buffer against its committed HEAD content and renders
 * IntelliJ-style change markers in the editor gutter (added / modified /
 * deleted), updated live as the document is edited, saved, or HEAD moves.
 *
 * Mirrors IntelliJ's `LineStatusTracker`
 * (platform/vcs-impl/src/com/intellij/openapi/vcs/ex/LineStatusTracker.java):
 * it diffs the *in-memory document* against the committed revision and paints
 * per-line markers in the gutter. Because the comparison is against the open
 * buffer (not the file on disk), unsaved edits are reflected immediately —
 * `git diff` against the working tree would miss them.
 *
 * Scope of this slice is the change-range model + gutter markers only; the
 * hover popup with the old content + revert (IntelliJ `LineStatusMarkerPopup`)
 * is a separate, later slice.
 */
export class LineStatusTracker implements vscode.Disposable {
  private readonly _gitService: IGitService;
  private readonly _disposables: vscode.Disposable[] = [];
  private readonly _decorationTypes: Record<LineStatusKind, vscode.TextEditorDecorationType>;
  /** Cached committed HEAD content per document URI, to avoid re-fetching on every keystroke. */
  private readonly _headCache = new Map<string, string>();
  private _debounceTimer: NodeJS.Timeout | undefined;

  constructor(gitService: IGitService) {
    this._gitService = gitService;
    this._decorationTypes = {
      added: vscode.window.createTextEditorDecorationType({
        gutterIconPath: gutterBar('#587c0c'),
        gutterIconSize: 'contain',
        overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
        overviewRulerLane: vscode.OverviewRulerLane.Left,
      }),
      modified: vscode.window.createTextEditorDecorationType({
        gutterIconPath: gutterBar('#0c7d9d'),
        gutterIconSize: 'contain',
        overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.modifiedForeground'),
        overviewRulerLane: vscode.OverviewRulerLane.Left,
      }),
      deleted: vscode.window.createTextEditorDecorationType({
        gutterIconPath: gutterTriangle('#a31515'),
        gutterIconSize: 'contain',
        overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
        overviewRulerLane: vscode.OverviewRulerLane.Left,
      }),
    };

    this._disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.scheduleUpdate(editor);
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document === event.document) {
          this.scheduleUpdate(editor);
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        // HEAD is unchanged on a plain save, but the buffer is now clean on
        // disk; the cached HEAD still applies, so just recompute.
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document === document) {
          this.scheduleUpdate(editor);
        }
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this._headCache.delete(document.uri.toString());
      })
    );

    const active = vscode.window.activeTextEditor;
    if (active) {
      this.scheduleUpdate(active);
    }
  }

  /** Whether the live changed-line gutter is enabled by configuration. */
  private isEnabled(): boolean {
    return vscode.workspace.getConfiguration('intellig').get<boolean>('lineStatus.enabled', true);
  }

  /** Debounce updates so rapid keystrokes don't spawn a git call per character. */
  private scheduleUpdate(editor: vscode.TextEditor): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }
    this._debounceTimer = setTimeout(() => {
      safeFireAndForget(
        this.update(editor),
        'LineStatusTracker.scheduleUpdate: refresh gutter markers'
      );
    }, 150);
  }

  /**
   * Recompute and paint the changed-line gutter markers for the given editor.
   * Clears all marker types first so a stale range can't linger.
   */
  private async update(editor: vscode.TextEditor): Promise<void> {
    if (!this.isEnabled() || editor.document.uri.scheme !== 'file') {
      this.clear(editor);
      return;
    }

    try {
      const head = await this.getHeadContent(editor.document);
      if (head === undefined) {
        this.clear(editor);
        return;
      }

      const ranges = computeLineStatusRanges(head, editor.document.getText());
      this.applyDecorations(editor, ranges);
    } catch {
      // Not in a repo, file untracked, or git unavailable — show no markers.
      this.clear(editor);
    }
  }

  /**
   * Fetch the committed HEAD content for a document, cached by URI. Returns
   * `undefined` when the file is outside any repository.
   */
  private async getHeadContent(document: vscode.TextDocument): Promise<string | undefined> {
    const key = document.uri.toString();
    const cached = this._headCache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const head = await fetchHeadContent(this._gitService, document.uri);
    if (head !== undefined) {
      this._headCache.set(key, head);
    }
    return head;
  }

  /** Group ranges by kind and set the three decoration buckets on the editor. */
  private applyDecorations(editor: vscode.TextEditor, ranges: ILineStatusRange[]): void {
    const buckets: Record<LineStatusKind, vscode.Range[]> = {
      added: [],
      modified: [],
      deleted: [],
    };
    for (const r of ranges) {
      buckets[r.kind].push(new vscode.Range(r.start, 0, r.end, 0));
    }
    editor.setDecorations(this._decorationTypes.added, buckets.added);
    editor.setDecorations(this._decorationTypes.modified, buckets.modified);
    editor.setDecorations(this._decorationTypes.deleted, buckets.deleted);
  }

  /** Remove all changed-line markers from an editor. */
  private clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this._decorationTypes.added, []);
    editor.setDecorations(this._decorationTypes.modified, []);
    editor.setDecorations(this._decorationTypes.deleted, []);
  }

  dispose(): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }
    for (const type of Object.values(this._decorationTypes)) {
      type.dispose();
    }
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables.length = 0;
    this._headCache.clear();
  }
}

/** Build a vertical colored gutter bar as an inline SVG data URI. */
function gutterBar(color: string): vscode.Uri {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="6" height="18">` +
    `<rect x="1" y="0" width="3" height="18" fill="${color}"/></svg>`;
  return svgUri(svg);
}

/** Build a small triangle pointing at the deletion gap as an inline SVG data URI. */
function gutterTriangle(color: string): vscode.Uri {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="18">` +
    `<path d="M1 6 L7 9 L1 12 Z" fill="${color}"/></svg>`;
  return svgUri(svg);
}

function svgUri(svg: string): vscode.Uri {
  return vscode.Uri.parse(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
}

/** Create a LineStatusTracker wired to the given git service. */
export function createLineStatusTracker(gitService: IGitService): LineStatusTracker {
  return new LineStatusTracker(gitService);
}
