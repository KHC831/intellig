import * as vscode from 'vscode';
import { spawn, SpawnOptions, execFileSync } from 'child_process';
import { ResultAsync, ok, err } from 'neverthrow';
import { getOutputChannel } from '../utils/outputChannel';
import { GitError, CommandFailedError, classifyGitCommandError } from './errors';

/**
 * Upper bound (in chars) on each captured stream — stdout, stderr, and the
 * combined buffer. V8 caps a single string at ~2^29-ish chars; concatenating
 * git's output past that throws `RangeError: Invalid string length` INSIDE the
 * socket `data` handler, which is an uncaught async throw that crashes the
 * extension host (observed on a 2.1 GB checkout). 64 MiB is far below the V8
 * limit yet larger than any output we meaningfully parse, so capping here is
 * safe: a runaway command yields a truncated-but-usable result instead of a
 * crash.
 */
export const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Append `chunk` to `existing` without letting the result exceed `cap` chars.
 * Once the accumulator reaches the cap, further appends are dropped (the head
 * is the part we care about — error reasons and the start of a log). Pure and
 * allocation-bounded, so it can never throw RangeError.
 */
export function appendCapped(existing: string, chunk: string, cap: number): string {
  if (existing.length >= cap) {
    return existing;
  }
  const room = cap - existing.length;
  return chunk.length <= room ? existing + chunk : existing + chunk.slice(0, room);
}

/**
 * Default wall-clock timeouts (ms) bounding a git child so a stalled command
 * can't hang the host indefinitely or leak a zombie process — most importantly
 * the unattended auto-fetch loop and any network verb stuck on a dead
 * connection or a hung credential helper. Network verbs get a tighter bound
 * than local verbs. An explicit `timeout` option always wins (including `0` =
 * no timeout), so a caller can still opt out.
 */
export const NETWORK_GIT_TIMEOUT_MS = 300_000;
export const LOCAL_GIT_TIMEOUT_MS = 600_000;

/** Grace period after SIGTERM before escalating to SIGKILL on a child that
 * ignores the polite signal (e.g. a credential helper trapping SIGTERM). */
export const GIT_KILL_GRACE_MS = 2_000;

/** Network verbs — bounded by {@link NETWORK_GIT_TIMEOUT_MS}. */
const NETWORK_GIT_VERBS = new Set(['fetch', 'pull', 'push']);
/** Verbs left UNBOUNDED: a `clone` legitimately runs for many minutes; a
 * `ls-remote` is the interactive credential probe. */
const UNBOUNDED_GIT_VERBS = new Set(['clone', 'ls-remote']);

/** The git subcommand (verb) = the first non-flag argv token, so a leading
 * global flag like `--no-optional-locks` is skipped. */
function gitVerb(args: string[]): string | undefined {
  return args.find((arg) => !arg.startsWith('-'));
}

/**
 * Resolve the effective wall-clock timeout (ms; `0` = unbounded) for a git
 * command. An explicit option value always wins — preserving the `0` opt-out;
 * otherwise the default is chosen by verb class (network / unbounded / local).
 */
export function resolveGitTimeoutMs(args: string[], explicit?: number): number {
  if (explicit !== undefined) {
    return explicit;
  }
  const verb = gitVerb(args);
  if (verb !== undefined && UNBOUNDED_GIT_VERBS.has(verb)) {
    return 0;
  }
  if (verb !== undefined && NETWORK_GIT_VERBS.has(verb)) {
    return NETWORK_GIT_TIMEOUT_MS;
  }
  return LOCAL_GIT_TIMEOUT_MS;
}

/**
 * Result of a Git command execution
 */
export interface IGitCommandResult {
  /** Exit code of the command */
  exitCode: number;
  /** Standard output */
  stdout: string;
  /** Standard error output */
  stderr: string;
  /** Combined output (stdout + stderr in order received) */
  combined: string;
}

/**
 * Options for executing a Git command
 */
