import * as fs from 'fs';
import * as path from 'path';
import { INTERNAL_IGNORED_FOLDERS } from '../repoScan';

/**
 * Stateless repository-topology helpers extracted from the {@link GitService}
 * façade. These COMPUTE path relationships ("is this path inside that repo
 * root", "what repo root owns this `.git/` directory", "should this newly-seen
 * `.git/` be ignored") from explicit arguments WITHOUT touching any lifecycle
 * state. GitService owns all cache/watcher mutation at the call site and uses
 * these only for the pure path math.
 */

/**
 * True when `candidate` is `rootPath` itself OR a path-child of `rootPath`.
 *
 * Uses `path.relative` rather than string `startsWith(rootPath + sep)` so
 * `/work/projectA` (path-child of /work) is correctly distinguished from
 * `/workspace/other` (sibling that shares only a string prefix). A `..`
 * prefix means candidate is OUTSIDE rootPath; an absolute result means a
 * different drive on Windows.
 */
export function isPathInsideOrEqual(rootPath: string, candidate: string): boolean {
  if (candidate === rootPath) {
    return true;
  }
  const rel = path.relative(rootPath, candidate); // pathspec-guard-allow: containment check, not a git pathspec
  // path.relative returns '..' or starts with '..' + sep when candidate
  // is OUTSIDE rootPath; absolute path means different drive on Windows.
  if (rel.length === 0 || rel === '..' || rel.startsWith('..' + path.sep)) {
    return false;
  }
  // Defense against Windows absolute-path pivot (different drive).
  if (path.isAbsolute(rel)) {
    return false;
  }
  return true;
}

/**
 * Resolve the per-worktree git directory for `repoRoot`.
 *
 * In a normal checkout `<root>/.git` is a directory and IS the git dir.
 * In a LINKED WORKTREE (and submodule) `<root>/.git` is a regular FILE holding
 * a `gitdir: <path>` pointer to `<main>/.git/worktrees/<name>` — so reading or
 * writing `<root>/.git/<file>` directly fails (it is a file, not a directory).
 * Per-worktree storage (changelists, shelves) must follow that pointer.
 *
 * We deliberately resolve the *per-worktree* gitdir (mirrors `git rev-parse
 * --git-dir`) rather than the shared common dir (`git rev-parse
 * --git-common-dir`): a changelist or shelf groups uncommitted changes in one
 * working tree, so each linked worktree gets its own isolated store. Sharing
 * the common dir would surface another worktree's changelists against files
 * that may not even exist (or differ) in the current checkout.
 *
 * Resolution is pure filesystem (no subprocess), matching the synchronous
 * storage-path call chain in ChangelistService / ShelfService. The `.git`
 * file format (`gitdir: <abs-or-rel-path>`) is git's stable on-disk contract.
 *
 * Always returns a path; on any anomaly (missing `.git`, unreadable/pointerless
 * file) it falls back to the conventional `<root>/.git`, so a caller's
 * mkdir-on-write still produces a usable location.
 */
export function resolveWorktreeGitDir(repoRoot: string): string {
  const dotGit = path.join(repoRoot, '.git');

  let stat: fs.Stats;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return dotGit;
  }

  if (stat.isDirectory()) {
    return dotGit;
  }

  // `.git` is a FILE (linked worktree / submodule): follow the `gitdir:`
  // pointer. A relative pointer is resolved against the worktree root.
  try {
    const pointer = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
    if (pointer) {
      return path.isAbsolute(pointer[1]) ? pointer[1] : path.resolve(repoRoot, pointer[1]);
    }
    // eslint-disable-next-line no-restricted-syntax -- an unreadable/absent `.git` pointer file falls through to the conventional `.git` path; absence here is an expected, recoverable outcome.
  } catch {
    // Unreadable pointer — fall through to the conventional path.
  }

  return dotGit;
}

/**
 * Given the fsPath of a created `.git/` directory, return the repo root that
 * owns it (its parent directory), or `undefined` when no usable parent exists
 * (the separator is at the start or absent).
 */
export function repoRootFromGitDir(gitDirFsPath: string): string | undefined {
  const lastSep = Math.max(gitDirFsPath.lastIndexOf('/'), gitDirFsPath.lastIndexOf('\\'));
  if (lastSep <= 0) {
    return undefined;
  }
  return gitDirFsPath.slice(0, lastSep);
}

/**
 * True when a newly-discovered `.git/` at `repoParentDir` should be ignored
 * relative to the watched `folderPath` — either because it sits OUTSIDE the
 * folder (defensive; the RelativePattern glob shouldn't surface those) or
 * because an ancestor segment matches an ignored-folder name.
 *
 * Applies the same filter the scanner uses: basename of any ancestor between
 * the workspace folder and the parent dir matching an ignored name (internal
 * ∪ user-config) disqualifies this `.git/`. Uses `path.relative` rather than
 * a string-prefix check so `/workspace/foo` is not treated as inside `/work`.
 */
export function isNewRepoPathIgnored(
  folderPath: string,
  repoParentDir: string,
  userIgnored: string[]
): boolean {
  const rel = path.relative(folderPath, repoParentDir); // pathspec-guard-allow: containment check, not a git pathspec
  if (rel.length > 0 && (rel === '..' || rel.startsWith('..' + path.sep))) {
    // The created `.git/` is OUTSIDE the watched folder. This shouldn't
    // happen given the RelativePattern glob, but defend against it.
    return true;
  }
  if (path.isAbsolute(rel)) {
    // Different drive on Windows — also outside the watched folder.
    return true;
  }
  const segments = rel.split(/[/\\]/).filter((s) => s.length > 0);
  const allIgnored = new Set<string>([...INTERNAL_IGNORED_FOLDERS, ...userIgnored]);
  if (segments.some((seg) => allIgnored.has(seg))) {
    return true;
  }
  return false;
}
