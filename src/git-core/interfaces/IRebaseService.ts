import * as vscode from 'vscode';
import { IRepository } from './IGitService';

/**
 * Rebase action types
 */
export type RebaseAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';

/**
 * Rebase session status
 */
export type RebaseStatus = 'planning' | 'in-progress' | 'paused' | 'conflict' | 'completed';

/**
 * Commit in a rebase session
 */
export interface IRebaseCommit {
  hash: string;
  message: string;
  action: RebaseAction;
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
 * Rebase session state
 */
export interface IRebaseSession {
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
   * Abort the rebase and restore original state
   */
  abortRebase(repo: IRepository): Promise<void>;

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
   * Provide a combined message for a squash action.
   *
   * Symmetric companion to {@link provideRewordMessage}. The git
   * mechanics are identical (the rebase pauses, asks for the new
   * message, and resumes on `--continue`); the separate name carries
   * intent at the call site for the squash N-commit flow. Should be
   * called when the rebase is paused after a `squash` step has merged
   * commits and is awaiting the combined message.
   */
  provideSquashMessage(repo: IRepository, message: string): Promise<IRebaseResult>;

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
