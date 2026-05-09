import * as vscode from 'vscode';

/**
 * Repository state enumeration
 */
export type RepositoryState = 'idle' | 'merging' | 'rebasing' | 'cherry-picking' | 'reverting';

/**
 * File status codes
 */
export type StatusCode = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '?' | '!' | ' ';

/**
 * File status type
 */
export type FileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'ignored'
  | 'conflicted';

/**
 * Branch type enumeration
 */
export type BranchType = 'local' | 'remote' | 'tag';

/**
 * Diff line type
 */
export type DiffLineType = 'context' | 'add' | 'delete';

/**
 * Author information
 */
export interface IAuthor {
  name: string;
  email: string;
}

/**
 * Upstream branch reference
 */
export interface IUpstream {
  remote: string;
  name: string;
}

/**
 * HEAD reference information
 */
export interface IHead {
  name?: string;
  commit?: string;
  upstream?: IUpstream;
  ahead: number;
  behind: number;
}

/**
 * Remote repository reference
 */
export interface IRemote {
  name: string;
  fetchUrl?: string;
  pushUrl?: string;
}

/**
 * Submodule information
 */
export interface ISubmodule {
  name: string;
  path: string;
  url: string;
}

/**
 * Repository model
 */
export interface IRepository {
  rootUri: vscode.Uri;
  state: RepositoryState;
  head?: IHead;
  remotes: IRemote[];
  submodules: ISubmodule[];
}

/**
 * Branch model
 */
export interface IBranch {
  name: string;
  type: BranchType;
  commit: string;
  upstream?: IUpstream;
  isHead: boolean;
  ahead?: number;
  behind?: number;
}

/**
 * Commit model
 */
export interface ICommit {
  hash: string;
  shortHash: string;
  message: string;
  body?: string;
  author: IAuthor;
  committer: IAuthor;
  parents: string[];
  authorDate: Date;
  commitDate: Date;
}

/**
 * Diff line model
 */
export interface IDiffLine {
  type: DiffLineType;
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

/**
 * Hunk model - a contiguous block of changed lines
 */
export interface IHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: IDiffLine[];
}

/**
 * Diff model
 */
export interface IDiff {
  path: string;
  oldPath?: string;
  status: FileStatus;
  hunks: IHunk[];
  binary: boolean;
}

/**
 * Stash model
 */
export interface IStash {
  index: number;
  message: string;
  date: Date;
  branch?: string;
}

/**
 * Tag model
 */
export interface ITag {
  name: string;
  commit: string;
  message?: string;
  tagger?: IAuthor;
  date?: Date;
  isAnnotated: boolean;
}

/**
 * File status model
 */
export interface IFileStatus {
  path: string;
  indexStatus: StatusCode;
  workTreeStatus: StatusCode;
  renamed?: string;
}

/**
 * Blame line information
 */
export interface IBlameLine {
  line: number;
  commit: string;
  author: string;
  authorEmail: string;
  date: Date;
  message: string;
  /** The commit the line existed in before this one (`previous <sha> <file>` header). */
  previousCommit?: string;
  /**
   * Path of the file at `previousCommit` when it differs from the current path.
   * Emitted by git blame's `previous` header when `-M`/`-C` detect a rename/move.
   */
  previousFilename?: string;
}

/**
 * Commit options
 */
export interface ICommitOptions {
  amend?: boolean;
  signOff?: boolean;
  noVerify?: boolean;
  allowEmpty?: boolean;
  /**
   * Optional author override in the `Name <email>` format. When set,
   * the commit is created with `--author="<value>"`. T2-06.
   */
  author?: string;
}

/**
 * Checkout options
 */
export interface ICheckoutOptions {
  createBranch?: boolean;
  force?: boolean;
  track?: string;
}

/**
 * Pull options
 */
export interface IPullOptions {
  /** Use `git pull --rebase`. Mutually exclusive with `ffOnly` and `noFf`. */
  rebase?: boolean;
  /** Require a fast-forward merge (`--ff-only`). Mutex with `rebase` and `noFf`. */
  ffOnly?: boolean;
  /** Always create a merge commit (`--no-ff`). Mutex with `rebase` and `ffOnly`. */
  noFf?: boolean;
  /** Stage changes without creating a merge commit (`--squash`). */
  squash?: boolean;
  /** Perform the merge/rebase but do not commit (`--no-commit`). */
  noCommit?: boolean;
  /** Bypass pre-merge hook (`--no-verify`). */
  noVerify?: boolean;
  /** Remote name (default origin). */
  remote?: string;
  /** Branch name on the remote to pull from. */
  branch?: string;
}

