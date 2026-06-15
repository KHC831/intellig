/**
 * Status Bar Service implementation.
 * Provides status bar integration for displaying Git branch and sync information.
 */

import * as vscode from 'vscode';
import {
  IStatusBarService,
  IStatusBarState,
  IStatusBarDisplayOptions,
  StatusBarClickAction,
} from './interfaces/IStatusBarService';
import { IGitService, IRepository, RepositoryState } from '../git-core/interfaces/IGitService';
import { resolveRepo } from '../utils/resolveRepo';
import { safeFireAndForget } from '../utils/safeFireAndForget';

/**
 * Default status bar display options
 */
const DEFAULT_OPTIONS: Required<IStatusBarDisplayOptions> = {
  showBranchName: true,
  showSyncStatus: true,
  priority: 100,
  alignment: vscode.StatusBarAlignment.Left,
};

/**
 * Default debounce window (ms) for coalescing rapid refresh triggers
 * (e.g. fetch + repo-change firing back-to-back for the same tick).
 */
const DEFAULT_REFRESH_DEBOUNCE_MS = 150;

/**
 * Status Bar Service implementation.
 * Manages the Git status bar item that displays branch and sync information.
 *
 * - Display current branch name in status bar
 * - Display progress and status notifications similar to IntelliJ
 *
 * Subscribes to `onDidFetch` (from AutoFetchService) and
 * `onDidChangeRepository` so the ↑N ↓M badge refreshes after every fetch or
 * repo state mutation. Clicking the badge opens the actionable branch popup
 * (`intellig.showBranchPopup`), falling back to opening the Git tool window
 * when the popup command isn't registered yet.
 */
export class StatusBarService implements IStatusBarService {
  private _statusBarItem: vscode.StatusBarItem;
  private _gitService: IGitService;
  private _state: IStatusBarState;
  private _options: Required<IStatusBarDisplayOptions>;
  private _disposables: vscode.Disposable[] = [];
  private _onDidChangeState: vscode.EventEmitter<IStatusBarState>;
  /** Repo most-recently passed to {@link update}. Used as the refresh source. */
  private _activeRepo: IRepository | undefined;
  /** Coalescing timer id for debounced refreshes. */
  private _refreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** Debounce window in milliseconds; exposed for tests. */
  private readonly _refreshDebounceMs: number;

  /**
   * Event fired when the status bar state changes.
   */
  readonly onDidChangeState: vscode.Event<IStatusBarState>;

  /**
   * Create a new StatusBarService instance.
   *
   * @param gitService - The Git service to use for repository information
   * @param options - Display options for the status bar item
   * @param refreshDebounceMs - Debounce window for refresh coalescing. Tests
   *   pass `0` for immediate refresh; production uses the default (150ms).
   */
  constructor(
    gitService: IGitService,
    options?: IStatusBarDisplayOptions,
    refreshDebounceMs: number = DEFAULT_REFRESH_DEBOUNCE_MS
  ) {
    this._gitService = gitService;
    this._options = { ...DEFAULT_OPTIONS, ...options };
    this._refreshDebounceMs = refreshDebounceMs;

    // Initialize state
    this._state = {
      ahead: 0,
      behind: 0,
      isDetached: false,
      hasUpstream: false,
      repositoryState: 'idle',
      isEmptyRepo: false,
    };

    // Create event emitter
    this._onDidChangeState = new vscode.EventEmitter<IStatusBarState>();
    this.onDidChangeState = this._onDidChangeState.event;
    this._disposables.push(this._onDidChangeState);

    // Create status bar item
    this._statusBarItem = vscode.window.createStatusBarItem(
      this._options.alignment,
      this._options.priority
    );
    // Click the status-bar branch widget → open the actionable branch popup
    // (checkout / new branch / merge / rebase / compare …), matching IntelliJ's
    // status-bar Git widget. The click routes through `intellig.statusBar.click`
    // which dispatches to `intellig.showBranchPopup`, falling back to opening
    // the Git tool window when the popup command isn't registered yet. The
    // primary action is configurable via {@link setClickAction}; the default
    // installed here is the branch popup.
    this._statusBarItem.command = {
      title: 'Manage Branches',
      command: 'intellig.statusBar.click',
      arguments: [],
    };
    this._statusBarItem.tooltip = 'Click to manage branches';
    this._disposables.push(this._statusBarItem);

    // Register the click-dispatch command that tries focusTab first, then
    // falls back to opening the tool window. Idempotent registration
    // (tolerates duplicate registrations by swallowing the throw).
    this._registerClickDispatch();

    // Listen for repository changes to update status bar
    this._disposables.push(
      this._gitService.onDidChangeRepository((repo) => {
        this._scheduleRefresh(repo);
      })
    );

    // Listen for fetches so the incoming/outgoing counts reflect the latest
    // remote-tracking state without waiting for a separate repo-change event.
    this._disposables.push(
      this._gitService.onDidFetch(({ repo }) => {
        this._scheduleRefresh(repo);
      })
    );

    // Initialize with current repository. Bucket C: init path;
    // the `onDidChangeRepository` listener above picks up late-arriving
    // repos, so an initial failure self-heals.
    safeFireAndForget(this._initialize(), 'StatusBarService.constructor: initial repository load');
  }

