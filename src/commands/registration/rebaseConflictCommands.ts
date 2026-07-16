import * as vscode from 'vscode';
import { registerLoggedCommand } from '../../utils/logger';
import { resolveRepo } from '../../utils/resolveRepo';
import { repoRelativePath } from '../../utils/repoRelativePath';
import { sanitizeGitError } from '../../git-core/gitError';
import { AUTOSTASH_PARKED_WARNING } from '../../git-core/rebaseAutostash';
import { createMergeView } from '../../services';
import { inferReopenOperation } from '../../conflicts/conflictReversal';
import { acceptLabels } from '../../conflicts/conflictSideNames';
import { runUnresolveFlow } from '../../conflicts/unresolveFlow';
import { isConflictedStatus } from '../../git-core/gitParser';
import type { ICommandContext } from './CommandContext';
import { registerBareCommand, registerRepoCommand, registerSelectionCommand } from './commandSpine';

/**
 * Merge-editor, conflict-resolution, and rebase-recovery command handlers
 * (`intellig.merge.*`, `intellig.conflict.*`, `intellig.rebase.*`,
 * `intellig.showResolveConflictsDialog`).
 *
 * Registered through the command spine where the spine's semantics fit
 * (repo-scoped conflict/rebase flows); the merge-view octet stays on
 * registerLoggedCommand because it must work WITHOUT services (it acts only
 * on the MergeView singleton). Reaches shared state through
 * {@link ICommandContext}. The `ctx.mergeView` singleton (openMergeView) is
 * lazily written back here through the read/WRITE ctx accessor so the single
 * owner in extension.ts is mutated (RULE E1). Interactive rebase opens the
 * unified Rebase dialog via `ctx.openRebaseDialog` (the dialog owns the
 * rebase-editor lifecycle). Returns its disposables; extension.ts owns the
 * single push (RULE E4).
 */
