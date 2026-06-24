import * as vscode from 'vscode';
import type { ResultAsync } from 'neverthrow';

import type { GitCli } from '../gitCli';
import type { GitError } from '../errors';

/**
 * Repository state enumeration
 */
export type RepositoryState = 'idle' | 'merging' | 'rebasing' | 'cherry-picking' | 'reverting';

/**
 * Payload describing an in-progress merge / rebase / cherry-pick / revert.
 * Surfaced as the verb-form prefix on the StatusBar git widget
 * (e.g. "Merging feature/foo", "Rebasing onto main",
 * "Cherry-picking abc1234", "Reverting abc1234").
 */
export interface IInProgressOperation {
  /**
   * Operation kind. Invariant: must equal `IRepository.state` when both are
   * set; the duplication exists so consumers reading `inProgress` don't have
   * to also read `state`. The two fields move in lockstep through
   * `loadRepository`.
   */
  kind: Exclude<RepositoryState, 'idle'>;
  /**
   * Target ref/branch name when known (e.g. "main", "feature/foo"); falls
   * back to the short SHA for cherry-pick / revert. Undefined for plain
   * merges where neither a name nor a SHA-based label is available.
   */
  target?: string;
  /**
   * Abbreviated SHA, set only when the underlying marker carries a 40-char
   * hash (cherry-pick / revert). For rebase/merge `target` already holds
   * a friendly name so this stays undefined.
   */
  targetSha?: string;
}

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
 * A single file selected for {@link IGitService.rollbackChanges}. Only the path
 * and status are needed — the status decides how the file is rolled back
 * (revert from HEAD vs. unindex vs. delete).
 */
export interface IRollbackChange {
  path: string;
  status: FileStatus;
}

/** Options gating the destructive parts of {@link IGitService.rollbackChanges}. */
export interface IRollbackOptions {
  /**
   * Delete untracked files from the working tree. Untracked files have no
   * committed state to revert to, so they are removed only when the caller
   * explicitly opted them in (mirrors IntelliJ requiring unversioned files to
   * be selected before they are touched). Off by default.
   */
  deleteUntracked?: boolean;
  /**
   * After unindexing an added file, also delete it from the working tree.
   * Off by default — matching git4idea, which leaves a rolled-back added file
   * on disk as untracked rather than destroying it.
   */
  deleteAddedFiles?: boolean;
}

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
  /**
   * Submodules of this repository. Optional because the loader does not parse
   * them today (submodules surface instead as their own top-level repos via
   * nested-repo discovery). Absent means "not computed", not "none" — a future
   * loader that populates this carries the real list.
   */
  submodules?: ISubmodule[];
  /**
   * Payload for an in-progress merge/rebase/cherry-pick/revert. Undefined
   * when `state === 'idle'`. Drives the StatusBar verb-form prefix.
   */
  inProgress?: IInProgressOperation;
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
  /** GPG/SSH signature status from git log %G? — 'G'|'B'|'U'|'X'|'Y'|'R'|'E'|'N' or undefined */
  gpgStatus?: string;
  /** Absolute path of the repository root. Set when merging logs from multiple repos (G8). */
  repoRoot?: string;
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
   * the commit is created with `--author="<value>"`.
   */
  author?: string;
}

/**
 * Result of {@link IGitService.commitFixup}.
 *
 * `commitFixup` never throws on the expected failure surfaces (an invalid
 * target hash, an empty index) so the caller can translate each into a
 * specific toast. `reason` is populated only when `success` is `false`.
 */
export interface ICommitFixupResult {
  success: boolean;
  /**
   * Machine-readable failure cause:
   *   - `invalid-hash`: the target hash was not a hex sha (rejected before git ran);
   *   - `nothing-to-commit`: no staged changes, so there was nothing to fixup/squash;
   *   - `error`: any other git failure (see {@link message}).
   */
  reason?: 'invalid-hash' | 'nothing-to-commit' | 'error';
  /** Raw git stderr/stdout for the `error` reason; sanitize before display. */
  message?: string;
}

/**
 * Checkout options
 */
