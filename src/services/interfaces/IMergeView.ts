import * as vscode from 'vscode';

/**
 * Conflict resolution type
 */
export type ConflictResolution = 'current' | 'incoming' | 'both' | 'manual';

/**
 * Conflict region in a file
 * Represents a single conflict with its ranges in base, current, and incoming versions
 */
export interface IConflictRegion {
  /** Unique identifier for this conflict */
  id: number;
  /** Range in the base version */
  baseRange: vscode.Range;
  /** Range in the current (local) version */
  currentRange: vscode.Range;
  /** Range in the incoming (remote) version */
  incomingRange: vscode.Range;
  /** Whether this conflict has been resolved */
  resolved: boolean;
  /** How the conflict was resolved */
  resolution?: ConflictResolution;
  /** The base content */
  baseContent: string;
  /** The current (local) content */
  currentContent: string;
  /** The incoming (remote) content */
  incomingContent: string;
}

/**
 * Merge state for a file
 * Contains all information about the merge state of a conflicted file
 */
export interface IMergeState {
  /** The file path */
  file: string;
  /** The base version content */
  base: string;
  /** The current (local) version content */
  current: string;
  /** The incoming (remote) version content */
  incoming: string;
  /** All conflict regions in the file */
  conflicts: IConflictRegion[];
  /** Set of resolved conflict IDs */
  resolvedConflicts: Set<number>;
}

/**
 * Merge View interface
 * Provides three-way merge conflict resolution functionality
 */
export interface IMergeView {
  /**
   * Show the merge view for a conflicted file
   * @param file - The path to the conflicted file
   */
  show(file: string): Promise<void>;

  /**
   * Hide the merge view
   */
  hide(): void;

  /**
   * Accept the current (local) version for a conflict
   * @param conflictId - The conflict ID, or undefined to accept for current conflict
   */
  acceptCurrent(conflictId?: number): void;

  /**
   * Accept the incoming (remote) version for a conflict
   * @param conflictId - The conflict ID, or undefined to accept for current conflict
   */
  acceptIncoming(conflictId?: number): void;

  /**
   * Accept both versions (current then incoming) for a conflict
   * @param conflictId - The conflict ID, or undefined to accept for current conflict
   */
  acceptBoth(conflictId?: number): void;

  /**
   * Accept current version for all conflicts in the file
   */
  acceptAllCurrent(): void;

  /**
   * Accept incoming version for all conflicts in the file
   */
  acceptAllIncoming(): void;

  /**
   * Navigate to the next conflict
   */
  nextConflict(): void;

  /**
   * Navigate to the previous conflict
   */
  previousConflict(): void;

  /**
   * Mark the file as resolved
   */
  markResolved(): Promise<void>;

  /**
   * Get the current merge state
   */
  getMergeState(): IMergeState | undefined;

  /**
   * Check if all conflicts are resolved
   */
  allConflictsResolved(): boolean;

  /**
   * Event fired when a file is resolved
   */
  onDidResolve: vscode.Event<string>;

  /**
   * Dispose of resources
   */
  dispose(): void;
}
