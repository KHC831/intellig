import * as vscode from 'vscode';
import { IRepository } from '../../git-core/interfaces/IGitService';
import type { IPreApplyState } from '../../git-core/ops/preservedChanges';
import { IConflictSideNames, IStageNames } from '../conflictSideNames';

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
  /**
   * Human-readable name for each conflict side ("Accept from {yours/theirs}").
   * Resolved and filled in by the service when it opens the dialog; callers
   * that build the context don't set it. Absent ⇒ the dialog shows the generic
   * "Accept Yours"/"Accept Theirs".
   */
  sideNames?: IConflictSideNames;
  /**
   * Pre-apply restore token for `operation: 'applyPatch'` — set when the
   * apply took a working-state snapshot before running. Its presence turns
   * the dialog's Abort into a FULL pre-apply restore (cleanly-applied
   * sibling files included) via
   * {@link IConflictResolutionService.restorePreApplyState}; absent, Abort
   * falls back to restoring only the unresolved paths.
   */
  preApplyState?: IPreApplyState;
  /**
   * Set when the apply could not snapshot the working tree. Abort then has no
   * pre-apply state to restore and can only revert the unresolved paths, so
   * the dialog warns instead of reporting the apply as fully undone.
   */
  preApplySnapshotFailed?: boolean;
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
  /**
   * Error message if operation failed. DISPLAY-READY: pre-sanitized at the
   * source (`sanitizeGitError`), so consumers may toast it directly. Sanitizing
   * here rather than per-consumer is deliberate — several palette toasts render
   * `result.error` raw, outside the reach of the toast-sanitizer structural
   * guard.
   */
  error?: string;
  /**
   * The call was a benign no-op dropped by a re-entrancy guard (a concurrent
   * bulk accept-all was already running). Not a success and not an error —
   * handlers should stay silent rather than toast.
   */
  skipped?: boolean;
}

/**
 * Merge/Rebase completion result
 */
export interface IOperationCompletionResult {
  /** Whether the operation completed successfully */
  success: boolean;
  /** Error message if operation failed. DISPLAY-READY (pre-sanitized) — see
   * {@link IConflictResolutionResult.error}. */
  error?: string;
  /** Any remaining conflicted files */
  remainingConflicts?: string[];
  /**
   * Rebase terminals only: `true` when git's `--autostash` reapply conflicted
   * and the entry was PARKED as a normal stash (data-safe; git reset the tree
   * first). Consumers surface the shared AUTOSTASH_PARKED_WARNING copy.
   */
  autostashParked?: boolean;
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
   * Send a RESOLVED file back to conflicted state (`git checkout --merge`)
   * so a mis-resolution can be redone — the inverse of the accepts. Git
   * refuses when the file has no resolve-undo data or no operation is in
   * progress.
   */
  unresolveFile(repo: IRepository, filePath: string): Promise<IConflictResolutionResult>;

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
   * Abort an unshelve / unstash / apply-patch conflict by restoring the given
   * conflicted paths to HEAD (those ops have no git-level `--abort`).
   */
  abortWorkingTreeConflicts(
    repo: IRepository,
    paths: string[]
  ): Promise<IOperationCompletionResult>;

  /**
   * Abort a patch apply by restoring the FULL pre-apply state from the
   * bracket token: patch-touched paths come back from the snapshot (or HEAD
   * when the tree was clean), patch-created files are removed. Paths the
   * patch never touched are left alone.
   */
  restorePreApplyState(
    repo: IRepository,
    state: IPreApplyState
  ): Promise<IOperationCompletionResult>;

  /**
   * Continue a paused `git am` session after conflict resolution
   * (`git am --continue`) — the applyPatch analog of {@link completeRebase}.
   * Further conflicts (the next mailbox patch collided) come back in
   * `remainingConflicts`.
   */
  continueAmSession(repo: IRepository): Promise<IOperationCompletionResult>;

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
  ): 'idle' | 'merging' | 'rebasing' | 'applying' | 'cherry-picking' | 'reverting';

  /**
   * The operation that produced the repo's live conflict, recorded when the
   * dialog first opened. Callers re-opening the dialog must prefer this over a
   * `repo.state` guess so unstash/unshelve/applyPatch (all `repo.state ===
   * 'idle'`) keep their ours/theirs reversal. `undefined` when nothing is
   * recorded.
   */
  getRecordedOperation(repo: IRepository): IConflictOpContext['operation'] | undefined;

  /**
   * Resolve a human-readable name for each conflict side ("Accept from
   * {yours}" / "{theirs}"). Reversal-correct per operation; walks the
   * branch-name → short-SHA → generic fallback ladder. Uses the recorded
   * operation when `operation` is omitted. Never throws.
   */
  getConflictSideNames(
    repo: IRepository,
    operation?: IConflictOpContext['operation']
  ): Promise<IConflictSideNames>;

  /**
   * The resolved operation plus the RAW stage names (stage 2 = ours,
   * stage 3 = theirs, unswapped). For consumers that pair names with stage
   * contents and run one reversal mapping over both — the merge window's
   * pane assignment. Uses the recorded operation when `operation` is
   * omitted. Never throws.
   */
  getConflictStageContext(
    repo: IRepository,
    operation?: IConflictOpContext['operation']
  ): Promise<{ operation: IConflictOpContext['operation']; stageNames: IStageNames }>;

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
   * (driving the status-bar prompt) and does not open a dialog — UNLESS
   * `options.explicit` is set. Automatic post-op callers omit it (they respect
   * the opt-out); a user-initiated open (status-bar prompt / VCS menu) passes
   * `{ explicit: true }` so the config only governs automatic opening.
   */
  openResolveConflictsDialog(
    repo: IRepository,
    conflicts: IConflictedFile[],
    opContext: IConflictOpContext,
    options?: { explicit?: boolean }
  ): Promise<void>;

  /**
   * Dispose of resources
   */
  dispose(): void;
}
