import { ResultAsync, ok, err, errAsync } from 'neverthrow';
import { IRepository } from '../interfaces/IGitService';
import {
  GitError,
  CommandFailedError,
  InvalidArgumentError,
  classifyGitCommandError,
} from '../errors';
import { IGitOpsContext } from './GitOpsContext';

/**
 * One linked-or-main working tree as reported by
 * `git worktree list --porcelain`.
 *
 * Mirrors the record set IntelliJ git4idea's `GitWorktreeListParser` builds
 * (`GitWorkingTree` — path / branch / main / detached / locked plus the HEAD
 * hash). The `git-dir` of the *current* checkout is the main worktree, so
 * `isMain` marks the first record git emits, matching git4idea's `isFirst`.
 */
export interface IWorktreeEntry {
  /** Absolute path to the working tree. */
  path: string;
  /** HEAD commit hash, or undefined for a bare main worktree. */
  head?: string;
  /** Full ref the worktree has checked out (e.g. `refs/heads/main`), or undefined when detached/bare. */
  branch?: string;
  /** The main (first-listed) worktree — the one holding the shared `.git`. */
  isMain: boolean;
  /** HEAD is detached (no branch ref). */
  isDetached: boolean;
  /** A bare repository main worktree (no checkout). */
  isBare: boolean;
  /** Worktree is locked (`git worktree lock`); a move/prune is refused. */
  isLocked: boolean;
}

/**
 * Parse `git worktree list --porcelain` output into structured entries.
 *
 * The porcelain format emits one blank-line-separated record per worktree.
 * Within a record each attribute is its own line: a `worktree <path>` header,
 * then optional `HEAD <sha>`, `branch <ref>`, and bare boolean lines
 * (`bare`, `detached`, `locked`). This mirrors the line dispatch in IntelliJ
 * git4idea's `GitWorktreeListParser.handleLine` / `createWorkingTree`: a blank
 * line flushes the in-progress record, and the first flushed record is the
 * main worktree. We also flush a trailing record when the output lacks the
 * final blank line, so the last worktree is never dropped.
 */
export function parseWorktreeList(output: string): IWorktreeEntry[] {
  const entries: IWorktreeEntry[] = [];

  let path: string | undefined;
  let head: string | undefined;
  let branch: string | undefined;
  let isDetached = false;
  let isBare = false;
  let isLocked = false;
  let isFirst = true;
  let hasRecord = false;

  const flush = (): void => {
    if (path !== undefined) {
      entries.push({
        path,
        head,
        branch,
        isMain: isFirst,
        isDetached,
        isBare,
        isLocked,
      });
      isFirst = false;
    }
    path = undefined;
    head = undefined;
    branch = undefined;
    isDetached = false;
    isBare = false;
    isLocked = false;
    hasRecord = false;
  };

  for (const raw of output.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim().length === 0) {
      flush();
      continue;
    }
    hasRecord = true;

    // Bare boolean attribute lines carry no value.
    if (line === 'bare') {
      isBare = true;
      continue;
    }
    if (line === 'detached') {
      isDetached = true;
      continue;
    }
    if (line === 'locked' || line.startsWith('locked ')) {
      isLocked = true;
      continue;
    }

    const spaceIndex = line.indexOf(' ');
    const name = spaceIndex === -1 ? line : line.slice(0, spaceIndex);
    const value = spaceIndex === -1 ? '' : line.slice(spaceIndex + 1);
    switch (name) {
      case 'worktree':
        path = value;
        break;
      case 'HEAD':
        head = value;
        break;
      case 'branch':
        branch = value;
        break;
      default:
        // Unknown attribute (e.g. `prunable`) — ignore, matching git4idea's
        // tolerant report-and-continue handling.
        break;
    }
  }

  // No trailing blank line: flush the final in-progress record.
  if (hasRecord) {
    flush();
  }

  return entries;
}

/** Options for {@link WorktreeOps.addWorktree}. */
export interface IAddWorktreeOptions {
  /** Filesystem path for the new worktree (must not already exist). */
  path: string;
  /** Commit-ish the worktree checks out (branch, tag, or SHA). */
  ref: string;
  /**
   * When set, create this new branch at `ref` and check it out in the
   * worktree (`git worktree add -b <newBranch> <path> <ref>`). When absent,
   * the existing `ref` is checked out directly.
   */
  newBranch?: string;
}

/**
 * Narrow capability the worktree command surface depends on. The
 * {@link IGitService} composite is frozen (ADR-001), so the concrete
 * {@link GitService} exposes these post-freeze methods directly; consumers
 * depend on this role interface rather than the frozen composite.
 */
export interface IWorktreeCapableService {
  listWorktrees(repo: IRepository): ResultAsync<IWorktreeEntry[], GitError>;
  addWorktree(repo: IRepository, options: IAddWorktreeOptions): ResultAsync<void, GitError>;
  removeWorktree(repo: IRepository, path: string, force?: boolean): ResultAsync<void, GitError>;
  pruneWorktrees(repo: IRepository): ResultAsync<void, GitError>;
}

