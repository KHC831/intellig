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
import { readConfig, updateConfig } from '../config/configKeys';
import { IGitService, IRepository, IBranch, ITag } from '../git-core/interfaces/IGitService';
import type { IFavoritesStore } from './BranchTreeProvider';
import type { IIncomingOutgoing } from '../git-core/ops/IncomingOutgoingOps';
import { resolveRepo } from '../utils/resolveRepo';
import { safeFireAndForget } from '../utils/safeFireAndForget';
import { sanitizeGitError } from '../git-core/gitError';

/**
 * Fetcher contract injected into {@link enrichBranchesWithIncomingOutgoing}.
 * Mirrors the `IncomingOutgoingOps.getForBranch` signature so callers can
 * pass the concrete service method without an extra wrapper:
 *
 *   (repo, branchName) => gitService.getIncomingOutgoingForBranch(repo, branchName)
 */
export type IncomingOutgoingFetcher = (
  repo: IRepository,
  branch: string
) => Promise<IIncomingOutgoing>;

/**
 * Duck-type guard: returns the gitService's `getIncomingOutgoingForBranch`
 * method as an {@link IncomingOutgoingFetcher} when present, `undefined`
 * otherwise. The method lives on the concrete GitService class, not the frozen
 * IGitService interface (ADR-001), so consumers detect it structurally rather
 * than widening the interface. Shared by the branch popup and the branch tree.
 */
