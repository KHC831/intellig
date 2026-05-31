/**
 * Branch Popup implementation.
 * Provides an IntelliJ-parity, sectioned QuickPick branch selector.
 *
 * Sections (top-to-bottom):
 *   - Recent   (≤5 most-recently-checked-out branches, current branch excluded)
 *   - Local    (all local branches, current highlighted with ● marker)
 *   - Remote   (all remote branches, preserved as origin/<name>)
 *   - Tags     (all tags)
 *
 * Favorites section (★) is deferred to T3-01 and intentionally omitted here.
 *
 * On selection:
 *   - Local branch  → secondary action menu (Checkout, Merge into Current, Rebase Current onto …, Compare, etc.)
 *   - Remote branch → secondary action menu (Checkout, Pull into Current Using Merge/Rebase, Compare, Cherry-Pick Commits, …)
 *   - Tag           → secondary action menu (Checkout Detached, New Branch from Tag…, Cherry-Pick, Delete, Push)
 *
 * Recent list persisted in workspaceState under key `intellig.recentBranches` (per repo, 5-entry LRU).
 * Auto-indent: when ≥3 branches share a `/` prefix, they are indented by 2 spaces in the label
 * (purely cosmetic — the raw prefix remains for QuickPick native filtering to work).
 */

import * as vscode from 'vscode';
import { IGitService, IRepository, IBranch, ITag } from '../git-core/interfaces/IGitService';
import { resolveRepo } from '../utils/resolveRepo';
import { safeFireAndForget } from '../utils/safeFireAndForget';
import { sanitizeGitError } from '../git-core/gitError';

/**
 * Workspace-state key under which the recent-branches LRU map is persisted.
 * Shape: `{ [repoRootFsPath: string]: string[] }` where the string[] is the
 * list of branch names (most-recent first, ≤5 entries, deduped).
 */
export const RECENT_BRANCHES_STATE_KEY = 'intellig.recentBranches';

/** Maximum number of recent branches retained in the LRU. */
export const RECENT_BRANCHES_MAX = 5;

/** Minimum sibling count before `/`-prefix auto-indent kicks in. */
export const AUTO_INDENT_MIN_GROUP_SIZE = 3;

/**
 * T3-01 — Workspace-state key under which the favorites list is persisted.
 *
 * Shape: `string[]` — branch names (local or remote-qualified), insertion
 * order preserved. Deduplicated. Branches that no longer exist in the repo
 * are filtered out at render time rather than pruned at write time (matches
 * IntelliJ's forgiving behaviour around transient/remote-only branches).
 */
export const FAVORITE_BRANCHES_STATE_KEY = 'intellig.favoriteBranches';

/**
 * Section identifier for an item in the main sectioned QuickPick.
 *
 * T3-01 added `favorites` at the top of the list.
 */
export type BranchPopupSection = 'favorites' | 'recent' | 'local' | 'remote' | 'tags';

/**
 * Branch action types available in the secondary action menu.
 */
export type BranchAction =
  // Shared
  | 'checkout'
  | 'new-branch'
  | 'new-branch-from'
  | 'merge'
  | 'rebase'
  | 'compare'
  | 'rename'
  | 'delete'
  | 'cherry-pick'
  | 'pull'
  // Remote-branch specific (IntelliJ parity)
  | 'remote.checkoutAsLocal'
  | 'remote.checkoutAndRebase'
  | 'remote.pullUsingMerge'
  | 'remote.pullUsingRebase'
  | 'remote.cherryPickCommits'
  // Local-branch specific
  | 'local.newBranchFrom'
  | 'local.mergeIntoCurrent'
  | 'local.rebaseCurrentOnto'
  | 'local.push'
  // Tag specific
  | 'tag.checkoutDetached'
  | 'tag.newBranchFrom'
  | 'tag.cherryPick'
  | 'tag.delete'
  | 'tag.push';

/**
 * Quick pick item for branches / tags / actions.
 */
export interface IBranchQuickPickItem extends vscode.QuickPickItem {
  branch?: IBranch;
  tag?: ITag;
  section?: BranchPopupSection;
  action?: BranchAction;
  commandId?: string;
  isAction?: boolean;
}

