/**
 * Branch Context Menu Commands implementation.
 * Provides command handlers for branch, remote branch, and tag context menus.
 */

import * as vscode from 'vscode';
import {
  IBranch,
  IGitService,
  IRefDiffFile,
  IRepository,
} from '../git-core/interfaces/IGitService';
import { BranchTreeItem, BranchTreeProvider } from './BranchTreeProvider';
import { IConflictResolutionService } from '../conflicts/interfaces/IConflictResolutionService';
import type { PullDialog } from '../sync/PullDialog';
import type { PushDialog, IPushPreselect } from '../sync/PushDialog';
import type { MergeDialog } from '../conflicts/MergeDialog';
import type { RebaseDialog } from '../rebase/RebaseDialog';
import type { NewBranchDialog } from './NewBranchDialog';
import { sanitizeGitError, worktreeConflictMessage } from '../git-core/gitError';
import { getLogger, registerLoggedCommand } from '../utils/logger';

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
      registerLoggedCommand('intellig.tag.delete', (item: BranchTreeItem) =>
        this._handleTagDelete(item)
      )
    );

    this._disposables.push(
      registerLoggedCommand('intellig.tag.push', (item: BranchTreeItem) =>
        this._handleTagPush(item)
      )
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

  // ============================================
  // Local Branch Command Handlers
  // ============================================

  /**
   * Handle checkout command for local branches.
   */
  private async _handleCheckout(item: BranchTreeItem): Promise<void> {
    const repo = this._getRepository();
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
      await this._gitService.checkout(repo, ref);
      // Checkout moved HEAD; reload before refresh so the
      // BranchTreeProvider's "current branch" mark reflects fresh state.
      await this._gitService.reloadRepository(repo);
      void vscode.window.showInformationMessage(successToast());
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const worktreeMessage = worktreeConflictMessage(errorMessage);
      if (worktreeMessage) {
        // git refuses a worktree-conflict checkout atomically — there is
        // nothing to stash or force around, so surface an actionable
        // message instead of the Stash/Force prompt.
        void vscode.window.showErrorMessage(worktreeMessage);
      } else if (
        errorMessage.includes('would be overwritten') ||
        errorMessage.includes('Please commit your changes or stash them')
      ) {
        const choice = await vscode.window.showWarningMessage(
          dirtyHeader(),
          'Stash & Switch',
          'Force Checkout',
          'Cancel'
        );
        if (choice === 'Stash & Switch') {
          try {
            await this._gitService.stash(repo, stashLabel());
            await this._gitService.checkout(repo, ref);
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
            await this._gitService.checkout(repo, ref, { force: true });
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
      } else {
        void vscode.window.showErrorMessage(
          `Failed to checkout branch: ${sanitizeGitError(errorMessage)}`
        );
      }
    }
  }

  /**
   * Handle new branch from here command.
   */
  private async _handleNewBranchFrom(item: BranchTreeItem): Promise<void> {
    const repo = this._getRepository();
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
      await this._gitService.createBranch(repo, branchName, startPoint);
      await this._gitService.checkout(repo, branchName);
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
    const repo = this._getRepository();
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
    const repo = this._getRepository();
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
          await this._gitService.rebaseAbort(repo);
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
    const repo = this._getRepository();
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
    const repo = this._getRepository();
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
      await this._gitService.renameBranch(repo, item.branch.name, newName);
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
    const repo = this._getRepository();
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
      await this._gitService.deleteBranch(repo, branchName);
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
          await this._gitService.deleteBranch(repo, branchName, true);
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
    const repo = this._getRepository();
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
      await this._gitService.fetch(repo, { remote: upstream.remote, prune: true });
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
   * Handle push command for local branches.
   * Pushes the branch to its upstream remote, or sets upstream if none configured.
   */
  private async _handlePush(item: BranchTreeItem): Promise<void> {
    const repo = this._getRepository();
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
      // to --set-upstream against the fallback remote (issue #19).
      this._pushDialogOpener({
        repo,
        branch: item.branch.name,
        upstream: item.branch.upstream,
        // Thread the clicked branch's OWN divergence so a non-HEAD row shows
        // its real ahead/behind and the force-with-lease flip fires (#19b).
        ahead: item.branch.ahead,
        behind: item.branch.behind,
      });
      return;
    }

    try {
      const upstream = item.branch.upstream;
      if (upstream) {
        await this._gitService.push(repo, {
          remote: upstream.remote,
          branch: item.branch.name,
        });
      } else {
        await this._gitService.push(repo, {
          branch: item.branch.name,
          setUpstream: true,
        });
      }
      void vscode.window.showInformationMessage(`Pushed branch '${item.branch.name}'`);
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
    const repo = this._getRepository();
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

      try {
        await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        void vscode.window.showErrorMessage(
          `Failed to show diff for ${filePath}: ${sanitizeGitError(errorMessage)}`
        );
      }
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
    const repo = this._getRepository();
    if (!repo || !item.branch) {
      return;
    }

    // Store the current branch name before checkout
    const previousCurrentBranch = repo.head?.name?.replace('refs/heads/', '') || 'HEAD';

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
      isRemote
        ? this._gitService.checkout(repo, localLeafName, {
            forceCreate: true,
            track: remoteFullName,
            ...(force ? { force: true } : {}),
          })
        : this._gitService.checkout(repo, localLeafName, force ? { force: true } : undefined);

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
      const worktreeMessage = worktreeConflictMessage(errorMessage);
      if (worktreeMessage) {
        // git refuses a worktree-conflict checkout atomically — surface an
        // actionable message rather than the Stash/Force prompt.
        void vscode.window.showErrorMessage(worktreeMessage);
      } else if (
        errorMessage.includes('would be overwritten') ||
        errorMessage.includes('Please commit your changes or stash them')
      ) {
        const choice = await vscode.window.showWarningMessage(
          `Cannot switch to '${displayName}': local changes would be overwritten.`,
          'Stash & Switch',
          'Force Checkout',
          'Cancel'
        );
        if (choice === 'Stash & Switch') {
          try {
            await this._gitService.stash(repo, `Auto-stash before checkout ${displayName}`);
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
      } else {
        void vscode.window.showErrorMessage(
          `Failed to checkout and rebase: ${sanitizeGitError(errorMessage)}`
        );
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
    const repo = this._getRepository();
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
      await this._gitService.pull(repo, {
        remote: remoteName,
        branch: branchName,
        rebase: preset === 'rebase',
        prune: true,
      });
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
    const repo = this._getRepository();
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
          await this._gitService.stash(repo, `Auto-stash before checkout ${branchName}`);
        } else if (choice !== 'Reset anyway') {
          // Cancel (or dialog dismissed): do not touch the local branch.
          return;
        }
      }

      // Create-or-reset the local to the remote tip in one step.
      await this._gitService.checkout(repo, branchName, { forceCreate: true, track });

      // checkout-as-local moved HEAD; reload before refresh.
      await this._gitService.reloadRepository(repo);
      void vscode.window.showInformationMessage(`Switched to branch '${branchName}'`);
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const worktreeMessage = worktreeConflictMessage(errorMessage);
      if (worktreeMessage) {
        // git refuses a worktree-conflict checkout atomically — surface an
        // actionable message rather than the Stash/Force prompt.
        void vscode.window.showErrorMessage(worktreeMessage);
      } else if (
        errorMessage.includes('would be overwritten') ||
        errorMessage.includes('Please commit your changes or stash them')
      ) {
        const choice = await vscode.window.showWarningMessage(
          `Cannot switch to '${branchName}': local changes would be overwritten.`,
          'Stash & Switch',
          'Force Checkout',
          'Cancel'
        );
        if (choice === 'Stash & Switch') {
          try {
            await this._gitService.stash(repo, `Auto-stash before checkout ${branchName}`);
            // `-B` create-or-resets regardless of whether a local exists.
            await this._gitService.checkout(repo, branchName, { forceCreate: true, track });
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
            await this._gitService.checkout(repo, branchName, {
              forceCreate: true,
              force: true,
              track,
            });
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
      } else {
        void vscode.window.showErrorMessage(
          `Failed to checkout branch: ${sanitizeGitError(errorMessage)}`
        );
      }
    }
  }

  /**
   * Handle cherry-pick commits command.
   */
  private async _handleCherryPickCommits(item: BranchTreeItem): Promise<void> {
    const repo = this._getRepository();
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
      const result = await this._gitService.cherryPick(repo, commitHashes);

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
    const repo = this._getRepository();
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
      await this._gitService.push(repo, {
        remote: remoteName,
        branch: `:${branchName}`,
      });

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
    const repo = this._getRepository();
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
        await this._gitService.checkout(repo, simpleName, {
          createBranch: true,
          track: upstreamRef,
        });
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

      await this._gitService.setBranchUpstream(repo, simpleName, upstreamRef);
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
    const repo = this._getRepository();
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
      await this._gitService.checkout(repo, item.tag.name);
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
    const repo = this._getRepository();
    if (!repo || !item.tag) {
      return;
    }

    try {
      const result = await this._gitService.cherryPick(repo, [item.tag.commit]);

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
   * Handle delete tag command.
   */
  private async _handleTagDelete(item: BranchTreeItem): Promise<void> {
    const repo = this._getRepository();
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
      await this._gitService.deleteTag(repo, item.tag.name);
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
    const repo = this._getRepository();
    if (!repo || !item.tag) {
      return;
    }

    try {
      await this._gitService.pushTag(repo, item.tag.name);
      void vscode.window.showInformationMessage(`Pushed tag '${item.tag.name}' to remote`);
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