export interface IGitCommandOptions {
  /** Working directory for the command */
  cwd?: string;
  /** Environment variables */
  env?: NodeJS.ProcessEnv;
  /**
   * Timeout in milliseconds. Omit to use the per-verb default
   * ({@link resolveGitTimeoutMs} — network 300s, local 600s, clone/ls-remote
   * unbounded). An explicit value wins, and `0` explicitly disables the bound.
   */
  timeout?: number;
  /** Input to write to stdin */
  input?: string;
  /** Whether to throw on non-zero exit code */
  throwOnError?: boolean;
}

/**
 * Error thrown when a Git command fails.
 *
 * **The constructed `message` is UNSANITISED.** It carries the raw
 * `git` stderr / stdout (and the full argv joined with spaces). When
 * `git` was invoked against a remote whose URL embeds credentials
 * (e.g. `https://x-access-token:ghp_…@github.com/owner/repo.git`),
 * those credentials WILL be present in `error.message`. Likewise,
 * `fs`-style errnos in the spawn-failure path (`ENOENT`, etc.) can
 * carry absolute home paths (`/Users/<name>/…`).
 *
 * Downstream consumers MUST run `sanitizeGitError(error.message)`
 * (or the higher-level `formatActionFailureToast(prefix, error)`
 * helper, both in `src/utils/gitError.ts`) before surfacing the
 * message in any user-visible channel — toasts, OutputChannel,
 * structured error responses, etc. The structural guard
 * (`scripts/check-action-toasts-sanitized.sh`) enforces this for
 * `vscode.window.show*Message(...)` calls; other surfaces are
 * caller-responsibility.
 *
 * The constructor deliberately does NOT pre-sanitise. Sanitisation
 * is a *rendering-time* concern: callers that log to a private file
 * for diagnostics may want the raw form, while callers that pipe to
 * a toast must scrub. Pre-sanitising in the constructor would erase
 * information the diagnostic-log path legitimately needs.
 */
export class GitCommandError extends Error {
  constructor(
    public readonly command: string,
    public readonly args: string[],
    public readonly result: IGitCommandResult,
    message?: string
  ) {
    super(
      message || `Git command failed: git ${args.join(' ')}\n${result.stderr || result.stdout}`
    );
    this.name = 'GitCommandError';
  }
}

/**
 * Resolve the bare command name `'git'` to an absolute path on PATH.
 *
 * Why: under heavy fork pressure on Linux runners (GitHub Actions
 * inside `xvfb-run`, the e2e suite shows this consistently),
 * libuv's `posix_spawnp` occasionally fails to resolve a bare
 * executable name and emits `spawn git ENOENT` even though `git`
 * is on PATH. Pre-resolving to an absolute path bypasses
 * `posix_spawnp`'s PATH lookup entirely — the spawn either finds
 * the file at the resolved path or fails deterministically.
 *
 * Falls back to the original `'git'` token if resolution fails for
 * any reason. That preserves behaviour for environments where
 * `which`/`where` isn't available or PATH is provider-injected.
 *
 * This runs synchronously ONCE at GitCli construction time. The
 * cost is a single shell-out at startup; the benefit is the
 * elimination of an entire class of Linux-CI flakes.
 */
