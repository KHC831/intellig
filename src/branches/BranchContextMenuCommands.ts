/**
 * Branch Context Menu Commands implementation.
 * Provides command handlers for branch, remote branch, and tag context menus.
 */

import * as vscode from 'vscode';
import {
  IBranch,
  IGitService,
  IRemote,
  IRepository,
  IUpstream,
} from '../git-core/interfaces/IGitService';
import { BranchTreeItem, BranchTreeProvider } from './BranchTreeProvider';
import { getIncomingOutgoingFetcher } from './BranchPopup';
import { IConflictResolutionService } from '../conflicts/interfaces/IConflictResolutionService';
import type { PullDialog } from '../sync/PullDialog';
import type { PushDialog, IPushPreselect } from '../sync/PushDialog';
import type { MergeDialog } from '../conflicts/MergeDialog';
import type { RebaseDialog } from '../rebase/RebaseDialog';
import type { NewBranchDialog } from './NewBranchDialog';
import { sanitizeGitError, worktreeConflictMessage } from '../git-core/gitError';
import {
  looksLikeConflictText,
  isLocalChangesWouldBeOverwritten,
  parseUntrackedOverwriteFiles,
} from '../git-core/gitProse';
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
import {
  cherryPickSuffixOptions,
  handleCherryPickCommits,
  type IBranchCherryPickContext,
} from './branchCherryPickActions';
import {
  handleDeleteRemote,
  handleTrackRemote,
  type IBranchRemoteContext,
} from './branchRemoteActions';
import { handleDelete, type IBranchDeleteContext } from './branchDeleteActions';
import { buildUpdatePullOptions, resolveUpdateRebase } from '../sync/updateProject';
import { readConfig } from '../config/configKeys';
import { isProtectedTarget } from '../sync/PushDialog';
import { proposeDeleteMergedBranch } from './deleteOnMerge';
import type { BranchComparisonView } from './BranchComparisonView';

/** Thunk that lazily returns the shared {@link PullDialog} singleton. */
export type PullDialogAccessor = () => PullDialog | undefined;

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
 * One selected local branch fed to {@link planAlignLocal}, carrying just the
 * facts the FF-vs-skip decision needs: whether it is checked out, its tracking
 * upstream, and its incoming/outgoing counts relative to that upstream.
 */
export interface IAlignLocalBranchInput {
  /** Local branch short name (e.g. `main`, `feature/x`). */
  name: string;
  /** True when this is the repository's checked-out branch. */
  isCurrent: boolean;
  /** Tracking upstream, or undefined when the branch tracks nothing. */
  upstream?: IUpstream;
  /** Commits the upstream has that the local branch lacks (git "behind"). */
  incoming: number;
  /** Local commits the upstream lacks (git "ahead"). */
  outgoing: number;
}

/** A fast-forward fetch the align-local action will run for one branch. */
export interface IAlignLocalFetch {
  /** Local branch being advanced. */
  branch: string;
  /** Remote to fetch from (the upstream's remote). */
  remote: string;
  /** `<remoteRef>:<localRef>` refspec — fetch FFs the local ref or refuses. */
  refspec: string;
}

/** Outcome of classifying a selection of local branches for align-local. */
export interface IAlignLocalPlan {
  /** Branches that are behind-only and will be fast-forwarded. */
  fetches: IAlignLocalFetch[];
  /** Branches we won't touch, with a user-facing reason. */
  skipped: { branch: string; reason: string }[];
  /** Branches already in sync with their upstream — nothing to do. */
  upToDate: string[];
}

/**
 * Classify selected local branches into fast-forward / skip / up-to-date
 * buckets for the align-local "Update Selected" action.
 *
 * Mirrors git4idea's GitBranchActionsUtil.updateBranches: every NON-current
 * tracking branch is fast-forwarded via a `<remoteRef>:<localRef>` fetch
 * refspec (`GitFetchSpec(repo, remote, "$remoteBranch:$localBranch")`), and
 * the action only ever fast-forwards — a diverged branch is left alone. We
 * decide FF-ability from the incoming/outgoing counts (behind-only ⇒ FF-able;
 * any outgoing ⇒ diverged) so we never even attempt a non-FF fetch, rather
 * than relying on git to refuse it.
 *
 * Skip reasons:
 * - no upstream configured.
 * - checked-out current branch — FF into a checked-out ref is refused. This
 *   is planner-level defense only: the Update / Update Selected handlers
 *   route the current branch to a full integration
 *   (`_updateCurrentBranch`, GitUpdateExecutionProcess parity) before ever
 *   consulting this planner.
 * - diverged (has outgoing commits) — not a fast-forward.
 *
 * The refspec joins user-controlled ref names; callers MUST splice it through
 * `buildGitArgs` (the fetch op does) so it can never be parsed as a git flag.
 */
export function planAlignLocal(inputs: IAlignLocalBranchInput[]): IAlignLocalPlan {
  const plan: IAlignLocalPlan = { fetches: [], skipped: [], upToDate: [] };

  for (const input of inputs) {
    if (!input.upstream) {
      plan.skipped.push({ branch: input.name, reason: 'no upstream configured' });
      continue;
    }
    if (input.isCurrent) {
      plan.skipped.push({
        branch: input.name,
        reason: 'checked out — use Update/Pull to advance the current branch',
      });
      continue;
    }
    if (input.outgoing > 0) {
      plan.skipped.push({
        branch: input.name,
        reason: 'diverged from upstream — not fast-forwardable',
      });
      continue;
    }
    if (input.incoming === 0) {
      plan.upToDate.push(input.name);
      continue;
    }
    plan.fetches.push({
      branch: input.name,
      remote: input.upstream.remote,
      refspec: `${input.upstream.name}:${input.name}`,
    });
  }

  return plan;
}

/**
 * Branch Context Menu Commands class.
 * Registers and handles all branch-related context menu commands.
 */
