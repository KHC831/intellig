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
import { JSDOM } from 'jsdom';
import { GitToolWindowProvider } from '../../../ui-shell/GitToolWindowProvider';
import { buildInlineScript } from '../../../git-core/gitToolWindow/provider/scriptBuilder';
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

describe('Inline script — commitsLoaded re-arms the load-more debounce (jsdom)', () => {
  it('a second near-bottom scroll fires loadMoreCommits again only after commitsLoaded', () => {
    const dom = new JSDOM(
      `<!doctype html><html><body>` +
        `<div class="graph-panel" data-loaded-count="10" data-total-available="100"></div>` +
        `</body></html>`,
      { runScripts: 'outside-only' }
    );
    const window = dom.window;
    const panel = window.document.querySelector('.graph-panel') as HTMLElement;

    const postedTypes: string[] = [];
    const api = {
      postMessage: (msg: { type: string }): void => {
        postedTypes.push(msg.type);
      },
      getState: () => ({}),
      setState: (): void => {},
    };
    (window as unknown as { acquireVsCodeApi: () => typeof api }).acquireVsCodeApi = () => api;

    // Seed geometry so a scroll lands within 50px of the bottom with more to load.
    Object.defineProperty(panel, 'scrollTop', { value: 1000, configurable: true });
    Object.defineProperty(panel, 'scrollHeight', { value: 1050, configurable: true });
    Object.defineProperty(panel, 'clientHeight', { value: 50, configurable: true });

    window.eval(buildInlineScript());

    const loadMoreCount = (): number => postedTypes.filter((t) => t === 'loadMoreCommits').length;
    const fireScroll = (): void => {
      panel.dispatchEvent(new window.Event('scroll'));
    };

    fireScroll();
    assert.strictEqual(loadMoreCount(), 1, 'first near-bottom scroll requests a page');

    // While the request is in flight, the debounce blocks a second request.
    fireScroll();
    assert.strictEqual(loadMoreCount(), 1, 'debounce blocks a second request until the page loads');

    // Host signals the page rendered → debounce re-arms.
    window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'commitsLoaded' } }));

    fireScroll();
    assert.strictEqual(loadMoreCount(), 2, 'after commitsLoaded the next scroll requests again');
  });
});
