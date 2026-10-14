/**
 * Before-commit check framework — IntelliG's port of git4idea's
 * `ICheckinHandler` / `CheckinHandlerFactory` mechanism
 * (`GitCheckinHandlerFactory.kt:55-516`).
 *
 * intellij-reference-only: follows the shape of git4idea's handler chain; the
 * checks and their code are IntelliG's own.
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
 * Checks: user.name-undefined, unresolved-merge, CRLF-without-autocrlf,
 * large-file, Windows-hostile filename, detached-root, and a status-read
 * watchdog. The file facts the CRLF/large-file checks need (`hasCrlf`,
 * `sizeBytes`) are sampled once by `CheckinChecks.sampleFileFacts`.
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
  /** File contains CRLF line separators (sampled; undefined = not sampled). */
  hasCrlf?: boolean;
  /** On-disk size in bytes (undefined = not sampled / file absent). */
  sizeBytes?: number;
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
  /**
   * `git config core.autocrlf`, lower-cased (`'true'` / `'input'` /
   * `'false'`), or `undefined` when unset or unreadable. The CRLF check only
   * fires when git is NOT normalizing (`true`/`input` suppress it).
   */
  coreAutoCrlf?: string;
  /**
   * True when the working-tree status could not be read (e.g. `getStatus`
   * threw). When set, {@link files} is empty and the conflict check cannot
   * run — surfaced as a non-blocking warning rather than silently passing.
   */
  statusReadFailed?: boolean;
  /**
   * `intellig.warnAboutCrlf` — reference: the CRLF check is gated on the
   * warnAboutCrlf setting (GitCheckinHandlerFactory). `false` silences the
   * CRLF check; unset defaults to warning.
   */
  warnAboutCrlf?: boolean;
  /**
   * Large-file warn threshold in BYTES, from `intellig.largeFileWarningMb`
   * (reference: warnAboutLargeFilesLimitMb). `<= 0` disables the check;
   * unset falls back to {@link LARGE_FILE_WARNING_BYTES}.
   */
  largeFileWarningBytes?: number;
  /**
   * True when the repo has `lfs.repositoryformatversion` set. The large-file
   * check skips LFS repos (reference GitCheckinHandlerFactory.kt:183) — big
   * files there are pointer-tracked, not raw blobs.
   */
  lfsRepo?: boolean;
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
 * Status-read-failure check.
 *
 * When the working-tree status couldn't be read, the unresolved-merge check
 * operates on an empty file set and cannot detect conflicts. Rather than let
 * the commit proceed with no signal (fail-open), surface a non-blocking warning
 * so the user knows the pre-commit checks were incomplete. git itself still
 * refuses a truly conflicted index, so this stays advisory.
 */
export const statusReadCheckinHandler: ICheckinHandler = {
  id: 'git.status.read',
  displayName: 'Working-tree status is readable',
  check(context: ICheckinContext): ICheckinProblem[] {
    if (!context.statusReadFailed) {
      return [];
    }
    return [
      {
        handlerId: 'git.status.read',
        text: 'Could not read the working-tree status, so the pre-commit conflict check could not run. The commit can proceed, but verify there are no unresolved conflicts.',
        severity: 'warning',
      },
    ];
  },
};

/**
 * Warn threshold for the large-file check: 50 MiB, the size at which the
 * major hosting providers start warning or refusing pushes.
 */
export const LARGE_FILE_WARNING_BYTES = 50 * 1024 * 1024;

/**
 * CRLF check (`GitCheckinHandlerFactory`'s CRLF handler / GitCrlfDialog).
 *
 * When a committed file contains CRLF separators and `core.autocrlf` is not
 * normalizing (`true`/`input`), the CRLFs land in the repository — a
 * cross-platform diff-noise trap. git4idea offers a fix dialog; IntelliG
 * warns (non-blocking) and points at core.autocrlf.
 */
export const crlfCheckinHandler: ICheckinHandler = {
  id: 'git.crlf',
  displayName: 'No CRLF committed without autocrlf',
  check(context: ICheckinContext): ICheckinProblem[] {
    if (context.warnAboutCrlf === false) {
      return [];
    }
    if (context.coreAutoCrlf === 'true' || context.coreAutoCrlf === 'input') {
      return [];
    }
    const crlf = context.files.filter((f) => f.hasCrlf === true);
    if (crlf.length === 0) {
      return [];
    }
    const sample = crlf
      .slice(0, 5)
      .map((f) => f.path)
      .join(', ');
    const more = crlf.length > 5 ? `, and ${crlf.length - 5} more` : '';
    return [
      {
        handlerId: 'git.crlf',
        text: `${crlf.length} file${
          crlf.length === 1 ? '' : 's'
        } being committed contain${crlf.length === 1 ? 's' : ''} CRLF line separators (${sample}${more}) and core.autocrlf is not set, so the CRLFs will be committed as-is. Consider "git config core.autocrlf input" (macOS/Linux) or "true" (Windows).`,
        severity: 'warning',
      },
    ];
  },
};

