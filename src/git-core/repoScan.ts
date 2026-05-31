/**
 * Bounded recursive scan for git repositories under a workspace folder.
 *
 * Fixes the nested-repo discovery gap (issue #204) where opening
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
 * Internal always-excluded folder names. Hidden, non-overridable: even if
 * the user passes an empty `ignoredFolders`, these names are skipped. The
 * list mirrors the most common build/dependency folders that would
 * otherwise spawn `git rev-parse --show-toplevel` thousands of times for
 * no useful result.
 *
 * `.git` itself is included so the helper can never re-enter a `.git/`
 * directory while scanning a parent for nested repos. Per issue #212
 * the filter applies to both `.git` directories AND `.git` files (the
 * latter are how linked worktrees and submodule worktrees encode their
 * repo metadata as `gitdir: <path>` pointers); the basename match is
 * shape-agnostic so either form is handled uniformly.
 *
 * **Split case-policy.** Every entry was previously matched
 * case-insensitively (issue #214). That silently broke a Linux user
 * with `Build/projectA/.git`: their repo was previously discovered (case-
 * sensitive Linux fs; `Build` ≠ `build`), then `Build` was filtered.
 * Same for `Out/`, `Target/`, `Vendor/`, `Dist/` — common Pascal-case
 * directories in C#/.NET, Rust, Java, monorepo conventions. The "git
 * crashes anyway on case-insensitive volumes" justification only holds
 * for `.git` / `.vscode` / `node_modules` / `.next`, which are
 * filesystem-canonicalized on Windows + case-insensitive macOS.
 *
 * The split policy:
 *   - {@link CASE_INSENSITIVE_IGNORED_NAMES}: filtered case-insensitively
 *     because they're filesystem-canonicalized anyway (`.git`, `.vscode`,
 *     `node_modules`, `.next`).
 *   - {@link CASE_SENSITIVE_IGNORED_NAMES}: filtered with EXACT case
 *     (`out`, `dist`, `target`, `build`, `vendor`) so case-sensitive
 *     Linux users keep working repos like `Build/projectA/.git`.
 */
export const CASE_INSENSITIVE_IGNORED_NAMES: readonly string[] = [
  '.git',
  '.vscode',
  'node_modules',
  '.next',
];

export const CASE_SENSITIVE_IGNORED_NAMES: readonly string[] = [
  'out',
  'dist',
  'target',
  'build',
  'vendor',
];

/**
 * Backward-compatible union of internal ignored folders. Production code
 * should prefer the split sets above; this is kept exported because the
 * Wave-10 new-repo watcher's mid-session ancestor filter (in
 * `GitService.setupNewRepoWatcher`) does an equality check against the
 * union and treats both halves the same way (which is fine there because
 * the new-repo watcher's ancestor list is checked against actual on-disk
 * paths via `path.relative`, not against an arbitrary user folder name).
 */
export const INTERNAL_IGNORED_FOLDERS: readonly string[] = [
  ...CASE_INSENSITIVE_IGNORED_NAMES,
  ...CASE_SENSITIVE_IGNORED_NAMES,
];

/**
 * Filesystem injection seam. Production code passes the default
 * implementation backed by `node:fs/promises`; unit tests pass an in-memory
 * stub so they don't have to set up real directory trees.
 *
 * @remarks
 * **`isFile()` on each entry (issue #212).** Linked worktrees and
 * submodule worktrees encode their repo metadata as a `.git` *file*
 * containing a `gitdir: <path>` pointer rather than a `.git/` directory.
 * The scanner currently treats those entries via the per-path
 * `resolveRepoRoot` callback (production: `git rev-parse --show-toplevel`,
 * which handles both shapes uniformly), so adding `isFile()` does not
 * change the discovery contract today. It IS, however, required so that
 * the `INTERNAL_IGNORED_FOLDERS` filter applies to a `.git` *file* child
 * the same way it applies to a `.git` *directory* child — without a
 * shape-aware skip we'd happily call `git rev-parse` against the `.git`
 * file path itself, which is a known a-priori repo signal and shouldn't
 * spawn a subprocess.
 */
