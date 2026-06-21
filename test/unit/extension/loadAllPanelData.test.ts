/**
 * Wiring integration test for `loadAllPanelData` (spec git-view-layout-parity,
 * ).
 *
 * makes the Loading_State a transient state whose end is bounded
 * by the completion of Repository_Detection. The defect was that, in a workspace
 * with no git repository, nothing resolved the loading state and the tool window
 * stayed on the spinner forever. The fix wires detection completion to
 * `setHasRepository(repositories.length > 0)` inside `loadAllPanelData`.
 *
 * `loadAllPanelData` is a closure inside `activate`, so it can't be invoked in
 * isolation. Following the established testing seam in this module (the thin
 * exported `provideGitShowContent` helper that the production closure delegates
 * to), the wiring lives in the exported `loadAllPanelDataCore`, and the
 * production closure is a one-line delegation to it. These tests drive that core
 * directly with a stub provider that records every `setHasRepository` argument,
 * pinning the bounded-loading guarantee at the fix's call site.
 *
 * The project does not use sinon; per docs/testing.md the codebase uses small,
 * purpose-built stubs that record only the calls under test.
 */

import '../../setup';
import * as assert from 'assert';
import { loadAllPanelDataCore } from '../../../src/extension';
import type { ILoadAllPanelDataProvider, ILoadAllPanelDataDeps } from '../../../src/extension';
import { Uri } from '../../mocks/vscode';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';

/**
 * Stub provider recording the exact arguments the core passes to the two
 * provider methods `loadAllPanelData` touches. Nothing else from the real
 * `GitToolWindowProvider` is needed to verify the bounded-loading wiring.
 */
class RecordingProvider implements ILoadAllPanelDataProvider {
  public hasRepositoryCalls: boolean[] = [];
  public availableRepositoriesCalls: IRepository[][] = [];

  setAvailableRepositories(repos: IRepository[]): void {
    this.availableRepositoriesCalls.push(repos);
  }

  setHasRepository(hasRepository: boolean): void {
    this.hasRepositoryCalls.push(hasRepository);
  }
}

/** Build a minimal `IRepository` stub sufficient for these wiring tests. */
function createMockRepository(rootPath: string): IRepository {
  return {
    rootUri: Uri.file(rootPath),
    state: 'idle',
    head: undefined,
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
}

describe('loadAllPanelData wiring — bounded loading guarantee (Req 3.4)', () => {
  it('calls setHasRepository(false) when discovery returns no repositories', async () => {
    const provider = new RecordingProvider();
    let loadLogCommitsCalls = 0;

    const deps: ILoadAllPanelDataDeps = {
      discoverAllRepositories: async () => [],
      provider,
      loadLogCommits: async () => {
        loadLogCommitsCalls++;
      },
    };

    await loadAllPanelDataCore(deps);

    // The empty-detection path must report `false` — the sole signal that
    // leaves Loading and lands the view in No_Repository_State.
    assert.deepStrictEqual(
      provider.hasRepositoryCalls,
      [false],
      'expected exactly one setHasRepository(false) call on the no-repository path'
    );
    // The selector is still updated (with the empty list) before the outcome
    // is reported.
    assert.strictEqual(provider.availableRepositoriesCalls.length, 1);
    assert.deepStrictEqual(provider.availableRepositoriesCalls[0], []);
    // Detection completion still chains into the commit load.
    assert.strictEqual(loadLogCommitsCalls, 1);
  });

  it('calls setHasRepository(true) when discovery returns a repository', async () => {
    const provider = new RecordingProvider();
    const repo = createMockRepository('/workspace/repo');
    let loadLogCommitsCalls = 0;

    const deps: ILoadAllPanelDataDeps = {
      discoverAllRepositories: async () => [repo],
      provider,
      loadLogCommits: async () => {
        loadLogCommitsCalls++;
      },
    };

    await loadAllPanelDataCore(deps);

    // The populated path reports `true`, clearing Loading; the graph then
    // fills via loadLogCommits.
    assert.deepStrictEqual(
      provider.hasRepositoryCalls,
      [true],
      'expected exactly one setHasRepository(true) call on the repository-present path'
    );
    assert.strictEqual(provider.availableRepositoriesCalls.length, 1);
    assert.deepStrictEqual(provider.availableRepositoriesCalls[0], [repo]);
    assert.strictEqual(loadLogCommitsCalls, 1);
  });

  it('passes the full discovered repository list to the selector before resolving loading', async () => {
    const provider = new RecordingProvider();
    const repos = [createMockRepository('/workspace/a'), createMockRepository('/workspace/b')];

    const deps: ILoadAllPanelDataDeps = {
      discoverAllRepositories: async () => repos,
      provider,
      loadLogCommits: async () => {},
    };

    await loadAllPanelDataCore(deps);

    // setAvailableRepositories receives the full list and setHasRepository(true)
    // resolves loading (length > 0).
    assert.deepStrictEqual(provider.availableRepositoriesCalls[0], repos);
    assert.deepStrictEqual(provider.hasRepositoryCalls, [true]);
  });

  it('does not throw and still loads commits when the provider is undefined', async () => {
    let loadLogCommitsCalls = 0;

    const deps: ILoadAllPanelDataDeps = {
      discoverAllRepositories: async () => [],
      provider: undefined,
      loadLogCommits: async () => {
        loadLogCommitsCalls++;
      },
    };

    await assert.doesNotReject(() => loadAllPanelDataCore(deps));
    assert.strictEqual(loadLogCommitsCalls, 1);
  });
});
