import * as vscode from 'vscode';
import { registerLoggedCommand } from '../../utils/logger';
import { resolveRepo } from '../../utils/resolveRepo';
import { sanitizeGitError } from '../../git-core/gitError';
import { createStashView, createShelfView, type IRepository, type ShelfView } from '../../services';
import type { ICommandContext } from './CommandContext';

/**
 * Stash + shelf command handlers extracted verbatim from extension.ts's
 * registerCommands: intellig.stash, intellig.showStashList,
 * intellig.stash.branchFromStash, intellig.stash.rename, intellig.shelve,
 * intellig.shelve.silent, intellig.unshelve.silent,
 * intellig.shelve.importPatches, intellig.showShelfList.
 *
 * Reaches shared state through {@link ICommandContext}. The stashView /
 * shelfView singletons are lazily written back through the read/WRITE ctx
 * accessors (RULE E1). The module-private `_pickStashForAction` and
 * `_getShelfContext` helpers moved with their consuming handlers. Returns its
 * disposables; extension.ts owns the single push (RULE E4).
 */
export function registerStashShelfCommands(ctx: ICommandContext): vscode.Disposable[] {
  // Stash changes command
  const stashCommand = registerLoggedCommand('intellig.stash', async () => {
    if (!ctx.services) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }

    const gitService = ctx.services.gitService;

    // Resolve repo with active-editor preference.
    let repo = await resolveRepo(gitService, {
      preferActive: true,
      pickerTitle: 'Stash — Choose Repository',
      pickerPlaceholder: 'Select a repository',
      silent: true,
    });

    if (!repo) {
      // Discovery fallback when no cached repos exist yet.
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders && workspaceFolders.length > 0) {
        repo = await gitService.getRepository(workspaceFolders[0].uri);
      }
      if (!repo) {
        void vscode.window.showErrorMessage('No Git repository found in workspace');
        return;
      }
    }

    // Create stash view if not exists and show create dialog
    if (!ctx.stashView) {
      ctx.stashView = createStashView(gitService);
    }
    await ctx.stashView.showCreateDialog(repo);
  });

  // Show stash list command
  const showStashListCommand = registerLoggedCommand('intellig.showStashList', async () => {
    if (!ctx.services) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }

    const gitService = ctx.services.gitService;

    // Resolve repo with active-editor preference.
    const repo = await resolveRepo(gitService, {
      preferActive: true,
      pickerTitle: 'Stashes — Choose Repository',
      pickerPlaceholder: 'Select a repository',
    });
    if (!repo) {
      return;
    }

    // Create stash view if not exists and show it
    if (!ctx.stashView) {
      ctx.stashView = createStashView(gitService);
    }
    await ctx.stashView.show(repo);
  });

  // Create Branch from Stash — palette entry. Prompts the user to
  // pick a stash (QuickPick) and delegates into `StashView.branchFromStash`
  // which in turn prompts for the branch name.
  const stashBranchFromStashCommand = registerLoggedCommand(
    'intellig.stash.branchFromStash',
    async () => {
      const picked = await _pickStashForAction('Create branch from stash');
      if (!picked) {
        return;
      }
      await picked.view.branchFromStash(picked.stash.index);
    }
  );

  // Rename Stash — palette entry. Prompts the user to pick a stash,
  // then delegates into `StashView.renameStash` which prompts for the new
  // message.
  const stashRenameCommand = registerLoggedCommand('intellig.stash.rename', async () => {
    const picked = await _pickStashForAction('Rename stash');
    if (!picked) {
      return;
    }
    await picked.view.renameStash(picked.stash.index);
  });

  // Shelve changes command
  const shelveCommand = registerLoggedCommand('intellig.shelve', async () => {
    if (!ctx.services) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }

    const gitService = ctx.services.gitService;
    // prefer the active-editor's repo in multi-root workspaces.
    let repo = await resolveRepo(gitService, {
      preferActive: true,
      silent: true,
    });

    if (!repo) {
      // Fallback: discover the first workspace folder's repo (cold start).
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders && workspaceFolders.length > 0) {
        repo = await gitService.getRepository(workspaceFolders[0].uri);
        if (!repo) {
          void vscode.window.showErrorMessage('No Git repository found in workspace');
          return;
        }
      } else {
        void vscode.window.showErrorMessage('No workspace folder open');
        return;
      }
    }

    // Create shelf view if not exists and show shelve dialog
    if (!ctx.shelfView) {
      ctx.shelfView = createShelfView(
        ctx.services.shelfService,
        (r) => gitService.getStatus(r),
        undefined,
        ctx.services.changelistService
      );
    }
    await ctx.shelfView.showShelveDialog(repo);
  });

  // Helper — ensure shelf view exists and return current repo + view.
  // Kept local to the silent shelve/unshelve commands so we don't repeat the
  // boilerplate in each handler.
  async function _getShelfContext(): Promise<{ repo: IRepository; view: ShelfView } | undefined> {
    if (!ctx.services) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return undefined;
    }
    const gitService = ctx.services.gitService;
    // prefer the active-editor's repo in multi-root workspaces.
    let repo = await resolveRepo(gitService, {
      preferActive: true,
      silent: true,
    });
    if (!repo) {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders && workspaceFolders.length > 0) {
        const discovered = await gitService.getRepository(workspaceFolders[0].uri);
        if (!discovered) {
          void vscode.window.showErrorMessage('No Git repository found in workspace');
          return undefined;
        }
        repo = discovered;
      } else {
        void vscode.window.showErrorMessage('No workspace folder open');
        return undefined;
      }
    }
    if (!ctx.shelfView) {
      ctx.shelfView = createShelfView(
        ctx.services.shelfService,
        (r) => gitService.getStatus(r),
        ctx.services.conflictResolutionService,
        ctx.services.changelistService
      );
    }
    // ShelfView depends on _repository being set for several methods; the
    // easiest path is to call refresh() which seeds it via the public show()
    // path. Use show() lazily only if it hasn't been seeded yet.
    await ctx.shelfView.show(repo).catch(() => {
      // show() opens a QuickPick — we just want the repo binding side-effect.
      // If it fails, fall through; the command handlers will surface their own
      // errors.
    });
    return { repo, view: ctx.shelfView };
  }

  // Silent Shelve (Ctrl+Shift+H). Shelves the active changelist with no
  // dialog. Fallback name: "WIP <ISO timestamp>".
  const shelveSilentCommand = registerLoggedCommand('intellig.shelve.silent', async () => {
    if (!ctx.services) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }
    const gitService = ctx.services.gitService;
    // prefer the active-editor's repo in multi-root workspaces.
    let repo = await resolveRepo(gitService, {
      preferActive: true,
      silent: true,
    });
    if (!repo) {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        void vscode.window.showErrorMessage('No workspace folder open');
        return;
      }
      const discovered = await gitService.getRepository(workspaceFolders[0].uri);
      if (!discovered) {
        void vscode.window.showErrorMessage('No Git repository found in workspace');
        return;
      }
      repo = discovered;
    }

    const changelistService = ctx.services.changelistService;
    // Ensure the changelist store is in sync with git status before picking
    // the active changelist — otherwise a just-edited file may still live
    // under "default" when the user expects to capture it.
    // E2E spec src/test/e2e/suite/07.shelf.test.ts relies on this inline reconcile
    // to avoid awaiting the watcher+reconcile debounce chain. Do not remove without
    // updating the spec.
    await changelistService.reconcileWithGitStatus(repo);
    const active = await changelistService.getActiveChangelist(repo);

    if (active.files.length === 0) {
      void vscode.window.showInformationMessage(
        `No files in active changelist '${active.name}' to shelve.`
      );
      return;
    }

    const fallbackName = `WIP ${new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)}`;
    const name = active.isDefault ? fallbackName : active.name;

    try {
      const item = await ctx.services.shelfService.shelve(repo, name, {
        files: active.files.map((f) => f.path),
      });
      if (item.partialCleanupFailures && item.partialCleanupFailures.length > 0) {
        const count = item.partialCleanupFailures.length;
        const paths = item.partialCleanupFailures.join(', ');
        void vscode.window.showWarningMessage(
          `Shelved ${item.files.length} file(s) to '${item.name}', but ${count} file(s) could not be removed from your working tree and are still present: ${paths}`
        );
      } else {
        void vscode.window.showInformationMessage(
          `Shelved ${item.files.length} file(s) to '${item.name}'.`
        );
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Silent shelve failed: ${sanitizeGitError(errorMessage)}`
      );
    }
  });

  // Silent Unshelve (Ctrl+Alt+U). Applies the most-recent entry without
  // prompting. If multiple entries exist (all non-unshelved), shows a
  // QuickPick.
  const unshelveSilentCommand = registerLoggedCommand('intellig.unshelve.silent', async () => {
    const shelfCtx = await _getShelfContext();
    if (!shelfCtx) {
      return;
    }
    const active = ctx
      .services!.shelfService.getShelfItems(shelfCtx.repo)
      .filter((i) => i.unshelvedAt === undefined);
    if (active.length === 0) {
      void vscode.window.showInformationMessage('No shelf entries to unshelve.');
      return;
    }

    let targetId: string;
    if (active.length === 1) {
      targetId = active[0].id;
    } else {
      // Order newest-first for the QuickPick.
      const sorted = active.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
      const picked = await vscode.window.showQuickPick(
        sorted.map((i) => ({
          label: i.name,
          description: `${i.files.length} file${i.files.length === 1 ? '' : 's'} · ${i.timestamp.toLocaleString()}`,
          id: i.id,
        })),
        { title: 'Unshelve Silently', placeHolder: 'Select a shelf entry to apply' }
      );
      if (!picked) {
        return;
      }
      targetId = picked.id;
    }

    const result = await shelfCtx.view.unshelveSilent(targetId);
    if (!result.success && !result.conflicts) {
      // Non-conflict errors are already surfaced by unshelve(); no-op here.
    }
  });

  // Import patches into the shelf. Reachable via command palette and the
  // shelf list root action.
  const shelveImportPatchesCommand = registerLoggedCommand(
    'intellig.shelve.importPatches',
    async () => {
      const shelfCtx = await _getShelfContext();
      if (!shelfCtx) {
        return;
      }
      await shelfCtx.view.importPatches();
    }
  );

  // Show shelf list command
  const showShelfListCommand = registerLoggedCommand('intellig.showShelfList', async () => {
    if (!ctx.services) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }

    const gitService = ctx.services.gitService;
    // prefer the active-editor's repo in multi-root workspaces.
    const repo = await resolveRepo(gitService, {
      preferActive: true,
    });
    if (!repo) {
      // resolveRepo already surfaced the "No Git repository found" toast.
      return;
    }

    // Create shelf view if not exists and show it
    if (!ctx.shelfView) {
      ctx.shelfView = createShelfView(
        ctx.services.shelfService,
        (r) => gitService.getStatus(r),
        undefined,
        ctx.services.changelistService
      );
    }
    await ctx.shelfView.show(repo);
  });

  /**
   * Prompt the user to pick a stash for a palette-invoked action (Rename…,
   * Create Branch from Stash…). Returns both the picked stash and the active
   * StashView instance so the caller can delegate the action handling.
   *
   * Lazily creates the module-level `stashView` (like the other stash palette
   * entries). Returns `undefined` if no repo, no stashes, or user cancels.
   */
  async function _pickStashForAction(
    title: string
  ): Promise<
    | { view: import('../../services').StashView; stash: { index: number; message: string } }
    | undefined
  > {
    if (!ctx.services) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return undefined;
    }
    const gitService = ctx.services.gitService;
    const repos = gitService.getRepositories();
    if (repos.length === 0) {
      void vscode.window.showErrorMessage('No Git repository found');
      return undefined;
    }
    const repo = repos[0];

    // Ensure the shared StashView exists so state stays consistent with the
    // list view the user may already have open.
    if (!ctx.stashView) {
      ctx.stashView = createStashView(gitService, ctx.services.conflictResolutionService);
    }
    await ctx.stashView.show(repo);
    const state = ctx.stashView.getState();
    if (!state.stashes || state.stashes.length === 0) {
      void vscode.window.showInformationMessage('No stashes to choose from.');
      return undefined;
    }

    const items = state.stashes.map((item) => ({
      label: `stash@{${item.stash.index}}`,
      description: item.stash.message || 'No message',
      detail: item.stash.branch ? `on ${item.stash.branch}` : undefined,
      index: item.stash.index,
      message: item.stash.message ?? '',
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title,
      placeHolder: 'Select a stash',
    });
    if (!picked) {
      return undefined;
    }
    return {
      view: ctx.stashView,
      stash: { index: picked.index, message: picked.message },
    };
  }

  return [
    stashCommand,
    showStashListCommand,
    stashBranchFromStashCommand,
    stashRenameCommand,
    shelveCommand,
    shelveSilentCommand,
    unshelveSilentCommand,
    shelveImportPatchesCommand,
    showShelfListCommand,
  ];
}
