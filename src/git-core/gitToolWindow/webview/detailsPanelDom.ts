/// <reference lib="dom" />
/**
 * Commit Details Panel DOM builder — the single source for the panel's markup,
 * built via `createElement` from a structured {@link DetailsPanelModel} so a
 * hostile commit message / path / author crosses as data (textContent /
 * element props), never interpolated markup. Shared by the Git tool window's
 * bundled webview entry (initial render + the `updateDetailsPanel` message) and
 * pinned directly by `detailsPanelDom` test helper. DOM-only, vscode-free.
 */

import type {
  DetailsPanelModel,
  DetailsTreeNode,
  MessageToken,
} from '../provider/detailsPanelModel.types';

/** Build the `.details-panel` element from a render-model. */
export function buildDetailsPanelDom(model: DetailsPanelModel): HTMLElement {
  const make = function (tag: string, className?: string): HTMLElement {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    return node;
  };
  const panel = make('div', 'details-panel');
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Commit Details');

  if (!model || model.kind === 'placeholder') {
    panel.setAttribute('aria-label', 'Commit Details');
    const ph = make('div', 'details-placeholder');
    const p = make('p', 'placeholder-message');
    p.textContent = 'Select a commit to view details';
    ph.appendChild(p);
    panel.appendChild(ph);
    return panel;
  }

  // Append message tokens (inert text + issue links) into a parent.
  const appendTokens = function (parent: HTMLElement, tokens: MessageToken[] | null): void {
    (tokens || []).forEach(function (tok) {
      if (tok.t === 'link') {
        const a = make('a', 'commit-issue-link');
        a.setAttribute('href', tok.href);
        a.setAttribute('title', tok.title);
        a.textContent = tok.text;
        parent.appendChild(a);
      } else if (tok.t === 'commit') {
        // Referenced commit: the graph's existing selection handler picks this
        // up by `data-commit-hash` and jumps to the row.
        const ref = make('a', 'commit-hash-link');
        ref.setAttribute('role', 'button');
        ref.setAttribute('tabindex', '0');
        ref.setAttribute('data-commit-hash', tok.hash);
        ref.setAttribute('title', 'Jump to commit ' + tok.hash);
        ref.textContent = tok.text;
        parent.appendChild(ref);
      } else {
        parent.appendChild(document.createTextNode(tok.v));
      }
    });
  };

  // Build the changed-files list (tree | empty | error message).
  const buildChangedFiles = function (
    count: number,
    tree: DetailsTreeNode[],
    error: string | undefined
  ): HTMLElement {
    const wrap = make('div', 'details-changed-files');
    const h4 = make('h4');
    // Heading: "<project> (<n> files) <path>". Falls back to the plain
    // "Changed Files (N)" when the owning project isn't known.
    if (model.projectName) {
      const filesText = count === 1 ? '1 file' : count + ' files';
      const nameEl = make('span', 'details-project-name');
      nameEl.textContent = model.projectName;
      h4.appendChild(nameEl);
      h4.appendChild(document.createTextNode(' (' + filesText + ')'));
      if (model.projectPath) {
        const pathEl = make('span', 'details-project-path');
        pathEl.textContent = model.projectPath;
        pathEl.setAttribute('title', model.projectPath);
        h4.appendChild(document.createTextNode(' '));
        h4.appendChild(pathEl);
      }
    } else {
      h4.textContent = 'Changed Files (' + count + ')';
    }
    // Heading + Group By toggle share a row; the toggle stays OUTSIDE the
    // heading so the h4's text (and accessible name) remains just the title.
    const header = make('div', 'details-changed-files-header');
    header.appendChild(h4);
    // IntelliJ offers a GroupBy on every changes list. Single commit only —
    // the multi panel has no per-selection preference yet.
    if (model.kind === 'single') {
      const groupBy = make('button', 'details-groupby-toggle');
      const flat = model.groupBy === 'flat';
      groupBy.setAttribute('type', 'button');
      groupBy.setAttribute('data-action', 'toggleDetailsGroupBy');
      groupBy.setAttribute('data-groupby', flat ? 'tree' : 'flat');
      groupBy.setAttribute('aria-pressed', String(!flat));
      groupBy.setAttribute('title', flat ? 'Group by directory' : 'Show flat file paths');
      groupBy.textContent = flat ? 'Flat' : 'Tree';
      header.appendChild(groupBy);
    }
    wrap.appendChild(header);
    const list = make('div', 'changed-files-list');
    list.setAttribute('role', 'tree');
    list.setAttribute('aria-label', 'Changed Files');
    if (error) {
      const p = make('p', 'empty-message error-message');
      p.textContent = 'Failed to load changed files: ' + error;
      list.appendChild(p);
    } else if (!tree || tree.length === 0) {
      const p = make('p', 'empty-message');
      p.textContent = 'No changed files';
      list.appendChild(p);
    } else {
      // Reserve the twistie column on FILE rows only when the forest nests:
      // without the spacer a child file's name starts LEFT of its parent
      // directory's name (the dir name sits after an 18px chevron column) and
      // the tree reads as unindented. A directory-free list (flat mode, or a
      // commit touching only root files) stays flush.
      const reserveTwistie = tree.some((n) => n.kind === 'directory');
      appendTree(
        list,
        tree,
        0,
        { next: 0 },
        model.kind === 'single' ? model.hash : undefined,
        reserveTwistie
      );
    }
    wrap.appendChild(list);
    return wrap;
  };

  if (model.kind === 'multi') {
    panel.classList.add('multi-commit-details');
    panel.setAttribute('aria-label', 'Multi-Commit Details');
    panel.setAttribute('data-selected-count', String(model.count));
    const header = make('h3', 'multi-commit-header');
    header.textContent = model.count + ' commit' + (model.count !== 1 ? 's' : '') + ' selected';
    panel.appendChild(header);
    const list = make('div', 'multi-commit-list');
    list.setAttribute('role', 'list');
    list.setAttribute('aria-label', 'Selected Commits');
    (model.commits || []).forEach(function (c) {
      const item = make('div', 'multi-commit-item');
      item.setAttribute('role', 'listitem');
      const sh = make('span', 'commit-short-hash');
      sh.textContent = c.shortHash;
      const sm = make('span', 'commit-summary');
      sm.textContent = c.summary;
      item.appendChild(sh);
      item.appendChild(sm);
      list.appendChild(item);
    });
    panel.appendChild(list);
    panel.appendChild(
      buildChangedFiles(model.changedFilesCount, model.fileTree, model.changedFilesError)
    );
    return panel;
  }

  // Single-commit panel.
  panel.appendChild(
    buildChangedFiles(model.changedFilesCount, model.fileTree, model.changedFilesError)
  );
  const meta = make('div', 'details-metadata');
  const row = function (labelText: string): HTMLElement {
    const r = make('div', 'detail-row');
    const l = make('span', 'detail-label');
    l.textContent = labelText;
    r.appendChild(l);
    return r;
  };

  // Refs pointing AT this commit, grouped by type like IntelliJ's
  // ReferencesPanel. Names cross as textContent — a ref name is user data.
  const appendRefRow = function (names: string[], kind: string, label: string): void {
    if (!names || names.length === 0) {
      return;
    }
    const refsRow = make('div', 'detail-row details-refs-row');
    const refsLabel = make('span', 'detail-label');
    refsLabel.textContent = label;
    refsRow.appendChild(refsLabel);
    const refsVal = make('span', 'detail-value details-refs-value');
    names.forEach(function (name) {
      const chip = make('span', 'details-ref-chip details-ref-' + kind);
      chip.setAttribute('title', name);
      chip.textContent = name;
      refsVal.appendChild(chip);
    });
    refsRow.appendChild(refsVal);
    meta.appendChild(refsRow);
  };

  // Commit message — subject in BOLD, body below; no "Message:" label
  // (IntelliJ shows the subject as the header, not a labeled field).
  const msgRow = make('div', 'detail-row message-row');
  const pre = make('pre', 'detail-value commit-full-message');
  const subject = make('span', 'commit-subject');
  appendTokens(subject, model.messageTokens);
  pre.appendChild(subject);
  if (model.bodyTokens) {
    pre.appendChild(document.createTextNode('\n\n'));
    appendTokens(pre, model.bodyTokens);
  }
  msgRow.appendChild(pre);
  meta.appendChild(msgRow);

  const refBranches = model.refBranches || [];
  const refTags = model.refTags || [];
  appendRefRow(refBranches, 'branch', refBranches.length === 1 ? 'Branch:' : 'Branches:');
  appendRefRow(refTags, 'tag', refTags.length === 1 ? 'Tag:' : 'Tags:');

  const hashRow = row('Hash:');
  const hashVal = make('span', 'detail-value hash-value');
  hashVal.setAttribute('data-copy-text', model.hash);
  hashVal.setAttribute('title', 'Click to copy');
  hashVal.textContent = model.hash;
  hashRow.appendChild(hashVal);
  meta.appendChild(hashRow);

  const authorRow = row('Author:');
  const authorVal = make('span', 'detail-value');
  authorVal.textContent = model.authorName + ' <' + model.authorEmail + '>';
  authorRow.appendChild(authorVal);
  meta.appendChild(authorRow);

  const dateRow = row('Date:');
  const dateVal = make('span', 'detail-value');
  dateVal.textContent = model.dateStr;
  dateRow.appendChild(dateVal);
  meta.appendChild(dateRow);

  // Dimmed committer line, shown only when the model carries one: "committed
  // by <name> <email>" and/or "on <date>" (CommitPresentationUtil).
  if (model.committed) {
    const committedRow = make('div', 'detail-row committed-by-row');
    const committedVal = make('span', 'detail-value committed-by-value');
    const parts: string[] = [];
    if (model.committed.name) {
      parts.push('committed by ' + model.committed.name + ' <' + model.committed.email + '>');
    }
    if (model.committed.dateStr) {
      parts.push((parts.length === 0 ? 'committed on ' : 'on ') + model.committed.dateStr);
    }
    committedVal.textContent = parts.join(' ');
    committedRow.appendChild(committedVal);
    meta.appendChild(committedRow);
  }

  const parentsRow = row('Parents:');
  const parentsVal = make('span', 'detail-value');
  if (!model.parents || model.parents.length === 0) {
    const none = make('span', 'no-parents');
    none.textContent = 'None (root commit)';
    parentsVal.appendChild(none);
  } else {
    model.parents.forEach(function (p, i) {
      if (i > 0) {
        parentsVal.appendChild(document.createTextNode(', '));
      }
      const span = make('span', 'parent-hash');
      span.setAttribute('data-parent-hash', p.full);
      span.setAttribute('title', p.full);
      span.textContent = p.short;
      parentsVal.appendChild(span);
    });
  }
  parentsRow.appendChild(parentsVal);
  meta.appendChild(parentsRow);

  // "Contained in branches" row (mirrors IntelliJ ContainingBranchesPanel /
  // CommitPresentationUtil.getBranchesLinkText): the header carries the
  // FULL branch count ("In N branch(es):") in both collapsed and expanded
  // states, or a loading / "not in any branch" phrase. Past the threshold
  // the names collapse to the first N + a "Show all" toggle. Branch names
  // cross as DATA (textContent), never interpolated markup.
  const branchesRow = make('div', 'detail-row containing-branches-row');
  const branchesLabel = make('span', 'detail-label');
  const containing = model.containingBranches;
  if (!containing) {
    branchesLabel.textContent = 'In branches: loading…';
    branchesRow.appendChild(branchesLabel);
  } else if (containing.length === 0) {
    branchesLabel.textContent = 'Not in any branch';
    branchesRow.appendChild(branchesLabel);
  } else {
    branchesLabel.textContent =
      'In ' + containing.length + (containing.length === 1 ? ' branch:' : ' branches:');
    branchesRow.appendChild(branchesLabel);
    const branchesVal = make('span', 'detail-value containing-branches-value');
    const threshold = model.branchCollapseThreshold || 3;
    const appendNames = function (parent: HTMLElement, names: string[]): void {
      names.forEach(function (name, i) {
        if (i > 0) {
          parent.appendChild(document.createTextNode(', '));
        }
        const span = make('span', 'containing-branch');
        span.textContent = name;
        parent.appendChild(span);
      });
    };
    if (containing.length <= threshold) {
      const all = make('span', 'branches-collapsed');
      appendNames(all, containing);
      branchesVal.appendChild(all);
    } else {
      const collapsed = make('span', 'branches-collapsed');
      appendNames(collapsed, containing.slice(0, threshold));
      collapsed.appendChild(document.createTextNode(' … '));
      const expanded = make('span', 'branches-expanded');
      expanded.style.display = 'none';
      appendNames(expanded, containing);
      expanded.appendChild(document.createTextNode(' '));

      const toggle = function (showExpanded: boolean): void {
        collapsed.style.display = showExpanded ? 'none' : '';
        expanded.style.display = showExpanded ? '' : 'none';
      };
      const linkButton = function (className: string, label: string, expand: boolean): HTMLElement {
        const a = make('a', className);
        a.setAttribute('role', 'button');
        a.setAttribute('tabindex', '0');
        a.textContent = label;
        a.addEventListener('click', function () {
          toggle(expand);
        });
        a.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle(expand);
          }
        });
        return a;
      };
      collapsed.appendChild(linkButton('branches-show-all', 'Show all', true));
      expanded.appendChild(linkButton('branches-hide', 'Hide', false));
      branchesVal.appendChild(collapsed);
      branchesVal.appendChild(expanded);
    }
    branchesRow.appendChild(branchesVal);
  }
  meta.appendChild(branchesRow);

  panel.appendChild(meta);
  return panel;

  // ---- nested file-tree builders (hoisted) ----
  function appendTree(
    parent: HTMLElement,
    nodes: DetailsTreeNode[],
    depth: number,
    ids: { next: number },
    commitHash: string | undefined,
    reserveTwistie: boolean
  ): void {
    (nodes || []).forEach(function (node) {
      if (node.kind === 'directory') {
        const padding = depth * 16 + 4;
        const dirItem = document.createElement('div');
        dirItem.className = 'changed-dir-item';
        dirItem.setAttribute('role', 'treeitem');
        dirItem.setAttribute('aria-expanded', 'true');
        const containerId = 'dir-children-' + ids.next++;
        dirItem.setAttribute('aria-controls', containerId);
        dirItem.setAttribute('tabindex', '0');
        dirItem.setAttribute('style', 'padding-left: ' + padding + 'px;');
        const chevron = document.createElement('span');
        chevron.className = 'dir-chevron codicon codicon-chevron-down';
        chevron.setAttribute('aria-hidden', 'true');
        dirItem.appendChild(chevron);
        const dirName = document.createElement('span');
        dirName.className = 'dir-name';
        dirName.textContent = node.name;
        dirItem.appendChild(dirName);
        parent.appendChild(dirItem);
        const childrenWrap = document.createElement('div');
        childrenWrap.className = 'changed-dir-children';
        childrenWrap.setAttribute('role', 'group');
        childrenWrap.id = containerId;
        appendTree(childrenWrap, node.children, depth + 1, ids, commitHash, reserveTwistie);
        parent.appendChild(childrenWrap);
      } else {
        const padding = depth * 16 + 4;
        const item = document.createElement('div');
        item.className = 'changed-file-item';
        item.setAttribute('data-path', node.path);
        item.setAttribute('data-status', node.status);
        // The panel's own hash in the single-commit tree; the merged file's
        // owning commit in the combined one. Without it the row's context menu
        // and double-click-to-diff both no-op on a row that looks interactive.
        const owner = node.commitHash ?? commitHash;
        if (owner !== undefined) {
          item.setAttribute('data-commit-hash', owner);
        }
        item.setAttribute('role', 'treeitem');
        item.setAttribute('tabindex', '0');
        item.setAttribute('style', 'padding-left: ' + padding + 'px;');
        // Blank twistie column (mirrors .dir-chevron's 16px + 2px margin) so
        // a file's name lands RIGHT of its parent directory's name.
        if (reserveTwistie) {
          const spacer = document.createElement('span');
          spacer.className = 'dir-chevron-spacer';
          spacer.setAttribute('aria-hidden', 'true');
          item.appendChild(spacer);
        }
        // No M/A/D status letter — the file-name colour (+ the per-file
        // line stat below) conveys the change kind. The status still
        // rides as a title for hover / screen readers.
        const nameSpan = document.createElement('span');
        nameSpan.className = 'file-name';
        nameSpan.setAttribute('style', 'color: ' + node.statusColor + ';');
        nameSpan.setAttribute('title', node.status);
        nameSpan.textContent = node.fileName;
        item.appendChild(nameSpan);
        if (node.status === 'renamed' && node.oldPath) {
          item.appendChild(document.createTextNode(' '));
          const arrow = document.createElement('span');
          arrow.className = 'rename-arrow';
          arrow.textContent = '←';
          item.appendChild(arrow);
          item.appendChild(document.createTextNode(' '));
          const oldPath = document.createElement('span');
          oldPath.className = 'old-path';
          oldPath.setAttribute('title', node.oldPath);
          oldPath.textContent = node.oldPath;
          item.appendChild(oldPath);
        }
        // Per-file line diff: "(+N | -M)" with +N green and -M red.
        // Shown only when there is at least one changed line (binary /
        // no-line-change files carry no counts).
        const adds = typeof node.additions === 'number' ? node.additions : 0;
        const dels = typeof node.deletions === 'number' ? node.deletions : 0;
        if (adds > 0 || dels > 0) {
          const stats = document.createElement('span');
          stats.className = 'changed-file-stats';
          stats.appendChild(document.createTextNode('('));
          const addSpan = document.createElement('span');
          addSpan.className = 'changed-file-add';
          addSpan.textContent = '+' + adds;
          stats.appendChild(addSpan);
          stats.appendChild(document.createTextNode(' | '));
          const delSpan = document.createElement('span');
          delSpan.className = 'changed-file-del';
          delSpan.textContent = '-' + dels;
          stats.appendChild(delSpan);
          stats.appendChild(document.createTextNode(')'));
          item.appendChild(stats);
        }
        parent.appendChild(item);
      }
    });
  }
}
