/**
 * Runtime (jsdom) regression tests for the graph-panel scroll wiring in the
 * Git tool window entry (W2).
 *
 * Two leaks shipped because nothing executed the client script against a
 * mutating DOM:
 *   1. The MutationObserver re-attached a FRESH `.graph-panel` scroll listener
 *      on EVERY DOM mutation → listeners leaked for the document's lifetime.
 *   2. It also reset `loadMoreCommitsRequested` on every mutation, weakening
 *      the load-more debounce so a stray mutation could re-fire `loadMoreCommits`
 *      before the host ever sent `commitsLoaded`.
 *
 * These tests boot the entry in jsdom and assert the invariants directly, so a
 * regression reds.
 */

import '../setup';
import * as assert from 'assert';
import { JSDOM } from 'jsdom';
import { bootWebviewEntry, IWebviewEntryHarness } from '../helpers/bootWebviewEntry';

/**
 * Boot the entry over a jsdom document holding a single `.graph-panel`, counting
 * `scroll` registrations on the panel node (wrapped pre-boot), and return
 * handles for assertions.
 */
function bootEntry(): {
  harness: IWebviewEntryHarness;
  window: JSDOM['window'];
  panel: HTMLElement;
  scrollListenerAdds: () => number;
  postedTypes: string[];
  flushMutations: () => Promise<void>;
} {
  let scrollAdds = 0;
  const harness = bootWebviewEntry('git-core/gitToolWindow/webview/gitToolWindow', {
    bodyHtml: `<div class="graph-panel" data-loaded-count="0" data-total-available="0"></div>`,
    beforeBoot: (window) => {
      const panel = window.document.querySelector('.graph-panel') as HTMLElement;
      const origAdd = panel.addEventListener.bind(panel);
      panel.addEventListener = ((type: string, ...rest: unknown[]) => {
        if (type === 'scroll') {
          scrollAdds++;
        }
        return (origAdd as (...a: unknown[]) => void)(type, ...rest);
      }) as typeof panel.addEventListener;
    },
  });
  const window = harness.window;
  const panel = window.document.querySelector('.graph-panel') as HTMLElement;
  const postedTypes = harness.posted.map((m) => (m as { type?: string }).type ?? '');

  const flushMutations = async (): Promise<void> => {
    // MutationObserver callbacks land on the microtask queue; a macrotask hop
    // flushes any batched delivery.
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  };

  return {
    harness,
    window,
    panel,
    scrollListenerAdds: () => scrollAdds,
    postedTypes,
    flushMutations,
  };
}

describe('Git tool window entry — graph-panel scroll wiring (W2, jsdom)', () => {
  let harness: IWebviewEntryHarness | undefined;

  afterEach(() => {
    if (harness) {
      harness.dispose();
      harness = undefined;
    }
  });

  it('attaches the .graph-panel scroll listener exactly once across many DOM mutations', async () => {
    const booted = bootEntry();
    harness = booted.harness;
    const { window, panel, scrollListenerAdds, flushMutations } = booted;

    assert.strictEqual(
      scrollListenerAdds(),
      1,
      'initial setup attaches exactly one scroll listener'
    );

    // Each appended child is a separate body mutation the observer reacts to.
    for (let i = 0; i < 5; i++) {
      const node = window.document.createElement('div');
      node.textContent = `mutation-${i}`;
      window.document.body.appendChild(node);
      // eslint-disable-next-line no-await-in-loop
      await flushMutations();
    }

    assert.strictEqual(
      scrollListenerAdds(),
      1,
      'the scroll listener must NOT be re-added on every DOM mutation (leak guard)'
    );
    void panel;
  });

  it('does not reset the load-more debounce on a DOM mutation (only commitsLoaded clears it)', async () => {
    const booted = bootEntry();
    harness = booted.harness;
    const { window, panel, flushMutations } = booted;
    const loadMoreCount = (): number =>
      booted.harness.posted.filter((m) => (m as { type?: string }).type === 'loadMoreCommits')
        .length;

    // Seed layout-derived numbers jsdom does not compute, so a scroll lands
    // within 50px of the bottom AND there are more commits to load.
    Object.defineProperty(panel, 'scrollTop', { value: 1000, configurable: true });
    Object.defineProperty(panel, 'scrollHeight', { value: 1050, configurable: true });
    Object.defineProperty(panel, 'clientHeight', { value: 50, configurable: true });
    panel.setAttribute('data-loaded-count', '10');
    panel.setAttribute('data-total-available', '100');

    const fireScroll = (): void => {
      panel.dispatchEvent(new window.Event('scroll'));
    };

    fireScroll();
    assert.strictEqual(
      loadMoreCount(),
      1,
      'first near-bottom scroll posts exactly one loadMoreCommits'
    );

    // A DOM mutation must NOT clear the in-flight flag.
    window.document.body.appendChild(window.document.createElement('div'));
    await flushMutations();

    fireScroll();
    assert.strictEqual(
      loadMoreCount(),
      1,
      'a mutation between scrolls must NOT re-arm the debounce; still exactly one post'
    );
  });
});
