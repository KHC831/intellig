/**
 * Branch-creation actions for the branch context menu: the popup-header "New
 * Branch" (start from HEAD) and "New Branch from here" (start from the clicked
 * branch, tag, or detached SHA). Both prefer the New Branch Dialog and fall
 * back to a prompt when no opener is wired. Reaches back into the dispatcher
 * through {@link IBranchCreateContext}.
 */

import * as vscode from 'vscode';
import type { IGitService, IRepository } from '../git-core/interfaces/IGitService';
import type { BranchTreeProvider } from './BranchTreeProvider';
import type { NewBranchDialogOpener } from './BranchContextMenuCommands';
import { sanitizeGitError } from '../git-core/gitError';
import type { RefTarget } from '../commands/registration/commandSpine';

/** Deps the create actions reach back into the dispatcher for. */
export interface IBranchCreateContext {
  readonly gitService: IGitService;
  readonly branchTreeProvider: BranchTreeProvider;
  readonly newBranchDialogOpener: NewBranchDialogOpener | undefined;
  getRepository(): IRepository | undefined;
}

/**
 * Handle the popup-header "New Branch" action — create a new branch starting
 * from the current HEAD (git4idea `Git.CreateNewBranch`). Routes through the
 * New Branch Dialog when wired; the dialog defaults its start point to HEAD
 * when none is supplied.
 */
export function handleNewBranch(ctx: IBranchCreateContext): void {
  const repo = ctx.getRepository();
  if (!repo) {
    void vscode.window.showErrorMessage('No Git repository found');
    return;
  }

  const startPoint = repo.head?.name?.replace('refs/heads/', '') || undefined;

  if (ctx.newBranchDialogOpener) {
    ctx.newBranchDialogOpener({ repo, startPoint });
    return;
  }

  void vscode.window.showErrorMessage('New Branch dialog is not available.');
}

/**
 * Handle new branch from here command.
 */
export async function handleNewBranchFrom(
  ctx: IBranchCreateContext,
  {
    repo,
    target,
  }: {
    repo: IRepository;
    target: RefTarget;
  }
): Promise<void> {
  // The start point is whatever was clicked: a branch name, a tag name,
  // or the detached row's 40-char SHA (never the parenthesized label).
  const startPoint =
    target.kind === 'branch'
      ? target.branch.name
      : target.kind === 'tag'
        ? target.tag.name
        : target.sha;
  if (!startPoint) {
    return;
  }

  // Route through the New Branch Dialog when the opener is wired.
  // Dialog handles name validation, tracking, overwrite, and checkout in a
  // single webview with typed options. Falls back to the old showInputBox
  // path when the opener is absent (test fixtures).
  if (ctx.newBranchDialogOpener) {
    ctx.newBranchDialogOpener({ repo, startPoint });
    return;
  }

  const branchName = await vscode.window.showInputBox({
    prompt: `Enter new branch name (from ${startPoint})`,
    placeHolder: 'feature/my-new-branch',
    validateInput: (value) => {
      if (!value || !value.trim()) {
        return 'Branch name cannot be empty';
      }
      // Reject leading `-` (git interprets as a CLI flag)
      // and leading `.` (git rejects refs starting with `.` per
      // git-check-ref-format) at the validator level. The
      // regex `^[\w\-./]+$` accepted `-foo` and `.hidden` because the
      // character class allowed `-` and `.` anywhere including the
      // first position; the service-boundary guard in
      // `GitService.createBranch` was the only line of defense.
      if (!/^(?![-.])[\w\-./]+$/.test(value)) {
        return 'Branch name contains invalid characters';
      }
      return undefined;
    },
  });

  if (!branchName) {
    return;
  }

  try {
    await ctx.gitService.createBranch(repo, branchName, startPoint).match(
      () => undefined,
      (e) => {
        throw e;
      }
    );
    await ctx.gitService.checkout(repo, branchName).match(
      () => undefined,
      (e) => {
        throw e;
      }
    );
    // createBranch + checkout pair moved HEAD; reload before refresh.
    await ctx.gitService.reloadRepository(repo);
    void vscode.window.showInformationMessage(
      `Created and switched to branch '${branchName}' from '${startPoint}'`
    );
    ctx.branchTreeProvider.refresh();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(
      `Failed to create branch: ${sanitizeGitError(errorMessage)}`
    );
  }
}
