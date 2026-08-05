/**
 * In the merged "All Repositories" scope the branch filter applies across every
 * visible root, so its dropdown options must be the UNION of all roots' branches
 * (IntelliJ BranchFilterModel parity) — not just the context repo's. A
 * single-repo scope still lists only that repo's branches.
 */

import '../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../src/ui-shell/GitToolWindowProvider';
import { IBranch, IGitService, IRepository } from '../../src/git-core/interfaces/IGitService';
import { Uri } from '../mocks/vscode';
import { createMockGitService } from '../mocks/mockGitService';

function repoAt(path: string): IRepository {
  return {
    rootUri: Uri.file(path),
    state: 'idle',
    head: { name: 'main', commit: 'abc123', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  };
}

function branch(name: string): IBranch {
  return { name, type: 'local', commit: 'deadbeef', isHead: false };
}

interface PostedMessage {
  type?: string;
  branchGroups?: { local: string[]; remotes: Array<{ remote: string; branches: string[] }> };
}

/** Capture postMessage payloads from a stub view attached to the provider. */
function attachCapturingView(provider: GitToolWindowProvider, sink: PostedMessage[]): void {
  /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
  (provider as any)._view = {
    webview: {
      get html(): string {
        return '';
      },
      set html(_v: string) {},
      options: {},
      cspSource: 'test:',
      onDidReceiveMessage: () => ({ dispose: () => {} }),
      postMessage: (m: PostedMessage) => {
        sink.push(m);
        return Promise.resolve(true);
      },
      asWebviewUri: (u: unknown) => u,
    },
    visible: true,
    onDidChangeVisibility: () => ({ dispose: () => {} }),
    onDidDispose: () => ({ dispose: () => {} }),
  };
  /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
}

function gitServiceWithBranches(
  repoA: IRepository,
  repoB: IRepository,
  byRepo: Map<string, IBranch[]>
): IGitService {
  return createMockGitService(repoA, {
    getRepositories: () => [repoA, repoB],
    getBranches: async (repo: IRepository) => byRepo.get(repo.rootUri.fsPath) ?? [],
    getLogContributors: async () => [],
  });
}

describe('Branch popup — option source per scope', () => {
  let provider: GitToolWindowProvider;
  let posted: PostedMessage[];
  const repoA = repoAt('/repos/a');
  const repoB = repoAt('/repos/b');
  const byRepo = new Map<string, IBranch[]>([
    ['/repos/a', [branch('main'), branch('feature/a')]],
    ['/repos/b', [branch('main'), branch('feature/b')]],
  ]);

  async function requestOptions(): Promise<void> {
    await (
      provider as unknown as { _handleRequestLogFilterOptions(): Promise<void> }
    )._handleRequestLogFilterOptions();
  }

  beforeEach(() => {
    provider = new GitToolWindowProvider(Uri.file('/test/extension'));
    provider.setAvailableRepositories([repoA, repoB]);
    provider.attachGitService(gitServiceWithBranches(repoA, repoB, byRepo));
    posted = [];
    attachCapturingView(provider, posted);
  });

  afterEach(() => {
    provider.dispose();
  });

  it('offers the UNION of all roots’ branches in the merged "All Repositories" scope', async () => {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
    (provider.repoScope as any)._repositoryScope = 'all';
    await requestOptions();
    const msg = posted.find((m) => m.type === 'logFilterOptionsReady');
    assert.deepStrictEqual(msg?.branchGroups?.local, ['feature/a', 'feature/b', 'main']);
    assert.deepStrictEqual(msg?.branchGroups?.remotes, []);
  });

  it('lists only the selected repo’s branches in a single-repo scope', async () => {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
    (provider.repoScope as any)._repositoryScope = 0; // repoA
    await requestOptions();
    const msg = posted.find((m) => m.type === 'logFilterOptionsReady');
    assert.deepStrictEqual(msg?.branchGroups?.local, ['feature/a', 'main']);
  });

  it('offers only the visible subset’s branches when a multi-root subset is active', async () => {
    // A 1-of-2 subset would collapse to a single-repo scope, so use a 3-repo
    // workspace and scope to {repoA} as the genuine "some but not all" case.
    const repoC = repoAt('/repos/c');
    const byRepo3 = new Map<string, IBranch[]>([
      ['/repos/a', [branch('main'), branch('feature/a')]],
      ['/repos/b', [branch('main'), branch('feature/b')]],
      ['/repos/c', [branch('main'), branch('feature/c')]],
    ]);
    provider.dispose();
    provider = new GitToolWindowProvider(Uri.file('/test/extension'));
    provider.setAvailableRepositories([repoA, repoB, repoC]);
    provider.attachGitService(
      createMockGitService(repoA, {
        getRepositories: () => [repoA, repoB, repoC],
        getBranches: async (repo: IRepository) => byRepo3.get(repo.rootUri.fsPath) ?? [],
        getLogContributors: async () => [],
      })
    );
    posted = [];
    attachCapturingView(provider, posted);

    // Check {repoA, repoC} — repoB's feature/b must be absent from the union.
    provider.repoScope.handleVisibleRepositoriesSelection(['/repos/a', '/repos/c']);
    await requestOptions();

    const msg = posted.find((m) => m.type === 'logFilterOptionsReady');
    assert.deepStrictEqual(msg?.branchGroups?.local, ['feature/a', 'feature/c', 'main']);
  });

  it('survives a hard rejection on ONE root (keeps the healthy roots, no throw)', async () => {
    // repoB's getBranches throws (e.g. unmounted multi-root → cwd ENOENT): the
    // union must still post repoA's branches and must not reject.
    provider = new GitToolWindowProvider(Uri.file('/test/extension'));
    provider.setAvailableRepositories([repoA, repoB]);
    provider.attachGitService(
      createMockGitService(repoA, {
        getRepositories: () => [repoA, repoB],
        getBranches: async (repo: IRepository) => {
          if (repo.rootUri.fsPath === '/repos/b') {
            throw new Error('spawn git ENOENT');
          }
          return byRepo.get(repo.rootUri.fsPath) ?? [];
        },
        getLogContributors: async () => [],
      })
    );
    posted = [];
    attachCapturingView(provider, posted);
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
    (provider.repoScope as any)._repositoryScope = 'all';

    await assert.doesNotReject(() => requestOptions());
    const msg = posted.find((m) => m.type === 'logFilterOptionsReady');
    assert.deepStrictEqual(
      msg?.branchGroups?.local,
      ['feature/a', 'main'],
      'healthy root survives'
    );
  });
});
