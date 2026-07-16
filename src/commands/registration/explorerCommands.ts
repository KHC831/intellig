import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { formatActionFailureToast } from '../../git-core/gitError';
import { openRevisionDiff } from '../../git-core/diff/openRevisionDiff';
import { PatchWriteFailed, CommitDialog } from '../../services';
import { canonicalizeFsPath } from '../../utils/repoRelativePath';
import { safeFireAndForget } from '../../utils/safeFireAndForget';
import { statusCodeToFileStatus } from '../../git-core/gitParser';
import type { FileStatus, IFileStatus } from '../../git-core/interfaces/IGitService';
import { presentFileHistory } from './commitHelpers';
import type { ICommandContext } from './CommandContext';
import { registerFileCommand, registerSelectionCommand } from './commandSpine';

// Re-exported so the established `from '.../explorerCommands'` import path used
// by `explorerRepoRelativePath.test.ts` keeps working after the helpers moved
// to the shared `utils/repoRelativePath` module (RULE E2 re-export clause).
export { repoRelativePath, toRepoRelativePosix } from '../../utils/repoRelativePath';

// The selection/target resolvers moved to the command spine (they are the
// spine's selection contract); re-exported here so the established import
// paths used by extension.ts and the unit tests keep working (RULE E2).
export { resolveExplorerFileUri, resolveExplorerSelection } from './commandSpine';

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
 * File-explorer context-menu command handlers (`intellig.explorer.*`),
 * registered through the command spine: the spine owns the services guard,
 * the (clickedUri, selectedUris[]) selection contract, repo resolution, and
 * failure toasts; the bodies below own only their outcome logic. Returns
 * the disposables; extension.ts owns the single `context.subscriptions.push`
 * (RULE E4).
 */
