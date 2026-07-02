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
import {
  restorePathsToHead,
  removeInsideRepo,
  IRestoreToHeadRequest,
} from '../worktree/restoreToHead';
import { IGitOpsContext } from './GitOpsContext';

/**
 * Recognise the stderr `git reset HEAD` emits on an UNBORN branch (a repo with
 * no commits, where HEAD does not resolve) so `unstage` can fall back to
 * `git rm --cached`. Two canonical shapes across git versions.
 */
function isUnbornHeadStderr(stderr: string): boolean {
  return (
    stderr.includes("ambiguous argument 'HEAD'") ||
    stderr.includes("Failed to resolve 'HEAD'") ||
    stderr.includes('bad revision')
  );
}

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
    return ResultAsync.fromPromise(this._unstage(repo, paths), classifyGitCommandError);
  }

  private async _unstage(repo: IRepository, paths: string[]): Promise<void> {
    const cwd = repo.rootUri.fsPath;
    // `git reset HEAD -- <paths>` is the normal unstage, but it fatals on an
    // unborn branch (a repo with no commits — HEAD does not resolve), which is
    // exactly the state when un-staging the FIRST files of a fresh repo. git4idea
    // special-cases this: with no HEAD there is nothing to diff the index
    // against, so `git rm --cached` empties the index entry directly.
    const reset = await this.ctx.gitCli.exec(['reset', 'HEAD', '--', ...paths], { cwd });
    if (reset.exitCode !== 0 && isUnbornHeadStderr(reset.stderr)) {
      await this.ctx.gitCli.exec(['rm', '--cached', '-r', '--', ...paths], {
        cwd,
        throwOnError: true,
      });
    } else if (reset.exitCode !== 0) {
      throw new CommandFailedError(reset.exitCode, reset.stderr, undefined, reset);
    }
    this.ctx.invalidateCache(cwd);
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
    // Restore the file to its last-COMMITTED state via the shared
    // restore-to-HEAD writer. `git checkout HEAD -- <path>` (not the old
    // `checkout -- <path>`, which restores from the INDEX) so a partially-
    // staged file discards its staged edits too — matching the confirm
    // dialog's "revert changes… cannot be undone" promise. The writer probes
    // HEAD membership, so a revert of an added-then-selected file unindexes it
    // instead of a fatal checkout.
    return ResultAsync.fromPromise(
      restorePathsToHead(this.ctx.gitCli, repo.rootUri.fsPath, [{ path }]),
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
    const cwd = repo.rootUri.fsPath;

    // The status came from `git status`, so it is authoritative — pass the
    // `inHead` hint to the shared writer rather than making it re-probe. The
    // writer owns the added/renamed/tracked partition and the safe ordering
    // (unindex → delete → batched checkout), so a rename now restores its OLD
    // path instead of a fatal checkout of the (HEAD-absent) new path.
    const restoreRequests: IRestoreToHeadRequest[] = [];
    // Untracked files have no committed state and are never staged, so they
    // are pure disk deletions — kept out of the writer (which would unindex).
    const untrackedToDelete: string[] = [];

    for (const change of changes) {
      switch (change.status) {
        case 'modified':
        case 'deleted':
          restoreRequests.push({ path: change.path, inHead: true });
          break;
        case 'renamed':
        case 'copied':
          restoreRequests.push({
            path: change.path,
            oldPath: change.oldPath,
            inHead: false,
            removeFromDiskIfAbsentFromHead: true,
          });
          break;
        case 'added':
          // Unindex so the file reverts to untracked (git4idea's "unversion"
          // step); only destroy it on disk when asked.
          restoreRequests.push({
            path: change.path,
            inHead: false,
            removeFromDiskIfAbsentFromHead: options.deleteAddedFiles === true,
          });
          break;
        case 'untracked':
          if (options.deleteUntracked) {
            untrackedToDelete.push(change.path);
          }
          break;
        // ignored / conflicted: not rolled back here.
      }
    }

    if (restoreRequests.length > 0) {
      await restorePathsToHead(this.ctx.gitCli, cwd, restoreRequests);
    }

    for (const rel of untrackedToDelete) {
      // Recursive force-delete via the shared symlink-aware containment guard
      // — never trust `rel` to stay inside the repo (an empty/"."/absolute/
      // `..`-escaping path, or a symlinked intermediate dir, would land the
      // delete at the work-tree root or beyond).
      await removeInsideRepo(cwd, rel);
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
          // Convert unselected deletions to context. `noNewline` must ride
          // along: dropping it made the patch claim a trailing newline the
          // index blob doesn't have (EOF of a no-trailing-newline file).
          newLines.push({
            type: 'context',
            content: line.content,
            oldLineNumber: line.oldLineNumber,
            newLineNumber: currentNewLine,
            noNewline: line.noNewline,
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

    // A no-newline CONTEXT line is only valid as the FINAL patch line. When a
    // selected add follows the kept EOF line, git's own diff shape is a
    // delete + marker + re-add pair (the kept line gains its newline) — emit
    // that instead. Counts are unchanged: context (1 old + 1 new) becomes
    // delete (1 old) + add (1 new).
    for (let i = 0; i < newLines.length - 1; i++) {
      const l = newLines[i];
      if (l.type === 'context' && l.noNewline) {
        newLines.splice(
          i,
          1,
          {
            type: 'delete',
            content: l.content,
            oldLineNumber: l.oldLineNumber,
            noNewline: true,
          },
          { type: 'add', content: l.content, newLineNumber: l.newLineNumber }
        );
        i++; // skip the inserted re-add
      }
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
