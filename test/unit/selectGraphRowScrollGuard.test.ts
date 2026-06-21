/**
 * Structural guard test for the inline `selectGraphRow` message-handler's
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
 * This guard pins the gate so the unconditional `scrollIntoView` cannot return.
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
  let handlerBlock: string;

  beforeEach(() => {
    const extensionUri = Uri.file('/test/extension');
    provider = new GitToolWindowProvider(extensionUri);
    mockWebview = createMockWebview();
    const html = provider._getThreePanelHtmlContent(
      mockWebview as unknown as import('vscode').Webview,
      []
    );
    const block = extractBlockAfter(html, /message\.type === 'selectGraphRow'/);
    assert.ok(block, 'rendered inline script must contain a selectGraphRow handler block');
    handlerBlock = block;
  });

  afterEach(() => {
    provider.dispose();
  });

  it('computes a fullyVisible visibility gate (mirror of isRowFullyVisible)', () => {
    const gate =
      /const\s+fullyVisible\s*=\s*rowTop\s*>=\s*viewportTop\s*&&\s*rowBottom\s*<=\s*viewportBottom/;
    assert.ok(
      gate.test(handlerBlock),
      'selectGraphRow must compute `fullyVisible = rowTop >= viewportTop && rowBottom <= viewportBottom` before scrolling'
    );
  });

  it('guards the scroll behind `if (!fullyVisible)` — not an unconditional re-center', () => {
    const guardedScroll =
      /if\s*\(\s*!\s*fullyVisible\s*\)\s*\{(?:\s*\/\/[^\n]*\n)*\s*targetRow\.scrollIntoView\s*\(/;
    assert.ok(
      guardedScroll.test(handlerBlock),
      'the `if (!fullyVisible)` block must immediately precede the targetRow.scrollIntoView call'
    );
  });

  it('does not scroll before computing the visibility gate (no unconditional scroll)', () => {
    const gateIdx = handlerBlock.indexOf('const fullyVisible');
    assert.notStrictEqual(gateIdx, -1, 'expected the fullyVisible gate in the handler');
    const beforeGate = handlerBlock.slice(0, gateIdx);
    assert.ok(
      !/scrollIntoView\s*\(/.test(beforeGate),
      'selectGraphRow must NOT scroll before computing the visibility gate'
    );
  });
});
