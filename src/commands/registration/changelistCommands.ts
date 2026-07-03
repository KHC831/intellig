import * as vscode from 'vscode';
import { sanitizeGitError } from '../../git-core/gitError';
import { ChangelistService } from '../../services';
import { commitChangelist, LAST_NO_VERIFY_STATE_KEY } from '../../commits/CommitDialog';
import { runBeforeCommitChecks } from '../../commits/CheckinChecks';
import type { ICommandContext } from './CommandContext';
import { registerRepoCommand } from './commandSpine';

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

/** Minimal changelist shape the pickers need (service-agnostic). */
interface IPickableChangelist {
  id: string;
  name: string;
  files: { path: string }[];
}

/**
 * Resolve the target changelist id for a palette invocation: the context
 * menus pass the id as the command argument, but Cmd+Shift+P passes nothing —
 * without this picker every id-guarded changelist command was a silent no-op
 * from the palette.
 */
async function pickChangelistId(
  changelists: readonly IPickableChangelist[],
  title: string
): Promise<string | undefined> {
  if (changelists.length === 0) {
    void vscode.window.showInformationMessage('No changelists found.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    changelists.map((cl) => ({
      label: cl.name,
      description: `${cl.files.length} file${cl.files.length === 1 ? '' : 's'}`,
      id: cl.id,
    })),
    { title, placeHolder: 'Select a changelist' }
  );
  return picked?.id;
}

/**
 * Palette fallback for "Move Files to Another Changelist…": multi-select the
 * files to move from across all changelists (the webview rows pass an
 * explicit file list instead).
 */
async function pickFilesToMove(
  changelists: readonly IPickableChangelist[]
): Promise<string[] | undefined> {
  const items = changelists.flatMap((cl) =>
    cl.files.map((f) => ({ label: f.path, description: cl.name }))
  );
  if (items.length === 0) {
    void vscode.window.showInformationMessage('No changed files to move.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Move Files to Another Changelist',
    placeHolder: 'Select files to move',
    canPickMany: true,
    matchOnDescription: true,
  });
  if (!picked || picked.length === 0) {
    return undefined;
  }
  return picked.map((p) => p.label);
}

