import { ResultAsync, ok, err, errAsync } from 'neverthrow';
import { IRepository } from '../interfaces/IGitService';
import {
  GitError,
  CommandFailedError,
  InvalidArgumentError,
  classifyGitCommandError,
} from '../errors';
import { IGitOpsContext } from './GitOpsContext';
import { unquoteCStylePath } from '../cQuote';
import { fromGitPath } from '../fromGitPath';

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
  /** Reason given to `git worktree lock --reason`, when it carried one. */
  lockReason?: string;
  /** Git considers the record prunable — its working tree is gone or unreadable. */
  isPrunable: boolean;
  /** Why git considers the record prunable, when it said. */
  prunableReason?: string;
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
  const blank = (): Omit<IWorktreeEntry, 'path' | 'isMain'> & { path: string | undefined } => ({
    path: undefined,
    head: undefined,
    branch: undefined,
    isDetached: false,
    isBare: false,
    isLocked: false,
    lockReason: undefined,
    isPrunable: false,
    prunableReason: undefined,
  });

  let draft = blank();

  const flush = (): void => {
    if (draft.path !== undefined) {
      // The first record git emits is the main worktree.
      entries.push({ ...draft, path: draft.path, isMain: entries.length === 0 });
    }
    draft = blank();
  };

  for (const raw of output.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim().length === 0) {
      flush();
      continue;
    }

    // Bare boolean attribute lines carry no value.
    if (line === 'bare') {
      draft.isBare = true;
      continue;
    }
    if (line === 'detached') {
      draft.isDetached = true;
      continue;
    }
    const locked = flagWithReason(line, 'locked');
    if (locked) {
      draft.isLocked = true;
      draft.lockReason = locked.reason;
      continue;
    }
    const prunable = flagWithReason(line, 'prunable');
    if (prunable) {
      draft.isPrunable = true;
      draft.prunableReason = prunable.reason;
      continue;
    }

    const spaceIndex = line.indexOf(' ');
    const name = spaceIndex === -1 ? line : line.slice(0, spaceIndex);
    const value = spaceIndex === -1 ? '' : line.slice(spaceIndex + 1);
    switch (name) {
      case 'worktree':
        draft.path = value;
        break;
      case 'HEAD':
        draft.head = value;
        break;
      case 'branch':
        draft.branch = value;
        break;
      default:
        // Unknown attribute — ignore, matching git4idea's tolerant
        // report-and-continue handling.
        break;
    }
  }

  // No trailing blank line: flush the final in-progress record.
  flush();

  return entries;
}

/**
 * A porcelain `<key>` or `<key> <reason>` line. Git C-quotes a reason holding
 * anything outside printable ASCII, a quote or a newline (`"caf\303\251"`),
 * so the text is decoded the way a quoted path is.
 */
function flagWithReason(
  line: string,
  key: 'locked' | 'prunable'
): { reason: string | undefined } | undefined {
  if (line === key) {
    return { reason: undefined };
  }
  if (line.startsWith(`${key} `)) {
    return { reason: unquoteCStylePath(line.slice(key.length + 1)) };
  }
  return undefined;
}

/** The `git worktree` verbs that take a worktree path, which always follows `--`. */
type WorktreePathVerb = 'add' | 'remove' | 'lock' | 'unlock';

/**
 * How hard `git worktree remove` pushes. Git refuses a worktree with changes
 * unless forced once, and a locked one unless forced twice.
 */
export type WorktreeRemoveForce = 'none' | 'discardChanges' | 'overrideLock';

const REMOVE_FORCE_FLAGS: Readonly<Record<WorktreeRemoveForce, readonly string[]>> = {
  none: [],
  discardChanges: ['--force'],
  overrideLock: ['--force', '--force'],
};

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
 * The worktree operations a command surface depends on. {@link WorktreeOps}
 * implements it; consumers reach it through {@link IWorktreeHost}.
 */
export interface IWorktreeCapableService {
  listWorktrees(repo: IRepository): ResultAsync<IWorktreeEntry[], GitError>;
  addWorktree(repo: IRepository, options: IAddWorktreeOptions): ResultAsync<void, GitError>;
  removeWorktree(
    repo: IRepository,
    path: string,
    force?: WorktreeRemoveForce
  ): ResultAsync<void, GitError>;
  pruneWorktrees(repo: IRepository): ResultAsync<void, GitError>;
  lockWorktree(repo: IRepository, path: string, reason?: string): ResultAsync<void, GitError>;
  unlockWorktree(repo: IRepository, path: string): ResultAsync<void, GitError>;
  hasUncommittedChanges(worktreePath: string): ResultAsync<boolean, GitError>;
}

/**
 * A service that owns worktree operations. The {@link IGitService} composite
 * is frozen (ADR-001), so this capability lives on its own role interface,
 * which the concrete {@link GitService} implements — a consumer holding the
 * frozen composite narrows to this name, and the class is checked against it.
 */
export interface IWorktreeHost {
  readonly worktrees: IWorktreeCapableService;
}

/**
 * The worktree operations of a git service held as the frozen composite. The
 * one place that narrows to {@link IWorktreeHost}: a service without them is
 * refused here, by name, rather than failing as an undefined read inside a
 * command.
 */
