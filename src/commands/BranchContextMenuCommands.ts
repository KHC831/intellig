/**
 * Branch Context Menu Commands implementation.
 * Provides command handlers for branch, remote branch, and tag context menus.
 */

import * as vscode from 'vscode';
import { IGitService, IRefDiffFile, IRepository } from '../services/interfaces/IGitService';
import { BranchTreeItem, BranchTreeProvider } from '../services/BranchTreeProvider';
import { IConflictResolutionService } from '../services/interfaces/IConflictResolutionService';
import type { PullDialog } from '../services/PullDialog';
import type { PushDialog } from '../services/PushDialog';
import type { MergeDialog } from '../services/MergeDialog';
import type { NewBranchDialog } from '../services/NewBranchDialog';

/** Thunk that lazily returns the shared {@link PullDialog} singleton. */
export type PullDialogAccessor = () => PullDialog | undefined;

/**
 * Thunk that opens a fresh Push Dialog pre-selected on the given repo + branch.
 * Push dialogs are not singletons (row table reflects current state), so this
 * is a one-shot opener rather than a getter.
 */
export type PushDialogOpener = (preselect: {
  repo: IRepository;
  branch?: string;
}) => PushDialog | undefined;

/**
 * T3-02: open a fresh Merge Dialog for `repo` merging `sourceBranch` into
 * the current branch.
 */
export type MergeDialogOpener = (preselect: {
  repo: IRepository;
  sourceBranch: string;
}) => MergeDialog | undefined;

