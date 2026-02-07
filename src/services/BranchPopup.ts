/**
 * Branch Popup implementation.
 * Provides a quick pick style branch selector with IntelliJ-style branch management.
 * Uses VS Code's QuickPick API for a native-feeling experience.
 *
 * Requirements: 4.1, 4.2, 17.4
 */

import * as vscode from 'vscode';
import { IGitService, IRepository, IBranch } from './interfaces/IGitService';

/**
 * Branch action types available in the popup
 */
export type BranchAction =
  | 'checkout'
  | 'new-branch'
  | 'new-branch-from'
  | 'merge'
  | 'rebase'
  | 'compare'
  | 'rename'
  | 'delete'
  | 'cherry-pick'
  | 'pull';

/**
 * Quick pick item for branches
 */
interface IBranchQuickPickItem extends vscode.QuickPickItem {
  branch?: IBranch;
  action?: BranchAction;
  isAction?: boolean;
  isSeparator?: boolean;
}

/**
 * Result from branch popup selection
 */
export interface IBranchPopupResult {
  /** The selected branch, if any */
  branch?: IBranch;
  /** The action to perform */
  action?: BranchAction;
  /** Whether the popup was cancelled */
  cancelled: boolean;
}

/**
 * Branch Popup class.
 * Provides a quick pick style branch selector with filtering and actions.
 *
 * Requirements:
 * - 4.1: Display current branch name in status bar (status bar item)
 * - 4.2: Display branch management menu with all local and remote branches
 * - 17.4: Use popup menu style similar to IntelliJ's branch popup
 */
export class BranchPopup {
  private _gitService: IGitService;
  private _statusBarItem: vscode.StatusBarItem;
  private _disposables: vscode.Disposable[] = [];
  private _currentRepository: IRepository | undefined;

  constructor(gitService: IGitService) {
    this._gitService = gitService;

    // Create status bar item for current branch display
    // Requirement 4.1: Display current branch name in status bar
    this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this._statusBarItem.command = 'intellij-git.showBranchPopup';
    this._statusBarItem.tooltip = 'Click to manage branches';
    this._disposables.push(this._statusBarItem);

    // Listen for repository changes to update status bar
    this._disposables.push(
      this._gitService.onDidChangeRepository((repo) => {
        this._currentRepository = repo;
        this._updateStatusBar(repo);
      })
    );

    // Initial status bar update
    void this._initializeStatusBar();
  }

