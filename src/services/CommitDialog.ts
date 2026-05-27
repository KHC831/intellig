/**
 * Commit Dialog implementation.
 * Provides a comprehensive commit dialog with diff preview and advanced options.
 * Implements IntelliJ-style commit workflow.
 */

import * as vscode from 'vscode';
import { IGitService, IRepository, IDiff, IHunk, ICommitOptions } from './interfaces/IGitService';
import { RECENT_MESSAGES_STATE_KEY, updateRecentMessagesLru } from './CommitToolWindow';
import { generateNonce } from '../utils/webviewNonce';
import { sanitizeGitError } from '../utils/gitError';

/**
 * workspaceState key persisting the gear-menu `--no-verify` toggle so it
 * survives between dialog invocations.
 */
export const LAST_NO_VERIFY_STATE_KEY = 'intellig.commit.lastNoVerify';

/**
 * Configuration key for the optional default author override.
 * When set to a valid `Name <email>` string, the CommitDialog pre-fills
 * the author field on open; the user can still edit or clear it.
 */
export const COMMIT_AUTHOR_CONFIG_KEY = 'commitAuthor';

/**
 * Options for opening the commit dialog
 */
export interface ICommitDialogOptions {
  /** Initial commit message */
  initialMessage?: string;
  /** Whether to amend the previous commit */
  amend?: boolean;
  /** Pre-selected files to commit */
  preSelectedFiles?: string[];
}

/**
 * Result from the commit dialog
 */
export interface ICommitDialogResult {
  /** Whether a commit was made */
  committed: boolean;
  /** The commit message used */
  message?: string;
  /** Files that were committed */
  files?: string[];
}

/**
 * Staged file information for the dialog
 */
interface IStagedFile {
  path: string;
  status: string;
  staged: boolean;
  selected: boolean;
}

/**
 * Options for {@link performCommit}.
 *
 * T1-04 extracted the commit-execution body of {@link CommitDialog._handleCommit}
 * into a standalone helper so the new {@link CommitToolWindow} (WebviewView-based
 * Commit surface) can call the exact same code path. Behavior must be identical
 * — only the UI wrapper differs.
 */
export interface IPerformCommitOptions {
  /** Non-empty commit message. Caller must validate before invoking. */
  message: string;
  /** Paths the user wants included in this commit (a mix of staged + unstaged). */
  selectedFiles: string[];
  /** All files currently known to the calling UI (used to compute stage/unstage deltas). */
  allFiles: Array<{ path: string; staged: boolean }>;
  /** Amend-the-previous-commit mode. */
  amend?: boolean;
  /** Append a `Signed-off-by` trailer. */
  signOff?: boolean;
  /**
   * Optional author override in `Name <email>` format. Invalid values
   * cause {@link performCommit} to return `{ success: false, error: … }`
   * without running any git commands. T2-06.
   */
  author?: string;
  /**
   * Skip git commit hooks (`--no-verify`). Mirrors the gear-menu toggle
   * in the Commit dialog. T2-06.
   */
  noVerify?: boolean;
}

/**
 * Result from {@link performCommit}.
 */
export interface IPerformCommitResult {
  /** True when the commit landed. */
  success: boolean;
  /** User-facing error message when {@link success} is false. */
  error?: string;
  /** Paths that ended up in the commit. Echoes {@link IPerformCommitOptions.selectedFiles} on success. */
  files?: string[];
}

/**
 * Execute a commit against {@link IGitService} using the partial-staging flow
 * that both {@link CommitDialog} and {@link CommitToolWindow} share.
 *
 * The helper:
 *   1. Stages any selected-but-unstaged files (delta-based).
 *   2. Unstages any staged-but-deselected files (delta-based).
 *   3. Calls {@link IGitService.commit} with {amend, signOff}.
 *
 * Errors are captured and returned via {@link IPerformCommitResult.error}; the
 * helper never throws. Callers render their own toast.
 */
export async function performCommit(
  gitService: IGitService,
  repository: IRepository,
  options: IPerformCommitOptions
): Promise<IPerformCommitResult> {
  const trimmed = options.message.trim();
  if (!trimmed) {
    return { success: false, error: 'Commit message cannot be empty' };
  }
  if (!options.selectedFiles || options.selectedFiles.length === 0) {
    return { success: false, error: 'No files selected for commit' };
  }

  // T2-06: validate author override (if supplied) before touching the
  // working tree.
  const authorTrimmed = options.author?.trim() ?? '';
  if (authorTrimmed.length > 0 && !isValidAuthorFormat(authorTrimmed)) {
    return {
      success: false,
      error: `Invalid author format: "${authorTrimmed}". Expected "Name <email@example.com>".`,
    };
  }

  try {
    const selectedSet = new Set(options.selectedFiles);

    // Stage selected files that aren't already staged.
    const filesToStage = options.allFiles
      .filter((f) => selectedSet.has(f.path) && !f.staged)
      .map((f) => f.path);
    if (filesToStage.length > 0) {
      await gitService.stage(repository, filesToStage);
    }

    // Unstage files that are staged but not selected.
    const filesToUnstage = options.allFiles
      .filter((f) => !selectedSet.has(f.path) && f.staged)
      .map((f) => f.path);
    if (filesToUnstage.length > 0) {
      await gitService.unstage(repository, filesToUnstage);
    }

    const commitOptions: ICommitOptions = {
      amend: options.amend ?? false,
      signOff: options.signOff ?? false,
      noVerify: options.noVerify ?? false,
    };
    if (authorTrimmed.length > 0) {
      commitOptions.author = authorTrimmed;
    }
    await gitService.commit(repository, options.message, commitOptions);

    return { success: true, files: options.selectedFiles };
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: msg };
  }
}

/**
 * Author-format regex used by the T2-06 author-override field.
 *
 * Requires `Name <email@domain>` where the name has no angle brackets,
 * the email has no whitespace / angle brackets and contains `@`. Loose
 * enough to accept most real-world author strings; strict enough to
 * reject accidental free-form input.
 */
export const AUTHOR_FORMAT_REGEX = /^[^<>]+ <[^<>@\s]+@[^<>\s]+>$/;

/**
 * Validate an author string against {@link AUTHOR_FORMAT_REGEX}. Empty
 * / whitespace-only strings are treated as "no override" and return true
 * so callers can skip the override silently.
 */
export function isValidAuthorFormat(value: string | undefined): boolean {
  if (!value) {
    return true;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return true;
  }
  return AUTHOR_FORMAT_REGEX.test(trimmed);
}

/**
 * Message types from webview to extension
 */
interface IWebviewMessage {
  type: string;
  message?: string;
  amend?: boolean;
  signOff?: boolean;
  files?: string[];
  path?: string;
  hunkIndex?: number;
  lineNumber?: number;
  lines?: number[];
  /** T2-06: author override payload from the `authorChange` message. */
  author?: string;
  /** T2-06: gear-menu `--no-verify` toggle payload. */
  noVerify?: boolean;
}

/**
 * Commit Dialog class.
 * Provides a webview panel for composing and submitting commits.
 *
 * - 3.1: Display commit message input area and list of staged changes
 * - 3.2: Display diff preview when file is selected
 * - 3.3: Amend option populates previous commit message
 * - 3.4: Sign-off option appends Signed-off-by line
 * - 3.5: Prevent commit with empty message
 * - 17.3: IntelliJ-style commit dialog layout
 */
