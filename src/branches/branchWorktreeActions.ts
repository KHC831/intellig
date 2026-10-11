/**
 * Worktree actions: the branch context menu's create / open / remove pickers,
 * and the actions on a Worktrees row (open, lock, unlock, remove) and on the
 * Worktrees category (prune). Each reaches back into the dispatcher through
 * {@link IBranchWorktreeContext}.
 */

import * as vscode from 'vscode';
import type { IRepository } from '../git-core/interfaces/IGitService';
import type { GitError } from '../git-core/errors';
import type { BranchTreeItem, BranchTreeProvider } from './BranchTreeProvider';
import { formatActionFailureToast } from '../git-core/gitError';
import { worktreeRemoveRefusal } from '../git-core/gitProse';
import { canonicalizeFsPath } from '../utils/repoRelativePath';
import {
  capabilityRefusal,
  isOpenInWindow,
  windowRoots,
  worktreeCapabilities,
  worktreeCheckout,
  worktreeName,
  worktreesForDisplay,
  worktreeStates,
  type WorktreeCapability,
} from './worktreeTreeItems';
import type {
  IWorktreeCapableService,
  IWorktreeEntry,
  WorktreeRemoveForce,
} from '../git-core/ops/WorktreeOps';

/** Deps the worktree actions reach back into the dispatcher for. */
export interface IBranchWorktreeContext {
  readonly worktrees: IWorktreeCapableService;
  readonly branchTreeProvider: BranchTreeProvider;
  resolveRepository(item?: BranchTreeItem): IRepository | undefined;
}

/**
 * "New Worktree…" — create a linked worktree checked out at the right-clicked
 * branch/tag (or a prompted ref), at a user-chosen path. Mirrors IntelliJ
 * git4idea's `git worktree add`: prompts whether to create a NEW branch in
 * the worktree or check out the existing ref, validates the target path does
 * not already exist, then runs the injection-safe argv builder in
 * {@link WorktreeOps.addWorktree}. Offers to open the new worktree afterward.
 */
export async function handleNewWorktree(
  ctx: IBranchWorktreeContext,
  item?: BranchTreeItem
): Promise<void> {
  const repo = ctx.resolveRepository(item);
  if (!repo) {
    return;
  }

  const ref = item?.branch?.name ?? item?.tag?.name ?? item?.getDetachedHeadSha() ?? 'HEAD';

  const targetPath = await vscode.window.showInputBox({
    prompt: `Path for the new worktree (checked out at '${ref}')`,
    placeHolder: '/absolute/path/to/worktree',
    validateInput: (value) => {
      const trimmed = value?.trim() ?? '';
      if (trimmed.length === 0) {
        return 'Worktree path cannot be empty';
      }
      if (trimmed.startsWith('-')) {
        return 'Worktree path cannot start with "-"';
      }
      return undefined;
    },
  });
  if (!targetPath || targetPath.trim().length === 0) {
    return;
  }
  const worktreePath = targetPath.trim();

  // Refuse a path that already exists — git would fail with a terse error;
  // a clear pre-check is friendlier and matches IntelliJ's path validation.
  let pathExists = false;
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(worktreePath));
    pathExists = true;
  } catch {
    pathExists = false;
  }
  if (pathExists) {
    void vscode.window.showErrorMessage(
      `Cannot create worktree: '${worktreePath}' already exists.`
    );
    return;
  }

  const createBranchPick = await vscode.window.showQuickPick(
    [
      { label: `Check out '${ref}'`, mode: 'existing' as const },
      { label: 'Create a new branch in the worktree…', mode: 'new' as const },
    ],
    { placeHolder: 'How should the worktree be checked out?' }
  );
  if (!createBranchPick) {
    return;
  }

  let newBranch: string | undefined;
  if (createBranchPick.mode === 'new') {
    newBranch = await vscode.window.showInputBox({
      prompt: `New branch name (created at '${ref}')`,
      placeHolder: 'feature/my-worktree-branch',
      validateInput: (value) => {
        if (!value || !value.trim()) {
          return 'Branch name cannot be empty';
        }
        if (!/^(?![-.])[\w\-./]+$/.test(value)) {
          return 'Invalid branch name';
        }
        return undefined;
      },
    });
    if (!newBranch) {
      return;
    }
  }

  const created = await ctx.worktrees
    .addWorktree(repo, { path: worktreePath, ref, newBranch })
    .match(
      () => true,
      (error) => {
        void vscode.window.showErrorMessage(
          formatActionFailureToast('Failed to create worktree', error)
        );
        return false;
      }
    );
  if (!created) {
    return;
  }

  ctx.branchTreeProvider.refresh();

  const open = await vscode.window.showInformationMessage(
    `Worktree created at '${worktreePath}'.`,
    'Open in New Window',
    'Open in Current Window'
  );
  if (open === 'Open in New Window' || open === 'Open in Current Window') {
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(worktreePath), {
      forceNewWindow: open === 'Open in New Window',
    });
  }
}