/**
 * Result from branch popup selection.
 */
export interface IBranchPopupResult {
  branch?: IBranch;
  tag?: ITag;
  action?: BranchAction;
  cancelled: boolean;
}

/**
 * Pure helper — returns the normalized label used in the Recent LRU.
 * For local branches, the name is used as-is (e.g. `main`, `feature/auth`).
 * For remote branches, the full remote-qualified name is used (`origin/main`).
 */
function normalizeRecentKey(branch: IBranch): string {
  return branch.name;
}

/**
 * Push a branch onto the front of a 5-entry LRU, deduplicating existing entries
 * and evicting from the tail. Pure — returns a new array.
 */
export function updateRecentLru(existing: readonly string[], name: string): string[] {
  const deduped = existing.filter((n) => n !== name);
  const next = [name, ...deduped];
  return next.slice(0, RECENT_BRANCHES_MAX);
}

/**
 * T3-01 — Add or remove a branch name from the favorites list.
 *
 * Insertion order is preserved, duplicates are removed. Pure — returns a new
 * array. Exported for unit tests.
 */
export function updateFavoritesList(
  existing: readonly string[],
  branchName: string,
  favorite: boolean
): string[] {
  const filtered = existing.filter((n) => n !== branchName);
  return favorite ? [...filtered, branchName] : filtered;
}

/**
 * T3-01 — Read the favorites list from workspaceState.
 *
 * Returns a defensive copy so callers can't mutate the stored array by
 * reference. Exported for unit tests and for callers outside this module
 * that want to know the current state.
 */
export function getFavorites(workspaceState: vscode.Memento | undefined): string[] {
  if (!workspaceState) {
    return [];
  }
  const raw = workspaceState.get<string[]>(FAVORITE_BRANCHES_STATE_KEY, []);
  return Array.isArray(raw) ? [...raw] : [];
}

/**
 * Detect `/`-prefix groups that have ≥ AUTO_INDENT_MIN_GROUP_SIZE siblings, so
 * those branches can be visually indented in the popup.
 * Returns the set of prefixes (e.g. `feature/`, `bugfix/`) that qualify.
 */
export function detectIndentablePrefixes(names: readonly string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const name of names) {
    const slash = name.indexOf('/');
    if (slash <= 0) {
      continue;
    }
    const prefix = name.substring(0, slash + 1);
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  const result = new Set<string>();
  for (const [prefix, count] of counts) {
    if (count >= AUTO_INDENT_MIN_GROUP_SIZE) {
      result.add(prefix);
    }
  }
  return result;
}

/**
 * Apply auto-indent (2-space prefix) to a branch label if its name is in a
 * qualifying `/`-prefix group. Purely cosmetic.
 */
export function formatBranchLabel(
  name: string,
  indentablePrefixes: Set<string>,
  isCurrent: boolean
): string {
  // Current branch always uses `● ` marker, never indent.
  if (isCurrent) {
    return `● ${name}`;
  }
  for (const prefix of indentablePrefixes) {
    if (name.startsWith(prefix)) {
      return `  ${name}`;
    }
  }
  return name;
}

/**
 * Build the sectioned QuickPick item list for the main branch popup.
 * Pure function — takes data in, returns items out. Safe to unit-test without
 * a VS Code host.
 *
 * Empty sections are suppressed (no header with no items).
 */
