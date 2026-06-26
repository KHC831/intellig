import { ResultAsync } from 'neverthrow';
import {
  IRepository,
  ICherryPickOptions,
  ICherryPickResult,
  IRevertOptions,
  IRevertResult,
} from '../interfaces/IGitService';
import { buildGitArgs } from '../gitCli';
import { GitError, InvalidArgumentError, classifyGitCommandError } from '../errors';
import { parseStatus, isConflictedStatus } from '../gitParser';
import { sanitizeGitError } from '../gitError';
import { IGitOpsContext } from './GitOpsContext';

/**
 * Cherry-pick + revert lifecycle operations extracted from the
 * {@link GitService} façade. Stateless: reaches the live GitCli + cache
 * invalidation lazily through {@link IGitOpsContext}.
 */
export class CherryPickRevertOps {
  constructor(private readonly ctx: IGitOpsContext) {}

  /**
   * Validate a `-m <mainline>` parent number before it is spliced into argv.
   * git expects a positive integer (1-based parent index); a fractional,
   * zero, negative, or non-finite value would otherwise be stringified and
   * passed straight to git. Throwing here keeps a malformed caller value from
   * ever reaching the command line.
   */
  private static assertValidMainline(mainline: number): void {
    if (!Number.isInteger(mainline) || mainline < 1) {
      throw new InvalidArgumentError(
        `Invalid mainline parent number: ${mainline}. Expected a positive integer (1-based).`
      );
    }
  }

  /**
   * Cherry-pick one or more commits onto the current branch.
   * Commits are applied in the order provided.
   *
   * `Ok(result)` carries the domain outcome (success, or a conflict/failure
   * with `failureReason`); `Err(GitError)` is reserved for a spawn/system fault
   * or an invalid argument (`InvalidArgumentError` from the mainline guard).
   *
   * @param repo - The repository
   * @param commits - Array of commit hashes to cherry-pick
   */
  cherryPick(
    repo: IRepository,
    commits: string[],
    options?: ICherryPickOptions
  ): ResultAsync<ICherryPickResult, GitError> {
    return ResultAsync.fromPromise(
      this._cherryPick(repo, commits, options),
      classifyGitCommandError
    );
  }

  private async _cherryPick(
    repo: IRepository,
    commits: string[],
    options?: ICherryPickOptions
  ): Promise<ICherryPickResult> {
    if (commits.length === 0) {
      return { success: true };
    }

    // File-subset mode ("Apply Selected Changes"): an empty array
    // means "no files picked" — short-circuit rather than erasing the
    // index. Caller should never invoke with an empty list; return success
    // defensively.
    if (options?.files && options.files.length === 0) {
      return { success: true };
    }

    // When `files` is set we force --no-commit because we need to mutate
    // the index afterwards to narrow to the selected file set.
    const noCommit = options?.noCommit === true || options?.files !== undefined;

    // `commits` are user-controlled; splice via buildGitArgs.
    const cherryFlags: string[] = [];
    if (noCommit) {
      cherryFlags.push('--no-commit');
    }
    // `-x` appends "(cherry picked from commit <hash>)" to each new commit
    // message (IntelliJ addCherryPickedFromSuffix). It only applies when a
    // commit is actually created — with --no-commit (or a file subset, which
    // forces --no-commit) there is no message to annotate, so suppress it.
    if (options?.addCherryPickedFrom && !noCommit) {
      cherryFlags.push('-x');
    }
    // `-m <mainline>` is required when any picked commit is a merge commit;
    // parent 1 is the conventional mainline (the branch the merge landed on).
    if (options?.mainline !== undefined) {
      CherryPickRevertOps.assertValidMainline(options.mainline);
      cherryFlags.push('-m', String(options.mainline));
    }
    const args = buildGitArgs('cherry-pick', cherryFlags, commits);

    const result = await this.ctx.gitCli.exec(args, {
      cwd: repo.rootUri.fsPath,
    });

    this.ctx.invalidateCache(repo.rootUri.fsPath);

    if (result.exitCode !== 0) {
      // Check for conflicts (plain cherry-pick path).
      const conflicts = await this.getConflictedFiles(repo);
      if (conflicts.length > 0) {
        return {
          success: false,
          conflicts,
        };
      }
      // Non-conflict failure (bad object, refused operation, dirty tree
      // for a non-conflicting reason, etc.). Surface git's stderr so the
      // caller can show it instead of dropping the failure silently.
      return {
        success: false,
        conflicts: [],
        failureReason: sanitizeGitError(result.stderr.trim() || result.stdout.trim()) || undefined,
      };
    }

    // Success path: if a file subset was requested, narrow the index +
    // worktree down to those files. Every file touched by the commits that
    // is NOT in the subset is unstaged and restored to its HEAD content.
    if (options?.files && options.files.length > 0) {
      const touched = await this._collectTouchedFiles(repo, commits);
      const keep = new Set(options.files);
      const drop = touched.filter((f) => !keep.has(f));
      if (drop.length > 0) {
        await this._restoreFilesToHead(repo, drop);
      }
      this.ctx.invalidateCache(repo.rootUri.fsPath);
    }

    return { success: true };
  }