/**
 * "Open Worktree…" — list the repo's worktrees, let the user pick one, and
 * open it as a VS Code folder. The main worktree and the one this window has
 * open are listed too (you may want either in a fresh window).
 */
export async function handleOpenWorktree(
  ctx: IBranchWorktreeContext,
  item?: BranchTreeItem
): Promise<void> {
  const repo = ctx.resolveRepository(item);
  const worktrees = repo ? await loadWorktrees(ctx, repo) : undefined;
  if (!worktrees) {
    return;
  }
  if (worktrees.length === 0) {
    void vscode.window.showInformationMessage('No worktrees found for this repository.');
    return;
  }

  const picked = await vscode.window.showQuickPick(worktrees.map(pickItem), {
    placeHolder: 'Select a worktree to open',
  });
  if (!picked) {
    return;
  }

  const newWindow = await vscode.window.showQuickPick(
    [
      { label: 'Open in New Window', forceNewWindow: true },
      { label: 'Open in Current Window', forceNewWindow: false },
    ],
    { placeHolder: `Open '${picked.worktree.path}'` }
  );
  if (newWindow) {
    await openWorktreeFolder(picked.worktree, newWindow.forceNewWindow);
  }
}

/**
 * "Remove Worktree…" — pick a worktree that offers Remove (never the main
 * worktree, never one this window has open), confirm once, and `git worktree
 * remove` it. The same picker carries a prune item so stale records of
 * manually deleted worktrees are cleanable from one front door.
 */
export async function handleRemoveWorktree(
  ctx: IBranchWorktreeContext,
  item?: BranchTreeItem
): Promise<void> {
  const repo = ctx.resolveRepository(item);
  const worktrees = repo ? await loadWorktrees(ctx, repo) : undefined;
  if (!repo || !worktrees) {
    return;
  }

  const roots = windowRoots(repo);
  const removable = worktrees.filter(
    (wt) => worktreeCapabilities(wt, isOpenInWindow(wt, roots)).canRemove
  );

  type RemoveItem = vscode.QuickPickItem & { worktree?: IWorktreeEntry; prune?: boolean };
  const items: RemoveItem[] = removable.map(pickItem);
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: '$(trash) Prune stale worktree records', prune: true });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder:
      removable.length === 0
        ? 'No linked worktrees to remove — prune cleans records of deleted ones'
        : 'Select a worktree to remove',
  });
  if (picked?.prune) {
    await prunePrunable(ctx, repo, worktrees);
  } else if (picked?.worktree) {
    await confirmAndRemoveWorktree(ctx, repo, picked.worktree);
  }
}

/**
 * Run a Worktrees row action on the worktree as git lists it NOW, not as the
 * row rendered it: a lock, unlock or remove from a terminal since then would
 * otherwise send the wrong force or the wrong verb. The action runs only if
 * the current worktree still offers `capability`, the same word that gated
 * its menu item; otherwise the user is told why and the tree catches up.
 */
