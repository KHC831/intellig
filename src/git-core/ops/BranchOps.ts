import { ResultAsync, ok, okAsync, err, errAsync } from 'neverthrow';
import {
  IRepository,
  IBranch,
  ICommit,
  ICreateBranchOptions,
  ICheckoutOptions,
  IMergeOptions,
  IMergeResult,
  IBasicRebaseResult,
  IRebaseOptions,
  IBranchComparison,
} from '../interfaces/IGitService';
import { buildGitArgs } from '../gitCli';
import {
  GitError,
  CommandFailedError,
  InvalidArgumentError,
  classifyGitCommandError,
} from '../errors';
import {
  parseBranches,
  parseContainingBranches,
  parseStatus,
  parseLog,
  getBranchFormat,
  getLogFormat,
  isConflictedStatus,
} from '../gitParser';
import { sanitizeGitError } from '../gitError';
import { parseGitVersion, supportsUpdateRefs, IGitVersion } from '../gitVersion';
import { getOutputChannel } from '../../utils/outputChannel';
import { IGitOpsContext } from './GitOpsContext';
import { NON_INTERACTIVE_GIT_ENV } from '../gitEnv';
import { isHexObjectId } from '../gitDirMarkers';
import { withAutostashParked } from '../rebaseAutostash';

/**
 * Translate {@link IRebaseOptions} into git flags, in IntelliJ git4idea's
 * `GitRebaseOption` declaration order (rebase-merges, keep-empty, root,
 * update-refs, autosquash). `--root` is a flag here; its effect on the
 * upstream ref is handled by the caller. Returns `[]` when no options are set,
 * so a legacy `rebaseBranch(repo, onto)` call is byte-for-byte unchanged.
 */
function rebaseOptionFlags(options?: IRebaseOptions): string[] {
  if (!options) {
    return [];
  }
  const flags: string[] = [];
  if (options.rebaseMerges) {
    flags.push('--rebase-merges');
  }
  if (options.keepEmpty) {
    flags.push('--keep-empty');
  }
  if (options.root) {
    flags.push('--root');
  }
  if (options.updateRefs) {
    flags.push('--update-refs');
  }
  if (options.autosquash) {
    flags.push('--autosquash');
  }
  return flags;
}

/**
 * Branch lifecycle operations (create / checkout / delete / rename /
 * upstream / merge / rebase / compare) extracted from the {@link GitService}
 * façade. Stateless: reaches the live GitCli + cache invalidation lazily
 * through {@link IGitOpsContext}.
 */
export class BranchOps {
  constructor(private readonly ctx: IGitOpsContext) {}

