/**
 * `setAvailableRepositories` must announce effective-scope changes in BOTH
 * directions. It fired the merged→single collapse but not the single→merged
 * restore, so a repo set that transiently passed through one repo (a delete
 * that removes-then-re-adds folders) left the branch tree stuck in single-repo
 * mode — the "branch selector disappeared after deleting a repo" bug. The tree
 * follows `onDidChangeRepositoryScope`, so every real transition must fire.
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

describe('Repository scope announcement across repo-set changes', () => {
  const a = '/work/alpha';
  const b = '/work/beta';
  const c = '/work/gamma';
  let provider: GitToolWindowProvider;
  let events: RepositoryScopeSelection[];

  beforeEach(() => {
    provider = new GitToolWindowProvider(Uri.file('/test/extension'));
    provider.setAvailableRepositories([makeRepo(a), makeRepo(b), makeRepo(c)]);
    events = [];
    provider.onDidChangeRepositoryScope((e) => events.push(e));
  });

  afterEach(() => {
    provider.dispose();
  });

  it('restores merged scope (and announces it) when the set grows back past one', () => {
    assert.strictEqual(provider.isAllReposSelected(), true, 'starts merged');

    provider.setAvailableRepositories([makeRepo(a)]);
    assert.strictEqual(provider.isAllReposSelected(), false, 'collapsed to single');
    assert.strictEqual(events.at(-1)?.kind, 'repository', 'collapse announced');

    provider.setAvailableRepositories([makeRepo(a), makeRepo(b), makeRepo(c)]);
    assert.strictEqual(provider.isAllReposSelected(), true, 'scope restored to all');
    assert.strictEqual(
      events.at(-1)?.kind,
      'all',
      'restore must be announced so the branch tree re-groups'
    );
  });

  it('stays silent when the merged set merely changes size (no scope change)', () => {
    // Adding/removing a repo while staying merged must not churn the wiring.
    provider.setAvailableRepositories([makeRepo(a), makeRepo(b), makeRepo(c), makeRepo('/work/d')]);
    provider.setAvailableRepositories([makeRepo(a), makeRepo(b)]);
    assert.strictEqual(provider.isAllReposSelected(), true, 'still merged throughout');
    assert.deepStrictEqual(events, [], 'no scope events for merged→merged size changes');
  });
});
