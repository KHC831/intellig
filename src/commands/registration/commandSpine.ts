/**
 * The command spine — the single wrapper every argument-taking command
 * handler registers through, carrying the invariants each handler used to
 * hand-roll (and, across ~130 copies, occasionally forget):
 *
 *  - the services guard (toast, never a crash on a cold invocation);
 *  - the explorer selection contract — VS Code invokes context commands as
 *    `(clickedUri, selectedUris[])`, and the WHOLE selection must be acted
 *    on, with the active editor as the palette fallback;
 *  - repository resolution through the shared {@link resolveRepo} chain
 *    (hint → defaultRepo config → active editor → single repo → picker);
 *  - repo-root-relative path derivation via {@link repoRelativePath};
 *  - unexpected failures surfaced as ONE sanitized toast built from the
 *    spec's failureTitle — a rejected handler can never be silent;
 *  - opt-in git-tool-window refresh after a successful mutation.
 *
 * Three scopes, three registration functions:
 *  - {@link registerSelectionCommand} — mutating multi-target commands
 *    (stage, revert, shelve-style): run receives every selected target.
 *  - {@link registerFileCommand} — single-target view commands (history,
 *    compare): run receives the clicked file only, by design.
 *  - {@link registerRepoCommand} — repo-level commands with no file
 *    argument; extra raw command arguments pass through to run.
 *
 * Handler bodies own only their OUTCOME logic (the git call, its
 * confirmation dialogs, and an honest success toast). Anything a body
 * throws is the spine's to report.
 */

import * as vscode from 'vscode';
import { registerLoggedCommand } from '../../utils/logger';
import { resolveRepo } from '../../utils/resolveRepo';
import { repoRelativePath } from '../../utils/repoRelativePath';
import { formatActionFailureToast } from '../../git-core/gitError';
import type { IRepository } from '../../git-core/interfaces/IGitService';
import type { ExtensionServices } from '../../services';
import type { ICommandContext } from './CommandContext';

/**
 * Resolve the file URI for an explorer-context command. Prefers the
 * explicitly-passed `fileUri`; falls back to the active editor's document
 * URI only when it is a `file:`-scheme document.
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

/** What every spine run receives: the guarded services + git service. */
export interface ISpineBaseArgs {
  services: ExtensionServices;
  gitService: ExtensionServices['gitService'];
}

/** Repo-scoped run arguments. */
export interface ISpineRepoArgs extends ISpineBaseArgs {
  repo: IRepository;
}

/** Selection-scoped run arguments: every selected target, repo-relative. */
export interface ISpineSelectionArgs extends ISpineRepoArgs {
  targets: vscode.Uri[];
  /** Repo-root-relative POSIX paths, index-aligned with `targets`. */
  paths: string[];
}

/** File-scoped run arguments: the clicked file only (view commands). */
export interface ISpineFileArgs extends ISpineRepoArgs {
  target: vscode.Uri;
  /** Repo-root-relative POSIX path of `target`. */
  path: string;
}

interface ISpineSpecBase {
  id: string;
  /** Toast prefix for an unexpected failure, e.g. `Failed to stage file`. */
  failureTitle: string;
  /** Repo QuickPick labels for multi-root disambiguation. */
  pickerTitle?: string;
  pickerPlaceholder?: string;
  /** Refresh the git tool window after a successful run. */
  refreshOnSuccess?: boolean;
}

export interface ISelectionCommandSpec extends ISpineSpecBase {
  /** Error toast when nothing is selected and no active editor applies. */
  noTargetMessage?: string;
  run: (args: ISpineSelectionArgs) => Promise<void>;
}

export interface IFileCommandSpec extends ISpineSpecBase {
  noTargetMessage?: string;
  run: (args: ISpineFileArgs) => Promise<void>;
}

export interface IRepoCommandSpec extends ISpineSpecBase {
  /**
   * Cold-start fallback: when the resolver finds no cached repository,
   * probe the first workspace folder before giving up — so invocations in
   * a brand-new workspace (no repos discovered yet) still work. The
   * resolver runs silent and this path owns the error toasts.
   */
  discoverFallback?: boolean;
  /**
   * When the first raw command argument is Uri-shaped, use its fsPath as
   * the repo-resolution hint (context-menu invocations that carry the
   * clicked file). The raw argument still reaches `run` untouched.
   */
  hintFromRawUri?: boolean;
  run: (args: ISpineRepoArgs, ...rawArgs: unknown[]) => Promise<void>;
}

/** Bare scope: services guard + failure backstop only (custom bodies). */
export interface IBareCommandSpec extends ISpineSpecBase {
  run: (args: ISpineBaseArgs, ...rawArgs: unknown[]) => Promise<void>;
}

function guardedServices(ctx: ICommandContext): ExtensionServices | undefined {
  if (!ctx.services) {
    void vscode.window.showErrorMessage('Extension services not initialized');
    return undefined;
  }
  return ctx.services;
}