/**
 * Push options
 */
export interface IPushOptions {
  /** `--force`. Bare force — per safety policy, requires explicit opt-in. */
  force?: boolean;
  /** `--force-with-lease`. Default force path when local diverges from upstream. */
  forceWithLease?: boolean;
  /** `--set-upstream`. Auto-set when the local branch has no upstream yet. */
  setUpstream?: boolean;
  /** Bypass pre-push hook (`--no-verify`). Off by default. */
  noVerify?: boolean;
  /** Push all tags (`--tags`). Mutually exclusive with `followTags`. */
  tags?: boolean;
  /** Push only annotated tags that are reachable from pushed commits (`--follow-tags`). Mutex w/ `tags`. */
  followTags?: boolean;
  /** Remote name (e.g. `origin`). Required unless refspec carries everything. */
  remote?: string;
  /** Branch name on the remote. Ignored when `refspec` is provided. */
  branch?: string;
  /**
   * Explicit `<localBranch>:<targetBranch>` refspec. Used when the user
   * edits the target branch name to something other than the local name.
   * Takes precedence over the positional `branch` arg in the CLI.
   */
  refspec?: string;
}

/**
 * Fetch options
 */
export interface IFetchOptions {
  /** Fetch from a specific remote; if omitted and `all` is false, uses `--all`. */
  remote?: string;
  /** Fetch from all remotes (default when neither `remote` nor `all` is set). */
  all?: boolean;
  /** Remove remote-tracking refs that no longer exist on the remote. */
  prune?: boolean;
  /** Fetch all tags. */
  tags?: boolean;
  /** Skip fetching tags. */
  noTags?: boolean;
}

/**
 * A single ref update returned by `git fetch --porcelain`.
 */
export interface IFetchRefUpdate {
  /** The ref that was updated (e.g. `refs/remotes/origin/main`). */
  ref: string;
  /** The previous SHA (may be 0000…0000 for a brand-new ref). */
  oldSha: string;
  /** The new SHA. */
  newSha: string;
}

/**
 * Result of a fetch operation, parsed from `git fetch --porcelain` output.
 */
export interface IFetchResult {
  /** Updated refs reported by the remote. */
  updatedRefs: IFetchRefUpdate[];
  /** Total number of commits ahead across all fetched refs (best-effort). */
  ahead: number;
  /** Total number of commits behind across all fetched refs (best-effort). */
  behind: number;
  /** Non-fatal error messages emitted on stderr (e.g. auth prompts). */
  errors: string[];
}

/**
 * Stash options
 */
export interface IStashOptions {
  includeUntracked?: boolean;
  keepIndex?: boolean;
}

/**
 * Log options for filtering commit history
 */
export interface ILogOptions {
  maxCount?: number;
  skip?: number;
  author?: string;
  since?: Date;
  until?: Date;
  path?: string;
  grep?: string;
  all?: boolean;
}

/**
 * Options for {@link IGitService.getFileHistory} (T2-07).
 *
 * Kept separate from {@link ILogOptions} because file-history introduces
 * two flags that don't otherwise make sense for a general `git log`:
 *   - `follow`: pass `--follow` so rename history is preserved
 *   - `branch`: limit history to commits reachable from the given branch
 *
 * `maxCount` is also exposed so callers can paginate / cap results for UI.
 */
/**
 * T3-07 — Commit classification returned by `git log --cherry-mark`.
 *
 * The characters are taken verbatim from git's output so consumers can
 * pattern-match without translating. `'='` is the payload the UI cares about
 * most (already-cherry-picked); the other marks are exposed for callers that
 * want a full picture.
 */
export type CherryMark = '=' | '+' | '-' | '<' | '>';

export interface IFileHistoryOptions {
  /** Pass `--follow` so rename/copy history is retained. Default: false. */
  follow?: boolean;
  /** Limit history to commits reachable from the given branch/ref. Default: current HEAD. */
  branch?: string;
  /** Maximum number of commits to return. Default: unlimited (git's default). */
  maxCount?: number;
}