  getBranches(repo: IRepository): ResultAsync<IBranch[], GitError> {
    const format = getBranchFormat();
    // `git branch -a` exits 0 on any real repo (even one with no commits yet),
    // so a non-zero exit is a genuine failure (not-a-repo / system) → Err,
    // never a silent empty list.
    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(['branch', '-a', '--format', format], { cwd: repo.rootUri.fsPath }),
      classifyGitCommandError
    ).andThen((result) =>
      result.exitCode !== 0
        ? err(new CommandFailedError(result.exitCode, result.stderr))
        : ok(parseBranches(result.stdout))
    );
  }

  /**
   * Branches that contain the given commit (local + remote), sorted
   * alphabetically. Mirrors git4idea `GitLogProvider.getContainingBranches`,
   * which runs `git branch -a --contains <hash>` and lists both kinds.
   *
   * A non-zero exit (e.g. unknown commit) tolerates as an empty list — the same
   * swallow-and-return-empty contract git4idea uses, so a flaky query never
   * breaks the details panel. Only a spawn/system fault rejects → classified
   * Err, which the façade LOGS and degrades to [] (no empty-catch swallow).
   */
  getContainingBranches(repo: IRepository, hash: string): ResultAsync<string[], GitError> {
    // `hash` rides positionally into `git branch --contains <hash>`, which has
    // no `--end-of-options`. Reject anything that is not a hex object name
    // before exec so a crafted ref can never smuggle in flags. A guard miss is
    // benign (not a git fault) → Ok([]), no error noise.
    if (!isHexObjectId(hash, { allowPrefix: true })) {
      return okAsync([]);
    }
    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(['branch', '-a', '--contains', hash, '--format', '%(refname)'], {
        cwd: repo.rootUri.fsPath,
      }),
      classifyGitCommandError
    ).map((result) => (result.exitCode !== 0 ? [] : parseContainingBranches(result.stdout)));
  }

  createBranch(
    repo: IRepository,
    name: string,
    startPointOrOptions?: string | ICreateBranchOptions
  ): ResultAsync<void, GitError> {
    // Pattern (b): the body branches across multiple exec paths (checkout-create
    // vs `branch`) and validates the name; a validation reject (InvalidArgumentError)
    // or any non-zero exit (throwOnError) is classified into the Err channel.
    return ResultAsync.fromPromise(
      this._createBranch(repo, name, startPointOrOptions),
      classifyGitCommandError
    );
  }

  private async _createBranch(
    repo: IRepository,
    name: string,
    startPointOrOptions?: string | ICreateBranchOptions
  ): Promise<void> {
    // Normalize the legacy string form into an options object so the rest
    // of the function is a single code path.
    const options: ICreateBranchOptions =
      typeof startPointOrOptions === 'string'
        ? { startPoint: startPointOrOptions }
        : (startPointOrOptions ?? {});

    // Security: service-boundary reject branch names starting with `-`
    // (git would parse `-foo` as a CLI flag) or `.` (invalid per
    // git-check-ref-format). Mirrors the `resetToCommit` isValidRef guard
    // and defends against upstream callers that skipped validateBranchName.
    if (!name || name.startsWith('-') || name.startsWith('.')) {
      throw new InvalidArgumentError(`Invalid branch name: ${name}`);
    }

    // When `checkout: true`, use `git checkout -[B] <name> <startPoint>`
    // so the branch is created AND switched to in a single atomic command.
    // Using `-B` when force is also set gives us "reset-and-checkout" in one
    // shot — matches IntelliJ's "Overwrite if exists" + "Checkout" combo.
    // branch-name validation above rejects `-`-leading names,
    // so `name` is safe to land positionally. We splice `--end-of-options`
    // before the unvalidated `startPoint` ref (the user-controlled
    // injection point).
    //
    // For `git checkout -[B|b] <name> --track <startPoint>` the name
    // must immediately follow `-b` (see GitServiceCheckout.test.ts).
    // The startPoint ref ALSO must follow git's positional contract:
    // either bare `<name> <startPoint>` or `<name> --track <startPoint>`.
    // We build the argv with the structural separator between flag args
    // and the user-controlled startPoint while preserving git's
    // positional constraints.
    if (options.checkout) {
      const args = ['checkout', options.force ? '-B' : '-b', name];
      if (options.track) {
        args.push('--track');
      }
      if (options.startPoint) {
        args.push('--end-of-options', options.startPoint);
      }
      await this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true });
      this.ctx.invalidateCache(repo.rootUri.fsPath);
      return;
    }

    const args = ['branch'];
    if (options.force) {
      args.push('-f');
    }
    if (options.track) {
      args.push('--track');
    }
    args.push(name);
    if (options.startPoint) {
      args.push('--end-of-options', options.startPoint);
    }

    await this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true });
    this.ctx.invalidateCache(repo.rootUri.fsPath);
  }

  checkout(
    repo: IRepository,
    ref: string,
    options?: ICheckoutOptions
  ): ResultAsync<void, GitError> {
    // Pattern (b): the body branches across multiple checkout layouts and
    // validates the startpoint; a validation reject (InvalidArgumentError) or
    // any non-zero exit (throwOnError) is classified into the Err channel. The
    // thrown CommandFailedError preserves `result.combined`, so callers that
    // inspect conflict output (combinedGitErrorText / isConflictError) keep
    // working through their `.match` Err arm.
    return ResultAsync.fromPromise(this._checkout(repo, ref, options), classifyGitCommandError);
  }

  private async _checkout(
    repo: IRepository,
    ref: string,
    options?: ICheckoutOptions
  ): Promise<void> {
    // Splice `--end-of-options` between flag args and the ref
    // to reject argv injection via a hostile branch name (e.g.
    // `--upload-pack=evil`).
    //
    // For `createBranch: true` the layout is
    //   `git checkout -b <name> [-f] [--track <upstream>]`
    // where `<name>` MUST immediately follow `-b` (a long-standing
    // regression class — see GitServiceCheckout.test.ts:103). The
    // `--end-of-options` separator cannot land between `-b` and the
    // name without breaking git's parser. We keep the createBranch
    // path's argv unchanged and rely on `validateBranchName` (called
    // by createBranch upstream) to reject hostile names.

    // forceCreate path: `git checkout -B <ref> [-f] [--track
    // <startPoint>]` — "create-or-reset to startpoint". Mirrors the `-b`
    // precedent: `-B` and `<ref>` MUST be adjacent (git parses the token
    // right after `-B` as the branch name). forceCreate WINS over
    // createBranch when both are set — `-B` is strictly more permissive
    // (succeeds whether or not the branch exists).
    //
    // Startpoint design: the `track` value doubles as the single startpoint
    // positional. git treats `--track <startPoint>` here as both "set this
    // upstream" and "reset to this commit". `--end-of-options` is NOT used
    // for the startpoint: with `--track`, git reinterprets a token after
    // `--end-of-options` as a pathspec and fails ("'--track' cannot be used
    // with updating paths"). Verified against git 2.50.1. We instead reject
    // a startpoint that starts with `-`/`.` (mirrors deleteBranch /
    // setBranchUpstream's leading-token guard). The `<ref>` is safe by
    // adjacency.
    if (options?.forceCreate) {
      if (options.track && (options.track.startsWith('-') || options.track.startsWith('.'))) {
        throw new InvalidArgumentError(`Invalid start point: ${options.track}`);
      }
      const args = ['checkout', '-B', ref];
      if (options.force) {
        args.push('-f');
      }
      if (options.track) {
        args.push('--track', options.track);
      }
      await this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true });
      this.ctx.invalidateCache(repo.rootUri.fsPath);
      return;
    }

    if (options?.createBranch) {
      // `checkout()` is its own public entry, so a `{createBranch:true}` caller
      // can bypass `validateBranchName`. Guard the new branch name and the
      // startpoint the same way the forceCreate path does (leading `-` parses as
      // a flag; leading `.` is invalid per git-check-ref-format).
      if (ref.startsWith('-') || ref.startsWith('.')) {
        throw new InvalidArgumentError(`Invalid branch name: ${ref}`);
      }
      if (options.track && (options.track.startsWith('-') || options.track.startsWith('.'))) {
        throw new InvalidArgumentError(`Invalid start point: ${options.track}`);
      }
      const args = ['checkout', '-b', ref];
      if (options?.force) {
        args.push('-f');
      }
      if (options?.track) {
        args.push('--track', options.track);
      }
      await this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true });
      this.ctx.invalidateCache(repo.rootUri.fsPath);
      return;
    }

    // Plain checkout path: the ref is user-controlled, so we splice
    // `--end-of-options` before it. `--track` is NOT emitted here: after
    // `--end-of-options <ref>` git would read it as a pathspec and fatal
    // ("'--track' cannot be used with updating paths") — tracking checkouts
    // go through the forceCreate path above, where `-B <name>` keeps the
    // flag in flag position.
    const flags: string[] = [];
    if (options?.force) {
      flags.push('-f');
    }

    const args = buildGitArgs('checkout', flags, [ref]);
    await this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true });
    this.ctx.invalidateCache(repo.rootUri.fsPath);
  }

  deleteBranch(repo: IRepository, name: string, force?: boolean): ResultAsync<void, GitError> {
    // service-boundary reject branch names starting with `-`
    // (git would parse `-foo` as a CLI flag) or `.` (invalid per
    // git-check-ref-format). Mirrors the `createBranch` guard. Also splice
    // `--end-of-options` between the `-d`/`-D` flag and the user-controlled
    // name as structural defense in depth.
    if (!name || name.startsWith('-') || name.startsWith('.')) {
      return errAsync(new InvalidArgumentError(`Invalid branch name: ${name}`));
    }
    const args = buildGitArgs('branch', [force ? '-D' : '-d'], [name]);
    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true }),
      classifyGitCommandError
    ).map(() => {
      this.ctx.invalidateCache(repo.rootUri.fsPath);
    });
  }

  /**
   * `git branch --set-upstream-to=<upstreamRef>
   * <localName>`. Used by `Track Remote Branch` when an existing local
   * branch with no/different upstream needs to adopt the right-clicked
   * remote ref. Same input-validation discipline as deleteBranch /
   * renameBranch: reject names starting with `-` or `.` so a
   * hostile name can't masquerade as a CLI flag, and splice
   * `--end-of-options` between the `--set-upstream-to=…` flag and the
   * positional local-name. The remote part of the upstream ref carries
   * the same guard — the form is `<remote>/<branch>` and either segment
   * starting with `-`/`.` is rejected.
   */
  setBranchUpstream(
    repo: IRepository,
    localName: string,
    upstreamRef: string
  ): ResultAsync<void, GitError> {
    if (!localName || localName.startsWith('-') || localName.startsWith('.')) {
      return errAsync(new InvalidArgumentError(`Invalid branch name: ${localName}`));
    }
    if (!upstreamRef || upstreamRef.startsWith('-') || upstreamRef.startsWith('.')) {
      return errAsync(new InvalidArgumentError(`Invalid upstream ref: ${upstreamRef}`));
    }
    const args = buildGitArgs('branch', [`--set-upstream-to=${upstreamRef}`], [localName]);
    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true }),
      classifyGitCommandError
    ).map(() => {
      this.ctx.invalidateCache(repo.rootUri.fsPath);
    });
  }

  renameBranch(repo: IRepository, oldName: string, newName: string): ResultAsync<void, GitError> {
    // service-boundary reject either name starting with `-`
    // (git would parse `-foo` as a CLI flag) or `.` (invalid per
    // git-check-ref-format). Mirrors the `createBranch` guard. Also splice
    // `--end-of-options` between the `-m` flag and the user-controlled
    // names as structural defense in depth.
    if (!oldName || oldName.startsWith('-') || oldName.startsWith('.')) {
      return errAsync(new InvalidArgumentError(`Invalid branch name: ${oldName}`));
    }
    if (!newName || newName.startsWith('-') || newName.startsWith('.')) {
      return errAsync(new InvalidArgumentError(`Invalid branch name: ${newName}`));
    }
    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(buildGitArgs('branch', ['-m'], [oldName, newName]), {
        cwd: repo.rootUri.fsPath,
        throwOnError: true,
      }),
      classifyGitCommandError
    ).map(() => {
      this.ctx.invalidateCache(repo.rootUri.fsPath);
    });
  }

  mergeBranch(
    repo: IRepository,
    branch: string,
    options?: IMergeOptions
  ): ResultAsync<IMergeResult, GitError> {
    // Pattern (b): the merge body self-detects conflicts via its own
    // `status --porcelain` read and never throws on a non-zero git exit
    // (domain conflicts/failures land in Ok(IMergeResult)). Only a spawn/system
    // fault rejects → classified Err → the façade degrades.
    return ResultAsync.fromPromise(
      this._mergeBranch(repo, branch, options),
      classifyGitCommandError
    );
  }

  private async _mergeBranch(
    repo: IRepository,
    branch: string,
    options?: IMergeOptions
  ): Promise<IMergeResult> {
    // Order: git merge [--ff-only|--no-ff] [--squash] [--no-commit] [-m <msg>] <branch>
    // Strategy flags are CLI-mutex. Precedence when the caller sets several:
    // ffOnly > noFf > squash. UI enforces the mutex before we get here.
    const flags: string[] = [];
    if (options?.ffOnly) {
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
    if (options?.allowUnrelatedHistories) {
      flags.push('--allow-unrelated-histories');
    }
    if (options?.message && options.message.length > 0) {
      flags.push('-m', options.message);
    }
    // `branch` is user-controlled; splice via buildGitArgs.
    const args = buildGitArgs('merge', flags, [branch]);

    const result = await this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath });
    this.ctx.invalidateCache(repo.rootUri.fsPath);

    if (result.exitCode === 0) {
      // Get the merge commit hash (note: with --squash or --no-commit, HEAD
      // hasn't advanced, so we still return the current HEAD — callers
      // interpret this as "the resulting tip" regardless of whether a new
      // commit was created).
      const headResult = await this.ctx.gitCli.exec(['rev-parse', 'HEAD'], {
        cwd: repo.rootUri.fsPath,
      });
      return {
        success: true,
        mergeCommit: headResult.stdout.trim(),
      };
    }

    // Check for conflicts
    const statusResult = await this.ctx.gitCli.exec(['status', '--porcelain', '-z'], {
      cwd: repo.rootUri.fsPath,
    });
    const conflicts = parseStatus(statusResult.stdout)
      .filter(isConflictedStatus)
      .map((f) => f.path);

    if (conflicts.length > 0) {
      return {
        success: false,
        conflicts,
      };
    }

    // Non-conflict failure (refused merge, unrelated histories, dirty
    // tree, etc.). Preserve git's stderr so the caller can surface the
    // underlying reason instead of a silent no-op.
    return {
      success: false,
      conflicts: [],
      failureReason: sanitizeGitError(result.stderr.trim() || result.stdout.trim()) || undefined,
    };
  }

  /**
   * Rebase the current branch onto another branch.
   *
   * @param repo - The repository
   * @param onto - The branch to rebase onto
   * @returns Rebase result with success status and any conflicts
   */
  rebaseBranch(
    repo: IRepository,
    onto: string,
    options?: IRebaseOptions
  ): ResultAsync<IBasicRebaseResult, GitError> {
    // Pattern (b): the rebase body self-detects conflicts via its own
    // `status --porcelain` read and returns a structured IBasicRebaseResult for
    // both success and domain failures. A validation reject (InvalidArgumentError)
    // or spawn/system fault is classified into the Err channel → façade degrades.
    return ResultAsync.fromPromise(
      this._rebaseBranch(repo, onto, options),
      classifyGitCommandError
    );
  }

  private async _rebaseBranch(
    repo: IRepository,
    onto: string,
    options?: IRebaseOptions
  ): Promise<IBasicRebaseResult> {
    // `onto` is user-controlled; splice via buildGitArgs. `--autostash` makes
    // git stash a dirty working tree before replaying and re-apply it after,
    // so a dirty tree doesn't dead-end on "cannot rebase: you have unstaged
    // changes". The optional git4idea-parity flags follow, in GitRebaseOption
    // declaration order. buildGitArgs places all flags between the subcommand
    // and `--end-of-options`, emitting e.g.
    // `rebase --autostash --update-refs --end-of-options <onto>`.
    // Service-boundary: reject a `-`/`.`-leading newbase so a hostile ref can
    // never be parsed as a git flag (mirrors the createBranch/setBranchUpstream
    // guards). The newbase is the argument of `--onto` and is consumed
    // positionally by git's option parser, but we reject defensively anyway.
    if (options?.newBase && (options.newBase.startsWith('-') || options.newBase.startsWith('.'))) {
      throw new InvalidArgumentError(`Invalid rebase newbase: ${options.newBase}`);
    }
    // `--update-refs` HARD-ERRORS on git < 2.38 ("unknown option `update-refs'"),
    // which would abort the rebase with a cryptic message. Pre-flight the git
    // version and refuse the flag with a clear, actionable reason instead of
    // passing it blindly. (Only pays the extra `git --version` call when the
    // opt-in flag is actually requested.)
    if (options?.updateRefs) {
      const version = await this.getGitVersion(repo);
      if (!supportsUpdateRefs(version)) {
        const have = version
          ? `${version.major}.${version.minor}.${version.patch}`
          : 'an older version';
        return {
          success: false,
          conflicts: [],
          failureReason: `--update-refs requires git 2.38 or newer (you have ${have}). Update git, or turn off the "Update refs" rebase option.`,
        };
      }
    }
    const flags = ['--autostash', ...rebaseOptionFlags(options)];
    // `--onto <newbase>` rebases the `<upstream>..HEAD` range onto a different
    // base (git4idea GitRebaseDialog "Onto" field). The newbase lands before
    // `--end-of-options` as the argument of `--onto`; the upstream stays the
    // guarded positional after the separator.
    if (options?.newBase) {
      flags.push('--onto', options.newBase);
    }
    // `--root` rebases from the root commit, so no upstream/onto ref is passed
    // (git4idea disables the upstream field when ROOT is selected). `--root`
    // and `<upstream>` are mutually exclusive; `--onto <newbase>` may pair with
    // either (place the whole history, or the range, onto the newbase).
    const refs = options?.root ? [] : [onto];
    const args = buildGitArgs('rebase', flags, refs);
    const result = await this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath });
    this.ctx.invalidateCache(repo.rootUri.fsPath);

    // Read the porcelain status regardless of exit code. A clean `--autostash`
    // round-trip exits 0 with no unmerged files, but when re-applying the
    // autostash collides with the rebased changes git leaves unmerged files
    // AND still exits 0. Checking unmerged files unconditionally surfaces that
    // pop-conflict instead of a false success.
    const statusResult = await this.ctx.gitCli.exec(['status', '--porcelain', '-z'], {
      cwd: repo.rootUri.fsPath,
    });
    const conflicts = parseStatus(statusResult.stdout)
      .filter(isConflictedStatus)
      .map((f) => f.path);

    if (conflicts.length > 0) {
      // Conflict-ness and continuability are orthogonal: both states list the
      // same unmerged files, but only a live rebase is continuable. For a
      // non-interactive `git rebase` the exit code is a faithful proxy for the
      // rebase-merge/rebase-apply marker the rebase-in-progress check reads:
      // a mid-replay conflict stops with a non-zero exit AND a live rebase, so
      // it is continuable via `git rebase --continue`/`--abort`; an autostash
      // pop conflict happens AFTER the rebase completes (exit 0, HEAD already
      // moved, no rebase in progress) where `--continue` would dead-end on
      // "no rebase in progress". (A non-zero exit with no unmerged files never
      // reaches here — it falls through to the failure-reason path below.)
      return {
        success: false,
        conflicts,
        rebaseInProgress: result.exitCode !== 0,
      };
    }

    if (result.exitCode === 0) {
      return {
        success: true,
      };
    }

    // Non-conflict failure (dirty working tree, in-progress rebase, refs
    // out of sync, etc.). Preserve git's stderr so the caller can surface
    // the underlying reason instead of a silent no-op.
    return {
      success: false,
      conflicts: [],
      failureReason: sanitizeGitError(result.stderr.trim() || result.stdout.trim()) || undefined,
    };
  }

  /**
   * Read the running git's version via `git --version`. Returns `undefined`
   * when the banner can't be parsed or the command fails, so callers
   * fail open (a parsing quirk must never block a flag the git may support).
   */
  private async getGitVersion(repo: IRepository): Promise<IGitVersion | undefined> {
    try {
      const res = await this.ctx.gitCli.exec(['--version'], { cwd: repo.rootUri.fsPath });
      return parseGitVersion(res.stdout);
    } catch (error) {
      // Fail open (a parse/exec quirk must not block a flag git may support) but
      // log so a mis-detected `--update-refs` gate is diagnosable, rather than
      // silently degrading.
      getOutputChannel().appendLine(
        `[git] getGitVersion failed (degrading to undefined): ${error instanceof Error ? error.message : String(error)}`
      );
      return undefined;
    }
  }

  /**
   * Skip the current commit during an in-progress rebase.
   *
   * Issues `git rebase --skip` which drops the problematic commit and
   * continues with the next one in the sequence. If the next commit also
   * conflicts, the returned result reflects those new conflicts exactly
   * like `rebaseBranch`'s conflict-path.
   *
   * This is destructive: the skipped commit's changes are permanently
   * lost from the rewritten history. Callers (ResolveConflictsDialog,
   * palette command) gate with a single confirm modal per safety policy
   * (feedback_data_loss_confirms.md — no double-confirm).
   */
  rebaseSkip(repo: IRepository): ResultAsync<IBasicRebaseResult, GitError> {
    // Pattern (b): structured result for success/conflict; only a spawn/system
    // fault rejects → classified Err → the façade degrades.
    return ResultAsync.fromPromise(this._rebaseSkip(repo), classifyGitCommandError);
  }

  private async _rebaseSkip(repo: IRepository): Promise<IBasicRebaseResult> {
    const result = await this.ctx.gitCli.exec(['rebase', '--skip'], {
      cwd: repo.rootUri.fsPath,
    });
    this.ctx.invalidateCache(repo.rootUri.fsPath);

    if (result.exitCode === 0) {
      return { success: true };
    }

    // Rebase is still running but the next commit hit conflicts. Surface
    // them the same way rebaseBranch does so callers can re-render the
    // Resolve Conflicts dialog with the new file set. Reached only via `git
    // rebase --skip`, so a rebase is necessarily still in progress: the
    // conflict is continuable.
    const statusResult = await this.ctx.gitCli.exec(['status', '--porcelain', '-z'], {
      cwd: repo.rootUri.fsPath,
    });
    const conflicts = parseStatus(statusResult.stdout)
      .filter(isConflictedStatus)
      .map((f) => f.path);

    return {
      success: false,
      conflicts,
      rebaseInProgress: true,
    };
  }

  /**
   * Abort an in-progress rebase (`git rebase --abort`).
   *
   * Restores the working tree + HEAD to their pre-rebase state and removes
   * the `.git/rebase-merge/` (or `rebase-apply/`) metadata. Mirrors the
   * {@link cherryPickAbort} / {@link revertAbort} pattern: `throwOnError`
   * surfaces any git failure to the caller, which is responsible for
   * routing the message through `sanitizeGitError` before display
   * (auto-abort recovery in `_handleRebaseCurrentOnto`).
   *
   * @param repo - The repository
   */
  rebaseAbort(repo: IRepository): ResultAsync<void, GitError> {
    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(['rebase', '--abort'], {
        cwd: repo.rootUri.fsPath,
        throwOnError: true,
      }),
      classifyGitCommandError
    ).map(() => {
      this.ctx.invalidateCache(repo.rootUri.fsPath);
    });
  }

  /**
   * Continue an in-progress rebase after the user resolves conflicts
   * (`git rebase --continue`).
   *
   * Mirrors {@link rebaseSkip}'s result-shape contract: on success returns
   * `{success: true}`; on exit-code ≠ 0 with unmerged files still present
   * returns `{success: false, conflicts}`; on exit-code ≠ 0 with no
   * unmerged files (e.g. continued without staging the resolution, or
   * editor closed without saving the commit message) surfaces the
   * underlying git error via `failureReason` so the caller can show it
   * instead of dropping the failure silently — same boundary contract as
   * {@link rebaseBranch}.
   *
   * @param repo - The repository
   */
  rebaseContinue(repo: IRepository): ResultAsync<IBasicRebaseResult, GitError> {
    // Pattern (b): structured result for success/conflict; only a spawn/system
    // fault rejects → classified Err → the façade degrades.
    return ResultAsync.fromPromise(this._rebaseContinue(repo), classifyGitCommandError);
  }

  private async _rebaseContinue(repo: IRepository): Promise<IBasicRebaseResult> {
    // `rebase --continue` commits the replayed pick using its stored message.
    // Pin the editor to a no-op so git commits it verbatim instead of trying to
    // open an editor under the non-TTY spawn — which fails outright when the host
    // has no EDITOR set ("Terminal is dumb, but EDITOR unset").
    const { result, autostashParked } = await withAutostashParked(
      this.ctx.gitCli,
      repo.rootUri.fsPath,
      () =>
        this.ctx.gitCli.exec(['rebase', '--continue'], {
          cwd: repo.rootUri.fsPath,
          env: { ...process.env, ...NON_INTERACTIVE_GIT_ENV },
        })
    );
    this.ctx.invalidateCache(repo.rootUri.fsPath);

    if (result.exitCode === 0) {
      return { success: true, autostashParked };
    }

    const statusResult = await this.ctx.gitCli.exec(['status', '--porcelain', '-z'], {
      cwd: repo.rootUri.fsPath,
    });
    const conflicts = parseStatus(statusResult.stdout)
      .filter(isConflictedStatus)
      .map((f) => f.path);

    if (conflicts.length > 0) {
      // Reached via `git rebase --continue`, so a rebase is necessarily still
      // in progress: the conflict is continuable.
      return {
        success: false,
        conflicts,
        rebaseInProgress: true,
      };
    }

    return {
      success: false,
      conflicts: [],
      failureReason: sanitizeGitError(result.stderr.trim() || result.stdout.trim()) || undefined,
    };
  }

  /**
   * Compare two branches to find differences.
   * Returns commits unique to each branch, files that differ, and ahead/behind counts.
   *
   * @param repo - The repository
   * @param branch1 - The first branch (typically the current branch)
   * @param branch2 - The second branch to compare against
   * @returns Branch comparison result with commits ahead/behind and changed files
   */
  compareBranches(
    repo: IRepository,
    branch1: string,
    branch2: string
  ): ResultAsync<IBranchComparison, GitError> {
    // Pattern (b): the comparison body tolerates a non-zero exit per-exec
    // (each step gates on `exitCode === 0`), so a domain "no diff" lands in
    // Ok(IBranchComparison). Only a spawn/system fault rejects → classified Err
    // → the façade degrades to an empty comparison.
    return ResultAsync.fromPromise(
      this._compareBranches(repo, branch1, branch2),
      classifyGitCommandError
    );
  }

  private async _compareBranches(
    repo: IRepository,
    branch1: string,
    branch2: string
  ): Promise<IBranchComparison> {
    const cwd = repo.rootUri.fsPath;
    const format = getLogFormat();

    // Get ahead/behind counts using git rev-list --left-right --count
    // This returns: "ahead\tbehind"
    // branch1/branch2 are user-controlled; splice via buildGitArgs.
    const countResult = await this.ctx.gitCli.exec(
      buildGitArgs('rev-list', ['--left-right', '--count'], [`${branch1}...${branch2}`]),
      { cwd }
    );

    let aheadCount = 0;
    let behindCount = 0;

    if (countResult.exitCode === 0 && countResult.stdout.trim()) {
      const parts = countResult.stdout.trim().split(/\s+/);
      if (parts.length >= 2) {
        aheadCount = parseInt(parts[0], 10) || 0;
        behindCount = parseInt(parts[1], 10) || 0;
      }
    }

    // Get commits unique to branch1 (ahead commits)
    // git rev-list branch2..branch1 gives commits in branch1 not in branch2
    // Both branches splice via buildGitArgs.
    const commitsAhead: ICommit[] = [];
    if (aheadCount > 0) {
      const aheadResult = await this.ctx.gitCli.exec(
        buildGitArgs('log', [`--format=${format}`, '-z'], [`${branch2}..${branch1}`]),
        { cwd }
      );
      if (aheadResult.exitCode === 0 && aheadResult.stdout.trim()) {
        commitsAhead.push(...parseLog(aheadResult.stdout));
      }
    }

    // Get commits unique to branch2 (behind commits)
    // git rev-list branch1..branch2 gives commits in branch2 not in branch1
    const commitsBehind: ICommit[] = [];
    if (behindCount > 0) {
      const behindResult = await this.ctx.gitCli.exec(
        buildGitArgs('log', [`--format=${format}`, '-z'], [`${branch1}..${branch2}`]),
        { cwd }
      );
      if (behindResult.exitCode === 0 && behindResult.stdout.trim()) {
        commitsBehind.push(...parseLog(behindResult.stdout));
      }
    }

    // Get files that differ between branches.
    // Use `--name-only -z` so paths with whitespace
    // / non-ASCII characters split unambiguously on `\0` rather than the
    // old `\n` parse, which lost names containing literal newlines.
    const diffResult = await this.ctx.gitCli.exec(
      buildGitArgs('diff', ['--name-only', '-z'], [`${branch1}...${branch2}`]),
      {
        cwd,
      }
    );

    // `-z` separates entries with `\0`, not `\n`, so paths
    // containing newlines or whitespace round-trip safely.
    let changedFiles: string[] = [];
    if (diffResult.exitCode === 0 && diffResult.stdout.length > 0) {
      changedFiles = diffResult.stdout.split('\0').filter((f) => f.length > 0);
    }

    return {
      commitsAhead,
      commitsBehind,
      aheadCount,
      behindCount,
      changedFiles,
    };
  }
}
