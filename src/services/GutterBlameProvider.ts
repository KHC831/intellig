import * as vscode from 'vscode';
import { IGutterBlameProvider } from './interfaces/IGutterBlameProvider';
import { IBlameService, IBlameInfo } from './interfaces/IBlameService';
import { IGitService, IBlameLine } from './interfaces/IGitService';
import * as path from 'path';

/**
 * Gutter Blame Provider implementation.
 * Displays blame annotations in the editor gutter for all visible lines,
 * with age-based color gradients and click actions.
 *
 * Requirements: 9.2, 9.5, 9.7 (Blame)
 * - 9.2: Display blame information in the editor gutter for all visible lines
 * - 9.5: Click actions to view commit or copy hash
 * - 9.7: Use distinct colors to differentiate commits by age
 */
export class GutterBlameProvider implements IGutterBlameProvider {
  private _enabled: boolean = false;
  private _blameService: IBlameService;
  private _gitService: IGitService;
  private _disposables: vscode.Disposable[] = [];
  private _decorationTypes: Map<string, vscode.TextEditorDecorationType> = new Map();
  private _onDidChangeEnabled: vscode.EventEmitter<boolean>;
  private _currentEditor: vscode.TextEditor | undefined;
  private _blameCache: Map<string, IBlameInfo> = new Map();
  private _updateDebounceTimer: NodeJS.Timeout | undefined;

  /**
   * Age brackets for color gradients (in days)
   */
  private static readonly AGE_BRACKETS = [
    { maxDays: 1, color: 'rgba(100, 200, 100, 0.9)', label: 'today' },
    { maxDays: 7, color: 'rgba(120, 180, 120, 0.8)', label: 'this week' },
    { maxDays: 30, color: 'rgba(140, 160, 140, 0.7)', label: 'this month' },
    { maxDays: 90, color: 'rgba(150, 150, 150, 0.6)', label: 'recent' },
    { maxDays: 180, color: 'rgba(140, 140, 140, 0.5)', label: 'older' },
    { maxDays: 365, color: 'rgba(130, 130, 130, 0.4)', label: 'last year' },
    { maxDays: Infinity, color: 'rgba(120, 120, 120, 0.35)', label: 'ancient' },
  ];

  /**
   * Event fired when the enabled state changes.
   */
  readonly onDidChangeEnabled: vscode.Event<boolean>;

  constructor(blameService: IBlameService, gitService: IGitService) {
    this._blameService = blameService;
    this._gitService = gitService;
    this._onDidChangeEnabled = new vscode.EventEmitter<boolean>();
    this.onDidChangeEnabled = this._onDidChangeEnabled.event;

    // Set up event listeners
    this.setupEventListeners();
  }

