import * as vscode from 'vscode';
import { IRepository } from '../../git-core/interfaces/IGitService';

/**
 * Operation context carried through a conflict-producing git op. Describes the
 * operation that produced the conflicts and which top-level actions are
 * available to the user. Consumed by the Resolve Conflicts dialog and its
 * callers.
 */
export interface IConflictOpContext {
  /** Which git operation produced these conflicts. */
  operation: 'merge' | 'rebase' | 'cherryPick' | 'revert' | 'unshelve' | 'unstash' | 'applyPatch';
  /** Optional human-readable target (branch, tag, shelf name…) shown in the title. */
  target?: string;
  /** Whether the `Abort {Op}` button should be available. */
  canAbort: boolean;
  /** Whether the `Continue` button should be available. */
  canContinue: boolean;
}

/**
 * Conflicted file information
 */
export interface IConflictedFile {
  /** The file path relative to repository root */
  path: string;
  /** Whether the file has been marked as resolved */
  resolved: boolean;
}

/**
 * Conflict resolution result
 */
export interface IConflictResolutionResult {
  /** Whether the operation was successful */
  success: boolean;
  /** Error message if operation failed */
  error?: string;
}

/**
 * Result of {@link IConflictResolutionService.acceptNonConflictingChanges}.
 * Adds enough detail for the caller to give feedback when the operation is a
 * no-op (a pure conflict with nothing one-sided to apply) instead of silently
 * doing nothing.
 */
export interface INonConflictingResult extends IConflictResolutionResult {
  /** Whether the file is now fully merged (no conflict hunks remain) and staged. */
  fullyResolved?: boolean;
  /** Number of true-conflict hunks still left in the file (0 when fully resolved). */
  remainingHunks?: number;
}

/**
 * Merge/Rebase completion result
 */
export interface IOperationCompletionResult {
  /** Whether the operation completed successfully */
  success: boolean;
  /** Error message if operation failed */
  error?: string;
  /** Any remaining conflicted files */
  remainingConflicts?: string[];
}

/**
 * Conflict Resolution Service interface
 * Provides conflict detection, resolution, and merge/rebase completion functionality
 */
export interface IConflictResolutionService {
  /**
   * Get all conflicted files in the repository
   *
   * @param repo - The repository
   * @returns Array of conflicted files
   */
  getConflictedFiles(repo: IRepository): Promise<IConflictedFile[]>;

  /**
   * Check if the repository has any unresolved conflicts
   *
   * @param repo - The repository
   * @returns True if there are unresolved conflicts
   */
  hasUnresolvedConflicts(repo: IRepository): Promise<boolean>;

  /**
   * Mark a file as resolved
   *
   * @param repo - The repository
   * @param filePath - The file path to mark as resolved
   * @returns Resolution result
   */
  markResolved(repo: IRepository, filePath: string): Promise<IConflictResolutionResult>;

  /**
   * Mark multiple files as resolved
   *
   * @param repo - The repository
   * @param filePaths - Array of file paths to mark as resolved
   * @returns Resolution result
   */
  markMultipleResolved(repo: IRepository, filePaths: string[]): Promise<IConflictResolutionResult>;

  /**
   * Accept the user's own ("Yours") version for a file and mark as resolved.
   *
   * During a rebase or unstash/unshelve git swaps the index sides — stage 2
   * (`--ours`) is the branch being replayed onto, stage 3 (`--theirs`) is the
   * user's own commit. Pass `reversed: true` so "Yours" still takes the user's
   * work. When omitted, reversal is auto-detected from `repo.state === 'rebasing'`.
   *
   * @param repo - The repository
   * @param filePath - The file path
   * @param reversed - Whether ours/theirs are swapped (rebase/unstash/unshelve)
   * @returns Resolution result
   */
  acceptCurrent(
    repo: IRepository,
    filePath: string,
    reversed?: boolean
  ): Promise<IConflictResolutionResult>;

  /**
   * Accept the incoming ("Theirs") version for a file and mark as resolved.
   * See {@link acceptCurrent} for the `reversed` semantics.
   *
   * @param repo - The repository
   * @param filePath - The file path
   * @param reversed - Whether ours/theirs are swapped (rebase/unstash/unshelve)
   * @returns Resolution result
   */
  acceptIncoming(
    repo: IRepository,
    filePath: string,
    reversed?: boolean
  ): Promise<IConflictResolutionResult>;

