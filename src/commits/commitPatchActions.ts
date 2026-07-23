/**
 * Create Patch actions for the commit context menu: single/multi-commit
 * `git format-patch` to a file or directory, and the silent clipboard variant.
 * Extracted from CommitContextMenuCommands; the class delegates through a thin
 * context so behaviour is unchanged.
 */

import * as vscode from 'vscode';
import type { IRepository } from '../git-core/interfaces/IGitService';
import type { GitCli } from '../git-core/gitCli';
import { patchSaveDefaultUri, rememberPatchDir } from '../patches/createPatchFlow';
import { atomicWriteFile } from '../utils/atomicWrite';
import { sanitizeGitError } from '../git-core/gitError';
import { isSelectionContiguous, type IMenuStateNode } from '../git-core/gitToolWindow/multiSelect';
import { allHashesValid, STALE_SELECTION_TOAST } from './commitContextMenuShared';

/** Deps the patch actions reach back into the dispatcher for. */
export interface ICommitPatchActionsContext {
  readonly gitCli: GitCli;
  readonly context: vscode.ExtensionContext | undefined;
  isCrossRepoSelection(commitHashes: readonly string[]): boolean;
  getRepositoryForCommit(hash?: string): Promise<IRepository | undefined>;
}

/**
 * Generate patch file(s) from the selected commit(s).
 *
 * Single-commit (N=1): legacy flow — `git format-patch -1 <hash>
 * --stdout` to a temp buffer, then `vscode.window.showSaveDialog` for
 * the destination, then `atomicWriteFile`.
 *
 * Multi-commit (N>=2) flow.
 *   - User picks a directory (`vscode.window.showOpenDialog` with
 *     `canSelectFolders=true`).
 *   - We classify the selection: "contiguous" iff the commits land on
 *     consecutive display indices in `commitNodes`. The display order
 *     is newest-first, so contiguous means there are no gaps in the
 *     index range from min to max selected.
 *   - Contiguous: `git format-patch <oldest>^..<newest> -o <dir>`. git
 *     emits one numbered `.patch` per commit in topological order.
 *   - Non-contiguous: `git format-patch -o <dir> <oldest> ... <newest>`
 *     (each hash is a separate `-1` style invocation under the hood;
 *     git produces N numbered patches, one per supplied commit).
 *   - In both modes git writes the files itself, so the host doesn't
 *     do per-file I/O — a partial mid-write failure leaves the dir
 *     state coherent (failed patches just aren't there).
 */