export interface ICheckoutOptions {
  createBranch?: boolean;
  force?: boolean;
  track?: string;
  /**
   * Maps to `git checkout -B <ref> [<startPoint>]` — "create-or-reset to
   * startpoint". Unlike `createBranch` (which emits `-b` and fails when the
   * branch already exists), `-B` resets an existing local branch's commit
   * pointer to the startpoint, or creates it if absent. This is IntelliJ's
   * "Checkout" idiom for a remote branch: `git checkout -B <branch>
   * <remote>/<branch>` lands the user on the remote tip regardless of any
   * stale local of the same name.
   *
   * **Startpoint**: when `forceCreate` is set, the `track` value doubles as
   * the startpoint positional. `{ forceCreate: true, track: 'origin/main' }`
   * emits `git checkout -B <ref> --track origin/main`, where git treats
   * `origin/main` as the single startpoint that also becomes the new
   * branch's upstream. Omitting `track` emits a bare `git checkout -B <ref>`
   * (reset to HEAD / current commit, no startpoint).
   *
   * **Mutex**: if both `forceCreate` and `createBranch` are set, `forceCreate`
   * wins — it is the strictly-more-permissive operation (`-B` succeeds whether
   * or not the branch exists, `-b` only when it doesn't).
   *
   * **argv safety**: the startpoint is user-controlled, but `--end-of-options`
   * CANNOT precede it here — with `--track`, git reinterprets the
   * post-`--end-of-options` token as a pathspec and fails with "'--track'
   * cannot be used with updating paths". The implementation instead rejects
   * startpoints starting with `-`/`.` (the same leading-token guard used by
   * `deleteBranch` / `setBranchUpstream`). The `<ref>` after `-B` is safe by
   * adjacency (git parses the token immediately after `-B` as the branch
   * name, mirroring the `-b` precedent).
   */
  forceCreate?: boolean;
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
  /** Remove remote-tracking refs that no longer exist on the remote (`--prune`). */
  prune?: boolean;
  /**
   * Stash a dirty working tree before integrating and re-apply it after
   * (`--autostash`), so an uncommitted change no longer dead-ends pull on
   * "cannot pull with rebase: you have unstaged changes" / local-changes-overwrite.
   */
  autostash?: boolean;
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
  /**
   * Explicit `<remoteRef>:<localRef>` refspec, fetched against `remote`.
   * Used by align-local "Update Selected" to fast-forward a non-checked-out
   * local branch to its tracked remote: git only advances the local ref when
   * the update is a fast-forward and refuses a non-FF, so this is the safe
   * FF-without-checkout primitive (git4idea
   * GitBranchActionsUtil.updateBranches). Requires `remote`; ignored otherwise.
   */
  refspec?: string;
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
  /**
   * Restrict the log to a single revision/ref (e.g. a branch like
   * `origin/feature`) instead of the current HEAD — used to scope the
   * cherry-pick picker to the commits ON the selected branch rather than the
   * repo's global HEAD history. Git refnames can't start with `-`, so it is
   * spliced as a positional revision arg.
   */
  ref?: string;
  /**
   * Exclude merge commits (`git log --no-merges`). Mirrors IntelliJ's
   * VCS-log "No Merges" filter. A static flag with no user input, so it is
   * spliced as a plain argument.
   */
  noMerges?: boolean;
  /**
   * Follow only the first parent of each merge (`git log --first-parent`).
   * Mirrors IntelliJ PermanentGraph.Options.FirstParent. A static flag.
   */
  firstParent?: boolean;
  /**
   * Prune merges made redundant by history simplification
   * (`git log --simplify-merges`). Part of IntelliJ's graph options chooser.
   * A static flag.
   */
  simplifyMerges?: boolean;
  /**
   * Only commits with at least this many parents (`git log --min-parents=N`).
   * Mirrors IntelliJ ParentFilterModel min bound. A number, spliced verbatim.
   */
  minParents?: number;
  /**
   * Only commits with at most this many parents (`git log --max-parents=N`).
   * Mirrors IntelliJ ParentFilterModel max bound. A number, spliced verbatim.
   */
  maxParents?: number;
  /**
   * Revision range like "main..feature" or "main...feature", passed as a
   * positional ref. Mirrors IntelliJ BranchFilterModel range notation
   * (VcsLogRangeFilter). User-typed, so it is validated (reject a leading
   * `-`/`.`) before use; ranges are self-scoping, so callers suppress `--all`.
   */
  logRange?: string;
  /**
   * Force `git log --topo-order`. Default (false) leaves git's default
   * date-driven ordering, which is wrong for graph rendering after
   * history-rewrites (rebase, squash, cherry-pick) — committer dates
   * become "now" and date-sorted output interleaves divergent branches
   * between a commit and its real parent. The graph-rendering caller
   * MUST set this; other callers (file history, search, etc.) can
   * leave it off.
   */
  topoOrder?: boolean;
  /**
   * Interpret `grep` as a Perl-extended regex (`git log -E`). Default (false)
   * treats `grep` as plain/basic-regex text. Mirrors IntelliJ's VCS-log text
   * filter "Use regex" toggle. Only meaningful alongside `grep`.
   */
  regex?: boolean;
  /**
   * Match `grep` case-sensitively. Default (false/undefined) adds
   * `--regexp-ignore-case` so the search is case-insensitive — matching
   * IntelliJ's "Match case" toggle, which is OFF by default. Only meaningful
   * alongside `grep`.
   */
  caseSensitive?: boolean;
}

