/**
 * Unit tests for the persistent in-progress status-bar item (#28).
 *
 * Drives the component with a stub repo accessor + change event and asserts
 * the underlying (mocked) StatusBarItem's visibility, text, and command.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { InProgressStatusBar } from '../../../ui-shell/InProgressStatusBar';
import { IRepository, RepositoryState } from '../../../git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

interface MockItem {
  text: string;
  tooltip: string | undefined;
  command: string | undefined;
  _shown: boolean;
  _disposed: boolean;
}

function makeRepo(state: RepositoryState, target?: string): IRepository {
  return {
    rootUri: Uri.file('/test/repo'),
    state,
    head: { name: 'refs/heads/main', commit: 'deadbeef', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
    ...(state === 'idle' ? {} : { inProgress: { kind: state, target } }),
  } as unknown as IRepository;
}

/** Stub deps with a manually-fireable change event + mutable repo set. */
function makeDeps(initial: IRepository[]): {
  deps: { getRepositories(): IRepository[]; onDidChangeRepository: vscode.Event<IRepository> };
  setRepos(next: IRepository[]): void;
  fire(): void;
} {
  let repos = initial;
  let listener: ((r: IRepository) => void) | undefined;
  return {
    deps: {
      getRepositories: () => repos,
      onDidChangeRepository: ((l: (r: IRepository) => void) => {
        listener = l;
        return { dispose: () => {} };
      }) as unknown as vscode.Event<IRepository>,
    },
    setRepos: (next) => {
      repos = next;
    },
    fire: () => listener?.(repos[0]),
  };
}

/** The component creates its item via the mocked `createStatusBarItem`. */
function itemOf(bar: InProgressStatusBar): MockItem {
  return (bar as unknown as { _item: MockItem })._item;
}

describe('InProgressStatusBar (#28)', () => {
  it('is hidden when all repositories are idle', () => {
    const { deps } = makeDeps([makeRepo('idle')]);
    const bar = new InProgressStatusBar(deps);
    assert.strictEqual(itemOf(bar)._shown, false);
    bar.dispose();
  });

  it('shows the badge + wires the unified resolve command when a repo is rebasing', () => {
    const { deps } = makeDeps([makeRepo('rebasing', 'main')]);
    const bar = new InProgressStatusBar(deps);
    const item = itemOf(bar);
    assert.strictEqual(item._shown, true);
    assert.ok(item.text.includes('Rebase'), 'badge names the op');
    assert.ok(item.tooltip!.includes('main'), 'tooltip carries the target');
    assert.strictEqual(item.command, 'intellig.showResolveConflictsDialog');
    bar.dispose();
  });

  it('surfaces merge / cherry-pick / revert too (all in-progress ops)', () => {
    for (const state of ['merging', 'cherry-picking', 'reverting'] as const) {
      const { deps } = makeDeps([makeRepo(state)]);
      const bar = new InProgressStatusBar(deps);
      assert.strictEqual(itemOf(bar)._shown, true, `${state} surfaces the badge`);
      bar.dispose();
    }
  });

  it('toggles visibility as a repo transitions idle → rebasing → idle', () => {
    const ctl = makeDeps([makeRepo('idle')]);
    const bar = new InProgressStatusBar(ctl.deps);
    assert.strictEqual(itemOf(bar)._shown, false, 'starts hidden (idle)');

    ctl.setRepos([makeRepo('rebasing')]);
    ctl.fire();
    assert.strictEqual(itemOf(bar)._shown, true, 'shows once rebasing');

    ctl.setRepos([makeRepo('idle')]);
    ctl.fire();
    assert.strictEqual(itemOf(bar)._shown, false, 'hides again once resolved');
    bar.dispose();
  });

  it('multi-root: surfaces the first in-progress repo when one is paused', () => {
    const { deps } = makeDeps([makeRepo('idle'), makeRepo('cherry-picking')]);
    const bar = new InProgressStatusBar(deps);
    assert.strictEqual(itemOf(bar)._shown, true);
    assert.ok(itemOf(bar).text.includes('Cherry'));
    bar.dispose();
  });

  it('dispose() disposes the status-bar item', () => {
    const { deps } = makeDeps([makeRepo('rebasing')]);
    const bar = new InProgressStatusBar(deps);
    bar.dispose();
    assert.strictEqual(itemOf(bar)._disposed, true);
  });
});
