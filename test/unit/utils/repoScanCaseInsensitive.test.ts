/**
 * Tests for split-case ignored-folder matching (#214).
 *
 * **Background (#214):** the basename comparison was originally
 * uniformly case-sensitive, so on Windows a `.GIT` folder slipped past
 * the filter and the scanner spawned `git rev-parse --show-toplevel`
 * against it (or worse, descended into `NODE_MODULES`).
 *
 * **Case-sensitivity refinement:** the blanket case-insensitive policy
 * silently regressed Linux. A user with `Build/projectA/.git` had the
 * repo discovered under the original case-sensitive compare (Linux fs is
 * case-sensitive; `Build` ≠ `build` so not filtered) but the
 * case-insensitive policy made `Build` match `build` in
 * the lowercased ignored set. Same for `Out/`, `Target/`, `Vendor/`,
 * `Dist/` — common Pascal-case directories in C#/.NET, Rust, Java.
 *
 * **Contract:** split case policy.
 *   - `.git`, `.vscode`, `node_modules`, `.next`: filtered case-INsensitively
 *     because they're filesystem-canonicalized on Windows + case-insensitive
 *     macOS anyway.
 *   - `out`, `dist`, `target`, `build`, `vendor`: filtered with EXACT
 *     case so Pascal-case Linux directories keep working.
 *   - User-supplied `ignoredFolders`: filtered case-INsensitively so
 *     Windows users don't have to guess on-disk casing.
 *
 * Each split-case spec was authored RED-first and confirmed failing before the
 * split was wired in. See AGENT_WORKSPACE.md for the verbatim red captures.
 */

import '../../setup';
import * as assert from 'assert';
import { scanFolderForGitRepos, IRepoScanFs } from '../../../src/git-core/repoScan';

interface IFsState {
  dirs: Map<string, string[]>;
  symlinks: Set<string>;
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
      const children = state.dirs.get(dirPath) ?? [];
      return children.map((name) => ({
        name,
        isDirectory(): boolean {
          return true;
        },
        isSymbolicLink(): boolean {
          return state.symlinks.has(`${dirPath}/${name}`);
        },
        isFile(): boolean {
          return false;
        },
      }));
    },
    async realpath(p: string): Promise<string> {
      return p;
    },
  };
}

