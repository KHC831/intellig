/**
 * Unit tests for `scanFolderForGitRepos` (task #204).
 *
 * The scan helper backs `GitService.discoverRepository` and is responsible
 * for finding all git repositories under a workspace root, including nested
 * ones (e.g. `~/work/{a,b}/.git` when the workspace folder is `~/work/`).
 *
 * The implementation only checked the workspace root for
 * `.git/`, so a folder containing only nested repos showed zero repos in
 * IntelliG. This test suite captures the contract IntelliG mirrors from VS
 * Code's git extension (`git.repositoryScanMaxDepth` + ignored folders),
 * but with our own implementation so we don't couple to vscode-git's API.
 *
 * Each spec below was written FIRST and run RED before any line of
 * production code in `src/utils/repoScan.ts` was added.
 */

import '../../setup';
import * as assert from 'assert';
import * as path from 'path';
import {
  scanFolderForGitRepos,
  IRepoScanFs,
  INTERNAL_IGNORED_FOLDERS,
} from '../../../src/git-core/repoScan';

// The scanner joins child paths with the host `path` (win32 on a Windows
// runner); these fixtures use POSIX literals, so inject path.posix to keep the
// joined paths matching the fixtures on any OS. Production uses the host path.
const scanForTest = (
  root: string,
  opts: Omit<Parameters<typeof scanFolderForGitRepos>[1], 'path'>
): Promise<string[]> => scanFolderForGitRepos(root, { ...opts, path: path.posix });

/**
 * In-memory fs stub. Caller pre-populates a `dirs` map (path → child names)
 * and a `realpaths` map (path → realpath; defaults to identity) and a
 * `symlinks` set (paths that should report `isSymbolicLink() === true`).
 */
interface IFsState {
  /** path → list of child basenames. Order is preserved. */
  dirs: Map<string, string[]>;
  /** Subset of paths (full absolute path) that are symlinks. */
  symlinks: Set<string>;
  /** Realpath overrides for cycle simulation. */
  realpaths: Map<string, string>;
  /**
   * Symlink paths whose TARGET is a file, not a directory. `stat()` reports
   * `isDirectory() === false` for these so the scanner skips them. Any symlink
   * not listed here resolves to a directory.
   */
  symlinkFileTargets?: Set<string>;
}

function makeFs(state: IFsState): IRepoScanFs {
  return {
    async readdir(
      dirPath: string,
      _options: { withFileTypes: true }
    ): Promise<
      {
        name: string;
        isDirectory(): boolean;
        isSymbolicLink(): boolean;
        isFile(): boolean;
      }[]
    > {
      const children = state.dirs.get(dirPath);
      if (!children) {
        return [];
      }
      return children.map((name) => {
        // POSIX-join to match the scanner's injected path.posix (fixtures use
        // POSIX literal paths), so symlink lookups match on a Windows runner.
        const fullPath = path.posix.join(dirPath, name);
        const isSymlink = state.symlinks.has(fullPath);
        return {
          name,
          isDirectory(): boolean {
            // Match Node's real Dirent: it reflects the ENTRY itself (via
            // lstat), so a symlink — even one pointing at a directory —
            // reports isDirectory() === false. Non-symlink registered
            // children are directories in this model.
            return !isSymlink;
          },
          isSymbolicLink(): boolean {
            return isSymlink;
          },
          isFile(): boolean {
            // (#212): IRepoScanFs.Dirent requires isFile(); none of the
            // registered children are regular files (they are dirs or
            // symlinks), so this is uniformly false.
            return false;
          },
        };
      });
    },
    async realpath(p: string): Promise<string> {
      return state.realpaths.get(p) ?? p;
    },
    async stat(p: string): Promise<{ isDirectory(): boolean }> {
      // Follows the symlink (unlike lstat): a symlink registered as a
      // file-target reports a non-directory; every other target is a dir.
      const isFileTarget = state.symlinkFileTargets?.has(p) ?? false;
      return { isDirectory: (): boolean => !isFileTarget };
    },
  };
}

