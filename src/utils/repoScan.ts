/**
 * Bounded recursive scan for git repositories under a workspace folder.
 *
 * Wave 10 (task #204) — fixes the nested-repo discovery gap where opening
 * `~/work/` with `~/work/projectA/.git` + `~/work/projectB/.git` showed zero
 * repos in IntelliG because `discoverRepository(folder)` only checked the
 * folder root for `.git/`. Mirrors the behavior of VS Code's
 * `git.repositoryScanMaxDepth` + `git.repositoryScanIgnoredFolders` settings
 * without coupling to vscode-git's API.
 *
 * Algorithm summary (see `scanFolderForGitRepos` for the full contract):
 *   1. If `root` is itself a repo, return `[root]` and DO NOT recurse — the
 *      children of a repo aren't separate repos.
 *   2. Otherwise, if `maxDepth === 0`, return `[]`.
 *   3. Otherwise, list directory children, filter out symlinks (unless
 *      `maxDepth === -1` AND realpath hasn't been visited — symlink cycle
 *      guard) and ignored-folder names, and recurse.
 *   4. Dedupe results by absolute path.
 *
 * The function is fs-injection-friendly via {@link IRepoScanFs}, so unit
 * tests can drive it from an in-memory tree without touching the disk.
 */

import * as fs from 'fs/promises';
import type { Dirent } from 'fs';
import * as path from 'path';

/**
 * Internal always-excluded folder names (basename match, case-sensitive).
 * Hidden, non-overridable: even if the user passes an empty
 * `ignoredFolders`, these names are skipped. The list mirrors the most
 * common build/dependency folders that would otherwise spawn `git rev-parse
 * --show-toplevel` thousands of times for no useful result.
 *
 * `.git` itself is included so the helper can never re-enter a `.git/`
 * directory while scanning a parent for nested repos.
 */
export const INTERNAL_IGNORED_FOLDERS: readonly string[] = [
  '.git',
  'node_modules',
  '.vscode',
  'out',
  'dist',
  '.next',
  'target',
  'build',
  'vendor',
];

/**
 * Filesystem injection seam. Production code passes the default
 * implementation backed by `node:fs/promises`; unit tests pass an in-memory
 * stub so they don't have to set up real directory trees.
 */
export interface IRepoScanFs {
  readdir(
    path: string,
    options: { withFileTypes: true }
  ): Promise<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }[]>;
  realpath(path: string): Promise<string>;
}

/**
 * Default fs adapter — thin wrappers around `fs/promises`. Exposed so
 * callers (e.g. `GitService.discoverRepository`) can use it without
 * re-implementing the wrapper.
 */
export const defaultRepoScanFs: IRepoScanFs = {
  async readdir(
    p: string,
    options: { withFileTypes: true }
  ): Promise<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }[]> {
    const entries: Dirent[] = await fs.readdir(p, options);
    return entries;
  },
  async realpath(p: string): Promise<string> {
    return fs.realpath(p);
  },
};

/**
 * Options for {@link scanFolderForGitRepos}.
 */
export interface IScanRepoOptions {
  /**
   * Maximum recursion depth from `root`.
   *   - `0` — only check the root itself; never list children.
   *   - `1` — root + immediate children (default; mirrors VS Code).
   *   - `n>1` — recurse n levels deep.
   *   - `-1` — unlimited (with realpath cycle guard for symlinks).
   */
  maxDepth: number;
  /**
   * User-configured ignored folder basenames (case-sensitive). Union'd
   * with {@link INTERNAL_IGNORED_FOLDERS}.
   */
  ignoredFolders: readonly string[];
  /**
   * Fs injection seam for unit tests. Defaults to {@link defaultRepoScanFs}.
   */
  fs?: IRepoScanFs;
  /**
   * Resolves a directory to its repo root (typically via
   * `git rev-parse --show-toplevel`). Returns `undefined` if the path is
   * not inside any repository.
   */
  resolveRepoRoot: (dirPath: string) => Promise<string | undefined>;
}

