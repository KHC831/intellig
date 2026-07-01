import { IConflictOpContext } from './interfaces/IConflictResolutionService';

/**
 * Whether a conflict-producing operation swaps the git index sides so that
 * "Yours" is stage 3 and "Theirs" is stage 2. True for rebase and for
 * unstash/unshelve (the user's own work is the side being replayed/restored),
 * matching IntelliJ `GitMergeUtil.isReverseRoot` plus the reversed merge
 * providers it constructs for unshelve/unstash.
 *
 * Lives in its own module so both the dialog's per-file actions and the
 * service's bulk-accept auto-detect share one source of truth (and to avoid a
 * cycle between ConflictResolutionService and ResolveConflictsDialog).
 */
export function isReversedOperation(operation?: IConflictOpContext['operation']): boolean {
  return operation === 'rebase' || operation === 'unstash' || operation === 'unshelve';
}

/** Git repository states the conflict service distinguishes. */
export type ConflictRepoState = 'idle' | 'merging' | 'rebasing' | 'cherry-picking' | 'reverting';

/**
 * Operation to assume when (re)opening the Resolve Conflicts dialog and when
 * deciding ours/theirs reversal. The repository STATE leads — a definitive
 * in-progress op is a git fact:
 *
 *  - merging/rebasing/cherry-picking/reverting map to their operation, even if a
 *    stale op is still recorded (a leftover 'merge' must not mask a live rebase).
 *  - idle ⇒ the repo carries unmerged files but NO `*_HEAD`/rebase state, which a
 *    real merge/rebase/cherry-pick/revert never does — it is a working-tree apply
 *    (unstash / unshelve / applyPatch). Here the recorded op is the only signal of
 *    which one; absent it, guess 'unstash' (reversed) so "Accept Yours" keeps the
 *    user's applied work (stage 3) and Abort restores the working tree rather than
 *    running `merge --abort` on an idle repo. (An external `git apply --3way` with
 *    no recorded op is the rare wrong guess, and stays recoverable from the patch.)
 *
 * Pure so it can be unit-tested without the command/extension host.
 */
export function inferReopenOperation(
  recordedOp: IConflictOpContext['operation'] | undefined,
  state: ConflictRepoState
): IConflictOpContext['operation'] {
  // A definitive in-progress state is a git fact and wins over a possibly-stale
  // recorded op (a leftover 'merge' must not mask a live rebase, or the accept
  // side flips). The recorded op only disambiguates an idle repo — a working-tree
  // apply (unstash / unshelve / applyPatch) that leaves no *_HEAD marker.
  switch (state) {
    case 'merging':
      return 'merge';
    case 'rebasing':
      return 'rebase';
    case 'cherry-picking':
      return 'cherryPick';
    case 'reverting':
      return 'revert';
    case 'idle':
      return recordedOp ?? 'unstash';
  }
}
