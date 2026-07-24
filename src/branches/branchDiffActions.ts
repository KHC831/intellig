/**
 * Diff action for the branch context menu: compare a branch ref against the
 * working tree, opening a diff tab per selected changed file. Reaches back
 * into the dispatcher through {@link IBranchDiffContext}.
 */

import * as vscode from 'vscode';
import type { IGitService, IRefDiffFile } from '../git-core/interfaces/IGitService';
import { sanitizeGitError } from '../git-core/gitError';
import { openRevisionDiff } from '../git-core/diff/openRevisionDiff';
import type { ITreeItemRunArgs } from '../commands/registration/commandSpine';

/** Deps the diff action reaches back into the dispatcher for. */
export interface IBranchDiffContext {
  readonly gitService: IGitService;
}

/**
 * "Compare with Working Tree" — diff the right-clicked branch ref against the
 * on-disk working tree, one diff tab per user-selected changed file.
 *
 * Flow:
 *   1. List changed files between `<branchRef>` and the working tree
 *      (`git diff --name-status -z <ref>` via `getChangedFilesAgainstWorkingTree`).
 *   2. If zero files → `showInformationMessage`, return.
 *   3. Else show a multi-select QuickPick of the changed files (with M/A/D/R/C/T/U status).
 *   4. For each selected file, open a `vscode.diff` tab:
 *        left  = `intellig-git:<filePath>?<branchRef>` (served by the git content provider)
 *        right = on-disk working-tree file
 *      title  = `<basename> (<branchRef> ↔ Working Tree)`
 *   5. User cancels the QuickPick → no-op, no toast, no error.
 */
export async function handleShowDiffWithWorkingTree(
  ctx: IBranchDiffContext,
  { repo, target }: ITreeItemRunArgs<'branch'>
): Promise<void> {
  const branchRef = target.branch.name;

  let files: IRefDiffFile[];
  try {
    // Capability is declared optional on IGitService so implementations can opt in;
    // all production impls provide it, but guard in case a mock omits it.
    if (typeof ctx.gitService.getChangedFilesAgainstWorkingTree !== 'function') {
      void vscode.window.showErrorMessage(
        'Failed to show diff: Git service does not support ref-vs-working-tree diffs'
      );
      return;
    }
    files = await ctx.gitService.getChangedFilesAgainstWorkingTree(repo, branchRef);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(
      `Failed to list changed files: ${sanitizeGitError(errorMessage)}`
    );
    return;
  }

  if (files.length === 0) {
    void vscode.window.showInformationMessage(`No changes between ${branchRef} and working tree`);
    return;
  }

  // Multi-select QuickPick: one row per changed file, prefixed with the status code.
  const items: Array<vscode.QuickPickItem & { file: IRefDiffFile }> = files.map((f) => ({
    label: `${f.status} ${f.path}`,
    description: f.oldPath ? `← ${f.oldPath}` : undefined,
    file: f,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    title: `Compare with ${branchRef}`,
    placeHolder: 'Select files to diff against the working tree (multi-select)…',
    canPickMany: true,
    matchOnDescription: true,
  });

  // User cancelled (hit Esc) → `selected` is undefined.
  // User accepted nothing → `selected` is an empty array; still a no-op.
  if (!selected || selected.length === 0) {
    return;
  }

  const rootFsPath = repo.rootUri.fsPath;
  const separator = rootFsPath.endsWith('/') || rootFsPath.endsWith('\\') ? '' : '/';

  for (const pick of selected) {
    const filePath = pick.file.path;
    const leftUri = vscode.Uri.parse(`intellig-git:${filePath}?${encodeURIComponent(branchRef)}`);
    const rightUri = vscode.Uri.file(`${rootFsPath}${separator}${filePath}`);
    const basename = filePath.substring(filePath.lastIndexOf('/') + 1);
    const title = `${basename} (${branchRef} ↔ Working Tree)`;

    await openRevisionDiff({ leftUri, rightUri, title }, `Failed to show diff for ${filePath}`);
  }
}
