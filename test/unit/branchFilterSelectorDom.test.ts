/**
 * Behavioral test for the inline `logFilterOptionsReady` handler populating the
 * Branch popup as a NESTED checkbox tree (multi-select). The handler must build
 * everything via createElement (injection-proof — textContent/data-branch cross
 * as data), render an "All branches" reset + IntelliJ's grouped layout (Local +
 * per-remote), nest branch names by "/" into folders, put a data-branch checkbox
 * on each leaf, and pre-check the leaves the filter already holds.
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
  function makeDom(selected: string[]): JSDOM {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body>
        <div class="log-filter-popup-list" id="filter-branch-list"></div>
      </body></html>`,
      { runScripts: 'outside-only' }
    );
    (dom.window as unknown as { __intelligFilter: unknown }).__intelligFilter = {
      isBranchChecked: (name: string) => selected.indexOf(name) !== -1,
      anyBranchSelected: () => selected.length > 0,
      getAuthor: () => '',
    };
    return dom;
  }

  const groups = {
    local: ['dev', 'feature/foo', 'feature/bar'],
    remotes: [{ remote: 'origin', branches: ['origin/main'] }],
  };

  /** data-branch values of the leaf checkboxes, in document order. */
  function leafRefs(list: Element): string[] {
    return Array.from(list.querySelectorAll('input[data-branch]')).map(
      (cb) => cb.getAttribute('data-branch') || ''
    );
  }

  it('renders All-branches + Local/remote sections and a checkbox per branch leaf', () => {
    const dom = makeDom([]);
    runOptionsReady(dom, { type: 'logFilterOptionsReady', branchGroups: groups });
    const list = dom.window.document.getElementById('filter-branch-list')!;
    const sections = Array.from(list.querySelectorAll('.log-filter-popup-section')).map(
      (s) => s.textContent
    );
    assert.deepStrictEqual(sections, ['Local', 'origin']);
    // Every branch is a leaf checkbox carrying its full ref.
    assert.deepStrictEqual(leafRefs(list), ['dev', 'feature/bar', 'feature/foo', 'origin/main']);
    assert.ok(list.querySelector('[data-branch="__all__"]'), 'All-branches reset present');
  });

  it('nests names by "/" into folders (feature/ holds foo + bar)', () => {
    const dom = makeDom([]);
    runOptionsReady(dom, { type: 'logFilterOptionsReady', branchGroups: groups });
    const list = dom.window.document.getElementById('filter-branch-list')!;
    const folders = Array.from(list.querySelectorAll('.log-filter-tree-folder')).map(
      (f) => f.textContent
    );
    assert.deepStrictEqual(folders, ['feature']);
    // The folder row's checkbox is a folder toggle (no data-branch); the leaves
    // under it are bar + foo.
    const folderRow = list
      .querySelector('.log-filter-tree-folder')!
      .closest('.log-filter-tree-node')!;
    assert.deepStrictEqual(leafRefs(folderRow), ['feature/bar', 'feature/foo']);
    assert.strictEqual(
      folderRow.querySelector('input[data-action="toggleBranchFolder"]') !== null,
      true
    );
  });

  it('keeps the full remote ref in data-branch while showing the short name', () => {
    const dom = makeDom([]);
    runOptionsReady(dom, { type: 'logFilterOptionsReady', branchGroups: groups });
    const list = dom.window.document.getElementById('filter-branch-list')!;
    const leaf = Array.from(list.querySelectorAll('input[data-branch]')).find(
      (cb) => cb.getAttribute('data-branch') === 'origin/main'
    )!;
    const text = leaf.closest('.log-filter-tree-row')!.querySelector('span')!.textContent;
    assert.strictEqual(text, 'main', 'remote prefix stripped from the display');
  });

  it('pre-checks the leaves the filter already holds', () => {
    const dom = makeDom(['feature/foo', 'origin/main']);
    runOptionsReady(dom, { type: 'logFilterOptionsReady', branchGroups: groups });
    const list = dom.window.document.getElementById('filter-branch-list')!;
    const checkedRefs = Array.from(list.querySelectorAll('input[data-branch]'))
      .filter((cb) => (cb as HTMLInputElement).checked)
      .map((cb) => cb.getAttribute('data-branch'));
    assert.deepStrictEqual(checkedRefs.sort(), ['feature/foo', 'origin/main']);
  });

  it('marks "All branches" active only when nothing is selected', () => {
    const empty = makeDom([]);
    runOptionsReady(empty, { type: 'logFilterOptionsReady', branchGroups: groups });
    assert.ok(
      empty.window.document.querySelector('.log-filter-popup-item.active[data-branch="__all__"]')
    );
    const some = makeDom(['dev']);
    runOptionsReady(some, { type: 'logFilterOptionsReady', branchGroups: groups });
    assert.strictEqual(
      some.window.document.querySelector('.log-filter-popup-item.active'),
      null,
      'a selection deactivates All branches'
    );
  });

  it('builds rows as inert text (no markup injection)', () => {
    const dom = makeDom([]);
    runOptionsReady(dom, {
      type: 'logFilterOptionsReady',
      branchGroups: { local: ['<img src=x onerror=alert(1)>'], remotes: [] },
    });
    const doc = dom.window.document;
    assert.strictEqual(doc.querySelector('img'), null, 'no element injected');
    const list = doc.getElementById('filter-branch-list')!;
    const leaf = Array.from(list.querySelectorAll('input[data-branch]')).find(
      (cb) => cb.getAttribute('data-branch') === '<img src=x onerror=alert(1)>'
    )!;
    assert.strictEqual(
      leaf.closest('.log-filter-tree-row')!.querySelector('span')!.textContent,
      '<img src=x onerror=alert(1)>'
    );
  });
});