/**
 * Merge options (T3-02).
 *
 * Mutex semantics enforced in the Merge Dialog UI:
 *  - `ffOnly` clears `noFf` and `squash`.
 *  - `squash` clears `noFf`.
 *  - Implementation tolerates callers that pass conflicting flags by
 *    picking the CLI-precedence one (ffOnly > noFf > squash).
 */
export interface IMergeOptions {
  /** `--ff-only`. Require a fast-forward; abort if not possible. Mutex w/ noFf + squash. */
  ffOnly?: boolean;
  /** `--no-ff`. Always create a merge commit even if fast-forward was possible. Mutex w/ ffOnly. */
  noFf?: boolean;
  /** `--squash`. Stage merge without creating a commit. Mutex w/ ffOnly. */
  squash?: boolean;
  /** `--no-commit`. Stage the merge but don't commit. */
  noCommit?: boolean;
  /** `-m <message>`. Optional merge commit message. */
  message?: string;
}

/**
 * Merge result
 */
export interface IMergeResult {
  success: boolean;
  conflicts?: string[];
  mergeCommit?: string;
}

/**
 * Create-branch options (T3-03).
 */
export interface ICreateBranchOptions {
  /**
   * Starting ref. If omitted, defaults to HEAD. May be a commit hash,
   * branch name, tag name, or any ref-ish git accepts.
   */
  startPoint?: string;
  /**
   * `--force`. When the branch already exists, reset it to `startPoint`.
   * Without this flag, a name collision fails with "already exists".
   */
  force?: boolean;
  /**
   * When `startPoint` names a remote-tracking branch, pass `--track` so
   * the new branch records it as upstream. Defaults to git's behaviour
   * (auto-detect) when undefined.
   */
  track?: boolean;
  /**
   * After creation, check out the new branch. When false or undefined,
   * the new branch is created without switching.
   */
  checkout?: boolean;
}

/**
 * Basic rebase result (for simple rebase operations)
 */
export interface IBasicRebaseResult {
  success: boolean;
  conflicts?: string[];
}

/**
 * Cherry-pick options.
 *
 * T2-05: adds `noCommit` (stage without creating a commit — IntelliJ's
 * "Cherry-Pick Without Commit") and `files` (restrict to a file subset —
 * IntelliJ's "Apply Selected Changes"). These two combine naturally:
 * `Apply Selected Changes` internally runs cherry-pick-no-commit and then
 * unstages/restores files outside the user's selection.
 */
export interface ICherryPickOptions {
  /** `--no-commit`. Apply the cherry-pick to the index + worktree without creating a commit. */
  noCommit?: boolean;
  /**
   * Restrict the cherry-pick to the given file subset. Implies `noCommit`
   * regardless of the flag (the implementation cherry-picks all files with
   * `-n`, then unstages + restores files NOT in this list).
   *
   * Empty array treated as "no files" and short-circuits with an empty
   * success result rather than erasing the index. `undefined` means
   * "no subset filter — apply all files from the commit".
   */
  files?: string[];
}

/**
 * Cherry-pick result
 */
export interface ICherryPickResult {
  success: boolean;
  conflicts?: string[];
}

/**
 * Revert result
 * Contains information about the result of a revert operation.
 */
export interface IRevertResult {
  /** Whether the revert operation succeeded */
  success: boolean;
  /** List of conflicted file paths if the revert caused conflicts */
  conflicts?: string[];
}

/**
 * Reset mode for `git reset`.
 *
 * - `soft`: move HEAD only; index and working tree untouched.
 * - `mixed` (default): move HEAD and reset the index; working tree untouched.
 * - `hard`: move HEAD, reset the index, and overwrite the working tree.
 * - `keep`: move HEAD and reset the index; keep local working-tree changes,
 *   abort if any local change would be overwritten.
 */
export type ResetMode = 'soft' | 'mixed' | 'hard' | 'keep';

