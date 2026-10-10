/**
 * Branch Context Menu Commands implementation.
 * Provides command handlers for branch, remote branch, and tag context menus.
 */

import * as vscode from 'vscode';
import { IGitService, IRepository } from '../git-core/interfaces/IGitService';
import { BranchTreeItem, BranchTreeProvider } from './BranchTreeProvider';
import { IConflictResolutionService } from '../conflicts/interfaces/IConflictResolutionService';
import type { PushDialog, IPushPreselect } from '../sync/PushDialog';
import type { MergeDialog } from '../conflicts/MergeDialog';
import type { RebaseDialog } from '../rebase/RebaseDialog';
import type { NewBranchDialog } from './NewBranchDialog';
import { getLogger, registerLoggedCommand } from '../utils/logger';
import {
  registerTreeItemCommand,
  ITreeItemCommandDeps,
  ITreeItemBatchEntry,
  ITreeItemRunArgs,
  TreeItemTarget,
} from '../commands/registration/commandSpine';
import {
  handleNewWorktree,
  handleOpenWorktree,
  handleRemoveWorktree,
  type IBranchWorktreeContext,
} from './branchWorktreeActions';
import {
  handleTagCheckoutDetached,
  handleTagCherryPick,
  handleTagMergeIntoCurrent,
  handleTagDeleteBatch,
  handleTagPush,
  handleTagDeleteRemote,
  offerRemoteDeleteForLocalTags,
  type IBranchTagContext,
} from './branchTagActions';
import { handleShowDiffWithWorkingTree, type IBranchDiffContext } from './branchDiffActions';
import { handleCherryPickCommits, type IBranchCherryPickContext } from './branchCherryPickActions';
import {
  handleDeleteRemote,
  handleTrackRemote,
  type IBranchRemoteContext,
} from './branchRemoteActions';
import { handleDelete, type IBranchDeleteContext } from './branchDeleteActions';
import { handlePush, type IBranchPushContext } from './branchPushActions';
import {
  handleUpdate,
  handleUpdateSelected,
  runPullFromBranchMenu,
  type IBranchUpdateContext,
} from './branchUpdateActions';
import {
  handleNewBranch,
  handleNewBranchFrom,
  type IBranchCreateContext,
} from './branchCreateActions';
import {
  handleCheckout,
  handleCheckoutAndRebase,
  handleCheckoutAsLocal,
  type IBranchCheckoutContext,
} from './branchCheckoutActions';
import {
  handleMergeIntoCurrent,
  handleRebaseCurrentOnto,
  type IBranchMergeRebaseContext,
} from './branchMergeRebaseActions';
import type { BranchComparisonView } from './BranchComparisonView';

/**
 * Thunk that opens a fresh Push Dialog pre-selected on the given repo + branch.
 * Push dialogs are not singletons (row table reflects current state), so this
 * is a one-shot opener rather than a getter.
 */
export type PushDialogOpener = (preselect: IPushPreselect) => PushDialog | undefined;

/**
 * Open a fresh Merge Dialog for `repo` merging `sourceBranch` into
 * the current branch. `proposeDeleteOnMerge` enables the deleteOnMerge
 * PROPOSE affordance on success (non-protected local branches only —
 * the caller computes eligibility).
 */
export type MergeDialogOpener = (preselect: {
  repo: IRepository;
  sourceBranch: string;
  proposeDeleteOnMerge?: boolean;
}) => MergeDialog | undefined;

/**
 * Open the unified Rebase Dialog for `repo`, preselecting `onto` as the
 * rebase target. Async because the opener fetches the branch list for the
 * dropdown at open time.
 */
export type RebaseDialogOpener = (preselect: {
  repo: IRepository;
  onto?: string;
  interactiveDefault?: boolean;
}) => Promise<RebaseDialog | undefined>;

/**
 * Open a fresh New Branch Dialog with the given start point.
 */
export type NewBranchDialogOpener = (preselect: {
  repo: IRepository;
  startPoint?: string;
  defaultName?: string;
}) => NewBranchDialog | undefined;

/**
 * Branch Context Menu Commands class.
 * Registers and handles all branch-related context menu commands.
 */
