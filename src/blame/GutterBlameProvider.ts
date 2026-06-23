import * as vscode from 'vscode';
import { IGutterBlameProvider } from './interfaces/IGutterBlameProvider';
import { IBlameService, IBlameInfo } from './interfaces/IBlameService';
import { IGitService, IBlameLine } from '../git-core/interfaces/IGitService';
import { BlameOptionsSource, IBlameAspectVisibility } from './BlameOptionsSource';
import { safeFireAndForget } from '../utils/safeFireAndForget';
import { computeHeatColor, buildOrderColorMap } from './heatColor';
import { buildAuthorColorMap } from './authorColor';
import { AuthorNameFormat, formatAuthorName } from './authorNameFormat';
import { repoRelativePath } from '../utils/repoRelativePath';
import { resolveBlameRepo } from './resolveBlameRepo';
import { getLogger } from '../utils/logger';
import { buildBlameHover } from './blameHover';

/** Aspect/name-format display config with provider defaults applied. */
interface IBlameDisplay {
  aspects: IBlameAspectVisibility;
  authorNameFormat: AuthorNameFormat;
}

/** Defaults used when no options source is wired (every aspect visible). */
const DEFAULT_DISPLAY: IBlameDisplay = {
  aspects: { author: true, date: true, revision: true },
  authorNameFormat: 'full',
};

/**
 * Gutter Blame Provider implementation.
 * Displays blame annotations in the editor gutter for all visible lines,
 * with an IntelliJ-style interpolated background gradient and click actions.
 *
 * - Display blame information in the editor gutter for every line
 * - Click actions to view commit or copy hash
 * - Per-commit background tint: each distinct commit gets a human-friendly
 *   categorical color (ORDER mode, by age rank) or a per-author color (AUTHOR
 *   mode), so lines from the same commit/author read as one colored block.
 */
export class GutterBlameProvider implements IGutterBlameProvider {
  private _enabled: boolean = false;
  private _blameService: IBlameService;
  private _gitService: IGitService;
  private _disposables: vscode.Disposable[] = [];
  /**
   * Two `before` decoration types render the annotation column, mirroring
   * IntelliJ's gutter (and the lkqm/gitblame-annotations layout):
   *   - `_textDecorationType` (created first → renders leftmost): the muted
   *     author/date/revision text. Per-line `contentText` + a file-wide `ch`
   *     width so every row's text column aligns.
   *   - `_heatDecorationType` (created second → renders to the right of the
   *     text): a thin colored strip carrying the age/author heat color, with a
   *     right margin that separates the whole annotation from the code. The
   *     strip is the IntelliJ-style colour bar AND the boundary.
   */
  private _textDecorationType: vscode.TextEditorDecorationType | undefined;
  private _heatDecorationType: vscode.TextEditorDecorationType | undefined;
  private _onDidChangeEnabled: vscode.EventEmitter<boolean>;
  private _currentEditor: vscode.TextEditor | undefined;
  private _blameCache: Map<string, IBlameInfo> = new Map();
  private _updateDebounceTimer: NodeJS.Timeout | undefined;
  /**
   * `true` when annotation was turned on via the explicit "Annotate with Git
   * Blame" action (IntelliJ's AnnotateToggleAction), which always annotates
   * regardless of the `intellig.blameAnnotationStyle` kill-switch. Reset on
   * `disable()`.
   */
  private _forced: boolean = false;

  /**
   * Event fired when the enabled state changes.
   */
  readonly onDidChangeEnabled: vscode.Event<boolean>;

  private _optionsSource: BlameOptionsSource | undefined;

