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
 * One rendered gutter cell. A `blank` cell (a hidden revision) carries no text or
 * tint but holds the column width so the code stays aligned. Committed cells carry
 * the annotation text, the per-commit tint, and a hover. Uncommitted (locally
 * edited / inserted) cells carry the "Uncommitted" label and a muted tint.
 */
interface IGutterEntry {
  text: string;
  bgColor: string;
  blank: boolean;
  hover?: vscode.MarkdownString;
}

/** The shared blank cell — no text, no tint, no hover. Used for HIDDEN lines. */
const BLANK_ENTRY: IGutterEntry = { text: '', bgColor: 'transparent', blank: true };

/** Gutter label for a not-yet-committed (locally edited / inserted) line. */
const UNCOMMITTED_LABEL = 'Uncommitted';
/**
 * Tint for not-yet-committed lines. A muted neutral block, distinct from the
 * per-commit palette, so freshly edited/inserted lines read as "local, not
 * committed" rather than belonging to a commit. Mirrors IntelliJ highlighting the
 * current/local lines apart from the committed history.
 */
const UNCOMMITTED_BG = 'rgba(128, 128, 128, 0.22)';

/**
 * A non-breaking space. Plain spaces inside a decoration's `before.contentText`
 * are trimmed/collapsed by the renderer (default `white-space: normal`), so all
 * gutter padding and column alignment is built from non-breaking spaces, which
 * survive.
 */
const NBSP = '\u00a0';

/**
 * Symmetric breathing room around the annotation text, in characters. The tinted
 * column carries this many NBSP on the left and on the right of the text, so the
 * colour block has matching margins on both sides instead of butting the gutter
 * edge / leaving a ragged gap before the code. Mirrors IntelliJ's padded cell.
 */
const GUTTER_PAD_CH = 2;
/** The symmetric pad as non-breaking spaces, added to each side of the text. */
const GUTTER_PAD = NBSP.repeat(GUTTER_PAD_CH);

/**
 * Fixed per-aspect column widths (characters). Each visible aspect renders at a
 * constant width — short values NBSP-padded, overflow truncated with an ellipsis
 * — so the whole annotation column is a CONSTANT size within a file AND from file
 * to file. (Growing the column to fit each file's widest author made the gutter
 * jump width when switching files.) The short hash is always 7 and the relative
 * date never exceeds 11 ("59 mins ago"), so only the author column truncates.
 */
const AUTHOR_COL_CH = 14;
const DATE_COL_CH = 11;
const REVISION_COL_CH = 7;

/** Fit `s` to exactly `width` chars: pad short with NBSP, truncate long with `…`. */
function fitColumn(s: string, width: number): string {
  if (s.length <= width) {
    return s.padEnd(width, NBSP);
  }
  // Don't slice through a surrogate pair (e.g. an emoji in an author name) — that
  // would leave a lone surrogate that renders as a broken glyph. Drop the dangling
  // high surrogate and pad back to width so the column stays aligned.
  let cut = width - 1;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    cut -= 1;
  }
  return (s.slice(0, cut) + '…').padEnd(width, NBSP);
}

/**
 * Blame text size, RELATIVE to the editor font, so the gutter scales when the
 * user changes their font. A smaller font normally shrinks the inline box and
 * the per-commit tint stops filling the row (striped block); we keep the block
 * continuous by rendering the cell as an inline-block whose height is pinned to
 * the editor's row line-height (see editorRowMetrics / _applyRenderState), so the
 * text can be as small as we like without breaking the block. The min floor is
 * just for readability.
 */
const BLAME_FONT_SCALE = 0.9;
const BLAME_FONT_MIN_PX = 10;

/**
 * Read the editor's font size and effective ROW line-height (px) from config,
 * mirroring VS Code's own computation (`editor.lineHeight`: 0 = derive from the
 * font via the golden ratio; 0<v<8 = a font-size multiplier; ≥8 = absolute px).
 * Used to pin the gutter cell's box to one row so the tint is a continuous block.
 * Scoped to the file (`scope`) so a language- or folder-specific font/line-height
 * is honoured. It approximates VS Code's layout (no API exposes the rendered row
 * height), so it can be off by a sub-pixel; the block tracks it closely enough.
 */
