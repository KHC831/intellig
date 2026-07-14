import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { IGitService, IRepository } from '../git-core/interfaces/IGitService';
import { resolveGitDir, REBASE_STATE_DIRS } from '../git-core/gitDirMarkers';
import { safeFireAndForget } from '../utils/safeFireAndForget';
import { CONTEXT_KEYS, setContextKey } from '../utils/contextKeys';
import { getLogger, type Logger } from '../utils/logger';
import { ResolveConflictsDialog, IConflictOpContext } from './ResolveConflictsDialog';
import { IMergeView } from './interfaces/IMergeView';
import {
  IConflictResolutionService,
  IConflictedFile,
} from './interfaces/IConflictResolutionService';

const STATE_FILE_DEBOUNCE_MS = 300;
const CONFIG_AUTO_OPEN_KEY = 'autoOpenResolveConflictsDialog';

/**
 * The resolution backend the coordinator drives: the headless Layer-3 resolver
 * (also the dialog's accept/abort/continue backend), plus recording the active
 * operation so the resolver's ours/theirs reversal stays consistent with the
 * dialog that opened.
 */
export interface IConflictResolverBackend extends IConflictResolutionService {
  recordOperation(repo: IRepository, operation: IConflictOpContext['operation']): void;
}

/**
 * Layer 4 — the conflict UI lifecycle: which dialog is open per repo, the
 * `intellig.conflicts.active` context key (aggregated across repos), and the
 * debounced `.git/**` state-file watcher that drives the status-bar prompt. The
 * "when to show what" layer; the headless resolver does the git work.
 */
export class ConflictUiCoordinator {
  private readonly _logger: Logger;
  private readonly _disposables: vscode.Disposable[] = [];
  private readonly _activeDialogs: Map<string, ResolveConflictsDialog> = new Map();
  private readonly _watcherDebounces: Map<string, NodeJS.Timeout> = new Map();
  private readonly _conflictsActiveByRepo: Map<string, boolean> = new Map();
  private _conflictsActiveAggregate = false;
  private _context: vscode.ExtensionContext | undefined;
  private _mergeView: IMergeView | undefined;

  constructor(
    private readonly _resolver: IConflictResolverBackend,
    private readonly _gitService: IGitService
  ) {
    this._logger = getLogger().child({ component: 'ConflictUiCoordinator' });
  }

  /**
   * Wire late-bound dependencies needed to open the Resolve Conflicts dialog.
   * Called once during activation after MergeView is constructed.
   */
  setResolveConflictsDependencies(context: vscode.ExtensionContext, mergeView: IMergeView): void {
    this._context = context;
    this._mergeView = mergeView;
  }

  /**
   * React to a repository change the resolver observed: refresh any open dialog
   * against the fresh unmerged set and re-run the debounced state-file check.
   */
  onRepositoryChanged(repo: IRepository, conflicts: IConflictedFile[]): void {
    this._reconcileOpenDialog(repo, conflicts);
    this._scheduleStateFileCheck(repo);
  }

  /**
   * Open (or reveal + update) the Resolve Conflicts dialog for a repository.
   * If the `intellig.autoOpenResolveConflictsDialog` config is `false` we skip
   * the dialog entirely unless `options.explicit` is set; the status-bar prompt
   * (driven by the state-file watcher and the context key) remains the surface.
   *
   * One dialog per repo at any given time.
   */
  async openResolveConflictsDialog(
    repo: IRepository,
    conflicts: IConflictedFile[],
    opContext: IConflictOpContext,
    options?: { explicit?: boolean }
  ): Promise<void> {
    // Record the operation up front (even when no dialog actually opens) so the
    // bulk palette accept-all commands reverse ours/theirs consistently with the
    // dialog's per-file actions for this conflict.
    this._resolver.recordOperation(repo, opContext.operation);

    // The config only gates AUTOMATIC opening after a conflict-producing op. An
    // explicit user action (status-bar prompt / VCS menu) always opens —
    // otherwise the opt-out turns that entry point into a dead-end.
    const autoOpen =
      options?.explicit === true ||
      vscode.workspace.getConfiguration('intellig').get<boolean>(CONFIG_AUTO_OPEN_KEY, true);

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
      // Only reuse a dialog for the SAME operation. A lingering dialog from a
      // finished op would otherwise show the new op's files while keeping the
      // old operation's reversal/labels. Different op ⇒ dispose it (its
      // onDidClose clears the registry) and fall through to a fresh dialog.
      if (existing.getOpContext().operation === opContext.operation) {
        existing.updateConflicts(conflicts);
        existing.reveal();
        return;
      }
      // Different op: dispose the stale dialog. Its onDidClose clears only the
      // dialog registry; the recorded op keeps the new op set above.
      existing.dispose();
    }

