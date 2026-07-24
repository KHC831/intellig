/**
 * Merge and rebase-onto actions for the branch context menu: "Merge into
 * Current" and "Rebase Current onto Selected". Both prefer their dialog when
 * an opener is wired and otherwise run the op directly, handing conflicts to
 * the Resolve Conflicts dialog. Reaches back into the dispatcher through
 * {@link IBranchMergeRebaseContext}.
 */

import * as vscode from 'vscode';
import type { IGitService, IRepository } from '../git-core/interfaces/IGitService';
import type { BranchTreeProvider } from './BranchTreeProvider';
import type { IConflictResolutionService } from '../conflicts/interfaces/IConflictResolutionService';
import type { MergeDialogOpener, RebaseDialogOpener } from './BranchContextMenuCommands';
import { sanitizeGitError } from '../git-core/gitError';
import { readConfig } from '../config/configKeys';
import { isProtectedTarget } from '../sync/PushDialog';
import { proposeDeleteMergedBranch } from './deleteOnMerge';
import type { ITreeItemRunArgs } from '../commands/registration/commandSpine';

/** Deps the merge / rebase-onto actions reach back into the dispatcher for. */
export interface IBranchMergeRebaseContext {
  readonly gitService: IGitService;
  readonly branchTreeProvider: BranchTreeProvider;
  readonly mergeDialogOpener: MergeDialogOpener | undefined;
  readonly rebaseDialogOpener: RebaseDialogOpener | undefined;
  /** Call-time read: the conflict service is setter-wired and both arms consult it post-await. */
  conflictResolutionService(): IConflictResolutionService | undefined;
  /** The resolve-dialog seam stays on the dispatcher; both arms route through it. */
  openResolveConflictsDialog(
    repo: IRepository,
    conflicts: string[],
    opContext: {
      operation: 'merge' | 'rebase' | 'cherryPick' | 'revert';
      target?: string;
      rebaseInProgress?: boolean;
    }
  ): Promise<void>;
  surfaceRebaseConflicts(
    repo: IRepository,
    conflicts: string[],
    target: string,
    canContinue?: boolean
  ): Promise<void>;
}

/**
 * Handle merge into current command.
 */
export async function handleMergeIntoCurrent(
  ctx: IBranchMergeRebaseContext,
  { repo, target }: ITreeItemRunArgs<'branch'>
): Promise<void> {
  // deleteOnMerge = PROPOSE for a non-protected local branch
  // (GitBranchPopupActions.java:287-291); tags route through
  // _handleTagMergeIntoCurrent and never propose.
  const proposeDeleteOnMerge =
    target.branch.type === 'local' &&
    !target.branch.isHead &&
    !isProtectedTarget(target.branch.name, readConfig('protectedBranches'));

  // Route through the Merge Dialog when the opener is wired; the
  // dialog handles options (ff-only / no-ff / squash / no-commit / -m),
  // conflict handoff, and the PROPOSE affordance itself. Fallback path
  // (no opener) preserves the legacy direct-merge behaviour for tests.
  if (ctx.mergeDialogOpener) {
    ctx.mergeDialogOpener({ repo, sourceBranch: target.branch.name, proposeDeleteOnMerge });
    return;
  }

  try {
    const result = await ctx.gitService.mergeBranch(repo, target.branch.name);

    if (result.success) {
      const successMessage = `Merged '${target.branch.name}' successfully`;
      if (proposeDeleteOnMerge) {
        // Fire-and-forget: the PROPOSE toast must not hold the command.
        void proposeDeleteMergedBranch(
          { gitService: ctx.gitService, onDeleted: () => ctx.branchTreeProvider.refresh() },
          repo,
          target.branch.name,
          successMessage
        );
      } else {
        void vscode.window.showInformationMessage(successMessage);
      }
    } else if (result.conflicts && result.conflicts.length > 0) {
      // Auto-open Resolve Conflicts dialog when wired; fall back
      // to a warning toast otherwise (legacy callers without the service).
      if (ctx.conflictResolutionService()) {
        await ctx.openResolveConflictsDialog(repo, result.conflicts, {
          operation: 'merge',
          target: target.branch.name,
        });
      } else {
        void vscode.window.showWarningMessage(
          `Merge conflicts in ${result.conflicts.length} file(s). Please resolve conflicts.`
        );
      }
    } else {
      // Non-conflict failure (refused merge, unrelated histories, dirty
      // tree, etc.). Surface the underlying git error instead of a
      // silent no-op. `failureReason` is sanitized at the GitService
      // boundary; safe to drop straight into a toast.
      const reason = result.failureReason ?? 'unknown error (no output from git)';
      void vscode.window.showErrorMessage(
        `Failed to merge '${target.branch.name}': ${sanitizeGitError(reason)}`
      );
    }
    // Merge moved HEAD; reload before refresh.
    await ctx.gitService.reloadRepository(repo);
    ctx.branchTreeProvider.refresh();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(
      `Failed to merge branch: ${sanitizeGitError(errorMessage)}`
    );
  }
}

