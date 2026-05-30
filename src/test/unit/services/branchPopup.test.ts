/**
 * Unit tests for the BranchPopup sectioned data pipeline.
 *
 * These tests exercise the pure helper functions exported from BranchPopup:
 *   - buildSectionedItems()
 *   - buildRemoteBranchActionMenu()
 *   - buildLocalBranchActionMenu()
 *   - buildTagActionMenu()
 *   - updateRecentLru()
 *   - detectIndentablePrefixes()
 *   - formatBranchLabel()
 *
 * Full integration tests for the BranchPopup UI (QuickPick host APIs) live in
 * the extension test suite and are not in scope for unit tests.
 */

/*
 * Stub factories synthesise IGitService implementations whose member
 * signatures return `Promise<T>`; no-await stub bodies are intentional here.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { IBranch, IGitService, IRepository, ITag } from '../../../git-core/interfaces/IGitService';
import {
  AUTO_INDENT_MIN_GROUP_SIZE,
  BranchPopup,
  FAVORITE_BRANCHES_STATE_KEY,
  IBranchQuickPickItem,
  RECENT_BRANCHES_MAX,
  buildLocalBranchActionMenu,
  buildRemoteBranchActionMenu,
  buildSectionedItems,
  buildTagActionMenu,
  detectIndentablePrefixes,
  formatBranchLabel,
  getFavorites,
  updateFavoritesList,
  updateRecentLru,
} from '../../../branches/BranchPopup';
import { EventEmitter, Uri } from '../../mocks/vscode';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const localMain: IBranch = {
  name: 'main',
  type: 'local',
  commit: 'aaa1111',
  isHead: true,
  upstream: { remote: 'origin', name: 'main' },
};
const localDevelop: IBranch = {
  name: 'develop',
  type: 'local',
  commit: 'bbb2222',
  isHead: false,
};
const localFeatureAuth: IBranch = {
  name: 'feature/auth',
  type: 'local',
  commit: 'ccc3333',
  isHead: false,
};
const localFeatureDashboard: IBranch = {
  name: 'feature/dashboard',
  type: 'local',
  commit: 'ddd4444',
  isHead: false,
};
const localFeatureApi: IBranch = {
  name: 'feature/api',
  type: 'local',
  commit: 'eee5555',
  isHead: false,
};
const localBugfixLogin: IBranch = {
  name: 'bugfix/login',
  type: 'local',
  commit: 'fff6666',
  isHead: false,
};

const remoteMain: IBranch = {
  name: 'origin/main',
  type: 'remote',
  commit: 'aaa1111',
  isHead: false,
};
const remoteDevelop: IBranch = {
  name: 'origin/develop',
  type: 'remote',
  commit: 'bbb2222',
  isHead: false,
};
const remoteFeatureAuth: IBranch = {
  name: 'origin/feature/auth',
  type: 'remote',
  commit: 'ccc3333',
  isHead: false,
};

const tagV1: ITag = {
  name: 'v1.0.0',
  commit: '1111111',
  isAnnotated: true,
  message: 'Release 1.0.0',
};
const tagV2: ITag = {
  name: 'v1.1.0',
  commit: '2222222',
  isAnnotated: true,
};

// Convenience: unwrap a string label (QuickPick items allow label string only in our shape).
function label(item: vscode.QuickPickItem): string {
  return typeof item.label === 'string' ? item.label : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// updateRecentLru
// ─────────────────────────────────────────────────────────────────────────────

describe('BranchPopup — updateRecentLru', () => {
  it('prepends a new entry to the front of the LRU', () => {
    const next = updateRecentLru(['a', 'b', 'c'], 'd');
    assert.deepStrictEqual(next, ['d', 'a', 'b', 'c']);
  });

  it('dedupes existing entries (moves to front)', () => {
    const next = updateRecentLru(['a', 'b', 'c'], 'b');
    assert.deepStrictEqual(next, ['b', 'a', 'c']);
  });

  it('caps the LRU at RECENT_BRANCHES_MAX (5) entries', () => {
    const next = updateRecentLru(['a', 'b', 'c', 'd', 'e'], 'f');
    assert.strictEqual(next.length, RECENT_BRANCHES_MAX);
    assert.deepStrictEqual(next, ['f', 'a', 'b', 'c', 'd']);
  });

  it('returns a new array (does not mutate input)', () => {
    const input = ['a', 'b'];
    const next = updateRecentLru(input, 'c');
    assert.notStrictEqual(next, input);
    assert.deepStrictEqual(input, ['a', 'b']);
  });

  it('handles empty input', () => {
    const next = updateRecentLru([], 'x');
    assert.deepStrictEqual(next, ['x']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// detectIndentablePrefixes / formatBranchLabel
// ─────────────────────────────────────────────────────────────────────────────

describe('BranchPopup — detectIndentablePrefixes', () => {
  it('identifies `/`-prefixes with ≥3 siblings', () => {
    const prefixes = detectIndentablePrefixes([
      'main',
      'develop',
      'feature/auth',
      'feature/dashboard',
      'feature/api',
      'bugfix/login',
      'bugfix/crash',
    ]);
    assert.ok(prefixes.has('feature/'), 'feature/ should be indentable (3 siblings)');
    assert.ok(!prefixes.has('bugfix/'), 'bugfix/ should NOT be indentable (only 2 siblings)');
  });

  it('requires at least AUTO_INDENT_MIN_GROUP_SIZE siblings', () => {
    assert.strictEqual(AUTO_INDENT_MIN_GROUP_SIZE, 3);
    const few = detectIndentablePrefixes(['feature/a', 'feature/b']);
    assert.strictEqual(few.size, 0);
  });

  it('ignores names without a `/`', () => {
    const prefixes = detectIndentablePrefixes(['main', 'develop', 'release']);
    assert.strictEqual(prefixes.size, 0);
  });
});

describe('BranchPopup — formatBranchLabel', () => {
  it('prefixes the current branch with ●', () => {
    const out = formatBranchLabel('main', new Set<string>(), /* isCurrent */ true);
    assert.strictEqual(out, '● main');
  });

  it('indents non-current branches whose name starts with an indentable prefix', () => {
    const out = formatBranchLabel('feature/auth', new Set(['feature/']), false);
    assert.strictEqual(out, '  feature/auth');
  });

  it('does NOT indent branches outside an indentable group', () => {
    const out = formatBranchLabel('main', new Set(['feature/']), false);
    assert.strictEqual(out, 'main');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildSectionedItems
// ─────────────────────────────────────────────────────────────────────────────

describe('BranchPopup — buildSectionedItems', () => {
  it('emits separator headers in Recent → Local → Remote → Tags order', () => {
    const items = buildSectionedItems({
      localBranches: [localMain, localDevelop],
      remoteBranches: [remoteMain, remoteDevelop],
      tags: [tagV1],
      recentBranchNames: ['develop'],
      currentBranchName: 'main',
    });

    const separatorLabels = items
      .filter((i) => i.kind === vscode.QuickPickItemKind.Separator)
      .map((i) => label(i));

    assert.deepStrictEqual(separatorLabels, ['Recent', 'Local', 'Remote', 'Tags']);
  });

  it('excludes the current branch from the Recent section', () => {
    const items = buildSectionedItems({
      localBranches: [localMain, localDevelop],
      remoteBranches: [],
      tags: [],
      // Recent list contains `main` (current) and `develop`; current must be filtered out.
      recentBranchNames: ['main', 'develop'],
      currentBranchName: 'main',
    });

    const recentStart = items.findIndex(
      (i) => i.kind === vscode.QuickPickItemKind.Separator && label(i) === 'Recent'
    );
    const localStart = items.findIndex(
      (i) => i.kind === vscode.QuickPickItemKind.Separator && label(i) === 'Local'
    );
    const recentItems = items.slice(recentStart + 1, localStart);
    assert.strictEqual(recentItems.length, 1, 'should only contain develop, not main');
    assert.strictEqual(recentItems[0].branch?.name, 'develop');
  });

  it('suppresses the Recent section entirely when empty (no header)', () => {
    const items = buildSectionedItems({
      localBranches: [localMain],
      remoteBranches: [],
      tags: [],
      recentBranchNames: [],
      currentBranchName: 'main',
    });
    const hasRecentHeader = items.some(
      (i) => i.kind === vscode.QuickPickItemKind.Separator && label(i) === 'Recent'
    );
    assert.strictEqual(hasRecentHeader, false);
  });

  it('suppresses Remote and Tags sections when their lists are empty', () => {
    const items = buildSectionedItems({
      localBranches: [localMain],
      remoteBranches: [],
      tags: [],
      recentBranchNames: [],
      currentBranchName: 'main',
    });
    const separators = items
      .filter((i) => i.kind === vscode.QuickPickItemKind.Separator)
      .map((i) => label(i));
    assert.deepStrictEqual(separators, ['Local']);
  });

  it('renders the current branch with a ● marker', () => {
    const items = buildSectionedItems({
      localBranches: [localMain, localDevelop],
      remoteBranches: [],
      tags: [],
      recentBranchNames: [],
      currentBranchName: 'main',
    });
    const mainItem = items.find((i) => i.branch?.name === 'main');
    assert.ok(mainItem, 'main should be in the list');
    assert.ok(label(mainItem).startsWith('● '), 'main should be marked with ●');
  });

  it('preserves origin/ prefix in remote branch labels', () => {
    const items = buildSectionedItems({
      localBranches: [],
      remoteBranches: [remoteMain],
      tags: [],
      recentBranchNames: [],
      currentBranchName: undefined,
    });
    const remoteItem = items.find((i) => i.branch?.name === 'origin/main');
    assert.ok(remoteItem);
    assert.ok(
      label(remoteItem).includes('origin/main'),
      'remote label should include the remote-qualified name'
    );
  });

  it('auto-indents local branches in a `/`-prefix group of ≥3', () => {
    const items = buildSectionedItems({
      localBranches: [
        localMain,
        localDevelop,
        localFeatureAuth,
        localFeatureDashboard,
        localFeatureApi,
        localBugfixLogin,
      ],
      remoteBranches: [],
      tags: [],
      recentBranchNames: [],
      currentBranchName: 'main',
    });

    const featureAuthItem = items.find((i) => i.branch?.name === 'feature/auth');
    assert.ok(featureAuthItem);
    assert.ok(
      label(featureAuthItem).startsWith('  '),
      'feature/auth should be indented (3 feature/ siblings)'
    );

    const bugfixItem = items.find((i) => i.branch?.name === 'bugfix/login');
    assert.ok(bugfixItem);
    assert.ok(
      !label(bugfixItem).startsWith('  '),
      'bugfix/login should NOT be indented (only 1 sibling)'
    );
  });

  it('places Recent items even when the underlying branch is remote-qualified', () => {
    const items = buildSectionedItems({
      localBranches: [localMain],
      remoteBranches: [remoteFeatureAuth],
      tags: [],
      recentBranchNames: ['origin/feature/auth'],
      currentBranchName: 'main',
    });

    const recentHeader = items.findIndex(
      (i) => i.kind === vscode.QuickPickItemKind.Separator && label(i) === 'Recent'
    );
    assert.ok(recentHeader >= 0, 'Recent section should be present');
    const firstRecent = items[recentHeader + 1];
    assert.strictEqual(firstRecent.branch?.name, 'origin/feature/auth');
    assert.strictEqual(firstRecent.section, 'recent');
  });

  it('drops recent entries whose branch no longer exists', () => {
    const items = buildSectionedItems({
      localBranches: [localMain],
      remoteBranches: [],
      tags: [],
      recentBranchNames: ['deleted-branch', 'also-gone'],
      currentBranchName: 'main',
    });

    const hasRecent = items.some(
      (i) => i.kind === vscode.QuickPickItemKind.Separator && label(i) === 'Recent'
    );
    assert.strictEqual(hasRecent, false, 'empty resolved Recent must not emit a header');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Remote-branch action menu
// ─────────────────────────────────────────────────────────────────────────────

describe('BranchPopup — buildRemoteBranchActionMenu', () => {
  const items = buildRemoteBranchActionMenu(remoteMain);

  it('includes Checkout, Checkout and Rebase onto Current, Pull using Merge/Rebase, Compare, Cherry-Pick, Delete', () => {
    const labels = items.map((i) => label(i));
    assert.ok(
      labels.some((l) => l.includes('Checkout')),
      'expected Checkout'
    );
    assert.ok(
      labels.some((l) => l.includes('Checkout and Rebase onto Current')),
      'expected Checkout and Rebase onto Current'
    );
    assert.ok(
      labels.some((l) => l.includes('Pull into Current Using Merge')),
      'expected Pull into Current Using Merge'
    );
    assert.ok(
      labels.some((l) => l.includes('Pull into Current Using Rebase')),
      'expected Pull into Current Using Rebase'
    );
    assert.ok(
      labels.some((l) => l.includes('Compare with Current')),
      'expected Compare with Current'
    );
    assert.ok(
      labels.some((l) => l.includes('Cherry-Pick Commits')),
      'expected Cherry-Pick Commits'
    );
    assert.ok(
      labels.some((l) => l.includes('Delete')),
      'expected Delete'
    );
  });

  it('routes each entry to an existing `intellig.*` command ID', () => {
    const expected = new Set([
      'intellig.remoteBranch.checkoutAsLocal',
      'intellig.branch.checkoutAndRebase',
      'intellig.remoteBranch.pullUsingMerge',
      'intellig.remoteBranch.pullUsingRebase',
      'intellig.branch.compareWithCurrent',
      'intellig.remoteBranch.cherryPickCommits',
      'intellig.remoteBranch.deleteRemote',
    ]);
    for (const item of items) {
      assert.ok(item.commandId, `${label(item)} missing commandId`);
      assert.ok(
        expected.has(item.commandId),
        `unknown commandId ${item.commandId ?? ''} on ${label(item)}`
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Local-branch action menu
// ─────────────────────────────────────────────────────────────────────────────

describe('BranchPopup — buildLocalBranchActionMenu', () => {
  const items = buildLocalBranchActionMenu(localDevelop, 'main');

  it('includes IntelliJ-parity entries: Checkout, New Branch from…, Rename…, Delete, Compare, Merge into Current, Rebase Current onto…, Push…', () => {
    const labels = items.map((i) => label(i));
    assert.ok(
      labels.some((l) => l.startsWith('$(arrow-right) Checkout')),
      'Checkout'
    );
    assert.ok(
      labels.some((l) => l.includes('New Branch from')),
      'New Branch from…'
    );
    assert.ok(
      labels.some((l) => l.includes('Rename…')),
      'Rename…'
    );
    assert.ok(
      labels.some((l) => l === '$(trash) Delete'),
      'Delete'
    );
    assert.ok(
      labels.some((l) => l.includes('Compare with Current')),
      'Compare with Current'
    );
    assert.ok(
      labels.some((l) => l.includes('Merge into Current')),
      'Merge into Current'
    );
    assert.ok(
      labels.some((l) => l.includes('Rebase Current onto')),
      'Rebase Current onto…'
    );
    assert.ok(
      labels.some((l) => l.includes('Push…')),
      'Push…'
    );
  });

  it('routes each entry to an existing `intellig.branch.*` command ID', () => {
    const expected = new Set([
      'intellig.branch.checkout',
      'intellig.branch.newBranchFrom',
      'intellig.branch.rename',
      'intellig.branch.delete',
      'intellig.branch.compareWithCurrent',
      'intellig.branch.mergeIntoCurrent',
      'intellig.branch.rebaseCurrentOnto',
      'intellig.branch.push',
    ]);
    for (const item of items) {
      assert.ok(item.commandId, `${label(item)} missing commandId`);
      assert.ok(expected.has(item.commandId), `unknown commandId ${item.commandId ?? ''}`);
    }
  });

  it('interpolates branch name into `New Branch from …` and `Rebase Current onto …` labels', () => {
    const labels = items.map((i) => label(i));
    assert.ok(
      labels.some((l) => l.includes(`New Branch from '${localDevelop.name}'…`)),
      "New Branch from '<branch>'…"
    );
    assert.ok(
      labels.some((l) => l.includes(`Rebase Current onto '${localDevelop.name}'`)),
      "Rebase Current onto '<branch>'"
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tag action menu
// ─────────────────────────────────────────────────────────────────────────────

describe('BranchPopup — buildTagActionMenu', () => {
  const items = buildTagActionMenu(tagV1);

  it('includes IntelliJ-parity entries: Checkout (Detached), New Branch from Tag…, Cherry-Pick, Delete, Push', () => {
    const labels = items.map((i) => label(i));
    assert.ok(
      labels.some((l) => l.includes('Checkout (Detached)')),
      'Checkout (Detached)'
    );
    assert.ok(
      labels.some((l) => l.includes('New Branch from Tag…')),
      'New Branch from Tag…'
    );
    assert.ok(
      labels.some((l) => l.endsWith('Cherry-Pick')),
      'Cherry-Pick'
    );
    assert.ok(
      labels.some((l) => l === '$(trash) Delete'),
      'Delete'
    );
    assert.ok(
      labels.some((l) => l.endsWith('Push')),
      'Push'
    );
  });

  it('routes each entry to an existing `intellig.tag.*` command ID', () => {
    const expected = new Set([
      'intellig.tag.checkoutDetached',
      'intellig.tag.newBranchFrom',
      'intellig.tag.cherryPick',
      'intellig.tag.delete',
      'intellig.tag.push',
    ]);
    for (const item of items) {
      assert.ok(item.commandId, `${label(item)} missing commandId`);
      assert.ok(expected.has(item.commandId), `unknown commandId ${item.commandId ?? ''}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-repo isolation for Recent LRU (data shape contract)
// ─────────────────────────────────────────────────────────────────────────────

describe('BranchPopup — Recent LRU per-repo shape', () => {
  // We do not instantiate BranchPopup here (createStatusBarItem isn't mocked);
  // we just verify the LRU-update math works correctly when partitioned by
  // repo-root key, which is exactly how BranchPopup.recordCheckout stores it.
  const repoA: IRepository = {
    rootUri: vscode.Uri.file('/a'),
    state: 'idle',
    remotes: [],
    submodules: [],
  };
  const repoB: IRepository = {
    rootUri: vscode.Uri.file('/b'),
    state: 'idle',
    remotes: [],
    submodules: [],
  };

  it('maintains independent LRUs per repo-root key', () => {
    const map: Record<string, string[]> = {};

    map[repoA.rootUri.fsPath] = updateRecentLru(map[repoA.rootUri.fsPath] ?? [], 'feature/x');
    map[repoB.rootUri.fsPath] = updateRecentLru(map[repoB.rootUri.fsPath] ?? [], 'bugfix/y');
    map[repoA.rootUri.fsPath] = updateRecentLru(map[repoA.rootUri.fsPath], 'main');

    assert.deepStrictEqual(map[repoA.rootUri.fsPath], ['main', 'feature/x']);
    assert.deepStrictEqual(map[repoB.rootUri.fsPath], ['bugfix/y']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Kept-for-compat tests from the previous flat-picker era
// (data-structure tests that still make sense on the redesigned popup)
// ─────────────────────────────────────────────────────────────────────────────

describe('BranchPopup - Branch Data Structures', () => {
  it('supports local branch type', () => {
    assert.strictEqual(localMain.type, 'local');
    assert.strictEqual(localMain.isHead, true);
  });

  it('supports remote branch type', () => {
    assert.strictEqual(remoteMain.type, 'remote');
    assert.strictEqual(remoteMain.name, 'origin/main');
  });

  it('supports upstream information', () => {
    assert.ok(localMain.upstream);
    assert.strictEqual(localMain.upstream.remote, 'origin');
  });

  it('supports tag shape', () => {
    assert.strictEqual(tagV1.name, 'v1.0.0');
    assert.strictEqual(tagV2.isAnnotated, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T3-01 — Favorites
// ─────────────────────────────────────────────────────────────────────────────

describe('BranchPopup — T3-01 updateFavoritesList', () => {
  it('appends a new branch when favorite=true', () => {
    const next = updateFavoritesList(['main'], 'develop', true);
    assert.deepStrictEqual(next, ['main', 'develop']);
  });

  it('removes a branch when favorite=false', () => {
    const next = updateFavoritesList(['main', 'develop'], 'develop', false);
    assert.deepStrictEqual(next, ['main']);
  });

  it('deduplicates existing entries on re-add (preserves insertion order)', () => {
    const next = updateFavoritesList(['main', 'develop', 'feature/x'], 'develop', true);
    // develop is removed then re-appended → moves to the end.
    assert.deepStrictEqual(next, ['main', 'feature/x', 'develop']);
  });

  it("is a no-op when removing a branch that isn't starred", () => {
    const next = updateFavoritesList(['main'], 'ghost', false);
    assert.deepStrictEqual(next, ['main']);
  });

  it('returns a new array (does not mutate input)', () => {
    const input = ['a', 'b'];
    const next = updateFavoritesList(input, 'c', true);
    assert.notStrictEqual(next, input);
    assert.deepStrictEqual(input, ['a', 'b']);
  });
});

describe('BranchPopup — T3-01 getFavorites', () => {
  function mkMemento(initial?: unknown): vscode.Memento {
    const store = new Map<string, unknown>();
    if (initial !== undefined) {
      store.set(FAVORITE_BRANCHES_STATE_KEY, initial);
    }
    return {
      get<T>(key: string, defaultValue?: T): T | undefined {
        return store.has(key) ? (store.get(key) as T) : defaultValue;
      },
      update: async (k: string, v: unknown): Promise<void> => {
        if (v === undefined) {
          store.delete(k);
        } else {
          store.set(k, v);
        }
      },
      keys: () => Array.from(store.keys()),
    } as unknown as vscode.Memento;
  }

  it('returns an empty array when no favorites are stored', () => {
    assert.deepStrictEqual(getFavorites(mkMemento()), []);
  });

  it('returns a copy (not the stored reference)', () => {
    const mem = mkMemento(['main']);
    const first = getFavorites(mem);
    first.push('tampered');
    const second = getFavorites(mem);
    assert.deepStrictEqual(second, ['main']);
  });

  it('returns [] when the stored value is not an array (defensive)', () => {
    const mem = mkMemento({ not: 'an array' });
    assert.deepStrictEqual(getFavorites(mem), []);
  });

  it('returns [] when no workspaceState is provided', () => {
    assert.deepStrictEqual(getFavorites(undefined), []);
  });
});

describe('BranchPopup — T3-01 buildSectionedItems renders Favorites', () => {
  it('emits a `★ Favorites` separator above Recent/Local when favorites exist', () => {
    const items = buildSectionedItems({
      localBranches: [localMain, localDevelop, localFeatureAuth],
      remoteBranches: [],
      tags: [],
      recentBranchNames: ['develop'],
      favoriteBranchNames: ['feature/auth'],
      currentBranchName: 'main',
    });
    const sepLabels = items
      .filter((i) => i.kind === vscode.QuickPickItemKind.Separator)
      .map((i) => (typeof i.label === 'string' ? i.label : ''));
    assert.strictEqual(
      sepLabels[0],
      '★ Favorites',
      `expected Favorites first, got: ${sepLabels.join(', ')}`
    );
  });

  it('suppresses the Favorites section when the list is empty', () => {
    const items = buildSectionedItems({
      localBranches: [localMain],
      remoteBranches: [],
      tags: [],
      recentBranchNames: [],
      favoriteBranchNames: [],
      currentBranchName: 'main',
    });
    const hasFav = items.some(
      (i) =>
        i.kind === vscode.QuickPickItemKind.Separator &&
        typeof i.label === 'string' &&
        i.label.includes('Favorites')
    );
    assert.strictEqual(hasFav, false);
  });

  it('filters out favorites that reference branches no longer present', () => {
    const items = buildSectionedItems({
      localBranches: [localMain],
      remoteBranches: [],
      tags: [],
      recentBranchNames: [],
      favoriteBranchNames: ['ghost-branch', 'main'],
      currentBranchName: undefined,
    });
    // Favorites header present, only `main` underneath (ghost-branch skipped).
    const favStartIdx = items.findIndex(
      (i) =>
        i.kind === vscode.QuickPickItemKind.Separator &&
        typeof i.label === 'string' &&
        i.label.includes('Favorites')
    );
    assert.ok(favStartIdx >= 0, 'Favorites separator should be present');
    // Walk items after the Favorites header until the next separator; those
    // are the favorites rows.
    const favRows: typeof items = [];
    for (let i = favStartIdx + 1; i < items.length; i++) {
      if (items[i].kind === vscode.QuickPickItemKind.Separator) {
        break;
      }
      favRows.push(items[i]);
    }
    assert.strictEqual(
      favRows.length,
      1,
      `expected only main under Favorites, got ${favRows.length}`
    );
    assert.strictEqual(favRows[0].branch?.name, 'main');
  });

  it('suppresses Favorites header when all favorites reference missing branches', () => {
    const items = buildSectionedItems({
      localBranches: [localMain],
      remoteBranches: [],
      tags: [],
      recentBranchNames: [],
      favoriteBranchNames: ['ghost-one', 'ghost-two'],
      currentBranchName: undefined,
    });
    const hasFav = items.some(
      (i) =>
        i.kind === vscode.QuickPickItemKind.Separator &&
        typeof i.label === 'string' &&
        i.label.includes('Favorites')
    );
    assert.strictEqual(
      hasFav,
      false,
      'Favorites header must not appear when resolved list is empty'
    );
  });

  it('renders per-branch star buttons on Local / Remote items (empty star when not favorite)', () => {
    const items = buildSectionedItems({
      localBranches: [localMain, localDevelop],
      remoteBranches: [],
      tags: [],
      recentBranchNames: [],
      favoriteBranchNames: ['develop'],
      currentBranchName: 'main',
    });
    const devRow = items.find((i) => i.branch?.name === 'develop' && i.section === 'local');
    const mainRow = items.find((i) => i.branch?.name === 'main' && i.section === 'local');
    assert.ok(
      devRow?.buttons && devRow.buttons.length === 1,
      'develop row should have star button'
    );
    assert.ok(mainRow?.buttons && mainRow.buttons.length === 1, 'main row should have star button');
    // develop is starred → full star tooltip
    assert.strictEqual(devRow.buttons[0].tooltip, 'Unstar');
    assert.strictEqual(mainRow.buttons[0].tooltip, 'Add to Favorites');
  });
});

// ─── R6-Gap-C: BranchPopup._initializeStatusBar multi-root selection ─────────
describe('BranchPopup - R6-Gap-C multi-root status-bar init', () => {
  function makeRepo(branchName: string, rootPath: string): IRepository {
    return {
      rootUri: Uri.file(rootPath),
      state: 'idle',
      head: {
        name: `refs/heads/${branchName}`,
        commit: 'deadbeefcafebabe0000000000000000deadbeef',
        ahead: 0,
        behind: 0,
      },
      remotes: [],
      submodules: [],
    };
  }

  it("selects the active-editor's repo (repoB), not repositories[0] (repoA)", async () => {
    const repoA = makeRepo('main-A', '/repo-a');
    const repoB = makeRepo('main-B', '/repo-b');

    const repoChangeEmitter = new EventEmitter<IRepository>();
    const gitService = {
      getRepositories: () => [repoA, repoB],
      getRepository: async () => undefined,
      onDidChangeRepository: repoChangeEmitter.event,
    } as unknown as IGitService;

    // Capture the status bar item so we can read its text.
    const originalCreate = vscode.window.createStatusBarItem;
    let capturedItem:
      | {
          text: string;
          tooltip: unknown;
          command: unknown;
          show: () => void;
          hide: () => void;
          dispose: () => void;
        }
      | undefined;
    (vscode.window as unknown as { createStatusBarItem: unknown }).createStatusBarItem = () => {
      capturedItem = {
        text: '',
        tooltip: undefined,
        command: undefined,
        show: () => {},
        hide: () => {},
        dispose: () => {},
      };
      return capturedItem;
    };

    const originalActive = (vscode.window as unknown as { activeTextEditor: unknown })
      .activeTextEditor;
    try {
      // Point the active editor at a file under /repo-b.
      (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = {
        document: {
          uri: Uri.file('/repo-b/src/foo.ts'),
        },
      };

      const popup = new BranchPopup(gitService);
      // _initializeStatusBar is async; wait a tick.
      await new Promise((r) => setTimeout(r, 10));

      assert.ok(capturedItem, 'Status bar item should have been created');
      assert.ok(
        capturedItem.text.includes('main-B'),
        `expected active-editor repo's branch "main-B" in status text, got "${capturedItem.text}"`
      );
      assert.ok(
        !capturedItem.text.includes('main-A'),
        `did NOT expect repositories[0]'s branch "main-A" in status text, got "${capturedItem.text}"`
      );

      popup.dispose();
    } finally {
      (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = originalActive;
      (vscode.window as unknown as { createStatusBarItem: unknown }).createStatusBarItem =
        originalCreate;
    }
  });
});

// TL-72 (Wave 9) — `_dispatchSelectedAction` catch block must run the
// raw command-execution error through `sanitizeGitError` before
// pushing it into the showErrorMessage toast template. Pre-fix,
// BranchPopup.ts:986 concatenated `error.message` directly. Branch
// commands often surface `git push`/`git pull` stderr that contains
// credentialed remote URLs and POSIX home paths; without sanitisation
// these leak into the user's notification history.
describe('BranchPopup TL-72 — action-path toast routes through sanitizeGitError', () => {
  it('_dispatchSelectedAction sanitizes credentialed URL + home path in toast', async () => {
    const RAW = 'fail: https://alice:secret@example.com/repo.git\n/Users/alice/project';
    const EXPECTED = 'fail: https://<redacted>@example.com/repo.git\n~/project';

    const repoChangeEmitter = new EventEmitter<IRepository>();
    const gitService = {
      getRepositories: () => [],
      getRepository: async () => undefined,
      onDidChangeRepository: repoChangeEmitter.event,
    } as unknown as IGitService;

    // Stub commands.getCommands and commands.executeCommand to drive
    // the catch block. getCommands returns the registered list (so the
    // dispatcher proceeds past the "Coming soon" fallback);
    // executeCommand throws with a credentialed payload.
    const oGetCommands = vscode.commands.getCommands;
    const oExec = vscode.commands.executeCommand;
    (vscode.commands as unknown as { getCommands: unknown }).getCommands = (): Thenable<string[]> =>
      Promise.resolve(['intellig.branch.checkout']);
    (vscode.commands as unknown as { executeCommand: unknown }).executeCommand =
      (): Promise<never> => Promise.reject(new Error(RAW));

    const errors: string[] = [];
    const oErr = vscode.window.showErrorMessage;
    (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage = (
      m: string
    ): Promise<string | undefined> => {
      errors.push(m);
      return Promise.resolve(undefined);
    };

    try {
      const popup = new BranchPopup(gitService);
      try {
        const selected: IBranchQuickPickItem = {
          label: '$(git-branch) feature/x',
          commandId: 'intellig.branch.checkout',
          branch: {
            name: 'feature/x',
            type: 'local',
            commit: 'abcdef0',
            isHead: false,
          },
        };

        const result = await (
          popup as unknown as {
            _dispatchSelectedAction: (
              repo: IRepository | undefined,
              s: IBranchQuickPickItem
            ) => Promise<{ cancelled: boolean }>;
          }
        )._dispatchSelectedAction(undefined, selected);

        assert.strictEqual(result.cancelled, true);
        assert.strictEqual(errors.length, 1, 'expected one error toast');
        assert.strictEqual(errors[0], `Branch operation failed: ${EXPECTED}`);
        assert.ok(!errors[0].includes('alice:secret'), 'toast must not leak credentials');
        assert.ok(!errors[0].includes('/Users/alice'), 'toast must not leak home path');
      } finally {
        popup.dispose();
      }
    } finally {
      (vscode.commands as unknown as { getCommands: unknown }).getCommands = oGetCommands;
      (vscode.commands as unknown as { executeCommand: unknown }).executeCommand = oExec;
      (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage = oErr;
    }
  });
});
