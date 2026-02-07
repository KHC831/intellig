import * as vscode from 'vscode';
import { spawn, SpawnOptions } from 'child_process';

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
 * Error thrown when a Git command fails
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
    this._gitPath = gitPath;
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