/**
 * Handle rebase current onto command.
 *
 * Rebases the current branch onto the right-clicked one without walling off
 * a dirty working tree: `rebaseBranch` passes `--autostash`, so git stashes
 * any uncommitted changes, replays, and re-applies them (IntelliJ
 * smart-stash parity). A clean rebase reports success with the changes
 * restored. An autostash-pop conflict — where re-applying the stash collides
 * with the rebased changes — is surfaced via the conflicts path with
 * `rebaseInProgress: false`, so the user resolves and `git add`s the files
 * (no continue/abort, since the rebase already completed). A genuine
 * non-conflict failure surfaces git's reason via a `failureReason` toast.
 *
 * After the rebase runs, the handler reloads the repo
 * and inspects `repo.inProgress` (populated from `readInProgressOperation`
 * via `loadRepository`). On a non-conflict failure that left an orphaned
 * `rebasing` state created by OUR invocation, it auto-aborts. When a
 * rebasing state remains for any other reason (e.g. paused on conflicts
 * with no Resolve Conflicts dialog wired), it surfaces an actionable
 * "rebase paused" warning. The before/after snapshot of
 * `inProgress.kind` ensures we never touch a rebase the user already had
 * in progress before they clicked.
 */
export async function handleRebaseCurrentOnto(
  ctx: IBranchMergeRebaseContext,
  { repo, target }: ITreeItemRunArgs<'branch'>
): Promise<void> {
  // Canonical surface: route through the unified Rebase dialog (onto =
  // the clicked branch, Interactive unchecked by default). The dialog owns
  // the same conflict + orphan-recovery handling ported from the inline
  // path below. The inline path remains the fallback when no opener is
  // wired (legacy construction / focused unit tests).
  if (ctx.rebaseDialogOpener) {
    await ctx.rebaseDialogOpener({
      repo,
      onto: target.branch.name,
      interactiveDefault: false,
    });
    return;
  }

  try {
    // No dirty-tree pre-check: rebaseBranch passes `--autostash`, so a dirty
    // tree is stashed and re-applied around the replay (IntelliJ smart-stash
    // parity). A clean rebase reports success with changes restored; an
    // autostash-pop conflict surfaces below via the conflicts path. Walling
    // off dirty trees here would block exactly what autostash handles.

    // Snapshot the in-progress operation BEFORE invoking the
    // rebase. This lets us distinguish a rebasing state that OUR call
    // created (eligible for auto-abort / pause-warning recovery) from one
    // the user already had paused before they clicked. `repo.inProgress`
    // is populated by `loadRepository` via `readInProgressOperation`
    // (see gitInProgress.ts); `kind` is the `IInProgressOperation` field.
    const beforeKind = repo.inProgress?.kind;

    const result = await ctx.gitService.rebaseBranch(repo, target.branch.name);

    // Track whether the Resolve Conflicts dialog was opened so we suppress
    // the redundant "rebase paused" warning for that same state —
    // the dialog is itself the actionable continue/abort UI.
    let conflictDialogOpened = false;
    // Track the non-conflict-failure branch so only it is eligible for
    // auto-abort of an orphaned rebase.
    let nonConflictFailure = false;

    if (result.success) {
      void vscode.window.showInformationMessage(
        `Rebased onto '${target.branch.name}' successfully`
      );
    } else if (result.conflicts && result.conflicts.length > 0) {
      // Auto-open Resolve Conflicts dialog when wired; fall back to a
      // warning toast otherwise. A non-continuable autostash-pop conflict
      // (rebaseInProgress === false) suppresses continue/abort.
      conflictDialogOpened = !!ctx.conflictResolutionService();
      await ctx.surfaceRebaseConflicts(
        repo,
        result.conflicts,
        target.branch.name,
        result.rebaseInProgress
      );
    } else {
      // Non-conflict failure (e.g. dirty tree, in-progress rebase, refs
      // out of sync, remote ref disappeared, etc.). Surface the underlying
      // git error so the user has SOMETHING to act on instead of a silent
      // no-op. `failureReason` is already sanitized at the GitService
      // boundary, but we re-pipe through `sanitizeGitError` here so the
      // safety contract is locally evident at the toast site
      // and survives any future refactor of the source side.
      nonConflictFailure = true;
      const reason = result.failureReason ?? 'unknown error (no output from git)';
      void vscode.window.showErrorMessage(
        `Failed to rebase onto '${target.branch.name}': ${sanitizeGitError(reason)}`
      );
    }

    // Rebase moved HEAD (or left an in-progress marker); reload before
    // refresh so the fresh `inProgress` state is read off disk.
    const reloaded = await ctx.gitService.reloadRepository(repo);
    const afterKind = (reloaded ?? repo).inProgress?.kind;

    if (nonConflictFailure && beforeKind !== 'rebasing' && afterKind === 'rebasing') {
      // Our non-conflict-failure invocation left an orphaned
      // rebasing state (`.git/rebase-merge/`). The user's mental model is
      // "I clicked rebase, it didn't work, it should be like I never
      // clicked it" — so auto-abort AFTER the error toast above. The
      // boundary is strict: only abort when the rebasing state did NOT
      // exist before our call. If the user already had a rebase paused,
      // `beforeKind === 'rebasing'` and we never touch it.
      try {
        // rebase-abort-exempt: orphaned-rebase recovery — non-conflict failure only; the before/after boundary above proves THIS invocation created the rebasing state
        await ctx.gitService.rebaseAbort(repo).match(
          () => undefined,
          (e) => {
            throw e;
          }
        );
      } catch (abortError) {
        const abortMsg = abortError instanceof Error ? abortError.message : 'Unknown error';
        void vscode.window.showErrorMessage(
          `Failed to abort orphaned rebase: ${sanitizeGitError(abortMsg)}`
        );
      }
    } else if (afterKind === 'rebasing' && !conflictDialogOpened) {
      // A rebasing state remains after the operation and we did
      // NOT open the Resolve Conflicts dialog as a dedicated UI. The rebase
      // is paused (conflicts) or was interrupted. Surface an actionable
      // warning. Of the rebase recovery commands the extension contributes,
      // only `intellig.rebase.skip` exists today (continue/abort are not
      // registered commands), so the message stays generic rather than
      // referencing command IDs that don't exist.
      void vscode.window.showWarningMessage(
        'Rebase paused with conflicts (or interruption). Resolve and continue, or abort.'
      );
    }

    ctx.branchTreeProvider.refresh();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(`Failed to rebase: ${sanitizeGitError(errorMessage)}`);
  }
}
