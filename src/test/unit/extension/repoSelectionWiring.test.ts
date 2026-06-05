/**
 * Wiring test for `wireRepositorySelection` — pins the dual-update behavior
 * of the Git tool window's repository selector dropdown.
 *
 * The bug this fixes: switching repos in the dropdown updated only the Git
 * (Log/Graph) view and silently left the Branches tree view pointing at the
 * previously-selected repo. Both downstream views must react to a single
 * `onDidSelectRepository` event.
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
import { wireRepositorySelection } from '../../../extension';
import type {
  IRepoSelectionToolWindowProvider,
  IRepoSelectionBranchTreeProvider,
} from '../../../extension';
import { Uri } from '../../mocks/vscode';
import type { IRepository } from '../../../git-core/interfaces/IGitService';

/**
 * Minimal Disposable stub matching `vscode.Disposable`'s shape for the
 * `Event.dispose()` round-trip.
 */
interface IDisposableStub {
  dispose(): void;
}

/**
 * Stub tool-window provider exposing only `onDidSelectRepository`. Records
 * each subscription so the test can fire the event manually and verify
 * dispose() is called when the returned disposables are torn down.
 */
class StubToolWindowProvider implements IRepoSelectionToolWindowProvider {
  private _listeners: Array<(repo: IRepository) => void> = [];
  public disposeCount = 0;

  // The `onDidSelectRepository` event signature mirrors `vscode.Event<T>`:
  // a function that, given a listener, returns a Disposable.
  onDidSelectRepository = (listener: (repo: IRepository) => unknown): IDisposableStub => {
    this._listeners.push(listener as (repo: IRepository) => void);
    return {
      dispose: (): void => {
        this.disposeCount++;
      },
    };
  };

  /** Test-only — fire the event with the given repo to all subscribed listeners. */
  fire(repo: IRepository): void {
    for (const listener of this._listeners) {
      listener(repo);
    }
  }

  /** Test-only — number of listeners currently subscribed. */
  listenerCount(): number {
    return this._listeners.length;
  }
}

/**
 * Stub branch tree provider that records every `setRepository` call so the
 * test can assert the dropdown's selection reaches the branches view.
 */
class RecordingBranchTreeProvider implements IRepoSelectionBranchTreeProvider {
  public setRepositoryCalls: IRepository[] = [];

  setRepository(repo: IRepository): void {
    this.setRepositoryCalls.push(repo);
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

describe('wireRepositorySelection — dropdown updates BOTH the Git view AND the Branches view', () => {
  it('subscribes exactly one graph listener AND one branch-tree listener', () => {
    const toolWindow = new StubToolWindowProvider();
    const branchTree = new RecordingBranchTreeProvider();
    const loadLogCalls: IRepository[] = [];

    const disposables = wireRepositorySelection({
      toolWindowProvider: toolWindow,
      branchTreeProvider: branchTree,
      loadLogCommitsForRepo: async (repo: IRepository) => {
        loadLogCalls.push(repo);
      },
    });

    // Two independent listeners — one drives the graph reload, one drives
    // the branch tree refresh. They are intentionally separate so a future
    // refactor that disposes one cannot accidentally take the other down.
    assert.strictEqual(
      toolWindow.listenerCount(),
      2,
      'wireRepositorySelection must register both a graph listener and a branch-tree listener'
    );
    assert.strictEqual(
      disposables.length,
      2,
      'wireRepositorySelection must return one disposable per listener'
    );
  });

  it('refreshes the branches tree view when the dropdown selects a different repo', () => {
    const toolWindow = new StubToolWindowProvider();
    const branchTree = new RecordingBranchTreeProvider();

    wireRepositorySelection({
      toolWindowProvider: toolWindow,
      branchTreeProvider: branchTree,
      loadLogCommitsForRepo: async () => undefined,
    });

    const repoA = createMockRepository('/workspace/repo-a');
    const repoB = createMockRepository('/workspace/repo-b');

    toolWindow.fire(repoA);
    toolWindow.fire(repoB);

    assert.strictEqual(branchTree.setRepositoryCalls.length, 2);
    assert.strictEqual(branchTree.setRepositoryCalls[0].rootUri.fsPath, '/workspace/repo-a');
    assert.strictEqual(branchTree.setRepositoryCalls[1].rootUri.fsPath, '/workspace/repo-b');
  });

  it('reloads the Log/Graph view for the selected repo via loadLogCommitsForRepo', () => {
    const toolWindow = new StubToolWindowProvider();
    const branchTree = new RecordingBranchTreeProvider();
    const loadLogCalls: IRepository[] = [];

    wireRepositorySelection({
      toolWindowProvider: toolWindow,
      branchTreeProvider: branchTree,
      loadLogCommitsForRepo: async (repo: IRepository) => {
        loadLogCalls.push(repo);
      },
    });

    const repoA = createMockRepository('/workspace/repo-a');
    toolWindow.fire(repoA);

    assert.strictEqual(loadLogCalls.length, 1);
    assert.strictEqual(loadLogCalls[0].rootUri.fsPath, '/workspace/repo-a');
  });

  it('updates BOTH views from a single dropdown selection (regression: branch tree was previously left out)', () => {
    const toolWindow = new StubToolWindowProvider();
    const branchTree = new RecordingBranchTreeProvider();
    const loadLogCalls: IRepository[] = [];

    wireRepositorySelection({
      toolWindowProvider: toolWindow,
      branchTreeProvider: branchTree,
      loadLogCommitsForRepo: async (repo: IRepository) => {
        loadLogCalls.push(repo);
      },
    });

    const repo = createMockRepository('/workspace/multi-root-repo-2');
    toolWindow.fire(repo);

    // The whole point of the fix: ONE dropdown change touches BOTH views.
    assert.strictEqual(loadLogCalls.length, 1, 'graph view must reload on selection change');
    assert.strictEqual(
      branchTree.setRepositoryCalls.length,
      1,
      'branches tree view must refresh on selection change'
    );
    assert.strictEqual(
      loadLogCalls[0].rootUri.fsPath,
      branchTree.setRepositoryCalls[0].rootUri.fsPath,
      'both views must observe the SAME repo from the same selection event'
    );
  });

  it('returns disposables that tear down both subscriptions when disposed', () => {
    const toolWindow = new StubToolWindowProvider();
    const branchTree = new RecordingBranchTreeProvider();

    const disposables = wireRepositorySelection({
      toolWindowProvider: toolWindow,
      branchTreeProvider: branchTree,
      loadLogCommitsForRepo: async () => undefined,
    });

    for (const d of disposables) {
      d.dispose();
    }

    assert.strictEqual(
      toolWindow.disposeCount,
      2,
      'both event subscriptions must be disposed (no leak on extension deactivation)'
    );
  });
});
