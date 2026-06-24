/**
 * Behavioral test for the inline `logFilterOptionsReady` handler populating the
 * branch-filter dropdown. The handler must build the <option> nodes via
 * createElement (injection-proof — value/textContent cross as data) and
 * preserve the currently-selected branch carried in `data-selected-branch`.
 */

import '../setup';
import * as assert from 'assert';
import { JSDOM } from 'jsdom';
import { buildInlineScript } from '../../src/git-core/gitToolWindow/provider/scriptBuilder';

/** Brace-match the `{ … }` body that follows a header regex match. */
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

/** Run the logFilterOptionsReady block in jsdom against a seeded document. */
function runOptionsReady(dom: JSDOM, message: unknown): void {
  const block = extractBlockAfter(buildInlineScript(), /message\.type === 'logFilterOptionsReady'/);
  const { window } = dom;
  (window as unknown as { message: unknown }).message = message;
  (window as unknown as { eval: (s: string) => void }).eval(
    'var message = window.message; ' + block
  );
}

describe('Branch filter selector — client population on logFilterOptionsReady', () => {
  function makeDom(selectedBranch: string): JSDOM {
    return new JSDOM(
      `<!DOCTYPE html><html><body>
        <select class="branch-filter-selector" data-selected-branch="${selectedBranch}"></select>
      </body></html>`,
      { runScripts: 'outside-only' }
    );
  }

  it('fills the dropdown with "All branches" plus every branch name', () => {
    const dom = makeDom('');
    runOptionsReady(dom, {
      type: 'logFilterOptionsReady',
      branches: ['main', 'dev', 'feature/x'],
      contributors: [],
    });
    const sel = dom.window.document.querySelector('.branch-filter-selector') as HTMLSelectElement;
    const labels = Array.from(sel.options).map((o) => o.textContent);
    assert.deepStrictEqual(labels, ['All branches', 'main', 'dev', 'feature/x']);
    assert.strictEqual(sel.options[0].value, '__all__');
    assert.strictEqual(sel.value, '__all__', 'no active branch → sentinel selected');
  });

  it('preserves the active branch selection after repopulation', () => {
    const dom = makeDom('feature/x');
    runOptionsReady(dom, {
      type: 'logFilterOptionsReady',
      branches: ['main', 'dev', 'feature/x'],
      contributors: [],
    });
    const sel = dom.window.document.querySelector('.branch-filter-selector') as HTMLSelectElement;
    assert.strictEqual(sel.value, 'feature/x', 'active branch stays selected');
  });

  it('keeps an active branch even when it is absent from the fetched list', () => {
    const dom = makeDom('detached-feature');
    runOptionsReady(dom, {
      type: 'logFilterOptionsReady',
      branches: ['main', 'dev'],
      contributors: [],
    });
    const sel = dom.window.document.querySelector('.branch-filter-selector') as HTMLSelectElement;
    const labels = Array.from(sel.options).map((o) => o.textContent);
    assert.ok(labels.includes('detached-feature'), 'active branch appended so selection holds');
    assert.strictEqual(sel.value, 'detached-feature');
  });

  it('builds options as inert text (no markup injection)', () => {
    const dom = makeDom('');
    runOptionsReady(dom, {
      type: 'logFilterOptionsReady',
      branches: ['<img src=x onerror=alert(1)>'],
      contributors: [],
    });
    const doc = dom.window.document;
    assert.strictEqual(doc.querySelector('img'), null, 'no element injected');
    const sel = doc.querySelector('.branch-filter-selector') as HTMLSelectElement;
    assert.strictEqual(sel.options[1].textContent, '<img src=x onerror=alert(1)>');
  });
});
