/**
 * Local Changes tree builders for the Commit tool window webview.
 *
 * Pure data→DOM: every node is created with createElement (HTML-string
 * skeletons are banned repo-wide) and nothing here reads live DOM or posts to
 * the host. Shared by boot render and applyModel so a live update and a fresh
 * render can never build different trees.
 */

import type {
  ICommitToolWindowInitModel,
  ICtwChangelistModel,
  ICtwConflictEntry,
  ICtwConflictsModel,
  ICtwFileEntry,
} from '../commitToolWindow.types';
import { el, setAttrs } from './ctwDom';

export function buildFileRow(
  f: ICtwFileEntry,
  changelistId: string,
  selected: ReadonlySet<string>
): HTMLDivElement {
  const row = el('div', {
    className:
      'ctw-file-row' +
      (f.conflicted ? ' ctw-file-conflicted' : '') +
      (f.untracked ? ' ctw-file-untracked' : ''),
  });
  // tabindex="-1" makes the row programmatically focusable without putting it
  // in the Tab order: dismissing its context menu hands focus back here rather
  // than dropping it on <body> in the middle of writing a commit message.
  setAttrs(row, { 'data-path': f.path, 'data-changelist': changelistId, tabindex: -1 });
  const chk = el('input', {
    type: 'checkbox',
    className: 'ctw-file-check',
    checked: selected.has(f.path),
  });
  setAttrs(chk, { 'data-path': f.path });
  row.appendChild(chk);
  row.appendChild(el('span', { className: 'ctw-file-status', textContent: f.statusChar }));
  row.appendChild(el('span', { className: 'ctw-file-path', textContent: f.displayName }));
  if (f.conflicted) {
    // Always rendered, never hover-revealed: a control you have to find with
    // the cursor cannot fix a discoverability problem. Only conflicted rows
    // carry one, so it stays rare rather than becoming row furniture.
    const resolve = el('button', { className: 'ctw-file-resolve', textContent: 'Resolve' });
    setAttrs(resolve, {
      type: 'button',
      'data-path': f.path,
      title: 'Resolve conflicts in this file',
    });
    row.appendChild(resolve);
  }
  return row;
}

// Append a changelist's files into its block, honoring grouping. Flat mode
// appends file rows directly; directory mode wraps each bucket in a
// .ctw-dir-group (with an optional .ctw-dir-row header).
export function appendChangelistFiles(
  block: HTMLElement,
  cl: ICtwChangelistModel,
  selected: ReadonlySet<string>
): void {
  if (cl.dirGroups) {
    cl.dirGroups.forEach((g) => {
      const group = el('div', { className: 'ctw-dir-group' });
      if (g.dir !== null && g.dir !== undefined) {
        const dirRow = el('div', { className: 'ctw-dir-row' });
        setAttrs(dirRow, { 'data-dir': g.dir });
        dirRow.appendChild(el('span', { className: 'ctw-dir-chevron', textContent: '▾' }));
        dirRow.appendChild(el('span', { className: 'ctw-dir-path', textContent: g.dir }));
        group.appendChild(dirRow);
      }
      (g.files || []).forEach((f) => {
        group.appendChild(buildFileRow(f, cl.id, selected));
      });
      block.appendChild(group);
    });
  } else {
    (cl.files || []).forEach((f) => {
      block.appendChild(buildFileRow(f, cl.id, selected));
    });
  }
}

/**
 * The Merge Conflicts node: a header naming the thing, the file count, and a
 * Resolve link, over the unmerged rows themselves. Nested inside its owning
 * changelist rather than hoisted above every list, so a list holding nothing
 * but conflicts keeps its own header and actions.
 *
 * Mirrors IntelliJ's `ChangesBrowserConflictsNode`, which renders the bold
 * title, a count, and a Resolve link opening the multi-file dialog.
 */
