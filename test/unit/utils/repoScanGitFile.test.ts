/**
 * Tests for `.git` as a FILE — linked worktrees & submodule worktrees.
 *
 * `.git` is honored as a FILE as well as a directory, so a scan-layer
 * fast-path on a `.git` file (the linked-worktree / submodule shape) is
 * possible. The `resolveRepoRoot` CLI path (git's `rev-parse --show-toplevel`)
 * resolves both shapes correctly regardless.
 *
 * Behaviour:
 *   1. `IRepoScanFs.Dirent` exposes `isFile(): boolean`.
 *   2. `.git` as a FILE entry is a repo signal in the scanner —
 *      when scanning a root, the `resolveRepoRoot` callback
 *      (production: git CLI) returns the repo root for either shape.
 *   3. The `INTERNAL_IGNORED_FOLDERS` comment documents that the `.git` skip
 *      applies regardless of fs entry type.
 *
 * Each spec was authored RED-first and confirmed failing before any
 * production code was modified.
 */

import '../../setup';
import * as assert from 'assert';
import * as path from 'path';
import { scanFolderForGitRepos, IRepoScanFs } from '../../../src/git-core/repoScan';

interface IFsState {
  /** path → list of child names (each child is a directory unless listed in `files`). */
  dirs: Map<string, string[]>;
  /** Subset of "<dirPath>/<childName>" full paths that are FILES, not directories. */
  files: Set<string>;
  /** Subset of full paths that are symlinks. */
  symlinks: Set<string>;
}

/**
 * In-memory fs stub that exposes `isDirectory()`, `isSymbolicLink()`, AND
 * `isFile()` per the contract.
 */
function makeFsWithFiles(state: IFsState): IRepoScanFs {
  return {
    async readdir(
      dirPath: string,
      _options: { withFileTypes: true }
    ): Promise<
      { name: string; isDirectory(): boolean; isSymbolicLink(): boolean; isFile(): boolean }[]
    > {
      const children = state.dirs.get(dirPath);
      if (!children) {
        return [];
      }
      return children.map((name) => {
        const fullPath = path.join(dirPath, name);
        const isFileFlag = state.files.has(fullPath);
        const isSymlinkFlag = state.symlinks.has(fullPath);
        return {
          name,
          isDirectory(): boolean {
            return !isFileFlag && !isSymlinkFlag;
          },
          isSymbolicLink(): boolean {
            return isSymlinkFlag;
          },
          isFile(): boolean {
            return isFileFlag;
          },
        };
      });
    },
    async realpath(p: string): Promise<string> {
      return p;
    },
  };
}

describe('scanFolderForGitRepos — .git as FILE (TL-87 / #212)', () => {
  it('detects a worktree whose .git is a file (not a directory) at the root', async () => {
    // /work/wt1 is a linked worktree: `/work/wt1/.git` is a FILE containing
    // `gitdir: <relative path>`. The scanner must still detect /work/wt1 as
    // a repo via `resolveRepoRoot` (the production CLI handles both shapes
    // — this test pins the contract at the scan-layer fs interface).
    const fs = makeFsWithFiles({
      dirs: new Map([['/work/wt1', ['.git', 'src']]]),
      files: new Set(['/work/wt1/.git']),
      symlinks: new Set(),
    });
    const result = await scanFolderForGitRepos('/work/wt1', {
      maxDepth: 1,
      ignoredFolders: [],
      fs,
      resolveRepoRoot: async (p: string): Promise<string | undefined> =>
        p === '/work/wt1' ? '/work/wt1' : undefined,
    });
    assert.deepStrictEqual(
      result,
      ['/work/wt1'],
      'a linked-worktree dir whose .git is a FILE must still be reported as a repo'
    );
  });

  it('detects a nested worktree (.git as file) under a non-repo root', async () => {
    // Workspace root /work/ is not a repo; /work/wt1 is a worktree with
    // `.git` as a FILE. The scanner must descend (depth=1) and detect
    // /work/wt1 as a repo via the per-child resolveRepoRoot call.
    const fs = makeFsWithFiles({
      dirs: new Map([
        ['/work', ['wt1']],
        ['/work/wt1', ['.git', 'src']],
      ]),
      files: new Set(['/work/wt1/.git']),
      symlinks: new Set(),
    });
    const result = await scanFolderForGitRepos('/work', {
      maxDepth: 1,
      ignoredFolders: [],
      fs,
      resolveRepoRoot: async (p: string): Promise<string | undefined> => {
        if (p === '/work') {
          return undefined;
        }
        if (p === '/work/wt1') {
          return '/work/wt1';
        }
        return undefined;
      },
    });
    assert.deepStrictEqual(result, ['/work/wt1']);
  });

  it('skips a `.git` FILE child the same way it skips a `.git` DIRECTORY child', async () => {
    // The internal-ignored filter must apply regardless of file/dir shape.
    // If a child is literally named `.git` (file or dir), the scanner must
    // NEVER call `resolveRepoRoot` on it (we don't want to spawn `git
    // rev-parse --show-toplevel` against a path that's known a-priori to be
    // a `.git` entry, file or otherwise).
    const fs = makeFsWithFiles({
      dirs: new Map([['/work/repo', ['.git', 'src']]]),
      files: new Set(['/work/repo/.git']), // .git here is a FILE
      symlinks: new Set(),
    });
    const seen: string[] = [];
    await scanFolderForGitRepos('/work/repo', {
      maxDepth: 1,
      ignoredFolders: [],
      fs,
      resolveRepoRoot: async (p: string): Promise<string | undefined> => {
        seen.push(p);
        return p === '/work/repo' ? '/work/repo' : undefined;
      },
    });
    // resolveRepoRoot must have been called on the root, but NEVER on the
    // .git file child — same invariant as for .git directory children.
    assert.ok(seen.includes('/work/repo'), 'root must be probed');
    assert.ok(
      !seen.includes('/work/repo/.git'),
      `expected resolveRepoRoot NOT called on the .git file entry, but call list was ${JSON.stringify(seen)}`
    );
  });
});
