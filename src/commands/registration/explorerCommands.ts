import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger, registerLoggedCommand } from '../../utils/logger';
import { resolveRepo } from '../../utils/resolveRepo';
import { sanitizeGitError, formatActionFailureToast } from '../../git-core/gitError';
import { openRevisionDiff } from '../../git-core/diff/openRevisionDiff';
import { PatchWriteFailed } from '../../services';
import { canonicalizeFsPath, repoRelativePath } from '../../utils/repoRelativePath';
import { statusCodeToFileStatus } from '../../git-core/gitParser';
import type { FileStatus, IFileStatus } from '../../git-core/interfaces/IGitService';
import { presentFileHistory } from './commitHelpers';
import type { ICommandContext } from './CommandContext';

// Re-exported so the established `from '.../explorerCommands'` import path used
// by `explorerRepoRelativePath.test.ts` keeps working after the helpers moved
// to the shared `utils/repoRelativePath` module (RULE E2 re-export clause).
export { repoRelativePath, toRepoRelativePosix } from '../../utils/repoRelativePath';

/**
 * Resolve the file URI for an explorer-context command. Prefers the
 * explicitly-passed `fileUri`; falls back to the active editor's document
 * URI only when it is a `file:`-scheme document.
 *
 * Relocated verbatim from extension.ts (a by-name test seam) and re-exported
 * from extension.ts so the `from '../../../extension'` import path used by
 * `explorerEditorMenu.test.ts` is preserved (RULE E2 re-export clause). The
 * helper file never imports extension.ts, so there is no import cycle.
 */
export function resolveExplorerFileUri(
  fileUri: vscode.Uri | undefined,
  activeEditorUri: vscode.Uri | undefined
): vscode.Uri | undefined {
  if (fileUri) {
    return fileUri;
  }
  if (activeEditorUri && activeEditorUri.scheme === 'file') {
    return activeEditorUri;
  }
  return undefined;
}

/**
 * Resolve the full target set for an explorer-context command. VS Code
 * invokes explorer/context commands as `(clickedUri, selectedUris[])`; the
 * mutating commands must act on the WHOLE selection — operating on just the
 * right-clicked file while toasting success silently drops the rest of the
 * user's selection. Falls back to the clicked uri, then the active editor
 * (palette invocations).
 */
export function resolveExplorerSelection(
  fileUri: vscode.Uri | undefined,
  selectedUris: unknown,
  activeEditorUri: vscode.Uri | undefined
): vscode.Uri[] {
  if (Array.isArray(selectedUris)) {
    const uris = selectedUris.filter(
      (u): u is vscode.Uri =>
        !!u && typeof u === 'object' && typeof (u as { fsPath?: unknown }).fsPath === 'string'
    );
    if (uris.length > 0) {
      return uris;
    }
  }
  const single = resolveExplorerFileUri(fileUri, activeEditorUri);
  return single ? [single] : [];
}

/**
 * Build an `intellig-git:` URI whose left pane the content provider resolves
 * via `git show <ref>:<filePath>`.
 *
 * When the producer knows the repository root it passes `repoRootFsPath`,
 * encoded alongside the ref as `?ref=<ref>&repoRoot=<root>` (URLSearchParams).
 * The provider needs that root because `filePath` here is repo-ROOT-relative:
 * in a nested repo / submodule or a multi-root workspace the workspace folder
 * is an ANCESTOR of the repo, so the provider's folder fallback would resolve
 * the wrong root and the diff's left pane would fail to load. Without a
 * `repoRootFsPath` the legacy single-query-is-the-ref form is emitted, kept
 * for back-compat with the many existing producers.
 */
export function buildIntelligGitUri(
  filePath: string,
  ref: string,
  repoRootFsPath?: string
): vscode.Uri {
  const query = repoRootFsPath
    ? new URLSearchParams({ ref, repoRoot: repoRootFsPath }).toString()
    : encodeURIComponent(ref);
  return vscode.Uri.parse(`intellig-git:${filePath}?${query}`);
}

