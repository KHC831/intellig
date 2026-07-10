/**
 * Structural guard test for the `selectGraphRow` message-handler's
 * visibility gate.
 *
 * When the user plain-clicks a commit row the webview posts `selectCommit`;
 * the host echoes back a `selectGraphRow` message (messageHandlers.selectCommit)
 * so the host stays the source of truth for selection. The webview's
 * `selectGraphRow` handler re-applies the `.selected` highlight AND scrolls the
 * row into view.
 *
 * The scroll must be GUARDED by the same `fullyVisible` visibility check that
 * `scrollToCommit` uses (ADR-009 section 2 — scroll position is webview-owned
 * ephemeral state). Without the gate, every click re-centers an already-visible
 * row with a smooth animation, so the graph "jerks around" on each selection —
 * the same class of bug as the branch-click "sweep from the top" that
 * `scrollToCommit` was hardened against.
 *
 * After the scroll-math de-dup refactor, both call sites delegate to the shared
 * `scrollRowIntoViewIfNeeded` helper rather than repeating the gate inline. These
 * tests pin:
 *  - the handler calls `scrollRowIntoViewIfNeeded(targetRow)`
 *  - the shared helper contains the `fullyVisible` gate
 *  - the handler itself has no unconditional `scrollIntoView` call before any gate
 */

import '../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../src/ui-shell/GitToolWindowProvider';
import { Uri, Webview } from '../mocks/vscode';

function createMockWebview(): Webview {
  return {
    html: '',
    options: {},
    cspSource: 'https://mock.csp.source',
    onDidReceiveMessage: () => ({ dispose: () => {} }),
    postMessage: () => Promise.resolve(true),
    asWebviewUri: (uri: Uri) => uri,
  } as unknown as Webview;
}

/**
 * Extract a brace-matched block beginning at the first `{` after the header
 * pattern match. Returns the block (inclusive of braces) or null.
 */
function extractBlockAfter(body: string, headerPattern: RegExp): string | null {
  const match = headerPattern.exec(body);
  if (!match) {
    return null;
  }
  const openBraceIdx = body.indexOf('{', match.index);
  if (openBraceIdx === -1) {
    return null;
  }
  let depth = 0;
  for (let i = openBraceIdx; i < body.length; i++) {
    const ch = body[i];
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return body.substring(openBraceIdx, i + 1);
      }
    }
  }
  return null;
}

describe('GitToolWindowProvider - inline selectGraphRow scroll visibility guard', () => {
  let provider: GitToolWindowProvider;
  let mockWebview: Webview;
  let html: string;
  let handlerBlock: string;
  let helperBlock: string;

  beforeEach(() => {
    const extensionUri = Uri.file('/test/extension');
    provider = new GitToolWindowProvider(extensionUri);
    mockWebview = createMockWebview();
    html = provider._getThreePanelHtmlContent(
      mockWebview as unknown as import('vscode').Webview,
      []
    );
    const hBlock = extractBlockAfter(html, /message\.type === 'selectGraphRow'/);
    assert.ok(hBlock, 'rendered inline script must contain a selectGraphRow handler block');
    handlerBlock = hBlock;

    const helper = extractBlockAfter(html, /function scrollRowIntoViewIfNeeded\s*\(/);
    assert.ok(helper, 'rendered inline script must contain a scrollRowIntoViewIfNeeded helper');
    helperBlock = helper;
  });

  afterEach(() => {
    provider.dispose();
  });

  it('handler delegates scroll to the shared scrollRowIntoViewIfNeeded helper', () => {
    const delegateCall = /scrollRowIntoViewIfNeeded\s*\(\s*targetRow\s*\)/;
    assert.ok(
      delegateCall.test(handlerBlock),
      'selectGraphRow handler must call scrollRowIntoViewIfNeeded(targetRow) rather than inlining scroll logic'
    );
  });

  it('shared helper computes a fullyVisible visibility gate', () => {
    const gate =
      /const\s+fullyVisible\s*=\s*rowTop\s*>=\s*viewportTop\s*&&\s*rowBottom\s*<=\s*viewportBottom/;
    assert.ok(
      gate.test(helperBlock),
      'scrollRowIntoViewIfNeeded must compute `fullyVisible = rowTop >= viewportTop && rowBottom <= viewportBottom`'
    );
  });

  it('shared helper guards the scroll behind `if (!fullyVisible)` — not an unconditional re-center', () => {
    const guardedScroll =
      /if\s*\(\s*!\s*fullyVisible\s*\)\s*\{(?:\s*\/\/[^\n]*\n)*\s*row\.scrollIntoView\s*\(/;
    assert.ok(
      guardedScroll.test(helperBlock),
      'scrollRowIntoViewIfNeeded must guard scrollIntoView behind `if (!fullyVisible)`'
    );
  });

  it('handler itself has no unconditional scrollIntoView (all scrolling goes through the helper)', () => {
    assert.ok(
      !/scrollIntoView\s*\(/.test(handlerBlock),
      'selectGraphRow handler must not call scrollIntoView directly — only via scrollRowIntoViewIfNeeded'
    );
  });
});
