import { readConfig } from '../../config/configKeys';
import { ResultAsync, ok, err, errAsync } from 'neverthrow';
import {
  IRepository,
  ICommitOptions,
  ICommitFixupResult,
  IFetchOptions,
  IFetchResult,
  IFetchRefUpdate,
  IPullOptions,
  IPushOptions,
  IRemote,
} from '../interfaces/IGitService';
import { buildGitArgs } from '../gitCli';
import {
  GitError,
  CommandFailedError,
  InvalidArgumentError,
  classifyGitCommandError,
} from '../errors';
import { parseRemotes, parseStatus, isConflictedStatus } from '../gitParser';
import { IGitOpsContext } from './GitOpsContext';

/**
 * Parse `for-each-ref --format=%(refname)\x1f%(objectname)` output into a
 * `ref → object id` map. Malformed lines are skipped.
 */
export function parseRefSnapshot(stdout: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const sep = line.indexOf('\x1f');
    if (sep <= 0) {
      continue;
    }
    const ref = line.slice(0, sep);
    const sha = line.slice(sep + 1).trim();
    if (sha.length === 0) {
      continue;
    }
    snapshot.set(ref, sha);
  }
  return snapshot;
}

/**
 * Diff two ref snapshots into the fetch's updated-ref report. A ref created
 * by the fetch gets an all-zero `oldSha`, a pruned ref an all-zero `newSha`
 * (both padded to the object-id length of the surviving side, so SHA-1 and
 * SHA-256 repos each report their native width — the shape git's own
 * porcelain output uses). Unchanged refs are omitted. Output is sorted by
 * ref name for deterministic reporting.
 */
export function diffRefSnapshots(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>
): IFetchRefUpdate[] {
  const updates: IFetchRefUpdate[] = [];
  for (const [ref, newSha] of after) {
    const oldSha = before.get(ref);
    if (oldSha === undefined) {
      updates.push({ ref, oldSha: '0'.repeat(newSha.length), newSha });
    } else if (oldSha !== newSha) {
      updates.push({ ref, oldSha, newSha });
    }
  }
  for (const [ref, oldSha] of before) {
    if (!after.has(ref)) {
      updates.push({ ref, oldSha, newSha: '0'.repeat(oldSha.length) });
    }
  }
  return updates.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}

/**
 * Filter a fetch's stderr down to genuinely diagnostic lines, dropping the
 * informational ref-listing chatter git emits there (`From …`, ` -> …`,
 * `* [new branch] …`, `+ forced-update` lines).
 */
export function collectFetchErrors(stderr: string): string[] {
  const errors: string[] = [];
  if (!stderr) {
    return errors;
  }
  for (const rawLine of stderr.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (/^From\s|^\s*->\s|^\s*\*\s|^\s*\+/.test(line)) {
      continue;
    }
    errors.push(line);
  }
  return errors;
}

/**
 * Commit + remote-interaction git verbs (commit/amend/fetch/pull/push and
 * remote add/remove/list) extracted from the {@link GitService} façade.
 * Stateless: reaches the live GitCli + cache invalidation lazily through
 * {@link IGitOpsContext}, and fires onDidFetch through the context's
 * fire-through capability so the emitter stays owned by GitService.
 */
export class RemoteOps {
  constructor(private readonly ctx: IGitOpsContext) {}

