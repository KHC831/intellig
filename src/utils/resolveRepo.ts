/**
 * T2-03 — Multi-root repository targeting helper.
 *
 * Most `intellig.*` command handlers used to reach for
 * `gitService.getRepositories()[0]`, which is fine in a single-root workspace
 * but silently picks an arbitrary repo in a multi-root workspace. This module
 * centralizes repository resolution so every command goes through the same
 * ordered fallback chain:
 *
 *   1. Honor explicit caller hints (`hintRepo`, `hintRepoPath`).
 *   2. Honor the `intellig.defaultRepo` configuration setting.
 *   3. Use the repo that owns the active editor's file, when
 *      `preferActive: true` and the match is unambiguous.
 *   4. If only one repo is open, return it.
 *   5. Otherwise, show a QuickPick.
 *   6. If no repos are open, surface an error toast and return `undefined`.
 *
 * The resolver is split into a pure core (`selectRepo`) and a thin async
 * wrapper (`resolveRepo`) that talks to VS Code. The pure core is the
 * unit-test surface — callers in tests can inject their own dependencies.
 */

import * as vscode from 'vscode';
import type { IRepository } from '../services/interfaces/IGitService';

/** Configuration key under `intellig.*` for the default-repo preference. */
export const DEFAULT_REPO_CONFIG_KEY = 'defaultRepo';

/** Optional caller hints for the resolver. */
export interface IResolveRepoContext {
  /**
   * An explicit repository the caller already has in hand (e.g. from a
   * context-menu invocation). When set and the repository is still open,
   * it's returned without further ceremony.
   */
  hintRepo?: IRepository;
  /**
   * An on-disk path the caller wants to resolve. Typically the fsPath of a
   * file that triggered the command (e.g. the Show History invocation for
   * `editor.action.showHistory`). Resolved to the deepest open repo whose
   * root is an ancestor of the path.
   */
  hintRepoPath?: string;
  /**
   * When `true`, consult `vscode.window.activeTextEditor` and prefer the
   * repo owning the active file (subject to an unambiguous match).
   */
  preferActive?: boolean;
  /**
   * Title to display on the QuickPick when multi-repo disambiguation is
   * required. Defaults to `"Choose Repository"`.
   */
  pickerTitle?: string;
  /** Placeholder to display on the QuickPick. */
  pickerPlaceholder?: string;
  /**
   * When `true`, suppress the "No Git repository found" error toast. Used
   * by callers that want to handle the empty-state themselves.
   */
  silent?: boolean;
}

/** Dependencies injected into {@link selectRepo} — keeps the core testable. */
export interface ISelectRepoDeps {
  /** All repositories currently open in the workspace. */
  repositories: readonly IRepository[];
  /** Current `intellig.defaultRepo` value; empty string / undefined means unset. */
  defaultRepo: string;
  /** fsPath of the active editor's file, if any. Used with `preferActive`. */
  activeEditorFsPath: string | undefined;
  /** Show the disambiguation QuickPick. Return `undefined` on user cancel. */
  showQuickPick: (
    items: IRepoPickItem[],
    title: string,
    placeholder: string
  ) => Promise<IRepoPickItem | undefined>;
  /** Surface an error toast. */
  showErrorMessage: (message: string) => void;
}

export interface IRepoPickItem {
  label: string;
  description?: string;
  repo: IRepository;
}

/**
 * Resolution outcome — `undefined` means "no repo selected" but does NOT
 * automatically imply an error. The resolver reports errors via the injected
 * `showErrorMessage` when appropriate (missing repo) and returns `undefined`
 * without a toast for user-cancellation.
 */
