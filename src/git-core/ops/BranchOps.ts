import {
  IRepository,
  IBranch,
  ICommit,
  ICreateBranchOptions,
  ICheckoutOptions,
  IMergeOptions,
  IMergeResult,
  IBasicRebaseResult,
  IBranchComparison,
} from '../interfaces/IGitService';
import { buildGitArgs } from '../gitCli';
import {
  parseBranches,
  parseStatus,
  parseLog,
  getBranchFormat,
  getLogFormat,
  isConflictedStatus,
} from '../gitParser';
import { sanitizeGitError } from '../gitError';
import { IGitOpsContext } from './GitOpsContext';

/**
 * Branch lifecycle operations (create / checkout / delete / rename /
 * upstream / merge / rebase / compare) extracted from the {@link GitService}
 * façade. Stateless: reaches the live GitCli + cache invalidation lazily
 * through {@link IGitOpsContext}.
 */
export class BranchOps {
  constructor(private readonly ctx: IGitOpsContext) {}

  async getBranches(repo: IRepository): Promise<IBranch[]> {
    const format = getBranchFormat();
    const result = await this.ctx.gitCli.exec(['branch', '-a', '--format', format], {
      cwd: repo.rootUri.fsPath,
    });

    if (result.exitCode !== 0) {
      return [];
    }

    return parseBranches(result.stdout);
  }

  async createBranch(
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
      throw new Error(`Invalid branch name: ${name}`);
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

  async checkout(repo: IRepository, ref: string, options?: ICheckoutOptions): Promise<void> {
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
        throw new Error(`Invalid start point: ${options.track}`);
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
    // `--end-of-options` before it.
    const flags: string[] = [];
    if (options?.force) {
      flags.push('-f');
    }
    const trailing: string[] = [];
    if (options?.track) {
      trailing.push('--track', options.track);
    }

    const args = [...buildGitArgs('checkout', flags, [ref]), ...trailing];
    await this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true });
    this.ctx.invalidateCache(repo.rootUri.fsPath);
  }

  async deleteBranch(repo: IRepository, name: string, force?: boolean): Promise<void> {
    // service-boundary reject branch names starting with `-`
    // (git would parse `-foo` as a CLI flag) or `.` (invalid per
    // git-check-ref-format). Mirrors the `createBranch` guard. Also splice
    // `--end-of-options` between the `-d`/`-D` flag and the user-controlled
    // name as structural defense in depth.
    if (!name || name.startsWith('-') || name.startsWith('.')) {
      throw new Error(`Invalid branch name: ${name}`);
    }
    const args = buildGitArgs('branch', [force ? '-D' : '-d'], [name]);
    await this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true });
    this.ctx.invalidateCache(repo.rootUri.fsPath);
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
  async setBranchUpstream(
    repo: IRepository,
    localName: string,
    upstreamRef: string
  ): Promise<void> {
    if (!localName || localName.startsWith('-') || localName.startsWith('.')) {
      throw new Error(`Invalid branch name: ${localName}`);
    }
    if (!upstreamRef || upstreamRef.startsWith('-') || upstreamRef.startsWith('.')) {
      throw new Error(`Invalid upstream ref: ${upstreamRef}`);
    }
    const args = buildGitArgs('branch', [`--set-upstream-to=${upstreamRef}`], [localName]);
    await this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true });
    this.ctx.invalidateCache(repo.rootUri.fsPath);
  }

  async renameBranch(repo: IRepository, oldName: string, newName: string): Promise<void> {
    // service-boundary reject either name starting with `-`
    // (git would parse `-foo` as a CLI flag) or `.` (invalid per
    // git-check-ref-format). Mirrors the `createBranch` guard. Also splice
    // `--end-of-options` between the `-m` flag and the user-controlled
    // names as structural defense in depth.
    if (!oldName || oldName.startsWith('-') || oldName.startsWith('.')) {
      throw new Error(`Invalid branch name: ${oldName}`);
    }
    if (!newName || newName.startsWith('-') || newName.startsWith('.')) {
      throw new Error(`Invalid branch name: ${newName}`);
    }
    await this.ctx.gitCli.exec(buildGitArgs('branch', ['-m'], [oldName, newName]), {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    this.ctx.invalidateCache(repo.rootUri.fsPath);
  }

  async mergeBranch(
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
    const statusResult = await this.ctx.gitCli.exec(['status', '--porcelain'], {
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
  async rebaseBranch(repo: IRepository, onto: string): Promise<IBasicRebaseResult> {
    // `onto` is user-controlled; splice via buildGitArgs. `--autostash` makes
    // git stash a dirty working tree before replaying and re-apply it after,
    // so a dirty tree no longer dead-ends on "cannot rebase: you have unstaged
    // changes". buildGitArgs places the flag between the subcommand and
    // `--end-of-options`, emitting `rebase --autostash --end-of-options <onto>`.
    const args = buildGitArgs('rebase', ['--autostash'], [onto]);
    const result = await this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath });
    this.ctx.invalidateCache(repo.rootUri.fsPath);

    // Read the porcelain status regardless of exit code. A clean `--autostash`
    // round-trip exits 0 with no unmerged files, but when re-applying the
    // autostash collides with the rebased changes git leaves unmerged files
    // AND still exits 0. Checking unmerged files unconditionally surfaces that
    // pop-conflict instead of a false success.
    const statusResult = await this.ctx.gitCli.exec(['status', '--porcelain'], {
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
  async rebaseSkip(repo: IRepository): Promise<IBasicRebaseResult> {
    const result = await this.ctx.gitCli.exec(['rebase', '--skip'], {
      cwd: repo.rootUri.fsPath,
    });
    this.ctx.invalidateCache(repo.rootUri.fsPath);

    if (result.exitCode === 0) {
      return { success: true };
    }

    // Rebase is still running but the next commit hit conflicts. Surface
    // them the same way rebaseBranch does so callers can re-render the
    // Resolve Conflicts dialog with the new file set.
    const statusResult = await this.ctx.gitCli.exec(['status', '--porcelain'], {
      cwd: repo.rootUri.fsPath,
    });
    const conflicts = parseStatus(statusResult.stdout)
      .filter(isConflictedStatus)
      .map((f) => f.path);

    return {
      success: false,
      conflicts,
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
  async rebaseAbort(repo: IRepository): Promise<void> {
    await this.ctx.gitCli.exec(['rebase', '--abort'], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    this.ctx.invalidateCache(repo.rootUri.fsPath);
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
  async rebaseContinue(repo: IRepository): Promise<IBasicRebaseResult> {
    const result = await this.ctx.gitCli.exec(['rebase', '--continue'], {
      cwd: repo.rootUri.fsPath,
    });
    this.ctx.invalidateCache(repo.rootUri.fsPath);

    if (result.exitCode === 0) {
      return { success: true };
    }

    const statusResult = await this.ctx.gitCli.exec(['status', '--porcelain'], {
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
  async compareBranches(
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