export function registerRebaseConflictCommands(ctx: ICommandContext): vscode.Disposable[] {
  // Merge View commands. Bare scope: with a Uri argument the repo is never
  // needed; without one the body runs its own conflicted-file picker.
  const openMergeViewCommand = registerBareCommand(ctx, {
    id: 'intellig.merge.openMergeView',
    failureTitle: 'Failed to open merge view',
    run: async ({ gitService }, rawUri) => {
      const fileUri =
        rawUri &&
        typeof rawUri === 'object' &&
        typeof (rawUri as { fsPath?: unknown }).fsPath === 'string'
          ? (rawUri as vscode.Uri)
          : undefined;

      // Get the file to open in merge view
      let filePath: string;
      if (fileUri) {
        filePath = fileUri.fsPath;
      } else {
        // If no file provided, show a picker for conflicted files.
        // prefer the active-editor's repo in multi-root workspaces.
        const repo = await resolveRepo(gitService, {
          preferActive: true,
        });
        if (!repo) {
          return;
        }
        const status = await gitService.getStatus(repo);
        const conflictedFiles = status.filter(isConflictedStatus);

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
        ctx.mergeView = createMergeView(ctx.context.extensionUri, gitService);
      }

      await ctx.mergeView.show(filePath);
    },
  });

  // spine-exempt: acts only on the MergeView singleton, deliberately usable without services
  const markResolvedCommand = registerLoggedCommand('intellig.merge.markResolved', async () => {
    if (ctx.mergeView) {
      await ctx.mergeView.markResolved();
    } else {
      // The MergeView singleton is created lazily on the first Open Merge
      // View; say so instead of silently doing nothing.
      void vscode.window.showInformationMessage(
        'No merge view is open — run "IntelliG: Open Merge View" on a conflicted file first.'
      );
    }
  });

  // Conflict Resolution commands
  // Manual entry point for re-opening the Resolve Conflicts dialog. Used by
  // the status-bar "Unresolved conflicts — click to resolve" prompt and by
  // the VCS menu `Resolve Conflicts…` item (contributed elsewhere).
  const showResolveConflictsDialogCommand = registerRepoCommand(ctx, {
    id: 'intellig.showResolveConflictsDialog',
    failureTitle: 'Failed to open the Resolve Conflicts dialog',
    run: async ({ services, repo }) => {
      const conflictService = services.conflictResolutionService;
      const conflicts = await conflictService.getConflictedFiles(repo);
      // Read the state off a RELOADED repo: the cached object trails the
      // 250ms watcher debounce, and a user can click faster than that.
      const fresh = (await services.gitService.reloadRepository(repo)) ?? repo;
      const state = conflictService.getRepositoryState(fresh);
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
    },
  });

  // Palette entry point — Skip This Commit during an in-progress rebase.
  // Gated by the same `intellig.conflicts.active` context key the status-bar
  // prompt uses, so it only appears while a rebase is paused on conflicts.
  // Destructive; single confirm matches the dialog button.
  const rebaseSkipCommand = registerRepoCommand(ctx, {
    id: 'intellig.rebase.skip',
    failureTitle: 'Failed to skip commit',
    run: async ({ services, gitService, repo }) => {
      const conflictService = services.conflictResolutionService;
      // Guard against the STALE cache, not just the state: the repo object
      // trails the 250ms watcher debounce, and "rebase paused" is exactly
      // when a user clicks fastest. Reload before deciding to refuse.
      const fresh = (await gitService.reloadRepository(repo)) ?? repo;
      const state = conflictService.getRepositoryState(fresh);
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
        ctx.gitToolWindowProvider?.refresh();
        return;
      }
      void vscode.window.showInformationMessage('Commit skipped.');
      // rebaseSkip moved HEAD; reload + refresh so the log graph reflects
      // the new rebase position rather than the pre-skip one.
      await gitService.reloadRepository(repo);
      ctx.gitToolWindowProvider?.refresh();
    },
  });

  // Palette + activation-warning entry points for `git rebase --continue`
  // and `git rebase --abort`. Together with the pre-existing
  // `intellig.rebase.skip`, these are the three commands the
  // activation-time rebase-paused warning toast can route the user to.
  // If any of the three is unregistered, the warning toast falls back to
  // a button-less generic message.
  const rebaseContinueCommand = registerRepoCommand(ctx, {
    id: 'intellig.rebase.continue',
    failureTitle: 'Failed to continue rebase',
    run: async ({ services, gitService, repo }) => {
      const conflictService = services.conflictResolutionService;
      // Guard against the STALE cache, not just the state: the repo object
      // trails the 250ms watcher debounce, and "rebase paused" is exactly
      // when a user clicks fastest. Reload before deciding to refuse.
      const fresh = (await gitService.reloadRepository(repo)) ?? repo;
      const state = conflictService.getRepositoryState(fresh);
      if (state !== 'rebasing') {
        void vscode.window.showInformationMessage(
          'Rebase --continue is only available while a rebase is in progress.'
        );
        return;
      }

      const res = await gitService.rebaseContinue(repo);
      if (res.success) {
        void vscode.window.showInformationMessage('Rebase continued successfully.');
        if (res.autostashParked) {
          void vscode.window.showWarningMessage(AUTOSTASH_PARKED_WARNING);
        }
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
      ctx.gitToolWindowProvider?.refresh();
    },
  });

  const rebaseAbortCommand = registerRepoCommand(ctx, {
    id: 'intellig.rebase.abort',
    failureTitle: 'Failed to abort rebase',
    run: async ({ services, gitService, repo }) => {
      const conflictService = services.conflictResolutionService;
      // Same stale-cache guard as --skip/--continue above.
      const fresh = (await gitService.reloadRepository(repo)) ?? repo;
      const state = conflictService.getRepositoryState(fresh);
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

      // Route through RebaseService.abortRebase (not the raw BranchOps
      // rebaseAbort): it tolerates the "no rebase in progress" phantom,
      // clears any cached session, and reports whether git parked a
      // conflicting autostash.
      const { autostashParked } = await services.rebaseService.abortRebase(repo);
      void vscode.window.showInformationMessage('Rebase aborted.');
      if (autostashParked) {
        void vscode.window.showWarningMessage(AUTOSTASH_PARKED_WARNING);
      }
      await gitService.reloadRepository(repo);
      ctx.gitToolWindowProvider?.refresh();
    },
  });

  // Recovery commands for a paused `git am` session (a failed multi-commit
  // mailbox apply). Mirror the rebase recovery trio above — same stale-cache
  // guard, same confirm policy — but route through PatchService's am ops:
  // git refuses `rebase --continue/--abort` during am (and vice versa), so
  // the two triples must never cross. The paused-operation warning toast and
  // the Apply Patch dialog's failure arm both point here.
  const amContinueCommand = registerRepoCommand(ctx, {
    id: 'intellig.am.continue',
    failureTitle: 'Failed to continue patch apply',
    run: async ({ services, gitService, repo }) => {
      const conflictService = services.conflictResolutionService;
      const fresh = (await gitService.reloadRepository(repo)) ?? repo;
      if (conflictService.getRepositoryState(fresh) !== 'applying') {
        void vscode.window.showInformationMessage(
          'Continue Patch Apply is only available while a patch apply (git am) is in progress.'
        );
        return;
      }

      const res = await services.patchService.amContinue(repo);
      if (res.success) {
        void vscode.window.showInformationMessage('Patch apply continued successfully.');
      } else if (res.conflicts && res.conflicts.length > 0) {
        // The next mailbox patch collided — hand the new file set to the
        // Resolve Conflicts dialog so the user can keep going.
        await conflictService.openResolveConflictsDialog(repo, res.conflicts, {
          operation: 'applyPatch',
          canAbort: true,
          canContinue: true,
        });
      } else {
        const reason = res.failureReason ?? 'unknown error (no output from git)';
        void vscode.window.showErrorMessage(
          `Failed to continue patch apply: ${sanitizeGitError(reason)}`
        );
      }
      await gitService.reloadRepository(repo);
      ctx.gitToolWindowProvider?.refresh();
    },
  });

  const amSkipCommand = registerRepoCommand(ctx, {
    id: 'intellig.am.skip',
    failureTitle: 'Failed to skip patch',
    run: async ({ services, gitService, repo }) => {
      const conflictService = services.conflictResolutionService;
      const fresh = (await gitService.reloadRepository(repo)) ?? repo;
      if (conflictService.getRepositoryState(fresh) !== 'applying') {
        void vscode.window.showInformationMessage(
          'Skip Patch is only available while a patch apply (git am) is in progress.'
        );
        return;
      }

      const choice = await vscode.window.showWarningMessage(
        'Skip this patch? Its changes will NOT be applied.',
        { modal: true },
        'Skip'
      );
      if (choice !== 'Skip') {
        return;
      }

      const res = await services.patchService.amSkip(repo);
      if (res.success) {
        void vscode.window.showInformationMessage('Patch skipped.');
      } else if (res.conflicts && res.conflicts.length > 0) {
        await conflictService.openResolveConflictsDialog(repo, res.conflicts, {
          operation: 'applyPatch',
          canAbort: true,
          canContinue: true,
        });
      } else {
        const reason = res.failureReason ?? 'unknown error (no output from git)';
        void vscode.window.showErrorMessage(`Failed to skip patch: ${sanitizeGitError(reason)}`);
      }
      await gitService.reloadRepository(repo);
      ctx.gitToolWindowProvider?.refresh();
    },
  });

  const amAbortCommand = registerRepoCommand(ctx, {
    id: 'intellig.am.abort',
    failureTitle: 'Failed to abort patch apply',
    run: async ({ services, gitService, repo }) => {
      const conflictService = services.conflictResolutionService;
      const fresh = (await gitService.reloadRepository(repo)) ?? repo;
      if (conflictService.getRepositoryState(fresh) !== 'applying') {
        void vscode.window.showInformationMessage(
          'Abort Patch Apply is only available while a patch apply (git am) is in progress.'
        );
        return;
      }

      const choice = await vscode.window.showWarningMessage(
        'Abort the patch apply? Your working tree will be restored to its pre-apply state.',
        { modal: true },
        'Abort'
      );
      if (choice !== 'Abort') {
        return;
      }

      const res = await services.patchService.amAbort(repo);
      if (res.success) {
        void vscode.window.showInformationMessage('Patch apply aborted.');
      } else {
        const reason = res.failureReason ?? 'unknown error (no output from git)';
        void vscode.window.showErrorMessage(
          `Failed to abort patch apply: ${sanitizeGitError(reason)}`
        );
      }
      await gitService.reloadRepository(repo);
      ctx.gitToolWindowProvider?.refresh();
    },
  });

  const markFileResolvedCommand = registerRepoCommand(ctx, {
    id: 'intellig.conflict.markResolved',
    failureTitle: 'Failed to mark file as resolved',
    // prefer the fileUri's repo (context-menu invocations), falling back to
    // the active-editor's repo in multi-root workspaces.
    hintFromRawUri: true,
    run: async ({ services, repo }, rawUri) => {
      const conflictService = services.conflictResolutionService;
      const fileUri =
        rawUri &&
        typeof rawUri === 'object' &&
        typeof (rawUri as { fsPath?: unknown }).fsPath === 'string'
          ? (rawUri as vscode.Uri)
          : undefined;

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
    },
  });

  // Un-Resolve File — the inverse of markResolved: send a mis-resolved file
  // back to conflicted state (`git checkout --merge`) so the resolution can
  // be redone. No git4idea equivalent; rides on git's resolve-undo data.
  const unresolveCommand = registerSelectionCommand(ctx, {
    id: 'intellig.conflict.unresolve',
    failureTitle: 'Failed to un-resolve file',
    noTargetMessage: 'No file selected — open or select the file to un-resolve',
    refreshOnSuccess: true,
    run: async ({ services, repo, paths }) => {
      await runUnresolveFlow(
        {
          repo,
          conflictService: services.conflictResolutionService,
          showInformationMessage: (msg) => vscode.window.showInformationMessage(msg),
          showErrorMessage: (msg) => vscode.window.showErrorMessage(msg),
        },
        paths
      );
    },
  });

  const acceptAllCurrentFilesCommand = registerRepoCommand(ctx, {
    id: 'intellig.conflict.acceptAllCurrent',
    failureTitle: 'Failed to accept all current',
    run: async ({ services, repo }) => {
      const conflictService = services.conflictResolutionService;
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
    },
  });

  const acceptAllIncomingFilesCommand = registerRepoCommand(ctx, {
    id: 'intellig.conflict.acceptAllIncoming',
    failureTitle: 'Failed to accept all incoming',
    run: async ({ services, repo }) => {
      const conflictService = services.conflictResolutionService;
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
    },
  });

  const completeMergeCommand = registerRepoCommand(ctx, {
    id: 'intellig.conflict.completeMerge',
    failureTitle: 'Failed to complete merge',
    run: async ({ services, repo }) => {
      const conflictService = services.conflictResolutionService;
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
    },
  });

  const completeRebaseCommand = registerRepoCommand(ctx, {
    id: 'intellig.conflict.completeRebase',
    failureTitle: 'Failed to continue rebase',
    run: async ({ services, repo }) => {
      const conflictService = services.conflictResolutionService;
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
    },
  });

  const abortMergeCommand = registerRepoCommand(ctx, {
    id: 'intellig.conflict.abortMerge',
    failureTitle: 'Failed to abort merge',
    run: async ({ services, repo }) => {
      const conflictService = services.conflictResolutionService;
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
    },
  });

  const abortRebaseCommand = registerRepoCommand(ctx, {
    id: 'intellig.conflict.abortRebase',
    failureTitle: 'Failed to abort rebase',
    run: async ({ services, repo }) => {
      const conflictService = services.conflictResolutionService;
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
    },
  });

  // Interactive Rebase command — opens the unified Rebase dialog with the
  // Interactive checkbox pre-checked. `arg.onto` lets callers (e.g.
  // "Interactive Rebase from Here") preselect a commit/branch target; the
  // bare-palette invocation leaves it unset and the dialog defaults to the
  // first available branch. Branch selection lives in the dialog's Onto
  // dropdown, so this handler doesn't run its own QuickPick.
  const interactiveRebaseCommand = registerRepoCommand(ctx, {
    id: 'intellig.rebase.interactive',
    failureTitle: 'Failed to open the rebase dialog',
    pickerTitle: 'Interactive Rebase — Choose Repository',
    pickerPlaceholder: 'Select a repository',
    discoverFallback: true,
    run: async ({ repo }, arg) => {
      const onto =
        arg && typeof arg === 'object' && typeof (arg as { onto?: unknown }).onto === 'string'
          ? (arg as { onto: string }).onto
          : undefined;
      await ctx.openRebaseDialog({
        repo,
        onto,
        interactiveDefault: true,
      });
    },
  });

  return [
    openMergeViewCommand,
    markResolvedCommand,
    showResolveConflictsDialogCommand,
    rebaseSkipCommand,
    rebaseContinueCommand,
    rebaseAbortCommand,
    amContinueCommand,
    amSkipCommand,
    amAbortCommand,
    markFileResolvedCommand,
    unresolveCommand,
    acceptAllCurrentFilesCommand,
    acceptAllIncomingFilesCommand,
    completeMergeCommand,
    completeRebaseCommand,
    abortMergeCommand,
    abortRebaseCommand,
    interactiveRebaseCommand,
  ];
}
