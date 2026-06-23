import { ResultAsync, errAsync } from 'neverthrow';
import {
  IRepository,
  ICommit,
  ITag,
  IStash,
  IDiff,
  IStashOptions,
  ILogOptions,
  IFileHistoryOptions,
} from '../interfaces/IGitService';
import { buildGitArgs } from '../gitCli';
import {
  GitError,
  CommandFailedError,
  InvalidArgumentError,
  classifyGitCommandError,
} from '../errors';
import {
  parseLog,
  parseCommit,
  parseTags,
  parseStashList,
  parseDiff,
  getLogFormat,
  getTagFormat,
} from '../gitParser';
import { IGitOpsContext } from './GitOpsContext';

/**
 * Stash + tag + history (getLog/getCommit/getFileHistory) operations
 * extracted from the {@link GitService} façade. Stateless: reaches the live
 * GitCli + cache invalidation lazily through {@link IGitOpsContext}.
 *
 * NOTE: commit/amend/fetch/pull/push/remotes stay on the façade because
 * `fetch()` fires the `_onDidFetch` emitter, which is not crossed into a
 * collaborator this batch.
 */
export class StashTagHistoryOps {
  constructor(private readonly ctx: IGitOpsContext) {}

  stash(repo: IRepository, message?: string, options?: IStashOptions): ResultAsync<void, GitError> {
    const args = ['stash', 'push'];

    if (message) {
      args.push('-m', message);
    }
    if (options?.includeUntracked) {
      args.push('--include-untracked');
    }
    if (options?.keepIndex) {
      args.push('--keep-index');
    }

    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true }),
      classifyGitCommandError
    ).map(() => {
      this.ctx.invalidateCache(repo.rootUri.fsPath);
    });
  }

  stashList(repo: IRepository): ResultAsync<IStash[], GitError> {
    // `--format=%gd<sep>%ci<sep>%gs` carries the stash's real committer date
    // (`%ci`); plain `git stash list` has no date, so parseStashList would
    // stamp every entry with the current time. `\x1f` separator matches the
    // log/tag/branch formats. `git stash list` exits 0 on any repo, so a
    // non-zero exit is a genuine failure → degraded empty list (the facade
    // logs + returns []). A spawn/system fault rejects exec → classified Err.
    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(['stash', 'list', '--format=%gd\x1f%ci\x1f%gs'], {
        cwd: repo.rootUri.fsPath,
      }),
      classifyGitCommandError
    ).map((result) => (result.exitCode !== 0 ? [] : parseStashList(result.stdout)));
  }

  /**
   * Validate a stash index before interpolating it into a `stash@{<index>}`
   * ref. A non-integer or negative value would otherwise produce a malformed
   * ref like `stash@{NaN}` or `stash@{undefined}`, so every stash method that
   * builds such a ref runs this guard first.
   *
   * Returns the typed error (rather than throwing) so single-exec methods can
   * `errAsync(...)` early and keep the Result channel total; the throwing
   * {@link _assertStashIndex} variant is for the multi-step async bodies that
   * are wrapped once in `fromPromise`.
   */
  private _stashIndexError(index: number): InvalidArgumentError | undefined {
    if (!Number.isInteger(index) || index < 0) {
      return new InvalidArgumentError(`Invalid stash index: ${index}`);
    }
    return undefined;
  }

  /** Throwing counterpart of {@link _stashIndexError} for pattern-(b) bodies. */
  private _assertStashIndex(index: number): void {
    const error = this._stashIndexError(index);
    if (error) {
      throw error;
    }
  }

  stashApply(repo: IRepository, index: number, reinstateIndex = true): ResultAsync<void, GitError> {
    const invalid = this._stashIndexError(index);
    if (invalid) {
      return errAsync(invalid);
    }
    // `--index` reinstates the staged/unstaged split; without it git returns
    // previously-staged changes as unstaged. Mirrors IntelliJ's unstash
    // "Reinstate index" checkbox (GitStashUtils.createUnstashHandler), which
    // adds `--index` only when selected. Default true preserves the staged
    // split; false is a working-tree-only apply.
    const args = ['stash', 'apply'];
    if (reinstateIndex) {
      args.push('--index');
    }
    args.push(`stash@{${index}}`);
    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true }),
      classifyGitCommandError
    ).map(() => {
      this.ctx.invalidateCache(repo.rootUri.fsPath);
    });
  }

  stashPop(repo: IRepository, index: number, reinstateIndex = true): ResultAsync<void, GitError> {
    const invalid = this._stashIndexError(index);
    if (invalid) {
      return errAsync(invalid);
    }
    // See stashApply: `--index` reinstates the staged/unstaged split and is
    // gated on the "Reinstate index" choice (IntelliJ GitStashUtils).
    const args = ['stash', 'pop'];
    if (reinstateIndex) {
      args.push('--index');
    }
    args.push(`stash@{${index}}`);
    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true }),
      classifyGitCommandError
    ).map(() => {
      this.ctx.invalidateCache(repo.rootUri.fsPath);
    });
  }

  stashDrop(repo: IRepository, index: number): ResultAsync<void, GitError> {
    const invalid = this._stashIndexError(index);
    if (invalid) {
      return errAsync(invalid);
    }
    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(['stash', 'drop', `stash@{${index}}`], {
        cwd: repo.rootUri.fsPath,
        throwOnError: true,
      }),
      classifyGitCommandError
    ).map(() => {
      this.ctx.invalidateCache(repo.rootUri.fsPath);
    });
  }

  /**
   * Create a branch rooted at a stashed state and apply the stash into it.
   * See {@link IGitService.stashBranch}.
   */
  stashBranch(repo: IRepository, index: number, branchName: string): ResultAsync<void, GitError> {
    if (!branchName || !branchName.trim()) {
      return errAsync(new InvalidArgumentError('Branch name cannot be empty'));
    }
    const name = branchName.trim();
    // Reject names starting with `-` (git would parse `-foo` as a CLI flag —
    // `branchName` is the leading positional here) or `.` (invalid per
    // git-check-ref-format). Mirrors the createBranch / createTag guards. Also
    // splice `--end-of-options` before the user-controlled name as structural
    // defense in depth.
    if (name.startsWith('-') || name.startsWith('.')) {
      return errAsync(new InvalidArgumentError(`Invalid branch name: ${name}`));
    }
    const invalid = this._stashIndexError(index);
    if (invalid) {
      return errAsync(invalid);
    }
    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(['stash', 'branch', '--end-of-options', name, `stash@{${index}}`], {
        cwd: repo.rootUri.fsPath,
        throwOnError: true,
      }),
      classifyGitCommandError
    ).map(() => {
      this.ctx.invalidateCache(repo.rootUri.fsPath);
    });
  }

  /**
   * Rename a stash by re-storing its commit with a new message and dropping
   * the original entry. See {@link IGitService.stashRename}.
   *
   * Implementation is two git calls:
   *   1. `git rev-parse stash@{<index>}`   — get the stash commit hash.
   *   2. `git stash store -m "<newMessage>" <hash>` — re-store at stash@{0}.
   *   3. `git stash drop stash@{<index+1>}` — drop the now-shifted original.
   *
   * No working-tree changes. On step 3 failure we attempt to drop the new
   * top-of-stack entry so we don't leave duplicates.
   */
  stashRename(repo: IRepository, index: number, newMessage: string): ResultAsync<void, GitError> {
    return ResultAsync.fromPromise(
      this._stashRename(repo, index, newMessage),
      classifyGitCommandError
    );
  }

  private async _stashRename(repo: IRepository, index: number, newMessage: string): Promise<void> {
    this._assertStashIndex(index);
    if (typeof newMessage !== 'string') {
      throw new InvalidArgumentError('New stash message must be a string');
    }

    const cwd = repo.rootUri.fsPath;

    // Resolve the stash ref to a commit hash. Fails if the index
    // doesn't exist.
    const revParse = await this.ctx.gitCli.exec(['rev-parse', `stash@{${index}}`], {
      cwd,
      throwOnError: true,
    });
    const commitHash = revParse.stdout.trim();
    if (!commitHash || !/^[a-f0-9]{7,40}$/i.test(commitHash)) {
      throw new InvalidArgumentError(`Could not resolve stash@{${index}} to a commit`);
    }

    // Store the commit back onto the stash stack with the new
    // message. This creates a duplicate entry at stash@{0}; the original
    // shifts to stash@{index+1}.
    await this.ctx.gitCli.exec(['stash', 'store', '-m', newMessage, commitHash], {
      cwd,
      throwOnError: true,
    });

    // Drop the original (now at index+1). If this fails we try to
    // undo step 2 so the user doesn't end up with a duplicate.
    try {
      await this.ctx.gitCli.exec(['stash', 'drop', `stash@{${index + 1}}`], {
        cwd,
        throwOnError: true,
      });
    } catch (error) {
      // Best-effort rollback of the duplicate.
      try {
        await this.ctx.gitCli.exec(['stash', 'drop', 'stash@{0}'], { cwd });
        // eslint-disable-next-line no-restricted-syntax -- best-effort rollback of the duplicate stash; if it also fails the original error below still surfaces to the caller.
      } catch {
        // If rollback also fails, leave the state as-is; the error below
        // still surfaces to the caller.
      }
      throw error;
    }

    this.ctx.invalidateCache(cwd);
  }

  /**
   * View the contents/diff of a stash.
   *
   * @param repo - The repository
   * @param index - The stash index
   * @returns Array of diffs showing the stash contents
   */
  stashShow(repo: IRepository, index: number): ResultAsync<IDiff[], GitError> {
    const invalid = this._stashIndexError(index);
    if (invalid) {
      return errAsync(invalid);
    }
    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(['stash', 'show', '-p', `stash@{${index}}`], {
        cwd: repo.rootUri.fsPath,
        throwOnError: true,
      }),
      classifyGitCommandError
    ).map((result) => parseDiff(result.stdout));
  }

  getTags(repo: IRepository): ResultAsync<ITag[], GitError> {
    const format = getTagFormat();
    // `git tag -l` exits 0 on any repo, so a non-zero exit is a genuine failure
    // → degraded empty list (the facade logs + returns []). A spawn/system fault
    // rejects exec → classified Err.
    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(['tag', '-l', '--format', format], { cwd: repo.rootUri.fsPath }),
      classifyGitCommandError
    ).map((result) => (result.exitCode !== 0 ? [] : parseTags(result.stdout)));
  }

  createTag(
    repo: IRepository,
    name: string,
    message?: string,
    ref?: string,
    force?: boolean
  ): ResultAsync<void, GitError> {
    // service-boundary reject tag names starting with `-`
    // (git would parse `-foo` as a CLI flag) or `.` (invalid per
    // git-check-ref-format). Mirrors the `createBranch` guard.
    if (!name || name.startsWith('-') || name.startsWith('.')) {
      return errAsync(new InvalidArgumentError(`Invalid tag name: ${name}`));
    }
    // Splice `--end-of-options` between flags and the
    // user-controlled `name` (and optional `ref`). Layouts:
    //   lightweight: `tag [-f] --end-of-options <name> [<ref>]`
    //   annotated  : `tag [-f] -a -m <msg> --end-of-options <name> [<ref>]`
    // Verified: `tag -a --end-of-options <name> -m <msg>` FAILS because
    // `-m` becomes a non-option arg after `--end-of-options`. We therefore
    // place `-m <msg>` BEFORE the separator. `-f` (force overwrite an
    // existing tag — IntelliJ GitTagDialog's Force checkbox) leads the flags.
    const flags: string[] = [];
    if (force) {
      flags.push('-f');
    }
    if (message) {
      flags.push('-a', '-m', message);
    }
    const refs: string[] = [name];
    if (ref) {
      refs.push(ref);
    }
    const args = buildGitArgs('tag', flags, refs);

    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true }),
      classifyGitCommandError
    ).map(() => {
      this.ctx.invalidateCache(repo.rootUri.fsPath);
    });
  }

  deleteTag(repo: IRepository, name: string): ResultAsync<void, GitError> {
    // service-boundary reject tag names starting with `-`
    // (git would parse `-foo` as a CLI flag) or `.` (invalid per
    // git-check-ref-format). Also splice `--end-of-options` between the
    // `-d` flag and the user-controlled name as structural defense in
    // depth.
    if (!name || name.startsWith('-') || name.startsWith('.')) {
      return errAsync(new InvalidArgumentError(`Invalid tag name: ${name}`));
    }
    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(buildGitArgs('tag', ['-d'], [name]), {
        cwd: repo.rootUri.fsPath,
        throwOnError: true,
      }),
      classifyGitCommandError
    ).map(() => {
      this.ctx.invalidateCache(repo.rootUri.fsPath);
    });
  }

  pushTag(repo: IRepository, name: string, remote?: string): ResultAsync<void, GitError> {
    // `name` (and `remote`) are user-controlled; splice via buildGitArgs.
    const args = buildGitArgs('push', [], [remote || 'origin', `refs/tags/${name}`]);
    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true }),
      classifyGitCommandError
    ).map(() => undefined);
  }

  /**
   * Delete a tag on the remote (`git push <remote> :refs/tags/<name>`) —
   * IntelliJ GitDeleteRemoteTagOperation. The colon-prefixed refspec is git's
   * "push nothing to this ref" delete form. Guards the tag name against a
   * leading dash so it can't smuggle a CLI flag into the refspec.
   */
  deleteRemoteTag(repo: IRepository, name: string, remote?: string): ResultAsync<void, GitError> {
    if (!name || name.startsWith('-') || name.startsWith('.')) {
      return errAsync(new InvalidArgumentError(`Invalid tag name: ${name}`));
    }
    const args = buildGitArgs('push', [], [remote || 'origin', `:refs/tags/${name}`]);
    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true }),
      classifyGitCommandError
    ).map(() => {
      this.ctx.invalidateCache(repo.rootUri.fsPath);
    });
  }

  getLog(repo: IRepository, options?: ILogOptions): ResultAsync<ICommit[], GitError> {
    return ResultAsync.fromPromise(this._getLog(repo, options), classifyGitCommandError);
  }

  private async _getLog(repo: IRepository, options?: ILogOptions): Promise<ICommit[]> {
    const format = getLogFormat();
    const args = ['log', `--format=${format}`, '-z'];

    if (options?.maxCount) {
      args.push(`-n${options.maxCount}`);
    }
    if (options?.skip) {
      args.push(`--skip=${options.skip}`);
    }
    if (options?.author) {
      args.push(`--author=${options.author}`);
    }
    if (options?.since) {
      args.push(`--since=${options.since.toISOString()}`);
    }
    if (options?.until) {
      args.push(`--until=${options.until.toISOString()}`);
    }
    if (options?.grep) {
      args.push(`--grep=${options.grep}`);
      // Case-insensitive is git's non-default; the UI's "Match case" toggle is
      // OFF by default, so opt into --regexp-ignore-case unless explicitly
      // case-sensitive. Mirrors IntelliJ TextFilterModel.matchesCase().
      if (!options.caseSensitive) {
        args.push('--regexp-ignore-case');
      }
      // Perl-extended regex enables full regex syntax in --grep (the "Use
      // regex" toggle). Without it git treats --grep as a basic regex.
      if (options.regex) {
        args.push('-E');
      }
    }
    if (options?.noMerges) {
      // Exclude merge commits — IntelliJ's VCS-log "No Merges" filter.
      args.push('--no-merges');
    }
    if (options?.firstParent) {
      // Follow only the first parent of each merge — IntelliJ
      // PermanentGraph.Options.FirstParent.
      args.push('--first-parent');
    }
    if (options?.simplifyMerges) {
      // Prune merges made redundant by history simplification — part of
      // IntelliJ's VCS-log graph options chooser.
      args.push('--simplify-merges');
    }
    if (options?.minParents !== undefined) {
      // Parent-count lower bound — IntelliJ ParentFilterModel min. A number, so
      // it is safe to splice verbatim.
      args.push(`--min-parents=${options.minParents}`);
    }
    if (options?.maxParents !== undefined) {
      // Parent-count upper bound — IntelliJ ParentFilterModel max.
      args.push(`--max-parents=${options.maxParents}`);
    }
    if (options?.all) {
      args.push('--exclude=refs/stash', '--all');
    }
    if (options?.topoOrder) {
      // git's default is date-driven ("show commit, then show its
      // parents in date order"), which interleaves divergent branches
      // and breaks graph rendering after history rewrites (rebase /
      // squash / cherry-pick give commits a "now" committerDate even
      // when their topology hasn't changed). `--topo-order` walks
      // ancestry in topological order so consumers can rely on a
      // commit's parent appearing later in the output. The graph
      // pipeline sets this; non-graph callers (search, file history)
      // can leave it off if they want git's default.
      args.push('--topo-order');
    }
    if (options?.ref) {
      // A single revision/ref (e.g. `origin/feature`) scopes the log to that
      // branch instead of HEAD. `ref` is user-selected, so reject a leading
      // `-` (would smuggle a CLI flag) or `.` (invalid per git-check-ref-format)
      // before the positional push. Mirrors the createBranch/deleteTag guard.
      // exec passes argv (no shell), so once guarded the push is injection-safe.
      // Must precede any `--`/pathspec below.
      if (options.ref.startsWith('-') || options.ref.startsWith('.')) {
        throw new InvalidArgumentError(`Invalid ref: ${options.ref}`);
      }
      args.push(options.ref);
    }
    if (options?.logRange) {
      // User-typed range like "main..feature" (IntelliJ BranchFilterModel range
      // notation → VcsLogRangeFilter). The `..`/`...` separator is expected; a
      // leading `-` would smuggle a CLI flag and a leading `.` is invalid per
      // git-check-ref-format, so reject both. exec passes argv (no shell), so a
      // well-formed range is injection-safe. Callers suppress `--all` (ranges
      // are self-scoping), so this is the only positional revision.
      const range = options.logRange;
      if (range.startsWith('-') || range.startsWith('.')) {
        throw new InvalidArgumentError(`Invalid log range: ${range}`);
      }
      args.push(range);
    }
    if (options?.path) {
      // Path-filtered history: --full-history keeps commits that touched the
      // path even off the simplified first-parent line (merges, side
      // branches), and --simplify-merges then prunes merges made redundant by
      // that filtering — matching IntelliJ's complete file history. Without
      // these, git's default simplification silently drops real history.
      args.push('--full-history', '--simplify-merges', '--', options.path);
    }

    const result = await this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath });
    if (result.exitCode !== 0) {
      return [];
    }

    return parseLog(result.stdout);
  }

  /**
   * Count the commits the SAME refs/filter as {@link getLog} would produce,
   * ignoring the load window (`git rev-list --count`).
   *
   * Every filter that changes the commit SET is mirrored from getLog so the
   * count and the loaded list agree exactly: author, since, until, grep
   * (+ case/regex modifiers), no-merges, first-parent, simplify-merges, parent
   * counts, `--all`, a single `ref`, a `logRange`, and a path filter. The
   * window-only `maxCount`/`skip` and the ordering-only `topoOrder` are
   * intentionally NOT applied — they don't change the total. The same leading
   * `-`/`.` guards as getLog keep `ref`/`logRange` injection-safe. When no
   * `all`/`ref`/`logRange` scope is given, rev-list (unlike `git log`) needs an
   * explicit starting revision, so we count from `HEAD` to match getLog's
   * default.
   */
  getLogCount(repo: IRepository, options?: ILogOptions): ResultAsync<number, GitError> {
    return ResultAsync.fromPromise(this._getLogCount(repo, options), classifyGitCommandError);
  }

  private async _getLogCount(repo: IRepository, options?: ILogOptions): Promise<number> {
    const args = ['rev-list', '--count'];

    if (options?.author) {
      args.push(`--author=${options.author}`);
    }
    if (options?.since) {
      args.push(`--since=${options.since.toISOString()}`);
    }
    if (options?.until) {
      args.push(`--until=${options.until.toISOString()}`);
    }
    if (options?.grep) {
      args.push(`--grep=${options.grep}`);
      if (!options.caseSensitive) {
        args.push('--regexp-ignore-case');
      }
      if (options.regex) {
        args.push('-E');
      }
    }
    if (options?.noMerges) {
      args.push('--no-merges');
    }
    if (options?.firstParent) {
      args.push('--first-parent');
    }
    if (options?.simplifyMerges) {
      args.push('--simplify-merges');
    }
    if (options?.minParents !== undefined) {
      args.push(`--min-parents=${options.minParents}`);
    }
    if (options?.maxParents !== undefined) {
      args.push(`--max-parents=${options.maxParents}`);
    }

    const hasAll = !!options?.all;
    if (hasAll) {
      args.push('--exclude=refs/stash', '--all');
    }
    if (options?.ref) {
      if (options.ref.startsWith('-') || options.ref.startsWith('.')) {
        throw new InvalidArgumentError(`Invalid ref: ${options.ref}`);
      }
      args.push(options.ref);
    }
    if (options?.logRange) {
      const range = options.logRange;
      if (range.startsWith('-') || range.startsWith('.')) {
        throw new InvalidArgumentError(`Invalid log range: ${range}`);
      }
      args.push(range);
    }
    // rev-list (unlike `git log`) has no implicit HEAD: with no ref/range/all
    // scope it errors out, so anchor the walk to HEAD to mirror getLog.
    if (!hasAll && !options?.ref && !options?.logRange) {
      args.push('HEAD');
    }
    if (options?.path) {
      args.push('--full-history', '--simplify-merges', '--', options.path);
    }

    const result = await this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath });
    if (result.exitCode !== 0) {
      return 0;
    }
    const count = parseInt(result.stdout.trim(), 10);
    return Number.isFinite(count) ? count : 0;
  }

  getCommit(repo: IRepository, hash: string): ResultAsync<ICommit, GitError> {
    return ResultAsync.fromPromise(this._getCommit(repo, hash), classifyGitCommandError);
  }

  private async _getCommit(repo: IRepository, hash: string): Promise<ICommit> {
    const format = getLogFormat();
    // `hash` is user-controlled; splice via buildGitArgs.
    const result = await this.ctx.gitCli.exec(
      buildGitArgs('show', ['-s', `--format=${format}`, '-z'], [hash]),
      {
        cwd: repo.rootUri.fsPath,
        throwOnError: true,
      }
    );

    const commit = parseCommit(result.stdout);
    if (!commit) {
      throw new CommandFailedError(1, '', `Failed to parse commit: ${hash}`);
    }

    return commit;
  }

  getFileHistory(
    repo: IRepository,
    path: string,
    options?: IFileHistoryOptions
  ): ResultAsync<ICommit[], GitError> {
    return ResultAsync.fromPromise(
      this._getFileHistory(repo, path, options),
      classifyGitCommandError
    );
  }

  private async _getFileHistory(
    repo: IRepository,
    path: string,
    options?: IFileHistoryOptions
  ): Promise<ICommit[]> {
    // Standalone implementation so we can pass `--follow` and a
    // branch ref that the generic `getLog()` doesn't understand.
    // `branch` is user-controlled; splice via buildGitArgs so
    // `--end-of-options` separates flag args from the ref.
    const format = getLogFormat();
    const flags: string[] = [`--format=${format}`, '-z'];

    if (options?.follow) {
      flags.push('--follow');
    }
    if (options?.maxCount !== undefined && options.maxCount > 0) {
      flags.push('-n', String(options.maxCount));
    }

    const refs: string[] = [];
    if (options?.branch) {
      // A branch/ref name — git log understands both local and remote refs.
      refs.push(options.branch);
    }

    // buildGitArgs writes the trailing `-- <path>` for us when `paths` is
    // non-undefined.
    const args = buildGitArgs('log', flags, refs, [path]);

    const result = await this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath });
    if (result.exitCode !== 0) {
      return [];
    }
    return parseLog(result.stdout);
  }

  /**
   * Line-scoped file history via `git log -L<start>,<end>:<file>`.
   *
   * Mirrors IntelliJ's "Show History for Selection"
   * (`SelectedBlockHistoryAction` / `VcsSelectionHistoryDialog`): the commit
   * list is restricted to the revisions that touched the given line range,
   * with git tracking the range across renames within that block.
   *
   * `-L` embeds the path in its own token, so the whole `-L<start>,<end>:<path>`
   * is a single argv element — `exec` passes argv with no shell, so even a path
   * that looks like a flag cannot break out. The line numbers are validated as
   * positive integers (start ≤ end) before they are spliced, so the token is
   * always well-formed. A separate `-- <path>` pathspec is illegal with `-L`
   * and is intentionally omitted.
   *
   * `-L` implies `--patch`; we pass `--no-patch` so the output is just the
   * custom log records {@link parseLog} understands (no hunk payload).
   */
  getLineHistory(
    repo: IRepository,
    path: string,
    startLine: number,
    endLine: number,
    options?: IFileHistoryOptions
  ): ResultAsync<ICommit[], GitError> {
    return ResultAsync.fromPromise(
      this._getLineHistory(repo, path, startLine, endLine, options),
      classifyGitCommandError
    );
  }

  private async _getLineHistory(
    repo: IRepository,
    path: string,
    startLine: number,
    endLine: number,
    options?: IFileHistoryOptions
  ): Promise<ICommit[]> {
    if (!Number.isInteger(startLine) || startLine < 1) {
      throw new InvalidArgumentError(`Invalid start line for line history: ${startLine}`);
    }
    if (!Number.isInteger(endLine) || endLine < startLine) {
      throw new InvalidArgumentError(`Invalid end line for line history: ${endLine}`);
    }

    const format = getLogFormat();
    // The path rides inside the -L token (one argv element). buildGitArgs
    // treats flags as trusted, which is safe here: the line numbers are
    // validated integers and the path cannot escape the token under argv exec.
    const lineRangeArg = `-L${startLine},${endLine}:${path}`;
    const flags: string[] = ['--no-patch', `--format=${format}`, '-z', lineRangeArg];
    if (options?.maxCount !== undefined && options.maxCount > 0) {
      flags.push('-n', String(options.maxCount));
    }

    const refs: string[] = [];
    if (options?.branch) {
      refs.push(options.branch);
    }

    // No `paths` arg: -L already carries the path, and a `--` pathspec is
    // illegal alongside it.
    const args = buildGitArgs('log', flags, refs);

    const result = await this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath });
    if (result.exitCode !== 0) {
      return [];
    }
    return parseLog(result.stdout);
  }
}