export function buildSectionedItems(input: {
  localBranches: IBranch[];
  remoteBranches: IBranch[];
  tags: ITag[];
  recentBranchNames: readonly string[];
  /** T3-01 — favorite branch names, insertion-order preserved. */
  favoriteBranchNames?: readonly string[];
  currentBranchName?: string;
}): IBranchQuickPickItem[] {
  const {
    localBranches,
    remoteBranches,
    tags,
    recentBranchNames,
    favoriteBranchNames,
    currentBranchName,
  } = input;

  const items: IBranchQuickPickItem[] = [];

  // Index local + remote branches by name for Recent / Favorites resolution.
  const allBranches: IBranch[] = [...localBranches, ...remoteBranches];
  const byName = new Map<string, IBranch>();
  for (const b of allBranches) {
    byName.set(b.name, b);
  }

  // Set of favorite names for quick lookup when emitting star buttons.
  const favoriteSet = new Set(favoriteBranchNames ?? []);

  // ── Favorites (T3-01) ─────────────────────────────────────────────────
  //
  // Rendered above Recent so the user's pinned branches are always at the
  // top of the picker. We filter to branches that currently exist (favorites
  // referring to deleted branches are silently skipped).
  if (favoriteBranchNames && favoriteBranchNames.length > 0) {
    const favoriteResolved: IBranch[] = [];
    for (const name of favoriteBranchNames) {
      const branch = byName.get(name);
      if (branch) {
        favoriteResolved.push(branch);
      }
    }
    if (favoriteResolved.length > 0) {
      items.push({
        label: '★ Favorites',
        kind: vscode.QuickPickItemKind.Separator,
      });
      for (const branch of favoriteResolved) {
        const marker = branch.type === 'remote' ? '$(cloud)' : '$(git-branch)';
        items.push({
          label: `★ ${marker} ${branch.name}`,
          description: branch.type === 'remote' ? 'remote' : 'local',
          buttons: [
            {
              iconPath: new vscode.ThemeIcon('star-full'),
              tooltip: 'Unstar',
            },
          ],
          branch,
          section: 'favorites',
        });
      }
    }
  }

  // ── Recent ────────────────────────────────────────────────────────────
  const recentResolved: IBranch[] = [];
  for (const name of recentBranchNames) {
    if (name === currentBranchName) {
      continue; // exclude current branch from Recent per spec
    }
    const branch = byName.get(name);
    if (branch) {
      recentResolved.push(branch);
    }
  }

  if (recentResolved.length > 0) {
    items.push({
      label: 'Recent',
      kind: vscode.QuickPickItemKind.Separator,
    });
    for (const branch of recentResolved) {
      const marker = branch.type === 'remote' ? '$(cloud)' : '$(git-branch)';
      items.push({
        label: `${marker} ${branch.name}`,
        description: branch.type === 'remote' ? 'remote' : 'local',
        branch,
        section: 'recent',
      });
    }
  }

  // ── Local ─────────────────────────────────────────────────────────────
  if (localBranches.length > 0) {
    const localNames = localBranches.map((b) => b.name);
    const localIndentablePrefixes = detectIndentablePrefixes(localNames);

    items.push({
      label: 'Local',
      kind: vscode.QuickPickItemKind.Separator,
    });

    for (const branch of localBranches) {
      const isCurrent = branch.name === currentBranchName || branch.isHead;
      const label = formatBranchLabel(branch.name, localIndentablePrefixes, isCurrent);
      const isFav = favoriteSet.has(branch.name);
      items.push({
        label,
        description: formatBranchDescription(branch, isCurrent),
        detail: branch.upstream ? `→ ${branch.upstream.remote}/${branch.upstream.name}` : undefined,
        buttons: [
          {
            iconPath: new vscode.ThemeIcon(isFav ? 'star-full' : 'star-empty'),
            tooltip: isFav ? 'Unstar' : 'Add to Favorites',
          },
        ],
        branch,
        section: 'local',
      });
    }
  }

  // ── Remote ────────────────────────────────────────────────────────────
  if (remoteBranches.length > 0) {
    // For remote indent detection, strip the leading "<remote>/" so grouping
    // works on the post-remote segment (e.g. `origin/feature/*`).
    const remoteIndentablePrefixes = detectIndentablePrefixes(
      remoteBranches.map((b) => {
        const slash = b.name.indexOf('/');
        return slash >= 0 ? b.name.substring(slash + 1) : b.name;
      })
    );

    items.push({
      label: 'Remote',
      kind: vscode.QuickPickItemKind.Separator,
    });

    for (const branch of remoteBranches) {
      // Compute the post-remote segment for indent-group matching.
      const slash = branch.name.indexOf('/');
      const postRemote = slash >= 0 ? branch.name.substring(slash + 1) : branch.name;
      let label = `$(cloud) ${branch.name}`;
      for (const prefix of remoteIndentablePrefixes) {
        if (postRemote.startsWith(prefix)) {
          label = `  $(cloud) ${branch.name}`;
          break;
        }
      }
      const isFav = favoriteSet.has(branch.name);
      items.push({
        label,
        description: branch.commit ? branch.commit.substring(0, 7) : undefined,
        buttons: [
          {
            iconPath: new vscode.ThemeIcon(isFav ? 'star-full' : 'star-empty'),
            tooltip: isFav ? 'Unstar' : 'Add to Favorites',
          },
        ],
        branch,
        section: 'remote',
      });
    }
  }

  // ── Tags ──────────────────────────────────────────────────────────────
  if (tags.length > 0) {
    items.push({
      label: 'Tags',
      kind: vscode.QuickPickItemKind.Separator,
    });
    for (const tag of tags) {
      items.push({
        label: `$(tag) ${tag.name}`,
        description: tag.commit ? tag.commit.substring(0, 7) : undefined,
        detail: tag.message,
        tag,
        section: 'tags',
      });
    }
  }

  return items;
}

