/**
 * Render tests for the History tab "affected paths" pane — the list of files
 * changed in the selected revision (mirrors IntelliJ's commit-changes view in
 * `VcsLogChangesBrowser` / the file-history details pane).
 *
 * Pure-render assertions: `renderAffectedPaths` is a synchronous function over
 * the tab state, so these tests construct a state literal directly without
 * pulling the HistoryTab class's `vscode` runtime import.
 */

import '../../setup';
import * as assert from 'assert';
import {
  affectedPathStatusLabel,
  renderAffectedPaths,
} from '../../../git-core/gitToolWindow/html/historyHtml';
import type { IHistoryTabState } from '../../../git-core/gitToolWindow/tabs/HistoryTab';

const BASE_STATE: IHistoryTabState = {
  filePath: 'src/app.ts',
  commits: [],
  selectedCommit: 'abc1234',
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
};

describe('historyHtml — affected paths pane', () => {
  it('maps each FileStatus to its single-letter git status code', () => {
    assert.strictEqual(affectedPathStatusLabel('modified'), 'M');
    assert.strictEqual(affectedPathStatusLabel('added'), 'A');
    assert.strictEqual(affectedPathStatusLabel('deleted'), 'D');
    assert.strictEqual(affectedPathStatusLabel('renamed'), 'R');
    assert.strictEqual(affectedPathStatusLabel('copied'), 'C');
    assert.strictEqual(affectedPathStatusLabel('untracked'), 'U');
    assert.strictEqual(affectedPathStatusLabel('conflicted'), 'U');
  });

  it('renders one row per affected path with its status badge and path', () => {
    const html = renderAffectedPaths({
      ...BASE_STATE,
      affectedPaths: [
        { path: 'src/a.ts', status: 'modified' },
        { path: 'src/b.ts', status: 'added' },
      ],
    });
    assert.ok(html.includes('src/a.ts'), 'first path must render');
    assert.ok(html.includes('src/b.ts'), 'second path must render');
    assert.ok(html.includes('history-affected-status'), 'status badge class must render');
    const rowCount = (html.match(/history-affected-row/g) ?? []).length;
    assert.strictEqual(rowCount, 2, 'exactly two affected-path rows');
  });

  it('shows the old → new path for a renamed entry', () => {
    const html = renderAffectedPaths({
      ...BASE_STATE,
      affectedPaths: [{ path: 'src/new.ts', status: 'renamed', oldPath: 'src/old.ts' }],
    });
    assert.ok(html.includes('src/old.ts'), 'old path must render for a rename');
    assert.ok(html.includes('src/new.ts'), 'new path must render for a rename');
  });

  it('renders a loading placeholder while affected paths are in flight', () => {
    const html = renderAffectedPaths({ ...BASE_STATE, affectedPathsLoading: true });
    assert.ok(/loading/i.test(html), 'loading placeholder must mention loading');
  });

  it('renders the affected-paths error when present', () => {
    const html = renderAffectedPaths({ ...BASE_STATE, affectedPathsError: 'kaboom' });
    assert.ok(html.includes('kaboom'), 'error text must surface');
    assert.ok(html.includes('role="alert"'), 'error must use an alert role');
  });

  it('escapes HTML metacharacters in affected paths', () => {
    const html = renderAffectedPaths({
      ...BASE_STATE,
      affectedPaths: [{ path: 'src/<script>.ts', status: 'added' }],
    });
    assert.ok(!html.includes('<script>'), 'raw markup must not leak into the pane');
    assert.ok(html.includes('&lt;script&gt;'), 'metacharacters must be escaped');
  });

  it('renders an empty-state hint when no revision change set is available', () => {
    const html = renderAffectedPaths({ ...BASE_STATE, affectedPaths: [] });
    assert.ok(/no (changed |affected )/i.test(html), 'empty pane must show a hint');
  });
});
