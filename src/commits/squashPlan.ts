import type { IRebaseAction, IRebaseCommit } from '../git-core/interfaces/IRebaseService';

/**
 * Build the interactive-rebase plan that combines a contiguous run of selected
 * commits into the oldest selected commit.
 *
 * Mirrors git4idea's `GitRebaseTodoModelConverter`: the oldest selected commit
 * is the unite ROOT; every other selected commit is united into it via `fixup`
 * (its own message discarded). Non-selected commits keep their action.
 *
 * Whether the root is reworded is decided by `combinedMessage`:
 *  - Squash: pass the user's combined message — the root becomes a `reword`
 *    carrying it. The message is delivered as a reword override (the todo
 *    transform realises it as `pick` + a non-interactive `commit --amend -F`),
 *    the only correct delivery: the rebase runs under `GIT_EDITOR=true`, so a
 *    classic `squash` would never pause for the message and git would silently
 *    keep its default all-messages concatenation instead of the edited text.
 *  - Fixup: omit it — there is no edited message, so the root stays `pick` and
 *    keeps its own message verbatim.
 *
 * @param sessionCommits - The rebase window's commits, in replay order.
 * @param selectedHashes - Hashes of the commits the user chose to combine.
 * @param targetHash - The oldest selected commit (the combine target / root).
 * @param combinedMessage - The user's combined message for a squash; omit for a
 *   fixup (the target then keeps its own message).
 */
export function buildSquashRebasePlan(
  sessionCommits: readonly IRebaseCommit[],
  selectedHashes: ReadonlySet<string>,
  targetHash: string,
  combinedMessage?: string
): IRebaseAction[] {
  return sessionCommits.map((c) => {
    if (!selectedHashes.has(c.hash)) {
      return { hash: c.hash, action: c.action };
    }
    if (c.hash === targetHash) {
      return combinedMessage === undefined
        ? { hash: c.hash, action: 'pick' as const }
        : { hash: c.hash, action: 'reword' as const, newMessage: combinedMessage };
    }
    return { hash: c.hash, action: 'fixup' as const };
  });
}
