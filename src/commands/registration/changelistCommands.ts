import * as vscode from 'vscode';
import { registerLoggedCommand } from '../../utils/logger';
import { resolveRepo } from '../../utils/resolveRepo';
import { sanitizeGitError } from '../../git-core/gitError';
import { ChangelistService } from '../../services';
import { commitChangelist, LAST_NO_VERIFY_STATE_KEY } from '../../commits/CommitDialog';
import { runBeforeCommitChecks } from '../../commits/CheckinChecks';
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

  // "Commit Only This Changelist" stages exactly the target changelist's
  // files (unstaging anything staged that the changelist doesn't own) and
  // commits them — git4idea's per-changelist commit
  // (GitCheckinEnvironment changelist→index mapping). The message is
  // gathered via an input box; before-commit checks run first so the same
  // safety net as the dialog applies. `--no-verify` is honored from the
  // persisted commit toggle so hook-bypass behaviour matches the dialog.
  const changelistCommitOnlyCommand = registerLoggedCommand(
    'intellig.changelist.commitOnly',
    async (changelistId?: string) => {
      if (!ctx.services || !changelistId) {
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

      const service = ctx.services.changelistService;
      const changelists = service.getChangelists(repo);
      const target = changelists.find((cl) => cl.id === changelistId);
      if (!target) {
        return;
      }
      if (target.files.length === 0) {
        void vscode.window.showInformationMessage(
          `Changelist '${target.name}' has no changes to commit.`
        );
        return;
      }

      const message = await vscode.window.showInputBox({
        prompt: `Commit message for '${target.name}' (${target.files.length} file${
          target.files.length === 1 ? '' : 's'
        })`,
        placeHolder: 'Enter commit message…',
        validateInput: (v) => (v && v.trim() ? undefined : 'Commit message cannot be empty'),
      });
      if (!message || !message.trim()) {
        return;
      }

      // Run the cheap before-commit checks (user.name, unresolved merge…)
      // unless the persisted --no-verify toggle bypasses them, mirroring
      // the dialog's gear-menu behaviour. `--no-verify` skips both git's
      // own hooks AND these IDE-side checks (same semantics).
      const noVerify =
        ctx.context.workspaceState.get<boolean>(LAST_NO_VERIFY_STATE_KEY, false) ?? false;
      if (!noVerify) {
        const proceed = await runBeforeCommitChecks(
          ctx.services.gitService,
          repo,
          target.files.map((f) => f.path)
        );
        if (!proceed) {
          return;
        }
      }

      const result = await commitChangelist(
        ctx.services.gitService,
        repo,
        changelists,
        changelistId,
        message.trim(),
        { noVerify }
      );

      if (!result.success) {
        void vscode.window.showErrorMessage(
          result.error ? `Commit failed: ${sanitizeGitError(result.error)}` : 'Commit failed'
        );
        return;
      }

      void vscode.window.showInformationMessage(
        `Committed ${(result.files ?? []).length} file(s) from '${target.name}'`
      );
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