  /**
   * Accept every change in a conflicted file that does not actually conflict
   * (the regions exactly one side edited), leaving the true conflicts (regions
   * both sides changed) for the user. Mirrors IntelliJ's
   * "Apply Non-Conflicting Changes" (platform/diff-impl `ApplyNonConflictsAction`).
   *
   * @param repo - The repository
   * @param filePath - Repo-relative path of the conflicted file
   * @returns Resolution result
   */
  acceptNonConflictingChanges(repo: IRepository, filePath: string): Promise<INonConflictingResult>;

  /**
   * Accept the user's own ("Yours") version for all conflicted files.
   * See {@link acceptCurrent} for the `reversed` semantics.
   *
   * @param repo - The repository
   * @param reversed - Whether ours/theirs are swapped (rebase/unstash/unshelve)
   * @returns Resolution result
   */
  acceptAllCurrent(repo: IRepository, reversed?: boolean): Promise<IConflictResolutionResult>;

  /**
   * Accept the incoming ("Theirs") version for all conflicted files.
   * See {@link acceptCurrent} for the `reversed` semantics.
   *
   * @param repo - The repository
   * @param reversed - Whether ours/theirs are swapped (rebase/unstash/unshelve)
   * @returns Resolution result
   */
  acceptAllIncoming(repo: IRepository, reversed?: boolean): Promise<IConflictResolutionResult>;

  /**
   * Check if merge/rebase can be completed (all conflicts resolved)
   *
   * @param repo - The repository
   * @returns True if operation can be completed
   */
  canCompleteOperation(repo: IRepository): Promise<boolean>;

  /**
   * Complete the current merge operation
   *
   * @param repo - The repository
   * @returns Completion result
   */
  completeMerge(repo: IRepository): Promise<IOperationCompletionResult>;

  /**
   * Complete the current rebase operation
   *
   * @param repo - The repository
   * @returns Completion result
   */
  completeRebase(repo: IRepository): Promise<IOperationCompletionResult>;

  /**
   * Abort the current merge operation
   *
   * @param repo - The repository
   * @returns Completion result
   */
  abortMerge(repo: IRepository): Promise<IOperationCompletionResult>;

  /**
   * Abort the current rebase operation
   *
   * @param repo - The repository
   * @returns Completion result
   */
  abortRebase(repo: IRepository): Promise<IOperationCompletionResult>;

  /**
   * Get the current repository state (merging, rebasing, etc.)
   *
   * @param repo - The repository
   * @returns The repository state
   */
  getRepositoryState(
    repo: IRepository
  ): 'idle' | 'merging' | 'rebasing' | 'cherry-picking' | 'reverting';

  /**
   * The operation that produced the repo's live conflict, recorded when the
   * dialog first opened. Callers re-opening the dialog must prefer this over a
   * `repo.state` guess so unstash/unshelve/applyPatch (all `repo.state ===
   * 'idle'`) keep their ours/theirs reversal. `undefined` when nothing is
   * recorded.
   */
  getRecordedOperation(repo: IRepository): IConflictOpContext['operation'] | undefined;

  /**
   * Event fired when conflicts change
   */
  onDidChangeConflicts: vscode.Event<{ repo: IRepository; conflicts: IConflictedFile[] }>;

  /**
   * Open (or reveal + update) the Resolve Conflicts dialog for a repository.
   * Invoked by callers that just completed a conflict-producing git op
   * (merge / rebase / cherry-pick / revert / unshelve / unstash) — see
   * caller-invoked pattern in design REVIEW.md section 1.5.
   *
   * When the `intellig.autoOpenResolveConflictsDialog` config is `false`,
   * this method only publishes the `intellig.conflicts.active` context key
   * (driving the status-bar prompt) and does not open a dialog.
   */
  openResolveConflictsDialog(
    repo: IRepository,
    conflicts: IConflictedFile[],
    opContext: IConflictOpContext
  ): Promise<void>;

  /**
   * Dispose of resources
   */
  dispose(): void;
}
