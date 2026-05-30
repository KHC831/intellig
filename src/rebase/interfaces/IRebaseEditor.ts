/**
 * Rebase Editor interface.
 * Provides a webview panel for interactive rebase operations.
 */

import { IRepository } from '../../git-core/interfaces/IGitService';

/**
 * Options for opening the rebase editor
 */
export interface IRebaseEditorOptions {
  /** The commit/branch to rebase onto */
  onto: string;
}

/**
 * Result from the rebase editor
 */
export interface IRebaseEditorResult {
  /** Whether the rebase was executed */
  executed: boolean;
  /** Whether the rebase completed successfully */
  success?: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Rebase Editor interface.
 * Provides methods for showing and controlling the interactive rebase editor.
 *
 * - 6.1: Display rebase editor showing commits to be rebased
 * - 6.2: Allow reordering commits via drag-and-drop
 * - 6.3: Support pick, reword, edit, squash, fixup, and drop operations
 */
export interface IRebaseEditor {
  /**
   * Show the rebase editor.
   *
   * @param repository - The repository to rebase in
   * @param options - Editor options including the target to rebase onto
   * @returns Promise resolving to the editor result
   */
  show(repository: IRepository, options: IRebaseEditorOptions): Promise<IRebaseEditorResult>;

  /**
   * Hide the rebase editor.
   */
  hide(): void;

  /**
   * Dispose of the editor resources.
   */
  dispose(): void;
}
