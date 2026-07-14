/**
 * Regression: the tabbed Git tool window must call `acquireVsCodeApi()` exactly
 * ONCE across its whole client surface.
 *
 * `acquireVsCodeApi()` throws "An instance of the VS Code API has already been
 * acquired" on every call after the first. The tool window used to ship three
 * coexisting inline client scripts (main + tab strip + History behaviour), each
 * acquiring its own handle — the second and third threw and silently died. The
 * fix consolidates all three into the single bundled `gitToolWindow.js` entry,
 * so the document has exactly one client script and one acquire. This test
 * fences against a future edit reintroducing a sibling inline script (or a
 * second acquire inside the entry).
 */
import '../../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM, VirtualConsole } from 'jsdom';

const ENTRY_ABS = path.join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'src',
  'git-core',
  'gitToolWindow',
  'webview',
  'gitToolWindow'
);
const HTML_DIR = path.join(ENTRY_ABS, '..', '..', 'html');

/**
 * Boot the bundled entry in a jsdom realm with a single counting
 * `acquireVsCodeApi`, over a body carrying the tab strip + a History row, and
 * report how many times it was called plus what it posted.
 */
function bootEntryCountingAcquire(): {
  acquireCount: number;
  doubleAcquireAttempted: boolean;
  posted: unknown[];
} {
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(
    `<!DOCTYPE html><body>
      <div class="intellig-tab-strip" role="tablist">
        <button type="button" data-tab="log" role="tab">Log</button>
        <button type="button" data-tab="history" role="tab">History</button>
      </div>
      <div class="intellig-tab-panel" data-tab-panel="history">
        <div class="history-commit-row" data-rev="abcdef1"></div>
      </div>
      <div class="log-filter-row" data-f-branch="" data-f-author="" data-f-path="" data-f-since="" data-f-until=""></div>
    </body>`,
    { runScripts: 'outside-only', virtualConsole }
  );
  const { window } = dom;

  const posted: unknown[] = [];
  let acquireCount = 0;
  let doubleAcquireAttempted = false;
  const acquire = (): unknown => {
    acquireCount += 1;
    if (acquireCount > 1) {
      doubleAcquireAttempted = true;
      throw new Error('An instance of the VS Code API has already been acquired');
    }
    return {
      postMessage: (msg: unknown) => posted.push(msg),
      getState: () => undefined,
      setState: () => undefined,
    };
  };

  const g = global as Record<string, unknown>;
  const saved = {
    window: g.window,
    document: g.document,
    MutationObserver: g.MutationObserver,
    Element: g.Element,
    Node: g.Node,
    HTMLElement: g.HTMLElement,
    acquireVsCodeApi: g.acquireVsCodeApi,
  };
  g.window = window;
  g.document = window.document;
  g.MutationObserver = window.MutationObserver;
  g.Element = window.Element;
  g.Node = window.Node;
  g.HTMLElement = window.HTMLElement;
  g.acquireVsCodeApi = acquire;
  (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = acquire;

  try {
    delete require.cache[require.resolve(ENTRY_ABS)];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require(ENTRY_ABS);

    const historyTab = window.document.querySelector('[data-tab="history"]');
    historyTab?.dispatchEvent(new window.Event('click', { bubbles: true }));
  } catch {
    // Non-acquire DOM gaps are irrelevant; the acquire counter carries the invariant.
  } finally {
    g.window = saved.window;
    g.document = saved.document;
    g.MutationObserver = saved.MutationObserver;
    g.Element = saved.Element;
    g.Node = saved.Node;
    g.HTMLElement = saved.HTMLElement;
    g.acquireVsCodeApi = saved.acquireVsCodeApi;
    window.close();
  }

  return { acquireCount, doubleAcquireAttempted, posted };
}

describe('tabbed webview acquires the VS Code API exactly once', () => {
  it('the bundled entry calls acquireVsCodeApi exactly once', () => {
    const { acquireCount, doubleAcquireAttempted } = bootEntryCountingAcquire();
    assert.strictEqual(acquireCount, 1, 'the tool window ships one client script → one acquire');
    assert.ok(
      !doubleAcquireAttempted,
      'a second acquireVsCodeApi() throws and kills its script (dead tabs / commit details)'
    );
  });

  it('the tab strip stays interactive (click posts tabChange) from the single bundle', () => {
    const { posted } = bootEntryCountingAcquire();
    assert.ok(
      posted.some((m) => (m as { type?: string }).type === 'tabChange'),
      'clicking a tab must post tabChange — proves the folded tab-strip wiring survived'
    );
  });

  /**
   * Structural backstop: the entry has exactly ONE executable
   * `acquireVsCodeApi(` call, carries no `window.__intelligVscodeApi` memo (the
   * multi-script workaround is gone), and the former sibling builders no longer
   * acquire — so a future edit can't quietly reintroduce a second client script.
   * Comments are stripped first so the check tracks code, not prose.
   */
  it('the entry is the sole acquire site and the sibling builders acquire none', () => {
    const strip = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    const entrySource = strip(fs.readFileSync(ENTRY_ABS + '.ts', 'utf8'));
    const callSites = entrySource.match(/acquireVsCodeApi\s*\(/g) ?? [];
    const declarations = entrySource.match(/declare function acquireVsCodeApi\s*\(/g) ?? [];
    assert.strictEqual(
      callSites.length - declarations.length,
      1,
      'the entry must have exactly one executable acquireVsCodeApi() call'
    );
    assert.ok(
      !entrySource.includes('__intelligVscodeApi'),
      'the window.__intelligVscodeApi memo is obsolete once the entry is the sole script'
    );

    for (const name of ['commonHtml.ts', 'historyHtml.ts']) {
      const src = strip(fs.readFileSync(path.join(HTML_DIR, name), 'utf8'));
      assert.ok(
        !/acquireVsCodeApi\s*\(/.test(src),
        `${name} must no longer acquire a webview API — its client script folded into the bundle`
      );
    }
  });
});
