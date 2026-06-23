/**
 * Commit Dialog implementation.
 * Provides a comprehensive commit dialog with diff preview and advanced options.
 * Implements IntelliJ-style commit workflow.
 */

import * as vscode from 'vscode';
import {
  IGitService,
  IRepository,
  IDiff,
  ICommitOptions,
} from '../git-core/interfaces/IGitService';
import { RECENT_MESSAGES_STATE_KEY, updateRecentMessagesLru } from './CommitToolWindow';
import { generateNonce } from '../utils/webviewNonce';
import { sanitizeGitError } from '../git-core/gitError';
import { getLogger } from '../utils/logger';
import {
  gatherCheckinContext,
  formatCheckinProblems,
  runBeforeCommitChecks,
} from './CheckinChecks';
import { runCheckinHandlers } from './CheckinHandlers';

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
 * Extracted from {@link CommitDialog._handleCommit} into a standalone helper
 * so {@link CommitToolWindow} (WebviewView-based Commit surface) can call
 * the exact same code path. Behavior must be identical — only the UI wrapper
 * differs.
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
   * without running any git commands.
   */
  author?: string;
  /**
   * Skip git commit hooks (`--no-verify`). Mirrors the gear-menu toggle
   * in the Commit dialog.
   */
  noVerify?: boolean;
  /**
   * Optional changelist id this commit is scoped to. Purely informational
   * for callers/telemetry — {@link performCommit} maps the *files* to the
   * index, so the id rides along so callers (and {@link commitChangelist})
   * can thread the changelist membership without re-deriving it. The actual
   * index mapping is driven by {@link selectedFiles} vs {@link allFiles},
   * matching git4idea's `GitCheckinEnvironment` changelist→index mapping.
   */
  changelistId?: string;
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

  // Validate author override (if supplied) before touching the working tree.
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
      await gitService.stage(repository, filesToStage).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
    }

    // Unstage files that are staged but not selected.
    const filesToUnstage = options.allFiles
      .filter((f) => !selectedSet.has(f.path) && f.staged)
      .map((f) => f.path);
    if (filesToUnstage.length > 0) {
      await gitService.unstage(repository, filesToUnstage).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
    }

    const commitOptions: ICommitOptions = {
      amend: options.amend ?? false,
      signOff: options.signOff ?? false,
      noVerify: options.noVerify ?? false,
    };
    if (authorTrimmed.length > 0) {
      commitOptions.author = authorTrimmed;
    }
    await gitService.commit(repository, options.message, commitOptions).match(
      () => undefined,
      (e) => {
        throw e;
      }
    );

    return { success: true, files: options.selectedFiles };
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: msg };
  }
}

/**
 * Author-format regex used by the author-override field.
 *
 * Requires `Name <email@domain>` where the name has no angle brackets and
 * no control characters (so a newline/tab can't smuggle a second header line),
 * the email has no whitespace / angle brackets and contains `@`. Loose
 * enough to accept most real-world author strings; strict enough to
 * reject accidental free-form input.
 */
// eslint-disable-next-line no-control-regex -- intentional C0 control-char exclusion in the name
export const AUTHOR_FORMAT_REGEX = /^[^<>\x00-\x1f]+ <[^<>@\s]+@[^<>\s]+>$/;

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

// ─────────────────────────────────────────────────────────────────────────────
// Changelist → index mapping (git4idea GitCheckinEnvironment parity)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal structural view of a changelist needed to compute a commit plan.
 *
 * Declared locally (rather than importing {@link IChangelist}) so this
 * module stays free of a changelists ↔ commits import cycle. Any object
 * exposing `id` + a `files` array of `{ path, staged }` satisfies it,
 * which the real {@link IChangelist} does.
 */
export interface IChangelistCommitView {
  id: string;
  files: ReadonlyArray<{ path: string; staged?: boolean }>;
}

/**
 * The file-level inputs {@link performCommit} needs to commit exactly one
 * changelist's contents. Pure data — separated from the git execution so the
 * mapping is unit/property testable without a live {@link IGitService}.
 */