/**
 * Options for {@link IGitService.getFileHistory}.
 *
 * Kept separate from {@link ILogOptions} because file-history introduces
 * two flags that don't otherwise make sense for a general `git log`:
 *   - `follow`: pass `--follow` so rename history is preserved
 *   - `branch`: limit history to commits reachable from the given branch
 *
 * `maxCount` is also exposed so callers can paginate / cap results for UI.
 */
/**
 * Commit classification returned by `git log --cherry-mark`.
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
 * Merge options.
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
  /** `--no-verify`. Bypass the pre-merge / commit-msg hooks. */
  noVerify?: boolean;
  /** `--allow-unrelated-histories`. Merge histories with no common ancestor. */
  allowUnrelatedHistories?: boolean;
  /** `-m <message>`. Optional merge commit message. */
  message?: string;
}

/**
 * Non-interactive rebase options — IntelliJ git4idea `GitRebaseOption`
 * parity (the flag-only members of `REBASE_FLAGS`). All default to off, so a
 * legacy `rebaseBranch(repo, onto)` call emits the same argv as before.
 *
 * The flags are spliced (in this declaration order, matching git4idea's enum)
 * between the `rebase` subcommand and the `--end-of-options <onto>` ref guard.
 */
export interface IRebaseOptions {
  /** `--rebase-merges`. Recreate merge commits instead of flattening them. */
  rebaseMerges?: boolean;
  /** `--keep-empty`. Keep commits that start empty. */
  keepEmpty?: boolean;
  /**
   * `--root`. Rebase all commits reachable from HEAD, back to the root.
   * When set, NO upstream/onto ref is passed (git4idea disables that field).
   */
  root?: boolean;
  /** `--update-refs`. Advance any branch refs that point at rebased commits. */
  updateRefs?: boolean;
  /** `--autosquash`. Reorder `fixup!`/`squash!` commits under their targets. */
  autosquash?: boolean;
  /**
   * `--onto <newbase>`. Rebase the `<upstream>..HEAD` range onto a different
   * base than the upstream (git4idea GitRebaseDialog "Onto" field). When unset
   * the argv is unchanged. The newbase lands as the argument of `--onto`,
   * before `--end-of-options`; a `-`/`.`-leading newbase is rejected at the
   * service boundary so a hostile ref can never be parsed as a git flag.
   */
  newBase?: string;
}

/**
 * Merge result.
 *
 * Failure shapes (mutually exclusive at the call site):
 *   - `success: true` → no other fields are read.
 *   - `success: false` with non-empty `conflicts` → callers route to the
 *     resolve-conflicts dialog.
 *   - `success: false`, empty/undefined `conflicts`, AND `failureReason`
 *     set → non-conflict failure (refused merge, unrelated histories,
 *     dirty tree, etc.). Callers MUST surface `failureReason` to the
 *     user instead of dropping the failure silently. Sanitized at the
 *     GitService boundary; safe to pass directly to a toast.
 */
export interface IMergeResult {
  success: boolean;
  conflicts?: string[];
  mergeCommit?: string;
  /**
   * Sanitized error reason for non-conflict failures. Populated when
   * git's exit code is non-zero AND no merge-conflict files are
   * present, so the caller can show the underlying git error instead
   * of a silent no-op.
   */
  failureReason?: string;
}

/**
 * Create-branch options.
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
 * Basic rebase result (for simple rebase operations).
 *
 * See {@link IMergeResult} for the documented failure-shape contract;
 * `failureReason` is populated identically here for non-conflict
 * failures so callers never drop the failure silently.
 */
/**
 * Conflict-bearing arm of {@link IBasicRebaseResult}.
 *
 * Selected whenever `conflicts` is a non-empty list (the empty-list /
 * no-conflict outcomes match {@link IBasicRebaseOutcomeResult}, whose
 * `conflicts` is typed `[]`). `rebaseInProgress` is REQUIRED so a conflict can
 * never be reported without declaring its continuability.
 *
 * Continuability is orthogonal to conflict-ness: a mid-replay conflict leaves
 * a live rebase (`true`, continue/abort apply), while an `--autostash` pop
 * conflict happens after the rebase already finished (`false`, no rebase in
 * progress — `git rebase --continue` would dead-end on "no rebase in
 * progress"). Consumers gate the continue/abort affordance on
 * `rebaseInProgress === true`; when `false` they offer only resolve-and-stage
 * (`git add`).
 */
export interface IBasicRebaseConflictResult {
  success: false;
  conflicts: string[];
  rebaseInProgress: boolean;
  failureReason?: never;
}

