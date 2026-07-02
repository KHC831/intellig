import { promises as fsp } from 'fs';
import * as nodePath from 'path';
import { ResultAsync, ok, err, okAsync, errAsync } from 'neverthrow';
import {
  IRepository,
  IFileStatus,
  IHunk,
  IDiffLine,
  ILineSelection,
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
import { buildHunkPatch } from '../patchBuilder';
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
   * @param selection - Disambiguated line selection: addLines keyed by
   *   newLineNumber, deleteLines keyed by oldLineNumber. The two number-spaces
   *   are kept separate so a collision between an add's newLineNumber and an
   *   unrelated delete's oldLineNumber cannot cause a false match.
   * @param hunk - The hunk containing the lines to stage
   */
  stageLines(
    repo: IRepository,
    path: string,
    selection: ILineSelection,
    hunk: IHunk
  ): ResultAsync<void, GitError> {
    if (selection.addLines.size === 0 && selection.deleteLines.size === 0) {
      return okAsync(undefined);
    }

    // Generate a patch that includes only the specified lines
    const patch = this.generateLinesPatch(path, selection.addLines, selection.deleteLines, hunk);
    // generateLinesPatch returns '' when the selected lines are all context
    // (no add/delete lines chosen). Passing an empty patch to `git apply`
    // results in a "patch is empty" error; guard and short-circuit instead.
    if (!patch) {
      return okAsync(undefined);
    }

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
   * Generate a patch string for a single hunk. Delegates to the shared
   * {@link buildHunkPatch} so path escaping and the `\ No newline at end of
   * file` marker are handled identically everywhere.
   */
  private generateHunkPatch(path: string, hunk: IHunk): string {
    return buildHunkPatch(path, hunk);
  }

  /**
   * Generate a patch string for specific lines within a hunk.
   * This creates a patch that only includes the selected lines while
   * converting unselected additions to context and keeping unselected deletions.
   *
   * @param path - The file path
   * @param selectedAddLines - newLineNumbers of add-type lines to include
   * @param selectedDeleteLines - oldLineNumbers of delete-type lines to include
   * @param hunk - The hunk containing the lines
   * @returns The patch string
   */
  private generateLinesPatch(
    path: string,
    selectedAddLines: ReadonlySet<number>,
    selectedDeleteLines: ReadonlySet<number>,
    hunk: IHunk
  ): string {
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
        // Add-line selection is keyed by newLineNumber — never matches
        // delete-line numbers (oldLineNumber) even when they share a value.
        if (selectedAddLines.has(currentNewLine)) {
          newLines.push(line);
          newLinesCount++;
        }
        // Unselected additions are simply omitted (not staged).
        currentNewLine++;
      } else if (line.type === 'delete') {
        // Delete-line selection is keyed by oldLineNumber — separate from add
        // selections so a collision in raw numbers cannot cause a false match.
        const lineNumber = line.oldLineNumber;
        if (lineNumber !== undefined && selectedDeleteLines.has(lineNumber)) {
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

    // Reuse the shared serializer so path escaping AND the no-newline marker
    // (carried on each `IDiffLine`) are emitted identically to the whole-hunk
    // path. Wrap the selected lines back into a hunk shape for it.
    const syntheticHunk: IHunk = {
      oldStart: hunk.oldStart,
      oldLines,
      newStart: hunk.newStart,
      newLines: newLinesCount,
      header: newHeader,
      lines: newLines,
    };
    return buildHunkPatch(path, syntheticHunk);
  }
}