export class CommitDialog {
  private _panel: vscode.WebviewPanel | undefined;
  private _disposables: vscode.Disposable[] = [];
  private _gitService: IGitService;
  private _repository: IRepository | undefined;
  private _stagedFiles: IStagedFile[] = [];
  private _currentDiff: IDiff | undefined;
  private _selectedFilePath: string | undefined;
  private _amendMode: boolean = false;
  private _signOffMode: boolean = false;
  private _commitMessage: string = '';
  private _previousCommitMessage: string = '';
  private _resolvePromise: ((result: ICommitDialogResult) => void) | undefined;
  /** Selected lines for partial staging - map of hunk index to selected line numbers */
  private _selectedLines: Map<number, Set<number>> = new Map();
  /** Whether partial staging mode is active */
  private _partialStagingMode: boolean = false;

  // T2-06 state ────────────────────────────────────────────────────────────
  /** Optional workspaceState for persisting recent-messages LRU & gear toggles. */
  private readonly _workspaceState: vscode.Memento | undefined;
  /** Custom author override ("Name <email>" or empty). */
  private _author: string = '';
  /** Last validation error for the author field, surfaced to the webview. */
  private _authorError: string | undefined;
  /** Gear toggle: skip git commit hooks on next commit. */
  private _noVerify: boolean = false;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    gitService: IGitService,
    workspaceState?: vscode.Memento
  ) {
    this._gitService = gitService;
    this._workspaceState = workspaceState;
    // Seed the gear toggle from persisted workspaceState (defaults false).
    this._noVerify = this._workspaceState?.get<boolean>(LAST_NO_VERIFY_STATE_KEY, false) ?? false;
  }

  /**
   * Show the commit dialog.
   *
   * @param repository - The repository to commit to
   * @param options - Dialog options
   * @returns Promise resolving to the dialog result
   */
  async show(
    repository: IRepository,
    options?: ICommitDialogOptions
  ): Promise<ICommitDialogResult> {
    this._repository = repository;
    this._amendMode = options?.amend ?? false;
    this._commitMessage = options?.initialMessage ?? '';

    // T2-06: seed author field from `intellig.commitAuthor` config unless
    // the caller already supplied one. Invalid configured values still
    // populate the input so the user sees and can fix them.
    if (!this._author) {
      const cfg = vscode.workspace.getConfiguration('intellig');
      const configured = cfg.get<string>(COMMIT_AUTHOR_CONFIG_KEY, '');
      if (configured && configured.trim().length > 0) {
        this._author = configured.trim();
        this._authorError = isValidAuthorFormat(this._author)
          ? undefined
          : 'Expected "Name <email@example.com>".';
      }
    }

    // Load staged files
    await this._loadStagedFiles(options?.preSelectedFiles);

    // Load previous commit message if amending
    if (this._amendMode) {
      await this._loadPreviousCommitMessage();
      if (!this._commitMessage) {
        this._commitMessage = this._previousCommitMessage;
      }
    }

    // Create or reveal the panel
    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.One);
    } else {
      this._panel = vscode.window.createWebviewPanel(
        'intellig.commitDialog',
        'Commit',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [this._extensionUri],
        }
      );

      // Handle panel disposal
      this._panel.onDidDispose(
        () => {
          this._panel = undefined;
          this._dispose();
          if (this._resolvePromise) {
            this._resolvePromise({ committed: false });
            this._resolvePromise = undefined;
          }
        },
        null,
        this._disposables
      );

      // Handle messages from webview
      this._panel.webview.onDidReceiveMessage(
        (message: IWebviewMessage) => this._handleMessage(message),
        null,
        this._disposables
      );
    }

    // Update the webview content
    this._updateWebview();

    // Return a promise that resolves when the dialog is closed
    return new Promise((resolve) => {
      this._resolvePromise = resolve;
    });
  }

  /**
   * Hide the commit dialog.
   */
  hide(): void {
    if (this._panel) {
      this._panel.dispose();
    }
  }

  /**
   * Load staged files from the repository.
   */
  private async _loadStagedFiles(preSelectedFiles?: string[]): Promise<void> {
    if (!this._repository) {
      return;
    }

    const status = await this._gitService.getStatus(this._repository);
    const preSelectedSet = new Set(preSelectedFiles ?? []);

    this._stagedFiles = status
      .filter((f) => f.indexStatus !== ' ' && f.indexStatus !== '?')
      .map((f) => ({
        path: f.path,
        status: this._getStatusLabel(f.indexStatus),
        staged: true,
        selected: preSelectedFiles ? preSelectedSet.has(f.path) : true,
      }));

    // Also include unstaged files that can be staged
    const unstagedFiles = status
      .filter((f) => (f.workTreeStatus !== ' ' && f.indexStatus === ' ') || f.indexStatus === '?')
      .map((f) => ({
        path: f.path,
        status: this._getStatusLabel(f.workTreeStatus),
        staged: false,
        selected: preSelectedFiles ? preSelectedSet.has(f.path) : false,
      }));

    this._stagedFiles = [...this._stagedFiles, ...unstagedFiles];
  }

  /**
   * Load the previous commit message for amend mode.
   */
  private async _loadPreviousCommitMessage(): Promise<void> {
    if (!this._repository) {
      return;
    }

    try {
      const commits = await this._gitService.getLog(this._repository, { maxCount: 1 });
      if (commits.length > 0) {
        const commit = commits[0];
        this._previousCommitMessage = commit.body
          ? `${commit.message}\n\n${commit.body}`
          : commit.message;
      }
    } catch {
      // Ignore errors - repository might be empty
    }
  }

  /**
   * Get a human-readable status label.
   */
  private _getStatusLabel(status: string): string {
    const labels: Record<string, string> = {
      M: 'Modified',
      A: 'Added',
      D: 'Deleted',
      R: 'Renamed',
      C: 'Copied',
      U: 'Unmerged',
      '?': 'Untracked',
      '!': 'Ignored',
    };
    return labels[status] || status;
  }

  /**
   * Handle messages from the webview.
   */
  private async _handleMessage(message: IWebviewMessage): Promise<void> {
    switch (message.type) {
      case 'commit':
        await this._handleCommit(message);
        break;
      case 'cancel':
        this.hide();
        break;
      case 'selectFile':
        if (message.path) {
          await this._handleFileSelect(message.path);
        }
        break;
      case 'toggleFile':
        if (message.path) {
          this._handleFileToggle(message.path);
        }
        break;
      case 'toggleAmend':
        await this._handleAmendToggle(message.amend ?? false);
        break;
      case 'toggleSignOff':
        this._signOffMode = message.signOff ?? false;
        break;
      case 'updateMessage':
        this._commitMessage = message.message ?? '';
        break;
      case 'stageFile':
        if (message.path) {
          await this._handleStageFile(message.path);
        }
        break;
      case 'unstageFile':
        if (message.path) {
          await this._handleUnstageFile(message.path);
        }
        break;
      case 'refresh':
        await this._loadStagedFiles();
        this._updateWebview();
        break;
      case 'stageHunk':
        if (message.hunkIndex !== undefined) {
          await this._handleStageHunk(message.hunkIndex);
        }
        break;
      case 'unstageHunk':
        if (message.hunkIndex !== undefined) {
          await this._handleUnstageHunk(message.hunkIndex);
        }
        break;
      case 'toggleLine':
        if (message.hunkIndex !== undefined && message.lineNumber !== undefined) {
          this._handleToggleLine(message.hunkIndex, message.lineNumber);
        }
        break;
      case 'stageSelectedLines':
        if (message.hunkIndex !== undefined) {
          await this._handleStageSelectedLines(message.hunkIndex);
        }
        break;
      case 'togglePartialStagingMode':
        this._partialStagingMode = !this._partialStagingMode;
        this._selectedLines.clear();
        this._updateWebview();
        break;
      case 'selectAllLinesInHunk':
        if (message.hunkIndex !== undefined) {
          this._handleSelectAllLinesInHunk(message.hunkIndex);
        }
        break;
      case 'deselectAllLinesInHunk':
        if (message.hunkIndex !== undefined) {
          this._handleDeselectAllLinesInHunk(message.hunkIndex);
        }
        break;

      // ─── T2-06 ──────────────────────────────────────────────────────────
      case 'authorChange':
        this._handleAuthorChange(message.author ?? '');
        break;
      case 'toggleNoVerify':
        await this._handleToggleNoVerify(message.noVerify ?? false);
        break;
      case 'openRecentMessages':
        await this._handleOpenRecentMessages();
        break;
      case 'openGearMenu':
        await this._handleOpenGearMenu();
        break;
    }
  }

  /**
   * T2-06: update the in-memory author field and refresh the webview so
   * validation errors surface below the input.
   */
  private _handleAuthorChange(value: string): void {
    this._author = value;
    this._authorError = isValidAuthorFormat(value)
      ? undefined
      : 'Expected "Name <email@example.com>".';
    this._updateWebview();
  }

  /**
   * T2-06: persist the `--no-verify` gear toggle across dialog sessions.
   */
  private async _handleToggleNoVerify(value: boolean): Promise<void> {
    this._noVerify = value;
    if (this._workspaceState) {
      await this._workspaceState.update(LAST_NO_VERIFY_STATE_KEY, value);
    }
  }

  /**
   * T2-06: populate a QuickPick from the recent-messages LRU and, if the
   * user selects one, pre-fill the commit-message textarea.
   *
   * The LRU is shared with {@link CommitToolWindow} via the
   * {@link RECENT_MESSAGES_STATE_KEY} workspaceState key, so picking a
   * message typed in the new tool window shows up in the classic dialog
   * and vice versa.
   */
  private async _handleOpenRecentMessages(): Promise<void> {
    if (!this._workspaceState) {
      void vscode.window.showInformationMessage('No recent commit messages yet.');
      return;
    }
    const recent = this._readRecentMessages();
    if (recent.length === 0) {
      void vscode.window.showInformationMessage('No recent commit messages yet.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      recent.map((m, i) => ({
        label: m.split('\n')[0].slice(0, 80),
        description: i === 0 ? '(most recent)' : undefined,
        detail: m.includes('\n') ? m : undefined,
        message: m,
      })),
      {
        title: 'Recent commit messages',
        placeHolder: 'Pick a message to pre-fill the editor',
        matchOnDescription: true,
        matchOnDetail: true,
      }
    );
    if (!picked) {
      return;
    }
    this._commitMessage = picked.message;
    this._updateWebview();
  }

  /**
   * T2-06: gear menu. Two entries ship in this step — one disabled stub
   * ("Run before-commit checks") and one functional toggle (`--no-verify`).
   * Additional entries (Reformat, Optimize Imports, etc.) land in the
   * T2-06 follow-up.
   */
  private async _handleOpenGearMenu(): Promise<void> {
    const items = buildGearMenuItems(this._noVerify);
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Commit options',
      placeHolder: 'Pick an option',
    });
    if (!picked) {
      return;
    }
    if (picked.id === 'noVerify') {
      await this._handleToggleNoVerify(!this._noVerify);
      this._updateWebview();
    } else if (picked.id === 'beforeCommit') {
      void vscode.window.showInformationMessage(
        'Before-commit checks are coming in a later T2-06 step.'
      );
    }
  }

  /**
   * Read the recent-messages LRU from workspaceState. Always returns an
   * array; empty when no state is wired or the key is absent.
   */
  private _readRecentMessages(): string[] {
    if (!this._workspaceState) {
      return [];
    }
    const value = this._workspaceState.get<string[]>(RECENT_MESSAGES_STATE_KEY, []);
    return Array.isArray(value) ? value : [];
  }

  /**
   * Push a successful commit onto the recent-messages LRU. No-op when
   * workspaceState isn't wired (keeps tests and legacy callers happy).
   */
  private async _pushRecentMessage(message: string): Promise<void> {
    if (!this._workspaceState) {
      return;
    }
    const updated = updateRecentMessagesLru(this._readRecentMessages(), message);
    await this._workspaceState.update(RECENT_MESSAGES_STATE_KEY, updated);
  }

  /**
   * Handle commit action.
   */
  private async _handleCommit(message: IWebviewMessage): Promise<void> {
    if (!this._repository) {
      return;
    }

    const commitMessage = message.message ?? this._commitMessage;
    const selectedFiles = this._stagedFiles.filter((f) => f.selected).map((f) => f.path);

    // T2-06: validate author format before we do any git work so the
    // dialog surfaces the error without staging/unstaging first.
    if (this._author.trim().length > 0 && !isValidAuthorFormat(this._author)) {
      this._authorError = 'Expected "Name <email@example.com>".';
      this._updateWebview();
      void vscode.window.showErrorMessage(
        'Commit failed: invalid author format. Expected "Name <email@example.com>".'
      );
      return;
    }

    // T1-04 — delegate to the shared helper so CommitDialog and
    // CommitToolWindow go through identical code paths. T2-06 adds
    // `author` + `noVerify` pass-through.
    const result = await performCommit(this._gitService, this._repository, {
      message: commitMessage,
      selectedFiles,
      allFiles: this._stagedFiles.map((f) => ({ path: f.path, staged: f.staged })),
      amend: this._amendMode,
      signOff: this._signOffMode,
      author: this._author,
      noVerify: this._noVerify,
    });

    if (!result.success) {
      void vscode.window.showErrorMessage(
        result.error ? `Commit failed: ${sanitizeGitError(result.error)}` : 'Commit failed'
      );
      return;
    }

    // T2-06: push the committed message onto the recent-messages LRU.
    await this._pushRecentMessage(commitMessage);

    void vscode.window.showInformationMessage(
      `Committed ${(result.files ?? selectedFiles).length} file(s)`
    );

    if (this._resolvePromise) {
      this._resolvePromise({
        committed: true,
        message: commitMessage,
        files: result.files ?? selectedFiles,
      });
      this._resolvePromise = undefined;
    }

    this.hide();
  }

  /**
   * Handle file selection for diff preview.
   */
  private async _handleFileSelect(path: string): Promise<void> {
    if (!this._repository) {
      return;
    }

    this._selectedFilePath = path;

    try {
      // Get the diff for the selected file
      const file = this._stagedFiles.find((f) => f.path === path);
      const staged = file?.staged ?? false;
      this._currentDiff = await this._gitService.getDiff(this._repository, path, staged);
      this._updateWebview();
    } catch (error) {
      console.error('Failed to get diff:', error);
      this._currentDiff = undefined;
      this._updateWebview();
    }
  }

  /**
   * Handle file toggle (select/deselect for commit).
   */
  private _handleFileToggle(path: string): void {
    const file = this._stagedFiles.find((f) => f.path === path);
    if (file) {
      file.selected = !file.selected;
      this._updateWebview();
    }
  }

  /**
   * Handle amend toggle.
   */
  private async _handleAmendToggle(amend: boolean): Promise<void> {
    this._amendMode = amend;

    if (amend && !this._previousCommitMessage) {
      await this._loadPreviousCommitMessage();
    }

    // If enabling amend and message is empty, populate with previous message
    if (amend && !this._commitMessage.trim()) {
      this._commitMessage = this._previousCommitMessage;
    }

    this._updateWebview();
  }

  /**
   * Handle staging a file.
   */
  private async _handleStageFile(path: string): Promise<void> {
    if (!this._repository) {
      return;
    }

    try {
      await this._gitService.stage(this._repository, [path]);
      await this._loadStagedFiles();
      this._updateWebview();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to stage file: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * Handle unstaging a file.
   */
  private async _handleUnstageFile(path: string): Promise<void> {
    if (!this._repository) {
      return;
    }

    try {
      await this._gitService.unstage(this._repository, [path]);
      await this._loadStagedFiles();
      this._updateWebview();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to unstage file: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * Handle staging a single hunk.
   */
  private async _handleStageHunk(hunkIndex: number): Promise<void> {
    if (!this._repository || !this._selectedFilePath || !this._currentDiff) {
      return;
    }

    const hunk = this._currentDiff.hunks[hunkIndex];
    if (!hunk) {
      return;
    }

    try {
      await this._gitService.stageHunk(this._repository, this._selectedFilePath, hunk);
      // Refresh the diff to show updated state
      await this._handleFileSelect(this._selectedFilePath);
      await this._loadStagedFiles();
      void vscode.window.showInformationMessage('Hunk staged successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to stage hunk: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * Handle unstaging a single hunk.
   */
  private async _handleUnstageHunk(hunkIndex: number): Promise<void> {
    if (!this._repository || !this._selectedFilePath || !this._currentDiff) {
      return;
    }

    const hunk = this._currentDiff.hunks[hunkIndex];
    if (!hunk) {
      return;
    }

    try {
      await this._gitService.unstageHunk(this._repository, this._selectedFilePath, hunk);
      // Refresh the diff to show updated state
      await this._handleFileSelect(this._selectedFilePath);
      await this._loadStagedFiles();
      void vscode.window.showInformationMessage('Hunk unstaged successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to unstage hunk: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * Handle toggling a line selection for partial staging.
   */
  private _handleToggleLine(hunkIndex: number, lineNumber: number): void {
    if (!this._selectedLines.has(hunkIndex)) {
      this._selectedLines.set(hunkIndex, new Set());
    }

    const hunkLines = this._selectedLines.get(hunkIndex)!;
    if (hunkLines.has(lineNumber)) {
      hunkLines.delete(lineNumber);
    } else {
      hunkLines.add(lineNumber);
    }

    this._updateWebview();
  }

  /**
   * Handle selecting all lines in a hunk.
   */
  private _handleSelectAllLinesInHunk(hunkIndex: number): void {
    if (!this._currentDiff) {
      return;
    }

    const hunk = this._currentDiff.hunks[hunkIndex];
    if (!hunk) {
      return;
    }

    const lineNumbers = new Set<number>();
    for (const line of hunk.lines) {
      if (line.type === 'add' && line.newLineNumber !== undefined) {
        lineNumbers.add(line.newLineNumber);
      } else if (line.type === 'delete' && line.oldLineNumber !== undefined) {
        lineNumbers.add(line.oldLineNumber);
      }
    }

    this._selectedLines.set(hunkIndex, lineNumbers);
    this._updateWebview();
  }

  /**
   * Handle deselecting all lines in a hunk.
   */
  private _handleDeselectAllLinesInHunk(hunkIndex: number): void {
    this._selectedLines.delete(hunkIndex);
    this._updateWebview();
  }

  /**
   * Handle staging selected lines within a hunk.
   */
  private async _handleStageSelectedLines(hunkIndex: number): Promise<void> {
    if (!this._repository || !this._selectedFilePath || !this._currentDiff) {
      return;
    }

    const hunk = this._currentDiff.hunks[hunkIndex];
    if (!hunk) {
      return;
    }

    const selectedLineNumbers = this._selectedLines.get(hunkIndex);
    if (!selectedLineNumbers || selectedLineNumbers.size === 0) {
      void vscode.window.showWarningMessage('No lines selected for staging');
      return;
    }

    try {
      await this._gitService.stageLines(
        this._repository,
        this._selectedFilePath,
        Array.from(selectedLineNumbers),
        hunk
      );
      // Clear selection and refresh
      this._selectedLines.delete(hunkIndex);
      await this._handleFileSelect(this._selectedFilePath);
      await this._loadStagedFiles();
      void vscode.window.showInformationMessage('Selected lines staged successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to stage lines: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * Update the webview content.
   */
  private _updateWebview(): void {
    if (!this._panel) {
      return;
    }

    this._panel.webview.html = this._getHtmlContent(this._panel.webview);
  }

  /**
   * Get the HTML content for the webview.
   */
  private _getHtmlContent(webview: vscode.Webview): string {
    const nonce = this._getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Commit</title>
  <style>
    ${this._getStyles()}
  </style>
</head>
<body>
  <div class="commit-dialog">
    <div class="commit-main">
      <div class="commit-left">
        ${this._getMessageSection()}
        ${this._getFilesSection()}
      </div>
      <div class="commit-right">
        ${this._getDiffPreviewSection()}
      </div>
    </div>
    <div class="commit-footer">
      ${this._getOptionsSection()}
      ${this._getButtonsSection()}
    </div>
  </div>
  <script nonce="${nonce}">
    ${this._getScript()}
  </script>
</body>
</html>`;
  }

  /**
   * Get the commit message section HTML.
   */
  private _getMessageSection(): string {
    const escapedMessage = this._escapeHtml(this._commitMessage);
    const hasRecent = this._readRecentMessages().length > 0;
    const recentBtnTitle = hasRecent
      ? 'Pick a recent commit message'
      : 'No recent commit messages yet';
    return `
      <div class="section message-section">
        <div class="section-header">
          <span class="section-title">Commit Message</span>
          <div class="section-header-actions">
            <button
              id="recent-messages-btn"
              class="header-action-button"
              type="button"
              title="${this._escapeHtml(recentBtnTitle)}"
              ${hasRecent ? '' : 'disabled'}
              onclick="openRecentMessages()"
            >∨</button>
            <button
              id="gear-btn"
              class="header-action-button"
              type="button"
              title="Commit options"
              onclick="openGearMenu()"
            >⚙</button>
          </div>
        </div>
        <textarea
          id="commit-message"
          class="commit-message-input"
          placeholder="Enter commit message..."
          oninput="handleMessageChange(this.value)"
        >${escapedMessage}</textarea>
        ${this._getAuthorSection()}
        ${this._getNoVerifyBadge()}
      </div>
    `;
  }

  /**
   * T2-06: author-override input below the commit-message textarea.
   */
  private _getAuthorSection(): string {
    const escapedAuthor = this._escapeHtml(this._author);
    const errorHtml = this._authorError
      ? `<div class="author-error" role="alert">${this._escapeHtml(this._authorError)}</div>`
      : '';
    return `
      <div class="author-section">
        <label for="commit-author" class="author-label">
          Author (optional):
        </label>
        <input
          id="commit-author"
          class="author-input"
          type="text"
          placeholder="Name &lt;email@example.com&gt;"
          value="${escapedAuthor}"
          oninput="handleAuthorChange(this.value)"
        />
        ${errorHtml}
      </div>
    `;
  }

  /**
   * T2-06: small chip advertising the `--no-verify` state so the user is
   * never surprised by a skipped-hook commit.
   */
  private _getNoVerifyBadge(): string {
    if (!this._noVerify) {
      return '';
    }
    return `
      <div class="no-verify-badge" role="note">
        ⚠ Git hooks will be skipped (<code>--no-verify</code>). Open the gear menu to turn this off.
      </div>
    `;
  }

  /**
   * Get the files section HTML.
   */
  private _getFilesSection(): string {
    const stagedFiles = this._stagedFiles.filter((f) => f.staged);
    const unstagedFiles = this._stagedFiles.filter((f) => !f.staged);

    let stagedHtml = '';
    if (stagedFiles.length > 0) {
      stagedHtml = `
        <div class="file-group">
          <div class="file-group-header">Staged Changes (${stagedFiles.length})</div>
          ${stagedFiles.map((f) => this._getFileItemHtml(f)).join('')}
        </div>
      `;
    }

    let unstagedHtml = '';
    if (unstagedFiles.length > 0) {
      unstagedHtml = `
        <div class="file-group">
          <div class="file-group-header">Unstaged Changes (${unstagedFiles.length})</div>
          ${unstagedFiles.map((f) => this._getFileItemHtml(f)).join('')}
        </div>
      `;
    }

    const emptyMessage =
      stagedFiles.length === 0 && unstagedFiles.length === 0
        ? '<div class="empty-message">No changes to commit</div>'
        : '';

    return `
      <div class="section files-section">
        <div class="section-header">
          <span class="section-title">Changes</span>
          <button class="refresh-button" onclick="refresh()" title="Refresh">↻</button>
        </div>
        <div class="files-list">
          ${stagedHtml}
          ${unstagedHtml}
          ${emptyMessage}
        </div>
      </div>
    `;
  }

  /**
   * Get HTML for a single file item.
   */
  private _getFileItemHtml(file: IStagedFile): string {
    const isSelected = this._selectedFilePath === file.path;
    const statusColor = this._getStatusColor(file.status);

    // Wave I H-2 — inline `onclick="X('${path}')"` is replaced by
    // `data-action="X" data-path="${path}"`. The delegated dispatcher
    // at the bottom of the inline <script> picks it up via
    // `addEventListener('click', ...)`, matching the pattern at
    // GitToolWindowProvider.ts:4523. Pre-Wave-I, escaping a path
    // containing a `'` would still inject JavaScript through the inline
    // attribute (`<button onclick="stageFile('foo\'-evil')">` →
    // CSP-bypassing arbitrary script).
    const escapedPath = this._escapeHtml(file.path);
    return `
      <div class="file-item ${isSelected ? 'selected' : ''}"
           data-path="${escapedPath}"
           data-action="selectFile">
        <input
          type="checkbox"
          class="file-checkbox"
          ${file.selected ? 'checked' : ''}
          data-action="toggleFile"
          data-path="${escapedPath}"
        />
        <span class="file-status" style="color: ${statusColor};">${file.status.charAt(0)}</span>
        <span class="file-path">${this._escapeHtml(this._getFileName(file.path))}</span>
        <span class="file-dir">${this._escapeHtml(this._getFileDir(file.path))}</span>
        ${
          file.staged
            ? `<button class="stage-button unstage" data-action="unstageFile" data-path="${escapedPath}" title="Unstage">−</button>`
            : `<button class="stage-button stage" data-action="stageFile" data-path="${escapedPath}" title="Stage">+</button>`
        }
      </div>
    `;
  }

  /**
   * Get the diff preview section HTML.
   */
  private _getDiffPreviewSection(): string {
    if (!this._currentDiff || !this._selectedFilePath) {
      return `
        <div class="section diff-section">
          <div class="section-header">
            <span class="section-title">Diff Preview</span>
          </div>
          <div class="diff-content empty">
            <div class="empty-message">Select a file to preview changes</div>
          </div>
        </div>
      `;
    }

    const file = this._stagedFiles.find((f) => f.path === this._selectedFilePath);
    const isStaged = file?.staged ?? false;
    const diffHtml = this._renderDiffWithControls(this._currentDiff, isStaged);

    return `
      <div class="section diff-section">
        <div class="section-header">
          <span class="section-title">Diff: ${this._escapeHtml(this._getFileName(this._selectedFilePath))}</span>
          <div class="diff-header-controls">
            <button class="partial-staging-toggle ${this._partialStagingMode ? 'active' : ''}" 
                    onclick="togglePartialStagingMode()" 
                    title="${this._partialStagingMode ? 'Exit line selection mode' : 'Enable line selection for partial staging'}">
              ${this._partialStagingMode ? '✓ Line Selection' : '☐ Line Selection'}
            </button>
          </div>
        </div>
        <div class="diff-content">
          ${diffHtml}
        </div>
      </div>
    `;
  }

  /**
   * Render a diff with staging controls as HTML.
   */
  private _renderDiffWithControls(diff: IDiff, isStaged: boolean): string {
    if (diff.binary) {
      return '<div class="binary-file">Binary file</div>';
    }

    if (diff.hunks.length === 0) {
      return '<div class="empty-message">No changes</div>';
    }

    return diff.hunks
      .map((hunk, index) => this._renderHunkWithControls(hunk, index, isStaged))
      .join('');
  }

  /**
   * Render a hunk with staging controls as HTML.
   */
  private _renderHunkWithControls(hunk: IHunk, hunkIndex: number, isStaged: boolean): string {
    const selectedLines = this._selectedLines.get(hunkIndex) || new Set<number>();
    const hasSelectedLines = selectedLines.size > 0;

    const linesHtml = hunk.lines
      .map((line) => {
        let lineClass = 'diff-line';
        let prefix = ' ';
        let isSelectable = false;
        let lineNumber: number | undefined;

        switch (line.type) {
          case 'add':
            lineClass += ' diff-add';
            prefix = '+';
            isSelectable = this._partialStagingMode;
            lineNumber = line.newLineNumber;
            break;
          case 'delete':
            lineClass += ' diff-delete';
            prefix = '-';
            isSelectable = this._partialStagingMode;
            lineNumber = line.oldLineNumber;
            break;
          case 'context':
            lineClass += ' diff-context';
            prefix = ' ';
            break;
        }

        const isSelected = lineNumber !== undefined && selectedLines.has(lineNumber);
        if (isSelected) {
          lineClass += ' line-selected';
        }

        const oldNum = line.oldLineNumber?.toString() ?? '';
        const newNum = line.newLineNumber?.toString() ?? '';

        // Wave J / WJ-5 — toggleLine inline-onclick → data-action
        // delegation. Pre-J this used `onclick="toggleLine(${hunkIndex},
        // ${lineNumber})"` interpolated into the row HTML. Although
        // both args are caller-controlled numbers (no user input
        // through the JS string here, unlike the file/path onclicks
        // Wave I cleaned), consistency wins — the dispatcher pattern
        // is uniform once toggleLine joins it. The dispatcher at
        // `_getInlineScript()` reads `data-hunk-index` and
        // `data-line-number` and routes to the global toggleLine().
        // Pinned by commitDialog-toggleLine-1 + -2.
        const selectableAttr =
          isSelectable && lineNumber !== undefined
            ? `data-action="toggleLine" data-hunk-index="${hunkIndex}" data-line-number="${lineNumber}"`
            : '';
        const selectableClass = isSelectable ? ' selectable' : '';

        const checkbox =
          this._partialStagingMode && isSelectable && lineNumber !== undefined
            ? `<span class="line-checkbox">${isSelected ? '☑' : '☐'}</span>`
            : '';

        return `
          <div class="${lineClass}${selectableClass}" ${selectableAttr}>
            ${checkbox}
            <span class="line-num old">${oldNum}</span>
            <span class="line-num new">${newNum}</span>
            <span class="line-prefix">${prefix}</span>
            <span class="line-content">${this._escapeHtml(line.content)}</span>
          </div>
        `;
      })
      .join('');

    // Hunk controls - stage/unstage buttons.
    // Wave I H-2 — inline-onclick → data-action delegation. `hunkIndex`
    // is a number (caller-controlled), but the data-action pattern
    // brings the same uniform CSP-safe shape as the path-based handlers
    // above. Matches GitToolWindowProvider:4523.
    const stageButton = isStaged
      ? `<button class="hunk-button unstage-hunk" data-action="unstageHunk" data-hunk-index="${hunkIndex}" title="Unstage this hunk">− Unstage Hunk</button>`
      : `<button class="hunk-button stage-hunk" data-action="stageHunk" data-hunk-index="${hunkIndex}" title="Stage this hunk">+ Stage Hunk</button>`;

    // Line selection controls (only shown in partial staging mode)
    const lineSelectionControls = this._partialStagingMode
      ? `
        <div class="line-selection-controls">
          <button class="hunk-button select-all" data-action="selectAllLinesInHunk" data-hunk-index="${hunkIndex}" title="Select all changed lines">Select All</button>
          <button class="hunk-button deselect-all" data-action="deselectAllLinesInHunk" data-hunk-index="${hunkIndex}" title="Deselect all lines">Deselect All</button>
          ${
            hasSelectedLines && !isStaged
              ? `<button class="hunk-button stage-selected" data-action="stageSelectedLines" data-hunk-index="${hunkIndex}" title="Stage selected lines">+ Stage ${selectedLines.size} Line${selectedLines.size !== 1 ? 's' : ''}</button>`
              : ''
          }
        </div>
      `
      : '';

    return `
      <div class="diff-hunk">
        <div class="hunk-header-row">
          <div class="hunk-header">${this._escapeHtml(hunk.header)}</div>
          <div class="hunk-controls">
            ${stageButton}
          </div>
        </div>
        ${lineSelectionControls}
        ${linesHtml}
      </div>
    `;
  }

  /**
   * Get the options section HTML.
   */
  private _getOptionsSection(): string {
    return `
      <div class="options-section">
        <label class="option-label">
          <input 
            type="checkbox" 
            id="amend-checkbox" 
            ${this._amendMode ? 'checked' : ''} 
            onchange="toggleAmend(this.checked)"
          />
          <span>Amend</span>
        </label>
        <label class="option-label">
          <input 
            type="checkbox" 
            id="signoff-checkbox" 
            ${this._signOffMode ? 'checked' : ''} 
            onchange="toggleSignOff(this.checked)"
          />
          <span>Sign-off</span>
        </label>
      </div>
    `;
  }

  /**
   * Get the buttons section HTML.
   */
  private _getButtonsSection(): string {
    const selectedCount = this._stagedFiles.filter((f) => f.selected).length;
    const commitDisabled = selectedCount === 0 ? 'disabled' : '';

    return `
      <div class="buttons-section">
        <button class="button cancel-button" onclick="cancel()">Cancel</button>
        <button class="button commit-button" onclick="commit()" ${commitDisabled}>
          Commit${this._amendMode ? ' (Amend)' : ''} (${selectedCount} file${selectedCount !== 1 ? 's' : ''})
        </button>
      </div>
    `;
  }

  /**
   * Get the CSS styles for the webview.
   */
  private _getStyles(): string {
    return `
      :root {
        --vscode-font-family: var(--vscode-editor-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
        --vscode-font-size: var(--vscode-editor-font-size, 13px);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        padding: 0;
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        background-color: var(--vscode-editor-background);
      }

      .commit-dialog {
        display: flex;
        flex-direction: column;
        height: 100vh;
        padding: 12px;
      }

      .commit-main {
        display: flex;
        flex: 1;
        gap: 12px;
        min-height: 0;
      }

      .commit-left {
        display: flex;
        flex-direction: column;
        width: 40%;
        min-width: 300px;
        gap: 12px;
      }

      .commit-right {
        flex: 1;
        min-width: 0;
      }

      .section {
        display: flex;
        flex-direction: column;
        background-color: var(--vscode-sideBar-background);
        border: 1px solid var(--vscode-panel-border);
        border-radius: 4px;
        overflow: hidden;
      }

      .section-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        background-color: var(--vscode-sideBarSectionHeader-background);
        border-bottom: 1px solid var(--vscode-panel-border);
      }

      .section-title {
        font-weight: 600;
        font-size: 12px;
        text-transform: uppercase;
        color: var(--vscode-sideBarSectionHeader-foreground);
      }

      .message-section {
        flex-shrink: 0;
      }

      .commit-message-input {
        width: 100%;
        min-height: 100px;
        padding: 8px;
        border: none;
        background-color: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        resize: vertical;
      }

      .commit-message-input:focus {
        outline: 1px solid var(--vscode-focusBorder);
      }

      .commit-message-input::placeholder {
        color: var(--vscode-input-placeholderForeground);
      }

      /* T2-06 ─────────────────────────────────────────────────────────── */
      .section-header-actions {
        display: inline-flex;
        gap: 4px;
      }
      .header-action-button {
        min-width: 22px;
        height: 22px;
        padding: 0 6px;
        border: 1px solid transparent;
        background: transparent;
        color: var(--vscode-foreground);
        cursor: pointer;
        font-size: 14px;
        line-height: 1;
      }
      .header-action-button:hover:not(:disabled) {
        background: var(--vscode-toolbar-hoverBackground);
        border-color: var(--vscode-focusBorder);
      }
      .header-action-button:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .author-section {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 8px;
        border-top: 1px solid var(--vscode-panel-border);
      }
      .author-label {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
      }
      .author-input {
        width: 100%;
        padding: 4px 6px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent);
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
      }
      .author-input:focus {
        outline: 1px solid var(--vscode-focusBorder);
      }
      .author-error {
        color: var(--vscode-errorForeground);
        font-size: 11px;
      }
      .no-verify-badge {
        padding: 6px 8px;
        font-size: 11px;
        color: var(--vscode-editorWarning-foreground);
        background: var(--vscode-inputValidation-warningBackground, transparent);
        border-top: 1px solid var(--vscode-panel-border);
      }
      /* ─── end T2-06 ───────────────────────────────────────────────────── */

      .files-section {
        flex: 1;
        min-height: 150px;
      }

      .files-list {
        flex: 1;
        overflow-y: auto;
        padding: 4px;
      }

      .file-group {
        margin-bottom: 8px;
      }

      .file-group-header {
        padding: 4px 8px;
        font-size: 11px;
        font-weight: 600;
        color: var(--vscode-descriptionForeground);
        text-transform: uppercase;
      }

      .file-item {
        display: flex;
        align-items: center;
        padding: 4px 8px;
        cursor: pointer;
        border-radius: 3px;
        gap: 8px;
      }

      .file-item:hover {
        background-color: var(--vscode-list-hoverBackground);
      }

      .file-item.selected {
        background-color: var(--vscode-list-activeSelectionBackground);
        color: var(--vscode-list-activeSelectionForeground);
      }

      .file-checkbox {
        flex-shrink: 0;
      }

      .file-status {
        width: 16px;
        font-weight: bold;
        font-size: 11px;
        flex-shrink: 0;
      }

      .file-path {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .file-dir {
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 100px;
      }

      .stage-button {
        padding: 2px 6px;
        border: none;
        border-radius: 3px;
        cursor: pointer;
        font-size: 12px;
        font-weight: bold;
        opacity: 0;
        transition: opacity 0.2s;
      }

      .file-item:hover .stage-button {
        opacity: 1;
      }

      .stage-button.stage {
        background-color: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
      }

      .stage-button.unstage {
        background-color: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
      }

      .refresh-button {
        padding: 2px 6px;
        border: none;
        background: transparent;
        color: var(--vscode-foreground);
        cursor: pointer;
        font-size: 14px;
      }

      .refresh-button:hover {
        background-color: var(--vscode-toolbar-hoverBackground);
        border-radius: 3px;
      }

      .diff-section {
        height: 100%;
      }

      .diff-content {
        flex: 1;
        overflow: auto;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 12px;
      }

      .diff-content.empty {
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .empty-message {
        color: var(--vscode-descriptionForeground);
        text-align: center;
        padding: 20px;
      }

      .diff-hunk {
        margin-bottom: 8px;
      }

      .hunk-header-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        background-color: var(--vscode-diffEditor-insertedTextBackground);
      }

      .hunk-header {
        padding: 4px 8px;
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        flex: 1;
      }

      .hunk-controls {
        display: flex;
        gap: 4px;
        padding: 4px 8px;
      }

      .hunk-button {
        padding: 2px 8px;
        border: none;
        border-radius: 3px;
        cursor: pointer;
        font-size: 11px;
        font-weight: 500;
      }

      .hunk-button.stage-hunk {
        background-color: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
      }

      .hunk-button.stage-hunk:hover {
        background-color: var(--vscode-button-hoverBackground);
      }

      .hunk-button.unstage-hunk {
        background-color: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
      }

      .hunk-button.unstage-hunk:hover {
        background-color: var(--vscode-button-secondaryHoverBackground);
      }

      .hunk-button.stage-selected {
        background-color: #4CAF50;
        color: white;
      }

      .hunk-button.stage-selected:hover {
        background-color: #45a049;
      }

      .hunk-button.select-all,
      .hunk-button.deselect-all {
        background-color: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
      }

      .line-selection-controls {
        display: flex;
        gap: 4px;
        padding: 4px 8px;
        background-color: var(--vscode-editor-inactiveSelectionBackground);
        border-bottom: 1px solid var(--vscode-panel-border);
      }

      .diff-header-controls {
        display: flex;
        gap: 8px;
      }

      .partial-staging-toggle {
        padding: 2px 8px;
        border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
        border-radius: 3px;
        cursor: pointer;
        font-size: 11px;
        background-color: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
      }

      .partial-staging-toggle:hover {
        background-color: var(--vscode-button-secondaryHoverBackground);
      }

      .partial-staging-toggle.active {
        background-color: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border-color: var(--vscode-button-background);
      }

      .diff-line {
        display: flex;
        white-space: pre;
        line-height: 1.4;
      }

      .diff-line.selectable {
        cursor: pointer;
      }

      .diff-line.selectable:hover {
        background-color: var(--vscode-list-hoverBackground);
      }

      .diff-line.line-selected {
        background-color: var(--vscode-editor-selectionBackground) !important;
      }

      .line-checkbox {
        width: 20px;
        text-align: center;
        flex-shrink: 0;
        user-select: none;
      }

      .diff-add {
        background-color: var(--vscode-diffEditor-insertedLineBackground, rgba(155, 185, 85, 0.2));
      }

      .diff-delete {
        background-color: var(--vscode-diffEditor-removedLineBackground, rgba(255, 0, 0, 0.2));
      }

      .line-num {
        width: 40px;
        padding: 0 4px;
        text-align: right;
        color: var(--vscode-editorLineNumber-foreground);
        user-select: none;
        flex-shrink: 0;
      }

      .line-prefix {
        width: 16px;
        text-align: center;
        flex-shrink: 0;
      }

      .line-content {
        flex: 1;
        padding-right: 8px;
      }

      .binary-file {
        padding: 20px;
        text-align: center;
        color: var(--vscode-descriptionForeground);
      }

      .commit-footer {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding-top: 12px;
        border-top: 1px solid var(--vscode-panel-border);
        margin-top: 12px;
      }

      .options-section {
        display: flex;
        gap: 16px;
      }

      .option-label {
        display: flex;
        align-items: center;
        gap: 4px;
        cursor: pointer;
        font-size: 12px;
      }

      .buttons-section {
        display: flex;
        gap: 8px;
      }

      .button {
        padding: 6px 14px;
        border: none;
        border-radius: 2px;
        cursor: pointer;
        font-size: 13px;
      }

      .button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .cancel-button {
        background-color: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
      }

      .cancel-button:hover:not(:disabled) {
        background-color: var(--vscode-button-secondaryHoverBackground);
      }

      .commit-button {
        background-color: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
      }

      .commit-button:hover:not(:disabled) {
        background-color: var(--vscode-button-hoverBackground);
      }
    `;
  }

  /**
   * Get the JavaScript for the webview.
   */
  private _getScript(): string {
    return `
      const vscode = acquireVsCodeApi();

      function handleMessageChange(value) {
        vscode.postMessage({ type: 'updateMessage', message: value });
      }

      function selectFile(path) {
        vscode.postMessage({ type: 'selectFile', path: path });
      }

      function toggleFile(path) {
        vscode.postMessage({ type: 'toggleFile', path: path });
      }

      function toggleAmend(checked) {
        vscode.postMessage({ type: 'toggleAmend', amend: checked });
      }

      function toggleSignOff(checked) {
        vscode.postMessage({ type: 'toggleSignOff', signOff: checked });
      }

      function stageFile(path) {
        vscode.postMessage({ type: 'stageFile', path: path });
      }

      function unstageFile(path) {
        vscode.postMessage({ type: 'unstageFile', path: path });
      }

      function refresh() {
        vscode.postMessage({ type: 'refresh' });
      }

      function stageHunk(hunkIndex) {
        vscode.postMessage({ type: 'stageHunk', hunkIndex: hunkIndex });
      }

      function unstageHunk(hunkIndex) {
        vscode.postMessage({ type: 'unstageHunk', hunkIndex: hunkIndex });
      }

      function toggleLine(hunkIndex, lineNumber) {
        vscode.postMessage({ type: 'toggleLine', hunkIndex: hunkIndex, lineNumber: lineNumber });
      }

      function stageSelectedLines(hunkIndex) {
        vscode.postMessage({ type: 'stageSelectedLines', hunkIndex: hunkIndex });
      }

      function togglePartialStagingMode() {
        vscode.postMessage({ type: 'togglePartialStagingMode' });
      }

      function selectAllLinesInHunk(hunkIndex) {
        vscode.postMessage({ type: 'selectAllLinesInHunk', hunkIndex: hunkIndex });
      }

      function deselectAllLinesInHunk(hunkIndex) {
        vscode.postMessage({ type: 'deselectAllLinesInHunk', hunkIndex: hunkIndex });
      }

      // ─── T2-06 ─────────────────────────────────────────────────────────
      function handleAuthorChange(value) {
        vscode.postMessage({ type: 'authorChange', author: value });
      }

      function openRecentMessages() {
        vscode.postMessage({ type: 'openRecentMessages' });
      }

      function openGearMenu() {
        vscode.postMessage({ type: 'openGearMenu' });
      }

      function commit() {
        const messageEl = document.getElementById('commit-message');
        const message = messageEl ? messageEl.value : '';
        vscode.postMessage({ type: 'commit', message: message });
      }

      function cancel() {
        vscode.postMessage({ type: 'cancel' });
      }

      // Wave I H-2 — Delegated event dispatcher.
      // Replaces inline onclick attributes with data-action + data-path
      // (and data-hunk-index for the hunk buttons). The dispatcher reads
      // those attributes from the closest matching ancestor and routes to
      // the corresponding handler. Mirrors GitToolWindowProvider line 4523.
      //
      // Why: an inline-onclick attribute interpolated the user-controlled
      // path verbatim into a JS string. A path containing a single quote
      // would have broken out of that string (HTML attribute decoding
      // turns &apos; back into a single quote inside the JS parser), so a
      // hostile filename could inject script. Data attributes go through
      // the DOM property channel, never the JS parser, so a path with any
      // character is safe.
      document.addEventListener('click', (e) => {
        const target = e.target.closest('[data-action]');
        if (!target) return;
        const action = target.dataset.action;
        const path = target.dataset.path;
        const hunkIndex = target.dataset.hunkIndex;
        const handlers = {
          selectFile: () => selectFile(path),
          toggleFile: () => { e.stopPropagation(); toggleFile(path); },
          stageFile: () => { e.stopPropagation(); stageFile(path); },
          unstageFile: () => { e.stopPropagation(); unstageFile(path); },
          stageHunk: () => stageHunk(Number(hunkIndex)),
          unstageHunk: () => unstageHunk(Number(hunkIndex)),
          stageSelectedLines: () => stageSelectedLines(Number(hunkIndex)),
          selectAllLinesInHunk: () => selectAllLinesInHunk(Number(hunkIndex)),
          deselectAllLinesInHunk: () => deselectAllLinesInHunk(Number(hunkIndex)),
          // Wave J / WJ-5 — toggleLine joins the dispatcher. The
          // existing global toggleLine(hunkIndex, lineNumber) function
          // is unchanged; we just route through it via Number()
          // coercion of the dataset strings. Pinned by
          // commitDialog-toggleLine-1.
          toggleLine: () => toggleLine(Number(hunkIndex), Number(target.dataset.lineNumber)),
        };
        const handler = handlers[action];
        if (handler) {
          handler();
        }
      });

      // Handle keyboard shortcuts
      document.addEventListener('keydown', (e) => {
        // Ctrl/Cmd + Enter to commit
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
        // Escape to cancel
        if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
        }
      });
    `;
  }

  /**
   * Get status color for file status.
   *
   * Wave J / WJ-2 — return CSS `var()` expressions instead of bare hex
   * so themes can override file-status colors. Each entry falls back
   * to the pre-Wave-J hex literal when the theme variable is undefined.
   *
   * VS Code's `gitDecoration-*` family covers all 7 file-status states
   * and has been part of the theme contract since 1.46. Our
   * engines.vscode floor is `^1.85.0`, so the variables are guaranteed
   * available; the hex fallback exists for two reasons:
   *   - belt-and-braces against a theme that explicitly clears the
   *     variable (rare but legal),
   *   - dev-mode jsdom test surfaces where no VS Code theme is loaded.
   *
   * Pinned by `chipTheme-1..3` in `CommitDialog.test.ts`.
   */
  private _getStatusColor(status: string): string {
    const colors: Record<string, string> = {
      Modified: 'var(--vscode-gitDecoration-modifiedResourceForeground, #6897BB)',
      Added: 'var(--vscode-gitDecoration-addedResourceForeground, #629755)',
      Deleted: 'var(--vscode-gitDecoration-deletedResourceForeground, #6C6C6C)',
      Renamed: 'var(--vscode-gitDecoration-renamedResourceForeground, #6897BB)',
      Copied: 'var(--vscode-gitDecoration-addedResourceForeground, #629755)',
      Untracked: 'var(--vscode-gitDecoration-untrackedResourceForeground, #CC7832)',
      Unmerged: 'var(--vscode-gitDecoration-conflictingResourceForeground, #FF0000)',
    };
    return colors[status] || 'var(--vscode-foreground, #FFFFFF)';
  }

  /**
   * Get file name from path.
   */
  private _getFileName(path: string): string {
    const parts = path.split('/');
    return parts[parts.length - 1];
  }

  /**
   * Get directory part of path.
   */
  private _getFileDir(path: string): string {
    const parts = path.split('/');
    if (parts.length <= 1) {
      return '';
    }
    parts.pop();
    return parts.join('/');
  }

  /**
   * Escape HTML special characters.
   */
  private _escapeHtml(text: string): string {
    const escapeMap: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return text.replace(/[&<>"']/g, (char) => escapeMap[char]);
  }

  /**
   * Generate a nonce for CSP. Delegates to the shared CSPRNG-backed helper
   * (`generateNonce`, base64url, 128-bit entropy) so every IntelliG webview
   * uses the same nonce strategy. Replaces a former inline
   * `Math.random()`-based generator so nonces are cryptographically
   * random instead of predictable.
   */
  private _getNonce(): string {
    return generateNonce();
  }

  /**
   * Dispose of resources.
   */
  private _dispose(): void {
    for (const disposable of this._disposables) {
      disposable.dispose();
    }
    this._disposables = [];
  }

  /**
   * Public dispose method.
   */
  dispose(): void {
    this.hide();
    this._dispose();
  }
}

/**
 * Create a new CommitDialog instance.
 *
 * @param extensionUri - The extension URI
 * @param gitService - The Git service
 * @returns A new CommitDialog instance
 */
export function createCommitDialog(
  extensionUri: vscode.Uri,
  gitService: IGitService,
  workspaceState?: vscode.Memento
): CommitDialog {
  return new CommitDialog(extensionUri, gitService, workspaceState);
}

/**
 * Gear-menu entry shape used by the QuickPick in
 * {@link CommitDialog._handleOpenGearMenu}.
 */
export interface IGearMenuItem extends vscode.QuickPickItem {
  id: 'beforeCommit' | 'noVerify';
}

/**
 * Build the two gear-menu entries that ship in this T2-06 step.
 *
 * Entry 1: disabled stub `Run before-commit checks` (marked via
 *   `description: 'Coming soon'` — VS Code has no real "disabled" flag
 *   on QuickPick items, so we signal it in the description and the
 *   handler falls through to an informational toast). Follow-up T2-06
 *   steps will wire Reformat / Optimize Imports / TODO / inspections.
 *
 * Entry 2: functional `--no-verify` toggle. The `$(check)` glyph shows
 *   the current state so the user can see whether hooks will be skipped.
 */
export function buildGearMenuItems(noVerify: boolean): IGearMenuItem[] {
  return [
    {
      id: 'beforeCommit',
      label: 'Run before-commit checks',
      description: 'Coming soon',
      detail:
        'T2-06 follow-up will wire Reformat / Optimize Imports / TODO / inspections. Click for details.',
    },
    {
      id: 'noVerify',
      label: `${noVerify ? '$(check)' : '$(circle-large-outline)'} Skip git hooks (--no-verify)`,
      description: noVerify ? 'currently on' : 'currently off',
      detail: noVerify
        ? 'Pre-commit and commit-msg hooks will NOT run for the next commit.'
        : 'Pre-commit and commit-msg hooks will run normally.',
    },
  ];
}