/**
 * Non-conflict arm of {@link IBasicRebaseResult}: a clean success, or a
 * non-conflict failure (dirty working tree, in-progress rebase, refs out of
 * sync, etc.). Carries an optional sanitized `failureReason` for the failure
 * case and an empty (or absent) `conflicts` list. The continuability flag is
 * forbidden here (`?: never`) so it only ever appears on a genuine conflict,
 * never polluting a non-conflict result.
 */
export interface IBasicRebaseOutcomeResult {
  success: boolean;
  conflicts?: [];
  /**
   * Sanitized error reason for non-conflict failures (e.g. "cannot
   * rebase: You have unstaged changes", in-progress rebase, etc.).
   */
  failureReason?: string;
  rebaseInProgress?: never;
}

export type IBasicRebaseResult = IBasicRebaseConflictResult | IBasicRebaseOutcomeResult;

/**
 * Cherry-pick options.
 *
 * Adds `noCommit` (stage without creating a commit — IntelliJ's
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
  /**
   * `-x`. Append a `(cherry picked from commit <hash>)` line to each new
   * commit message — IntelliJ's `addCherryPickedFromSuffix`. Ignored when the
   * pick does not commit (`noCommit` or a `files` subset), since there is no
   * commit message to annotate.
   */
  addCherryPickedFrom?: boolean;
  /**
   * `-m <mainline>`. Required when cherry-picking a merge commit; specifies
   * which parent (1-based) to treat as the mainline. Conventional default is
   * `1` (the first parent, typically the branch the merge landed on).
   */
  mainline?: number;
}

/**
 * Options for {@link IGitService.revert}.
 */
export interface IRevertOptions {
  /**
   * `-m <mainline>`. Required when reverting a merge commit; specifies which
   * parent (1-based) to treat as the mainline. Conventional default is `1`.
   */
  mainline?: number;
  /**
   * Custom commit message for the revert commit. When provided the
   * implementation uses `--no-commit` then `git commit -m <message>` so the
   * message is set without needing `$GIT_EDITOR`.
   * When absent the existing `--no-edit` path is used (git generates
   * "Revert \"<subject>\"" automatically).
   */
  message?: string;
}

/**
 * Cherry-pick result.
 *
 * See {@link IMergeResult} for the documented failure-shape contract;
 * `failureReason` is populated identically here for non-conflict
 * failures so callers never drop the failure silently.
 */
export interface ICherryPickResult {
  success: boolean;
  conflicts?: string[];
  /**
   * Sanitized error reason for non-conflict failures (e.g. "your local
   * changes would be overwritten", "fatal: bad object <hash>").
   */
  failureReason?: string;
}

/**
 * Revert result.
 *
 * Contains information about the result of a revert operation.
 *
 * See {@link IMergeResult} for the documented failure-shape contract;
 * `failureReason` is populated identically here for non-conflict
 * failures so callers never drop the failure silently.
 */
export interface IRevertResult {
  /** Whether the revert operation succeeded */
  success: boolean;
  /** List of conflicted file paths if the revert caused conflicts */
  conflicts?: string[];
  /**
   * Sanitized error reason for non-conflict failures.
   */
  failureReason?: string;
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
 * `IGitRepository`, `IGitReplay`), not on this composite. The full
 * role-interface decomposition is tracked in the backlog; until then,
 * this composite is dead-letter.
 */
export interface IGitService {
  // Repository operations
  getRepository(uri: vscode.Uri): Promise<IRepository | undefined>;
  /**
   * Returns every repository discovered across all workspace folders.
   *
   * Includes nested repositories within each workspace folder, subject to
   * the `intellig.repositoryScanMaxDepth` setting (default `1`, mirroring
   * VS Code's `git.repositoryScanMaxDepth`). Common build/dependency
   * folders (`node_modules`, `dist`, `out`, etc.) are always skipped, plus
   * any extra basenames the user adds to
   * `intellig.repositoryScanIgnoredFolders`. New repositories created
   * mid-session (e.g. via `git init` in a subfolder) are picked up
   * automatically by a `**\/.git` filesystem watcher.
   */
  getRepositories(): IRepository[];
  onDidChangeRepository: vscode.Event<IRepository>;
  /**
   * (#213): fired when a previously-discovered repository is
   * removed from tracking — either because the user removed the
   * containing workspace folder, OR because the repo's `.git/HEAD` was
   * deleted mid-session (`rm -rf .git`, aggressive `git worktree remove`,
   * etc.). Subscribers that mirror the repo list (BranchTreeProvider,
   * StatusBarService, BranchPopup, ChangelistService,
   * ConflictResolutionService, GitToolWindowProvider) listen and drop
   * the repo from their UI.
   *
   * Required (not optional) on the interface
   * so production callers can subscribe directly without `?.()` guards.
   * Test mocks adopt the {@link noopEvent} helper from
   * `src/test/mocks/noopEvent.ts` to add a one-line stub.
   */
  onDidRemoveRepository: vscode.Event<IRepository>;

