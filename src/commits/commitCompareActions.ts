/**
 * Compare / view-revision actions for the commit context menu: diff a commit
 * against the working tree, compare two revisions, and open a commit's files at
 * that revision. Extracted from CommitContextMenuCommands; the class delegates
 * through a thin context so behaviour is unchanged.
 */

import * as vscode from 'vscode';
import type { IGitService, IRepository } from '../git-core/interfaces/IGitService';
import type { GitCli } from '../git-core/gitCli';
import type { IMenuStateNode } from '../git-core/gitToolWindow/multiSelect';
import { openRevisionDiff } from '../git-core/diff/openRevisionDiff';
import { sanitizeGitError } from '../git-core/gitError';
import { allHashesValid, STALE_SELECTION_TOAST } from './commitContextMenuShared';

/** Deps the compare actions reach back into the dispatcher for. */
export interface ICommitCompareActionsContext {
  readonly gitCli: GitCli;
  readonly gitService: IGitService;
  isCrossRepoSelection(commitHashes: readonly string[]): boolean;
  getRepositoryForCommit(hash?: string): Promise<IRepository | undefined>;
}

/**
 * Open a diff comparison between the selected commit and the current working tree.
 * Lists changed files and opens the diff for each.
 */
export async function compareWithLocal(
  ctx: ICommitCompareActionsContext,
  commitHashes: string[]
): Promise<void> {
  const repo = await ctx.getRepositoryForCommit(commitHashes[0]);
  if (!repo || commitHashes.length === 0) {
    return;
  }

  const hash = commitHashes[0];

  try {
    const diffs = await ctx.gitService.getCommitDiff(repo, hash);
    if (diffs.length === 0) {
      void vscode.window.showInformationMessage('No changes found in this commit.');
      return;
    }

    // Open the first file's diff as a starting point.
    // The `intellig-git:` TextDocumentContentProvider (registered in
    // extension.ts::registerGitContentProvider) reads the URI query as the
    // raw, URL-encoded git ref. Prior shape used the unregistered
    // `git-show:` scheme with a JSON query, causing VS Code to fail to
    // resolve the left-hand side of the diff (user-reported crash).
    const firstDiff = diffs[0];
    const commitUri = vscode.Uri.parse(
      `intellig-git:${firstDiff.path}?${encodeURIComponent(hash)}`
    );
    const localUri = vscode.Uri.joinPath(repo.rootUri, firstDiff.path);

    // Bare (re-throws) so the surrounding catch — which also covers
    // `getCommitDiff` above — produces the single toast.
    await openRevisionDiff({
      leftUri: commitUri,
      rightUri: localUri,
      title: `${firstDiff.path} (${hash.substring(0, 8)} ↔ Working Tree)`,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(
      `Failed to compare with local: ${sanitizeGitError(errorMessage)}`
    );
  }
}

/**
 * Compare Versions: open `vscode.diff` between the two
 * selected commits.
 *
 * Reuses the `intellig-git:` `TextDocumentContentProvider` already
 * registered for `compareWithLocal` so both diff flows share
 * one URI scheme. The provider reads the URI query as the
 * URL-encoded git ref; we hand it the OLDEST hash on the LHS and the
 * NEWEST hash on the RHS (matches IntelliJ's "Compare Versions"
 * direction — older on the left, newer on the right).
 *
 * Action visibility / enable is gated host-side by `computeMenuState`
 * (visible AND enabled iff N=2). This handler only runs when the
 * gating allows it; defensive `length !== 2` no-op so a stale
 * dispatch can't crash.
 */
export async function compareVersions(
  ctx: ICommitCompareActionsContext,
  commitHashes: string[],
  commitNodes: readonly IMenuStateNode[] = []
): Promise<void> {
  if (commitHashes.length !== 2) {
    // Should never happen — the menu gating ensures N=2 — but stay
    // quiet rather than throw on a stale dispatch.
    return;
  }
  // defence-in-depth hash regex (cap raised to 64
  // for SHA-256 support).
  if (!allHashesValid(commitHashes)) {
    return;
  }
  if (ctx.isCrossRepoSelection(commitHashes)) {
    return;
  }
  const repo = await ctx.getRepositoryForCommit(commitHashes[0]);
  if (!repo) {
    return;
  }

  // Derive displayOrder from the typed nodes.
  const displayOrder = commitNodes.map((n) => n.hash);

  // Symmetry with `createPatchMulti`: every
  // commitHash must be in commitNodes. Without this guard a hex-format
  // hash that isn't in the rendered log slips past the regex check
  // and `git diff <bad>..<good>` produces a noisy "fatal: bad
  // revision" toast instead of the cleaner stale-selection phrasing.
  const inOrder = new Set(displayOrder);
  const stale = commitHashes.filter((h) => !inOrder.has(h));
  if (stale.length > 0) {
    void vscode.window.showInformationMessage(STALE_SELECTION_TOAST);
    return;
  }

  // The webview hands hashes in newest-first display order. See
  // ADR-009 section 5 (selection mutations come in two flavours) and the
  // WARNING on `getSelectedCommits()` for the contract:
  // newest-first is the canonical projection from the rendered log.
  // Project against the dispatched
  // commitNodes instead of `getExtendedLogState()` so the handler
  // stays decoupled from provider state.
  //
  // The dispatcher already aborts
  // upstream when a hash isn't in the rendered commitNodes, AND the
  // in-order guard immediately above also catches it; the swap-
  // fallback that lived here earlier is dead. Webview-driven dispatches
  // see the dispatcher guard plus the in-order check; an external caller passing
  // default `commitNodes = []` will see EVERY hash as stale and get
  // the stale-selection toast — they must supply a non-empty
  // `commitNodes: readonly IMenuStateNode[]` covering both targeted
  // hashes. The canonical projection lives in
  // `GitToolWindowProvider._handleCommitContextMenu`, which maps
  // `getExtendedLogState().commitNodes` to
  // `{hash, parentCount: parents.length}` per node; programmatic
  // callers should mirror that projection (or call into the same
  // routing path). The idx0 / idx1 projection here only runs after
  // both guards, so both indices are guaranteed found.
  const idx0 = displayOrder.indexOf(commitHashes[0]);
  const idx1 = displayOrder.indexOf(commitHashes[1]);
  // Larger display index = older commit.
  const oldHash = idx0 > idx1 ? commitHashes[0] : commitHashes[1];
  const newHash = idx0 > idx1 ? commitHashes[1] : commitHashes[0];

  // `git diff --name-only oldHash..newHash`
  // gives ONLY the changes from oldHash to newHash, the right
  // semantic for "compare these two commits". The earlier path used
  // `getMultiCommitDiff` which returns CUMULATIVE changes across all
  // listed commits — wrong for non-adjacent endpoints where the user
  // explicitly skipped the intermediates.
  const result = await ctx.gitCli.exec(['diff', '--name-only', '-z', `${oldHash}..${newHash}`], {
    cwd: repo.rootUri.fsPath,
    throwOnError: false,
  });

  // Propagate failure as a sanitised toast instead
  // of silently returning undefined.
  if (result.exitCode !== 0) {
    const stderr = (result.stderr || result.stdout || 'git diff failed').trim();
    void vscode.window.showErrorMessage(`Failed to compare versions: ${sanitizeGitError(stderr)}`);
    return;
  }

  // NUL-delimited: a path carrying whitespace or non-ASCII bytes arrives
  // verbatim rather than C-quoted, so it is never trimmed or unescaped here.
  const firstFile = result.stdout.split('\0').filter((s) => s.length > 0)[0];
  if (!firstFile) {
    void vscode.window.showInformationMessage(
      `No file changes between ${oldHash.substring(0, 8)} and ${newHash.substring(0, 8)}.`
    );
    return;
  }
  const lhs = vscode.Uri.parse(`intellig-git:${firstFile}?${encodeURIComponent(oldHash)}`);
  const rhs = vscode.Uri.parse(`intellig-git:${firstFile}?${encodeURIComponent(newHash)}`);
  await openRevisionDiff(
    {
      leftUri: lhs,
      rightUri: rhs,
      title: `${firstFile} (${oldHash.substring(0, 8)} ↔ ${newHash.substring(0, 8)})`,
    },
    'Failed to compare versions'
  );
}

/**
 * Show the repository file tree at the selected commit revision.
 * Opens the commit's changed files list so the user can browse the state at that point.
 */
export async function showRepoAtRevision(
  ctx: ICommitCompareActionsContext,
  commitHashes: string[]
): Promise<void> {
  const repo = await ctx.getRepositoryForCommit(commitHashes[0]);
  if (!repo || commitHashes.length === 0) {
    return;
  }

  const hash = commitHashes[0];

  try {
    const result = await ctx.gitCli.exec(['ls-tree', '--name-only', '-r', '-z', hash], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });

    // NUL-delimited, so a path carrying whitespace or non-ASCII bytes reaches
    // the pick as its real name instead of git's C-quoted spelling.
    const files = result.stdout.split('\0').filter((f) => f.length > 0);
    if (files.length === 0) {
      void vscode.window.showInformationMessage('No files found at this revision.');
      return;
    }

    const selected = await vscode.window.showQuickPick(
      files.map((f) => ({ label: f, description: hash.substring(0, 8) })),
      {
        title: `Repository at ${hash.substring(0, 8)}`,
        placeHolder: 'Select a file to view',
        matchOnDescription: true,
      }
    );

    if (selected) {
      // See `compareWithLocal` above for why this uses the
      // `intellig-git:` scheme with a URL-encoded ref in the query.
      const fileUri = vscode.Uri.parse(
        `intellig-git:${selected.label}?${encodeURIComponent(hash)}`
      );
      await vscode.commands.executeCommand('vscode.open', fileUri);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(
      `Failed to show repository at revision: ${sanitizeGitError(errorMessage)}`
    );
  }
}