export function worktreesOf(service: object): IWorktreeCapableService {
  const worktrees = (service as Partial<IWorktreeHost>).worktrees;
  if (worktrees === undefined) {
    throw new Error('this git service provides no worktree operations (IWorktreeHost)');
  }
  return worktrees;
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
export class WorktreeOps implements IWorktreeCapableService {
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
        : ok(
            parseWorktreeList(result.stdout).map((entry) => ({
              ...entry,
              path: fromGitPath(entry.path),
            }))
          )
    );
  }

  /**
   * Lock a worktree (`git worktree lock [--reason <reason>] -- <path>`), so
   * git refuses to prune or move it — what a worktree on a removable drive or
   * a long-lived one wants. The reason is `--reason`'s own value rather than
   * text spliced into a flag.
   */
  lockWorktree(repo: IRepository, path: string, reason?: string): ResultAsync<void, GitError> {
    const flags = reason !== undefined && reason.trim().length > 0 ? ['--reason', reason] : [];
    return this.runOnPath(repo, 'lock', flags, path);
  }

  /**
   * Whether the worktree at `worktreePath` has modified, staged or untracked
   * files (`git status --porcelain` run in it prints anything). Overriding a
   * lock removes those along with the tree, so a confirm needs to know.
   */
  hasUncommittedChanges(worktreePath: string): ResultAsync<boolean, GitError> {
    return ResultAsync.fromPromise(
      // git-path-quote-exempt: only whether git printed anything is read, never a path
      this.ctx.gitCli.exec(['status', '--porcelain'], { cwd: worktreePath }),
      classifyGitCommandError
    ).andThen((result) =>
      result.exitCode !== 0
        ? err(new CommandFailedError(result.exitCode, result.stderr))
        : ok(result.stdout.trim().length > 0)
    );
  }

  /**
   * Unlock a worktree (`git worktree unlock -- <path>`). Git refuses when the
   * worktree is not locked, which the caller surfaces rather than swallowing.
   */
  unlockWorktree(repo: IRepository, path: string): ResultAsync<void, GitError> {
    return this.runOnPath(repo, 'unlock', [], path);
  }

  /**
   * Create a linked worktree (`git worktree add [-b <newBranch>] -- <path> <ref>`).
   *
   * `git worktree add` accepts exactly `[<options>] -- <path> [<commit-ish>]`;
   * an `--end-of-options` token or a second `--` is itself treated as a stray
   * positional and rejected with a usage error. The `newBranch` name follows
   * `-b` (git requires the name adjacent to `-b`, before the `--`), so it is
   * validated up front like {@link BranchOps.createBranch}: a name starting with
   * `-`/`.` is rejected. The `ref` is likewise rejected when it starts with
   * `-`/`.` as defense in depth on top of the `--` separator.
   *
   * The caller is responsible for confirming the path does not already exist
   * (git refuses, but a UI gives a clearer message).
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
    return this.runOnPath(repo, 'add', newBranch !== undefined ? ['-b', newBranch] : [], path, ref);
  }

  /**
   * Remove a linked worktree (`git worktree remove [--force [--force]] -- <path>`).
   * Git refuses a worktree with changes, or a locked one, unless forced to the
   * matching {@link WorktreeRemoveForce}; the caller decides whether to retry
   * forced after surfacing that refusal.
   */
  removeWorktree(
    repo: IRepository,
    path: string,
    force: WorktreeRemoveForce = 'none'
  ): ResultAsync<void, GitError> {
    return this.runOnPath(repo, 'remove', REMOVE_FORCE_FLAGS[force], path);
  }

  /**
   * Prune stale worktree records (`git worktree prune`) — cleans the
   * `.git/worktrees/` bookkeeping for worktrees whose directories are gone.
   * No user-controlled arguments.
   */
  pruneWorktrees(repo: IRepository): ResultAsync<void, GitError> {
    return this.settle(
      repo,
      this.ctx.gitCli.exec(['worktree', 'prune'], {
        cwd: repo.rootUri.fsPath,
        throwOnError: true,
      })
    );
  }

  /**
   * One `git worktree <verb> [flags] -- <path> [more positionals]` call.
   *
   * Injection safety for every verb lives here: the user-controlled path (and
   * anything after it) follows a single `--`, which ends git's option parsing,
   * so a hostile path such as `--upload-pack=evil` can only ever be a
   * positional. An empty path is refused before git runs.
   */
  private runOnPath(
    repo: IRepository,
    verb: WorktreePathVerb,
    flags: readonly string[],
    path: string,
    ...rest: string[]
  ): ResultAsync<void, GitError> {
    if (!path || path.trim().length === 0) {
      return errAsync(new InvalidArgumentError('Worktree path is required'));
    }
    // pathspec-exempt: a worktree DIRECTORY (and a ref for `add`), not pathspecs
    const args = ['worktree', verb, ...flags, '--', path, ...rest];
    return this.settle(
      repo,
      this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true })
    );
  }

  /** Run a mutating worktree command and drop the repository's cached state. */
  /** Classify a mutating worktree command's failure and drop the repository's cached state. */
  private settle(
    repo: IRepository,
    exec: ReturnType<IGitOpsContext['gitCli']['exec']>
  ): ResultAsync<void, GitError> {
    return ResultAsync.fromPromise(exec, classifyGitCommandError).map(() => {
      this.ctx.invalidateCache(repo.rootUri.fsPath);
    });
  }
}
