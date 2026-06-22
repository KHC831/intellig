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
import {
  resolveCommitRepoByRoot,
  resolveRepoForCommitDiff,
  resolveLogHeadAnchor,
} from '../../../src/extension';
import { Uri } from '../../mocks/vscode';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';

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

describe('resolveRepoForCommitDiff — non-interactive, containment-validated repo for "Changed files" diff', () => {
  // Two open repos; the commit exists ONLY in beta. Builds a gitService whose
  // getCommit succeeds for the repo that holds the hash and rejects otherwise.
  function makeServices(holder: IRepository, hash: string) {
    const alpha = mockRepository('/work/alpha');
    const repos = [alpha, holder];
    let quickPickCalls = 0;
    const gitService = {
      getRepository: async (uri: Uri): Promise<IRepository | undefined> =>
        repos.find((r) => r.rootUri.fsPath === uri.fsPath),
      getRepositories: (): IRepository[] => repos,
      getCommit: async (repo: IRepository, h: string) => {
        if (repo === holder && h === hash) {
          return { hash } as unknown;
        }
        throw new Error('unknown revision');
      },
      // Present so a regression that reaches for a picker would be observable.
      showQuickPick: (): undefined => {
        quickPickCalls++;
        return undefined;
      },
    };
    return { alpha, gitService, quickPickCalls: () => quickPickCalls };
  }

  type DiffArgs = Parameters<typeof resolveRepoForCommitDiff>;

  it('picks the repo that CONTAINS the commit, not the (wrong) selected repo, and never prompts', async () => {
    const beta = mockRepository('/work/beta');
    const { alpha, gitService, quickPickCalls } = makeServices(beta, 'bbbbbbb');
    // Single-log mode: no recorded root; selected repo is the WRONG one (alpha).
    const provider = {
      getRepoRootForCommit: (): string | undefined => undefined,
      getSelectedRepository: (): IRepository => alpha,
    };

    const resolved = await resolveRepoForCommitDiff(
      provider,
      gitService as unknown as DiffArgs[1],
      'bbbbbbb'
    );

    assert.strictEqual(
      resolved,
      beta,
      'must resolve the repo holding the commit (beta), not alpha'
    );
    assert.strictEqual(quickPickCalls(), 0, 'must never show a repository QuickPick');
  });

  it('falls through a recorded root that does not actually contain the commit', async () => {
    const beta = mockRepository('/work/beta');
    const { gitService } = makeServices(beta, 'bbbbbbb');
    // Recorded root points at alpha (stale), which does NOT hold the commit.
    const provider = {
      getRepoRootForCommit: (): string | undefined => '/work/alpha',
      getSelectedRepository: (): undefined => undefined,
    };

    const resolved = await resolveRepoForCommitDiff(
      provider,
      gitService as unknown as DiffArgs[1],
      'bbbbbbb'
    );

    assert.strictEqual(
      resolved,
      beta,
      'a non-containing recorded root must not win — probe to beta'
    );
  });

  it('returns undefined when no open repo contains the commit (caller shows an error, not a blank diff)', async () => {
    const beta = mockRepository('/work/beta');
    const { gitService } = makeServices(beta, 'bbbbbbb');
    const provider = {
      getRepoRootForCommit: (): string | undefined => undefined,
      getSelectedRepository: (): undefined => undefined,
    };

    const resolved = await resolveRepoForCommitDiff(
      provider,
      gitService as unknown as DiffArgs[1],
      'deadbeef'
    );

    assert.strictEqual(resolved, undefined, 'no repo holds the commit → undefined (no blank diff)');
  });
});

/**
 * L-1 — the merged "All Repositories" graph must NOT anchor its HEAD highlight
 * (the yellow current-branch chip) or its lane-0 spine to a single repo's HEAD.
 * Doing so misleadingly singles out the context repo's current branch across an
 * interleaved multi-repo graph. IntelliJ highlights each root's HEAD; matching
 * that needs per-row repo identity on the branch chips, so merged mode instead
 * SUPPRESSES the anchor. Single-repo / specific scope keeps the repo's own HEAD.
 */
describe('resolveLogHeadAnchor — merged-log HEAD spine / current-branch highlight', () => {
  const repo = {
    head: { name: 'refs/heads/main', commit: 'abc1230000000000000000000000000000000000' },
  } as unknown as IRepository;

  it('suppresses the HEAD anchor in merged (all-roots) mode so no single repo is highlighted as HEAD', () => {
    assert.deepStrictEqual(
      resolveLogHeadAnchor(true, repo),
      {},
      'merged mode must pass no headHash / headBranchName to the log state'
    );
  });

  it("uses the repo's own HEAD (hash + de-prefixed branch name) in single-repo / specific scope", () => {
    assert.deepStrictEqual(resolveLogHeadAnchor(false, repo), {
      headHash: 'abc1230000000000000000000000000000000000',
      headBranchName: 'main',
    });
  });

  it('tolerates a missing repo / detached HEAD in single-repo scope', () => {
    assert.deepStrictEqual(resolveLogHeadAnchor(false, undefined), {
      headHash: undefined,
      headBranchName: undefined,
    });
  });
});
