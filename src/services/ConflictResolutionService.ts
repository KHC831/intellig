import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  IConflictResolutionService,
  IConflictedFile,
  IConflictResolutionResult,
  IOperationCompletionResult,
} from './interfaces/IConflictResolutionService';
import { IGitService, IRepository, RepositoryState } from './interfaces/IGitService';
import { GitCli, IGitCommandOptions, IGitCommandResult } from '../utils/gitCli';
import { ResolveConflictsDialog, IConflictOpContext } from './ResolveConflictsDialog';
import { IMergeView } from './interfaces/IMergeView';
import { getOutputChannel } from '../utils/outputChannel';
import { safeFireAndForget } from '../utils/safeFireAndForget';

/**
 * Context key flipped `true` whenever a conflict-producing state file exists
 * in `.git/` AND there are unmerged files. Consumed by `when` clauses for the
 * status-bar item and VCS menu entries.
 */
const CONTEXT_KEY_CONFLICTS_ACTIVE = 'intellig.conflicts.active';

/**
 * Debounce interval for the `.git/*_HEAD` state-file watcher. Matches the
 * existing GitService `setupRepositoryWatcher` debounce (300ms) so we don't
 * stack concurrent work.
 */
const STATE_FILE_DEBOUNCE_MS = 300;

/**
 * Config key gating the auto-open behavior. Defaults to `true` (locked per
 * REVIEW.md §7).
 */
const CONFIG_AUTO_OPEN_KEY = 'autoOpenResolveConflictsDialog';

/**
 * Interface for accessing GitCli from GitService
 */
interface IGitServiceWithCli extends IGitService {
  gitCli: GitCli;
}

/**
 * Conflict Resolution Service implementation
 * Provides conflict detection, resolution, and merge/rebase completion functionality
 */
export class ConflictResolutionService implements IConflictResolutionService {
  private _disposables: vscode.Disposable[] = [];
  private _onDidChangeConflicts: vscode.EventEmitter<{
    repo: IRepository;
    conflicts: IConflictedFile[];
  }>;

  /**
   * Per-repository open dialog registry. Keyed by repo rootUri.fsPath so we
   * only have one Resolve Conflicts dialog open per repository at a time
   * (reveal + update the existing one instead of stacking dialogs).
   */
  private readonly _activeDialogs: Map<string, ResolveConflictsDialog> = new Map();

  /**
   * Per-repository debounce timers for the state-file watcher.
   */
  private readonly _watcherDebounces: Map<string, NodeJS.Timeout> = new Map();

  /**
   * Per-repository latest context-key state. Tracks the last value we
   * published for each repo so we can avoid redundant `setContext` calls
   * AND correctly report the aggregate (any-repo-has-conflicts) state in
   * multi-root workspaces.
   *
   * LOW-3: the previous single-boolean impl reflected only the last repo
   * touched, so two repos (one conflicted, one clean) would flip the key
   * whenever either fired — yielding correct aggregate only incidentally.
   * Map keyed by `repo.rootUri.fsPath` → last known active bool; aggregate
   * is `true` iff any value in the map is `true`.
   */
  private readonly _conflictsActiveByRepo: Map<string, boolean> = new Map();

  /**
   * Memoized aggregate of `_conflictsActiveByRepo.values()`. Updated lazily
   * from `_recomputeAggregateActive()`; exposed via `getConflictsActive()`
   * (which stays pure-read for tests).
   */
  private _conflictsActiveAggregate = false;

  /**
   * Optional dependencies for opening the dialog. Wired via
   * `setResolveConflictsDependencies` so existing callers that just use
   * acceptCurrent/acceptIncoming can construct the service without them.
   */
  private _context: vscode.ExtensionContext | undefined;
  private _mergeView: IMergeView | undefined;

  /**
   * Event fired when conflicts change
   */
  readonly onDidChangeConflicts: vscode.Event<{ repo: IRepository; conflicts: IConflictedFile[] }>;

