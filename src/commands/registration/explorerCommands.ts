import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { registerLoggedCommand } from '../../utils/logger';
import { resolveRepo } from '../../utils/resolveRepo';
import { sanitizeGitError, formatActionFailureToast } from '../../git-core/gitError';
import { openRevisionDiff } from '../../git-core/diff/openRevisionDiff';
import { PatchWriteFailed } from '../../services';
import { canonicalizeFsPath, repoRelativePath } from '../../utils/repoRelativePath';
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
        const history = await gitService.getFileHistory(repo, filePath);
        if (history.length === 0) {
          void vscode.window.showInformationMessage(`No history found for ${filePath}`);
          return;
        }

        // Show history in a quick pick
        const items = history.map((commit) => ({
          label: commit.shortHash,
          description: commit.message.substring(0, 60),
          detail: `${commit.author.name} - ${commit.authorDate.toLocaleDateString()}`,
          commit,
        }));

        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: `History for ${filePath}`,
          title: 'File History',
        });

        if (selected) {
          // Show the diff for the selected commit
          const diff = await gitService.getCommitDiff(repo, selected.commit.hash);
          const fileDiff = diff.find((d) => d.path === filePath || d.oldPath === filePath);
          if (fileDiff) {
            // Open diff view
            // sanitize-exempt: non-error-data: selected.commit.message is the user-authored commit subject from `git log`, not git stderr
            void vscode.window.showInformationMessage(
              `Commit ${selected.commit.shortHash}: ${selected.commit.message}`
            );
          }
        }
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

      // Confirm revert
      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to revert changes to ${filePath}? This cannot be undone.`,
        { modal: true },
        'Revert'
      );

      if (confirm !== 'Revert') {
        return;
      }

      try {
        await gitService.revertFile(repo, filePath).match(
          () => undefined,
          (e) => {
            throw e;
          }
        );
        void vscode.window.showInformationMessage(`Reverted: ${filePath}`);
        // Refresh views
        if (ctx.gitToolWindowProvider) {
          ctx.gitToolWindowProvider.refresh();
        }
      } catch (error) {
        void vscode.window.showErrorMessage(
          formatActionFailureToast('Failed to revert file', error)
        );
      }
    }
  );

  // Stage command for file explorer
  const explorerStageCommand = registerLoggedCommand(
    'intellig.explorer.stage',
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
        await gitService.stage(repo, [filePath]).match(
          () => undefined,
          (e) => {
            throw e;
          }
        );
        void vscode.window.showInformationMessage(`Staged: ${filePath}`);
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
        await gitService.unstage(repo, [filePath]).match(
          () => undefined,
          (e) => {
            throw e;
          }
        );
        void vscode.window.showInformationMessage(`Unstaged: ${filePath}`);
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
    async (fileUri?: vscode.Uri) => {
      if (!ctx.services) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const gitService = ctx.services.gitService;
      const fileUriToUse = _resolveExplorerFileUri(fileUri);
      if (!fileUriToUse) {
        void vscode.window.showErrorMessage('No file selected');
        return;
      }
      const repo = await resolveRepo(gitService, {
        hintRepoPath: fileUriToUse.fsPath,
        preferActive: true,
      });
      if (!repo) {
        return;
      }
      const filePath = repoRelativePath(repo.rootUri.fsPath, fileUriToUse.fsPath);

      // Diff the working-tree file against its HEAD revision via the
      // `intellig-git:` content provider (the scheme this extension serves;
      // the built-in `git:` scheme is unavailable when the user runs IntelliG
      // in place of the bundled Git extension). The repo root is encoded so
      // the provider resolves the right repo for a nested/multi-root layout.
      const headUri = buildIntelligGitUri(filePath, 'HEAD', repo.rootUri.fsPath);
      await openRevisionDiff(
        {
          leftUri: headUri,
          rightUri: fileUriToUse,
          title: `${filePath} (HEAD ↔ Working Tree)`,
        },
        'Failed to show diff'
      );
    }
  );

  // ─── Explorer / editor menu parity — command bridges ────────────────────

  function _resolveExplorerFileUri(fileUri: vscode.Uri | undefined): vscode.Uri | undefined {
    return resolveExplorerFileUri(fileUri, vscode.window.activeTextEditor?.document.uri);
  }

  // Commit File (git4idea Git.FileActions → CheckinFiles, the head of the
  // submenu). Per ADR-014 commit/staging routes through the native SCM API,
  // not a webview: stage the selected file, then reveal the SCM view so the
  // user types a message and accepts to commit it via the IntelliG
  // SourceControl input (mirrors VS Code's built-in Git flow).
  const explorerCommitFileCommand = registerLoggedCommand(
    'intellig.explorer.commitFile',
    async (fileUri?: vscode.Uri) => {
      if (!ctx.services) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }
      const resolvedUri = _resolveExplorerFileUri(fileUri);
      if (!resolvedUri) {
        void vscode.window.showErrorMessage('No file selected to commit');
        return;
      }

      const gitService = ctx.services.gitService;
      const repo = await resolveRepo(gitService, {
        hintRepoPath: resolvedUri.fsPath,
        pickerTitle: 'Commit File — Choose Repository',
        pickerPlaceholder: 'Select a repository',
      });
      if (!repo) {
        return;
      }
      const filePath = repoRelativePath(repo.rootUri.fsPath, resolvedUri.fsPath);
      try {
        await gitService.stage(repo, [filePath]).match(
          () => undefined,
          (e) => {
            throw e;
          }
        );
        if (ctx.gitToolWindowProvider) {
          ctx.gitToolWindowProvider.refresh();
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
    async (fileUri?: vscode.Uri) => {
      if (!ctx.services) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }
      const resolvedUri = _resolveExplorerFileUri(fileUri);
      if (!resolvedUri) {
        void vscode.window.showErrorMessage('No file selected to add to VCS');
        return;
      }

      const gitService = ctx.services.gitService;
      const repo = await resolveRepo(gitService, {
        hintRepoPath: resolvedUri.fsPath,
        pickerTitle: 'Add to VCS — Choose Repository',
        pickerPlaceholder: 'Select a repository',
      });
      if (!repo) {
        return;
      }
      const filePath = repoRelativePath(repo.rootUri.fsPath, resolvedUri.fsPath);
      try {
        await gitService.stage(repo, [filePath]).match(
          () => undefined,
          (e) => {
            throw e;
          }
        );
        void vscode.window.showInformationMessage(`Added to VCS: ${filePath}`);
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
    async (fileUri?: vscode.Uri) => {
      if (!ctx.services) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }
      const resolvedUri = _resolveExplorerFileUri(fileUri);
      if (!resolvedUri) {
        void vscode.window.showErrorMessage('No file selected to add to .gitignore');
        return;
      }

      const gitService = ctx.services.gitService;
      const repo = await resolveRepo(gitService, {
        hintRepoPath: resolvedUri.fsPath,
        pickerTitle: 'Add to .gitignore — Choose Repository',
        pickerPlaceholder: 'Select a repository',
      });
      if (!repo) {
        return;
      }

      // Canonicalize both ends so a symlinked path component (macOS
      // `/var` → `/private/var`: git reports the resolved root, the URI keeps
      // the symlink) doesn't defeat the pure prefix match in gitignorePatternFor.
      const pattern = gitignorePatternFor(
        canonicalizeFsPath(repo.rootUri.fsPath),
        canonicalizeFsPath(resolvedUri.fsPath)
      );
      if (!pattern) {
        void vscode.window.showErrorMessage(
          'Cannot add to .gitignore: the file is outside the repository.'
        );
        return;
      }

      const gitignorePath = path.join(repo.rootUri.fsPath, '.gitignore');
      try {
        const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
        const updated = buildGitignoreAppendContent(existing, pattern);
        if (updated === existing) {
          void vscode.window.showInformationMessage(`Already in .gitignore: ${pattern}`);
          return;
        }
        fs.writeFileSync(gitignorePath, updated, 'utf8');
        void vscode.window.showInformationMessage(`Added to .gitignore: ${pattern}`);
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
    async (fileUri?: vscode.Uri) => {
      if (!ctx.services) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }
      const resolvedUri = _resolveExplorerFileUri(fileUri);
      if (!resolvedUri) {
        void vscode.window.showErrorMessage('No file selected to create patch from');
        return;
      }

      const gitService = ctx.services.gitService;
      const repo = await resolveRepo(gitService, {
        hintRepoPath: resolvedUri.fsPath,
        pickerTitle: 'Create Patch — Choose Repository',
        pickerPlaceholder: 'Select a repository',
      });
      if (!repo) {
        return;
      }
      const filePath = repoRelativePath(repo.rootUri.fsPath, resolvedUri.fsPath);

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
            files: [filePath],
            toClipboard: true,
          });
          if (!patch || patch.trim().length === 0) {
            void vscode.window.showInformationMessage('No local changes to diff for this file.');
            return;
          }
          void vscode.window.showInformationMessage('Patch copied to clipboard.');
          return;
        }

        const basename = filePath.substring(filePath.lastIndexOf('/') + 1);
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
          files: [filePath],
          outputPath: uri.fsPath,
        });
        if (!patch || patch.trim().length === 0) {
          void vscode.window.showInformationMessage('No local changes to diff for this file.');
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