  constructor(
    blameService: IBlameService,
    gitService: IGitService,
    optionsSource?: BlameOptionsSource
  ) {
    this._blameService = blameService;
    this._gitService = gitService;
    this._optionsSource = optionsSource;
    this._onDidChangeEnabled = new vscode.EventEmitter<boolean>();
    this.onDidChangeEnabled = this._onDidChangeEnabled.event;

    // Annotation TEXT column — muted metadata colour (editorCodeLens.foreground,
    // not code). Per-line contentText + a file-wide `ch` width are supplied via
    // DecorationOptions.renderOptions so every row aligns. Created first so it
    // renders to the LEFT of the heat strip.
    this._textDecorationType = vscode.window.createTextEditorDecorationType({
      before: {
        contentText: '',
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
        textDecoration: 'none; font-size: 11px; font-family: monospace;',
      },
      isWholeLine: false,
    });

    // Heat STRIP — a thin colored bar carrying the age/author heat color
    // (per-line backgroundColor), with a right margin that both separates the
    // strip from the code and acts as the annotation↔code boundary. Created
    // second so it renders between the text column and the code.
    this._heatDecorationType = vscode.window.createTextEditorDecorationType({
      before: {
        contentText: ' ',
        width: '3px',
        margin: '0 12px 0 8px',
      },
      isWholeLine: false,
    });

    // Set up event listeners
    this.setupEventListeners();

    // Re-blame whenever the user toggles an option or hides/un-hides a
    // revision. Cache is cleared so the new flags take effect.
    if (this._optionsSource) {
      this._disposables.push(
        this._optionsSource.onDidChange(() => {
          this._blameCache.clear();
          if (this._enabled && this._currentEditor) {
            // Bucket B: blame fetches can fail async; log+suppress
            // so the option-source sync doesn't stall on one bad editor.
            safeFireAndForget(
              this.updateDecorations(this._currentEditor),
              'GutterBlameProvider.onDidChange: re-blame after options change'
            );
          }
        })
      );
    }
  }

