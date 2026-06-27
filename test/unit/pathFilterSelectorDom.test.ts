/**
 * Behavioral test for the inline `pathOptionsReady` handler populating the Path
 * popup as a NESTED checkbox tree of the repo's tracked files. Every node —
 * folder OR file — must carry a data-path checkbox (git log -- <dir> covers the
 * subtree), pre-check the paths the filter holds, and be built via createElement
 * (injection-proof).
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

function runPathOptions(dom: JSDOM, message: unknown): void {
  const block = extractBlockAfter(buildInlineScript(), /message\.type === 'pathOptionsReady'/);
  const { window } = dom;
  (window as unknown as { message: unknown }).message = message;
  (window as unknown as { eval: (s: string) => void }).eval(
    'var message = window.message; ' + block
  );
}

describe('Path popup — client population on pathOptionsReady', () => {
  function makeDom(selected: string[]): JSDOM {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body>
        <div class="log-filter-popup-list" id="filter-path-list"></div>
      </body></html>`,
      { runScripts: 'outside-only' }
    );
    (dom.window as unknown as { __intelligFilter: unknown }).__intelligFilter = {
      isPathChecked: (p: string) => selected.indexOf(p) !== -1,
      anyPathSelected: () => selected.length > 0,
    };
    return dom;
  }

  const paths = ['src/a.ts', 'src/b.ts', 'README.md'];

  function dataPaths(scope: Element): string[] {
    return Array.from(scope.querySelectorAll('input[data-path]')).map(
      (cb) => cb.getAttribute('data-path') || ''
    );
  }

  it('builds a node (folder + file) per path segment, each with its full path', () => {
    const dom = makeDom([]);
    runPathOptions(dom, { type: 'pathOptionsReady', paths });
    const list = dom.window.document.getElementById('filter-path-list')!;
    // Sorted: README.md, then src/ (folder) with a.ts, b.ts.
    assert.deepStrictEqual(dataPaths(list), ['README.md', 'src', 'src/a.ts', 'src/b.ts']);
    assert.ok(list.querySelector('[data-path="__all__"]'), 'All-paths reset present');
  });

  it('marks directories as folders and selecting one filters by the directory path', () => {
    const dom = makeDom([]);
    runPathOptions(dom, { type: 'pathOptionsReady', paths });
    const list = dom.window.document.getElementById('filter-path-list')!;
    const folders = Array.from(list.querySelectorAll('.log-filter-tree-folder')).map(
      (f) => f.textContent
    );
    assert.deepStrictEqual(folders, ['src']);
    const srcCb = Array.from(list.querySelectorAll('input[data-path]')).find(
      (cb) => cb.getAttribute('data-path') === 'src'
    )!;
    assert.strictEqual(srcCb.getAttribute('data-action'), 'togglePathCheckbox');
  });

  it('pre-checks the paths the filter already holds', () => {
    const dom = makeDom(['src/a.ts']);
    runPathOptions(dom, { type: 'pathOptionsReady', paths });
    const list = dom.window.document.getElementById('filter-path-list')!;
    const checkedPaths = Array.from(list.querySelectorAll('input[data-path]'))
      .filter((cb) => (cb as HTMLInputElement).checked)
      .map((cb) => cb.getAttribute('data-path'));
    assert.deepStrictEqual(checkedPaths, ['src/a.ts']);
  });

  it('builds rows as inert text (no markup injection)', () => {
    const dom = makeDom([]);
    runPathOptions(dom, {
      type: 'pathOptionsReady',
      paths: ['<img src=x onerror=alert(1)>.ts'],
    });
    const doc = dom.window.document;
    assert.strictEqual(doc.querySelector('img'), null, 'no element injected');
  });
});