  /**
   * Register the status-bar click dispatch command — opens the actionable
   * branch popup (`intellig.showBranchPopup`), falling back to opening the Git
   * tool window when the popup command isn't registered yet (e.g. during
   * activation before branch commands are wired). Registered defensively so a
   * duplicate registration (hot-reload or test) doesn't break the constructor.
   *
   * This is the IntelliJ-parity behaviour: clicking the status-bar Git widget
   * pops a menu of branch actions (checkout, new branch, merge, rebase,
   * compare …) rather than merely focusing a read-only Incoming list.
   */
  private _registerClickDispatch(): void {
    try {
      const disposable = vscode.commands.registerCommand('intellig.statusBar.click', async () => {
        try {
          await vscode.commands.executeCommand('intellig.showBranchPopup');
        } catch {
          await vscode.commands.executeCommand('intellig.openGitToolWindow');
        }
      });
      this._disposables.push(disposable);
    } catch {
      // Command already registered (another instance still alive, or reload).
      // Safe no-op — the existing registration still works.
    }
  }

  /**
   * Schedule a debounced refresh. If multiple events fire inside the
   * {@link _refreshDebounceMs} window, only the last one's repo is used.
   */
  private _scheduleRefresh(repo: IRepository): void {
    this._activeRepo = repo;
    if (this._refreshDebounceMs <= 0) {
      this.update(repo);
      return;
    }
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
    }
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = undefined;
      if (this._activeRepo) {
        this.update(this._activeRepo);
      }
    }, this._refreshDebounceMs);
  }

  /**
   * Initialize the status bar with current repository info.
   *
   * Route through `resolveRepo(preferActive: true)` so the
   * status bar branch indicator reflects the active editor's repo in
   * multi-root workspaces, not an arbitrary first-enumerated repo.
   * Falls back to the first workspace folder's repo when the git
   * service is still empty.
   */
  private async _initialize(): Promise<void> {
    const repo = await resolveRepo(this._gitService, {
      preferActive: true,
      silent: true,
    });
    if (repo) {
      this.update(repo);
      return;
    }
    // Fallback: discover from workspace folders (git service not yet populated)
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      const discovered = await this._gitService.getRepository(workspaceFolders[0].uri);
      if (discovered) {
        this.update(discovered);
      } else {
        // No repository found - hide status bar
        this.hide();
      }
    } else {
      // No workspace folders - hide status bar
      this.hide();
    }
  }

  /**
   * Show the status bar item.
   */
  show(): void {
    this._statusBarItem.show();
  }

  /**
   * Hide the status bar item.
   * Requirement: Hide when no repository is open
   */
  hide(): void {
    this._statusBarItem.hide();
  }

  /**
   * Update the status bar with the current repository state.
   *
   * @param repository - The repository to display status for
   */
  update(repository: IRepository): void {
    // Build new state from repository
    const newState = this._buildState(repository);

    // Update internal state
    const stateChanged = !this._statesEqual(this._state, newState);
    this._state = newState;

    // Update status bar display
    this._updateDisplay();

    // Fire state change event if state changed
    if (stateChanged) {
      this._onDidChangeState.fire(this._state);
    }
  }

  /**
   * Build status bar state from repository.
   */
  private _buildState(repository: IRepository): IStatusBarState {
    const state: IStatusBarState = {
      ahead: 0,
      behind: 0,
      isDetached: false,
      hasUpstream: false,
      repositoryState: repository.state,
      isEmptyRepo: false,
    };

    if (repository.head) {
      if (repository.head.name) {
        // Normal branch state
        state.branchName = repository.head.name.replace('refs/heads/', '');
        state.isDetached = false;
        // Symbolic HEAD with no commit means the repo is freshly
        // `git init`-ed (or otherwise has no objects yet). Surface the
        // branch name with a `(no commits yet)` suffix instead of the
        // bare "No commits yet" treatment.
        if (!repository.head.commit) {
          state.isEmptyRepo = true;
        }
      } else if (repository.head.commit) {
        // Detached HEAD state
        state.isDetached = true;
        state.commitHash = repository.head.commit.substring(0, 7);
      }

      // Sync status (ahead/behind)
      state.ahead = repository.head.ahead || 0;
      state.behind = repository.head.behind || 0;
      state.hasUpstream = repository.head.upstream !== undefined;
    }

    // Copy the verb-form payload from the repository so the status bar
    // can render "Rebasing onto main" rather than the bare verb.
    if (repository.inProgress) {
      state.inProgress = {
        kind: repository.inProgress.kind,
        ...(repository.inProgress.target !== undefined
          ? { target: repository.inProgress.target }
          : {}),
      };
    }

    return state;
  }

  /**
   * Check if two states are equal.
   */
  private _statesEqual(a: IStatusBarState, b: IStatusBarState): boolean {
    return (
      a.branchName === b.branchName &&
      a.ahead === b.ahead &&
      a.behind === b.behind &&
      a.isDetached === b.isDetached &&
      a.commitHash === b.commitHash &&
      a.hasUpstream === b.hasUpstream &&
      a.repositoryState === b.repositoryState &&
      a.isEmptyRepo === b.isEmptyRepo &&
      // Compare the verb-form payload by structural shape: two
      // consecutive reloads carrying the same kind+target should
      // coalesce, but a kind/target change must trigger a refresh.
      a.inProgress?.kind === b.inProgress?.kind &&
      a.inProgress?.target === b.inProgress?.target
    );
  }

  /**
   * Update the status bar display based on current state.
   * - Display current branch name in status bar
   * - Show ahead/behind counts if the branch has an upstream (e.g., "main ↑2 ↓1")
   */
  private _updateDisplay(): void {
    const {
      branchName,
      ahead,
      behind,
      isDetached,
      commitHash,
      hasUpstream,
      repositoryState,
      isEmptyRepo,
      inProgress,
    } = this._state;

    // Build status text
    let statusText = '';
    let tooltip = '';

    // Verb-form prefix for in-progress operations. Built first so the
    // icon + verb anchors the status bar; the branch chip + ahead/behind
    // counters still trail to keep the existing information visible.
    let verbPrefix = '';
    let verbLabel = '';
    if (inProgress) {
      const verb = this._getInProgressVerb(inProgress.kind, inProgress.target);
      const icon = this._getRepositoryStateIndicator(inProgress.kind);
      if (verb) {
        verbLabel = verb;
        verbPrefix = icon ? `${icon} ${verb}` : verb;
      }
    }

    if (isDetached) {
      // Detached HEAD state
      statusText = `$(git-commit) ${commitHash || 'HEAD'}`;
      tooltip = 'Detached HEAD - Click to manage branches';
    } else if (branchName) {
      if (isEmptyRepo) {
        // Empty repo: surface the configured initial branch with
        // `(no commits yet)` so the user knows where the first commit
        // will land.
        statusText = `$(git-branch) ${branchName} (no commits yet)`;
        tooltip = `On branch ${branchName} — no commits yet. Your first commit will create this branch.`;
      } else {
        statusText = `$(git-branch) ${branchName}`;
        tooltip = `Branch: ${branchName}`;
      }

      // Add ahead/behind indicators if upstream is configured
      if (this._options.showSyncStatus && hasUpstream) {
        const indicators: string[] = [];
        if (ahead > 0) {
          indicators.push(`↑${ahead}`);
        }
        if (behind > 0) {
          indicators.push(`↓${behind}`);
        }
        if (indicators.length > 0) {
          statusText += ` ${indicators.join(' ')}`;
        }

        if (ahead > 0 || behind > 0) {
          tooltip += `\n${ahead} commit(s) ahead, ${behind} commit(s) behind`;
        } else {
          tooltip += '\nUp to date with upstream';
        }
      } else if (!hasUpstream && !isEmptyRepo) {
        tooltip += '\nNo upstream configured';
      }
    } else {
      // Fallback: symbolic-ref also failed (rare — mid-clone / corrupt).
      // The common empty-repo case is handled in the `branchName` branch.
      statusText = '$(git-branch) No commits yet';
      tooltip = 'No commits yet - Click to manage branches';
    }

    // Verb-prefix path: rich `inProgress` payload leads the status-bar
    // text (e.g. "$(git-merge) Merging topic $(git-branch) feature ↑2 ↓1").
    // Branch chip + ahead/behind counters tail the verb form so the
    // existing information stays visible at a glance.
    //
    // Degraded fallback (non-idle state but no rich payload): icon
    // TRAILS the branch label (e.g. "$(git-branch) feature $(git-merge)").
    // Exists only to preserve the pre-verb-prefix signal that the
    // working tree is non-idle.
    if (verbPrefix) {
      statusText = statusText ? `${verbPrefix} ${statusText}` : verbPrefix;
      // Tooltip carries the verb-form label as the narratable fallback
      // for screen readers that may not interpret the codicon glyphs.
      tooltip = `${verbLabel}\n${tooltip}`;
    } else if (repositoryState !== 'idle') {
      const stateIndicator = this._getRepositoryStateIndicator(repositoryState);
      if (stateIndicator) {
        statusText += ` ${stateIndicator}`;
        tooltip += `\nRepository state: ${repositoryState}`;
      }
    }

    // Update status bar item
    this._statusBarItem.text = statusText;
    this._statusBarItem.tooltip = tooltip + '\nClick to manage branches';

    // Show the status bar item
    this.show();
  }

  /**
   * Verb-form text for an in-progress operation. The verb is the leading
   * word of the status-bar prefix; the target (when known) is glued in
   * with the connector that matches IntelliJ's wording:
   *
   *   - merging:        "Merging <target>"          (no connector)
   *   - rebasing:       "Rebasing onto <target>"    (preposition)
   *   - cherry-picking: "Cherry-picking <target>"   (no connector)
   *   - reverting:      "Reverting <target>"        (no connector)
   *
   * When `target` is undefined (plain merge, marker file race) the verb
   * alone is surfaced — sufficient signal on its own without a misleading
   * "<unknown>" placeholder. `kind` is typed as
   * `Exclude<RepositoryState, 'idle'>` to surface a TS exhaustiveness
   * check on every new in-progress state.
   */
  private _getInProgressVerb(
    kind: Exclude<RepositoryState, 'idle'>,
    target: string | undefined
  ): string {
    switch (kind) {
      case 'merging':
        return target ? `Merging ${target}` : 'Merging';
      case 'rebasing':
        return target ? `Rebasing onto ${target}` : 'Rebasing';
      case 'cherry-picking':
        return target ? `Cherry-picking ${target}` : 'Cherry-picking';
      case 'reverting':
        return target ? `Reverting ${target}` : 'Reverting';
      default:
        return assertNeverInProgressKind(kind);
    }
  }

  /**
   * Get a visual indicator for the repository state.
   */
  private _getRepositoryStateIndicator(state: string): string {
    switch (state) {
      case 'merging':
        return '$(git-merge)';
      case 'rebasing':
        return '$(git-pull-request)';
      case 'cherry-picking':
        return '$(git-commit)';
      case 'reverting':
        return '$(discard)';
      default:
        return '';
    }
  }

  /**
   * Get the current status bar state.
   *
   * @returns The current status bar state
   */
  getState(): IStatusBarState {
    return { ...this._state };
  }

  /**
   * Set the click action for the status bar item.
   *
   * @param action - The action to perform when clicked
   */
  setClickAction(action: StatusBarClickAction): void {
    switch (action) {
      case 'branch-popup':
        this._statusBarItem.command = 'intellig.showBranchPopup';
        break;
      case 'sync':
        this._statusBarItem.command = 'intellig.sync';
        break;
      case 'none':
        this._statusBarItem.command = undefined;
        break;
    }
  }

  /**
   * Set the command to execute when the status bar item is clicked.
   * Requirement: Click on the status bar item to open the branch popup
   *
   * @param command - The VS Code command ID to execute
   */
  setCommand(command: string): void {
    this._statusBarItem.command = command;
  }

  /**
   * Set the tooltip text for the status bar item.
   *
   * @param tooltip - The tooltip text or MarkdownString
   */
  setTooltip(tooltip: string | vscode.MarkdownString): void {
    this._statusBarItem.tooltip = tooltip;
  }

  /**
   * Dispose of the status bar service and its resources.
   */
  dispose(): void {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = undefined;
    }
    for (const disposable of this._disposables) {
      disposable.dispose();
    }
    this._disposables = [];
  }
}

/**
 * Create a new StatusBarService instance.
 *
 * @param gitService - The Git service to use for repository information
 * @param options - Display options for the status bar item
 * @param refreshDebounceMs - Debounce window for refresh coalescing (default
 *   150ms). Tests pass `0` for immediate refresh.
 * @returns A new StatusBarService instance
 */
export function createStatusBarService(
  gitService: IGitService,
  options?: IStatusBarDisplayOptions,
  refreshDebounceMs?: number
): StatusBarService {
  return new StatusBarService(gitService, options, refreshDebounceMs);
}

/**
 * Exhaustiveness sentinel for the {@link StatusBarService._getInProgressVerb}
 * switch. Adding a new value to `RepositoryState` (e.g. `'bisecting'`)
 * without extending the switch triggers a compile-time error here; at
 * runtime, an unreachable arm downgrades to an empty verb (status-bar
 * falls back to the bare icon) rather than throwing — failures here are
 * cosmetic, not correctness.
 */
function assertNeverInProgressKind(_kind: never): string {
  return '';
}
