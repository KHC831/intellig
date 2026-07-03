/**
 * Branches-tree search filter — the IntelliJ speed-search analogue for the
 * native tree. `setSearchQuery` narrows every section (HEAD, Favorites,
 * Local, Remote, Tags) to case-insensitive substring matches on the FULL
 * ref name, so folder grouping is built from the survivors and an empty
 * remote/folder disappears rather than rendering hollow.
 */

import '../../setup';
import * as assert from 'assert';
import { BranchTreeProvider, type BranchTreeItem } from '../../../src/branches/BranchTreeProvider';
import { createMockGitService, attachedRepo, detachedRepo } from '../../mocks/mockGitService';
import type { IBranch, ITag } from '../../../src/git-core/interfaces/IGitService';

const BRANCHES: IBranch[] = [
  { name: 'main', type: 'local', commit: 'a'.repeat(40), isHead: true },
  { name: 'feature/auth/login', type: 'local', commit: 'b'.repeat(40), isHead: false },
  { name: 'feature/payments', type: 'local', commit: 'c'.repeat(40), isHead: false },
  { name: 'hotfix/AUTH-escape', type: 'local', commit: 'd'.repeat(40), isHead: false },
  { name: 'origin/main', type: 'remote', commit: 'a'.repeat(40), isHead: false },
  { name: 'origin/feature/auth/login', type: 'remote', commit: 'b'.repeat(40), isHead: false },
  { name: 'upstream/release', type: 'remote', commit: 'e'.repeat(40), isHead: false },
];

const TAGS: ITag[] = [
  { name: 'v1.0.0', commit: 'a'.repeat(40), isAnnotated: false },
  { name: 'auth-rollout', commit: 'b'.repeat(40), isAnnotated: false },
];

function makeProvider(repo = attachedRepo('main')): BranchTreeProvider {
  const gitService = createMockGitService(repo, {
    getBranches: async () => BRANCHES,
    getTags: async () => TAGS,
  });
  const provider = new BranchTreeProvider(gitService);
  provider.setRepository(repo);
  return provider;
}

async function category(provider: BranchTreeProvider, label: string): Promise<BranchTreeItem[]> {
  const root = await provider.getChildren();
  const node = root.find((c) => c.label === label);
  if (!node) {
    return [];
  }
  return provider.getChildren(node);
}

/** Flatten a section fully (descend branch folders). */
async function leafNames(provider: BranchTreeProvider, label: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (items: BranchTreeItem[]): Promise<void> => {
    for (const it of items) {
      if (it.itemType === 'branch-folder') {
        await walk(await provider.getChildren(it));
      } else if (it.branch) {
        out.push(it.branch.name);
      } else if (it.tag) {
        out.push(it.tag.name);
      }
    }
  };
  await walk(await category(provider, label));
  return out.sort();
}

describe('BranchTreeProvider — search filter', () => {
  it('filters Local leaves by case-insensitive substring on the full name', async () => {
    const provider = makeProvider();
    provider.setSearchQuery('auth');
    assert.deepStrictEqual(await leafNames(provider, 'Local'), [
      'feature/auth/login',
      'hotfix/AUTH-escape',
    ]);
  });

  it('filters Remote leaves and drops remotes with zero matches entirely', async () => {
    const provider = makeProvider();
    provider.setSearchQuery('auth');
    assert.deepStrictEqual(await leafNames(provider, 'Remote'), ['origin/feature/auth/login']);
    const remoteFolders = await category(provider, 'Remote');
    assert.ok(
      !remoteFolders.some((f) => f.label === 'upstream'),
      'a remote with no matching branches must not render an empty folder'
    );
  });

  it('filters Tags by the same query', async () => {
    const provider = makeProvider();
    provider.setSearchQuery('auth');
    assert.deepStrictEqual(await leafNames(provider, 'Tags'), ['auth-rollout']);
  });

  it('clearing the query restores every section', async () => {
    const provider = makeProvider();
    provider.setSearchQuery('auth');
    provider.setSearchQuery(undefined);
    assert.strictEqual((await leafNames(provider, 'Local')).length, 4);
    assert.strictEqual((await leafNames(provider, 'Tags')).length, 2);
  });

  it('an empty or whitespace query normalizes to no filter', async () => {
    const provider = makeProvider();
    provider.setSearchQuery('   ');
    assert.strictEqual(provider.getSearchQuery(), undefined);
    assert.strictEqual((await leafNames(provider, 'Local')).length, 4);
  });

  it('round-trips the active query for the search command prefill', () => {
    const provider = makeProvider();
    provider.setSearchQuery('feat');
    assert.strictEqual(provider.getSearchQuery(), 'feat');
  });

  it('hides the detached-HEAD synthetic row while a query is active', async () => {
    const provider = makeProvider(detachedRepo('f'.repeat(40)));
    provider.setSearchQuery('auth');
    const locals = await category(provider, 'Local');
    assert.ok(
      !locals.some((i) => i.itemType === 'detached-head'),
      'detached row is positional info, not a search result'
    );
  });

  it('fires onDidChangeTreeData when the query changes', () => {
    const provider = makeProvider();
    let fires = 0;
    provider.onDidChangeTreeData(() => {
      fires += 1;
    });
    provider.setSearchQuery('auth');
    provider.setSearchQuery(undefined);
    assert.strictEqual(fires, 2);
  });

  it('does NOT refire for a no-op query change (same value)', () => {
    const provider = makeProvider();
    provider.setSearchQuery('auth');
    let fires = 0;
    provider.onDidChangeTreeData(() => {
      fires += 1;
    });
    provider.setSearchQuery('auth');
    assert.strictEqual(fires, 0);
  });
});