  /**
   * Synchronously invalidate + reload a repository's cache entry,
   * then return the fresh `IRepository`.
   *
   * Mutation handlers (`checkout`, `cherry-pick`, etc.) call this BEFORE
   * `provider.refresh()` so the panel reload runs against fresh
   * `repo.head` / `repo.state` instead of racing the
   * {@link onDidChangeRepository} watcher path (which has a 250 ms
   * debounce and used to be the only reload trigger). Fires
   * `onDidChangeRepository` as a side-effect so subscribers
   * (BranchTreeProvider, StatusBarService, etc.) refresh too.
   *
   * **Caller contract **: callers MUST NOT branch on
   * the return value. The `IRepository | undefined` return type is for
   * type safety against the failure path; the BEHAVIOR is fire-and-forget.
   * Always call `provider.refresh()` next regardless of whether the
   * return is `undefined` (reload failed → watcher's debounced reload
   * picks up the change as the safety net) or a fresh `IRepository`
   * (reload succeeded → panel reads the new value on the next render).
   * Pinned by `headChipRefresh.test.ts` "defensive fallback" invariant.
   *
   * @param repo - The repository to reload
   * @returns The fresh repository on success, or `undefined` on reload
   *   failure. Type-narrow only; do NOT use the return for control flow.
   */
  reloadRepository(repo: IRepository): Promise<IRepository | undefined>;

  // Commit operations
  commit(repo: IRepository, message: string, options: ICommitOptions): ResultAsync<void, GitError>;
  amend(repo: IRepository, message: string): ResultAsync<void, GitError>;
  commitFixup(
    repo: IRepository,
    targetHash: string,
    mode: 'fixup' | 'squash'
  ): ResultAsync<ICommitFixupResult, GitError>;

  // Branch operations
  getBranches(repo: IRepository): Promise<IBranch[]>;
  /**
   * Branches (local + remote) that contain the given commit, sorted
   * alphabetically. Backs the "Contained in branches" row in the commit
   * details panel. Degrades to an empty list on failure.
   */
  getContainingBranches(repo: IRepository, hash: string): Promise<string[]>;
  /**
   * Commits common to HEAD and `ref` (reachable from both). Backs the
   * "highlight common commits" treatment when a non-checked-out branch is
   * selected. Degrades to an empty list on failure or unrelated histories.
   */
  getCommonCommits(repo: IRepository, ref: string): Promise<string[]>;
  /**
   * Distinct commit authors across all refs, formatted `"Name <email>"`,
   * in descending commit-count order, capped at 500. Source for the
   * ref-aware author datalist in the log filter bar.
   */
  getLogContributors(repo: IRepository): Promise<string[]>;
  /**
   * Create a branch. Legacy callers pass `startPoint` as the third
   * positional argument (string); new callers can pass an options object
   * with `force`, `track`, `checkout` — see {@link ICreateBranchOptions}.
   */
  createBranch(
    repo: IRepository,
    name: string,
    startPointOrOptions?: string | ICreateBranchOptions
  ): ResultAsync<void, GitError>;
  checkout(repo: IRepository, ref: string, options?: ICheckoutOptions): ResultAsync<void, GitError>;
  deleteBranch(repo: IRepository, name: string, force?: boolean): ResultAsync<void, GitError>;
  renameBranch(repo: IRepository, oldName: string, newName: string): ResultAsync<void, GitError>;
  /**
   * Set the upstream tracking ref of an existing
   * local branch. Routes through `git branch --set-upstream-to=<ref>
   * <localName>`. Used by the Track Remote Branch single-menu-entry
   * smart-detect path: when a local with the matching simple name
   * already exists (with no upstream OR with a different upstream),
   * we adopt the right-clicked remote ref via this API rather than
   * creating a new local branch.
   *
   * Argv layout:
   *   `git branch --set-upstream-to=<remote>/<branch> <localName>`
   *
   * Both `localName` and `upstreamRef` are user-controlled; the
   * implementation rejects names starting with `-` / `.` (
   * leading-dash guard) and splices `--end-of-options` between the
   * flag(s) and the local name.
   */
  setBranchUpstream(
    repo: IRepository,
    localName: string,
    upstreamRef: string
  ): ResultAsync<void, GitError>;
  /**
   * Merge a branch into the current one. Legacy callers pass just
   * `(repo, branch)`; new callers may pass {@link IMergeOptions}.
   */
  mergeBranch(repo: IRepository, branch: string, options?: IMergeOptions): Promise<IMergeResult>;
  rebaseBranch(
    repo: IRepository,
    onto: string,
    options?: IRebaseOptions
  ): Promise<IBasicRebaseResult>;

