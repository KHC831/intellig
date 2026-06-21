/**
 * Structural guard for the inline `logFilterOptionsReady` handler that populates
 * the branch + author filter datalists.
 *
 * As part of the string→DOM webview migration, the handler must build the
 * `<option>` nodes via `document.createElement('option')` + the injection-proof
 * `.value` property, NOT by assigning an interpolated HTML string to
 * `datalist.innerHTML`. Building via the DOM removes the hand-rolled `escapeAttr`
 * helper (the property setter cannot be HTML-interpreted) and matches every other
 * migrated webview.
 *
 * The guard pins that contract: the datalist branch must use `createElement`
 * and must not assign `.innerHTML`.
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

describe('GitToolWindowProvider - filter datalists built via createElement (DOM migration)', () => {
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

  it('builds <option> nodes via document.createElement', () => {
    assert.ok(
      /createElement\(\s*['"]option['"]\s*\)/.test(block),
      "logFilterOptionsReady must build options via document.createElement('option')"
    );
  });

  it('does not assign innerHTML to the datalists', () => {
    assert.ok(
      !/\.innerHTML\s*=/.test(block),
      'logFilterOptionsReady must not populate the datalists via innerHTML — use DOM nodes + .value'
    );
  });
});