export interface IChangelistCommitPlan {
  /** Paths that belong to the target changelist (the commit's contents). */
  selectedFiles: string[];
  /**
   * Every path known across ALL changelists, with its current staged flag.
   * Drives {@link performCommit}'s delta stage/unstage so files in OTHER
   * changelists that happen to be staged get unstaged before the commit.
   */
  allFiles: Array<{ path: string; staged: boolean }>;
}

/**
 * Compute the {@link IChangelistCommitPlan} for committing only the
 * changelist identified by {@link targetChangelistId}.
 *
 * Mirrors git4idea's `GitCheckinEnvironment.commit` changelist→index
 * mapping (`GitCheckinEnvironment.kt:339-352,446-498`): the selected
 * changelist's changes are staged to the index and everything else is left
 * out. We realise "left out" via {@link performCommit}'s unstage delta — a
 * file in another changelist that is currently staged is unstaged so the
 * commit captures the target changelist only.
 *
 * The target's files become {@link IChangelistCommitPlan.selectedFiles};
 * the union of all changelists' files becomes
 * {@link IChangelistCommitPlan.allFiles}. Paths are de-duplicated, keeping
 * the first-seen `staged` flag (a path should live in exactly one
 * changelist post-reconcile, so duplicates are defensive only).
 *
 * @param changelists - All changelists for the repo.
 * @param targetChangelistId - Id of the changelist to commit.
 * @returns The plan, or `undefined` if the target id is unknown.
 */
export function computeChangelistCommitPlan(
  changelists: ReadonlyArray<IChangelistCommitView>,
  targetChangelistId: string
): IChangelistCommitPlan | undefined {
  const target = changelists.find((cl) => cl.id === targetChangelistId);
  if (!target) {
    return undefined;
  }

  const allFiles: Array<{ path: string; staged: boolean }> = [];
  const seen = new Set<string>();
  for (const cl of changelists) {
    for (const f of cl.files) {
      if (seen.has(f.path)) {
        continue;
      }
      seen.add(f.path);
      allFiles.push({ path: f.path, staged: f.staged ?? false });
    }
  }

  const selectedFiles = target.files.map((f) => f.path);

  return { selectedFiles, allFiles };
}

/**
 * Options for {@link commitChangelist}. Mirrors the optional knobs on
 * {@link IPerformCommitOptions} (amend/signOff/author/noVerify) so a
 * changelist-scoped commit has the same expressivity as a free-form one.
 */
export interface ICommitChangelistOptions {
  amend?: boolean;
  signOff?: boolean;
  author?: string;
  noVerify?: boolean;
}

/**
 * Commit ONLY the files belonging to a single changelist.
 *
 * Computes the changelist→index plan via {@link computeChangelistCommitPlan}
 * and delegates to {@link performCommit}, which stages the target's files,
 * unstages anything staged that the target doesn't own, then commits. This
 * is the executable counterpart to git4idea's per-changelist commit.
 *
 * Returns `{ success: false }` (without touching git) when the changelist is
 * unknown or has no files — there is nothing to commit.
 */
export async function commitChangelist(
  gitService: IGitService,
  repository: IRepository,
  changelists: ReadonlyArray<IChangelistCommitView>,
  targetChangelistId: string,
  message: string,
  options: ICommitChangelistOptions = {}
): Promise<IPerformCommitResult> {
  const plan = computeChangelistCommitPlan(changelists, targetChangelistId);
  if (!plan) {
    return { success: false, error: `Changelist not found: ${targetChangelistId}` };
  }
  if (plan.selectedFiles.length === 0) {
    return { success: false, error: 'Changelist has no files to commit' };
  }

  return performCommit(gitService, repository, {
    message,
    selectedFiles: plan.selectedFiles,
    allFiles: plan.allFiles,
    amend: options.amend,
    signOff: options.signOff,
    author: options.author,
    noVerify: options.noVerify,
    changelistId: targetChangelistId,
  });
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
  /** Author override payload from the `authorChange` message. */
  author?: string;
  /** Gear-menu `--no-verify` toggle payload. */
  noVerify?: boolean;
}