describe('scanFolderForGitRepos (Wave 10 — task #204)', () => {
  it('exports an INTERNAL_IGNORED_FOLDERS list including .git, node_modules, and common build dirs', () => {
    // The internal-ignored list is non-overridable: even if the user passes
    // an empty `ignoredFolders` array, these names are skipped.
    assert.ok(INTERNAL_IGNORED_FOLDERS.includes('.git'));
    assert.ok(INTERNAL_IGNORED_FOLDERS.includes('node_modules'));
    assert.ok(INTERNAL_IGNORED_FOLDERS.includes('out'));
    assert.ok(INTERNAL_IGNORED_FOLDERS.includes('dist'));
    assert.ok(INTERNAL_IGNORED_FOLDERS.includes('.vscode'));
    assert.ok(INTERNAL_IGNORED_FOLDERS.includes('.next'));
    assert.ok(INTERNAL_IGNORED_FOLDERS.includes('target'));
    assert.ok(INTERNAL_IGNORED_FOLDERS.includes('build'));
    assert.ok(INTERNAL_IGNORED_FOLDERS.includes('vendor'));
  });

  describe('root is itself a git repo', () => {
    it('returns root path when root is a git repo', async () => {
      // Common case: workspace folder IS a repo. We must NOT then scan into
      // it for nested repos — the children of a repo are part of that repo,
      // not separate repos.
      const fs = makeFs({
        dirs: new Map([['/work/projectA', ['src', 'sub']]]),
        symlinks: new Set(),
        realpaths: new Map(),
      });
      const result = await scanForTest('/work/projectA', {
        maxDepth: 1,
        ignoredFolders: [],
        fs,
        resolveRepoRoot: async (p: string): Promise<string | undefined> =>
          p === '/work/projectA' ? '/work/projectA' : undefined,
      });
      assert.deepStrictEqual(result, ['/work/projectA']);
    });
  });

  describe('maxDepth=0 + non-repo root', () => {
    it('returns empty when maxDepth=0 and root is not a git repo', async () => {
      // Strict ceiling: at depth 0 we only check the root; if the root isn't
      // a repo, we're done. No recursion.
      const fs = makeFs({
        dirs: new Map([['/work', ['projectA', 'projectB']]]),
        symlinks: new Set(),
        realpaths: new Map(),
      });
      const result = await scanForTest('/work', {
        maxDepth: 0,
        ignoredFolders: [],
        fs,
        resolveRepoRoot: async (): Promise<string | undefined> => undefined,
      });
      assert.deepStrictEqual(result, []);
    });
  });

  describe('maxDepth=1 + nested repos', () => {
    it('returns child repo paths when maxDepth=1 and root has nested repos', async () => {
      // The bug-this-Wave-fixes case: workspace folder is a parent dir
      // containing two sibling repos.
      const fs = makeFs({
        dirs: new Map([['/work', ['projectA', 'projectB']]]),
        symlinks: new Set(),
        realpaths: new Map(),
      });
      const result = await scanForTest('/work', {
        maxDepth: 1,
        ignoredFolders: [],
        fs,
        resolveRepoRoot: async (p: string): Promise<string | undefined> => {
          if (p === '/work') {
            return undefined;
          }
          if (p === '/work/projectA' || p === '/work/projectB') {
            return p;
          }
          return undefined;
        },
      });
      assert.deepStrictEqual(result.sort(), ['/work/projectA', '/work/projectB']);
    });
  });

  describe('internal-ignored folders', () => {
    it('skips internal-ignored folders even when not in user ignoredFolders', async () => {
      // node_modules is in INTERNAL_IGNORED_FOLDERS; the user's empty
      // ignoredFolders list cannot override that.
      const fs = makeFs({
        dirs: new Map([['/work', ['projectA', 'node_modules']]]),
        symlinks: new Set(),
        realpaths: new Map(),
      });
      const seen: string[] = [];
      await scanForTest('/work', {
        maxDepth: 1,
        ignoredFolders: [],
        fs,
        resolveRepoRoot: async (p: string): Promise<string | undefined> => {
          seen.push(p);
          if (p === '/work/projectA') {
            return '/work/projectA';
          }
          return undefined;
        },
      });
      // resolveRepoRoot must NEVER have been called on the node_modules path —
      // we don't want to spawn `git rev-parse --show-toplevel` inside
      // node_modules; that's the entire point of the internal-ignore list.
      assert.ok(
        !seen.includes('/work/node_modules'),
        `expected resolveRepoRoot NOT called on node_modules, but call list was ${JSON.stringify(seen)}`
      );
    });
  });

  describe('user-ignored folders', () => {
    it('skips user-ignored folders', async () => {
      const fs = makeFs({
        dirs: new Map([['/work', ['projectA', 'mybuild']]]),
        symlinks: new Set(),
        realpaths: new Map(),
      });
      const result = await scanForTest('/work', {
        maxDepth: 1,
        ignoredFolders: ['mybuild'],
        fs,
        resolveRepoRoot: async (p: string): Promise<string | undefined> => {
          if (p === '/work/projectA') {
            return '/work/projectA';
          }
          if (p === '/work/mybuild') {
            return '/work/mybuild';
          }
          return undefined;
        },
      });
      assert.deepStrictEqual(result, ['/work/projectA']);
    });
  });

  describe('do not recurse into a discovered repo', () => {
    it('does not recurse into a discovered repo even when maxDepth permits', async () => {
      // /work/projectA/.git exists, AND /work/projectA/sub/.git would be a
      // would-be inner repo — we MUST stop at projectA.
      const fs = makeFs({
        dirs: new Map([
          ['/work', ['projectA']],
          ['/work/projectA', ['sub']],
          ['/work/projectA/sub', []],
        ]),
        symlinks: new Set(),
        realpaths: new Map(),
      });
      const result = await scanForTest('/work', {
        maxDepth: 2,
        ignoredFolders: [],
        fs,
        resolveRepoRoot: async (p: string): Promise<string | undefined> => {
          if (p === '/work') {
            return undefined;
          }
          if (p === '/work/projectA') {
            return '/work/projectA';
          }
          if (p === '/work/projectA/sub') {
            return '/work/projectA/sub';
          }
          return undefined;
        },
      });
      assert.deepStrictEqual(result, ['/work/projectA']);
    });
  });

  describe('symlink handling', () => {
    it('skips symlinks when maxDepth is finite (>= 0)', async () => {
      // Default behavior at finite depth: do not follow symlinks. Avoids
      // accidentally pulling in repos via symlinked aliases.
      const fs = makeFs({
        dirs: new Map([['/work', ['projectA', 'linked']]]),
        symlinks: new Set(['/work/linked']),
        realpaths: new Map(),
      });
      const seen: string[] = [];
      await scanForTest('/work', {
        maxDepth: 1,
        ignoredFolders: [],
        fs,
        resolveRepoRoot: async (p: string): Promise<string | undefined> => {
          seen.push(p);
          if (p === '/work/projectA') {
            return '/work/projectA';
          }
          return undefined;
        },
      });
      assert.ok(
        !seen.includes('/work/linked'),
        `expected resolveRepoRoot NOT called on symlink, but call list was ${JSON.stringify(seen)}`
      );
    });

    it('follows symlinks at maxDepth=-1 with realpath cycle guard', async () => {
      // At unlimited depth we MAY follow symlinks but only if their realpath
      // hasn't been visited — otherwise a self-loop (e.g. ~/work/loop ->
      // ~/work) would scan forever.
      const fs = makeFs({
        dirs: new Map([
          ['/work', ['loop']],
          ['/work/loop', []], // not visited because cycle
        ]),
        symlinks: new Set(['/work/loop']),
        realpaths: new Map([
          ['/work', '/work'],
          ['/work/loop', '/work'], // cycle: loop -> work
        ]),
      });
      const result = await scanForTest('/work', {
        maxDepth: -1,
        ignoredFolders: [],
        fs,
        resolveRepoRoot: async (): Promise<string | undefined> => undefined,
      });
      // No repos found, scan terminated. The pure assertion is "no crash, no
      // infinite recursion" — the empty-result is the proxy.
      assert.deepStrictEqual(result, []);
    });

    it('discovers a repo behind a symlinked directory at maxDepth=-1', async () => {
      // The dead-code case: a Dirent for a symlink-to-dir reports
      // isDirectory() === false, so the scan must still let it through and
      // follow it (target is a directory) to reach the nested repo.
      const fs = makeFs({
        dirs: new Map([
          ['/work', ['linked']],
          ['/work/linked', ['inner']],
          ['/work/linked/inner', []],
        ]),
        symlinks: new Set(['/work/linked']),
        realpaths: new Map([['/work/linked', '/mnt/target']]),
      });
      const result = await scanForTest('/work', {
        maxDepth: -1,
        ignoredFolders: [],
        fs,
        resolveRepoRoot: async (p: string): Promise<string | undefined> =>
          p === '/work/linked/inner' ? '/work/linked/inner' : undefined,
      });
      assert.deepStrictEqual(result, ['/work/linked/inner']);
    });

    it('terminates and does not duplicate results on a symlink cycle at maxDepth=-1', async () => {
      // A real directory holds a repo child AND a symlink back to the root.
      // The cycle guard must stop the loop while still reporting the repo once.
      const fs = makeFs({
        dirs: new Map([
          ['/work', ['repo', 'link']],
          ['/work/repo', []],
        ]),
        symlinks: new Set(['/work/link']),
        realpaths: new Map([['/work/link', '/work']]), // link -> root
      });
      const result = await scanForTest('/work', {
        maxDepth: -1,
        ignoredFolders: [],
        fs,
        resolveRepoRoot: async (p: string): Promise<string | undefined> =>
          p === '/work/repo' ? '/work/repo' : undefined,
      });
      assert.deepStrictEqual(result, ['/work/repo']);
    });

    it('skips a symlink to a FILE at maxDepth=-1', async () => {
      // realpath alone can't tell a file target from a dir target; the stat
      // check must skip a symlink whose target is a file.
      const fs = makeFs({
        dirs: new Map([['/work', ['filelink']]]),
        symlinks: new Set(['/work/filelink']),
        realpaths: new Map([['/work/filelink', '/some/file']]),
        symlinkFileTargets: new Set(['/work/filelink']),
      });
      const seen: string[] = [];
      const result = await scanForTest('/work', {
        maxDepth: -1,
        ignoredFolders: [],
        fs,
        resolveRepoRoot: async (p: string): Promise<string | undefined> => {
          seen.push(p);
          return undefined;
        },
      });
      assert.deepStrictEqual(result, []);
      assert.ok(
        !seen.includes('/work/filelink'),
        `a symlink to a file must be skipped before resolveRepoRoot, got ${JSON.stringify(seen)}`
      );
    });
  });

  describe('dedup', () => {
    it('dedupes repo paths across recursion', async () => {
      // Defensive: if `resolveRepoRoot` reports the same root from two
      // different child paths (e.g. via symlinks at maxDepth=-1), the
      // returned array contains it once.
      const fs = makeFs({
        dirs: new Map([
          ['/work', ['a', 'b']],
          ['/work/a', []],
          ['/work/b', []],
        ]),
        symlinks: new Set(),
        realpaths: new Map(),
      });
      const result = await scanForTest('/work', {
        maxDepth: 1,
        ignoredFolders: [],
        fs,
        // Both children resolve to the SAME repo root.
        resolveRepoRoot: async (p: string): Promise<string | undefined> => {
          if (p === '/work') {
            return undefined;
          }
          if (p === '/work/a' || p === '/work/b') {
            return '/work/shared';
          }
          return undefined;
        },
      });
      assert.deepStrictEqual(result, ['/work/shared']);
    });
  });
});
