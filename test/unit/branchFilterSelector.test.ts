/**
 * Unit tests for the Branch filter popup — the Branch button in the log filter
 * row that scopes the log/graph to a chosen branch (IntelliJ
 * BranchFilterPopupComponent / BranchFilterModel). Default = "All branches";
 * picking a branch threads `filter.branch` into the log query (git log <branch>)
 * via the shared `applyLogFilter` pipeline.
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

describe('Branch filter popup — render', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    provider = new GitToolWindowProvider(Uri.file('/test/extension'));
    provider.setAvailableRepositories([makeRepo()]);
  });

  afterEach(() => {
    provider.dispose();
  });

  it('renders a Branch popup button defaulting to "All"', () => {
    const html = provider._getLogFilterRowHtml();
    assert.ok(html.includes('data-popup="branch"'), 'has the Branch popup trigger');
    assert.ok(/id="filter-branch-value">All</.test(html), 'Branch value defaults to All');
    assert.ok(html.includes('data-f-branch=""'), 'row mirrors an empty branch scope');
  });

  it('shows the active branch as the Branch button value', () => {
    provider.setLogFilter({ branch: 'feature/x' });
    const html = provider._getLogFilterRowHtml();
    assert.ok(/id="filter-branch-value">feature\/x</.test(html), 'Branch value shows the branch');
    assert.ok(html.includes('data-f-branch="feature/x"'), 'row mirrors the branch for the script');
  });

  it('shows a range as the Branch button value', () => {
    provider.setLogFilter({ logRange: 'main..feature' });
    const html = provider._getLogFilterRowHtml();
    assert.ok(
      /id="filter-branch-value">main\.\.feature</.test(html),
      'range shown in Branch value'
    );
  });

  it('escapes a hostile branch name in the rendered value', () => {
    provider.setLogFilter({ branch: '"><img src=x>' });
    const html = provider._getLogFilterRowHtml();
    assert.ok(!html.includes('<img src=x>'), 'must not emit a raw tag');
  });
});

describe('Branch filter popup — selection handling', () => {
  let provider: GitToolWindowProvider;
  let lastFilter: ILogFilter | undefined;
  let fireCount: number;

  function applyBranch(branch: string): void {
    (provider as unknown as { _handleMessage(m: unknown): void })._handleMessage({
      type: 'applyLogFilter',
      filter: { branch },
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
    applyBranch('feature/x');
    assert.strictEqual(fireCount, 1);
    assert.strictEqual(lastFilter?.branch, 'feature/x');
    assert.strictEqual(provider.getExtendedLogState().filter?.branch, 'feature/x');
  });

  it('clears the branch scope (undefined filter) when "All branches" is picked', () => {
    provider.setLogFilter({ branch: 'feature/x' });
    applyBranch('');
    assert.strictEqual(lastFilter, undefined, 'no other criteria → whole filter clears');
    assert.strictEqual(provider.getExtendedLogState().filter, undefined);
  });

  it('routes a range value (A..B) to logRange, not a single branch', () => {
    applyBranch('main..feature');
    assert.strictEqual(lastFilter?.logRange, 'main..feature');
    assert.strictEqual(lastFilter?.branch, undefined);
  });

  it('drops a flag-injection branch value (security)', () => {
    applyBranch('--upload-pack=evil');
    assert.strictEqual(
      provider.getExtendedLogState().filter?.branch,
      undefined,
      'a leading-dash ref must be dropped, not applied'
    );
  });

  it('drops a leading-dot ref (getLog throws on it)', () => {
    applyBranch('.hidden');
    assert.strictEqual(
      provider.getExtendedLogState().filter?.branch,
      undefined,
      'a leading-dot ref must be dropped, not applied'
    );
  });
});
