/**
 * Branch Comparison View interface.
 * Defines the contract for the branch comparison UI component.
 */

import * as vscode from 'vscode';
import { IRepository, ICommit, IBranchComparison } from '../../git-core/interfaces/IGitService';

/**
 * State for the branch comparison view.
 *
 * Deliberately carries no `error` field. Refresh failures are surfaced
 * through the `{ error? }` return value of {@link IBranchComparisonView.refresh}
 * (and {@link IBranchComparisonView.setBranches}) at every call site; a
 * sideband on the view state would be a latent mirror that callers could
 * accidentally read after the canonical channel had already been handled.
 * See ADR-006 (`docs/adr/`) and {@link IBranchComparisonView.refresh}
 * for the contract.
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
   *
   * Resolves to an object describing the outcome. On success, `error` is
   * undefined. On failure (compareBranches throws), `error` contains a
   * human-readable, sanitized message suitable for a toast or
   * OutputChannel line. Never rejects — every caller (sync or async)
   * handles the outcome by reading the returned object, which makes
   * failure propagation explicit at every call site.
   *
   * Per ADR-006 (`docs/adr/ADR-006-error-state-binding-by-view-type.md`),
   * this QuickPick view binds errors through the refresh return value
   * rather than a `_state.error` sideband. Pre-Wave-8 the sideband was
   * the canonical channel and only `show()` read it; downstream callers
   * (post-swap, post-refresh-action paths) silently swallowed the error.
   * The `{ error? }` shape fixes that by making the outcome explicit at
   * every call site.
   */
  refresh(): Promise<{ error?: string }>;

  /**
   * Get the current state of the branch comparison view.
   */
  getState(): IBranchComparisonViewState;

  /**
   * Set the branches to compare.
   *
   * Performs the comparison as a side effect. Resolves to the same
   * `{ error? }` shape as {@link refresh} — see ADR-006 for the
   * canonical-channel rule.
   *
   * @param branch1 - The first branch
   * @param branch2 - The second branch
   */
  setBranches(branch1: string, branch2: string): Promise<{ error?: string }>;

  /**
   * Swap the two branches being compared.
   *
   * Resolves to the same `{ error? }` shape as {@link refresh}. On
   * success, the comparison QuickPick is re-rendered with the swapped
   * result; on error, callers should surface `result.error` themselves
   * since the implementation only emits the toast inside
   * `_performComparison` and skips the re-render to avoid showing a
   * stale picker over a known-failed comparison.
   */
  swapBranches(): Promise<{ error?: string }>;

  /**
   * Compare with remote tracking branch.
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
