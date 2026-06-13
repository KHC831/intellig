/**
 * Branch Tree Provider implementation.
 * Provides a tree view of branches with context menu support.
 */

import * as vscode from 'vscode';
import { IGitService, IRepository, IBranch, ITag } from '../git-core/interfaces/IGitService';
import { resolveRepo } from '../utils/resolveRepo';
import { safeFireAndForget } from '../utils/safeFireAndForget';
import { getLogger, type Logger } from '../utils/logger';

/**
 * Tree item types for the branch tree
 */
export type BranchTreeItemType =
  | 'local-branch'
  | 'remote-branch'
  | 'tag'
  | 'category'
  | 'detached-head' // Synthetic row for detached HEAD state
  | 'branch-folder'; // IntelliJ-parity nesting node ("feature" container with feature/* children)

/**
 * Branch-folder scope (the kind of branches the folder groups).
 * Used to dispatch back to the right branch list when expanding the
 * folder.
 */
export type BranchFolderScope = 'local' | 'remote';

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
} as const;

/**
 * Branch tree item representing a branch, tag, or category in the tree view
 */
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
    remotePrefix?: string
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
        return this.isCurrentBranch
          ? CONTEXT_VALUES.LOCAL_BRANCH_CURRENT
          : CONTEXT_VALUES.LOCAL_BRANCH;
      case 'remote-branch':
        return CONTEXT_VALUES.REMOTE_BRANCH;
      case 'tag':
        return CONTEXT_VALUES.TAG;
      case 'category':
        return CONTEXT_VALUES.CATEGORY;
      case 'detached-head':
        return CONTEXT_VALUES.DETACHED_HEAD;
      case 'branch-folder':
        return CONTEXT_VALUES.BRANCH_FOLDER;
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
        // Both local and remote branches use the same git-branch icon
        // (per UX request to drop the cloud-vs-branch distinction). The
        // ref kind is still distinguishable via the parent category in
        // the tree (`Local` vs `Remote`) and the `Remote branch:` aria
        // label on chips.
        return new vscode.ThemeIcon('git-branch');
      case 'tag':
        return new vscode.ThemeIcon('tag');
      case 'category':
        return new vscode.ThemeIcon('folder');
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

/**
 * Branch Tree Data Provider.
 * Provides tree data for the branches view with local branches, remote branches, and tags.
 *
 * - Context menu for local branches
 * - Context menu for remote branches
 * - Disable checkout for current branch
 * - Context menu for tags
 * - Organize menu items in logical groupings
 */