    // Resolve the per-side ref names so the dialog can render "Accept from
    // {branch}". A side with no resolvable ref comes back undefined and the
    // dialog shows the generic "Accept Yours/Theirs" for that side. Skip the
    // resolution (several git spawns) on the empty in-progress reopen — with no
    // conflict rows there are no per-file Accept buttons to label.
    const sideNames =
      conflicts.length === 0
        ? {}
        : await this._resolver.getConflictSideNames(repo, opContext.operation);
    const dialog = new ResolveConflictsDialog(
      this._context,
      repo,
      conflicts,
      { ...opContext, sideNames },
      this._resolver,
      this._mergeView,
      this._gitService
    );
    this._activeDialogs.set(key, dialog);

    dialog.onDidClose((reason) => {
      this._activeDialogs.delete(key);
      // Do NOT clear the recorded op here: closing the editor tab ('cancelled')
      // does not resolve the conflict, and the bulk palette accept-all commands
      // still need the recorded operation to swap ours/theirs for an
      // unstash/unshelve that has no repo.state signal. The recorded op is
      // cleared when the repo's conflicts actually clear or on dispose.
      // Completion or abort implies the op is finished → flip context key for
      // this repo. Other repos' active state is preserved.
      if (reason === 'completed' || reason === 'aborted') {
        safeFireAndForget(
          this._setConflictsActive(repo, false),
          'ConflictUiCoordinator.openResolveConflictsDialog: clear active on dialog close'
        );
      }
    });