  /**
   * Create a decoration type for a specific age bracket.
   * Each age bracket gets its own decoration type with appropriate color.
   *
   * @param ageKey - The age bracket key
   * @param color - The color for this age bracket
   * @returns The decoration type
   */
  private getOrCreateDecorationType(
    ageKey: string,
    color: string
  ): vscode.TextEditorDecorationType {
    if (!this._decorationTypes.has(ageKey)) {
      const decorationType = vscode.window.createTextEditorDecorationType({
        gutterIconSize: 'contain',
        before: {
          contentText: '',
          width: '200px',
          color: color,
          textDecoration: 'none; font-size: 11px; font-family: monospace;',
        },
        isWholeLine: false,
      });
      this._decorationTypes.set(ageKey, decorationType);
    }
    return this._decorationTypes.get(ageKey)!;
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
          void this.updateDecorations(this._currentEditor);
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
      void this.updateDecorations(editor);
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
      void this.updateDecorations(editor);
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
   * Update gutter blame decorations for all visible lines.
   *
   * @param editor - The text editor
   */
  private async updateDecorations(editor: vscode.TextEditor): Promise<void> {
    // Clear existing decorations first
    this.clearDecorationsForEditor(editor);

    // Skip if not a file scheme (e.g., output, debug console)
    if (editor.document.uri.scheme !== 'file') {
      return;
    }

    try {
      const blameInfo = await this.getBlameForFile(editor);
      if (!blameInfo || blameInfo.lines.length === 0) {
        return;
      }

      // Get visible ranges
      const visibleRanges = editor.visibleRanges;
      if (visibleRanges.length === 0) {
        return;
      }

      // Group decorations by age bracket for efficient rendering
      const decorationsByAge: Map<string, vscode.DecorationOptions[]> = new Map();

      for (const visibleRange of visibleRanges) {
        const startLine = visibleRange.start.line;
        const endLine = visibleRange.end.line;

        for (let line = startLine; line <= endLine; line++) {
          // Find blame for this line (blame lines are 1-indexed)
          const blameLine = blameInfo.lines.find((bl) => bl.line === line + 1);
          if (!blameLine || blameLine.commit.startsWith('0000000')) {
            continue;
          }

          const decoration = this.createDecoration(editor, line, blameLine);
          if (decoration) {
            const ageKey = this.getAgeBracketKey(blameLine.date);
            if (!decorationsByAge.has(ageKey)) {
              decorationsByAge.set(ageKey, []);
            }
            decorationsByAge.get(ageKey)!.push(decoration);
          }
        }
      }

      // Apply decorations by age bracket
      for (const [ageKey, decorations] of decorationsByAge) {
        const bracket = this.getAgeBracket(ageKey);
        const decorationType = this.getOrCreateDecorationType(ageKey, bracket.color);
        editor.setDecorations(decorationType, decorations);
      }
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
      // Fetch blame info
      blameInfo = await this._blameService.getBlame(repo, relativePath);
      this._blameCache.set(cacheKey, blameInfo);
    }

    return blameInfo;
  }

  /**
   * Create a decoration for a blame annotation in the gutter.
   *
   * @param _editor - The text editor (unused, kept for API consistency)
   * @param line - The line number (0-indexed)
   * @param blameLine - The blame information for the line
   * @returns The decoration options, or undefined if not applicable
   */
  private createDecoration(
    _editor: vscode.TextEditor,
    line: number,
    blameLine: IBlameLine
  ): vscode.DecorationOptions | undefined {
    // Format the gutter text
    const gutterText = this.formatGutterText(blameLine);

    // Create hover message with full details and click actions
    const hoverMessage = this.createHoverMessage(blameLine);

    // Get the line range (start of line)
    const range = new vscode.Range(line, 0, line, 0);

    // Get age-based color
    const ageKey = this.getAgeBracketKey(blameLine.date);
    const bracket = this.getAgeBracket(ageKey);

    return {
      range,
      hoverMessage,
      renderOptions: {
        before: {
          contentText: gutterText,
          color: bracket.color,
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
      `[View Commit](command:intellij-git.viewCommit?${encodeURIComponent(JSON.stringify(blameLine.commit))}) | `
    );
    md.appendMarkdown(
      `[Copy Hash](command:intellij-git.copyCommitHash?${encodeURIComponent(JSON.stringify(blameLine.commit))}) | `
    );
    if (blameLine.previousCommit) {
      md.appendMarkdown(
        `[Previous Revision](command:intellij-git.showPreviousRevision?${encodeURIComponent(JSON.stringify({ commit: blameLine.commit, path: '' }))})`
      );
    }

    return md;
  }

  /**
   * Get the age bracket key for a date.
   *
   * @param date - The commit date
   * @returns The age bracket key
   */
  private getAgeBracketKey(date: Date): string {
    const now = new Date();
    const ageInDays = (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24);

    for (let i = 0; i < GutterBlameProvider.AGE_BRACKETS.length; i++) {
      if (ageInDays <= GutterBlameProvider.AGE_BRACKETS[i].maxDays) {
        return `age_${i}`;
      }
    }
    return `age_${GutterBlameProvider.AGE_BRACKETS.length - 1}`;
  }

  /**
   * Get the age bracket configuration for a key.
   *
   * @param ageKey - The age bracket key
   * @returns The age bracket configuration
   */
  private getAgeBracket(ageKey: string): (typeof GutterBlameProvider.AGE_BRACKETS)[0] {
    const index = parseInt(ageKey.replace('age_', ''), 10);
    return (
      GutterBlameProvider.AGE_BRACKETS[index] ||
      GutterBlameProvider.AGE_BRACKETS[GutterBlameProvider.AGE_BRACKETS.length - 1]
    );
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
   * Clear decorations for a specific editor.
   *
   * @param editor - The text editor
   */
  private clearDecorationsForEditor(editor: vscode.TextEditor): void {
    for (const decorationType of this._decorationTypes.values()) {
      editor.setDecorations(decorationType, []);
    }
  }

  /**
   * Clear all decorations from all editors.
   */
  private clearDecorations(): void {
    // Clear decorations from all visible editors
    for (const editor of vscode.window.visibleTextEditors) {
      this.clearDecorationsForEditor(editor);
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

    // Dispose all decoration types
    for (const decorationType of this._decorationTypes.values()) {
      decorationType.dispose();
    }
    this._decorationTypes.clear();

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
  gitService: IGitService
): GutterBlameProvider {
  return new GutterBlameProvider(blameService, gitService);
}
