import * as vscode from 'vscode';
import {
  IConflictResolutionService,
  IConflictedFile,
  IConflictResolutionResult,
  IOperationCompletionResult,
} from './interfaces/IConflictResolutionService';
import { IGitService, IRepository, RepositoryState } from './interfaces/IGitService';
import { GitCli, IGitCommandOptions, IGitCommandResult } from '../utils/gitCli';

/**
 * Interface for accessing GitCli from GitService
 */
interface IGitServiceWithCli extends IGitService {
  gitCli: GitCli;
}

/**
 * Conflict Resolution Service implementation
 * Provides conflict detection, resolution, and merge/rebase completion functionality
 *
 * Requirements: 10.1, 10.5, 10.6, 10.8
 */
export class ConflictResolutionService implements IConflictResolutionService {
  private _disposables: vscode.Disposable[] = [];
  private _onDidChangeConflicts: vscode.EventEmitter<{
    repo: IRepository;
    conflicts: IConflictedFile[];
  }>;

  /**
   * Event fired when conflicts change
   */
  readonly onDidChangeConflicts: vscode.Event<{ repo: IRepository; conflicts: IConflictedFile[] }>;

  constructor(private readonly _gitService: IGitService) {
    this._onDidChangeConflicts = new vscode.EventEmitter();
    this.onDidChangeConflicts = this._onDidChangeConflicts.event;

    // Listen for repository changes to detect conflict changes
    this._disposables.push(
      this._gitService.onDidChangeRepository(async (repo) => {
        const conflicts = await this.getConflictedFiles(repo);
        this._onDidChangeConflicts.fire({ repo, conflicts });
      })
    );
  }

  /**
   * Get all conflicted files in the repository
   * Requirement 10.1: Display conflicted files in Local Changes View
   *
   * @param repo - The repository
   * @returns Array of conflicted files
   */
  async getConflictedFiles(repo: IRepository): Promise<IConflictedFile[]> {
    const status = await this._gitService.getStatus(repo);

    // Filter for conflicted files (status code 'U' in either index or work tree)
    const conflictedFiles = status
      .filter((file) => file.indexStatus === 'U' || file.workTreeStatus === 'U')
      .map((file) => ({
        path: file.path,
        resolved: false, // Files with 'U' status are not yet resolved
      }));

    return conflictedFiles;
  }

  /**
   * Check if the repository has any unresolved conflicts
   *
   * @param repo - The repository
   * @returns True if there are unresolved conflicts
   */
  async hasUnresolvedConflicts(repo: IRepository): Promise<boolean> {
    const conflicts = await this.getConflictedFiles(repo);
    return conflicts.length > 0;
  }

