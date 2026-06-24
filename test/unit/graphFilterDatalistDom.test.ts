/**
 * Structural guard for the inline `logFilterOptionsReady` handler that populates
 * the Branch filter popup.
 *
 * The handler must build the item nodes via `document.createElement('button')` +
 * the injection-proof `.textContent`/`data-*` properties, NOT by assigning an
 * interpolated HTML string to `.innerHTML`. (The filters use custom popups, not
 * native `<select>`/`<datalist>` — Chromium renders those popups in an
 * unstyleable UA layer.)
 *
 * The guard pins that contract: the Branch-popup population must use
 * `createElement` and must not assign `.innerHTML`.
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

describe('GitToolWindowProvider - Branch popup items built via createElement (DOM migration)', () => {
  let provider: GitToolWindowProvider;
  let block: string;

  beforeEach(() => {
    const extensionUri = Uri.file('/test/extension');
    provider = new GitToolWindowProvider(extensionUri);
    const html = provider._getThreePanelHtmlContent(
      createMockWebview() as unknown as import('vscode').Webview,
      []
    );
    const b = extractBlockAfter(html, /message\.type === 'logFilterOptionsReady'/);
    assert.ok(b, 'rendered inline script must contain a logFilterOptionsReady handler');
    block = b;
  });

  afterEach(() => {
    provider.dispose();
  });

  it('builds Branch popup items via document.createElement', () => {
    assert.ok(
      /createElement\(\s*['"]button['"]\s*\)/.test(block),
      "logFilterOptionsReady must build items via document.createElement('button')"
    );
  });

  it('does not assign innerHTML when populating the Branch popup', () => {
    assert.ok(
      !/\.innerHTML\s*=/.test(block),
      'logFilterOptionsReady must not populate the Branch popup via innerHTML — use DOM nodes + .textContent'
    );
  });
});