export class BranchTreeProvider
  implements vscode.TreeDataProvider<BranchTreeItem>, vscode.Disposable
{
  private _gitService: IGitService;
  private _currentRepository: IRepository | undefined;
  private _onDidChangeTreeData: vscode.EventEmitter<BranchTreeItem | undefined | null | void>;
  readonly onDidChangeTreeData: vscode.Event<BranchTreeItem | undefined | null | void>;
  // Own the EventEmitter + every event subscription so
  // `dispose()` (called from the extension's
  // `context.subscriptions.push(...)` registration) tears down cleanly
  // on extension deactivation. The constructor leaked the
  // `onDidChangeRepository` listener and the EventEmitter on dispose.
  private readonly _disposables: vscode.Disposable[] = [];
  private _disposed = false;

  /**
   * Component-bound Logger emitted on each refresh trigger (debug)
   * and refresh failure (warn) so the BranchTree's lifecycle waypoints
   * land in the IntelliG OutputChannel uniformly with the rest of the
   * service graph.
   */
  private readonly _logger: Logger;

  constructor(gitService: IGitService) {
    this._gitService = gitService;
    this._onDidChangeTreeData = new vscode.EventEmitter<BranchTreeItem | undefined | null | void>();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this._logger = getLogger().child({ component: 'BranchTreeProvider' });

    // Listen for repository changes. Capture the subscription
    // so dispose() tears it down. Guard the callback against post-dispose
    // delivery (the event source can outlive us when dispose() races
    // with an in-flight `onDidChangeRepository` fire — a no-op here is
    // safer than mutating `_currentRepository` mid-teardown).
    this._disposables.push(
      this._gitService.onDidChangeRepository((repo) => {
        if (this._disposed) {
          return;
        }
        this._currentRepository = repo;
        this.refresh();
      })
    );

    // Initialize with first repository. Bucket C: init path;
    // `onDidChangeRepository` above picks up repos discovered later, so a
    // cold-start failure is transient.
    safeFireAndForget(
      this._initializeRepository(),
      'BranchTreeProvider.constructor: initial repository load'
    );
  }

  /**
   * Dispose the EventEmitter and every captured
   * subscription. Idempotent: safe to call twice (the second call is
   * a no-op). Post-dispose, `refresh()` becomes a no-op because the
   * event emitter is dead and the `_disposed` flag short-circuits
   * the `onDidChangeRepository` callback.
   *
   * Registered with `context.subscriptions.push(branchTreeProvider)`
   * in `extension.ts:4178` so the extension lifecycle owns the
   * teardown.
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables.length = 0;
    this._onDidChangeTreeData.dispose();
  }

  /**
   * Initialize the current repository for this tree provider.
   *
   * Route through `resolveRepo(preferActive: true)` so the
   * branches view reflects the active editor's repo in multi-root
   * workspaces, not an arbitrary first-enumerated repo. Falls back to
   * discovering the first workspace folder when the git service hasn't
   * populated any repos yet.
   */
  private async _initializeRepository(): Promise<void> {
    const repo = await resolveRepo(this._gitService, {
      preferActive: true,
      silent: true,
    });
    if (repo) {
      this._currentRepository = repo;
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
    // debug-level waypoint on every refresh trigger.
    // Fires whenever upstream state changes
    // (repo switch, init, manual `setRepository`, etc.).
    this._logger.debug('refresh triggered');
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
        new BranchTreeItem('Local', vscode.TreeItemCollapsibleState.Expanded, 'category'),
        new BranchTreeItem('Remote', vscode.TreeItemCollapsibleState.Collapsed, 'category'),
        new BranchTreeItem('Tags', vscode.TreeItemCollapsibleState.Collapsed, 'category'),
      ];
    }

    // Category level - show items
    if (element.itemType === 'category') {
      try {
        switch (element.label) {
          case 'Local':
            return await this._getLocalBranches();
          case 'Remote':
            return await this._getRemoteBranches();
          case 'Tags':
            return await this._getTags();
          default:
            return [];
        }
      } catch (err) {
        // warn-level waypoint on refresh failure.
        // Re-throw so VS Code still surfaces the
        // error to the TreeView host (preserves pre-task observable
        // behaviour).
        this._logger.warn('refresh failed', {
          category: typeof element.label === 'string' ? element.label : '',
        });
        throw err;
      }
    }

    // Branch-folder level — descend into nested folder children.
    if (element.itemType === 'branch-folder') {
      try {
        return await this._getFolderChildren(element);
      } catch (err) {
        this._logger.warn('refresh failed', {
          category: 'branch-folder',
          folderPath: element.folderPath,
        });
        throw err;
      }
    }

    return [];
  }

  private async _getLocalBranches(): Promise<BranchTreeItem[]> {
    if (!this._currentRepository) {
      return [];
    }

    const items: BranchTreeItem[] = [];

    // When detached, prepend a "(HEAD detached at <sha>)" row at
    // the TOP of Local Branches. Detached signal: `head.name === undefined
    // && head.commit` is a non-empty string (per: `git symbolic-ref
    // HEAD` exits non-zero in detached state, so `head.name` is undefined;
    // `parseHead` always sets `head.commit` to `commitOutput.trim()`,
    // which can be the EMPTY string in a corrupt repo where rev-parse
    // also returned nothing — guard against that with `length > 0` so
    // we don't render `(HEAD detached at )` with an empty SHA).
    // Empty repo (`head` undefined entirely) falls through — no detached
    // row. Mid-rebase keeps `head.name` set, so no detached row there
    // either. Pinned by branchTree-detached-1..6.
    const head = this._currentRepository.head;
    if (head && head.name === undefined && head.commit && head.commit.length > 0) {
      const shortSha = head.commit.substring(0, 7);
      items.push(
        new BranchTreeItem(
          `(HEAD detached at ${shortSha})`,
          vscode.TreeItemCollapsibleState.None,
          'detached-head',
          undefined,
          undefined,
          true, // isCurrentBranch — yes, the user IS here
          head.commit // detachedHeadSha (full 40-char SHA)
        )
      );
    }

    const branches = await this._gitService.getBranches(this._currentRepository);
    const localBranches = branches.filter((b) => b.type === 'local');
    const currentBranchName = head?.name?.replace('refs/heads/', '');

    // IntelliJ-parity nesting: branches with `/` in their names group
    // into folder rows. `feature/auth/login` shows up as
    // `feature → auth → login` instead of a flat `feature/auth/login`
    // entry. Build the level-0 view by partitioning the branches into
    // first-segment buckets.
    const groupedItems = this._groupBranchesByPath(
      localBranches,
      '',
      'local',
      currentBranchName,
      undefined
    );
    items.push(...groupedItems);

    return items;
  }

  private async _getRemoteBranches(): Promise<BranchTreeItem[]> {
    if (!this._currentRepository) {
      return [];
    }

    const branches = await this._gitService.getBranches(this._currentRepository);
    const remoteBranches = branches.filter((b) => b.type === 'remote');

    // First level under "Remote": one folder per remote name (origin,
    // upstream, …). The remote name is segment 0 of the branch's full
    // name (`origin/main` → remote=origin, leaf=main). When a remote
    // has only one branch we still nest it under the remote folder so
    // the user sees a consistent "remote → branches" structure
    // (matches IntelliJ).
    const byRemote = new Map<string, IBranch[]>();
    for (const branch of remoteBranches) {
      const slash = branch.name.indexOf('/');
      if (slash <= 0) {
        // Defensive: a remote branch without a `/` is malformed; surface it
        // at the top level rather than dropping it on the floor.
        const items = byRemote.get('') ?? [];
        items.push(branch);
        byRemote.set('', items);
        continue;
      }
      const remote = branch.name.slice(0, slash);
      const list = byRemote.get(remote) ?? [];
      list.push(branch);
      byRemote.set(remote, list);
    }

    const remoteNames = Array.from(byRemote.keys()).sort();
    return remoteNames.map((remoteName) => {
      if (remoteName === '') {
        // Malformed branches (no `/` in the name) — render them as
        // a flat group under a synthetic empty-name folder so they're
        // still visible. Should never happen in practice.
        return new BranchTreeItem(
          '(unknown remote)',
          vscode.TreeItemCollapsibleState.Collapsed,
          'branch-folder',
          undefined,
          undefined,
          false,
          undefined,
          '',
          'remote',
          ''
        );
      }
      return new BranchTreeItem(
        remoteName,
        vscode.TreeItemCollapsibleState.Collapsed,
        'branch-folder',
        undefined,
        undefined,
        false,
        undefined,
        '',
        'remote',
        remoteName
      );
    });
  }

  /**
   * Build the children of a {@link BranchTreeItem} whose itemType is
   * `'branch-folder'`. Re-fetches the branches (cheap; gitService
   * caches) and partitions them at the next path segment after
   * {@link BranchTreeItem.folderPath} (and {@link BranchTreeItem.remotePrefix}
   * for remotes).
   */
  private async _getFolderChildren(folder: BranchTreeItem): Promise<BranchTreeItem[]> {
    if (!this._currentRepository || !folder.folderScope) {
      return [];
    }
    const branches = await this._gitService.getBranches(this._currentRepository);
    const filtered = branches.filter((b) => b.type === folder.folderScope);

    const head = this._currentRepository.head;
    const currentBranchName = head?.name?.replace('refs/heads/', '');

    return this._groupBranchesByPath(
      filtered,
      folder.folderPath ?? '',
      folder.folderScope,
      currentBranchName,
      folder.remotePrefix
    );
  }

  /**
   * Partition a flat list of branches into the children at a given
   * folder level (path-prefix grouping, IntelliJ parity).
   *
   * @param branches    Flat list of branches at this scope (already
   *                    filtered to local-only or remote-only).
   * @param folderPath  Slash-joined path from the category root,
   *                    excluding the {@link remotePrefix} for remotes.
   *                    Empty string means "at the root of the
   *                    category" (top-level for Local; underneath a
   *                    specific remote for Remote).
   * @param scope       `'local'` or `'remote'`.
   * @param currentBranchName HEAD's branch name (for the `current`
   *                    affordance; only meaningful for local
   *                    branches).
   * @param remotePrefix Remote-name prefix to strip from each branch
   *                    name before partitioning (e.g. `origin`).
   *                    Undefined for local branches.
   */
  private _groupBranchesByPath(
    branches: IBranch[],
    folderPath: string,
    scope: BranchFolderScope,
    currentBranchName: string | undefined,
    remotePrefix: string | undefined
  ): BranchTreeItem[] {
    // Compute, for each branch, the path-stripped suffix relative to
    // the current folder. Drop branches that don't fall under the
    // folder.
    const stripPrefix = (name: string): string | undefined => {
      let rest = name;
      if (remotePrefix) {
        const remoteWithSlash = `${remotePrefix}/`;
        if (!rest.startsWith(remoteWithSlash)) {
          return undefined;
        }
        rest = rest.slice(remoteWithSlash.length);
      }
      if (folderPath) {
        const folderWithSlash = `${folderPath}/`;
        if (!rest.startsWith(folderWithSlash)) {
          return undefined;
        }
        rest = rest.slice(folderWithSlash.length);
      }
      return rest;
    };

    // Bucket: first segment of the suffix → either the leaf branch (no
    // more `/` in the suffix) or a list of branches grouped under that
    // segment as a folder.
    const leaves: IBranch[] = [];
    const folderBuckets = new Map<string, IBranch[]>();
    for (const branch of branches) {
      const suffix = stripPrefix(branch.name);
      if (suffix === undefined || suffix === '') {
        continue;
      }
      const slash = suffix.indexOf('/');
      if (slash === -1) {
        leaves.push(branch);
      } else {
        const segment = suffix.slice(0, slash);
        const list = folderBuckets.get(segment) ?? [];
        list.push(branch);
        folderBuckets.set(segment, list);
      }
    }

    // Render order (IntelliJ parity): folders first (alpha-sorted),
    // then leaves (alpha-sorted). The user scans top-down; folders
    // group related work, leaves are direct children.
    const items: BranchTreeItem[] = [];
    const folderSegments = Array.from(folderBuckets.keys()).sort();
    for (const segment of folderSegments) {
      const childPath = folderPath ? `${folderPath}/${segment}` : segment;
      items.push(
        new BranchTreeItem(
          segment,
          vscode.TreeItemCollapsibleState.Collapsed,
          'branch-folder',
          undefined,
          undefined,
          false,
          undefined,
          childPath,
          scope,
          remotePrefix
        )
      );
    }

    leaves.sort((a, b) => a.name.localeCompare(b.name));
    for (const branch of leaves) {
      const suffix = stripPrefix(branch.name)!;
      // The leaf's display name is the trailing segment, not the full
      // path — IntelliJ parity, and the parent folders already convey
      // the prefix in the tree breadcrumb.
      const displayName = suffix;
      if (scope === 'local') {
        const isCurrentBranch = branch.name === currentBranchName || branch.isHead;
        items.push(
          new BranchTreeItem(
            displayName,
            vscode.TreeItemCollapsibleState.None,
            'local-branch',
            branch,
            undefined,
            isCurrentBranch
          )
        );
      } else {
        items.push(
          new BranchTreeItem(
            displayName,
            vscode.TreeItemCollapsibleState.None,
            'remote-branch',
            branch
          )
        );
      }
    }

    return items;
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
