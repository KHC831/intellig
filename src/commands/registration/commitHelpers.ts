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
 * Resolve the repository that CONTAINS `hash`, NON-interactively.
 *
 * For a commit-scoped action (diff/compare/apply) the target repo is determined
 * by the commit, not the user. {@link pickRepositoryForCommit} prompts with a
 * blind "Choose Repository" QuickPick in a multi-repo workspace and never
 * verifies the pick holds the commit — so a wrong pick runs the op against a
 * repo without the commit and yields a BLANK diff / empty result. This resolver
 * mirrors `resolveRepoForCommitDiff` (registration/wiring.ts): single-repo is
 * auto-selected; multi-repo returns the first repo whose `getCommit(hash)`
 * succeeds; and it surfaces an error (rather than prompting) when no open repo
 * contains the commit.
 */
export async function resolveRepoContainingCommit(
  ctx: ICommandContext,
  hash: string
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
  for (const repo of repos) {
    try {
      await gitService.getCommit(repo, hash);
      return repo;
    } catch {
      // Commit not in this repo — keep looking, never prompt blindly. Mirrors
      // resolveRepoForCommitDiff's contains() probe (wiring.ts).
      continue;
    }
  }
  void vscode.window.showErrorMessage(
    `Could not find the repository containing commit ${hash.substring(0, 7)}.`
  );
  return undefined;
}

/**
 * Resolve a single repository to operate on for a commit-context action.
 * Single-repo workspaces are auto-selected; multi-repo shows a QuickPick.
 * Prefer {@link resolveRepoContainingCommit} for commit-scoped actions where
 * the repo is determined by the commit (this blind picker has no commit
 * context, so a multi-repo pick can target the wrong repo).
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
 * Resolve a repository from an explicit on-disk root hint, or `undefined` when
 * no usable hint is supplied. Threaded through from the merged "all roots" log
 * commit menu so a commit-context action targets the CLICKED commit's OWN repo
 * instead of re-prompting / re-resolving by the active editor. A non-string /
 * empty hint, or a root that no longer resolves to an open repo, yields
 * `undefined` so callers fall back to their existing resolution.
 */
async function repoFromRootHint(
  ctx: ICommandContext,
  repoRootArg?: unknown
): Promise<IRepository | undefined> {
  const root = typeof repoRootArg === 'string' && repoRootArg.length > 0 ? repoRootArg : undefined;
  if (!root || !ctx.services) {
    return undefined;
  }
  return ctx.services.gitService.getRepository(vscode.Uri.file(root));
}

/**
 * Resolve the repository for a commit-context action, preferring an explicit
 * repo-root hint (the merged-log clicked-commit's own root) when present and
 * falling back to {@link pickRepositoryForCommit} otherwise.
 */
