import * as vscode from 'vscode';
import { registerLoggedCommand } from '../../utils/logger';
import { resolveRepo } from '../../utils/resolveRepo';
import { repoRelativePath } from '../../utils/repoRelativePath';
import { sanitizeGitError, formatActionFailureToast } from '../../git-core/gitError';
import { createMergeView } from '../../services';
import { inferReopenOperation } from '../../conflicts/conflictReversal';
import { acceptLabels } from '../../conflicts/conflictSideNames';
import type { ICommandContext } from './CommandContext';

/**
 * Merge-editor, conflict-resolution, and rebase-recovery command handlers
 * (`intellig.merge.*`, `intellig.conflict.*`, `intellig.rebase.*`,
 * `intellig.showResolveConflictsDialog`) extracted verbatim from
 * extension.ts's registerCommands.
 *
 * Reaches shared state through {@link ICommandContext}. The `ctx.mergeView`
 * singleton (openMergeView) is lazily written back here through the
 * read/WRITE ctx accessor so the single owner in extension.ts is mutated
 * (RULE E1). Interactive rebase now opens the unified Rebase dialog via
 * `ctx.openRebaseDialog` (the dialog owns the rebase-editor lifecycle).
 * Returns its disposables; extension.ts owns the single push (RULE E4).
 */
