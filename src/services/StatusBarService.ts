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
import { IGitService, IRepository } from './interfaces/IGitService';

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
 * Status Bar Service implementation.
 * Manages the Git status bar item that displays branch and sync information.
 *
 * - 4.1: Display current branch name in status bar
 * - 17.8: Display progress and status notifications similar to IntelliJ
 */
export class StatusBarService implements IStatusBarService {
  private _statusBarItem: vscode.StatusBarItem;
  private _gitService: IGitService;
  private _state: IStatusBarState;
  private _options: Required<IStatusBarDisplayOptions>;
  private _disposables: vscode.Disposable[] = [];
  private _onDidChangeState: vscode.EventEmitter<IStatusBarState>;

  /**
   * Event fired when the status bar state changes.
   */
  readonly onDidChangeState: vscode.Event<IStatusBarState>;

  /**
   * Create a new StatusBarService instance.
   *
   * @param gitService - The Git service to use for repository information
   * @param options - Display options for the status bar item
   */
  constructor(gitService: IGitService, options?: IStatusBarDisplayOptions) {
    this._gitService = gitService;
    this._options = { ...DEFAULT_OPTIONS, ...options };

    // Initialize state
    this._state = {
      ahead: 0,
      behind: 0,
      isDetached: false,
      hasUpstream: false,
      repositoryState: 'idle',
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
    this._statusBarItem.command = 'intellig.showBranchPopup';
    this._statusBarItem.tooltip = 'Click to manage branches';
    this._disposables.push(this._statusBarItem);

    // Listen for repository changes to update status bar
    this._disposables.push(
      this._gitService.onDidChangeRepository((repo) => {
        this.update(repo);
      })
    );

    // Initialize with current repository
    void this._initialize();
  }

  /**
   * Initialize the status bar with current repository info.
   */
  private async _initialize(): Promise<void> {
    const repositories = this._gitService.getRepositories();
    if (repositories.length > 0) {
      this.update(repositories[0]);
    } else {
      // Try to discover repository from workspace
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders && workspaceFolders.length > 0) {
        const repo = await this._gitService.getRepository(workspaceFolders[0].uri);
        if (repo) {
          this.update(repo);
        } else {
          // No repository found - hide status bar
          this.hide();
        }
      } else {
        // No workspace folders - hide status bar
        this.hide();
      }
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
    };

    if (repository.head) {
      if (repository.head.name) {
        // Normal branch state
        state.branchName = repository.head.name.replace('refs/heads/', '');
        state.isDetached = false;
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
      a.repositoryState === b.repositoryState
    );
  }

  /**
   * Update the status bar display based on current state.
   * - 4.1: Display current branch name in status bar
   * - Show ahead/behind counts if the branch has an upstream (e.g., "main ↑2 ↓1")
   */
  private _updateDisplay(): void {
    const { branchName, ahead, behind, isDetached, commitHash, hasUpstream, repositoryState } =
      this._state;

    // Build status text
    let statusText = '';
    let tooltip = '';

    if (isDetached) {
      // Detached HEAD state
      statusText = `$(git-commit) ${commitHash || 'HEAD'}`;
      tooltip = 'Detached HEAD - Click to manage branches';
    } else if (branchName) {
      // Normal branch state with git branch icon
      statusText = `$(git-branch) ${branchName}`;
      tooltip = `Branch: ${branchName}`;

      // Add ahead/behind indicators if upstream is configured
      // Requirement: Show ahead/behind counts if the branch has an upstream
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

        // Update tooltip with sync info
        if (ahead > 0 || behind > 0) {
          tooltip += `\n${ahead} commit(s) ahead, ${behind} commit(s) behind`;
        } else {
          tooltip += '\nUp to date with upstream';
        }
      } else if (!hasUpstream) {
        tooltip += '\nNo upstream configured';
      }
    } else {
      // No commits yet
      statusText = '$(git-branch) No commits yet';
      tooltip = 'No commits yet - Click to manage branches';
    }

    // Add repository state indicator if not idle
    if (repositoryState !== 'idle') {
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
 * @returns A new StatusBarService instance
 */
export function createStatusBarService(
  gitService: IGitService,
  options?: IStatusBarDisplayOptions
): StatusBarService {
  return new StatusBarService(gitService, options);
}
