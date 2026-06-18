/**
 * Tests for `resolveCommitRepoByRoot` — targets the CLICKED commit's own
 * repository when the log is the merged "all repositories" view.
 *
 * The bug this guards: in 'all' scope the merged log interleaves commits from
 * every repo (each tagged with its `repoRoot`), but the commit-select and
 * commit-diff handlers resolved the repo via `getSelectedRepository()` — the
 * context repo only. Selecting a foreign-repo commit (often the newest one)
 * then ran `getCommitDiff(contextRepo, foreignHash)` → wrong/empty diff.
 *
 * The resolution is extracted from the `activate` closure (like
 * `wireRepositorySelection` / `loadAllPanelDataCore`) so it's unit-testable.
 *
 * No sinon — small purpose-built stubs per docs/testing.md.
 */

import '../../setup';
import * as assert from 'assert';
import { resolveCommitRepoByRoot } from '../../../extension';
import { Uri } from '../../mocks/vscode';
import type { IRepository } from '../../../git-core/interfaces/IGitService';

function mockRepository(rootPath: string): IRepository {
  return {
    rootUri: Uri.file(rootPath),
    state: 'idle',
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
}

describe('resolveCommitRepoByRoot — clicked-commit repo in the merged all-roots log', () => {
  it("resolves the commit's OWN repo (not the context repo) when a repoRoot is recorded", async () => {
    const repoBeta = mockRepository('/work/beta');
    const provider = {
      getRepoRootForCommit: (hash: string): string | undefined =>
        hash === 'bbbbbbb' ? '/work/beta' : undefined,
    };
    const queriedPaths: string[] = [];
    const gitService = {
      getRepository: async (uri: Uri): Promise<IRepository | undefined> => {
        queriedPaths.push(uri.fsPath);
        return uri.fsPath === '/work/beta' ? repoBeta : undefined;
      },
    };

    const resolved = await resolveCommitRepoByRoot(
      provider,
      gitService as unknown as Parameters<typeof resolveCommitRepoByRoot>[1],
      'bbbbbbb'
    );

    assert.strictEqual(resolved, repoBeta, 'must resolve the foreign commit to its own repo');
    assert.deepStrictEqual(
      queriedPaths,
      ['/work/beta'],
      'must look up the recorded repoRoot, not the context repo'
    );
  });

  it('returns undefined without querying getRepository when no repoRoot is recorded', async () => {
    const provider = {
      getRepoRootForCommit: (): string | undefined => undefined,
    };
    let queried = false;
    const gitService = {
      getRepository: async (): Promise<IRepository | undefined> => {
        queried = true;
        return undefined;
      },
    };

    const resolved = await resolveCommitRepoByRoot(
      provider,
      gitService as unknown as Parameters<typeof resolveCommitRepoByRoot>[1],
      'aaaaaaa'
    );

    assert.strictEqual(resolved, undefined, 'no repoRoot → defer to the handler fallback chain');
    assert.strictEqual(queried, false, 'must not query getRepository without a repoRoot');
  });

  it('returns undefined when the recorded repoRoot no longer resolves to a repo', async () => {
    const provider = {
      getRepoRootForCommit: (): string | undefined => '/work/gone',
    };
    const gitService = {
      getRepository: async (): Promise<IRepository | undefined> => undefined,
    };

    const resolved = await resolveCommitRepoByRoot(
      provider,
      gitService as unknown as Parameters<typeof resolveCommitRepoByRoot>[1],
      'aaaaaaa'
    );

    assert.strictEqual(resolved, undefined, 'unresolvable root → defer to the fallback chain');
  });

  it('tolerates a missing provider (returns undefined)', async () => {
    const gitService = {
      getRepository: async (): Promise<IRepository | undefined> => undefined,
    };
    const resolved = await resolveCommitRepoByRoot(
      undefined,
      gitService as unknown as Parameters<typeof resolveCommitRepoByRoot>[1],
      'aaaaaaa'
    );
    assert.strictEqual(resolved, undefined);
  });
});
