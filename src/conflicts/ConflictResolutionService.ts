import * as vscode from 'vscode';
import {
  IConflictResolutionService,
  IConflictedFile,
  IConflictResolutionResult,
  IOperationCompletionResult,
} from './interfaces/IConflictResolutionService';
import { IGitService, IRepository, RepositoryState } from '../git-core/interfaces/IGitService';
import { GitCli, IGitCommandOptions, IGitCommandResult } from '../git-core/gitCli';
import { ResolveConflictsDialog, IConflictOpContext } from './ResolveConflictsDialog';
import { inferReopenOperation, isReversedOperation } from './conflictReversal';
import { resolveConflictSideNames, IConflictSideNames } from './conflictSideNames';
import { sanitizeGitError } from '../git-core/gitError';
import { withAutostashParked } from '../git-core/rebaseAutostash';
import { IMergeView } from './interfaces/IMergeView';
import { isConflictedStatus } from '../git-core/gitParser';
import { resolveGitDir } from '../git-core/gitDirMarkers';
import { RepoCommandQueue } from '../git-core/repoCommandQueue';
import { IConflictIndexWriter, ConflictIndexWriter } from './conflictIndexWriter';
import { ConflictUiCoordinator } from './conflictUiCoordinator';
import { getLogger, type Logger } from '../utils/logger';
import { NON_INTERACTIVE_GIT_ENV } from '../git-core/gitEnv';
import { restorePathsToHead } from '../git-core/worktree/restoreToHead';

/**
 * Interface for accessing GitCli from GitService
 */
interface IGitServiceWithCli extends IGitService {
  gitCli: GitCli;
}

/**
 * Narrowing for the shared per-repo index lock the concrete GitService
 * exposes (ADR-001: post-freeze capabilities live on the class, consumers
 * narrow like the `gitCli` hatch).
 */
