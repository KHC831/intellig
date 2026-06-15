/**
 * Before-commit check framework — IntelliG's port of git4idea's
 * `ICheckinHandler` / `CheckinHandlerFactory` mechanism
 * (`GitCheckinHandlerFactory.kt:55-516`).
 *
 * git4idea runs a chain of independent handlers before a commit lands; each
 * returns a `CommitProblem` (or nothing) that can warn, block, or offer a
 * modal fix. IntelliG mirrors the shape with a much smaller surface:
 *
 *   - {@link ICheckinHandler} — one named check. Pure: it receives a
 *     fully-populated {@link ICheckinContext} snapshot and returns the
 *     problems it found. No I/O inside the check itself, so the entire
 *     check set is unit/property testable without a live git process.
 *   - {@link ICheckinContext} — the data the cheap checks need (git
 *     `user.name`/`user.email`, the working-tree file statuses for the
 *     committed paths, detached-HEAD flag). The caller gathers this once
 *     (see `CommitChecks.gatherCheckinContext`) and hands it to every
 *     handler.
 *   - {@link runCheckinHandlers} — runs the chain and aggregates the
 *     problems.
 *
 * The `--no-verify` toggle bypasses this chain exactly like it bypasses git
 * hooks: when the caller is in no-verify mode it simply does not run the
 * checks. That keeps the gear-menu toggle's meaning ("skip the safety
 * nets") consistent across hooks and IDE-side checks.
 *
 * Cheap checks ported first (this wave): user.name-undefined and
 * unresolved-merge. Detached-root is included as a third low-cost check
 * because the context already carries the flag. CRLF / large-file /
 * bad-filename are scaffolded as TODO follow-ups — the framework is shaped
 * to accept them without change.
 */

import { FileStatus } from '../git-core/interfaces/IGitService';

/**
 * Severity of a before-commit problem.
 *   - `error`   — blocks the commit; the user must fix or bypass.
 *   - `warning` — surfaced, but the user may proceed.
 */
export type CheckinProblemSeverity = 'error' | 'warning';

/**
 * A single problem found by a {@link ICheckinHandler}.
 */
export interface ICheckinProblem {
  /** Id of the handler that produced this problem (for grouping/telemetry). */
  handlerId: string;
  /** User-facing description. */
  text: string;
  /** Whether this blocks the commit or merely warns. */
  severity: CheckinProblemSeverity;
}

/**
 * Per-file view the checks operate on. A subset of the working-tree status —
 * just the path and its resolved {@link FileStatus} (e.g. `conflicted`).
 */
export interface ICheckinFile {
  path: string;
  status: FileStatus;
}

/**
 * The data snapshot every {@link ICheckinHandler} sees. Gathered once by the
 * caller (one git-config read + the already-loaded status) so the checks
 * themselves stay pure and synchronous.
 */
export interface ICheckinContext {
  /** `git config user.name`, or `undefined`/empty when unset. */
  userName?: string;
  /** `git config user.email`, or `undefined`/empty when unset. */
  userEmail?: string;
  /**
   * Whether git config could actually be read. `false` means the identity
   * could not be determined (e.g. the `gitCli` escape hatch was unavailable
   * in a stubbed environment). The user.name check does NOT fire when the
   * identity is unresolved — "couldn't read config" is not the same as
   * "name is missing", so we never block on an indeterminate result.
   * Defaults to `true` when omitted so callers that always read config can
   * leave it off.
   */
  userIdentityResolved?: boolean;
  /** Working-tree files being committed (post changelist→index mapping). */
  files: ReadonlyArray<ICheckinFile>;
  /** True when HEAD is detached (committing lands on no branch). */
  detachedHead: boolean;
}

/**
 * A named before-commit check. Pure — returns the problems it finds for the
 * given context, never performs I/O.
 */
