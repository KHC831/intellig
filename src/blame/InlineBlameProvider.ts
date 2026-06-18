import * as vscode from 'vscode';
import { IInlineBlameProvider } from './interfaces/IInlineBlameProvider';
import { IBlameService, IBlameInfo } from './interfaces/IBlameService';
import { IGitService, IBlameLine, IRepository } from '../git-core/interfaces/IGitService';
import { BlameOptionsSource, IBlameAspectVisibility } from './BlameOptionsSource';
import { computeAuthorColor } from './authorColor';
import { AuthorNameFormat, formatAuthorName } from './authorNameFormat';
import { safeFireAndForget } from '../utils/safeFireAndForget';
import { parseRemoteUrl, type IRemoteUrl } from '../utils/remoteUrl';
import { commitUrl } from '../utils/hostingLinks';
import * as path from 'path';

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
 * Inline Blame Provider implementation.
 * Displays commit information at the end of the current line as a decoration.
 *
 * - Display blame annotations for file (inline at end of current line)
 * - Show commit message on hover
 * - Show tooltip with full commit details
 * - Use IntelliJ-style annotations
 */
export class InlineBlameProvider implements IInlineBlameProvider {
  private _enabled: boolean = false;
  private _blameService: IBlameService;
  private _gitService: IGitService;
  private _disposables: vscode.Disposable[] = [];
  private _decorationType: vscode.TextEditorDecorationType | undefined;
  private _onDidChangeEnabled: vscode.EventEmitter<boolean>;
  private _currentLine: number = -1;
  private _currentEditor: vscode.TextEditor | undefined;
  private _blameCache: Map<string, IBlameInfo> = new Map();

  /**
   * Parsed remote URL cache, keyed by repository root fsPath. Used
   * by the hover to turn the commit hash into a clickable link into the
   * hosting provider's web UI. `undefined` entries are stored too so we
   * don't re-parse the same unparseable URL on every hover.
   */
  private _remoteCache: Map<string, IRemoteUrl | undefined> = new Map();

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

    // Create the decoration type for inline blame
    this._decorationType = this.createDecorationType();

    // Set up event listeners
    this.setupEventListeners();

