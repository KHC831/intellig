/**
 * Stash View interface.
 * Provides stash management UI with list display, context menu actions, and creation dialog.
 */

import * as vscode from 'vscode';
import { IStash, IStashOptions, IDiff, IRepository } from '../../git-core/interfaces/IGitService';

/**
 * Stash context menu action types.
 *
 * Includes `'branch'` (git stash branch) and `'rename'` (rewrite the stash
 * message via `git stash store` plumbing).
 */
export type StashContextAction = 'apply' | 'pop' | 'drop' | 'view' | 'branch' | 'rename';

/**
 * Result from stash creation dialog
 */
export interface IStashCreationResult {
  /** Whether a stash was created */
  created: boolean;
  /** The stash message used */
  message?: string;
  /** Options used for stash creation */
  options?: IStashOptions;
}

/**
 * Result from stash action
 */
export interface IStashActionResult {
  /** Whether the action was successful */
  success: boolean;
  /** The action that was performed */
  action?: StashContextAction;
  /** The stash that was acted upon */
  stash?: IStash;
  /** Error message if action failed */
  error?: string;
}

/**
 * Stash list item for display
 */
export interface IStashListItem {
  /** The stash data */
  stash: IStash;
  /** Whether this item is selected */
  selected: boolean;
}

/**
 * State for the Stash View.
 *
 * Deliberately carries no `error` field. Refresh failures are surfaced
 * through the `{ error? }` return value of {@link IStashView.refresh}
 * at every call site; a sideband on the view state would be a latent
 * mirror that callers could accidentally read after the canonical
 * channel had already been handled. See ADR-006 (`docs/adr/`) and
 * {@link IStashView.refresh} for the contract.
 */
export interface IStashViewState {
  /** List of stashes */
  stashes: IStashListItem[];
  /** Currently selected stash index */
  selectedIndex?: number;
  /** Whether the view is loading */
  loading: boolean;
}

/**
 * Stash View interface.
 * Provides stash management functionality including list display, context menu actions,
 * and stash creation dialog.
 *
 * - Create Git stash with optional message
 * - Offer options to include untracked files and keep index
 * - Display all stashes with messages and timestamps
 * - Apply stash contents to working directory
 * - Apply and remove stash (pop)
 * - Delete stash after confirmation
 * - Display stash contents as diff
 */
export interface IStashView {
  /**
   * Show the stash list view.
   *
   * @param repository - The repository to show stashes for
   * @returns Promise resolving when the view is shown
   */
  show(repository: IRepository): Promise<void>;

  /**
   * Hide the stash view.
   */
  hide(): void;

  /**
   * Refresh the stash list.
   *
   * Resolves to an object describing the outcome. On success, `error` is
   * undefined. On failure (service read throws, state update fails),
   * `error` contains a human-readable, sanitized message suitable for a
   * toast or OutputChannel line. Never rejects — every caller (sync or
   * async) handles the outcome by reading the returned object, which makes
   * failure propagation explicit at every call site.
   *
   * Per ADR-006 (`docs/adr/ADR-006-error-state-binding-by-view-type.md`),
   * this QuickPick view binds errors through the refresh return value
   * rather than a `_state.error` sideband. When the sideband was the
   * canonical channel, only `_showStashList` read it; downstream
   * callers (post-pop, post-drop, post-rename, post-create-branch refresh
   * paths) silently swallowed the error. The `{ error? }` shape fixes
   * that by making the outcome explicit at every call site.
   */
  refresh(): Promise<{ error?: string }>;

  /**
   * Get the current state of the stash view.
   */
  getState(): IStashViewState;

  /**
   * Select a stash in the list.
   *
   * @param index - The stash index to select
   */
  selectStash(index: number): void;

  /**
   * Show the stash creation dialog.
   *
   * @param repository - The repository to create stash in
   * @returns Promise resolving to the creation result
   */
  showCreateDialog(repository: IRepository): Promise<IStashCreationResult>;

  /**
   * Apply a stash to the working directory.
   *
   * @param index - The stash index to apply
   * @returns Promise resolving to the action result
   */
  applyStash(index: number): Promise<IStashActionResult>;

  /**
   * Pop a stash (apply and remove).
   *
   * @param index - The stash index to pop
   * @returns Promise resolving to the action result
   */
  popStash(index: number): Promise<IStashActionResult>;

  /**
   * Drop a stash after confirmation.
   *
   * @param index - The stash index to drop
   * @returns Promise resolving to the action result
   */
  dropStash(index: number): Promise<IStashActionResult>;

  /**
   * Create a branch from a stash. Prompts for the branch name, then wraps
   * {@link IGitService.stashBranch}.
   *
   * @param index - The stash index to branch from
   * @returns Promise resolving to the action result
   */
  branchFromStash(index: number): Promise<IStashActionResult>;

  /**
   * Rename a stash. Prompts for the new message, then wraps
   * {@link IGitService.stashRename}.
   *
   * @param index - The stash index to rename
   * @returns Promise resolving to the action result
   */
  renameStash(index: number): Promise<IStashActionResult>;

  /**
   * View a stash's contents as diff.
   *
   * @param index - The stash index to view
   * @returns Promise resolving to the stash diffs
   */
  viewStash(index: number): Promise<IDiff[]>;

  /**
   * Show context menu for a stash.
   *
   * @param index - The stash index to show menu for
   * @returns Promise resolving to the action result
   */
  showContextMenu(index: number): Promise<IStashActionResult>;

  /**
   * Event fired when the stash list changes
   */
  onDidChangeStashes: vscode.Event<IStash[]>;

  /**
   * Event fired when a stash is selected
   */
  onDidSelectStash: vscode.Event<IStash | undefined>;

  /**
   * Event fired when a stash action is requested
   */
  onDidRequestAction: vscode.Event<{ action: StashContextAction; stash: IStash }>;

  /**
   * Dispose of resources
   */
  dispose(): void;
}