    // Seed the context key so the VCS menu item & status-bar prompt reflect
    // the live state as soon as the dialog opens.
    await this._setConflictsActive(repo, true);
  }

  /** Whether a dialog is currently open for the repo. */
  hasOpenDialog(repo: IRepository): boolean {
    return this._activeDialogs.has(repo.rootUri.fsPath);
  }

  /** The open dialog for the repo, if any. */
  getOpenDialog(repo: IRepository): ResolveConflictsDialog | undefined {
    return this._activeDialogs.get(repo.rootUri.fsPath);
  }

  /**
   * Sync an open Resolve Conflicts dialog against the freshly-queried unmerged
   * set. When a conflicted file stops being unmerged — typically because the
   * user finished it in VS Code's native merge editor (`git.openMergeEditor`),
   * which stages the file and so mutates `.git/index` (a watched entry) — its
   * row flips to resolved and the dialog's Continue enables once every row is.
   *
   * Mirrors IntelliJ `MultipleFileMergeDialog.updateModelFromFiles`, which
   * re-reads `git ls-files --unmerged` on a refresh and drops resolved rows.
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
   * `.git/REVERT_HEAD` (plus the rebase dirs), combine with the unmerged-files
   * check, and publish the context key. Debounced so a flurry of `.git/**`
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
      // State-file check errors are transient (race with concurrent `.git/**`
      // mutations); log-and-suppress — the next watcher event retries.
      safeFireAndForget(
        this._runStateFileCheck(repo).then(() => undefined),
        'ConflictUiCoordinator._scheduleStateFileCheck: debounced state-file check'
      );
    }, STATE_FILE_DEBOUNCE_MS);
    this._watcherDebounces.set(key, timer);
  }

  /**
   * Resolve the combined conflict state for a repo and publish the context key.
   * Exposed so tests can drive it deterministically.
   */
  async runStateFileCheck(repo: IRepository): Promise<boolean> {
    return this._runStateFileCheck(repo);
  }

  private async _runStateFileCheck(repo: IRepository): Promise<boolean> {
    const stateFiles = ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];
    // Resolve the real gitdir: in a linked worktree/submodule `<root>/.git` is a
    // FILE, so probing markers under the raw path would ENOTDIR and miss every
    // in-progress signal — the conflict prompt would never surface there.
    const gitDir = await resolveGitDir(repo.rootUri.fsPath);
    let anyStateFilePresent = false;

    for (const file of stateFiles) {
      try {
        await fs.promises.access(path.join(gitDir, file));
        anyStateFilePresent = true;
        break;
      } catch (error) {
        // ENOENT is the expected "state file absent" signal — keep looking. Any
        // other errno (EACCES/EIO/ENOTDIR…) is a real fs fault that must not be
        // masked as "no operation in progress"; log+degrade so it's visible.
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
      for (const dir of REBASE_STATE_DIRS) {
        try {
          const stat = await fs.promises.stat(path.join(gitDir, dir));
          if (stat.isDirectory()) {
            anyStateFilePresent = true;
            break;
          }
        } catch (error) {
          // ENOENT is the expected "rebase dir absent" signal. Any other errno
          // is a real fs fault that must not be masked; log+degrade.
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
            this._logger.debug('in-progress rebase-dir probe failed', {
              dir,
              err: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }

    const unmerged = await this._resolver.hasUnresolvedConflicts(repo);
    const active = anyStateFilePresent && unmerged;
    await this._setConflictsActive(repo, active);
    return active;
  }

  /**
   * Record the per-repo active state and publish the aggregate context key. The
   * aggregate flips to `true` whenever any repo has conflicts and back to
   * `false` only when every repo reports clean. Only invokes `setContext` when
   * the aggregate actually changes.
   */
  private async _setConflictsActive(repo: IRepository, active: boolean): Promise<void> {
    const key = repo.rootUri.fsPath;
    const previous = this._conflictsActiveByRepo.get(key) ?? false;
    if (previous === active) {
      return;
    }
    this._conflictsActiveByRepo.set(key, active);

    const nextAggregate = this._recomputeAggregateActive();
    if (nextAggregate === this._conflictsActiveAggregate) {
      return;
    }
    this._conflictsActiveAggregate = nextAggregate;
    await setContextKey(CONTEXT_KEYS.conflictsActive, nextAggregate);
  }

  /** Compute the aggregate — any repo conflicted ⇒ true. */
  private _recomputeAggregateActive(): boolean {
    for (const v of this._conflictsActiveByRepo.values()) {
      if (v) {
        return true;
      }
    }
    return false;
  }

  /** Current aggregate value of the context key we last published. */
  getConflictsActive(): boolean {
    return this._conflictsActiveAggregate;
  }

  /** Per-repo active flag (test/telemetry helper). */
  getConflictsActiveForRepo(repo: IRepository): boolean {
    return this._conflictsActiveByRepo.get(repo.rootUri.fsPath) ?? false;
  }

  /** Number of open dialogs (telemetry helper for dispose logging). */
  get openDialogCount(): number {
    return this._activeDialogs.size;
  }

  dispose(): void {
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables.length = 0;
    for (const t of this._watcherDebounces.values()) {
      clearTimeout(t);
    }
    this._watcherDebounces.clear();
    for (const dialog of this._activeDialogs.values()) {
      dialog.dispose();
    }
    this._activeDialogs.clear();
    this._conflictsActiveByRepo.clear();
  }
}
