/**
 * Visual_Parity_Snapshot for `_getNoRepositoryHtml(webview)`.
 *
 * (git-view-layout-parity) —.
 *
 * pins the emitted No_Repository_State markup, including the
 * no-repository message text (`No Git repository found in this workspace.`)
 * and the `Initialize Repository` control. requires the
 * no-repository state to convey its status as visible TEXT rather than through
 * the loading spinner, so this file also asserts the absence of the
 * loading-view body markup that `_getLoadingHtml` emits.
 *
 * Inline-frozen-literal pattern (per ADR-010 Layer 1, mirroring
 * `commitGraphSnapshots.test.ts`): the expected HTML is an inline literal —
 * no `--update-snapshots` opacity — so a legitimate copy/markup change surfaces
 * as a deliberate review diff. Two deterministic normalizations are applied
 * before freezing:
 *   1. The 22-char base64url CSP nonce (random per call) → `__NONCE__`.
 *   2. The shared `_getInlineStyles()` `<style>` block (not specific to this
 *      view, and itself huge) → `__INLINE_STYLES__`.
 * What remains is the no-repository document structure: the CSP scaffold, the
 * message paragraph, the Initialize Repository button, and the init-repo
 * bootstrap script.
 *
 * The absence assertions deliberately target the loading-view BODY markers
 * (`loading-container`, `loading-spinner-icon`, `Loading git graph`) rather
 * than the bare `loading-spinner` substring: the shared inline styles carry a
 * `.loading-spinner` CSS rule (used by the graph's "load more" indicator), so
 * the bare token legitimately appears in every webview's CSS and is NOT a valid
 * discriminator for the no-repository view.
 */

import '../../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../../ui-shell/GitToolWindowProvider';
import { Uri, type Webview } from '../../mocks/vscode';

/**
 * Narrow test-surface for the two private HTML emitters under test. Kept
 * deliberately minimal (docs/testing.md §3) — only the methods this snapshot
 * drives, no kitchen-sink internals.
 */
interface HtmlEmitterSurface {
  _getNoRepositoryHtml(webview: Webview): string;
  _getLoadingHtml(webview: Webview): string;
}

/**
 * Create a mock Webview for the HTML emitters (mirrors
 * `threePanelLayout.test.ts`). Only `cspSource` / `asWebviewUri` are consulted
 * by the emitters; the fixed `cspSource` keeps the frozen literal deterministic.
 */
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
 * Replace the per-call random nonce and the shared inline-styles block with
 * stable placeholders so the document structure can be frozen as a literal.
 */
function normalize(html: string): string {
  return html
    .replace(/nonce="[A-Za-z0-9_-]{22}"/g, 'nonce="__NONCE__"')
    .replace(/'nonce-[A-Za-z0-9_-]{22}'/g, "'nonce-__NONCE__'")
    .replace(/<style>[\s\S]*?<\/style>/, '<style>__INLINE_STYLES__</style>');
}

describe('git-view-layout-parity / snap-norepo — _getNoRepositoryHtml Visual_Parity_Snapshot', () => {
  let provider: GitToolWindowProvider;
  const extensionUri = Uri.file('/test/extension');

  beforeEach(() => {
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  it('snap-norepo-1: freezes the no-repository document (message + Initialize Repository button)', () => {
    const webview = createMockWebview();
    const html = (provider as unknown as HtmlEmitterSurface)._getNoRepositoryHtml(webview);

    const expected = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src https://mock.csp.source 'unsafe-inline'; script-src 'nonce-__NONCE__';">
  <title>Git Tool Window</title>
  <style>__INLINE_STYLES__</style>
</head>
<body>
  <div class="no-repository">
    <p>No Git repository found in this workspace.</p>
    <button class="init-repo-button" id="init-repo-btn">Initialize Repository</button>
  </div>
  <script nonce="__NONCE__">
    (function() {
      const vscode = acquireVsCodeApi();
      const btn = document.getElementById('init-repo-btn');
      if (btn) {
        btn.addEventListener('click', function() {
          vscode.postMessage({ type: 'initRepository' });
        });
      }
    })();
  </script>
</body>
</html>`;

    assert.strictEqual(normalize(html), expected);
  });

  it('snap-norepo-2: pins the no-repository message text and Initialize Repository control verbatim (Req 3.6)', () => {
    const webview = createMockWebview();
    const html = (provider as unknown as HtmlEmitterSurface)._getNoRepositoryHtml(webview);

    // The exact No_Repository_State contract wording (glossary + Req 3.6).
    assert.ok(
      html.includes('<p>No Git repository found in this workspace.</p>'),
      'no-repository message text must be pinned verbatim'
    );
    // The Initialize Repository control, with the id the bootstrap script wires.
    assert.ok(
      html.includes(
        '<button class="init-repo-button" id="init-repo-btn">Initialize Repository</button>'
      ),
      'Initialize Repository button must be pinned verbatim'
    );
  });

  it('snap-norepo-3: no-repository state shows TEXT, not the loading spinner (Req 3.5)', () => {
    const webview = createMockWebview();
    const html = (provider as unknown as HtmlEmitterSurface)._getNoRepositoryHtml(webview);

    // The loading-view BODY markers are emitted ONLY by _getLoadingHtml. Their
    // absence here proves the no-repository view is not the spinner view.
    assert.ok(
      !html.includes('loading-container'),
      'no-repository HTML must NOT contain the loading-view container'
    );
    assert.ok(
      !html.includes('loading-spinner-icon'),
      'no-repository HTML must NOT contain the spinning loading icon'
    );
    assert.ok(
      !html.includes('Loading git graph'),
      'no-repository HTML must NOT contain the loading text'
    );
  });

  it('snap-norepo-4: the asserted loading markers ARE the loading view (discriminator sanity)', () => {
    // Guard the absence assertions above: prove the markers genuinely identify
    // the loading view, so snap-norepo-3 is meaningful rather than vacuous.
    const webview = createMockWebview();
    const loadingHtml = (provider as unknown as HtmlEmitterSurface)._getLoadingHtml(webview);

    assert.ok(loadingHtml.includes('loading-container'), 'loading view emits its container');
    assert.ok(loadingHtml.includes('loading-spinner-icon'), 'loading view emits the spinner icon');
    assert.ok(loadingHtml.includes('Loading git graph'), 'loading view emits the loading text');
  });
});