/**
 * Format the right-hand description of a local-branch QuickPick item.
 */
function formatBranchDescription(branch: IBranch, isCurrent: boolean): string {
  const parts: string[] = [];
  if (isCurrent) {
    parts.push('current');
  }
  if (branch.ahead !== undefined && branch.ahead > 0) {
    parts.push(`↑${branch.ahead}`);
  }
  if (branch.behind !== undefined && branch.behind > 0) {
    parts.push(`↓${branch.behind}`);
  }
  if (parts.length === 0 && branch.commit) {
    parts.push(branch.commit.substring(0, 7));
  }
  return parts.join(' ');
}

/**
 * Build the secondary action-menu items for a REMOTE branch selection.
 * Labels mirror INTELLIJ_REFERENCE.md §"Branches popup — remote branch context menu".
 *
 * Routes to command IDs declared in package.json:
 *   - intellig.remoteBranch.checkoutAsLocal
 *   - intellig.branch.checkoutAndRebase          (shared with local)
 *   - intellig.remoteBranch.pullUsingMerge
 *   - intellig.remoteBranch.pullUsingRebase
 *   - intellig.branch.compareWithCurrent         (shared with local)
 *   - intellig.remoteBranch.cherryPickCommits
 *   - intellig.remoteBranch.deleteRemote
 */
export function buildRemoteBranchActionMenu(branch: IBranch): IBranchQuickPickItem[] {
  return [
    {
      label: '$(arrow-down) Checkout',
      description: 'Create a local tracking branch and switch to it',
      action: 'remote.checkoutAsLocal',
      commandId: 'intellig.remoteBranch.checkoutAsLocal',
      branch,
      isAction: true,
    },
    {
      label: '$(git-pull-request) Checkout and Rebase onto Current',
      description: `Checkout ${branch.name} and rebase it onto the previously current branch`,
      action: 'remote.checkoutAndRebase',
      commandId: 'intellig.branch.checkoutAndRebase',
      branch,
      isAction: true,
    },
    {
      label: '$(git-merge) Pull into Current Using Merge',
      description: `Fetch ${branch.name} and merge into the current branch`,
      action: 'remote.pullUsingMerge',
      commandId: 'intellig.remoteBranch.pullUsingMerge',
      branch,
      isAction: true,
    },
    {
      label: '$(git-pull-request) Pull into Current Using Rebase',
      description: `Fetch ${branch.name} and rebase current branch onto it`,
      action: 'remote.pullUsingRebase',
      commandId: 'intellig.remoteBranch.pullUsingRebase',
      branch,
      isAction: true,
    },
    {
      label: '$(diff) Compare with Current',
      description: `Compare ${branch.name} with the current branch`,
      action: 'compare',
      commandId: 'intellig.branch.compareWithCurrent',
      branch,
      isAction: true,
    },
    {
      label: '$(git-commit) Cherry-Pick Commits',
      description: `Choose commits from ${branch.name} to cherry-pick onto current`,
      action: 'remote.cherryPickCommits',
      commandId: 'intellig.remoteBranch.cherryPickCommits',
      branch,
      isAction: true,
    },
    {
      label: '$(trash) Delete',
      description: `Delete the remote branch ${branch.name}`,
      action: 'delete',
      commandId: 'intellig.remoteBranch.deleteRemote',
      branch,
      isAction: true,
    },
  ];
}

