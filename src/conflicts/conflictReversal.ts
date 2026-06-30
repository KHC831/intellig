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
