/**
 * Runtime (jsdom) regression for the load-more scroll persist/restore in the
 * Git tool window inline script.
 *
 * The user's actual complaint was the graph "jumps to top" when more commits
 * load. The fix persists the graph-panel scrollTop to webview state on scroll
 * and restores it after the grown render (the full webview.html reload would
 * otherwise reset scrollTop to 0). Nothing executed those two inline blocks, so
 * a regression that dropped the restore — i.e. the original jump-to-top bug —
 * would stay green. These specs run `buildInlineScript()` in jsdom and pin:
 *   1. on scroll, the current scrollTop is written to webview state
 *      (`graphScrollTop`), merged with existing keys;
 *   2. a render carrying `data-preserve-scroll` restores the saved scrollTop;
 *   3. a normal render (no attribute) does NOT restore — it stays at the top,
 *      so the one-shot preserve never wedges subsequent filter/repo renders.
 *
 * jsdom does no layout, so `scrollTop` is backed by an explicit accessor that
 * records writes (mirroring how the sibling scroll-wiring test seeds layout
 * numbers).
 */

import '../setup';
import * as assert from 'assert';
import { JSDOM } from 'jsdom';
import { buildInlineScript } from '../../git-core/gitToolWindow/provider/scriptBuilder';

interface WebviewState {
  graphScrollTop?: number;
  [k: string]: unknown;
}

interface BootOptions {
  preserveScroll: boolean;
  initialState?: WebviewState;
}

/**
 * Boot the inline script in jsdom with a single `.graph-panel`, a recording
 * `scrollTop` accessor, and a stubbed webview state. The restore IIFE runs at
 * script-eval time, so the panel's `data-preserve-scroll` attribute and the
 * initial state must be in place BEFORE eval.
 */
function boot(opts: BootOptions): {
  window: JSDOM['window'];
  panel: HTMLElement;
  getScrollTop: () => number;
  state: WebviewState;
} {
  const attr = opts.preserveScroll ? ' data-preserve-scroll="true"' : '';
  const dom = new JSDOM(
    `<!doctype html><html><body>` +
      `<div class="graph-panel" data-loaded-count="0" data-total-available="0"${attr}></div>` +
      `</body></html>`,
    { runScripts: 'outside-only' }
  );
  const window = dom.window;
  const panel = window.document.querySelector('.graph-panel') as HTMLElement;

  // jsdom doesn't lay out, so scrollTop is a no-op number; back it with an
  // accessor that actually records reads/writes.
  let scrollTopVal = 0;
  Object.defineProperty(panel, 'scrollTop', {
    get: () => scrollTopVal,
    set: (v: number) => {
      scrollTopVal = v;
    },
    configurable: true,
  });

  const state: WebviewState = { ...(opts.initialState ?? {}) };
  const api = {
    postMessage: (): void => {},
    // VS Code hands back a fresh object each call (structured-clone), never the
    // live ref — return a copy so the script's read→mutate→setState merge works.
    getState: (): WebviewState => ({ ...state }),
    setState: (s: WebviewState): void => {
      Object.keys(state).forEach((k) => delete state[k]);
      Object.assign(state, s);
    },
  };
  (window as unknown as { acquireVsCodeApi: () => typeof api }).acquireVsCodeApi = () => api;

  window.eval(buildInlineScript());

  return { window, panel, getScrollTop: () => scrollTopVal, state };
}

describe('Git tool window inline script — load-more scroll restore (jsdom)', () => {
  it('persists the graph-panel scrollTop to webview state on scroll (merging existing keys)', () => {
    const { window, panel, state } = boot({
      preserveScroll: false,
      initialState: { unrelated: 'keep-me' },
    });

    panel.scrollTop = 742; // user scrolled
    panel.dispatchEvent(new window.Event('scroll'));

    assert.strictEqual(state.graphScrollTop, 742, 'scrollTop is saved to webview state');
    assert.strictEqual(state.unrelated, 'keep-me', 'existing state keys are preserved');
  });

  it('restores the saved scrollTop when the render carries data-preserve-scroll', () => {
    const { getScrollTop } = boot({
      preserveScroll: true,
      initialState: { graphScrollTop: 1234 },
    });

    assert.strictEqual(
      getScrollTop(),
      1234,
      'a preserve-scroll render restores the saved position instead of resetting to top'
    );
  });

  it('does NOT restore on a normal render (no data-preserve-scroll) — stays at the top', () => {
    const { getScrollTop } = boot({
      preserveScroll: false,
      initialState: { graphScrollTop: 1234 },
    });

    assert.strictEqual(
      getScrollTop(),
      0,
      'without the one-shot attribute the panel starts at the top (filter/repo render)'
    );
  });

  it('does not restore a zero/absent saved position (no spurious scroll)', () => {
    const { getScrollTop } = boot({
      preserveScroll: true,
      initialState: {},
    });
    assert.strictEqual(getScrollTop(), 0, 'no saved position → nothing to restore');
  });
});
