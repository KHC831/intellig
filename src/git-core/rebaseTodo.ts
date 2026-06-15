/**
 * In-place transform of git's interactive-rebase todo file.
 *
 * IntelliJ's git4idea (`GitInteractiveRebaseFile.load/save` +
 * `GitRebaseEntry.kt`) never rebuilds the todo from a commit list. It parses
 * git's REAL `git-rebase-todo`: commit lines (pick/reword/edit/squash/fixup/
 * drop) are editable entries, and every other command — `label`, `reset`,
 * `merge`, `exec`, `update-ref`, `noop` — is an `Action.Other` carried through
 * verbatim. Comment (`#`) and blank lines are dropped on save (git regenerates
 * its help block on the next read).
 *
 * Rebuilding from the commit list alone — as the old `generateTodoContent`
 * did — silently drops those structural commands, which corrupts
 * `rebase.updateRefs` (the `update-ref` lines that advance stacked branches)
 * and `--rebase-merges` rebases (the `label`/`reset`/`merge` lines that
 * reconstruct merge topology). This transform mirrors git4idea: it remaps and
 * reorders the commit lines per the user's plan while carrying every
 * structural line through unchanged.
 */

import type { IRebaseAction, RebaseAction } from './interfaces/IRebaseService';

/**
 * Map a todo command token (full name or git's single-letter abbreviation) to
 * a {@link RebaseAction}, or `undefined` if it is not a commit command (so the
 * line is structural and preserved verbatim).
 */
function parseCommitAction(command: string): RebaseAction | undefined {
  switch (command.toLowerCase()) {
    case 'p':
    case 'pick':
      return 'pick';
    case 'r':
    case 'reword':
      return 'reword';
    case 'e':
    case 'edit':
      return 'edit';
    case 's':
    case 'squash':
      return 'squash';
    case 'f':
    case 'fixup':
      return 'fixup';
    case 'd':
    case 'drop':
      return 'drop';
    default:
      return undefined;
  }
}

/** Whether two hashes refer to the same commit, tolerating differing lengths. */
function hashMatches(todoHash: string, planHash: string): boolean {
  const a = todoHash.toLowerCase();
  const b = planHash.toLowerCase();
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * A commit line plus the structural command lines that immediately trail it
 * (up to the next commit line). The trailing block travels with the commit
 * when the plan reorders it — an `update-ref` that advanced a branch after a
 * commit must stay anchored to that commit.
 */
interface ICommitGroup {
  hash: string;
  /** The commit line's subject (everything after the hash token), verbatim. */
  subject: string;
  /** Structural command lines following this commit, verbatim. */
  trailing: string[];
}

/**
 * Transform git's real rebase todo according to the user's plan.
 *
 * @param originalTodo - The exact contents git wrote to `git-rebase-todo`.
 * @param plan - The user's ordered actions. Each entry must match exactly one
 *   commit line in the todo (by hash prefix); the plan defines both the new
 *   action for each commit and the new commit order.
 * @returns The rewritten todo (newline-terminated), ready to write back.
 * @throws If a plan entry references a hash absent from git's todo — a
 *   mismatch that would otherwise silently corrupt the rebase.
 */
export function transformRebaseTodo(originalTodo: string, plan: IRebaseAction[]): string {
  const lines = originalTodo.split('\n');

  // Structural lines seen before the first commit line — git's `--rebase-merges`
  // todos open with `label onto` / `reset onto`, which must lead the output.
  const preamble: string[] = [];
  const groups: ICommitGroup[] = [];
  let current: ICommitGroup | undefined;

  for (const raw of lines) {
    const trimmed = raw.trim();

    // Drop comment and blank lines — git rewrites its help block on next read.
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }

    const firstSpace = trimmed.indexOf(' ');
    const command = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
    const action = parseCommitAction(command);

    if (action === undefined) {
      // Structural command (label/reset/merge/exec/update-ref/noop/…). Keep it
      // verbatim, anchored to the commit it trails (or the preamble).
      if (current) {
        current.trailing.push(trimmed);
      } else {
        preamble.push(trimmed);
      }
      continue;
    }

    // Commit line: `<command> <hash> <subject…>`.
    const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();
    const hashSpace = rest.indexOf(' ');
    const hash = hashSpace === -1 ? rest : rest.slice(0, hashSpace);
    const subject = hashSpace === -1 ? '' : rest.slice(hashSpace + 1);

    current = { hash, subject, trailing: [] };
    groups.push(current);
  }

  const out: string[] = [...preamble];

  for (const entry of plan) {
    const group = groups.find((g) => hashMatches(g.hash, entry.hash));
    if (!group) {
      throw new Error(
        `Rebase plan references commit ${entry.hash}, which is not in git's rebase todo`
      );
    }
    // Re-emit the commit line with the planned action. The subject and the
    // original hash token are preserved exactly; reword carries the OLD
    // subject here — git opens a separate message editor for the new text, so
    // the todo must keep the original (matching git4idea, which never writes
    // the new message into the todo line).
    const subjectSuffix = group.subject ? ` ${group.subject}` : '';
    out.push(`${entry.action} ${group.hash}${subjectSuffix}`);
    out.push(...group.trailing);
  }

  return out.join('\n') + '\n';
}
