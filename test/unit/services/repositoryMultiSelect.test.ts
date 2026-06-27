/**
 * Multi-select repository scope (the "Repository" log filter).
 *
 * The repo filter lets the user show commits from a SUBSET of a multi-root
 * workspace, not just one repo or all. The selection collapses to the existing
 * single/all scopes at the extremes:
 *   - check all (or none)  → `'all'` (merged), no visible subset.
 *   - check exactly one    → the single-repo scope (HEAD spine, no root column).
 *   - check 2 .. n-1       → merged scope filtered to that subset
 *                            (`getVisibleRepoRoots()` lists the chosen roots).
 *
 * Identity is by NORMALIZED path (spec L14), so an unknown root is ignored and
 * a re-discovered list that shifts indexes keeps the subset pinned.
 */

import '../../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../../src/ui-shell/GitToolWindowProvider';
import { Uri } from '../../mocks/vscode';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';
import type { RepositoryScopeSelection } from '../../../src/registration/wiring';

function makeRepo(rootPath: string): IRepository {
  return {
    rootUri: Uri.file(rootPath),
    state: 'idle',
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
}

describe('Repository multi-select scope', () => {
  let provider: GitToolWindowProvider;
  let scopeEvents: RepositoryScopeSelection[];

  const a = '/work/alpha';
  const b = '/work/beta';
  const c = '/work/gamma';

  beforeEach(() => {
    provider = new GitToolWindowProvider(Uri.file('/test/extension'));
    provider.setAvailableRepositories([makeRepo(a), makeRepo(b), makeRepo(c)]);
    scopeEvents = [];
    provider.onDidChangeRepositoryScope((e) => scopeEvents.push(e));
  });

  afterEach(() => {
    provider.dispose();
  });

  function select(roots: string[]): void {
    (
      provider as unknown as { _handleVisibleRepositoriesSelection(roots: string[]): void }
    )._handleVisibleRepositoriesSelection(roots);
  }

  it('all roots checked → merged "all", no visible subset', () => {
    select([a, b, c]);
    assert.strictEqual(provider.isAllReposSelected(), true);
    assert.strictEqual(provider.getVisibleRepoRoots(), null);
    assert.deepStrictEqual(
      scopeEvents.map((e) => e.kind),
      ['all']
    );
  });

  it('no roots checked is treated as "all"', () => {
    select([]);
    assert.strictEqual(provider.isAllReposSelected(), true);
    assert.strictEqual(provider.getVisibleRepoRoots(), null);
    assert.deepStrictEqual(
      scopeEvents.map((e) => e.kind),
      ['all']
    );
  });

  it('exactly one root checked collapses to the single-repo scope', () => {
    select([b]);
    assert.strictEqual(provider.isAllReposSelected(), false);
    assert.strictEqual(provider.getVisibleRepoRoots(), null);
    assert.strictEqual(provider.getSelectedRepository()!.rootUri.fsPath, b);
    const last = scopeEvents[scopeEvents.length - 1];
    assert.strictEqual(last.kind, 'repository');
    assert.strictEqual(last.kind === 'repository' ? last.repository.rootUri.fsPath : undefined, b);
  });

  it('a 2-of-3 subset stays merged but records the visible roots', () => {
    select([a, c]);
    assert.strictEqual(provider.isAllReposSelected(), true, 'subset renders as merged');
    assert.deepStrictEqual(provider.getVisibleRepoRoots(), [a, c]);
    assert.deepStrictEqual(
      scopeEvents.map((e) => e.kind),
      ['all'],
      'subset fires a single all-scope change so the loader re-reads the subset'
    );
  });

  it('getVisibleRepositories filters to the subset; is the full list when unscoped', () => {
    assert.strictEqual(provider.getVisibleRepositories().length, 3);
    select([a, c]);
    assert.deepStrictEqual(
      provider.getVisibleRepositories().map((r) => r.rootUri.fsPath),
      [a, c]
    );
  });

  it('ignores an unknown root, matching by normalized path', () => {
    select([a, c, '/work/does-not-exist']);
    assert.deepStrictEqual(provider.getVisibleRepoRoots(), [a, c]);
  });

  it('prunes the subset when a visible root disappears; nulls it below two', () => {
    select([a, b, c].slice(0, 2)); // subset {a, b}
    assert.deepStrictEqual(provider.getVisibleRepoRoots(), [a, b]);

    // gamma removed, a + b remain → subset of 2 of 2 == all → nulled.
    provider.setAvailableRepositories([makeRepo(a), makeRepo(b)]);
    assert.strictEqual(
      provider.getVisibleRepoRoots(),
      null,
      'subset == full list collapses to all'
    );
  });

  it('preserves a 2-of-3 subset across an index-shifting re-discovery', () => {
    select([a, c]); // subset {a, c}
    // Re-discover the same three repos in a different order.
    provider.setAvailableRepositories([makeRepo(c), makeRepo(b), makeRepo(a)]);
    assert.deepStrictEqual(
      [...(provider.getVisibleRepoRoots() ?? [])].sort(),
      [a, c].sort(),
      'subset follows repo identity, not index'
    );
  });

  it('picking a single repo chip clears any active subset', () => {
    select([a, c]);
    assert.deepStrictEqual(provider.getVisibleRepoRoots(), [a, c]);
    (
      provider as unknown as { _handleRepositorySelection(i: number | 'all'): void }
    )._handleRepositorySelection(1);
    assert.strictEqual(provider.getVisibleRepoRoots(), null);
  });
});
