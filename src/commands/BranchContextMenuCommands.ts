/**
 * Branch Context Menu Commands implementation.
 * Provides command handlers for branch, remote branch, and tag context menus.
 */

import * as vscode from 'vscode';
import { IGitService, IRepository } from '../services/interfaces/IGitService';
import { BranchTreeItem, BranchTreeProvider } from '../services/BranchTreeProvider';

/**
 * Branch Context Menu Commands class.
 * Registers and handles all branch-related context menu commands.
 */
export class BranchContextMenuCommands {
  private _gitService: IGitService;
  private _branchTreeProvider: BranchTreeProvider;
  private _disposables: vscode.Disposable[] = [];

  constructor(gitService: IGitService, branchTreeProvider: BranchTreeProvider) {
    this._gitService = gitService;
    this._branchTreeProvider = branchTreeProvider;
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
      vscode.commands.registerCommand(
        'intellig.branch.mergeIntoCurrent',
        (item: BranchTreeItem) => this._handleMergeIntoCurrent(item)
      )
    );

    this._disposables.push(
      vscode.commands.registerCommand(
        'intellig.branch.rebaseCurrentOnto',
        (item: BranchTreeItem) => this._handleRebaseCurrentOnto(item)
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
      vscode.commands.registerCommand(
        'intellig.branch.checkoutAndRebase',
        (item: BranchTreeItem) => this._handleCheckoutAndRebase(item)
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
      if (errorMessage.includes('would be overwritten') || errorMessage.includes('Please commit your changes or stash them')) {
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
            void vscode.window.showInformationMessage(`Stashed changes and switched to '${item.branch.name}'`);
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

    try {
      const result = await this._gitService.mergeBranch(repo, item.branch.name);

      if (result.success) {
        void vscode.window.showInformationMessage(`Merged '${item.branch.name}' successfully`);
      } else if (result.conflicts && result.conflicts.length > 0) {
        void vscode.window.showWarningMessage(
          `Merge conflicts in ${result.conflicts.length} file(s). Please resolve conflicts.`
        );
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
        void vscode.window.showWarningMessage(
          `Rebase conflicts in ${result.conflicts.length} file(s). Please resolve conflicts.`
        );
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
   * Opens a diff comparison between the right-clicked branch ref and the working tree.
   */
  private async _handleShowDiffWithWorkingTree(item: BranchTreeItem): Promise<void> {
    const repo = this._getRepository();
    if (!repo || !item.branch) {
      return;
    }

    try {
      const branchRef = item.branch.name;
      const leftUri = vscode.Uri.parse(`git-branch://${branchRef}`);
      const rightUri = repo.rootUri;

      await vscode.commands.executeCommand(
        'vscode.diff',
        leftUri,
        rightUri,
        `${branchRef} ↔ Working Tree`
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to show diff: ${errorMessage}`);
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
        void vscode.window.showWarningMessage(
          `Rebase conflicts in ${result.conflicts.length} file(s). Please resolve conflicts.`
        );
      }
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (errorMessage.includes('would be overwritten') || errorMessage.includes('Please commit your changes or stash them')) {
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
              void vscode.window.showWarningMessage(
                `Rebase conflicts in ${result.conflicts.length} file(s). Please resolve conflicts.`
              );
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
              void vscode.window.showWarningMessage(
                `Rebase conflicts in ${result.conflicts.length} file(s). Please resolve conflicts.`
              );
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
   * Pulls the remote branch into the current branch using rebase strategy.
   */
  private async _handlePullUsingRebase(item: BranchTreeItem): Promise<void> {
    const repo = this._getRepository();
    if (!repo || !item.branch) {
      return;
    }

    // Parse remote name and branch name from item.branch.name (e.g., "origin/main" -> "origin", "main")
    const slashIndex = item.branch.name.indexOf('/');
    const remoteName = slashIndex >= 0 ? item.branch.name.substring(0, slashIndex) : item.branch.name;
    const branchName = slashIndex >= 0 ? item.branch.name.substring(slashIndex + 1) : item.branch.name;

    try {
      await this._gitService.pull(repo, {
        remote: remoteName,
        branch: branchName,
        rebase: true,
      });
      void vscode.window.showInformationMessage(
        `Pulled '${item.branch.name}' into current branch using rebase`
      );
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const conflictCount = this._parseConflictCount(errorMessage);
      if (conflictCount > 0) {
        void vscode.window.showWarningMessage(
          `Rebase conflicts in ${conflictCount} file(s). Please resolve conflicts.`
        );
        this._branchTreeProvider.refresh();
      } else {
        void vscode.window.showErrorMessage(`Failed to pull using rebase: ${errorMessage}`);
      }
    }
  }

  /**
   * Handle pull using merge command for remote branches.
   * Pulls the remote branch into the current branch using merge strategy.
   */
  private async _handlePullUsingMerge(item: BranchTreeItem): Promise<void> {
    const repo = this._getRepository();
    if (!repo || !item.branch) {
      return;
    }

    // Parse remote name and branch name from item.branch.name (e.g., "origin/main" -> "origin", "main")
    const slashIndex = item.branch.name.indexOf('/');
    const remoteName = slashIndex >= 0 ? item.branch.name.substring(0, slashIndex) : item.branch.name;
    const branchName = slashIndex >= 0 ? item.branch.name.substring(slashIndex + 1) : item.branch.name;

    try {
      await this._gitService.pull(repo, {
        remote: remoteName,
        branch: branchName,
        rebase: false,
      });
      void vscode.window.showInformationMessage(
        `Pulled '${item.branch.name}' into current branch using merge`
      );
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const conflictCount = this._parseConflictCount(errorMessage);
      if (conflictCount > 0) {
        void vscode.window.showWarningMessage(
          `Merge conflicts in ${conflictCount} file(s). Please resolve conflicts.`
        );
        this._branchTreeProvider.refresh();
      } else {
        void vscode.window.showErrorMessage(`Failed to pull using merge: ${errorMessage}`);
      }
    }
  }

  // ============================================
  // Helper Methods
  // ============================================

  /**
   * Parse the number of conflicted files from a git error message.
   * Git error messages contain "CONFLICT" markers for each conflicted file.
   * Returns 0 if no conflict markers are found.
   */
  private _parseConflictCount(errorMessage: string): number {
    const matches = errorMessage.match(/CONFLICT/gi);
    return matches ? matches.length : 0;
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
      if (errorMessage.includes('would be overwritten') || errorMessage.includes('Please commit your changes or stash them')) {
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
            void vscode.window.showInformationMessage(`Stashed changes and switched to '${branchName}'`);
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
   * Handle pull into current command.
   */
  private async _handlePullIntoCurrent(item: BranchTreeItem): Promise<void> {
    const repo = this._getRepository();
    if (!repo || !item.branch) {
      return;
    }

    // Parse remote name from branch name
    const parts = item.branch.name.split('/');
    const remoteName = parts[0];
    const branchName = parts.slice(1).join('/');

    try {
      await this._gitService.pull(repo, {
        remote: remoteName,
        branch: branchName,
      });

      void vscode.window.showInformationMessage(`Pulled '${item.branch.name}' into current branch`);
      this._branchTreeProvider.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to pull: ${errorMessage}`);
    }
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
  branchTreeProvider: BranchTreeProvider
): BranchContextMenuCommands {
  return new BranchContextMenuCommands(gitService, branchTreeProvider);
}
