/**
 * Runtime (jsdom) regression for the load-more scroll persist/restore in the
 * Git tool window inline script.
 *
 * The user's actual complaint was the graph "jumps to top" when more commits
 * load. The fix persists the graph-panel scrollTop to webview state on scroll
 * and restores it on every full re-render UNLESS that render is navigational.
 * Scroll is preserved by DEFAULT (the host stamps `data-preserve-scroll`), so an
 * incidental re-render landing right after load-more (cherry marks, selection)
 * keeps the user in place; only a navigational render (repo/filter change,
 * initial load) omits the attribute, resets to top, and clears the stale saved
 * position. Nothing executed those inline blocks, so a regression that dropped
 * the restore — i.e. the original jump-to-top bug — would stay green. These specs
 * run `buildInlineScript()` in jsdom and pin:
 *   1. on scroll, the current scrollTop is written to webview state
 *      (`graphScrollTop`), merged with existing keys;
 *   2. a preserve render (default) restores the saved scrollTop;
 *   3. a navigational render (no attribute) does NOT restore AND clears the
 *      stale saved position so a following incidental render starts at top;
 *   4. an explicit `data-scroll-to-commit` render is not overridden by restore;
 *   5. the restore re-applies on the next animation frame so it survives the
 *      real webview's first layout pass.
 *
 * jsdom does no layout, so `scrollTop` is backed by an explicit accessor that
 * records writes (mirroring how the sibling scroll-wiring test seeds layout
 * numbers).
 */

import '../setup';
import * as assert from 'assert';
import { bootWebviewEntry, IWebviewEntryHarness } from '../helpers/bootWebviewEntry';

/** The entry persists graphScrollTop under a versioned `{v,data}` slot envelope. */
interface ScrollEnvelope {
  v: number;
  data: number;
}
interface WebviewState {
  graphScrollTop?: ScrollEnvelope;
  [k: string]: unknown;
}

interface BootOptions {
  /** Render preserves scroll (default render). Omit/false → navigational reset. */
  preserveScroll: boolean;
  /** Stamp `data-scroll-to-commit` so the explicit-jump path takes priority. */
  scrollToCommit?: string;
  /** Raw initial state; a numeric `graphScrollTop` is wrapped in the slot envelope. */
  initialState?: { graphScrollTop?: number; [k: string]: unknown };
  /**
   * Provide a `requestAnimationFrame` that records callbacks instead of running
   * them, so a test can assert the deferred re-apply and fire it on demand. When
   * absent, no rAF global is defined (the entry must guard on `typeof`).
   */
  captureRaf?: boolean;
}

const rafCallbacks: Array<() => void> = [];

/**
 * Boot the entry in jsdom with a single `.graph-panel`, a recording `scrollTop`
 * accessor, and a stubbed webview state. The restore runs at boot, so the
 * panel's attributes and the initial state must be in place BEFORE boot.
 */
function boot(opts: BootOptions): {
  harness: IWebviewEntryHarness;
  window: IWebviewEntryHarness['window'];
  panel: HTMLElement;
  getScrollTop: () => number;
  state: () => WebviewState;
  flushRaf: () => void;
} {
  rafCallbacks.length = 0;
  let scrollTopVal = 0;
  const preserveAttr = opts.preserveScroll ? ' data-preserve-scroll="true"' : '';
  const scrollToCommitAttr = opts.scrollToCommit
    ? ` data-scroll-to-commit="${opts.scrollToCommit}"`
    : '';

  // Wrap a numeric graphScrollTop into the WebviewStateSlot `{v,data}` envelope.
  const rawInit = { ...(opts.initialState ?? {}) };
  const seedState: Record<string, unknown> = { ...rawInit };
  if (typeof rawInit.graphScrollTop === 'number') {
    seedState.graphScrollTop = { v: 1, data: rawInit.graphScrollTop };
  }

  const harness = bootWebviewEntry('git-core/gitToolWindow/webview/gitToolWindow', {
    bodyHtml:
      `<div class="graph-panel" data-loaded-count="0" data-total-available="0"` +
      `${preserveAttr}${scrollToCommitAttr}></div>`,
    initialState: seedState,
    beforeBoot: (window) => {
      const panel = window.document.querySelector('.graph-panel') as HTMLElement;
      // jsdom doesn't lay out, so scrollTop is a no-op number; back it with an
      // accessor that actually records reads/writes.
      Object.defineProperty(panel, 'scrollTop', {
        get: () => scrollTopVal,
        set: (v: number) => {
          scrollTopVal = v;
        },
        configurable: true,
      });
      if (opts.captureRaf) {
        (
          window as unknown as { requestAnimationFrame: (cb: () => void) => number }
        ).requestAnimationFrame = (cb: () => void): number => {
          rafCallbacks.push(cb);
          return rafCallbacks.length;
        };
      }
    },
  });

  const panel = harness.document.querySelector('.graph-panel') as HTMLElement;

  return {
    harness,
    window: harness.window,
    panel,
    getScrollTop: () => scrollTopVal,
    state: () => (harness.readState() ?? {}) as WebviewState,
    flushRaf: () => {
      const pending = rafCallbacks.splice(0);
      pending.forEach((cb) => cb());
    },
  };
}

