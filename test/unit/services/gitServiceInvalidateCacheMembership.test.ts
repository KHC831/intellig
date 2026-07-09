/**
 * `GitService.invalidateCache` marks a repo entry STALE, it does NOT drop the
 * repo from membership.
 *
 * Membership invariant: `getRepositories()` returns identity/membership only
 * (see its JSDoc) and its membership changes ONLY via `removeRepositoryWatcher`
 * (workspace-folder removal / `.git` deletion) and `dispose`. A cache
 * invalidation from an ops mutation must keep the repo present so that a
 * consumer reading the list mid-invalidation (e.g. `wireAvailableRepositorySync`
 * pushing `setAvailableRepositories(getRepositories())` on every
 * `onDidChangeRepository`) never sees a repo momentarily vanish — the class
 * behind the multi-root dropdown drop/collapse bug family.
 *
 * Freshness is still enforced: an invalidated entry reads as past-TTL, so the
 * TTL consumers (`getCachedRepository`, `findOwningRepository`) treat it as a
 * miss and reload rather than serving stale state.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { okAsync, errAsync, ResultAsync } from 'neverthrow';
import { GitService } from '../../../src/git-core/GitService';
import { GitError, SpawnFailedError } from '../../../src/git-core/errors';
import { wireAvailableRepositorySync } from '../../../src/registration/wiring';
import type { IAvailableRepositoriesProvider } from '../../../src/registration/wiring';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

/** Narrow view of the private cache-invalidation seam, for the test. */
type InvalidateSeam = { invalidateCache(rootPath: string): void };

class RecordingGitCli {
  /** Every cwd passed to getRepositoryRoot — used to detect a reload spawn. */
  public rootCwds: string[] = [];

  async exec(): Promise<{ exitCode: number; stdout: string; stderr: string; combined: string }> {
    return { exitCode: 0, stdout: '', stderr: '', combined: '' };
  }

  getRepositoryRoot(p: string): ResultAsync<string | undefined, GitError> {
    this.rootCwds.push(p);
    let dir = p;
    try {
      if (!fs.statSync(p).isDirectory()) {
        return errAsync(new SpawnFailedError('spawn ENOTDIR'));
      }
    } catch {
      return errAsync(new SpawnFailedError('spawn ENOENT'));
    }
    while (dir !== path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, '.git'))) {
        return okAsync(fs.realpathSync.native(dir));
      }
      dir = path.dirname(dir);
    }
    return okAsync(undefined);
  }

  dispose(): void {}
}

function makeRepo(baseDir: string, name: string): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(baseDir, `${name}-`)));
  fs.mkdirSync(path.join(root, '.git'));
  return root;
}

describe('GitService.invalidateCache preserves repository membership', () => {
  let gitService: GitService;
  let cli: RecordingGitCli;
  let baseDir: string;

  beforeEach(() => {
    gitService = new GitService();
    cli = new RecordingGitCli();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._gitCli = cli;
    // Temp fixtures live under the gitignored workspace-notes/tmp, never os.tmpdir().
    const notesTmp = path.resolve(__dirname, '../../../workspace-notes/tmp');
    fs.mkdirSync(notesTmp, { recursive: true });
    baseDir = fs.realpathSync.native(fs.mkdtempSync(path.join(notesTmp, 'invalidate-')));
  });

  afterEach(() => {
    gitService.dispose();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('keeps a repo in getRepositories() immediately after invalidateCache', async () => {
    const root = makeRepo(baseDir, 'repo');
    const repo = await gitService.getRepository(Uri.file(root));
    assert.ok(repo, 'repo should be discovered');

    (gitService as unknown as InvalidateSeam).invalidateCache(root);

    const roots = gitService.getRepositories().map((r) => r.rootUri.fsPath);
    assert.ok(
      roots.includes(root),
      'getRepositories() membership must survive invalidateCache — only removeRepositoryWatcher drops a repo'
    );
  });

  it('reloads (does not serve the stale entry) after invalidateCache', async () => {
    const root = makeRepo(baseDir, 'repo');
    await gitService.getRepository(Uri.file(root));

    (gitService as unknown as InvalidateSeam).invalidateCache(root);

    cli.rootCwds = [];
    const resolved = await gitService.getRepository(Uri.file(root));
    assert.ok(resolved, 'repo still resolves via reload');
    assert.ok(
      cli.rootCwds.length > 0,
      'an invalidated entry must fall through to a fresh load, not be served from cache'
    );
  });

  it("does not drop repo A from the available list when B reloads inside A's invalidation window", async () => {
    const rootA = makeRepo(baseDir, 'repoA');
    const rootB = makeRepo(baseDir, 'repoB');
    await gitService.getRepository(Uri.file(rootA));
    const repoB = await gitService.getRepository(Uri.file(rootB));
    assert.ok(repoB, 'repo B should be discovered');

    const setCalls: string[][] = [];
    const provider: IAvailableRepositoriesProvider = {
      setAvailableRepositories: (repos: IRepository[]): void => {
        setCalls.push(repos.map((r) => r.rootUri.fsPath));
      },
    };
    const disposables = wireAvailableRepositorySync({ provider, gitService });

    // A's ops mutation invalidates A; B's reload completes inside that window
    // and fires onDidChangeRepository, driving the available-repository sync.
    (gitService as unknown as InvalidateSeam).invalidateCache(rootA);
    await gitService.reloadRepository(repoB);

    assert.ok(
      gitService.getRepositories().some((r) => r.rootUri.fsPath === rootA),
      'A must remain in getRepositories() while B reloads'
    );
    for (const list of setCalls) {
      assert.ok(
        list.includes(rootA),
        `setAvailableRepositories must never push a list missing A, got: ${JSON.stringify(list)}`
      );
    }

    disposables.forEach((d) => {
      d.dispose();
    });
  });
});
