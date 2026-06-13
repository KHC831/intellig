import * as vscode from 'vscode';
import { resolveRepo } from '../../utils/resolveRepo';
import { sanitizeGitError } from '../../git-core/gitError';
import type { IGitService, IRepository } from '../../services';
import type { ICommandContext } from './CommandContext';

/**
 * Shared helpers for the commit-menu + commit/repo-core command modules.
 * Pure utilities take no context; stateful helpers take `ICommandContext`
 * as a parameter (the context is for shared mutable singletons, not a junk
 * drawer for domain utilities). `runNewTagFlow` / `validateTagName` /
 * `INewTagFlowDeps` are relocated here verbatim from extension.ts (by-name
 * test seams) and re-exported from extension.ts so `newTag.test.ts`'s import
 * path is preserved (RULE E2). This file never imports extension.ts.
 */

/**
 * Extract a commit hash from a context-menu argument. Accepts strings,
 * objects with `{ hash }`, or undefined.
 */
export function extractCommitHash(arg: unknown): string | undefined {
  if (!arg) {
    return undefined;
  }
  if (typeof arg === 'string') {
    return arg;
  }
  if (typeof arg === 'object' && arg !== null) {
    const obj = arg as { hash?: unknown; commit?: unknown };
    if (typeof obj.hash === 'string') {
      return obj.hash;
    }
    if (typeof obj.commit === 'string') {
      return obj.commit;
    }
  }
  return undefined;
}

/**
 * Resolve a single repository to operate on for a commit-context action.
 * Single-repo workspaces are auto-selected; multi-repo shows a QuickPick.
 */
export async function pickRepositoryForCommit(
  ctx: ICommandContext
): Promise<IRepository | undefined> {
  if (!ctx.services) {
    void vscode.window.showErrorMessage('Extension services not initialized');
    return undefined;
  }
  const gitService = ctx.services.gitService;
  const repos = gitService.getRepositories();
  if (repos.length === 0) {
    void vscode.window.showErrorMessage('No Git repository found in workspace');
    return undefined;
  }
  if (repos.length === 1) {
    return repos[0];
  }
  const items = repos.map((r) => ({
    label: r.rootUri.fsPath.split(/[\\/]/).filter(Boolean).pop() ?? r.rootUri.fsPath,
    description: r.rootUri.fsPath,
    repo: r,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Choose Repository',
    placeHolder: 'Select a repository',
  });
  return picked?.repo;
}

/**
 * Pick a repository for the New Tag flow. Returns `undefined` if the user
 * cancels or no repository is available.
 */
export async function pickRepositoryForTag(ctx: ICommandContext): Promise<IRepository | undefined> {
  if (!ctx.services) {
    void vscode.window.showErrorMessage('Extension services not initialized');
    return undefined;
  }
  // Delegate to the unified resolver so `intellig.defaultRepo` and the
  // active-editor heuristic apply here too.
  return resolveRepo(ctx.services.gitService, {
    preferActive: true,
    pickerTitle: 'Create Tag — Choose Repository',
    pickerPlaceholder: 'Select a repository',
  });
}

/**
 * Validate a git tag name using a subset of git-check-ref-format rules.
 * Returns an error message when invalid, `undefined` when valid.
 */
export function validateTagName(name: string): string | undefined {
  if (!name || name.trim().length === 0) {
    return 'Tag name cannot be empty';
  }
  if (/\s/.test(name)) {
    return 'Tag name cannot contain whitespace';
  }
  if (/[~^:?*[\\]/.test(name)) {
    return 'Tag name cannot contain any of ~ ^ : ? * [ \\';
  }
  if (name.includes('..')) {
    return 'Tag name cannot contain consecutive dots';
  }
  if (name.startsWith('-') || name.startsWith('.') || name.startsWith('/')) {
    return 'Tag name cannot start with -, ., or /';
  }
  if (name.endsWith('.') || name.endsWith('/') || name.endsWith('.lock')) {
    return 'Tag name cannot end with ., /, or .lock';
  }
  // Control characters
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return 'Tag name cannot contain control characters';
    }
  }
  return undefined;
}

/**
 * Dependencies for the New Tag flow. Kept as a discrete object so tests can
 * exercise the flow without needing full extension activation.
 */
export interface INewTagFlowDeps {
  /** The repository to tag against. */
  repo: IRepository;
  /** Git service used to create the tag. */
  gitService: IGitService;
  /**
   * Prompt helper compatible with `vscode.window.showInputBox`. Returning
   * `undefined` means the user cancelled.
   */
  showInputBox: (options: vscode.InputBoxOptions) => Thenable<string | undefined>;
  /** Info-toast helper (`vscode.window.showInformationMessage` shape). */
  showInformationMessage: (message: string) => Thenable<string | undefined>;
  /** Error-toast helper (`vscode.window.showErrorMessage` shape). */
  showErrorMessage: (message: string) => Thenable<string | undefined>;
  /** Optional refresh hook invoked on success. */
  onTagCreated?: () => void;
}

/**
 * Pure (dependency-injected) implementation of the New Tag flow. Prompts
 * for a tag name, then an optional annotation message, then creates the
 * tag against `targetRef` (or HEAD when `targetRef` is undefined).
 *
 * Exported so unit tests can exercise the flow without activating the
 * extension.
 */
export async function runNewTagFlow(
  deps: INewTagFlowDeps,
  targetRef: string | undefined
): Promise<void> {
  const name = await deps.showInputBox({
    title: 'Create Tag',
    prompt: 'Tag name',
    placeHolder: 'e.g., v1.0.0',
    validateInput: (value: string) => validateTagName(value),
  });
  if (!name) {
    return;
  }

  const message = await deps.showInputBox({
    title: 'Create Tag',
    prompt: 'Optional annotation message (leave empty for a lightweight tag)',
    placeHolder: 'e.g., Release 1.0',
  });
  if (message === undefined) {
    // User pressed Escape on the message prompt.
    return;
  }

  try {
    const normalizedMessage = message.trim().length > 0 ? message : undefined;
    await deps.gitService.createTag(deps.repo, name, normalizedMessage, targetRef);
    void deps.showInformationMessage(`Created tag: ${name}`);
    if (deps.onTagCreated) {
      deps.onTagCreated();
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    void deps.showErrorMessage(`Failed to create tag: ${sanitizeGitError(msg)}`);
  }
}

/**
 * Extension-level wrapper: picks a repository, wires the real VS Code window
 * helpers, then delegates to `runNewTagFlow`. Takes `ICommandContext` so it
 * can reach the live services + provider for the post-create refresh.
 */
export async function runNewTagFlowFromContext(
  ctx: ICommandContext,
  targetRef: string | undefined
): Promise<void> {
  const repo = await pickRepositoryForTag(ctx);
  if (!repo || !ctx.services) {
    return;
  }
  const services = ctx.services;
  await runNewTagFlow(
    {
      repo,
      gitService: services.gitService,
      showInputBox: (options) => vscode.window.showInputBox(options),
      showInformationMessage: (msg) => vscode.window.showInformationMessage(msg),
      showErrorMessage: (msg) => vscode.window.showErrorMessage(msg),
      onTagCreated: () => {
        // createTag added a ref that drives the
        // tag tree + log-graph tag chip; reload before refresh so the
        // panel reads the post-mutation tag set.
        void (async (): Promise<void> => {
          await services.gitService.reloadRepository(repo);
          if (ctx.gitToolWindowProvider) {
            ctx.gitToolWindowProvider.refresh();
          }
        })();
      },
    },
    targetRef
  );
}
