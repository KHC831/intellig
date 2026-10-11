/**
 * The worktree commands: the branch menu's New / Open / Remove Worktree…
 * pickers, the Worktrees category's Prune Worktrees…, and the actions on a
 * Worktrees row. A row action goes through the tree-item spine with a
 * worktree target, then {@link withCurrentWorktree}, once per selected row.
 */

import type * as vscode from 'vscode';
import { registerLoggedCommand } from '../utils/logger';
import {
  registerTreeItemCommand,
  type ITreeItemCommandDeps,
} from '../commands/registration/commandSpine';
import type { IRepository } from '../git-core/interfaces/IGitService';
import type { IWorktreeEntry } from '../git-core/ops/WorktreeOps';
import type { BranchTreeItem } from './branchTreeItem';
import type { WorktreeCapability } from './worktreeTreeItems';
import {
  confirmAndRemoveWorktree,
  handleLockWorktree,
  handleNewWorktree,
  handleOpenWorktree,
  handlePruneWorktrees,
  handleRemoveWorktree,
  handleUnlockWorktree,
  openWorktreeFolder,
  withCurrentWorktree,
  type IBranchWorktreeContext,
} from './branchWorktreeActions';

export function registerWorktreeCommands(
  ctx: IBranchWorktreeContext,
  deps: ITreeItemCommandDeps
): vscode.Disposable[] {
  const onRow = (spec: {
    id: string;
    failureTitle: string;
    /** The capability word that shows this command's menu item. */
    requires: WorktreeCapability;
    /** Act on the clicked row only, ignoring the rest of a selection. */
    clickedOnly?: boolean;
    run: (repo: IRepository, worktree: IWorktreeEntry) => Promise<void>;
  }): vscode.Disposable =>
    registerTreeItemCommand(deps, {
      id: spec.id,
      failureTitle: spec.failureTitle,
      accepts: ['worktree'],
      run: async ({ batch }) => {
        for (const { repo, target } of spec.clickedOnly ? batch.slice(0, 1) : batch) {
          await withCurrentWorktree(ctx, repo, target.worktree, spec.requires, (wt) =>
            spec.run(repo, wt)
          );
        }
      },
    });

  return [
    // spine-exempt: deliberately usable without a tree target (worktree ref falls back to HEAD)
    registerLoggedCommand('intellig.branch.newWorktree', (item?: BranchTreeItem) =>
      handleNewWorktree(ctx, item)
    ),
    // spine-exempt: repo-scope picker; the clicked row only names the repository
    registerLoggedCommand('intellig.branch.openWorktree', (item?: BranchTreeItem) =>
      handleOpenWorktree(ctx, item)
    ),
    // spine-exempt: repo-scope picker; the clicked row only names the repository
    registerLoggedCommand('intellig.branch.removeWorktree', (item?: BranchTreeItem) =>
      handleRemoveWorktree(ctx, item)
    ),
    // spine-exempt: the Worktrees category row carries only its repository, no tree target
    registerLoggedCommand('intellig.worktree.prune', async (item?: BranchTreeItem) => {
      const repo = ctx.resolveRepository(item);
      if (repo) {
        await handlePruneWorktrees(ctx, repo);
      }
    }),
    onRow({
      id: 'intellig.worktree.openInNewWindow',
      failureTitle: 'Failed to open worktree',
      requires: 'canOpen',
      run: (_repo, wt) => openWorktreeFolder(wt, true),
    }),
    onRow({
      id: 'intellig.worktree.openInCurrentWindow',
      failureTitle: 'Failed to open worktree',
      requires: 'canOpen',
      clickedOnly: true,
      run: (_repo, wt) => openWorktreeFolder(wt, false),
    }),
    onRow({
      id: 'intellig.worktree.lock',
      failureTitle: 'Failed to lock worktree',
      requires: 'canLock',
      run: (repo, wt) => handleLockWorktree(ctx, repo, wt),
    }),
    onRow({
      id: 'intellig.worktree.unlock',
      failureTitle: 'Failed to unlock worktree',
      requires: 'canUnlock',
      run: (repo, wt) => handleUnlockWorktree(ctx, repo, wt),
    }),
    onRow({
      id: 'intellig.worktree.remove',
      failureTitle: 'Failed to remove worktree',
      requires: 'canRemove',
      run: (repo, wt) => confirmAndRemoveWorktree(ctx, repo, wt),
    }),
  ];
}