  constructor(private readonly _gitService: IGitService) {
    this._onDidChangeConflicts = new vscode.EventEmitter();
    this.onDidChangeConflicts = this._onDidChangeConflicts.event;

    // Listen for repository changes to detect conflict changes. Also
    // piggybacks the state-file watcher check — setupRepositoryWatcher in
    // GitService fires this event on any `.git/**` change (300ms debounced),
    // which means MERGE_HEAD / REBASE_HEAD / CHERRY_PICK_HEAD / REVERT_HEAD
    // appearance and removal both flow through here without extra plumbing.
    this._disposables.push(
      this._gitService.onDidChangeRepository(async (repo) => {
        const conflicts = await this.getConflictedFiles(repo);
        this._onDidChangeConflicts.fire({ repo, conflicts });
        this._scheduleStateFileCheck(repo);
      })
    );
  }

  /**
   * Wire late-bound dependencies needed to open the Resolve Conflicts dialog.
   * Called once during extension activation after MergeView is constructed.
   */
  setResolveConflictsDependencies(context: vscode.ExtensionContext, mergeView: IMergeView): void {
    this._context = context;
    this._mergeView = mergeView;
  }

  /**
   * Open (or reveal + update) the Resolve Conflicts dialog for a repository.
   * If the `intellig.autoOpenResolveConflictsDialog` config is `false` we skip
   * the dialog entirely; the status-bar prompt (driven by the state-file
   * watcher and the context key) remains the only surface.
   *
   * One dialog per repo at any given time.
   */
  async openResolveConflictsDialog(
    repo: IRepository,
    conflicts: IConflictedFile[],
    opContext: IConflictOpContext
  ): Promise<void> {
    const autoOpen = vscode.workspace
      .getConfiguration('intellig')
      .get<boolean>(CONFIG_AUTO_OPEN_KEY, true);

    if (!autoOpen) {
      // Feature flag off: surface context key only so the status-bar prompt
      // remains but don't steal focus.
      await this._setConflictsActive(repo, true);
      return;
    }

    if (!this._context || !this._mergeView) {
      // Dependencies not yet wired — fall back to context-key only.
      await this._setConflictsActive(repo, true);
      return;
    }

    const key = repo.rootUri.fsPath;
    const existing = this._activeDialogs.get(key);
    if (existing) {
      existing.updateConflicts(conflicts);
      existing.reveal();
      return;
    }

    const dialog = new ResolveConflictsDialog(
      this._context,
      repo,
      conflicts,
      opContext,
      this,
      this._mergeView,
      this._gitService
    );
    this._activeDialogs.set(key, dialog);

    dialog.onDidClose((reason) => {
      this._activeDialogs.delete(key);
      // Completion or abort implies the op is finished → flip context key
      // for this repo. Other repos' active state is preserved.
      // Bucket B: setContext failures are cosmetic (we fall
      // through to the next state transition), but we log them instead
      // of silently dropping the rejection so a broken setContext proxy
      // is diagnosable from the extension-host console.
      if (reason === 'completed' || reason === 'aborted') {
        safeFireAndForget(
          this._setConflictsActive(repo, false),
          'ConflictResolutionService.openResolveConflictsDialog: clear active on dialog close',
          { outputChannel: getOutputChannel() }
        );
      }
    });

    // Seed the context key so the VCS menu item & status-bar prompt reflect
    // the live state as soon as the dialog opens.
    await this._setConflictsActive(repo, true);
  }

