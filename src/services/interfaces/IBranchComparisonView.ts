/**
 * Branch Comparison View interface.
 * Defines the contract for the branch comparison UI component.
 *
 * Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6
 */

import * as vscode from 'vscode';
import { IRepository, ICommit, IBranchComparison } from './IGitService';

/**
 * State for the branch comparison view
 */
export interface IBranchComparisonViewState {
  /** The first branch being compared (typically current branch) */
  branch1: string | undefined;
  /** The second branch being compared */
  branch2: string | undefined;
  /** The comparison result */
  comparison: IBranchComparison | undefined;
  /** Whether the view is currently loading */
  loading: boolean;
  /** Error message if any */
  error: string | undefined;
}

/**
 * Result from showing the branch comparison view
 */
export interface IBranchComparisonResult {
  /** Whether a comparison was performed */
  compared: boolean;
  /** The first branch that was compared */
  branch1?: string;
  /** The second branch that was compared */
  branch2?: string;
  /** The comparison data */
  comparison?: IBranchComparison;
}

/**
 * Action types for branch comparison context menu
 */
export type BranchComparisonAction = 'view-diff' | 'view-commit' | 'swap-branches' | 'refresh';

/**
 * Result from a branch comparison action
 */
export interface IBranchComparisonActionResult {
  /** Whether the action succeeded */
  success: boolean;
  /** The action that was performed */
  action?: BranchComparisonAction;
  /** Error message if the action failed */
  error?: string;
}

/**
 * Branch Comparison View interface.
 * Provides branch comparison functionality with UI for selecting branches,
 * viewing commits unique to each branch, and viewing file differences.
 *
 * Requirements:
 * - 15.1: Prompt for target branch to compare
 * - 15.2: Display commits unique to each branch
 * - 15.3: Display files that differ between branches
 * - 15.4: Display diff for selected file
 * - 15.5: Compare with remote tracking branch
 * - 15.6: Show ahead/behind commit counts
 */
export interface IBranchComparisonView {
  /**
   * Event fired when the comparison changes
   */
  readonly onDidChangeComparison: vscode.Event<IBranchComparison | undefined>;

  /**
   * Event fired when a file is selected for diff viewing
   */
  readonly onDidSelectFile: vscode.Event<string>;

  /**
   * Event fired when a commit is selected for viewing
   */
  readonly onDidSelectCommit: vscode.Event<ICommit>;

  /**
   * Show the branch comparison view.
   * Requirement 15.1: Prompt for target branch to compare
   *
   * @param repository - The repository to compare branches in
   * @param branch1 - Optional first branch (defaults to current branch)
   * @param branch2 - Optional second branch (will prompt if not provided)
   * @returns Promise resolving to the comparison result
   */
  show(
    repository: IRepository,
    branch1?: string,
    branch2?: string
  ): Promise<IBranchComparisonResult>;

  /**
   * Hide the branch comparison view.
   */
  hide(): void;

  /**
   * Refresh the comparison with current branches.
   */
  refresh(): Promise<void>;

  /**
   * Get the current state of the branch comparison view.
   */
  getState(): IBranchComparisonViewState;

  /**
   * Set the branches to compare.
   *
   * @param branch1 - The first branch
   * @param branch2 - The second branch
   */
  setBranches(branch1: string, branch2: string): Promise<void>;

  /**
   * Swap the two branches being compared.
   */
  swapBranches(): Promise<void>;

  /**
   * Compare with remote tracking branch.
   * Requirement 15.5: Compare local branch with its remote tracking branch
   *
   * @param repository - The repository
   * @param localBranch - The local branch to compare (defaults to current)
   * @returns Promise resolving to the comparison result
   */
  compareWithRemote(
    repository: IRepository,
    localBranch?: string
  ): Promise<IBranchComparisonResult>;

  /**
   * View the diff for a specific file between the two branches.
   * Requirement 15.4: Display diff for selected file
   *
   * @param filePath - The file path to view diff for
   */
  viewFileDiff(filePath: string): Promise<void>;

  /**
   * View details of a specific commit.
   *
   * @param commit - The commit to view
   */
  viewCommit(commit: ICommit): Promise<void>;

  /**
   * Dispose of resources.
   */
  dispose(): void;
}
