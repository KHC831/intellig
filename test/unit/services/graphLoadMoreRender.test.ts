/**
 * Provider-side load-more render plumbing.
 *
 * Pins the two pieces the dead-emitter fix needs on the render side:
 *   - `updateLogState(..., totalAvailable)` stores the honest total so the
 *     graph panel can render "loaded of total" and the webview can decide
 *     whether scroll-to-bottom should request more;
 *   - scroll is preserved by DEFAULT — every render stamps `data-preserve-scroll`
 *     so in-place re-renders (load-more, cherry-mark arrival, selection) keep the
 *     user's scroll position; `markResetScrollOnNextRender()` omits the attribute
 *     on exactly the next (navigational) render so a repo/filter change starts at
 *     the top.
 */

import '../../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../../src/ui-shell/GitToolWindowProvider';
import { ICommitNode } from '../../../src/git-core/commitGraph';
import { ICommit } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

function makeCommit(hash: string): ICommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    message: `msg ${hash}`,
    author: { name: 'A', email: 'a@a' },
    committer: { name: 'A', email: 'a@a' },
    parents: [],
    authorDate: new Date(0),
    commitDate: new Date(0),
  };
}

function makeNode(hash: string): ICommitNode {
  return {
    commit: makeCommit(hash),
    graphColumn: 0,
    graphLines: [{ fromColumn: 0, toColumn: 0, color: '#4CAF50', type: 'commit' as const }],
    branches: [],
    tags: [],
  };
}

describe('GitToolWindowProvider — load-more render plumbing', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    provider = new GitToolWindowProvider(Uri.file('/test/extension'));
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('totalAvailable', () => {
    it('defaults to undefined when no total is supplied', () => {
      provider.updateLogState([makeCommit('a1')]);
      assert.strictEqual(provider.getLogTotalAvailable(), undefined);
    });

    it('stores the supplied total so the indicator can show loaded-of-total', () => {
      provider.updateLogState(
        [makeCommit('a1'), makeCommit('a2')],
        undefined,
        undefined,
        'a1',
        undefined,
        600
      );
      assert.strictEqual(provider.getLogTotalAvailable(), 600);
    });

    it('renders data-total-available from the stored total and a "of N" indicator with more to load', () => {
      const nodes = [makeNode('a1'), makeNode('a2')];
      // Two loaded, 600 available → hasMore.
      const html = provider._getGraphPanelHtml(nodes, undefined, 2, 600);
      assert.ok(html.includes('data-total-available="600"'), 'panel advertises the real total');
      assert.ok(html.includes('data-loaded-count="2"'), 'panel advertises loaded count');
      assert.ok(html.includes('(2 of 600)'), 'indicator shows honest "loaded of total"');
    });

    it('shows no loading indicator when everything is loaded', () => {
      const nodes = [makeNode('a1'), makeNode('a2')];
      const html = provider._getGraphPanelHtml(nodes, undefined, 2, 2);
      assert.ok(!html.includes('graph-loading-indicator'), 'no indicator at the true end');
    });
  });

  describe('scroll preserve-by-default / navigational reset', () => {
    it('stamps data-preserve-scroll by default so in-place re-renders keep scroll', () => {
      const html = provider._getGraphPanelHtml([makeNode('a1')]);
      assert.ok(
        html.includes('data-preserve-scroll="true"'),
        'every render preserves scroll unless a navigational reset is requested'
      );
    });

    it('omits data-preserve-scroll on exactly the next render after markResetScrollOnNextRender (one-shot)', () => {
      provider.markResetScrollOnNextRender();

      const navigational = provider._getGraphPanelHtml([makeNode('a1')]);
      assert.ok(
        !navigational.includes('data-preserve-scroll'),
        'a fresh navigational render resets to the top'
      );

      const following = provider._getGraphPanelHtml([makeNode('a1')]);
      assert.ok(
        following.includes('data-preserve-scroll="true"'),
        'the reset is one-shot — the following render preserves scroll again'
      );
    });

    // Regression for the dogfood bug: the graph jumped to top after load-more
    // because a SECOND incidental render (cherry marks arriving async) landed
    // right after the load-more render and the old one-shot preserve flag was
    // already consumed by the first. Preserve-by-default keeps BOTH renders'
    // attribute so the user's scroll survives the incidental re-render.
    it('preserves scroll across the incidental cherry-mark render after load-more', () => {
      // Load-more is an in-place render: no reset requested → preserves.
      const loadMoreRender = provider._getGraphPanelHtml([makeNode('a1')], undefined, 2, 600);
      assert.ok(
        loadMoreRender.includes('data-preserve-scroll="true"'),
        'load-more render preserves scroll'
      );

      // Cherry marks arrive async → setCherryPickedHashes → _updateWebview →
      // a second render with NO new load-more. It must STILL preserve scroll.
      const cherryRender = provider._getGraphPanelHtml([makeNode('a1')], undefined, 2, 600);
      assert.ok(
        cherryRender.includes('data-preserve-scroll="true"'),
        'the incidental second render must NOT reset to top'
      );
    });

    it('resets only the navigational render, then preserves the incidental render after it', () => {
      // Fresh navigational load (repo/filter change) → reset.
      provider.markResetScrollOnNextRender();
      const navigational = provider._getGraphPanelHtml([makeNode('a1')], undefined, 2, 600);
      assert.ok(
        !navigational.includes('data-preserve-scroll'),
        'the navigational render resets to top'
      );

      // The cherry-mark render that follows a fresh load preserves — the webview
      // clears the stale saved position on the reset render so this restores top.
      const cherryRender = provider._getGraphPanelHtml([makeNode('a1')], undefined, 2, 600);
      assert.ok(
        cherryRender.includes('data-preserve-scroll="true"'),
        'the render after a navigational reset preserves scroll'
      );
    });
  });
});
