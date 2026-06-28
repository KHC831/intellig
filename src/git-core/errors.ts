/**
 * Typed git error taxonomy for the Result boundary.
 *
 * The git-IO layer historically swallowed failures into `undefined` / `false`,
 * which conflated a SYSTEM error (e.g. `ENOTDIR` from passing a file as a
 * command cwd — a bug) with a DOMAIN outcome ("this directory is not a git
 * repository"). That masquerade is the root cause behind the merge-view
 * "No repository found" bug.
 *
 * This module gives the boundary a small, typed error vocabulary so a system
 * failure can never silently read as a domain absence. Query/op methods return
 * `Result`/`ResultAsync<T, GitError>` (neverthrow) carrying one of these:
 *
 *   - {@link NotARepositoryError} — the path is genuinely not inside a repo.
 *   - {@link SpawnFailedError}    — git could not be spawned / ran against an
 *                                   invalid cwd (`ENOTDIR`, `ENOENT`, …); a
 *                                   real system fault, never a domain answer.
 *   - {@link CommandFailedError}  — git ran but exited non-zero ({exitCode,
 *                                   stderr}).
 *   - {@link TimeoutError}        — the command was killed for exceeding its
 *                                   timeout.
 *
 * Each carries a `kind` discriminant so callers can branch (`.match` / switch)
 * without `instanceof` chains, while still extending `Error` so they log and
 * stringify naturally.
 */

import { GitCommandError } from './gitCli';

export type GitErrorKind =
  | 'not-a-repository'
  | 'spawn-failed'
  | 'command-failed'
  | 'timeout'
  | 'invalid-argument';

/**
 * Base for the typed git errors. Extends `Error` so a `GitError` drops straight
 * into `logger.error(msg, err)` and stringifies usefully.
 */
abstract class GitErrorBase extends Error {
  abstract readonly kind: GitErrorKind;
}

/** The path is genuinely outside any git repository. */
export class NotARepositoryError extends GitErrorBase {
  readonly kind = 'not-a-repository';
  constructor(public readonly path?: string) {
    super(path ? `Not a git repository: ${path}` : 'Not a git repository');
    this.name = 'NotARepositoryError';
  }
}

/**
 * git could not be spawned, or was spawned against an invalid cwd. Carries the
 * OS errno text (`ENOTDIR`, `ENOENT`, …). A real system fault — distinct from,
 * and never to be collapsed into, "not a repository".
 */
export class SpawnFailedError extends GitErrorBase {
  readonly kind = 'spawn-failed';
  constructor(
    message: string,
    public readonly originalError?: unknown
  ) {
    super(message);
    this.name = 'SpawnFailedError';
  }
}

/**
 * git ran but exited non-zero.
 *
 * Carries the original {@link IGitCommandResult} under `result` (when classified
 * from a `GitCommandError`) so downstream inspectors that need BOTH streams —
 * e.g. `combinedGitErrorText` / `isConflictError`, since git writes merge
 * "CONFLICT" markers to STDOUT — can still see the combined output. The duck-
 * typed `result.combined` shape matches `GitCommandError`, so those helpers work
 * unchanged.
 */
export class CommandFailedError extends GitErrorBase {
  readonly kind = 'command-failed';
  constructor(
    public readonly exitCode: number,
    public readonly stderr: string,
    message?: string,
    public readonly result?: { stdout: string; stderr: string; combined: string }
  ) {
    super(message ?? `Git command failed (exit ${exitCode}): ${stderr}`);
    this.name = 'CommandFailedError';
  }
}

/** The command was killed for exceeding its timeout. */
export class TimeoutError extends GitErrorBase {
  readonly kind = 'timeout';
  constructor(message = 'Git command timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * A caller-supplied argument was rejected BEFORE git ran — e.g. an empty
 * worktree path, or a ref/branch name that starts with `-`/`.` (an
 * argv-injection guard). Distinct from {@link CommandFailedError}: git was
 * never invoked. Surfacing it as a typed Err (rather than a thrown `Error`)
 * keeps the ops Result channel total, so callers handle it through the same
 * `.match` arm as a git failure.
 */
export class InvalidArgumentError extends GitErrorBase {
  readonly kind = 'invalid-argument';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidArgumentError';
  }
}

export type GitError =
  | NotARepositoryError
  | SpawnFailedError
  | CommandFailedError
  | TimeoutError
  | InvalidArgumentError;

/**
 * Classify a thrown value from the gitCli layer into a typed {@link GitError}.
 *
 * Failure modes this must separate:
 *   - `child_process.spawn` throws SYNCHRONOUSLY with a raw `ErrnoException`
 *     (`code: 'ENOTDIR'`) when handed a file as cwd — NOT wrapped in
 *     `GitCommandError`. This is the exact error that used to be swallowed to
 *     `undefined`, so it must land as {@link SpawnFailedError}, never a domain
 *     outcome.
 *   - The spawn 'error' path (missing binary) rejects with a `GitCommandError`
 *     whose `result.exitCode` is `-1` and whose stderr carries the errno.
 *   - A timeout rejects with a `GitCommandError` ("Git command timed out").
 *   - A non-zero exit (when `throwOnError`) rejects with a `GitCommandError`
 *     carrying the real `exitCode` + stderr → {@link CommandFailedError}.
 *
 * The spawn-vs-command discriminator is `exitCode < 0`: libuv reports
 * spawn/system faults (and the timeout kill) as `-1`, while any non-negative
 * exit means git actually ran and exited. We deliberately do NOT sniff stderr
 * for errno tokens — a genuine `CommandFailedError` can legitimately mention
 * `ENOENT`/`ENOTDIR` in its output (e.g. `git checkout` of a missing path),
 * and mis-tagging that as spawn-failed would be the same masquerade in reverse.
 */
export function classifyGitCommandError(error: unknown): GitError {
  // Already-typed: a deeper op layer (e.g. an InvalidArgumentError thrown by a
  // validation guard inside a wrapped async body) must survive classification
  // unchanged rather than being re-tagged as a spawn fault.
  if (error instanceof GitErrorBase) {
    // Every concrete GitError extends GitErrorBase; the union members are the
    // only instantiable subclasses, so this narrowing is total at runtime.
    return error as GitError;
  }
  if (error instanceof GitCommandError) {
    const { exitCode, stderr } = error.result;
    // A real timeout requires the process to have been killed (exitCode < 0).
    // Git puts server stderr (e.g. "Connection timed out") into the message,
    // so a positive exit code means git ran and returned a real failure — do
    // not re-tag it as a timeout based solely on the message text.
    if (exitCode < 0) {
      if (/timed out/i.test(error.message)) {
        return new TimeoutError(error.message);
      }
      return new SpawnFailedError(error.message, error);
    }
    return new CommandFailedError(exitCode, stderr, error.message, error.result);
  }
  if (error instanceof Error) {
    // Raw ErrnoException from a synchronous spawn throw (e.g. file-as-cwd
    // ENOTDIR), or any other non-GitCommandError throw.
    return new SpawnFailedError(error.message, error);
  }
  return new SpawnFailedError(String(error), error);
}