interface IGitServiceWithIndexLock extends IGitService {
  withIndexLock<T>(rootPath: string, fn: () => Promise<T>): Promise<T>;
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
   * Per-repository operation that produced the active conflict, recorded when a
   * Resolve Conflicts dialog is opened. The single source of truth for whether
   * ours/theirs are swapped (see {@link _isReversed}); lets the operation-less
   * bulk palette commands agree with the dialog's per-file actions on
   * unstash/unshelve. Cleared when the repo's conflicts clear (NOT on dialog
   * close — a closed tab leaves the conflict, and its unstash/unshelve reversal,
   * still in effect).
   */
  private readonly _opByRepo: Map<string, IConflictOpContext['operation']> = new Map();

  /**
   * Repos with a bulk accept-all (acceptAllCurrent/acceptAllIncoming) in flight.
   * The palette commands gate on a modal confirm, but a double-confirm could
   * launch two concurrent batches; the second would re-query conflicts and run
   * `checkout`/`rm` on a path the first already resolved, erroring mid-batch.
   * A second bulk op on the same repo is dropped while one is running.
   */
  private readonly _bulkInFlight: Set<string> = new Set();

  /** Layer 4 — dialog lifecycle + context key. Set in the constructor. */
  private readonly _coordinator: ConflictUiCoordinator;

  /**
   * Component-bound Logger emitted on construction and disposal so
   * operational waypoints land in the IntelliG OutputChannel
   * uniformly with the rest of the service graph.
   */
  private readonly _logger: Logger;

  /**
   * Fallback per-repo serializer, used ONLY when the injected git service
   * does not expose the shared {@link GitService.withIndexLock} hatch (narrow
   * test stubs). Production always routes through the SHARED GitService lock
   * so accepts serialize against every other index-mutating feature (e.g.
   * the merge editor's synthetic-base injection), not just against other
   * accepts.
   */
  private readonly _fallbackIndexQueue = new RepoCommandQueue();

  /**
   * Acquire the per-repo index lock: the shared GitService one when exposed,
   * else the local fallback. NOT re-entrant (see RepoCommandQueue).
   */
  private _withIndexLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
    const shared = (this._gitService as Partial<IGitServiceWithIndexLock>).withIndexLock;
    if (typeof shared === 'function') {
      // The Partial<> narrowing erases the method's generic; the underlying
      // contract is `<T>(root, fn: () => Promise<T>) => Promise<T>`.
      return shared.call(this._gitService, root, fn) as Promise<T>;
    }
    return this._fallbackIndexQueue.withLock(root, fn);
  }

  /** Layer 1 git index plumbing (checkout/rm/read-stages). */
  private readonly _indexWriter: IConflictIndexWriter;

  /**
   * Event fired when conflicts change
   */
  readonly onDidChangeConflicts: vscode.Event<{ repo: IRepository; conflicts: IConflictedFile[] }>;

  constructor(
    private readonly _gitService: IGitService,
    indexWriter?: IConflictIndexWriter
  ) {
    // The one place GitService's raw GitCli is derived; the accept paths depend
    // on the IConflictIndexWriter seam, not the downcast. Tests may inject a
    // fault-injecting writer.
    this._indexWriter =
      indexWriter ?? new ConflictIndexWriter((_gitService as IGitServiceWithCli).gitCli);
    this._onDidChangeConflicts = new vscode.EventEmitter();
    this.onDidChangeConflicts = this._onDidChangeConflicts.event;
    this._logger = getLogger().child({ component: 'ConflictResolutionService' });
    this._logger.info('ConflictResolutionService constructed');

    // Layer 4 — dialog lifecycle + context key. Composed here; the service
    // delegates its UI-facing surface to it and stays the headless resolver.
    this._coordinator = new ConflictUiCoordinator(this, this._gitService);

    // Listen for repository changes to detect conflict changes. `.git/**`
    // changes (300ms-debounced in GitService) flow through here, so MERGE_HEAD /
    // REBASE_HEAD / CHERRY_PICK_HEAD / REVERT_HEAD appearance and removal both
    // update conflicts + the coordinator's dialog/context-key state.
    this._disposables.push(
      this._gitService.onDidChangeRepository(async (repo) => {
        const conflicts = await this.getConflictedFiles(repo);
        // Once the repo is conflict-free the recorded operation is stale — drop
        // it so a later, unrelated conflict never inherits the wrong ours/theirs
        // reversal from it.
        if (conflicts.length === 0) {
          this._opByRepo.delete(repo.rootUri.fsPath);
        }
        this._onDidChangeConflicts.fire({ repo, conflicts });
        this._coordinator.onRepositoryChanged(repo, conflicts);
      })
    );
  }

  /**
   * Record the operation that produced the repo's live conflict, so the bulk
   * accept-all reversal (which has no repo.state signal for unstash/unshelve)
   * stays consistent with the dialog. Written by the UI coordinator on open.
   */
  recordOperation(repo: IRepository, operation: IConflictOpContext['operation']): void {
    this._opByRepo.set(repo.rootUri.fsPath, operation);
  }

  /** @see IConflictResolutionService — delegated to the Layer-4 UI coordinator. */
  setResolveConflictsDependencies(context: vscode.ExtensionContext, mergeView: IMergeView): void {
    this._coordinator.setResolveConflictsDependencies(context, mergeView);
  }

  openResolveConflictsDialog(
    repo: IRepository,
    conflicts: IConflictedFile[],
    opContext: IConflictOpContext,
    options?: { explicit?: boolean }
  ): Promise<void> {
    return this._coordinator.openResolveConflictsDialog(repo, conflicts, opContext, options);
  }

  /** Publish the combined conflict state + context key for a repo. */
  runStateFileCheck(repo: IRepository): Promise<boolean> {
    return this._coordinator.runStateFileCheck(repo);
  }

  /** Current aggregate value of the `intellig.conflicts.active` context key. */
  getConflictsActive(): boolean {
    return this._coordinator.getConflictsActive();
  }

  /** Per-repo active flag (multi-root test helper). */
  getConflictsActiveForRepo(repo: IRepository): boolean {
    return this._coordinator.getConflictsActiveForRepo(repo);
  }

  /** Whether a Resolve Conflicts dialog is currently open for a repo. */
  hasOpenDialog(repo: IRepository): boolean {
    return this._coordinator.hasOpenDialog(repo);
  }

  /** The open dialog for a repo, if any (test helper). */
  getOpenDialog(repo: IRepository): ResolveConflictsDialog | undefined {
    return this._coordinator.getOpenDialog(repo);
  }

  /**
   * The operation that produced the repo's live conflict, recorded when the
   * dialog was first opened. Callers that RE-open the dialog (the manual
   * "Resolve Conflicts…" entry point) must prefer this over re-guessing from
   * `repo.state`: unstash/unshelve/applyPatch all leave `repo.state === 'idle'`,
   * so a state-based guess would mislabel them as 'merge', clobber the recorded
   * op, and silently flip ours/theirs to the wrong side. Returns `undefined`
   * when no operation is on record (e.g. a conflict produced outside the
   * extension), in which case a state-based fallback is the best available.
   */
  getRecordedOperation(repo: IRepository): IConflictOpContext['operation'] | undefined {
    return this._opByRepo.get(repo.rootUri.fsPath);
  }

  async getConflictSideNames(
    repo: IRepository,
    operation?: IConflictOpContext['operation']
  ): Promise<IConflictSideNames> {
    const op =
      operation ??
      inferReopenOperation(this._opByRepo.get(repo.rootUri.fsPath), this.getRepositoryState(repo));
    const gitCli = (this._gitService as IGitServiceWithCli).gitCli;
    const cwd = repo.rootUri.fsPath;
    const run = async (args: string[]): Promise<string | undefined> => {
      try {
        const r = await gitCli.exec(args, { cwd, throwOnError: false });
        return r.exitCode === 0 ? r.stdout.trim() || undefined : undefined;
      } catch {
        return undefined;
      }
    };
    // The `.git` dir is a *file* in linked worktrees/submodules — resolve it via
    // the shared fs helper (no subprocess, same logic as loadRepository).
    const gitDir = await resolveGitDir(cwd);
    const shortenSha = (sha: string): Promise<string | undefined> =>
      run(['rev-parse', '--short', sha]);
    const nameRev = async (sha: string): Promise<string | undefined> => {
      const name = await run(['name-rev', '--name-only', '--no-undefined', sha]);
      // name-rev can return an ancestor expression ("main~2") or a prefixed name
      // ("remotes/origin/x", "tags/v1"); only a clean tip name is a useful
      // "Accept from {name}".
      if (!name || /[~^]/.test(name)) {
        return undefined;
      }
      return name.replace(/^(?:remotes|tags)\//, '');
    };
    return resolveConflictSideNames(gitDir, op, repo.head?.name, shortenSha, nameRev);
  }

  /**
   * Get all conflicted files in the repository
   *
   * @param repo - The repository
   * @returns Array of conflicted files
   */
  async getConflictedFiles(repo: IRepository): Promise<IConflictedFile[]> {
    const status = await this._gitService.getStatus(repo);

    // Use the canonical unmerged-status predicate so both-added (AA) and
    // both-deleted (DD) conflicts — which carry no `U` column — are caught
    // alongside the `U`-marked ones. A U-only filter silently dropped them.
    const conflictedFiles = status
      .filter((file) => isConflictedStatus(file))
      .map((file) => ({
        path: file.path,
        resolved: false,
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
      await this._gitService.stage(repo, [filePath]).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );

      // Fire change event
      const conflicts = await this.getConflictedFiles(repo);
      this._onDidChangeConflicts.fire({ repo, conflicts });

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Failed to mark file as resolved: ${sanitizeGitError(errorMessage)}`,
      };
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
      await this._gitService.stage(repo, filePaths).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );

      // Fire change event
      const conflicts = await this.getConflictedFiles(repo);
      this._onDidChangeConflicts.fire({ repo, conflicts });

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Failed to mark files as resolved: ${sanitizeGitError(errorMessage)}`,
      };
    }
  }

  /**
   * Whether ours/theirs are swapped for this resolution. Git reverses the index
   * sides during a rebase (and unstash/unshelve): stage 2 (`--ours`) becomes the
   * branch being replayed onto and stage 3 (`--theirs`) the user's own commit.
   * Mirrors IntelliJ `GitMergeUtil.isReverseRoot` (rebase).
   *
   * When the caller does not pass an explicit flag (e.g. the bulk palette
   * commands, which have no operation context of their own), resolve the
   * operation through {@link inferReopenOperation} — the repository state leads
   * (a definitive in-progress op is a git fact), and the recorded op only
   * disambiguates an idle repo (a working-tree apply ⇒ unstash). That is the
   * same inference the dialog and the naming use, so a bulk "Accept All" and a
   * per-file "Accept Yours" always resolve the same conflict to the same side.
   */
  private _isReversed(repo: IRepository, reversed?: boolean): boolean {
    if (reversed !== undefined) {
      return reversed;
    }
    const operation = inferReopenOperation(
      this._opByRepo.get(repo.rootUri.fsPath),
      this.getRepositoryState(repo)
    );
    return isReversedOperation(operation);
  }

  /** Checkout flag that takes the user's own ("Yours") side. */
  private _yoursFlag(repo: IRepository, reversed?: boolean): '--ours' | '--theirs' {
    return this._isReversed(repo, reversed) ? '--theirs' : '--ours';
  }

  /** Checkout flag that takes the incoming ("Theirs") side. */
  private _theirsFlag(repo: IRepository, reversed?: boolean): '--ours' | '--theirs' {
    return this._isReversed(repo, reversed) ? '--ours' : '--theirs';
  }

  /**
   * Resolve a single conflicted file by taking one index side (via the Layer 1
   * {@link IConflictIndexWriter}) and staging the checked-out result, serialized
   * against other index writes for this repo.
   */
  private async _acceptSide(
    repo: IRepository,
    filePath: string,
    flag: '--ours' | '--theirs'
  ): Promise<void> {
    const root = repo.rootUri.fsPath;
    await this._withIndexLock(root, async () => {
      const entry = (await this._indexWriter.readStages(root, filePath)).get(filePath);
      const needsStage = await this._indexWriter.takeSide(root, filePath, flag, entry);
      if (needsStage) {
        await this._gitService.stage(repo, [filePath]).match(
          () => undefined,
          (e) => {
            throw e;
          }
        );
      }
    });
  }

  /**
   * Send a RESOLVED file back to conflicted state (`git checkout --merge`) so
   * a mis-resolution can be redone — the inverse of the accept operations.
   * Serialized against other index writes; git itself refuses when the file
   * has no recorded resolve-undo data or no operation is in progress.
   */
  async unresolveFile(repo: IRepository, filePath: string): Promise<IConflictResolutionResult> {
    try {
      const root = repo.rootUri.fsPath;
      await this._withIndexLock(root, () => this._indexWriter.restoreConflict(root, filePath));

      const conflicts = await this.getConflictedFiles(repo);
      this._onDidChangeConflicts.fire({ repo, conflicts });

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Failed to un-resolve '${filePath}': ${sanitizeGitError(errorMessage)}`,
      };
    }
  }

  /**
   * Accept the user's own ("Yours") version for a file and mark as resolved.
   *
   * @param repo - The repository
   * @param filePath - The file path
   * @param reversed - Whether ours/theirs are swapped (rebase/unstash/unshelve)
   * @returns Resolution result
   */
  async acceptCurrent(
    repo: IRepository,
    filePath: string,
    reversed?: boolean
  ): Promise<IConflictResolutionResult> {
    try {
      await this._acceptSide(repo, filePath, this._yoursFlag(repo, reversed));

      // Fire change event
      const conflicts = await this.getConflictedFiles(repo);
      this._onDidChangeConflicts.fire({ repo, conflicts });

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Failed to accept current version: ${sanitizeGitError(errorMessage)}`,
      };
    }
  }

  /**
   * Accept incoming (theirs) version for a file and mark as resolved
   *
   * @param repo - The repository
   * @param filePath - The file path
   * @returns Resolution result
   */
  async acceptIncoming(
    repo: IRepository,
    filePath: string,
    reversed?: boolean
  ): Promise<IConflictResolutionResult> {
    try {
      await this._acceptSide(repo, filePath, this._theirsFlag(repo, reversed));

      // Fire change event
      const conflicts = await this.getConflictedFiles(repo);
      this._onDidChangeConflicts.fire({ repo, conflicts });

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Failed to accept incoming version: ${sanitizeGitError(errorMessage)}`,
      };
    }
  }

  /**
   * Accept current version for all conflicted files
   *
   * @param repo - The repository
   * @returns Resolution result
   */
  async acceptAllCurrent(
    repo: IRepository,
    reversed?: boolean
  ): Promise<IConflictResolutionResult> {
    return this._runBulk(repo, () => this._acceptAllBySide(repo, this._yoursFlag(repo, reversed)));
  }

  /**
   * Run a bulk accept-all batch under the per-repo {@link _bulkInFlight} guard
   * so a concurrent second invocation can't interleave `checkout`/`rm` with the
   * first and error mid-batch. A dropped second call is a benign no-op marked
   * `skipped` — NOT a success (the in-flight batch may be taking the other side,
   * so claiming success would mislabel it) and NOT an error to toast. The guard
   * clears in `finally`.
   */
  private async _runBulk(
    repo: IRepository,
    batch: () => Promise<void>
  ): Promise<IConflictResolutionResult> {
    const key = repo.rootUri.fsPath;
    if (this._bulkInFlight.has(key)) {
      return { success: false, skipped: true };
    }
    this._bulkInFlight.add(key);
    try {
      await batch();
      const remainingConflicts = await this.getConflictedFiles(repo);
      this._onDidChangeConflicts.fire({ repo, conflicts: remainingConflicts });
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Failed to accept all: ${sanitizeGitError(errorMessage)}` };
    } finally {
      this._bulkInFlight.delete(key);
    }
  }

  /**
   * Take one index side (`--ours`/`--theirs`) for every conflicted file.
   * Files whose taken side was deleted are removed with `git rm`; the rest are
   * checked out and staged in one batch.
   */
  private async _acceptAllBySide(repo: IRepository, flag: '--ours' | '--theirs'): Promise<void> {
    const root = repo.rootUri.fsPath;
    // Serialize the whole batch against per-file accepts for this repo so the
    // checkouts/rms/stage never race another accept on `.git/index.lock`.
    await this._withIndexLock(root, async () => {
      // One index-only read of every unmerged path + its stages (git4idea's
      // `git ls-files -u` model) — the canonical conflict set, and the single
      // source for the per-file delete-vs-checkout decision.
      const stagesByPath = await this._indexWriter.readStages(root);
      if (stagesByPath.size === 0) {
        return;
      }

      const toStage: string[] = [];
      for (const [conflictPath, entry] of stagesByPath) {
        const needsStage = await this._indexWriter.takeSide(root, conflictPath, flag, entry);
        if (needsStage) {
          toStage.push(conflictPath);
        }
      }
      // Stage the checked-out files to mark resolved (rm already staged removals).
      if (toStage.length > 0) {
        await this._gitService.stage(repo, toStage).match(
          () => undefined,
          (e) => {
            throw e;
          }
        );
      }
    });
  }

  /**
   * Accept incoming version for all conflicted files
   *
   * @param repo - The repository
   * @returns Resolution result
   */
  async acceptAllIncoming(
    repo: IRepository,
    reversed?: boolean
  ): Promise<IConflictResolutionResult> {
    return this._runBulk(repo, () => this._acceptAllBySide(repo, this._theirsFlag(repo, reversed)));
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
      const gitCli = (this._gitService as IGitServiceWithCli).gitCli;
      // `git merge --continue` commits the resolved index honoring MERGE_MSG and
      // the merge hooks; the editor is suppressed (it would hang under the
      // non-TTY spawn). No cached-`repo.state` guard — git self-guards live off
      // `MERGE_HEAD` (errors when no merge is in progress) and off unmerged
      // entries, so this stays guardless like abortMerge. The friendly pre-check
      // belongs to the callers: the palette runs canCompleteOperation, the
      // dialog its allResolved() gate. Both the dialog Continue and the palette
      // "Complete Merge" route here (git4idea's single GitConflictResolver.merge).
      const result: IGitCommandResult = await gitCli.exec(['merge', '--continue'], {
        cwd: repo.rootUri.fsPath,
        env: { ...NON_INTERACTIVE_GIT_ENV },
      });
      if (result.exitCode !== 0) {
        return {
          success: false,
          error: `Failed to complete merge: ${sanitizeGitError(result.stderr || result.stdout)}`,
        };
      }

      const conflicts = await this.getConflictedFiles(repo);
      this._onDidChangeConflicts.fire({ repo, conflicts });
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Failed to complete merge: ${sanitizeGitError(errorMessage)}`,
      };
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
      // No cached-`repo.state` guard (matches completeMerge / the abort methods):
      // `git rebase --continue` self-guards live — it errors when no rebase is in
      // progress and pauses with the remaining conflicts (handled below) when
      // any are unresolved. The palette's canCompleteOperation is the friendly
      // pre-check.
      const gitCli = (this._gitService as IGitServiceWithCli).gitCli;
      const options: IGitCommandOptions = {
        cwd: repo.rootUri.fsPath,
        // `git rebase --continue` opens the editor to confirm the replayed
        // commit's message; under VS Code's non-TTY spawn that hangs forever
        // (timeout 0). GIT_EDITOR=true commits the prepared message verbatim,
        // mirroring the dialog/merge continue paths.
        env: { ...NON_INTERACTIVE_GIT_ENV },
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
          error: `Failed to continue rebase: ${sanitizeGitError(result.stderr || result.stdout)}`,
        };
      }

      // Fire change event
      const conflicts = await this.getConflictedFiles(repo);
      this._onDidChangeConflicts.fire({ repo, conflicts });

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Failed to complete rebase: ${sanitizeGitError(errorMessage)}`,
      };
    }
  }

  /**
   * Abort an unshelve / unstash / apply-patch conflict by restoring the given
   * paths to HEAD. Those ops leave conflict markers in the working tree with no
   * git-level "aborting" state, so there is no `--abort`; a bare `checkout -- .`
   * would wipe unrelated working-tree changes, hence the caller passes just the
   * unresolved paths.
   *
   * Routes through the shared restore-to-HEAD writer, which probes each path's
   * HEAD membership: a both-added (add/add) path is absent from HEAD, so a bare
   * `checkout HEAD -- <path>` fatals ("pathspec did not match") and would fail
   * the whole batch. The writer unindexes such paths instead and keeps the
   * added copy on disk as untracked (git4idea `GitRollbackEnvironment`
   * unversions a NEW file rather than deleting it).
   */
  async abortWorkingTreeConflicts(
    repo: IRepository,
    paths: string[]
  ): Promise<IOperationCompletionResult> {
    if (paths.length === 0) {
      return { success: true };
    }
    try {
      const gitCli = (this._gitService as IGitServiceWithCli).gitCli;
      await restorePathsToHead(
        gitCli,
        repo.rootUri.fsPath,
        paths.map((path) => ({ path }))
      );
      const conflicts = await this.getConflictedFiles(repo);
      this._onDidChangeConflicts.fire({ repo, conflicts });
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Failed to abort: ${sanitizeGitError(errorMessage)}` };
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
          error: `Failed to abort merge: ${sanitizeGitError(result.stderr || result.stdout)}`,
        };
      }

      // Fire change event
      const conflicts = await this.getConflictedFiles(repo);
      this._onDidChangeConflicts.fire({ repo, conflicts });

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Failed to abort merge: ${sanitizeGitError(errorMessage)}` };
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

      const { result, autostashParked } = await withAutostashParked(
        gitCli,
        repo.rootUri.fsPath,
        () => gitCli.exec(['rebase', '--abort'], options)
      );

      if (result.exitCode !== 0) {
        return {
          success: false,
          error: `Failed to abort rebase: ${sanitizeGitError(result.stderr || result.stdout)}`,
        };
      }

      // Fire change event
      const conflicts = await this.getConflictedFiles(repo);
      this._onDidChangeConflicts.fire({ repo, conflicts });

      return { success: true, autostashParked };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Failed to abort rebase: ${sanitizeGitError(errorMessage)}` };
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
    this._logger.info('ConflictResolutionService disposing', {
      activeDialogs: this._coordinator.openDialogCount,
    });
    this._onDidChangeConflicts.dispose();

    // Tear down Layer 4 (watcher timers + open dialogs + context-key state).
    this._coordinator.dispose();
    this._opByRepo.clear();

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
