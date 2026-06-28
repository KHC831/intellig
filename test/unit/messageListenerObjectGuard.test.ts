/**
 * Structural guard test: all `window.addEventListener('message', ...)` handlers
 * in the inline webview script must check that `event.data` is a non-null object
 * before accessing its properties.
 *
 * Without the guard, a non-object `event.data` (e.g. a string, number, or null
 * posted by a third-party iframe) causes a TypeError on `message.type`, which
 * surfaces as an unhandled error in the webview console and may corrupt handler
 * state. The guard degrades gracefully by returning early.
 *
 * The required form is:
 *   const message = event.data;
 *   if (!message || typeof message !== 'object') { return; }
 *
 * This mirrors the Phase-1 object-check fix applied to other handlers in this
 * codebase (see waveDR1.test.ts, branchContextMenuErrors.test.ts).
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
function extractBlockAfter(body: string, headerPattern: RegExp, startFrom = 0): string | null {
  const match = headerPattern.exec(body.slice(startFrom));
  if (!match) {
    return null;
  }
  const baseIdx = startFrom + match.index;
  const openBraceIdx = body.indexOf('{', baseIdx);
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

/** The guard pattern that must appear at the top of every message handler callback. */
const OBJECT_GUARD =
  /if\s*\(\s*!message\s*\|\|\s*typeof\s+message\s*!==\s*['"]object['"]\s*\)\s*\{\s*return\s*;?\s*\}/;

describe('scriptBuilder inline webview - message listener object-check guards', () => {
  let html: string;

  before(() => {
    const provider = new GitToolWindowProvider(Uri.file('/test/extension'));
    const mockWebview = createMockWebview();
    html = provider._getThreePanelHtmlContent(
      mockWebview as unknown as import('vscode').Webview,
      []
    );
    provider.dispose();
  });

  it('main message listener (scrollToCommit / selectGraphRow handler) has object guard', () => {
    // Extract the callback of the first window.addEventListener('message', ...)
    const block = extractBlockAfter(html, /window\.addEventListener\s*\(\s*['"]message['"]/);
    assert.ok(block, 'rendered HTML must contain window.addEventListener("message", ...) callback');
    assert.ok(
      OBJECT_GUARD.test(block),
      'main message listener must guard: if (!message || typeof message !== "object") { return; }'
    );
  });

  it('commitsLoaded message listener has object guard', () => {
    // Find the SECOND window.addEventListener('message', ...) — for commitsLoaded.
    const firstIdx = html.indexOf("window.addEventListener('message'");
    assert.notStrictEqual(firstIdx, -1, 'must contain at least one message listener');
    const secondListenerIdx = html.indexOf("window.addEventListener('message'", firstIdx + 1);
    assert.notStrictEqual(secondListenerIdx, -1, 'must contain a second message listener');

    const block = extractBlockAfter(
      html,
      /window\.addEventListener\s*\(\s*['"]message['"]/,
      secondListenerIdx
    );
    assert.ok(block, 'second message listener callback must be extractable');
    assert.ok(
      OBJECT_GUARD.test(block),
      'commitsLoaded message listener must guard: if (!message || typeof message !== "object") { return; }'
    );
  });
});