  /**
   * Poll `.git/MERGE_HEAD`, `.git/REBASE_HEAD`, `.git/CHERRY_PICK_HEAD`, and
   * `.git/REVERT_HEAD` for the repository, combine with the unmerged-files
   * check, and publish the context key `intellig.conflicts.active`.
   *
   * Debounced at {@link STATE_FILE_DEBOUNCE_MS} so a flurry of `.git/**`
   * changes produces a single publish.
   */
  private _scheduleStateFileCheck(repo: IRepository): void {
    const key = repo.rootUri.fsPath;
    const existing = this._watcherDebounces.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this._watcherDebounces.delete(key);
      // Bucket B: state-file check errors are transient (race with
      // concurrent `.git/**` mutations); log-and-suppress is the right
      // answer here because the next watcher event will retry the check.
      // `_runStateFileCheck` returns `Promise<boolean>` so we drop the
      // value before handing to safeFireAndForget.
      safeFireAndForget(
        this._runStateFileCheck(repo).then(() => undefined),
        'ConflictResolutionService._scheduleStateFileCheck: debounced state-file check',
        { outputChannel: getOutputChannel() }
      );
    }, STATE_FILE_DEBOUNCE_MS);
    this._watcherDebounces.set(key, timer);
  }

  /**
   * Resolve the combined conflict state for a repo and publish the context
   * key. Exposed as a separate method so tests can drive it deterministically.
   */
  async runStateFileCheck(repo: IRepository): Promise<boolean> {
    return this._runStateFileCheck(repo);
  }

  private async _runStateFileCheck(repo: IRepository): Promise<boolean> {
    const stateFiles = ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];
    const gitDir = path.join(repo.rootUri.fsPath, '.git');
    let anyStateFilePresent = false;

    for (const file of stateFiles) {
      try {
        await fs.promises.access(path.join(gitDir, file));
        anyStateFilePresent = true;
        break;
      } catch {
        // Missing — keep looking.
      }
    }

    // Rebase uses a directory (rebase-merge/rebase-apply), not just a file.
    if (!anyStateFilePresent) {
      for (const dir of ['rebase-merge', 'rebase-apply']) {
        try {
          const stat = await fs.promises.stat(path.join(gitDir, dir));
          if (stat.isDirectory()) {
            anyStateFilePresent = true;
            break;
          }
        } catch {
          // Ignore.
        }
      }
    }

    const unmerged = await this.hasUnresolvedConflicts(repo);
    const active = anyStateFilePresent && unmerged;
    await this._setConflictsActive(repo, active);
    return active;
  }

  /**
   * Record the per-repo active state and publish the aggregate
   * `intellig.conflicts.active` context key. The aggregate flips to `true`
   * whenever any repo has conflicts and back to `false` only when every
   * repo reports clean.
   *
   * Only invokes `setContext` when the aggregate actually changes, so the
   * original memoization guarantee is preserved.
   */
  private async _setConflictsActive(repo: IRepository, active: boolean): Promise<void> {
    const key = repo.rootUri.fsPath;
    const previous = this._conflictsActiveByRepo.get(key) ?? false;
    if (previous === active) {
      // Per-repo state unchanged — aggregate can't change, nothing to do.
      return;
    }
    this._conflictsActiveByRepo.set(key, active);

    const nextAggregate = this._recomputeAggregateActive();
    if (nextAggregate === this._conflictsActiveAggregate) {
      // Aggregate unchanged (e.g. another repo is still conflicted).
      return;
    }
    this._conflictsActiveAggregate = nextAggregate;
    try {
      await vscode.commands.executeCommand(
        'setContext',
        CONTEXT_KEY_CONFLICTS_ACTIVE,
        nextAggregate
      );
    } catch {
      // setContext isn't available in non-test extension-host builds; swallow
      // so this call is safe in unit tests that don't mock it.
    }
  }

  /**
   * Compute the aggregate — any repo conflicted ⇒ true.
   */
  private _recomputeAggregateActive(): boolean {
    for (const v of this._conflictsActiveByRepo.values()) {
      if (v) {
        return true;
      }
    }
    return false;
  }

  /**
   * Current aggregate value of the context key we last published. Exposed
   * for tests.
   */
  getConflictsActive(): boolean {
    return this._conflictsActiveAggregate;
  }

  /**
   * Per-repo active state snapshot. Exposed for tests that want to verify
   * multi-root behavior (one repo conflicted, another clean).
   */
  getConflictsActiveForRepo(repo: IRepository): boolean {
    return this._conflictsActiveByRepo.get(repo.rootUri.fsPath) ?? false;
  }

  /**
   * Whether a Resolve Conflicts dialog is currently open for a repo.
   */
  hasOpenDialog(repo: IRepository): boolean {
    return this._activeDialogs.has(repo.rootUri.fsPath);
  }

  /**
   * Return the open dialog for a repo, if any. Primarily useful to tests.
   */
  getOpenDialog(repo: IRepository): ResolveConflictsDialog | undefined {
    return this._activeDialogs.get(repo.rootUri.fsPath);
  }

  /**
   * Get all conflicted files in the repository
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

    // Clear any pending state-file watcher timers.
    for (const timer of this._watcherDebounces.values()) {
      clearTimeout(timer);
    }
    this._watcherDebounces.clear();

    // Dispose any open Resolve Conflicts dialogs.
    for (const dialog of this._activeDialogs.values()) {
      dialog.dispose();
    }
    this._activeDialogs.clear();

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