export interface IRepoScanFs {
  readdir(
    path: string,
    options: { withFileTypes: true }
  ): Promise<
    {
      name: string;
      isDirectory(): boolean;
      isSymbolicLink(): boolean;
      /**
       * Issue #212: true when the entry is a regular file (not a directory
       * and not a symlink). Most importantly used to recognize the `.git`
       * file shape used by linked worktrees + submodule worktrees, but the
       * current scan algorithm only requires it to be present on the type —
       * the runtime decision logic uses `isDirectory()` exclusively for
       * recursion and the basename match for filtering.
       */
      isFile(): boolean;
    }[]
  >;
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
  ): Promise<
    {
      name: string;
      isDirectory(): boolean;
      isSymbolicLink(): boolean;
      isFile(): boolean;
    }[]
  > {
    const entries: Dirent[] = await fs.readdir(p, options);
    // node:fs Dirent already exposes isFile()/isDirectory()/isSymbolicLink();
    // we just narrow the structural type the rest of the scanner consumes.
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
   * User-configured ignored folder basenames. Union'd with
   * {@link INTERNAL_IGNORED_FOLDERS}.
   *
   * The comparison for user-supplied folders is
   * case-INsensitive (Windows-parity); INTERNAL folders are split per
   * the policy documented above on {@link CASE_INSENSITIVE_IGNORED_NAMES}
   * / {@link CASE_SENSITIVE_IGNORED_NAMES}. So `mybuild`, `MyBuild`, and
   * `MYBUILD` all match the same set of children when supplied here,
   * but `Build` (capital B) is NOT filtered by the internal `build`
   * entry on case-sensitive Linux.
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
 * **Performance note:** `maxDepth: -1` (unlimited) incurs `O(N)`
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
  // Split case policy.
  //   - {@link CASE_INSENSITIVE_IGNORED_NAMES} (`.git`, `.vscode`,
  //     `node_modules`, `.next`): always filesystem-canonicalized on
  //     Windows + case-insensitive macOS, so a basename match is
  //     case-insensitive. Lowercase both sides at filter time.
  //   - {@link CASE_SENSITIVE_IGNORED_NAMES} (`out`, `dist`, `target`,
  //     `build`, `vendor`): match EXACTLY so Pascal-case build dirs on
  //     case-sensitive Linux (`Build/projectA/.git`, `Out/cargo`, etc.)
  //     are still discovered. These were previously lowercased uniformly,
  //     which silently filtered legitimate Linux repos.
  //   - User-supplied `opts.ignoredFolders`: matched case-insensitively
  //     so a Windows user who configures `["mybuild"]` doesn't have to
  //     guess the on-disk casing.
  const caseInsensitiveIgnored = new Set<string>(
    [...CASE_INSENSITIVE_IGNORED_NAMES, ...opts.ignoredFolders].map((n) => n.toLowerCase())
  );
  const caseSensitiveIgnored = new Set<string>(CASE_SENSITIVE_IGNORED_NAMES);
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

    let entries: {
      name: string;
      isDirectory(): boolean;
      isSymbolicLink(): boolean;
      isFile(): boolean;
    }[];
    try {
      entries = await fsImpl.readdir(dir, { withFileTypes: true });
    } catch {
      // Permission denied / mid-clone races / unmounted NFS — log via
      // caller's policy. Return what we have.
      return;
    }

    for (const entry of entries) {
      // Split case policy, applied BEFORE the directory-only filter so a
      // `.git` *file* child (issue #212: linked-worktree shape) is also
      // skipped without spawning
      // `git rev-parse --show-toplevel` against a known repo signal.
      const lowerName = entry.name.toLowerCase();
      if (caseInsensitiveIgnored.has(lowerName) || caseSensitiveIgnored.has(entry.name)) {
        continue;
      }
      if (!entry.isDirectory()) {
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