  /**
   * Skip the current commit during an in-progress rebase (`git rebase --skip`).
   *
   * Drops the commit under the cursor and moves on to the next one. The
   * commit's changes are NOT applied — callers should confirm destructive
   * intent before invoking.
   *
   * @returns Result with success status and any new conflicts surfaced by
   *   the next commit in the rebase sequence.
   */
  rebaseSkip(repo: IRepository): Promise<IBasicRebaseResult>;

  /**
   * Abort an in-progress rebase (`git rebase --abort`).
   *
   * Restores the working tree and HEAD to the pre-rebase state, removing
   * the `.git/rebase-merge/` (or `rebase-apply/`) metadata. Used by the
   * Bug C auto-abort recovery path in `_handleRebaseCurrentOnto`: when our
   * own `rebaseBranch` invocation left an orphaned rebasing state after a
   * non-conflict failure, the handler runs this so the click behaves as
   * "it should be like I never clicked it".
   *
   * Mirrors {@link cherryPickAbort} / {@link revertAbort}: resolves on
   * success, rejects (via `throwOnError`) on failure so the caller can
   * surface a sanitized error.
   *
   * @param repo - The repository
   */
  rebaseAbort(repo: IRepository): ResultAsync<void, GitError>;

  /**
   * Continue an in-progress rebase after the user resolves conflicts
   * (`git rebase --continue`).
   *
   * Mirrors {@link rebaseSkip}'s result-shape contract: on success returns
   * `{success: true}`; on exit-code ≠ 0 with unmerged files still present
   * returns `{success: false, conflicts}` so callers (e.g. the Resolve
   * Conflicts dialog) can re-render the new conflict set; on exit-code ≠ 0
   * with no unmerged files surfaces the underlying git error via
   * `failureReason`.
   *
   * @param repo - The repository
   */
  rebaseContinue(repo: IRepository): Promise<IBasicRebaseResult>;
  compareBranches(repo: IRepository, branch1: string, branch2: string): Promise<IBranchComparison>;

  // Remote operations
  /**
   * Fetch from remote(s). Returns a structured result parsed from
   * `git fetch --porcelain`. Legacy callers can pass a remote-name string.
   */
  fetch(repo: IRepository, options?: IFetchOptions | string): ResultAsync<IFetchResult, GitError>;
  pull(repo: IRepository, options?: IPullOptions): ResultAsync<void, GitError>;
  push(repo: IRepository, options?: IPushOptions): ResultAsync<void, GitError>;
  /**
   * Event fired after each fetch completes (successful or not). Consumers
   * include the auto-fetch scheduler and incoming-commits UI.
   */
  onDidFetch: vscode.Event<{ repo: IRepository; result: IFetchResult }>;
  getRemotes(repo: IRepository): ResultAsync<IRemote[], GitError>;
  addRemote(repo: IRepository, name: string, url: string): ResultAsync<void, GitError>;
  removeRemote(repo: IRepository, name: string): ResultAsync<void, GitError>;
  /** Change a remote's URL (`git remote set-url`). */
  setRemoteUrl(repo: IRepository, name: string, url: string): ResultAsync<void, GitError>;
  /** Rename a remote (`git remote rename`). */
  renameRemote(repo: IRepository, oldName: string, newName: string): ResultAsync<void, GitError>;

  // Stash operations
  stash(repo: IRepository, message?: string, options?: IStashOptions): ResultAsync<void, GitError>;
  stashList(repo: IRepository): Promise<IStash[]>;
  /**
   * Apply a stash. `reinstateIndex` (default true) controls whether `--index`
   * reinstates the staged/unstaged split — IntelliJ unstash "Reinstate index".
   */
  stashApply(
    repo: IRepository,
    index: number,
    reinstateIndex?: boolean
  ): ResultAsync<void, GitError>;
  /** Apply + drop a stash. `reinstateIndex` as in {@link stashApply}. */
  stashPop(repo: IRepository, index: number, reinstateIndex?: boolean): ResultAsync<void, GitError>;
  stashDrop(repo: IRepository, index: number): ResultAsync<void, GitError>;
  stashShow(repo: IRepository, index: number): Promise<IDiff[]>;
  /**
   * Create a new branch rooted at the stashed state, apply the stash, and
   * drop it on success. Wraps `git stash branch <branchName> stash@{<index>}`.
   *
   * Returns an Err (via the Result channel) if:
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
  stashBranch(repo: IRepository, index: number, branchName: string): ResultAsync<void, GitError>;
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
  stashRename(repo: IRepository, index: number, newMessage: string): ResultAsync<void, GitError>;

  // Tag operations
  getTags(repo: IRepository): Promise<ITag[]>;
  createTag(
    repo: IRepository,
    name: string,
    message?: string,
    ref?: string,
    force?: boolean
  ): ResultAsync<void, GitError>;
  deleteTag(repo: IRepository, name: string): ResultAsync<void, GitError>;
  pushTag(repo: IRepository, name: string, remote?: string): ResultAsync<void, GitError>;
  /** Delete a tag on the remote (`git push <remote> :refs/tags/<name>`). */
  deleteRemoteTag(repo: IRepository, name: string, remote?: string): ResultAsync<void, GitError>;