export async function withCurrentWorktree(
  ctx: IBranchWorktreeContext,
  repo: IRepository,
  clicked: IWorktreeEntry,
  capability: WorktreeCapability,
  act: (worktree: IWorktreeEntry) => Promise<void>
): Promise<void> {
  const worktrees = await loadWorktrees(ctx, repo);
  if (!worktrees) {
    return;
  }
  const key = canonicalizeFsPath(clicked.path);
  const current = worktrees.find((wt) => canonicalizeFsPath(wt.path) === key);
  if (!current) {
    void vscode.window.showInformationMessage(
      `'${worktreeName(clicked)}' is no longer a worktree of this repository.`
    );
    ctx.branchTreeProvider.refresh();
    return;
  }
  const openHere = isOpenInWindow(current, windowRoots(repo));
  if (!worktreeCapabilities(current, openHere)[capability]) {
    void vscode.window.showWarningMessage(capabilityRefusal(capability, current, openHere));
    ctx.branchTreeProvider.refresh();
    return;
  }
  await act(current);
}

/** Open a worktree's folder in a new or the current window. */
export async function openWorktreeFolder(
  worktree: IWorktreeEntry,
  newWindow: boolean
): Promise<void> {
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(worktree.path), {
    forceNewWindow: newWindow,
  });
}

/** Lock a worktree, with an optional reason (`git worktree lock --reason`). */
export async function handleLockWorktree(
  ctx: IBranchWorktreeContext,
  repo: IRepository,
  worktree: IWorktreeEntry
): Promise<void> {
  const reason = await vscode.window.showInputBox({
    prompt: `Lock worktree '${worktreeName(worktree)}'. Reason (optional)`,
    placeHolder: 'e.g. on a removable drive',
  });
  if (reason === undefined) {
    return;
  }
  const trimmed = reason.trim();
  await ctx.worktrees
    .lockWorktree(repo, worktree.path, trimmed.length > 0 ? trimmed : undefined)
    .match(refreshTree(ctx), toastFailure('Failed to lock worktree'));
}

/** Unlock a worktree (`git worktree unlock`). */
export async function handleUnlockWorktree(
  ctx: IBranchWorktreeContext,
  repo: IRepository,
  worktree: IWorktreeEntry
): Promise<void> {
  await ctx.worktrees
    .unlockWorktree(repo, worktree.path)
    .match(refreshTree(ctx), toastFailure('Failed to unlock worktree'));
}

/** "Prune Worktrees…" on the Worktrees category. */
export async function handlePruneWorktrees(
  ctx: IBranchWorktreeContext,
  repo: IRepository
): Promise<void> {
  const worktrees = await loadWorktrees(ctx, repo);
  if (worktrees) {
    await prunePrunable(ctx, repo, worktrees);
  }
}

/**
 * `git worktree prune` after one confirm naming the worktrees it will drop
 * (git4idea PruneWorkingTreesAction); with none missing, say so instead.
 */
