import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  IConflictResolutionService,
  IConflictedFile,
  IConflictResolutionResult,
  INonConflictingResult,
  IOperationCompletionResult,
} from './interfaces/IConflictResolutionService';
import { IGitService, IRepository, RepositoryState } from '../git-core/interfaces/IGitService';
import { GitCli, IGitCommandOptions, IGitCommandResult } from '../git-core/gitCli';
import { ResolveConflictsDialog, IConflictOpContext } from './ResolveConflictsDialog';
import { IMergeView } from './interfaces/IMergeView';
import { isConflictedStatus } from '../git-core/gitParser';
import { safeFireAndForget } from '../utils/safeFireAndForget';
import { getLogger, type Logger } from '../utils/logger';

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
 * REVIEW.md section 7).
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
   * The previous single-boolean impl reflected only the last repo
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
   * Component-bound Logger emitted on construction and disposal so
   * operational waypoints land in the IntelliG OutputChannel
   * uniformly with the rest of the service graph.
   */
  private readonly _logger: Logger;

  /**
   * Event fired when conflicts change
   */
  readonly onDidChangeConflicts: vscode.Event<{ repo: IRepository; conflicts: IConflictedFile[] }>;

  constructor(private readonly _gitService: IGitService) {
    this._onDidChangeConflicts = new vscode.EventEmitter();
    this.onDidChangeConflicts = this._onDidChangeConflicts.event;
    this._logger = getLogger().child({ component: 'ConflictResolutionService' });
    this._logger.info('ConflictResolutionService constructed');

    // Listen for repository changes to detect conflict changes. Also
    // piggybacks the state-file watcher check — setupRepositoryWatcher in
    // GitService fires this event on any `.git/**` change (300ms debounced),
    // which means MERGE_HEAD / REBASE_HEAD / CHERRY_PICK_HEAD / REVERT_HEAD
    // appearance and removal both flow through here without extra plumbing.
    this._disposables.push(
      this._gitService.onDidChangeRepository(async (repo) => {
        const conflicts = await this.getConflictedFiles(repo);
        this._onDidChangeConflicts.fire({ repo, conflicts });
        this._reconcileOpenDialog(repo, conflicts);
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
          'ConflictResolutionService.openResolveConflictsDialog: clear active on dialog close'
        );
      }
    });

    // Seed the context key so the VCS menu item & status-bar prompt reflect
    // the live state as soon as the dialog opens.
    await this._setConflictsActive(repo, true);
  }

  /**
   * Sync an open Resolve Conflicts dialog against the freshly-queried unmerged
   * set. When a conflicted file stops being unmerged — typically because the
   * user finished it in VS Code's native merge editor (`git.openMergeEditor`),
   * which stages the file and so mutates `.git/index` (a watched entry) — its
   * row flips to resolved and the dialog's Continue button enables once every
   * row is resolved.
   *
   * Mirrors IntelliJ `MultipleFileMergeDialog.updateModelFromFiles`
   * (platform/vcs-impl), which re-reads `git ls-files --unmerged`
   * (GitMergeProvider) on a refresh and drops rows no longer reported.
   */
  private _reconcileOpenDialog(repo: IRepository, conflicts: IConflictedFile[]): void {
    const dialog = this._activeDialogs.get(repo.rootUri.fsPath);
    if (!dialog) {
      return;
    }
    const unmergedPaths = new Set(conflicts.map((c) => c.path));
    dialog.reconcileResolved(unmergedPaths);
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
        'ConflictResolutionService._scheduleStateFileCheck: debounced state-file check'
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
      } catch (error) {
        // ENOENT is the expected "state file absent" signal — keep looking.
        // Any other errno (EACCES/EIO/ENOTDIR…) is a real fs fault that must
        // not be masked as "no operation in progress"; log+degrade so it's visible.
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          this._logger.debug('in-progress state-file probe failed', {
            file,
            err: error instanceof Error ? error.message : String(error),
          });
        }
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
        } catch (error) {
          // ENOENT is the expected "rebase dir absent" signal. Any other errno
          // is a real fs fault that must not be masked; log+degrade so it's visible.
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
            this._logger.debug('in-progress rebase-dir probe failed', {
              dir,
              err: error instanceof Error ? error.message : String(error),
            });
          }
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
      // eslint-disable-next-line no-restricted-syntax -- setContext is a non-essential UI context key; a failure (e.g. unit tests that don't mock it) is non-fatal.
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
      return { success: false, error: `Failed to mark files as resolved: ${errorMessage}` };
    }
  }

  /**
   * Whether ours/theirs are swapped for this resolution. Git reverses the index
   * sides during a rebase (and unstash/unshelve): stage 2 (`--ours`) becomes the
   * branch being replayed onto and stage 3 (`--theirs`) the user's own commit.
   * Mirrors IntelliJ `GitMergeUtil.isReverseRoot` (rebase). When the caller does
   * not pass an explicit flag (e.g. the bulk palette commands), fall back to the
   * repository state so a paused rebase still swaps correctly.
   */
  private _isReversed(repo: IRepository, reversed?: boolean): boolean {
    return reversed ?? this.getRepositoryState(repo) === 'rebasing';
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
   * Resolve a single conflicted file by taking one index side (`--ours` or
   * `--theirs`). A delete/modify conflict where the taken side has no blob
   * (`--ours` + index 'D', or `--theirs` + work-tree 'D') is resolved with
   * `git rm` instead of `checkout` (IntelliJ's GitMergeProvider routes deletions
   * to rm); otherwise the side is checked out and staged.
   */
  private async _acceptSide(
    repo: IRepository,
    filePath: string,
    flag: '--ours' | '--theirs'
  ): Promise<void> {
    const gitCli = (this._gitService as IGitServiceWithCli).gitCli;
    const options: IGitCommandOptions = {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    };
    const status = await this._getUnmergedStatus(repo, filePath);
    const sideDeleted = flag === '--ours' ? status?.index === 'D' : status?.workTree === 'D';
    if (sideDeleted) {
      await gitCli.exec(['rm', '--', filePath], options);
    } else {
      await gitCli.exec(['checkout', flag, '--', filePath], options);
      await this._gitService.stage(repo, [filePath]).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
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
      return { success: false, error: `Failed to accept current version: ${errorMessage}` };
    }
  }

  /**
   * Look up the porcelain unmerged status (index X / work-tree Y) of a single
   * file, used to distinguish a normal both-modified conflict from a
   * delete/modify one. Returns undefined if the file is absent from
   * `git status` (callers then take the default checkout path).
   */
  private async _getUnmergedStatus(
    repo: IRepository,
    filePath: string
  ): Promise<{ index: string; workTree: string } | undefined> {
    const file = (await this._statusByPath(repo)).get(filePath);
    return file ? { index: file.indexStatus, workTree: file.workTreeStatus } : undefined;
  }

  /** path → porcelain X/Y status for the repo, for routing bulk accept-all ops. */
  private async _statusByPath(
    repo: IRepository
  ): Promise<Map<string, { indexStatus: string; workTreeStatus: string }>> {
    const status = await this._gitService.getStatus(repo);
    return new Map(
      status.map((f) => [f.path, { indexStatus: f.indexStatus, workTreeStatus: f.workTreeStatus }])
    );
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
      return { success: false, error: `Failed to accept incoming version: ${errorMessage}` };
    }
  }

  /**
   * Accept every change in a conflicted file that does NOT actually conflict —
   * the regions exactly one side edited — taking that side, and leave the
   * regions both sides changed (the true conflicts) for the user.
   *
   * Mirrors IntelliJ's "Apply Non-Conflicting Changes"
   * (platform/diff-impl `ApplyNonConflictsAction` →
   * `MergeThreesideViewer.applyNonConflictedChanges`, which resolves
   * `ContainerUtil.filter(getAllChanges(), change -> !change.isConflict())`).
   *
   * Rather than hand-roll a diff3 hunk engine, we delegate the three-way text
   * merge to git's own `git merge-file`: fed the index's base/ours/theirs
   * stages it auto-applies every one-sided hunk and re-emits conflict markers
   * for two-sided ones. If no conflict hunks remain the file is fully merged
   * and we stage it (resolved); otherwise it stays unstaged for the user.
   *
   * @param repo - The repository
   * @param filePath - Repo-relative path of the conflicted file
   * @returns Resolution result
   */
  async acceptNonConflictingChanges(
    repo: IRepository,
    filePath: string
  ): Promise<INonConflictingResult> {
    try {
      const gitCli = (this._gitService as IGitServiceWithCli).gitCli;

      // A modify/delete conflict (one side deleted the file) has no three-way
      // text to merge — it is a true conflict in its entirety, so there are no
      // non-conflicting regions to auto-apply. Leave it for the user, matching
      // IntelliJ's filter to `!isConflict()` changes.
      const status = await this._getUnmergedStatus(repo, filePath);
      if (status?.index === 'D' || status?.workTree === 'D') {
        return { success: true, fullyResolved: false, remainingHunks: 1 };
      }

      // Read the three merge stages straight from the index: stage 1 = merge
      // base, stage 2 = ours, stage 3 = theirs. An absent stage (e.g. no common
      // ancestor in an add/add conflict) reads as empty.
      const base = await this._readMergeStage(gitCli, repo, 1, filePath);
      const ours = await this._readMergeStage(gitCli, repo, 2, filePath);
      const theirs = await this._readMergeStage(gitCli, repo, 3, filePath);

      const merged = await mergeNonConflictingText(gitCli, base, ours, theirs);

      const absPath = path.join(repo.rootUri.fsPath, filePath);
      await fs.promises.writeFile(absPath, merged.content);

      // No conflict hunks remain ⇒ the file is fully merged; stage it so it
      // drops out of the unmerged set. Otherwise leave it unstaged so the user
      // settles the remaining true conflicts.
      if (!merged.hasConflicts) {
        await this._gitService.stage(repo, [filePath]).match(
          () => undefined,
          (e) => {
            throw e;
          }
        );
      }

      const conflicts = await this.getConflictedFiles(repo);
      this._onDidChangeConflicts.fire({ repo, conflicts });

      // Count the `<<<<<<<` hunks left so the caller can report progress instead
      // of silently doing nothing on a pure conflict.
      const remainingHunks = merged.hasConflicts
        ? (merged.content.match(/^<{7}/gm) || []).length
        : 0;
      return { success: true, fullyResolved: !merged.hasConflicts, remainingHunks };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Failed to accept non-conflicting changes: ${errorMessage}`,
      };
    }
  }

  /**
   * Read one merge stage of a conflicted file straight from the index
   * (`git show :<stage>:<path>`). Returns empty string when the stage is
   * absent — e.g. an add/add conflict has no stage 1 (no common ancestor).
   */
  private async _readMergeStage(
    gitCli: GitCli,
    repo: IRepository,
    stage: 1 | 2 | 3,
    filePath: string
  ): Promise<string> {
    const result = await gitCli.exec(['show', `:${stage}:${filePath}`], {
      cwd: repo.rootUri.fsPath,
      throwOnError: false,
    });
    return result.exitCode === 0 ? result.stdout : '';
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
    try {
      await this._acceptAllBySide(repo, this._yoursFlag(repo, reversed));

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
   * Take one index side (`--ours`/`--theirs`) for every conflicted file.
   * Files whose taken side was deleted are removed with `git rm`; the rest are
   * checked out and staged in one batch.
   */
  private async _acceptAllBySide(repo: IRepository, flag: '--ours' | '--theirs'): Promise<void> {
    const conflicts = await this.getConflictedFiles(repo);
    if (conflicts.length === 0) {
      return;
    }

    const gitCli = (this._gitService as IGitServiceWithCli).gitCli;
    const options: IGitCommandOptions = {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    };

    const statusByPath = await this._statusByPath(repo);
    const toStage: string[] = [];
    for (const conflict of conflicts) {
      const row = statusByPath.get(conflict.path);
      const sideDeleted =
        flag === '--ours' ? row?.indexStatus === 'D' : row?.workTreeStatus === 'D';
      if (sideDeleted) {
        await gitCli.exec(['rm', '--', conflict.path], options);
      } else {
        await gitCli.exec(['checkout', flag, '--', conflict.path], options);
        toStage.push(conflict.path);
      }
    }
    // Stage the checked-out files to mark as resolved (rm already staged removals).
    if (toStage.length > 0) {
      await this._gitService.stage(repo, toStage).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
    }
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
    try {
      await this._acceptAllBySide(repo, this._theirsFlag(repo, reversed));

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
      // Bail immediately when the repo is not in a merge state — proceeding
      // to `git commit --no-edit` on a non-merging repo would commit whatever
      // happens to be staged, which is never the intent (mirrors IntelliJ
      // GitConflictResolver.proceedIfNothingToMerge).
      const state = this.getRepositoryState(repo);
      if (state !== 'merging') {
        return {
          success: false,
          error: 'Repository is not in a merge state',
        };
      }

      // Check for unresolved conflicts before committing.
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
      // Bail immediately when the repo is not in a rebase state — same guard
      // as completeMerge: proceeding would run a git command against the wrong
      // repo state.
      const state = this.getRepositoryState(repo);
      if (state !== 'rebasing') {
        return {
          success: false,
          error: 'Repository is not in a rebase state',
        };
      }

      // Check for unresolved conflicts before continuing.
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
        // `git rebase --continue` opens the editor to confirm the replayed
        // commit's message; under VS Code's non-TTY spawn that hangs forever
        // (timeout 0). GIT_EDITOR=true commits the prepared message verbatim,
        // mirroring the dialog/merge continue paths.
        env: { GIT_EDITOR: 'true' },
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
    this._logger.info('ConflictResolutionService disposing', {
      activeDialogs: this._activeDialogs.size,
      pendingWatchers: this._watcherDebounces.size,
    });
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
 * Result of a three-way text merge that applies only non-conflicting changes.
 */
export interface IMergeNonConflictingResult {
  /** Merged file content: one-sided hunks applied, two-sided hunks re-marked. */
  content: string;
  /** Whether any true-conflict hunks (with `<<<<<<<` markers) remain. */
  hasConflicts: boolean;
}

/**
 * Run git's own three-way text merge over the base/ours/theirs contents and
 * return the result. `git merge-file` auto-applies every hunk only one side
 * changed and re-emits conflict markers for hunks both sides changed — the
 * machinery behind "accept non-conflicting changes". Its exit code is the
 * number of conflict hunks (0 = clean), which we map to {@link
 * IMergeNonConflictingResult.hasConflicts}.
 *
 * The three sides are staged into a private temp directory so the merge is
 * independent of any working tree; the directory is always cleaned up.
 */
export async function mergeNonConflictingText(
  gitCli: GitCli,
  base: string,
  ours: string,
  theirs: string
): Promise<IMergeNonConflictingResult> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'intellig-merge-'));
  const oursPath = path.join(tmpDir, 'ours');
  const basePath = path.join(tmpDir, 'base');
  const theirsPath = path.join(tmpDir, 'theirs');
  try {
    await Promise.all([
      fs.promises.writeFile(oursPath, ours),
      fs.promises.writeFile(basePath, base),
      fs.promises.writeFile(theirsPath, theirs),
    ]);

    // `-p` prints the merged result to stdout (leaving the inputs untouched);
    // `-L` labels the conflict markers with the side they came from. Arg order
    // is current(ours) / base / other(theirs).
    const result = await gitCli.exec(
      [
        'merge-file',
        '-p',
        '-L',
        'Current (ours)',
        '-L',
        'Merge base',
        '-L',
        'Incoming (theirs)',
        oursPath,
        basePath,
        theirsPath,
      ],
      { cwd: tmpDir, throwOnError: false }
    );

    // A clean run exits 0; conflicts exit with the (positive) hunk count. Git
    // signals real trouble (unreadable input, binary) with 255 and no stdout —
    // surface that rather than silently returning an empty merge.
    if (result.exitCode === 255 && result.stdout.length === 0) {
      throw new Error(`git merge-file failed: ${result.stderr || 'unknown error'}`);
    }

    return { content: result.stdout, hasConflicts: result.exitCode !== 0 };
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
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
