import * as vscode from 'vscode';
import { IGutterBlameProvider } from './interfaces/IGutterBlameProvider';
import { IBlameService, IBlameInfo } from './interfaces/IBlameService';
import { IGitService, IBlameLine } from '../git-core/interfaces/IGitService';
import { BlameOptionsSource } from './BlameOptionsSource';
import { safeFireAndForget } from '../utils/safeFireAndForget';
import { computeHeatColor } from './heatColor';
import * as path from 'path';

/**
 * Gutter Blame Provider implementation.
 * Displays blame annotations in the editor gutter for all visible lines,
 * with an IntelliJ-style interpolated background gradient and click actions.
 *
 * - Display blame information in the editor gutter for all visible lines
 * - Click actions to view commit or copy hash
 * - Background heat gradient: newest commits → warm/amber, oldest → cool/gray,
 *   interpolated linearly across the file's full age range (matches IntelliJ's
 *   ORDER color mode from AnnotateToggleAction / AnnotationsSettings).
 */
export class GutterBlameProvider implements IGutterBlameProvider {
  private _enabled: boolean = false;
  private _blameService: IBlameService;
  private _gitService: IGitService;
  private _disposables: vscode.Disposable[] = [];
  /**
   * Single shared decoration type for the gutter `before` pseudo-element.
   * Per-line background colors are injected via `DecorationOptions.renderOptions`
   * (instance-level `before.backgroundColor`), so we only need one type.
   */
  private _sharedDecorationType: vscode.TextEditorDecorationType | undefined;
  private _onDidChangeEnabled: vscode.EventEmitter<boolean>;
  private _currentEditor: vscode.TextEditor | undefined;
  private _blameCache: Map<string, IBlameInfo> = new Map();
  private _updateDebounceTimer: NodeJS.Timeout | undefined;

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

