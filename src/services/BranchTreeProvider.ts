/**
 * Branch Tree Provider implementation.
 * Provides a tree view of branches with context menu support.
 */

import * as vscode from 'vscode';
import { IGitService, IRepository, IBranch, ITag } from './interfaces/IGitService';

/**
 * Tree item types for the branch tree
 */
export type BranchTreeItemType = 'local-branch' | 'remote-branch' | 'tag' | 'category';

/**
 * Context values for tree items (used in when clauses for menus)
 */
export const CONTEXT_VALUES = {
  LOCAL_BRANCH: 'intellig.localBranch',
  LOCAL_BRANCH_CURRENT: 'intellig.localBranchCurrent',
  REMOTE_BRANCH: 'intellig.remoteBranch',
  TAG: 'intellig.tag',
  CATEGORY: 'intellig.category',
} as const;

/**
 * Branch tree item representing a branch, tag, or category in the tree view
 */
export class BranchTreeItem extends vscode.TreeItem {
  public readonly itemType: BranchTreeItemType;
  public readonly branch?: IBranch;
  public readonly tag?: ITag;
  public readonly isCurrentBranch: boolean;

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    itemType: BranchTreeItemType,
    branch?: IBranch,
    tag?: ITag,
    isCurrentBranch: boolean = false
  ) {
    super(label, collapsibleState);

    this.itemType = itemType;
    this.branch = branch;
    this.tag = tag;
    this.isCurrentBranch = isCurrentBranch;

    // Set context value for menu contributions
    this.contextValue = this._getContextValue();

    // Set icon based on type
    this.iconPath = this._getIcon();

    // Set description for branches
    this.description = this._getDescription();

    // Set tooltip
    this.tooltip = this._getTooltip();
  }

  private _getContextValue(): string {
    switch (this.itemType) {
      case 'local-branch':
        return this.isCurrentBranch
          ? CONTEXT_VALUES.LOCAL_BRANCH_CURRENT
          : CONTEXT_VALUES.LOCAL_BRANCH;
      case 'remote-branch':
        return CONTEXT_VALUES.REMOTE_BRANCH;
      case 'tag':
        return CONTEXT_VALUES.TAG;
      case 'category':
        return CONTEXT_VALUES.CATEGORY;
      default:
        return '';
    }
  }

  private _getIcon(): vscode.ThemeIcon {
    switch (this.itemType) {
      case 'local-branch':
        return this.isCurrentBranch
          ? new vscode.ThemeIcon(
              'check',
              new vscode.ThemeColor('gitDecoration.addedResourceForeground')
            )
          : new vscode.ThemeIcon('git-branch');
      case 'remote-branch':
        return new vscode.ThemeIcon('cloud');
      case 'tag':
        return new vscode.ThemeIcon('tag');
      case 'category':
        return new vscode.ThemeIcon('folder');
      default:
        return new vscode.ThemeIcon('circle-outline');
    }
  }

  private _getDescription(): string | undefined {
    if (this.branch) {
      const parts: string[] = [];

      if (this.isCurrentBranch) {
        parts.push('current');
      }

      if (this.branch.ahead !== undefined && this.branch.ahead > 0) {
        parts.push(`↑${this.branch.ahead}`);
      }

      if (this.branch.behind !== undefined && this.branch.behind > 0) {
        parts.push(`↓${this.branch.behind}`);
      }

      if (parts.length === 0 && this.branch.commit) {
        parts.push(this.branch.commit.substring(0, 7));
      }

      return parts.join(' ');
    }

    if (this.tag) {
      return this.tag.commit.substring(0, 7);
    }

    return undefined;
  }

  private _getTooltip(): string {
    if (this.branch) {
      let tooltip = `Branch: ${this.branch.name}`;
      if (this.branch.commit) {
        tooltip += `\nCommit: ${this.branch.commit}`;
      }
      if (this.branch.upstream) {
        tooltip += `\nUpstream: ${this.branch.upstream.remote}/${this.branch.upstream.name}`;
      }
      if (this.isCurrentBranch) {
        tooltip += '\n(Current Branch)';
      }
      return tooltip;
    }

    if (this.tag) {
      let tooltip = `Tag: ${this.tag.name}`;
      tooltip += `\nCommit: ${this.tag.commit}`;
      if (this.tag.message) {
        tooltip += `\nMessage: ${this.tag.message}`;
      }
      if (this.tag.isAnnotated) {
        tooltip += '\n(Annotated Tag)';
      }
      return tooltip;
    }

    return typeof this.label === 'string' ? this.label : '';
  }
}