/**
 * A single file that differs between two refs (or between a ref and the working tree).
 * The `status` is the short code reported by `git diff --name-status` (e.g. M, A, D, R, C, T).
 *
 * Distinct from the Details-Panel `IChangedFile` in `IGitToolWindowProvider`, which
 * uses the verbose `FileStatus` union. This type mirrors Git's short codes verbatim
 * so callers can render the native M/A/D/R/C/T/U indicators without a translation step.
 */
export interface IRefDiffFile {
  /** Path of the file, relative to the repository root. */
  path: string;
  /** Short status code: M=modified, A=added, D=deleted, R=renamed, C=copied, T=type changed, U=unmerged. */
  status: 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U';
  /** Original path when the file was renamed/copied (status R/C). */
  oldPath?: string;
}

/**
 * Branch comparison result
 * Contains information about the differences between two branches.
 */
export interface IBranchComparison {
  /** Commits in branch1 that are not in branch2 */
  commitsAhead: ICommit[];
  /** Commits in branch2 that are not in branch1 */
  commitsBehind: ICommit[];
  /** Number of commits ahead (branch1 has that branch2 doesn't) */
  aheadCount: number;
  /** Number of commits behind (branch2 has that branch1 doesn't) */
  behindCount: number;
  /** Files that differ between the two branches */
  changedFiles: string[];
}

/**
 * Core Git Service interface for interacting with Git repositories.
 * This is the main service for all Git operations.
 *
 * **FROZEN** (2026-05-09) — do not add methods to this interface. See
 * `docs/adr/ADR-001-igitservice-composite-freeze.md`. New git capabilities
 * should land on role interfaces (e.g. `IGitRemote`, `IGitHistory`,
 * `IGitBranches`, `IGitStash`, `IGitTags`, `IGitWorkingTree`,
 * `IGitRepository`, `IGitReplay`), not on this composite. Await TL-1 for
 * the full decomposition; until then, this composite is dead-letter.
 */
export interface IGitService {
  // Repository operations
  getRepository(uri: vscode.Uri): Promise<IRepository | undefined>;
  getRepositories(): IRepository[];
  onDidChangeRepository: vscode.Event<IRepository>;

  // Commit operations
  commit(repo: IRepository, message: string, options: ICommitOptions): Promise<void>;
  amend(repo: IRepository, message: string): Promise<void>;

  // Branch operations
  getBranches(repo: IRepository): Promise<IBranch[]>;
  /**
   * Create a branch. Legacy callers pass `startPoint` as the third
   * positional argument (string); new callers can pass an options object
   * with `force`, `track`, `checkout` — see {@link ICreateBranchOptions}.
   */
  createBranch(
    repo: IRepository,
    name: string,
    startPointOrOptions?: string | ICreateBranchOptions
  ): Promise<void>;
  checkout(repo: IRepository, ref: string, options?: ICheckoutOptions): Promise<void>;
  deleteBranch(repo: IRepository, name: string, force?: boolean): Promise<void>;
  renameBranch(repo: IRepository, oldName: string, newName: string): Promise<void>;
  /**
   * Merge a branch into the current one. Legacy callers pass just
   * `(repo, branch)`; new callers may pass {@link IMergeOptions}.
   */
  mergeBranch(
    repo: IRepository,
    branch: string,
    options?: IMergeOptions
  ): Promise<IMergeResult>;
  rebaseBranch(repo: IRepository, onto: string): Promise<IBasicRebaseResult>;

  /**
   * Skip the current commit during an in-progress rebase (`git rebase --skip`).
   *
   * Drops the commit under the cursor and moves on to the next one. The
   * commit's changes are NOT applied — callers should confirm destructive
   * intent before invoking (T3-05).
   *
   * @returns Result with success status and any new conflicts surfaced by
   *   the next commit in the rebase sequence.
   */
  rebaseSkip(repo: IRepository): Promise<IBasicRebaseResult>;
  compareBranches(repo: IRepository, branch1: string, branch2: string): Promise<IBranchComparison>;

  // Remote operations
  /**
   * Fetch from remote(s). Returns a structured result parsed from
   * `git fetch --porcelain`. Legacy callers can pass a remote-name string.
   */
  fetch(repo: IRepository, options?: IFetchOptions | string): Promise<IFetchResult>;
  pull(repo: IRepository, options?: IPullOptions): Promise<void>;
  push(repo: IRepository, options?: IPushOptions): Promise<void>;
  /**
   * Event fired after each fetch completes (successful or not). Consumers
   * include the auto-fetch scheduler and incoming-commits UI.
   */
  onDidFetch: vscode.Event<{ repo: IRepository; result: IFetchResult }>;
  getRemotes(repo: IRepository): Promise<IRemote[]>;
  addRemote(repo: IRepository, name: string, url: string): Promise<void>;
  removeRemote(repo: IRepository, name: string): Promise<void>;

