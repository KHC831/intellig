/**
 * `commitsLoaded` round-trip — host post + webview debounce re-arm.
 *
 * The webview debounces scroll-to-bottom load-more with
 * `loadMoreCommitsRequested`. Re-arming it must NOT rely on the full
 * `webview.html` reload happening to reset the flag (a future in-place DOM
 * patch would silently wedge load-more after the first extra page). So the host
 * now EXPLICITLY posts `commitsLoaded` after a load-more render. These specs
 * pin both ends of that contract:
 *   - `GitToolWindowProvider.notifyCommitsLoaded()` posts `{type:'commitsLoaded'}`
 *     to the webview (and is a safe no-op with no view);
 *   - the inline script's handler re-arms the debounce on `commitsLoaded`, so a
 *     second near-bottom scroll fires another `loadMoreCommits`.
 */

import '../../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../../src/ui-shell/GitToolWindowProvider';
import { bootWebviewEntry, IWebviewEntryHarness } from '../../helpers/bootWebviewEntry';
import { Uri } from '../../mocks/vscode';

describe('GitToolWindowProvider.notifyCommitsLoaded — host post', () => {
  it('posts a commitsLoaded message to the webview when a view is attached', () => {
    const provider = new GitToolWindowProvider(Uri.file('/test/extension'));
    const posted: Array<{ type?: string }> = [];
    (provider as unknown as { _view: unknown })._view = {
      webview: {
        postMessage: (msg: { type?: string }) => {
          posted.push(msg);
          return Promise.resolve(true);
        },
      },
    };

    provider.notifyCommitsLoaded();

    assert.deepStrictEqual(posted, [{ type: 'commitsLoaded' }]);
    provider.dispose();
  });

  it('is a safe no-op when no view is attached', () => {
    const provider = new GitToolWindowProvider(Uri.file('/test/extension'));
    assert.doesNotThrow(() => provider.notifyCommitsLoaded());
    provider.dispose();
  });
});

describe('Entry — commitsLoaded re-arms the load-more debounce (jsdom)', () => {
  let h: IWebviewEntryHarness;

  afterEach(() => {
    if (h) {
      h.dispose();
    }
  });

  it('a second near-bottom scroll fires loadMoreCommits again only after commitsLoaded', () => {
    h = bootWebviewEntry('git-core/gitToolWindow/webview/gitToolWindow', {
      bodyHtml: `<div class="graph-panel" data-loaded-count="10" data-total-available="100"></div>`,
    });
    const window = h.window;
    const panel = h.document.querySelector('.graph-panel') as HTMLElement;

    // Seed geometry so a scroll lands within 50px of the bottom with more to
    // load (read by the entry's scroll handler when the event fires).
    Object.defineProperty(panel, 'scrollTop', { value: 1000, configurable: true });
    Object.defineProperty(panel, 'scrollHeight', { value: 1050, configurable: true });
    Object.defineProperty(panel, 'clientHeight', { value: 50, configurable: true });

    const loadMoreCount = (): number =>
      h.posted.filter((m) => (m as { type?: string }).type === 'loadMoreCommits').length;
    const fireScroll = (): void => {
      panel.dispatchEvent(new window.Event('scroll'));
    };

    fireScroll();
    assert.strictEqual(loadMoreCount(), 1, 'first near-bottom scroll requests a page');

    // While the request is in flight, the debounce blocks a second request.
    fireScroll();
    assert.strictEqual(loadMoreCount(), 1, 'debounce blocks a second request until the page loads');

    // Host signals the page rendered → debounce re-arms.
    h.post({ type: 'commitsLoaded' });

    fireScroll();
    assert.strictEqual(loadMoreCount(), 2, 'after commitsLoaded the next scroll requests again');
  });
});