export async function resolveRepoForCommit(
  ctx: ICommandContext,
  repoRootArg?: unknown
): Promise<IRepository | undefined> {
  return (await repoFromRootHint(ctx, repoRootArg)) ?? pickRepositoryForCommit(ctx);
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
 * Validate the commit/ref typed into the New Tag flow's commit field
 * (GitTagDialog's commit text field). An empty value tags HEAD, so it is
 * accepted. A ref carrying whitespace, or one starting with `-` (which git
 * would parse as a CLI flag), is rejected at the UI boundary as defense in
 * depth — the op layer also splices `--end-of-options` before the ref.
 * Returns an error message when invalid, `undefined` when valid.
 */
export function validateCommitRef(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (/\s/.test(trimmed)) {
    return 'Commit or ref cannot contain whitespace';
  }
  if (trimmed.startsWith('-')) {
    return 'Commit or ref cannot start with -';
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
  /**
   * Modal warning helper (`vscode.window.showWarningMessage` shape) used for
   * the overwrite-existing-tag prompt. Optional for back-compat; when absent,
   * the flow surfaces the "already exists" error instead of offering force.
   */
  showWarningMessage?: (
    message: string,
    options: { modal: boolean },
    ...items: string[]
  ) => Thenable<string | undefined>;
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

  // Mirror GitTagDialog's commit field: when the caller did not pin a target
  // (palette flow), let the user choose the commit/ref to tag. A blank value
  // tags HEAD, exactly like leaving GitTagDialog's commit field empty. When a
  // ref was supplied (log commit context menu), skip the prompt — the commit
  // is already chosen.
  let ref = targetRef;
  if (ref === undefined) {
    const commit = await deps.showInputBox({
      title: 'Create Tag',
      prompt: 'Commit to tag (leave empty for HEAD)',
      placeHolder: 'e.g., HEAD, a branch name, or a commit hash',
      validateInput: (value: string) => validateCommitRef(value),
    });
    if (commit === undefined) {
      // User pressed Escape on the commit prompt.
      return;
    }
    const trimmedCommit = commit.trim();
    ref = trimmedCommit.length > 0 ? trimmedCommit : undefined;
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

  const normalizedMessage = message.trim().length > 0 ? message : undefined;
  try {
    await deps.gitService.createTag(deps.repo, name, normalizedMessage, ref).match(
      () => undefined,
      (e) => {
        throw e;
      }
    );
    void deps.showInformationMessage(`Created tag: ${name}`);
    if (deps.onTagCreated) {
      deps.onTagCreated();
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    // When the tag already exists, offer to overwrite it (IntelliJ
    // GitTagDialog's Force checkbox). Re-run createTag with force on confirm.
    if (/already exists/i.test(msg) && deps.showWarningMessage) {
      const choice = await deps.showWarningMessage(
        `Tag '${name}' already exists. Overwrite it?`,
        { modal: true },
        'Overwrite'
      );
      if (choice !== 'Overwrite') {
        return;
      }
      try {
        await deps.gitService.createTag(deps.repo, name, normalizedMessage, ref, true).match(
          () => undefined,
          (e) => {
            throw e;
          }
        );
        void deps.showInformationMessage(`Created tag: ${name}`);
        if (deps.onTagCreated) {
          deps.onTagCreated();
        }
      } catch (retryError) {
        const rmsg = retryError instanceof Error ? retryError.message : 'Unknown error';
        void deps.showErrorMessage(`Failed to create tag: ${sanitizeGitError(rmsg)}`);
      }
      return;
    }
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
  targetRef: string | undefined,
  repoRootArg?: unknown
): Promise<void> {
  // Prefer the clicked commit's own repo root (merged "all roots" log) so the
  // tag lands on the right repo; otherwise fall back to the usual picker.
  const repo = (await repoFromRootHint(ctx, repoRootArg)) ?? (await pickRepositoryForTag(ctx));
  if (!repo || !ctx.services) {
    return;
  }
  await runNewTagFlow(
    {
      repo,
      gitService: ctx.services.gitService,
      showInputBox: (options) => vscode.window.showInputBox(options),
      showInformationMessage: (msg) => vscode.window.showInformationMessage(msg),
      showErrorMessage: (msg) => vscode.window.showErrorMessage(msg),
      showWarningMessage: (msg, options, ...items) =>
        vscode.window.showWarningMessage(msg, options, ...items),
      onTagCreated: () => {
        // createTag added a ref that drives the
        // tag tree + log-graph tag chip; reload before refresh so the
        // panel reads the post-mutation tag set.
        // Live read through ctx (matching the original's live
        // `extensionServices!.gitService` module-global read) so a
        // deactivation race between createTag and this callback behaves
        // byte-identically rather than running on a captured-stale service.
        void (async (): Promise<void> => {
          await ctx.services!.gitService.reloadRepository(repo);
          if (ctx.gitToolWindowProvider) {
            ctx.gitToolWindowProvider.refresh();
          }
        })();
      },
    },
    targetRef
  );
}
