/**
 * jsdom wiring test for the rendered graph panel scroll affordance.
 *
 * Feature: git-graph-branch-click-scroll.
 *
 * Renders `_getGraphPanelHtml(...)` into jsdom and asserts the DOM wiring the
 * inline `scrollToCommit(commitHash)` routine depends on: every commit surfaces
 * a `[data-hash="…"]` row, and each row sits inside the `.graph-panel`
 * container the inline script walks up to via `closest('.graph-panel')`. The
 * scroll DECISION itself (a fully-visible row is not scrolled; an off-screen
 * row is) is covered against the live inline script by
 * scrollToCommitInlineGuard.test.ts.
 *
 * _Requirements: 1.1, 2.1_
 */

import '../setup';
import * as assert from 'assert';
import { JSDOM } from 'jsdom';
import { GitToolWindowProvider } from '../../src/ui-shell/GitToolWindowProvider';
import { ICommitNode } from '../../src/git-core/commitGraph';
import { ICommit } from '../../src/git-core/interfaces/IGitService';
import { Uri } from '../mocks/vscode';

/**
 * Helper to create a minimal ICommit for testing.
 */
function makeCommit(overrides: Partial<ICommit> = {}): ICommit {
  return {
    hash: 'abc1234567890abcdef1234567890abcdef123456',
    shortHash: 'abc1234',
    message: 'Add scroll visibility gate',
    author: { name: 'Alice', email: 'alice@example.com' },
    committer: { name: 'Alice', email: 'alice@example.com' },
    parents: ['def5678901234567890abcdef1234567890abcdef'],
    authorDate: new Date(2024, 0, 15, 14, 30, 0),
    commitDate: new Date(2024, 0, 15, 14, 30, 0),
    ...overrides,
  };
}

/**
 * Helper to create a minimal ICommitNode for testing.
 */
function makeCommitNode(commitOverrides: Partial<ICommit> = {}): ICommitNode {
  return {
    commit: makeCommit(commitOverrides),
    graphColumn: 0,
    graphLines: [{ fromColumn: 0, toColumn: 0, color: '#4CAF50', type: 'commit' as const }],
    branches: [],
    tags: [],
  };
}

describe('Feature: git-graph-branch-click-scroll - graph panel scroll wiring (jsdom)', () => {
  let provider: GitToolWindowProvider;

  // Two distinct full hashes so we render two `[data-hash]` rows.
  const visibleHash = 'aaa1111111111111111111111111111111111111111';
  const offscreenHash = 'bbb2222222222222222222222222222222222222222';

  beforeEach(() => {
    const extensionUri = Uri.file('/test/extension');
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  it('renders [data-hash] rows inside a .graph-panel container that the inline scrollToCommit selects', () => {
    const nodes = [
      makeCommitNode({ hash: visibleHash, shortHash: 'aaa1111' }),
      makeCommitNode({ hash: offscreenHash, shortHash: 'bbb2222' }),
    ];

    const html = provider._getGraphPanelHtml(nodes);
    const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
    const doc = dom.window.document;

    // The inline scrollToCommit walks up to `.graph-panel` via
    // `commitRow.closest('.graph-panel')`, so the container must exist.
    const panel = doc.querySelector('.graph-panel');
    assert.ok(panel, '.graph-panel container should exist in rendered markup');

    // The inline scrollToCommit resolves the row via
    // `document.querySelector('[data-hash="' + commitHash + '"]')`, so both
    // commits must surface a `[data-hash]` row.
    const visibleRow = doc.querySelector(`[data-hash="${visibleHash}"]`);
    const offscreenRow = doc.querySelector(`[data-hash="${offscreenHash}"]`);
    assert.ok(visibleRow, 'visible commit row should be selectable by data-hash');
    assert.ok(offscreenRow, 'off-screen commit row should be selectable by data-hash');

    // The rows must be inside the panel so `closest('.graph-panel')` resolves.
    // (assert.ok above narrows visibleRow to non-null via its asserts signature.)
    assert.strictEqual(
      visibleRow.closest('.graph-panel'),
      panel,
      'commit row must resolve to the .graph-panel ancestor (matches inline closest())'
    );
  });

  it('mirrors how the inline script gathers geometry from a jsdom element (documentation)', () => {
    // jsdom returns 0 for layout-derived props by default. To SHOW the shape of
    // the inline gather step without relying on real layout, we stamp the same
    // numeric properties the inline script reads, then build the geometry
    // exactly as the inline `scrollToCommit` does.
    const html = provider._getGraphPanelHtml([
      makeCommitNode({ hash: visibleHash, shortHash: 'aaa1111' }),
    ]);
    const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
    const doc = dom.window.document;

    const row = doc.querySelector(`[data-hash="${visibleHash}"]`) as HTMLElement;
    const panel = row.closest('.graph-panel') as HTMLElement;
    assert.ok(row && panel, 'row and panel must resolve for the wiring demonstration');

    // Seed the layout-derived numbers jsdom does not compute.
    Object.defineProperty(row, 'offsetTop', { value: 120, configurable: true });
    Object.defineProperty(row, 'offsetHeight', { value: 20, configurable: true });
    Object.defineProperty(panel, 'scrollTop', { value: 100, configurable: true });
    Object.defineProperty(panel, 'clientHeight', { value: 300, configurable: true });

    // Build geometry the way the inline scrollToCommit does.
    const g = {
      rowTop: row.offsetTop,
      rowBottom: row.offsetTop + row.offsetHeight,
      viewportTop: panel.scrollTop,
      viewportBottom: panel.scrollTop + panel.clientHeight,
    };

    assert.deepStrictEqual(
      g,
      { rowTop: 120, rowBottom: 140, viewportTop: 100, viewportBottom: 400 },
      'inline gather step should produce the seeded geometry'
    );
  });
});
