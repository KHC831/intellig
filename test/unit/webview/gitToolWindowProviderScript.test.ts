/**
 * Webview client-script test for the full Git tool-window document assembled by
 * GitToolWindowProvider.
 *
 * `_getThreePanelHtmlContent` composes the graph/details panels, the codicon
 * font CSS, the three-panel styles, and the concatenated inline scripts
 * (initial-details island + buildInlineScript + divider-drag + column-resize).
 * Running that whole composite under jsdom catches a renderer regression in the
 * assembled document — wiring that the isolated buildInlineScript test cannot
 * see — which no extension-host / e2e lane exercises.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { GitToolWindowProvider } from '../../../src/git-core/gitToolWindow/GitToolWindowProvider';
import type { ICommitNode } from '../../../src/git-core/commitGraph';
import { Uri } from '../../mocks/vscode';
import { runWebviewScript, IWebviewHarness } from '../../helpers/webviewHarness';
import { extractWebviewScript } from '../../helpers/webviewHtml';

const GARBAGE_MESSAGES: unknown[] = [
  { type: 'totally-unknown-message' },
  { type: undefined },
  { foo: 'bar' },
  {},
];

function mockWebview(): vscode.Webview {
  return {
    cspSource: 'vscode-webview://mock',
    asWebviewUri: (uri: Uri): Uri => uri,
  } as unknown as vscode.Webview;
}

function fullHtml(): string {
  const provider = new GitToolWindowProvider(Uri.file('/test/extension'));
  // `_getThreePanelHtmlContent` is the public (testability) entry point that
  // produces the complete `<!DOCTYPE html>` document. Empty commitNodes render
  // the loaded-but-empty graph — enough to exercise the inline script wiring.
  return provider._getThreePanelHtmlContent(mockWebview(), [] as ICommitNode[]);
}

describe('webview: Git tool-window full document (jsdom)', () => {
  let h: IWebviewHarness;

  afterEach(() => {
    if (h) {
      h.dispose();
    }
  });

  it('loads the composed inline scripts without throwing and builds the panels', () => {
    const { script, bodyHtml } = extractWebviewScript(fullHtml());
    h = runWebviewScript(script, { bodyHtml });
    assert.deepStrictEqual(
      h.errors.map((e) => e.message),
      []
    );
    assert.ok(h.document.getElementById('graph-panel'), 'graph panel present');
    assert.ok(h.document.getElementById('details-panel'), 'details panel present');
  });

  it('tolerates representative and garbage extension→webview messages', () => {
    const { script, bodyHtml } = extractWebviewScript(fullHtml());
    h = runWebviewScript(script, { bodyHtml });
    h.post({ type: 'update', commits: [], branches: [], tags: [] });
    h.post({ type: 'selectGraphRow', commitHash: 'abc' });
    h.post({ type: 'scrollToCommit', commitHash: 'abc' });
    for (const msg of GARBAGE_MESSAGES) {
      h.post(msg);
    }
    assert.deepStrictEqual(
      h.errors.map((e) => e.message),
      []
    );
  });
});