export function registerExplorerCommands(ctx: ICommandContext): vscode.Disposable[] {
  const explorerShowHistoryCommand = registerFileCommand(ctx, {
    id: 'intellig.explorer.showHistory',
    failureTitle: 'Failed to get file history',
    run: async ({ repo, path: filePath }) => {
      // Identical behavior to the command-palette "Show History": open the
      // file in the History tab (tabbed mode), else fall back to a QuickPick.
      await presentFileHistory(ctx, repo, filePath);
    },
  });

  const explorerCompareWithBranchCommand = registerFileCommand(ctx, {
    id: 'intellig.explorer.compareWithBranch',
    failureTitle: 'Failed to compare with branch',
    run: async ({ gitService, repo, target, path: filePath }) => {
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
      await openRevisionDiff({
        leftUri: branchUri,
        rightUri: target,
        title: `${filePath} (${selected.label} ↔ Working Tree)`,
      });
    },
  });

  const explorerRevertCommand = registerSelectionCommand(ctx, {
    id: 'intellig.explorer.revert',
    failureTitle: 'Failed to revert file',
    run: async ({ gitService, repo, paths }) => {
      // Nothing-to-revert pre-check: untracked or clean files must not be
      // walked through a "cannot be undone" confirm into a no-op "Reverted"
      // toast. Selections that mix both keep only the revertable files.
      //
      // getStatus absorbs git faults to an empty list (its passive-view
      // contract), so an empty result is ambiguous — a genuinely clean tree OR a
      // swallowed status-read failure. Treating that as "nothing to revert"
      // would silently drop the file the user explicitly chose. Only apply the
      // precheck when the read returned data; on an empty status, honor the
      // request and let revertFile be the source of truth (a clean file reverts
      // as a harmless no-op).
      const statuses = await gitService.getStatus(repo);
      const canClassify = statuses.length > 0;
      const revertable: string[] = [];
      const skippedMsgs: string[] = [];
      for (const p of paths) {
        const msg = canClassify ? revertPrecheck(fileStatusFor(statuses, p), p) : undefined;
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
        ctx.gitToolWindowProvider?.refresh();
      }
    },
  });

  const explorerStageCommand = registerSelectionCommand(ctx, {
    id: 'intellig.explorer.stage',
    failureTitle: 'Failed to stage file',
    refreshOnSuccess: true,
    run: async ({ gitService, repo, paths }) => {
      await gitService.stage(repo, paths).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      void vscode.window.showInformationMessage(
        paths.length === 1 ? `Staged: ${paths[0]}` : `Staged ${paths.length} files`
      );
    },
  });

  const explorerUnstageCommand = registerSelectionCommand(ctx, {
    id: 'intellig.explorer.unstage',
    failureTitle: 'Failed to unstage file',
    refreshOnSuccess: true,
    run: async ({ gitService, repo, paths }) => {
      await gitService.unstage(repo, paths).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      void vscode.window.showInformationMessage(
        paths.length === 1 ? `Unstaged: ${paths[0]}` : `Unstaged ${paths.length} files`
      );
    },
  });

  const explorerShowDiffCommand = registerSelectionCommand(ctx, {
    id: 'intellig.explorer.showDiff',
    failureTitle: 'Failed to show diff',
    run: async ({ repo, targets, paths }) => {
      // Diff each working-tree file against its HEAD revision via the
      // `intellig-git:` content provider (the scheme this extension serves;
      // the built-in `git:` scheme is unavailable when the user runs IntelliG
      // in place of the bundled Git extension). The repo root is encoded so
      // the provider resolves the right repo for a nested/multi-root layout.
      for (let i = 0; i < targets.length; i++) {
        const filePath = paths[i];
        const headUri = buildIntelligGitUri(filePath, 'HEAD', repo.rootUri.fsPath);
        await openRevisionDiff(
          {
            leftUri: headUri,
            rightUri: targets[i],
            title: `${filePath} (HEAD ↔ Working Tree)`,
          },
          'Failed to show diff'
        );
      }
    },
  });

  // Commit File (git4idea Git.FileActions → CheckinFiles, the head of the
  // submenu). Opens the Commit Dialog with exactly the selection preselected
  // (reference: CommitChangeListDialog scoped to the clicked change) — the
  // dialog stages/commits only the checked files, so already-staged work on
  // OTHER files never rides along with a "commit this file" click.
  const explorerCommitFileCommand = registerSelectionCommand(ctx, {
    id: 'intellig.explorer.commitFile',
    noTargetMessage: 'No file selected to commit',
    pickerTitle: 'Commit File — Choose Repository',
    pickerPlaceholder: 'Select a repository',
    failureTitle: 'Failed to open the commit dialog',
    run: ({ gitService, repo, paths }) => {
      if (!ctx.commitDialog) {
        ctx.commitDialog = new CommitDialog(
          ctx.context.extensionUri,
          gitService,
          ctx.context.workspaceState
        );
      }
      // show() resolves when the dialog CLOSES — don't hold the command open
      // on user interaction; the dialog surfaces its own failures.
      safeFireAndForget(
        ctx.commitDialog.show(repo, { preSelectedFiles: paths }).then(() => undefined),
        'explorer.commitFile: commit dialog'
      );
      return Promise.resolve();
    },
  });

  // Add to VCS. Stages the selection (equivalent to `git add <paths>`), so
  // the files become tracked. Shown in the IntelliJ-parity explorer submenu.
  const explorerAddToVcsCommand = registerSelectionCommand(ctx, {
    id: 'intellig.explorer.addToVcs',
    noTargetMessage: 'No file selected to add to VCS',
    pickerTitle: 'Add to VCS — Choose Repository',
    pickerPlaceholder: 'Select a repository',
    failureTitle: 'Failed to add file to VCS',
    refreshOnSuccess: true,
    run: async ({ gitService, repo, paths }) => {
      await gitService.stage(repo, paths).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      void vscode.window.showInformationMessage(
        paths.length === 1 ? `Added to VCS: ${paths[0]}` : `Added ${paths.length} files to VCS`
      );
    },
  });

  // Add to .gitignore (IntelliJ GitIgnoreFileActionGroup). Appends the
  // repo-root-relative path of every selected file to `<root>/.gitignore`,
  // idempotently.
  const explorerAddToGitignoreCommand = registerSelectionCommand(ctx, {
    id: 'intellig.explorer.addToGitignore',
    noTargetMessage: 'No file selected to add to .gitignore',
    pickerTitle: 'Add to .gitignore — Choose Repository',
    pickerPlaceholder: 'Select a repository',
    failureTitle: 'Failed to add to .gitignore',
    run: async ({ gitService, repo, targets, paths }) => {
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
      const fileStatuses = paths.map((p) =>
        statusesKnown ? fileStatusFor(statuses, p) : undefined
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
      ctx.gitToolWindowProvider?.refresh();
    },
  });

  // Compare with the Same Repository Version.
  // Opens a diff tab between the working-tree file and its HEAD revision.
  const explorerCompareWithRepoVersionCommand = registerFileCommand(ctx, {
    id: 'intellig.explorer.compareWithRepoVersion',
    noTargetMessage: 'No file selected to compare',
    pickerTitle: 'Compare with HEAD — Choose Repository',
    pickerPlaceholder: 'Select a repository',
    failureTitle: 'Failed to compare with HEAD',
    run: async ({ repo, target, path: filePath }) => {
      const leftUri = buildCompareWithRepoVersionLeftUri(filePath, 'HEAD', repo.rootUri.fsPath);
      const title = buildCompareWithRepoVersionTitle(filePath);
      await openRevisionDiff({ leftUri, rightUri: target, title }, 'Failed to compare with HEAD');
    },
  });

  // Create Patch from File.
  // Delegates to PatchService.createPatchFromLocalChanges filtered to the
  // selection. Matches `intellig.patch.createFromLocal` scoped to the
  // selected files.
  const explorerCreatePatchFromFileCommand = registerSelectionCommand(ctx, {
    id: 'intellig.explorer.createPatchFromFile',
    noTargetMessage: 'No file selected to create patch from',
    pickerTitle: 'Create Patch — Choose Repository',
    pickerPlaceholder: 'Select a repository',
    failureTitle: 'Failed to create patch',
    run: async ({ services, repo, paths }) => {
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
          const patch = await services.patchService.createPatchFromLocalChanges(repo, {
            files: paths,
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
          paths.length === 1 ? paths[0].substring(paths[0].lastIndexOf('/') + 1) : 'changes';
        const defaultUri = vscode.Uri.joinPath(repo.rootUri, `${basename}.patch`);
        const uri = await vscode.window.showSaveDialog({
          defaultUri,
          filters: { 'Patch files': ['patch', 'diff'], 'All files': ['*'] },
          saveLabel: 'Save Patch',
        });
        if (!uri) {
          return;
        }
        const patch = await services.patchService.createPatchFromLocalChanges(repo, {
          files: paths,
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
        // sanitised toast — swallowing here avoids a second banner for one
        // failure; anything else is the spine's to report.
        if (error instanceof PatchWriteFailed) {
          return;
        }
        throw error;
      }
    },
  });

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
