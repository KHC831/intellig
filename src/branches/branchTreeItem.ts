/**
 * The Branches tree's row type: one class for every row (repository,
 * category, folder, branch, tag, detached HEAD), with the context values the
 * menus bind to.
 */

import * as vscode from 'vscode';
import type { IRepository, IBranch, ITag } from '../git-core/interfaces/IGitService';

/**
 * Last path segment of a repository root, used as the label of a
 * `'repository'` root node in multi-repo mode. Matches the repo-name
 * derivation used elsewhere (e.g. the update/pull/push repo pickers).
 */
export function repositoryLabel(repo: IRepository): string {
  const fsPath = repo.rootUri.fsPath;
  return fsPath.split(/[\\/]/).filter(Boolean).pop() ?? fsPath;
}

/** The one color repository-row icons render in (per UX decision). */
const REPOSITORY_ICON_COLOR = 'charts.green';

/**
 * Tree item types for the branch tree
 */
export type BranchTreeItemType =
  | 'local-branch'
  | 'remote-branch'
  | 'tag'
  | 'category'
  | 'detached-head' // Synthetic row for detached HEAD state — the only HEAD-specific row (an attached HEAD is the checked row inside Local)
  | 'branch-folder' // IntelliJ-parity nesting node ("feature" container with feature/* children)
  | 'repository' // Per-repository root node in a multi-repo workspace (git4idea GitBranchesTreeMultiRepoModel)
  | 'worktrees-category' // A repository's Worktrees section (git4idea Working Trees tab)
  | 'worktree' // One working tree under it
  | 'message'; // A row that only says something, e.g. why a list could not load

/**
 * Folder scope (the kind of ref the folder groups). Used to dispatch back
 * to the right ref list when expanding the folder.
 */
export type BranchFolderScope = 'local' | 'remote' | 'tag';

/** Label of the per-repository section that lists its working trees. */
export const WORKTREES_CATEGORY = 'Worktrees';

/**
 * Context values for tree items (used in when clauses for menus)
 */
export const CONTEXT_VALUES = {
  LOCAL_BRANCH: 'intellig.localBranch',
  LOCAL_BRANCH_CURRENT: 'intellig.localBranchCurrent',
  REMOTE_BRANCH: 'intellig.remoteBranch',
  TAG: 'intellig.tag',
  CATEGORY: 'intellig.category',
  DETACHED_HEAD: 'intellig.detachedHead',
  BRANCH_FOLDER: 'intellig.branchFolder',
  REPOSITORY: 'intellig.repository',
  WORKTREES_CATEGORY: 'intellig.worktreesCategory',
} as const;

/**
 * Branch tree item representing a branch, tag, or category in the tree view
 */
/**
 * Where should the git graph navigate when this tree row is selected?
 * Branch rows jump by NAME (the graph resolves the tip from its branch
 * map) plus the row's repo root when it has one — in a multi-root workspace
 * several repos carry a same-named branch, and the merged log needs the root
 * to land on the clicked repo's tip. Tag rows jump by the tag's peeled
 * COMMIT hash (tags aren't in the branch map, so name-based lookup can't
 * find them — the class of bug that left tag clicks doing nothing);
 * structural rows (categories, folders, repository headers) don't navigate.
 */
export function graphTargetForTreeSelection(
  item: BranchTreeItem
):
  | { kind: 'branch'; name: string; repoRoot?: string }
  | { kind: 'commit'; hash: string }
  | undefined {
  if (item.branch) {
    const repoRoot = item.repository?.rootUri.fsPath;
    return repoRoot
      ? { kind: 'branch', name: item.branch.name, repoRoot }
      : { kind: 'branch', name: item.branch.name };
  }
  if (item.tag) {
    return { kind: 'commit', hash: item.tag.commit };
  }
  return undefined;
}

