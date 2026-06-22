import * as path from 'path';
import * as vscode from 'vscode';
import type { IGitService, IRepository } from '../git-core/interfaces/IGitService';
import { canonicalizeFsPath } from '../utils/repoRelativePath';

/**
 * Resolve the repository a blame provider should annotate for `uri`.
 *
 * Resolution order, mirroring how the rest of the extension targets repos
 * (`resolveRepo`) but non-interactively — no QuickPick, safe for the inline
 * provider's per-cursor hot path:
 *
 *   1. The deepest already-open repository whose root is an ancestor of the
 *      file, compared on canonicalized (realpath'd) paths so a symlinked
 *      editor path (macOS `/var` → `/private/var`) still matches a repo root
 *      that git reported as a realpath.
 *   2. The single open repository, when exactly one is open.
 *   3. A fresh `getRepository` (spawns `git rev-parse`) as a last resort.
 *
 * Previously the providers used only step 3. That fresh resolution can return
 * `undefined` for a file even when its repo is open and cached — the cache is
 * keyed by repo root, not file path, so a file lookup always misses and falls
 * to a `git rev-parse` subprocess that can fail (git PATH / transient). The
 * annotation then silently rendered nothing despite an open repo.
 */
export async function resolveBlameRepo(
  gitService: IGitService,
  uri: vscode.Uri
): Promise<IRepository | undefined> {
  const repos = gitService.getRepositories();

  const target = canonicalizeFsPath(uri.fsPath);
  let best: IRepository | undefined;
  let bestLen = -1;
  for (const repo of repos) {
    const root = canonicalizeFsPath(repo.rootUri.fsPath);
    if (target === root || target.startsWith(root + path.sep)) {
      if (root.length > bestLen) {
        best = repo;
        bestLen = root.length;
      }
    }
  }
  if (best) {
    return best;
  }

  if (repos.length === 1) {
    return repos[0];
  }

  return gitService.getRepository(uri);
}
