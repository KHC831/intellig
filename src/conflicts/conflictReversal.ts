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
 * Operation to assume when (re)opening the Resolve Conflicts dialog. Prefers the
 * operation recorded when the conflict's dialog first opened (the truth, set by
 * whichever flow produced the conflict). When nothing is on record — a conflict
 * produced OUTSIDE the extension — fall back to the repository state:
 *
 *  - merging/rebasing/cherry-picking/reverting map to their operation.
 *  - idle ⇒ the repo carries unmerged files but NO `*_HEAD`/rebase state, which
 *    a real merge/rebase/cherry-pick/revert never does — it is a working-tree
 *    apply, overwhelmingly an external `git stash pop`/apply. Guess 'unstash'
 *    (reversed) so "Accept Yours" keeps the user's stashed work (stage 3) and
 *    Abort restores the working tree rather than running `merge --abort` on an
 *    idle repo. (An external `git apply --3way` is the rare wrong guess here,
 *    and it stays recoverable from the patch.)
 *
 * Pure so it can be unit-tested without the command/extension host.
 */
export function inferReopenOperation(
  recordedOp: IConflictOpContext['operation'] | undefined,
  state: ConflictRepoState
): IConflictOpContext['operation'] {
  if (recordedOp !== undefined) {
    return recordedOp;
  }
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
      return 'unstash';
  }
}
