import type { RepositoryState } from '../git-core/interfaces/IGitService';

/**
 * Inputs for the Update Project preflight guard — the subset of repository
 * state GitUpdateProcess inspects before deciding an update is possible.
 */
export interface IUpdateProjectState {
  /** The repo's in-progress operation kind, if any (`repo.inProgress?.kind`). */
  inProgressKind?: Exclude<RepositoryState, 'idle'>;
  /** Whether the working tree currently has unmerged (conflicted) files. */
  hasUnmergedFiles: boolean;
}

/**
 * Decide whether an "Update Project" may proceed — IntelliJ git4idea
 * `GitUpdateProcess` parity. That process refuses to update when a rebase or
 * merge is already in progress, or when the working tree has unmerged files
 * (GitUpdateProcess.java: `checkRebaseInProgress() || isMergeInProgress() ||
 * areUnmergedFiles()`). A cherry-pick or revert in progress is NOT one of its
 * blockers, so those pass.
 *
 * @returns a human-readable reason the update is blocked, or `undefined` when
 *   the repo is ready to update. Pure — no git access.
 */
export function updateProjectBlockedReason(state: IUpdateProjectState): string | undefined {
  if (state.inProgressKind === 'rebasing') {
    return 'A rebase is in progress. Finish or abort it before updating.';
  }
  if (state.inProgressKind === 'merging') {
    return 'A merge is in progress. Finish or abort it before updating.';
  }
  if (state.hasUnmergedFiles) {
    return 'There are unresolved merge conflicts. Resolve them before updating.';
  }
  return undefined;
}
