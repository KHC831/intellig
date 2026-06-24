/**
 * Behavioral test for the inline `highlightCommonCommits` handler: it toggles the
 * `commit-row-common` class on rows whose `data-hash` the host sent, clearing any
 * previous highlight first (empty payload = clear). Rows cross as data; hashes
 * are matched by attribute, never interpreted as markup.
 */

import '../setup';
import * as assert from 'assert';
import { JSDOM } from 'jsdom';
import { buildInlineScript } from '../../src/git-core/gitToolWindow/provider/scriptBuilder';

function extractBlockAfter(body: string, headerPattern: RegExp): string {
  const match = headerPattern.exec(body);
  assert.ok(match, 'header not found in inline script');
  const open = body.indexOf('{', match.index);
  let depth = 0;
  for (let i = open; i < body.length; i++) {
    if (body[i] === '{') {
      depth++;
    } else if (body[i] === '}') {
      depth--;
      if (depth === 0) {
        return body.substring(open, i + 1);
      }
    }
  }
  throw new Error('unbalanced braces');
}

function runHighlight(dom: JSDOM, hashes: unknown): void {
  const block = extractBlockAfter(
    buildInlineScript(),
    /message\.type === 'highlightCommonCommits'/
  );
  const { window } = dom;
  (window as unknown as { message: unknown }).message = { type: 'highlightCommonCommits', hashes };
  (window as unknown as { eval: (s: string) => void }).eval(
    'var message = window.message; ' + block
  );
}

function rowsDom(hashes: string[]): JSDOM {
  const rows = hashes.map((h) => `<div class="commit-row" data-hash="${h}"></div>`).join('');
  return new JSDOM(`<!DOCTYPE html><html><body>${rows}</body></html>`, {
    runScripts: 'outside-only',
  });
}

function commonHashes(dom: JSDOM): string[] {
  return Array.from(dom.window.document.querySelectorAll('.commit-row.commit-row-common')).map(
    (r) => r.getAttribute('data-hash') ?? ''
  );
}

describe('Branch common-commit highlight — client toggle', () => {
  it('adds the common class only to the rows whose hashes were sent', () => {
    const dom = rowsDom(['c1', 'c2', 'c3']);
    runHighlight(dom, ['c2', 'c3']);
    assert.deepStrictEqual(commonHashes(dom), ['c2', 'c3']);
  });

  it('clears a previous highlight before applying the new set', () => {
    const dom = rowsDom(['c1', 'c2', 'c3']);
    runHighlight(dom, ['c1']);
    runHighlight(dom, ['c3']);
    assert.deepStrictEqual(commonHashes(dom), ['c3'], 'c1 no longer highlighted');
  });

  it('an empty payload clears all highlights', () => {
    const dom = rowsDom(['c1', 'c2']);
    runHighlight(dom, ['c1', 'c2']);
    runHighlight(dom, []);
    assert.deepStrictEqual(commonHashes(dom), []);
  });

  it('ignores a hash with no matching row (no throw)', () => {
    const dom = rowsDom(['c1']);
    runHighlight(dom, ['nope', 'c1']);
    assert.deepStrictEqual(commonHashes(dom), ['c1']);
  });
});
