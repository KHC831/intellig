/**
 * Wiring test for `wireRepositorySelection` — pins the scope-driven update of
 * BOTH the Git tool window's Log/Graph view AND the Branches tree view from a
 * single repository-scope change event.
 *
 * The selector exposes one scope state: `'all'` (merged log, optionally
 * narrowed to a checked subset of roots) or a specific repository. Both
 * downstream views must react to the SAME `onDidChangeRepositoryScope` event
 * so the log and the branches tree always show the same repositories.
 *
 * `wireRepositorySelection` is exported from `extension.ts` for the same
 * reason `loadAllPanelDataCore` is — the production wiring lives inside an
 * `activate` closure that can't be invoked in isolation, so the testable
 * core is extracted and the closure becomes a thin delegation.
 *
 * The project does not use sinon; per docs/testing.md this file uses small,
 * purpose-built stubs that record only the calls under test.
 */

import '../../setup';
import * as assert from 'assert';
import { wireRepositorySelection } from '../../../src/extension';
import type {
  IRepoSelectionToolWindowProvider,
  IRepoSelectionBranchTreeProvider,
} from '../../../src/extension';
import type { RepositoryScopeSelection } from '../../../src/registration/wiring';
import { Uri } from '../../mocks/vscode';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';
import type { ILogFilter } from '../../../src/git-core/interfaces/IGitToolWindowProvider';

/**
 * Minimal Disposable stub matching `vscode.Disposable`'s shape for the
 * `Event.dispose()` round-trip.
 */
interface IDisposableStub {
  dispose(): void;
}

/**
 * Stub tool-window provider exposing only `onDidChangeRepositoryScope`. Records
 * each subscription so the test can fire the event manually and verify
 * dispose() is called when the returned disposables are torn down.
 */
class StubToolWindowProvider implements IRepoSelectionToolWindowProvider {
  private _listeners: Array<(scope: RepositoryScopeSelection) => void> = [];
  public disposeCount = 0;

  // The `onDidChangeRepositoryScope` event signature mirrors `vscode.Event<T>`:
  // a function that, given a listener, returns a Disposable.
  onDidChangeRepositoryScope = (
    listener: (scope: RepositoryScopeSelection) => unknown
  ): IDisposableStub => {
    this._listeners.push(listener as (scope: RepositoryScopeSelection) => void);
    return {
      dispose: (): void => {
        this.disposeCount++;
      },
    };
  };

  /** Test-only — fire the event with the given scope to all subscribed listeners. */
  fire(scope: RepositoryScopeSelection): void {
    for (const listener of this._listeners) {
      listener(scope);
    }
  }

  /** Test-only — number of listeners currently subscribed. */
  listenerCount(): number {
    return this._listeners.length;
  }
}

/**
 * Stub branch tree provider that records every `setRepository` and
 * `setVisibleRepoRoots` call so the test can assert the selector's scope
 * reaches the branches view: the recorded repo backs row fallbacks, the
 * visible-roots set is what actually hides non-selected repos.
 */
class RecordingBranchTreeProvider implements IRepoSelectionBranchTreeProvider {
  public setRepositoryCalls: IRepository[] = [];
  public setVisibleRepoRootsCalls: Array<readonly string[] | null> = [];

  setRepository(repo: IRepository): void {
    this.setRepositoryCalls.push(repo);
  }

