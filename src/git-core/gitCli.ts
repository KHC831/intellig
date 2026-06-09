import * as vscode from 'vscode';
import { spawn, SpawnOptions, execFileSync } from 'child_process';

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
  /** Timeout in milliseconds (0 = no timeout) */
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

  constructor(gitPath: string = 'git') {
    // Pre-resolve the bare `'git'` token to an absolute path so
    // `child_process.spawn` skips libuv's PATH lookup entirely. This
    // eliminates the `spawn git ENOENT` flake that surfaces under
    // fork pressure on Linux CI (GitHub Actions inside `xvfb-run`).
    // Pre-resolution is a no-op when caller supplied an explicit path
    // and falls back to the bare name when resolution itself fails.
    this._gitPath = resolveGitExecutable(gitPath);
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
    const { cwd, env, timeout = 0, input, throwOnError = false } = options;

    const spawnOptions: SpawnOptions = {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    };

    return new Promise((resolve, reject) => {
      const process = spawn(this._gitPath, args, spawnOptions);

      let stdout = '';
      let stderr = '';
      let combined = '';
      let killed = false;

      // Set up timeout if specified
      let timeoutId: NodeJS.Timeout | undefined;
      if (timeout > 0) {
        timeoutId = setTimeout(() => {
          killed = true;
          process.kill('SIGTERM');
        }, timeout);
      }

      // Capture stdout
      process.stdout?.on('data', (data: Buffer) => {
        const str = data.toString();
        stdout += str;
        combined += str;
      });

      // Capture stderr
      process.stderr?.on('data', (data: Buffer) => {
        const str = data.toString();
        stderr += str;
        combined += str;
      });

      // Handle process completion
      process.on('close', (code) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

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
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

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

      // Write input to stdin if provided
      if (input && process.stdin) {
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
   * @returns True if Git is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      const result = await this.exec(['--version']);
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  /**
   * Get the Git version.
   *
   * @returns The Git version string, or undefined if not available
   */
  async getVersion(): Promise<string | undefined> {
    try {
      const result = await this.exec(['--version']);
      if (result.exitCode === 0) {
        // Parse "git version X.Y.Z" format
        const match = result.stdout.match(/git version (\d+\.\d+\.\d+)/);
        return match ? match[1] : result.stdout.trim();
      }
    } catch {
      // Ignore errors
    }
    return undefined;
  }

  /**
   * Check if a directory is a Git repository.
   *
   * @param path - The directory path to check
   * @returns True if the directory is a Git repository
   */
  async isRepository(path: string): Promise<boolean> {
    try {
      const result = await this.exec(['rev-parse', '--git-dir'], { cwd: path });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  /**
   * Get the root directory of a Git repository.
   *
   * @param path - A path within the repository
   * @returns The repository root path, or undefined if not in a repository
   */
  async getRepositoryRoot(path: string): Promise<string | undefined> {
    try {
      const result = await this.exec(['rev-parse', '--show-toplevel'], { cwd: path });
      if (result.exitCode === 0) {
        return result.stdout.trim();
      }
    } catch {
      // Ignore errors
    }
    return undefined;
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
