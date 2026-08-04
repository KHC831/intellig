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
import * as fs from 'fs';
import * as path from 'path';

/** Source of the filter-list builders module (logFilterOptionsReady lives here). */
const ENTRY_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../../src/git-core/gitToolWindow/webview/logFilterLists.ts'),
  'utf8'
);

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

describe('git tool-window entry - Branch popup items built via createElement (DOM migration)', () => {
  let block: string;

  beforeEach(() => {
    const b = extractBlockAfter(ENTRY_SOURCE, /message\.type === 'logFilterOptionsReady'/);
    assert.ok(b, 'rendered client entry must contain a logFilterOptionsReady handler');
    block = b;
  });

  it('builds Branch popup items via document.createElement', () => {
    // The branch popup is a checkbox tree (master + leaves), so the DOM-migration
    // contract is satisfied by createElement('input')/'label', not 'button'.
    assert.ok(
      /createElement\(\s*['"]input['"]\s*\)/.test(block) &&
        /createElement\(\s*['"]label['"]\s*\)/.test(block),
      "logFilterOptionsReady must build items via document.createElement('input'/'label')"
    );
  });

  it('does not assign innerHTML when populating the Branch popup', () => {
    assert.ok(
      !/\.innerHTML\s*=/.test(block),
      'logFilterOptionsReady must not populate the Branch popup via innerHTML — use DOM nodes + .textContent'
    );
  });
});
