/**
 * Console tab affordances: Clear, bottom-pin, and scroll persistence.
 *
 * ConsoleService.clear() had no caller and the tab offered no Clear control at
 * all. Separately, every git command rebuilds the whole webview while the tab
 * is active, so the log snapped back to the top on each one and never followed
 * new output — the graph already persists its scroll, the console did not.
 */

import '../../setup';
import * as assert from 'assert';
import { bootWebviewEntry, type IWebviewEntryHarness } from '../../helpers/bootWebviewEntry';
import {
  renderConsoleTabBody,
  consoleTabStyles,
} from '../../../src/git-core/gitToolWindow/html/consoleHtml';
import { createConsoleTabHandler } from '../../../src/git-core/gitToolWindow/tabs/ConsoleTab';
import type { IConsoleEntry } from '../../../src/git-core/interfaces/IGitToolWindowProvider';

const ENTRY = 'git-core/gitToolWindow/webview/gitToolWindow';

function entries(count = 3): IConsoleEntry[] {
  return Array.from({ length: count }, (_v, i) => ({
    timestamp: new Date('2026-06-01T12:00:00Z'),
    command: `git status ${i}`,
    output: `output ${i}`,
    exitCode: 0,
    isError: false,
  }));
}

const harnesses: IWebviewEntryHarness[] = [];
afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.dispose();
  }
});

/**
 * jsdom performs no layout, so every element reports a zero scroll range and a
 * `scrollTop` assertion would pass without the code under test ever running.
 * Give elements a real range before boot so bottom-pin / restore are observable.
 */
function withScrollRange(scrollHeight = 1000, clientHeight = 200) {
  return (window: IWebviewEntryHarness['window']): void => {
    Object.defineProperty(window.Element.prototype, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(window.Element.prototype, 'clientHeight', {
      configurable: true,
      get: () => clientHeight,
    });
  };
}

function bootConsole(consoleEntries: IConsoleEntry[] = entries()): IWebviewEntryHarness {
  const harness = bootWebviewEntry(ENTRY, {
    bodyHtml: renderConsoleTabBody(consoleEntries),
    beforeBoot: withScrollRange(),
  });
  harnesses.push(harness);
  return harness;
}

describe('Console tab Clear affordance', () => {
  it('renders a Clear control when there are entries', () => {
    const html = renderConsoleTabBody(entries());

    assert.match(html, /class="[^"]*console-clear-btn/);
  });

  it('clicking Clear posts console.clear', () => {
    const harness = bootConsole();

    const button = harness.document.querySelector('.console-clear-btn');
    assert.ok(button, 'sanity: Clear control rendered');
    button.dispatchEvent(new harness.window.MouseEvent('click', { bubbles: true }));

    assert.deepStrictEqual(
      harness.posted.filter((m) => (m as { type?: string }).type === 'console.clear'),
      [{ type: 'console.clear' }]
    );
  });

  it('routes console.clear to the host clear hook', () => {
    let cleared = 0;
    const handler = createConsoleTabHandler({ clearConsole: () => void cleared++ });

    void handler({ type: 'console.clear' });

    assert.strictEqual(cleared, 1);
  });

  it('ignores an unrelated console message', () => {
    let cleared = 0;
    const handler = createConsoleTabHandler({ clearConsole: () => void cleared++ });

    void handler({ type: 'console.filter' });

    assert.strictEqual(cleared, 0);
  });
});

describe('Console tab scroll behaviour', () => {
  it('bounds the log so it scrolls internally instead of growing the page', () => {
    const css = consoleTabStyles();

    assert.match(css, /\.console-log\s*\{[^}]*overflow:\s*auto/);
  });

  it('pins a fresh console to the bottom so newest output is visible', () => {
    const harness = bootConsole();

    const log = harness.document.querySelector('.console-log') as HTMLElement;
    assert.ok(log, 'sanity: console log rendered');
    assert.strictEqual(log.scrollTop, 800, 'scrolled to the bottom of the 1000/200 range');
  });

  it('restores the offset of a console the user had scrolled up', () => {
    const harness = bootWebviewEntry(ENTRY, {
      bodyHtml: renderConsoleTabBody(entries()),
      initialState: { consoleScrollTop: 120, consolePinnedToBottom: false },
      beforeBoot: withScrollRange(),
    });
    harnesses.push(harness);

    const log = harness.document.querySelector('.console-log') as HTMLElement;
    assert.ok(log, 'sanity: console log rendered');
    assert.strictEqual(log.scrollTop, 120, 'restored, not bottom-pinned to 800');
  });

  it('re-pins a console that was left at the bottom, ignoring its stale offset', () => {
    // The saved offset belongs to the PREVIOUS, shorter log. Honouring it
    // would park the view above everything that arrived since.
    const harness = bootWebviewEntry(ENTRY, {
      bodyHtml: renderConsoleTabBody(entries()),
      initialState: { consoleScrollTop: 300, consolePinnedToBottom: true },
      beforeBoot: withScrollRange(),
    });
    harnesses.push(harness);

    const log = harness.document.querySelector('.console-log') as HTMLElement;
    assert.strictEqual(log.scrollTop, 800, 'follows the newest output');
  });

  it('records that the user scrolled away from the bottom', () => {
    const harness = bootConsole();

    const log = harness.document.querySelector('.console-log') as HTMLElement;
    Object.defineProperty(log, 'scrollTop', { value: 240, writable: true, configurable: true });
    log.dispatchEvent(new harness.window.Event('scroll', { bubbles: true }));

    assert.strictEqual(
      (harness.readState() as { consolePinnedToBottom?: boolean } | undefined)
        ?.consolePinnedToBottom,
      false,
      'scrolling up must stop the log from following new output'
    );
  });

  it('re-pins when the user scrolls back to the bottom', () => {
    const harness = bootConsole();

    const log = harness.document.querySelector('.console-log') as HTMLElement;
    Object.defineProperty(log, 'scrollTop', { value: 240, writable: true, configurable: true });
    log.dispatchEvent(new harness.window.Event('scroll', { bubbles: true }));
    Object.defineProperty(log, 'scrollTop', { value: 800, writable: true, configurable: true });
    log.dispatchEvent(new harness.window.Event('scroll', { bubbles: true }));

    assert.strictEqual(
      (harness.readState() as { consolePinnedToBottom?: boolean } | undefined)
        ?.consolePinnedToBottom,
      true,
      'returning to the bottom resumes following'
    );
  });

  it('persists the scroll offset as the user scrolls', () => {
    const harness = bootConsole();

    const log = harness.document.querySelector('.console-log') as HTMLElement;
    Object.defineProperty(log, 'scrollTop', { value: 240, writable: true, configurable: true });
    log.dispatchEvent(new harness.window.Event('scroll', { bubbles: true }));

    assert.strictEqual(
      (harness.readState() as { consoleScrollTop?: number } | undefined)?.consoleScrollTop,
      240
    );
  });
});
