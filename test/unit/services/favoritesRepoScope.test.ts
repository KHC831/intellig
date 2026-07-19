/**
 * Repo-scoped favorites with predefined defaults (DvcsBranchManager /
 * GitBranchManager parity).
 *
 * Resolution order mirrors DvcsBranchManager.isFavorite: an explicit favorite
 * wins, then an explicit exclusion, then the predefined defaults
 * (master/main for local, origin/master and origin/main for remote). Starring
 * is keyed by repository, so a star in one root does not leak into another.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { createFavoritesStore, FAVORITES_SLOT } from '../../../src/branches/BranchTreeProvider';
import { readFileSync } from 'fs';
import { join } from 'path';

interface IPackageJson {
  contributes: { menus: Record<string, Array<{ command: string; when?: string; group?: string }>> };
}

const REPO_A = '/work/alpha';
const REPO_B = '/work/beta';

function makeMemento(seed?: Record<string, unknown>): vscode.Memento {
  const store = new Map<string, unknown>(Object.entries(seed ?? {}));
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

describe('favorites: predefined defaults', () => {
  it('stars master and main by default in every repository', () => {
    const store = createFavoritesStore(makeMemento());
    try {
      assert.strictEqual(store.isFavorite('local', REPO_A, 'main'), true);
      assert.strictEqual(store.isFavorite('local', REPO_A, 'master'), true);
      assert.strictEqual(store.isFavorite('local', REPO_B, 'main'), true);
    } finally {
      store.dispose();
    }
  });

  it('stars origin/master and origin/main by default as remote favorites', () => {
    const store = createFavoritesStore(makeMemento());
    try {
      assert.strictEqual(store.isFavorite('remote', REPO_A, 'origin/main'), true);
      assert.strictEqual(store.isFavorite('remote', REPO_A, 'origin/master'), true);
    } finally {
      store.dispose();
    }
  });

  it('does not star an ordinary branch by default', () => {
    const store = createFavoritesStore(makeMemento());
    try {
      assert.strictEqual(store.isFavorite('local', REPO_A, 'feature/login'), false);
    } finally {
      store.dispose();
    }
  });

  it('keeps a default local name out of the REMOTE defaults', () => {
    const store = createFavoritesStore(makeMemento());
    try {
      assert.strictEqual(
        store.isFavorite('remote', REPO_A, 'main'),
        false,
        'main is a local default; the remote default is origin/main'
      );
    } finally {
      store.dispose();
    }
  });
});

describe('favorites: un-starring a predefined default sticks', () => {
  it('records an exclusion so the default does not come back', () => {
    const memento = makeMemento();
    const store = createFavoritesStore(memento);
    try {
      store.setFavorite('local', REPO_A, 'main', false);

      assert.strictEqual(store.isFavorite('local', REPO_A, 'main'), false);
    } finally {
      store.dispose();
    }

    // A fresh store over the same memento = a restart.
    const reopened = createFavoritesStore(memento);
    try {
      assert.strictEqual(
        reopened.isFavorite('local', REPO_A, 'main'),
        false,
        'the exclusion must survive a restart'
      );
    } finally {
      reopened.dispose();
    }
  });

  it('re-starring an excluded default clears the exclusion', () => {
    const store = createFavoritesStore(makeMemento());
    try {
      store.setFavorite('local', REPO_A, 'main', false);
      store.setFavorite('local', REPO_A, 'main', true);

      assert.strictEqual(store.isFavorite('local', REPO_A, 'main'), true);
    } finally {
      store.dispose();
    }
  });

  it('excludes the default in one repository only', () => {
    const store = createFavoritesStore(makeMemento());
    try {
      store.setFavorite('local', REPO_A, 'main', false);

      assert.strictEqual(store.isFavorite('local', REPO_B, 'main'), true, 'other repo unaffected');
    } finally {
      store.dispose();
    }
  });
});

describe('favorites: repository scoping', () => {
  it('stars a branch in one repository without starring it in another', () => {
    const store = createFavoritesStore(makeMemento());
    try {
      store.setFavorite('local', REPO_A, 'feature/login', true);

      assert.strictEqual(store.isFavorite('local', REPO_A, 'feature/login'), true);
      assert.strictEqual(store.isFavorite('local', REPO_B, 'feature/login'), false);
    } finally {
      store.dispose();
    }
  });

  it('keeps local and remote stars of the same name apart', () => {
    const store = createFavoritesStore(makeMemento());
    try {
      store.setFavorite('remote', REPO_A, 'origin/topic', true);

      assert.strictEqual(store.isFavorite('local', REPO_A, 'origin/topic'), false);
    } finally {
      store.dispose();
    }
  });

  it('round-trips a star through persistence', () => {
    const memento = makeMemento();
    const store = createFavoritesStore(memento);
    try {
      store.setFavorite('local', REPO_A, 'feature/login', true);
    } finally {
      store.dispose();
    }

    const reopened = createFavoritesStore(memento);
    try {
      assert.strictEqual(reopened.isFavorite('local', REPO_A, 'feature/login'), true);
    } finally {
      reopened.dispose();
    }
  });

  it('lists the resolved favorite names for a repository, defaults included', () => {
    const store = createFavoritesStore(makeMemento());
    try {
      store.setFavorite('local', REPO_A, 'feature/login', true);
      store.setFavorite('local', REPO_A, 'master', false);

      assert.deepStrictEqual(store.favoriteNames('local', REPO_A).sort(), [
        'feature/login',
        'main',
      ]);
    } finally {
      store.dispose();
    }
  });
});

describe('favorites: all-repository entries on the write path', () => {
  // BranchStorage.add/remove/contains match repoPath by strict equality
  // (platform/dvcs-impl/shared/.../BranchStorage.kt find()); only the
  // list-building read fans an all-repositories entry out across roots.
  it('un-starring in one repository leaves the all-repository star for the others', () => {
    const memento = makeMemento({ [FAVORITES_SLOT.key]: ['feature/legacy'] });
    const store = createFavoritesStore(memento);
    try {
      store.setFavorite('local', REPO_A, 'feature/legacy', false);

      assert.strictEqual(store.isFavorite('local', REPO_A, 'feature/legacy'), false);
      assert.strictEqual(
        store.isFavorite('local', REPO_B, 'feature/legacy'),
        true,
        'the all-repository star still applies to every other root'
      );
    } finally {
      store.dispose();
    }
  });

  it('re-starring in that repository restores it without disturbing the others', () => {
    const memento = makeMemento({ [FAVORITES_SLOT.key]: ['feature/legacy'] });
    const store = createFavoritesStore(memento);
    try {
      store.setFavorite('local', REPO_A, 'feature/legacy', false);
      store.setFavorite('local', REPO_A, 'feature/legacy', true);

      assert.strictEqual(store.isFavorite('local', REPO_A, 'feature/legacy'), true);
      assert.strictEqual(store.isFavorite('local', REPO_B, 'feature/legacy'), true);
    } finally {
      store.dispose();
    }
  });

  it('a repo-scoped un-star survives a restart', () => {
    const memento = makeMemento({ [FAVORITES_SLOT.key]: ['feature/legacy'] });
    const store = createFavoritesStore(memento);
    try {
      store.setFavorite('local', REPO_A, 'feature/legacy', false);
    } finally {
      store.dispose();
    }

    const reopened = createFavoritesStore(memento);
    try {
      assert.strictEqual(reopened.isFavorite('local', REPO_A, 'feature/legacy'), false);
      assert.strictEqual(reopened.isFavorite('local', REPO_B, 'feature/legacy'), true);
    } finally {
      reopened.dispose();
    }
  });

  it('drops an un-starred all-repository name from that repository name list only', () => {
    const memento = makeMemento({ [FAVORITES_SLOT.key]: ['feature/legacy'] });
    const store = createFavoritesStore(memento);
    try {
      store.setFavorite('local', REPO_A, 'feature/legacy', false);

      assert.ok(!store.favoriteNames('local', REPO_A).includes('feature/legacy'));
      assert.ok(store.favoriteNames('local', REPO_B).includes('feature/legacy'));
    } finally {
      store.dispose();
    }
  });
});

describe('favorites: migration from the flat name list', () => {
  it('carries legacy favorites over as all-repository stars', () => {
    // Legacy shape: a bare (un-enveloped) array of local branch names.
    const memento = makeMemento({ [FAVORITES_SLOT.key]: ['feature/legacy', 'release/1.x'] });

    const store = createFavoritesStore(memento);
    try {
      assert.strictEqual(store.isFavorite('local', REPO_A, 'feature/legacy'), true);
      assert.strictEqual(
        store.isFavorite('local', REPO_B, 'release/1.x'),
        true,
        'an unscoped legacy star applies to every repository'
      );
    } finally {
      store.dispose();
    }
  });

  it('carries legacy favorites stored under the version-1 envelope', () => {
    const memento = makeMemento({ [FAVORITES_SLOT.key]: { v: 1, data: ['feature/legacy'] } });

    const store = createFavoritesStore(memento);
    try {
      assert.strictEqual(store.isFavorite('local', REPO_A, 'feature/legacy'), true);
    } finally {
      store.dispose();
    }
  });

  it('leaves a migrated store writable without losing the migrated stars', () => {
    const memento = makeMemento({ [FAVORITES_SLOT.key]: ['feature/legacy'] });
    const store = createFavoritesStore(memento);
    try {
      store.setFavorite('local', REPO_A, 'other', true);
    } finally {
      store.dispose();
    }

    const reopened = createFavoritesStore(memento);
    try {
      assert.strictEqual(reopened.isFavorite('local', REPO_A, 'feature/legacy'), true);
      assert.strictEqual(reopened.isFavorite('local', REPO_A, 'other'), true);
    } finally {
      reopened.dispose();
    }
  });

  it('ignores a junk payload rather than throwing', () => {
    const memento = makeMemento({ [FAVORITES_SLOT.key]: { nonsense: true } });

    const store = createFavoritesStore(memento);
    try {
      assert.strictEqual(store.isFavorite('local', REPO_A, 'feature/login'), false);
      assert.strictEqual(store.isFavorite('local', REPO_A, 'main'), true, 'defaults still apply');
    } finally {
      store.dispose();
    }
  });
});

describe('favorites: menu reachability for remote refs', () => {
  it('offers Toggle Favorite on remote branch rows, not just local ones', () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '../../../package.json'), 'utf8')
    ) as IPackageJson;
    const starEntries = pkg.contributes.menus['view/item/context'].filter(
      (m) => m.command === 'intellig.branch.toggleFavorite'
    );

    assert.ok(
      starEntries.some((m) => m.when?.includes('intellig.remoteBranch')),
      `remote rows must be starrable (git4idea treats REMOTE as first-class); entries: ${JSON.stringify(starEntries)}`
    );
  });
});