  // Stash operations
  stash(repo: IRepository, message?: string, options?: IStashOptions): Promise<void>;
  stashList(repo: IRepository): Promise<IStash[]>;
  stashApply(repo: IRepository, index: number): Promise<void>;
  stashPop(repo: IRepository, index: number): Promise<void>;
  stashDrop(repo: IRepository, index: number): Promise<void>;
  stashShow(repo: IRepository, index: number): Promise<IDiff[]>;
  /**
   * Create a new branch rooted at the stashed state, apply the stash, and
   * drop it on success. Wraps `git stash branch <branchName> stash@{<index>}`.
   *
   * Fails (throws) if:
   *  - the branch name already exists,
   *  - the stash index is invalid,
   *  - applying the stash would conflict with the new branch's base commit
   *    (caller may route the resulting error to the Resolve Conflicts dialog
   *    like the other stash apply/pop call sites do).
   *
   * @param repo - The repository
   * @param index - Stash index (e.g. 0 for `stash@{0}`)
   * @param branchName - Name of the new branch
   */
  stashBranch(repo: IRepository, index: number, branchName: string): Promise<void>;
  /**
   * Rename a stash entry. Git has no native `stash rename`, so this uses the
   * `git stash store` plumbing: the original stash's commit object is
   * re-stored with a new message at the top of the stash stack, then the
   * original entry is dropped. No working-tree state is touched.
   *
   * After a successful rename, the renamed entry lives at `stash@{0}` and
   * all other stashes shift by one.
   *
   * @param repo - The repository
   * @param index - Stash index of the entry to rename
   * @param newMessage - The new message (subject line) for the stash
   */
  stashRename(repo: IRepository, index: number, newMessage: string): Promise<void>;

  // Tag operations
  getTags(repo: IRepository): Promise<ITag[]>;
  createTag(repo: IRepository, name: string, message?: string, ref?: string): Promise<void>;
  deleteTag(repo: IRepository, name: string): Promise<void>;
  pushTag(repo: IRepository, name: string, remote?: string): Promise<void>;

  // History operations
  getLog(repo: IRepository, options?: ILogOptions): Promise<ICommit[]>;
  getCommit(repo: IRepository, hash: string): Promise<ICommit>;
  getFileHistory(
    repo: IRepository,
    path: string,
    options?: IFileHistoryOptions
  ): Promise<ICommit[]>;

  /**
   * T3-07 — Compute `git log --cherry-mark` classifications between `baseRef`
   * and HEAD. Returns a map keyed by commit hash.
   *
   * Mark values (per git-log docs):
   *   - `'='` → this commit is a patch-equivalent of one already on the other
   *             side (i.e. "already cherry-picked"). The UI uses this to dim
   *             the row and show a ✓ badge.
   *   - `'+'` → commit is only on the left side (HEAD).
   *   - `'-'` → commit is only on the right side (baseRef).
   *   - `'<'` → left-only (boundary).
   *   - `'>'` → right-only (boundary).
   *
   * Optional — implementations may omit when the underlying git doesn't
   * support `--cherry-mark` (pre-1.6.6). Callers must handle `undefined`.
   *
   * @param repo - The repository
   * @param baseRef - The ref against which to compare (typically the upstream
   *                  branch). `HEAD...baseRef` is what gets passed to git log.
   */
  getCherryMarks?(
    repo: IRepository,
    baseRef: string
  ): Promise<Map<string, CherryMark>>;

  // Diff operations
  getDiff(repo: IRepository, path: string, staged?: boolean): Promise<IDiff>;
  getCommitDiff(repo: IRepository, hash: string): Promise<IDiff[]>;

