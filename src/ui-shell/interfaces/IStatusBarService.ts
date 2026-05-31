/**
 * Status Bar Service interface.
 * Provides status bar integration for displaying Git information.
 */

import * as vscode from 'vscode';
import { IRepository, RepositoryState } from '../../git-core/interfaces/IGitService';

/**
 * Status bar item click action types
 */
export type StatusBarClickAction = 'branch-popup' | 'sync' | 'none';

/**
 * Status bar display options
 */
export interface IStatusBarDisplayOptions {
  /** Whether to show the branch name */
  showBranchName?: boolean;
  /** Whether to show ahead/behind counts */
  showSyncStatus?: boolean;
  /** Priority for status bar item positioning (higher = more left) */
  priority?: number;
  /** Alignment of the status bar item */
  alignment?: vscode.StatusBarAlignment;
}

/**
 * Status bar state information
 */
export interface IStatusBarState {
  /** Current branch name (without refs/heads/ prefix) */
  branchName?: string;
  /** Number of commits ahead of upstream */
  ahead: number;
  /** Number of commits behind upstream */
  behind: number;
  /** Whether the repository is in detached HEAD state */
  isDetached: boolean;
  /** Short commit hash (for detached HEAD state) */
  commitHash?: string;
  /** Whether there is an upstream configured */
  hasUpstream: boolean;
  /** Repository state (idle, merging, rebasing, etc.) */
  repositoryState: string;
  /**
   * True when the repository has a symbolic HEAD (`head.name` set) but no
   * commits yet. Surfaced as `(no commits yet)` suffix in the status-bar
   * label so the user knows the initial branch is configured but their
   * first commit has not landed. Mirrors the existing `isDetached`
   * precedent.
   */
  isEmptyRepo: boolean;
  /**
   * When the repo is mid-merge / mid-rebase / mid-cherry-pick / mid-revert,
   * the verb-form prefix and target name to render. Sourced from
   * `IRepository.inProgress`. Undefined when the repo is idle. `kind` is
   * typed as `Exclude<RepositoryState, 'idle'>` so the StatusBar's verb
   * switch can be exhaustively checked at compile time.
   */
  inProgress?: { kind: Exclude<RepositoryState, 'idle'>; target?: string };
}

/**
 * Status Bar Service interface.
 * Manages the Git status bar item that displays branch and sync information.
 *
 * - 4.1: Display current branch name in status bar
 * - 17.8: Display progress and status notifications similar to IntelliJ
 */
export interface IStatusBarService {
  /**
   * Show the status bar item.
   */
  show(): void;

  /**
   * Hide the status bar item.
   */
  hide(): void;

  /**
   * Update the status bar with the current repository state.
   *
   * @param repository - The repository to display status for
   */
  update(repository: IRepository): void;

  /**
   * Get the current status bar state.
   *
   * @returns The current status bar state
   */
  getState(): IStatusBarState;

  /**
   * Set the click action for the status bar item.
   *
   * @param action - The action to perform when clicked
   */
  setClickAction(action: StatusBarClickAction): void;

  /**
   * Set the command to execute when the status bar item is clicked.
   *
   * @param command - The VS Code command ID to execute
   */
  setCommand(command: string): void;

  /**
   * Set the tooltip text for the status bar item.
   *
   * @param tooltip - The tooltip text or MarkdownString
   */
  setTooltip(tooltip: string | vscode.MarkdownString): void;

  /**
   * Event fired when the status bar state changes.
   */
  readonly onDidChangeState: vscode.Event<IStatusBarState>;

  /**
   * Dispose of the status bar service and its resources.
   */
  dispose(): void;
}
