import { promises as fsp } from 'fs';
import * as nodePath from 'path';
import { ResultAsync, ok, err, okAsync, errAsync } from 'neverthrow';
import {
  IRepository,
  IFileStatus,
  IHunk,
  IDiffLine,
  ResetMode,
  IRollbackChange,
  IRollbackOptions,
} from '../interfaces/IGitService';
import {
  GitError,
  CommandFailedError,
  InvalidArgumentError,
  classifyGitCommandError,
} from '../errors';
import { parseStatus } from '../gitParser';
import { IGitOpsContext } from './GitOpsContext';

/**
 * Working-tree index & patch staging operations extracted from the
 * {@link GitService} façade. Stateless: reaches the live GitCli + cache
 * invalidation lazily through {@link IGitOpsContext}.
 */
export class StagingOps {
  constructor(private readonly ctx: IGitOpsContext) {}

  getStatus(repo: IRepository): ResultAsync<IFileStatus[], GitError> {
    // `git status --porcelain` exits 0 on any real repo, so a non-zero exit is
    // a genuine failure (not-a-repo / system) → Err, never a silent empty list.
    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(['status', '--porcelain', '-z'], { cwd: repo.rootUri.fsPath }),
      classifyGitCommandError
    ).andThen((result) =>
      result.exitCode !== 0
        ? err(new CommandFailedError(result.exitCode, result.stderr))
        : ok(parseStatus(result.stdout))
    );
  }

  stage(repo: IRepository, paths: string[]): ResultAsync<void, GitError> {
    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(['add', '--', ...paths], {
        cwd: repo.rootUri.fsPath,
        throwOnError: true,
      }),
      classifyGitCommandError
    ).map(() => {
      this.ctx.invalidateCache(repo.rootUri.fsPath);
    });
  }

  unstage(repo: IRepository, paths: string[]): ResultAsync<void, GitError> {
    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(['reset', 'HEAD', '--', ...paths], {
        cwd: repo.rootUri.fsPath,
        throwOnError: true,
      }),
      classifyGitCommandError
    ).map(() => {
      this.ctx.invalidateCache(repo.rootUri.fsPath);
    });
  }

  /**
   * Stage a single hunk from a file.
   *
   * @param repo - The repository
   * @param path - The file path
   * @param hunk - The hunk to stage
   */
  stageHunk(repo: IRepository, path: string, hunk: IHunk): ResultAsync<void, GitError> {
    // Generate a patch for the hunk
    const patch = this.generateHunkPatch(path, hunk);

    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(['apply', '--cached', '-'], {
        cwd: repo.rootUri.fsPath,
        input: patch,
        throwOnError: true,
      }),
      classifyGitCommandError
    ).map(() => {
      this.ctx.invalidateCache(repo.rootUri.fsPath);
    });
  }

  /**
   * Stage specific lines within a file.
   * This generates a custom patch that includes only the specified lines.
   *
   * @param repo - The repository
   * @param path - The file path
   * @param lines - Array of line numbers (1-indexed) in the new file to stage
   * @param hunk - The hunk containing the lines to stage
   */
  stageLines(
    repo: IRepository,
    path: string,
    lines: number[],
    hunk: IHunk
  ): ResultAsync<void, GitError> {
    if (lines.length === 0) {
      return okAsync(undefined);
    }

    // Generate a patch that includes only the specified lines
    const patch = this.generateLinesPatch(path, lines, hunk);

    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(['apply', '--cached', '-'], {
        cwd: repo.rootUri.fsPath,
        input: patch,
        throwOnError: true,
      }),
      classifyGitCommandError
    ).map(() => {
      this.ctx.invalidateCache(repo.rootUri.fsPath);
    });
  }

  /**
   * Unstage a single hunk from a file.
   * This generates a reverse patch and applies it to the index.
   *
   * @param repo - The repository
   * @param path - The file path
   * @param hunk - The hunk to unstage
   */
  unstageHunk(repo: IRepository, path: string, hunk: IHunk): ResultAsync<void, GitError> {
    // Generate a patch for the hunk
    const patch = this.generateHunkPatch(path, hunk);

    // Apply the patch in reverse to unstage
    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(['apply', '--cached', '-R', '-'], {
        cwd: repo.rootUri.fsPath,
        input: patch,
        throwOnError: true,
      }),
      classifyGitCommandError
    ).map(() => {
      this.ctx.invalidateCache(repo.rootUri.fsPath);
    });
  }

  /**
   * Revert (discard) a single hunk in the WORKING TREE.
   *
   * IntelliJ's "Revert Chunk" discards one hunk's working-tree change without
   * staging anything. This reverse-applies the hunk patch to the working tree
   * — `git apply -R` WITHOUT `--cached`, the one difference from
   * {@link unstageHunk} (which reverse-applies to the index).
   *
   * @param repo - The repository
   * @param path - The file path
   * @param hunk - The hunk to discard
   */
  revertHunk(repo: IRepository, path: string, hunk: IHunk): ResultAsync<void, GitError> {
    return ResultAsync.fromPromise(this._revertHunk(repo, path, hunk), classifyGitCommandError);
  }

  private async _revertHunk(repo: IRepository, path: string, hunk: IHunk): Promise<void> {
    // Reverting touches the working tree only (no `--cached`). If the file also
    // has staged changes the index keeps its pre-revert content, so the
    // "discarded" hunk silently reappears on the next commit. Refuse rather
    // than leave a stale index behind.
    const staged = await this.ctx.gitCli.exec(['diff', '--cached', '--name-only', '--', path], {
      cwd: repo.rootUri.fsPath,
    });
    if (staged.exitCode === 0 && staged.stdout.trim().length > 0) {
      throw new InvalidArgumentError(
        'Stage or unstage this file first — it has staged changes that would otherwise keep the reverted hunk in the next commit.'
      );
    }

    const patch = this.generateHunkPatch(path, hunk);

    await this.ctx.gitCli.exec(['apply', '-R', '-'], {
      cwd: repo.rootUri.fsPath,
      input: patch,
      throwOnError: true,
    });
    this.ctx.invalidateCache(repo.rootUri.fsPath);
  }

  /**
   * Revert (discard) uncommitted changes to a file.
   * This restores the file to its last committed state.
   *
   * @param repo - The repository
   * @param path - The file path to revert
   */
  revertFile(repo: IRepository, path: string): ResultAsync<void, GitError> {
    // Use git checkout -- <path> to discard changes
    // This works for both modified and deleted files
    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(['checkout', '--', path], {
        cwd: repo.rootUri.fsPath,
        throwOnError: true,
      }),
      classifyGitCommandError
    ).map(() => {
      this.ctx.invalidateCache(repo.rootUri.fsPath);
    });
  }

  /**
   * Roll back local changes for a set of selected files — IntelliJ's
   * "Rollback" / "Revert Local Changes".
   *
   * Mirrors git4idea GitRollbackEnvironment.rollbackChanges: classify each
   * file by status, then unindex added files, delete the files the caller
   * opted into removing, and finally revert tracked changes from HEAD. Every
   * path is passed positionally behind `--` so a path that looks like a flag
   * (e.g. `--force`) can never be read as one.
   */
  rollbackChanges(
    repo: IRepository,
    changes: IRollbackChange[],
    options: IRollbackOptions = {}
  ): ResultAsync<void, GitError> {
    return ResultAsync.fromPromise(
      this._rollbackChanges(repo, changes, options),
      classifyGitCommandError
    );
  }

  private async _rollbackChanges(
    repo: IRepository,
    changes: IRollbackChange[],
    options: IRollbackOptions = {}
  ): Promise<void> {
    const toRevert: string[] = []; // modified/deleted/renamed → checkout HEAD
    const toUnindex: string[] = []; // added (staged-new) → rm --cached
    const toDelete: string[] = []; // working-tree files to remove from disk

    for (const change of changes) {
      switch (change.status) {
        case 'modified':
        case 'deleted':
        case 'renamed':
        case 'copied':
          toRevert.push(change.path);
          break;
        case 'added':
          // Unindex so the file reverts to untracked, matching git4idea's
          // "unversion" step; only destroy it on disk when asked.
          toUnindex.push(change.path);
          if (options.deleteAddedFiles) {
            toDelete.push(change.path);
          }
          break;
        case 'untracked':
          // No committed state to restore — only removable, and only when the
          // caller explicitly included it.
          if (options.deleteUntracked) {
            toDelete.push(change.path);
          }
          break;
        // ignored / conflicted: not rolled back here.
      }
    }

    const cwd = repo.rootUri.fsPath;

    if (toUnindex.length > 0) {
      await this.ctx.gitCli.exec(['rm', '--cached', '-f', '--', ...toUnindex], {
        cwd,
        throwOnError: true,
      });
    }

    for (const rel of toDelete) {
      // This is a recursive force-delete, so never trust `rel` to stay inside
      // the repo: an empty/"."/absolute/`..`-escaping path would otherwise
      // resolve to the working-tree root (or outside it) and wipe it. Require
      // the resolved target to be STRICTLY inside the repo root.
      const abs = nodePath.resolve(cwd, rel);
      const root = nodePath.resolve(cwd);
      if (abs === root || !abs.startsWith(root + nodePath.sep)) {
        throw new InvalidArgumentError(`Refusing to delete a path outside the repository: ${rel}`);
      }
      await fsp.rm(abs, { force: true, recursive: true });
    }

    if (toRevert.length > 0) {
      await this.ctx.gitCli.exec(['checkout', 'HEAD', '--', ...toRevert], {
        cwd,
        throwOnError: true,
      });
    }

    this.ctx.invalidateCache(cwd);
  }

  /**
   * Reset the current branch to the given target commit using one of the four
   * IntelliJ reset modes.
   */
  resetToCommit(repo: IRepository, target: string, mode: ResetMode): ResultAsync<void, GitError> {
    // Security: reject refs starting with `-` (git would treat them as CLI
    // flags, bypassing the argv-spawn defense) or `.` (invalid per
    // git-check-ref-format). Mirrors the ResetDialog.isValidRef guard.
    if (!target || !/^(?![-.])[A-Za-z0-9_./@:~^-]+$/.test(target)) {
      return errAsync(new InvalidArgumentError(`Invalid reset target: ${target}`));
    }
    const modeFlag = `--${mode}`;
    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(['reset', modeFlag, target], {
        cwd: repo.rootUri.fsPath,
        throwOnError: true,
      }),
      classifyGitCommandError
    ).map(() => {
      this.ctx.invalidateCache(repo.rootUri.fsPath);
    });
  }

  /**
   * Build the `diff --git` / `---` / `+++` header lines for a hunk patch,
   * quoting the path exactly as git would (see {@link escapePatchPath}).
   *
   * `git apply` parses the path off the `---`/`+++` lines treating a TAB as a
   * field delimiter and a NEWLINE as a line delimiter, so a raw `a/<path>` on a
   * name carrying a tab/newline (or other special byte) makes git stage the
   * WRONG file or reject the patch. When the path is unquoted but contains a
   * space, git tab-delimits the `---`/`+++` name so its parser still finds the
   * end of the filename — mirror that too.
   *
   * @param path - The file path
   * @returns The three header lines, in order.
   */
  private patchHeader(path: string): string[] {
    const a = this.escapePatchPath(`a/${path}`);
    const b = this.escapePatchPath(`b/${path}`);
    const quoted = a.startsWith('"');
    const tail = !quoted && path.includes(' ') ? '\t' : '';
    return [`diff --git ${a} ${b}`, `--- ${a}${tail}`, `+++ ${b}${tail}`];
  }

  /**
   * Quote a prefixed patch path the way git's own diff writer does.
   *
   * git C-style double-quotes the name (wrapping the `a/`|`b/` prefix INSIDE the
   * quotes, with `\t \n \" \\ \NNN` escapes) when it contains a double quote,
   * backslash, control byte, DEL, or non-ASCII byte; otherwise it emits the name
   * bare. The escapes are byte-wise over the UTF-8 encoding, matching git's
   * `quote_c_style` (e.g. `é` → `\303\251`).
   *
   * @param name - The prefixed name token, e.g. `a/<path>` or `b/<path>`.
   * @returns The bare name, or its C-style quoted form when quoting is required.
   */
  private escapePatchPath(name: string): string {
    const bytes = Buffer.from(name, 'utf8');
    const needsQuoting = bytes.some(
      (byte) => byte < 0x20 || byte === 0x22 || byte === 0x5c || byte >= 0x7f
    );
    if (!needsQuoting) {
      return name;
    }

    let out = '"';
    for (const byte of bytes) {
      switch (byte) {
        case 0x07:
          out += '\\a';
          break;
        case 0x08:
          out += '\\b';
          break;
        case 0x09:
          out += '\\t';
          break;
        case 0x0a:
          out += '\\n';
          break;
        case 0x0b:
          out += '\\v';
          break;
        case 0x0c:
          out += '\\f';
          break;
        case 0x0d:
          out += '\\r';
          break;
        case 0x22:
          out += '\\"';
          break;
        case 0x5c:
          out += '\\\\';
          break;
        default:
          if (byte < 0x20 || byte >= 0x7f) {
            out += '\\' + byte.toString(8).padStart(3, '0');
          } else {
            out += String.fromCharCode(byte);
          }
      }
    }
    return out + '"';
  }

  /**
   * Generate a patch string for a single hunk.
   *
   * @param path - The file path
   * @param hunk - The hunk to generate a patch for
   * @returns The patch string
   */
  private generateHunkPatch(path: string, hunk: IHunk): string {
    const lines: string[] = [...this.patchHeader(path), hunk.header];

    for (const line of hunk.lines) {
      switch (line.type) {
        case 'add':
          lines.push(`+${line.content}`);
          break;
        case 'delete':
          lines.push(`-${line.content}`);
          break;
        case 'context':
          lines.push(` ${line.content}`);
          break;
      }
    }

    return lines.join('\n') + '\n';
  }

  /**
   * Generate a patch string for specific lines within a hunk.
   * This creates a patch that only includes the selected lines while
   * converting unselected additions to context and keeping unselected deletions.
   *
   * @param path - The file path
   * @param selectedLines - Array of line numbers (1-indexed) in the new file to include
   * @param hunk - The hunk containing the lines
   * @returns The patch string
   */
  private generateLinesPatch(path: string, selectedLines: number[], hunk: IHunk): string {
    const selectedSet = new Set(selectedLines);

    // Build the new hunk with only selected lines
    const newLines: IDiffLine[] = [];
    let currentNewLine = hunk.newStart;
    let oldLines = 0;
    let newLinesCount = 0;

    for (const line of hunk.lines) {
      if (line.type === 'context') {
        // Context lines are always included
        newLines.push(line);
        oldLines++;
        newLinesCount++;
        currentNewLine++;
      } else if (line.type === 'add') {
        if (selectedSet.has(currentNewLine)) {
          // Include selected additions
          newLines.push(line);
          newLinesCount++;
        } else {
          // Convert unselected additions to context (they exist in working copy)
          // Skip them - they won't be staged
        }
        currentNewLine++;
      } else if (line.type === 'delete') {
        // For deletions, we need to check if the corresponding line is selected
        // Deletions don't have a new line number, so we include them if any
        // adjacent additions are selected, or always include them for simplicity
        // In practice, line-level staging of deletions is complex
        // For now, include deletions that are explicitly selected or adjacent to selected lines
        const lineNumber = line.oldLineNumber;
        if (lineNumber !== undefined && selectedSet.has(lineNumber)) {
          newLines.push(line);
          oldLines++;
        } else {
          // Convert unselected deletions to context
          newLines.push({
            type: 'context',
            content: line.content,
            oldLineNumber: line.oldLineNumber,
            newLineNumber: currentNewLine,
          });
          oldLines++;
          newLinesCount++;
        }
      }
    }

    // If no lines were actually selected for staging, return empty
    const hasChanges = newLines.some((l) => l.type === 'add' || l.type === 'delete');
    if (!hasChanges) {
      return '';
    }

    // Generate the new hunk header
    const newHeader = `@@ -${hunk.oldStart},${oldLines} +${hunk.newStart},${newLinesCount} @@`;

    const patchLines: string[] = [...this.patchHeader(path), newHeader];

    for (const line of newLines) {
      switch (line.type) {
        case 'add':
          patchLines.push(`+${line.content}`);
          break;
        case 'delete':
          patchLines.push(`-${line.content}`);
          break;
        case 'context':
          patchLines.push(` ${line.content}`);
          break;
      }
    }

    return patchLines.join('\n') + '\n';
  }
}
