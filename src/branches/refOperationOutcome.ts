/**
 * The outcome ladder shared by every branch-menu ref operation that can end in
 * conflicts — merge and cherry-pick, for both branch and tag refs.
 *
 * All four sites answer the same three-way result the same way: success gets
 * the caller's toast, conflicts go to the Resolve Conflicts dialog (a warning
 * toast only when no service is wired), and a non-conflict failure surfaces
 * git's own reason rather than dead-ending silently. Keeping that ladder in
 * one place is what stops the copies drifting — a mislabelled `operation`
 * sends the dialog the wrong ours/theirs orientation, and a dropped reason
 * turns a real git refusal into a no-op.
 */

import * as vscode from 'vscode';
import type { IRepository } from '../git-core/interfaces/IGitService';
import type { IConflictResolutionService } from '../conflicts/interfaces/IConflictResolutionService';
import { sanitizeGitError } from '../git-core/gitError';

/** The slice of a git result this ladder reads. */
export interface IRefOperationResult {
  readonly success: boolean;
  readonly conflicts?: string[];
  readonly failureReason?: string;
}

/**
 * The conflict seam each action module reaches back into the dispatcher for.
 * The service is setter-wired and every arm consults it after an await, so it
 * is a call-time getter; the dialog itself stays on the dispatcher, which is
 * the sole live reader of that service.
 */
export interface IRefOperationConflictContext {
  conflictResolutionService(): IConflictResolutionService | undefined;
  openResolveConflictsDialog(
    repo: IRepository,
    conflicts: string[],
    opContext: {
      operation: 'merge' | 'rebase' | 'cherryPick' | 'revert';
      target?: string;
      rebaseInProgress?: boolean;
    }
  ): Promise<void>;
}

/** Forward operations that share this ladder, and how each names itself. */
const CONFLICT_LABEL = {
  merge: 'Merge',
  cherryPick: 'Cherry-pick',
} as const;

/** What differs per site: the ref, the wording, and what success means. */
export interface IRefOperationSpec {
  readonly operation: keyof typeof CONFLICT_LABEL;
  /** Ref the operation ran against — the dialog shows it, so it must be exact. */
  readonly target: string;
  /** Error-toast prefix, e.g. `Failed to merge 'feature'`. */
  readonly failurePrefix: string;
  /**
   * Runs on success. A callback rather than a message because the merge site
   * may offer to delete the merged branch instead of plain-toasting.
   */
  onSuccess(): void;
}

/**
 * Route one merge / cherry-pick result. Neither operation reverses ours and
 * theirs (both replay the source onto HEAD), so the dialog gets the operation
 * verbatim.
 */
export async function routeRefOperationOutcome(
  ctx: IRefOperationConflictContext,
  repo: IRepository,
  result: IRefOperationResult,
  spec: IRefOperationSpec
): Promise<void> {
  if (result.success) {
    spec.onSuccess();
    return;
  }

  if (result.conflicts && result.conflicts.length > 0) {
    if (ctx.conflictResolutionService()) {
      await ctx.openResolveConflictsDialog(repo, result.conflicts, {
        operation: spec.operation,
        target: spec.target,
      });
    } else {
      void vscode.window.showWarningMessage(
        `${CONFLICT_LABEL[spec.operation]} conflicts in ${result.conflicts.length} file(s). ` +
          `Please resolve conflicts.`
      );
    }
    return;
  }

  // `failureReason` is sanitized at the GitService boundary; re-piping it here
  // keeps the safety contract evident at the toast site.
  const reason = result.failureReason ?? 'unknown error (no output from git)';
  void vscode.window.showErrorMessage(`${spec.failurePrefix}: ${sanitizeGitError(reason)}`);
}

/** A rebase result also says whether the rebase is still in progress. */
export interface IRebaseOperationResult extends IRefOperationResult {
  readonly rebaseInProgress?: boolean;
}

/** The rebase-conflict seam; the dispatcher owns continuability routing. */
export interface IRebaseOutcomeContext {
  surfaceRebaseConflicts(
    repo: IRepository,
    conflicts: string[],
    target: string,
    canContinue?: boolean
  ): Promise<void>;
}

/**
 * Route one rebase result. Conflicts go to `surfaceRebaseConflicts` rather
 * than straight to the dialog: only it knows that an `--autostash` pop
 * conflict (`rebaseInProgress === false`) must suppress continue and abort,
 * which would otherwise dead-end on "no rebase in progress".
 */
export async function routeRebaseOutcome(
  ctx: IRebaseOutcomeContext,
  repo: IRepository,
  result: IRebaseOperationResult,
  spec: { onto: string; successMessage: string }
): Promise<void> {
  if (result.success) {
    void vscode.window.showInformationMessage(spec.successMessage);
    return;
  }

  if (result.conflicts && result.conflicts.length > 0) {
    await ctx.surfaceRebaseConflicts(repo, result.conflicts, spec.onto, result.rebaseInProgress);
    return;
  }

  const reason = result.failureReason ?? 'unknown error (no output from git)';
  void vscode.window.showErrorMessage(
    `Failed to rebase onto '${spec.onto}': ${sanitizeGitError(reason)}`
  );
}
