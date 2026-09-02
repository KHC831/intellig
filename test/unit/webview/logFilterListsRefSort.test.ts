/**
 * The Log filter row's branch-tree renderer (`logFilterLists.ts`) must order
 * each tree level by the same comparator the Branches tree uses
 * (compareRefNames), not a bare code-unit `.sort()` — see
 * loadedGraphQueriesBranchFilterSort.test.ts for the host-side half of the
 * same class.
 */

import '../../setup';
import * as assert from 'assert';
import { JSDOM } from 'jsdom';
import { applyFilterOptionsMessage } from '../../../src/git-core/gitToolWindow/webview/logFilterLists';
import { compareRefNames } from '../../../src/utils/refNameSort';
import type { GitToolWindowOutbound } from '../../../src/git-core/gitToolWindow/gitToolWindow.protocol';

function withDom<T>(fn: () => T): T {
  const dom = new JSDOM('<!doctype html><body><div id="filter-branch-list"></div></body>');
  const globals = globalThis as { document?: Document; window?: unknown };
  const priorDocument = globals.document;
  const priorWindow = globals.window;
  globals.document = dom.window.document;
  globals.window = dom.window;
  try {
    return fn();
  } finally {
    globals.document = priorDocument;
    globals.window = priorWindow;
    dom.window.close();
  }
}

describe('applyFilterOptionsMessage — logFilterOptionsReady tree ordering', () => {
  it('renders the Local branch tree top level in compareRefNames order', () => {
    withDom(() => {
      const names = ['Backup', 'fork', 'Upstream', 'upstream'];
      const message = {
        type: 'logFilterOptionsReady',
        branchGroups: { local: names, remotes: [] },
      } as unknown as GitToolWindowOutbound;

      applyFilterOptionsMessage(message, () => null);

      const list = document.getElementById('filter-branch-list');
      assert.ok(list, 'the branch list must exist');
      const rendered = Array.from(
        list.querySelectorAll('.log-filter-tree-node .log-filter-tree-leaf')
      ).map((el) => el.textContent);
      assert.deepStrictEqual(
        rendered,
        [...names].sort(compareRefNames),
        'the rendered top-level order must match the shared ref-name comparator'
      );
    });
  });
});