async function resolveScopedRepo(
  services: ExtensionServices,
  spec: ISpineSpecBase & { discoverFallback?: boolean },
  hintRepoPath: string | undefined
): Promise<IRepository | undefined> {
  const repo = await resolveRepo(services.gitService, {
    hintRepoPath,
    preferActive: true,
    ...(spec.discoverFallback ? { silent: true } : {}),
    ...(spec.pickerTitle ? { pickerTitle: spec.pickerTitle } : {}),
    ...(spec.pickerPlaceholder ? { pickerPlaceholder: spec.pickerPlaceholder } : {}),
  });
  if (repo || !spec.discoverFallback) {
    return repo;
  }
  // Cold start: no cached repos yet — probe the first workspace folder.
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    void vscode.window.showErrorMessage('No workspace folder open');
    return undefined;
  }
  const discovered = await services.gitService.getRepository(folders[0].uri);
  if (!discovered) {
    void vscode.window.showErrorMessage('No Git repository found in workspace');
    return undefined;
  }
  return discovered;
}

async function runReported(
  ctx: ICommandContext,
  spec: ISpineSpecBase,
  body: () => Promise<void>
): Promise<void> {
  try {
    await body();
  } catch (error) {
    void vscode.window.showErrorMessage(formatActionFailureToast(spec.failureTitle, error));
    return;
  }
  if (spec.refreshOnSuccess) {
    ctx.gitToolWindowProvider?.refresh();
  }
}

/** Register a mutating multi-target command (whole explorer selection). */
export function registerSelectionCommand(
  ctx: ICommandContext,
  spec: ISelectionCommandSpec
): vscode.Disposable {
  return registerLoggedCommand(spec.id, async (fileUri?: vscode.Uri, selectedUris?: unknown) => {
    const services = guardedServices(ctx);
    if (!services) {
      return;
    }
    const targets = resolveExplorerSelection(
      fileUri,
      selectedUris,
      vscode.window.activeTextEditor?.document.uri
    );
    if (targets.length === 0) {
      void vscode.window.showErrorMessage(spec.noTargetMessage ?? 'No file selected');
      return;
    }
    const repo = await resolveScopedRepo(services, spec, targets[0].fsPath);
    if (!repo) {
      return;
    }
    const paths = targets.map((u) => repoRelativePath(repo.rootUri.fsPath, u.fsPath));
    await runReported(ctx, spec, () =>
      spec.run({ services, gitService: services.gitService, repo, targets, paths })
    );
  });
}

/** Register a single-target view command (the clicked file only). */
export function registerFileCommand(
  ctx: ICommandContext,
  spec: IFileCommandSpec
): vscode.Disposable {
  return registerLoggedCommand(spec.id, async (fileUri?: vscode.Uri) => {
    const services = guardedServices(ctx);
    if (!services) {
      return;
    }
    const target = resolveExplorerFileUri(fileUri, vscode.window.activeTextEditor?.document.uri);
    if (!target) {
      void vscode.window.showErrorMessage(spec.noTargetMessage ?? 'No file selected');
      return;
    }
    const repo = await resolveScopedRepo(services, spec, target.fsPath);
    if (!repo) {
      return;
    }
    const path = repoRelativePath(repo.rootUri.fsPath, target.fsPath);
    await runReported(ctx, spec, () =>
      spec.run({ services, gitService: services.gitService, repo, target, path })
    );
  });
}

/** Register a repo-level command; raw command arguments pass through. */
export function registerRepoCommand(
  ctx: ICommandContext,
  spec: IRepoCommandSpec
): vscode.Disposable {
  return registerLoggedCommand(spec.id, async (...rawArgs: unknown[]) => {
    const services = guardedServices(ctx);
    if (!services) {
      return;
    }
    const first = rawArgs[0];
    const hint =
      spec.hintFromRawUri &&
      first &&
      typeof first === 'object' &&
      typeof (first as { fsPath?: unknown }).fsPath === 'string'
        ? (first as { fsPath: string }).fsPath
        : undefined;
    const repo = await resolveScopedRepo(services, spec, hint);
    if (!repo) {
      return;
    }
    await runReported(ctx, spec, () =>
      spec.run({ services, gitService: services.gitService, repo }, ...rawArgs)
    );
  });
}

/**
 * Register a command whose body owns its own targeting (commit-pinned repo
 * resolution, blame contexts, multi-shape arguments): the spine contributes
 * the services guard and the failure-toast backstop.
 */
export function registerBareCommand(
  ctx: ICommandContext,
  spec: IBareCommandSpec
): vscode.Disposable {
  return registerLoggedCommand(spec.id, async (...rawArgs: unknown[]) => {
    const services = guardedServices(ctx);
    if (!services) {
      return;
    }
    await runReported(ctx, spec, () =>
      spec.run({ services, gitService: services.gitService }, ...rawArgs)
    );
  });
}
