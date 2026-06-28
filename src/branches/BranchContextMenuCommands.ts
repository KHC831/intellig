/**
 * Branch Context Menu Commands implementation.
 * Provides command handlers for branch, remote branch, and tag context menus.
 */

import * as vscode from 'vscode';
import {
  IBranch,
  IGitService,
  IRefDiffFile,
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
import {
  sanitizeGitError,
  formatActionFailureToast,
  worktreeConflictMessage,
} from '../git-core/gitError';
import { openRevisionDiff } from '../git-core/diff/openRevisionDiff';
import { getLogger, registerLoggedCommand } from '../utils/logger';
import type { IWorktreeCapableService, IWorktreeEntry } from '../git-core/ops/WorktreeOps';

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
 * the current branch.
 */
export type MergeDialogOpener = (preselect: {
  repo: IRepository;
  sourceBranch: string;
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
 * - checked-out current branch — FF into a checked-out ref is refused; the
 *   branch must be advanced via Update/Pull instead (git4idea routes this to
 *   GitUpdateExecutionProcess, which is out of scope for align-local).
 * - no upstream configured.
 * - diverged (has outgoing commits) — not a fast-forward.
 *
 * The refspec joins user-controlled ref names; callers MUST splice it through
 * `buildGitArgs` (the fetch op does) so it can never be parsed as a git flag.
 */
export function planAlignLocal(inputs: IAlignLocalBranchInput[]): IAlignLocalPlan {
  const plan: IAlignLocalPlan = { fetches: [], skipped: [], upToDate: [] };

  for (const input of inputs) {
    if (input.isCurrent) {
      plan.skipped.push({
        branch: input.name,
        reason: 'checked out — use Update/Pull to advance the current branch',
      });
      continue;
    }
    if (!input.upstream) {
      plan.skipped.push({ branch: input.name, reason: 'no upstream configured' });
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
   * View the GitService through its worktree capability. The frozen
   * {@link IGitService} composite (ADR-001) does not declare the post-freeze
   * worktree methods; the concrete `GitService` implements them, so consumers
   * widen through the {@link IWorktreeCapableService} role interface.
   */
  private _worktreeService(): IWorktreeCapableService {
    return this._gitService as unknown as IWorktreeCapableService;
  }

  /**
   * "New Worktree…" — create a linked worktree checked out at the right-clicked
   * branch/tag (or a prompted ref), at a user-chosen path. Mirrors IntelliJ
   * git4idea's `git worktree add`: prompts whether to create a NEW branch in
   * the worktree or check out the existing ref, validates the target path does
   * not already exist, then runs the injection-safe argv builder in
   * {@link WorktreeOps.addWorktree}. Offers to open the new worktree afterward.
   */
  private async _handleNewWorktree(item?: BranchTreeItem): Promise<void> {
    const repo = this._resolveRepository(item);
    if (!repo) {
      return;
    }

    const ref = item?.branch?.name ?? item?.tag?.name ?? item?.getDetachedHeadSha() ?? 'HEAD';

    const targetPath = await vscode.window.showInputBox({
      prompt: `Path for the new worktree (checked out at '${ref}')`,
      placeHolder: '/absolute/path/to/worktree',
      validateInput: (value) => {
        const trimmed = value?.trim() ?? '';
        if (trimmed.length === 0) {
          return 'Worktree path cannot be empty';
        }
        if (trimmed.startsWith('-')) {
          return 'Worktree path cannot start with "-"';
        }
        return undefined;
      },
    });
    if (!targetPath || targetPath.trim().length === 0) {
      return;
    }
    const worktreePath = targetPath.trim();

    // Refuse a path that already exists — git would fail with a terse error;
    // a clear pre-check is friendlier and matches IntelliJ's path validation.
    let pathExists = false;
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(worktreePath));
      pathExists = true;
    } catch {
      pathExists = false;
    }
    if (pathExists) {
      void vscode.window.showErrorMessage(
        `Cannot create worktree: '${worktreePath}' already exists.`
      );
      return;
    }

    const createBranchPick = await vscode.window.showQuickPick(
      [
        { label: `Check out '${ref}'`, mode: 'existing' as const },
        { label: 'Create a new branch in the worktree…', mode: 'new' as const },
      ],
      { placeHolder: 'How should the worktree be checked out?' }
    );
    if (!createBranchPick) {
      return;
    }

    let newBranch: string | undefined;
    if (createBranchPick.mode === 'new') {
      newBranch = await vscode.window.showInputBox({
        prompt: `New branch name (created at '${ref}')`,
        placeHolder: 'feature/my-worktree-branch',
        validateInput: (value) => {
          if (!value || !value.trim()) {
            return 'Branch name cannot be empty';
          }
          if (!/^(?![-.])[\w\-./]+$/.test(value)) {
            return 'Invalid branch name';
          }
          return undefined;
        },
      });
      if (!newBranch) {
        return;
      }
    }

    const created = await this._worktreeService()
      .addWorktree(repo, { path: worktreePath, ref, newBranch })
      .match(
        () => true,
        (error) => {
          void vscode.window.showErrorMessage(
            formatActionFailureToast('Failed to create worktree', error)
          );
          return false;
        }
      );
    if (!created) {
      return;
    }

    this._branchTreeProvider.refresh();

    const open = await vscode.window.showInformationMessage(
      `Worktree created at '${worktreePath}'.`,
      'Open in New Window',
      'Open in Current Window'
    );
    if (open === 'Open in New Window' || open === 'Open in Current Window') {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(worktreePath), {
        forceNewWindow: open === 'Open in New Window',
      });
    }
  }

  /**
   * "Open Worktree…" — list the repo's worktrees
   * (`git worktree list --porcelain`), let the user pick one, and open it as a
   * VS Code folder. The current/main worktree and any path equal to the active
   * repo root are still listed (you may want to reopen the main checkout in a
   * fresh window).
   */
  private async _handleOpenWorktree(): Promise<void> {
    const repo = this._getRepository();
    if (!repo) {
      return;
    }

    const worktrees = await this._worktreeService()
      .listWorktrees(repo)
      .match(
        (list) => list,
        (error) => {
          void vscode.window.showErrorMessage(
            formatActionFailureToast('Failed to list worktrees', error)
          );
          return undefined;
        }
      );
    if (!worktrees) {
      return;
    }
    if (worktrees.length === 0) {
      void vscode.window.showInformationMessage('No worktrees found for this repository.');
      return;
    }

    const items = worktrees.map((wt) => ({
      label: this._worktreeLabel(wt),
      description: wt.path,
      worktree: wt,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a worktree to open',
    });
    if (!picked) {
      return;
    }

    const newWindow = await vscode.window.showQuickPick(
      [
        { label: 'Open in New Window', forceNewWindow: true },
        { label: 'Open in Current Window', forceNewWindow: false },
      ],
      { placeHolder: `Open '${picked.worktree.path}'` }
    );
    if (!newWindow) {
      return;
    }

    await vscode.commands.executeCommand(
      'vscode.openFolder',
      vscode.Uri.file(picked.worktree.path),
      { forceNewWindow: newWindow.forceNewWindow }
    );
  }

  /**
   * Human-readable label for a worktree pick: the short branch name (stripping
   * the `refs/heads/` prefix git's porcelain emits), `(detached)` /
   * `(bare)` for those states, plus a `(locked)` / `(main)` suffix.
   */
  private _worktreeLabel(wt: IWorktreeEntry): string {
    let base: string;
    if (wt.isBare) {
      base = '(bare)';
    } else if (wt.isDetached) {
      base = '(detached)';
    } else if (wt.branch) {
      base = wt.branch.replace(/^refs\/heads\//, '');
    } else {
      base = '(unknown)';
    }
    const tags: string[] = [];
    if (wt.isMain) {
      tags.push('main');
    }
    if (wt.isLocked) {
      tags.push('locked');
    }
    return tags.length > 0 ? `${base} (${tags.join(', ')})` : base;
  }

  /**
   * Register all branch context menu commands.
   *
   * @param context - The VS Code extension context
   */
  register(context: vscode.ExtensionContext): void {
    // Local branch commands
    this._disposables.push(
      registerLoggedCommand('intellig.branch.checkout', (item: BranchTreeItem) =>
        this._handleCheckout(item)
      )
    );

    this._disposables.push(
      registerLoggedCommand('intellig.branch.new', () => this._handleNewBranch())
    );
    this._disposables.push(
      registerLoggedCommand('intellig.branch.newBranchFrom', (item: BranchTreeItem) =>
        this._handleNewBranchFrom(item)
      )
    );

    this._disposables.push(
      registerLoggedCommand('intellig.branch.mergeIntoCurrent', (item: BranchTreeItem) =>
        this._handleMergeIntoCurrent(item)
      )
    );

    this._disposables.push(
      registerLoggedCommand('intellig.branch.rebaseCurrentOnto', (item: BranchTreeItem) =>
        this._handleRebaseCurrentOnto(item)
      )
    );

    this._disposables.push(
      registerLoggedCommand('intellig.branch.compareWithCurrent', (item: BranchTreeItem) =>
        this._handleCompareWithCurrent(item)
      )
    );

    this._disposables.push(
      registerLoggedCommand('intellig.branch.rename', (item: BranchTreeItem) =>
        this._handleRename(item)
      )
    );

    this._disposables.push(
      registerLoggedCommand('intellig.branch.delete', (item: BranchTreeItem) =>
        this._handleDelete(item)
      )
    );

    // Remote branch commands
    this._disposables.push(
      registerLoggedCommand('intellig.remoteBranch.checkoutAsLocal', (item: BranchTreeItem) =>
        this._handleCheckoutAsLocal(item)
      )
    );

    this._disposables.push(
      registerLoggedCommand('intellig.remoteBranch.cherryPickCommits', (item: BranchTreeItem) =>
        this._handleCherryPickCommits(item)
      )
    );

    this._disposables.push(
      registerLoggedCommand('intellig.remoteBranch.pullIntoCurrent', (item: BranchTreeItem) =>
        this._handlePullIntoCurrent(item)
      )
    );

    this._disposables.push(
      registerLoggedCommand('intellig.remoteBranch.deleteRemote', (item: BranchTreeItem) =>
        this._handleDeleteRemote(item)
      )
    );

    // Track Remote Branch single-entry smart-detect.
    this._disposables.push(
      registerLoggedCommand('intellig.remoteBranch.trackBranch', (item: BranchTreeItem) =>
        this._handleTrackRemote(item)
      )
    );

    // New command handlers
    this._disposables.push(
      registerLoggedCommand('intellig.branch.update', (item: BranchTreeItem) =>
        this._handleUpdate(item)
      )
    );

    this._disposables.push(
      registerLoggedCommand('intellig.branch.updateSelected', (item: BranchTreeItem) =>
        this._handleUpdateSelected(item)
      )
    );

    this._disposables.push(
      registerLoggedCommand('intellig.branch.push', (item: BranchTreeItem) =>
        this._handlePush(item)
      )
    );

    this._disposables.push(
      registerLoggedCommand('intellig.branch.showDiffWithWorkingTree', (item: BranchTreeItem) =>
        this._handleShowDiffWithWorkingTree(item)
      )
    );

    this._disposables.push(
      registerLoggedCommand('intellig.branch.checkoutAndRebase', (item: BranchTreeItem) =>
        this._handleCheckoutAndRebase(item)
      )
    );

    this._disposables.push(
      registerLoggedCommand('intellig.remoteBranch.pullUsingRebase', (item: BranchTreeItem) =>
        this._handlePullUsingRebase(item)
      )
    );

    this._disposables.push(
      registerLoggedCommand('intellig.remoteBranch.pullUsingMerge', (item: BranchTreeItem) =>
        this._handlePullUsingMerge(item)
      )
    );

    // Tag commands
    this._disposables.push(
      registerLoggedCommand('intellig.tag.checkoutDetached', (item: BranchTreeItem) =>
        this._handleTagCheckoutDetached(item)
      )
    );

    this._disposables.push(
      registerLoggedCommand('intellig.tag.newBranchFrom', (item: BranchTreeItem) =>
        this._handleTagNewBranchFrom(item)
      )
    );

    this._disposables.push(
      registerLoggedCommand('intellig.tag.cherryPick', (item: BranchTreeItem) =>
        this._handleTagCherryPick(item)
      )
    );

    this._disposables.push(
      registerLoggedCommand('intellig.tag.mergeIntoCurrent', (item: BranchTreeItem) =>
        this._handleTagMergeIntoCurrent(item)
      )
    );

    this._disposables.push(
      registerLoggedCommand('intellig.tag.delete', (item: BranchTreeItem) =>
        this._handleTagDelete(item)
      )
    );

    this._disposables.push(
      registerLoggedCommand('intellig.tag.push', (item: BranchTreeItem) =>
        this._handleTagPush(item)
      )
    );

    this._disposables.push(
      registerLoggedCommand('intellig.tag.deleteRemote', (item: BranchTreeItem) =>
        this._handleTagDeleteRemote(item)
      )
    );

    // Worktree commands
    this._disposables.push(
      registerLoggedCommand('intellig.branch.newWorktree', (item?: BranchTreeItem) =>
        this._handleNewWorktree(item)
      )
    );
    this._disposables.push(
      registerLoggedCommand('intellig.branch.openWorktree', () => this._handleOpenWorktree())
    );

    // Refresh command
    this._disposables.push(
      registerLoggedCommand('intellig.branches.refresh', () => this._branchTreeProvider.refresh())
    );

    // Add all disposables to context
    context.subscriptions.push(...this._disposables);
  }

  /**
   * Get the current repository.
   */
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
   * Three cases:
   * - Worktree conflict (git refuses atomically) → shows a targeted error,
   *   returns `null` (caller must not show a second error).
   * - Dirty tree (`would be overwritten` / `Please commit`) → shows the
   *   Stash & Switch / Force Checkout / Cancel dialog, returns the user's
   *   choice or `null` on Cancel.
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
    if (
      errorMessage.includes('would be overwritten') ||
      errorMessage.includes('Please commit your changes or stash them')
    ) {
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

  // ============================================
  // Local Branch Command Handlers
  // ============================================

  /**
   * Handle checkout command for local branches.
   */
  private async _handleCheckout(item: BranchTreeItem): Promise<void> {
    const repo = this._resolveRepository(item);
    if (!repo) {
      return;
    }

    // Accept the detached row as a checkout target. `item.branch`
    // is undefined for the synthetic detached-head row; the SHA lives on
    // `getDetachedHeadSha()`. The git command runs uniformly (no
    // early-return on "already at that commit" — IntelliJ does the same;
    // the dirty-working-tree fallback flow handles errors). The toast
    // branches: branch name vs detached re-checkout.
    const ref = item.branch?.name ?? item.getDetachedHeadSha();
    if (!ref) {
      return;
    }
    const successToast = (): string =>
      item.branch
        ? `Switched to branch '${item.branch.name}'`
        : `Re-checked out detached HEAD at ${ref.substring(0, 7)}`;
    const dirtyHeader = (): string =>
      item.branch
        ? `Cannot switch to '${item.branch.name}': local changes would be overwritten.`
        : `Cannot re-checkout detached HEAD at ${ref.substring(0, 7)}: local changes would be overwritten.`;
    const stashLabel = (): string =>
      item.branch
        ? `Auto-stash before checkout ${item.branch.name}`
        : `Auto-stash before checkout ${ref.substring(0, 7)}`;
    const stashSuccessToast = (): string =>
      item.branch
        ? `Stashed changes and switched to '${item.branch.name}'`
        : `Stashed changes and re-checked out detached HEAD at ${ref.substring(0, 7)}`;
    const forceSuccessToast = (): string =>
      item.branch
        ? `Force switched to '${item.branch.name}'`
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
          await this._gitService.checkout(repo, ref).match(
            () => undefined,
            (e) => {
              throw e;
            }
          );
          // Stash + checkout pair moved HEAD; reload before refresh.
          await this._gitService.reloadRepository(repo);
          void vscode.window.showInformationMessage(stashSuccessToast());
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
  private async _handleNewBranchFrom(item: BranchTreeItem): Promise<void> {
    const repo = this._resolveRepository(item);
    if (!repo) {
      return;
    }

    // `??` chain (was `||`) so empty-string ref names don't
    // accidentally fall through to the next operand. Falls through to
    // `getDetachedHeadSha()` for the synthetic detached-head row, which
    // returns the 40-char SHA — never the parenthesized label, so this
    // can't resurrect the bug class.
    const startPoint = item.branch?.name ?? item.tag?.name ?? item.getDetachedHeadSha();
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
  private async _handleMergeIntoCurrent(item: BranchTreeItem): Promise<void> {
    const repo = this._resolveRepository(item);
    if (!repo || !item.branch) {
      return;
    }

    // Route through the Merge Dialog when the opener is wired; the
    // dialog handles options (ff-only / no-ff / squash / no-commit / -m)
    // and conflict handoff itself. Fallback path (no opener) preserves the
    // legacy direct-merge behaviour for tests.
    if (this._mergeDialogOpener) {
      this._mergeDialogOpener({ repo, sourceBranch: item.branch.name });
      return;
    }

    try {
      const result = await this._gitService.mergeBranch(repo, item.branch.name);

      if (result.success) {
        void vscode.window.showInformationMessage(`Merged '${item.branch.name}' successfully`);
      } else if (result.conflicts && result.conflicts.length > 0) {
        // Auto-open Resolve Conflicts dialog when wired; fall back
        // to a warning toast otherwise (legacy callers without the service).
        if (this._conflictResolutionService) {
          await this._openResolveConflictsDialog(repo, result.conflicts, {
            operation: 'merge',
            target: item.branch.name,
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
          `Failed to merge '${item.branch.name}': ${sanitizeGitError(reason)}`
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
  private async _handleRebaseCurrentOnto(item: BranchTreeItem): Promise<void> {
    const repo = this._resolveRepository(item);
    if (!repo || !item.branch) {
      return;
    }

    // Canonical surface: route through the unified Rebase dialog (onto =
    // the clicked branch, Interactive unchecked by default). The dialog owns
    // the same conflict + orphan-recovery handling ported from the inline
    // path below. The inline path remains the fallback when no opener is
    // wired (legacy construction / focused unit tests).
    if (this._rebaseDialogOpener) {
      await this._rebaseDialogOpener({
        repo,
        onto: item.branch.name,
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

      const result = await this._gitService.rebaseBranch(repo, item.branch.name);

      // Track whether the Resolve Conflicts dialog was opened so we suppress
      // the redundant "rebase paused" warning for that same state —
      // the dialog is itself the actionable continue/abort UI.
      let conflictDialogOpened = false;
      // Track the non-conflict-failure branch so only it is eligible for
      // auto-abort of an orphaned rebase.
      let nonConflictFailure = false;

      if (result.success) {
        void vscode.window.showInformationMessage(
          `Rebased onto '${item.branch.name}' successfully`
        );
      } else if (result.conflicts && result.conflicts.length > 0) {
        // Auto-open Resolve Conflicts dialog when wired; fall back to a
        // warning toast otherwise. A non-continuable autostash-pop conflict
        // (rebaseInProgress === false) suppresses continue/abort.
        conflictDialogOpened = !!this._conflictResolutionService;
        await this._surfaceRebaseConflicts(
          repo,
          result.conflicts,
          item.branch.name,
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
          `Failed to rebase onto '${item.branch.name}': ${sanitizeGitError(reason)}`
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

  /**
   * Handle compare with current command.
   */
  private async _handleCompareWithCurrent(item: BranchTreeItem): Promise<void> {
    const repo = this._resolveRepository(item);
    if (!repo || !item.branch) {
      return;
    }

    try {
      const currentBranch = repo.head?.name?.replace('refs/heads/', '') || 'HEAD';
      const comparison = await this._gitService.compareBranches(
        repo,
        currentBranch,
        item.branch.name
      );

      const message =
        `Comparing ${currentBranch} with ${item.branch.name}:\n` +
        `• ${comparison.aheadCount} commit(s) ahead\n` +
        `• ${comparison.behindCount} commit(s) behind\n` +
        `• ${comparison.changedFiles.length} file(s) changed`;

      void vscode.window.showInformationMessage(message);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to compare branches: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * Handle rename command.
   */
  private async _handleRename(item: BranchTreeItem): Promise<void> {
    const repo = this._resolveRepository(item);
    if (!repo || !item.branch) {
      return;
    }

    const newName = await vscode.window.showInputBox({
      prompt: `Rename branch '${item.branch.name}' to:`,
      value: item.branch.name,
      validateInput: (value) => {
        if (!value || !value.trim()) {
          return 'Branch name cannot be empty';
        }
        if (value === item.branch?.name) {
          return 'New name must be different';
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

    if (!newName) {
      return;
    }

    try {
      await this._gitService.renameBranch(repo, item.branch.name, newName).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      // Rename may have updated `repo.head.name` (if renaming
      // current branch); reload before refresh.
      await this._gitService.reloadRepository(repo);
      void vscode.window.showInformationMessage(`Renamed branch to '${newName}'`);
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to rename branch: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * Handle delete command.
   *
   * Two-tier UX matching IntelliJ: the first attempt uses safe delete
   * (`git branch -d`), which refuses to delete a branch whose tip
   * commits aren't reachable from any other ref. On that specific
   * failure, prompt the user with a "Force delete?" modal and, on
   * confirm, retry with `git branch -D` (force).
   */
  private async _handleDelete(item: BranchTreeItem): Promise<void> {
    const repo = this._resolveRepository(item);
    if (!repo || !item.branch) {
      return;
    }

    const branchName = item.branch.name;

    const confirm = await vscode.window.showWarningMessage(
      `Are you sure you want to delete the branch '${branchName}'?`,
      { modal: true },
      'Delete'
    );

    if (confirm !== 'Delete') {
      return;
    }

    try {
      await this._gitService.deleteBranch(repo, branchName).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      // Branch list changed; reload so the tree shows the
      // post-deletion ref set deterministically.
      await this._gitService.reloadRepository(repo);
      void vscode.window.showInformationMessage(`Deleted branch '${branchName}'`);
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      if (isNotFullyMergedError(errorMessage)) {
        const forceConfirm = await vscode.window.showWarningMessage(
          `Branch '${branchName}' is not fully merged. Force delete? Unmerged commits will be lost.`,
          { modal: true },
          'Force Delete'
        );
        if (forceConfirm !== 'Force Delete') {
          return;
        }
        try {
          await this._gitService.deleteBranch(repo, branchName, true).match(
            () => undefined,
            (e) => {
              throw e;
            }
          );
          await this._gitService.reloadRepository(repo);
          void vscode.window.showInformationMessage(`Force-deleted branch '${branchName}'`);
          this._branchTreeProvider.refresh();
        } catch (forceError) {
          const forceMessage = forceError instanceof Error ? forceError.message : 'Unknown error';
          void vscode.window.showErrorMessage(
            `Failed to force-delete branch: ${sanitizeGitError(forceMessage)}`
          );
        }
        return;
      }

      void vscode.window.showErrorMessage(
        `Failed to delete branch: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  // ============================================
  // New Command Handlers
  // ============================================

  /**
   * Handle update command for local branches.
   * Fetches the latest changes from the upstream remote for the branch.
   */
  private async _handleUpdate(item: BranchTreeItem): Promise<void> {
    const repo = this._resolveRepository(item);
    if (!repo || !item.branch) {
      return;
    }

    const upstream = item.branch.upstream;
    if (!upstream) {
      void vscode.window.showInformationMessage(
        `Branch '${item.branch.name}' has no upstream configured.`
      );
      return;
    }

    try {
      await this._gitService.fetch(repo, { remote: upstream.remote, prune: true }).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      // Fetch updated remote-tracking refs; reload so ahead/behind
      // counts on the branch tree match the post-fetch state.
      await this._gitService.reloadRepository(repo);
      void vscode.window.showInformationMessage(
        `Updated branch '${item.branch.name}' from '${upstream.remote}'`
      );
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to update branch: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * Align-local "Update Selected": fast-forward the clicked local branch to its
   * tracked remote WITHOUT checking it out, skipping it when it has diverged.
   *
   * git4idea parity: GitBranchActionsUtil.updateBranches advances every
   * non-current tracking branch via a `<remoteRef>:<localRef>` fetch refspec
   * (`GitFetchSpec(repo, remote, "$remoteBranch:$localBranch")`) and only ever
   * fast-forwards — diverged branches are left untouched. The current branch is
   * routed to a full update (GitUpdateExecutionProcess) instead; here we skip it
   * and tell the user to use Update/Pull, since fetching into a checked-out ref
   * is refused. Surfaced from BranchesDashboardActions.UpdateSelectedBranchAction.
   */
  private async _handleUpdateSelected(item: BranchTreeItem): Promise<void> {
    const repo = this._resolveRepository(item);
    if (!repo || !item.branch) {
      return;
    }

    const branch = item.branch;
    // Incoming/outgoing lives on the concrete GitService, not the frozen
    // IGitService (ADR-001), so reach it through the same duck-typed fetcher
    // the branch popup/tree use rather than widening the interface.
    const fetcher = getIncomingOutgoingFetcher(this._gitService);
    let counts: { incoming: number; outgoing: number };
    try {
      const io = fetcher ? await fetcher(repo, branch.name) : { incoming: 0, outgoing: 0 };
      counts = { incoming: io.incoming, outgoing: io.outgoing };
    } catch {
      // Counts unavailable (rare) — treat as in-sync so we never attempt a
      // blind fetch that could be a non-FF; the user can fall back to Update.
      counts = { incoming: 0, outgoing: 0 };
    }

    const plan = planAlignLocal([
      {
        name: branch.name,
        isCurrent: branch.isHead,
        upstream: branch.upstream,
        incoming: counts.incoming,
        outgoing: counts.outgoing,
      },
    ]);

    const advanced: string[] = [];
    const skipped = [...plan.skipped];
    for (const fetch of plan.fetches) {
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

    this._reportAlignLocalResult(advanced, skipped, plan.upToDate);
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
  private async _handlePush(item: BranchTreeItem): Promise<void> {
    const repo = this._resolveRepository(item);
    if (!repo || !item.branch) {
      return;
    }

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
        branch: item.branch.name,
        upstream: item.branch.upstream,
        // Thread the clicked branch's OWN divergence so a non-HEAD row shows
        // its real ahead/behind and the force-with-lease flip fires.
        ahead: item.branch.ahead,
        behind: item.branch.behind,
      });
      return;
    }

    try {
      const upstream = item.branch.upstream;
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
          branch: item.branch.name,
          ...(setUpstream ? { setUpstream: true } : {}),
        })
        .match(
          () => undefined,
          (e) => {
            throw e;
          }
        );
      void vscode.window.showInformationMessage(
        `Pushed branch '${item.branch.name}' to '${targetRemote}'`
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

  /**
   * Handle show diff with working tree command.
   * Opens a per-file diff comparison between the right-clicked branch ref and the working tree.
   *
   * Flow:
   *   1. List changed files between `<branchRef>` and the working tree
   *      (`git diff --name-status -z <ref>` via `getChangedFilesAgainstWorkingTree`).
   *   2. If zero files → `showInformationMessage`, return.
   *   3. Else show a multi-select QuickPick of the changed files (with M/A/D/R/C/T/U status).
   *   4. For each selected file, open a `vscode.diff` tab:
   *        left  = `intellig-git:<filePath>?<branchRef>` (served by the git content provider)
   *        right = on-disk working-tree file
   *      title  = `<basename> (<branchRef> ↔ Working Tree)`
   *   5. User cancels the QuickPick → no-op, no toast, no error.
   */
  private async _handleShowDiffWithWorkingTree(item: BranchTreeItem): Promise<void> {
    const repo = this._resolveRepository(item);
    if (!repo || !item.branch) {
      return;
    }

    const branchRef = item.branch.name;

    let files: IRefDiffFile[];
    try {
      // Capability is declared optional on IGitService so implementations can opt in;
      // all production impls provide it, but guard in case a mock omits it.
      if (typeof this._gitService.getChangedFilesAgainstWorkingTree !== 'function') {
        void vscode.window.showErrorMessage(
          'Failed to show diff: Git service does not support ref-vs-working-tree diffs'
        );
        return;
      }
      files = await this._gitService.getChangedFilesAgainstWorkingTree(repo, branchRef);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to list changed files: ${sanitizeGitError(errorMessage)}`
      );
      return;
    }

    if (files.length === 0) {
      void vscode.window.showInformationMessage(`No changes between ${branchRef} and working tree`);
      return;
    }

    // Multi-select QuickPick: one row per changed file, prefixed with the status code.
    const items: Array<vscode.QuickPickItem & { file: IRefDiffFile }> = files.map((f) => ({
      label: `${f.status} ${f.path}`,
      description: f.oldPath ? `← ${f.oldPath}` : undefined,
      file: f,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      title: `Compare with ${branchRef}`,
      placeHolder: 'Select files to diff against the working tree (multi-select)…',
      canPickMany: true,
      matchOnDescription: true,
    });

    // User cancelled (hit Esc) → `selected` is undefined.
    // User accepted nothing → `selected` is an empty array; still a no-op.
    if (!selected || selected.length === 0) {
      return;
    }

    const rootFsPath = repo.rootUri.fsPath;
    const separator = rootFsPath.endsWith('/') || rootFsPath.endsWith('\\') ? '' : '/';

    for (const pick of selected) {
      const filePath = pick.file.path;
      const leftUri = vscode.Uri.parse(`intellig-git:${filePath}?${encodeURIComponent(branchRef)}`);
      const rightUri = vscode.Uri.file(`${rootFsPath}${separator}${filePath}`);
      const basename = filePath.substring(filePath.lastIndexOf('/') + 1);
      const title = `${basename} (${branchRef} ↔ Working Tree)`;

      await openRevisionDiff({ leftUri, rightUri, title }, `Failed to show diff for ${filePath}`);
    }
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
  private async _handleCheckoutAndRebase(item: BranchTreeItem): Promise<void> {
    const repo = this._resolveRepository(item);
    if (!repo || !item.branch) {
      return;
    }

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
    const isRemote = item.branch.type === 'remote';
    const remoteFullName = item.branch.name; // e.g. 'origin/main'
    const localLeafName = isRemote
      ? remoteFullName.split('/').slice(1).join('/') // 'origin/main' → 'main'
      : item.branch.name;
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
          await checkout();
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
   * Handle pull using rebase command for remote branches.
   * Pulls directly with the `rebase` preset (rebase=true) and the
   * remote/branch parsed from the menu item. The second "Pull: Options"
   * QuickPick is intentionally bypassed — the menu entry already chose the
   * strategy.
   */
  private async _handlePullUsingRebase(item: BranchTreeItem): Promise<void> {
    await this._runPullFromBranchMenu(item, 'rebase');
  }

  /**
   * Handle pull using merge command for remote branches.
   * Pulls directly with the `merge` preset (rebase=false). The
   * second "Pull: Options" QuickPick is intentionally bypassed.
   */
  private async _handlePullUsingMerge(item: BranchTreeItem): Promise<void> {
    await this._runPullFromBranchMenu(item, 'merge');
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
    item: BranchTreeItem,
    preset: 'rebase' | 'merge'
  ): Promise<void> {
    const repo = this._resolveRepository(item);
    if (!repo || !item.branch) {
      return;
    }

    // Parse remote name and branch name from item.branch.name
    // (e.g., "origin/main" -> "origin", "main")
    const slashIndex = item.branch.name.indexOf('/');
    const remoteName =
      slashIndex >= 0 ? item.branch.name.substring(0, slashIndex) : item.branch.name;
    const branchName =
      slashIndex >= 0 ? item.branch.name.substring(slashIndex + 1) : item.branch.name;

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
        `Pulled '${item.branch.name}' into current branch using ${strategy}`
      );
      // Pull moved HEAD; reload before refresh.
      await this._gitService.reloadRepository(repo);
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      // Conflict handoff: when the conflict service is wired in (always true
      // in production via ExtensionServices — see `ConflictResolutionService`
      // construction in `ExtensionServices.initialize`), probe the working
      // tree for unresolved conflicts and auto-open the Resolve Conflicts
      // dialog if any are present. Pull-using-rebase maps to `'rebase'` and
      // pull-using-merge maps to `'merge'` — conceptually the same
      // post-conflict states merge / rebase produce directly.
      // Wrap the probe + dialog handoff in an inner try/catch so
      // a probe failure (git process crash, transient fs/access issue) does
      // NOT swallow the original pull error. Before this guard, a throw
      // from `getConflictedFiles` (or from the dialog wiring) escaped the
      // outer catch block before the generic `showErrorMessage` ran,
      // leaving the user with no surface-level feedback on the real pull
      // failure. We log-and-fall-through: the generic error below still
      // fires, and the probe error is captured for debugging.
      if (this._conflictResolutionService) {
        try {
          const conflicts = await this._conflictResolutionService.getConflictedFiles(repo);
          if (conflicts.length > 0) {
            await this._openResolveConflictsDialog(
              repo,
              conflicts.map((c) => c.path),
              { operation: preset === 'rebase' ? 'rebase' : 'merge', target: item.branch.name }
            );
            // Pull may have partially advanced HEAD before the
            // conflict; reload so the tree reflects the post-conflict state.
            await this._gitService.reloadRepository(repo);
            this._branchTreeProvider.refresh();
            return;
          }
        } catch (probeError) {
          // Do NOT surface a toast for the probe failure itself — the
          // outer generic error below is the one the user cares about
          // (it names the pull strategy + the original fatal). Keep the
          // probe error in the log for debugging.
          getLogger()
            .child({ component: 'BranchContextMenuCommands' })
            .warn('pull-fallback conflict probe failed', {
              probeError: probeError instanceof Error ? probeError.message : String(probeError),
            });
        }
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
  private async _handleCheckoutAsLocal(item: BranchTreeItem): Promise<void> {
    const repo = this._resolveRepository(item);
    if (!repo || !item.branch) {
      return;
    }

    // Parse remote name from branch name (e.g., "origin/main" -> "origin", "main")
    const parts = item.branch.name.split('/');
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

      // checkout-as-local moved HEAD; reload before refresh.
      await this._gitService.reloadRepository(repo);
      void vscode.window.showInformationMessage(`Switched to branch '${branchName}'`);
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
          // `-B` create-or-resets regardless of whether a local exists.
          await this._gitService.checkout(repo, branchName, { forceCreate: true, track }).match(
            () => undefined,
            (e) => {
              throw e;
            }
          );
          // Stash + checkout moved HEAD; reload before refresh.
          await this._gitService.reloadRepository(repo);
          void vscode.window.showInformationMessage(
            `Stashed changes and switched to '${branchName}'`
          );
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

  /**
   * Handle cherry-pick commits command.
   */
  private async _handleCherryPickCommits(item: BranchTreeItem): Promise<void> {
    const repo = this._resolveRepository(item);
    if (!repo || !item.branch) {
      return;
    }

    try {
      // Scope the log to the SELECTED branch (e.g. `origin/feature`), not the
      // repo's global HEAD history — otherwise the picker lists HEAD's recent
      // commits and the user cherry-picks the wrong commits.
      const commits = await this._gitService.getLog(repo, {
        maxCount: 50,
        ref: item.branch.name,
      });

      const commitItems = commits.map((commit) => ({
        label: commit.shortHash,
        description: commit.message.split('\n')[0],
        detail: `${commit.author.name} - ${commit.authorDate.toLocaleDateString()}`,
        commit,
      }));

      const selected = await vscode.window.showQuickPick(commitItems, {
        title: `Cherry-pick commits from ${item.branch.name}`,
        placeHolder: 'Select commits to cherry-pick',
        canPickMany: true,
      });

      if (!selected || selected.length === 0) {
        return;
      }

      const commitHashes = selected.map((s) => s.commit.hash);
      const result = await this._gitService.cherryPick(repo, commitHashes).match(
        (r) => r,
        (e) => {
          throw e;
        }
      );

      if (result.success) {
        void vscode.window.showInformationMessage(
          `Cherry-picked ${selected.length} commit(s) successfully`
        );
      } else if (result.conflicts && result.conflicts.length > 0) {
        // Auto-open Resolve Conflicts dialog when wired.
        if (this._conflictResolutionService) {
          await this._openResolveConflictsDialog(repo, result.conflicts, {
            operation: 'cherryPick',
            target: item.branch.name,
          });
        } else {
          void vscode.window.showWarningMessage(
            `Cherry-pick conflicts in ${result.conflicts.length} file(s). Please resolve conflicts.`
          );
        }
      } else {
        // Non-conflict failure: surface the underlying git error.
        const reason = result.failureReason ?? 'unknown error (no output from git)';
        void vscode.window.showErrorMessage(`Failed to cherry-pick: ${sanitizeGitError(reason)}`);
      }
      // cherry-pick moved HEAD; reload before refresh.
      await this._gitService.reloadRepository(repo);
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to cherry-pick: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * Handle pull into current command.
   *
   * Delegates to `_runPullFromBranchMenu` with the default ("merge")
   * preset so the user gets the same direct-pull + conflict-handoff
   * pipeline as the pullUsingMerge/Rebase entries. This path does
   * not open the second "Pull: Options" QuickPick — the right-click
   * entry already chose the strategy. The conflict-handoff
   * still fires on a conflicted pull.
   */
  private async _handlePullIntoCurrent(item: BranchTreeItem): Promise<void> {
    await this._runPullFromBranchMenu(item, 'merge');
  }

  /**
   * Handle delete remote branch command.
   */
  private async _handleDeleteRemote(item: BranchTreeItem): Promise<void> {
    const repo = this._resolveRepository(item);
    if (!repo || !item.branch) {
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Are you sure you want to delete the remote branch '${item.branch.name}'? This cannot be undone.`,
      { modal: true },
      'Delete'
    );

    if (confirm !== 'Delete') {
      return;
    }

    // Parse remote name from branch name
    const parts = item.branch.name.split('/');
    const remoteName = parts[0];
    const branchName = parts.slice(1).join('/');

    try {
      // Use git push to delete remote branch
      await this._gitService
        .push(repo, {
          remote: remoteName,
          branch: `:${branchName}`,
        })
        .match(
          () => undefined,
          (e) => {
            throw e;
          }
        );

      // Push:branch removed remote ref; reload so the tree's
      // remote-branches list reflects the deletion.
      await this._gitService.reloadRepository(repo);
      void vscode.window.showInformationMessage(`Deleted remote branch '${item.branch.name}'`);
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to delete remote branch: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * IntelliJ-parity "Track Branch" — single menu
   * entry with smart detection of the user's intent based on whether a
   * matching local branch already exists.
   *
   * Behaviour matrix (matching IntelliJ's "Track Branch" semantics):
   *
   *   - **No local with the simple name**: create + checkout the local
   *     branch with the right-clicked remote ref as upstream
   *     (`git checkout --track <remote>/<branch>` shape via
   *     `gitService.checkout(createBranch: true, track: …)`).
   *
   *   - **Local exists with no upstream**: silently set its upstream
   *     to the right-clicked remote ref via
   *     `gitService.setBranchUpstream(local, upstream)`. No checkout
   *     (the user is already in the local; if they're not, they didn't
   *     ask to switch).
   *
   *   - **Local exists with a different upstream**: confirm dialog,
   *     then `gitService.setBranchUpstream(local, upstream)` if the
   *     user agrees. The cross-tracking case is the one footgun in
   *     this menu — without confirm, the user could accidentally lose
   *     their existing tracking association on `git pull`.
   *
   *   - **Local exists with the SAME upstream**: no-op + info toast
   *     ("Already tracking …"). Saves the user wondering whether the
   *     menu fired at all.
   *
   * We exposed only `Checkout (as new local)` for remote
   * branches, which always created a new local — the existing-local
   * cross-tracking case had no menu surface at all. Closes that
   * IntelliJ-parity gap.
   */
  private async _handleTrackRemote(item: BranchTreeItem): Promise<void> {
    const repo = this._resolveRepository(item);
    if (!repo || !item.branch) {
      return;
    }

    // Parse remote name from branch name (e.g. "origin/main" -> remote
    // "origin", branch "main"). The "simple name" extraction matches
    // the existing checkoutAsLocal path; nested branch names like
    // `origin/feature/foo` produce simple-name `feature/foo`.
    const parts = item.branch.name.split('/');
    if (parts.length < 2) {
      // Defensive — `IBranch.type === 'remote'` should guarantee a
      // remote-prefixed name, but if somehow we got a malformed input
      // surface a clear error rather than crashing on the slice below.
      void vscode.window.showErrorMessage(
        `Cannot parse remote branch '${item.branch.name}' — expected format <remote>/<branch>.`
      );
      return;
    }
    const upstreamRef = item.branch.name; // e.g. "origin/main"
    const simpleName = parts.slice(1).join('/');

    // SK-2 — defense-in-depth: sweep relied on
    // validateBranchName at the service boundary for checkout({ createBranch }),
    // but the simpleName here is sliced from a parsed remote branch name
    // which could theoretically be hostile (e.g. a malformed remote ref like
    // `origin/-evil` or `origin/.hidden`). Guard explicitly before the
    // checkout / setBranchUpstream call so the error surface is a friendly
    // showErrorMessage rather than a service-boundary throw.
    if (simpleName.startsWith('-') || simpleName.startsWith('.')) {
      void vscode.window.showErrorMessage(
        `Cannot create local branch from remote with reserved name prefix: ${simpleName}`
      );
      return;
    }

    let existingLocal: IBranch | undefined;
    try {
      const branches = await this._gitService.getBranches(repo);
      existingLocal = branches.find((b) => b.type === 'local' && b.name === simpleName);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to load branches: ${sanitizeGitError(msg)}`);
      return;
    }

    try {
      if (!existingLocal) {
        // No local with this name → create + checkout with --track.
        await this._gitService
          .checkout(repo, simpleName, {
            createBranch: true,
            track: upstreamRef,
          })
          .match(
            () => undefined,
            (e) => {
              throw e;
            }
          );
        await this._gitService.reloadRepository(repo);
        void vscode.window.showInformationMessage(
          `Created local branch '${simpleName}' tracking '${upstreamRef}'`
        );
        this._branchTreeProvider.refresh();
        return;
      }

      // Existing local — examine its upstream.
      const currentUpstream = existingLocal.upstream
        ? `${existingLocal.upstream.remote}/${existingLocal.upstream.name}`
        : undefined;

      if (currentUpstream === upstreamRef) {
        void vscode.window.showInformationMessage(
          `'${simpleName}' already tracks '${upstreamRef}'`
        );
        return;
      }

      if (currentUpstream && currentUpstream !== upstreamRef) {
        const confirm = await vscode.window.showWarningMessage(
          `'${simpleName}' currently tracks '${currentUpstream}'. Re-track to '${upstreamRef}'?`,
          { modal: true },
          'Re-track'
        );
        if (confirm !== 'Re-track') {
          return;
        }
      }

      await this._gitService.setBranchUpstream(repo, simpleName, upstreamRef).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      await this._gitService.reloadRepository(repo);
      void vscode.window.showInformationMessage(`'${simpleName}' now tracks '${upstreamRef}'`);
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to track branch: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  // ============================================
  // Tag Command Handlers
  // ============================================

  /**
   * Handle tag checkout (detached) command.
   */
  private async _handleTagCheckoutDetached(item: BranchTreeItem): Promise<void> {
    const repo = this._resolveRepository(item);
    if (!repo || !item.tag) {
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Checking out tag '${item.tag.name}' will put you in detached HEAD state. Continue?`,
      { modal: true },
      'Checkout'
    );

    if (confirm !== 'Checkout') {
      return;
    }

    try {
      await this._gitService.checkout(repo, item.tag.name).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      // checkout-tag moved HEAD into detached state; reload
      // before refresh so the tree's "current branch" mark clears
      // (HEAD chip on the log graph drives the user-visible cue).
      await this._gitService.reloadRepository(repo);
      void vscode.window.showInformationMessage(
        `Checked out tag '${item.tag.name}' (detached HEAD)`
      );
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to checkout tag: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * Handle new branch from tag command.
   */
  private async _handleTagNewBranchFrom(item: BranchTreeItem): Promise<void> {
    // Reuse the same logic as branch new branch from
    await this._handleNewBranchFrom(item);
  }

  /**
   * Handle tag cherry-pick command.
   */
  private async _handleTagCherryPick(item: BranchTreeItem): Promise<void> {
    const repo = this._resolveRepository(item);
    if (!repo || !item.tag) {
      return;
    }

    try {
      const result = await this._gitService.cherryPick(repo, [item.tag.commit]).match(
        (r) => r,
        (e) => {
          throw e;
        }
      );

      if (result.success) {
        void vscode.window.showInformationMessage(
          `Cherry-picked tag '${item.tag.name}' successfully`
        );
      } else if (result.conflicts && result.conflicts.length > 0) {
        void vscode.window.showWarningMessage(
          `Cherry-pick conflicts in ${result.conflicts.length} file(s). Please resolve conflicts.`
        );
      } else {
        // Non-conflict failure: surface the underlying git error.
        const reason = result.failureReason ?? 'unknown error (no output from git)';
        void vscode.window.showErrorMessage(`Failed to cherry-pick: ${sanitizeGitError(reason)}`);
      }
      // cherry-pick from tag moved HEAD; reload before refresh.
      await this._gitService.reloadRepository(repo);
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to cherry-pick: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * Handle tag "Merge into Current" command — merge the selected tag into the
   * current branch. IntelliJ git4idea parity: GitBranchPopupActions.TagActions
   * offers a MergeAction built from `new GitTag(tagName)`, so the same
   * `Merge <ref> into Current` flow that branches use applies to a tag ref.
   *
   * Reuses the existing merge surface: routes through the Merge Dialog when
   * wired (the dialog feeds the tag name straight into `mergeBranch` as a
   * generic source ref and owns the ff-only/no-ff/squash options plus conflict
   * handoff), falling back to a direct `mergeBranch` with the same conflict /
   * non-conflict-failure routing as `_handleMergeIntoCurrent`.
   */
  private async _handleTagMergeIntoCurrent(item: BranchTreeItem): Promise<void> {
    const repo = this._resolveRepository(item);
    if (!repo || !item.tag) {
      return;
    }

    const tagRef = item.tag.name;

    if (this._mergeDialogOpener) {
      this._mergeDialogOpener({ repo, sourceBranch: tagRef });
      return;
    }

    try {
      const result = await this._gitService.mergeBranch(repo, tagRef);

      if (result.success) {
        void vscode.window.showInformationMessage(`Merged '${tagRef}' successfully`);
      } else if (result.conflicts && result.conflicts.length > 0) {
        if (this._conflictResolutionService) {
          await this._openResolveConflictsDialog(repo, result.conflicts, {
            operation: 'merge',
            target: tagRef,
          });
        } else {
          void vscode.window.showWarningMessage(
            `Merge conflicts in ${result.conflicts.length} file(s). Please resolve conflicts.`
          );
        }
      } else {
        const reason = result.failureReason ?? 'unknown error (no output from git)';
        void vscode.window.showErrorMessage(
          `Failed to merge '${tagRef}': ${sanitizeGitError(reason)}`
        );
      }
      // Merge moved HEAD; reload before refresh.
      await this._gitService.reloadRepository(repo);
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to merge tag: ${sanitizeGitError(errorMessage)}`);
    }
  }

  /**
   * Handle delete tag command.
   */
  private async _handleTagDelete(item: BranchTreeItem): Promise<void> {
    const repo = this._resolveRepository(item);
    if (!repo || !item.tag) {
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Are you sure you want to delete the tag '${item.tag.name}'?`,
      { modal: true },
      'Delete'
    );

    if (confirm !== 'Delete') {
      return;
    }

    try {
      await this._gitService.deleteTag(repo, item.tag.name).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      // Tag list changed; reload so the tree's tags section
      // reflects the post-deletion ref set.
      await this._gitService.reloadRepository(repo);
      void vscode.window.showInformationMessage(`Deleted tag '${item.tag.name}'`);
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to delete tag: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * Handle push tag command.
   */
  private async _handleTagPush(item: BranchTreeItem): Promise<void> {
    const repo = this._resolveRepository(item);
    if (!repo || !item.tag) {
      return;
    }

    try {
      // Choose the target remote when several exist (default = origin / first);
      // a single remote pushes without prompting. Cancel aborts.
      const targetRemote = await this._chooseTargetRemote(repo);
      if (!targetRemote) {
        return;
      }
      await this._gitService.pushTag(repo, item.tag.name, targetRemote).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      void vscode.window.showInformationMessage(
        `Pushed tag '${item.tag.name}' to '${targetRemote}'`
      );
      // pushTag updates remote-tracking refs;
      // reload + refresh so the tag tree's "pushed to remote" cue
      // (when present) reads the post-push state.
      await this._gitService.reloadRepository(repo);
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to push tag: ${sanitizeGitError(errorMessage)}`);
    }
  }

  /**
   * Handle delete-remote-tag command — IntelliJ GitDeleteRemoteTagOperation parity
   * (`git4idea/backend/src/ui/GitTagDialog.java` and
   * `StashTagHistoryOps.deleteRemoteTag`).
   *
   * Prompts for confirmation then calls
   * `git push <remote> :refs/tags/<name>` via the existing
   * {@link StashTagHistoryOps.deleteRemoteTag} op. Errors route through
   * {@link sanitizeGitError} so credentials in remote URLs are stripped.
   */
  private async _handleTagDeleteRemote(item: BranchTreeItem): Promise<void> {
    const repo = this._resolveRepository(item);
    if (!repo || !item.tag) {
      return;
    }

    // Choose the target remote (default = origin / first; prompt when several
    // exist), mirroring `_handleTagPush` — don't silently hardcode origin in a
    // multi-remote repo. Cancel aborts.
    const targetRemote = await this._chooseTargetRemote(repo);
    if (!targetRemote) {
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Delete remote tag '${item.tag.name}' from ${targetRemote}?`,
      { modal: true },
      'Delete from Remote'
    );

    if (confirm !== 'Delete from Remote') {
      return;
    }

    try {
      await this._gitService.deleteRemoteTag(repo, item.tag.name, targetRemote).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      void vscode.window.showInformationMessage(
        `Deleted remote tag '${item.tag.name}' from ${targetRemote}`
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to delete remote tag: ${sanitizeGitError(errorMessage)}`
      );
    }
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
 * Recognise the canonical "not fully merged" stderr emitted by
 * `git branch -d` when the branch's tip is unreachable from any other
 * ref. Used to upgrade the failure path to a "Force delete?" prompt
 * rather than surfacing the raw CLI hint to the user.
 *
 * Matches across git versions and locales by checking for the stable
 * "not fully merged" phrase. The full message is roughly:
 *   error: the branch '<name>' is not fully merged
 *   If you are sure you want to delete it, run 'git branch -D <name>'
 */
export function isNotFullyMergedError(message: string): boolean {
  return /not fully merged/i.test(message);
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