  // History operations
  getLog(repo: IRepository, options?: ILogOptions): Promise<ICommit[]>;
  /**
   * Count how many commits the SAME refs/filter as {@link getLog} would yield,
   * ignoring the `maxCount`/`skip` window (`git rev-list --count`). Used by the
   * Graph view to render an honest "X of Y" loaded indicator and to know when
   * scroll-to-bottom load-more has reached the true end of history.
   *
   * Mirrors the option-to-arg mapping of {@link getLog} for every filter that
   * changes the commit SET (author/since/until/grep/no-merges/parent-count/
   * ref/range/path/all); window-only options (`maxCount`, `skip`) and ordering
   * options (`topoOrder`) are ignored because they don't change the total.
   */
  getLogCount(repo: IRepository, options?: ILogOptions): Promise<number>;
  getCommit(repo: IRepository, hash: string): Promise<ICommit>;
  getFileHistory(
    repo: IRepository,
    path: string,
    options?: IFileHistoryOptions
  ): Promise<ICommit[]>;

  /**
   * Line-scoped file history via `git log -L<startLine>,<endLine>:<path>`.
   *
   * Restricts the commit list to revisions that touched the given inclusive
   * line range, mirroring IntelliJ's "Show History for Selection"
   * (`SelectedBlockHistoryAction` / `VcsSelectionHistoryDialog`). `startLine`
   * and `endLine` are 1-based and inclusive (`startLine <= endLine`).
   *
   * Optional — implementations may omit it; callers must fall back to
   * {@link getFileHistory} (whole-file history) when it is absent.
   */
  getLineHistory?(
    repo: IRepository,
    path: string,
    startLine: number,
    endLine: number,
    options?: IFileHistoryOptions
  ): Promise<ICommit[]>;

  /**
   * Compute `git log --cherry-mark` classifications between `baseRef`
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
  getCherryMarks?(repo: IRepository, baseRef: string): Promise<Map<string, CherryMark>>;

  // Diff operations
  getDiff(repo: IRepository, path: string, staged?: boolean): Promise<IDiff>;
  getCommitDiff(repo: IRepository, hash: string): Promise<IDiff[]>;

  /**
   * Load a file's content as of a specific revision — the file-history "Get
   * version" / open-revision path. Backed by `git show <rev>:<path>`.
   *
   * Returns the file content, or an empty string when the file does not exist
   * at that revision. Optional so narrow test mocks of `IGitService` need not
   * stub it; callers must guard with a nullish check.
   *
   * @param repo - The repository
   * @param path - Repo-relative path of the file
   * @param rev - Revision (commit hash, branch, tag) to read the file at
   */
  getFileAtRevision?(repo: IRepository, path: string, rev: string): Promise<string>;

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
   * Compute the merge-base between two refs.
   *
   * Returns the SHA of the best common ancestor. Backed by
   * `git merge-base <refA> <refB>`. Used by the Git tool window's branch
   * focus feature to mark every commit on the path from a focused branch
   * tip back to its merge-base with HEAD as "on the focused path".
   *
   * Returns `undefined` when:
   *   - the refs share no common ancestor (disjoint histories — git
   *     exits non-zero), or
   *   - either ref is unknown / invalid, or
   *   - the underlying `git merge-base` invocation fails for any reason.
   *
   * Optional, mirroring the {@link getCherryMarks} /
   * {@link getChangedFilesAgainstWorkingTree} pattern: narrow test mocks
   * needn't stub it, and the focus-on-graph caller falls back to no
   * highlight when it's absent or returns undefined (Trap T-8).
   *
   * @param repo - The repository
   * @param refA - The first ref (typically `HEAD`)
   * @param refB - The second ref (typically the focused branch name)
   * @returns The merge-base commit SHA, or undefined when none / on error
   */
  getMergeBase?(repo: IRepository, refA: string, refB: string): Promise<string | undefined>;

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
   * @param options - Optional cherry-pick flags
   * @returns Cherry-pick result with success status and any conflicts
   */
  cherryPick(
    repo: IRepository,
    commits: string[],
    options?: ICherryPickOptions
  ): ResultAsync<ICherryPickResult, GitError>;