export function registerRebaseConflictCommands(ctx: ICommandContext): vscode.Disposable[] {
  // Merge View commands
  const openMergeViewCommand = registerLoggedCommand(
    'intellig.merge.openMergeView',
    async (fileUri?: vscode.Uri) => {
      if (!ctx.services) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      // Get the file to open in merge view
      let filePath: string;
      if (fileUri) {
        filePath = fileUri.fsPath;
      } else {
        // If no file provided, show a picker for conflicted files
        const gitService = ctx.services.gitService;
        // prefer the active-editor's repo in multi-root workspaces.
        const repo = await resolveRepo(gitService, {
          preferActive: true,
        });
        if (!repo) {
          return;
        }
        const status = await gitService.getStatus(repo);
        const conflictedFiles = status.filter(
          (f) => f.indexStatus === 'U' || f.workTreeStatus === 'U'
        );

        if (conflictedFiles.length === 0) {
          void vscode.window.showInformationMessage('No conflicted files found');
          return;
        }

        const selected = await vscode.window.showQuickPick(
          conflictedFiles.map((f) => ({
            label: f.path,
            description: 'Conflicted',
          })),
          { placeHolder: 'Select a conflicted file to resolve' }
        );

        if (!selected) {
          return;
        }
        filePath = selected.label;
      }

      // Create merge view if not exists
      if (!ctx.mergeView) {
        ctx.mergeView = createMergeView(ctx.context.extensionUri, ctx.services.gitService);
      }

      try {
        await ctx.mergeView.show(filePath);
      } catch (error) {
        void vscode.window.showErrorMessage(
          formatActionFailureToast('Failed to open merge view', error)
        );
      }
    }
  );

  // The merge.* commands act on the lazily-created MergeView singleton; when
  // it has never been opened, say so instead of silently doing nothing (all
  // eight are palette-visible).
  function noMergeViewToast(): void {
    void vscode.window.showInformationMessage(
      'No merge view is open — run "IntelliG: Open Merge View" on a conflicted file first.'
    );
  }

  const acceptCurrentCommand = registerLoggedCommand('intellig.merge.acceptCurrent', () => {
    if (ctx.mergeView) {
      ctx.mergeView.acceptCurrent();
    } else {
      noMergeViewToast();
    }
  });

  const acceptIncomingCommand = registerLoggedCommand('intellig.merge.acceptIncoming', () => {
    if (ctx.mergeView) {
      ctx.mergeView.acceptIncoming();
    } else {
      noMergeViewToast();
    }
  });

  const acceptBothCommand = registerLoggedCommand('intellig.merge.acceptBoth', () => {
    if (ctx.mergeView) {
      ctx.mergeView.acceptBoth();
    } else {
      noMergeViewToast();
    }
  });

  const acceptAllCurrentCommand = registerLoggedCommand('intellig.merge.acceptAllCurrent', () => {
    if (ctx.mergeView) {
      ctx.mergeView.acceptAllCurrent();
    } else {
      noMergeViewToast();
    }
  });

  const acceptAllIncomingCommand = registerLoggedCommand('intellig.merge.acceptAllIncoming', () => {
    if (ctx.mergeView) {
      ctx.mergeView.acceptAllIncoming();
    } else {
      noMergeViewToast();
    }
  });

  const nextConflictCommand = registerLoggedCommand('intellig.merge.nextConflict', () => {
    if (ctx.mergeView) {
      ctx.mergeView.nextConflict();
    } else {
      noMergeViewToast();
    }
  });

  const previousConflictCommand = registerLoggedCommand('intellig.merge.previousConflict', () => {
    if (ctx.mergeView) {
      ctx.mergeView.previousConflict();
    } else {
      noMergeViewToast();
    }
  });

  const markResolvedCommand = registerLoggedCommand('intellig.merge.markResolved', async () => {
    if (ctx.mergeView) {
      await ctx.mergeView.markResolved();
    } else {
      noMergeViewToast();
    }
  });

  // Conflict Resolution commands
  // Manual entry point for re-opening the Resolve Conflicts dialog. Used by
  // the status-bar "Unresolved conflicts — click to resolve" prompt and by
  // the VCS menu `Resolve Conflicts…` item (contributed elsewhere).
  const showResolveConflictsDialogCommand = registerLoggedCommand(
    'intellig.showResolveConflictsDialog',
    async () => {
      if (!ctx.services) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }
      const conflictService = ctx.services.conflictResolutionService;
      const gitService = ctx.services.gitService;
      // prefer the active-editor's repo in multi-root workspaces.
      const repo = await resolveRepo(gitService, {
        preferActive: true,
      });
      if (!repo) {
        return;
      }
      const conflicts = await conflictService.getConflictedFiles(repo);
      const state = conflictService.getRepositoryState(repo);
      if (conflicts.length === 0 && state === 'idle') {
        // Nothing unresolved AND no operation in progress — genuinely nothing to do.
        void vscode.window.showInformationMessage('No unresolved conflicts.');
        return;
      }
      // With zero conflicts but an operation still in progress, the user resolved
      // everything (e.g. in the native merge editor, which just stages the file);
      // open the dialog anyway so Continue/Abort are reachable — otherwise the
      // in-progress badge would dead-end with no way to finish the operation.
      //
      // The repository state leads (a definitive in-progress op is a git fact);
      // the recorded op only disambiguates an idle repo — a working-tree apply
      // produced outside the extension. See {@link inferReopenOperation}.
      const operation = inferReopenOperation(conflictService.getRecordedOperation(repo), state);
      const opContext = {
        operation,
        canAbort: true,
        canContinue: true,
      };
      await conflictService.openResolveConflictsDialog(repo, conflicts, opContext, {
        explicit: true,
      });
    }
  );

  // Palette entry point — Skip This Commit during an in-progress rebase.
  // Gated by the same `intellig.conflicts.active` context key the status-bar
  // prompt uses, so it only appears while a rebase is paused on conflicts.
  // Destructive; single confirm matches the dialog button.
  const rebaseSkipCommand = registerLoggedCommand('intellig.rebase.skip', async () => {
    if (!ctx.services) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }
    const gitService = ctx.services.gitService;
    const conflictService = ctx.services.conflictResolutionService;
    // prefer the active-editor's repo in multi-root workspaces.
    const repo = await resolveRepo(gitService, {
      preferActive: true,
    });
    if (!repo) {
      return;
    }

    const state = conflictService.getRepositoryState(repo);
    if (state !== 'rebasing') {
      void vscode.window.showInformationMessage(
        'Rebase --skip is only available while a rebase is in progress.'
      );
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      'Skip this commit? The changes will NOT be applied.',
      { modal: true },
      'Skip'
    );
    if (choice !== 'Skip') {
      return;
    }

    try {
      const res = await gitService.rebaseSkip(repo);
      if (!res.success && res.conflicts && res.conflicts.length > 0) {
        // More conflicts after the skip — reopen the Resolve Conflicts
        // dialog for the user. Reuses the auto-open path.
        await conflictService.openResolveConflictsDialog(
          repo,
          res.conflicts.map((p) => ({ path: p, resolved: false })),
          { operation: 'rebase', canAbort: true, canContinue: true }
        );
        // rebaseSkip advanced HEAD even though
        // conflicts persist on the next commit; reload + refresh so
        // the panel reflects the new in-progress rebase position.
        await gitService.reloadRepository(repo);
        if (ctx.gitToolWindowProvider) {
          ctx.gitToolWindowProvider.refresh();
        }
        return;
      }
      void vscode.window.showInformationMessage('Commit skipped.');
      // rebaseSkip moved HEAD; reload + refresh so the log graph reflects
      // the new rebase position rather than the pre-skip one.
      await gitService.reloadRepository(repo);
      if (ctx.gitToolWindowProvider) {
        ctx.gitToolWindowProvider.refresh();
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Failed to skip commit: ${sanitizeGitError(errMsg)}`);
    }
  });

  // Palette + activation-warning entry points for `git rebase --continue`
  // and `git rebase --abort`. Together with the pre-existing
  // `intellig.rebase.skip`, these are the three commands the
  // activation-time rebase-paused warning toast can route the user to.
  // If any of the three is unregistered, the warning toast falls back to
  // a button-less generic message.
  const rebaseContinueCommand = registerLoggedCommand('intellig.rebase.continue', async () => {
    if (!ctx.services) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }
    const gitService = ctx.services.gitService;
    const conflictService = ctx.services.conflictResolutionService;
    const repo = await resolveRepo(gitService, { preferActive: true });
    if (!repo) {
      return;
    }

    const state = conflictService.getRepositoryState(repo);
    if (state !== 'rebasing') {
      void vscode.window.showInformationMessage(
        'Rebase --continue is only available while a rebase is in progress.'
      );
      return;
    }

    try {
      const res = await gitService.rebaseContinue(repo);
      if (res.success) {
        void vscode.window.showInformationMessage('Rebase continued successfully.');
      } else if (res.conflicts && res.conflicts.length > 0) {
        // Next commit in the rebase sequence introduced new conflicts —
        // reopen the Resolve Conflicts dialog so the user can keep going.
        await conflictService.openResolveConflictsDialog(
          repo,
          res.conflicts.map((p) => ({ path: p, resolved: false })),
          { operation: 'rebase', canAbort: true, canContinue: true }
        );
      } else {
        // Non-conflict failure (unstaged resolution, editor cancelled,
        // etc.). Surface git's reason — already sanitized at the
        // GitService boundary, but re-pipe through `sanitizeGitError`
        // here so the safety contract is locally evident at the toast site.
        const reason = res.failureReason ?? 'unknown error (no output from git)';
        void vscode.window.showErrorMessage(
          `Failed to continue rebase: ${sanitizeGitError(reason)}`
        );
      }
      await gitService.reloadRepository(repo);
      if (ctx.gitToolWindowProvider) {
        ctx.gitToolWindowProvider.refresh();
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Failed to continue rebase: ${sanitizeGitError(errMsg)}`);
    }
  });

  const rebaseAbortCommand = registerLoggedCommand('intellig.rebase.abort', async () => {
    if (!ctx.services) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }
    const gitService = ctx.services.gitService;
    const conflictService = ctx.services.conflictResolutionService;
    const repo = await resolveRepo(gitService, { preferActive: true });
    if (!repo) {
      return;
    }

    const state = conflictService.getRepositoryState(repo);
    if (state !== 'rebasing') {
      void vscode.window.showInformationMessage(
        'Rebase --abort is only available while a rebase is in progress.'
      );
      return;
    }

    // `rebase --abort` rewrites HEAD back to the pre-rebase state and is
    // therefore destructive of the in-flight rebase work (NOT of any
    // committed history). Single-confirm modal matches the rest of the
    // rebase recovery commands.
    const choice = await vscode.window.showWarningMessage(
      'Abort the rebase? Your working tree will be restored to its pre-rebase state.',
      { modal: true },
      'Abort'
    );
    if (choice !== 'Abort') {
      return;
    }

    try {
      await gitService.rebaseAbort(repo).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      void vscode.window.showInformationMessage('Rebase aborted.');
      await gitService.reloadRepository(repo);
      if (ctx.gitToolWindowProvider) {
        ctx.gitToolWindowProvider.refresh();
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Failed to abort rebase: ${sanitizeGitError(errMsg)}`);
    }
  });

  const markFileResolvedCommand = registerLoggedCommand(
    'intellig.conflict.markResolved',
    async (fileUri?: vscode.Uri) => {
      if (!ctx.services) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const conflictService = ctx.services.conflictResolutionService;
      const gitService = ctx.services.gitService;
      // prefer the fileUri's repo (when invoked from a context
      // menu), falling back to the active-editor's repo in multi-root
      // workspaces.
      const repo = await resolveRepo(gitService, {
        hintRepoPath: fileUri?.fsPath,
        preferActive: true,
      });
      if (!repo) {
        return;
      }

      // Get file path
      let filePath: string;
      if (fileUri) {
        // Shared repo-relative derivation (canonicalizes symlinks, anchored at
        // the root) — an unanchored String.replace mangles paths that repeat
        // the root segment and misses macOS /var → /private/var.
        filePath = repoRelativePath(repo.rootUri.fsPath, fileUri.fsPath);
      } else {
        // Show picker for conflicted files
        const conflicts = await conflictService.getConflictedFiles(repo);
        if (conflicts.length === 0) {
          void vscode.window.showInformationMessage('No conflicted files found');
          return;
        }

        const selected = await vscode.window.showQuickPick(
          conflicts.map((c) => ({ label: c.path })),
          { placeHolder: 'Select a file to mark as resolved' }
        );

        if (!selected) {
          return;
        }
        filePath = selected.label;
      }

      const result = await conflictService.markResolved(repo, filePath);
      if (result.success) {
        void vscode.window.showInformationMessage(`Marked ${filePath} as resolved`);
      } else {
        void vscode.window.showErrorMessage(result.error || 'Failed to mark file as resolved');
      }
    }
  );

  const acceptAllCurrentFilesCommand = registerLoggedCommand(
    'intellig.conflict.acceptAllCurrent',
    async () => {
      if (!ctx.services) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const conflictService = ctx.services.conflictResolutionService;
      const gitService = ctx.services.gitService;
      // prefer the active-editor's repo in multi-root workspaces.
      const repo = await resolveRepo(gitService, {
        preferActive: true,
      });
      if (!repo) {
        return;
      }
      const conflicts = await conflictService.getConflictedFiles(repo);

      if (conflicts.length === 0) {
        void vscode.window.showInformationMessage('No conflicted files found');
        return;
      }

      const { yours } = await conflictService.getConflictSideNames(repo);
      const { button, subject } = acceptLabels(yours, 'yours');
      const confirm = await vscode.window.showWarningMessage(
        `Accept ${subject} for ${conflicts.length} conflicted file(s)? The incoming side will be discarded.`,
        { modal: true },
        button
      );

      if (confirm !== button) {
        return;
      }

      const result = await conflictService.acceptAllCurrent(repo);
      if (result.success) {
        void vscode.window.showInformationMessage(`Accepted ${subject} for all conflicted files`);
      } else if (!result.skipped) {
        void vscode.window.showErrorMessage(result.error || `Failed to accept ${subject}`);
      }
    }
  );

  const acceptAllIncomingFilesCommand = registerLoggedCommand(
    'intellig.conflict.acceptAllIncoming',
    async () => {
      if (!ctx.services) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const conflictService = ctx.services.conflictResolutionService;
      const gitService = ctx.services.gitService;
      // prefer the active-editor's repo in multi-root workspaces.
      const repo = await resolveRepo(gitService, {
        preferActive: true,
      });
      if (!repo) {
        return;
      }
      const conflicts = await conflictService.getConflictedFiles(repo);

      if (conflicts.length === 0) {
        void vscode.window.showInformationMessage('No conflicted files found');
        return;
      }

      const { theirs } = await conflictService.getConflictSideNames(repo);
      const { button, subject } = acceptLabels(theirs, 'theirs');
      const confirm = await vscode.window.showWarningMessage(
        `Accept ${subject} for ${conflicts.length} conflicted file(s)? Your side will be discarded.`,
        { modal: true },
        button
      );

      if (confirm !== button) {
        return;
      }

      const result = await conflictService.acceptAllIncoming(repo);
      if (result.success) {
        void vscode.window.showInformationMessage(`Accepted ${subject} for all conflicted files`);
      } else if (!result.skipped) {
        void vscode.window.showErrorMessage(result.error || `Failed to accept ${subject}`);
      }
    }
  );

  const completeMergeCommand = registerLoggedCommand(
    'intellig.conflict.completeMerge',
    async () => {
      if (!ctx.services) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const conflictService = ctx.services.conflictResolutionService;
      const gitService = ctx.services.gitService;
      // prefer the active-editor's repo in multi-root workspaces.
      const repo = await resolveRepo(gitService, {
        preferActive: true,
      });
      if (!repo) {
        return;
      }

      // Check if we can complete
      const canComplete = await conflictService.canCompleteOperation(repo);
      if (!canComplete) {
        const conflicts = await conflictService.getConflictedFiles(repo);
        if (conflicts.length > 0) {
          void vscode.window.showErrorMessage(
            `Cannot complete merge: ${conflicts.length} unresolved conflict(s) remain`
          );
          return;
        }
      }

      const result = await conflictService.completeMerge(repo);
      if (result.success) {
        void vscode.window.showInformationMessage('Merge completed successfully');
      } else {
        void vscode.window.showErrorMessage(
          result.error ? sanitizeGitError(result.error) : 'Failed to complete merge'
        );
      }
    }
  );

  const completeRebaseCommand = registerLoggedCommand(
    'intellig.conflict.completeRebase',
    async () => {
      if (!ctx.services) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const conflictService = ctx.services.conflictResolutionService;
      const gitService = ctx.services.gitService;
      // prefer the active-editor's repo in multi-root workspaces.
      const repo = await resolveRepo(gitService, {
        preferActive: true,
      });
      if (!repo) {
        return;
      }

      // Check if we can complete
      const canComplete = await conflictService.canCompleteOperation(repo);
      if (!canComplete) {
        const conflicts = await conflictService.getConflictedFiles(repo);
        if (conflicts.length > 0) {
          void vscode.window.showErrorMessage(
            `Cannot continue rebase: ${conflicts.length} unresolved conflict(s) remain`
          );
          return;
        }
      }

      const result = await conflictService.completeRebase(repo);
      if (result.success) {
        void vscode.window.showInformationMessage('Rebase continued successfully');
      } else if (result.remainingConflicts && result.remainingConflicts.length > 0) {
        void vscode.window.showWarningMessage(
          `Rebase paused: ${result.remainingConflicts.length} more conflict(s) to resolve`
        );
      } else {
        void vscode.window.showErrorMessage(
          result.error ? sanitizeGitError(result.error) : 'Failed to continue rebase'
        );
      }
    }
  );

  const abortMergeCommand = registerLoggedCommand('intellig.conflict.abortMerge', async () => {
    if (!ctx.services) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }

    const conflictService = ctx.services.conflictResolutionService;
    const gitService = ctx.services.gitService;
    // prefer the active-editor's repo in multi-root workspaces.
    const repo = await resolveRepo(gitService, {
      preferActive: true,
    });
    if (!repo) {
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      'Abort the merge? The merge in progress is discarded and your working tree is restored to its pre-merge state.',
      { modal: true },
      'Abort Merge'
    );

    if (confirm !== 'Abort Merge') {
      return;
    }

    const result = await conflictService.abortMerge(repo);
    if (result.success) {
      void vscode.window.showInformationMessage('Merge aborted');
    } else {
      void vscode.window.showErrorMessage(
        result.error ? sanitizeGitError(result.error) : 'Failed to abort merge'
      );
    }
  });

  const abortRebaseCommand = registerLoggedCommand('intellig.conflict.abortRebase', async () => {
    if (!ctx.services) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }

    const conflictService = ctx.services.conflictResolutionService;
    const gitService = ctx.services.gitService;
    // prefer the active-editor's repo in multi-root workspaces.
    const repo = await resolveRepo(gitService, {
      preferActive: true,
    });
    if (!repo) {
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      'Abort the rebase? The rebase in progress is discarded and your working tree is restored to its pre-rebase state.',
      { modal: true },
      'Abort Rebase'
    );

    if (confirm !== 'Abort Rebase') {
      return;
    }

    const result = await conflictService.abortRebase(repo);
    if (result.success) {
      void vscode.window.showInformationMessage('Rebase aborted');
    } else {
      void vscode.window.showErrorMessage(
        result.error ? sanitizeGitError(result.error) : 'Failed to abort rebase'
      );
    }
  });

  // Interactive Rebase command — opens the unified Rebase dialog with the
  // Interactive checkbox pre-checked. `arg.onto` lets callers (e.g.
  // "Interactive Rebase from Here") preselect a commit/branch target; the
  // bare-palette invocation leaves it unset and the dialog defaults to the
  // first available branch. Branch selection lives in the dialog's Onto
  // dropdown, so this handler doesn't run its own QuickPick.
  const interactiveRebaseCommand = registerLoggedCommand(
    'intellig.rebase.interactive',
    async (arg?: { onto?: string }) => {
      if (!ctx.services) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const gitService = ctx.services.gitService;

      // Unified multi-root resolver.
      let repo = await resolveRepo(gitService, {
        preferActive: true,
        pickerTitle: 'Interactive Rebase — Choose Repository',
        pickerPlaceholder: 'Select a repository',
        silent: true,
      });

      if (!repo) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
          repo = await gitService.getRepository(workspaceFolders[0].uri);
        }
        if (!repo) {
          void vscode.window.showErrorMessage('No Git repository found in workspace');
          return;
        }
      }

      await ctx.openRebaseDialog({
        repo,
        onto: arg?.onto,
        interactiveDefault: true,
      });
    }
  );

  return [
    openMergeViewCommand,
    acceptCurrentCommand,
    acceptIncomingCommand,
    acceptBothCommand,
    acceptAllCurrentCommand,
    acceptAllIncomingCommand,
    nextConflictCommand,
    previousConflictCommand,
    markResolvedCommand,
    showResolveConflictsDialogCommand,
    rebaseSkipCommand,
    rebaseContinueCommand,
    rebaseAbortCommand,
    markFileResolvedCommand,
    acceptAllCurrentFilesCommand,
    acceptAllIncomingFilesCommand,
    completeMergeCommand,
    completeRebaseCommand,
    abortMergeCommand,
    abortRebaseCommand,
    interactiveRebaseCommand,
  ];
}
