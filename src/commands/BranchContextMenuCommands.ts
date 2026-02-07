/**
 * Branch Context Menu Commands implementation.
 * Provides command handlers for branch, remote branch, and tag context menus.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 17.6
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
      vscode.commands.registerCommand('intellij-git.branch.checkout', (item: BranchTreeItem) =>
        this._handleCheckout(item)
      )
    );

    this._disposables.push(
      vscode.commands.registerCommand('intellij-git.branch.newBranchFrom', (item: BranchTreeItem) =>
        this._handleNewBranchFrom(item)
      )
    );

    this._disposables.push(
      vscode.commands.registerCommand(
        'intellij-git.branch.mergeIntoCurrent',
        (item: BranchTreeItem) => this._handleMergeIntoCurrent(item)
      )
    );

    this._disposables.push(
      vscode.commands.registerCommand(
        'intellij-git.branch.rebaseCurrentOnto',
        (item: BranchTreeItem) => this._handleRebaseCurrentOnto(item)
      )
    );

    this._disposables.push(
      vscode.commands.registerCommand(
        'intellij-git.branch.compareWithCurrent',
        (item: BranchTreeItem) => this._handleCompareWithCurrent(item)
      )
    );

    this._disposables.push(
      vscode.commands.registerCommand('intellij-git.branch.rename', (item: BranchTreeItem) =>
        this._handleRename(item)
      )
    );

    this._disposables.push(
      vscode.commands.registerCommand('intellij-git.branch.delete', (item: BranchTreeItem) =>
        this._handleDelete(item)
      )
    );

    // Remote branch commands
    this._disposables.push(
      vscode.commands.registerCommand(
        'intellij-git.remoteBranch.checkoutAsLocal',
        (item: BranchTreeItem) => this._handleCheckoutAsLocal(item)
      )
    );

    this._disposables.push(
      vscode.commands.registerCommand(
        'intellij-git.remoteBranch.cherryPickCommits',
        (item: BranchTreeItem) => this._handleCherryPickCommits(item)
      )
    );

    this._disposables.push(
      vscode.commands.registerCommand(
        'intellij-git.remoteBranch.pullIntoCurrent',
        (item: BranchTreeItem) => this._handlePullIntoCurrent(item)
      )
    );

    this._disposables.push(
      vscode.commands.registerCommand(
        'intellij-git.remoteBranch.deleteRemote',
        (item: BranchTreeItem) => this._handleDeleteRemote(item)
      )
    );

    // Tag commands
    this._disposables.push(
      vscode.commands.registerCommand('intellij-git.tag.checkoutDetached', (item: BranchTreeItem) =>
        this._handleTagCheckoutDetached(item)
      )
    );

    this._disposables.push(
      vscode.commands.registerCommand('intellij-git.tag.newBranchFrom', (item: BranchTreeItem) =>
        this._handleTagNewBranchFrom(item)
      )
    );

    this._disposables.push(
      vscode.commands.registerCommand('intellij-git.tag.cherryPick', (item: BranchTreeItem) =>
        this._handleTagCherryPick(item)
      )
    );

    this._disposables.push(
      vscode.commands.registerCommand('intellij-git.tag.delete', (item: BranchTreeItem) =>
        this._handleTagDelete(item)
      )
    );

    this._disposables.push(
      vscode.commands.registerCommand('intellij-git.tag.push', (item: BranchTreeItem) =>
        this._handleTagPush(item)
      )
    );

    // Refresh command
    this._disposables.push(
      vscode.commands.registerCommand('intellij-git.branches.refresh', () =>
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
   * Requirement 5.1: Checkout option in context menu
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
   * Requirement 5.1: New Branch from Here option
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
   * Requirement 5.1: Merge into Current option
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
   * Requirement 5.1: Rebase Current onto This option
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
   * Requirement 5.1: Compare with Current option
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
   * Requirement 5.1: Rename option
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
   * Requirement 5.1: Delete option
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
  // Remote Branch Command Handlers
  // ============================================

  /**
   * Handle checkout as local branch command.
   * Requirement 5.3: Create local tracking branch and switch to it
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
   * Requirement 5.4: Display commit selection dialog for cherry-picking
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
   * Requirement 5.5: Fetch and merge remote branch into current
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
   * Requirement 5.6: Delete branch from remote with confirmation and warning
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
   * Requirement 5.8: Checkout tag in detached HEAD state
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
   * Requirement 5.8: New Branch from Here option for tags
   */
  private async _handleTagNewBranchFrom(item: BranchTreeItem): Promise<void> {
    // Reuse the same logic as branch new branch from
    await this._handleNewBranchFrom(item);
  }

  /**
   * Handle tag cherry-pick command.
   * Requirement 5.8: Cherry-pick option for tags
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
   * Requirement 5.8: Delete Tag option
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
   * Requirement 5.8: Push Tag option
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