function editorRowMetrics(scope?: vscode.Uri): { fontSizePx: number; lineHeightPx: number } {
  const cfg = vscode.workspace.getConfiguration('editor', scope ?? null);
  const fontSizePx = cfg.get<number>('fontSize') || 14;
  let lineHeight = cfg.get<number>('lineHeight') ?? 0;
  const goldenRatio = process.platform === 'darwin' ? 1.5 : 1.35;
  if (lineHeight === 0) {
    lineHeight = goldenRatio * fontSizePx;
  } else if (lineHeight < 8) {
    lineHeight = lineHeight * fontSizePx;
  }
  return { fontSizePx, lineHeightPx: Math.round(lineHeight) };
}

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
   * The single `before` decoration that renders the annotation column: the muted
   * author/date/revision text on a per-commit tinted, row-height block. Per-line
   * `contentText` is NBSP-padded to a fixed character width so every row aligns,
   * and a right margin separates the block from the code.
   */
  private _textDecorationType: vscode.TextEditorDecorationType | undefined;
  private _onDidChangeEnabled: vscode.EventEmitter<boolean>;
  private _currentEditor: vscode.TextEditor | undefined;
  private _blameCache: Map<string, IBlameInfo> = new Map();
  private _updateDebounceTimer: NodeJS.Timeout | undefined;
  /**
   * The last rendered gutter, keyed by editor URI. Holds one entry per document
   * line (committed → annotated cell; uncommitted → "Uncommitted" cell; hidden →
   * blank cell) plus the column width. Kept so an edit can be reflected
   * SYNCHRONOUSLY — the entries
   * are shifted for inserted/removed lines and re-applied immediately, so a new
   * line gets its blank cell at once instead of the caret sitting at column 0
   * until the debounced re-blame returns (the cursor-jump bug). The `width` is the
   * fixed column width, so blank cells pad to the same size and stay aligned.
   */
  private _renderState:
    | { uri: string; width: string; entries: Map<number, IGutterEntry> }
    | undefined;
  /**
   * `true` when annotation was turned on via the explicit "Annotate with Git
   * Blame" action (IntelliJ's AnnotateToggleAction), which always annotates
   * regardless of the `intellig.blameAnnotationStyle` kill-switch. Reset on
   * `disable()`.
   */
  private _forced: boolean = false;
  /**
   * Monotonically-increasing sequence number for async updateDecorations calls.
   * Incremented at the start of every call; after each await, if the stored seq
   * has advanced, a newer call has started and we bail rather than overwrite with
   * a stale result.
   */
  private _decorationRequestSeq: number = 0;

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

    // Annotation column — muted metadata colour (editorCodeLens.foreground, not
    // code). Per-line contentText (NBSP-padded), the per-commit tint, and the
    // inline-block sizing are supplied per instance via DecorationOptions in
    // _applyRenderState.
    this._textDecorationType = vscode.window.createTextEditorDecorationType({
      before: {
        contentText: '',
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
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
          // Reflect the edit in the gutter immediately (shift the existing cells
          // + blank the new line) so the caret doesn't snap to column 0 and back
          // while the debounced re-blame runs. Then debounce the real re-blame.
          this._shiftRenderStateForEdit(this._currentEditor, event.contentChanges);
          this.debounceUpdate(this._currentEditor);
        }
      })
    );

    // Re-render when the editor font size / line-height changes — the gutter cell
    // is sized relative to the font and its block height is pinned to the row, so
    // both must follow a live font change (no document edit fires otherwise).
    this._disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          (e.affectsConfiguration('editor.fontSize') ||
            e.affectsConfiguration('editor.lineHeight')) &&
          this._enabled &&
          this._currentEditor &&
          this._renderState &&
          this._renderState.uri === this._currentEditor.document.uri.toString()
        ) {
          // The blame model is unchanged — just repaint with the new metrics.
          this._applyRenderState(this._currentEditor);
        }
      })
    );

    // Invalidate on a repo-state change (commit / checkout / reset / pull moves
    // HEAD WITHOUT touching file bytes, so the document listeners never fire).
    // Mirrors InlineBlameProvider so the gutter doesn't keep showing pre-move
    // blame until the user switches/edits/saves.
    this._disposables.push(
      this._gitService.onDidChangeRepository(() => {
        this._blameCache.clear();
        if (this._enabled && this._currentEditor) {
          safeFireAndForget(
            this.updateDecorations(this._currentEditor),
            'GutterBlameProvider.onDidChangeRepository: re-blame after HEAD move'
          );
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
    if (!this._textDecorationType) {
      return;
    }

    // Capture request token before the first await. If a newer updateDecorations
    // call starts while we are awaiting blame, _decorationRequestSeq will have
    // advanced and the guard below discards this stale result so it does not
    // overwrite the newer decoration.
    const mySeq = ++this._decorationRequestSeq;

    // NOTE: decorations are NOT cleared up front. `setDecorations` replaces the
    // whole set for a type, so the success path below sets them in one shot —
    // a pre-clear would leave an empty frame that collapses the gutter and jerks
    // the code left then right on every edit (the keystroke flicker). Early
    // returns clear explicitly; the success path replaces atomically.
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
      this.clearDecorationsFor(editor);
      return;
    }

    // Skip if not a file scheme (e.g., output, debug console)
    if (editor.document.uri.scheme !== 'file') {
      log.debug('updateDecorations: skipped — non-file scheme', {
        scheme: editor.document.uri.scheme,
      });
      this.clearDecorationsFor(editor);
      return;
    }

    try {
      const blameInfo = await this.getBlameForFile(editor);
      // A newer updateDecorations call started while we were awaiting blame —
      // bail rather than overwrite the newer result with stale data.
      if (this._decorationRequestSeq !== mySeq) {
        return;
      }
      if (!blameInfo || blameInfo.lines.length === 0) {
        log.debug('updateDecorations: no blame lines for file', {
          uri: editor.document.uri.toString(),
          lines: blameInfo?.lines.length ?? 0,
        });
        this.clearDecorationsFor(editor);
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
        this.clearDecorationsFor(editor);
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

      // Single pass over every blamed line, building one entry PER DOCUMENT LINE
      // (committed → annotated; uncommitted → "Uncommitted"; hidden → blank).
      // Covering every line means a synchronous edit can shift the map and
      // re-render without leaving a gap. Iterating the blame model directly
      // (rather than scanning the visible viewport on each scroll) is O(lines).
      const docLineCount = editor.document.lineCount;
      const entries = new Map<number, IGutterEntry>();
      const uncommittedEntry = this.uncommittedEntry();
      let maxLen = uncommittedEntry.text.length;
      for (const blameLine of blameInfo.lines) {
        // Blame lines are 1-indexed; map to the editor's 0-indexed line. Skip
        // any blame row that falls outside the current document (e.g. a
        // previous-revision blame longer than the working copy).
        const line = blameLine.line - 1;
        if (line < 0 || line >= docLineCount) {
          continue;
        }
        // A HIDDEN line (user hid this revision) gets a BLANK cell — present for
        // alignment but carrying nothing. An UNCOMMITTED line (git's all-zeros
        // boundary commit — a locally edited / inserted line) gets the
        // "Uncommitted" cell so a new line shows colour and a label instead of a
        // dark gap.
        const hidden = !!this._optionsSource && this._optionsSource.isHidden(blameLine.commit);
        if (hidden) {
          entries.set(line, BLANK_ENTRY);
          continue;
        }
        if (blameLine.commit.startsWith('0000000')) {
          entries.set(line, uncommittedEntry);
          continue;
        }
        // AUTHOR mode tints by the line's author; ORDER mode by the commit's age
        // rank. `computeHeatColor` remains the ultimate fallback for a line whose
        // commit somehow missed the map.
        const bgColor =
          authorColors?.get(blameLine.author) ??
          orderColors?.get(blameLine.commit) ??
          computeHeatColor(blameLine.date.getTime(), oldestMs, newestMs);
        const text = this.formatGutterText(blameLine);
        if (text.length > maxLen) {
          maxLen = text.length;
        }
        entries.set(line, {
          text,
          bgColor,
          blank: false,
          hover: this.createHoverMessage(blameLine),
        });
      }

      // Lines the blame did not emit are NOT back-filled as Uncommitted: VS Code
      // always carries one phantom empty line after a file's final newline that
      // git never blames, so back-filling it would strand a stale "Uncommitted"
      // marker (e.g. after adding then removing a last line). A genuinely edited /
      // inserted line comes back from `git blame --contents -` as an all-zeros
      // line and is handled above.

      // The annotation columns are fixed-width (see formatGutterText), so every
      // committed line is the same length — `maxLen` is that constant. Store it as
      // the column width; blank cells are NBSP-padded to it for alignment. It
      // tracks the current visible-aspect set (shrinks when an aspect is hidden)
      // rather than growing to fit per file.
      this._renderState = {
        uri: editor.document.uri.toString(),
        width: `${maxLen}ch`,
        entries,
      };

      log.debug('updateDecorations: applying decorations', { count: entries.size });
      this._applyRenderState(editor);
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
   * Paint the gutter column from {@link _renderState} for `editor`. One pass over
   * the line→entry map; `setDecorations` replaces the whole set, so this fully
   * repaints in one call (no pre-clear, no flicker).
   */
  private _applyRenderState(editor: vscode.TextEditor): void {
    if (!this._textDecorationType || !this._renderState) {
      return;
    }
    const { width, entries } = this._renderState;
    // The stored width is the fixed text-column width in characters. The box is
    // sized by its CONTENT, not a `ch` width property (that left dead space on
    // short rows). Each cell's text is padded with NBSP to that width (so columns
    // align in the monospace editor font), wrapped with GUTTER_PAD on both sides
    // for symmetric breathing room.
    const rawWidthCh = parseInt(width, 10) || 0;
    // Size the text RELATIVE to the editor font, but render each cell as an
    // inline-block whose height is pinned to the editor's row line-height. The
    // tint paints the whole inline-block, so it fills the row regardless of how
    // small the text is, and a same-commit run reads as one continuous block. The
    // metrics are read for THIS editor's document (font/line-height can be
    // language-scoped). `vertical-align: top` makes the box cover exactly its row
    // (no line-height inflation). A right margin is the gap to the code.
    const { fontSizePx, lineHeightPx } = editorRowMetrics(editor.document.uri);
    const textPx = Math.max(BLAME_FONT_MIN_PX, Math.round(BLAME_FONT_SCALE * fontSizePx));
    const blockStyle =
      `none; display: inline-block; vertical-align: top; ` +
      `line-height: ${lineHeightPx}px; height: ${lineHeightPx}px; ` +
      `font-size: ${textPx}px; margin-right: ${GUTTER_PAD_CH}ch;`;
    const textDecorations: vscode.DecorationOptions[] = [];
    for (const [line, e] of entries) {
      const range = new vscode.Range(line, 0, line, 0);
      const aligned = e.text.padEnd(rawWidthCh, NBSP);
      textDecorations.push({
        range,
        // No hover on a blank (uncommitted / hidden / edited) cell.
        ...(e.blank || !e.hover ? {} : { hoverMessage: e.hover }),
        // Tint the FULL annotation column with the per-commit color (IntelliJ
        // tints the whole gutter cell). VS Code's per-instance `before` REPLACES
        // the type's `before`, so the muted text colour AND the inline-block sizing
        // are restated here. A blank cell keeps the padded width (for alignment)
        // but no tint.
        renderOptions: {
          before: {
            contentText: GUTTER_PAD + aligned + GUTTER_PAD,
            backgroundColor: e.bgColor,
            color: new vscode.ThemeColor('editorCodeLens.foreground'),
            textDecoration: blockStyle,
          },
        },
      });
    }
    editor.setDecorations(this._textDecorationType, textDecorations);
  }

  /**
   * Reflect a single document edit in {@link _renderState} SYNCHRONOUSLY: shift
   * the line→entry map by the edit's line delta and mark the edited/inserted rows
   * Uncommitted, then repaint — so a newly created line immediately has its gutter
   * cell (the caret stays put instead of snapping to column 0 and back while the
   * debounced re-blame runs). Only the common single-change case is handled; for
   * multi-change edits the debounced re-blame is the sole update.
   *
   * @returns `true` when it shifted + repainted, `false` when it declined (no
   *   state, URI mismatch, or a multi-change edit) so the caller still debounces.
   */
  private _shiftRenderStateForEdit(
    editor: vscode.TextEditor,
    changes: readonly vscode.TextDocumentContentChangeEvent[]
  ): boolean {
    if (!this._renderState || this._renderState.uri !== editor.document.uri.toString()) {
      return false;
    }
    if (changes.length !== 1) {
      return false;
    }
    const change = changes[0];
    const startLine = change.range.start.line;
    const endLine = change.range.end.line;
    const removed = endLine - startLine;
    const added = (change.text.match(/\n/g) ?? []).length;
    const delta = added - removed;

    const oldEntries = this._renderState.entries;
    const shifted = new Map<number, IGutterEntry>();
    for (const [line, entry] of oldEntries) {
      if (line < startLine) {
        shifted.set(line, entry);
      } else if (line > endLine) {
        shifted.set(line + delta, entry);
      }
      // Lines in [startLine, endLine] are dropped — the replaced region.
    }
    // The edited + newly inserted rows are now local content, so show the
    // Uncommitted cell at once (an edited line's prior blame is stale; a new line
    // has none). This matches what the debounced re-blame will report, so there's
    // no blank→Uncommitted flash.
    const uncommittedEntry = this.uncommittedEntry();
    for (let line = startLine; line <= startLine + added; line++) {
      shifted.set(line, uncommittedEntry);
    }
    // Rebuild a dense map over the new document so every line has a cell. Lines
    // with no shifted entry stay BLANK (not Uncommitted) — only the explicitly
    // edited/inserted rows above are marked Uncommitted.
    const lineCount = editor.document.lineCount;
    const dense = new Map<number, IGutterEntry>();
    for (let line = 0; line < lineCount; line++) {
      dense.set(line, shifted.get(line) ?? BLANK_ENTRY);
    }
    this._renderState = { ...this._renderState, entries: dense };
    // Bump the sequence number so any in-flight updateDecorations call (which
    // captured an older mySeq before its blame await) bails at the post-await
    // guard rather than overwriting this freshly-shifted gutter with stale
    // pre-edit blame.
    ++this._decorationRequestSeq;
    this._applyRenderState(editor);
    return true;
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

    // When the buffer has unsaved edits, blame the live content (`--contents -`)
    // so annotations align with the editor and edited/new lines come back
    // uncommitted instead of inheriting the on-disk line's blame. This path is
    // content-dependent, so it bypasses the provider-level cache too.
    const contents = document.isDirty ? document.getText() : undefined;
    if (contents !== undefined) {
      return this._blameService.getBlame(
        repo,
        relativePath,
        undefined,
        this._optionsSource?.asBlameOptions(),
        contents
      );
    }

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
      columns.push(
        fitColumn(
          formatAuthorName(blameLine.author, blameLine.authorEmail, authorNameFormat),
          AUTHOR_COL_CH
        )
      );
    }
    if (aspects.date) {
      columns.push(fitColumn(this.formatRelativeDate(blameLine.date), DATE_COL_CH));
    }
    if (aspects.revision) {
      columns.push(fitColumn(blameLine.commit.substring(0, 7), REVISION_COL_CH));
    }

    // Each column is already a FIXED width, so the joined text is a constant
    // length (per visible-aspect set) and the column never grows to fit. Join
    // with NBSP — plain spaces are collapsed/trimmed by the decoration renderer,
    // which would crush the inter-column gaps.
    return columns.join(NBSP);
  }

  /**
   * The gutter cell for a not-yet-committed (locally edited / inserted) line:
   * the "Uncommitted" label in the author column, the other visible columns
   * blank, a muted neutral tint, and no hover (there is no commit to open). Built
   * through the same fixed-width columns as {@link formatGutterText} so its width
   * matches committed cells and the code stays aligned.
   */
  private uncommittedEntry(): IGutterEntry {
    const { aspects } = this.resolveDisplay();
    const columns: string[] = [];
    if (aspects.author) {
      columns.push(fitColumn(UNCOMMITTED_LABEL, AUTHOR_COL_CH));
    }
    if (aspects.date) {
      columns.push(fitColumn('', DATE_COL_CH));
    }
    if (aspects.revision) {
      columns.push(fitColumn('', REVISION_COL_CH));
    }
    return { text: columns.join(NBSP), bgColor: UNCOMMITTED_BG, blank: false };
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
   * Clear the gutter for a single editor (used on the early-return paths of
   * {@link updateDecorations} so a no-blame / kill-switched file shows no gutter,
   * without disturbing the provider's current-editor state).
   */
  private clearDecorationsFor(editor: vscode.TextEditor): void {
    if (!this._textDecorationType) {
      return;
    }
    editor.setDecorations(this._textDecorationType, []);
    // Drop stale render state for this editor so a later edit doesn't shift and
    // repaint a gutter we just cleared.
    if (this._renderState && this._renderState.uri === editor.document.uri.toString()) {
      this._renderState = undefined;
    }
  }

  /**
   * Clear all decorations from all editors.
   */
  private clearDecorations(): void {
    if (!this._textDecorationType) {
      return;
    }
    // Clear the gutter from all visible editors
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this._textDecorationType, []);
    }

    this._currentEditor = undefined;
    this._renderState = undefined;
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
