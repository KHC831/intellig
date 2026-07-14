/**
 * Regression: the tabbed Git tool window must call `acquireVsCodeApi()` exactly
 * ONCE across all of its client scripts.
 *
 * `acquireVsCodeApi()` throws "An instance of the VS Code API has already been
 * acquired" on every call after the first. With the tabbed layout on (the
 * default), three client scripts coexist in one document — the bundled main
 * entry, the tab-strip wiring, and the History behaviour. When each acquired its
 * own instance, the second and third threw and never attached their listeners,
 * so (depending on render order) commit selection, tab switching, and History
 * navigation all silently died. The fix memoises the API on
 * `window.__intelligVscodeApi` so the first script acquires and the rest reuse it.
 */
import '../../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { tabStripBehaviorScript } from '../../../../src/git-core/gitToolWindow/html/commonHtml';
import { historyTabBehaviorScript } from '../../../../src/git-core/gitToolWindow/html/historyHtml';

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

/**
 * Run the two inline sibling scripts (History + tab strip) and boot the bundled
 * main entry in ONE jsdom realm, sharing a single counting `acquireVsCodeApi`,
 * and report how many times it was called.
 */
function runTabbedDocumentScripts(): {
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
    // Inline siblings first (one acquires + memoises); then the bundled entry
    // must reuse the memo rather than re-acquire.
    window.eval(historyTabBehaviorScript());
    window.eval(tabStripBehaviorScript());
    delete require.cache[require.resolve(ENTRY_ABS)];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require(ENTRY_ABS);

    const historyTab = window.document.querySelector('[data-tab="history"]');
    historyTab?.dispatchEvent(new window.Event('click', { bubbles: true }));
  } catch {
    // Non-acquire DOM gaps are irrelevant; the acquire counter + flag carry the invariant.
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
  it('no client script calls acquireVsCodeApi a second time', () => {
    const { acquireCount, doubleAcquireAttempted } = runTabbedDocumentScripts();
    assert.strictEqual(
      acquireCount,
      1,
      'the main entry, tab-strip, and History scripts must share one acquireVsCodeApi() call'
    );
    assert.ok(
      !doubleAcquireAttempted,
      'a second acquireVsCodeApi() throws and kills that script (dead tabs / commit details)'
    );
  });

  it('the tab strip stays interactive (click posts tabChange) once scripts coexist', () => {
    const { posted } = runTabbedDocumentScripts();
    assert.ok(
      posted.some((m) => (m as { type?: string }).type === 'tabChange'),
      'clicking a tab must still post tabChange — proves the strip script survived'
    );
  });

  /**
   * Structural backstop: every executable `acquireVsCodeApi(` call across the
   * three coexisting client sources (the entry + the two inline builders) must
   * be the memoised form that assigns into `window.__intelligVscodeApi`. A bare
   * re-acquire would throw and kill its script, so this guards against a future
   * edit reintroducing one. Comments are stripped first so the check tracks
   * code, not prose wording.
   */
  it('every acquireVsCodeApi call site memoises onto window.__intelligVscodeApi', () => {
    const entrySource = fs.readFileSync(ENTRY_ABS + '.ts', 'utf8');
    const concatenated = [entrySource, tabStripBehaviorScript(), historyTabBehaviorScript()].join(
      '\n'
    );

    const code = concatenated.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    const callSites = code.match(/acquireVsCodeApi\s*\(/g) ?? [];
    assert.ok(
      callSites.length >= 3,
      'expected each of the three client sources to call acquireVsCodeApi'
    );

    // The entry declares `acquireVsCodeApi` via `declare function acquireVsCodeApi(`;
    // that ambient declaration is not an executable acquire, so exclude it.
    const declarations = code.match(/declare function acquireVsCodeApi\s*\(/g) ?? [];
    const executableCallSites = callSites.length - declarations.length;

    const memoisedAssignments =
      code.match(/__intelligVscodeApi\s*=\s*acquireVsCodeApi\s*\(/g) ?? [];
    assert.strictEqual(
      memoisedAssignments.length,
      executableCallSites,
      'every executable acquireVsCodeApi() must be the `window.__intelligVscodeApi = acquireVsCodeApi()` memo-set form'
    );
  });
});
