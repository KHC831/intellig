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

  async stash(repo: IRepository, message?: string, options?: IStashOptions): Promise<void> {
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

    await this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true });
    this.ctx.invalidateCache(repo.rootUri.fsPath);
  }

  async stashList(repo: IRepository): Promise<IStash[]> {
    const result = await this.ctx.gitCli.exec(['stash', 'list'], { cwd: repo.rootUri.fsPath });
    if (result.exitCode !== 0) {
      return [];
    }
    return parseStashList(result.stdout);
  }

  /**
   * Validate a stash index before interpolating it into the
   * `stash@{<index>}` ref., `stashApply` / `stashPop` /
   * `stashDrop` / `stashShow` interpolated the raw `index` directly,
   * trusting upstream callers (CommitToolWindow / palette commands) to
   * pass a valid integer. A non-integer or negative value would
   * silently produce a malformed git ref like `stash@{NaN}` or
   * `stash@{undefined}`. The other stash methods (`stashBranch`,
   * `stashRename`) already validated; this helper reuses the same
   * predicate so the pattern is uniform across all 6 sites.
   *
   * Throws (rather than returns) so the caller can trust `index` is a
   * non-negative integer for the rest of the call.
   */
  private _validateStashIndex(index: number): asserts index is number {
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`Invalid stash index: ${index}`);
    }
  }

  async stashApply(repo: IRepository, index: number): Promise<void> {
    this._validateStashIndex(index);
    // `--index` reinstates the staged/unstaged split; without it git returns
    // previously-staged changes as unstaged (IntelliJ parity: GitStashUtils).
    await this.ctx.gitCli.exec(['stash', 'apply', '--index', `stash@{${index}}`], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    this.ctx.invalidateCache(repo.rootUri.fsPath);
  }

  async stashPop(repo: IRepository, index: number): Promise<void> {
    this._validateStashIndex(index);
    await this.ctx.gitCli.exec(['stash', 'pop', '--index', `stash@{${index}}`], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    this.ctx.invalidateCache(repo.rootUri.fsPath);
  }

  async stashDrop(repo: IRepository, index: number): Promise<void> {
    this._validateStashIndex(index);
    await this.ctx.gitCli.exec(['stash', 'drop', `stash@{${index}}`], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    this.ctx.invalidateCache(repo.rootUri.fsPath);
  }

  /**
   * Create a branch rooted at a stashed state and apply the stash into it.
   * See {@link IGitService.stashBranch}.
   */
  async stashBranch(repo: IRepository, index: number, branchName: string): Promise<void> {
    if (!branchName || !branchName.trim()) {
      throw new Error('Branch name cannot be empty');
    }
    this._validateStashIndex(index);
    await this.ctx.gitCli.exec(['stash', 'branch', branchName.trim(), `stash@{${index}}`], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    this.ctx.invalidateCache(repo.rootUri.fsPath);
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
  async stashRename(repo: IRepository, index: number, newMessage: string): Promise<void> {
    this._validateStashIndex(index);
    if (typeof newMessage !== 'string') {
      throw new Error('New stash message must be a string');
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
      throw new Error(`Could not resolve stash@{${index}} to a commit`);
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
  async stashShow(repo: IRepository, index: number): Promise<IDiff[]> {
    this._validateStashIndex(index);
    const result = await this.ctx.gitCli.exec(['stash', 'show', '-p', `stash@{${index}}`], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });

    return parseDiff(result.stdout);
  }

  async getTags(repo: IRepository): Promise<ITag[]> {
    const format = getTagFormat();
    const result = await this.ctx.gitCli.exec(['tag', '-l', '--format', format], {
      cwd: repo.rootUri.fsPath,
    });

    if (result.exitCode !== 0) {
      return [];
    }

    return parseTags(result.stdout);
  }

  async createTag(
    repo: IRepository,
    name: string,
    message?: string,
    ref?: string,
    force?: boolean
  ): Promise<void> {
    // service-boundary reject tag names starting with `-`
    // (git would parse `-foo` as a CLI flag) or `.` (invalid per
    // git-check-ref-format). Mirrors the `createBranch` guard.
    if (!name || name.startsWith('-') || name.startsWith('.')) {
      throw new Error(`Invalid tag name: ${name}`);
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

    await this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true });
    this.ctx.invalidateCache(repo.rootUri.fsPath);
  }

  async deleteTag(repo: IRepository, name: string): Promise<void> {
    // service-boundary reject tag names starting with `-`
    // (git would parse `-foo` as a CLI flag) or `.` (invalid per
    // git-check-ref-format). Also splice `--end-of-options` between the
    // `-d` flag and the user-controlled name as structural defense in
    // depth.
    if (!name || name.startsWith('-') || name.startsWith('.')) {
      throw new Error(`Invalid tag name: ${name}`);
    }
    await this.ctx.gitCli.exec(buildGitArgs('tag', ['-d'], [name]), {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    this.ctx.invalidateCache(repo.rootUri.fsPath);
  }

  async pushTag(repo: IRepository, name: string, remote?: string): Promise<void> {
    // `name` (and `remote`) are user-controlled; splice via buildGitArgs.
    const args = buildGitArgs('push', [], [remote || 'origin', `refs/tags/${name}`]);
    await this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true });
  }

  /**
   * Delete a tag on the remote (`git push <remote> :refs/tags/<name>`) —
   * IntelliJ GitDeleteRemoteTagOperation. The colon-prefixed refspec is git's
   * "push nothing to this ref" delete form. Guards the tag name against a
   * leading dash so it can't smuggle a CLI flag into the refspec.
   */
  async deleteRemoteTag(repo: IRepository, name: string, remote?: string): Promise<void> {
    if (!name || name.startsWith('-') || name.startsWith('.')) {
      throw new Error(`Invalid tag name: ${name}`);
    }
    const args = buildGitArgs('push', [], [remote || 'origin', `:refs/tags/${name}`]);
    await this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true });
    this.ctx.invalidateCache(repo.rootUri.fsPath);
  }

  async getLog(repo: IRepository, options?: ILogOptions): Promise<ICommit[]> {
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
    }
    if (options?.noMerges) {
      // Exclude merge commits — IntelliJ's VCS-log "No Merges" filter.
      args.push('--no-merges');
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
      // branch instead of HEAD. Refnames can't start with `-`, and exec passes
      // argv (no shell), so a positional push is injection-safe. Must precede
      // any `--`/pathspec below.
      args.push(options.ref);
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

  async getCommit(repo: IRepository, hash: string): Promise<ICommit> {
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
      throw new Error(`Failed to parse commit: ${hash}`);
    }

    return commit;
  }

  async getFileHistory(
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
}