/**
 * Build the secondary action-menu items for a LOCAL non-current branch.
 * Labels mirror INTELLIJ_REFERENCE.md §"Branches popup — local branch context menu".
 */
export function buildLocalBranchActionMenu(
  branch: IBranch,
  currentBranchName: string | undefined
): IBranchQuickPickItem[] {
  const current = currentBranchName ?? 'current branch';
  return [
    {
      label: '$(arrow-right) Checkout',
      description: `Switch to ${branch.name}`,
      action: 'checkout',
      commandId: 'intellig.branch.checkout',
      branch,
      isAction: true,
    },
    {
      label: `$(add) New Branch from '${branch.name}'…`,
      description: `Create a new branch starting from ${branch.name}`,
      action: 'local.newBranchFrom',
      commandId: 'intellig.branch.newBranchFrom',
      branch,
      isAction: true,
    },
    {
      label: '$(edit) Rename…',
      description: `Rename ${branch.name}`,
      action: 'rename',
      commandId: 'intellig.branch.rename',
      branch,
      isAction: true,
    },
    {
      label: '$(trash) Delete',
      description: `Delete ${branch.name}`,
      action: 'delete',
      commandId: 'intellig.branch.delete',
      branch,
      isAction: true,
    },
    {
      label: '$(diff) Compare with Current',
      description: `Compare ${branch.name} with ${current}`,
      action: 'compare',
      commandId: 'intellig.branch.compareWithCurrent',
      branch,
      isAction: true,
    },
    {
      label: '$(git-merge) Merge into Current',
      description: `Merge ${branch.name} into ${current}`,
      action: 'local.mergeIntoCurrent',
      commandId: 'intellig.branch.mergeIntoCurrent',
      branch,
      isAction: true,
    },
    {
      label: `$(git-pull-request) Rebase Current onto '${branch.name}'`,
      description: `Rebase ${current} onto ${branch.name}`,
      action: 'local.rebaseCurrentOnto',
      commandId: 'intellig.branch.rebaseCurrentOnto',
      branch,
      isAction: true,
    },
    {
      label: '$(cloud-upload) Push…',
      description: `Push ${branch.name} to its upstream remote`,
      action: 'local.push',
      commandId: 'intellig.branch.push',
      branch,
      isAction: true,
    },
  ];
}

/**
 * Build the secondary action-menu items for a TAG.
 * Labels mirror INTELLIJ_REFERENCE.md §"Branches popup — tag context menu".
 */
export function buildTagActionMenu(tag: ITag): IBranchQuickPickItem[] {
  return [
    {
      label: '$(arrow-right) Checkout (Detached)',
      description: `Check out tag ${tag.name} in detached HEAD state`,
      action: 'tag.checkoutDetached',
      commandId: 'intellig.tag.checkoutDetached',
      tag,
      isAction: true,
    },
    {
      label: `$(add) New Branch from Tag…`,
      description: `Create a new branch starting from tag ${tag.name}`,
      action: 'tag.newBranchFrom',
      commandId: 'intellig.tag.newBranchFrom',
      tag,
      isAction: true,
    },
    {
      label: '$(git-commit) Cherry-Pick',
      description: `Cherry-pick tag ${tag.name} onto the current branch`,
      action: 'tag.cherryPick',
      commandId: 'intellig.tag.cherryPick',
      tag,
      isAction: true,
    },
    {
      label: '$(trash) Delete',
      description: `Delete tag ${tag.name}`,
      action: 'tag.delete',
      commandId: 'intellig.tag.delete',
      tag,
      isAction: true,
    },
    {
      label: '$(cloud-upload) Push',
      description: `Push tag ${tag.name} to the default remote`,
      action: 'tag.push',
      commandId: 'intellig.tag.push',
      tag,
      isAction: true,
    },
  ];
}

/**
 * Branch Popup class.
 * Provides a quick pick style branch selector with filtering and IntelliJ-parity actions.
 */
export class BranchPopup {
  private _gitService: IGitService;
  private _statusBarItem: vscode.StatusBarItem;
  private _disposables: vscode.Disposable[] = [];
  private _currentRepository: IRepository | undefined;
  private _workspaceState: vscode.Memento | undefined;

