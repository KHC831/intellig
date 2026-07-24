/**
 * Worktree actions for the branch context menu: create a linked worktree,
 * open an existing one, and remove/prune worktrees. Each action reaches back
 * into the dispatcher through {@link IBranchWorktreeContext}.
 */

import * as vscode from 'vscode';
import type { IGitService, IRepository } from '../git-core/interfaces/IGitService';
import type { BranchTreeItem, BranchTreeProvider } from './BranchTreeProvider';
import { formatActionFailureToast } from '../git-core/gitError';
import type { IWorktreeCapableService, IWorktreeEntry } from '../git-core/ops/WorktreeOps';

/** Deps the worktree actions reach back into the dispatcher for. */
export interface IBranchWorktreeContext {
  readonly gitService: IGitService;
  readonly branchTreeProvider: BranchTreeProvider;
  getRepository(): IRepository | undefined;
  resolveRepository(item?: BranchTreeItem): IRepository | undefined;
}

/**
 * View the GitService through its worktree capability. The frozen
 * {@link IGitService} composite (ADR-001) does not declare the post-freeze
 * worktree methods; the concrete `GitService` implements them, so consumers
 * widen through the {@link IWorktreeCapableService} role interface.
 */
function worktreeService(ctx: IBranchWorktreeContext): IWorktreeCapableService {
  return ctx.gitService as unknown as IWorktreeCapableService;
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

  const created = await worktreeService(ctx)
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
 * "Open Worktree…" — list the repo's worktrees
 * (`git worktree list --porcelain`), let the user pick one, and open it as a
 * VS Code folder. The current/main worktree and any path equal to the active
 * repo root are still listed (you may want to reopen the main checkout in a
 * fresh window).
 */
export async function handleOpenWorktree(ctx: IBranchWorktreeContext): Promise<void> {
  const repo = ctx.getRepository();
  if (!repo) {
    return;
  }

  const worktrees = await worktreeService(ctx)
    .listWorktrees(repo)
    .match(
      (list) => list,
      (error) => {
        void vscode.window.showErrorMessage(
          formatActionFailureToast('Failed to list worktrees', error)
        );
        return undefined;
      }
    );
  if (!worktrees) {
    return;
  }
  if (worktrees.length === 0) {
    void vscode.window.showInformationMessage('No worktrees found for this repository.');
    return;
  }

  const items = worktrees.map((wt) => ({
    label: worktreeLabel(wt),
    description: wt.path,
    worktree: wt,
  }));
  const picked = await vscode.window.showQuickPick(items, {
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
  if (!newWindow) {
    return;
  }

  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(picked.worktree.path), {
    forceNewWindow: newWindow.forceNewWindow,
  });
}

/**
 * "Remove Worktree…" — pick a linked worktree (never the main worktree or
 * the checkout this window has open), confirm once, and `git worktree
 * remove` it. Git's dirty/locked refusal is surfaced with a Force Remove
 * retry. The same picker carries a prune item (`git worktree prune`) so
 * stale records of manually-deleted worktrees are cleanable from one
 * front door.
 */
export async function handleRemoveWorktree(ctx: IBranchWorktreeContext): Promise<void> {
  const repo = ctx.getRepository();
  if (!repo) {
    return;
  }

  const worktrees = await worktreeService(ctx)
    .listWorktrees(repo)
    .match(
      (list) => list,
      (error) => {
        void vscode.window.showErrorMessage(
          formatActionFailureToast('Failed to list worktrees', error)
        );
        return undefined;
      }
    );
  if (!worktrees) {
    return;
  }

  const repoRoot = repo.rootUri.fsPath;
  const removable = worktrees.filter((wt) => !wt.isMain && wt.path !== repoRoot);

  type RemoveItem = vscode.QuickPickItem & { worktree?: IWorktreeEntry; prune?: boolean };
  const items: RemoveItem[] = removable.map((wt) => ({
    label: worktreeLabel(wt),
    description: wt.path,
    worktree: wt,
  }));
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: '$(trash) Prune stale worktree records', prune: true });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder:
      removable.length === 0
        ? 'No linked worktrees to remove — prune cleans records of deleted ones'
        : 'Select a worktree to remove',
  });
  if (!picked) {
    return;
  }

  if (picked.prune) {
    const pruned = await worktreeService(ctx)
      .pruneWorktrees(repo)
      .match(
        () => true,
        (error) => {
          void vscode.window.showErrorMessage(
            formatActionFailureToast('Failed to prune worktrees', error)
          );
          return false;
        }
      );
    if (pruned) {
      void vscode.window.showInformationMessage('Pruned stale worktree records.');
      ctx.branchTreeProvider.refresh();
    }
    return;
  }

  const worktree = picked.worktree;
  if (!worktree) {
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Remove worktree '${worktree.path}'?`,
    { modal: true },
    'Remove'
  );
  if (confirm !== 'Remove') {
    return;
  }
  await removeWorktreeReporting(ctx, repo, worktree.path, false);
}

/**
 * Run one `git worktree remove`; on git's use-`--force` refusal (dirty or
 * locked tree) offer a single Force Remove retry, otherwise surface the
 * sanitized failure.
 */
async function removeWorktreeReporting(
  ctx: IBranchWorktreeContext,
  repo: IRepository,
  worktreePath: string,
  force: boolean
): Promise<void> {
  const failure = await worktreeService(ctx)
    .removeWorktree(repo, worktreePath, force ? true : undefined)
    .match(
      () => undefined,
      (error) => error
    );
  if (!failure) {
    void vscode.window.showInformationMessage(`Removed worktree '${worktreePath}'.`);
    ctx.branchTreeProvider.refresh();
    return;
  }
  if (!force && /--force/.test(failure.message)) {
    const choice = await vscode.window.showWarningMessage(
      `Worktree '${worktreePath}' has local modifications or is locked. Remove it anyway?`,
      { modal: true },
      'Force Remove'
    );
    if (choice === 'Force Remove') {
      await removeWorktreeReporting(ctx, repo, worktreePath, true);
    }
    return;
  }
  void vscode.window.showErrorMessage(
    formatActionFailureToast('Failed to remove worktree', failure)
  );
}

/**
 * Human-readable label for a worktree pick: the short branch name (stripping
 * the `refs/heads/` prefix git's porcelain emits), `(detached)` /
 * `(bare)` for those states, plus a `(locked)` / `(main)` suffix.
 */
function worktreeLabel(wt: IWorktreeEntry): string {
  let base: string;
  if (wt.isBare) {
    base = '(bare)';
  } else if (wt.isDetached) {
    base = '(detached)';
  } else if (wt.branch) {
    base = wt.branch.replace(/^refs\/heads\//, '');
  } else {
    base = '(unknown)';
  }
  const tags: string[] = [];
  if (wt.isMain) {
    tags.push('main');
  }
  if (wt.isLocked) {
    tags.push('locked');
  }
  return tags.length > 0 ? `${base} (${tags.join(', ')})` : base;
}
