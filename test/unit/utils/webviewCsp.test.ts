/**
 * The shared webview CSP builder is the single home for the `default-src`
 * policy (enforced by check:webview-csp). The full policy carries img/font-src
 * for the graph document's icons + codicon font; the minimal policy narrows
 * those away for static pre-graph documents and plain dialog frames.
 */

import '../../setup';
import * as assert from 'assert';
import { buildWebviewCsp } from '../../../src/utils/webviewCsp';

const SRC = 'vscode-webview://host';
const NONCE = 'abc123';

describe('buildWebviewCsp', () => {
  it('emits the full policy (img + font) by default', () => {
    assert.strictEqual(
      buildWebviewCsp(SRC, NONCE),
      `default-src 'none'; style-src ${SRC} 'unsafe-inline'; script-src 'nonce-${NONCE}'; img-src ${SRC} data:; font-src ${SRC};`
    );
  });

  it('narrows to the minimal policy when images and fonts are opted out', () => {
    assert.strictEqual(
      buildWebviewCsp(SRC, NONCE, { images: false, fonts: false }),
      `default-src 'none'; style-src ${SRC} 'unsafe-inline'; script-src 'nonce-${NONCE}';`
    );
  });

  it('minimal policy omits img-src and font-src entirely', () => {
    const csp = buildWebviewCsp(SRC, NONCE, { images: false, fonts: false });
    assert.ok(!csp.includes('img-src'), 'no img-src in the minimal policy');
    assert.ok(!csp.includes('font-src'), 'no font-src in the minimal policy');
  });

  it('honors each flag independently', () => {
    assert.strictEqual(
      buildWebviewCsp(SRC, NONCE, { images: true, fonts: false }),
      `default-src 'none'; style-src ${SRC} 'unsafe-inline'; script-src 'nonce-${NONCE}'; img-src ${SRC} data:;`
    );
    assert.strictEqual(
      buildWebviewCsp(SRC, NONCE, { images: false, fonts: true }),
      `default-src 'none'; style-src ${SRC} 'unsafe-inline'; script-src 'nonce-${NONCE}'; font-src ${SRC};`
    );
  });
});
