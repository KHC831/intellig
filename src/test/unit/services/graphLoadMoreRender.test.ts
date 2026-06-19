/**
 * Provider-side load-more render plumbing.
 *
 * Pins the two pieces the dead-emitter fix needs on the render side:
 *   - `updateLogState(..., totalAvailable)` stores the honest total so the
 *     graph panel can render "loaded of total" and the webview can decide
 *     whether scroll-to-bottom should request more;
 *   - `markPreserveScrollOnNextRender()` stamps `data-preserve-scroll` on the
 *     NEXT graph render exactly once, then clears — so a load-more re-render
 *     keeps the user's scroll position but a following normal render does not.
 */

import '../../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../../ui-shell/GitToolWindowProvider';
import { ICommitNode } from '../../../git-core/commitGraph';
import { ICommit } from '../../../git-core/interfaces/IGitService';
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

  describe('markPreserveScrollOnNextRender', () => {
    it('does not stamp data-preserve-scroll by default', () => {
      const html = provider._getGraphPanelHtml([makeNode('a1')]);
      assert.ok(!html.includes('data-preserve-scroll'), 'normal render does not preserve scroll');
    });

    it('stamps data-preserve-scroll on the next render exactly once', () => {
      provider.markPreserveScrollOnNextRender();

      const first = provider._getGraphPanelHtml([makeNode('a1')]);
      assert.ok(
        first.includes('data-preserve-scroll="true"'),
        'load-more render asks the webview to restore scroll'
      );

      const second = provider._getGraphPanelHtml([makeNode('a1')]);
      assert.ok(
        !second.includes('data-preserve-scroll'),
        'the flag is one-shot — the following render resets to top'
      );
    });
  });
});