  setVisibleRepoRoots(roots: readonly string[] | null): void {
    this.setVisibleRepoRootsCalls.push(roots);
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

describe('wireRepositorySelection — scope change updates BOTH the Git view AND the Branches view', () => {
  it('subscribes exactly one scope listener and returns one disposable for it', () => {
    const toolWindow = new StubToolWindowProvider();
    const branchTree = new RecordingBranchTreeProvider();

    const disposables = wireRepositorySelection({
      toolWindowProvider: toolWindow,
      branchTreeProvider: branchTree,
      loadLogCommitsForRepo: async () => undefined,
      loadAllRootsLog: async () => undefined,
      activeLogFilter: () => undefined,
    });

    assert.strictEqual(
      toolWindow.listenerCount(),
      1,
      'wireRepositorySelection must register a single scope listener that drives both views'
    );
    assert.strictEqual(
      disposables.length,
      1,
      'wireRepositorySelection must return one disposable for the scope listener'
    );
  });

  it('records the selected repo on the branches tree when a specific repository is chosen', () => {
    const toolWindow = new StubToolWindowProvider();
    const branchTree = new RecordingBranchTreeProvider();

    wireRepositorySelection({
      toolWindowProvider: toolWindow,
      branchTreeProvider: branchTree,
      loadLogCommitsForRepo: async () => undefined,
      loadAllRootsLog: async () => undefined,
      activeLogFilter: () => undefined,
    });

    const repoA = createMockRepository('/workspace/repo-a');
    const repoB = createMockRepository('/workspace/repo-b');

    toolWindow.fire({ kind: 'repository', repository: repoA });
    toolWindow.fire({ kind: 'repository', repository: repoB });

    assert.strictEqual(branchTree.setRepositoryCalls.length, 2);
    assert.strictEqual(branchTree.setRepositoryCalls[0].rootUri.fsPath, '/workspace/repo-a');
    assert.strictEqual(branchTree.setRepositoryCalls[1].rootUri.fsPath, '/workspace/repo-b');
  });

  it('narrows the branches tree to the selected repo (hides the others)', () => {
    const toolWindow = new StubToolWindowProvider();
    const branchTree = new RecordingBranchTreeProvider();

    wireRepositorySelection({
      toolWindowProvider: toolWindow,
      branchTreeProvider: branchTree,
      loadLogCommitsForRepo: async () => undefined,
      loadAllRootsLog: async () => undefined,
      activeLogFilter: () => undefined,
    });

    toolWindow.fire({ kind: 'repository', repository: createMockRepository('/workspace/repo-a') });

    assert.deepStrictEqual(
      branchTree.setVisibleRepoRootsCalls,
      [['/workspace/repo-a']],
      'a specific selection narrows the tree to that one repo'
    );
  });

  it('passes a checked-subset scope through to the branches tree', () => {
    const toolWindow = new StubToolWindowProvider();
    const branchTree = new RecordingBranchTreeProvider();

    wireRepositorySelection({
      toolWindowProvider: toolWindow,
      branchTreeProvider: branchTree,
      loadLogCommitsForRepo: async () => undefined,
      loadAllRootsLog: async () => undefined,
      activeLogFilter: () => undefined,
    });

    const subset = ['/workspace/repo-a', '/workspace/repo-c'];
    toolWindow.fire({ kind: 'all', visibleRoots: subset });
    toolWindow.fire({ kind: 'all', visibleRoots: null });

    assert.deepStrictEqual(
      branchTree.setVisibleRepoRootsCalls,
      [subset, null],
      'the merged scope forwards its visible subset (null = every repo)'
    );
  });

  it('reloads the single-repo Log/Graph view via loadLogCommitsForRepo on a specific selection', () => {
    const toolWindow = new StubToolWindowProvider();
    const branchTree = new RecordingBranchTreeProvider();
    const loadLogCalls: IRepository[] = [];
    let allRootsCalls = 0;

    wireRepositorySelection({
      toolWindowProvider: toolWindow,
      branchTreeProvider: branchTree,
      loadLogCommitsForRepo: async (repo: IRepository) => {
        loadLogCalls.push(repo);
      },
      loadAllRootsLog: async () => {
        allRootsCalls++;
      },
      activeLogFilter: () => undefined,
    });

    const repoA = createMockRepository('/workspace/repo-a');
    toolWindow.fire({ kind: 'repository', repository: repoA });

    assert.strictEqual(loadLogCalls.length, 1);
    assert.strictEqual(loadLogCalls[0].rootUri.fsPath, '/workspace/repo-a');
    assert.strictEqual(allRootsCalls, 0, 'specific selection must NOT call the merged loader');
  });

  it('forwards a specific selection to the Commit tool window when one is wired', () => {
    const toolWindow = new StubToolWindowProvider();
    const branchTree = new RecordingBranchTreeProvider();
    const ctwCalls: IRepository[] = [];

    wireRepositorySelection({
      toolWindowProvider: toolWindow,
      branchTreeProvider: branchTree,
      loadLogCommitsForRepo: async () => undefined,
      loadAllRootsLog: async () => undefined,
      activeLogFilter: () => undefined,
      commitToolWindow: {
        setRepository: (repo: IRepository) => {
          ctwCalls.push(repo);
        },
      },
    });

    const repoA = createMockRepository('/workspace/repo-a');
    toolWindow.fire({ kind: 'repository', repository: repoA });
    toolWindow.fire({ kind: 'all', visibleRoots: null });

    assert.strictEqual(ctwCalls.length, 1, 'specific selection reaches the Commit tool window');
    assert.strictEqual(ctwCalls[0].rootUri.fsPath, '/workspace/repo-a');
  });

  it('routes the "All Repositories" scope to the merged log loader without recording a repo', () => {
    const toolWindow = new StubToolWindowProvider();
    const branchTree = new RecordingBranchTreeProvider();
    const loadLogCalls: IRepository[] = [];
    let allRootsCalls = 0;

    wireRepositorySelection({
      toolWindowProvider: toolWindow,
      branchTreeProvider: branchTree,
      loadLogCommitsForRepo: async (repo: IRepository) => {
        loadLogCalls.push(repo);
      },
      loadAllRootsLog: async () => {
        allRootsCalls++;
      },
      activeLogFilter: () => undefined,
    });

    toolWindow.fire({ kind: 'all', visibleRoots: null });

    assert.strictEqual(allRootsCalls, 1, 'all scope must call the merged log loader');
    assert.strictEqual(loadLogCalls.length, 0, 'all scope must NOT call the single-repo loader');
    assert.strictEqual(
      branchTree.setRepositoryCalls.length,
      0,
      'all scope must NOT record a single repo on the branch tree'
    );
  });

  it('keeps the log and branches in agreement from one scope event (regression: views could desync)', () => {
    const toolWindow = new StubToolWindowProvider();
    const branchTree = new RecordingBranchTreeProvider();
    const loadLogCalls: IRepository[] = [];

    wireRepositorySelection({
      toolWindowProvider: toolWindow,
      branchTreeProvider: branchTree,
      loadLogCommitsForRepo: async (repo: IRepository) => {
        loadLogCalls.push(repo);
      },
      loadAllRootsLog: async () => undefined,
      activeLogFilter: () => undefined,
    });

    const repo = createMockRepository('/workspace/multi-root-repo-2');
    toolWindow.fire({ kind: 'repository', repository: repo });

    assert.strictEqual(loadLogCalls.length, 1, 'graph view must reload on selection change');
    assert.strictEqual(
      branchTree.setRepositoryCalls.length,
      1,
      'branches tree view must refresh on selection change'
    );
    assert.strictEqual(
      loadLogCalls[0].rootUri.fsPath,
      branchTree.setRepositoryCalls[0].rootUri.fsPath,
      'both views must observe the SAME repo from the same scope event'
    );
  });

  it('reapplies the active log filter when a specific-repo scope reloads the log', () => {
    const toolWindow = new StubToolWindowProvider();
    const branchTree = new RecordingBranchTreeProvider();
    const received: Array<ILogFilter | undefined> = [];
    const active: ILogFilter = { branch: 'main' };

    wireRepositorySelection({
      toolWindowProvider: toolWindow,
      branchTreeProvider: branchTree,
      loadLogCommitsForRepo: async (_repo: IRepository, filter?: ILogFilter) => {
        received.push(filter);
      },
      loadAllRootsLog: async () => undefined,
      activeLogFilter: () => active,
    });

    toolWindow.fire({ kind: 'repository', repository: createMockRepository('/workspace/repo-a') });

    assert.strictEqual(received.length, 1);
    assert.strictEqual(
      received[0],
      active,
      'a scope reload must carry the active filter — an unfiltered reload silently widens a filtered log while the filter row still shows its values'
    );
  });

  it('reapplies the active log filter when the "All Repositories" scope reloads the merged log', () => {
    const toolWindow = new StubToolWindowProvider();
    const branchTree = new RecordingBranchTreeProvider();
    const received: Array<ILogFilter | undefined> = [];
    const active: ILogFilter = { searchText: 'fix' };

    wireRepositorySelection({
      toolWindowProvider: toolWindow,
      branchTreeProvider: branchTree,
      loadLogCommitsForRepo: async () => undefined,
      loadAllRootsLog: async (filter?: ILogFilter) => {
        received.push(filter);
      },
      activeLogFilter: () => active,
    });

    toolWindow.fire({ kind: 'all', visibleRoots: null });

    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0], active, 'the merged scope reload must carry the active filter');
  });

  it('reads the active filter live at event time, not once at wiring time', () => {
    const toolWindow = new StubToolWindowProvider();
    const branchTree = new RecordingBranchTreeProvider();
    const received: Array<ILogFilter | undefined> = [];
    let active: ILogFilter | undefined = undefined;

    wireRepositorySelection({
      toolWindowProvider: toolWindow,
      branchTreeProvider: branchTree,
      loadLogCommitsForRepo: async (_repo: IRepository, filter?: ILogFilter) => {
        received.push(filter);
      },
      loadAllRootsLog: async () => undefined,
      activeLogFilter: () => active,
    });

    const repo = createMockRepository('/workspace/repo-a');
    toolWindow.fire({ kind: 'repository', repository: repo });
    active = { author: 'kahochan' };
    toolWindow.fire({ kind: 'repository', repository: repo });

    assert.strictEqual(received.length, 2);
    assert.strictEqual(received[0], undefined, 'no filter active at first fire');
    assert.strictEqual(
      received[1],
      active,
      'the second fire must observe the filter applied AFTER wiring — the read is call-time, not a snapshot'
    );
  });

  it('returns disposables that tear down the scope subscription when disposed', () => {
    const toolWindow = new StubToolWindowProvider();
    const branchTree = new RecordingBranchTreeProvider();

    const disposables = wireRepositorySelection({
      toolWindowProvider: toolWindow,
      branchTreeProvider: branchTree,
      loadLogCommitsForRepo: async () => undefined,
      loadAllRootsLog: async () => undefined,
      activeLogFilter: () => undefined,
    });

    for (const d of disposables) {
      d.dispose();
    }

    assert.strictEqual(
      toolWindow.disposeCount,
      1,
      'the scope subscription must be disposed (no leak on extension deactivation)'
    );
  });
});