  /**
   * List files that differ between the given ref (commit, branch, tag) and the
   * current working tree. Backed by `git diff --name-status <ref>`.
   *
   * Optional so that narrow test mocks of `IGitService` do not need to stub this
   * method; callers must guard with a nullish check and fall back to an error
   * toast when the method is absent.
   *
   * @param repo - The repository
   * @param ref - The ref to diff the working tree against
   * @returns Array of changed files with their short status code
   */
  getChangedFilesAgainstWorkingTree?(repo: IRepository, ref: string): Promise<IRefDiffFile[]>;

  /**
   * Get the combined diff for multiple commits.
   * This calculates the cumulative changes across all selected commits,
   * showing the total changes from the oldest commit's parent to the newest commit.
   *
   * @param repo - The repository
   * @param commits - Array of commit hashes (can be in any order)
   * @returns Array of diffs representing the combined changes
   */
  getMultiCommitDiff(repo: IRepository, commits: string[]): Promise<IDiff[]>;

  // Blame operations
  getBlame(repo: IRepository, path: string): Promise<IBlameLine[]>;

  // Cherry-pick and revert
  /**
   * Cherry-pick one or more commits onto the current branch.
   * Commits are applied in the order provided.
   *
   * When `options.noCommit` is true, passes `--no-commit` so changes land
   * in the index + worktree without a commit.
   *
   * When `options.files` is set, applies the cherry-pick to that file
   * subset only. Implementation: cherry-pick with `--no-commit`, then for
   * every file NOT in the subset, unstage via `git reset HEAD -- <file>`
   * and restore via `git checkout -- <file>`. The final state contains
   * only the selected files in the index + worktree.
   *
   * @param repo - The repository
   * @param commits - Array of commit hashes to cherry-pick
   * @param options - Optional cherry-pick flags (T2-05)
   * @returns Cherry-pick result with success status and any conflicts
   */
  cherryPick(
    repo: IRepository,
    commits: string[],
    options?: ICherryPickOptions
  ): Promise<ICherryPickResult>;

  /**
   * Abort an in-progress cherry-pick operation.
   * Restores the working directory to its pre-cherry-pick state.
   *
   * @param repo - The repository
   */
  cherryPickAbort(repo: IRepository): Promise<void>;

  /**
   * Continue a cherry-pick operation after resolving conflicts.
   *
   * @param repo - The repository
   * @returns Cherry-pick result with success status and any new conflicts
   */
  cherryPickContinue(repo: IRepository): Promise<ICherryPickResult>;

  /**
   * Revert one or more commits, creating new commits that undo the changes.
   * Commits are reverted in the order provided.
   *
   * @param repo - The repository
   * @param commits - Array of commit hashes to revert
   * @returns Revert result with success status and any conflicts
   */
  revert(repo: IRepository, commits: string[]): Promise<IRevertResult>;

  /**
   * Abort an in-progress revert operation.
   * Restores the working directory to its pre-revert state.
   *
   * @param repo - The repository
   */
  revertAbort(repo: IRepository): Promise<void>;

  /**
   * Continue a revert operation after resolving conflicts.
   *
   * @param repo - The repository
   * @returns Revert result with success status and any new conflicts
   */
  revertContinue(repo: IRepository): Promise<IRevertResult>;

  // Status
  getStatus(repo: IRepository): Promise<IFileStatus[]>;
  stage(repo: IRepository, paths: string[]): Promise<void>;
  unstage(repo: IRepository, paths: string[]): Promise<void>;
  stageHunk(repo: IRepository, path: string, hunk: IHunk): Promise<void>;
  stageLines(repo: IRepository, path: string, lines: number[], hunk: IHunk): Promise<void>;
  unstageHunk(repo: IRepository, path: string, hunk: IHunk): Promise<void>;

  /**
   * Revert (discard) uncommitted changes to a file.
   * This restores the file to its last committed state.
   *
   * @param repo - The repository
   * @param path - The file path to revert
   */
  revertFile(repo: IRepository, path: string): Promise<void>;

  /**
   * Reset the current branch to point at the given commit.
   * Supports the four IntelliJ reset modes (soft, mixed, hard, keep).
   *
   * @param repo - The repository
   * @param target - The commit hash, branch, or other ref to reset to
   * @param mode - The reset mode
   */
  resetToCommit(repo: IRepository, target: string, mode: ResetMode): Promise<void>;

  // Disposal
  dispose(): void;
}
