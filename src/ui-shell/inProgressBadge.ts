/**
 * Pure descriptor for the persistent "operation in progress" status-bar
 * badge (#28).
 *
 * Maps a repository's {@link RepositoryState} to the status-bar text +
 * tooltip shown while a merge / rebase / cherry-pick / revert is paused
 * (typically on conflicts). Returns `null` for the `idle` state.
 *
 * The badge is intentionally op-agnostic about the resolution flow: the
 * status-bar item it feeds invokes `intellig.showResolveConflictsDialog`,
 * which already infers the operation from repository state and opens the
 * unified Resolve-Conflicts surface (continue / abort / skip per op). One
 * badge, one action, all four in-progress kinds.
 */

import { RepositoryState } from '../git-core/interfaces/IGitService';

/** Status-bar badge content for an in-progress operation. */
export interface IInProgressBadge {
  /** Status-bar text, e.g. `"$(warning) Rebase in progress"`. */
  text: string;
  /** Hover tooltip describing the op + available actions. */
  tooltip: string;
}

/** Human label per non-idle op kind. */
const LABELS: Record<Exclude<RepositoryState, 'idle'>, string> = {
  rebasing: 'Rebase in progress',
  merging: 'Merge in progress',
  'cherry-picking': 'Cherry-pick in progress',
  reverting: 'Revert in progress',
};

/**
 * Build the status-bar badge for `state`, or `null` when the repository is
 * idle. `target` (a ref name or short SHA, when known) is surfaced in the
 * tooltip only — the short status-bar text stays compact.
 */
export function describeInProgressOp(
  state: RepositoryState,
  target?: string
): IInProgressBadge | null {
  if (state === 'idle') {
    return null;
  }
  const label = LABELS[state];
  const targetSuffix = target ? ` onto ${target}` : '';
  return {
    text: `$(warning) ${label}`,
    tooltip: `${label}${targetSuffix} — click to resolve conflicts (continue / abort / skip).`,
  };
}
