import * as vscode from 'vscode';
import { IRepository } from './IGitService';
import type { RebaseAction } from './rebaseAction';

/**
 * Rebase action types (defined vscode-free in ./rebaseAction; re-exported here
 * as the canonical name).
 */
export type { RebaseAction } from './rebaseAction';

/**
 * Rebase session status.
 *
 * `cleared-stale` is distinct from `completed`: it marks a no-op where a
 * continue/skip/abort found NO live git rebase and self-cleared a phantom
 * (stale) cached session. No commits were replayed, so the UI must report it
 * honestly rather than claiming the rebase completed.
 */
export type RebaseStatus =
  'planning' | 'in-progress' | 'paused' | 'conflict' | 'completed' | 'cleared-stale';

/**
 * Commit in a rebase session
 */
export interface IRebaseCommit {
  hash: string;
  /** Subject line — the plan row's one-line label. */
  message: string;
  /**
   * The commit's complete message (subject + body). Seeds the reword box and
   * any message-rewriting consumer — reading `message` there drops the body.
   * Absent on sessions reconstructed from an on-disk todo (detectActiveRebase),
   * whose todo lines carry subjects only; consumers fall back to `message`.
   */
  fullMessage?: string;
  action: RebaseAction;
  /** User-edited message override for 'reword' action (H1 inline editing). */
  newMessage?: string;
}

/**
 * Rebase action for updating the plan
 */
export interface IRebaseAction {
  hash: string;
  action: RebaseAction;
  newMessage?: string;
}

/**
 * Sentinel `onto` value for a full-history rebase: the initial commit has no
 * parent to rebase onto, so an edit that includes it runs `git rebase -i
 * --root` (no positional base). Deliberately not a valid revision or flag —
 * an accidental splice into a positional argv fails loudly instead of acting
 * as either.
 */
export const REBASE_ROOT = '<root>';

/**
 * Rebase session state
 */
export interface IRebaseSession {
  /** Rebase base revision, or {@link REBASE_ROOT} for a `--root` rebase. */
  onto: string;
  originalBranch: string;
  commits: IRebaseCommit[];
  currentStep: number;
  status: RebaseStatus;
}

/**
 * Conflict-bearing arm of {@link IRebaseResult}.
 *
 * Discriminated by `status: 'conflict'`. `rebaseInProgress` is REQUIRED so a
 * conflict can never be reported without declaring its continuability —
 * consumers gate the continue/abort affordance on it (`=== true`).
 *
 * Continuability is orthogonal to conflict-ness: a mid-replay conflict leaves
 * a live rebase (`true`, continue/abort apply), while an `--autostash` pop
 * conflict happens after the rebase already finished (`false`, no rebase in
 * progress — `git rebase --continue` would dead-end on "no rebase in
 * progress"). When `false` consumers offer only resolve-and-stage (`git add`).
 */
export interface IRebaseConflictResult {
  success: false;
  status: 'conflict';
  conflictedFiles: string[];
  rebaseInProgress: boolean;
  autostashParked?: never;
}

/**
 * Non-conflict arm of {@link IRebaseResult} (completed / in-progress / paused
 * / planning). These outcomes carry no conflict files and no continuability
 * flag — both are forbidden here (`?: never`) so the meaningful
 * `rebaseInProgress` only ever appears on a genuine conflict, never polluting
 * a success result.
 */
export interface IRebaseOutcomeResult {
  success: boolean;
  status: Exclude<RebaseStatus, 'conflict'>;
  conflictedFiles?: never;
  rebaseInProgress?: never;
  /**
   * Terminal transitions only: `true` when git's `--autostash` reapply
   * conflicted and the entry was PARKED as a normal stash entry (data-safe;
   * git reset the tree first). Consumers surface the shared
   * AUTOSTASH_PARKED_WARNING copy exactly once per terminal transition.
   */
  autostashParked?: boolean;
}

/**
 * Result of a rebase operation.
 *
 * A discriminated union: a `status: 'conflict'` result MUST set
 * `rebaseInProgress` (see {@link IRebaseConflictResult}); every other outcome
 * forbids it (see {@link IRebaseOutcomeResult}).
 */
export type IRebaseResult = IRebaseConflictResult | IRebaseOutcomeResult;

/**
 * Rebase Service interface for interactive rebase operations.
 */
export interface IRebaseService {
  /**
   * Start an interactive rebase
   */
  startInteractiveRebase(repo: IRepository, onto: string): Promise<IRebaseSession>;

  /**
   * Get the current rebase session
   */
  getRebaseSession(repo: IRepository): IRebaseSession | undefined;

  /**
   * True when this service holds a live IN-MEMORY session for the repo — i.e.
   * the extension itself is driving a rebase episode (squash / interactive
   * rebase / a paused extension-run rebase). Reads the raw session map WITHOUT
   * the disk-reconstruction {@link getRebaseSession} does, so an inherited/CLI
   * rebase (no in-memory session) reads false. Lets callers tell an
   * extension-managed rebase apart from an inherited one.
   */
  isManagingRebase(repo: IRepository): boolean;

  /**
   * Update the rebase plan with new actions
   */
  updateRebasePlan(repo: IRepository, plan: IRebaseAction[]): void;

  /**
   * Discard any cached rebase session for the repository.
   *
   * Used when an interactive-rebase editor is abandoned (cancelled or
   * closed) before the rebase is executed: the 'planning' session was
   * stored before git was touched, so it must be dropped or it would
   * poison later branch operations.
   */
  clearSession(repo: IRepository): void;

  /**
   * Execute the rebase with the current plan
   */
  executeRebase(repo: IRepository): Promise<IRebaseResult>;

  /**
   * Continue the rebase after resolving conflicts
   */
  continueRebase(repo: IRepository): Promise<IRebaseResult>;

  /**
   * Abort the rebase and restore original state. Reports whether git's
   * autostash reapply conflicted and was parked as a stash entry.
   */
  abortRebase(repo: IRepository): Promise<{ autostashParked: boolean }>;

  /**
   * Skip the current commit during rebase
   */
  skipCommit(repo: IRepository): Promise<IRebaseResult>;

  /**
   * Provide a new message for a reword action.
   * Should be called when the rebase is paused for reword.
   */
  provideRewordMessage(repo: IRepository, message: string): Promise<IRebaseResult>;

  /**
   * Amend the current commit during an edit pause.
   * Should be called when the rebase is paused for edit.
   */
  amendEditCommit(repo: IRepository, message?: string): Promise<IRebaseResult>;

  /**
   * Event fired when rebase session changes
   */
  onDidChangeRebaseSession: vscode.Event<IRebaseSession | undefined>;

  /**
   * Dispose of resources
   */
  dispose(): void;
}
