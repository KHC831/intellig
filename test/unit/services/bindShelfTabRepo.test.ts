/**
 * The Commit tool window's Shelf/Stash tab is backed by TWO views: the shelf
 * view owns shelf rows, the stash view owns stash rows. Both must be refreshed
 * before an action runs — refreshing only the shelf view leaves the stash
 * view's action-backing state empty, so every stash action fails
 * "Stash not found: stash@{n}" even though the tab renders the stashes (the
 * tool window renders the list from its own `stashList` call, a separate
 * source). This locks the both-views-refreshed contract at the bind seam.
 */

import '../../setup';
import * as assert from 'assert';
import { bindShelfTabRepo } from '../../../src/registration/registerViews';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

function repoAt(root: string): IRepository {
  return {
    rootUri: Uri.file(root),
    state: 'idle',
    head: { name: 'main', commit: 'a', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
}

interface ViewRec {
  bound: IRepository[];
  refreshed: number;
  refreshResult: { error?: string };
  setRepository(repo: IRepository): void;
  refresh(): Promise<{ error?: string }>;
}

function makeView(refreshResult: { error?: string } = {}): ViewRec {
  const rec: ViewRec = {
    bound: [],
    refreshed: 0,
    refreshResult,
    setRepository(repo: IRepository) {
      rec.bound.push(repo);
    },
    async refresh() {
      rec.refreshed += 1;
      return rec.refreshResult;
    },
  };
  return rec;
}

describe('bindShelfTabRepo — both views bound and refreshed', () => {
  it('refreshes BOTH the shelf and the stash view (stash actions need current state)', async () => {
    const repo = repoAt('/r1');
    const shelf = makeView();
    const stash = makeView();
    const errors: Array<[string, string]> = [];

    const bound = await bindShelfTabRepo(
      { getSelectedRepository: () => repo },
      [repo],
      shelf,
      stash,
      (view, error) => errors.push([view, error])
    );

    assert.strictEqual(bound, repo, 'returns the bound repo');
    assert.deepStrictEqual(shelf.bound, [repo], 'shelf view bound to the repo');
    assert.deepStrictEqual(stash.bound, [repo], 'stash view bound to the repo');
    assert.strictEqual(shelf.refreshed, 1, 'shelf view refreshed');
    assert.strictEqual(
      stash.refreshed,
      1,
      'stash view refreshed — without this every stash action misses'
    );
    assert.deepStrictEqual(errors, [], 'no refresh errors logged on the happy path');
  });

  it('returns undefined and touches neither view when no repository is open', async () => {
    const shelf = makeView();
    const stash = makeView();

    const bound = await bindShelfTabRepo(
      { getSelectedRepository: () => undefined },
      [],
      shelf,
      stash,
      () => {}
    );

    assert.strictEqual(bound, undefined);
    assert.strictEqual(shelf.refreshed, 0);
    assert.strictEqual(stash.refreshed, 0);
  });

  it('reports each view refresh failure through the logger without throwing', async () => {
    const repo = repoAt('/r1');
    const shelf = makeView({ error: 'shelf boom' });
    const stash = makeView({ error: 'stash boom' });
    const errors: Array<[string, string]> = [];

    const bound = await bindShelfTabRepo(
      { getSelectedRepository: () => repo },
      [repo],
      shelf,
      stash,
      (view, error) => errors.push([view, error])
    );

    assert.strictEqual(bound, repo, 'a refresh failure must not block the action');
    assert.deepStrictEqual(errors, [
      ['shelf', 'shelf boom'],
      ['stash', 'stash boom'],
    ]);
  });
});
