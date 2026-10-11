/**
 * Favorite branches are WORKSPACE-scoped (git4idea parity: `GitFavoriteRefs`
 * is project-level state — starring `main` in one project must not star
 * `main` everywhere). The store persists to workspaceState, seeding once from
 * the legacy globalState slot so existing users keep their stars.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { createFavoritesStore, FAVORITES_SLOT } from '../../../src/branches/favoritesStore';
import { loadPersisted } from '../../../src/utils/persistedState';

function makeMemento(): vscode.Memento {
  const store = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue?: T): T | undefined {
      return (store.get(key) as T) ?? defaultValue;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) {
        store.delete(key);
      } else {
        store.set(key, value);
      }
    },
    keys(): readonly string[] {
      return Array.from(store.keys());
    },
  };
}

describe('favorites store scope (workspace-level, git4idea parity)', () => {
  const REPO = '/work/alpha';

  it('writes favorites to the workspace memento, not the legacy global one', () => {
    const workspaceState = makeMemento();
    const globalState = makeMemento();
    const store = createFavoritesStore(workspaceState, globalState);
    try {
      store.setFavorite('local', REPO, 'feature/x', true);

      assert.ok(loadPersisted(workspaceState, FAVORITES_SLOT), 'workspace slot holds the star');
      assert.strictEqual(
        loadPersisted(globalState, FAVORITES_SLOT),
        undefined,
        'globalState must not receive new writes'
      );
    } finally {
      store.dispose();
    }
  });

  it('seeds the workspace slot from the legacy global name list once', async () => {
    const workspaceState = makeMemento();
    const globalState = makeMemento();
    await globalState.update(FAVORITES_SLOT.key, ['release']);

    const store = createFavoritesStore(workspaceState, globalState);
    try {
      assert.strictEqual(
        store.isFavorite('local', REPO, 'release'),
        true,
        'legacy global favorites must be visible after migration'
      );
      assert.ok(
        loadPersisted(workspaceState, FAVORITES_SLOT),
        'migration must persist into workspaceState'
      );
    } finally {
      store.dispose();
    }
  });

  it('does not re-seed once the workspace slot exists (un-starring sticks)', async () => {
    const workspaceState = makeMemento();
    const globalState = makeMemento();
    await globalState.update(FAVORITES_SLOT.key, ['release']);

    const first = createFavoritesStore(workspaceState, globalState);
    first.setFavorite('local', REPO, 'release', false);
    first.dispose();

    const second = createFavoritesStore(workspaceState, globalState);
    try {
      assert.strictEqual(
        second.isFavorite('local', REPO, 'release'),
        false,
        'an un-starred branch must not be re-populated from the legacy global slot'
      );
    } finally {
      second.dispose();
    }
  });

  it('leaves the legacy global slot intact for other workspaces to migrate from', async () => {
    const workspaceState = makeMemento();
    const globalState = makeMemento();
    await globalState.update(FAVORITES_SLOT.key, ['release']);

    const store = createFavoritesStore(workspaceState, globalState);
    store.dispose();

    assert.deepStrictEqual(
      globalState.get(FAVORITES_SLOT.key),
      ['release'],
      'migration reads the legacy slot; it must not delete it'
    );
  });
});
