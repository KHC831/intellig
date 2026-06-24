/**
 * Unit tests for the branch-filter selector — a dropdown alongside the repo
 * selector that scopes the log/graph to a chosen branch (IntelliJ
 * BranchFilterPopupComponent / BranchFilterModel). Default = "All branches"
 * (current HEAD --branches --remotes behavior); picking a branch threads
 * `filter.branch` into the log query (git log <branch>).
 */

import '../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../src/ui-shell/GitToolWindowProvider';
import { IRepository } from '../../src/git-core/interfaces/IGitService';
import { ILogFilter } from '../../src/git-core/interfaces/IGitToolWindowProvider';
import { Uri } from '../mocks/vscode';

function makeRepo(): IRepository {
  return {
    rootUri: Uri.file('/test/repo'),
    state: 'idle',
    head: { name: 'main', commit: 'abc123', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  };
}

describe('Branch filter selector — render', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    provider = new GitToolWindowProvider(Uri.file('/test/extension'));
  });

  afterEach(() => {
    provider.dispose();
  });

  it('renders nothing when no repository is selected', () => {
    assert.strictEqual(provider._getBranchFilterSelectorHtml(), '');
  });

  it('renders an "All branches" sentinel selected by default', () => {
    provider.setAvailableRepositories([makeRepo()]);
    const html = provider._getBranchFilterSelectorHtml();
    assert.ok(html.includes('branch-filter-selector'), 'has the selector element');
    assert.ok(/All branches/.test(html), 'has the All branches sentinel');
    assert.ok(/value="__all__" selected/.test(html), 'sentinel selected when no branch filter');
  });

  it('preselects the active branch when a branch filter is set', () => {
    provider.setAvailableRepositories([makeRepo()]);
    provider.setLogFilter({ branch: 'feature/x' });
    const html = provider._getBranchFilterSelectorHtml();
    assert.ok(
      html.includes('data-selected-branch="feature/x"'),
      'carries the active branch for client repopulation'
    );
    assert.ok(/value="feature\/x" selected/.test(html), 'active branch option preselected');
    assert.ok(
      !/value="__all__" selected/.test(html),
      'sentinel NOT selected when a branch is active'
    );
  });

  it('does not preselect a branch when the active filter is a range', () => {
    provider.setAvailableRepositories([makeRepo()]);
    provider.setLogFilter({ logRange: 'main..feature' });
    const html = provider._getBranchFilterSelectorHtml();
    assert.ok(/value="__all__" selected/.test(html), 'a range is not a single-branch scope');
    assert.ok(!/data-selected-branch="main\.\.feature"/.test(html));
  });

  it('escapes a hostile branch name in the preselected option', () => {
    provider.setAvailableRepositories([makeRepo()]);
    provider.setLogFilter({ branch: '"><img src=x>' });
    const html = provider._getBranchFilterSelectorHtml();
    assert.ok(!html.includes('<img src=x>'), 'must not emit a raw tag');
  });
});

describe('Branch filter selector — selection handling', () => {
  let provider: GitToolWindowProvider;
  let lastFilter: ILogFilter | undefined;
  let fireCount: number;

  function postSelectBranch(branch: string | null): void {
    (provider as unknown as { _handleMessage(m: unknown): void })._handleMessage({
      type: 'selectBranchFilter',
      branch,
    });
  }

  beforeEach(() => {
    provider = new GitToolWindowProvider(Uri.file('/test/extension'));
    provider.setAvailableRepositories([makeRepo()]);
    lastFilter = undefined;
    fireCount = 0;
    provider.onDidRequestLogFilter((f) => {
      lastFilter = f;
      fireCount += 1;
    });
  });

  afterEach(() => {
    provider.dispose();
  });

  it('sets filter.branch and fires the log-filter request when a branch is picked', () => {
    postSelectBranch('feature/x');
    assert.strictEqual(fireCount, 1);
    assert.strictEqual(lastFilter?.branch, 'feature/x');
    assert.strictEqual(provider.getExtendedLogState().filter?.branch, 'feature/x');
  });

  it('clears the branch scope (undefined filter) when "All branches" is picked', () => {
    provider.setLogFilter({ branch: 'feature/x' });
    postSelectBranch(null);
    assert.strictEqual(fireCount, 1);
    assert.strictEqual(lastFilter, undefined, 'no other criteria → whole filter clears');
    assert.strictEqual(provider.getExtendedLogState().filter, undefined);
  });

  it('preserves other active filter criteria when switching branch', () => {
    provider.setLogFilter({ author: 'jane', branch: 'old' });
    postSelectBranch('new');
    assert.strictEqual(lastFilter?.author, 'jane', 'author criterion preserved');
    assert.strictEqual(lastFilter?.branch, 'new', 'branch updated');
  });

  it('clears a conflicting range when a single branch is picked', () => {
    provider.setLogFilter({ logRange: 'main..feature' });
    postSelectBranch('feature/x');
    assert.strictEqual(lastFilter?.logRange, undefined, 'range dropped in favor of the branch');
    assert.strictEqual(lastFilter?.branch, 'feature/x');
  });

  it('rejects a flag-injection branch value without firing (security)', () => {
    postSelectBranch('--upload-pack=evil');
    assert.strictEqual(fireCount, 0, 'a leading-dash ref must be dropped, not applied');
    assert.strictEqual(provider.getExtendedLogState().filter, undefined);
  });

  it('rejects a leading-dot ref without firing (getLog throws on it)', () => {
    // GitService.getLog rejects refs starting with `.` (invalid per
    // git-check-ref-format); dropping it here avoids a failed reload.
    postSelectBranch('.hidden');
    assert.strictEqual(fireCount, 0, 'a leading-dot ref must be dropped, not applied');
    assert.strictEqual(provider.getExtendedLogState().filter, undefined);
  });
});
