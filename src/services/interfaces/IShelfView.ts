/**
 * Shelf View interface.
 * Provides shelf management UI with list display, context menu actions, and shelve dialog.
 */

import * as vscode from 'vscode';
import { IDiff, IRepository } from './IGitService';
import { IShelfItem, IShelveSelection, IUnshelveOptions } from './IShelfService';

/**
 * Shelf context menu action types
 */
export type ShelfContextAction = 'unshelve' | 'view' | 'delete';

/**
 * Result from shelve dialog
 */
export interface IShelveDialogResult {
  /** Whether changes were shelved */
  shelved: boolean;
  /** The name given to the shelf item */
  name?: string;
  /** The selection of changes that were shelved */
  selection?: IShelveSelection;
  /** The created shelf item */
  shelfItem?: IShelfItem;
}

/**
 * Result from shelf action
 */
export interface IShelfActionResult {
  /** Whether the action was successful */
  success: boolean;
  /** The action that was performed */
  action?: ShelfContextAction;
  /** The shelf item that was acted upon */
  shelfItem?: IShelfItem;
  /** Error message if action failed */
  error?: string;
  /** Conflicted files if unshelve had conflicts */
  conflicts?: string[];
}

/**
 * Shelf list item for display
 */
export interface IShelfListItem {
  /** The shelf item data */
  shelfItem: IShelfItem;
  /** Whether this item is selected */
  selected: boolean;
}

/**
 * State for the Shelf View
 */
export interface IShelfViewState {
  /** List of shelf items */
  shelfItems: IShelfListItem[];
  /** Currently selected shelf item ID */
  selectedId?: string;
  /** Whether the view is loading */
  loading: boolean;
  /** Error message if any */
  error?: string;
}

/**
 * Shelf View interface.
 * Provides shelf management functionality including list display, context menu actions,
 * and shelve dialog.
 *
 * - 8.1: Save selected changes to IDE-managed shelf storage
 * - 8.2: Allow selecting specific files, changelists, or hunks to shelve
 * - 8.3: Display all shelved changesets with names and timestamps
 * - 8.4: Restore shelved changes to working directory
 * - 8.5: Offer options to remove from shelf or keep a copy
 * - 8.6: Display shelved content as diff
 */
export interface IShelfView {
  /**
   * Show the shelf list view.
   *
   * @param repository - The repository to show shelf items for
   * @returns Promise resolving when the view is shown
   */
  show(repository: IRepository): Promise<void>;

  /**
   * Hide the shelf view.
   */
  hide(): void;

  /**
   * Refresh the shelf list.
   */
  refresh(): Promise<void>;

  /**
   * Get the current state of the shelf view.
   */
  getState(): IShelfViewState;

  /**
   * Select a shelf item in the list.
   *
   * @param id - The shelf item ID to select
   */
  selectShelfItem(id: string): void;

  /**
   * Show the shelve dialog for creating a new shelf item.
   *
   * @param repository - The repository to shelve changes from
   * @returns Promise resolving to the dialog result
   */
  showShelveDialog(repository: IRepository): Promise<IShelveDialogResult>;

  /**
   * Unshelve changes back to working directory.
   *
   * @param id - The shelf item ID to unshelve
   * @param options - Unshelve options
   * @returns Promise resolving to the action result
   */
  unshelve(id: string, options?: IUnshelveOptions): Promise<IShelfActionResult>;

  /**
   * View a shelf item's contents as diff.
   *
   * @param id - The shelf item ID to view
   * @returns Promise resolving to the shelf diffs
   */
  viewShelfItem(id: string): Promise<IDiff[]>;

  /**
   * Delete a shelf item after confirmation.
   *
   * @param id - The shelf item ID to delete
   * @returns Promise resolving to the action result
   */
  deleteShelfItem(id: string): Promise<IShelfActionResult>;

  /**
   * Show context menu for a shelf item.
   *
   * @param id - The shelf item ID to show menu for
   * @returns Promise resolving to the action result
   */
  showContextMenu(id: string): Promise<IShelfActionResult>;

  /**
   * Event fired when the shelf list changes
   */
  onDidChangeShelfItems: vscode.Event<IShelfItem[]>;

  /**
   * Event fired when a shelf item is selected
   */
  onDidSelectShelfItem: vscode.Event<IShelfItem | undefined>;

  /**
   * Event fired when a shelf action is requested
   */
  onDidRequestAction: vscode.Event<{ action: ShelfContextAction; shelfItem: IShelfItem }>;

  /**
   * Dispose of resources
   */
  dispose(): void;
}
