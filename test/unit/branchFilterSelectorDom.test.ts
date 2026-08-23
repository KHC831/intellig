/**
 * Behavioral test for the `logFilterOptionsReady` handler populating the Branch
 * popup as a NESTED checkbox tree (multi-select). The handler must build
 * everything via createElement (injection-proof — textContent/data-branch cross
 * as data), render an "All branches" reset + IntelliJ's grouped layout (Local +
 * per-remote), nest branch names by "/" into folders, put a data-branch checkbox
 * on each leaf, and pre-check the leaves the filter already holds.
 *
 * The tri-state (all / none / subset) is driven by the `.log-filter-row`'s
 * `data-f-*` attributes, which the entry's `setupLogFilterRow` reads at boot to
 * seed the real `filterBridge` the handler consults.
 */

import '../setup';
import * as assert from 'assert';
import { bootWebviewEntry, IWebviewEntryHarness } from '../helpers/bootWebviewEntry';

const ENTRY = 'git-core/gitToolWindow/webview/gitToolWindow';

const groups = {
  local: ['dev', 'feature/foo', 'feature/bar'],
  remotes: [{ remote: 'origin', branches: ['origin/main'] }],
};

describe('Branch popup — client population on logFilterOptionsReady', () => {
  const booted: IWebviewEntryHarness[] = [];

  afterEach(() => {
    while (booted.length) {
      booted.pop()!.dispose();
    }
  });

  /**
   * Boot the entry with a `.log-filter-row` whose data attributes yield the
   * requested tri-state, plus an empty branch list, then deliver the branch
   * options. Returns the resulting document.
   */
  function render(
    mode: 'all' | 'none' | 'subset',
    checked: string[] = [],
    branchGroups: unknown = groups
  ): Document {
    const rowAttrs =
      mode === 'none'
        ? ' data-f-branches-none="true"'
        : mode === 'subset'
          ? ` data-f-branches='${JSON.stringify(checked)}'`
          : '';
    const h = bootWebviewEntry(ENTRY, {
      bodyHtml:
        `<div class="log-filter-row"${rowAttrs}></div>` +
        `<div class="log-filter-popup-list" id="filter-branch-list"></div>`,
    });
    booted.push(h);
    h.post({ type: 'logFilterOptionsReady', branchGroups });
    return h.document;
  }

  /** data-branch values of the leaf checkboxes, in document order. */
  function leafRefs(list: Element): string[] {
    return Array.from(list.querySelectorAll('input[data-branch]')).map(
      (cb) => cb.getAttribute('data-branch') || ''
    );
  }

  it('renders a master All-branches checkbox + Local/remote sections + a checkbox per leaf', () => {
    const document = render('all');
    const list = document.getElementById('filter-branch-list')!;
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
    const document = render('all');
    const list = document.getElementById('filter-branch-list')!;
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
    const document = render('all');
    const list = document.getElementById('filter-branch-list')!;
    const leaf = Array.from(list.querySelectorAll('input[data-branch]')).find(
      (cb) => cb.getAttribute('data-branch') === 'origin/main'
    )!;
    const text = leaf.closest('.log-filter-tree-row')!.querySelector('span')!.textContent;
    assert.strictEqual(text, 'main', 'remote prefix stripped from the display');
  });

  it('pre-checks only the leaves the subset holds, master unchecked + indeterminate', () => {
    const document = render('subset', ['feature/foo', 'origin/main']);
    const list = document.getElementById('filter-branch-list')!;
    const checkedRefs = Array.from(list.querySelectorAll('input[data-branch]'))
      .filter((cb) => (cb as HTMLInputElement).checked)
      .map((cb) => cb.getAttribute('data-branch'));
    assert.deepStrictEqual(checkedRefs.sort(), ['feature/foo', 'origin/main']);
    const master = list.querySelector('input[data-action="toggleAllBranches"]') as HTMLInputElement;
    assert.strictEqual(master.checked, false, 'master not fully checked for a subset');
    assert.strictEqual(master.indeterminate, true, 'master indeterminate for a subset');
  });

  it('checks the master only in the all state (unchecked for none)', () => {
    const allDoc = render('all');
    const allMaster = allDoc.querySelector(
      'input[data-action="toggleAllBranches"]'
    ) as HTMLInputElement;
    assert.strictEqual(allMaster.checked, true, 'master checked when all');

    const noneDoc = render('none');
    const noneMaster = noneDoc.querySelector(
      'input[data-action="toggleAllBranches"]'
    ) as HTMLInputElement;
    assert.strictEqual(noneMaster.checked, false, 'master unchecked when none');
    const anyLeafChecked = Array.from(noneDoc.querySelectorAll('input[data-branch]')).some(
      (cb) => (cb as HTMLInputElement).checked
    );
    assert.strictEqual(anyLeafChecked, false, 'no leaves checked in the none state');
  });

  // The name→node map is a plain object, so a segment that names an
  // Object.prototype key reads as an already-present node. Both branch names
  // below are legal per git-check-ref-format.
  it('lists branches whose name is an Object.prototype key', () => {
    const document = render('all', [], {
      local: ['constructor', 'main', 'toString'],
      remotes: [],
    });
    const list = document.getElementById('filter-branch-list')!;
    // Dropping one silently also miscounts the leaves, so "every box checked"
    // resolves to `all` while a real branch is missing from the filter.
    assert.deepStrictEqual(leafRefs(list), ['constructor', 'main', 'toString']);
  });

  it('lists branches under a folder whose name is an Object.prototype key', () => {
    const document = render('all', [], {
      local: ['__proto__/x', 'main'],
      remotes: [],
    });
    const list = document.getElementById('filter-branch-list')!;
    // Walking into the inherited value throws mid-render, so the whole popup
    // comes up empty — `main` disappears along with the offending name.
    assert.deepStrictEqual(leafRefs(list), ['__proto__/x', 'main']);
  });

  // Reconciliation asks "is this saved ref still on offer?" through the same
  // kind of plain-object map. An inherited key answers yes for a branch that is
  // gone, so the kept count reaches the leaf count and the whole filter
  // silently resets to "all branches" instead of narrowing to what survived.
  it('drops a saved branch that no longer exists even when it names an Object.prototype key', () => {
    const document = render('subset', ['toString', 'main'], {
      local: ['dev', 'main'],
      remotes: [],
    });
    const list = document.getElementById('filter-branch-list')!;
    const checked = Array.from(list.querySelectorAll<HTMLInputElement>('input[data-branch]'))
      .filter((cb) => cb.checked)
      .map((cb) => cb.getAttribute('data-branch'));
    assert.deepStrictEqual(checked, ['main'], 'only the surviving saved branch stays checked');
  });

  it('builds rows as inert text (no markup injection)', () => {
    const document = render('all', [], {
      local: ['<img src=x onerror=alert(1)>'],
      remotes: [],
    });
    assert.strictEqual(document.querySelector('img'), null, 'no element injected');
    const list = document.getElementById('filter-branch-list')!;
    const leaf = Array.from(list.querySelectorAll('input[data-branch]')).find(
      (cb) => cb.getAttribute('data-branch') === '<img src=x onerror=alert(1)>'
    )!;
    assert.strictEqual(
      leaf.closest('.log-filter-tree-row')!.querySelector('span')!.textContent,
      '<img src=x onerror=alert(1)>'
    );
  });
});