/**
 * Worktree create / list operations, extracted as an *Ops collaborator of the
 * {@link GitService} façade (the {@link IGitService} composite is frozen per
 * ADR-001, so new git capabilities land here). Stateless: reaches the live
 * GitCli lazily through {@link IGitOpsContext}, matching {@link BranchOps} /
 * {@link IncomingOutgoingOps}.
 *
 * North-star: IntelliJ git4idea lists worktrees via
 * `git worktree list --porcelain` (parsed by `GitWorktreeListParser`) and
 * creates linked worktrees with `git worktree add`. See {@link parseWorktreeList}.
 */
export class WorktreeOps {
  constructor(private readonly ctx: IGitOpsContext) {}

  /**
   * List the repository's worktrees via `git worktree list --porcelain`.
   *
   * `Ok(entries)` on success; `Err(GitError)` on any failure — a non-zero exit
   * (`CommandFailedError`) or a spawn/system fault. The picker caller surfaces
   * a sanitized error toast through the Err arm rather than silently rendering
   * "no worktrees", so a fault can't masquerade as an empty list.
   */
  listWorktrees(repo: IRepository): ResultAsync<IWorktreeEntry[], GitError> {
    return ResultAsync.fromPromise(
      // git-path-quote-exempt: worktree porcelain prints worktree paths verbatim, including spaces and non-ASCII
      this.ctx.gitCli.exec(['worktree', 'list', '--porcelain'], { cwd: repo.rootUri.fsPath }),
      classifyGitCommandError
    ).andThen((result) =>
      result.exitCode !== 0
        ? err(new CommandFailedError(result.exitCode, result.stderr))
        : ok(parseWorktreeList(result.stdout))
    );
  }

  /**
   * Create a linked worktree (`git worktree add [-b <newBranch>] <path> <ref>`).
   *
   * Injection safety: the worktree `path` and `ref` are user-controlled
   * positionals. A single `--` precedes BOTH, ending git's option parsing so a
   * hostile path such as `--upload-pack=evil` (or a flag-like ref) can never be
   * parsed as an option — everything after `--` is a positional. (`git worktree
   * add` accepts exactly `[<options>] -- <path> [<commit-ish>]`; an
   * `--end-of-options` token or a second `--` is itself treated as a stray
   * positional and rejected with a usage error.) The `newBranch` name follows
   * `-b` (git requires the name adjacent to `-b`, before the `--`), so it is
   * validated up front like {@link BranchOps.createBranch}: a name starting with
   * `-`/`.` is rejected. The `ref` is likewise rejected when it starts with
   * `-`/`.` as defense in depth on top of the `--` separator.
   *
   * The caller is responsible for confirming the path does not already exist
   * (git refuses, but a UI gives a clearer message); we additionally reject an
   * empty path here.
   */
  addWorktree(repo: IRepository, options: IAddWorktreeOptions): ResultAsync<void, GitError> {
    const { path, ref, newBranch } = options;

    if (!path || path.trim().length === 0) {
      return errAsync(new InvalidArgumentError('Worktree path is required'));
    }
    if (!ref || ref.startsWith('-') || ref.startsWith('.')) {
      return errAsync(new InvalidArgumentError(`Invalid ref: ${ref}`));
    }
    if (
      newBranch !== undefined &&
      (!newBranch || newBranch.startsWith('-') || newBranch.startsWith('.'))
    ) {
      return errAsync(new InvalidArgumentError(`Invalid branch name: ${newBranch}`));
    }

    // Layout: worktree add [-b <newBranch>] -- <path> <ref>
    // `-b <newBranch>` must precede the `--` (git's grammar); the new-branch
    // name is validated above. The single `--` ends option parsing, so BOTH the
    // user path and the ref that follow are positionals and a flag-like value
    // cannot be reinterpreted as an option.
    const args: string[] = ['worktree', 'add'];
    if (newBranch !== undefined) {
      args.push('-b', newBranch);
    }
    args.push('--', path, ref);

    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true }),
      classifyGitCommandError
    ).map(() => {
      this.ctx.invalidateCache(repo.rootUri.fsPath);
    });
  }

  /**
   * Remove a linked worktree (`git worktree remove [--force] -- <path>`).
   *
   * Injection safety: the user-controlled path is the only positional and
   * follows a single `--`, so a flag-shaped path can never be parsed as an
   * option (same grammar note as {@link addWorktree}). Git itself refuses a
   * dirty or locked worktree without `--force`; the caller decides whether
   * to retry forced after surfacing that refusal.
   */
  removeWorktree(repo: IRepository, path: string, force?: boolean): ResultAsync<void, GitError> {
    if (!path || path.trim().length === 0) {
      return errAsync(new InvalidArgumentError('Worktree path is required'));
    }

    const args: string[] = ['worktree', 'remove'];
    if (force) {
      args.push('--force');
    }
    args.push('--', path);

    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true }),
      classifyGitCommandError
    ).map(() => {
      this.ctx.invalidateCache(repo.rootUri.fsPath);
    });
  }

  /**
   * Prune stale worktree records (`git worktree prune`) — cleans the
   * `.git/worktrees/` bookkeeping for worktrees whose directories are gone.
   * No user-controlled arguments.
   */
  pruneWorktrees(repo: IRepository): ResultAsync<void, GitError> {
    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(['worktree', 'prune'], {
        cwd: repo.rootUri.fsPath,
        throwOnError: true,
      }),
      classifyGitCommandError
    ).map(() => {
      this.ctx.invalidateCache(repo.rootUri.fsPath);
    });
  }
}