/**
 * Branch Tree Data Provider.
 * Provides tree data for the branches view with local branches, remote branches, and tags.
 *
 * - 5.1: Context menu for local branches
 * - 5.2: Context menu for remote branches
 * - 5.7: Disable checkout for current branch
 * - 5.8: Context menu for tags
 * - 17.6: Organize menu items in logical groupings
 */
export class BranchTreeProvider implements vscode.TreeDataProvider<BranchTreeItem> {
  private _gitService: IGitService;
  private _currentRepository: IRepository | undefined;
  private _onDidChangeTreeData: vscode.EventEmitter<BranchTreeItem | undefined | null | void>;
  readonly onDidChangeTreeData: vscode.Event<BranchTreeItem | undefined | null | void>;

  constructor(gitService: IGitService) {
    this._gitService = gitService;
    this._onDidChangeTreeData = new vscode.EventEmitter<BranchTreeItem | undefined | null | void>();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;

    // Listen for repository changes
    this._gitService.onDidChangeRepository((repo) => {
      this._currentRepository = repo;
      this.refresh();
    });

    // Initialize with first repository
    void this._initializeRepository();
  }

  private async _initializeRepository(): Promise<void> {
    const repositories = this._gitService.getRepositories();
    if (repositories.length > 0) {
      this._currentRepository = repositories[0];
    } else {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders && workspaceFolders.length > 0) {
        this._currentRepository = await this._gitService.getRepository(workspaceFolders[0].uri);
      }
    }
    this.refresh();
  }

  /**
   * Refresh the tree view
   */
  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  /**
   * Set the current repository
   */
  setRepository(repo: IRepository): void {
    this._currentRepository = repo;
    this.refresh();
  }

  /**
   * Get the current repository
   */
  getRepository(): IRepository | undefined {
    return this._currentRepository;
  }

  getTreeItem(element: BranchTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: BranchTreeItem): Promise<BranchTreeItem[]> {
    if (!this._currentRepository) {
      return [];
    }

    // Root level - show categories
    if (!element) {
      return [
        new BranchTreeItem('Local Branches', vscode.TreeItemCollapsibleState.Expanded, 'category'),
        new BranchTreeItem(
          'Remote Branches',
          vscode.TreeItemCollapsibleState.Collapsed,
          'category'
        ),
        new BranchTreeItem('Tags', vscode.TreeItemCollapsibleState.Collapsed, 'category'),
      ];
    }

    // Category level - show items
    if (element.itemType === 'category') {
      switch (element.label) {
        case 'Local Branches':
          return this._getLocalBranches();
        case 'Remote Branches':
          return this._getRemoteBranches();
        case 'Tags':
          return this._getTags();
        default:
          return [];
      }
    }

    return [];
  }

  private async _getLocalBranches(): Promise<BranchTreeItem[]> {
    if (!this._currentRepository) {
      return [];
    }

    const branches = await this._gitService.getBranches(this._currentRepository);
    const localBranches = branches.filter((b) => b.type === 'local');
    const currentBranchName = this._currentRepository.head?.name?.replace('refs/heads/', '');

    return localBranches.map((branch) => {
      const isCurrentBranch = branch.name === currentBranchName || branch.isHead;
      return new BranchTreeItem(
        branch.name,
        vscode.TreeItemCollapsibleState.None,
        'local-branch',
        branch,
        undefined,
        isCurrentBranch
      );
    });
  }

  private async _getRemoteBranches(): Promise<BranchTreeItem[]> {
    if (!this._currentRepository) {
      return [];
    }

    const branches = await this._gitService.getBranches(this._currentRepository);
    const remoteBranches = branches.filter((b) => b.type === 'remote');

    return remoteBranches.map((branch) => {
      // Parse remote name from branch name (e.g., "origin/main" -> "main")
      const parts = branch.name.split('/');
      const displayName = parts.slice(1).join('/');

      return new BranchTreeItem(
        displayName,
        vscode.TreeItemCollapsibleState.None,
        'remote-branch',
        branch
      );
    });
  }

  private async _getTags(): Promise<BranchTreeItem[]> {
    if (!this._currentRepository) {
      return [];
    }

    const tags = await this._gitService.getTags(this._currentRepository);

    return tags.map((tag) => {
      return new BranchTreeItem(
        tag.name,
        vscode.TreeItemCollapsibleState.None,
        'tag',
        undefined,
        tag
      );
    });
  }
}

/**
 * Create a new BranchTreeProvider instance.
 *
 * @param gitService - The Git service to use
 * @returns A new BranchTreeProvider instance
 */
export function createBranchTreeProvider(gitService: IGitService): BranchTreeProvider {
  return new BranchTreeProvider(gitService);
}
