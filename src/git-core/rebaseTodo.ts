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
 * The six commit commands a rebase plan entry may carry. Any other token is a
 * structural command (`label`/`reset`/`merge`/`exec`/…) that git owns — it must
 * never arrive as a plan `action`, since the action is emitted verbatim into
 * the todo (`<action> <hash> …`) where a forged `exec …` would inject.
 */
export const REBASE_ACTIONS: readonly RebaseAction[] = [
  'pick',
  'reword',
  'edit',
  'squash',
  'fixup',
  'drop',
];

/** Type guard: `value` is one of the six valid rebase commit actions. */
export function isRebaseAction(value: unknown): value is RebaseAction {
  return typeof value === 'string' && (REBASE_ACTIONS as readonly string[]).includes(value);
}

/**
 * Whether `hash` is a safe commit hash: 4-64 hex chars and nothing else.
 * Rejects path separators and `..` so a plan hash can never traverse out of
 * the git dir when interpolated into a message-override file path.
 */
export function isValidRebaseHash(hash: unknown): hash is string {
  return typeof hash === 'string' && /^[0-9a-fA-F]{4,64}$/.test(hash);
}

/**
 * Whether a plan entry carries a usable pre-typed reword message — i.e. a
 * 'reword' action whose `newMessage` is present and not blank. A blank
 * override is treated as absent: writing an empty `-F` file would make
 * `git commit --amend` abort ("empty commit message") and break the rebase,
 * so we fall back to the classic interactive reword instead (matching the
 * editor textarea's "leave blank to edit interactively" affordance).
 */
export function hasRewordOverride(entry: IRebaseAction): boolean {
  return (
    entry.action === 'reword' &&
    entry.newMessage !== undefined &&
    entry.newMessage.trim().length > 0
  );
}

/**
 * Whether a plan entry carries a usable pre-typed combined message for a squash
 * — a 'squash' action whose `newMessage` is present and not blank. git4idea
 * collects this combined message up front (`GitRebaseTodoModelConverter`
 * unites the squash entry into its predecessor and stores
 * `GitSquashedCommitsMessage.squash(old, entry)` on the root as a `Reword`).
 *
 * The blank guard mirrors {@link hasRewordOverride}: writing an empty `-F` file
 * would make the post-fixup `git commit --amend` abort ("empty commit
 * message") and break the rebase, so a blank override falls back to git's
 * classic interactive squash instead.
 */
export function hasSquashOverride(entry: IRebaseAction): boolean {
  return (
    entry.action === 'squash' &&
    entry.newMessage !== undefined &&
    entry.newMessage.trim().length > 0
  );
}

/**
 * Whether a plan entry carries a usable inline message override (reword or
 * squash) — the cases that pre-write a message file and amend non-interactively
 * instead of pausing for git's editor.
 */
export function hasInlineMessageOverride(entry: IRebaseAction): boolean {
  return hasRewordOverride(entry) || hasSquashOverride(entry);
}

/**
 * Basename of the temp file holding an inline message override (reword or
 * squash), keyed by the full plan hash so two commits sharing a short prefix in
 * one plan never collide onto the same file. Lives in the git dir; the
 * `exec git commit --amend -F` line references it as `.git/<name>` relative to
 * the repo root.
 */
export function messageOverrideFileName(hash: string): string {
  // Fail closed at the path sink: this name is joined onto `.git/`, so a hash
  // carrying a separator or `..` would escape the git dir and write attacker
  // content to an arbitrary file. Reject anything that isn't a bare hex hash.
  if (!isValidRebaseHash(hash)) {
    throw new Error('Invalid rebase commit hash for message-override file');
  }
  return `.intellig-reword-${hash}.txt`;
}

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
  // Validate every plan entry before any of it reaches the todo or a file
  // path. The plan originates from the webview; a forged `action` would inject
  // an arbitrary todo command (`exec …`) and a non-hex `hash` would traverse
  // out of the git dir via messageOverrideFileName. Fail closed so git aborts
  // the rebase rather than replaying a poisoned plan.
  for (const entry of plan) {
    if (!isValidRebaseHash(entry.hash)) {
      throw new Error(`Rebase plan entry has an invalid commit hash`);
    }
    if (!isRebaseAction(entry.action)) {
      throw new Error(`Rebase plan entry has an invalid action`);
    }
  }

  // A squash/fixup melds into the PRECEDING commit, so it cannot lead the plan
  // (a squash override emits 'fixup', which has the same constraint). Catch it
  // here with a clear message instead of letting git abort the rebase mid-run
  // with "cannot 'fixup' without a previous commit".
  const first = plan[0];
  if (first && (first.action === 'squash' || first.action === 'fixup')) {
    throw new Error(`Cannot ${first.action} the first commit in the plan`);
  }

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
    const subjectSuffix = group.subject ? ` ${group.subject}` : '';
    const amendExec = `exec git commit --amend -F .git/${messageOverrideFileName(entry.hash)} --no-edit`;
    if (hasRewordOverride(entry)) {
      // User pre-typed a message in the planning UI (H1 parity). Emit 'pick'
      // so git never pauses, then amend the message via exec. The message file
      // is written by applyPlanToTodoFile before git runs.
      out.push(`pick ${group.hash}${subjectSuffix}`);
      out.push(amendExec);
    } else if (hasSquashOverride(entry)) {
      // User pre-typed the combined message (H1 parity). Emit 'fixup' rather
      // than 'squash': fixup melds into the previous commit WITHOUT pausing and
      // discards this commit's own message, then the exec amends the resulting
      // commit to the user's combined message. This yields the same end-state
      // as git4idea's "reword the unite root" (GitRebaseTodoModelConverter),
      // without needing a persistent message-step editor.
      out.push(`fixup ${group.hash}${subjectSuffix}`);
      out.push(amendExec);
    } else {
      // Classic path: emit the planned action verbatim. reword/squash cause git
      // to pause for user input via $GIT_EDITOR; other actions run without
      // stopping.
      out.push(`${entry.action} ${group.hash}${subjectSuffix}`);
    }
    out.push(...group.trailing);
  }

  return out.join('\n') + '\n';
}