  /**
   * Set up event listeners for editor changes and scrolling.
   */
  private setupEventListeners(): void {
    // Listen for active editor changes
    this._disposables.push(
      vscode.window.onDidChangeActiveTextEditor(async (editor) => {
        if (!this._enabled) {
          return;
        }

        if (!editor) {
          this.clearDecorations();
          return;
        }

        this._currentEditor = editor;
        await this.updateDecorations(editor);
      })
    );

    // No scroll listener: the gutter is rendered for the whole file in one pass
    // (see updateDecorations) and VS Code virtualizes the on-screen rows, so
    // there is nothing to recompute as the viewport moves.

    // Listen for document changes to invalidate cache
    this._disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        const uri = event.document.uri.toString();
        this._blameCache.delete(uri);

        // Refresh if this is the current editor
        if (
          this._enabled &&
          this._currentEditor &&
          this._currentEditor.document.uri.toString() === uri
        ) {
          this.debounceUpdate(this._currentEditor);
        }
      })
    );

    // Listen for document saves to refresh blame
    this._disposables.push(
      vscode.workspace.onDidSaveTextDocument((document) => {
        const uri = document.uri.toString();
        this._blameCache.delete(uri);

        // Refresh if this is the current editor
        if (
          this._enabled &&
          this._currentEditor &&
          this._currentEditor.document.uri.toString() === uri
        ) {
          // Bucket B: blame fetches can fail async.
          safeFireAndForget(
            this.updateDecorations(this._currentEditor),
            'GutterBlameProvider.onDidSaveTextDocument: re-blame after save'
          );
        }
      })
    );
  }

  /**
   * Debounce decoration updates while the user is typing, so a burst of edits
   * coalesces into a single re-blame instead of one per keystroke.
   *
   * @param editor - The text editor to update
   */
  private debounceUpdate(editor: vscode.TextEditor): void {
    if (this._updateDebounceTimer) {
      clearTimeout(this._updateDebounceTimer);
    }

    this._updateDebounceTimer = setTimeout(() => {
      // Bucket B: debounced edit update; log+suppress so the debounce cycle
      // keeps firing even if one fetch rejects.
      safeFireAndForget(
        this.updateDecorations(editor),
        'GutterBlameProvider.debounceUpdate: debounced decoration refresh'
      );
    }, 100);
  }

  /**
   * Enable gutter blame annotations.
   *
   * @param targetEditor - The editor to annotate. Defaults to the active
   *   editor; the explicit "Annotate with Git Blame" action passes the
   *   freshly-opened editor for the right-clicked file so the gutter attaches
   *   to that file rather than whatever was last focused.
   * @param opts.force - When `true`, render regardless of
   *   `intellig.blameAnnotationStyle` (matches IntelliJ's AnnotateToggleAction,
   *   where the explicit action always annotates).
   */
  enable(targetEditor?: vscode.TextEditor, opts?: { force?: boolean }): void {
    if (opts?.force) {
      this._forced = true;
    }

    if (this._enabled) {
      // Already on: still refresh so a forced re-invocation on a different
      // file re-annotates the now-targeted editor.
      const current = targetEditor ?? vscode.window.activeTextEditor;
      if (current) {
        this._currentEditor = current;
        safeFireAndForget(
          this.updateDecorations(current),
          'GutterBlameProvider.enable: refresh on re-enable'
        );
      }
      return;
    }

    this._enabled = true;
    this._onDidChangeEnabled.fire(true);

    // Update decorations for the targeted (or active) editor
    const editor = targetEditor ?? vscode.window.activeTextEditor;
    if (editor) {
      this._currentEditor = editor;
      // Bucket B: enable() is sync; async blame fetch follows.
      safeFireAndForget(
        this.updateDecorations(editor),
        'GutterBlameProvider.enable: initial decorations'
      );
    }
  }

  /**
   * Disable gutter blame annotations.
   */
  disable(): void {
    if (!this._enabled) {
      return;
    }

    this._enabled = false;
    this._forced = false;
    this._onDidChangeEnabled.fire(false);
    this.clearDecorations();
  }

  /**
   * Toggle gutter blame annotations on/off.
   * @returns The new enabled state
   */
  toggle(): boolean {
    if (this._enabled) {
      this.disable();
    } else {
      this.enable();
    }
    return this._enabled;
  }

  /**
   * Check if gutter blame is currently enabled.
   * @returns True if gutter blame is enabled
   */
  isEnabled(): boolean {
    return this._enabled;
  }

  /**
   * Refresh the gutter blame decorations for the current editor.
   */
  async refresh(): Promise<void> {
    if (!this._enabled || !this._currentEditor) {
      return;
    }

    // Clear cache for current document
    const uri = this._currentEditor.document.uri.toString();
    this._blameCache.delete(uri);

    await this.updateDecorations(this._currentEditor);
  }

  /**
   * Check whether the active `intellig.blameAnnotationStyle` permits
   * gutter annotations. Returns `false` when the style is `'off'` or
   * `'inline'` (gutter-relevant styles are `'gutter'` and `'both'`).
   *
   * Exposed for unit testing via the `as unknown as { isAnnotationStyleEnabled(): boolean }`
   * test-seam pattern used elsewhere in this codebase.
   */
  isAnnotationStyleEnabled(): boolean {
    const style = vscode.workspace
      .getConfiguration('intellig')
      .get<string>('blameAnnotationStyle', 'inline');
    return style === 'gutter' || style === 'both';
  }

  /**
   * Update gutter blame decorations for the WHOLE file in a single pass.
   *
   * Decorations are computed once per blame load (file switch / enable / option
   * change / edit / save) and applied for every line; VS Code virtualizes the
   * gutter so only on-screen rows actually paint. This is what the efficient
   * blame extensions (and IntelliJ's annotation gutter) do — re-rendering the
   * visible viewport on every scroll event was the source of the scroll lag and
   * a column-width jitter (the `ch` width recomputed from whichever rows were
   * visible). The text-column width is now the file-wide maximum, so the column
   * stays put while scrolling.
   *
   * Computes the file's full oldest↔newest commit timestamp range from all
   * blamed lines, then interpolates a background heat color per line using
   * `computeHeatColor`. Matches IntelliJ's ORDER color mode (AnnotateToggleAction
   * `computeBgColors`) where newer commits get a warmer background.
   *
   * @param editor - The text editor
   */
  private async updateDecorations(editor: vscode.TextEditor): Promise<void> {
    const log = getLogger().child({ component: 'GutterBlameProvider' });
    if (!this._textDecorationType || !this._heatDecorationType) {
      return;
    }

    // Clear existing decorations first (both columns)
    editor.setDecorations(this._textDecorationType, []);
    editor.setDecorations(this._heatDecorationType, []);

    log.debug('updateDecorations: begin', {
      uri: editor.document.uri.toString(),
      scheme: editor.document.uri.scheme,
      forced: this._forced,
      enabled: this._enabled,
    });

    // Respect the master annotation style kill-switch — unless annotation was
    // turned on via the explicit Annotate action, which always renders.
    if (!this._forced && !this.isAnnotationStyleEnabled()) {
      log.debug('updateDecorations: skipped — style kill-switch and not forced');
      return;
    }

    // Skip if not a file scheme (e.g., output, debug console)
    if (editor.document.uri.scheme !== 'file') {
      log.debug('updateDecorations: skipped — non-file scheme', {
        scheme: editor.document.uri.scheme,
      });
      return;
    }

    try {
      const blameInfo = await this.getBlameForFile(editor);
      if (!blameInfo || blameInfo.lines.length === 0) {
        log.debug('updateDecorations: no blame lines for file', {
          uri: editor.document.uri.toString(),
          lines: blameInfo?.lines.length ?? 0,
        });
        return;
      }

      // Compute the timestamp range across ALL blame lines in the file so
      // the gradient is stable while the user scrolls (not relative to the
      // visible viewport). Matches IntelliJ's per-file color scheme.
      let oldestMs = Infinity;
      let newestMs = -Infinity;
      for (const bl of blameInfo.lines) {
        if (!bl.commit.startsWith('0000000')) {
          const t = bl.date.getTime();
          if (t < oldestMs) {
            oldestMs = t;
          }
          if (t > newestMs) {
            newestMs = t;
          }
        }
      }
      // Guard against a file with only uncommitted lines.
      if (!isFinite(oldestMs)) {
        log.debug('updateDecorations: all lines uncommitted — nothing to annotate');
        return;
      }

      // Pre-compute the per-commit / per-author background palette over the
      // file's full committed set so every line of the same commit (or author)
      // shares one color and the gutter reads as colored blocks.
      //   - AUTHOR mode: stable per-author color (IntelliJ AUTHOR branch).
      //   - ORDER mode (default): per-commit color keyed by AGE RANK, so
      //     adjacent commits stay visually distinct instead of collapsing to the
      //     same timestamp-interpolated shade (IntelliJ ORDER branch).
      const colorMode = this._optionsSource?.snapshot().colorMode ?? 'order';
      const committedLines = blameInfo.lines.filter((bl) => !bl.commit.startsWith('0000000'));
      const authorColors =
        colorMode === 'author'
          ? buildAuthorColorMap(committedLines.map((bl) => bl.author))
          : undefined;
      const orderColors =
        colorMode === 'author'
          ? undefined
          : buildOrderColorMap(
              committedLines.map((bl) => ({ commit: bl.commit, dateMs: bl.date.getTime() }))
            );

      log.debug('updateDecorations: computing decorations', {
        blameLines: blameInfo.lines.length,
      });

      // Single pass over every blamed line: collect the renderable (committed,
      // non-hidden) rows and the widest formatted text, so the text column gets
      // one file-wide `ch` width and every row's columns line up. Iterating the
      // blame model directly (rather than scanning the visible viewport on each
      // scroll) is O(lines) once per load instead of O(visible × lines) on every
      // scroll frame.
      interface IRenderEntry {
        line: number;
        blameLine: IBlameLine;
        bgColor: string;
        text: string;
      }
      const docLineCount = editor.document.lineCount;
      const entries: IRenderEntry[] = [];
      for (const blameLine of blameInfo.lines) {
        // Blame lines are 1-indexed; map to the editor's 0-indexed line. Skip
        // any blame row that falls outside the current document (e.g. a
        // previous-revision blame longer than the working copy).
        const line = blameLine.line - 1;
        if (line < 0 || line >= docLineCount) {
          continue;
        }
        if (blameLine.commit.startsWith('0000000')) {
          continue;
        }
        // "Hide Revision" — any line whose commit the user has hidden is
        // elided from the gutter.
        if (this._optionsSource && this._optionsSource.isHidden(blameLine.commit)) {
          continue;
        }
        // AUTHOR mode tints by the line's author; ORDER mode by the commit's age
        // rank. `computeHeatColor` remains the ultimate fallback for a line whose
        // commit somehow missed the map.
        const bgColor =
          authorColors?.get(blameLine.author) ??
          orderColors?.get(blameLine.commit) ??
          computeHeatColor(blameLine.date.getTime(), oldestMs, newestMs);
        entries.push({ line, blameLine, bgColor, text: this.formatGutterText(blameLine) });
      }

      // Annotate EVERY line (author/date/revision on each), like IntelliJ's
      // aspect columns. Size the text column to the widest entry so the code
      // stays aligned across the whole file.
      let maxLen = 0;
      for (const e of entries) {
        if (e.text.length > maxLen) {
          maxLen = e.text.length;
        }
      }
      // `+ 2` leaves a little breathing room after the longest entry.
      const widthCh = `${maxLen + 2}ch`;
      const textDecorations: vscode.DecorationOptions[] = [];
      const heatDecorations: vscode.DecorationOptions[] = [];
      for (const e of entries) {
        const range = new vscode.Range(e.line, 0, e.line, 0);
        textDecorations.push({
          range,
          hoverMessage: this.createHoverMessage(e.blameLine),
          // Tint the FULL annotation column with the per-commit color (IntelliJ
          // tints the whole gutter cell, not a sliver). VS Code's per-instance
          // `before` REPLACES the decoration type's `before`, so the muted text
          // color is restated here rather than inherited from the type — else it
          // is dropped along with the type's attachment.
          renderOptions: {
            before: {
              contentText: e.text,
              width: widthCh,
              backgroundColor: e.bgColor,
              color: new vscode.ThemeColor('editorCodeLens.foreground'),
            },
          },
        });
        heatDecorations.push({
          range,
          // Accent bar between the annotation and the code. Width/contentText are
          // restated per-instance (not inherited from the type) for the same
          // replace-semantics reason — otherwise the bar collapses to zero width
          // and shows no color at all (the "no color" bug).
          renderOptions: {
            before: {
              contentText: ' ',
              width: '3px',
              margin: '0 12px 0 8px',
              backgroundColor: e.bgColor,
            },
          },
        });
      }

      log.debug('updateDecorations: applying decorations', { count: textDecorations.length });
      editor.setDecorations(this._textDecorationType, textDecorations);
      editor.setDecorations(this._heatDecorationType, heatDecorations);
    } catch (error) {
      // Blame may genuinely be unavailable (file untracked, not in a repo, git
      // error). Log at debug so the failure is diagnosable instead of silent.
      log.debug('updateDecorations: blame unavailable / failed', {
        uri: editor.document.uri.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get blame information for the file in the editor.
   *
   * @param editor - The text editor
   * @returns The blame information, or undefined if not available
   */
  private async getBlameForFile(editor: vscode.TextEditor): Promise<IBlameInfo | undefined> {
    const document = editor.document;
    const uri = document.uri;

    // Resolve from the already-open repositories first (no subprocess); see
    // resolveBlameRepo for why the bare `getRepository` fresh-resolve was
    // unreliable and silently emptied the annotation.
    const repo = await resolveBlameRepo(this._gitService, uri);
    if (!repo) {
      getLogger()
        .child({ component: 'GutterBlameProvider' })
        .debug('getBlameForFile: no repository for file', { uri: uri.toString() });
      return undefined;
    }

    // git blame runs with `cwd = repo.rootUri.fsPath`, so it needs the
    // REPO-root-relative path. `repoRelativePath` canonicalizes both ends so a
    // symlinked editor URI against a realpath-resolved root (macOS `/var` →
    // `/private/var`) does not produce an escaping `../` pathspec.
    const relativePath = repoRelativePath(repo.rootUri.fsPath, uri.fsPath);

    // Check cache first
    const cacheKey = uri.toString();
    let blameInfo = this._blameCache.get(cacheKey);

    if (!blameInfo) {
      // Fetch blame info, piping through the current -w/-M/-C selection so
      // git blame reflects the user's chosen options.
      blameInfo = await this._blameService.getBlame(
        repo,
        relativePath,
        undefined,
        this._optionsSource?.asBlameOptions()
      );
      this._blameCache.set(cacheKey, blameInfo);
    }

    return blameInfo;
  }

  /**
   * Format the gutter text for the blame annotation. Renders only the aspect
   * columns the user has left visible (author / date / revision), in that
   * fixed order, with the author rendered per the chosen name format. Mirrors
   * IntelliJ's per-aspect show/hide gutter columns.
   *
   * @param blameLine - The blame information
   * @returns The formatted gutter text
   */
  private formatGutterText(blameLine: IBlameLine): string {
    const { aspects, authorNameFormat } = this.resolveDisplay();
    const columns: string[] = [];
    if (aspects.author) {
      columns.push(formatAuthorName(blameLine.author, blameLine.authorEmail, authorNameFormat));
    }
    if (aspects.date) {
      columns.push(this.formatRelativeDate(blameLine.date));
    }
    if (aspects.revision) {
      columns.push(blameLine.commit.substring(0, 7));
    }

    // Pad every column except the last so the visible columns stay aligned.
    return columns.map((c, i) => (i < columns.length - 1 ? c.padEnd(12) : c)).join(' ');
  }

  /**
   * Resolve the aspect-visibility + name-format display config from the
   * options source, applying provider defaults when none is wired.
   */
  private resolveDisplay(): IBlameDisplay {
    const snap = this._optionsSource?.snapshot();
    if (!snap) {
      return DEFAULT_DISPLAY;
    }
    return { aspects: snap.aspects, authorNameFormat: snap.authorNameFormat };
  }

  /**
   * Create a hover message with full commit details and click actions.
   *
   * @param blameLine - The blame information
   * @returns The hover message as MarkdownString
   */
  private createHoverMessage(blameLine: IBlameLine): vscode.MarkdownString {
    return buildBlameHover(blameLine, { showPreviousRevision: true });
  }

  /**
   * Format a date as a relative time string.
   *
   * @param date - The date to format
   * @returns The relative time string (e.g., "2 days ago")
   */
  private formatRelativeDate(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);
    const diffWeeks = Math.floor(diffDays / 7);
    const diffMonths = Math.floor(diffDays / 30);
    const diffYears = Math.floor(diffDays / 365);

    if (diffYears > 0) {
      return diffYears === 1 ? '1 yr ago' : `${diffYears} yrs ago`;
    } else if (diffMonths > 0) {
      return diffMonths === 1 ? '1 mo ago' : `${diffMonths} mos ago`;
    } else if (diffWeeks > 0) {
      return diffWeeks === 1 ? '1 wk ago' : `${diffWeeks} wks ago`;
    } else if (diffDays > 0) {
      return diffDays === 1 ? '1 day ago' : `${diffDays} days ago`;
    } else if (diffHours > 0) {
      return diffHours === 1 ? '1 hr ago' : `${diffHours} hrs ago`;
    } else if (diffMins > 0) {
      return diffMins === 1 ? '1 min ago' : `${diffMins} mins ago`;
    } else {
      return 'just now';
    }
  }

  /**
   * Clear all decorations from all editors.
   */
  private clearDecorations(): void {
    if (!this._textDecorationType || !this._heatDecorationType) {
      return;
    }
    // Clear both columns from all visible editors
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this._textDecorationType, []);
      editor.setDecorations(this._heatDecorationType, []);
    }

    this._currentEditor = undefined;
  }

  /**
   * Dispose of resources.
   */
  dispose(): void {
    // Disable first to clean up state
    this._enabled = false;

    if (this._updateDebounceTimer) {
      clearTimeout(this._updateDebounceTimer);
    }

    this._onDidChangeEnabled.dispose();

    if (this._textDecorationType) {
      this._textDecorationType.dispose();
      this._textDecorationType = undefined;
    }
    if (this._heatDecorationType) {
      this._heatDecorationType.dispose();
      this._heatDecorationType = undefined;
    }

    for (const disposable of this._disposables) {
      disposable.dispose();
    }
    this._disposables = [];

    this._blameCache.clear();
  }
}

/**
 * Create a new GutterBlameProvider instance.
 *
 * @param blameService - The blame service
 * @param gitService - The git service
 * @returns A new GutterBlameProvider instance
 */
export function createGutterBlameProvider(
  blameService: IBlameService,
  gitService: IGitService,
  optionsSource?: BlameOptionsSource
): GutterBlameProvider {
  return new GutterBlameProvider(blameService, gitService, optionsSource);
}
