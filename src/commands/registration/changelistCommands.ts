import * as vscode from 'vscode';
import { registerLoggedCommand } from '../../utils/logger';
import { resolveRepo } from '../../utils/resolveRepo';
import { sanitizeGitError } from '../../git-core/gitError';
import { ChangelistService } from '../../services';
import type { ICommandContext } from './CommandContext';

/**
 * Changelist command handlers (`intellig.changelist.*`) extracted verbatim
 * from extension.ts's registerCommands. These back the context menu in the
 * Commit tool window's Local Changes tab. Every handler routes through
 * `resolveRepo(preferActive)` so changelist ops in multi-root workspaces
 * target the repo owning the active editor, not an arbitrary
 * `repositories[0]`.
 *
 * Stateless — reaches shared state through {@link ICommandContext}; no
 * singleton write-back in this domain. Returns its disposables; extension.ts
 * owns the single `context.subscriptions.push(...)` (RULE E4).
 */
export function registerChangelistCommands(ctx: ICommandContext): vscode.Disposable[] {
  const changelistNewCommand = registerLoggedCommand('intellig.changelist.new', async () => {
    if (!ctx.services) {
      return;
    }
    const repo = await resolveRepo(ctx.services.gitService, {
      preferActive: true,
      silent: true,
    });
    if (!repo) {
      void vscode.window.showErrorMessage('No Git repository found');
      return;
    }
    const name = await vscode.window.showInputBox({
      prompt: 'Enter new changelist name',
      validateInput: (v) => (v && v.trim() ? undefined : 'Name cannot be empty'),
    });
    if (!name) {
      return;
    }
    try {
      ctx.services.changelistService.createChangelist(repo, name.trim());
    } catch (err) {
      const m = err instanceof Error ? err.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to create changelist: ${sanitizeGitError(m)}`);
    }
  });

  const changelistSetActiveCommand = registerLoggedCommand(
    'intellig.changelist.setActive',
    async (changelistId?: string) => {
      if (!ctx.services) {
        return;
      }
      const repo = await resolveRepo(ctx.services.gitService, {
        preferActive: true,
        silent: true,
      });
      if (!repo || !changelistId) {
        return;
      }
      try {
        await ctx.services.changelistService.setActiveChangelist(repo, changelistId);
      } catch (err) {
        const m = err instanceof Error ? err.message : 'Unknown error';
        void vscode.window.showErrorMessage(
          `Failed to set active changelist: ${sanitizeGitError(m)}`
        );
      }
    }
  );

  const changelistRenameCommand = registerLoggedCommand(
    'intellig.changelist.rename',
    async (changelistId?: string) => {
      if (!ctx.services) {
        return;
      }
      const repo = await resolveRepo(ctx.services.gitService, {
        preferActive: true,
        silent: true,
      });
      if (!repo || !changelistId) {
        return;
      }
      const current = ctx.services.changelistService
        .getChangelists(repo)
        .find((cl) => cl.id === changelistId);
      if (!current) {
        return;
      }
      const newName = await vscode.window.showInputBox({
        prompt: `Rename changelist '${current.name}' to:`,
        value: current.name,
        validateInput: (v) => (v && v.trim() ? undefined : 'Name cannot be empty'),
      });
      if (!newName || newName.trim() === current.name) {
        return;
      }
      try {
        ctx.services.changelistService.renameChangelist(repo, changelistId, newName.trim());
      } catch (err) {
        const m = err instanceof Error ? err.message : 'Unknown error';
        void vscode.window.showErrorMessage(`Failed to rename changelist: ${sanitizeGitError(m)}`);
      }
    }
  );

  const changelistDeleteCommand = registerLoggedCommand(
    'intellig.changelist.delete',
    async (changelistId?: string) => {
      if (!ctx.services) {
        return;
      }
      const repo = await resolveRepo(ctx.services.gitService, {
        preferActive: true,
        silent: true,
      });
      if (!repo || !changelistId) {
        return;
      }
      try {
        ctx.services.changelistService.deleteChangelist(repo, changelistId);
      } catch (err) {
        const m = err instanceof Error ? err.message : 'Unknown error';
        void vscode.window.showErrorMessage(`Failed to delete changelist: ${sanitizeGitError(m)}`);
      }
    }
  );

  const changelistEditDescriptionCommand = registerLoggedCommand(
    'intellig.changelist.editDescription',
    async (changelistId?: string) => {
      if (!ctx.services) {
        return;
      }
      const repo = await resolveRepo(ctx.services.gitService, {
        preferActive: true,
        silent: true,
      });
      if (!repo || !changelistId) {
        return;
      }
      const service = ctx.services.changelistService;
      const current = service.getChangelists(repo).find((cl) => cl.id === changelistId);
      if (!current) {
        return;
      }
      const newDescription = await vscode.window.showInputBox({
        prompt: `Edit description for '${current.name}'`,
        value: current.description ?? '',
      });
      if (newDescription === undefined) {
        return;
      }
      // setDescription is a ChangelistService-only addition.
      if (service instanceof ChangelistService) {
        try {
          service.setDescription(repo, changelistId, newDescription);
        } catch (err) {
          const m = err instanceof Error ? err.message : 'Unknown error';
          void vscode.window.showErrorMessage(
            `Failed to update description: ${sanitizeGitError(m)}`
          );
        }
      }
    }
  );

  const changelistMoveFilesToCommand = registerLoggedCommand(
    'intellig.changelist.moveFilesTo',
    async (files?: string[]) => {
      if (!ctx.services) {
        return;
      }
      const repo = await resolveRepo(ctx.services.gitService, {
        preferActive: true,
        silent: true,
      });
      if (!repo || !files || files.length === 0) {
        return;
      }
      const service = ctx.services.changelistService;
      const targets = service.getChangelists(repo).map((cl) => ({ label: cl.name, id: cl.id }));
      const picked = await vscode.window.showQuickPick(targets, {
        title: `Move ${files.length} file${files.length === 1 ? '' : 's'} to…`,
        placeHolder: 'Select target changelist',
      });
      if (!picked) {
        return;
      }
      try {
        service.moveToChangelist(repo, files, picked.id);
      } catch (err) {
        const m = err instanceof Error ? err.message : 'Unknown error';
        void vscode.window.showErrorMessage(`Failed to move files: ${sanitizeGitError(m)}`);
      }
    }
  );

  // "Commit Only This Changelist" and "Shelve Changelist" are MVP stubs that
  // surface a friendly message — the full wiring lands in follow-up work
  // alongside the actual commit/shelve flows consuming the changelist filter.
  const changelistCommitOnlyCommand = registerLoggedCommand(
    'intellig.changelist.commitOnly',
    async (changelistId?: string) => {
      if (!changelistId) {
        return;
      }
      void vscode.window.showInformationMessage(
        'Commit Only This Changelist — focuses the Commit tool window with the changelist pre-selected. Full filter arrives with the gear options.'
      );
      if (ctx.commitToolWindow) {
        await ctx.commitToolWindow.show();
      }
    }
  );

  const changelistShelveCommand = registerLoggedCommand(
    'intellig.changelist.shelve',
    async (changelistId?: string) => {
      if (!ctx.services || !changelistId) {
        return;
      }
      const repo = await resolveRepo(ctx.services.gitService, {
        preferActive: true,
        silent: true,
      });
      if (!repo) {
        return;
      }
      const changelist = ctx.services.changelistService
        .getChangelists(repo)
        .find((cl) => cl.id === changelistId);
      if (!changelist) {
        return;
      }
      try {
        await ctx.services.shelfService.shelve(repo, changelist.name, {
          files: changelist.files.map((f) => f.path),
        });
        void vscode.window.showInformationMessage(
          `Shelved ${changelist.files.length} file(s) from '${changelist.name}'`
        );
      } catch (err) {
        const m = err instanceof Error ? err.message : 'Unknown error';
        void vscode.window.showErrorMessage(`Failed to shelve changelist: ${sanitizeGitError(m)}`);
      }
    }
  );

  return [
    changelistNewCommand,
    changelistSetActiveCommand,
    changelistRenameCommand,
    changelistDeleteCommand,
    changelistEditDescriptionCommand,
    changelistMoveFilesToCommand,
    changelistCommitOnlyCommand,
    changelistShelveCommand,
  ];
}