export class BranchContextMenuCommands {
  private _gitService: IGitService;
  private _branchTreeProvider: BranchTreeProvider;
  private _conflictResolutionService: IConflictResolutionService | undefined;
  private _pullDialogAccessor?: PullDialogAccessor;
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
    pullDialogAccessor?: PullDialogAccessor,
    pushDialogOpener?: PushDialogOpener,
    mergeDialogOpener?: MergeDialogOpener,
    newBranchDialogOpener?: NewBranchDialogOpener,
    rebaseDialogOpener?: RebaseDialogOpener
  ) {
    this._gitService = gitService;
    this._branchTreeProvider = branchTreeProvider;
    this._conflictResolutionService = conflictResolutionService;
    this._pullDialogAccessor = pullDialogAccessor;
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
      getRepository: () => this._getRepository(),
      resolveRepository: (item) => this._resolveRepository(item),
    };
  }

  private _handleNewWorktree(item?: BranchTreeItem): Promise<void> {
    return handleNewWorktree(this._worktreeContext(), item);
  }

  private _handleOpenWorktree(): Promise<void> {
    return handleOpenWorktree(this._worktreeContext());
  }

  private _handleRemoveWorktree(): Promise<void> {
    return handleRemoveWorktree(this._worktreeContext());
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
      // spine-exempt: itemless repo-scope picker (lists worktrees, no tree target)
      registerLoggedCommand('intellig.branch.openWorktree', () => this._handleOpenWorktree())
    );
    this._disposables.push(
      // spine-exempt: itemless repo-scope picker (lists worktrees, no tree target)
      registerLoggedCommand('intellig.branch.removeWorktree', () => this._handleRemoveWorktree())
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

  /**
   * Handle the outer dirty-working-tree checkout error pattern.
   *
   * Four cases:
   * - Worktree conflict (git refuses atomically) → shows a targeted error,
   *   returns `null` (caller must not show a second error).
   * - UNTRACKED files would be overwritten → fatal error naming the files,
   *   returns `null`. No Stash & Switch: the stash has no
   *   `--include-untracked`, so a stash-and-retry fails on the same files
   *   (git4idea treats this arm as fatal, GitCheckoutOperation.java:187-190).
   * - TRACKED dirty tree (`would be overwritten` / `Please commit`) → shows
   *   the Stash & Switch / Force Checkout / Cancel dialog, returns the
   *   user's choice or `null` on Cancel.
   * - Any other error → shows `fallbackError` and returns `null`.
   *
   * Callers act on the returned choice and provide their own
   * branch-specific stash/force logic.
   */
  private async _handleDirtyTreeError(
    errorMessage: string,
    dirtyHeader: string,
    fallbackError: string
  ): Promise<'Stash & Switch' | 'Force Checkout' | null> {
    const worktreeMessage = worktreeConflictMessage(errorMessage);
    if (worktreeMessage) {
      void vscode.window.showErrorMessage(worktreeMessage);
      return null;
    }
    const untracked = parseUntrackedOverwriteFiles(errorMessage);
    if (untracked) {
      void vscode.window.showErrorMessage(
        `Untracked working tree files would be overwritten: ${untracked.join(', ')}. ` +
          `Move or remove them, then retry.`
      );
      return null;
    }
    if (isLocalChangesWouldBeOverwritten(errorMessage)) {
      const choice = await vscode.window.showWarningMessage(
        dirtyHeader,
        'Stash & Switch',
        'Force Checkout',
        'Cancel'
      );
      if (choice === 'Stash & Switch' || choice === 'Force Checkout') {
        return choice as 'Stash & Switch' | 'Force Checkout';
      }
      return null;
    }
    void vscode.window.showErrorMessage(fallbackError);
    return null;
  }

  /**
   * Restore ("pop") the auto-stash created by a Stash & Switch / Stash and
   * reset flow after the checkout landed — git4idea's Smart Checkout is
   * stash → checkout → UNSTASH; stopping after the checkout silently parks
   * the user's changes in the stash.
   *
   * A pop that conflicts with the switched-to branch routes into the
   * Resolve Conflicts flow as an `unstash` (same handoff StashView uses, so
   * ours/theirs reversal is correct); any other failure keeps the changes
   * safely in the stash and says so.
   *
   * @returns `'restored'` on a clean pop, `'conflict-routed'` when the
   *   Resolve Conflicts dialog took over, `'failed'` when the changes stay
   *   parked in the stash (already surfaced to the user).
   */
  private async _restoreStashAfterSwitch(
    repo: IRepository,
    stashSha?: string
  ): Promise<'restored' | 'conflict-routed' | 'failed'> {
    // Resolve the CREATED entry's current position first — `stash@{0}` is not
    // stable between the push and this pop (an autostash, a concurrent flow
    // or the user can push another entry, renumbering the stack), and popping
    // the head blindly applies the WRONG stash. `stashSha` is captured right
    // after the push; a legacy no-hash listing falls back to the head.
    let index = 0;
    if (stashSha !== undefined) {
      const entries = await this._gitService.stashList(repo);
      const entry = entries.find((e) => e.hash === stashSha);
      if (!entry) {
        void vscode.window.showWarningMessage(
          'Switched, but the auto-stash created for this checkout is no longer in the stash ' +
            'list — your changes were not restored.'
        );
        return 'failed';
      }
      index = entry.index;
    }
    try {
      // Explicit --index: this pops the extension's OWN auto-stash, so the
      // exact staged/unstaged split it captured must come back.
      await this._gitService.stashPop(repo, index, true).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      return 'restored';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this._conflictResolutionService && looksLikeConflictText(message)) {
        const conflicts = await this._conflictResolutionService.getConflictedFiles(repo);
        if (conflicts.length > 0) {
          await this._conflictResolutionService.openResolveConflictsDialog(repo, conflicts, {
            operation: 'unstash',
            target: `stash@{${index}}`,
            canAbort: true,
            canContinue: true,
          });
          return 'conflict-routed';
        }
      }
      void vscode.window.showWarningMessage(
        `Switched, but restoring your stashed changes failed: ${sanitizeGitError(message)}. ` +
          `They remain in the stash list.`
      );
      return 'failed';
    }
  }

  /**
   * The sha of the most recently created stash entry, captured immediately
   * after a `stash push` so {@link _restoreStashAfterSwitch} can pop exactly
   * that entry later. `undefined` when the listing carries no hash (legacy
   * stash-list form) — the restore then falls back to the head.
   */
  private async _createdStashSha(repo: IRepository): Promise<string | undefined> {
    try {
      const entries = await this._gitService.stashList(repo);
      return entries[0]?.hash;
    } catch {
      return undefined;
    }
  }

  // ============================================
  // Local Branch Command Handlers
  // ============================================

  /**
   * Handle checkout command for local branches.
   */
  private async _handleCheckout({
    repo,
    target,
  }: ITreeItemRunArgs<'branch' | 'detached'>): Promise<void> {
    // Accept the detached row as a checkout target (the SHA rides on the
    // target). The git command runs uniformly (no early-return on "already
    // at that commit" — IntelliJ does the same; the dirty-working-tree
    // fallback flow handles errors). The toast branches: branch name vs
    // detached re-checkout.
    const branch = target.kind === 'branch' ? target.branch : undefined;
    const ref = branch?.name ?? (target.kind === 'detached' ? target.sha : undefined);
    if (!ref) {
      return;
    }
    const successToast = (): string =>
      branch
        ? `Switched to branch '${branch.name}'`
        : `Re-checked out detached HEAD at ${ref.substring(0, 7)}`;
    const dirtyHeader = (): string =>
      branch
        ? `Cannot switch to '${branch.name}': local changes would be overwritten.`
        : `Cannot re-checkout detached HEAD at ${ref.substring(0, 7)}: local changes would be overwritten.`;
    const stashLabel = (): string =>
      branch
        ? `Auto-stash before checkout ${branch.name}`
        : `Auto-stash before checkout ${ref.substring(0, 7)}`;
    const stashSuccessToast = (restored: boolean): string => {
      const target = branch
        ? `switched to '${branch.name}'`
        : `re-checked out detached HEAD at ${ref.substring(0, 7)}`;
      return restored
        ? `Stashed changes, ${target}, and restored them`
        : `Stashed changes and ${target}`;
    };
    const forceSuccessToast = (): string =>
      branch
        ? `Force switched to '${branch.name}'`
        : `Force re-checked out detached HEAD at ${ref.substring(0, 7)}`;

    try {
      await this._gitService.checkout(repo, ref).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      // Checkout moved HEAD; reload before refresh so the
      // BranchTreeProvider's "current branch" mark reflects fresh state.
      await this._gitService.reloadRepository(repo);
      void vscode.window.showInformationMessage(successToast());
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const choice = await this._handleDirtyTreeError(
        errorMessage,
        dirtyHeader(),
        `Failed to checkout branch: ${sanitizeGitError(errorMessage)}`
      );
      if (choice === 'Stash & Switch') {
        try {
          await this._gitService.stash(repo, stashLabel()).match(
            () => undefined,
            (e) => {
              throw e;
            }
          );
          const createdStashSha = await this._createdStashSha(repo);
          await this._gitService.checkout(repo, ref).match(
            () => undefined,
            (e) => {
              throw e;
            }
          );
          // Smart-checkout parity: restore the stash onto the new branch.
          const restore = await this._restoreStashAfterSwitch(repo, createdStashSha);
          // Stash + checkout (+ pop) moved HEAD; reload before refresh.
          await this._gitService.reloadRepository(repo);
          if (restore !== 'conflict-routed') {
            void vscode.window.showInformationMessage(stashSuccessToast(restore === 'restored'));
          }
          this._branchTreeProvider.refresh();
        } catch (stashError) {
          const stashMsg = stashError instanceof Error ? stashError.message : 'Unknown error';
          void vscode.window.showErrorMessage(
            `Failed to stash and checkout: ${sanitizeGitError(stashMsg)}`
          );
        }
      } else if (choice === 'Force Checkout') {
        try {
          await this._gitService.checkout(repo, ref, { force: true }).match(
            () => undefined,
            (e) => {
              throw e;
            }
          );
          // Force checkout moved HEAD; reload before refresh.
          await this._gitService.reloadRepository(repo);
          void vscode.window.showInformationMessage(forceSuccessToast());
          this._branchTreeProvider.refresh();
        } catch (forceError) {
          const forceMsg = forceError instanceof Error ? forceError.message : 'Unknown error';
          void vscode.window.showErrorMessage(
            `Failed to force checkout: ${sanitizeGitError(forceMsg)}`
          );
        }
      }
    }
  }

  /**
   * Handle the popup-header "New Branch" action — create a new branch starting
   * from the current HEAD (git4idea `Git.CreateNewBranch`). Routes through the
   * New Branch Dialog when wired; the dialog defaults its start point to HEAD
   * when none is supplied.
   */
  private _handleNewBranch(): void {
    const repo = this._getRepository();
    if (!repo) {
      void vscode.window.showErrorMessage('No Git repository found');
      return;
    }

    const startPoint = repo.head?.name?.replace('refs/heads/', '') || undefined;

    if (this._newBranchDialogOpener) {
      this._newBranchDialogOpener({ repo, startPoint });
      return;
    }

    void vscode.window.showErrorMessage('New Branch dialog is not available.');
  }

  /**
   * Handle new branch from here command.
   */
  private async _handleNewBranchFrom({
    repo,
    target,
  }: {
    repo: IRepository;
    target: TreeItemTarget;
  }): Promise<void> {
    // The start point is whatever was clicked: a branch name, a tag name,
    // or the detached row's 40-char SHA (never the parenthesized label).
    const startPoint =
      target.kind === 'branch'
        ? target.branch.name
        : target.kind === 'tag'
          ? target.tag.name
          : target.sha;
    if (!startPoint) {
      return;
    }

    // Route through the New Branch Dialog when the opener is wired.
    // Dialog handles name validation, tracking, overwrite, and checkout in a
    // single webview with typed options. Falls back to the old showInputBox
    // path when the opener is absent (test fixtures).
    if (this._newBranchDialogOpener) {
      this._newBranchDialogOpener({ repo, startPoint });
      return;
    }

    const branchName = await vscode.window.showInputBox({
      prompt: `Enter new branch name (from ${startPoint})`,
      placeHolder: 'feature/my-new-branch',
      validateInput: (value) => {
        if (!value || !value.trim()) {
          return 'Branch name cannot be empty';
        }
        // Reject leading `-` (git interprets as a CLI flag)
        // and leading `.` (git rejects refs starting with `.` per
        // git-check-ref-format) at the validator level. The
        // regex `^[\w\-./]+$` accepted `-foo` and `.hidden` because the
        // character class allowed `-` and `.` anywhere including the
        // first position; the service-boundary guard in
        // `GitService.createBranch` was the only line of defense.
        if (!/^(?![-.])[\w\-./]+$/.test(value)) {
          return 'Branch name contains invalid characters';
        }
        return undefined;
      },
    });

    if (!branchName) {
      return;
    }

    try {
      await this._gitService.createBranch(repo, branchName, startPoint).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      await this._gitService.checkout(repo, branchName).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      // createBranch + checkout pair moved HEAD; reload before refresh.
      await this._gitService.reloadRepository(repo);
      void vscode.window.showInformationMessage(
        `Created and switched to branch '${branchName}' from '${startPoint}'`
      );
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to create branch: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * Handle merge into current command.
   */
  private async _handleMergeIntoCurrent({
    repo,
    target,
  }: ITreeItemRunArgs<'branch'>): Promise<void> {
    // deleteOnMerge = PROPOSE for a non-protected local branch
    // (GitBranchPopupActions.java:287-291); tags route through
    // _handleTagMergeIntoCurrent and never propose.
    const proposeDeleteOnMerge =
      target.branch.type === 'local' &&
      !target.branch.isHead &&
      !isProtectedTarget(target.branch.name, readConfig('protectedBranches'));

    // Route through the Merge Dialog when the opener is wired; the
    // dialog handles options (ff-only / no-ff / squash / no-commit / -m),
    // conflict handoff, and the PROPOSE affordance itself. Fallback path
    // (no opener) preserves the legacy direct-merge behaviour for tests.
    if (this._mergeDialogOpener) {
      this._mergeDialogOpener({ repo, sourceBranch: target.branch.name, proposeDeleteOnMerge });
      return;
    }

    try {
      const result = await this._gitService.mergeBranch(repo, target.branch.name);

      if (result.success) {
        const successMessage = `Merged '${target.branch.name}' successfully`;
        if (proposeDeleteOnMerge) {
          // Fire-and-forget: the PROPOSE toast must not hold the command.
          void proposeDeleteMergedBranch(
            { gitService: this._gitService, onDeleted: () => this._branchTreeProvider.refresh() },
            repo,
            target.branch.name,
            successMessage
          );
        } else {
          void vscode.window.showInformationMessage(successMessage);
        }
      } else if (result.conflicts && result.conflicts.length > 0) {
        // Auto-open Resolve Conflicts dialog when wired; fall back
        // to a warning toast otherwise (legacy callers without the service).
        if (this._conflictResolutionService) {
          await this._openResolveConflictsDialog(repo, result.conflicts, {
            operation: 'merge',
            target: target.branch.name,
          });
        } else {
          void vscode.window.showWarningMessage(
            `Merge conflicts in ${result.conflicts.length} file(s). Please resolve conflicts.`
          );
        }
      } else {
        // Non-conflict failure (refused merge, unrelated histories, dirty
        // tree, etc.). Surface the underlying git error instead of a
        // silent no-op. `failureReason` is sanitized at the GitService
        // boundary; safe to drop straight into a toast.
        const reason = result.failureReason ?? 'unknown error (no output from git)';
        void vscode.window.showErrorMessage(
          `Failed to merge '${target.branch.name}': ${sanitizeGitError(reason)}`
        );
      }
      // Merge moved HEAD; reload before refresh.
      await this._gitService.reloadRepository(repo);
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to merge branch: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * Handle rebase current onto command.
   *
   * Rebases the current branch onto the right-clicked one without walling off
   * a dirty working tree: `rebaseBranch` passes `--autostash`, so git stashes
   * any uncommitted changes, replays, and re-applies them (IntelliJ
   * smart-stash parity). A clean rebase reports success with the changes
   * restored. An autostash-pop conflict — where re-applying the stash collides
   * with the rebased changes — is surfaced via the conflicts path with
   * `rebaseInProgress: false`, so the user resolves and `git add`s the files
   * (no continue/abort, since the rebase already completed). A genuine
   * non-conflict failure surfaces git's reason via a `failureReason` toast.
   *
   * After the rebase runs, the handler reloads the repo
   * and inspects `repo.inProgress` (populated from `readInProgressOperation`
   * via `loadRepository`). On a non-conflict failure that left an orphaned
   * `rebasing` state created by OUR invocation, it auto-aborts. When a
   * rebasing state remains for any other reason (e.g. paused on conflicts
   * with no Resolve Conflicts dialog wired), it surfaces an actionable
   * "rebase paused" warning. The before/after snapshot of
   * `inProgress.kind` ensures we never touch a rebase the user already had
   * in progress before they clicked.
   */
  private async _handleRebaseCurrentOnto({
    repo,
    target,
  }: ITreeItemRunArgs<'branch'>): Promise<void> {
    // Canonical surface: route through the unified Rebase dialog (onto =
    // the clicked branch, Interactive unchecked by default). The dialog owns
    // the same conflict + orphan-recovery handling ported from the inline
    // path below. The inline path remains the fallback when no opener is
    // wired (legacy construction / focused unit tests).
    if (this._rebaseDialogOpener) {
      await this._rebaseDialogOpener({
        repo,
        onto: target.branch.name,
        interactiveDefault: false,
      });
      return;
    }

    try {
      // No dirty-tree pre-check: rebaseBranch passes `--autostash`, so a dirty
      // tree is stashed and re-applied around the replay (IntelliJ smart-stash
      // parity). A clean rebase reports success with changes restored; an
      // autostash-pop conflict surfaces below via the conflicts path. Walling
      // off dirty trees here would block exactly what autostash handles.

      // Snapshot the in-progress operation BEFORE invoking the
      // rebase. This lets us distinguish a rebasing state that OUR call
      // created (eligible for auto-abort / pause-warning recovery) from one
      // the user already had paused before they clicked. `repo.inProgress`
      // is populated by `loadRepository` via `readInProgressOperation`
      // (see gitInProgress.ts); `kind` is the `IInProgressOperation` field.
      const beforeKind = repo.inProgress?.kind;

      const result = await this._gitService.rebaseBranch(repo, target.branch.name);

      // Track whether the Resolve Conflicts dialog was opened so we suppress
      // the redundant "rebase paused" warning for that same state —
      // the dialog is itself the actionable continue/abort UI.
      let conflictDialogOpened = false;
      // Track the non-conflict-failure branch so only it is eligible for
      // auto-abort of an orphaned rebase.
      let nonConflictFailure = false;

      if (result.success) {
        void vscode.window.showInformationMessage(
          `Rebased onto '${target.branch.name}' successfully`
        );
      } else if (result.conflicts && result.conflicts.length > 0) {
        // Auto-open Resolve Conflicts dialog when wired; fall back to a
        // warning toast otherwise. A non-continuable autostash-pop conflict
        // (rebaseInProgress === false) suppresses continue/abort.
        conflictDialogOpened = !!this._conflictResolutionService;
        await this._surfaceRebaseConflicts(
          repo,
          result.conflicts,
          target.branch.name,
          result.rebaseInProgress
        );
      } else {
        // Non-conflict failure (e.g. dirty tree, in-progress rebase, refs
        // out of sync, remote ref disappeared, etc.). Surface the underlying
        // git error so the user has SOMETHING to act on instead of a silent
        // no-op. `failureReason` is already sanitized at the GitService
        // boundary, but we re-pipe through `sanitizeGitError` here so the
        // safety contract is locally evident at the toast site
        // and survives any future refactor of the source side.
        nonConflictFailure = true;
        const reason = result.failureReason ?? 'unknown error (no output from git)';
        void vscode.window.showErrorMessage(
          `Failed to rebase onto '${target.branch.name}': ${sanitizeGitError(reason)}`
        );
      }

      // Rebase moved HEAD (or left an in-progress marker); reload before
      // refresh so the fresh `inProgress` state is read off disk.
      const reloaded = await this._gitService.reloadRepository(repo);
      const afterKind = (reloaded ?? repo).inProgress?.kind;

      if (nonConflictFailure && beforeKind !== 'rebasing' && afterKind === 'rebasing') {
        // Our non-conflict-failure invocation left an orphaned
        // rebasing state (`.git/rebase-merge/`). The user's mental model is
        // "I clicked rebase, it didn't work, it should be like I never
        // clicked it" — so auto-abort AFTER the error toast above. The
        // boundary is strict: only abort when the rebasing state did NOT
        // exist before our call. If the user already had a rebase paused,
        // `beforeKind === 'rebasing'` and we never touch it.
        try {
          // rebase-abort-exempt: orphaned-rebase recovery — non-conflict failure only; the before/after boundary above proves THIS invocation created the rebasing state
          await this._gitService.rebaseAbort(repo).match(
            () => undefined,
            (e) => {
              throw e;
            }
          );
        } catch (abortError) {
          const abortMsg = abortError instanceof Error ? abortError.message : 'Unknown error';
          void vscode.window.showErrorMessage(
            `Failed to abort orphaned rebase: ${sanitizeGitError(abortMsg)}`
          );
        }
      } else if (afterKind === 'rebasing' && !conflictDialogOpened) {
        // A rebasing state remains after the operation and we did
        // NOT open the Resolve Conflicts dialog as a dedicated UI. The rebase
        // is paused (conflicts) or was interrupted. Surface an actionable
        // warning. Of the rebase recovery commands the extension contributes,
        // only `intellig.rebase.skip` exists today (continue/abort are not
        // registered commands), so the message stays generic rather than
        // referencing command IDs that don't exist.
        void vscode.window.showWarningMessage(
          'Rebase paused with conflicts (or interruption). Resolve and continue, or abort.'
        );
      }

      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to rebase: ${sanitizeGitError(errorMessage)}`);
    }
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

  /**
   * Handle update command for local branches — git4idea updateBranches parity
   * (GitBranchActionsUtil.updateBranches).
   *
   * A NON-current branch gets the align-local fast-forward via a
   * `<remoteRef>:<localRef>` fetch refspec (shared with Update Selected). The
   * CURRENT branch cannot be fetched into, so it is INTEGRATED — the
   * reference routes it through GitUpdateExecutionProcess (fetch + merge or
   * rebase per the update settings); ours mirrors Update Project's per-repo
   * step in {@link _updateCurrentBranch}.
   */
  private async _handleUpdate({ repo, target }: ITreeItemRunArgs<'branch'>): Promise<void> {
    const upstream = target.branch.upstream;
    if (!upstream) {
      void vscode.window.showInformationMessage(
        `Branch '${target.branch.name}' has no upstream configured.`
      );
      return;
    }

    if (!target.branch.isHead) {
      await this._alignLocalBranch(repo, target.branch);
      return;
    }

    await this._updateCurrentBranch(repo, target.branch);
  }

  /**
   * Integrate the CURRENT branch with its upstream. git4idea routes Update on
   * the checked-out branch through `GitUpdateExecutionProcess.update` (fetch +
   * merge/rebase per the update method, with a local-changes saver;
   * GitBranchActionsUtil.kt:51-63) — a fetch-plus-toast is not an update.
   *
   * Mirrors Update Project's single-repo step: fetch the upstream remote with
   * prune, probe the incoming count (0 ⇒ up-to-date toast, probe failure ⇒
   * pull anyway — never claim up-to-date on data we did not read), then pull
   * with the branch-default strategy (`resolveUpdateRebase` over
   * `intellig.pullRebase`) + autostash via {@link buildUpdatePullOptions}. A
   * pull that stops on conflicts routes into the Resolve Conflicts dialog
   * with the operation matching the strategy, so ours/theirs naming follows
   * the same reversal inference the pull handlers use.
   */
  private async _updateCurrentBranch(repo: IRepository, branch: IBranch): Promise<void> {
    const upstream = branch.upstream;
    if (!upstream) {
      void vscode.window.showInformationMessage(
        `Branch '${branch.name}' has no upstream configured.`
      );
      return;
    }
    const rebase = resolveUpdateRebase('branch-default', readConfig('pullRebase'));
    const strategy = rebase ? 'rebase' : 'merge';
    try {
      await this._gitService.fetch(repo, { remote: upstream.remote, prune: true }).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      let incoming: number | undefined;
      const fetcher = getIncomingOutgoingFetcher(this._gitService);
      if (fetcher) {
        try {
          incoming = (await fetcher(repo, branch.name)).incoming;
        } catch {
          incoming = undefined;
        }
      }
      if (incoming === 0) {
        // Fetch updated remote-tracking refs; reload so ahead/behind counts
        // on the branch tree match the post-fetch state.
        await this._gitService.reloadRepository(repo);
        void vscode.window.showInformationMessage(
          `Fetched '${upstream.remote}'. '${branch.name}' is up to date.`
        );
        this._branchTreeProvider.refresh();
        return;
      }
      await this._gitService.pull(repo, buildUpdatePullOptions(rebase)).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      // Pull moved HEAD; reload before refresh.
      await this._gitService.reloadRepository(repo);
      void vscode.window.showInformationMessage(
        incoming === undefined
          ? `Updated '${branch.name}' from '${upstream.remote}' using ${strategy}`
          : `Updated '${branch.name}': integrated ${incoming} commit(s) from ` +
              `'${upstream.remote}' using ${strategy}`
      );
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (await this._routePullConflicts(repo, strategy, branch.name)) {
        return;
      }
      void vscode.window.showErrorMessage(
        `Failed to update branch: ${sanitizeGitError(errorMessage)}`
      );
    }
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

  /**
   * Align-local "Update Selected": fast-forward the clicked local branch to its
   * tracked remote WITHOUT checking it out, skipping it when it has diverged.
   *
   * git4idea parity: GitBranchActionsUtil.updateBranches advances every
   * non-current tracking branch via a `<remoteRef>:<localRef>` fetch refspec
   * (`GitFetchSpec(repo, remote, "$remoteBranch:$localBranch")`) and only ever
   * fast-forwards — diverged branches are left untouched. The current branch
   * is routed to a full integration instead (GitUpdateExecutionProcess in the
   * reference, {@link _updateCurrentBranch} here), since fetching into a
   * checked-out ref is refused. Surfaced from
   * BranchesDashboardActions.UpdateSelectedBranchAction.
   */
  private async _handleUpdateSelected({ repo, target }: ITreeItemRunArgs<'branch'>): Promise<void> {
    if (target.branch.isHead && target.branch.upstream) {
      await this._updateCurrentBranch(repo, target.branch);
      return;
    }
    await this._alignLocalBranch(repo, target.branch);
  }

  /**
   * Fast-forward one local branch to its tracked remote via the align-local
   * refspec fetch, shared by Update (non-current branches) and Update
   * Selected. When the divergence probe is unavailable or fails, the FF fetch
   * is attempted anyway — git itself refuses a non-fast-forward into a
   * non-checked-out ref — instead of claiming "up to date" on data we never
   * read.
   */
  private async _alignLocalBranch(repo: IRepository, branch: IBranch): Promise<void> {
    // Incoming/outgoing lives on the concrete GitService, not the frozen
    // IGitService (ADR-001), so reach it through the same duck-typed fetcher
    // the branch popup/tree use rather than widening the interface.
    const fetcher = getIncomingOutgoingFetcher(this._gitService);
    let counts: { incoming: number; outgoing: number } | undefined;
    if (fetcher) {
      try {
        const io = await fetcher(repo, branch.name);
        counts = { incoming: io.incoming, outgoing: io.outgoing };
      } catch {
        counts = undefined;
      }
    }

    let fetches: IAlignLocalFetch[];
    const skipped: { branch: string; reason: string }[] = [];
    let upToDate: string[] = [];
    if (counts === undefined) {
      // Divergence unknown. Classify via the planner with a synthetic
      // behind-only count so the checked-out / no-upstream skip reasons stay
      // canonical, then let git enforce FF-only on the attempted fetch.
      const plan = planAlignLocal([
        {
          name: branch.name,
          isCurrent: branch.isHead,
          upstream: branch.upstream,
          incoming: 1,
          outgoing: 0,
        },
      ]);
      fetches = plan.fetches;
      skipped.push(...plan.skipped);
    } else {
      const plan = planAlignLocal([
        {
          name: branch.name,
          isCurrent: branch.isHead,
          upstream: branch.upstream,
          incoming: counts.incoming,
          outgoing: counts.outgoing,
        },
      ]);
      fetches = plan.fetches;
      skipped.push(...plan.skipped);
      upToDate = plan.upToDate;
    }

    const advanced: string[] = [];
    for (const fetch of fetches) {
      try {
        await this._gitService.fetch(repo, { remote: fetch.remote, refspec: fetch.refspec }).match(
          () => undefined,
          (e) => {
            throw e;
          }
        );
        advanced.push(fetch.branch);
      } catch (error) {
        // git refuses a non-FF update into a non-checked-out ref; treat a late
        // divergence (the tracking ref moved since we read the counts) as a
        // skip rather than a hard error, mirroring git4idea's FF-only semantics.
        const message = error instanceof Error ? error.message : 'Unknown error';
        skipped.push({
          branch: fetch.branch,
          reason: `fast-forward failed — ${sanitizeGitError(message)}`,
        });
      }
    }

    if (advanced.length > 0) {
      await this._gitService.reloadRepository(repo);
      this._branchTreeProvider.refresh();
    }

    this._reportAlignLocalResult(advanced, skipped, upToDate);
  }

  /**
   * Surface the align-local outcome as a single info/warning toast. A clean
   * fast-forward is an info; any skip (diverged, no upstream, checked out)
   * downgrades to a warning so the user notices the branch was left behind.
   */
  private _reportAlignLocalResult(
    advanced: string[],
    skipped: { branch: string; reason: string }[],
    upToDate: string[]
  ): void {
    const parts: string[] = [];
    if (advanced.length > 0) {
      parts.push(`Fast-forwarded ${advanced.join(', ')}`);
    }
    if (upToDate.length > 0) {
      parts.push(`${upToDate.join(', ')} already up to date`);
    }
    for (const s of skipped) {
      parts.push(`Skipped ${s.branch}: ${s.reason}`);
    }

    const summary = parts.join('. ') + '.';
    if (skipped.length > 0) {
      void vscode.window.showWarningMessage(summary);
    } else {
      void vscode.window.showInformationMessage(summary);
    }
  }

  /**
   * Pick the target remote for a push — IntelliJ GitPushTarget.getRemoteToPush
   * / GitUtil.getDefaultOrFirstRemote parity
   * (git4idea/backend/src/push/GitPushTarget.java,
   * git4idea/backend/src/GitUtil.java#getDefaultOrFirstRemote).
   *
   * With at most one remote there is nothing to choose, so we return it
   * without prompting (single-remote fast path, unchanged behaviour). With
   * several remotes we show a QuickPick whose default — preselected first so
   * Enter accepts it, mirroring IntelliJ's preselected combobox — is the
   * branch's tracked remote when it still exists, else `origin`, else the
   * first remote. Returns the chosen remote name, or `undefined` if the user
   * cancels (caller aborts the push).
   *
   * The returned name flows into `gitService.push` / `pushTag`, both of which
   * splice it through `buildGitArgs` with `--end-of-options` ahead of the
   * remote — so a hostile remote name from `.git/config` can never be parsed
   * as a git flag (argv-injection defense; check:remote-ops-eoo).
   */
  private async _chooseTargetRemote(
    repo: IRepository,
    preferred?: string
  ): Promise<string | undefined> {
    let remotes: IRemote[];
    try {
      remotes = await this._gitService.getRemotes(repo).match(
        (r) => r,
        (e) => {
          throw e;
        }
      );
    } catch {
      // Enumeration failed (rare) — fall back to the preferred/origin default
      // and let the push itself surface any real error.
      return preferred ?? 'origin';
    }
    if (remotes.length <= 1) {
      return remotes[0]?.name ?? preferred ?? 'origin';
    }

    const names = remotes.map((r) => r.name);
    const fallback = names.includes('origin') ? 'origin' : names[0];
    const def = preferred && names.includes(preferred) ? preferred : fallback;
    const ordered = [def, ...names.filter((n) => n !== def)];

    const picked = await vscode.window.showQuickPick(
      ordered.map((name) => ({
        label: name,
        description: name === def ? 'default' : undefined,
      })),
      {
        title: 'Push — Choose Target Remote',
        placeHolder: `Select the remote to push to (default: ${def})`,
      }
    );
    return picked?.label;
  }

  /**
   * Handle push command for local branches.
   * Pushes the branch to its upstream remote, or sets upstream if none configured.
   */
  private async _handlePush({ repo, target }: ITreeItemRunArgs<'branch'>): Promise<void> {
    // Route through the Push Dialog when available so the user gets
    // the per-row target edit, force-with-lease dropdown, and protected-
    // branch guard. Falls back to a direct push (original behaviour) when
    // the opener is absent — e.g. in unit tests that don't wire the dialog.
    if (this._pushDialogOpener) {
      // Thread the clicked branch's OWN upstream so a non-HEAD branch that
      // already tracks a remote keeps it in the dialog instead of being forced
      // to --set-upstream against the fallback remote.
      this._pushDialogOpener({
        repo,
        branch: target.branch.name,
        upstream: target.branch.upstream,
        // Thread the clicked branch's OWN divergence so a non-HEAD row shows
        // its real ahead/behind and the force-with-lease flip fires.
        ahead: target.branch.ahead,
        behind: target.branch.behind,
      });
      return;
    }

    try {
      const upstream = target.branch.upstream;
      // When several remotes exist, let the user pick the target (default =
      // tracked remote / origin); a single remote skips the prompt. Cancelling
      // the picker aborts the push.
      const targetRemote = await this._chooseTargetRemote(repo, upstream?.remote);
      if (!targetRemote) {
        return;
      }
      // Set upstream when the branch isn't yet tracking, or when the user
      // redirected it to a remote other than its current upstream — matching
      // IntelliJ's "set new upstream" on a remote change. Pushing to the
      // already-tracked remote keeps the existing tracking untouched.
      const setUpstream = !upstream || targetRemote !== upstream.remote;
      await this._gitService
        .push(repo, {
          remote: targetRemote,
          branch: target.branch.name,
          ...(setUpstream ? { setUpstream: true } : {}),
        })
        .match(
          () => undefined,
          (e) => {
            throw e;
          }
        );
      void vscode.window.showInformationMessage(
        `Pushed branch '${target.branch.name}' to '${targetRemote}'`
      );
      // Fallback push path lacked any
      // reload/refresh; add both so ahead/behind counts on the
      // branch tree match the post-push state.
      await this._gitService.reloadRepository(repo);
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to push branch: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  private _diffContext(): IBranchDiffContext {
    return { gitService: this._gitService };
  }

  private _handleShowDiffWithWorkingTree(args: ITreeItemRunArgs<'branch'>): Promise<void> {
    return handleShowDiffWithWorkingTree(this._diffContext(), args);
  }

  /**
   * Handle checkout and rebase command.
   * Checks out the right-clicked branch and rebases it onto the previously
   * current branch — IntelliJ's "Checkout and Rebase onto '{current}'" flow.
   *
   * Remote-branch handling: a plain `git checkout origin/main` on a
   * remote-tracking ref detaches HEAD at that ref's commit (remote-tracking
   * refs aren't local branches). IntelliJ's behaviour is to create or
   * fast-forward a LOCAL branch of the same leaf name, tracking the remote,
   * and check THAT out so HEAD stays attached. The fix below uses
   * `checkout -B <local> --track <remote>` when the right-clicked item is
   * a remote branch, mirroring `_handleCheckoutAsLocal`'s pattern.
   */
  private async _handleCheckoutAndRebase({
    repo,
    target,
  }: ITreeItemRunArgs<'branch'>): Promise<void> {
    // Store the revision to rebase onto BEFORE checkout. When HEAD is attached
    // that's the branch name; when DETACHED there's no branch name, so capture
    // the prior COMMIT sha — rebasing onto the literal 'HEAD' would target the
    // just-moved HEAD (a no-op / nonsensical target).
    const previousCurrentBranch = repo.head?.name?.replace('refs/heads/', '') || repo.head?.commit;
    if (!previousCurrentBranch) {
      void vscode.window.showErrorMessage('Cannot determine the previous revision to rebase onto.');
      return;
    }

    // Resolve the actual checkout target:
    //   - Local branch  → check out by name (`git checkout main`).
    //   - Remote branch → create-or-fast-forward a local tracking branch
    //     of the same leaf name (`git checkout -B main --track origin/main`).
    //     This keeps HEAD attached. IntelliJ parity.
    const isRemote = target.branch.type === 'remote';
    const remoteFullName = target.branch.name; // e.g. 'origin/main'
    const localLeafName = isRemote
      ? remoteFullName.split('/').slice(1).join('/') // 'origin/main' → 'main'
      : target.branch.name;
    // The branch label rendered in toasts always uses the LOCAL leaf name —
    // reads as "Checked out main" rather than "Checked out origin/main".
    const displayName = localLeafName;
    const checkout = (force?: boolean): Promise<void> =>
      (isRemote
        ? this._gitService.checkout(repo, localLeafName, {
            forceCreate: true,
            track: remoteFullName,
            ...(force ? { force: true } : {}),
          })
        : this._gitService.checkout(repo, localLeafName, force ? { force: true } : undefined)
      ).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );

    try {
      // Checkout the right-clicked branch (attached HEAD).
      await checkout();

      // Rebase onto the previously current branch
      const result = await this._gitService.rebaseBranch(repo, previousCurrentBranch);

      if (result.success) {
        void vscode.window.showInformationMessage(
          `Checked out '${displayName}' and rebased onto '${previousCurrentBranch}'`
        );
      } else if (result.conflicts && result.conflicts.length > 0) {
        await this._surfaceRebaseConflicts(
          repo,
          result.conflicts,
          previousCurrentBranch,
          result.rebaseInProgress
        );
      } else {
        // Non-conflict failure: surface the underlying git error.
        const reason = result.failureReason ?? 'unknown error (no output from git)';
        void vscode.window.showErrorMessage(
          `Failed to rebase onto '${previousCurrentBranch}': ${sanitizeGitError(reason)}`
        );
      }
      // Checkout + rebase moved HEAD; reload before refresh.
      await this._gitService.reloadRepository(repo);
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const choice = await this._handleDirtyTreeError(
        errorMessage,
        `Cannot switch to '${displayName}': local changes would be overwritten.`,
        `Failed to checkout and rebase: ${sanitizeGitError(errorMessage)}`
      );
      if (choice === 'Stash & Switch') {
        try {
          await this._gitService.stash(repo, `Auto-stash before checkout ${displayName}`).match(
            () => undefined,
            (e) => {
              throw e;
            }
          );
          const createdStashSha = await this._createdStashSha(repo);
          await checkout();
          // Smart-checkout parity: restore the stash before the rebase (the
          // rebase itself runs with --autostash, so restored dirtiness is
          // handled). A conflicted restore hands off to the Resolve
          // Conflicts flow and must NOT start a rebase over an unmerged tree.
          const restoreOutcome = await this._restoreStashAfterSwitch(repo, createdStashSha);
          if (restoreOutcome === 'conflict-routed') {
            await this._gitService.reloadRepository(repo);
            this._branchTreeProvider.refresh();
            return;
          }
          const result = await this._gitService.rebaseBranch(repo, previousCurrentBranch);
          if (result.success) {
            void vscode.window.showInformationMessage(
              `Stashed changes, checked out '${displayName}' and rebased onto '${previousCurrentBranch}'`
            );
          } else if (result.conflicts && result.conflicts.length > 0) {
            await this._surfaceRebaseConflicts(
              repo,
              result.conflicts,
              previousCurrentBranch,
              result.rebaseInProgress
            );
          } else {
            // Non-conflict failure: surface the underlying git error.
            const reason = result.failureReason ?? 'unknown error (no output from git)';
            void vscode.window.showErrorMessage(
              `Failed to rebase onto '${previousCurrentBranch}': ${sanitizeGitError(reason)}`
            );
          }
          // Stash + checkout + rebase moved HEAD; reload before refresh.
          await this._gitService.reloadRepository(repo);
          this._branchTreeProvider.refresh();
        } catch (stashError) {
          const stashMsg = stashError instanceof Error ? stashError.message : 'Unknown error';
          void vscode.window.showErrorMessage(
            `Failed to stash and checkout: ${sanitizeGitError(stashMsg)}`
          );
        }
      } else if (choice === 'Force Checkout') {
        try {
          await checkout(true);
          const result = await this._gitService.rebaseBranch(repo, previousCurrentBranch);
          if (result.success) {
            void vscode.window.showInformationMessage(
              `Force checked out '${displayName}' and rebased onto '${previousCurrentBranch}'`
            );
          } else if (result.conflicts && result.conflicts.length > 0) {
            await this._surfaceRebaseConflicts(
              repo,
              result.conflicts,
              previousCurrentBranch,
              result.rebaseInProgress
            );
          } else {
            // Non-conflict failure: surface the underlying git error.
            const reason = result.failureReason ?? 'unknown error (no output from git)';
            void vscode.window.showErrorMessage(
              `Failed to rebase onto '${previousCurrentBranch}': ${sanitizeGitError(reason)}`
            );
          }
          // Force checkout + rebase moved HEAD; reload before refresh.
          await this._gitService.reloadRepository(repo);
          this._branchTreeProvider.refresh();
        } catch (forceError) {
          const forceMsg = forceError instanceof Error ? forceError.message : 'Unknown error';
          void vscode.window.showErrorMessage(
            `Failed to force checkout and rebase: ${sanitizeGitError(forceMsg)}`
          );
        }
      }
    }
  }

  /**
   * Shared implementation for the pullUsing* handlers.
   *
   * The right-click menu entry already chose the strategy
   * (`pullUsingRebase` → rebase, `pullUsingMerge` → merge), so this path
   * pulls directly via `gitService.pull` with `rebase: preset === 'rebase'`
   * and never opens the PullDialog. Previously this delegated to
   * `PullDialog.show`, which popped a second "Pull: Options" QuickPick
   * requiring the synthetic ▶ Pull terminal item; dismissing it returned
   * `{status:'cancelled'}` that the caller awaited but never branched on,
   * making the action look like a silent no-op.
   *
   * `_pullDialogAccessor` remains a field/constructor param (other wiring
   * may reference it) but is intentionally NOT consulted here. The generic
   * `intellig.pull` palette command still routes through PullDialog — that
   * entry point is where strategy IS the question.
   */
  private async _runPullFromBranchMenu(
    { repo, target }: ITreeItemRunArgs<'branch'>,
    preset: 'rebase' | 'merge'
  ): Promise<void> {
    // Parse remote name and branch name from target.branch.name
    // (e.g., "origin/main" -> "origin", "main")
    const slashIndex = target.branch.name.indexOf('/');
    const remoteName =
      slashIndex >= 0 ? target.branch.name.substring(0, slashIndex) : target.branch.name;
    const branchName =
      slashIndex >= 0 ? target.branch.name.substring(slashIndex + 1) : target.branch.name;

    // The right-click pullUsing* entries intentionally bypass the
    // PullDialog — the menu entry already chose the strategy, so the second
    // "Pull: Options" QuickPick was redundant friction whose silent cancel
    // looked like a no-op. The `_pullDialogAccessor` field is retained for
    // constructor-arity / wiring compatibility (the generic `intellig.pull`
    // palette command still routes through PullDialog). Emit a debug note
    // (visible only at `log.level=debug`) so a received click is observable
    // even though no dialog opens.
    getLogger()
      .child({ component: 'BranchContextMenuCommands' })
      .debug('pullUsing* bypassing PullDialog (strategy chosen via menu)', {
        preset,
        dialogAvailable: this._pullDialogAccessor !== undefined,
      });

    // Direct-pull path — the only path for both presets. The conflict-probe
    // handoff below auto-opens the Resolve Conflicts dialog when the pull
    // leaves the working tree with unresolved conflicts.
    try {
      await this._gitService
        .pull(repo, {
          remote: remoteName,
          branch: branchName,
          rebase: preset === 'rebase',
          prune: true,
        })
        .match(
          () => undefined,
          (e) => {
            throw e;
          }
        );
      const strategy = preset === 'rebase' ? 'rebase' : 'merge';
      void vscode.window.showInformationMessage(
        `Pulled '${target.branch.name}' into current branch using ${strategy}`
      );
      // Pull moved HEAD; reload before refresh.
      await this._gitService.reloadRepository(repo);
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      // Conflict handoff: probe the working tree and auto-open the Resolve
      // Conflicts dialog when the pull left unresolved conflicts.
      // Pull-using-rebase maps to `'rebase'` and pull-using-merge to
      // `'merge'` — the same post-conflict states merge / rebase produce
      // directly. A probe failure never swallows the original pull error —
      // the generic toast below still fires.
      if (await this._routePullConflicts(repo, preset, target.branch.name)) {
        return;
      }
      const strategy = preset === 'rebase' ? 'rebase' : 'merge';
      void vscode.window.showErrorMessage(
        `Failed to pull using ${strategy}: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  // ============================================
  // Remote Branch Command Handlers
  // ============================================

  /**
   * Handle checkout as local branch command.
   *
   * A remote branch "Checkout" must land the user on the remote tip
   * even when a stale local of the same name exists. We use IntelliJ's
   * idiom `git checkout -B <branch> <remote>/<branch>` (forceCreate) which
   * creates-or-resets the local to the remote tip in one step — the old
   * `localExists ? plain-checkout : create-tracking` branching left a stale
   * local untouched. Because `-B` rewrites the local's commit pointer, we
   * first probe the local branch's `ahead` count and, when it has commits
   * not on the remote (which would become unreachable), show a modal
   * confirmation before resetting.
   */
  private async _handleCheckoutAsLocal({
    repo,
    target,
  }: ITreeItemRunArgs<'branch'>): Promise<void> {
    // Parse remote name from branch name (e.g., "origin/main" -> "origin", "main")
    const parts = target.branch.name.split('/');
    const remoteName = parts[0];
    const branchName = parts.slice(1).join('/');
    const track = `${remoteName}/${branchName}`;

    try {
      // Data-loss guard: if a local branch of the same name exists and is
      // ahead of the remote, `-B` would orphan its unique commits. Probe the
      // local IBranch and prompt before resetting. When the local doesn't
      // exist (nothing to lose) or `ahead === 0` (the reset is a no-op or a
      // fast-forward), skip the prompt and reset directly.
      const branches = await this._gitService.getBranches(repo);
      const local = branches.find((b) => b.type === 'local' && b.name === branchName);
      const ahead = local?.ahead ?? 0;

      let stashedBeforeReset = false;
      let stashShaBeforeReset: string | undefined;
      if (local && ahead > 0) {
        const choice = await vscode.window.showWarningMessage(
          `Local branch '${branchName}' has ${ahead} commit${ahead === 1 ? '' : 's'} ` +
            `not on remote '${track}'. Resetting to the remote tip will make ` +
            `${ahead === 1 ? 'it' : 'them'} unreachable.`,
          { modal: true },
          'Reset anyway',
          'Stash and reset'
        );
        if (choice === 'Stash and reset') {
          await this._gitService.stash(repo, `Auto-stash before checkout ${branchName}`).match(
            () => undefined,
            (e) => {
              throw e;
            }
          );
          stashShaBeforeReset = await this._createdStashSha(repo);
          stashedBeforeReset = true;
        } else if (choice !== 'Reset anyway') {
          // Cancel (or dialog dismissed): do not touch the local branch.
          return;
        }
      }

      // Create-or-reset the local to the remote tip in one step.
      await this._gitService.checkout(repo, branchName, { forceCreate: true, track }).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );

      // Smart-checkout parity: a "Stash and reset" restores the stash too.
      const resetRestore = stashedBeforeReset
        ? await this._restoreStashAfterSwitch(repo, stashShaBeforeReset)
        : 'restored';

      // checkout-as-local moved HEAD; reload before refresh.
      await this._gitService.reloadRepository(repo);
      if (resetRestore !== 'conflict-routed') {
        void vscode.window.showInformationMessage(`Switched to branch '${branchName}'`);
      }
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const choice = await this._handleDirtyTreeError(
        errorMessage,
        `Cannot switch to '${branchName}': local changes would be overwritten.`,
        `Failed to checkout branch: ${sanitizeGitError(errorMessage)}`
      );
      if (choice === 'Stash & Switch') {
        try {
          await this._gitService.stash(repo, `Auto-stash before checkout ${branchName}`).match(
            () => undefined,
            (e) => {
              throw e;
            }
          );
          const createdStashSha = await this._createdStashSha(repo);
          // `-B` create-or-resets regardless of whether a local exists.
          await this._gitService.checkout(repo, branchName, { forceCreate: true, track }).match(
            () => undefined,
            (e) => {
              throw e;
            }
          );
          // Smart-checkout parity: restore the stash onto the new branch.
          const restore = await this._restoreStashAfterSwitch(repo, createdStashSha);
          // Stash + checkout (+ pop) moved HEAD; reload before refresh.
          await this._gitService.reloadRepository(repo);
          if (restore !== 'conflict-routed') {
            void vscode.window.showInformationMessage(
              restore === 'restored'
                ? `Stashed changes, switched to '${branchName}', and restored them`
                : `Stashed changes and switched to '${branchName}'`
            );
          }
          this._branchTreeProvider.refresh();
        } catch (stashError) {
          const stashMsg = stashError instanceof Error ? stashError.message : 'Unknown error';
          void vscode.window.showErrorMessage(
            `Failed to stash and checkout: ${sanitizeGitError(stashMsg)}`
          );
        }
      } else if (choice === 'Force Checkout') {
        try {
          // `-B` create-or-resets regardless of whether a local exists.
          await this._gitService
            .checkout(repo, branchName, {
              forceCreate: true,
              force: true,
              track,
            })
            .match(
              () => undefined,
              (e) => {
                throw e;
              }
            );
          // Force checkout moved HEAD; reload before refresh.
          await this._gitService.reloadRepository(repo);
          void vscode.window.showInformationMessage(`Force switched to '${branchName}'`);
          this._branchTreeProvider.refresh();
        } catch (forceError) {
          const forceMsg = forceError instanceof Error ? forceError.message : 'Unknown error';
          void vscode.window.showErrorMessage(
            `Failed to force checkout: ${sanitizeGitError(forceMsg)}`
          );
        }
      }
    }
  }

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
   * conflict-dialog seam and the cherry-pick-suffix / remote-choice helpers
   * stay on the dispatcher and are reached via lambdas.
   */
  private _tagContext(): IBranchTagContext {
    return {
      gitService: this._gitService,
      branchTreeProvider: this._branchTreeProvider,
      mergeDialogOpener: this._mergeDialogOpener,
      conflictResolutionService: () => this._conflictResolutionService,
      openResolveConflictsDialog: (repo, conflicts, opContext) =>
        this._openResolveConflictsDialog(repo, conflicts, opContext),
      cherryPickSuffixOptions: (repo, hashes) =>
        cherryPickSuffixOptions({ gitService: this._gitService }, repo, hashes),
      chooseTargetRemote: (repo) => this._chooseTargetRemote(repo),
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
  pullDialogAccessor?: PullDialogAccessor,
  pushDialogOpener?: PushDialogOpener,
  mergeDialogOpener?: MergeDialogOpener,
  newBranchDialogOpener?: NewBranchDialogOpener,
  rebaseDialogOpener?: RebaseDialogOpener
): BranchContextMenuCommands {
  return new BranchContextMenuCommands(
    gitService,
    branchTreeProvider,
    conflictResolutionService,
    pullDialogAccessor,
    pushDialogOpener,
    mergeDialogOpener,
    newBranchDialogOpener,
    rebaseDialogOpener
  );
}
