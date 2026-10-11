/**
 * The worktrees a repository shows, and their rows in the Branches tree's
 * Worktrees category (git4idea Working Trees tab,
 * workingTrees/ui/GitWorkingTreesListRenderer.kt): main first, each row's
 * state in its icon, description and tooltip, and the actions it offers as
 * words of its context value.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ResultAsync } from 'neverthrow';
import type { IGitService, IRepository } from '../git-core/interfaces/IGitService';
import type { GitError } from '../git-core/errors';
import {
  worktreesOf,
  type IWorktreeCapableService,
  type IWorktreeEntry,
} from '../git-core/ops/WorktreeOps';
import { resolveWorktreeGitDir } from '../git-core/repo/RepositoryDiscovery';
import { formatActionFailureToast } from '../git-core/gitError';
import { BranchTreeItem } from './branchTreeItem';
import { canonicalizeFsPath } from '../utils/repoRelativePath';

/** Context value of a worktree row; the capability words follow it. */
export const WORKTREE_CONTEXT = 'intellig.worktree';

/** What a worktree row offers; each becomes a word of its context value. */
export interface IWorktreeCapabilities {
  canOpen: boolean;
  canRemove: boolean;
  canLock: boolean;
  canUnlock: boolean;
}

export type WorktreeCapability = keyof IWorktreeCapabilities;

/**
 * The worktrees `repo` shows, main first, the way git4idea's
 * GitWorktreeListParser presents them:
 *  - a record on neither a branch nor a detached HEAD (a bare main) is not a
 *    checkout, and is left out;
 *  - the record git reports by its git dir (a submodule's own checkout) gets
 *    the checkout's path back;
 *  - a linked worktree whose folder is gone is prunable, whether or not this
 *    git version (before 2.31) says so.
 */
export function worktreesForDisplay(
  worktrees: IWorktreeCapableService,
  repo: IRepository
): ResultAsync<IWorktreeEntry[], GitError> {
  const root = repo.rootUri.fsPath;
  const gitDir = canonicalizeFsPath(resolveWorktreeGitDir(root));
  return worktrees.listWorktrees(repo).map((list) =>
    list
      .filter((wt) => wt.branch !== undefined || wt.isDetached)
      .map((wt) => (canonicalizeFsPath(wt.path) === gitDir ? { ...wt, path: root } : wt))
      .map((wt) =>
        !wt.isMain && !wt.isPrunable && !fs.existsSync(wt.path) ? { ...wt, isPrunable: true } : wt
      )
      .sort((a, b) => Number(b.isMain) - Number(a.isMain))
  );
}

/**
 * The folders this window shows for `repo`, canonical: its workspace folders
 * and the repository's own root. A worktree at one of them is open here, and
 * removing it would delete a folder on screen.
 */
export function windowRoots(repo: IRepository): ReadonlySet<string> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return new Set(
    [...folders.map((f) => f.uri.fsPath), repo.rootUri.fsPath].map((p) => canonicalizeFsPath(p))
  );
}

/** Is `worktree` at one of `roots` (from {@link windowRoots})? */
export function isOpenInWindow(worktree: IWorktreeEntry, roots: ReadonlySet<string>): boolean {
  return roots.has(canonicalizeFsPath(worktree.path));
}

/**
 * The actions a worktree offers, following git4idea's enablement
 * (OpenWorkingTreeAction, RemoveWorkingTreeAction) plus lock/unlock, which
 * git refuses on the main worktree.
 */
export function worktreeCapabilities(
  worktree: IWorktreeEntry,
  isOpenHere: boolean
): IWorktreeCapabilities {
  return {
    canOpen: !isOpenHere && !worktree.isPrunable,
    canRemove: !worktree.isMain && !isOpenHere,
    canLock: !worktree.isMain && !worktree.isLocked,
    canUnlock: worktree.isLocked,
  };
}