  /**
   * Return the union of files touched by each commit (via
   * `git show --name-only -z --format=`). Used by the `files` subset path to
   * determine which files to revert after a `cherry-pick -n`.
   *
   * `-z` NUL-separates the names and emits them verbatim; without it git
   * C-quotes non-ASCII / special-character paths (`"caf\303\251.ts"`), which
   * then never match the user's real selection — so a special-named file
   * outside the selection is silently kept, and the restore targets a
   * non-existent quoted path. A name containing a newline would also split into
   * bogus entries under a `\n` parse.
   */
  private async _collectTouchedFiles(repo: IRepository, commits: string[]): Promise<string[]> {
    const touched = new Set<string>();
    for (const commit of commits) {
      // `commit` is user-controlled; splice via buildGitArgs.
      const res = await this.ctx.gitCli.exec(
        buildGitArgs('show', ['--name-only', '-z', '--format='], [commit]),
        {
          cwd: repo.rootUri.fsPath,
        }
      );
      if (res.exitCode !== 0) {
        continue;
      }
      for (const name of res.stdout.split('\0')) {
        if (name.length > 0) {
          touched.add(name);
        }
      }
    }
    return [...touched];
  }

  /**
   * Unstage + restore a set of files to their HEAD content. Used by the
   * cherry-pick file-subset path to drop files outside the user's
   * selection. Batches the `reset` and `checkout` calls (one call each
   * for the whole set) to avoid N round-trips.
   */
  private async _restoreFilesToHead(repo: IRepository, files: string[]): Promise<void> {
    if (files.length === 0) {
      return;
    }
    // Unstage (may fail if already unstaged; we tolerate that).
    await this.ctx.gitCli.exec(['reset', 'HEAD', '--', ...files], {
      cwd: repo.rootUri.fsPath,
    });
    // Restore working-tree copy.
    await this.ctx.gitCli.exec(['checkout', '--', ...files], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
  }

  /**
   * Abort an in-progress cherry-pick operation.
   * Restores the working directory to its pre-cherry-pick state.
   *
   * @param repo - The repository
   */
  cherryPickAbort(repo: IRepository): ResultAsync<void, GitError> {
    return ResultAsync.fromPromise(this._cherryPickAbort(repo), classifyGitCommandError);
  }

  private async _cherryPickAbort(repo: IRepository): Promise<void> {
    await this.ctx.gitCli.exec(['cherry-pick', '--abort'], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    this.ctx.invalidateCache(repo.rootUri.fsPath);
  }

  /**
   * Continue a cherry-pick operation after resolving conflicts.
   *
   * @param repo - The repository
   * @returns Cherry-pick result with success status and any new conflicts
   */
  cherryPickContinue(repo: IRepository): ResultAsync<ICherryPickResult, GitError> {
    return ResultAsync.fromPromise(this._cherryPickContinue(repo), classifyGitCommandError);
  }

  private async _cherryPickContinue(repo: IRepository): Promise<ICherryPickResult> {
    const result = await this.ctx.gitCli.exec(['cherry-pick', '--continue'], {
      cwd: repo.rootUri.fsPath,
    });

    this.ctx.invalidateCache(repo.rootUri.fsPath);

    if (result.exitCode === 0) {
      return { success: true };
    }

    // Check for conflicts (there might be more commits to cherry-pick)
    const conflicts = await this.getConflictedFiles(repo);

    if (conflicts.length > 0) {
      return {
        success: false,
        conflicts,
      };
    }

    // Non-conflict failure: surface git's stderr so the caller can show
    // it instead of dropping the failure silently.
    return {
      success: false,
      conflicts: [],
      failureReason: sanitizeGitError(result.stderr.trim() || result.stdout.trim()) || undefined,
    };
  }

  /**
   * Get the list of conflicted files in the repository.
   *
   * @param repo - The repository
   * @returns Array of conflicted file paths
   */
  private async getConflictedFiles(repo: IRepository): Promise<string[]> {
    const statusResult = await this.ctx.gitCli.exec(['status', '--porcelain', '-z'], {
      cwd: repo.rootUri.fsPath,
    });
    return parseStatus(statusResult.stdout)
      .filter(isConflictedStatus)
      .map((f) => f.path);
  }

  revert(
    repo: IRepository,
    commits: string[],
    options?: IRevertOptions
  ): ResultAsync<IRevertResult, GitError> {
    return ResultAsync.fromPromise(this._revert(repo, commits, options), classifyGitCommandError);
  }

  private async _revert(
    repo: IRepository,
    commits: string[],
    options?: IRevertOptions
  ): Promise<IRevertResult> {
    if (commits.length === 0) {
      return { success: true };
    }

    const revertFlags: string[] = [];

    // `-m <mainline>` is required when any reverted commit is a merge commit.
    if (options?.mainline !== undefined) {
      CherryPickRevertOps.assertValidMainline(options.mainline);
      revertFlags.push('-m', String(options.mainline));
    }

    if (options?.message !== undefined) {
      // Custom message path: stage without committing, then commit with the
      // provided message so $GIT_EDITOR is never invoked.
      revertFlags.push('--no-commit');
      const stageResult = await this.ctx.gitCli.exec(buildGitArgs('revert', revertFlags, commits), {
        cwd: repo.rootUri.fsPath,
      });
      if (stageResult.exitCode !== 0) {
        this.ctx.invalidateCache(repo.rootUri.fsPath);
        const conflicts = await this.getConflictedFiles(repo);
        if (conflicts.length > 0) {
          return { success: false, conflicts };
        }
        return {
          success: false,
          conflicts: [],
          failureReason:
            sanitizeGitError(stageResult.stderr.trim() || stageResult.stdout.trim()) || undefined,
        };
      }
      const commitResult = await this.ctx.gitCli.exec(['commit', '-m', options.message], {
        cwd: repo.rootUri.fsPath,
      });
      this.ctx.invalidateCache(repo.rootUri.fsPath);
      if (commitResult.exitCode === 0) {
        return { success: true };
      }
      return {
        success: false,
        conflicts: [],
        failureReason:
          sanitizeGitError(commitResult.stderr.trim() || commitResult.stdout.trim()) || undefined,
      };
    }

    // Default path: let git generate the "Revert \"<subject>\"" message.
    revertFlags.push('--no-edit');
    const result = await this.ctx.gitCli.exec(buildGitArgs('revert', revertFlags, commits), {
      cwd: repo.rootUri.fsPath,
    });

    this.ctx.invalidateCache(repo.rootUri.fsPath);

    if (result.exitCode === 0) {
      return { success: true };
    }

    // Check for conflicts
    const conflicts = await this.getConflictedFiles(repo);

    if (conflicts.length > 0) {
      return {
        success: false,
        conflicts,
      };
    }

    // Non-conflict failure: surface git's stderr so the caller can show
    // it instead of dropping the failure silently.
    return {
      success: false,
      conflicts: [],
      failureReason: sanitizeGitError(result.stderr.trim() || result.stdout.trim()) || undefined,
    };
  }

  /**
   * Abort an in-progress revert operation.
   * Restores the working directory to its pre-revert state.
   *
   * @param repo - The repository
   */
  revertAbort(repo: IRepository): ResultAsync<void, GitError> {
    return ResultAsync.fromPromise(this._revertAbort(repo), classifyGitCommandError);
  }

  private async _revertAbort(repo: IRepository): Promise<void> {
    await this.ctx.gitCli.exec(['revert', '--abort'], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    this.ctx.invalidateCache(repo.rootUri.fsPath);
  }

  /**
   * Continue a revert operation after resolving conflicts.
   *
   * @param repo - The repository
   * @returns Revert result with success status and any new conflicts
   */
  revertContinue(repo: IRepository): ResultAsync<IRevertResult, GitError> {
    return ResultAsync.fromPromise(this._revertContinue(repo), classifyGitCommandError);
  }

  private async _revertContinue(repo: IRepository): Promise<IRevertResult> {
    const result = await this.ctx.gitCli.exec(['revert', '--continue'], {
      cwd: repo.rootUri.fsPath,
    });

    this.ctx.invalidateCache(repo.rootUri.fsPath);

    if (result.exitCode === 0) {
      return { success: true };
    }

    // Check for conflicts (there might be more commits to revert)
    const conflicts = await this.getConflictedFiles(repo);

    if (conflicts.length > 0) {
      return {
        success: false,
        conflicts,
      };
    }

    // Non-conflict failure: surface git's stderr so the caller can show
    // it instead of dropping the failure silently.
    return {
      success: false,
      conflicts: [],
      failureReason: sanitizeGitError(result.stderr.trim() || result.stdout.trim()) || undefined,
    };
  }
}