  /**
   * Abort an in-progress cherry-pick operation.
   * Restores the working directory to its pre-cherry-pick state.
   *
   * @param repo - The repository
   */
  cherryPickAbort(repo: IRepository): ResultAsync<void, GitError>;

  /**
   * Continue a cherry-pick operation after resolving conflicts.
   *
   * @param repo - The repository
   * @returns Cherry-pick result with success status and any new conflicts
   */
  cherryPickContinue(repo: IRepository): ResultAsync<ICherryPickResult, GitError>;

  /**
   * Revert one or more commits, creating new commits that undo the changes.
   * Commits are reverted in the order provided.
   *
   * @param repo - The repository
   * @param commits - Array of commit hashes to revert
   * @returns Revert result with success status and any conflicts
   */
  revert(
    repo: IRepository,
    commits: string[],
    options?: IRevertOptions
  ): ResultAsync<IRevertResult, GitError>;

  /**
   * Abort an in-progress revert operation.
   * Restores the working directory to its pre-revert state.
   *
   * @param repo - The repository
   */
  revertAbort(repo: IRepository): ResultAsync<void, GitError>;

  /**
   * Continue a revert operation after resolving conflicts.
   *
   * @param repo - The repository
   * @returns Revert result with success status and any new conflicts
   */
  revertContinue(repo: IRepository): ResultAsync<IRevertResult, GitError>;

  // Status
  getStatus(repo: IRepository): Promise<IFileStatus[]>;
  stage(repo: IRepository, paths: string[]): ResultAsync<void, GitError>;
  unstage(repo: IRepository, paths: string[]): ResultAsync<void, GitError>;
  stageHunk(repo: IRepository, path: string, hunk: IHunk): ResultAsync<void, GitError>;
  stageLines(
    repo: IRepository,
    path: string,
    lines: number[],
    hunk: IHunk
  ): ResultAsync<void, GitError>;
  unstageHunk(repo: IRepository, path: string, hunk: IHunk): ResultAsync<void, GitError>;

  /**
   * Revert (discard) a single hunk in the working tree (`git apply -R`,
   * no `--cached`). Mirrors IntelliJ's "Revert Chunk".
   */
  revertHunk(repo: IRepository, path: string, hunk: IHunk): ResultAsync<void, GitError>;

  /**
   * Revert (discard) uncommitted changes to a file.
   * This restores the file to its last committed state.
   *
   * @param repo - The repository
   * @param path - The file path to revert
   */
  revertFile(repo: IRepository, path: string): ResultAsync<void, GitError>;

  /**
   * Roll back (revert local changes for) a set of selected files at once —
   * IntelliJ's "Rollback" / "Revert Local Changes". Per git4idea's
   * GitRollbackEnvironment.rollbackChanges:
   *   - modified / deleted / renamed → restored from HEAD
   *     (`git checkout HEAD -- <paths>`);
   *   - added (staged-new) → unindexed (`git rm --cached -f -- <paths>`),
   *     left on disk as untracked unless {@link IRollbackOptions.deleteAddedFiles};
   *   - untracked → deleted from disk only when
   *     {@link IRollbackOptions.deleteUntracked} (data loss with no recovery).
   *
   * Destructive: callers MUST confirm before invoking.
   */
  rollbackChanges(
    repo: IRepository,
    changes: IRollbackChange[],
    options?: IRollbackOptions
  ): ResultAsync<void, GitError>;

  /**
   * Reset the current branch to point at the given commit.
   * Supports the four IntelliJ reset modes (soft, mixed, hard, keep).
   *
   * @param repo - The repository
   * @param target - The commit hash, branch, or other ref to reset to
   * @param mode - The reset mode
   */
  resetToCommit(repo: IRepository, target: string, mode: ResetMode): ResultAsync<void, GitError>;

  // Disposal
  dispose(): void;
}

/**
 * @internal — exposes the low-level `GitCli` handle for call sites that need
 * to issue raw git commands (e.g. `git show <ref>:<path>`) that the frozen
 * {@link IGitService} composite deliberately doesn't wrap.
 *
 * `GitService` implements both {@link IGitService} and this interface.
 * Do not add new call sites without tech-lead review; each such site is a
 * candidate to become a proper role-interface method under the composite
 * decomposition effort (see backlog). See `docs/testing.md` section 5 for the
 * relationship between this production escape hatch and the TestSurface
 * idiom used by tests.
 */
export interface IGitServiceCli {
  readonly gitCli: GitCli;
}
