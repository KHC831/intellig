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
  // Build a DOM whose __intelligFilter bridge emulates the real tri-state:
  // 'all' (every leaf checked), 'none' (none), or 'subset' (the given refs).
  function makeDom(mode: 'all' | 'none' | 'subset', checked: string[] = []): JSDOM {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body>
        <div class="log-filter-popup-list" id="filter-branch-list"></div>
      </body></html>`,
      { runScripts: 'outside-only' }
    );
    (dom.window as unknown as { __intelligFilter: unknown }).__intelligFilter = {
      isBranchChecked: (name: string) =>
        mode === 'all' ? true : mode === 'none' ? false : checked.indexOf(name) !== -1,
      branchState: () => mode,
      // Mirror the real syncBranchFolderChecks: reconcile folder + master from leaves.
      syncBranchTree: () => {
        const list = dom.window.document.getElementById('filter-branch-list');
        if (!list) {
          return;
        }
        list.querySelectorAll('input[data-action="toggleBranchFolder"]').forEach((folder) => {
          const wrap = folder.closest('.log-filter-tree-node');
          const leaves = wrap ? Array.from(wrap.querySelectorAll('input[data-branch]')) : [];
          const on = leaves.filter((l) => (l as HTMLInputElement).checked).length;
          (folder as HTMLInputElement).checked = leaves.length > 0 && on === leaves.length;
          (folder as HTMLInputElement).indeterminate = on > 0 && on < leaves.length;
        });
        const master = list.querySelector('input[data-action="toggleAllBranches"]');
        if (master) {
          (master as HTMLInputElement).checked = mode === 'all';
          (master as HTMLInputElement).indeterminate = mode === 'subset';
        }
      },
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

  it('renders a master All-branches checkbox + Local/remote sections + a checkbox per leaf', () => {
    const dom = makeDom('all');
    runOptionsReady(dom, { type: 'logFilterOptionsReady', branchGroups: groups });
    const list = dom.window.document.getElementById('filter-branch-list')!;
    const sections = Array.from(list.querySelectorAll('.log-filter-popup-section')).map(
      (s) => s.textContent
    );
    assert.deepStrictEqual(sections, ['Local', 'origin']);
    // Every branch is a leaf checkbox carrying its full ref.
    assert.deepStrictEqual(leafRefs(list), ['dev', 'feature/bar', 'feature/foo', 'origin/main']);
    // Master "All branches" CHECKBOX present and checked in the 'all' state.
    const master = list.querySelector<HTMLInputElement>('input[data-action="toggleAllBranches"]');
    assert.ok(master, 'master All-branches checkbox present');
    assert.strictEqual(master.checked, true, 'master checked in the all state');
    // In the all state every leaf renders checked.
    const leaves = Array.from(list.querySelectorAll<HTMLInputElement>('input[data-branch]'));
    assert.ok(
      leaves.every((cb) => cb.checked),
      'every leaf is checked in the all state'
    );
  });

  it('nests names by "/" into folders (feature/ holds foo + bar)', () => {
    const dom = makeDom('all');
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
    const dom = makeDom('all');
    runOptionsReady(dom, { type: 'logFilterOptionsReady', branchGroups: groups });
    const list = dom.window.document.getElementById('filter-branch-list')!;
    const leaf = Array.from(list.querySelectorAll('input[data-branch]')).find(
      (cb) => cb.getAttribute('data-branch') === 'origin/main'
    )!;
    const text = leaf.closest('.log-filter-tree-row')!.querySelector('span')!.textContent;
    assert.strictEqual(text, 'main', 'remote prefix stripped from the display');
  });

  it('pre-checks only the leaves the subset holds, master unchecked + indeterminate', () => {
    const dom = makeDom('subset', ['feature/foo', 'origin/main']);
    runOptionsReady(dom, { type: 'logFilterOptionsReady', branchGroups: groups });
    const list = dom.window.document.getElementById('filter-branch-list')!;
    const checkedRefs = Array.from(list.querySelectorAll('input[data-branch]'))
      .filter((cb) => (cb as HTMLInputElement).checked)
      .map((cb) => cb.getAttribute('data-branch'));
    assert.deepStrictEqual(checkedRefs.sort(), ['feature/foo', 'origin/main']);
    const master = list.querySelector('input[data-action="toggleAllBranches"]') as HTMLInputElement;
    assert.strictEqual(master.checked, false, 'master not fully checked for a subset');
    assert.strictEqual(master.indeterminate, true, 'master indeterminate for a subset');
  });

  it('checks the master only in the all state (unchecked for none)', () => {
    const all = makeDom('all');
    runOptionsReady(all, { type: 'logFilterOptionsReady', branchGroups: groups });
    const allMaster = all.window.document.querySelector(
      'input[data-action="toggleAllBranches"]'
    ) as HTMLInputElement;
    assert.strictEqual(allMaster.checked, true, 'master checked when all');

    const none = makeDom('none');
    runOptionsReady(none, { type: 'logFilterOptionsReady', branchGroups: groups });
    const noneMaster = none.window.document.querySelector(
      'input[data-action="toggleAllBranches"]'
    ) as HTMLInputElement;
    assert.strictEqual(noneMaster.checked, false, 'master unchecked when none');
    const anyLeafChecked = Array.from(
      none.window.document.querySelectorAll('input[data-branch]')
    ).some((cb) => (cb as HTMLInputElement).checked);
    assert.strictEqual(anyLeafChecked, false, 'no leaves checked in the none state');
  });

  it('builds rows as inert text (no markup injection)', () => {
    const dom = makeDom('all');
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