function resolveGitExecutable(gitName: string): string {
  if (gitName !== 'git') {
    // Caller already supplied an explicit path; trust it.
    return gitName;
  }
  // POSIX: `command -v git`. Windows: `where git`. Both write the
  // resolved absolute path to stdout on success.
  const isWindows = process.platform === 'win32';
  try {
    if (isWindows) {
      const out = execFileSync('where', ['git'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      // `where` may print multiple paths (one per line); take the first.
      const first = out.split(/\r?\n/).find((line) => line.trim().length > 0);
      return first ? first.trim() : gitName;
    }
    const out = execFileSync('/usr/bin/env', ['sh', '-c', 'command -v git'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out.length > 0 ? out : gitName;
  } catch {
    // Resolution failed (no shell, missing `command`, restrictive sandbox,
    // etc.). Fall back to the bare name and let the per-command spawn
    // surface any actual missing-git error to the user.
    return gitName;
  }
}

/**
 * Git CLI wrapper for executing Git commands.
 * Provides a consistent interface for running Git commands and capturing output.
 */
export class GitCli {
  private _gitPath: string;
  /** Injectable spawn (defaults to child_process.spawn) — a test seam for
   * driving timeout / kill behavior with a controllable child. */
  private readonly _spawn: typeof spawn;
  private _onCommandExecuted: vscode.EventEmitter<{
    command: string;
    args: string[];
    result: IGitCommandResult;
  }>;

  /**
   * Event fired when a Git command is executed.
   * Useful for logging to the Console View.
   */
  readonly onCommandExecuted: vscode.Event<{
    command: string;
    args: string[];
    result: IGitCommandResult;
  }>;

  constructor(gitPath: string = 'git', spawnFn: typeof spawn = spawn) {
    // Pre-resolve the bare `'git'` token to an absolute path so
    // `child_process.spawn` skips libuv's PATH lookup entirely. This
    // eliminates the `spawn git ENOENT` flake that surfaces under
    // fork pressure on Linux CI (GitHub Actions inside `xvfb-run`).
    // Pre-resolution is a no-op when caller supplied an explicit path
    // and falls back to the bare name when resolution itself fails.
    this._gitPath = resolveGitExecutable(gitPath);
    this._spawn = spawnFn;
    this._onCommandExecuted = new vscode.EventEmitter();
    this.onCommandExecuted = this._onCommandExecuted.event;
  }

  /**
   * Get the path to the Git executable
   */
  get gitPath(): string {
    return this._gitPath;
  }

  /**
   * Set the path to the Git executable
   */
  set gitPath(value: string) {
    this._gitPath = value;
  }

  /**
   * Execute a Git command and return the result.
   *
   * @param args - Command arguments (without 'git')
   * @param options - Execution options
   * @returns The command result
   * @throws GitCommandError if throwOnError is true and command fails
   */
  async exec(args: string[], options: IGitCommandOptions = {}): Promise<IGitCommandResult> {
    // Belt-and-suspenders against `spawn git ENOENT`:
    //
    //   1. Constructor pre-resolved `'git'` to an absolute path
    //      (`resolveGitExecutable`). That should already make
    //      libuv's PATH lookup a non-issue.
    //   2. If the spawn STILL fails with ENOENT (e.g. concurrent
    //      sandbox tear-down, /tmp racing under load), retry ONCE
    //      after a short delay. The retry uses the same gitPath
    //      because pre-resolution gave us a deterministic absolute
    //      path; a transient ENOENT past that point is virtually
    //      always a fork/scheduler hiccup and not a missing binary.
    //
    // The retry is bounded to one attempt so a real "git not found"
    // surfaces to the user without an interactive hang.
    try {
      return await this._spawnOnce(args, options);
    } catch (err) {
      if (err instanceof GitCommandError && /ENOENT/i.test(err.result.stderr)) {
        await new Promise((r) => setTimeout(r, 50));
        return this._spawnOnce(args, options);
      }
      throw err;
    }
  }

  private _spawnOnce(args: string[], options: IGitCommandOptions): Promise<IGitCommandResult> {
    const { cwd, env, input, throwOnError = false } = options;
    // An explicit `options.timeout` (incl. 0 = no timeout) wins; otherwise apply
    // the per-verb default so a stalled command can't hang the host forever.
    const timeout = resolveGitTimeoutMs(args, options.timeout);

    const spawnOptions: SpawnOptions = {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    };

    return new Promise((resolve, reject) => {
      const process = this._spawn(this._gitPath, args, spawnOptions);

      let stdout = '';
      let stderr = '';
      let combined = '';
      let killed = false;

      // Bound the command: on timeout send SIGTERM, then escalate to SIGKILL if
      // the child ignores it (a hung credential helper can trap SIGTERM). Both
      // timers are cleared on close/error so a normal completion never kills.
      let timeoutId: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      const clearTimers = (): void => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        if (killTimer) {
          clearTimeout(killTimer);
        }
      };
      if (timeout > 0) {
        timeoutId = setTimeout(() => {
          killed = true;
          process.kill('SIGTERM');
          killTimer = setTimeout(() => {
            process.kill('SIGKILL');
          }, GIT_KILL_GRACE_MS);
        }, timeout);
      }

      // Capture stdout / stderr with a hard size cap. Accumulating with a bare
      // `+=` let a huge stream (e.g. a log/diff on a multi-GB repo) overflow
      // V8's max string length and throw RangeError inside this handler —
      // uncaught, it crashed the extension host. appendCapped bounds growth;
      // the try/catch is belt-and-braces so nothing thrown here ever escapes
      // as an uncaught async exception.
      process.stdout?.on('data', (data: Buffer) => {
        try {
          const str = data.toString();
          stdout = appendCapped(stdout, str, MAX_GIT_OUTPUT_BYTES);
          combined = appendCapped(combined, str, MAX_GIT_OUTPUT_BYTES);
          // eslint-disable-next-line no-restricted-syntax -- defensive belt-and-braces; a capture error in this high-frequency data handler must never escape as an uncaught async exception that crashes the host (see the block comment above).
        } catch {
          // Defensive: never let a capture error crash the host.
        }
      });

      process.stderr?.on('data', (data: Buffer) => {
        try {
          const str = data.toString();
          stderr = appendCapped(stderr, str, MAX_GIT_OUTPUT_BYTES);
          combined = appendCapped(combined, str, MAX_GIT_OUTPUT_BYTES);
          // eslint-disable-next-line no-restricted-syntax -- defensive belt-and-braces; a capture error in this high-frequency data handler must never escape as an uncaught async exception that crashes the host (see the block comment above).
        } catch {
          // Defensive: never let a capture error crash the host.
        }
      });

      // Handle process completion
      process.on('close', (code) => {
        clearTimers();

        const result: IGitCommandResult = {
          exitCode: killed ? -1 : (code ?? -1),
          stdout,
          stderr,
          combined,
        };

        // Fire the command executed event
        this._onCommandExecuted.fire({ command: this._gitPath, args, result });

        if (killed) {
          reject(new GitCommandError(this._gitPath, args, result, 'Git command timed out'));
        } else if (throwOnError && code !== 0) {
          reject(new GitCommandError(this._gitPath, args, result));
        } else {
          resolve(result);
        }
      });

      // Handle process errors
      process.on('error', (error) => {
        clearTimers();

        const result: IGitCommandResult = {
          exitCode: -1,
          stdout,
          stderr: error.message,
          combined: combined + error.message,
        };

        reject(
          new GitCommandError(
            this._gitPath,
            args,
            result,
            `Failed to execute git: ${error.message}`
          )
        );
      });

      // Write input to stdin if provided. Attach an `'error'` handler first so
      // a broken pipe (EPIPE — the child exited without draining stdin) or any
      // other stream error is logged rather than thrown as an uncaught async
      // exception that would crash the extension host.
      if (input && process.stdin) {
        process.stdin.on('error', (error: Error) => {
          getOutputChannel().appendLine(
            `[git] stdin write failed for "${this._gitPath} ${args.join(' ')}": ${error.message}`
          );
        });
        process.stdin.write(input);
        process.stdin.end();
      }
    });
  }

  /**
   * Execute a Git command and return stdout on success.
   * Throws on non-zero exit code.
   *
   * @param args - Command arguments
   * @param options - Execution options
   * @returns The stdout output
   */
  async execString(args: string[], options: IGitCommandOptions = {}): Promise<string> {
    const result = await this.exec(args, { ...options, throwOnError: true });
    return result.stdout;
  }

  /**
   * Check if Git is available and working.
   *
   * Implemented in terms of {@link getVersion} so the system-fault path (git
   * missing → spawn ENOENT) is classified rather than swallowed: availability
   * is exactly "git ran `--version` successfully", and any spawn/command fault
   * is, by definition, "not available".
   *
   * @returns True if Git is available
   */
  async isAvailable(): Promise<boolean> {
    return (await this.getVersion()).isOk();
  }

  /**
   * Get the Git version.
   *
   * @returns `Ok(version)` on success, or `Err(GitError)` — a spawn fault when
   *   git is missing/unspawnable, else a command failure.
   */
  getVersion(): ResultAsync<string, GitError> {
    return ResultAsync.fromPromise(this.exec(['--version']), classifyGitCommandError).andThen(
      (result) => {
        if (result.exitCode !== 0) {
          return err(new CommandFailedError(result.exitCode, result.stderr));
        }
        // Parse "git version X.Y.Z" format.
        const match = result.stdout.match(/git version (\d+\.\d+\.\d+)/);
        return ok(match ? match[1] : result.stdout.trim());
      }
    );
  }

  /**
   * Check if a directory is a Git repository.
   *
   * @param path - The directory path to check
   * @returns `Ok(true)`/`Ok(false)` for the domain answer (a non-repo directory
   *   exits non-zero → `Ok(false)`), or `Err(GitError)` when git could not be
   *   spawned (e.g. `path` is a file → `ENOTDIR`). A system fault is never
   *   collapsed into "not a repository".
   */
  isRepository(path: string): ResultAsync<boolean, GitError> {
    return ResultAsync.fromPromise(
      this.exec(['rev-parse', '--git-dir'], { cwd: path }),
      classifyGitCommandError
    ).map((result) => result.exitCode === 0);
  }

  /**
   * Get the root directory of a Git repository.
   *
   * @param path - A path within the repository
   * @returns `Ok(root)` when `path` is inside a repo, `Ok(undefined)` when it is
   *   a real directory that simply isn't a repo (the expected domain absence),
   *   or `Err(GitError)` when git could not be spawned (e.g. `path` is a file →
   *   `ENOTDIR`). Distinguishing the last two is the whole point: a swallowed
   *   `ENOTDIR` used to masquerade as "no repository found".
   */
  getRepositoryRoot(path: string): ResultAsync<string | undefined, GitError> {
    return ResultAsync.fromPromise(
      this.exec(['rev-parse', '--show-toplevel'], { cwd: path }),
      classifyGitCommandError
    ).map((result) => (result.exitCode === 0 ? result.stdout.trim() : undefined));
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this._onCommandExecuted.dispose();
  }
}

/**
 * Create a new GitCli instance with the default Git path.
 *
 * @param gitPath - Optional path to the Git executable
 * @returns A new GitCli instance
 */
export function createGitCli(gitPath?: string): GitCli {
  return new GitCli(gitPath);
}

/**
 * argv-injection-safe ref splice.
 *
 * Composes git argv from `subcommand`, `flags`, and user-controlled
 * `refs`/`paths`. Inserts `--end-of-options` between flag args and ref
 * args structurally, so a malicious ref like `--upload-pack=evil`
 * cannot land as a flag. Pinned by gitArgInjection.property.test.ts.
 *
 * Layout:
 *   `<subcommand> <...flags> [--end-of-options <...refs>] [-- <...paths>]`
 *
 * `--end-of-options` is emitted only when `refs.length > 0`. The path
 * separator `--` is emitted whenever `paths !== undefined`, even when
 * `paths` is empty — callers that want "no path filter" should pass
 * `undefined` instead of `[]`.
 *
 * Introduced this discipline ad-hoc in `getMergeBase`;
 * generalizes it across every ref-consuming GitService method.
 */
export function buildGitArgs(
  subcommand: string,
  flags: string[],
  refs: string[],
  paths?: string[]
): string[] {
  const argv: string[] = [subcommand, ...flags];
  if (refs.length > 0) {
    argv.push('--end-of-options', ...refs);
  }
  if (paths !== undefined) {
    argv.push('--', ...paths);
  }
  return argv;
}