    // Shared decoration type — text style is fixed; background color is
    // supplied per-instance via DecorationOptions.renderOptions.before.
    this._sharedDecorationType = vscode.window.createTextEditorDecorationType({
      before: {
        contentText: '',
        width: '200px',
        textDecoration: 'none; font-size: 11px; font-family: monospace;',
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

    // Listen for visible range changes (scrolling)
    this._disposables.push(
      vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
        if (!this._enabled) {
          return;
        }

        // Debounce updates during scrolling
        this.debounceUpdate(event.textEditor);
      })
    );

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
   * Debounce decoration updates during rapid scrolling.
   *
   * @param editor - The text editor to update
   */
  private debounceUpdate(editor: vscode.TextEditor): void {
    if (this._updateDebounceTimer) {
      clearTimeout(this._updateDebounceTimer);
    }

    this._updateDebounceTimer = setTimeout(() => {
      // Bucket B: debounced scroll/edit update; log+suppress so
      // the debounce cycle keeps firing even if one fetch rejects.
      safeFireAndForget(
        this.updateDecorations(editor),
        'GutterBlameProvider.debounceUpdate: debounced decoration refresh'
      );
    }, 100);
  }

  /**
   * Enable gutter blame annotations.
   */
  enable(): void {
    if (this._enabled) {
      return;
    }

    this._enabled = true;
    this._onDidChangeEnabled.fire(true);

    // Update decorations for current editor
    const editor = vscode.window.activeTextEditor;
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
   * Update gutter blame decorations for all visible lines.
   *
   * Computes the file's full oldest↔newest commit timestamp range from all
   * blamed lines, then interpolates a background heat color per line using
   * `computeHeatColor`. Matches IntelliJ's ORDER color mode (AnnotateToggleAction
   * `computeBgColors`) where newer commits get a warmer background.
   *
   * @param editor - The text editor
   */
  private async updateDecorations(editor: vscode.TextEditor): Promise<void> {
    if (!this._sharedDecorationType) {
      return;
    }

    // Clear existing decorations first
    editor.setDecorations(this._sharedDecorationType, []);

    // Respect the master annotation style kill-switch.
    if (!this.isAnnotationStyleEnabled()) {
      return;
    }

    // Skip if not a file scheme (e.g., output, debug console)
    if (editor.document.uri.scheme !== 'file') {
      return;
    }

    try {
      const blameInfo = await this.getBlameForFile(editor);
      if (!blameInfo || blameInfo.lines.length === 0) {
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
        return;
      }

      // Get visible ranges
      const visibleRanges = editor.visibleRanges;
      if (visibleRanges.length === 0) {
        return;
      }

      const decorations: vscode.DecorationOptions[] = [];

      for (const visibleRange of visibleRanges) {
        const startLine = visibleRange.start.line;
        const endLine = visibleRange.end.line;

        for (let line = startLine; line <= endLine; line++) {
          // Blame lines are 1-indexed
          const blameLine = blameInfo.lines.find((bl) => bl.line === line + 1);
          if (!blameLine || blameLine.commit.startsWith('0000000')) {
            continue;
          }

          // "Hide Revision" — any line whose commit the user has hidden is
          // elided from the gutter. No decoration is rendered.
          if (this._optionsSource && this._optionsSource.isHidden(blameLine.commit)) {
            continue;
          }

          // Per-line background color interpolated across the file's age range.
          const bgColor = computeHeatColor(blameLine.date.getTime(), oldestMs, newestMs);
          const decoration = this.createDecoration(line, blameLine, bgColor);
          if (decoration) {
            decorations.push(decoration);
          }
        }
      }

      editor.setDecorations(this._sharedDecorationType, decorations);
    } catch {
      // Silently fail - blame may not be available for this file
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

    // Get repository for this file
    const repo = await this._gitService.getRepository(uri);
    if (!repo) {
      return undefined;
    }

    // Get relative path from repository root
    const relativePath = path.relative(repo.rootUri.fsPath, uri.fsPath);

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
   * Create a decoration for a blame annotation in the gutter.
   *
   * The background color is pre-computed by the caller from the file-wide
   * timestamp range so it reflects IntelliJ's ORDER gradient semantics.
   *
   * @param line - The line number (0-indexed)
   * @param blameLine - The blame information for the line
   * @param bgColor - The CSS `rgba()` background color for this line
   * @returns The decoration options, or undefined if not applicable
   */
  private createDecoration(
    line: number,
    blameLine: IBlameLine,
    bgColor: string
  ): vscode.DecorationOptions | undefined {
    // Format the gutter text
    const gutterText = this.formatGutterText(blameLine);

    // Create hover message with full details and click actions
    const hoverMessage = this.createHoverMessage(blameLine);

    // Get the line range (start of line)
    const range = new vscode.Range(line, 0, line, 0);

    return {
      range,
      hoverMessage,
      renderOptions: {
        before: {
          contentText: gutterText,
          // Foreground text color inherits from the theme; background carries
          // the IntelliJ-style heat gradient interpolated across the file.
          backgroundColor: bgColor,
        },
      },
    };
  }

  /**
   * Format the gutter text for the blame annotation.
   * Shows author initials/name and relative date.
   *
   * @param blameLine - The blame information
   * @returns The formatted gutter text
   */
  private formatGutterText(blameLine: IBlameLine): string {
    const author = this.formatAuthor(blameLine.author);
    const relativeDate = this.formatRelativeDate(blameLine.date);
    const shortHash = blameLine.commit.substring(0, 7);

    // Format: "author  date  hash"
    return `${author.padEnd(12)} ${relativeDate.padEnd(12)} ${shortHash}`;
  }

  /**
   * Format author name for gutter display.
   * Uses initials for long names, full name for short names.
   *
   * @param author - The author name
   * @returns The formatted author string
   */
  private formatAuthor(author: string): string {
    // If name is short enough, use it directly
    if (author.length <= 10) {
      return author;
    }

    // Try to extract initials from name parts
    const parts = author.split(/\s+/);
    if (parts.length >= 2) {
      // Use first name + last initial
      const firstName = parts[0];
      const lastInitial = parts[parts.length - 1].charAt(0).toUpperCase();
      if (firstName.length <= 8) {
        return `${firstName} ${lastInitial}.`;
      }
      // Use initials only
      return parts.map((p) => p.charAt(0).toUpperCase()).join('');
    }

    // Truncate long single names
    return author.substring(0, 9) + '…';
  }

  /**
   * Create a hover message with full commit details and click actions.
   *
   * @param blameLine - The blame information
   * @returns The hover message as MarkdownString
   */
  private createHoverMessage(blameLine: IBlameLine): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportHtml = true;

    // Commit hash (short)
    const shortHash = blameLine.commit.substring(0, 7);

    // Format the date
    const dateStr = blameLine.date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

    // Build the hover content
    md.appendMarkdown(`**Commit:** \`${shortHash}\`\n\n`);
    md.appendMarkdown(`**Author:** ${blameLine.author}`);
    if (blameLine.authorEmail) {
      md.appendMarkdown(` <${blameLine.authorEmail}>`);
    }
    md.appendMarkdown(`\n\n`);
    md.appendMarkdown(`**Date:** ${dateStr}\n\n`);
    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(`${blameLine.message}\n\n`);

    // Add action links (click actions)
    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(
      `[View Commit](command:intellig.viewCommit?${encodeURIComponent(JSON.stringify(blameLine.commit))}) | `
    );
    md.appendMarkdown(
      `[Copy Hash](command:intellig.copyCommitHash?${encodeURIComponent(JSON.stringify(blameLine.commit))}) | `
    );
    if (blameLine.previousCommit) {
      md.appendMarkdown(
        `[Previous Revision](command:intellig.showPreviousRevision?${encodeURIComponent(JSON.stringify({ commit: blameLine.commit, path: '' }))})`
      );
    }

    return md;
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
    if (!this._sharedDecorationType) {
      return;
    }
    // Clear decorations from all visible editors
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this._sharedDecorationType, []);
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

    if (this._sharedDecorationType) {
      this._sharedDecorationType.dispose();
      this._sharedDecorationType = undefined;
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