/**
 * Find all git repositories rooted at or below `root`.
 *
 * @param root Absolute path to start scanning. Typically a workspace folder.
 * @param opts See {@link IScanRepoOptions}.
 * @returns Absolute paths of discovered repo roots, deduped.
 *
 * **Algorithm:**
 *   1. If `resolveRepoRoot(root)` returns a path, that path IS the repo for
 *      this scan — return `[<root-resolved>]`. Children of a repo aren't
 *      separate repos, so we don't recurse.
 *   2. Otherwise, if `maxDepth === 0`, return `[]`.
 *   3. Otherwise, `readdir(root)` and filter:
 *      - directories only,
 *      - basename NOT in `ignoredFolders ∪ INTERNAL_IGNORED_FOLDERS`,
 *      - NOT a symlink (unless `maxDepth === -1` AND realpath hasn't been
 *        visited — cycle guard).
 *   4. For each surviving child: call `resolveRepoRoot(childPath)`. If that
 *      returns a non-empty string, add to results AND skip recursion into
 *      that child. Otherwise, recurse with `maxDepth - 1` (or stay at `-1`).
 *   5. Dedupe by absolute path before returning.
 *
 * Errors from `readdir` are caught and logged; the scan continues with
 * whatever was discovered before the error.
 *
 * @remarks
 * **Performance note (TL-84):** `maxDepth: -1` (unlimited) incurs `O(N)`
 * `fs.realpath` syscalls — one per directory entered AND one per symlinked
 * child evaluated — to power the cycle guard. On large trees with many
 * subdirectories this can add measurable I/O latency. Stay on the default
 * `maxDepth: 1` (or any small finite depth) unless you genuinely need to
 * follow symlinks; finite-depth scans skip symlinks unconditionally and
 * therefore make zero `realpath` calls.
 */
export async function scanFolderForGitRepos(
  root: string,
  opts: IScanRepoOptions
): Promise<string[]> {
  const fsImpl = opts.fs ?? defaultRepoScanFs;
  const ignored = new Set<string>([...INTERNAL_IGNORED_FOLDERS, ...opts.ignoredFolders]);
  const results = new Set<string>();
  // Track realpath of every directory we've already entered so the symlink
  // cycle guard at `maxDepth === -1` can detect a self-loop.
  const visitedRealpaths = new Set<string>();

  // First, check if root itself is a repo.
  const rootRepo = await opts.resolveRepoRoot(root);
  if (rootRepo) {
    return [rootRepo];
  }

  if (opts.maxDepth === 0) {
    return [];
  }

  /**
   * Recursive scan body. `remaining` is the remaining depth budget; `-1`
   * means unlimited.
   */
  async function scan(dir: string, remaining: number): Promise<void> {
    if (remaining === 0) {
      return;
    }

    // Cycle guard: track realpath of every directory we recurse into.
    if (opts.maxDepth === -1) {
      let realDir: string;
      try {
        realDir = await fsImpl.realpath(dir);
      } catch {
        realDir = dir;
      }
      if (visitedRealpaths.has(realDir)) {
        return;
      }
      visitedRealpaths.add(realDir);
    }

    let entries: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }[];
    try {
      entries = await fsImpl.readdir(dir, { withFileTypes: true });
    } catch {
      // Permission denied / mid-clone races / unmounted NFS — log via
      // caller's policy. Return what we have.
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (ignored.has(entry.name)) {
        continue;
      }

      const childPath = path.join(dir, entry.name);

      if (entry.isSymbolicLink()) {
        // Finite depth → never follow symlinks.
        if (opts.maxDepth !== -1) {
          continue;
        }
        // Unlimited depth → follow only if realpath unseen.
        let realChild: string;
        try {
          realChild = await fsImpl.realpath(childPath);
        } catch {
          continue;
        }
        if (visitedRealpaths.has(realChild)) {
          continue;
        }
        // Reserve the realpath BEFORE the resolveRepoRoot/recurse so a
        // cycle inside the child can't re-enter.
        visitedRealpaths.add(realChild);
      }

      const childRepo = await opts.resolveRepoRoot(childPath);
      if (childRepo) {
        results.add(childRepo);
        // Discovered repo — don't recurse INTO it. Children of a repo are
        // part of that repo, not separate repos.
        continue;
      }

      // Not a repo — recurse if the depth budget permits.
      const nextRemaining = remaining === -1 ? -1 : remaining - 1;
      await scan(childPath, nextRemaining);
    }
  }

  // The initial recursion budget mirrors `maxDepth` directly: at depth=1 we
  // list root's immediate children but do not recurse INTO them.
  await scan(root, opts.maxDepth);

  return Array.from(results);
}