async function prunePrunable(
  ctx: IBranchWorktreeContext,
  repo: IRepository,
  worktrees: readonly IWorktreeEntry[]
): Promise<void> {
  const missing = worktrees.filter((wt) => wt.isPrunable).map(worktreeName);
  if (missing.length === 0) {
    void vscode.window.showInformationMessage('There are no missing worktrees to prune.');
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Remove Git records for missing worktrees: ${missing.join(', ')}?`,
    { modal: true },
    'Prune Worktrees'
  );
  if (confirm !== 'Prune Worktrees') {
    return;
  }
  const pruned = await ctx.worktrees
    .pruneWorktrees(repo)
    .match(refreshTree(ctx), toastFailure('Failed to prune worktrees'));
  if (pruned) {
    void vscode.window.showInformationMessage(`Pruned ${missing.join(', ')}.`);
  }
}

/** The worktrees `repo` shows, or undefined after a toast saying why not. */
function loadWorktrees(
  ctx: IBranchWorktreeContext,
  repo: IRepository
): Promise<IWorktreeEntry[] | undefined> {
  return worktreesForDisplay(ctx.worktrees, repo).match(
    (list) => list,
    (error) => {
      toastFailure('Failed to list worktrees')(error);
      return undefined;
    }
  );
}

/** A picker item for a worktree: what it has checked out, its states, and its path. */
function pickItem(worktree: IWorktreeEntry): vscode.QuickPickItem & { worktree: IWorktreeEntry } {
  const states = worktreeStates(worktree);
  return {
    label: worktreeCheckout(worktree),
    description: states.length > 0 ? `${states.join(' · ')}  ${worktree.path}` : worktree.path,
    worktree,
  };
}

/** The success arm of a worktree change: refresh the tree to show it. */
function refreshTree(ctx: IBranchWorktreeContext): () => boolean {
  return () => {
    ctx.branchTreeProvider.refresh();
    return true;
  };
}

/** The failure arm of a worktree change: a sanitized toast saying why. */
function toastFailure(title: string): (error: GitError) => boolean {
  return (error) => {
    void vscode.window.showErrorMessage(formatActionFailureToast(title, error));
    return false;
  };
}

/**
 * Confirm once, then `git worktree remove`. A worktree the list shows as
 * locked says so (with its reason) in that one confirm and is removed past
 * the lock; anything else starts unforced.
 */
export async function confirmAndRemoveWorktree(
  ctx: IBranchWorktreeContext,
  repo: IRepository,
  worktree: IWorktreeEntry
): Promise<void> {
  const lock = worktree.isLocked
    ? ` It is locked${worktree.lockReason ? ` (${worktree.lockReason})` : ''}` +
      `${await lostChanges(ctx, worktree.path)}.`
    : '';
  const confirm = await vscode.window.showWarningMessage(
    `Remove worktree '${worktree.path}'?${lock}`,
    { modal: true },
    'Remove'
  );
  if (confirm !== 'Remove') {
    return;
  }
  await removeWorktreeReporting(
    ctx,
    repo,
    worktree.path,
    worktree.isLocked ? 'overrideLock' : 'none'
  );
}

/**
 * The clause a lock-overriding confirm adds when the tree has uncommitted
 * changes: `-f -f` skips git's own check for them, so the confirm is the only
 * warning. A tree whose status cannot be read (its folder is gone) adds none.
 */
async function lostChanges(ctx: IBranchWorktreeContext, worktreePath: string): Promise<string> {
  const dirty = await ctx.worktrees.hasUncommittedChanges(worktreePath).unwrapOr(false);
  return dirty ? ' and has uncommitted changes, which will be lost' : '';
}

/**
 * Run one `git worktree remove`. When git refuses for a reason more force
 * gets past (local changes, a lock) offer one Force Remove retry at that
 * force; otherwise surface the sanitized failure.
 */
async function removeWorktreeReporting(
  ctx: IBranchWorktreeContext,
  repo: IRepository,
  worktreePath: string,
  force: WorktreeRemoveForce
): Promise<void> {
  const failure = await ctx.worktrees.removeWorktree(repo, worktreePath, force).match(
    () => undefined,
    (error) => error
  );
  if (!failure) {
    void vscode.window.showInformationMessage(`Removed worktree '${worktreePath}'.`);
    ctx.branchTreeProvider.refresh();
    return;
  }
  const needed = worktreeRemoveRefusal(failure.message);
  if (needed && needed !== force) {
    const why =
      needed === 'overrideLock'
        ? `is locked${await lostChanges(ctx, worktreePath)}`
        : 'has local modifications';
    const choice = await vscode.window.showWarningMessage(
      `Worktree '${worktreePath}' ${why}. Remove it anyway?`,
      { modal: true },
      'Force Remove'
    );
    if (choice === 'Force Remove') {
      await removeWorktreeReporting(ctx, repo, worktreePath, needed);
    }
    return;
  }
  void vscode.window.showErrorMessage(
    formatActionFailureToast('Failed to remove worktree', failure)
  );
}