export async function createPatch(
  ctx: ICommitPatchActionsContext,
  commitHashes: string[],
  commitNodes: readonly IMenuStateNode[] = []
): Promise<void> {
  if (ctx.isCrossRepoSelection(commitHashes)) {
    return;
  }
  const repo = await ctx.getRepositoryForCommit(commitHashes[0]);
  if (!repo || commitHashes.length === 0) {
    return;
  }
  // defence-in-depth hash regex.
  if (!allHashesValid(commitHashes)) {
    return;
  }

  if (commitHashes.length >= 2) {
    await createPatchMulti(ctx, repo, commitHashes, commitNodes);
    return;
  }

  const hash = commitHashes[0];

  let stdout: string;
  try {
    const result = await ctx.gitCli.exec(['format-patch', '-1', hash, '--stdout'], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    // Fail closed on a capped stream: the captured stdout is a prefix of the
    // real patch, so writing it would produce a corrupt `.patch`.
    if (result.truncated) {
      void vscode.window.showErrorMessage(
        'Failed to create patch: diff exceeds the capture limit; patch not written'
      );
      return;
    }
    stdout = result.stdout;
  } catch (error) {
    // git exec failure — keep the historical "Failed to create patch"
    // phrasing so existing tests + docs still match.
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(
      `Failed to create patch: ${sanitizeGitError(errorMessage)}`
    );
    return;
  }

  const saveUri = await vscode.window.showSaveDialog({
    defaultUri: patchSaveDefaultUri(
      ctx.context?.workspaceState,
      repo.rootUri,
      `${hash.substring(0, 8)}.patch`
    ),
    filters: { 'Patch Files': ['patch'], 'All Files': ['*'] },
  });

  if (!saveUri) {
    return;
  }
  await rememberPatchDir(ctx.context?.workspaceState, saveUri);

  // Route the user-picked save through atomicWriteFile so a partial
  // write (EBUSY on a Windows-locked file, ENOSPC on a full disk,
  // process kill mid-flight) never leaves a truncated `.patch`
  // file — `git apply`/`git am` would silently fail downstream on junk.
  // Write error is caught separately from the git exec error above so
  // a write-only failure can't be masked by a git-exec error path in
  // future refactors.
  try {
    await atomicWriteFile(saveUri.fsPath, stdout);
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Failed to write patch: ${sanitizeGitError(raw)}`);
    return;
  }
  // Clickable "Open Folder" affordance (IntelliJ parity).
  void toastPatchSavedSingle(saveUri.fsPath);
}

/**
 * Derive the commit spec a multi-commit `format-patch` run consumes:
 * the range form `<oldest>^..<newest>` for a contiguous selection whose
 * oldest commit has a parent (git emits one patch per commit in the range,
 * numbered topologically), or the positional oldest-first hash list
 * otherwise (`<oldest>^..` cannot resolve when oldest is the initial
 * commit; a non-contiguous selection has no range at all). Returns
 * undefined — after the stale-selection toast — when any hash is missing
 * from the dispatched display order.
 */
function deriveFormatPatchCommitSpec(
  commitHashes: readonly string[],
  commitNodes: readonly IMenuStateNode[]
): string[] | undefined {
  const displayOrder = commitNodes.map((n) => n.hash);

  // Every commitHash MUST be in displayOrder. The host already validates
  // against commitNodes; this is the belt-and-suspenders mirror at the
  // handler boundary.
  const inOrder = new Set(displayOrder);
  const stale = commitHashes.filter((h) => !inOrder.has(h));
  if (stale.length > 0) {
    void vscode.window.showInformationMessage(STALE_SELECTION_TOAST);
    return undefined;
  }

  // Project to display indices for contiguity + range-form bounds.
  const indexByHash = new Map<string, number>();
  for (let i = 0; i < displayOrder.length; i++) {
    indexByHash.set(displayOrder[i], i);
  }
  const indices = commitHashes
    .map((h) => indexByHash.get(h))
    .filter((i): i is number => i !== undefined)
    .slice()
    .sort((a, b) => a - b);
  // Display order (newest-first): smallest index = newest commit.
  const newestHash = displayOrder[indices[0]];
  const oldestHash = displayOrder[indices[indices.length - 1]];

  const isContiguous = isSelectionContiguous(new Set(commitHashes), displayOrder);
  const oldestParents = commitNodes.find((n) => n.hash === oldestHash)?.parentCount ?? 1;
  if (isContiguous && oldestParents > 0) {
    return [`${oldestHash}^..${newestHash}`];
  }
  // Sort descending by display index → oldest-first replay order
  // (newest-first display means larger index = older).
  return [...commitHashes]
    .filter((h) => indexByHash.has(h))
    .sort((a, b) => (indexByHash.get(b) ?? 0) - (indexByHash.get(a) ?? 0));
}

/**
 * Silent clipboard variant of Create Patch — IntelliJ
 * CreatePatchFromChangesAction.Clipboard parity. Streams the combined
 * `format-patch --stdout` mailbox (one commit or the multi-commit
 * range/positional spec) straight to the clipboard; no dialogs.
 */
export async function createPatchToClipboard(
  ctx: ICommitPatchActionsContext,
  commitHashes: string[],
  commitNodes: readonly IMenuStateNode[] = []
): Promise<void> {
  if (ctx.isCrossRepoSelection(commitHashes)) {
    return;
  }
  const repo = await ctx.getRepositoryForCommit(commitHashes[0]);
  if (!repo || commitHashes.length === 0) {
    return;
  }
  // defence-in-depth hash regex.
  if (!allHashesValid(commitHashes)) {
    return;
  }

  let spec: string[];
  if (commitHashes.length >= 2) {
    const derived = deriveFormatPatchCommitSpec(commitHashes, commitNodes);
    if (!derived) {
      return;
    }
    spec = derived;
  } else {
    spec = ['-1', commitHashes[0]];
  }

  try {
    const result = await ctx.gitCli.exec(['format-patch', '--stdout', ...spec], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    // Fail closed on a capped stream: the captured stdout is a prefix of
    // the real mailbox, so copying it would hand the user a corrupt patch.
    if (result.truncated) {
      void vscode.window.showErrorMessage(
        'Failed to create patch: diff exceeds the capture limit; patch not copied'
      );
      return;
    }
    await vscode.env.clipboard.writeText(result.stdout);
    const n = commitHashes.length;
    void vscode.window.showInformationMessage(
      n === 1 ? 'Patch copied to clipboard.' : `Patch for ${n} commits copied to clipboard.`
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(
      `Failed to create patch: ${sanitizeGitError(errorMessage)}`
    );
  }
}

/**
 * Multi-commit `format-patch` driver. See
 * {@link createPatch} for the contract.
 *
 * Consumes the typed `commitNodes` payload (newest-
 * first `IMenuStateNode[]`) and derives `displayOrder` + parent
 * lookups from it, replacing the prior parallel records.
 *
 * See ADR-009 section 6 for the display-order vs replay-
 * order contract; `getSelectedCommitsOldestFirst()` is the
 * programmatic-caller equivalent of the dispatch payload.
 *
 * Fixes (preserved):
 *   - Every commitHash MUST resolve in displayOrder; abort
 *     with the toast otherwise (no silent drop).
 *   - When oldest is the initial commit (parents=0),
 *     `<oldest>^..` doesn't resolve. Switch to positional fallback.
 *   - Contiguity check delegates to `isSelectionContiguous`
 *     from `multiSelect.ts` (no inline `indices.every` reimpl).
 *   - Takes `commitNodes` directly via the dispatch event,
 *     no `getExtendedLogState()` call.
 *   - Success toast offers "Open Folder" via
 *     `revealFileInOS`.
 */
async function createPatchMulti(
  ctx: ICommitPatchActionsContext,
  repo: IRepository,
  commitHashes: readonly string[],
  commitNodes: readonly IMenuStateNode[]
): Promise<void> {
  const spec = deriveFormatPatchCommitSpec(commitHashes, commitNodes);
  if (!spec) {
    return;
  }

  // Ask the user once for the destination directory.
  const dirChoice = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Save Patches Here',
    title: `Choose a folder for ${commitHashes.length} patch files`,
  });
  if (!dirChoice || dirChoice.length === 0) {
    // Quiet abort — the user cancelled.
    return;
  }
  const outDir = dirChoice[0].fsPath;

  // Build the format-patch argv. Output flag first so range / positional
  // code paths share the same prefix.
  const argv = ['format-patch', '-o', outDir, ...spec];

  try {
    const result = await ctx.gitCli.exec(argv, {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    // Here git writes each `.patch` to outDir directly; stdout is only the
    // manifest of written paths. A capped stdout can't corrupt the on-disk
    // patches, but it does mean the manifest (and any count derived from it)
    // is incomplete — so surface that instead of a confident "wrote N".
    if (result.truncated) {
      void vscode.window.showWarningMessage(
        `Patches written to ${outDir}, but the output list exceeded the capture limit — ` +
          `verify all ${commitHashes.length} patch files are present.`
      );
      return;
    }
    // git format-patch prints the path of each emitted file on stdout,
    // one per line. Count non-empty lines to surface "wrote N patches".
    const written = result.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0).length;
    void toastPatchSavedMulti(outDir, written || commitHashes.length);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(
      `Failed to create patches: ${sanitizeGitError(errorMessage)}`
    );
  }
}

/**
 * Show the success toast with a clickable "Open
 * Folder" action that reveals the patch file in the host OS file
 * manager (Finder / Explorer / xdg-open). IntelliJ parity.
 */
async function toastPatchSavedSingle(filePath: string): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    `Patch saved to ${filePath}`,
    'Open Folder'
  );
  if (choice === 'Open Folder') {
    void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(filePath));
  }
}

/**
 * multi-commit success toast variant.
 */
async function toastPatchSavedMulti(outDir: string, count: number): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    `Wrote ${count} patch file(s) to ${outDir}`,
    'Open Folder'
  );
  if (choice === 'Open Folder') {
    void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outDir));
  }
}