export async function selectRepo(
  deps: ISelectRepoDeps,
  context: IResolveRepoContext = {}
): Promise<IRepository | undefined> {
  const { repositories } = deps;

  // Step 0 — nothing open.
  if (repositories.length === 0) {
    if (!context.silent) {
      deps.showErrorMessage('No Git repository found');
    }
    return undefined;
  }

  // Step 1 — explicit repo hint.
  if (context.hintRepo && repositories.includes(context.hintRepo)) {
    return context.hintRepo;
  }

  // Step 2 — path hint.
  if (context.hintRepoPath) {
    const match = findRepoContainingPath(repositories, context.hintRepoPath);
    if (match) {
      return match;
    }
  }

  // Step 3 — defaultRepo config (basename OR absolute path match).
  if (deps.defaultRepo && deps.defaultRepo.trim().length > 0) {
    const cfg = deps.defaultRepo.trim();
    const byPath = repositories.find((r) => normalizePath(r.rootUri.fsPath) === normalizePath(cfg));
    if (byPath) {
      return byPath;
    }
    const byBasename = repositories.find((r) => basenameOf(r.rootUri.fsPath) === cfg);
    if (byBasename) {
      return byBasename;
    }
  }

  // Step 4 — preferActive: use the active editor's repo when unambiguous.
  if (context.preferActive && deps.activeEditorFsPath) {
    const match = findRepoContainingPath(repositories, deps.activeEditorFsPath);
    if (match) {
      return match;
    }
  }

  // Step 5 — single open repo.
  if (repositories.length === 1) {
    // ALLOWED: explicit single-repo-guaranteed branch (the `.length === 1`
    // guard above); `repositories[0]` is literally the only repo.
    return repositories[0];
  }

  // Step 6 — multi-repo: prompt.
  const items: IRepoPickItem[] = repositories.map((r) => ({
    label: basenameOf(r.rootUri.fsPath),
    description: r.rootUri.fsPath,
    repo: r,
  }));
  const title = context.pickerTitle ?? 'Choose Repository';
  const placeholder = context.pickerPlaceholder ?? 'Select a repository';
  const picked = await deps.showQuickPick(items, title, placeholder);
  return picked?.repo;
}

/**
 * Thin wrapper around {@link selectRepo} that talks to VS Code / a Git
 * service. Intended to be called by production code in `extension.ts`.
 */
export async function resolveRepo(
  gitService: { getRepositories(): readonly IRepository[] },
  context: IResolveRepoContext = {}
): Promise<IRepository | undefined> {
  const config = vscode.workspace.getConfiguration('intellig');
  const defaultRepo = config.get<string>(DEFAULT_REPO_CONFIG_KEY, '') ?? '';

  const activeEditor = vscode.window.activeTextEditor;
  const activeEditorFsPath =
    activeEditor && activeEditor.document && activeEditor.document.uri.scheme === 'file'
      ? activeEditor.document.uri.fsPath
      : undefined;

  return selectRepo(
    {
      repositories: gitService.getRepositories(),
      defaultRepo,
      activeEditorFsPath,
      showQuickPick: async (items, title, placeholder) => {
        const picked = await vscode.window.showQuickPick(items, {
          title,
          placeHolder: placeholder,
        });
        return picked ?? undefined;
      },
      showErrorMessage: (m) => {
        void vscode.window.showErrorMessage(m);
      },
    },
    context
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Normalize an fsPath for comparison: strip trailing separator, unify slashes. */
export function normalizePath(p: string): string {
  if (!p) {
    return '';
  }
  // Unify path separators first (Windows).
  let out = p.replace(/\\/g, '/');
  // Strip trailing slash except for a bare root "/".
  if (out.length > 1 && out.endsWith('/')) {
    out = out.slice(0, -1);
  }
  return out;
}

/** Extract the last non-empty path segment from an fsPath. */
export function basenameOf(p: string): string {
  const normalized = normalizePath(p);
  if (!normalized) {
    return '';
  }
  const parts = normalized.split('/').filter((s) => s.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : normalized;
}

/**
 * Find the repo whose root is the deepest ancestor of {@param path}.
 * Returns `undefined` if no repo root is an ancestor.
 */
export function findRepoContainingPath(
  repositories: readonly IRepository[],
  path: string
): IRepository | undefined {
  const target = normalizePath(path);
  if (!target) {
    return undefined;
  }
  let best: IRepository | undefined;
  let bestLen = -1;
  for (const repo of repositories) {
    const root = normalizePath(repo.rootUri.fsPath);
    if (!root) {
      continue;
    }
    // Exact match, or ancestor match (root + '/').
    if (target === root || target.startsWith(root + '/')) {
      if (root.length > bestLen) {
        best = repo;
        bestLen = root.length;
      }
    }
  }
  return best;
}