/**
 * Build the left-hand `intellig-git:` URI used by
 * `intellig.explorer.compareWithRepoVersion`. Delegates to
 * {@link buildIntelligGitUri}; when `repoRootFsPath` is supplied the provider
 * can resolve the exact repo even for a nested/multi-root layout.
 *
 * Relocated verbatim from extension.ts; re-exported there for unit tests.
 */
export function buildCompareWithRepoVersionLeftUri(
  filePath: string,
  ref: string = 'HEAD',
  repoRootFsPath?: string
): vscode.Uri {
  return buildIntelligGitUri(filePath, ref, repoRootFsPath);
}

/**
 * Build the diff-tab title used by
 * `intellig.explorer.compareWithRepoVersion`. Mirrors the `<basename> (ref ↔ Working Tree)`
 * convention used by `showDiffWithWorkingTree` for consistency.
 *
 * Relocated verbatim from extension.ts; re-exported there for unit tests.
 */
export function buildCompareWithRepoVersionTitle(filePath: string, ref: string = 'HEAD'): string {
  const basename = filePath.substring(filePath.lastIndexOf('/') + 1);
  return `${basename} (${ref} ↔ Working Tree)`;
}

/**
 * Compute the `.gitignore` pattern for a file — its repo-root-relative,
 * POSIX-separated path with a leading `/` so it anchors to that exact file
 * (matching IntelliJ's GitIgnoreFileActionGroup, which writes the
 * root-relative path). Returns `undefined` when `fileFsPath` is not inside
 * `repoRoot`, so the caller never writes a bogus `../` pattern.
 *
 * Pure (no fs); both args are absolute filesystem paths. Accepts Windows
 * back-slash separators and normalizes them to `/`.
 */
export function gitignorePatternFor(repoRoot: string, fileFsPath: string): string | undefined {
  const root = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const file = fileFsPath.replace(/\\/g, '/');
  const prefix = `${root}/`;
  if (!file.startsWith(prefix)) {
    return undefined;
  }
  const rel = file.slice(prefix.length);
  return `/${rel}`;
}

/**
 * Build the new `.gitignore` contents after appending `pattern`.
 *
 * Idempotent: if `pattern` already appears as a non-comment line (ignoring
 * surrounding whitespace), the existing content is returned unchanged so
 * repeated "Add to .gitignore" never duplicates a rule. Otherwise the pattern
 * is appended on its own line, with a separating newline inserted when the
 * file didn't already end in one. The result is always newline-terminated.
 *
 * Pure (no fs).
 */
export function buildGitignoreAppendContent(existing: string, pattern: string): string {
  const alreadyPresent = existing
    .split('\n')
    .some((line) => line.trim() === pattern && !line.trim().startsWith('#'));
  if (alreadyPresent) {
    return existing;
  }
  const needsSeparator = existing.length > 0 && !existing.endsWith('\n');
  return `${existing}${needsSeparator ? '\n' : ''}${pattern}\n`;
}

/**
 * Toast for "Add to .gitignore", honest about tracked files: appending a
 * pattern does NOT stop Git from tracking an already-tracked file, so a
 * plain success toast would over-claim. `fileStatus` is the file's porcelain
 * status ('untracked' when Git ignores→untracked it; undefined when the file
 * is absent from status — clean-tracked or already ignored).
 */
export function gitignoreAppendToast(
  pattern: string,
  fileStatus: FileStatus | undefined
): { message: string; severity: 'info' | 'warning' } {
  if (fileStatus === 'untracked' || fileStatus === 'ignored') {
    return { message: `Added to .gitignore: ${pattern}`, severity: 'info' };
  }
  const qualifier =
    fileStatus === undefined
      ? 'If the file is tracked, Git will keep tracking it'
      : 'The file is tracked, so Git will keep tracking it';
  return {
    message: `Added to .gitignore: ${pattern} — ${qualifier} until it is untracked (git rm --cached).`,
    severity: 'warning',
  };
}

/**
 * Pre-check for Revert File: returns the info message to show INSTEAD of the
 * confirm dialog when there is nothing to revert (an untracked file, or a
 * file absent from status), or `undefined` when the revert should proceed.
 * Without this the flow confirmed "cannot be undone", did nothing, and
 * toasted "Reverted".
 */
