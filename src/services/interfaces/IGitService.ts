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
  previousCommit?: string;
}

/**
 * Commit options
 */
export interface ICommitOptions {
  amend?: boolean;
  signOff?: boolean;
  noVerify?: boolean;
  allowEmpty?: boolean;
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
  rebase?: boolean;
  remote?: string;
  branch?: string;
}

/**
 * Push options
 */
export interface IPushOptions {
  force?: boolean;
  forceWithLease?: boolean;
  setUpstream?: boolean;
  remote?: string;
  branch?: string;
  tags?: boolean;
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
 * Merge result
 */
export interface IMergeResult {
  success: boolean;
  conflicts?: string[];
  mergeCommit?: string;
}

/**
 * Basic rebase result (for simple rebase operations)
 */
export interface IBasicRebaseResult {
  success: boolean;
  conflicts?: string[];
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
  createBranch(repo: IRepository, name: string, startPoint?: string): Promise<void>;
  checkout(repo: IRepository, ref: string, options?: ICheckoutOptions): Promise<void>;
  deleteBranch(repo: IRepository, name: string, force?: boolean): Promise<void>;
  renameBranch(repo: IRepository, oldName: string, newName: string): Promise<void>;
  mergeBranch(repo: IRepository, branch: string): Promise<IMergeResult>;
  rebaseBranch(repo: IRepository, onto: string): Promise<IBasicRebaseResult>;
  compareBranches(repo: IRepository, branch1: string, branch2: string): Promise<IBranchComparison>;

  // Remote operations
  fetch(repo: IRepository, remote?: string): Promise<void>;
  pull(repo: IRepository, options?: IPullOptions): Promise<void>;
  push(repo: IRepository, options?: IPushOptions): Promise<void>;
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

  // Tag operations
  getTags(repo: IRepository): Promise<ITag[]>;
  createTag(repo: IRepository, name: string, message?: string, ref?: string): Promise<void>;
  deleteTag(repo: IRepository, name: string): Promise<void>;
  pushTag(repo: IRepository, name: string, remote?: string): Promise<void>;

  // History operations
  getLog(repo: IRepository, options?: ILogOptions): Promise<ICommit[]>;
  getCommit(repo: IRepository, hash: string): Promise<ICommit>;
  getFileHistory(repo: IRepository, path: string): Promise<ICommit[]>;

  // Diff operations
  getDiff(repo: IRepository, path: string, staged?: boolean): Promise<IDiff>;
  getCommitDiff(repo: IRepository, hash: string): Promise<IDiff[]>;

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
   * @param repo - The repository
   * @param commits - Array of commit hashes to cherry-pick
   * @returns Cherry-pick result with success status and any conflicts
   */
  cherryPick(repo: IRepository, commits: string[]): Promise<ICherryPickResult>;

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

  // Disposal
  dispose(): void;
}