/**
 * Large-file check: warns for files over {@link LARGE_FILE_WARNING_BYTES}.
 * Hosting providers warn at 50 MiB and hard-refuse near 100 MiB, and a blob
 * once pushed is in history forever — worth one warning before the commit.
 */
export const largeFileCheckinHandler: ICheckinHandler = {
  id: 'git.large.file',
  displayName: 'No unexpectedly large files',
  check(context: ICheckinContext): ICheckinProblem[] {
    const threshold = context.largeFileWarningBytes ?? LARGE_FILE_WARNING_BYTES;
    if (threshold <= 0) {
      return []; // 0 (or negative) disables the check
    }
    if (context.lfsRepo) {
      return []; // LFS repos track big files as pointers, not raw blobs
    }
    const big = context.files.filter(
      (f) => typeof f.sizeBytes === 'number' && f.sizeBytes > threshold
    );
    if (big.length === 0) {
      return [];
    }
    const thresholdMb = Math.round(threshold / (1024 * 1024));
    const list = big
      .slice(0, 5)
      .map((f) => `${f.path} (${Math.round((f.sizeBytes ?? 0) / (1024 * 1024))} MB)`)
      .join(', ');
    const more = big.length > 5 ? `, and ${big.length - 5} more` : '';
    return [
      {
        handlerId: 'git.large.file',
        text: `${big.length} file${big.length === 1 ? ' is' : 's are'} larger than ${thresholdMb} MB: ${list}${more}. Large blobs stay in history forever and most hosts refuse them — consider Git LFS or excluding the file.`,
        severity: 'warning',
      },
    ];
  },
};

/** Windows-reserved device names (any extension still reserves the name). */
const WINDOWS_RESERVED_SEGMENT = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** True when one path segment cannot exist on a Windows checkout. */
function isWindowsHostileSegment(segment: string): boolean {
  return (
    // eslint-disable-next-line no-control-regex
    /[<>:"|?*\u0000-\u001f]/.test(segment) ||
    /[. ]$/.test(segment) ||
    WINDOWS_RESERVED_SEGMENT.test(segment)
  );
}

/**
 * Bad-filename check: a NEW file whose name Windows cannot represent
 * (reserved device names, `<>:"|?*` or control characters, trailing dot or
 * space in any segment) makes the whole repository uncloneable on Windows.
 * Only added/untracked files are checked — an existing bad name would warn
 * on every commit forever.
 */
export const badFilenameCheckinHandler: ICheckinHandler = {
  id: 'git.bad.filename',
  displayName: 'File names are portable',
  check(context: ICheckinContext): ICheckinProblem[] {
    const bad = context.files.filter(
      (f) =>
        (f.status === 'added' || f.status === 'untracked') &&
        f.path.split('/').some(isWindowsHostileSegment)
    );
    if (bad.length === 0) {
      return [];
    }
    const sample = bad
      .slice(0, 5)
      .map((f) => f.path)
      .join(', ');
    const more = bad.length > 5 ? `, and ${bad.length - 5} more` : '';
    return [
      {
        handlerId: 'git.bad.filename',
        text: `${bad.length} new file name${
          bad.length === 1 ? ' is' : 's are'
        } not valid on Windows (${sample}${more}) — the repository would fail to check out there. Rename before committing.`,
        severity: 'warning',
      },
    ];
  },
};

/**
 * The default check chain, in run order: user.name first (it blocks the
 * hardest), unresolved-merge next, then the warning-grade content checks
 * (CRLF, large file, bad filename), then detached-HEAD + status-read.
 */
export const DEFAULT_CHECKIN_HANDLERS: ReadonlyArray<ICheckinHandler> = [
  userNameCheckinHandler,
  unresolvedMergeCheckinHandler,
  crlfCheckinHandler,
  largeFileCheckinHandler,
  badFilenameCheckinHandler,
  detachedRootCheckinHandler,
  statusReadCheckinHandler,
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