/**
 * Commit Dialog class.
 * Provides a webview panel for composing and submitting commits.
 *
 * - Display commit message input area and list of staged changes
 * - Display diff preview when file is selected
 * - Amend option populates previous commit message
 * - Sign-off option appends Signed-off-by line
 * - Prevent commit with empty message
 * - IntelliJ-style commit dialog layout
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
  /** Re-entrancy guard: true while a commit is in flight (blocks double-submit). */
  private _committing: boolean = false;
  private _commitMessage: string = '';
  private _previousCommitMessage: string = '';
  private _resolvePromise: ((result: ICommitDialogResult) => void) | undefined;
  /** Selected lines for partial staging - map of hunk index to selected line numbers */
  private _selectedLines: Map<number, Set<number>> = new Map();
  /** Whether partial staging mode is active */
  private _partialStagingMode: boolean = false;

  // Author/gear-toggle state ──────────────────────────────────────────────
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

    // Seed the author field from `intellig.commitAuthor` config unless the
    // caller already supplied one. Invalid configured values still populate
    // the input so the user sees and can fix them.
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
    } catch (error) {
      // An empty repo is already handled as an empty log; this only fires on a
      // genuine fault. Log+degrade (no previous-message prefill) so it stays visible.
      getLogger()
        .child({ component: 'CommitDialog' })
        .debug('loadPreviousCommitMessage failed', {
          err: error instanceof Error ? error.message : String(error),
        });
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
      case 'revertHunk':
        if (message.hunkIndex !== undefined) {
          await this._handleRevertHunk(message.hunkIndex);
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

      // ─── Author + gear-menu ─────────────────────────────────────────────
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
   * Update the in-memory author field and refresh the webview so validation
   * errors surface below the input.
   */
  private _handleAuthorChange(value: string): void {
    this._author = value;
    this._authorError = isValidAuthorFormat(value)
      ? undefined
      : 'Expected "Name <email@example.com>".';
    this._updateWebview();
  }

  /**
   * Persist the `--no-verify` gear toggle across dialog sessions.
   */
  private async _handleToggleNoVerify(value: boolean): Promise<void> {
    this._noVerify = value;
    if (this._workspaceState) {
      await this._workspaceState.update(LAST_NO_VERIFY_STATE_KEY, value);
    }
  }

  /**
   * Populate a QuickPick from the recent-messages LRU and, if the user
   * selects one, pre-fill the commit-message textarea.
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
   * Gear menu. Currently two entries — one disabled stub ("Run before-commit
   * checks") and one functional toggle (`--no-verify`). Additional entries
   * (Reformat, Optimize Imports, etc.) are planned as follow-ups.
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
      await this._previewBeforeCommitChecks();
    }
  }

  /**
   * Run the before-commit checks against the currently-selected files and
   * report the result without committing. Lets the user preview the checks
   * from the gear menu (the same checks run automatically at commit time
   * unless `--no-verify` is on).
   */
  private async _previewBeforeCommitChecks(): Promise<void> {
    if (!this._repository) {
      return;
    }
    const selectedPaths = this._stagedFiles.filter((f) => f.selected).map((f) => f.path);
    const context = await gatherCheckinContext(this._gitService, this._repository, selectedPaths);
    const result = runCheckinHandlers(context);
    if (result.problems.length === 0) {
      void vscode.window.showInformationMessage('Before-commit checks passed.');
      return;
    }
    void vscode.window.showWarningMessage(
      result.hasBlockingProblem
        ? 'Before-commit checks found problems'
        : 'Before-commit checks found warnings',
      { modal: true, detail: formatCheckinProblems(result.problems) }
    );
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
    // Re-entrancy guard: a rapid second accept (double Enter, or Enter while the
    // before-commit modal is open) must not launch a second commit while the
    // first is still in flight.
    if (this._committing) {
      return;
    }
    this._committing = true;
    try {
      await this._handleCommitInner(message);
    } finally {
      this._committing = false;
    }
  }

  private async _handleCommitInner(message: IWebviewMessage): Promise<void> {
    if (!this._repository) {
      return;
    }

    const commitMessage = message.message ?? this._commitMessage;
    const selectedFiles = this._stagedFiles.filter((f) => f.selected).map((f) => f.path);

    // Validate author format before we do any git work so the dialog
    // surfaces the error without staging/unstaging first.
    if (this._author.trim().length > 0 && !isValidAuthorFormat(this._author)) {
      this._authorError = 'Expected "Name <email@example.com>".';
      this._updateWebview();
      void vscode.window.showErrorMessage(
        'Commit failed: invalid author format. Expected "Name <email@example.com>".'
      );
      return;
    }

    // Run the before-commit checks (user.name / unresolved-merge /
    // detached-HEAD) unless `--no-verify` is on — `--no-verify` skips both
    // git's own hooks and these IDE-side checks. A blocking problem the user
    // declines to override aborts the commit.
    if (!this._noVerify) {
      const proceed = await runBeforeCommitChecks(
        this._gitService,
        this._repository,
        selectedFiles
      );
      if (!proceed) {
        return;
      }
    }

    // Delegate to the shared helper so CommitDialog and CommitToolWindow go
    // through identical code paths, with `author` + `noVerify` passed through.
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

    // Push the committed message onto the recent-messages LRU.
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
      getLogger()
        .child({ component: 'CommitDialog' })
        .error('failed to get diff', { path }, error instanceof Error ? error : undefined);
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
      await this._gitService.stage(this._repository, [path]).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
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
      await this._gitService.unstage(this._repository, [path]).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
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
      await this._gitService.stageHunk(this._repository, this._selectedFilePath, hunk).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
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
      await this._gitService.unstageHunk(this._repository, this._selectedFilePath, hunk).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
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
   * Handle reverting (discarding) a single hunk in the working tree — IntelliJ
   * "Revert Chunk". Discards uncommitted work, so a modal confirm gates it
   * (data-loss-confirm policy).
   */
  private async _handleRevertHunk(hunkIndex: number): Promise<void> {
    if (!this._repository || !this._selectedFilePath || !this._currentDiff) {
      return;
    }

    const hunk = this._currentDiff.hunks[hunkIndex];
    if (!hunk) {
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      `Revert this hunk in ${this._selectedFilePath}? The change will be discarded.`,
      { modal: true },
      'Revert Hunk'
    );
    if (choice !== 'Revert Hunk') {
      return;
    }

    try {
      await this._gitService.revertHunk(this._repository, this._selectedFilePath, hunk).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      // Refresh the diff to show updated state
      await this._handleFileSelect(this._selectedFilePath);
      await this._loadStagedFiles();
      void vscode.window.showInformationMessage('Hunk reverted successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to revert hunk: ${sanitizeGitError(errorMessage)}`
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
      await this._gitService
        .stageLines(this._repository, this._selectedFilePath, Array.from(selectedLineNumbers), hunk)
        .match(
          () => undefined,
          (e) => {
            throw e;
          }
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
  <div class="commit-dialog" id="root"></div>
  <script nonce="${nonce}">
    ${this._getScript()}
  </script>
</body>
</html>`;
  }

  /**
   * Serialize all host-side commit-dialog state into the JSON init island the
   * inline script reads to build the DOM. Per-file and per-line display values
   * (file name/dir, status colour, line classes, checkboxes) are precomputed
   * here so the script just maps data → DOM. Every dynamic value reaches the
   * DOM via .value / .textContent / element props (injection-proof).
   */
  private _getInitJson(): string {
    const fileItem = (f: IStagedFile): unknown => ({
      path: f.path,
      fileName: this._getFileName(f.path),
      fileDir: this._getFileDir(f.path),
      statusChar: f.status.charAt(0),
      statusColor: this._getStatusColor(f.status),
      selected: f.selected,
      isSelected: this._selectedFilePath === f.path,
      staged: f.staged,
    });

    const hasRecent = this._readRecentMessages().length > 0;

    let diff: unknown = null;
    if (this._currentDiff && this._selectedFilePath) {
      const file = this._stagedFiles.find((f) => f.path === this._selectedFilePath);
      const isStaged = file?.staged ?? false;
      diff = {
        fileName: this._getFileName(this._selectedFilePath),
        partialStagingMode: this._partialStagingMode,
        binary: this._currentDiff.binary,
        empty: this._currentDiff.hunks.length === 0,
        hunks: this._currentDiff.binary
          ? []
          : this._currentDiff.hunks.map((hunk, hunkIndex) => {
              const selectedLines = this._selectedLines.get(hunkIndex) || new Set<number>();
              return {
                header: hunk.header,
                hunkIndex,
                isStaged,
                hasSelectedLines: selectedLines.size > 0,
                selectedCount: selectedLines.size,
                lines: hunk.lines.map((line) => {
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
                      break;
                  }
                  const isSelected = lineNumber !== undefined && selectedLines.has(lineNumber);
                  if (isSelected) {
                    lineClass += ' line-selected';
                  }
                  if (isSelectable) {
                    lineClass += ' selectable';
                  }
                  const showCheckbox =
                    this._partialStagingMode && isSelectable && lineNumber !== undefined;
                  return {
                    lineClass,
                    prefix,
                    oldNum: line.oldLineNumber?.toString() ?? '',
                    newNum: line.newLineNumber?.toString() ?? '',
                    content: line.content,
                    selectable:
                      isSelectable && lineNumber !== undefined ? { hunkIndex, lineNumber } : null,
                    checkbox: showCheckbox ? (isSelected ? '☑' : '☐') : null,
                  };
                }),
              };
            }),
      };
    }

    const selectedCount = this._stagedFiles.filter((f) => f.selected).length;

    return JSON.stringify({
      message: this._commitMessage,
      author: this._author,
      authorError: this._authorError,
      noVerify: this._noVerify,
      hasRecent,
      recentBtnTitle: hasRecent ? 'Pick a recent commit message' : 'No recent commit messages yet',
      stagedFiles: this._stagedFiles.filter((f) => f.staged).map(fileItem),
      unstagedFiles: this._stagedFiles.filter((f) => !f.staged).map(fileItem),
      diff,
      amendMode: this._amendMode,
      signOffMode: this._signOffMode,
      selectedCount,
      commitLabel:
        'Commit' +
        (this._amendMode ? ' (Amend)' : '') +
        ' (' +
        selectedCount +
        ' file' +
        (selectedCount !== 1 ? 's' : '') +
        ')',
    }).replace(/</g, '\\u003c');
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

      /* section-header-actions ─────────────────────────────────────────── */
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
      /* ─── end section-header-actions ──────────────────────────────────── */

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
      const INIT = ${this._getInitJson()};
      const el = (tag, props) => Object.assign(document.createElement(tag), props || {});
      const setData = (node, attrs) => { for (const k in attrs) node.setAttribute(k, attrs[k]); return node; };

      // ── Build the body via createElement (no HTML-string injection) ────────
      (function buildBody() {
        const root = document.getElementById('root');
        if (!root) return;

        // Message section
        const messageSection = el('div', { className: 'section message-section' });
        const msgHeader = el('div', { className: 'section-header' });
        msgHeader.append(el('span', { className: 'section-title', textContent: 'Commit Message' }));
        const headerActions = el('div', { className: 'section-header-actions' });
        const recentBtn = el('button', { id: 'recent-messages-btn', className: 'header-action-button', type: 'button', title: INIT.recentBtnTitle, textContent: '∨' });
        setData(recentBtn, { 'data-action': 'openRecentMessages' });
        recentBtn.disabled = !INIT.hasRecent;
        const gearBtn = el('button', { id: 'gear-btn', className: 'header-action-button', type: 'button', title: 'Commit options', textContent: '⚙' });
        setData(gearBtn, { 'data-action': 'openGearMenu' });
        headerActions.append(recentBtn, gearBtn);
        msgHeader.append(headerActions);
        messageSection.append(msgHeader);
        const textarea = el('textarea', { id: 'commit-message', className: 'commit-message-input', placeholder: 'Enter commit message...' });
        textarea.value = INIT.message;
        messageSection.append(textarea);
        // Author section
        const authorSection = el('div', { className: 'author-section' });
        authorSection.append(el('label', { htmlFor: 'commit-author', className: 'author-label', textContent: 'Author (optional):' }));
        const authorInput = el('input', { id: 'commit-author', className: 'author-input', type: 'text', placeholder: 'Name <email@example.com>' });
        authorInput.value = INIT.author;
        authorSection.append(authorInput);
        if (INIT.authorError) {
          const errDiv = el('div', { className: 'author-error', textContent: INIT.authorError });
          errDiv.setAttribute('role', 'alert');
          authorSection.append(errDiv);
        }
        messageSection.append(authorSection);
        if (INIT.noVerify) {
          const badge = el('div', { className: 'no-verify-badge' });
          badge.setAttribute('role', 'note');
          badge.append('⚠ Git hooks will be skipped (', el('code', { textContent: '--no-verify' }), '). Open the gear menu to turn this off.');
          messageSection.append(badge);
        }

        // Files section
        const filesSection = el('div', { className: 'section files-section' });
        const filesHeader = el('div', { className: 'section-header' });
        filesHeader.append(el('span', { className: 'section-title', textContent: 'Changes' }));
        const refreshBtn = el('button', { className: 'refresh-button', title: 'Refresh', textContent: '↻' });
        setData(refreshBtn, { 'data-action': 'refresh' });
        filesHeader.append(refreshBtn);
        filesSection.append(filesHeader);
        const filesList = el('div', { className: 'files-list' });
        const buildFileItem = (f) => {
          const item = el('div', { className: 'file-item' + (f.isSelected ? ' selected' : '') });
          setData(item, { 'data-path': f.path, 'data-action': 'selectFile' });
          const cb = el('input', { type: 'checkbox', className: 'file-checkbox' });
          cb.checked = f.selected;
          setData(cb, { 'data-action': 'toggleFile', 'data-path': f.path });
          const status = el('span', { className: 'file-status', textContent: f.statusChar });
          status.style.color = f.statusColor;
          const stageBtn = f.staged
            ? setData(el('button', { className: 'stage-button unstage', title: 'Unstage', textContent: '−' }), { 'data-action': 'unstageFile', 'data-path': f.path })
            : setData(el('button', { className: 'stage-button stage', title: 'Stage', textContent: '+' }), { 'data-action': 'stageFile', 'data-path': f.path });
          item.append(cb, status, el('span', { className: 'file-path', textContent: f.fileName }), el('span', { className: 'file-dir', textContent: f.fileDir }), stageBtn);
          return item;
        };
        const fileGroup = (label, files) => {
          const group = el('div', { className: 'file-group' });
          group.append(el('div', { className: 'file-group-header', textContent: label + ' (' + files.length + ')' }));
          for (const f of files) group.append(buildFileItem(f));
          return group;
        };
        if (INIT.stagedFiles.length > 0) filesList.append(fileGroup('Staged Changes', INIT.stagedFiles));
        if (INIT.unstagedFiles.length > 0) filesList.append(fileGroup('Unstaged Changes', INIT.unstagedFiles));
        if (INIT.stagedFiles.length === 0 && INIT.unstagedFiles.length === 0) {
          filesList.append(el('div', { className: 'empty-message', textContent: 'No changes to commit' }));
        }
        filesSection.append(filesList);

        // Diff preview section
        const diffSection = el('div', { className: 'section diff-section' });
        const diffHeader = el('div', { className: 'section-header' });
        if (!INIT.diff) {
          diffHeader.append(el('span', { className: 'section-title', textContent: 'Diff Preview' }));
          diffSection.append(diffHeader);
          const dc = el('div', { className: 'diff-content empty' });
          dc.append(el('div', { className: 'empty-message', textContent: 'Select a file to preview changes' }));
          diffSection.append(dc);
        } else {
          diffHeader.append(el('span', { className: 'section-title', textContent: 'Diff: ' + INIT.diff.fileName }));
          const ctrls = el('div', { className: 'diff-header-controls' });
          const toggle = el('button', { className: 'partial-staging-toggle' + (INIT.diff.partialStagingMode ? ' active' : ''), title: INIT.diff.partialStagingMode ? 'Exit line selection mode' : 'Enable line selection for partial staging', textContent: INIT.diff.partialStagingMode ? '✓ Line Selection' : '☐ Line Selection' });
          setData(toggle, { 'data-action': 'togglePartialStagingMode' });
          ctrls.append(toggle);
          diffHeader.append(ctrls);
          diffSection.append(diffHeader);
          const dc = el('div', { className: 'diff-content' });
          if (INIT.diff.binary) {
            dc.append(el('div', { className: 'binary-file', textContent: 'Binary file' }));
          } else if (INIT.diff.empty) {
            dc.append(el('div', { className: 'empty-message', textContent: 'No changes' }));
          } else {
            for (const hunk of INIT.diff.hunks) dc.append(buildHunk(hunk));
          }
          diffSection.append(dc);
        }

        // Footer
        const footer = el('div', { className: 'commit-footer' });
        const options = el('div', { className: 'options-section' });
        const optionLabel = (id, checked, text) => {
          const label = el('label', { className: 'option-label' });
          const input = el('input', { type: 'checkbox', id: id });
          input.checked = checked;
          label.append(input, el('span', { textContent: text }));
          return label;
        };
        options.append(optionLabel('amend-checkbox', INIT.amendMode, 'Amend'), optionLabel('signoff-checkbox', INIT.signOffMode, 'Sign-off'));
        const buttons = el('div', { className: 'buttons-section' });
        const cancelBtn = setData(el('button', { className: 'button cancel-button', textContent: 'Cancel' }), { 'data-action': 'cancel' });
        const commitBtn = setData(el('button', { className: 'button commit-button', textContent: INIT.commitLabel }), { 'data-action': 'commit' });
        commitBtn.disabled = INIT.selectedCount === 0;
        buttons.append(cancelBtn, commitBtn);
        footer.append(options, buttons);

        // Layout
        const main = el('div', { className: 'commit-main' });
        const left = el('div', { className: 'commit-left' });
        left.append(messageSection, filesSection);
        const right = el('div', { className: 'commit-right' });
        right.append(diffSection);
        main.append(left, right);
        root.append(main, footer);

        function buildHunk(hunk) {
          const h = el('div', { className: 'diff-hunk' });
          const headerRow = el('div', { className: 'hunk-header-row' });
          headerRow.append(el('div', { className: 'hunk-header', textContent: hunk.header }));
          const hunkControls = el('div', { className: 'hunk-controls' });
          if (hunk.isStaged) {
            hunkControls.append(setData(el('button', { className: 'hunk-button unstage-hunk', title: 'Unstage this hunk', textContent: '− Unstage Hunk' }), { 'data-action': 'unstageHunk', 'data-hunk-index': String(hunk.hunkIndex) }));
          } else {
            hunkControls.append(
              setData(el('button', { className: 'hunk-button stage-hunk', title: 'Stage this hunk', textContent: '+ Stage Hunk' }), { 'data-action': 'stageHunk', 'data-hunk-index': String(hunk.hunkIndex) }),
              setData(el('button', { className: 'hunk-button revert-hunk', title: "Discard this hunk's changes", textContent: '↶ Revert Hunk' }), { 'data-action': 'revertHunk', 'data-hunk-index': String(hunk.hunkIndex) })
            );
          }
          headerRow.append(hunkControls);
          h.append(headerRow);
          if (INIT.diff.partialStagingMode) {
            const lsc = el('div', { className: 'line-selection-controls' });
            lsc.append(
              setData(el('button', { className: 'hunk-button select-all', title: 'Select all changed lines', textContent: 'Select All' }), { 'data-action': 'selectAllLinesInHunk', 'data-hunk-index': String(hunk.hunkIndex) }),
              setData(el('button', { className: 'hunk-button deselect-all', title: 'Deselect all lines', textContent: 'Deselect All' }), { 'data-action': 'deselectAllLinesInHunk', 'data-hunk-index': String(hunk.hunkIndex) })
            );
            if (hunk.hasSelectedLines && !hunk.isStaged) {
              lsc.append(setData(el('button', { className: 'hunk-button stage-selected', title: 'Stage selected lines', textContent: '+ Stage ' + hunk.selectedCount + ' Line' + (hunk.selectedCount !== 1 ? 's' : '') }), { 'data-action': 'stageSelectedLines', 'data-hunk-index': String(hunk.hunkIndex) }));
            }
            h.append(lsc);
          }
          for (const line of hunk.lines) {
            const lineEl = el('div', { className: line.lineClass });
            if (line.selectable) setData(lineEl, { 'data-action': 'toggleLine', 'data-hunk-index': String(line.selectable.hunkIndex), 'data-line-number': String(line.selectable.lineNumber) });
            if (line.checkbox) lineEl.append(el('span', { className: 'line-checkbox', textContent: line.checkbox }));
            lineEl.append(
              el('span', { className: 'line-num old', textContent: line.oldNum }),
              el('span', { className: 'line-num new', textContent: line.newNum }),
              el('span', { className: 'line-prefix', textContent: line.prefix }),
              el('span', { className: 'line-content', textContent: line.content })
            );
            h.append(lineEl);
          }
          return h;
        }
      })();

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

      function revertHunk(hunkIndex) {
        vscode.postMessage({ type: 'revertHunk', hunkIndex: hunkIndex });
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

      // ─── author controls ───────────────────────────────────────────────
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

      // Delegated event dispatcher.
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
          revertHunk: () => revertHunk(Number(hunkIndex)),
          stageSelectedLines: () => stageSelectedLines(Number(hunkIndex)),
          selectAllLinesInHunk: () => selectAllLinesInHunk(Number(hunkIndex)),
          deselectAllLinesInHunk: () => deselectAllLinesInHunk(Number(hunkIndex)),
          // / WJ-5 — toggleLine joins the dispatcher. The
          // existing global toggleLine(hunkIndex, lineNumber) function
          // is unchanged; we just route through it via Number()
          // coercion of the dataset strings. Pinned by
          // commitDialog-toggleLine-1.
          toggleLine: () => toggleLine(Number(hunkIndex), Number(target.dataset.lineNumber)),
          // Header/footer controls. These were inline onclick handlers,
          // which the nonce-only CSP (no 'unsafe-inline') blocks, leaving
          // the buttons dead; routing through the delegated dispatcher
          // restores them.
          openRecentMessages: () => openRecentMessages(),
          openGearMenu: () => openGearMenu(),
          refresh: () => refresh(),
          togglePartialStagingMode: () => togglePartialStagingMode(),
          cancel: () => cancel(),
          commit: () => commit(),
        };
        const handler = handlers[action];
        if (handler) {
          handler();
        }
      });

      // Input / change controls. Inline oninput/onchange attributes are also
      // blocked by the nonce-only CSP, so wire them through addEventListener.
      const msgEl = document.getElementById('commit-message');
      if (msgEl) {
        msgEl.addEventListener('input', (e) => handleMessageChange(e.target.value));
      }
      const authorEl = document.getElementById('commit-author');
      if (authorEl) {
        authorEl.addEventListener('input', (e) => handleAuthorChange(e.target.value));
      }
      const amendEl = document.getElementById('amend-checkbox');
      if (amendEl) {
        amendEl.addEventListener('change', (e) => toggleAmend(e.target.checked));
      }
      const signoffEl = document.getElementById('signoff-checkbox');
      if (signoffEl) {
        signoffEl.addEventListener('change', (e) => toggleSignOff(e.target.checked));
      }

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
   * Returns CSS `var()` expressions instead of bare hex
   * so themes can override file-status colors. Each entry falls back
   * to a hex literal when the theme variable is undefined.
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
 * Build the two gear-menu entries.
 *
 * Entry 1: functional `Run before-commit checks` — previews the cheap
 *   before-commit checks (user.name / unresolved-merge / detached-HEAD)
 *   against the selected files without committing. The same checks run
 *   automatically at commit time unless `--no-verify` is on. Reformat /
 *   Optimize Imports / TODO / inspection checks remain follow-ups.
 *
 * Entry 2: functional `--no-verify` toggle. The `$(check)` glyph shows
 *   the current state so the user can see whether hooks will be skipped.
 */
export function buildGearMenuItems(noVerify: boolean): IGearMenuItem[] {
  return [
    {
      id: 'beforeCommit',
      label: 'Run before-commit checks',
      description: 'user.name · unresolved merge · detached HEAD',
      detail:
        'Preview the cheap before-commit checks against the selected files. These run automatically at commit time unless --no-verify is on.',
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