/** Why `worktree` does not offer `capability`, for an action that asked anyway. */
export function capabilityRefusal(
  capability: WorktreeCapability,
  worktree: IWorktreeEntry,
  isOpenHere: boolean
): string {
  const name = worktreeName(worktree);
  switch (capability) {
    case 'canOpen':
      return isOpenHere
        ? `'${name}' is already open in this window.`
        : `The worktree folder '${worktree.path}' no longer exists.`;
    case 'canRemove':
      return worktree.isMain
        ? 'The main worktree cannot be removed.'
        : `This window has '${name}' open. Open another worktree to remove it.`;
    case 'canLock':
      return worktree.isMain
        ? 'The main worktree cannot be locked.'
        : `'${name}' is already locked.`;
    case 'canUnlock':
      return `'${name}' is not locked.`;
  }
}

/** A worktree's folder name, as its row is labelled. */
export function worktreeName(worktree: IWorktreeEntry): string {
  return path.basename(worktree.path) || worktree.path;
}

/** What a worktree has checked out: its branch, or the commit it is detached at. */
export function worktreeCheckout(worktree: IWorktreeEntry): string {
  if (worktree.branch) {
    return worktree.branch.replace(/^refs\/heads\//, '');
  }
  return worktree.head ? `detached at ${worktree.head.slice(0, 7)}` : 'detached';
}

/** The state words a worktree is described with, in row and picker alike. */
export function worktreeStates(worktree: IWorktreeEntry): string[] {
  return [
    worktree.isMain ? 'main worktree' : undefined,
    worktree.isLocked ? 'Locked' : undefined,
    worktree.isPrunable ? 'Prunable' : undefined,
  ].filter((part): part is string => part !== undefined);
}

function tooltipFor(worktree: IWorktreeEntry, isOpenHere: boolean): string {
  const lines = [`Worktree: ${worktree.path}`, `Branch: ${worktreeCheckout(worktree)}`];
  if (worktree.head) {
    lines.push(`HEAD: ${worktree.head}`);
  }
  if (worktree.isMain) {
    lines.push('Main worktree');
  }
  if (isOpenHere) {
    lines.push('Open in this window');
  }
  if (worktree.isLocked) {
    lines.push(worktree.lockReason ? `Locked: ${worktree.lockReason}` : 'Locked');
  }
  if (worktree.isPrunable) {
    lines.push(worktree.prunableReason ? `Prunable: ${worktree.prunableReason}` : 'Prunable');
  }
  return lines.join('\n');
}

function iconFor(worktree: IWorktreeEntry, isOpenHere: boolean): vscode.ThemeIcon {
  if (isOpenHere) {
    return new vscode.ThemeIcon(
      'check',
      new vscode.ThemeColor('gitDecoration.addedResourceForeground')
    );
  }
  if (worktree.isPrunable) {
    return new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
  }
  return new vscode.ThemeIcon(worktree.isLocked ? 'lock' : 'folder');
}

/** One working tree in the Branches tree. */
export class WorktreeTreeItem extends BranchTreeItem {
  constructor(
    public readonly worktree: IWorktreeEntry,
    repo: IRepository,
    isOpenHere: boolean
  ) {
    super(
      worktreeName(worktree),
      vscode.TreeItemCollapsibleState.None,
      'worktree',
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
    const can = worktreeCapabilities(worktree, isOpenHere);
    this.contextValue = [
      WORKTREE_CONTEXT,
      ...(Object.keys(can) as WorktreeCapability[]).filter((key) => can[key]),
    ].join(' ');
    this.description = [worktreeCheckout(worktree), ...worktreeStates(worktree)].join(' · ');
    this.tooltip = tooltipFor(worktree, isOpenHere);
    this.iconPath = iconFor(worktree, isOpenHere);
  }
}

/**
 * The Worktrees category's children for `repo`. A failed listing renders as
 * one row saying so: the tree is a passive view, so it degrades rather than
 * throwing at the tree host.
 */
export async function worktreeRows(
  gitService: IGitService,
  repo: IRepository
): Promise<BranchTreeItem[]> {
  const roots = windowRoots(repo);
  return worktreesForDisplay(worktreesOf(gitService), repo).match(
    (list) => list.map((wt) => new WorktreeTreeItem(wt, repo, isOpenInWindow(wt, roots))),
    (error) => {
      const row = BranchTreeItem.forRepository(
        formatActionFailureToast('Failed to list worktrees', error),
        vscode.TreeItemCollapsibleState.None,
        'message',
        repo
      );
      row.iconPath = new vscode.ThemeIcon('error');
      return [row];
    }
  );
}
