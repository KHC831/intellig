/// <reference lib="dom" />
/**
 * Host-message list builders for the log filter row: the branch tree
 * (`logFilterOptionsReady`) and the author list (`authorOptionsReady`).
 * Extracted verbatim from the entry's message handler; behavior is pinned by
 * the filter-row webview suites.
 */

import type { GitToolWindowOutbound } from '../gitToolWindow.protocol';
import type { IFilterBridge } from './logFilterRow';

/**
 * Apply the two filter-list host messages (`logFilterOptionsReady`,
 * `authorOptionsReady`) to the popup DOM. `getBridge` is a live read: the
 * bridge may be absent (no filter row) and must never be captured at wiring
 * time.
 */
export function applyFilterOptionsMessage(
  message: GitToolWindowOutbound,
  getBridge: () => IFilterBridge | null
): void {
  if (message.type === 'logFilterOptionsReady') {
    const list = document.getElementById('filter-branch-list');
    const groups = message.branchGroups;
    if (list && groups) {
      const intf = getBridge();
      const checked = (name: string): boolean => (intf ? intf.isBranchChecked(name) : false);
      list.replaceChildren();
      const addSection = function (title: string): void {
        const header = document.createElement('div');
        header.className = 'log-filter-popup-section';
        header.textContent = title;
        list.appendChild(header);
      };
      // A Map, not an object: a branch may legally be named `constructor` /
      // `toString` / `__proto__`, and an object literal inherits those keys.
      interface ITreeNode {
        children: Map<string, ITreeNode>;
        order: string[];
        leaf: string | null;
      }
      const newNode = (): ITreeNode => ({ children: new Map(), order: [], leaf: null });
      const buildTree = function (names: string[], stripPrefix: string): ITreeNode {
        const root: ITreeNode = newNode();
        names.forEach(function (full) {
          const shown =
            stripPrefix && full.indexOf(stripPrefix) === 0 ? full.slice(stripPrefix.length) : full;
          const parts = shown.split('/').filter(Boolean);
          let node = root;
          parts.forEach(function (seg, i) {
            let child = node.children.get(seg);
            if (!child) {
              child = newNode();
              node.children.set(seg, child);
              node.order.push(seg);
            }
            node = child;
            if (i === parts.length - 1) {
              node.leaf = full;
            }
          });
        });
        return root;
      };
      const renderTree = function (container: HTMLElement, node: ITreeNode, depth: number): void {
        node.order.sort();
        node.order.forEach(function (seg) {
          const child = node.children.get(seg);
          if (!child) {
            return;
          }
          const hasChildren = child.order.length > 0;
          const wrap = document.createElement('div');
          wrap.className = 'log-filter-tree-node';
          const rowLabel = document.createElement('label');
          rowLabel.className = 'log-filter-tree-row';
          rowLabel.style.paddingLeft = depth * 14 + 8 + 'px';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          if (child.leaf) {
            cb.setAttribute('data-action', 'toggleBranchCheckbox');
            cb.setAttribute('data-branch', child.leaf);
            cb.checked = !!checked(child.leaf);
          } else {
            cb.setAttribute('data-action', 'toggleBranchFolder');
          }
          const text = document.createElement('span');
          text.className = hasChildren ? 'log-filter-tree-folder' : 'log-filter-tree-leaf';
          text.textContent = seg;
          rowLabel.appendChild(cb);
          rowLabel.appendChild(text);
          wrap.appendChild(rowLabel);
          container.appendChild(wrap);
          if (hasChildren) {
            renderTree(wrap, child, depth + 1);
          }
        });
      };
      const masterRow = document.createElement('label');
      masterRow.className = 'log-filter-tree-row';
      const masterCb = document.createElement('input');
      masterCb.type = 'checkbox';
      masterCb.className = 'log-filter-tree-check';
      masterCb.setAttribute('data-action', 'toggleAllBranches');
      masterCb.checked = (intf ? intf.branchState() : 'all') === 'all';
      const masterText = document.createElement('span');
      masterText.className = 'log-filter-tree-leaf';
      masterText.textContent = 'All branches';
      masterRow.appendChild(masterCb);
      masterRow.appendChild(masterText);
      list.appendChild(masterRow);
      if (Array.isArray(groups.local) && groups.local.length > 0) {
        addSection('Local');
        renderTree(list, buildTree(groups.local, ''), 0);
      }
      if (Array.isArray(groups.remotes)) {
        groups.remotes.forEach(function (g) {
          if (!g.branches || g.branches.length === 0) {
            return;
          }
          addSection(g.remote);
          renderTree(list, buildTree(g.branches, g.remote + '/'), 0);
        });
      }
      if (intf && intf.reconcileBranchSelection) {
        intf.reconcileBranchSelection();
      }
      if (intf && intf.syncBranchTree) {
        intf.syncBranchTree();
      }
    }
  }
  if (message.type === 'authorOptionsReady') {
    const list = document.getElementById('filter-author-list');
    if (list && Array.isArray(message.authors)) {
      const b = getBridge();
      const current = b ? b.getAuthor() : '';
      list.replaceChildren();
      const allBtn = document.createElement('button');
      allBtn.type = 'button';
      allBtn.className = 'log-filter-popup-item' + (current ? '' : ' active');
      allBtn.setAttribute('data-action', 'pickAuthorFilter');
      allBtn.setAttribute('data-author', '__all__');
      allBtn.textContent = 'All users';
      list.appendChild(allBtn);
      // "me" preset — applies the resolved configured identity as the
      // author filter; omitted when the identity is unknown.
      if (typeof message.me === 'string' && message.me.length > 0) {
        const meBtn = document.createElement('button');
        meBtn.type = 'button';
        meBtn.className = 'log-filter-popup-item' + (message.me === current ? ' active' : '');
        meBtn.setAttribute('data-action', 'pickAuthorFilter');
        meBtn.setAttribute('data-author', message.me);
        meBtn.textContent = 'me';
        list.appendChild(meBtn);
      }
      // Each author is a CHECKBOX (IntelliJ multi-user filter): checking
      // several unions them; All users / me stay one-click buttons above.
      message.authors.forEach(function (a) {
        const name = String(a);
        const label = document.createElement('label');
        label.className = 'log-filter-tree-row';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.setAttribute('data-action', 'toggleAuthorCheckbox');
        box.setAttribute('data-author', name);
        const bridge = window.__intelligFilter;
        box.checked = bridge ? bridge.getAuthors().indexOf(name) !== -1 : name === current;
        const text = document.createElement('span');
        text.className = 'log-filter-tree-leaf';
        text.textContent = name;
        label.appendChild(box);
        label.appendChild(text);
        list.appendChild(label);
      });
    }
  }
}
