import * as vscode from 'vscode';
import { registerLoggedCommand } from '../../utils/logger';
import { resolveRepo } from '../../utils/resolveRepo';
import { sanitizeGitError, formatActionFailureToast } from '../../git-core/gitError';
import { PatchWriteFailed } from '../../services';
import type { ICommandContext } from './CommandContext';

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
 * Build the left-hand `intellig-git:` URI used by
 * `intellig.explorer.compareWithRepoVersion`. The query component is
 * URL-encoded so refs with `/` (e.g. remote-qualified branches) survive
 * round-tripping through `Uri.parse`.
 *
 * Relocated verbatim from extension.ts; re-exported there for unit tests.
 */
export function buildCompareWithRepoVersionLeftUri(
  filePath: string,
  ref: string = 'HEAD'
): vscode.Uri {
  return vscode.Uri.parse(`intellig-git:${filePath}?${encodeURIComponent(ref)}`);
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

      // Get file path from URI or active editor
      let filePath: string;
      if (fileUri) {
        filePath = vscode.workspace.asRelativePath(fileUri);
      } else {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
          void vscode.window.showErrorMessage('No file selected');
          return;
        }
        filePath = vscode.workspace.asRelativePath(activeEditor.document.uri);
      }

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

      // Get file path from URI or active editor
      let filePath: string;
      let fileUriToUse: vscode.Uri;
      if (fileUri) {
        filePath = vscode.workspace.asRelativePath(fileUri);
        fileUriToUse = fileUri;
      } else {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
          void vscode.window.showErrorMessage('No file selected');
          return;
        }
        filePath = vscode.workspace.asRelativePath(activeEditor.document.uri);
        fileUriToUse = activeEditor.document.uri;
      }

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

        // Use VS Code's built-in diff command to compare
        const branchUri = vscode.Uri.parse(`git:${filePath}?ref=${selected.label}`);
        await vscode.commands.executeCommand(
          'vscode.diff',
          branchUri,
          fileUriToUse,
          `${filePath} (${selected.label} ↔ Working Tree)`
        );
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

      // Get file path from URI or active editor
      let filePath: string;
      if (fileUri) {
        filePath = vscode.workspace.asRelativePath(fileUri);
      } else {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
          void vscode.window.showErrorMessage('No file selected');
          return;
        }
        filePath = vscode.workspace.asRelativePath(activeEditor.document.uri);
      }

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
        await gitService.revertFile(repo, filePath);
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

      // Get file path from URI or active editor
      let filePath: string;
      if (fileUri) {
        filePath = vscode.workspace.asRelativePath(fileUri);
      } else {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
          void vscode.window.showErrorMessage('No file selected');
          return;
        }
        filePath = vscode.workspace.asRelativePath(activeEditor.document.uri);
      }

      try {
        await gitService.stage(repo, [filePath]);
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

      // Get file path from URI or active editor
      let filePath: string;
      if (fileUri) {
        filePath = vscode.workspace.asRelativePath(fileUri);
      } else {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
          void vscode.window.showErrorMessage('No file selected');
          return;
        }
        filePath = vscode.workspace.asRelativePath(activeEditor.document.uri);
      }

      try {
        await gitService.unstage(repo, [filePath]);
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
      const repositories = gitService.getRepositories();

      if (repositories.length === 0) {
        void vscode.window.showErrorMessage('No Git repository found');
        return;
      }

      // Get file path from URI or active editor
      let filePath: string;
      let fileUriToUse: vscode.Uri;
      if (fileUri) {
        filePath = vscode.workspace.asRelativePath(fileUri);
        fileUriToUse = fileUri;
      } else {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
          void vscode.window.showErrorMessage('No file selected');
          return;
        }
        filePath = vscode.workspace.asRelativePath(activeEditor.document.uri);
        fileUriToUse = activeEditor.document.uri;
      }

      try {
        // Use VS Code's built-in Git diff command
        const gitUri = vscode.Uri.parse(`git:${filePath}?ref=HEAD`);
        await vscode.commands.executeCommand(
          'vscode.diff',
          gitUri,
          fileUriToUse,
          `${filePath} (HEAD ↔ Working Tree)`
        );
      } catch (error) {
        void vscode.window.showErrorMessage(formatActionFailureToast('Failed to show diff', error));
      }
    }
  );

  // ─── Explorer / editor menu parity — command bridges ────────────────────

  function _resolveExplorerFileUri(fileUri: vscode.Uri | undefined): vscode.Uri | undefined {
    return resolveExplorerFileUri(fileUri, vscode.window.activeTextEditor?.document.uri);
  }

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
      const filePath = vscode.workspace.asRelativePath(resolvedUri);
      try {
        await gitService.stage(repo, [filePath]);
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
      const filePath = vscode.workspace.asRelativePath(resolvedUri);
      const leftUri = buildCompareWithRepoVersionLeftUri(filePath);
      const title = buildCompareWithRepoVersionTitle(filePath);
      try {
        await vscode.commands.executeCommand('vscode.diff', leftUri, resolvedUri, title);
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        void vscode.window.showErrorMessage(
          `Failed to compare with HEAD: ${sanitizeGitError(msg)}`
        );
      }
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
      const filePath = vscode.workspace.asRelativePath(resolvedUri);

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
    explorerShowHistoryCommand,
    explorerCompareWithBranchCommand,
    explorerRevertCommand,
    explorerStageCommand,
    explorerUnstageCommand,
    explorerShowDiffCommand,
    explorerAddToVcsCommand,
    explorerCompareWithRepoVersionCommand,
    explorerCreatePatchFromFileCommand,
  ];
}
