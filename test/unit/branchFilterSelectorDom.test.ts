/**
 * Behavioral test for the inline `logFilterOptionsReady` handler populating the
 * Branch popup. The handler must build the item buttons via createElement
 * (injection-proof — textContent/data-branch cross as data), render IntelliJ's
 * grouped layout (Local + per-remote), and mark the active branch.
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

describe('Branch popup — client population on logFilterOptionsReady', () => {
  function makeDom(selectedBranch: string): JSDOM {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body>
        <div class="log-filter-popup-list" id="filter-branch-list">
          <button class="log-filter-popup-item" data-branch="__all__">All branches</button>
        </div>
      </body></html>`,
      { runScripts: 'outside-only' }
    );
    (dom.window as unknown as { __intelligFilter: unknown }).__intelligFilter = {
      getBranch: () => selectedBranch,
      getAuthor: () => '',
    };
    return dom;
  }

  const groups = {
    local: ['dev', 'main'],
    remotes: [{ remote: 'origin', branches: ['origin/feature', 'origin/main'] }],
  };

  it('fills the list with All branches + Local + per-remote groups', () => {
    const dom = makeDom('');
    runOptionsReady(dom, { type: 'logFilterOptionsReady', branchGroups: groups });
    const list = dom.window.document.getElementById('filter-branch-list')!;
    const items = Array.from(list.querySelectorAll('.log-filter-popup-item')).map(
      (b) => b.textContent
    );
    assert.deepStrictEqual(items, ['All branches', 'dev', 'main', 'feature', 'main']);
    const sections = Array.from(list.querySelectorAll('.log-filter-popup-section')).map(
      (s) => s.textContent
    );
    assert.deepStrictEqual(sections, ['Local', 'origin']);
  });

  it('keeps the full remote ref in data-branch while showing the short name', () => {
    const dom = makeDom('');
    runOptionsReady(dom, { type: 'logFilterOptionsReady', branchGroups: groups });
    const list = dom.window.document.getElementById('filter-branch-list')!;
    const feature = Array.from(list.querySelectorAll('.log-filter-popup-item')).find(
      (b) => b.textContent === 'feature'
    )!;
    assert.strictEqual(feature.getAttribute('data-branch'), 'origin/feature');
  });

  it('marks the active branch item', () => {
    const dom = makeDom('main');
    runOptionsReady(dom, { type: 'logFilterOptionsReady', branchGroups: groups });
    const list = dom.window.document.getElementById('filter-branch-list')!;
    const active = list.querySelector('.log-filter-popup-item.active')!;
    assert.strictEqual(active.getAttribute('data-branch'), 'main');
  });

  it('marks "All branches" active when no branch is set', () => {
    const dom = makeDom('');
    runOptionsReady(dom, { type: 'logFilterOptionsReady', branchGroups: groups });
    const list = dom.window.document.getElementById('filter-branch-list')!;
    const active = list.querySelector('.log-filter-popup-item.active')!;
    assert.strictEqual(active.getAttribute('data-branch'), '__all__');
  });

  it('builds items as inert text (no markup injection)', () => {
    const dom = makeDom('');
    runOptionsReady(dom, {
      type: 'logFilterOptionsReady',
      branchGroups: { local: ['<img src=x onerror=alert(1)>'], remotes: [] },
    });
    const doc = dom.window.document;
    assert.strictEqual(doc.querySelector('img'), null, 'no element injected');
    const list = doc.getElementById('filter-branch-list')!;
    const item = Array.from(list.querySelectorAll('.log-filter-popup-item')).find(
      (b) => b.getAttribute('data-branch') === '<img src=x onerror=alert(1)>'
    )!;
    assert.strictEqual(item.textContent, '<img src=x onerror=alert(1)>');
  });
});