  constructor(gitService: IGitService, workspaceState?: vscode.Memento) {
    this._gitService = gitService;
    this._workspaceState = workspaceState;

    // Create status bar item for current branch display
    this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this._statusBarItem.command = 'intellig.showBranchPopup';
    this._statusBarItem.tooltip = 'Click to manage branches';
    this._disposables.push(this._statusBarItem);

    // Listen for repository changes to update status bar
    this._disposables.push(
      this._gitService.onDidChangeRepository((repo) => {
        this._currentRepository = repo;
        this._updateStatusBar(repo);
      })
    );

    // Initial status bar update. Bucket C: init path, downstream
    // listeners retry on repository change; log-and-suppress is correct.
    safeFireAndForget(
      this._initializeStatusBar(),
      'BranchPopup.constructor: initial status-bar update'
    );
  }

  /**
   * Initialize the status bar with current repository info.
   *
   * Route through `resolveRepo(preferActive: true)` so the
   * active-editor's repo drives the status-bar branch display in multi-root
   * workspaces. Falls back to discovering the first workspace folder's repo
   * when the git service hasn't yet enumerated any repositories (cold start).
   */
  private async _initializeStatusBar(): Promise<void> {
    const repo = await resolveRepo(this._gitService, {
      preferActive: true,
      silent: true,
    });
    if (repo) {
      this._currentRepository = repo;
      this._updateStatusBar(repo);
      return;
    }
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      const discovered = await this._gitService.getRepository(workspaceFolders[0].uri);
      if (discovered) {
        this._currentRepository = discovered;
        this._updateStatusBar(discovered);
      }
    }
  }

  /**
   * Update the status bar with current branch information.
   *
   * Cross-surface parity with `StatusBarService`: when `head.name` is set
   * but `head.commit` is empty (the empty-repo shape — `GitService.loadRepository`
   * surfaces the configured initial branch even before the first commit),
   * render the same `$(git-branch) <name> (no commits yet)` label and
   * tooltip. Without this, BranchPopup's own status-bar item silently
   * drops the "no commits yet" treatment and the two surfaces disagree
   * for the same repo state.
   */
  private _updateStatusBar(repo: IRepository): void {
    if (repo.head?.name) {
      const branchName = repo.head.name.replace('refs/heads/', '');
      // Empty-repo path: head.name set, head.commit empty.
      if (!repo.head.commit) {
        this._statusBarItem.text = `$(git-branch) ${branchName} (no commits yet)`;
        this._statusBarItem.tooltip = `On branch ${branchName} — no commits yet. Your first commit will create this branch.`;
        this._statusBarItem.show();
        return;
      }
      let statusText = `$(git-branch) ${branchName}`;
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
      const shortHash = repo.head.commit.substring(0, 7);
      this._statusBarItem.text = `$(git-commit) ${shortHash}`;
      this._statusBarItem.tooltip = 'Detached HEAD - Click to manage branches';
      this._statusBarItem.show();
    } else {
      this._statusBarItem.text = '$(git-branch) No commits yet';
      this._statusBarItem.show();
    }
  }

  /**
   * Show the branch popup.
   *
   * @param repository - Optional repository to use (defaults to current)
   * @returns Promise resolving to the popup result
   */
  async show(repository?: IRepository): Promise<IBranchPopupResult> {
    const repo = repository || this._currentRepository;

    if (!repo) {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders && workspaceFolders.length > 0) {
        const discoveredRepo = await this._gitService.getRepository(workspaceFolders[0].uri);
        if (!discoveredRepo) {
          void vscode.window.showErrorMessage('No Git repository found');
          return { cancelled: true };
        }
        this._currentRepository = discoveredRepo;
        return this._showSectionedPicker(discoveredRepo);
      }
      void vscode.window.showErrorMessage('No Git repository found');
      return { cancelled: true };
    }

    return this._showSectionedPicker(repo);
  }

  /**
   * Record a successful checkout in the Recent LRU (per repo).
   * Called by extension code whenever a checkout completes.
   */
  public async recordCheckout(repo: IRepository, branch: IBranch): Promise<void> {
    if (!this._workspaceState) {
      return;
    }
    const repoKey = repo.rootUri.fsPath;
    const all = this._readRecentMap();
    const existing = all[repoKey] ?? [];
    const updated = updateRecentLru(existing, normalizeRecentKey(branch));
    all[repoKey] = updated;
    await this._writeRecentMap(all);
  }

  /** Read the per-repo Recent LRU map from workspaceState. */
  private _readRecentMap(): Record<string, string[]> {
    if (!this._workspaceState) {
      return {};
    }
    return this._workspaceState.get<Record<string, string[]>>(RECENT_BRANCHES_STATE_KEY, {}) ?? {};
  }

  /** Write the per-repo Recent LRU map to workspaceState. */
  private async _writeRecentMap(map: Record<string, string[]>): Promise<void> {
    if (!this._workspaceState) {
      return;
    }
    await this._workspaceState.update(RECENT_BRANCHES_STATE_KEY, map);
  }

  /** Show the main sectioned branch picker. */
  private async _showSectionedPicker(repo: IRepository): Promise<IBranchPopupResult> {
    // Load branches + tags in parallel
    const [branches, tags] = await Promise.all([
      this._gitService.getBranches(repo),
      this._safeGetTags(repo),
    ]);

    const localBranches = branches.filter((b) => b.type === 'local');
    const remoteBranches = branches.filter((b) => b.type === 'remote');
    const currentBranchName = repo.head?.name?.replace('refs/heads/', '');

    const recentBranchNames = this._readRecentMap()[repo.rootUri.fsPath] ?? [];

    const quickPick = vscode.window.createQuickPick<IBranchQuickPickItem>();
    quickPick.title = 'Git Branches';
    quickPick.placeholder = 'Search branches, remotes, tags…';
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;

    // T3-01 — render with the current favorites; `refreshItems` re-invokes
    // `buildSectionedItems` so star toggles update the UI in-place without
    // dismissing the picker.
    const refreshItems = (): void => {
      quickPick.items = buildSectionedItems({
        localBranches,
        remoteBranches,
        tags,
        recentBranchNames,
        favoriteBranchNames: getFavorites(this._workspaceState),
        currentBranchName,
      });
    };
    refreshItems();

    return new Promise<IBranchPopupResult>((resolve) => {
      let resolved = false;
      const finish = (r: IBranchPopupResult): void => {
        if (!resolved) {
          resolved = true;
          resolve(r);
        }
      };

      quickPick.onDidAccept(async () => {
        const selected = quickPick.selectedItems[0];
        quickPick.hide();

        if (!selected) {
          finish({ cancelled: true });
          return;
        }

        if (selected.branch) {
          const result = await this._showBranchActionMenu(repo, selected.branch, currentBranchName);
          finish(result);
        } else if (selected.tag) {
          const result = await this._showTagActionMenu(repo, selected.tag);
          finish(result);
        } else {
          finish({ cancelled: true });
        }
      });

      // T3-01 — star button → toggle favorite for the item's branch and
      // re-render in-place so the user can star multiple branches without
      // dismissing the picker.
      quickPick.onDidTriggerItemButton(async ({ item }) => {
        const branch = item.branch;
        if (!branch) {
          return;
        }
        const currentFavs = getFavorites(this._workspaceState);
        const isFav = currentFavs.includes(branch.name);
        await this.updateFavorites(branch.name, !isFav);
        refreshItems();
      });

      quickPick.onDidHide(() => {
        quickPick.dispose();
        finish({ cancelled: true });
      });

      quickPick.show();
    });
  }

  /**
   * T3-01 — Toggle a branch's favorite status, persisted in workspaceState.
   *
   * Public so extension-level commands / tests can flip favorites without
   * going through the QuickPick UI.
   */
  public async updateFavorites(branchName: string, favorite: boolean): Promise<void> {
    if (!this._workspaceState) {
      return;
    }
    const existing = getFavorites(this._workspaceState);
    const updated = updateFavoritesList(existing, branchName, favorite);
    await this._workspaceState.update(FAVORITE_BRANCHES_STATE_KEY, updated);
  }

  /**
   * T3-01 — Read the current favorites list. Thin wrapper around
   * {@link getFavorites} so callers with only a `BranchPopup` handle can
   * inspect the state.
   */
  public getFavorites(): string[] {
    return getFavorites(this._workspaceState);
  }

  /** Show the secondary action menu for the picked branch. */
  private async _showBranchActionMenu(
    repo: IRepository,
    branch: IBranch,
    currentBranchName?: string
  ): Promise<IBranchPopupResult> {
    const isCurrent = branch.name === currentBranchName || branch.isHead;
    const isRemote = branch.type === 'remote';

    // If user clicked the current branch, there's nothing meaningful to do.
    if (isCurrent) {
      void vscode.window.showInformationMessage(
        `Already on '${branch.name}' — use the Local section to pick a different branch.`
      );
      return { branch, cancelled: true };
    }

    const actionItems = isRemote
      ? buildRemoteBranchActionMenu(branch)
      : buildLocalBranchActionMenu(branch, currentBranchName);

    const selected = await vscode.window.showQuickPick(actionItems, {
      title: `Branch: ${branch.name}`,
      placeHolder: 'Select an action',
    });

    if (!selected) {
      return { cancelled: true };
    }

    return this._dispatchSelectedAction(repo, selected);
  }

  /** Show the secondary action menu for the picked tag. */
  private async _showTagActionMenu(repo: IRepository, tag: ITag): Promise<IBranchPopupResult> {
    const actionItems = buildTagActionMenu(tag);

    const selected = await vscode.window.showQuickPick(actionItems, {
      title: `Tag: ${tag.name}`,
      placeHolder: 'Select an action',
    });

    if (!selected) {
      return { cancelled: true };
    }

    return this._dispatchSelectedAction(repo, selected);
  }

  /**
   * Route the selected action-menu entry to its corresponding command ID.
   *
   * Existing branch/tag command handlers (see `BranchContextMenuCommands`) expect
   * a `BranchTreeItem`-like argument with `.branch` / `.tag` fields. We construct
   * a minimal shim and pass it through `vscode.commands.executeCommand`.
   *
   * If a command isn't registered, we show a "Coming soon" info message so the
   * UI still works before the backing handler lands.
   */
  private async _dispatchSelectedAction(
    _repo: IRepository,
    selected: IBranchQuickPickItem
  ): Promise<IBranchPopupResult> {
    const commandId = selected.commandId;
    if (!commandId) {
      void vscode.window.showInformationMessage(
        `Coming soon: ${typeof selected.label === 'string' ? selected.label : 'this action'}`
      );
      return {
        branch: selected.branch,
        tag: selected.tag,
        action: selected.action,
        cancelled: false,
      };
    }

    // Minimal `BranchTreeItem`-compatible shim: the existing handlers only access
    // `.branch` and `.tag` off of the argument.
    const shim = { branch: selected.branch, tag: selected.tag };

    try {
      const allCommands = await vscode.commands.getCommands(true);
      if (!allCommands.includes(commandId)) {
        void vscode.window.showInformationMessage(
          `Coming soon: ${typeof selected.label === 'string' ? selected.label : commandId}`
        );
        return {
          branch: selected.branch,
          tag: selected.tag,
          action: selected.action,
          cancelled: false,
        };
      }
      await vscode.commands.executeCommand(commandId, shim);
      return {
        branch: selected.branch,
        tag: selected.tag,
        action: selected.action,
        cancelled: false,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Branch operation failed: ${sanitizeGitError(errorMessage)}`
      );
      return { cancelled: true };
    }
  }

  /**
   * Load tags for a repository, swallowing errors so the popup still opens when
   * the repository has no tags or the underlying git call fails.
   */
  private async _safeGetTags(repo: IRepository): Promise<ITag[]> {
    try {
      return await this._gitService.getTags(repo);
    } catch {
      return [];
    }
  }

  /** Hide the branch popup (if shown). QuickPick handles its own hiding. */
  hide(): void {
    /* no-op */
  }

  /** Dispose of resources. */
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
 * @param workspaceState - Optional Memento for persisting the Recent LRU
 * @returns A new BranchPopup instance
 */
export function createBranchPopup(
  gitService: IGitService,
  workspaceState?: vscode.Memento
): BranchPopup {
  return new BranchPopup(gitService, workspaceState);
}