  /**
   * Initialize the status bar with current repository info.
   */
  private async _initializeStatusBar(): Promise<void> {
    const repositories = this._gitService.getRepositories();
    if (repositories.length > 0) {
      this._currentRepository = repositories[0];
      this._updateStatusBar(repositories[0]);
    } else {
      // Try to discover repository from workspace
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders && workspaceFolders.length > 0) {
        const repo = await this._gitService.getRepository(workspaceFolders[0].uri);
        if (repo) {
          this._currentRepository = repo;
          this._updateStatusBar(repo);
        }
      }
    }
  }

  /**
   * Update the status bar with current branch information.
   * Requirement 4.1: Display current branch name in status bar
   */
  private _updateStatusBar(repo: IRepository): void {
    if (repo.head?.name) {
      const branchName = repo.head.name.replace('refs/heads/', '');
      let statusText = `$(git-branch) ${branchName}`;

      // Add ahead/behind indicators if available
      if (repo.head.ahead > 0 || repo.head.behind > 0) {
        const indicators: string[] = [];
        if (repo.head.ahead > 0) {
          indicators.push(`↑${repo.head.ahead}`);
        }
        if (repo.head.behind > 0) {
          indicators.push(`↓${repo.head.behind}`);
        }
        statusText += ` ${indicators.join(' ')}`;
      }

      this._statusBarItem.text = statusText;
      this._statusBarItem.show();
    } else if (repo.head?.commit) {
      // Detached HEAD state
      const shortHash = repo.head.commit.substring(0, 7);
      this._statusBarItem.text = `$(git-commit) ${shortHash}`;
      this._statusBarItem.tooltip = 'Detached HEAD - Click to manage branches';
      this._statusBarItem.show();
    } else {
      // No commits yet
      this._statusBarItem.text = '$(git-branch) No commits yet';
      this._statusBarItem.show();
    }
  }

  /**
   * Show the branch popup.
   * Requirement 4.2: Display branch management menu with all local and remote branches
   * Requirement 17.4: Use popup menu style similar to IntelliJ's branch popup
   *
   * @param repository - Optional repository to use (defaults to current)
   * @returns Promise resolving to the popup result
   */
  async show(repository?: IRepository): Promise<IBranchPopupResult> {
    const repo = repository || this._currentRepository;

    if (!repo) {
      // Try to get repository from workspace
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders && workspaceFolders.length > 0) {
        const discoveredRepo = await this._gitService.getRepository(workspaceFolders[0].uri);
        if (!discoveredRepo) {
          void vscode.window.showErrorMessage('No Git repository found');
          return { cancelled: true };
        }
        this._currentRepository = discoveredRepo;
        return this._showBranchPicker(discoveredRepo);
      }
      void vscode.window.showErrorMessage('No Git repository found');
      return { cancelled: true };
    }

    return this._showBranchPicker(repo);
  }

  /**
   * Show the branch picker quick pick.
   */
  private async _showBranchPicker(repo: IRepository): Promise<IBranchPopupResult> {
    // Get all branches
    const branches = await this._gitService.getBranches(repo);

    // Separate local and remote branches
    const localBranches = branches.filter((b) => b.type === 'local');
    const remoteBranches = branches.filter((b) => b.type === 'remote');

    // Get current branch name
    const currentBranchName = repo.head?.name?.replace('refs/heads/', '');

    // Create quick pick
    const quickPick = vscode.window.createQuickPick<IBranchQuickPickItem>();
    quickPick.title = 'Git Branches';
    quickPick.placeholder = 'Search branches or select an action...';
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;

    // Build items list
    const items = this._buildQuickPickItems(localBranches, remoteBranches, currentBranchName);
    quickPick.items = items;

    // Handle selection
    return new Promise<IBranchPopupResult>((resolve) => {
      quickPick.onDidAccept(async () => {
        const selected = quickPick.selectedItems[0];
        quickPick.hide();

        if (!selected) {
          resolve({ cancelled: true });
          return;
        }

        if (selected.isAction) {
          // Handle action items
          const result = await this._handleAction(repo, selected.action!, selected.branch);
          resolve(result);
        } else if (selected.branch) {
          // Show action menu for selected branch
          const result = await this._showBranchActionMenu(repo, selected.branch, currentBranchName);
          resolve(result);
        } else {
          resolve({ cancelled: true });
        }
      });

      quickPick.onDidHide(() => {
        quickPick.dispose();
        // Only resolve if not already resolved
      });

      quickPick.show();
    });
  }

  /**
   * Build quick pick items from branches.
   * Requirement 4.2: Display all local and remote branches
   */
  private _buildQuickPickItems(
    localBranches: IBranch[],
    remoteBranches: IBranch[],
    currentBranchName?: string
  ): IBranchQuickPickItem[] {
    const items: IBranchQuickPickItem[] = [];

    // Add action items at the top
    items.push({
      label: '$(add) New Branch...',
      description: 'Create a new branch from current HEAD',
      action: 'new-branch',
      isAction: true,
    });

    items.push({
      label: '$(add) New Branch From...',
      description: 'Create a new branch from a specific ref',
      action: 'new-branch-from',
      isAction: true,
    });

    // Separator
    items.push({
      label: '',
      kind: vscode.QuickPickItemKind.Separator,
      isSeparator: true,
    });

    // Local branches section
    if (localBranches.length > 0) {
      items.push({
        label: 'Local Branches',
        kind: vscode.QuickPickItemKind.Separator,
        isSeparator: true,
      });

      for (const branch of localBranches) {
        const isCurrentBranch = branch.name === currentBranchName || branch.isHead;
        const icon = isCurrentBranch ? '$(check)' : '$(git-branch)';
        const description = this._getBranchDescription(branch, isCurrentBranch);

        items.push({
          label: `${icon} ${branch.name}`,
          description,
          detail: branch.upstream
            ? `→ ${branch.upstream.remote}/${branch.upstream.name}`
            : undefined,
          branch,
        });
      }
    }

    // Remote branches section
    if (remoteBranches.length > 0) {
      items.push({
        label: 'Remote Branches',
        kind: vscode.QuickPickItemKind.Separator,
        isSeparator: true,
      });

      for (const branch of remoteBranches) {
        // Parse remote name from branch name (e.g., "origin/main" -> "origin", "main")
        const parts = branch.name.split('/');
        const remoteName = parts[0];
        const branchName = parts.slice(1).join('/');

        items.push({
          label: `$(cloud) ${branchName}`,
          description: `on ${remoteName}`,
          detail: `${branch.commit.substring(0, 7)}`,
          branch,
        });
      }
    }

    return items;
  }

  /**
   * Get description text for a branch.
   */
  private _getBranchDescription(branch: IBranch, isCurrentBranch: boolean): string {
    const parts: string[] = [];

    if (isCurrentBranch) {
      parts.push('current');
    }

    if (branch.ahead !== undefined && branch.ahead > 0) {
      parts.push(`↑${branch.ahead}`);
    }

    if (branch.behind !== undefined && branch.behind > 0) {
      parts.push(`↓${branch.behind}`);
    }

    if (parts.length === 0) {
      parts.push(branch.commit.substring(0, 7));
    }

    return parts.join(' ');
  }

  /**
   * Show action menu for a selected branch.
   * Requirement 5.1, 5.2: Context menu options for branches
   */
  private async _showBranchActionMenu(
    repo: IRepository,
    branch: IBranch,
    currentBranchName?: string
  ): Promise<IBranchPopupResult> {
    const isCurrentBranch = branch.name === currentBranchName || branch.isHead;
    const isRemoteBranch = branch.type === 'remote';

    // Build action items based on branch type
    const actionItems: IBranchQuickPickItem[] = [];

    if (isRemoteBranch) {
      // Remote branch actions (Requirement 5.2)
      actionItems.push({
        label: '$(arrow-down) Checkout as Local Branch',
        description: 'Create a local tracking branch and switch to it',
        action: 'checkout',
        branch,
        isAction: true,
      });

      actionItems.push({
        label: '$(add) New Branch from Here',
        description: 'Create a new branch starting from this commit',
        action: 'new-branch-from',
        branch,
        isAction: true,
      });

      actionItems.push({
        label: '$(git-merge) Merge into Current',
        description: `Merge ${branch.name} into ${currentBranchName || 'current branch'}`,
        action: 'merge',
        branch,
        isAction: true,
      });

      actionItems.push({
        label: '$(git-pull-request) Rebase Current onto This',
        description: `Rebase ${currentBranchName || 'current branch'} onto ${branch.name}`,
        action: 'rebase',
        branch,
        isAction: true,
      });

      actionItems.push({
        label: '$(diff) Compare with Current',
        description: `Compare ${branch.name} with ${currentBranchName || 'current branch'}`,
        action: 'compare',
        branch,
        isAction: true,
      });

      actionItems.push({
        label: '$(arrow-down) Pull into Current',
        description: `Fetch and merge ${branch.name} into current branch`,
        action: 'pull',
        branch,
        isAction: true,
      });

      actionItems.push({
        label: '$(trash) Delete Remote Branch',
        description: 'Delete this branch from the remote',
        action: 'delete',
        branch,
        isAction: true,
      });
    } else {
      // Local branch actions (Requirement 5.1)
      if (!isCurrentBranch) {
        actionItems.push({
          label: '$(arrow-right) Checkout',
          description: `Switch to ${branch.name}`,
          action: 'checkout',
          branch,
          isAction: true,
        });
      } else {
        actionItems.push({
          label: '$(check) Current Branch',
          description: 'You are already on this branch',
          branch,
        });
      }

      actionItems.push({
        label: '$(add) New Branch from Here',
        description: 'Create a new branch starting from this commit',
        action: 'new-branch-from',
        branch,
        isAction: true,
      });

      if (!isCurrentBranch) {
        actionItems.push({
          label: '$(git-merge) Merge into Current',
          description: `Merge ${branch.name} into ${currentBranchName || 'current branch'}`,
          action: 'merge',
          branch,
          isAction: true,
        });

        actionItems.push({
          label: '$(git-pull-request) Rebase Current onto This',
          description: `Rebase ${currentBranchName || 'current branch'} onto ${branch.name}`,
          action: 'rebase',
          branch,
          isAction: true,
        });
      }

      actionItems.push({
        label: '$(diff) Compare with Current',
        description: `Compare ${branch.name} with ${currentBranchName || 'current branch'}`,
        action: 'compare',
        branch,
        isAction: true,
      });

      actionItems.push({
        label: '$(edit) Rename',
        description: `Rename ${branch.name}`,
        action: 'rename',
        branch,
        isAction: true,
      });

      if (!isCurrentBranch) {
        actionItems.push({
          label: '$(trash) Delete',
          description: `Delete ${branch.name}`,
          action: 'delete',
          branch,
          isAction: true,
        });
      }
    }

    // Show action picker
    const selected = await vscode.window.showQuickPick(actionItems, {
      title: `Branch: ${branch.name}`,
      placeHolder: 'Select an action',
    });

    if (!selected || !selected.action) {
      return { cancelled: true };
    }

    return this._handleAction(repo, selected.action, branch);
  }

  /**
   * Handle a branch action.
   */
  private async _handleAction(
    repo: IRepository,
    action: BranchAction,
    branch?: IBranch
  ): Promise<IBranchPopupResult> {
    try {
      switch (action) {
        case 'checkout':
          return await this._handleCheckout(repo, branch);

        case 'new-branch':
          return await this._handleNewBranch(repo);

        case 'new-branch-from':
          return await this._handleNewBranchFrom(repo, branch);

        case 'merge':
          return await this._handleMerge(repo, branch);

        case 'rebase':
          return await this._handleRebase(repo, branch);

        case 'compare':
          return await this._handleCompare(repo, branch);

        case 'rename':
          return await this._handleRename(repo, branch);

        case 'delete':
          return await this._handleDelete(repo, branch);

        case 'pull':
          return await this._handlePull(repo, branch);

        default:
          return { cancelled: true };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Branch operation failed: ${errorMessage}`);
      return { cancelled: true };
    }
  }

  /**
   * Handle checkout action.
   * Requirement 4.5: Switch to selected branch
   */
  private async _handleCheckout(repo: IRepository, branch?: IBranch): Promise<IBranchPopupResult> {
    if (!branch) {
      return { cancelled: true };
    }

    const isRemoteBranch = branch.type === 'remote';

    if (isRemoteBranch) {
      // Checkout remote branch as local tracking branch
      // Requirement 5.3: Create local tracking branch and switch to it
      const parts = branch.name.split('/');
      const remoteName = parts[0];
      const branchName = parts.slice(1).join('/');

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
    } else {
      // Checkout local branch
      await this._gitService.checkout(repo, branch.name);
      void vscode.window.showInformationMessage(`Switched to branch '${branch.name}'`);
    }

    return { branch, action: 'checkout', cancelled: false };
  }

  /**
   * Handle new branch action.
   * Requirement 4.3: Create branch from current HEAD
   */
  private async _handleNewBranch(repo: IRepository): Promise<IBranchPopupResult> {
    const branchName = await vscode.window.showInputBox({
      prompt: 'Enter new branch name',
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
      return { cancelled: true };
    }

    await this._gitService.createBranch(repo, branchName);
    await this._gitService.checkout(repo, branchName);

    void vscode.window.showInformationMessage(`Created and switched to branch '${branchName}'`);

    return { action: 'new-branch', cancelled: false };
  }

  /**
   * Handle new branch from specific ref.
   * Requirement 4.4: Create branch from selected source
   */
  private async _handleNewBranchFrom(
    repo: IRepository,
    branch?: IBranch
  ): Promise<IBranchPopupResult> {
    let startPoint: string;

    if (branch) {
      startPoint = branch.name;
    } else {
      // Show branch picker to select start point
      const branches = await this._gitService.getBranches(repo);
      const items = branches.map((b) => ({
        label: b.name,
        description: b.type === 'remote' ? 'remote' : 'local',
        branch: b,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        title: 'Select Start Point',
        placeHolder: 'Select a branch to create from',
      });

      if (!selected) {
        return { cancelled: true };
      }

      startPoint = selected.branch.name;
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
      return { cancelled: true };
    }

    await this._gitService.createBranch(repo, branchName, startPoint);
    await this._gitService.checkout(repo, branchName);

    void vscode.window.showInformationMessage(
      `Created and switched to branch '${branchName}' from '${startPoint}'`
    );

    return { action: 'new-branch-from', cancelled: false };
  }

  /**
   * Handle merge action.
   * Requirement 4.7: Merge selected branch into current
   */
  private async _handleMerge(repo: IRepository, branch?: IBranch): Promise<IBranchPopupResult> {
    if (!branch) {
      return { cancelled: true };
    }

    const result = await this._gitService.mergeBranch(repo, branch.name);

    if (result.success) {
      void vscode.window.showInformationMessage(`Merged '${branch.name}' successfully`);
    } else if (result.conflicts && result.conflicts.length > 0) {
      void vscode.window.showWarningMessage(
        `Merge conflicts in ${result.conflicts.length} file(s). Please resolve conflicts.`
      );
    }

    return { branch, action: 'merge', cancelled: false };
  }

  /**
   * Handle rebase action.
   * Requirement 4.8: Rebase current branch onto selected
   */
  private async _handleRebase(repo: IRepository, branch?: IBranch): Promise<IBranchPopupResult> {
    if (!branch) {
      return { cancelled: true };
    }

    const result = await this._gitService.rebaseBranch(repo, branch.name);

    if (result.success) {
      void vscode.window.showInformationMessage(`Rebased onto '${branch.name}' successfully`);
    } else if (result.conflicts && result.conflicts.length > 0) {
      void vscode.window.showWarningMessage(
        `Rebase conflicts in ${result.conflicts.length} file(s). Please resolve conflicts.`
      );
    }

    return { branch, action: 'rebase', cancelled: false };
  }

  /**
   * Handle compare action.
   * Requirement 4.11: Compare with current branch
   */
  private async _handleCompare(repo: IRepository, branch?: IBranch): Promise<IBranchPopupResult> {
    if (!branch) {
      return { cancelled: true };
    }

    const currentBranch = repo.head?.name?.replace('refs/heads/', '') || 'HEAD';
    const comparison = await this._gitService.compareBranches(repo, currentBranch, branch.name);

    // Show comparison summary
    const message =
      `Comparing ${currentBranch} with ${branch.name}:\n` +
      `• ${comparison.aheadCount} commit(s) ahead\n` +
      `• ${comparison.behindCount} commit(s) behind\n` +
      `• ${comparison.changedFiles.length} file(s) changed`;

    void vscode.window.showInformationMessage(message);

    // TODO: Open comparison view (task 28.1)

    return { branch, action: 'compare', cancelled: false };
  }

  /**
   * Handle rename action.
   * Requirement 4.10: Rename branch
   */
  private async _handleRename(repo: IRepository, branch?: IBranch): Promise<IBranchPopupResult> {
    if (!branch) {
      return { cancelled: true };
    }

    const newName = await vscode.window.showInputBox({
      prompt: `Rename branch '${branch.name}' to:`,
      value: branch.name,
      validateInput: (value) => {
        if (!value || !value.trim()) {
          return 'Branch name cannot be empty';
        }
        if (value === branch.name) {
          return 'New name must be different';
        }
        if (!/^[\w\-./]+$/.test(value)) {
          return 'Branch name contains invalid characters';
        }
        return undefined;
      },
    });

    if (!newName) {
      return { cancelled: true };
    }

    await this._gitService.renameBranch(repo, branch.name, newName);
    void vscode.window.showInformationMessage(`Renamed branch to '${newName}'`);

    return { branch, action: 'rename', cancelled: false };
  }

  /**
   * Handle delete action.
   * Requirement 4.9: Delete branch with confirmation
   */
  private async _handleDelete(repo: IRepository, branch?: IBranch): Promise<IBranchPopupResult> {
    if (!branch) {
      return { cancelled: true };
    }

    const isRemoteBranch = branch.type === 'remote';
    const warningMessage = isRemoteBranch
      ? `Are you sure you want to delete the remote branch '${branch.name}'? This cannot be undone.`
      : `Are you sure you want to delete the branch '${branch.name}'?`;

    const confirm = await vscode.window.showWarningMessage(
      warningMessage,
      { modal: true },
      'Delete'
    );

    if (confirm !== 'Delete') {
      return { cancelled: true };
    }

    if (isRemoteBranch) {
      // Delete remote branch
      // Requirement 5.6: Delete remote branch
      const parts = branch.name.split('/');
      const remoteName = parts[0];
      const branchName = parts.slice(1).join('/');

      // Use git push to delete remote branch
      await this._gitService.push(repo, {
        remote: remoteName,
        branch: `:${branchName}`,
      });

      void vscode.window.showInformationMessage(`Deleted remote branch '${branch.name}'`);
    } else {
      // Delete local branch
      await this._gitService.deleteBranch(repo, branch.name);
      void vscode.window.showInformationMessage(`Deleted branch '${branch.name}'`);
    }

    return { branch, action: 'delete', cancelled: false };
  }

  /**
   * Handle pull action for remote branch.
   * Requirement 5.5: Pull remote branch into current
   */
  private async _handlePull(repo: IRepository, branch?: IBranch): Promise<IBranchPopupResult> {
    if (!branch || branch.type !== 'remote') {
      return { cancelled: true };
    }

    const parts = branch.name.split('/');
    const remoteName = parts[0];
    const branchName = parts.slice(1).join('/');

    await this._gitService.pull(repo, {
      remote: remoteName,
      branch: branchName,
    });

    void vscode.window.showInformationMessage(`Pulled '${branch.name}' into current branch`);

    return { branch, action: 'pull', cancelled: false };
  }

  /**
   * Hide the branch popup (if shown).
   */
  hide(): void {
    // QuickPick handles its own hiding
  }

  /**
   * Dispose of resources.
   */
  dispose(): void {
    this._statusBarItem.dispose();
    for (const disposable of this._disposables) {
      disposable.dispose();
    }
    this._disposables = [];
  }
}

/**
 * Create a new BranchPopup instance.
 *
 * @param gitService - The Git service to use
 * @returns A new BranchPopup instance
 */
export function createBranchPopup(gitService: IGitService): BranchPopup {
  return new BranchPopup(gitService);
}
