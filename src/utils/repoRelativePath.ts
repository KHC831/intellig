/**
 * Repo-root-relative git pathspec derivation.
 *
 * git commands run with `cwd = repo.rootUri.fsPath`, so any file argument must
 * be REPO-root-relative. `vscode.workspace.asRelativePath` is WORKSPACE-FOLDER-
 * relative and so wrong whenever the repo root differs from the folder (a
 * nested repo / submodule, or a multi-root workspace where the folder name is
 * prefixed) — it makes `git <op> -- <folder>/<file>` fail with "pathspec did
 * not match any files". This module is the single source of truth for the
 * correct derivation, shared by the explorer, commit/repo, and blame/editor
 * command handlers.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Canonicalize an absolute filesystem path, resolving symlinked components
 * (e.g. macOS `/var` → `/private/var`, where `git rev-parse --show-toplevel`
 * reports the resolved repo root while an explorer URI keeps the symlink).
 * Falls back to the deepest existing ancestor for a path that does not exist
 * on disk (a just-deleted file) so the parent's symlinks still resolve.
 */
export function canonicalizeFsPath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    const parent = path.dirname(p);
    if (parent === p) {
      return p;
    }
    return path.join(canonicalizeFsPath(parent), path.basename(p));
  }
}

/**
 * Compute the repo-root-relative, POSIX-separated path git needs for a file.
 *
 * Unlike `vscode.workspace.asRelativePath` — which is relative to the
 * WORKSPACE FOLDER and so wrong whenever the repo root differs from the folder
 * (a nested repo / submodule, or a multi-root workspace where the folder name
 * is prefixed) — this is always relative to the repository root, matching the
 * `cwd` git commands run under. A workspace-folder-relative path makes
 * `git add -- <folder>/<file>` fail with "pathspec did not match any files",
 * which is why the explorer ops silently did nothing.
 *
 * Both ends are canonicalized first so a symlinked path component does not
 * produce a spurious `../` escape. When the file is genuinely outside the
 * repo the absolute fsPath is returned so git surfaces a clear "outside
 * repository" error rather than us sending a bogus `../` pathspec.
 */
export function repoRelativePath(repoRootFsPath: string, fileFsPath: string): string {
  return toRepoRelativePosix(canonicalizeFsPath(repoRootFsPath), canonicalizeFsPath(fileFsPath));
}

/**
 * Pure (no-fs) separator/outside-repo core of {@link repoRelativePath}, split
 * out and parameterized by the path implementation so the POSIX and Windows
 * (back-slash + drive-letter) branches are unit-testable on any host.
 *
 * `rel === ''` means the target IS the repo root itself; `'../'` or an absolute
 * result means it's outside the repo. In every such case the absolute fsPath is
 * returned: git then operates on (or rejects) an explicit path rather than
 * receiving a bogus `../` pathspec or an empty argument. The repo-root case is
 * unreachable from the explorer menus (they bind to files only —
 * `explorerResourceIsFolder == false`); the fallback is purely defensive.
 */
export function toRepoRelativePosix(
  repoRootFsPath: string,
  fileFsPath: string,
  pathImpl: Pick<typeof path, 'relative' | 'isAbsolute'> = path
): string {
  const rel = pathImpl.relative(repoRootFsPath, fileFsPath).replace(/\\/g, '/');
  if (rel === '' || rel.startsWith('../') || pathImpl.isAbsolute(rel)) {
    return fileFsPath;
  }
  return rel;
}