export function revertPrecheck(
  fileStatus: FileStatus | undefined,
  filePath: string
): string | undefined {
  if (fileStatus === 'untracked') {
    return `'${filePath}' is not tracked by Git — nothing to revert.`;
  }
  if (fileStatus === undefined || fileStatus === 'ignored') {
    return `No local changes to revert for '${filePath}'.`;
  }
  return undefined;
}

/**
 * Look up a file's porcelain status by repo-relative path. Undefined when the
 * file is absent from status (clean-tracked, or ignored).
 */
export function fileStatusFor(
  statuses: readonly IFileStatus[],
  filePath: string
): FileStatus | undefined {
  const s = statuses.find((entry) => entry.path === filePath);
  return s ? statusCodeToFileStatus(s.indexStatus, s.workTreeStatus) : undefined;
}

/**
 * File-explorer context-menu command handlers
 * (`intellig.explorer.*`) extracted verbatim from extension.ts's
 * registerCommands. Stateless — reaches shared state through
 * {@link ICommandContext}; no singleton write-back in this domain. Returns
 * its disposables; extension.ts owns the single `context.subscriptions.push`
 * (RULE E4).
 */
export function registerExplorerCommands(ctx: ICommandContext): vscode.Disposable[] {
  const explorerShowHistoryCommand = registerLoggedCommand(
    'intellig.explorer.showHistory',
    async (fileUri?: vscode.Uri) => {
      if (!ctx.services) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const gitService = ctx.services.gitService;
      // honor the explorer-selected file's repo (hintRepoPath);
      // fall back to the active-editor's repo in multi-root workspaces.
      const repo = await resolveRepo(gitService, {
        hintRepoPath: fileUri?.fsPath,
        preferActive: true,
      });
      if (!repo) {
        return;
      }

      // Resolve the target file (explorer selection, else active editor) and
      // derive its REPO-root-relative path — the value git needs under
      // `cwd = repo.rootUri.fsPath`. `asRelativePath` is workspace-folder-
      // relative and breaks for nested/multi-root repos (see repoRelativePath).
      const targetUri = _resolveExplorerFileUri(fileUri);
      if (!targetUri) {
        void vscode.window.showErrorMessage('No file selected');
        return;
      }
      const filePath = repoRelativePath(repo.rootUri.fsPath, targetUri.fsPath);

      try {
        // Identical behavior to the command-palette "Show History": open the
        // file in the History tab (tabbed mode), else fall back to a QuickPick.
        await presentFileHistory(ctx, repo, filePath);
      } catch (error) {
        void vscode.window.showErrorMessage(
          formatActionFailureToast('Failed to get file history', error)
        );
      }
    }
  );

  // Compare with Branch command for file explorer
  const explorerCompareWithBranchCommand = registerLoggedCommand(
    'intellig.explorer.compareWithBranch',
    async (fileUri?: vscode.Uri) => {
      if (!ctx.services) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const gitService = ctx.services.gitService;
      // honor the explorer-selected file's repo (hintRepoPath);
      // fall back to the active-editor's repo in multi-root workspaces.
      const repo = await resolveRepo(gitService, {
        hintRepoPath: fileUri?.fsPath,
        preferActive: true,
      });
      if (!repo) {
        return;
      }

      const fileUriToUse = _resolveExplorerFileUri(fileUri);
      if (!fileUriToUse) {
        void vscode.window.showErrorMessage('No file selected');
        return;
      }
      const filePath = repoRelativePath(repo.rootUri.fsPath, fileUriToUse.fsPath);

      try {
        // Get branches for selection
        const branches = await gitService.getBranches(repo);
        const branchItems = branches.map((b) => ({
          label: b.name,
          description: b.type === 'remote' ? 'Remote' : b.isHead ? 'Current' : 'Local',
        }));

        const selected = await vscode.window.showQuickPick(branchItems, {
          placeHolder: 'Select a branch to compare with',
          title: `Compare ${filePath} with Branch`,
        });

        if (!selected) {
          return;
        }

        // Compare the working-tree file against its revision on the chosen
        // branch via the `intellig-git:` content provider (this extension's
        // scheme; the built-in `git:` scheme is unavailable when IntelliG runs
        // in place of the bundled Git extension). The repo root is encoded so
        // the provider resolves the right repo for a nested/multi-root layout.
        const branchUri = buildIntelligGitUri(filePath, selected.label, repo.rootUri.fsPath);
        // Bare (re-throws) into the surrounding catch, which also covers
        // `getBranches` + the QuickPick above.
        await openRevisionDiff({
          leftUri: branchUri,
          rightUri: fileUriToUse,
          title: `${filePath} (${selected.label} ↔ Working Tree)`,
        });
      } catch (error) {
        void vscode.window.showErrorMessage(
          formatActionFailureToast('Failed to compare with branch', error)
        );
      }
    }
  );

  // Revert command for file explorer
  const explorerRevertCommand = registerLoggedCommand(
    'intellig.explorer.revert',
    async (fileUri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
      if (!ctx.services) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const gitService = ctx.services.gitService;
      // The whole explorer selection, not just the right-clicked file.
      const targets = _resolveSelection(fileUri, selectedUris);
      if (targets.length === 0) {
        void vscode.window.showErrorMessage('No file selected');
        return;
      }
      const repo = await resolveRepo(gitService, {
        hintRepoPath: targets[0].fsPath,
        preferActive: true,
      });
      if (!repo) {
        return;
      }

      const paths = targets.map((u) => repoRelativePath(repo.rootUri.fsPath, u.fsPath));

      // Nothing-to-revert pre-check: untracked or clean files must not be
      // walked through a "cannot be undone" confirm into a no-op "Reverted"
      // toast. Selections that mix both keep only the revertable files.
      const statuses = await gitService.getStatus(repo);
      const revertable: string[] = [];
      const skippedMsgs: string[] = [];
      for (const p of paths) {
        const msg = revertPrecheck(fileStatusFor(statuses, p), p);
        if (msg) {
          skippedMsgs.push(msg);
        } else {
          revertable.push(p);
        }
      }
      if (revertable.length === 0) {
        void vscode.window.showInformationMessage(skippedMsgs.join(' '));
        return;
      }

      // Confirm revert — the message names EVERY file the confirm covers.
      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to revert changes to ${revertable.join(', ')}? This cannot be undone.`,
        { modal: true },
        'Revert'
      );

      if (confirm !== 'Revert') {
        return;
      }

      const failed: string[] = [];
      for (const p of revertable) {
        try {
          await gitService.revertFile(repo, p).match(
            () => undefined,
            (e) => {
              throw e;
            }
          );
        } catch (error) {
          failed.push(p);
          void vscode.window.showErrorMessage(
            formatActionFailureToast(`Failed to revert ${p}`, error)
          );
        }
      }
      const reverted = revertable.filter((p) => !failed.includes(p));
      if (reverted.length > 0) {
        void vscode.window.showInformationMessage(
          reverted.length === 1 ? `Reverted: ${reverted[0]}` : `Reverted ${reverted.length} files`
        );
        // Refresh views
        if (ctx.gitToolWindowProvider) {
          ctx.gitToolWindowProvider.refresh();
        }
      }
    }
  );

  // Stage command for file explorer
  const explorerStageCommand = registerLoggedCommand(
    'intellig.explorer.stage',
    async (fileUri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
      if (!ctx.services) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const gitService = ctx.services.gitService;
      // The whole explorer selection (VS Code's second argument), not just
      // the right-clicked file; repo from the first target's path.
      const targets = _resolveSelection(fileUri, selectedUris);
      if (targets.length === 0) {
        void vscode.window.showErrorMessage('No file selected');
        return;
      }
      const repo = await resolveRepo(gitService, {
        hintRepoPath: targets[0].fsPath,
        preferActive: true,
      });
      if (!repo) {
        return;
      }

      // REPO-root-relative paths — the values git needs under
      // `cwd = repo.rootUri.fsPath` (see repoRelativePath).
      const paths = targets.map((u) => repoRelativePath(repo.rootUri.fsPath, u.fsPath));

      try {
        await gitService.stage(repo, paths).match(
          () => undefined,
          (e) => {
            throw e;
          }
        );
        void vscode.window.showInformationMessage(
          paths.length === 1 ? `Staged: ${paths[0]}` : `Staged ${paths.length} files`
        );
        // Refresh views
        if (ctx.gitToolWindowProvider) {
          ctx.gitToolWindowProvider.refresh();
        }
      } catch (error) {
        void vscode.window.showErrorMessage(
          formatActionFailureToast('Failed to stage file', error)
        );
      }
    }
  );

  // Unstage command for file explorer
  const explorerUnstageCommand = registerLoggedCommand(
    'intellig.explorer.unstage',
    async (fileUri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
      if (!ctx.services) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const gitService = ctx.services.gitService;
      // The whole explorer selection (VS Code's second argument), not just
      // the right-clicked file; repo from the first target's path.
      const targets = _resolveSelection(fileUri, selectedUris);
      if (targets.length === 0) {
        void vscode.window.showErrorMessage('No file selected');
        return;
      }
      const repo = await resolveRepo(gitService, {
        hintRepoPath: targets[0].fsPath,
        preferActive: true,
      });
      if (!repo) {
        return;
      }

      // REPO-root-relative paths — the values git needs under
      // `cwd = repo.rootUri.fsPath` (see repoRelativePath).
      const paths = targets.map((u) => repoRelativePath(repo.rootUri.fsPath, u.fsPath));

      try {
        await gitService.unstage(repo, paths).match(
          () => undefined,
          (e) => {
            throw e;
          }
        );
        void vscode.window.showInformationMessage(
          paths.length === 1 ? `Unstaged: ${paths[0]}` : `Unstaged ${paths.length} files`
        );
        // Refresh views
        if (ctx.gitToolWindowProvider) {
          ctx.gitToolWindowProvider.refresh();
        }
      } catch (error) {
        void vscode.window.showErrorMessage(
          formatActionFailureToast('Failed to unstage file', error)
        );
      }
    }
  );

  // Show Diff command for file explorer
  const explorerShowDiffCommand = registerLoggedCommand(
    'intellig.explorer.showDiff',
    async (fileUri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
      if (!ctx.services) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const gitService = ctx.services.gitService;
      // The whole explorer selection — one diff tab per selected file.
      const targets = _resolveSelection(fileUri, selectedUris);
      if (targets.length === 0) {
        void vscode.window.showErrorMessage('No file selected');
        return;
      }
      const repo = await resolveRepo(gitService, {
        hintRepoPath: targets[0].fsPath,
        preferActive: true,
      });
      if (!repo) {
        return;
      }

      // Diff each working-tree file against its HEAD revision via the
      // `intellig-git:` content provider (the scheme this extension serves;
      // the built-in `git:` scheme is unavailable when the user runs IntelliG
      // in place of the bundled Git extension). The repo root is encoded so
      // the provider resolves the right repo for a nested/multi-root layout.
      for (const target of targets) {
        const filePath = repoRelativePath(repo.rootUri.fsPath, target.fsPath);
        const headUri = buildIntelligGitUri(filePath, 'HEAD', repo.rootUri.fsPath);
        await openRevisionDiff(
          {
            leftUri: headUri,
            rightUri: target,
            title: `${filePath} (HEAD ↔ Working Tree)`,
          },
          'Failed to show diff'
        );
      }
    }
  );

  // ─── Explorer / editor menu parity — command bridges ────────────────────

  function _resolveExplorerFileUri(fileUri: vscode.Uri | undefined): vscode.Uri | undefined {
    return resolveExplorerFileUri(fileUri, vscode.window.activeTextEditor?.document.uri);
  }

  function _resolveSelection(fileUri?: vscode.Uri, selectedUris?: unknown): vscode.Uri[] {
    return resolveExplorerSelection(
      fileUri,
      selectedUris,
      vscode.window.activeTextEditor?.document.uri
    );
  }

  // Commit File (git4idea Git.FileActions → CheckinFiles, the head of the
  // submenu). Per ADR-014 commit/staging routes through the native SCM API,
  // not a webview: stage the selected file, then reveal the SCM view so the
  // user types a message and accepts to commit it via the IntelliG
  // SourceControl input (mirrors VS Code's built-in Git flow).
  const explorerCommitFileCommand = registerLoggedCommand(
    'intellig.explorer.commitFile',
    async (fileUri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
      if (!ctx.services) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }
      // The whole explorer selection — every selected file gets staged for
      // the commit, not just the right-clicked one.
      const targets = _resolveSelection(fileUri, selectedUris);
      if (targets.length === 0) {
        void vscode.window.showErrorMessage('No file selected to commit');
        return;
      }

      const gitService = ctx.services.gitService;
      const repo = await resolveRepo(gitService, {
        hintRepoPath: targets[0].fsPath,
        pickerTitle: 'Commit File — Choose Repository',
        pickerPlaceholder: 'Select a repository',
      });
      if (!repo) {
        return;
      }
      const paths = targets.map((u) => repoRelativePath(repo.rootUri.fsPath, u.fsPath));
      try {
        await gitService.stage(repo, paths).match(
          () => undefined,
          (e) => {
            throw e;
          }
        );
        if (ctx.gitToolWindowProvider) {
          ctx.gitToolWindowProvider.refresh();
        }
        // The SCM accept commits the WHOLE staged index — when other files
        // are already staged, say so before the user hits commit.
        try {
          const statuses = await gitService.getStatus(repo);
          const otherStaged = statuses.filter(
            (st) => st.indexStatus !== ' ' && st.indexStatus !== '?' && !paths.includes(st.path)
          ).length;
          if (otherStaged > 0) {
            void vscode.window.showInformationMessage(
              `Note: ${otherStaged} other staged file(s) will be included in the commit.`
            );
          }
        } catch (statusError) {
          getLogger()
            .child({ component: 'explorerCommands' })
            .debug('commitFile: staged-index probe failed', {
              err: statusError instanceof Error ? statusError.message : String(statusError),
            });
        }
        // Reveal the native SCM view so the just-staged file can be committed
        // from the IntelliG SourceControl input (acceptInputCommand commits on
        // accept). VS Code offers no per-SourceControl input-focus command, so
        // this reveals the SCM viewlet where that input lives. The accept
        // commits the whole staged index (as the built-in Git extension does),
        // not strictly this file — but staging it first makes the common
        // clean-index case effectively file-scoped.
        await vscode.commands.executeCommand('workbench.view.scm');
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        void vscode.window.showErrorMessage(
          `Failed to stage file for commit: ${sanitizeGitError(msg)}`
        );
      }
    }
  );

  // Add to VCS. Stages the file (equivalent to `git add <path>`), so it
  // becomes tracked. Shown in the IntelliJ-parity explorer submenu.
  const explorerAddToVcsCommand = registerLoggedCommand(
    'intellig.explorer.addToVcs',
    async (fileUri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
      if (!ctx.services) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }
      // The whole explorer selection, not just the right-clicked file.
      const targets = _resolveSelection(fileUri, selectedUris);
      if (targets.length === 0) {
        void vscode.window.showErrorMessage('No file selected to add to VCS');
        return;
      }

      const gitService = ctx.services.gitService;
      const repo = await resolveRepo(gitService, {
        hintRepoPath: targets[0].fsPath,
        pickerTitle: 'Add to VCS — Choose Repository',
        pickerPlaceholder: 'Select a repository',
      });
      if (!repo) {
        return;
      }
      const paths = targets.map((u) => repoRelativePath(repo.rootUri.fsPath, u.fsPath));
      try {
        await gitService.stage(repo, paths).match(
          () => undefined,
          (e) => {
            throw e;
          }
        );
        void vscode.window.showInformationMessage(
          paths.length === 1 ? `Added to VCS: ${paths[0]}` : `Added ${paths.length} files to VCS`
        );
        if (ctx.gitToolWindowProvider) {
          ctx.gitToolWindowProvider.refresh();
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        void vscode.window.showErrorMessage(`Failed to add file to VCS: ${sanitizeGitError(msg)}`);
      }
    }
  );

  // Add to .gitignore (IntelliJ GitIgnoreFileActionGroup). Appends the
  // repo-root-relative path to `<root>/.gitignore`, idempotently.
  const explorerAddToGitignoreCommand = registerLoggedCommand(
    'intellig.explorer.addToGitignore',
    async (fileUri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
      if (!ctx.services) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }
      // The whole explorer selection — one pattern per selected file.
      const targets = _resolveSelection(fileUri, selectedUris);
      if (targets.length === 0) {
        void vscode.window.showErrorMessage('No file selected to add to .gitignore');
        return;
      }

      const gitService = ctx.services.gitService;
      const repo = await resolveRepo(gitService, {
        hintRepoPath: targets[0].fsPath,
        pickerTitle: 'Add to .gitignore — Choose Repository',
        pickerPlaceholder: 'Select a repository',
      });
      if (!repo) {
        return;
      }

      // Canonicalize both ends so a symlinked path component (macOS
      // `/var` → `/private/var`: git reports the resolved root, the URI keeps
      // the symlink) doesn't defeat the pure prefix match in gitignorePatternFor.
      const root = canonicalizeFsPath(repo.rootUri.fsPath);
      const patterns: string[] = [];
      for (const target of targets) {
        const pattern = gitignorePatternFor(root, canonicalizeFsPath(target.fsPath));
        if (!pattern) {
          void vscode.window.showErrorMessage(
            'Cannot add to .gitignore: the file is outside the repository.'
          );
          return;
        }
        patterns.push(pattern);
      }

      const gitignorePath = path.join(repo.rootUri.fsPath, '.gitignore');
      try {
        const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
        let updated = existing;
        for (const pattern of patterns) {
          updated = buildGitignoreAppendContent(updated, pattern);
        }
        if (updated === existing) {
          void vscode.window.showInformationMessage(
            patterns.length === 1
              ? `Already in .gitignore: ${patterns[0]}`
              : 'Already in .gitignore: all selected files.'
          );
          return;
        }
        fs.writeFileSync(gitignorePath, updated, 'utf8');
        // Honest feedback: appending a rule does not untrack a tracked file.
        // With several files, one tracked file is enough to warrant the
        // warning wording.
        let statuses: readonly IFileStatus[] = [];
        let statusesKnown = true;
        try {
          statuses = await gitService.getStatus(repo);
        } catch {
          statusesKnown = false;
        }
        const fileStatuses = targets.map((t) =>
          statusesKnown
            ? fileStatusFor(statuses, repoRelativePath(repo.rootUri.fsPath, t.fsPath))
            : undefined
        );
        const worst =
          fileStatuses.find((st) => gitignoreAppendToast('x', st).severity === 'warning') ??
          fileStatuses[0];
        const toast = gitignoreAppendToast(patterns.join(', '), worst);
        if (toast.severity === 'warning') {
          void vscode.window.showWarningMessage(toast.message);
        } else {
          void vscode.window.showInformationMessage(toast.message);
        }
        if (ctx.gitToolWindowProvider) {
          ctx.gitToolWindowProvider.refresh();
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        void vscode.window.showErrorMessage(
          `Failed to add to .gitignore: ${sanitizeGitError(msg)}`
        );
      }
    }
  );

  // Compare with the Same Repository Version.
  // Opens a diff tab between the working-tree file and its HEAD revision.
  // Reuses the `intellig-git:` URI scheme registered elsewhere in this file,
  // matching the pattern shipped for ref-based diffs.
  const explorerCompareWithRepoVersionCommand = registerLoggedCommand(
    'intellig.explorer.compareWithRepoVersion',
    async (fileUri?: vscode.Uri) => {
      if (!ctx.services) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }
      const resolvedUri = _resolveExplorerFileUri(fileUri);
      if (!resolvedUri) {
        void vscode.window.showErrorMessage('No file selected to compare');
        return;
      }

      const gitService = ctx.services.gitService;
      const repo = await resolveRepo(gitService, {
        hintRepoPath: resolvedUri.fsPath,
        pickerTitle: 'Compare with HEAD — Choose Repository',
        pickerPlaceholder: 'Select a repository',
      });
      if (!repo) {
        return;
      }
      const filePath = repoRelativePath(repo.rootUri.fsPath, resolvedUri.fsPath);
      const leftUri = buildCompareWithRepoVersionLeftUri(filePath, 'HEAD', repo.rootUri.fsPath);
      const title = buildCompareWithRepoVersionTitle(filePath);
      await openRevisionDiff(
        { leftUri, rightUri: resolvedUri, title },
        'Failed to compare with HEAD'
      );
    }
  );

  // Create Patch from File.
  // Delegates to PatchService.createPatchFromLocalChanges with a single-file
  // filter. Matches the behaviour of `intellig.patch.createFromLocal` but
  // scoped to one file.
  const explorerCreatePatchFromFileCommand = registerLoggedCommand(
    'intellig.explorer.createPatchFromFile',
    async (fileUri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
      if (!ctx.services) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }
      // The whole explorer selection — the patch covers every selected file.
      const targets = _resolveSelection(fileUri, selectedUris);
      if (targets.length === 0) {
        void vscode.window.showErrorMessage('No file selected to create patch from');
        return;
      }

      const gitService = ctx.services.gitService;
      const repo = await resolveRepo(gitService, {
        hintRepoPath: targets[0].fsPath,
        pickerTitle: 'Create Patch — Choose Repository',
        pickerPlaceholder: 'Select a repository',
      });
      if (!repo) {
        return;
      }
      const filePaths = targets.map((u) => repoRelativePath(repo.rootUri.fsPath, u.fsPath));
      const filePath = filePaths[0];

      const target = await vscode.window.showQuickPick(
        [
          { label: '$(file) Save to file…', id: 'file' as const },
          { label: '$(clippy) Copy to clipboard', id: 'clipboard' as const },
        ],
        { placeHolder: 'Where should the patch be written?' }
      );
      if (!target) {
        return;
      }

      try {
        if (target.id === 'clipboard') {
          const patch = await ctx.services.patchService.createPatchFromLocalChanges(repo, {
            files: filePaths,
            toClipboard: true,
          });
          if (!patch || patch.trim().length === 0) {
            void vscode.window.showInformationMessage(
              'No local changes to diff for the selected file(s).'
            );
            return;
          }
          void vscode.window.showInformationMessage('Patch copied to clipboard.');
          return;
        }

        const basename =
          filePaths.length === 1 ? filePath.substring(filePath.lastIndexOf('/') + 1) : 'changes';
        const defaultUri = vscode.Uri.joinPath(repo.rootUri, `${basename}.patch`);
        const uri = await vscode.window.showSaveDialog({
          defaultUri,
          filters: { 'Patch files': ['patch', 'diff'], 'All files': ['*'] },
          saveLabel: 'Save Patch',
        });
        if (!uri) {
          return;
        }
        const patch = await ctx.services.patchService.createPatchFromLocalChanges(repo, {
          files: filePaths,
          outputPath: uri.fsPath,
        });
        if (!patch || patch.trim().length === 0) {
          void vscode.window.showInformationMessage(
            'No local changes to diff for the selected file(s).'
          );
          return;
        }
        void vscode.window.showInformationMessage(`Patch saved to ${uri.fsPath}`);
      } catch (error) {
        // PatchWriteFailed means the service has already surfaced a
        // sanitised toast — we must not re-toast or the user sees two
        // error banners for one failure.
        if (error instanceof PatchWriteFailed) {
          return;
        }
        const msg = error instanceof Error ? error.message : 'Unknown error';
        void vscode.window.showErrorMessage(`Failed to create patch: ${sanitizeGitError(msg)}`);
      }
    }
  );

  return [
    explorerCommitFileCommand,
    explorerShowHistoryCommand,
    explorerCompareWithBranchCommand,
    explorerRevertCommand,
    explorerStageCommand,
    explorerUnstageCommand,
    explorerShowDiffCommand,
    explorerAddToVcsCommand,
    explorerAddToGitignoreCommand,
    explorerCompareWithRepoVersionCommand,
    explorerCreatePatchFromFileCommand,
  ];
}