describe('scanFolderForGitRepos — split-case ignored folders (TL-89 / #214 + R1 / H2)', () => {
  // ============================================
  // Case-SENSITIVE matching for build directories so
  // case-sensitive Linux filesystems keep working with Pascal-case
  // directory names.
  // ============================================

  it('discovers nested `Build/projectA/.git` on case-sensitive disk (R1/H2 — `Build` ≠ `build`)', async () => {
    // The bug-this-finding-fixes case: a Linux user with `/work/Build/projectA/.git`.
    // The original case-sensitive compare worked here (`Build` ≠ `build`).
    // A lowercase compare wrongly filtered `Build` as a child entry.
    // `build` is in the case-SENSITIVE set, so `Build` (a CHILD entry
    // of /work) is NOT filtered, the scan recurses into it, and finds the
    // nested repo.
    const fs = makeFs({
      dirs: new Map([
        ['/work', ['Build']],
        ['/work/Build', ['projectA']],
      ]),
      symlinks: new Set(),
    });
    const result = await scanFolderForGitRepos('/work', {
      maxDepth: 2,
      ignoredFolders: [],
      fs,
      resolveRepoRoot: async (p: string): Promise<string | undefined> => {
        if (p === '/work/Build/projectA') {
          return '/work/Build/projectA';
        }
        return undefined;
      },
    });
    assert.deepStrictEqual(
      result,
      ['/work/Build/projectA'],
      '`Build/` (capital B) must NOT match the lowercase `build` ignored entry on case-sensitive Linux — pre-R1 the lowercase-blanket filter dropped this whole subtree'
    );
  });

  it('discovers nested `Out/cargo/.git` on case-sensitive disk (R1/H2 — `Out` ≠ `out`)', async () => {
    const fs = makeFs({
      dirs: new Map([
        ['/work', ['Out']],
        ['/work/Out', ['cargo']],
      ]),
      symlinks: new Set(),
    });
    const result = await scanFolderForGitRepos('/work', {
      maxDepth: 2,
      ignoredFolders: [],
      fs,
      resolveRepoRoot: async (p: string): Promise<string | undefined> => {
        if (p === '/work/Out/cargo') {
          return '/work/Out/cargo';
        }
        return undefined;
      },
    });
    assert.deepStrictEqual(
      result,
      ['/work/Out/cargo'],
      '`Out/` (capital O) must NOT match the lowercase `out` ignored entry on case-sensitive Linux'
    );
  });

  it('still filters lowercase `build/` exactly (R1/H2 — case-sensitive set retains exact match)', async () => {
    // Sanity check the negative side: a `build/` (lowercase) folder is
    // still filtered. Otherwise the case-sensitive set would have over-corrected and
    // dropped the case-insensitive protection entirely.
    const fs = makeFs({
      dirs: new Map([['/work', ['projectA', 'build']]]),
      symlinks: new Set(),
    });
    const seen: string[] = [];
    await scanFolderForGitRepos('/work', {
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
      !seen.includes('/work/build'),
      `expected resolveRepoRoot NOT called on lowercase /work/build, but call list was ${JSON.stringify(seen)}`
    );
  });

  // ============================================
  // #214: case-INsensitive matching retained for the
  // filesystem-canonicalized names (`.git`, `.vscode`, `node_modules`,
  // `.next`).
  // ============================================

  it('skips a child literally named `.GIT` (uppercase) the same way it skips `.git`', async () => {
    // Synthetic Windows-style path: a `.GIT` folder must be filtered out
    // because the basename matches the lowercase `.git` entry in
    // INTERNAL_IGNORED_FOLDERS under case-insensitive comparison.
    const fs = makeFs({
      dirs: new Map([['/work/repo', ['.GIT', 'src']]]),
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
    assert.ok(
      !seen.includes('/work/repo/.GIT'),
      `expected resolveRepoRoot NOT called on uppercase .GIT, but call list was ${JSON.stringify(seen)}`
    );
  });

  it('skips a child literally named `NODE_MODULES` (uppercase) the same way it skips `node_modules`', async () => {
    const fs = makeFs({
      dirs: new Map([['/work', ['projectA', 'NODE_MODULES']]]),
      symlinks: new Set(),
    });
    const seen: string[] = [];
    await scanFolderForGitRepos('/work', {
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
      !seen.includes('/work/NODE_MODULES'),
      `expected resolveRepoRoot NOT called on NODE_MODULES, but call list was ${JSON.stringify(seen)}`
    );
  });

  it('skips a mixed-case child like `Node_Modules` (matches lowercase `node_modules`)', async () => {
    // Defense-in-depth: case folding must be true case-insensitive, not just
    // a single-direction lowercase or single-direction uppercase compare.
    const fs = makeFs({
      dirs: new Map([['/work', ['projectA', 'Node_Modules']]]),
      symlinks: new Set(),
    });
    const seen: string[] = [];
    await scanFolderForGitRepos('/work', {
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
      !seen.includes('/work/Node_Modules'),
      `expected resolveRepoRoot NOT called on Node_Modules, but call list was ${JSON.stringify(seen)}`
    );
  });

  it('matches a user-supplied ignored folder regardless of case', async () => {
    // The contract MUST extend to user-supplied ignoredFolders too —
    // someone who configures `["mybuild"]` shouldn't have IntelliG suddenly
    // start scanning `MyBuild/` when they rename it on a case-preserving
    // filesystem.
    const fs = makeFs({
      dirs: new Map([['/work', ['projectA', 'MyBuild']]]),
      symlinks: new Set(),
    });
    const result = await scanFolderForGitRepos('/work', {
      maxDepth: 1,
      ignoredFolders: ['mybuild'], // lowercase user config
      fs,
      resolveRepoRoot: async (p: string): Promise<string | undefined> => {
        if (p === '/work/projectA') {
          return '/work/projectA';
        }
        if (p === '/work/MyBuild') {
          return '/work/MyBuild';
        }
        return undefined;
      },
    });
    assert.deepStrictEqual(
      result,
      ['/work/projectA'],
      'user-supplied ignoredFolders must match case-insensitively (lowercase config vs MixedCase entry)'
    );
  });

  it('matches a user-supplied UPPERCASE ignored folder against a lowercase entry', async () => {
    // Inverse of the above: user supplies UPPERCASE; entry is lowercase.
    const fs = makeFs({
      dirs: new Map([['/work', ['projectA', 'mybuild']]]),
      symlinks: new Set(),
    });
    const result = await scanFolderForGitRepos('/work', {
      maxDepth: 1,
      ignoredFolders: ['MYBUILD'], // uppercase user config
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
    assert.deepStrictEqual(
      result,
      ['/work/projectA'],
      'user-supplied UPPERCASE ignoredFolders must match lowercase entries case-insensitively'
    );
  });
});
