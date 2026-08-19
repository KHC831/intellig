/**
 * Wiring test for `wireBranchTreeNavigation` — the listener that turns a
 * Branches-tree selection into a graph jump.
 *
 * This is the production handler the tree view is wired to, so a branch row
 * must reach `navigateToBranch` (carrying the row's own repo, which
 * disambiguates same-named branches across roots) and a tag row must reach
 * `navigateToCommit` with the tag's peeled commit. Rows that address neither
 * (categories, folders, repository nodes) must navigate nowhere rather than
 * throwing inside a selection callback.
 *
 * The project does not use sinon; per docs/testing.md this file uses small,
 * purpose-built stubs that record only the calls under test.
 */

import '../../setup';
import * as assert from 'assert';
import { wireBranchTreeNavigation } from '../../../src/registration/wiring';
import type { IBranchTreeNavigationTreeView } from '../../../src/registration/wiring';
import { BranchTreeItem } from '../../../src/branches/BranchTreeProvider';
import { Uri } from '../../mocks/vscode';
import type { IBranch, IRepository, ITag } from '../../../src/git-core/interfaces/IGitService';

interface IDisposableStub {
  dispose(): void;
}

/** Stub tree view whose selection event the test fires by hand. */
class StubTreeView implements IBranchTreeNavigationTreeView {
  private _listeners: Array<(e: { selection: readonly BranchTreeItem[] }) => void> = [];
  public disposeCount = 0;

  onDidChangeSelection = (
    listener: (e: { selection: readonly BranchTreeItem[] }) => unknown
  ): IDisposableStub => {
    this._listeners.push(listener as (e: { selection: readonly BranchTreeItem[] }) => void);
    return {
      dispose: (): void => {
        this.disposeCount++;
      },
    };
  };

  select(...selection: BranchTreeItem[]): void {
    for (const listener of this._listeners) {
      listener({ selection });
    }
  }
}

function repoAt(fsPath: string): IRepository {
  return {
    rootUri: Uri.file(fsPath),
    state: 'idle',
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
}

function branchRow(name: string, repo?: IRepository): BranchTreeItem {
  const branch: IBranch = { name, type: 'local', commit: 'a'.repeat(40), isHead: false };
  return new BranchTreeItem(
    name,
    0,
    'local-branch',
    branch,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    repo
  );
}

function tagRow(name: string, commit: string): BranchTreeItem {
  const tag: ITag = { name, commit, isAnnotated: false };
  return new BranchTreeItem(name, 0, 'tag', undefined, tag);
}

function categoryRow(label: string): BranchTreeItem {
  return new BranchTreeItem(label, 1, 'category');
}

describe('wireBranchTreeNavigation — tree selection drives the graph', () => {
  /** Build the wiring over recording stubs. */
  function setup(): {
    view: StubTreeView;
    branchCalls: Array<{ name: string; repoRoot?: string }>;
    commitCalls: string[];
    disposable: { dispose(): void };
  } {
    const view = new StubTreeView();
    const branchCalls: Array<{ name: string; repoRoot?: string }> = [];
    const commitCalls: string[] = [];
    const disposable = wireBranchTreeNavigation({
      treeView: view,
      toolWindowProvider: {
        navigateToBranch: async (name, repoRoot) => {
          branchCalls.push({ name, repoRoot });
        },
        navigateToCommit: async (hash) => {
          commitCalls.push(hash);
        },
      },
    });
    return { view, branchCalls, commitCalls, disposable };
  }

  it('routes a branch row to navigateToBranch carrying the row own repo', () => {
    const { view, branchCalls, commitCalls } = setup();

    view.select(branchRow('feature/x', repoAt('/workspace/repo-b')));

    assert.deepStrictEqual(branchCalls, [{ name: 'feature/x', repoRoot: '/workspace/repo-b' }]);
    assert.strictEqual(commitCalls.length, 0, 'a branch row must not navigate by hash');
  });

  it('routes a tag row to navigateToCommit with the peeled commit', () => {
    const { view, branchCalls, commitCalls } = setup();

    view.select(tagRow('v1.0', 'e'.repeat(40)));

    assert.deepStrictEqual(commitCalls, ['e'.repeat(40)]);
    assert.strictEqual(branchCalls.length, 0, 'a tag row must not navigate by branch name');
  });

  it('navigates nowhere for structural rows or an empty selection', () => {
    const { view, branchCalls, commitCalls } = setup();

    view.select(categoryRow('Local'));
    view.select();

    assert.strictEqual(branchCalls.length + commitCalls.length, 0, 'no navigation is attempted');
  });

  it('survives a rejected navigation without throwing out of the selection callback', () => {
    const view = new StubTreeView();
    const disposable = wireBranchTreeNavigation({
      treeView: view,
      toolWindowProvider: {
        navigateToBranch: () => Promise.reject(new Error('window grow failed')),
        navigateToCommit: async () => undefined,
      },
    });

    // The tree-selection callback is synchronous; a rejected navigation must be
    // absorbed by safeFireAndForget, never surface as an unhandled rejection.
    assert.doesNotThrow(() => view.select(branchRow('feature/x')));
    disposable.dispose();
  });

  it('disposes the selection subscription', () => {
    const { view, disposable } = setup();

    disposable.dispose();

    assert.strictEqual(view.disposeCount, 1, 'no listener leak on extension deactivation');
  });
});
