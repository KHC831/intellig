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
 * Result of a rebase operation
 */
export interface IRebaseResult {
  success: boolean;
  status: RebaseStatus;
  conflictedFiles?: string[];
}

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