/**
 * T3-03: open a fresh New Branch Dialog with the given start point.
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
  private _newBranchDialogOpener?: NewBranchDialogOpener;
  private _disposables: vscode.Disposable[] = [];

  constructor(
    gitService: IGitService,
    branchTreeProvider: BranchTreeProvider,
    conflictResolutionService?: IConflictResolutionService,
    pullDialogAccessor?: PullDialogAccessor,
    pushDialogOpener?: PushDialogOpener,
    mergeDialogOpener?: MergeDialogOpener,
    newBranchDialogOpener?: NewBranchDialogOpener
  ) {
    this._gitService = gitService;
    this._branchTreeProvider = branchTreeProvider;
    this._conflictResolutionService = conflictResolutionService;
    this._pullDialogAccessor = pullDialogAccessor;
    this._pushDialogOpener = pushDialogOpener;
    this._mergeDialogOpener = mergeDialogOpener;
    this._newBranchDialogOpener = newBranchDialogOpener;
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
   * T1-02 extends the operation union with `'pull'` (pull-using-rebase maps
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
    }
  ): Promise<void> {
    if (!this._conflictResolutionService || conflicts.length === 0) {
      return;
    }
    await this._conflictResolutionService.openResolveConflictsDialog(
      repo,
      conflicts.map((p) => ({ path: p, resolved: false })),
      {
        operation: opContext.operation,
        target: opContext.target,
        canAbort: true,
        canContinue: true,
      }
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
      vscode.commands.registerCommand('intellig.branch.checkout', (item: BranchTreeItem) =>
        this._handleCheckout(item)
      )
    );

    this._disposables.push(
      vscode.commands.registerCommand('intellig.branch.newBranchFrom', (item: BranchTreeItem) =>
        this._handleNewBranchFrom(item)
      )
    );

    this._disposables.push(
      vscode.commands.registerCommand('intellig.branch.mergeIntoCurrent', (item: BranchTreeItem) =>
        this._handleMergeIntoCurrent(item)
      )
    );

    this._disposables.push(
      vscode.commands.registerCommand('intellig.branch.rebaseCurrentOnto', (item: BranchTreeItem) =>
        this._handleRebaseCurrentOnto(item)
      )
    );

    this._disposables.push(
      vscode.commands.registerCommand(
        'intellig.branch.compareWithCurrent',
        (item: BranchTreeItem) => this._handleCompareWithCurrent(item)
      )
    );

    this._disposables.push(
      vscode.commands.registerCommand('intellig.branch.rename', (item: BranchTreeItem) =>
        this._handleRename(item)
      )
    );

    this._disposables.push(
      vscode.commands.registerCommand('intellig.branch.delete', (item: BranchTreeItem) =>
        this._handleDelete(item)
      )
    );

    // Remote branch commands
    this._disposables.push(
      vscode.commands.registerCommand(
        'intellig.remoteBranch.checkoutAsLocal',
        (item: BranchTreeItem) => this._handleCheckoutAsLocal(item)
      )
    );

    this._disposables.push(
      vscode.commands.registerCommand(
        'intellig.remoteBranch.cherryPickCommits',
        (item: BranchTreeItem) => this._handleCherryPickCommits(item)
      )
    );

    this._disposables.push(
      vscode.commands.registerCommand(
        'intellig.remoteBranch.pullIntoCurrent',
        (item: BranchTreeItem) => this._handlePullIntoCurrent(item)
      )
    );

    this._disposables.push(
      vscode.commands.registerCommand(
        'intellig.remoteBranch.deleteRemote',
        (item: BranchTreeItem) => this._handleDeleteRemote(item)
      )
    );

    // New command handlers
    this._disposables.push(
      vscode.commands.registerCommand('intellig.branch.update', (item: BranchTreeItem) =>
        this._handleUpdate(item)
      )
    );

    this._disposables.push(
      vscode.commands.registerCommand('intellig.branch.push', (item: BranchTreeItem) =>
        this._handlePush(item)
      )
    );

    this._disposables.push(
      vscode.commands.registerCommand(
        'intellig.branch.showDiffWithWorkingTree',
        (item: BranchTreeItem) => this._handleShowDiffWithWorkingTree(item)
      )
    );

    this._disposables.push(
      vscode.commands.registerCommand('intellig.branch.checkoutAndRebase', (item: BranchTreeItem) =>
        this._handleCheckoutAndRebase(item)
      )
    );

    this._disposables.push(
      vscode.commands.registerCommand(
        'intellig.remoteBranch.pullUsingRebase',
        (item: BranchTreeItem) => this._handlePullUsingRebase(item)
      )
    );

    this._disposables.push(
      vscode.commands.registerCommand(
        'intellig.remoteBranch.pullUsingMerge',
        (item: BranchTreeItem) => this._handlePullUsingMerge(item)
      )
    );

    // Tag commands
    this._disposables.push(
      vscode.commands.registerCommand('intellig.tag.checkoutDetached', (item: BranchTreeItem) =>
        this._handleTagCheckoutDetached(item)
      )
    );

    this._disposables.push(
      vscode.commands.registerCommand('intellig.tag.newBranchFrom', (item: BranchTreeItem) =>
        this._handleTagNewBranchFrom(item)
      )
    );

    this._disposables.push(
      vscode.commands.registerCommand('intellig.tag.cherryPick', (item: BranchTreeItem) =>
        this._handleTagCherryPick(item)
      )
    );

    this._disposables.push(
      vscode.commands.registerCommand('intellig.tag.delete', (item: BranchTreeItem) =>
        this._handleTagDelete(item)
      )
    );

    this._disposables.push(
      vscode.commands.registerCommand('intellig.tag.push', (item: BranchTreeItem) =>
        this._handleTagPush(item)
      )
    );

    // Refresh command
    this._disposables.push(
      vscode.commands.registerCommand('intellig.branches.refresh', () =>
        this._branchTreeProvider.refresh()
      )
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
    if (!repo || !item.branch) {
      return;
    }

    try {
      await this._gitService.checkout(repo, item.branch.name);
      void vscode.window.showInformationMessage(`Switched to branch '${item.branch.name}'`);
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (
        errorMessage.includes('would be overwritten') ||
        errorMessage.includes('Please commit your changes or stash them')
      ) {
        const choice = await vscode.window.showWarningMessage(
          `Cannot switch to '${item.branch.name}': local changes would be overwritten.`,
          'Stash & Switch',
          'Force Checkout',
          'Cancel'
        );
        if (choice === 'Stash & Switch') {
          try {
            await this._gitService.stash(repo, `Auto-stash before checkout ${item.branch.name}`);
            await this._gitService.checkout(repo, item.branch.name);
            void vscode.window.showInformationMessage(
              `Stashed changes and switched to '${item.branch.name}'`
            );
            this._branchTreeProvider.refresh();
          } catch (stashError) {
            const stashMsg = stashError instanceof Error ? stashError.message : 'Unknown error';
            void vscode.window.showErrorMessage(`Failed to stash and checkout: ${stashMsg}`);
          }
        } else if (choice === 'Force Checkout') {
          try {
            await this._gitService.checkout(repo, item.branch.name, { force: true });
            void vscode.window.showInformationMessage(`Force switched to '${item.branch.name}'`);
            this._branchTreeProvider.refresh();
          } catch (forceError) {
            const forceMsg = forceError instanceof Error ? forceError.message : 'Unknown error';
            void vscode.window.showErrorMessage(`Failed to force checkout: ${forceMsg}`);
          }
        }
      } else {
        void vscode.window.showErrorMessage(`Failed to checkout branch: ${errorMessage}`);
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

    const startPoint = item.branch?.name || item.tag?.name;
    if (!startPoint) {
      return;
    }

    // T3-03: route through the New Branch Dialog when the opener is wired.
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
        if (!/^[\w\-./]+$/.test(value)) {
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
      void vscode.window.showInformationMessage(
        `Created and switched to branch '${branchName}' from '${startPoint}'`
      );
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to create branch: ${errorMessage}`);
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

    // T3-02: route through the Merge Dialog when the opener is wired; the
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
        // T1-08(a): auto-open Resolve Conflicts dialog when wired; fall back
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
      }
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to merge branch: ${errorMessage}`);
    }
  }

  /**
   * Handle rebase current onto command.
   */
  private async _handleRebaseCurrentOnto(item: BranchTreeItem): Promise<void> {
    const repo = this._getRepository();
    if (!repo || !item.branch) {
      return;
    }

    try {
      const result = await this._gitService.rebaseBranch(repo, item.branch.name);

      if (result.success) {
        void vscode.window.showInformationMessage(
          `Rebased onto '${item.branch.name}' successfully`
        );
      } else if (result.conflicts && result.conflicts.length > 0) {
        // T1-08(a): auto-open Resolve Conflicts dialog when wired; fall back
        // to a warning toast otherwise.
        if (this._conflictResolutionService) {
          await this._openResolveConflictsDialog(repo, result.conflicts, {
            operation: 'rebase',
            target: item.branch.name,
          });
        } else {
          void vscode.window.showWarningMessage(
            `Rebase conflicts in ${result.conflicts.length} file(s). Please resolve conflicts.`
          );
        }
      }
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to rebase: ${errorMessage}`);
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
      void vscode.window.showErrorMessage(`Failed to compare branches: ${errorMessage}`);
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
        if (!/^[\w\-./]+$/.test(value)) {
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
      void vscode.window.showInformationMessage(`Renamed branch to '${newName}'`);
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to rename branch: ${errorMessage}`);
    }
  }

  /**
   * Handle delete command.
   */
  private async _handleDelete(item: BranchTreeItem): Promise<void> {
    const repo = this._getRepository();
    if (!repo || !item.branch) {
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Are you sure you want to delete the branch '${item.branch.name}'?`,
      { modal: true },
      'Delete'
    );

    if (confirm !== 'Delete') {
      return;
    }

    try {
      await this._gitService.deleteBranch(repo, item.branch.name);
      void vscode.window.showInformationMessage(`Deleted branch '${item.branch.name}'`);
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to delete branch: ${errorMessage}`);
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
      await this._gitService.fetch(repo, upstream.remote);
      void vscode.window.showInformationMessage(
        `Updated branch '${item.branch.name}' from '${upstream.remote}'`
      );
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to update branch: ${errorMessage}`);
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

    // Route through the T1-01 Push Dialog when available so the user gets
    // the per-row target edit, force-with-lease dropdown, and protected-
    // branch guard. Falls back to a direct push (original behaviour) when
    // the opener is absent — e.g. in unit tests that don't wire the dialog.
    if (this._pushDialogOpener) {
      this._pushDialogOpener({ repo, branch: item.branch.name });
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
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to push branch: ${errorMessage}`);
    }
  }

  /**
   * Handle show diff with working tree command.
   * Opens a per-file diff comparison between the right-clicked branch ref and the working tree.
   *
   * BUG-17 (T2-01): the original implementation passed a single `vscode.diff` call
   * using the repo root directory URI as the right-hand side. VS Code's built-in
   * `vscode.diff` command only diffs files, not directories, so it silently failed.
   *
   * New flow:
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
      void vscode.window.showErrorMessage(`Failed to list changed files: ${errorMessage}`);
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
        void vscode.window.showErrorMessage(`Failed to show diff for ${filePath}: ${errorMessage}`);
      }
    }
  }

  /**
   * Handle checkout and rebase command.
   * Checks out the right-clicked branch and rebases the previously current branch onto it.
   */
  private async _handleCheckoutAndRebase(item: BranchTreeItem): Promise<void> {
    const repo = this._getRepository();
    if (!repo || !item.branch) {
      return;
    }

    // Store the current branch name before checkout
    const previousCurrentBranch = repo.head?.name?.replace('refs/heads/', '') || 'HEAD';

    try {
      // Step 1: Checkout the right-clicked branch
      await this._gitService.checkout(repo, item.branch.name);

      // Step 2: Rebase onto the previously current branch
      const result = await this._gitService.rebaseBranch(repo, previousCurrentBranch);

      if (result.success) {
        void vscode.window.showInformationMessage(
          `Checked out '${item.branch.name}' and rebased onto '${previousCurrentBranch}'`
        );
      } else if (result.conflicts && result.conflicts.length > 0) {
        // T1-08(a): auto-open Resolve Conflicts dialog when wired; fall back
        // to a warning toast otherwise.
        if (this._conflictResolutionService) {
          await this._openResolveConflictsDialog(repo, result.conflicts, {
            operation: 'rebase',
            target: previousCurrentBranch,
          });
        } else {
          void vscode.window.showWarningMessage(
            `Rebase conflicts in ${result.conflicts.length} file(s). Please resolve conflicts.`
          );
        }
      }
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (
        errorMessage.includes('would be overwritten') ||
        errorMessage.includes('Please commit your changes or stash them')
      ) {
        const choice = await vscode.window.showWarningMessage(
          `Cannot switch to '${item.branch.name}': local changes would be overwritten.`,
          'Stash & Switch',
          'Force Checkout',
          'Cancel'
        );
        if (choice === 'Stash & Switch') {
          try {
            await this._gitService.stash(repo, `Auto-stash before checkout ${item.branch.name}`);
            await this._gitService.checkout(repo, item.branch.name);
            const result = await this._gitService.rebaseBranch(repo, previousCurrentBranch);
            if (result.success) {
              void vscode.window.showInformationMessage(
                `Stashed changes, checked out '${item.branch.name}' and rebased onto '${previousCurrentBranch}'`
              );
            } else if (result.conflicts && result.conflicts.length > 0) {
              // T1-08(a): auto-open Resolve Conflicts dialog when wired.
              if (this._conflictResolutionService) {
                await this._openResolveConflictsDialog(repo, result.conflicts, {
                  operation: 'rebase',
                  target: previousCurrentBranch,
                });
              } else {
                void vscode.window.showWarningMessage(
                  `Rebase conflicts in ${result.conflicts.length} file(s). Please resolve conflicts.`
                );
              }
            }
            this._branchTreeProvider.refresh();
          } catch (stashError) {
            const stashMsg = stashError instanceof Error ? stashError.message : 'Unknown error';
            void vscode.window.showErrorMessage(`Failed to stash and checkout: ${stashMsg}`);
          }
        } else if (choice === 'Force Checkout') {
          try {
            await this._gitService.checkout(repo, item.branch.name, { force: true });
            const result = await this._gitService.rebaseBranch(repo, previousCurrentBranch);
            if (result.success) {
              void vscode.window.showInformationMessage(
                `Force checked out '${item.branch.name}' and rebased onto '${previousCurrentBranch}'`
              );
            } else if (result.conflicts && result.conflicts.length > 0) {
              // T1-08(a): auto-open Resolve Conflicts dialog when wired.
              if (this._conflictResolutionService) {
                await this._openResolveConflictsDialog(repo, result.conflicts, {
                  operation: 'rebase',
                  target: previousCurrentBranch,
                });
              } else {
                void vscode.window.showWarningMessage(
                  `Rebase conflicts in ${result.conflicts.length} file(s). Please resolve conflicts.`
                );
              }
            }
            this._branchTreeProvider.refresh();
          } catch (forceError) {
            const forceMsg = forceError instanceof Error ? forceError.message : 'Unknown error';
            void vscode.window.showErrorMessage(`Failed to force checkout and rebase: ${forceMsg}`);
          }
        }
      } else {
        void vscode.window.showErrorMessage(`Failed to checkout and rebase: ${errorMessage}`);
      }
    }
  }

  /**
   * Handle pull using rebase command for remote branches.
   * Routes through the T1-02 Pull Dialog with the `rebase` preset and the
   * remote/branch pre-filled from the menu item. Falls back to a direct
   * pull if the dialog accessor isn't available.
   */
  private async _handlePullUsingRebase(item: BranchTreeItem): Promise<void> {
    await this._runPullFromBranchMenu(item, 'rebase');
  }

  /**
   * Handle pull using merge command for remote branches.
   * Routes through the T1-02 Pull Dialog with the `merge` preset.
   */
  private async _handlePullUsingMerge(item: BranchTreeItem): Promise<void> {
    await this._runPullFromBranchMenu(item, 'merge');
  }

  /**
   * Shared implementation for the pullUsing* handlers — delegates to the
   * Pull Dialog with source pre-filled, or falls back to a direct pull
   * when the dialog is unavailable.
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

    const dialog = this._pullDialogAccessor?.();
    if (dialog) {
      await dialog.show(repo, preset, { remote: remoteName, branch: branchName });
      this._branchTreeProvider.refresh();
      return;
    }

    // Fallback path (tests and any legacy caller that didn't wire up the
    // Pull Dialog): preserve the original direct-pull behaviour.
    try {
      await this._gitService.pull(repo, {
        remote: remoteName,
        branch: branchName,
        rebase: preset === 'rebase',
      });
      const strategy = preset === 'rebase' ? 'rebase' : 'merge';
      void vscode.window.showInformationMessage(
        `Pulled '${item.branch.name}' into current branch using ${strategy}`
      );
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      // T1-08(a) handoff: when the conflict service is wired in (always true
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
            this._branchTreeProvider.refresh();
            return;
          }
        } catch (probeError) {
          // Do NOT surface a toast for the probe failure itself — the
          // outer generic error below is the one the user cares about
          // (it names the pull strategy + the original fatal). Keep the
          // probe error in the console/log for debugging.
          console.error('[intellig] pull-fallback conflict probe failed:', probeError);
        }
      }
      const strategy = preset === 'rebase' ? 'rebase' : 'merge';
      void vscode.window.showErrorMessage(`Failed to pull using ${strategy}: ${errorMessage}`);
    }
  }

  // ============================================
  // Remote Branch Command Handlers
  // ============================================

  /**
   * Handle checkout as local branch command.
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

    try {
      // Check if local branch already exists
      const branches = await this._gitService.getBranches(repo);
      const localExists = branches.some((b) => b.type === 'local' && b.name === branchName);

      if (localExists) {
        // Just checkout the existing local branch
        await this._gitService.checkout(repo, branchName);
      } else {
        // Create and checkout tracking branch
        await this._gitService.checkout(repo, branchName, {
          createBranch: true,
          track: `${remoteName}/${branchName}`,
        });
      }

      void vscode.window.showInformationMessage(`Switched to branch '${branchName}'`);
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (
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
            const branches = await this._gitService.getBranches(repo);
            const localExists = branches.some((b) => b.type === 'local' && b.name === branchName);
            if (localExists) {
              await this._gitService.checkout(repo, branchName);
            } else {
              await this._gitService.checkout(repo, branchName, {
                createBranch: true,
                track: `${remoteName}/${branchName}`,
              });
            }
            void vscode.window.showInformationMessage(
              `Stashed changes and switched to '${branchName}'`
            );
            this._branchTreeProvider.refresh();
          } catch (stashError) {
            const stashMsg = stashError instanceof Error ? stashError.message : 'Unknown error';
            void vscode.window.showErrorMessage(`Failed to stash and checkout: ${stashMsg}`);
          }
        } else if (choice === 'Force Checkout') {
          try {
            const branches = await this._gitService.getBranches(repo);
            const localExists = branches.some((b) => b.type === 'local' && b.name === branchName);
            if (localExists) {
              await this._gitService.checkout(repo, branchName, { force: true });
            } else {
              await this._gitService.checkout(repo, branchName, {
                createBranch: true,
                force: true,
                track: `${remoteName}/${branchName}`,
              });
            }
            void vscode.window.showInformationMessage(`Force switched to '${branchName}'`);
            this._branchTreeProvider.refresh();
          } catch (forceError) {
            const forceMsg = forceError instanceof Error ? forceError.message : 'Unknown error';
            void vscode.window.showErrorMessage(`Failed to force checkout: ${forceMsg}`);
          }
        }
      } else {
        void vscode.window.showErrorMessage(`Failed to checkout branch: ${errorMessage}`);
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
      // Get commits from the remote branch
      const commits = await this._gitService.getLog(repo, {
        maxCount: 50,
        path: undefined,
      });

      // Filter commits that are on the remote branch
      // For simplicity, show recent commits and let user select
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
        // T1-08(a): auto-open Resolve Conflicts dialog when wired.
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
      }
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to cherry-pick: ${errorMessage}`);
    }
  }

  /**
   * Handle pull into current command.
   *
   * Delegates to `_runPullFromBranchMenu` with the default ("merge")
   * preset so the user gets the same Pull Dialog + conflict-handoff
   * pipeline as the pullUsingMerge/Rebase entries. Matches the caller-
   * invoked pattern introduced by T1-02 and extended by T1-08(a).
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

      void vscode.window.showInformationMessage(`Deleted remote branch '${item.branch.name}'`);
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to delete remote branch: ${errorMessage}`);
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
      void vscode.window.showInformationMessage(
        `Checked out tag '${item.tag.name}' (detached HEAD)`
      );
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to checkout tag: ${errorMessage}`);
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
      }
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to cherry-pick: ${errorMessage}`);
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
      void vscode.window.showInformationMessage(`Deleted tag '${item.tag.name}'`);
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to delete tag: ${errorMessage}`);
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
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to push tag: ${errorMessage}`);
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
  newBranchDialogOpener?: NewBranchDialogOpener
): BranchContextMenuCommands {
  return new BranchContextMenuCommands(
    gitService,
    branchTreeProvider,
    conflictResolutionService,
    pullDialogAccessor,
    pushDialogOpener,
    mergeDialogOpener,
    newBranchDialogOpener
  );
}