export class BranchContextMenuCommands {
  private _gitService: IGitService;
  private _branchTreeProvider: BranchTreeProvider;
  private _conflictResolutionService: IConflictResolutionService | undefined;
  private _pushDialogOpener?: PushDialogOpener;
  private _mergeDialogOpener?: MergeDialogOpener;
  private _rebaseDialogOpener?: RebaseDialogOpener;
  private _newBranchDialogOpener?: NewBranchDialogOpener;
  private _branchComparisonView?: BranchComparisonView;
  private _disposables: vscode.Disposable[] = [];

  constructor(
    gitService: IGitService,
    branchTreeProvider: BranchTreeProvider,
    conflictResolutionService?: IConflictResolutionService,
    pushDialogOpener?: PushDialogOpener,
    mergeDialogOpener?: MergeDialogOpener,
    newBranchDialogOpener?: NewBranchDialogOpener,
    rebaseDialogOpener?: RebaseDialogOpener
  ) {
    this._gitService = gitService;
    this._branchTreeProvider = branchTreeProvider;
    this._conflictResolutionService = conflictResolutionService;
    this._pushDialogOpener = pushDialogOpener;
    this._mergeDialogOpener = mergeDialogOpener;
    this._newBranchDialogOpener = newBranchDialogOpener;
    this._rebaseDialogOpener = rebaseDialogOpener;
  }

  /**
   * Late-bind the conflict resolution service. Used when the service isn't
   * available at construction time (e.g. existing wiring that hasn't been
   * updated yet). Safe no-op for duplicate calls.
   */
  setConflictResolutionService(service: IConflictResolutionService): void {
    this._conflictResolutionService = service;
  }

  /**
   * Late-bind the Branch Comparison View — constructed AFTER this commands
   * class in the activate() sequence, mirroring
   * {@link CommitContextMenuCommands.setBranchComparisonView}. Compare With
   * Current routes through it; without it the summary toast remains as the
   * fallback.
   */
  setBranchComparisonView(view: BranchComparisonView): void {
    this._branchComparisonView = view;
  }

  /**
   * Open the Resolve Conflicts dialog for conflicts produced by the given op.
   * No-op if the conflict resolution service hasn't been wired in (legacy
   * callers that haven't migrated).
   *
   * The operation union includes `'pull'` (pull-using-rebase maps
   * to `'rebase'`, pull-using-merge maps to `'merge'`) so Pull Dialog and
   * branch-menu pull handlers share this helper with the existing
   * merge/rebase/cherryPick/revert callers.
   */
  private async _openResolveConflictsDialog(
    repo: IRepository,
    conflicts: string[],
    opContext: {
      operation: 'merge' | 'rebase' | 'cherryPick' | 'revert';
      target?: string;
      /**
       * Whether a rebase is still in progress. When `false` (an
       * `--autostash` pop conflict after the rebase already finished) the
       * continue/abort affordances are suppressed — `git rebase
       * --continue`/`--abort` would dead-end on "no rebase in progress" — and
       * the dialog offers resolve-and-stage only. Defaults to `true` for the
       * mid-rebase / merge / cherry-pick / revert callers.
       */
      rebaseInProgress?: boolean;
    }
  ): Promise<void> {
    if (!this._conflictResolutionService || conflicts.length === 0) {
      return;
    }
    const continuable = opContext.rebaseInProgress !== false;
    await this._conflictResolutionService.openResolveConflictsDialog(
      repo,
      conflicts.map((p) => ({ path: p, resolved: false })),
      {
        operation: opContext.operation,
        target: opContext.target,
        canAbort: continuable,
        canContinue: continuable,
      }
    );
  }

  /**
   * Surface a rebase conflict result, routing by continuability.
   *
   * A continuable mid-rebase conflict opens the Resolve Conflicts dialog with
   * the continue/abort affordances (falling back to a "resolve conflicts"
   * warning when the dialog isn't wired). A non-continuable conflict — an
   * `--autostash` pop conflict surfaced after the rebase already finished —
   * opens the same dialog WITHOUT continue/abort (`git rebase
   * --continue`/`--abort` would dead-end on "no rebase in progress") and the
   * fallback warning instead tells the user to resolve and `git add` the
   * files, since the rebase is already complete.
   */
  private async _surfaceRebaseConflicts(
    repo: IRepository,
    conflicts: string[],
    target: string,
    rebaseInProgress: boolean | undefined
  ): Promise<void> {
    if (this._conflictResolutionService) {
      await this._openResolveConflictsDialog(repo, conflicts, {
        operation: 'rebase',
        target,
        rebaseInProgress,
      });
      return;
    }
    if (rebaseInProgress === false) {
      void vscode.window.showWarningMessage(
        `Rebase onto '${target}' succeeded, but re-applying your stashed changes ` +
          `conflicted in ${conflicts.length} file(s). Resolve them and \`git add\` them. ` +
          `Do not continue or abort — the rebase is already complete.`
      );
      return;
    }
    void vscode.window.showWarningMessage(
      `Rebase conflicts in ${conflicts.length} file(s). Please resolve conflicts.`
    );
  }