  /**
   * Mark a file as resolved by staging it
   * Requirement 10.5: Enable marking the file as resolved
   *
   * @param repo - The repository
   * @param filePath - The file path to mark as resolved
   * @returns Resolution result
   */
  async markResolved(repo: IRepository, filePath: string): Promise<IConflictResolutionResult> {
    try {
      // Stage the file to mark it as resolved
      await this._gitService.stage(repo, [filePath]);

      // Fire change event
      const conflicts = await this.getConflictedFiles(repo);
      this._onDidChangeConflicts.fire({ repo, conflicts });

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Failed to mark file as resolved: ${errorMessage}` };
    }
  }

  /**
   * Mark multiple files as resolved
   *
   * @param repo - The repository
   * @param filePaths - Array of file paths to mark as resolved
   * @returns Resolution result
   */
  async markMultipleResolved(
    repo: IRepository,
    filePaths: string[]
  ): Promise<IConflictResolutionResult> {
    try {
      // Stage all files to mark them as resolved
      await this._gitService.stage(repo, filePaths);

      // Fire change event
      const conflicts = await this.getConflictedFiles(repo);
      this._onDidChangeConflicts.fire({ repo, conflicts });

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Failed to mark files as resolved: ${errorMessage}` };
    }
  }

  /**
   * Accept current (ours) version for a file and mark as resolved
   * Requirement 10.8: Accept All Current
   *
   * @param repo - The repository
   * @param filePath - The file path
   * @returns Resolution result
   */
  async acceptCurrent(repo: IRepository, filePath: string): Promise<IConflictResolutionResult> {
    try {
      // Use git checkout --ours to accept current version
      const gitCli = (this._gitService as IGitServiceWithCli).gitCli;
      const options: IGitCommandOptions = {
        cwd: repo.rootUri.fsPath,
        throwOnError: true,
      };
      await gitCli.exec(['checkout', '--ours', '--', filePath], options);

      // Stage the file to mark as resolved
      await this._gitService.stage(repo, [filePath]);

      // Fire change event
      const conflicts = await this.getConflictedFiles(repo);
      this._onDidChangeConflicts.fire({ repo, conflicts });

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Failed to accept current version: ${errorMessage}` };
    }
  }

  /**
   * Accept incoming (theirs) version for a file and mark as resolved
   * Requirement 10.8: Accept All Incoming
   *
   * @param repo - The repository
   * @param filePath - The file path
   * @returns Resolution result
   */
  async acceptIncoming(repo: IRepository, filePath: string): Promise<IConflictResolutionResult> {
    try {
      // Use git checkout --theirs to accept incoming version
      const gitCli = (this._gitService as IGitServiceWithCli).gitCli;
      const options: IGitCommandOptions = {
        cwd: repo.rootUri.fsPath,
        throwOnError: true,
      };
      await gitCli.exec(['checkout', '--theirs', '--', filePath], options);

      // Stage the file to mark as resolved
      await this._gitService.stage(repo, [filePath]);

      // Fire change event
      const conflicts = await this.getConflictedFiles(repo);
      this._onDidChangeConflicts.fire({ repo, conflicts });

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Failed to accept incoming version: ${errorMessage}` };
    }
  }

  /**
   * Accept current version for all conflicted files
   * Requirement 10.8: Accept All Current
   *
   * @param repo - The repository
   * @returns Resolution result
   */
  async acceptAllCurrent(repo: IRepository): Promise<IConflictResolutionResult> {
    try {
      const conflicts = await this.getConflictedFiles(repo);

      if (conflicts.length === 0) {
        return { success: true };
      }

      const gitCli = (this._gitService as IGitServiceWithCli).gitCli;
      const options: IGitCommandOptions = {
        cwd: repo.rootUri.fsPath,
        throwOnError: true,
      };

      // Accept current version for all conflicted files
      for (const conflict of conflicts) {
        await gitCli.exec(['checkout', '--ours', '--', conflict.path], options);
      }

      // Stage all files to mark as resolved
      const filePaths = conflicts.map((c) => c.path);
      await this._gitService.stage(repo, filePaths);

      // Fire change event
      const remainingConflicts = await this.getConflictedFiles(repo);
      this._onDidChangeConflicts.fire({ repo, conflicts: remainingConflicts });

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Failed to accept all current: ${errorMessage}` };
    }
  }

  /**
   * Accept incoming version for all conflicted files
   * Requirement 10.8: Accept All Incoming
   *
   * @param repo - The repository
   * @returns Resolution result
   */
  async acceptAllIncoming(repo: IRepository): Promise<IConflictResolutionResult> {
    try {
      const conflicts = await this.getConflictedFiles(repo);

      if (conflicts.length === 0) {
        return { success: true };
      }

      const gitCli = (this._gitService as IGitServiceWithCli).gitCli;
      const options: IGitCommandOptions = {
        cwd: repo.rootUri.fsPath,
        throwOnError: true,
      };

      // Accept incoming version for all conflicted files
      for (const conflict of conflicts) {
        await gitCli.exec(['checkout', '--theirs', '--', conflict.path], options);
      }

      // Stage all files to mark as resolved
      const filePaths = conflicts.map((c) => c.path);
      await this._gitService.stage(repo, filePaths);

      // Fire change event
      const remainingConflicts = await this.getConflictedFiles(repo);
      this._onDidChangeConflicts.fire({ repo, conflicts: remainingConflicts });

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Failed to accept all incoming: ${errorMessage}` };
    }
  }

  /**
   * Check if merge/rebase can be completed (all conflicts resolved)
   * Requirement 10.6: Enable completing merge/rebase when resolved
   *
   * @param repo - The repository
   * @returns True if operation can be completed
   */
  async canCompleteOperation(repo: IRepository): Promise<boolean> {
    const state = this.getRepositoryState(repo);

    // Must be in a merge/rebase state
    if (state === 'idle') {
      return false;
    }

    // Check for unresolved conflicts
    const hasConflicts = await this.hasUnresolvedConflicts(repo);
    return !hasConflicts;
  }

  /**
   * Complete the current merge operation
   * Requirement 10.6: Enable completing merge when resolved
   *
   * @param repo - The repository
   * @returns Completion result
   */
  async completeMerge(repo: IRepository): Promise<IOperationCompletionResult> {
    try {
      // Check if we can complete
      const canComplete = await this.canCompleteOperation(repo);
      if (!canComplete) {
        const conflicts = await this.getConflictedFiles(repo);
        if (conflicts.length > 0) {
          return {
            success: false,
            error: 'Cannot complete merge: unresolved conflicts remain',
            remainingConflicts: conflicts.map((c) => c.path),
          };
        }
      }

      const gitCli = (this._gitService as IGitServiceWithCli).gitCli;
      const options: IGitCommandOptions = {
        cwd: repo.rootUri.fsPath,
      };

      // Complete the merge with a commit
      const result: IGitCommandResult = await gitCli.exec(['commit', '--no-edit'], options);

      if (result.exitCode !== 0) {
        return {
          success: false,
          error: `Failed to complete merge: ${result.stderr || result.stdout}`,
        };
      }

      // Fire change event
      const conflicts = await this.getConflictedFiles(repo);
      this._onDidChangeConflicts.fire({ repo, conflicts });

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Failed to complete merge: ${errorMessage}` };
    }
  }

  /**
   * Complete the current rebase operation
   * Requirement 10.6: Enable completing rebase when resolved
   *
   * @param repo - The repository
   * @returns Completion result
   */
  async completeRebase(repo: IRepository): Promise<IOperationCompletionResult> {
    try {
      // Check if we can complete
      const canComplete = await this.canCompleteOperation(repo);
      if (!canComplete) {
        const conflicts = await this.getConflictedFiles(repo);
        if (conflicts.length > 0) {
          return {
            success: false,
            error: 'Cannot complete rebase: unresolved conflicts remain',
            remainingConflicts: conflicts.map((c) => c.path),
          };
        }
      }

      const gitCli = (this._gitService as IGitServiceWithCli).gitCli;
      const options: IGitCommandOptions = {
        cwd: repo.rootUri.fsPath,
      };

      // Continue the rebase
      const result: IGitCommandResult = await gitCli.exec(['rebase', '--continue'], options);

      if (result.exitCode !== 0) {
        // Check if there are more conflicts
        const conflicts = await this.getConflictedFiles(repo);
        if (conflicts.length > 0) {
          return {
            success: false,
            error: 'Rebase paused: more conflicts to resolve',
            remainingConflicts: conflicts.map((c) => c.path),
          };
        }

        return {
          success: false,
          error: `Failed to continue rebase: ${result.stderr || result.stdout}`,
        };
      }

      // Fire change event
      const conflicts = await this.getConflictedFiles(repo);
      this._onDidChangeConflicts.fire({ repo, conflicts });

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Failed to complete rebase: ${errorMessage}` };
    }
  }

  /**
   * Abort the current merge operation
   *
   * @param repo - The repository
   * @returns Completion result
   */
  async abortMerge(repo: IRepository): Promise<IOperationCompletionResult> {
    try {
      const gitCli = (this._gitService as IGitServiceWithCli).gitCli;
      const options: IGitCommandOptions = {
        cwd: repo.rootUri.fsPath,
      };

      const result: IGitCommandResult = await gitCli.exec(['merge', '--abort'], options);

      if (result.exitCode !== 0) {
        return {
          success: false,
          error: `Failed to abort merge: ${result.stderr || result.stdout}`,
        };
      }

      // Fire change event
      const conflicts = await this.getConflictedFiles(repo);
      this._onDidChangeConflicts.fire({ repo, conflicts });

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Failed to abort merge: ${errorMessage}` };
    }
  }

  /**
   * Abort the current rebase operation
   *
   * @param repo - The repository
   * @returns Completion result
   */
  async abortRebase(repo: IRepository): Promise<IOperationCompletionResult> {
    try {
      const gitCli = (this._gitService as IGitServiceWithCli).gitCli;
      const options: IGitCommandOptions = {
        cwd: repo.rootUri.fsPath,
      };

      const result: IGitCommandResult = await gitCli.exec(['rebase', '--abort'], options);

      if (result.exitCode !== 0) {
        return {
          success: false,
          error: `Failed to abort rebase: ${result.stderr || result.stdout}`,
        };
      }

      // Fire change event
      const conflicts = await this.getConflictedFiles(repo);
      this._onDidChangeConflicts.fire({ repo, conflicts });

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Failed to abort rebase: ${errorMessage}` };
    }
  }

  /**
   * Get the current repository state (merging, rebasing, etc.)
   *
   * @param repo - The repository
   * @returns The repository state
   */
  getRepositoryState(
    repo: IRepository
  ): 'idle' | 'merging' | 'rebasing' | 'cherry-picking' | 'reverting' {
    // The repository state is already tracked in the IRepository interface
    return repo.state as RepositoryState;
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this._onDidChangeConflicts.dispose();

    for (const disposable of this._disposables) {
      disposable.dispose();
    }
    this._disposables = [];
  }
}

/**
 * Create a new ConflictResolutionService instance
 *
 * @param gitService - The Git service
 * @returns A new ConflictResolutionService instance
 */
export function createConflictResolutionService(
  gitService: IGitService
): ConflictResolutionService {
  return new ConflictResolutionService(gitService);
}