export interface ICheckinHandler {
  /** Stable id, used for {@link ICheckinProblem.handlerId} + dedup. */
  readonly id: string;
  /** Human-readable name (debug / settings surfaces). */
  readonly displayName: string;
  /** Inspect the context, return zero or more problems. */
  check(context: ICheckinContext): ICheckinProblem[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Cheap checks (ported from GitCheckinHandlerFactory)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * user.name / user.email undefined check
 * (`GitUserNameCheckinHandler`, GitCheckinHandlerFactory.kt:196-308).
 *
 * git refuses to commit (or stamps an `(none)`/host-derived identity) when
 * `user.name`/`user.email` are unset. git4idea blocks and offers a dialog to
 * set them; IntelliG blocks with an error and points the user at the config.
 */
export const userNameCheckinHandler: ICheckinHandler = {
  id: 'git.user.name',
  displayName: 'Author identity is configured',
  check(context: ICheckinContext): ICheckinProblem[] {
    // Indeterminate config (couldn't read) never blocks — only a positively
    // observed missing identity does.
    if (context.userIdentityResolved === false) {
      return [];
    }
    const nameSet = !!context.userName && context.userName.trim().length > 0;
    const emailSet = !!context.userEmail && context.userEmail.trim().length > 0;
    if (nameSet && emailSet) {
      return [];
    }
    const missing: string[] = [];
    if (!nameSet) {
      missing.push('user.name');
    }
    if (!emailSet) {
      missing.push('user.email');
    }
    return [
      {
        handlerId: 'git.user.name',
        text: `Git ${missing.join(' and ')} ${
          missing.length === 1 ? 'is' : 'are'
        } not set. Configure your identity with "git config user.name" and "git config user.email" before committing.`,
        severity: 'error',
      },
    ];
  },
};

/**
 * Unresolved merge / conflict check
 * (`GitCheckinHandlerFactory` resolves unmerged paths before commit).
 *
 * A commit that includes a file still in `conflicted` (unmerged, `U`) state
 * would record conflict markers. Block it.
 */
export const unresolvedMergeCheckinHandler: ICheckinHandler = {
  id: 'git.unresolved.merge',
  displayName: 'No unresolved merge conflicts',
  check(context: ICheckinContext): ICheckinProblem[] {
    const conflicted = context.files.filter((f) => f.status === 'conflicted');
    if (conflicted.length === 0) {
      return [];
    }
    const sample = conflicted
      .slice(0, 5)
      .map((f) => f.path)
      .join(', ');
    const more = conflicted.length > 5 ? `, and ${conflicted.length - 5} more` : '';
    return [
      {
        handlerId: 'git.unresolved.merge',
        text: `${conflicted.length} file${
          conflicted.length === 1 ? ' has' : 's have'
        } unresolved merge conflicts (${sample}${more}). Resolve the conflicts before committing.`,
        severity: 'error',
      },
    ];
  },
};

/**
 * Detached-HEAD check
 * (`GitDetachedRootCheckinHandler`, GitCheckinHandlerFactory.kt:310-372).
 *
 * Committing on a detached HEAD lands the commit on no branch; it will be
 * lost on the next checkout unless the user creates a branch. git4idea warns
 * and offers a do-not-ask. IntelliG surfaces a warning (non-blocking) — the
 * commit is technically valid, just easy to lose.
 */
export const detachedRootCheckinHandler: ICheckinHandler = {
  id: 'git.detached.root',
  displayName: 'HEAD is on a branch',
  check(context: ICheckinContext): ICheckinProblem[] {
    if (!context.detachedHead) {
      return [];
    }
    return [
      {
        handlerId: 'git.detached.root',
        text: 'HEAD is detached. This commit will not be on any branch and may be lost on the next checkout. Create a branch to keep it.',
        severity: 'warning',
      },
    ];
  },
};

/**
 * The default cheap-check chain, in run order. user.name first (it blocks
 * the hardest), then unresolved-merge, then the detached-HEAD warning.
 *
 * CRLF / large-file / bad-filename checks plug in here when ported.
 */
export const DEFAULT_CHECKIN_HANDLERS: ReadonlyArray<ICheckinHandler> = [
  userNameCheckinHandler,
  unresolvedMergeCheckinHandler,
  detachedRootCheckinHandler,
];

/**
 * Result of running the chain.
 */
export interface ICheckinResult {
  /** Every problem found, in handler order. */
  problems: ICheckinProblem[];
  /** True when at least one problem has `severity: 'error'`. */
  hasBlockingProblem: boolean;
}

/**
 * Run a chain of {@link ICheckinHandler}s against a context and aggregate
 * the problems. Pure — no I/O, no ordering surprises (handlers run in array
 * order, problems concatenate in that order).
 *
 * @param handlers - The chain (defaults to {@link DEFAULT_CHECKIN_HANDLERS}).
 * @param context - The gathered snapshot.
 */
export function runCheckinHandlers(
  context: ICheckinContext,
  handlers: ReadonlyArray<ICheckinHandler> = DEFAULT_CHECKIN_HANDLERS
): ICheckinResult {
  const problems: ICheckinProblem[] = [];
  for (const handler of handlers) {
    problems.push(...handler.check(context));
  }
  return {
    problems,
    hasBlockingProblem: problems.some((p) => p.severity === 'error'),
  };
}
