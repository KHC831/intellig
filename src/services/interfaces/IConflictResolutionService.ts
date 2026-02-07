import * as vscode from 'vscode';
import { IRepository } from './IGitService';

/**
 * Conflicted file information
 */
export interface IConflictedFile {
  /** The file path relative to repository root */
  path: string;
  /** Whether the file has been marked as resolved */
  resolved: boolean;
}

/**
 * Conflict resolution result
 */
export interface IConflictResolutionResult {
  /** Whether the operation was successful */
  success: boolean;
  /** Error message if operation failed */
  error?: string;
}

/**
 * Merge/Rebase completion result
 */
export interface IOperationCompletionResult {
  /** Whether the operation completed successfully */
  success: boolean;
  /** Error message if operation failed */
  error?: string;
  /** Any remaining conflicted files */
  remainingConflicts?: string[];
}

/**
 * Conflict Resolution Service interface
 * Provides conflict detection, resolution, and merge/rebase completion functionality
 *
 * Requirements: 10.1, 10.5, 10.6, 10.8
 */
export interface IConflictResolutionService {
  /**
   * Get all conflicted files in the repository
   * Requirement 10.1: Display conflicted files in Local Changes View
   *
   * @param repo - The repository
   * @returns Array of conflicted files
   */
  getConflictedFiles(repo: IRepository): Promise<IConflictedFile[]>;

  /**
   * Check if the repository has any unresolved conflicts
   *
   * @param repo - The repository
   * @returns True if there are unresolved conflicts
   */
  hasUnresolvedConflicts(repo: IRepository): Promise<boolean>;

  /**
   * Mark a file as resolved
   * Requirement 10.5: Enable marking the file as resolved
   *
   * @param repo - The repository
   * @param filePath - The file path to mark as resolved
   * @returns Resolution result
   */
  markResolved(repo: IRepository, filePath: string): Promise<IConflictResolutionResult>;

  /**
   * Mark multiple files as resolved
   *
   * @param repo - The repository
   * @param filePaths - Array of file paths to mark as resolved
   * @returns Resolution result
   */
  markMultipleResolved(repo: IRepository, filePaths: string[]): Promise<IConflictResolutionResult>;

  /**
   * Accept current (ours) version for a file and mark as resolved
   * Requirement 10.8: Accept All Current
   *
   * @param repo - The repository
   * @param filePath - The file path
   * @returns Resolution result
   */
  acceptCurrent(repo: IRepository, filePath: string): Promise<IConflictResolutionResult>;

  /**
   * Accept incoming (theirs) version for a file and mark as resolved
   * Requirement 10.8: Accept All Incoming
   *
   * @param repo - The repository
   * @param filePath - The file path
   * @returns Resolution result
   */
  acceptIncoming(repo: IRepository, filePath: string): Promise<IConflictResolutionResult>;

  /**
   * Accept current version for all conflicted files
   * Requirement 10.8: Accept All Current
   *
   * @param repo - The repository
   * @returns Resolution result
   */
  acceptAllCurrent(repo: IRepository): Promise<IConflictResolutionResult>;

  /**
   * Accept incoming version for all conflicted files
   * Requirement 10.8: Accept All Incoming
   *
   * @param repo - The repository
   * @returns Resolution result
   */
  acceptAllIncoming(repo: IRepository): Promise<IConflictResolutionResult>;

  /**
   * Check if merge/rebase can be completed (all conflicts resolved)
   * Requirement 10.6: Enable completing merge/rebase when resolved
   *
   * @param repo - The repository
   * @returns True if operation can be completed
   */
  canCompleteOperation(repo: IRepository): Promise<boolean>;

  /**
   * Complete the current merge operation
   * Requirement 10.6: Enable completing merge when resolved
   *
   * @param repo - The repository
   * @returns Completion result
   */
  completeMerge(repo: IRepository): Promise<IOperationCompletionResult>;

  /**
   * Complete the current rebase operation
   * Requirement 10.6: Enable completing rebase when resolved
   *
   * @param repo - The repository
   * @returns Completion result
   */
  completeRebase(repo: IRepository): Promise<IOperationCompletionResult>;

  /**
   * Abort the current merge operation
   *
   * @param repo - The repository
   * @returns Completion result
   */
  abortMerge(repo: IRepository): Promise<IOperationCompletionResult>;

  /**
   * Abort the current rebase operation
   *
   * @param repo - The repository
   * @returns Completion result
   */
  abortRebase(repo: IRepository): Promise<IOperationCompletionResult>;

  /**
   * Get the current repository state (merging, rebasing, etc.)
   *
   * @param repo - The repository
   * @returns The repository state
   */
  getRepositoryState(
    repo: IRepository
  ): 'idle' | 'merging' | 'rebasing' | 'cherry-picking' | 'reverting';

  /**
   * Event fired when conflicts change
   */
  onDidChangeConflicts: vscode.Event<{ repo: IRepository; conflicts: IConflictedFile[] }>;

  /**
   * Dispose of resources
   */
  dispose(): void;
}