export function registerChangelistCommands(ctx: ICommandContext): vscode.Disposable[] {
  /** Narrow the raw command argument to a changelist id, when present. */
  const idArg = (raw: unknown): string | undefined => (typeof raw === 'string' ? raw : undefined);

  const changelistNewCommand = registerRepoCommand(ctx, {
    id: 'intellig.changelist.new',
    failureTitle: 'Failed to create changelist',
    run: async ({ services, repo }) => {
      const name = await vscode.window.showInputBox({
        prompt: 'Enter new changelist name',
        validateInput: (v) => (v && v.trim() ? undefined : 'Name cannot be empty'),
      });
      if (!name) {
        return;
      }
      services.changelistService.createChangelist(repo, name.trim());
    },
  });

  const changelistSetActiveCommand = registerRepoCommand(ctx, {
    id: 'intellig.changelist.setActive',
    failureTitle: 'Failed to set active changelist',
    run: async ({ services, repo }, rawId) => {
      const service = services.changelistService;
      const targetId =
        idArg(rawId) ??
        (await pickChangelistId(service.getChangelists(repo), 'Set Active Changelist'));
      if (!targetId) {
        return;
      }
      await service.setActiveChangelist(repo, targetId);
    },
  });

  const changelistRenameCommand = registerRepoCommand(ctx, {
    id: 'intellig.changelist.rename',
    failureTitle: 'Failed to rename changelist',
    run: async ({ services, repo }, rawId) => {
      const service = services.changelistService;
      const targetId =
        idArg(rawId) ?? (await pickChangelistId(service.getChangelists(repo), 'Rename Changelist'));
      if (!targetId) {
        return;
      }
      const current = service.getChangelists(repo).find((cl) => cl.id === targetId);
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
      service.renameChangelist(repo, targetId, newName.trim());
    },
  });

  const changelistDeleteCommand = registerRepoCommand(ctx, {
    id: 'intellig.changelist.delete',
    failureTitle: 'Failed to delete changelist',
    run: async ({ services, repo }, rawId) => {
      const service = services.changelistService;
      const targetId =
        idArg(rawId) ?? (await pickChangelistId(service.getChangelists(repo), 'Remove Changelist'));
      if (!targetId) {
        return;
      }
      // A non-empty changelist gets a confirm — its files fall back to the
      // default changelist (no data loss, but the grouping is gone).
      const target = service.getChangelists(repo).find((cl) => cl.id === targetId);
      if (target && target.files.length > 0) {
        const confirm = await vscode.window.showWarningMessage(
          `Remove changelist '${target.name}'? Its ${target.files.length} file(s) will move to the default changelist.`,
          { modal: true },
          'Remove'
        );
        if (confirm !== 'Remove') {
          return;
        }
      }
      service.deleteChangelist(repo, targetId);
    },
  });

  const changelistEditDescriptionCommand = registerRepoCommand(ctx, {
    id: 'intellig.changelist.editDescription',
    failureTitle: 'Failed to update description',
    run: async ({ services, repo }, rawId) => {
      const service = services.changelistService;
      const targetId =
        idArg(rawId) ??
        (await pickChangelistId(service.getChangelists(repo), 'Edit Changelist Description'));
      if (!targetId) {
        return;
      }
      const current = service.getChangelists(repo).find((cl) => cl.id === targetId);
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
        service.setDescription(repo, targetId, newDescription);
      }
    },
  });

  const changelistMoveFilesToCommand = registerRepoCommand(ctx, {
    id: 'intellig.changelist.moveFilesTo',
    failureTitle: 'Failed to move files',
    run: async ({ services, repo }, rawFiles) => {
      const service = services.changelistService;
      const files = Array.isArray(rawFiles)
        ? rawFiles.filter((f): f is string => typeof f === 'string')
        : undefined;
      const toMove =
        files && files.length > 0 ? files : await pickFilesToMove(service.getChangelists(repo));
      if (!toMove || toMove.length === 0) {
        return;
      }
      const targets = service.getChangelists(repo).map((cl) => ({ label: cl.name, id: cl.id }));
      const picked = await vscode.window.showQuickPick(targets, {
        title: `Move ${toMove.length} file${toMove.length === 1 ? '' : 's'} to…`,
        placeHolder: 'Select target changelist',
      });
      if (!picked) {
        return;
      }
      service.moveToChangelist(repo, toMove, picked.id);
    },
  });

  // "Commit Only This Changelist" stages exactly the target changelist's
  // files (unstaging anything staged that the changelist doesn't own) and
  // commits them — git4idea's per-changelist commit
  // (GitCheckinEnvironment changelist→index mapping). The message is
  // gathered via an input box; before-commit checks run first so the same
  // safety net as the dialog applies. `--no-verify` is honored from the
  // persisted commit toggle so hook-bypass behaviour matches the dialog.
  const changelistCommitOnlyCommand = registerRepoCommand(ctx, {
    id: 'intellig.changelist.commitOnly',
    failureTitle: 'Commit failed',
    run: async ({ services, gitService, repo }, rawId) => {
      const service = services.changelistService;
      const changelists = service.getChangelists(repo);
      const targetId =
        idArg(rawId) ?? (await pickChangelistId(changelists, 'Commit Only This Changelist'));
      if (!targetId) {
        return;
      }
      const target = changelists.find((cl) => cl.id === targetId);
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
          gitService,
          repo,
          target.files.map((f) => f.path)
        );
        if (!proceed) {
          return;
        }
      }

      const result = await commitChangelist(
        gitService,
        repo,
        changelists,
        targetId,
        message.trim(),
        {
          noVerify,
        }
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
    },
  });

  const changelistShelveCommand = registerRepoCommand(ctx, {
    id: 'intellig.changelist.shelve',
    failureTitle: 'Failed to shelve changelist',
    run: async ({ services, repo }, rawId) => {
      const service = services.changelistService;
      const targetId =
        idArg(rawId) ?? (await pickChangelistId(service.getChangelists(repo), 'Shelve Changelist'));
      if (!targetId) {
        return;
      }
      const changelist = service.getChangelists(repo).find((cl) => cl.id === targetId);
      if (!changelist) {
        return;
      }
      const item = await services.shelfService.shelve(repo, changelist.name, {
        files: changelist.files.map((f) => f.path),
      });
      if (item.partialCleanupFailures && item.partialCleanupFailures.length > 0) {
        const count = item.partialCleanupFailures.length;
        const paths = item.partialCleanupFailures.join(', ');
        void vscode.window.showWarningMessage(
          `Shelved ${changelist.files.length} file(s) from '${changelist.name}', but ${count} file(s) could not be removed from your working tree and are still present: ${paths}`
        );
      } else {
        void vscode.window.showInformationMessage(
          `Shelved ${changelist.files.length} file(s) from '${changelist.name}'`
        );
      }
    },
  });

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