    // Re-blame whenever the option source changes (flag toggle or
    // hide/un-hide). Cache is dropped so the new flags take effect.
    if (this._optionsSource) {
      this._disposables.push(
        this._optionsSource.onDidChange(() => {
          this._blameCache.clear();
          if (this._enabled && this._currentEditor) {
            // Bucket B: blame fetches can fail (async gitCli);
            // surface to console without blocking the option-source sync.
            safeFireAndForget(
              this.updateDecoration(this._currentEditor, this._currentLine),
              'InlineBlameProvider.onDidChange: re-blame after options change'
            );
          }
        })
      );
    }
  }

  /**
   * Create the decoration type for inline blame annotations.
   * Uses a subtle style that doesn't interfere with code readability.
   */
  private createDecorationType(): vscode.TextEditorDecorationType {
    return vscode.window.createTextEditorDecorationType({
      after: {
        margin: '0 0 0 3em',
        textDecoration: 'none',
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
    });
  }

  /**
   * Set up event listeners for cursor movement and editor changes.
   */
  private setupEventListeners(): void {
    // Listen for cursor position changes
    this._disposables.push(
      vscode.window.onDidChangeTextEditorSelection(async (event) => {
        if (!this._enabled) {
          return;
        }

        const editor = event.textEditor;
        const line = editor.selection.active.line;

        // Only update if the line changed
        if (editor === this._currentEditor && line === this._currentLine) {
          return;
        }

        this._currentEditor = editor;
        this._currentLine = line;

        await this.updateDecoration(editor, line);
      })
    );

    // Listen for active editor changes
    this._disposables.push(
      vscode.window.onDidChangeActiveTextEditor(async (editor) => {
        if (!this._enabled || !editor) {
          this.clearDecorations();
          return;
        }

        this._currentEditor = editor;
        this._currentLine = editor.selection.active.line;

        await this.updateDecoration(editor, this._currentLine);
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
          // Bucket B: blame fetches can fail (async gitCli);
          // log+suppress so the event-listener chain stays alive.
          safeFireAndForget(
            this.updateDecoration(this._currentEditor, this._currentLine),
            'InlineBlameProvider.onDidChangeTextDocument: re-blame after edit'
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
          // Bucket B: same rationale as onDidChangeTextDocument.
          safeFireAndForget(
            this.updateDecoration(this._currentEditor, this._currentLine),
            'InlineBlameProvider.onDidSaveTextDocument: re-blame after save'
          );
        }
      })
    );
  }

  /**
   * Enable inline blame annotations.
   */
  enable(): void {
    if (this._enabled) {
      return;
    }

    this._enabled = true;
    this._onDidChangeEnabled.fire(true);

    // Update decoration for current editor
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      this._currentEditor = editor;
      this._currentLine = editor.selection.active.line;
      // Bucket B: enable is sync; async blame fetch follows.
      safeFireAndForget(
        this.updateDecoration(editor, this._currentLine),
        'InlineBlameProvider.enable: initial decoration'
      );
    }
  }

  /**
   * Disable inline blame annotations.
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
   * Toggle inline blame annotations on/off.
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
   * Check if inline blame is currently enabled.
   * @returns True if inline blame is enabled
   */
  isEnabled(): boolean {
    return this._enabled;
  }

  /**
   * Refresh the inline blame decoration for the current editor.
   */
  async refresh(): Promise<void> {
    if (!this._enabled || !this._currentEditor) {
      return;
    }

    // Clear cache for current document
    const uri = this._currentEditor.document.uri.toString();
    this._blameCache.delete(uri);

    await this.updateDecoration(this._currentEditor, this._currentLine);
  }

  /**
   * Check whether the active `intellig.blameAnnotationStyle` permits
   * inline annotations. Returns `false` when the style is `'off'` or
   * `'gutter'` (inline-only-relevant styles are `'inline'` and `'both'`).
   *
   * Exposed for unit testing via the `as unknown as { isAnnotationStyleEnabled(): boolean }`
   * test-seam pattern used elsewhere in this codebase.
   */
  isAnnotationStyleEnabled(): boolean {
    const style = vscode.workspace
      .getConfiguration('intellig')
      .get<string>('blameAnnotationStyle', 'inline');
    return style === 'inline' || style === 'both';
  }

  /**
   * Update the inline blame decoration for the specified line.
   *
   * @param editor - The text editor
   * @param line - The line number (0-indexed)
   */
  private async updateDecoration(editor: vscode.TextEditor, line: number): Promise<void> {
    if (!this._decorationType) {
      return;
    }

    // Clear existing decorations first
    editor.setDecorations(this._decorationType, []);

    // Respect the master annotation style kill-switch.
    if (!this.isAnnotationStyleEnabled()) {
      return;
    }

    // Skip if not a file scheme (e.g., output, debug console)
    if (editor.document.uri.scheme !== 'file') {
      return;
    }

    try {
      const blameLine = await this.getBlameForLine(editor, line);
      if (!blameLine) {
        return;
      }

      // Resolve the repository once so we can feed its first remote URL
      // into the hover markdown. Failure here is non-fatal — the hover
      // still renders, just without the external commit link.
      const repo = await this._gitService.getRepository(editor.document.uri);

      // In AUTHOR color mode, tint the inline text by the stable per-author
      // color computed over the file's full author set (matches IntelliJ's
      // AnnotateToggleAction AUTHOR branch). ORDER mode leaves it undefined
      // and falls back to the age-based fade in createDecoration.
      const textColor = this.resolveAuthorColor(editor, blameLine);

      // Create the decoration
      const decoration = this.createDecoration(editor, line, blameLine, repo, textColor);
      if (decoration) {
        editor.setDecorations(this._decorationType, [decoration]);
      }
    } catch {
      // Silently fail - blame may not be available for this file
    }
  }

  /**
   * Get blame information for a specific line.
   *
   * @param editor - The text editor
   * @param line - The line number (0-indexed)
   * @returns The blame line information, or undefined if not available
   */
  private async getBlameForLine(
    editor: vscode.TextEditor,
    line: number
  ): Promise<IBlameLine | undefined> {
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
      // Fetch blame info, piping through the current -w/-M/-C selection.
      blameInfo = await this._blameService.getBlame(
        repo,
        relativePath,
        undefined,
        this._optionsSource?.asBlameOptions()
      );
      this._blameCache.set(cacheKey, blameInfo);
    }

    // Find the blame line (line numbers in blame are 1-indexed)
    const blameLine = blameInfo.lines.find((bl) => bl.line === line + 1);
    // Skip hidden revisions — the inline decoration stays empty so the
    // user doesn't see annotation for elided commits.
    if (blameLine && this._optionsSource && this._optionsSource.isHidden(blameLine.commit)) {
      return undefined;
    }
    return blameLine;
  }

  /**
   * Create a decoration for the blame annotation.
   *
   * @param editor - The text editor
   * @param line - The line number (0-indexed)
   * @param blameLine - The blame information for the line
   * @returns The decoration options, or undefined if not applicable
   */
  private createDecoration(
    editor: vscode.TextEditor,
    line: number,
    blameLine: IBlameLine,
    repo?: IRepository | undefined,
    textColor?: string
  ): vscode.DecorationOptions | undefined {
    // Skip uncommitted changes
    if (blameLine.commit.startsWith('0000000')) {
      return undefined;
    }

    // Format the inline text
    const inlineText = this.formatInlineText(blameLine);

    // Create hover message with full details
    const hoverMessage = this.createHoverMessage(blameLine, repo);

    // Get the line range (end of line)
    const lineText = editor.document.lineAt(line);
    const range = new vscode.Range(line, lineText.text.length, line, lineText.text.length);

    // AUTHOR mode supplies a per-author color; ORDER mode falls back to the
    // age-based fade.
    const color = textColor ?? this.getAgeBasedColor(blameLine.date);

    return {
      range,
      hoverMessage,
      renderOptions: {
        after: {
          contentText: inlineText,
          color: color,
          fontStyle: 'italic',
        },
      },
    };
  }

  /**
   * Format the inline text for the blame annotation. Renders only the aspect
   * fields the user has left visible (revision / author / date), with the
   * author rendered per the chosen name format, followed by the truncated
   * commit message. Mirrors IntelliJ's per-aspect show/hide annotation fields.
   *
   * @param blameLine - The blame information
   * @returns The formatted inline text
   */
  private formatInlineText(blameLine: IBlameLine): string {
    const { aspects, authorNameFormat } = this.resolveDisplay();

    const meta: string[] = [];
    if (aspects.author) {
      meta.push(
        this.truncateString(
          formatAuthorName(blameLine.author, blameLine.authorEmail, authorNameFormat),
          20
        )
      );
    }
    if (aspects.date) {
      meta.push(this.formatRelativeDate(blameLine.date));
    }

    let prefix = meta.join(', ');
    if (aspects.revision) {
      const shortHash = blameLine.commit.substring(0, 7);
      prefix = prefix ? `${shortHash} ${prefix}` : shortHash;
    }

    const message = this.truncateString(blameLine.message, 40);
    return prefix ? `${prefix} • ${message}` : message;
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
   * Create a hover message with full commit details.
   *
   * When the repository has a parseable remote URL and the provider is
   * known, the short hash renders as a clickable link into the provider's
   * web UI. On remote-parse failure we fall back to the plain `` `hash` ``
   * markdown so the hover never crashes.
   *
   * @param blameLine - The blame information
   * @param repo - The repository that owns the file (used for the remote URL)
   * @returns The hover message as MarkdownString
   */
  private createHoverMessage(
    blameLine: IBlameLine,
    repo?: IRepository | undefined
  ): vscode.MarkdownString {
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

    // Build the provider commit URL if we can. A failure at any step
    // (no remotes, unparseable URL, unknown provider) leaves `providerLink`
    // undefined and the hover falls back to the plain hash.
    const providerLink = this._buildCommitProviderLink(repo, blameLine.commit);

    // Build the hover content
    if (providerLink) {
      md.appendMarkdown(`**Commit:** [\`${shortHash}\`](${providerLink})\n\n`);
    } else {
      md.appendMarkdown(`**Commit:** \`${shortHash}\`\n\n`);
    }
    md.appendMarkdown(`**Author:** ${blameLine.author}`);
    if (blameLine.authorEmail) {
      md.appendMarkdown(` <${blameLine.authorEmail}>`);
    }
    md.appendMarkdown(`\n\n`);
    md.appendMarkdown(`**Date:** ${dateStr}\n\n`);
    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(`${blameLine.message}\n\n`);

    // Add action links
    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(
      `[View Commit](command:intellig.editor.showCommit?${encodeURIComponent(JSON.stringify(blameLine.commit))}) | `
    );
    md.appendMarkdown(
      `[Copy Hash](command:intellig.editor.copyCommitHash?${encodeURIComponent(JSON.stringify(blameLine.commit))})`
    );
    if (providerLink) {
      md.appendMarkdown(` | [Open on Host](${providerLink})`);
    }

    return md;
  }

  /**
   * Resolve the repo's first remote URL (preferring `origin`) and
   * build a commit link into the hosting provider's web UI. Caches the
   * parsed remote per repo so we don't re-parse the URL on every hover.
   * Returns `undefined` when any step fails so the hover falls back to a
   * plain hash.
   */
  private _buildCommitProviderLink(
    repo: IRepository | undefined,
    hash: string
  ): string | undefined {
    if (!repo) {
      return undefined;
    }
    const key = repo.rootUri.fsPath;
    let parsed: IRemoteUrl | undefined;
    if (this._remoteCache.has(key)) {
      parsed = this._remoteCache.get(key);
    } else {
      const remotes = repo.remotes ?? [];
      if (remotes.length === 0) {
        this._remoteCache.set(key, undefined);
        return undefined;
      }
      const preferred = remotes.find((r) => r.name === 'origin') ?? remotes[0];
      const url = preferred.fetchUrl ?? preferred.pushUrl;
      parsed = parseRemoteUrl(url);
      this._remoteCache.set(key, parsed);
    }
    if (!parsed) {
      return undefined;
    }
    return commitUrl(parsed, hash);
  }

  /**
   * Resolve the AUTHOR-mode text color for a line, or `undefined` when the
   * active color mode is ORDER. The per-author color is computed over the
   * file's full author set (read from the blame cache populated by
   * {@link getBlameForLine}), so the same author is tinted consistently.
   *
   * @param editor - The text editor
   * @param blameLine - The blame line being decorated
   * @returns The CSS color string, or `undefined` to use the age-based fade
   */
  private resolveAuthorColor(editor: vscode.TextEditor, blameLine: IBlameLine): string | undefined {
    const colorMode = this._optionsSource?.snapshot().colorMode ?? 'order';
    if (colorMode !== 'author') {
      return undefined;
    }
    const cached = this._blameCache.get(editor.document.uri.toString());
    if (!cached) {
      return undefined;
    }
    const authors = cached.lines
      .filter((bl) => !bl.commit.startsWith('0000000'))
      .map((bl) => bl.author);
    return computeAuthorColor(blameLine.author, authors);
  }

  /**
   * Get an age-based color for the blame annotation.
   * Newer commits are brighter, older commits are more faded.
   *
   * @param date - The commit date
   * @returns The color string
   */
  private getAgeBasedColor(date: Date): string {
    const now = new Date();
    const ageInDays = (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24);

    // Color gradient from bright to faded based on age
    // Recent (< 7 days): bright
    // Medium (7-30 days): medium
    // Old (30-90 days): faded
    // Very old (> 90 days): very faded

    if (ageInDays < 7) {
      return 'rgba(153, 153, 153, 0.9)'; // Bright gray
    } else if (ageInDays < 30) {
      return 'rgba(153, 153, 153, 0.7)'; // Medium gray
    } else if (ageInDays < 90) {
      return 'rgba(153, 153, 153, 0.5)'; // Faded gray
    } else {
      return 'rgba(153, 153, 153, 0.35)'; // Very faded gray
    }
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
      return diffYears === 1 ? '1 year ago' : `${diffYears} years ago`;
    } else if (diffMonths > 0) {
      return diffMonths === 1 ? '1 month ago' : `${diffMonths} months ago`;
    } else if (diffWeeks > 0) {
      return diffWeeks === 1 ? '1 week ago' : `${diffWeeks} weeks ago`;
    } else if (diffDays > 0) {
      return diffDays === 1 ? '1 day ago' : `${diffDays} days ago`;
    } else if (diffHours > 0) {
      return diffHours === 1 ? '1 hour ago' : `${diffHours} hours ago`;
    } else if (diffMins > 0) {
      return diffMins === 1 ? '1 minute ago' : `${diffMins} minutes ago`;
    } else {
      return 'just now';
    }
  }

  /**
   * Truncate a string to a maximum length.
   *
   * @param str - The string to truncate
   * @param maxLength - The maximum length
   * @returns The truncated string
   */
  private truncateString(str: string, maxLength: number): string {
    if (str.length <= maxLength) {
      return str;
    }
    return str.substring(0, maxLength - 1) + '…';
  }

  /**
   * Clear all decorations from all editors.
   */
  private clearDecorations(): void {
    if (!this._decorationType) {
      return;
    }

    // Clear decorations from all visible editors
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this._decorationType, []);
    }

    this._currentLine = -1;
    this._currentEditor = undefined;
  }

  /**
   * Dispose of resources.
   */
  dispose(): void {
    // Disable first to clean up state
    this._enabled = false;

    this._onDidChangeEnabled.dispose();

    if (this._decorationType) {
      this._decorationType.dispose();
      this._decorationType = undefined;
    }

    for (const disposable of this._disposables) {
      disposable.dispose();
    }
    this._disposables = [];

    this._blameCache.clear();
  }
}

/**
 * Create a new InlineBlameProvider instance.
 *
 * @param blameService - The blame service
 * @param gitService - The git service
 * @returns A new InlineBlameProvider instance
 */
export function createInlineBlameProvider(
  blameService: IBlameService,
  gitService: IGitService,
  optionsSource?: BlameOptionsSource
): InlineBlameProvider {
  return new InlineBlameProvider(blameService, gitService, optionsSource);
}