describe('Git tool window entry — load-more scroll restore (jsdom)', () => {
  const booted: IWebviewEntryHarness[] = [];
  const track = <T extends { harness: IWebviewEntryHarness }>(b: T): T => {
    booted.push(b.harness);
    return b;
  };

  afterEach(() => {
    // Dispose in reverse (LIFO) so each restores the globals its predecessor set.
    while (booted.length) {
      booted.pop()!.dispose();
    }
  });

  it('persists the graph-panel scrollTop to webview state on scroll (merging existing keys)', () => {
    const { window, panel, state } = track(
      boot({
        preserveScroll: true,
        initialState: { unrelated: 'keep-me' },
      })
    );

    panel.scrollTop = 742; // user scrolled
    panel.dispatchEvent(new window.Event('scroll'));

    assert.strictEqual(state().graphScrollTop?.data, 742, 'scrollTop is saved to webview state');
    assert.strictEqual(state().unrelated, 'keep-me', 'existing state keys are preserved');
  });

  it('restores the saved scrollTop on a preserve render (the default)', () => {
    const { getScrollTop } = track(
      boot({
        preserveScroll: true,
        initialState: { graphScrollTop: 1234 },
      })
    );

    assert.strictEqual(
      getScrollTop(),
      1234,
      'a preserve render restores the saved position instead of resetting to top'
    );
  });

  it('does NOT restore on a navigational render (no attribute) — stays at the top', () => {
    const { getScrollTop } = track(
      boot({
        preserveScroll: false,
        initialState: { graphScrollTop: 1234 },
      })
    );

    assert.strictEqual(getScrollTop(), 0, 'a navigational (repo/filter) render starts at the top');
  });

  it('clears the stale saved position on a navigational render so the next render starts at top', () => {
    const { state } = track(
      boot({
        preserveScroll: false,
        initialState: { graphScrollTop: 1234, unrelated: 'keep-me' },
      })
    );

    assert.strictEqual(
      state().graphScrollTop?.data,
      0,
      'the navigational render wipes the now-stale scroll so an incidental re-render restores top'
    );
    assert.strictEqual(state().unrelated, 'keep-me', 'other state keys survive the reset');
  });

  it('preserves scroll across an incidental render right after load-more (the dogfood regression)', () => {
    // Render 1: load-more (preserve) restores the saved position.
    const first = track(boot({ preserveScroll: true, initialState: { graphScrollTop: 980 } }));
    assert.strictEqual(first.getScrollTop(), 980, 'load-more render restores scroll');

    // Render 2: the cherry-mark update is ALSO a preserve render (preserve is
    // the default now), so it restores again instead of snapping to top. The
    // saved position is untouched by render 1, so the value is still there.
    const second = track(boot({ preserveScroll: true, initialState: { graphScrollTop: 980 } }));
    assert.strictEqual(
      second.getScrollTop(),
      980,
      'the incidental second render restores scroll — it does NOT reset to top'
    );
  });

  it('does not let the preserve-restore override an explicit data-scroll-to-commit render', () => {
    const { getScrollTop } = track(
      boot({
        preserveScroll: true,
        scrollToCommit: 'abc123',
        initialState: { graphScrollTop: 1234 },
      })
    );

    // The explicit jump-to-commit path (autoScrollOnLoad) owns the scroll; the
    // restore must bail so it doesn't clobber it back to the saved position.
    assert.strictEqual(
      getScrollTop(),
      0,
      'restore is suppressed when an explicit scroll-to-commit is present'
    );
  });

  it('re-applies the restore on the next animation frame so it survives the first layout pass', () => {
    const { panel, getScrollTop, flushRaf } = track(
      boot({
        preserveScroll: true,
        initialState: { graphScrollTop: 555 },
        captureRaf: true,
      })
    );

    // Immediate restore happened at boot time.
    assert.strictEqual(getScrollTop(), 555, 'restore applies synchronously');

    // Simulate the real webview clamping/resetting scrollTop before layout.
    panel.scrollTop = 0;
    flushRaf();
    assert.strictEqual(
      getScrollTop(),
      555,
      'the rAF retry re-applies the saved position after layout settles'
    );
  });

  it('does not restore a zero/absent saved position (no spurious scroll)', () => {
    const { getScrollTop } = track(
      boot({
        preserveScroll: true,
        initialState: {},
      })
    );
    assert.strictEqual(getScrollTop(), 0, 'no saved position → nothing to restore');
  });
});