export function getIncomingOutgoingFetcher(
  gitService: unknown
): IncomingOutgoingFetcher | undefined {
  if (
    typeof gitService === 'object' &&
    gitService !== null &&
    'getIncomingOutgoingForBranch' in gitService &&
    typeof (gitService as Record<string, unknown>).getIncomingOutgoingForBranch === 'function'
  ) {
    const svc = gitService as {
      getIncomingOutgoingForBranch(repo: IRepository, branch: string): Promise<IIncomingOutgoing>;
    };
    return (repo: IRepository, branch: string) => svc.getIncomingOutgoingForBranch(repo, branch);
  }
  return undefined;
}

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
 * Workspace-state key under which the favorites list is persisted.
 *
 * Shape: `string[]` — branch names (local or remote-qualified), insertion
 * order preserved. Deduplicated. Branches that no longer exist in the repo
 * are filtered out at render time rather than pruned at write time (matches
 * IntelliJ's forgiving behaviour around transient/remote-only branches).
 */
export const FAVORITE_BRANCHES_STATE_KEY = 'intellig.favoriteBranches';

/**
 * Section identifier for an item in the main sectioned QuickPick.
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
  | 'local.setUpstream'
  // Tag specific
  | 'tag.checkoutDetached'
  | 'tag.newBranchFrom'
  | 'tag.cherryPick'
  | 'tag.mergeIntoCurrent'
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
 * Header action carried by the branch popup's title bar, mirroring git4idea's
 * `GitBranchesTreePopup` header (New Branch, Fetch, Settings gear).
 */
export type BranchPopupHeaderAction = 'new-branch' | 'fetch' | 'settings';

/**
 * A title-bar button on the main branch QuickPick. `commandId` is dispatched
 * via `vscode.commands.executeCommand` for the action buttons; the Settings
 * gear has none — it opens the in-popup toggle menu instead.
 */
export interface IBranchPopupHeaderButton extends vscode.QuickInputButton {
  action: BranchPopupHeaderAction;
  commandId?: string;
}

/**
 * Settings-gear toggles, parity with git4idea `GitBranchesTreePopupSettings`
 * (`shared/src/com/intellij/vcs/git/branch/popup/GitBranchesPopupHeaderActions.kt`).
 * Multi-root-only toggles (filter-by-repository, track-repos-synchronously) are
 * deferred with the multi-repo grouping slice.
 */
export interface IBranchPopupSettings {
  /** Render the Tags section (git4idea `git.branches.show.tags`). */
  showTags: boolean;
  /** Render the Recent section (git4idea `git.branches.show.recent`). */
  showRecentBranches: boolean;
  /** Auto-indent `/`-prefixed siblings (git4idea `git.branches.group.by.directory`). */
  groupByDirectory: boolean;
}

/** A toggle entry in the settings-gear sub-menu. */
export interface IBranchSettingsToggleItem extends vscode.QuickPickItem {
  setting: keyof IBranchPopupSettings;
}

/**
 * Build the branch popup's header (title-bar) buttons, mirroring git4idea's
 * `GitBranchesTreePopup` header — New Branch (`Git.CreateNewBranch`), Fetch
 * (`Git.Branches.Popup.Fetch`), and the Settings gear
 * (`Git.Branches.Popup.Settings`). Pure — safe to unit-test.
 */
export function buildBranchPopupHeaderButtons(): IBranchPopupHeaderButton[] {
  return [
    {
      action: 'new-branch',
      commandId: 'intellig.branch.new',
      iconPath: new vscode.ThemeIcon('add'),
      tooltip: 'New Branch…',
    },
    {
      action: 'fetch',
      commandId: 'intellig.fetch',
      iconPath: new vscode.ThemeIcon('sync'),
      tooltip: 'Fetch',
    },
    {
      action: 'settings',
      iconPath: new vscode.ThemeIcon('settings-gear'),
      tooltip: 'Settings',
    },
  ];
}

/**
 * Build the settings-gear toggle menu items, reflecting the current
 * {@link IBranchPopupSettings} as checkbox state. Order mirrors git4idea's
 * gear group (group-by-directory → show-recent → show-tags).
 */
export function buildSettingsToggleItems(
  settings: IBranchPopupSettings
): IBranchSettingsToggleItem[] {
  return [
    {
      label: 'Group by Directory',
      setting: 'groupByDirectory',
      picked: settings.groupByDirectory,
    },
    {
      label: 'Show Recent Branches',
      setting: 'showRecentBranches',
      picked: settings.showRecentBranches,
    },
    {
      label: 'Show Tags',
      setting: 'showTags',
      picked: settings.showTags,
    },
  ];
}

/**
 * Read the persisted branch-popup settings from VS Code configuration,
 * defaulting every toggle to `true` so the popup's default layout is unchanged.
 */
export function readBranchPopupSettings(): IBranchPopupSettings {
  return {
    showTags: readConfig('branches.showTags'),
    showRecentBranches: readConfig('branches.showRecentBranches'),
    groupByDirectory: readConfig('branches.groupByDirectory'),
  };
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
 * Add or remove a branch name from the favorites list.
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
 * Read the legacy per-workspace favorites list (key
 * {@link FAVORITE_BRANCHES_STATE_KEY}). Retained only so the popup can migrate
 * pre-existing favorites into the shared store; persistence lives in
 * {@link IFavoritesStore}.
 *
 * Returns a defensive copy so callers can't mutate the stored array by
 * reference. Exported for unit tests.
 */
export function readLegacyFavorites(workspaceState: vscode.Memento | undefined): string[] {
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
 * Enrich a list of branches with live incoming/outgoing counts from git.
 *
 * Called by {@link BranchPopup._showSectionedPicker} before building the
 * sectioned QuickPick so each local branch that has a configured tracking
 * upstream shows ↓N (behind = incoming) and ↑N (ahead = outgoing) indicators
 * — IntelliJ's `GitBranchIncomingOutgoingManager` parity
 * (`git4idea/backend/src/branch/GitBranchIncomingOutgoingManager.java`).
 *
 * Key design points:
 *   - Branches without a configured upstream are left untouched (their
 *     `ahead` / `behind` remain `undefined`).
 *   - Individual fetch failures are swallowed and treated as 0/0 so a
 *     single unavailable remote can't abort the whole popup load.
 *   - The original {@link IBranch} objects are never mutated; the function
 *     returns shallow clones with updated counts.
 *   - All upstream-bearing fetches run in parallel (`Promise.all`).
 *
 * @param repo       - Repository to query.
 * @param branches   - Flat list of branches (local + remote).
 * @param fetcher    - Service method to retrieve incoming/outgoing counts.
 *
 * @returns New array of IBranch — clones with `ahead` / `behind` populated
 *          for tracked branches, originals for the rest.
 */
export async function enrichBranchesWithIncomingOutgoing(
  repo: IRepository,
  branches: IBranch[],
  fetcher: IncomingOutgoingFetcher
): Promise<IBranch[]> {
  // Build enrichment tasks only for branches with a configured upstream.
  const tasks: Array<{ index: number; task: Promise<IIncomingOutgoing> }> = [];
  for (let i = 0; i < branches.length; i++) {
    if (branches[i].upstream) {
      tasks.push({
        index: i,
        task: fetcher(repo, branches[i].name).catch(
          (): IIncomingOutgoing => ({
            branch: branches[i].name,
            incoming: 0,
            outgoing: 0,
            noUpstream: true,
          })
        ),
      });
    }
  }

  // Resolve all fetches in parallel.
  const results = await Promise.all(tasks.map((t) => t.task));

  // Build the output — copy each branch, applying counts for fetched ones.
  const out: IBranch[] = branches.map((b) => ({ ...b }));
  for (let ti = 0; ti < tasks.length; ti++) {
    const { index } = tasks[ti];
    const io = results[ti];
    // Map: incoming (upstream → local) = behind; outgoing (local → upstream) = ahead.
    out[index] = { ...out[index], behind: io.incoming, ahead: io.outgoing };
  }

  return out;
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
  /** Favorite branch names, insertion-order preserved. */
  favoriteBranchNames?: readonly string[];
  currentBranchName?: string;
  /** Render the Tags section (default true). git4idea `git.branches.show.tags`. */
  showTags?: boolean;
  /** Render the Recent section (default true). git4idea `git.branches.show.recent`. */
  showRecentBranches?: boolean;
  /** Auto-indent `/`-prefix groups (default true). git4idea `git.branches.group.by.directory`. */
  groupByDirectory?: boolean;
}): IBranchQuickPickItem[] {
  const {
    localBranches,
    remoteBranches,
    tags,
    recentBranchNames,
    favoriteBranchNames,
    currentBranchName,
    showTags = true,
    showRecentBranches = true,
    groupByDirectory = true,
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

  // ── Favorites ─────────────────────────────────────────────────────────
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
        const marker = '$(git-branch)';
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

  if (showRecentBranches && recentResolved.length > 0) {
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
    const localIndentablePrefixes = groupByDirectory
      ? detectIndentablePrefixes(localNames)
      : new Set<string>();

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
    const remoteIndentablePrefixes = groupByDirectory
      ? detectIndentablePrefixes(
          remoteBranches.map((b) => {
            const slash = b.name.indexOf('/');
            return slash >= 0 ? b.name.substring(slash + 1) : b.name;
          })
        )
      : new Set<string>();

    items.push({
      label: 'Remote',
      kind: vscode.QuickPickItemKind.Separator,
    });

    for (const branch of remoteBranches) {
      // Compute the post-remote segment for indent-group matching.
      const slash = branch.name.indexOf('/');
      const postRemote = slash >= 0 ? branch.name.substring(slash + 1) : branch.name;
      let label = `$(git-branch) ${branch.name}`;
      for (const prefix of remoteIndentablePrefixes) {
        if (postRemote.startsWith(prefix)) {
          label = `  $(git-branch) ${branch.name}`;
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
  if (showTags && tags.length > 0) {
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
 * Labels mirror INTELLIJ_REFERENCE.md section "Branches popup — remote branch context menu".
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
 * Labels mirror INTELLIJ_REFERENCE.md section "Branches popup — local branch context menu".
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
    {
      // No commandId: when this entry is accepted, _showBranchActionMenu
      // intercepts it before _dispatchSelectedAction and runs the in-popup
      // _handleSetUpstream (a nested QuickPick of remote branches) rather than
      // dispatching to a registered command. git4idea sets a local branch's
      // upstream via the Push dialog / `checkout --track`; the label mirrors
      // `git branch --set-upstream-to` (and VS Code's built-in "Set Upstream…").
      label: '$(link) Set Upstream…',
      description: `Choose which remote branch ${branch.name} tracks`,
      action: 'local.setUpstream',
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
  ];
}

/**
 * Build the secondary action-menu items for a TAG.
 * Labels mirror INTELLIJ_REFERENCE.md section "Branches popup — tag context menu".
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
      label: '$(git-merge) Merge into Current',
      description: `Merge tag ${tag.name} into the current branch`,
      action: 'tag.mergeIntoCurrent',
      commandId: 'intellig.tag.mergeIntoCurrent',
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
  /**
   * Optional incoming/outgoing fetcher injected at construction time.
   * When present, each local branch with a configured upstream is enriched
   * with ahead/behind counts before the picker renders (IntelliJ
   * `GitBranchIncomingOutgoingManager` parity). When absent (default) the
   * picker loads without the async per-branch git queries so the popup
   * opens immediately even if the service hasn't exposed the method.
   *
   * Wired in `extension.ts`:
   *   `(repo, branch) => gitService.getIncomingOutgoingForBranch(repo, branch)`
   */
  private _incomingOutgoingFetcher: IncomingOutgoingFetcher | undefined;
  /**
   * Shared favorites store — the single source of truth for starred branches
   * across the popup and the Branches tree (git4idea parity: one
   * `GitRepositoryModel.favoriteRefs`). Injected so both surfaces read and
   * write the same set; when absent (unit doubles that don't exercise stars)
   * favorites are unavailable.
   */
  private _favoritesStore: IFavoritesStore | undefined;

  constructor(
    gitService: IGitService,
    workspaceState?: vscode.Memento,
    incomingOutgoingFetcher?: IncomingOutgoingFetcher,
    favoritesStore?: IFavoritesStore
  ) {
    this._gitService = gitService;
    this._workspaceState = workspaceState;
    this._incomingOutgoingFetcher = incomingOutgoingFetcher;
    this._favoritesStore = favoritesStore;
    this._migrateLegacyFavorites();

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
    // Load branches + tags in parallel.
    const [rawBranches, tags] = await Promise.all([
      this._gitService.getBranches(repo),
      this._safeGetTags(repo),
    ]);

    // Enrich local branches with incoming/outgoing counts when the fetcher
    // is wired (IntelliJ GitBranchIncomingOutgoingManager parity — ↓N behind
    // and ↑N ahead badges next to each branch in the list). Falls back to the
    // raw branch list when no fetcher is present so the popup still opens
    // without the async git queries.
    const branches = this._incomingOutgoingFetcher
      ? await enrichBranchesWithIncomingOutgoing(
          repo,
          rawBranches,
          this._incomingOutgoingFetcher
        ).catch(() => rawBranches) // swallow enrichment failures; never block the popup
      : rawBranches;

    const localBranches = branches.filter((b) => b.type === 'local');
    const remoteBranches = branches.filter((b) => b.type === 'remote');
    const currentBranchName = repo.head?.name?.replace('refs/heads/', '');

    const recentBranchNames = this._readRecentMap()[repo.rootUri.fsPath] ?? [];

    const quickPick = vscode.window.createQuickPick<IBranchQuickPickItem>();
    quickPick.title = 'Git Branches';
    quickPick.placeholder = 'Search branches, remotes, tags…';
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;

    // Header (title-bar) actions: New Branch, Fetch, Settings gear — parity with
    // git4idea GitBranchesTreePopup's header (Git.CreateNewBranch,
    // Git.Branches.Popup.Fetch, Git.Branches.Popup.Settings).
    quickPick.buttons = buildBranchPopupHeaderButtons();

    // Render with the current favorites + settings toggles; `refreshItems`
    // re-invokes `buildSectionedItems` so star toggles and the settings gear
    // update the UI in-place without dismissing the picker.
    const refreshItems = (): void => {
      const settings = readBranchPopupSettings();
      quickPick.items = buildSectionedItems({
        localBranches,
        remoteBranches,
        tags,
        recentBranchNames,
        favoriteBranchNames: this.getFavorites(),
        currentBranchName,
        showTags: settings.showTags,
        showRecentBranches: settings.showRecentBranches,
        groupByDirectory: settings.groupByDirectory,
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

      // Header buttons: New Branch / Fetch dispatch their command (dismissing
      // the popup first, matching git4idea where the action closes the popup);
      // the Settings gear opens the in-popup toggle menu and re-renders.
      quickPick.onDidTriggerButton(async (button) => {
        const header = button as IBranchPopupHeaderButton;
        if (header.action === 'settings') {
          await this._showBranchSettingsMenu();
          refreshItems();
          return;
        }
        if (header.commandId) {
          quickPick.hide();
          await this._dispatchHeaderCommand(header.commandId);
          finish({ cancelled: true });
        }
      });

      // Star button → toggle favorite for the item's branch and re-render
      // in-place so the user can star multiple branches without dismissing
      // the picker.
      quickPick.onDidTriggerItemButton(async ({ item }) => {
        const branch = item.branch;
        if (!branch) {
          return;
        }
        const currentFavs = this.getFavorites();
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
   * Toggle a branch's favorite status through the shared favorites store, so
   * the star is reflected on the Branches tree too (single
   * `GitRepositoryModel.favoriteRefs`).
   *
   * Public so extension-level commands / tests can flip favorites without
   * going through the QuickPick UI.
   */
  public updateFavorites(branchName: string, favorite: boolean): Promise<void> {
    if (!this._favoritesStore) {
      return Promise.resolve();
    }
    const updated = updateFavoritesList(this._favoritesStore.read(), branchName, favorite);
    this._favoritesStore.write(updated);
    return Promise.resolve();
  }

  /**
   * Read the current favorites list from the shared store. Returns a
   * defensive copy so callers can't mutate the stored array by reference.
   */
  public getFavorites(): string[] {
    return this._favoritesStore ? [...this._favoritesStore.read()] : [];
  }

  /**
   * One-time migration of favorites persisted under the old per-workspace
   * key ({@link FAVORITE_BRANCHES_STATE_KEY}) into the shared store, so no
   * pre-existing star is lost when the two surfaces unify. The union is
   * idempotent; clearing the old key prevents re-migration and stops the
   * workspace copy from drifting from the shared set.
   */
  private _migrateLegacyFavorites(): void {
    if (!this._workspaceState || !this._favoritesStore) {
      return;
    }
    const legacy = readLegacyFavorites(this._workspaceState);
    if (legacy.length === 0) {
      return;
    }
    const merged = [...new Set([...this._favoritesStore.read(), ...legacy])];
    this._favoritesStore.write(merged);
    void this._workspaceState.update(FAVORITE_BRANCHES_STATE_KEY, undefined);
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

    // Set Upstream… is handled inline (nested QuickPick of remote branches)
    // rather than dispatched to a registered command.
    if (selected.action === 'local.setUpstream') {
      return this._handleSetUpstream(repo, branch);
    }

    return this._dispatchSelectedAction(repo, selected);
  }

  /**
   * Set (or change) a local branch's tracking upstream.
   *
   * Opens a nested QuickPick of the repository's remote branches and routes the
   * choice through {@link IGitService.setBranchUpstream}
   * (`git branch --set-upstream-to=<ref> -- <local>`). git4idea has no dedicated
   * "set upstream" popup entry — it configures tracking via the Push dialog or
   * `checkout --track`; this surfaces the same operation from the local-branch
   * popup. Guards: no remote branches / a cancelled pick are graceful no-ops.
   */
  private async _handleSetUpstream(
    repo: IRepository,
    branch: IBranch
  ): Promise<IBranchPopupResult> {
    let remoteBranches: IBranch[];
    try {
      const all = await this._gitService.getBranches(repo);
      remoteBranches = all.filter((b) => b.type === 'remote');
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to load branches: ${sanitizeGitError(msg)}`);
      return { cancelled: true };
    }

    if (remoteBranches.length === 0) {
      void vscode.window.showInformationMessage(
        `No remote branches available to set as upstream for '${branch.name}'.`
      );
      return { branch, cancelled: true };
    }

    const currentUpstream = branch.upstream
      ? `${branch.upstream.remote}/${branch.upstream.name}`
      : undefined;

    const pickItems: IBranchQuickPickItem[] = remoteBranches.map((b) => ({
      label: `$(cloud) ${b.name}`,
      description: b.name === currentUpstream ? 'current upstream' : undefined,
      branch: b,
    }));

    const picked = await vscode.window.showQuickPick(pickItems, {
      title: `Set Upstream for '${branch.name}'`,
      placeHolder: 'Select a remote branch to track',
    });
    if (!picked || !picked.branch) {
      return { cancelled: true };
    }

    const upstreamRef = picked.branch.name;
    try {
      await this._gitService.setBranchUpstream(repo, branch.name, upstreamRef).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      await this._gitService.reloadRepository(repo);
      void vscode.window.showInformationMessage(`'${branch.name}' now tracks '${upstreamRef}'`);
      return { branch, action: 'local.setUpstream', cancelled: false };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to set upstream: ${sanitizeGitError(msg)}`);
      return { cancelled: true };
    }
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
   * Dispatch a header-action command (New Branch / Fetch), surfacing a "Coming
   * soon" hint if the backing command isn't registered yet and a sanitized
   * error toast on failure. Mirrors {@link _dispatchSelectedAction}'s
   * registration guard so the header behaves like the action menu.
   */
  private async _dispatchHeaderCommand(commandId: string): Promise<void> {
    try {
      const allCommands = await vscode.commands.getCommands(true);
      if (!allCommands.includes(commandId)) {
        void vscode.window.showInformationMessage(`Coming soon: ${commandId}`);
        return;
      }
      await vscode.commands.executeCommand(commandId);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Branch operation failed: ${sanitizeGitError(errorMessage)}`
      );
    }
  }

  /**
   * Show the settings-gear toggle menu (multi-select), parity with git4idea's
   * `GitBranchesTreePopupSettings`. Persists each toggle to VS Code
   * configuration so the choice survives across popups.
   */
  private async _showBranchSettingsMenu(): Promise<void> {
    const before = readBranchPopupSettings();
    const items = buildSettingsToggleItems(before);

    const picked = await vscode.window.showQuickPick(items, {
      title: 'Branch Popup Settings',
      placeHolder: 'Toggle which sections and grouping appear',
      canPickMany: true,
    });
    // `undefined` = the user dismissed without confirming; leave settings as-is.
    if (!picked) {
      return;
    }

    const selectedSettings = new Set(picked.map((i) => i.setting));
    const updates: Thenable<void>[] = [];
    for (const item of items) {
      const next = selectedSettings.has(item.setting);
      if (next !== before[item.setting]) {
        updates.push(
          updateConfig(`branches.${item.setting}`, next, vscode.ConfigurationTarget.Global)
        );
      }
    }
    await Promise.all(updates);
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
 * @param incomingOutgoingFetcher - Optional fetcher for per-branch ahead/behind
 *   counts (IntelliJ GitBranchIncomingOutgoingManager parity).
 * @param favoritesStore - Shared favorites store (the same instance the
 *   Branches tree uses) so stars are consistent across both surfaces.
 * @returns A new BranchPopup instance
 */
export function createBranchPopup(
  gitService: IGitService,
  workspaceState?: vscode.Memento,
  incomingOutgoingFetcher?: IncomingOutgoingFetcher,
  favoritesStore?: IFavoritesStore
): BranchPopup {
  return new BranchPopup(gitService, workspaceState, incomingOutgoingFetcher, favoritesStore);
}