  /**
   * Deps the worktree action module reaches back into the dispatcher for.
   * `gitService`/`branchTreeProvider` are constructor-stable, so a snapshot is
   * live; `getRepository`/`resolveRepository` stay on the class.
   */
  private _worktreeContext(): IBranchWorktreeContext {
    return {
      gitService: this._gitService,
      branchTreeProvider: this._branchTreeProvider,
      resolveRepository: (item) => this._resolveRepository(item),
    };
  }

  private _handleNewWorktree(item?: BranchTreeItem): Promise<void> {
    return handleNewWorktree(this._worktreeContext(), item);
  }

  /**
   * Register all branch context menu commands.
   *
   * @param context - The VS Code extension context
   */
  register(context: vscode.ExtensionContext): void {
    // Local branch commands
    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.branch.checkout',
        failureTitle: 'Failed to check out',
        accepts: ['branch', 'detached'],
        run: (args) => this._handleCheckout(args),
      })
    );

    this._disposables.push(
      // spine-exempt: itemless dialog opener (New Branch works from any context)
      registerLoggedCommand('intellig.branch.new', () => this._handleNewBranch())
    );
    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.branch.newBranchFrom',
        failureTitle: 'Failed to create branch',
        accepts: ['branch', 'tag', 'detached'],
        run: (args) => this._handleNewBranchFrom(args),
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.branch.mergeIntoCurrent',
        failureTitle: 'Failed to merge',
        accepts: ['branch'],
        run: (args) => this._handleMergeIntoCurrent(args),
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.branch.rebaseCurrentOnto',
        failureTitle: 'Failed to rebase',
        accepts: ['branch'],
        run: (args) => this._handleRebaseCurrentOnto(args),
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.branch.compareWithCurrent',
        failureTitle: 'Failed to compare branches',
        accepts: ['branch'],
        run: async ({ repo, target }) => {
          const currentBranch = repo.head?.name?.replace('refs/heads/', '') || 'HEAD';

          // GitCompareWithBranchAction opens a comparison surface, not a
          // notification — route through the Branch Comparison View (shared
          // with the commit menu's Compare with Branch…). The summary toast
          // remains only as the no-view fallback (legacy wiring / tests).
          if (this._branchComparisonView) {
            await this._branchComparisonView.show(repo, currentBranch, target.branch.name);
            return;
          }

          const comparison = await this._gitService.compareBranches(
            repo,
            currentBranch,
            target.branch.name
          );

          // Single line — VS Code notifications collapse newlines.
          void vscode.window.showInformationMessage(
            `Comparing ${currentBranch} with ${target.branch.name}: ` +
              `${comparison.aheadCount} commit(s) ahead · ` +
              `${comparison.behindCount} commit(s) behind · ` +
              `${comparison.changedFiles.length} file(s) changed`
          );
        },
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.branch.rename',
        failureTitle: 'Failed to rename branch',
        accepts: ['branch'],
        refreshOnSuccess: true,
        run: async ({ repo, target }) => {
          const oldName = target.branch.name;
          const newName = await vscode.window.showInputBox({
            prompt: `Rename branch '${oldName}' to:`,
            value: oldName,
            validateInput: (value) => {
              if (!value || !value.trim()) {
                return 'Branch name cannot be empty';
              }
              if (value === oldName) {
                return 'New name must be different';
              }
              // Reject leading `-` (git interprets as a CLI flag) and leading
              // `.` (git-check-ref-format) at the validator level, not just at
              // the service boundary.
              if (!/^(?![-.])[\w\-./]+$/.test(value)) {
                return 'Branch name contains invalid characters';
              }
              return undefined;
            },
          });
          if (!newName) {
            return;
          }
          await this._gitService.renameBranch(repo, oldName, newName).match(
            () => undefined,
            (e) => {
              throw e;
            }
          );
          // Rename may have updated `repo.head.name` (if renaming the current
          // branch); reload before the spine's refresh.
          await this._gitService.reloadRepository(repo);
          void vscode.window.showInformationMessage(`Renamed branch to '${newName}'`);
        },
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.branch.delete',
        failureTitle: 'Failed to delete branch',
        accepts: ['branch'],
        run: (args) => this._handleDelete(args),
      })
    );

    // Remote branch commands
    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.remoteBranch.checkoutAsLocal',
        failureTitle: 'Failed to checkout branch',
        accepts: ['branch'],
        run: (args) => this._handleCheckoutAsLocal(args),
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.remoteBranch.cherryPickCommits',
        failureTitle: 'Failed to cherry-pick',
        accepts: ['branch'],
        run: (args) => this._handleCherryPickCommits(args),
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.remoteBranch.pullIntoCurrent',
        failureTitle: 'Failed to pull',
        accepts: ['branch'],
        run: (args) => this._runPullFromBranchMenu(args, 'merge'),
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.remoteBranch.deleteRemote',
        failureTitle: 'Failed to delete remote branch',
        accepts: ['branch'],
        run: (args) => this._handleDeleteRemote(args),
      })
    );

    // Track Remote Branch single-entry smart-detect.
    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.remoteBranch.trackBranch',
        failureTitle: 'Failed to track branch',
        accepts: ['branch'],
        run: (args) => this._handleTrackRemote(args),
      })
    );

    // New command handlers
    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.branch.update',
        failureTitle: 'Failed to update branch',
        accepts: ['branch'],
        run: (args) => this._handleUpdate(args),
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.branch.updateSelected',
        failureTitle: 'Failed to update branch',
        accepts: ['branch'],
        run: (args) => this._handleUpdateSelected(args),
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.branch.push',
        failureTitle: 'Failed to push',
        accepts: ['branch'],
        run: (args) => this._handlePush(args),
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.branch.showDiffWithWorkingTree',
        failureTitle: 'Failed to show diff',
        accepts: ['branch'],
        run: (args) => this._handleShowDiffWithWorkingTree(args),
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.branch.checkoutAndRebase',
        failureTitle: 'Failed to checkout and rebase',
        accepts: ['branch'],
        run: (args) => this._handleCheckoutAndRebase(args),
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.remoteBranch.pullUsingRebase',
        failureTitle: 'Failed to pull',
        accepts: ['branch'],
        run: (args) => this._runPullFromBranchMenu(args, 'rebase'),
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.remoteBranch.pullUsingMerge',
        failureTitle: 'Failed to pull',
        accepts: ['branch'],
        run: (args) => this._runPullFromBranchMenu(args, 'merge'),
      })
    );

    // Tag commands
    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.tag.checkoutDetached',
        failureTitle: 'Failed to check out tag',
        accepts: ['tag'],
        run: (args) => this._handleTagCheckoutDetached(args),
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.tag.newBranchFrom',
        failureTitle: 'Failed to create branch',
        accepts: ['tag'],
        run: (args) => this._handleNewBranchFrom(args),
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.tag.cherryPick',
        failureTitle: 'Failed to cherry-pick tag',
        accepts: ['tag'],
        run: (args) => this._handleTagCherryPick(args),
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.tag.mergeIntoCurrent',
        failureTitle: 'Failed to merge tag',
        accepts: ['tag'],
        run: (args) => this._handleTagMergeIntoCurrent(args),
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.tag.delete',
        failureTitle: 'Failed to delete tag',
        accepts: ['tag'],
        refreshOnSuccess: true,
        run: async ({ repo, target, batch }) => {
          if (batch.length > 1) {
            return this._handleTagDeleteBatch(batch);
          }
          const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to delete the tag '${target.tag.name}'?`,
            { modal: true },
            'Delete'
          );
          if (confirm !== 'Delete') {
            return;
          }
          await this._gitService.deleteTag(repo, target.tag.name).match(
            () => undefined,
            (e) => {
              throw e;
            }
          );
          // Tag list changed; reload so the tree's tags section reflects the
          // post-deletion ref set before the spine's refresh.
          await this._gitService.reloadRepository(repo);
          // Fire-and-forget: the success toast + optional remote-delete action
          // must not hold the command (and its refresh) pending on the toast.
          void this._offerRemoteDeleteForLocalTags([{ repo, name: target.tag.name }]);
        },
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.tag.push',
        failureTitle: 'Failed to push tag',
        accepts: ['tag'],
        run: (args) => this._handleTagPush(args),
      })
    );

    this._disposables.push(
      registerTreeItemCommand(this._treeItemDeps(), {
        id: 'intellig.tag.deleteRemote',
        failureTitle: 'Failed to delete tag on remote',
        accepts: ['tag'],
        run: (args) => this._handleTagDeleteRemote(args),
      })
    );

    // Worktree commands
    this._disposables.push(
      // spine-exempt: deliberately usable without a tree target (worktree ref falls back to HEAD)
      registerLoggedCommand('intellig.branch.newWorktree', (item?: BranchTreeItem) =>
        this._handleNewWorktree(item)
      )
    );
    this._disposables.push(
      // spine-exempt: repo-scope picker; the clicked row only names the repository
      registerLoggedCommand('intellig.branch.openWorktree', (i?: BranchTreeItem) =>
        handleOpenWorktree(this._worktreeContext(), i)
      )
    );
    this._disposables.push(
      // spine-exempt: repo-scope picker; the clicked row only names the repository
      registerLoggedCommand('intellig.branch.removeWorktree', (i?: BranchTreeItem) =>
        handleRemoveWorktree(this._worktreeContext(), i)
      )
    );

    // Refresh command
    this._disposables.push(
      // spine-exempt: provider-only view refresh; needs no target or repo
      registerLoggedCommand('intellig.branches.refresh', () => this._branchTreeProvider.refresh())
    );

    // Add all disposables to context
    context.subscriptions.push(...this._disposables);
  }

  /**
   * Get the current repository.
   */
  /**
   * Tree-item spine deps (see {@link registerTreeItemCommand}): the tree's
   * current repo as the fallback for items that don't carry one, and the
   * tree refresh for `refreshOnSuccess` specs.
   */
  private _treeItemDeps(): ITreeItemCommandDeps {
    return {
      getRepository: () => this._getRepository(),
      refresh: () => this._branchTreeProvider.refresh(),
    };
  }

  private _getRepository(): IRepository | undefined {
    return this._branchTreeProvider.getRepository();
  }

  /**
   * Resolve the repository a context-menu action targets. The clicked tree
   * leaf carries its owning repository — every branch/remote leaf is tagged
   * with the repo whose node it hangs under — so a colliding name (e.g.
   * `main`, present in every repo of a multi-root workspace) drives the git
   * op against the RIGHT repo. Falls back to the tree's current repository
   * for palette invocations, where no item is supplied.
   */
  private _resolveRepository(item?: BranchTreeItem): IRepository | undefined {
    return item?.repository ?? this._getRepository();
  }

  // ============================================
  // Shared error-handling helpers
  // ============================================

  private _checkoutContext(): IBranchCheckoutContext {
    return {
      gitService: this._gitService,
      branchTreeProvider: this._branchTreeProvider,
      conflictResolutionService: () => this._conflictResolutionService,
      surfaceRebaseConflicts: (repo, conflicts, target, canContinue) =>
        this._surfaceRebaseConflicts(repo, conflicts, target, canContinue),
    };
  }

  private _handleCheckout(args: ITreeItemRunArgs<'branch' | 'detached'>): Promise<void> {
    return handleCheckout(this._checkoutContext(), args);
  }

  private _handleCheckoutAndRebase(args: ITreeItemRunArgs<'branch'>): Promise<void> {
    return handleCheckoutAndRebase(this._checkoutContext(), args);
  }

  private _handleCheckoutAsLocal(args: ITreeItemRunArgs<'branch'>): Promise<void> {
    return handleCheckoutAsLocal(this._checkoutContext(), args);
  }

  private _mergeRebaseContext(): IBranchMergeRebaseContext {
    return {
      gitService: this._gitService,
      branchTreeProvider: this._branchTreeProvider,
      mergeDialogOpener: this._mergeDialogOpener,
      rebaseDialogOpener: this._rebaseDialogOpener,
      conflictResolutionService: () => this._conflictResolutionService,
      openResolveConflictsDialog: (repo, conflicts, opContext) =>
        this._openResolveConflictsDialog(repo, conflicts, opContext),
      surfaceRebaseConflicts: (repo, conflicts, target, canContinue) =>
        this._surfaceRebaseConflicts(repo, conflicts, target, canContinue),
    };
  }

  private _handleMergeIntoCurrent(args: ITreeItemRunArgs<'branch'>): Promise<void> {
    return handleMergeIntoCurrent(this._mergeRebaseContext(), args);
  }

  private _handleRebaseCurrentOnto(args: ITreeItemRunArgs<'branch'>): Promise<void> {
    return handleRebaseCurrentOnto(this._mergeRebaseContext(), args);
  }

  private _createContext(): IBranchCreateContext {
    return {
      gitService: this._gitService,
      branchTreeProvider: this._branchTreeProvider,
      newBranchDialogOpener: this._newBranchDialogOpener,
      getRepository: () => this._getRepository(),
    };
  }

  private _handleNewBranch(): void {
    handleNewBranch(this._createContext());
  }

  private _handleNewBranchFrom(args: { repo: IRepository; target: TreeItemTarget }): Promise<void> {
    return handleNewBranchFrom(this._createContext(), args);
  }

  private _deleteContext(): IBranchDeleteContext {
    return {
      gitService: this._gitService,
      branchTreeProvider: this._branchTreeProvider,
    };
  }

  private _handleDelete(args: ITreeItemRunArgs<'branch'>): Promise<void> {
    return handleDelete(this._deleteContext(), args);
  }

  // ============================================
  // New Command Handlers
  // ============================================

  private _updateContext(): IBranchUpdateContext {
    return {
      gitService: this._gitService,
      branchTreeProvider: this._branchTreeProvider,
      routePullConflicts: (repo, operation, target) =>
        this._routePullConflicts(repo, operation, target),
    };
  }

  private _handleUpdate(args: ITreeItemRunArgs<'branch'>): Promise<void> {
    return handleUpdate(this._updateContext(), args);
  }

  private _handleUpdateSelected(args: ITreeItemRunArgs<'branch'>): Promise<void> {
    return handleUpdateSelected(this._updateContext(), args);
  }

  /**
   * After a failed pull, probe the working tree for unresolved conflicts and
   * hand off to the Resolve Conflicts dialog when any are present. Returns
   * whether the dialog took over (callers suppress their generic error toast
   * then). A probe failure is logged and treated as "no conflicts" so it
   * never swallows the original pull error.
   */
  private async _routePullConflicts(
    repo: IRepository,
    operation: 'merge' | 'rebase',
    target: string
  ): Promise<boolean> {
    if (!this._conflictResolutionService) {
      return false;
    }
    try {
      const conflicts = await this._conflictResolutionService.getConflictedFiles(repo);
      if (conflicts.length === 0) {
        return false;
      }
      await this._openResolveConflictsDialog(
        repo,
        conflicts.map((c) => c.path),
        { operation, target }
      );
      // The pull may have partially advanced HEAD before the conflict;
      // reload so the tree reflects the post-conflict state.
      await this._gitService.reloadRepository(repo);
      this._branchTreeProvider.refresh();
      return true;
    } catch (probeError) {
      // Do NOT toast the probe failure itself — the caller's generic error
      // is the one the user cares about. Keep the probe error in the log.
      getLogger()
        .child({ component: 'BranchContextMenuCommands' })
        .warn('pull conflict probe failed', {
          probeError: probeError instanceof Error ? probeError.message : String(probeError),
        });
      return false;
    }
  }

  private _pushContext(): IBranchPushContext {
    return {
      gitService: this._gitService,
      branchTreeProvider: this._branchTreeProvider,
      pushDialogOpener: this._pushDialogOpener,
    };
  }

  private _handlePush(args: ITreeItemRunArgs<'branch'>): Promise<void> {
    return handlePush(this._pushContext(), args);
  }

  private _diffContext(): IBranchDiffContext {
    return { gitService: this._gitService };
  }

  private _handleShowDiffWithWorkingTree(args: ITreeItemRunArgs<'branch'>): Promise<void> {
    return handleShowDiffWithWorkingTree(this._diffContext(), args);
  }

  private _runPullFromBranchMenu(
    args: ITreeItemRunArgs<'branch'>,
    preset: 'rebase' | 'merge'
  ): Promise<void> {
    return runPullFromBranchMenu(this._updateContext(), args, preset);
  }

  // ============================================
  // Remote Branch Command Handlers
  // ============================================

  private _cherryPickContext(): IBranchCherryPickContext {
    return {
      gitService: this._gitService,
      branchTreeProvider: this._branchTreeProvider,
      conflictResolutionService: () => this._conflictResolutionService,
      openResolveConflictsDialog: (repo, conflicts, opContext) =>
        this._openResolveConflictsDialog(repo, conflicts, opContext),
    };
  }

  private _handleCherryPickCommits(args: ITreeItemRunArgs<'branch'>): Promise<void> {
    return handleCherryPickCommits(this._cherryPickContext(), args);
  }

  /**
   * Deps the remote-branch action module reaches back into the dispatcher for.
   * gitService/branchTreeProvider are constructor-stable snapshots.
   */
  private _remoteContext(): IBranchRemoteContext {
    return {
      gitService: this._gitService,
      branchTreeProvider: this._branchTreeProvider,
    };
  }

  private _handleDeleteRemote(args: ITreeItemRunArgs<'branch'>): Promise<void> {
    return handleDeleteRemote(this._remoteContext(), args);
  }

  private _handleTrackRemote(args: ITreeItemRunArgs<'branch'>): Promise<void> {
    return handleTrackRemote(this._remoteContext(), args);
  }

  // ============================================
  // Tag Command Handlers
  // ============================================

  /**
   * Deps the tag action module reaches back into the dispatcher for.
   * gitService/branchTreeProvider/mergeDialogOpener are constructor-stable
   * snapshots; the setter-wired conflict service is a call-time getter; the
   * conflict-dialog seam stays on the dispatcher and is reached via a lambda.
   */
  private _tagContext(): IBranchTagContext {
    return {
      gitService: this._gitService,
      branchTreeProvider: this._branchTreeProvider,
      mergeDialogOpener: this._mergeDialogOpener,
      conflictResolutionService: () => this._conflictResolutionService,
      openResolveConflictsDialog: (repo, conflicts, opContext) =>
        this._openResolveConflictsDialog(repo, conflicts, opContext),
    };
  }

  private _handleTagCheckoutDetached(args: ITreeItemRunArgs<'tag'>): Promise<void> {
    return handleTagCheckoutDetached(this._tagContext(), args);
  }

  private _handleTagCherryPick(args: ITreeItemRunArgs<'tag'>): Promise<void> {
    return handleTagCherryPick(this._tagContext(), args);
  }

  private _handleTagMergeIntoCurrent(args: ITreeItemRunArgs<'tag'>): Promise<void> {
    return handleTagMergeIntoCurrent(this._tagContext(), args);
  }

  private _handleTagDeleteBatch(batch: ReadonlyArray<ITreeItemBatchEntry<'tag'>>): Promise<void> {
    return handleTagDeleteBatch(this._tagContext(), batch);
  }

  private _handleTagPush(args: ITreeItemRunArgs<'tag'>): Promise<void> {
    return handleTagPush(this._tagContext(), args);
  }

  private _handleTagDeleteRemote(args: ITreeItemRunArgs<'tag'>): Promise<void> {
    return handleTagDeleteRemote(this._tagContext(), args);
  }

  private _offerRemoteDeleteForLocalTags(
    deleted: ReadonlyArray<{ repo: IRepository; name: string }>
  ): Promise<void> {
    return offerRemoteDeleteForLocalTags(this._tagContext(), deleted);
  }

  /**
   * Dispose of resources.
   */
  dispose(): void {
    for (const disposable of this._disposables) {
      disposable.dispose();
    }
    this._disposables = [];
  }
}

/**
 * Create a new BranchContextMenuCommands instance.
 *
 * @param gitService - The Git service to use
 * @param branchTreeProvider - The branch tree provider
 * @returns A new BranchContextMenuCommands instance
 */
export function createBranchContextMenuCommands(
  gitService: IGitService,
  branchTreeProvider: BranchTreeProvider,
  conflictResolutionService?: IConflictResolutionService,
  pushDialogOpener?: PushDialogOpener,
  mergeDialogOpener?: MergeDialogOpener,
  newBranchDialogOpener?: NewBranchDialogOpener,
  rebaseDialogOpener?: RebaseDialogOpener
): BranchContextMenuCommands {
  return new BranchContextMenuCommands(
    gitService,
    branchTreeProvider,
    conflictResolutionService,
    pushDialogOpener,
    mergeDialogOpener,
    newBranchDialogOpener,
    rebaseDialogOpener
  );
}