  /**
   * Commit staged changes to the repository.
   *
   * @param repo - The repository to commit to
   * @param message - The commit message
   * @param options - Commit options (amend, signOff, noVerify, allowEmpty)
   * @throws Error if commit message is empty (unless amending or allowEmpty is true)
   */
  commit(
    repo: IRepository,
    message: string,
    options: ICommitOptions = {}
  ): ResultAsync<void, GitError> {
    // Validate commit message - prevent empty messages unless amending or allowEmpty
    const trimmedMessage = message.trim();
    if (!trimmedMessage && !options.amend && !options.allowEmpty) {
      return errAsync(new InvalidArgumentError('Commit message cannot be empty'));
    }

    // A keep-message amend (empty message + amend) must NOT emit `-m ''` —
    // git aborts on an empty commit message. `--no-edit` re-uses the
    // previous message instead.
    const args =
      !trimmedMessage && options.amend ? ['commit', '--no-edit'] : ['commit', '-m', message];

    if (options.amend) {
      args.push('--amend');
    }
    if (options.signOff) {
      args.push('--signoff');
    }
    if (options.noVerify) {
      args.push('--no-verify');
    }
    if (options.allowEmpty) {
      args.push('--allow-empty');
    }
    // `--author="Name <email>"` override.
    if (options.author && options.author.trim().length > 0) {
      args.push(`--author=${options.author.trim()}`);
    }

    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true }),
      classifyGitCommandError
    ).map(() => {
      this.ctx.invalidateCache(repo.rootUri.fsPath);
    });
  }

  amend(repo: IRepository, message: string): ResultAsync<void, GitError> {
    return this.commit(repo, message, { amend: true });
  }

  /**
   * Commit the currently-staged changes as a `fixup!`/`squash!` of the
   * target commit — IntelliJ git4idea's Git.Fixup.To.Commit /
   * Git.Squash.Into.Commit. The underlying primitive is `git commit
   * --fixup=<hash>` (mode `fixup`) or `git commit --squash=<hash> --no-edit`
   * (mode `squash`); git builds the `fixup! <subject>` / `squash! <subject>`
   * message from the target automatically.
   *
   * @param targetHash - The commit to fixup/squash into. Validated as a hex
   *   sha before interpolation so it can never escape the flag value.
   * @returns A structured result; never throws on an empty index or an
   *   invalid hash so the caller can surface a precise toast.
   */
  commitFixup(
    repo: IRepository,
    targetHash: string,
    mode: 'fixup' | 'squash'
  ): ResultAsync<ICommitFixupResult, GitError> {
    return ResultAsync.fromPromise(
      this._commitFixup(repo, targetHash, mode),
      classifyGitCommandError
    );
  }

  private async _commitFixup(
    repo: IRepository,
    targetHash: string,
    mode: 'fixup' | 'squash'
  ): Promise<ICommitFixupResult> {
    // Reject anything that isn't a bare hex sha (leading dash, flag-like
    // input, path traversal) before it reaches the `--fixup=`/`--squash=`
    // flag value.
    if (!/^[0-9a-f]{4,64}$/i.test(targetHash)) {
      return { success: false, reason: 'invalid-hash' };
    }

    const args =
      mode === 'fixup'
        ? ['commit', `--fixup=${targetHash}`]
        : ['commit', `--squash=${targetHash}`, '--no-edit'];

    const result = await this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath });

    if (result.exitCode !== 0) {
      const combined = `${result.stdout}\n${result.stderr}`;
      if (/nothing to commit|nothing added to commit|no changes added to commit/i.test(combined)) {
        return { success: false, reason: 'nothing-to-commit' };
      }
      return { success: false, reason: 'error', message: result.stderr || result.stdout };
    }

    this.ctx.invalidateCache(repo.rootUri.fsPath);
    return { success: true };
  }

  fetch(
    repo: IRepository,
    optionsOrRemote?: IFetchOptions | string
  ): ResultAsync<IFetchResult, GitError> {
    return ResultAsync.fromPromise(this._fetch(repo, optionsOrRemote), classifyGitCommandError);
  }

  private async _fetch(
    repo: IRepository,
    optionsOrRemote?: IFetchOptions | string
  ): Promise<IFetchResult> {
    // Back-compat: a plain string argument is treated as the remote name.
    const options: IFetchOptions =
      typeof optionsOrRemote === 'string' ? { remote: optionsOrRemote } : (optionsOrRemote ?? {});

    // Split flags vs. the remote ref so buildGitArgs can splice
    // `--end-of-options` between them; defends against argv injection
    // through a hostile remote name (the auto-fetch loop runs unattended
    // and remote names come from `.git/config`).
    //
    // Updated refs are derived from a before/after ref SNAPSHOT (see
    // `_snapshotRefs`), NOT `fetch --porcelain`: the porcelain flag requires
    // git ≥ 2.41 and hard-failed every fetch (manual, Pull pre-fetch,
    // AutoFetch, Update Project) on older gits still common in LTS distros.
    // Two local `for-each-ref` reads work on every supported git with one
    // code path and no version probe.
    const flags: string[] = [];
    if (options.prune) {
      flags.push('--prune');
    }
    // Resolve tag-fetching policy. User-passed `tags` / `noTags` in
    // `options` always win over the `intellig.fetchTags` config so
    // programmatic callers (PushDialog retry, Pull dialog, etc.) can opt
    // out of the global policy. When neither the option nor the config
    // dictates a flag ("auto"), we emit no tag-related flag and let git's
    // own default (follow `remote.<remote>.tagOpt`) apply.
    if (options.tags) {
      flags.push('--tags');
    } else if (options.noTags) {
      flags.push('--no-tags');
    } else {
      const fetchTagsPolicy = readConfig('fetchTags');
      if (fetchTagsPolicy === 'all') {
        flags.push('--tags');
      } else if (fetchTagsPolicy === 'never') {
        flags.push('--no-tags');
      }
      // 'auto' (and any unexpected value) → no flag.
    }
    const refs: string[] = [];
    if (options.all) {
      flags.push('--all');
    } else if (options.remote) {
      refs.push(options.remote);
      // A `<remoteRef>:<localRef>` refspec fast-forwards the local ref (or
      // refuses a non-FF) without checkout — align-local "Update Selected".
      // It carries user-controlled branch names, so it rides in `refs`
      // behind `--end-of-options` like the remote name.
      if (options.refspec) {
        refs.push(options.refspec);
      }
    } else {
      flags.push('--all');
    }

    const args = buildGitArgs('fetch', flags, refs);
    const cwd = repo.rootUri.fsPath;

    const before = await this._snapshotRefs(cwd);
    const cliResult = await this.ctx.gitCli.exec(args, {
      cwd,
      throwOnError: true,
    });
    const after = await this._snapshotRefs(cwd);

    // Suppress the report (not fabricate one) when either snapshot failed.
    const updatedRefs =
      before !== undefined && after !== undefined ? diffRefSnapshots(before, after) : [];
    const result: IFetchResult = {
      updatedRefs,
      errors: collectFetchErrors(cliResult.stderr),
    };
    this.ctx.invalidateCache(cwd);
    this.ctx.fireDidFetch({ repo, result });
    return result;
  }

  /**
   * Snapshot every remote-tracking ref + tag as a `ref → object id` map via
   * `git for-each-ref` (a cheap local read). Taken immediately before and
   * after a fetch; the diff of the two snapshots is the set of refs the fetch
   * updated. A failed read returns `undefined` — distinct from an EMPTY map
   * (a repo with no remote refs yet): degrading a failed BEFORE read to empty
   * made the diff report the WHOLE ref namespace as freshly created, so the
   * manual-fetch toast claimed "N ref(s) updated" for an up-to-date repo.
   * The caller suppresses the report when either side failed (best-effort
   * field; the fetch itself still succeeds).
   *
   * The `\x1f` separator matches the log/branch/tag formats: a ref name can
   * never contain a C0 control character (git-check-ref-format).
   */
  private async _snapshotRefs(cwd: string): Promise<Map<string, string> | undefined> {
    const result = await this.ctx.gitCli.exec(
      ['for-each-ref', '--format=%(refname)\x1f%(objectname)', 'refs/remotes', 'refs/tags'],
      { cwd }
    );
    if (result.exitCode !== 0) {
      return undefined;
    }
    return parseRefSnapshot(result.stdout);
  }

  pull(repo: IRepository, options?: IPullOptions): ResultAsync<void, GitError> {
    return ResultAsync.fromPromise(this._pull(repo, options), classifyGitCommandError);
  }

  private async _pull(repo: IRepository, options?: IPullOptions): Promise<void> {
    // Order: git pull [--rebase|--ff-only|--no-ff] [--squash] [--no-commit] [--no-verify] <remote> <branch>
    // Split flags vs. refs (remote/branch) so buildGitArgs can
    // splice `--end-of-options` between them; defends against argv
    // injection through hostile remote/branch names.
    const flags: string[] = [];

    // Strategy flags are mutually exclusive; first non-empty wins to stay safe
    // even if the caller hasn't resolved the UI mutex.
    if (options?.rebase) {
      flags.push('--rebase');
    } else if (options?.ffOnly) {
      flags.push('--ff-only');
    } else if (options?.noFf) {
      flags.push('--no-ff');
    }

    if (options?.squash) {
      flags.push('--squash');
    }
    if (options?.noCommit) {
      flags.push('--no-commit');
    }
    if (options?.noVerify) {
      flags.push('--no-verify');
    }
    if (options?.autostash) {
      // `--autostash` makes git stash a dirty working tree before integrating
      // and re-apply it after, so an uncommitted change doesn't dead-end
      // pull on "cannot pull with rebase: you have unstaged changes" /
      // local-changes-overwrite (mirrors rebaseBranch's `--autostash`).
      flags.push('--autostash');
    }
    if (options?.prune) {
      flags.push('--prune');
    }

    const refs: string[] = [];
    if (options?.remote) {
      refs.push(options.remote);
    }
    if (options?.branch) {
      refs.push(options.branch);
    }

    const args = buildGitArgs('pull', flags, refs);
    await this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true });
    this.ctx.invalidateCache(repo.rootUri.fsPath);

    // With `--autostash` git integrates cleanly (exit 0) then pops the stash.
    // A clean round-trip exits 0 with no unmerged files, but when popping the
    // autostash collides with the pulled changes git leaves unmerged files AND
    // still exits 0 — so the `throwOnError` above never fires. Read the
    // porcelain status to surface that pop-conflict instead of a false success
    // (mirrors rebaseBranch's post-status check). Routed as a CONFLICT error so
    // PullDialog hands it to the Resolve Conflicts flow.
    if (options?.autostash) {
      const statusResult = await this.ctx.gitCli.exec(['status', '--porcelain', '-z'], {
        cwd: repo.rootUri.fsPath,
      });
      const conflicts = parseStatus(statusResult.stdout)
        .filter(isConflictedStatus)
        .map((f) => f.path);
      if (conflicts.length > 0) {
        // Synthesised failure: git itself exited 0, but the autostash pop left
        // unmerged files. Route as a CommandFailedError whose message AND
        // `.combined` carry the "CONFLICT:" marker so `isConflictError`
        // (which duck-types `.result.combined`, falling back to `.message`)
        // still hands this to the Resolve Conflicts flow after classification.
        const conflictMessage = `CONFLICT: applying the autostash left unmerged files (${conflicts.join(
          ', '
        )}).`;
        throw new CommandFailedError(1, '', conflictMessage, {
          stdout: conflictMessage,
          stderr: '',
          combined: conflictMessage,
        });
      }
    }
  }

  push(repo: IRepository, options?: IPushOptions): ResultAsync<void, GitError> {
    // Order: git push [--force|--force-with-lease] [--set-upstream] [--no-verify]
    //                 [--tags|--follow-tags] <remote> [<refspec>|<branch>]
    // Split flags vs. refs so buildGitArgs splices
    // `--end-of-options`; defends against argv injection through hostile
    // remote / refspec / branch names.
    const flags: string[] = [];

    // Force flags are mutually exclusive; `force` (bare --force) wins if a
    // caller sets both so the command can't silently downgrade the user's
    // explicit request. Safety policy still puts the onus on the UI to
    // prefer `forceWithLease`.
    if (options?.force) {
      flags.push('--force');
    } else if (options?.forceWithLease) {
      flags.push('--force-with-lease');
    }
    if (options?.setUpstream) {
      flags.push('--set-upstream');
    }
    if (options?.noVerify) {
      flags.push('--no-verify');
    }
    // Tag flags are mutually exclusive; prefer --follow-tags when both set
    // so we don't accidentally push unrelated tags.
    if (options?.followTags) {
      flags.push('--follow-tags');
    } else if (options?.tags) {
      flags.push('--tags');
    }

    const refs: string[] = [];
    if (options?.remote) {
      refs.push(options.remote);
    }
    // Explicit refspec (`local:target`) takes precedence over positional branch.
    if (options?.refspec) {
      refs.push(options.refspec);
    } else if (options?.branch) {
      refs.push(options.branch);
    }

    const args = buildGitArgs('push', flags, refs);
    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true }),
      classifyGitCommandError
    ).map(() => {
      this.ctx.invalidateCache(repo.rootUri.fsPath);
    });
  }

  getRemotes(repo: IRepository): ResultAsync<IRemote[], GitError> {
    // `git remote -v` exits 0 on any repo, so a non-zero exit is a genuine
    // failure (not-a-repo / system), not a silent empty remote list.
    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(['remote', '-v'], { cwd: repo.rootUri.fsPath }),
      classifyGitCommandError
    ).andThen((result) =>
      result.exitCode !== 0
        ? err(new CommandFailedError(result.exitCode, result.stderr))
        : ok(parseRemotes(result.stdout))
    );
  }

  /**
   * Add a remote (`git remote add <name> <url>`). `git remote` has no
   * `--end-of-options`, so a leading-dash guard on both args is the
   * argv-injection defense (mirrors {@link setRemoteUrl}/{@link renameRemote}).
   */
  addRemote(repo: IRepository, name: string, url: string): ResultAsync<void, GitError> {
    if (!name || name.startsWith('-')) {
      return errAsync(new InvalidArgumentError(`Invalid remote name: ${name}`));
    }
    if (!url || url.startsWith('-')) {
      return errAsync(new InvalidArgumentError(`Invalid remote URL: ${url}`));
    }
    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(['remote', 'add', name, url], {
        cwd: repo.rootUri.fsPath,
        throwOnError: true,
      }),
      classifyGitCommandError
    ).map(() => {
      this.ctx.invalidateCache(repo.rootUri.fsPath);
    });
  }

  /**
   * Remove a remote (`git remote remove <name>`). `git remote` has no
   * `--end-of-options`, so a leading-dash guard on the name is the
   * argv-injection defense (mirrors {@link addRemote}/{@link setRemoteUrl}).
   */
  removeRemote(repo: IRepository, name: string): ResultAsync<void, GitError> {
    if (!name || name.startsWith('-')) {
      return errAsync(new InvalidArgumentError(`Invalid remote name: ${name}`));
    }
    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(['remote', 'remove', name], {
        cwd: repo.rootUri.fsPath,
        throwOnError: true,
      }),
      classifyGitCommandError
    ).map(() => {
      this.ctx.invalidateCache(repo.rootUri.fsPath);
    });
  }

  /**
   * Change a remote's fetch URL (`git remote set-url <name> <url>`).
   * `git remote` has no `--end-of-options`, so a leading-dash guard on both
   * args is the argv-injection defense (mirrors the branch/stash name guards).
   */
  setRemoteUrl(repo: IRepository, name: string, url: string): ResultAsync<void, GitError> {
    if (!name || name.startsWith('-')) {
      return errAsync(new InvalidArgumentError(`Invalid remote name: ${name}`));
    }
    if (!url || url.startsWith('-')) {
      return errAsync(new InvalidArgumentError(`Invalid remote URL: ${url}`));
    }
    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(['remote', 'set-url', name, url], {
        cwd: repo.rootUri.fsPath,
        throwOnError: true,
      }),
      classifyGitCommandError
    ).map(() => {
      this.ctx.invalidateCache(repo.rootUri.fsPath);
    });
  }

  /**
   * Rename a remote (`git remote rename <old> <new>`). Both names are
   * leading-dash-guarded against argv injection.
   */
  renameRemote(repo: IRepository, oldName: string, newName: string): ResultAsync<void, GitError> {
    if (!oldName || oldName.startsWith('-')) {
      return errAsync(new InvalidArgumentError(`Invalid remote name: ${oldName}`));
    }
    if (!newName || newName.startsWith('-')) {
      return errAsync(new InvalidArgumentError(`Invalid remote name: ${newName}`));
    }
    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(['remote', 'rename', oldName, newName], {
        cwd: repo.rootUri.fsPath,
        throwOnError: true,
      }),
      classifyGitCommandError
    ).map(() => {
      this.ctx.invalidateCache(repo.rootUri.fsPath);
    });
  }
}
