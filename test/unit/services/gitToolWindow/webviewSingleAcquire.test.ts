/**
 * Regression: the tabbed Git tool window must call `acquireVsCodeApi()` exactly
 * ONCE across all of its inline scripts.
 *
 * `acquireVsCodeApi()` throws "An instance of the VS Code API has already been
 * acquired" on every call after the first. With the tabbed layout on (the
 * default), three inline scripts coexist in one document — the main script, the
 * tab-strip wiring, and the History behaviour. When each acquired its own
 * instance, the second and third scripts threw and never attached their
 * listeners, so (depending on render order) commit selection, tab switching,
 * and History navigation all silently died. The fix memoises the API on
 * `window` so the first script acquires and the rest reuse it.
 */
import '../../../setup';
import * as assert from 'assert';
import { JSDOM } from 'jsdom';
import { buildInlineScript } from '../../../../src/git-core/gitToolWindow/provider/scriptBuilder';
import { tabStripBehaviorScript } from '../../../../src/git-core/gitToolWindow/html/commonHtml';
import { historyTabBehaviorScript } from '../../../../src/git-core/gitToolWindow/html/historyHtml';

function runTabbedDocumentScripts(): {
  acquireCount: number;
  doubleAcquireAttempted: boolean;
  posted: unknown[];
} {
  const dom = new JSDOM(
    `<!DOCTYPE html><body>
      <div class="intellig-tab-strip" role="tablist">
        <button type="button" data-tab="log" role="tab">Log</button>
        <button type="button" data-tab="history" role="tab">History</button>
      </div>
      <div class="intellig-tab-panel" data-tab-panel="history">
        <div class="history-commit-row" data-rev="abcdef1"></div>
      </div>
      <div class="repository-selector"></div>
    </body>`,
    { runScripts: 'outside-only' }
  );
  const { window } = dom;

  const posted: unknown[] = [];
  let acquireCount = 0;
  let doubleAcquireAttempted = false;
  (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => {
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

  const scripts = [historyTabBehaviorScript(), tabStripBehaviorScript(), buildInlineScript()];
  for (const src of scripts) {
    try {
      window.eval(src);
    } catch {
      // Non-acquire DOM gaps are irrelevant; the acquire counter + flag carry the invariant.
    }
  }

  const historyTab = window.document.querySelector('[data-tab="history"]');
  historyTab?.dispatchEvent(new window.Event('click', { bubbles: true }));

  return { acquireCount, doubleAcquireAttempted, posted };
}

describe('tabbed webview acquires the VS Code API exactly once', () => {
  it('no inline script calls acquireVsCodeApi a second time', () => {
    const { acquireCount, doubleAcquireAttempted } = runTabbedDocumentScripts();
    assert.strictEqual(
      acquireCount,
      1,
      'the main, tab-strip, and History scripts must share one acquireVsCodeApi() call'
    );
    assert.ok(
      !doubleAcquireAttempted,
      'a second acquireVsCodeApi() throws and kills that inline script (dead tabs / commit details)'
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
   * three coexisting builder outputs must be the memoised form that assigns
   * into `window.__intelligVscodeApi`. A bare re-acquire would throw and kill
   * its script, so this guards against a future edit reintroducing one.
   * Comments are stripped first so the check tracks code, not prose wording.
   */
  it('every acquireVsCodeApi call site memoises onto window.__intelligVscodeApi', () => {
    const concatenated = [
      buildInlineScript(),
      tabStripBehaviorScript(),
      historyTabBehaviorScript(),
    ].join('\n');

    // None of these builder strings carry `//` inside a string literal, so the
    // line/block comment strip below only removes genuine comments.
    const code = concatenated.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    const callSites = code.match(/acquireVsCodeApi\s*\(/g) ?? [];
    assert.ok(
      callSites.length >= 3,
      'expected each of the three builders to call acquireVsCodeApi'
    );

    const memoisedAssignments =
      code.match(/__intelligVscodeApi\s*=\s*acquireVsCodeApi\s*\(/g) ?? [];
    assert.strictEqual(
      memoisedAssignments.length,
      callSites.length,
      'every executable acquireVsCodeApi() must be the `window.__intelligVscodeApi = acquireVsCodeApi()` memo-set form'
    );
  });
});
