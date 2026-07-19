/**
 * Runtime-ish coverage for the History tab's Details Panel, which now reuses
 * the Log page's model (buildDetailsPanelModel) + renderer (buildDetailsPanelDom).
 * These run the REAL client-side builder in jsdom and assert the rendered DOM —
 * the surface that only shows up on F5 otherwise.
 */
import '../../setup';
import * as assert from 'assert';
import { renderDetailsPanel } from '../../helpers/detailsPanelDom';
import { buildDetailsPanelModel } from '../../../src/git-core/gitToolWindow/provider/detailsPanelModel';
import { renderHistoryTabBody } from '../../../src/git-core/gitToolWindow/html/historyHtml';
import type { ICommitDetails } from '../../../src/git-core/interfaces/IGitToolWindowProvider';
import type { IHistoryTabState } from '../../../src/git-core/gitToolWindow/tabs/HistoryTab';

const ctx = {
  isIssueLinkingEnabled: () => false,
  getSelectedRepoRemote: () => undefined,
  getSelectedRepoProject: () => undefined,
  isKnownCommitHash: () => false,
  getDetailsGroupBy: () => 'tree' as const,
} as never;

function commitDetails(over: Partial<ICommitDetails> = {}): ICommitDetails {
  return {
    hash: 'abc1234def5678abc1234def5678abc1234def56',
    message: 'Fix the thing',
    body: 'A longer body paragraph.',
    author: { name: 'Alice', email: 'alice@example.com' },
    date: new Date('2024-03-04T10:00:00Z'),
    parents: ['parent00parent00parent00parent00parent000'],
    branches: [],
    tags: [],
    changedFiles: [
      { path: 'src/a.ts', status: 'modified' },
      { path: 'src/b.ts', status: 'added' },
    ],
    containingBranches: ['main', 'origin/main'],
    ...over,
  };
}

function loadedState(over: Partial<IHistoryTabState> = {}): IHistoryTabState {
  return {
    filePath: 'src/a.ts',
    commits: [],
    selectedCommit: 'abc1234def5678abc1234def5678abc1234def56',
    compareCommit: undefined,
    branchFilter: undefined,
    lineRange: undefined,
    followRenames: false,
    availableBranches: [],
    error: undefined,
    loading: false,
    affectedPaths: [],
    affectedPathsLoading: false,
    affectedPathsError: undefined,
    containingBranches: ['main'],
    ...over,
  };
}

describe('History tab Details Panel — reuses the Log renderer', () => {
  it('renders the commit message + author from the shared model', () => {
    const panel = renderDetailsPanel(buildDetailsPanelModel(ctx, commitDetails()));
    const html = panel.outerHTML;
    assert.ok(html.includes('Fix the thing'), 'commit subject present');
    assert.ok(html.includes('Alice'), 'author present');
  });

  it('renders the changed files with data-commit-hash (so double-click opens the diff)', () => {
    const panel = renderDetailsPanel(buildDetailsPanelModel(ctx, commitDetails()));
    const items = panel.querySelectorAll('.changed-file-item[data-path][data-commit-hash]');
    assert.strictEqual(items.length, 2, 'both changed files rendered with commit-hash');
  });

  it('shows the containing branches when resolved', () => {
    const panel = renderDetailsPanel(buildDetailsPanelModel(ctx, commitDetails()));
    assert.ok(panel.outerHTML.includes('main'), 'branch name present');
    assert.ok(!panel.outerHTML.includes('loading…'), 'not stuck loading once resolved');
  });

  it('shows "loading…" only while containingBranches is undefined', () => {
    const panel = renderDetailsPanel(
      buildDetailsPanelModel(ctx, commitDetails({ containingBranches: undefined }))
    );
    assert.ok(panel.outerHTML.includes('loading'), 'loading shown while unresolved');
  });

  it('renders an empty changed-files list without throwing', () => {
    const panel = renderDetailsPanel(
      buildDetailsPanelModel(ctx, commitDetails({ changedFiles: [] }))
    );
    assert.ok(panel, 'panel built');
  });
});

describe('History tab body layout', () => {
  it('places the (empty) details container and the list side-by-side, with no nested details-panel', () => {
    const body = renderHistoryTabBody(loadedState());
    assert.ok(body.includes('id="history-details-panel"'), 'details container present');
    assert.ok(body.includes('class="history-main"'), 'side-by-side row present');
    assert.ok(body.includes('class="history-list-panel"'), 'list panel present');
    // The container must NOT itself carry `details-panel` — buildDetailsPanelDom
    // creates that element inside it; a nested .details-panel double-styles.
    assert.ok(
      !/id="history-details-panel"[^>]*class="[^"]*details-panel/.test(body),
      'container must not also be a .details-panel'
    );
  });
});
