/**
 * Repo-selector identity tests (spec L5 + L14).
 *
 * The repository dropdown's selection must follow the repo's IDENTITY
 * (its normalized path), not its index in the available-repositories
 * array. A reload that re-discovers the same repos in a different order
 * (which happens when a watcher tear-down + re-add shifts cache slots
 * after a mutation) must keep the user's selection pinned to the same
 * repo, not silently jump to whatever now sits at the old index.
 *
 * These pin:
 *   - L5: selection survives a repo-list rebuild that shifts indexes.
 *   - L14: the selected `<option>` is emitted by normalized-path match,
 *     so Windows drive-case / slash-flavor spellings of the same repo
 *     are treated as identical.
 */

import '../../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../../src/ui-shell/GitToolWindowProvider';
import { Uri } from '../../mocks/vscode';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';

function makeRepo(rootPath: string): IRepository {
  return {
    rootUri: Uri.file(rootPath),
    state: 'idle',
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
}

type SetReposArg = Parameters<GitToolWindowProvider['setAvailableRepositories']>[0];

describe('Repo selector identity (L5 + L14)', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    provider = new GitToolWindowProvider(Uri.file('/test/extension'));
  });

  afterEach(() => {
    provider.dispose();
  });

  it('selector survives a repo-list rebuild that shifts indexes (L5)', () => {
    const a = makeRepo('/work/alpha');
    const b = makeRepo('/work/beta');
    const c = makeRepo('/work/gamma');
    provider.setAvailableRepositories([a, b, c] as SetReposArg);

    // Select the SECOND repo (beta, index 1).
    provider.repoScope.handleRepositorySelection(1);
    assert.strictEqual(provider.getSelectedRepository()!.rootUri.fsPath, '/work/beta');

    // Reload: same three repos, reordered so beta is now LAST (index 2).
    // Fresh IRepository instances simulate a re-discovery.
    const reordered = [makeRepo('/work/gamma'), makeRepo('/work/alpha'), makeRepo('/work/beta')];
    provider.setAvailableRepositories(reordered);

    // Selection must follow the PATH (beta), not the index (1 -> alpha).
    assert.strictEqual(
      provider.getSelectedRepository()!.rootUri.fsPath,
      '/work/beta',
      'selection must follow the repo path across an index-shifting reload'
    );
  });

  it('falls back to the first repo when the previously-selected repo is gone', () => {
    const a = makeRepo('/work/alpha');
    const b = makeRepo('/work/beta');
    provider.setAvailableRepositories([a, b] as SetReposArg);
    provider.repoScope.handleRepositorySelection(1); // select beta
    assert.strictEqual(provider.getSelectedRepository()!.rootUri.fsPath, '/work/beta');

    // beta closed; only alpha remains.
    provider.setAvailableRepositories([makeRepo('/work/alpha')] as SetReposArg);
    assert.strictEqual(
      provider.getSelectedRepository()!.rootUri.fsPath,
      '/work/alpha',
      'gone selection falls back to the first repo'
    );
  });

  it('emits a Repository-popup checkbox per repo with a full-path title, checking the scoped repo', () => {
    const a = makeRepo('/work/alpha');
    const b = makeRepo('/work/beta');
    provider.setAvailableRepositories([a, b] as SetReposArg);
    provider.repoScope.handleRepositorySelection(1); // single-repo scope: beta

    const html = provider._getLogFilterRowHtml();

    // Each repo gets a checkbox titled with its full fsPath (disambiguates
    // same-leaf-name repos on hover), keyed by root for the subset message.
    assert.ok(
      html.includes('title="/work/alpha"'),
      `alpha checkbox should carry its path; got: ${html}`
    );
    assert.ok(
      html.includes('title="/work/beta"'),
      `beta checkbox should carry its path; got: ${html}`
    );
    assert.ok(
      html.includes('data-action="toggleRepoCheckbox" data-repo-root="/work/beta" checked'),
      `beta (the scoped repo) should be checked; got: ${html}`
    );
    assert.ok(
      !html.includes('data-repo-root="/work/alpha" checked'),
      `alpha should be unchecked in beta's single-repo scope; got: ${html}`
    );
  });

  it('omits the Repository popup entirely when only one repo is present', () => {
    provider.setAvailableRepositories([makeRepo('/work/solo')] as SetReposArg);
    const html = provider._getLogFilterRowHtml();
    assert.ok(
      !html.includes('toggleRepoCheckbox') && !html.includes('data-popup="repo"'),
      'single-repo workspace has no Repository filter at all'
    );
  });
});