export class BranchTreeItem extends vscode.TreeItem {
  public readonly itemType: BranchTreeItemType;
  public readonly branch?: IBranch;
  public readonly tag?: ITag;
  public readonly isCurrentBranch: boolean;
  /**
   * Full 40-char commit SHA when {@link itemType} is
   * `'detached-head'`. Read by dispatcher (e.g. `_handleCheckout`,
   * `_handleNewBranchFrom`) via {@link getDetachedHeadSha}; never reach
   * inside this field directly so the dispatcher contract stays
   * grep-able.
   *
   * Undefined for every non-detached-head row.
   */
  private readonly _detachedHeadSha?: string;
  /**
   * Folder-path data for {@link itemType} === `'branch-folder'`.
   *
   * `folderPath` is the slash-joined path from the category root
   * (e.g. `feature` or `feature/auth`); `folderScope` is `'local'` or
   * `'remote'` so getChildren can re-fetch the right branch list.
   * `remotePrefix` is the remote name (e.g. `origin`) when the folder
   * lives under the Remote category — remote branches arrive as
   * `origin/feature/auth`, but the user-visible path under Remote is
   * `origin → feature → auth`, so we keep the prefix separate from
   * `folderPath` to avoid double-counting `origin/` while filtering.
   *
   * All three are undefined for non-folder rows.
   */
  public readonly folderPath?: string;
  public readonly folderScope?: BranchFolderScope;
  public readonly remotePrefix?: string;
  /**
   * True when this row is a branch the user has starred (git4idea
   * parity: `GitRepositoryModel.favoriteRefs`). Drives the star icon.
   * Always false for non-branch rows.
   */
  public readonly isFavorite: boolean;
  /**
   * Repository this node belongs to in a multi-repo workspace
   * (git4idea parity: `GitBranchesTreeMultiRepoModel` builds a
   * `RepositoryNode` per repo). Set on the `'repository'` root node and
   * propagated to every section/folder node beneath it so `getChildren`
   * resolves branches against the right repo. Undefined in the
   * single-repo flat layout, where the provider falls back to its
   * `_currentRepository`.
   */
  public readonly repository?: IRepository;

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    itemType: BranchTreeItemType,
    branch?: IBranch,
    tag?: ITag,
    isCurrentBranch: boolean = false,
    detachedHeadSha?: string, // Full 40-char SHA for detached row
    folderPath?: string,
    folderScope?: BranchFolderScope,
    remotePrefix?: string,
    isFavorite: boolean = false,
    repository?: IRepository
  ) {
    super(label, collapsibleState);

    this.itemType = itemType;
    this.branch = branch;
    this.tag = tag;
    this.isCurrentBranch = isCurrentBranch;
    this._detachedHeadSha = detachedHeadSha;
    this.folderPath = folderPath;
    this.folderScope = folderScope;
    this.remotePrefix = remotePrefix;
    this.isFavorite = isFavorite;
    this.repository = repository;

    // Set context value for menu contributions
    this.contextValue = this._getContextValue();

    // Set icon based on type
    this.iconPath = this._getIcon();

    // Set description for branches
    this.description = this._getDescription();

    // Set tooltip
    this.tooltip = this._getTooltip();

    // accessibilityInformation for the synthetic
    // detached-head row. VS Code's TreeView reads `label + description`
    // by default; for the detached row we want the SR to hear the
    // multi-line tooltip's leading phrase ("Detached HEAD — at <sha>")
    // because the visible label is just `(HEAD detached at <sha>)` and
    // the description ("detached") doesn't convey "this is your current
    // commit". Pinned by `branchTree-detached-aria-1` in
    // BranchTreeProvider.test.ts.
    if (this.itemType === 'detached-head') {
      const sha = this._detachedHeadSha ?? '';
      const shortSha = sha.length >= 7 ? sha.substring(0, 7) : sha;
      this.accessibilityInformation = {
        label: shortSha
          ? `Detached HEAD at ${shortSha} — not on a branch`
          : 'Detached HEAD — not on a branch',
        role: 'treeitem',
      };
    }
  }

  /**
   * A structural row that carries only its repository: a repository node, a
   * category, a message.
   */
  static forRepository(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    itemType: BranchTreeItemType,
    repo: IRepository
  ): BranchTreeItem {
    return new BranchTreeItem(
      label,
      collapsibleState,
      itemType,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      repo
    );
  }

  /**
   * Public accessor for the detached HEAD SHA. Returns the full
   * 40-char commit SHA when this row is the synthetic detached-head row;
   * `undefined` otherwise.
   *
   * Dispatchers (`_handleCheckout`, `_handleNewBranchFrom`) call this
   * to obtain the git start-point WITHOUT reading the parenthesized
   * label string — that path is the regression class.
   */
  public getDetachedHeadSha(): string | undefined {
    return this._detachedHeadSha;
  }

  private _getContextValue(): string {
    switch (this.itemType) {
      case 'local-branch':
        // Favorite state is conveyed by the star icon, not the context
        // value — so a starred branch keeps the full local-branch menu
        // (checkout, compare, …). The Toggle Favorite action binds to
        // both local-branch context values.
        return this.isCurrentBranch
          ? CONTEXT_VALUES.LOCAL_BRANCH_CURRENT
          : CONTEXT_VALUES.LOCAL_BRANCH;
      case 'remote-branch':
        return CONTEXT_VALUES.REMOTE_BRANCH;
      case 'tag':
        return CONTEXT_VALUES.TAG;
      case 'category':
        return CONTEXT_VALUES.CATEGORY;
      case 'worktrees-category':
        return CONTEXT_VALUES.WORKTREES_CATEGORY;
      case 'detached-head':
        return CONTEXT_VALUES.DETACHED_HEAD;
      case 'branch-folder':
        return CONTEXT_VALUES.BRANCH_FOLDER;
      case 'repository':
        return CONTEXT_VALUES.REPOSITORY;
      default:
        return '';
    }
  }

  private _getIcon(): vscode.ThemeIcon {
    switch (this.itemType) {
      case 'repository':
        return new vscode.ThemeIcon('repo', new vscode.ThemeColor(REPOSITORY_ICON_COLOR));
      case 'local-branch':
        if (this.isCurrentBranch) {
          return new vscode.ThemeIcon(
            'check',
            new vscode.ThemeColor('gitDecoration.addedResourceForeground')
          );
        }
        // Starred branches get a filled star (git4idea parity: favorite
        // refs render with the favorite/star icon).
        return this.isFavorite
          ? new vscode.ThemeIcon('star-full')
          : new vscode.ThemeIcon('git-branch');
      case 'remote-branch':
        // Both local and remote branches use the same git-branch icon
        // (per UX request to drop the cloud-vs-branch distinction). The
        // ref kind is still distinguishable via the parent category in
        // the tree (`Local` vs `Remote`) and the `Remote branch:` aria
        // label on chips. Favorites star the same way either side of that
        // line — a remote ref can be starred, so it must be able to show it.
        return this.isFavorite
          ? new vscode.ThemeIcon('star-full')
          : new vscode.ThemeIcon('git-branch');
      case 'tag':
        return new vscode.ThemeIcon('tag');
      case 'category':
      case 'worktrees-category':
        return new vscode.ThemeIcon('folder');
      case 'message':
        return new vscode.ThemeIcon('info');
      case 'branch-folder':
        return new vscode.ThemeIcon('folder');
      case 'detached-head':
        // yellow/gold matches the HEAD chip in the graph
        // (`statusBarItem.warningBackground`). User reads "this is HEAD"
        // consistently across both surfaces.
        return new vscode.ThemeIcon(
          'git-commit',
          new vscode.ThemeColor('statusBarItem.warningBackground')
        );
      default:
        return new vscode.ThemeIcon('circle-outline');
    }
  }

  private _getDescription(): string | undefined {
    // Synthetic detached-head row description. Distinct from
    // 'current' (which implies a branch is checked out) — 'detached'
    // reads as "you are at this commit; HEAD is not bound to a branch".
    if (this.itemType === 'detached-head') {
      return 'detached';
    }
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
    // Per-repository root node tooltip — the repository's root path.
    if (this.itemType === 'repository') {
      const name = typeof this.label === 'string' ? this.label : '';
      const path = this.repository?.rootUri.fsPath;
      return path ? `Repository: ${name}\n${path}` : `Repository: ${name}`;
    }
    // Synthetic detached-head row tooltip.
    if (this.itemType === 'detached-head') {
      const sha = this._detachedHeadSha ?? '';
      return (
        `Detached HEAD\n` +
        `Commit: ${sha}\n` +
        `(Not on a branch — checkout a branch to attach HEAD)`
      );
    }
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
