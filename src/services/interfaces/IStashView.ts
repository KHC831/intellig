/**
 * Stash View interface.
 * Provides stash management UI with list display, context menu actions, and creation dialog.
 */

import * as vscode from 'vscode';
import { IStash, IStashOptions, IDiff, IRepository } from './IGitService';

/**
 * Stash context menu action types
 */
export type StashContextAction = 'apply' | 'pop' | 'drop' | 'view';

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
 * State for the Stash View
 */
export interface IStashViewState {
  /** List of stashes */
  stashes: IStashListItem[];
  /** Currently selected stash index */
  selectedIndex?: number;
  /** Whether the view is loading */
  loading: boolean;
  /** Error message if any */
  error?: string;
}

/**
 * Stash View interface.
 * Provides stash management functionality including list display, context menu actions,
 * and stash creation dialog.
 *
 * - 7.1: Create Git stash with optional message
 * - 7.2: Offer options to include untracked files and keep index
 * - 7.3: Display all stashes with messages and timestamps
 * - 7.4: Apply stash contents to working directory
 * - 7.5: Apply and remove stash (pop)
 * - 7.6: Delete stash after confirmation
 * - 7.7: Display stash contents as diff
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
   */
  refresh(): Promise<void>;

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