export function buildConflictsBlock(
  conflicts: ICtwConflictsModel,
  selected: ReadonlySet<string>
): HTMLDivElement {
  const block = el('div', { className: 'ctw-conflicts-block' });
  const header = el('div', { className: 'ctw-conflicts-row' });
  header.appendChild(el('span', { className: 'ctw-chevron', textContent: '▾' }));
  header.appendChild(
    el('span', { className: 'ctw-conflicts-name', textContent: 'Merge Conflicts' })
  );
  header.appendChild(
    el('span', {
      className: 'ctw-count',
      textContent: conflicts.fileCount + ' file' + (conflicts.fileCount === 1 ? '' : 's'),
    })
  );
  const resolve = el('button', { className: 'ctw-conflicts-resolve', textContent: 'Resolve' });
  setAttrs(resolve, { type: 'button', title: 'Resolve all conflicted files' });
  header.appendChild(resolve);
  block.appendChild(header);
  conflicts.files.forEach((f: ICtwConflictEntry) => {
    const row = buildFileRow(f, f.changelistId, selected);
    if (typeof f.conflictCount === 'number') {
      // Sits before the Resolve button so the row reads
      // "<path>  3 conflicts  [Resolve]".
      const count = el('span', {
        className: 'ctw-file-conflict-count',
        textContent: f.conflictCount + (f.conflictCount === 1 ? ' conflict' : ' conflicts'),
      });
      row.insertBefore(count, row.querySelector('.ctw-file-resolve'));
    }
    block.appendChild(row);
  });
  return block;
}

export function buildChangelistBlock(
  cl: ICtwChangelistModel,
  selected: ReadonlySet<string>,
  opts?: { unversioned?: boolean }
): HTMLDivElement {
  const block = el('div', {
    className: 'ctw-changelist-block' + (opts && opts.unversioned ? ' ctw-unversioned-block' : ''),
  });
  const header = el('div', {
    className: 'ctw-changelist-row' + (opts && opts.unversioned ? ' ctw-unversioned-row' : ''),
  });
  setAttrs(header, { 'data-changelist': cl.id, tabindex: -1 });
  header.appendChild(el('span', { className: 'ctw-chevron', textContent: '▾' }));
  const name = el('span', {
    className: 'ctw-changelist-name' + (cl.isActive ? ' ctw-changelist-active' : ''),
  });
  name.appendChild(document.createTextNode(cl.name));
  if (cl.isActive) {
    name.appendChild(document.createTextNode(' '));
    name.appendChild(el('span', { className: 'ctw-active-tag', textContent: '(Active)' }));
  }
  header.appendChild(name);
  header.appendChild(
    el('span', {
      className: 'ctw-count',
      textContent: cl.fileCount + ' file' + (cl.fileCount === 1 ? '' : 's'),
    })
  );
  block.appendChild(header);
  // The changelist's own Merge Conflicts node, ahead of its ordinary files —
  // IntelliJ nests the conflicts group inside the changelist subtree.
  if (cl.conflicts) {
    block.appendChild(buildConflictsBlock(cl.conflicts, selected));
  }
  appendChangelistFiles(block, cl, selected);
  return block;
}

export function buildGroupingToggle(model: ICommitToolWindowInitModel): HTMLDivElement {
  const wrap = el('div', { className: 'ctw-grouping' });
  setAttrs(wrap, { role: 'radiogroup', 'aria-label': 'Group by' });
  wrap.appendChild(el('span', { className: 'ctw-grouping-label', textContent: 'Group by:' }));
  const btn = (value: string, label: string): HTMLButtonElement => {
    const b = el('button', {
      className: 'ctw-grouping-btn' + (model.grouping === value ? ' ctw-grouping-active' : ''),
      textContent: label,
    });
    setAttrs(b, { 'data-grouping': value, 'aria-pressed': model.grouping === value });
    return b;
  };
  wrap.appendChild(btn('directory', 'Directory'));
  wrap.appendChild(btn('flat', 'Flat'));
  return wrap;
}

/** Grouping toggle + changelist tree (or empty note) — the replaceable Local Changes content. */
export function buildLocalTreeContent(model: ICommitToolWindowInitModel): DocumentFragment {
  const frag = document.createDocumentFragment();
  frag.appendChild(buildGroupingToggle(model));
  if (model.local.empty) {
    frag.appendChild(el('div', { className: 'ctw-empty', textContent: 'No uncommitted changes.' }));
    return frag;
  }
  const selected = new Set(model.selectedFiles ?? []);
  const tree = el('div', { className: 'ctw-changelist-tree' });
  setAttrs(tree, { role: 'tree' });
  model.local.changelists.forEach((cl) => {
    tree.appendChild(buildChangelistBlock(cl, selected));
  });
  if (model.local.unversioned) {
    tree.appendChild(
      buildChangelistBlock(model.local.unversioned, selected, { unversioned: true })
    );
  }
  frag.appendChild(tree);
  return frag;
}
