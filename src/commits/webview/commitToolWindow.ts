/// <reference lib="dom" />
// Webview entry for the Commit Tool Window (bundled into
// media/webview/commitToolWindow.js). Reads its render model from the host's
// `data-init` island, builds every panel via createElement, and posts
// protocol-typed messages.
//
// The DOM splits into a PERSISTENT skeleton (tab strip, the two panels, diff
// preview pane, composer) built once at boot, and two replaceable content
// containers (`#ctw-local-tree`, `#ctw-shelf-list`) that both boot and the
// host's `updateModel` messages fill from the same pure builders. A live
// update therefore can never touch composer text, focus, or the tab strip —
// the invariant that keeps background refreshes from stomping user input.
// Row/checkbox/filter/grouping events are DELEGATED on the persistent
// containers, so a content swap cannot orphan listeners.

import type {
  CommitToolWindowInbound,
  CommitToolWindowOutbound,
} from '../commitToolWindow.protocol';
import type {
  ICommitToolWindowInitModel,
  ICtwChangelistModel,
  ICtwFileEntry,
} from '../commitToolWindow.types';
import { buildDiffPreviewPane, renderDiffPreview, resetPreviewPane } from './ctwDiffPreview';
import { INIT_ELEMENT_ID, parseInitIsland } from '../../utils/webviewInit';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscodeApi = acquireVsCodeApi();

function post(message: CommitToolWindowInbound): void {
  vscodeApi.postMessage(message);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Partial<HTMLElementTagNameMap[K]>
): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props ?? {});
}

function setAttrs<T extends Element>(
  node: T,
  attrs: Record<string, string | number | boolean | null | undefined>
): T {
  for (const k in attrs) {
    const v = attrs[k];
    if (v !== null && v !== undefined) {
      node.setAttribute(k, String(v));
    }
  }
  return node;
}

// Escape a value before splicing it into an attribute selector
// ([data-path="<path>"]). Prefers the native CSS.escape (present in the
// Chromium webview), falls back to a minimal escaper under test DOMs that lack
// the CSS global. A filename may legally contain a backslash on POSIX, which a
// quote-only escape would leave as an invalid selector that throws.
function cssEscapeAttr(value: string): string {
  const s = String(value);
  const cssGlobal = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS;
  if (cssGlobal && typeof cssGlobal.escape === 'function') {
    return cssGlobal.escape(s);
  }
  return s.replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\' + ch);
}

/**
 * Repo root the rendered rows belong to. Echoed on every file action so the
 * host can drop a click that lands after the selector retargeted the view.
 */
let renderedRepoRoot: string | undefined;

/** Path currently shown in the diff preview pane (undefined = placeholder). */
let previewedPath: string | undefined;

// ─── Pure builders (shared by boot and applyModel) ───────────────────────────

function buildFileRow(
  f: ICtwFileEntry,
  changelistId: string,
  selected: ReadonlySet<string>
): HTMLDivElement {
  const row = el('div', { className: 'ctw-file-row' });
  setAttrs(row, { 'data-path': f.path, 'data-changelist': changelistId });
  const chk = el('input', {
    type: 'checkbox',
    className: 'ctw-file-check',
    checked: selected.has(f.path),
  });
  setAttrs(chk, { 'data-path': f.path });
  row.appendChild(chk);
  row.appendChild(el('span', { className: 'ctw-file-status', textContent: f.statusChar }));
  row.appendChild(el('span', { className: 'ctw-file-path', textContent: f.displayName }));
  return row;
}

// Append a changelist's files into its block, honoring grouping. Flat mode
// appends file rows directly; directory mode wraps each bucket in a
// .ctw-dir-group (with an optional .ctw-dir-row header).
function appendChangelistFiles(
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

function buildChangelistBlock(
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
  setAttrs(header, { 'data-changelist': cl.id });
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
  appendChangelistFiles(block, cl, selected);
  return block;
}

function buildGroupingToggle(model: ICommitToolWindowInitModel): HTMLDivElement {
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
function buildLocalTreeContent(model: ICommitToolWindowInitModel): DocumentFragment {
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

function buildComposerPanel(model: ICommitToolWindowInitModel): HTMLDivElement {
  const c = model.composer;
  const wrap = el('div', { className: 'ctw-composer' });
  const row = el('div', { className: 'ctw-composer-row' });
  const ta = el('textarea', { className: 'ctw-composer-msg', value: c.message });
  setAttrs(ta, { placeholder: 'Commit message' });
  row.appendChild(ta);
  wrap.appendChild(row);
  const opts = el('div', { className: 'ctw-composer-options' });
  const checkbox = (cls: string, checked: boolean, label: string): HTMLLabelElement => {
    const lbl = el('label');
    const input = el('input', { type: 'checkbox', className: cls, checked: !!checked });
    lbl.appendChild(input);
    lbl.appendChild(document.createTextNode(' ' + label));
    return lbl;
  };
  opts.appendChild(checkbox('ctw-chk-amend', c.amend, 'Amend'));
  opts.appendChild(checkbox('ctw-chk-signoff', c.signOff, 'Sign-off'));
  wrap.appendChild(opts);
  const actions = el('div', { className: 'ctw-composer-actions' });
  const group = el('div', { className: 'ctw-primary-group' });
  const commitBtn = el('button', { className: 'ctw-btn-commit', textContent: 'Commit' });
  setAttrs(commitBtn, { type: 'button' });
  group.appendChild(commitBtn);
  const dropdown = el('button', { className: 'ctw-btn-commit-dropdown', textContent: '▾' });
  setAttrs(dropdown, { type: 'button', 'aria-haspopup': 'menu' });
  group.appendChild(dropdown);
  actions.appendChild(group);
  const menu = el('div', { className: 'ctw-primary-menu', hidden: true });
  const cap = el('button', {
    className: 'ctw-btn-commit-and-push',
    textContent: 'Commit and Push…',
  });
  setAttrs(cap, { type: 'button' });
  menu.appendChild(cap);
  actions.appendChild(menu);
  wrap.appendChild(actions);
  return wrap;
}

function buildShelfFilterHeader(model: ICommitToolWindowInitModel): HTMLDivElement {
  const wrap = el('div', { className: 'ctw-shelf-filter' });
  setAttrs(wrap, { role: 'radiogroup', 'aria-label': 'Show' });
  wrap.appendChild(el('span', { className: 'ctw-shelf-filter-label', textContent: 'Show:' }));
  const btn = (value: string, label: string): HTMLButtonElement => {
    const b = el('button', {
      className:
        'ctw-shelf-filter-btn' + (model.shelf.filter === value ? ' ctw-shelf-filter-active' : ''),
      textContent: label,
    });
    setAttrs(b, { 'data-shelf-filter': value, 'aria-pressed': model.shelf.filter === value });
    return b;
  };
  wrap.appendChild(btn('shelves', 'Shelves'));
  wrap.appendChild(btn('stashes', 'Stashes'));
  wrap.appendChild(btn('both', 'Both'));
  return wrap;
}

function buildShelfRow(entry: ICommitToolWindowInitModel['shelf']['rows'][number]): HTMLDivElement {
  const row = el('div', { className: 'ctw-shelf-row' });
  setAttrs(row, { role: 'listitem' });
  if (entry.kind === 'shelf') {
    setAttrs(row, { 'data-row-kind': 'shelf', 'data-shelf-id': entry.id });
    const badge = el('span', { className: 'ctw-shelf-badge', textContent: '📚' });
    setAttrs(badge, { title: 'Shelf entry' });
    row.appendChild(badge);
    const name = el('span', { className: 'ctw-shelf-name' });
    name.appendChild(document.createTextNode(entry.name));
    if (entry.alreadyUnshelved) {
      name.appendChild(document.createTextNode(' '));
      name.appendChild(
        el('span', {
          className: 'ctw-shelf-alreadyUnshelved',
          textContent: '(already unshelved)',
        })
      );
    }
    row.appendChild(name);
    row.appendChild(
      el('span', {
        className: 'ctw-shelf-count',
        textContent: entry.fileCount + ' file' + (entry.fileCount === 1 ? '' : 's'),
      })
    );
  } else {
    setAttrs(row, { 'data-row-kind': 'stash', 'data-stash-index': entry.index });
    const badge = el('span', { className: 'ctw-shelf-badge', textContent: '📦' });
    setAttrs(badge, { title: 'Git stash' });
    row.appendChild(badge);
    row.appendChild(el('span', { className: 'ctw-shelf-name', textContent: entry.name }));
    row.appendChild(el('span', { className: 'ctw-shelf-count', textContent: entry.id }));
  }
  return row;
}

/** Filter header + rows (or empty note) — the replaceable Shelf content. */
function buildShelfListContent(model: ICommitToolWindowInitModel): DocumentFragment {
  const frag = document.createDocumentFragment();
  frag.appendChild(buildShelfFilterHeader(model));
  if (model.shelf.empty) {
    frag.appendChild(el('div', { className: 'ctw-empty', textContent: model.shelf.emptyCopy }));
    return frag;
  }
  const list = el('div', { className: 'ctw-shelf-list' });
  setAttrs(list, { role: 'list' });
  model.shelf.rows.forEach((r) => {
    list.appendChild(buildShelfRow(r));
  });
  frag.appendChild(list);
  return frag;
}

// ─── Skeleton lookups ────────────────────────────────────────────────────────

function localPanelEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-panel="localChanges"]');
}

function shelfPanelEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-panel="shelf"]');
}

/** Toggle tab-strip active state, panel visibility, and pane emptiness. */
function applyChrome(model: ICommitToolWindowInitModel): void {
  document.querySelectorAll('.ctw-tab').forEach((tab) => {
    const active = tab.getAttribute('data-tab') === model.activeTab;
    tab.classList.toggle('ctw-tab-active', active);
    setAttrs(tab, { 'aria-selected': active });
  });
  const local = localPanelEl();
  const shelf = shelfPanelEl();
  if (local) {
    local.style.display = model.showLocal ? 'flex' : 'none';
  }
  if (shelf) {
    shelf.style.display = model.showLocal ? 'none' : 'flex';
  }
  // No file rows → nothing to preview; hide the pane instead of showing an
  // idle placeholder under the empty note.
  const pane = document.querySelector<HTMLElement>('[data-diff-preview]');
  if (pane) {
    pane.style.display = model.local.empty ? 'none' : '';
  }
}

function modelHasPath(model: ICommitToolWindowInitModel, path: string): boolean {
  const inChangelist = (cl: ICtwChangelistModel): boolean => {
    if (cl.files && cl.files.some((f) => f.path === path)) {
      return true;
    }
    return !!cl.dirGroups && cl.dirGroups.some((g) => g.files.some((f) => f.path === path));
  };
  if (model.local.changelists.some(inChangelist)) {
    return true;
  }
  return !!model.local.unversioned && inChangelist(model.local.unversioned);
}

/**
 * Apply a host `updateModel` in place. Replaces the two content containers'
 * children from the pure builders, restores panel scroll around the swap, and
 * refreshes or resets the diff preview. Deliberately never reads
 * `model.composer` — a live update must not stomp in-progress typing.
 */
function applyModel(model: ICommitToolWindowInitModel): void {
  renderedRepoRoot = model.repoRoot;
  const localTree = document.getElementById('ctw-local-tree');
  const shelfList = document.getElementById('ctw-shelf-list');
  if (!localTree || !shelfList) {
    return;
  }
  const local = localPanelEl();
  const shelf = shelfPanelEl();
  const localScroll = local ? local.scrollTop : 0;
  const shelfScroll = shelf ? shelf.scrollTop : 0;

  while (localTree.firstChild) {
    localTree.removeChild(localTree.firstChild);
  }
  localTree.appendChild(buildLocalTreeContent(model));
  while (shelfList.firstChild) {
    shelfList.removeChild(shelfList.firstChild);
  }
  shelfList.appendChild(buildShelfListContent(model));

  applyChrome(model);

  if (local) {
    local.scrollTop = localScroll;
  }
  if (shelf) {
    shelf.scrollTop = shelfScroll;
  }

  if (previewedPath !== undefined) {
    if (modelHasPath(model, previewedPath)) {
      // Content may have changed under the preview — ask the host for a
      // fresh diff of the same path.
      post({ type: 'selectFile', path: previewedPath, repoRoot: renderedRepoRoot });
    } else {
      const pane = document.querySelector('[data-diff-preview]');
      if (pane) {
        resetPreviewPane(pane);
      }
      previewedPath = undefined;
    }
  }
}

// ─── Boot render ─────────────────────────────────────────────────────────────

/** Checkbox glyph + label for a gear-menu entry (figure space keeps alignment). */
function gearItemText(label: string, checked: boolean): string {
  return `${checked ? '✓' : ' '} ${label}`;
}

function render(INIT: ICommitToolWindowInitModel): void {
  renderedRepoRoot = INIT.repoRoot;
  function buildTabStrip(): HTMLDivElement {
    const strip = el('div', { className: 'ctw-tab-strip' });
    setAttrs(strip, { role: 'tablist' });
    const tab = (id: string, label: string): HTMLButtonElement => {
      const b = el('button', {
        className: 'ctw-tab' + (INIT.activeTab === id ? ' ctw-tab-active' : ''),
        textContent: label,
      });
      setAttrs(b, { 'data-tab': id, role: 'tab', 'aria-selected': INIT.activeTab === id });
      return b;
    };
    strip.appendChild(tab('localChanges', 'Local Changes'));
    strip.appendChild(tab('shelf', 'Shelf'));
    strip.appendChild(el('div', { className: 'ctw-tab-spacer' }));
    const gearWrap = el('div', { className: 'ctw-gear-wrap' });
    const gear = el('button', { className: 'ctw-gear', textContent: '⚙' });
    setAttrs(gear, { title: 'Options', 'aria-haspopup': 'menu' });
    gearWrap.appendChild(gear);
    const gearMenu = el('div', { className: 'ctw-gear-menu', hidden: true });
    (INIT.gearItems || []).forEach((i) => {
      const item = el('button', {
        className: 'ctw-gear-item',
        textContent: gearItemText(i.label, i.checked),
      });
      setAttrs(item, {
        role: 'menuitemcheckbox',
        'aria-checked': String(i.checked),
        'data-gear-id': i.id,
        'data-gear-label': i.label,
      });
      item.addEventListener('click', () => {
        post({ type: 'gearAction', id: i.id });
        gearMenu.hidden = true;
      });
      gearMenu.appendChild(item);
    });
    gearWrap.appendChild(gearMenu);
    strip.appendChild(gearWrap);
    return strip;
  }

  // Assemble the persistent skeleton into #ctw-root, then fill the two
  // content containers exactly the way applyModel does.
  const root = document.getElementById('ctw-root');
  if (!root) {
    return;
  }
  root.appendChild(buildTabStrip());
  const bodyEl = el('div', { className: 'ctw-body' });

  const localPanel = el('div', { className: 'ctw-panel' });
  setAttrs(localPanel, {
    'data-panel': 'localChanges',
    style: 'display:' + (INIT.showLocal ? 'flex' : 'none') + ';',
  });
  const localTree = el('div');
  localTree.id = 'ctw-local-tree';
  localTree.appendChild(buildLocalTreeContent(INIT));
  localPanel.appendChild(localTree);
  const pane = buildDiffPreviewPane();
  if (INIT.local.empty) {
    pane.style.display = 'none';
  }
  localPanel.appendChild(pane);
  localPanel.appendChild(buildComposerPanel(INIT));
  bodyEl.appendChild(localPanel);

  const shelfPanel = el('div', { className: 'ctw-panel' });
  setAttrs(shelfPanel, {
    'data-panel': 'shelf',
    style: 'display:' + (INIT.showLocal ? 'none' : 'flex') + ';',
  });
  const shelfList = el('div');
  shelfList.id = 'ctw-shelf-list';
  shelfList.appendChild(buildShelfListContent(INIT));
  shelfPanel.appendChild(shelfList);
  bodyEl.appendChild(shelfPanel);
  root.appendChild(bodyEl);

  wireControls();
}

// Snapshot the composer + selected files for a commit / commit-and-push post.
function getComposerPayload(): {
  message: string;
  amend: boolean;
  signOff: boolean;
  files: string[];
} {
  const msgField = document.querySelector<HTMLTextAreaElement>('.ctw-composer-msg');
  const amendChk = document.querySelector<HTMLInputElement>('.ctw-chk-amend');
  const signoffChk = document.querySelector<HTMLInputElement>('.ctw-chk-signoff');
  return {
    message: msgField ? msgField.value : '',
    amend: amendChk ? amendChk.checked : false,
    signOff: signoffChk ? signoffChk.checked : false,
    files: Array.from(document.querySelectorAll<HTMLInputElement>('.ctw-file-check'))
      .filter((c) => c.checked)
      .map((c) => c.getAttribute('data-path'))
      .filter((p): p is string => p !== null),
  };
}

/**
 * The file path a row-targeting mouse event refers to, or undefined. The
 * checkbox is excluded here once rather than at each gesture: two fast clicks
 * on it are an include/exclude toggle, not a request to open.
 */
function fileRowPathFrom(e: Event): string | undefined {
  if (!(e.target instanceof Element) || (e.target as HTMLElement).tagName === 'INPUT') {
    return undefined;
  }
  const row = e.target.closest('.ctw-file-row');
  return row ? (row.getAttribute('data-path') ?? undefined) : undefined;
}

function wireControls(): void {
  // Tab click (persistent nodes → direct listeners).
  document.querySelectorAll('.ctw-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      if (tab === 'localChanges' || tab === 'shelf') {
        post({ type: 'tabChange', tab });
      }
    });
  });

  // Gear toggle (persistent).
  const gear = document.querySelector('.ctw-gear');
  const gearMenu = document.querySelector<HTMLElement>('.ctw-gear-menu');
  if (gear && gearMenu) {
    gear.addEventListener('click', () => {
      gearMenu.hidden = !gearMenu.hidden;
    });
  }

  // Local Changes content — DELEGATED on the persistent container, so rows
  // and controls rebuilt by applyModel keep working without re-wiring.
  const localTree = document.getElementById('ctw-local-tree');
  if (localTree) {
    localTree.addEventListener('click', (e) => {
      if (!(e.target instanceof Element)) {
        return;
      }
      const groupingBtn = e.target.closest('.ctw-grouping-btn');
      if (groupingBtn) {
        const g = groupingBtn.getAttribute('data-grouping');
        if (g === 'flat' || g === 'directory') {
          post({ type: 'changesGroupingChange', grouping: g });
        }
        return;
      }
      const path = fileRowPathFrom(e);
      // Already previewed: a double-click's second click would otherwise spawn
      // a redundant `git diff` for the row the pane is already showing. The
      // host-side re-request in applyModel stays unconditional — content there
      // may genuinely have changed.
      if (path && path !== previewedPath) {
        post({ type: 'selectFile', path, repoRoot: renderedRepoRoot });
      }
    });
    // Double-click opens the file's diff in an editor tab (single click only
    // fills the inline preview pane). The checkbox is excluded: two fast
    // clicks there are an include/exclude toggle, not a request to open.
    localTree.addEventListener('dblclick', (e) => {
      const path = fileRowPathFrom(e);
      if (path) {
        post({ type: 'openFileDiff', path, repoRoot: renderedRepoRoot });
      }
    });
    localTree.addEventListener('change', (e) => {
      if (!(e.target instanceof Element) || !e.target.classList.contains('ctw-file-check')) {
        return;
      }
      const path = e.target.getAttribute('data-path');
      if (path) {
        post({ type: 'toggleFile', path, repoRoot: renderedRepoRoot });
      }
    });
  }

  // Shelf content — delegated filter clicks; row clicks are reserved (the
  // host acts on right-clicks only).
  const shelfList = document.getElementById('ctw-shelf-list');
  if (shelfList) {
    shelfList.addEventListener('click', (e) => {
      if (!(e.target instanceof Element)) {
        return;
      }
      const btn = e.target.closest('.ctw-shelf-filter-btn');
      if (!btn) {
        return;
      }
      const f = btn.getAttribute('data-shelf-filter');
      if (f === 'shelves' || f === 'stashes' || f === 'both') {
        post({ type: 'shelfTabFilterChange', filter: f });
      }
    });
  }

  // Right-click on a changelist row or file row → send a context-action ping to
  // the host. Host decides what menu to present (keeps the menu labels in one
  // place — changelistContextMenuLabels / fileContextMenuLabels in the host).
  document.addEventListener('contextmenu', (e) => {
    if (!(e.target instanceof Element)) {
      return;
    }
    const row = e.target.closest('.ctw-changelist-row, .ctw-file-row, .ctw-shelf-row');
    if (!row) {
      return;
    }
    e.preventDefault();
    // Shelf/stash rows take precedence — they open a QuickPick via a dedicated
    // host message rather than the changelist-flavored context-action.
    if (row.classList.contains('ctw-shelf-row')) {
      const rowKind = row.getAttribute('data-row-kind');
      const shelfId = row.getAttribute('data-shelf-id');
      const stashIdxAttr = row.getAttribute('data-stash-index');
      post({
        type: 'shelfTabContextAction',
        action: 'contextOpen',
        rowKind: rowKind === 'shelf' || rowKind === 'stash' ? rowKind : undefined,
        shelfId: shelfId || undefined,
        stashIndex: stashIdxAttr === null ? undefined : Number(stashIdxAttr),
      });
      return;
    }
    const path = row.getAttribute('data-path');
    const changelistId = row.getAttribute('data-changelist');
    post({
      type: 'changelistContextAction',
      repoRoot: renderedRepoRoot,
      action: 'contextOpen',
      changelistId: changelistId ?? undefined,
      path: path ?? undefined,
    });
  });

  // Composer fields (persistent).
  const msgField = document.querySelector<HTMLTextAreaElement>('.ctw-composer-msg');
  const amendChk = document.querySelector<HTMLInputElement>('.ctw-chk-amend');
  const signoffChk = document.querySelector<HTMLInputElement>('.ctw-chk-signoff');
  if (msgField) {
    msgField.addEventListener('input', () => {
      post({ type: 'updateComposerField', message: msgField.value });
    });
  }
  if (amendChk) {
    amendChk.addEventListener('change', () => {
      post({ type: 'updateComposerField', amend: amendChk.checked });
    });
  }
  if (signoffChk) {
    signoffChk.addEventListener('change', () => {
      post({ type: 'updateComposerField', signOff: signoffChk.checked });
    });
  }

  // Primary commit button + Commit-and-Push dropdown (persistent).
  const commitBtn = document.querySelector('.ctw-btn-commit');
  const commitDropdownBtn = document.querySelector('.ctw-btn-commit-dropdown');
  const commitPushMenu = document.querySelector<HTMLElement>('.ctw-primary-menu');
  const commitAndPushBtn = document.querySelector('.ctw-btn-commit-and-push');
  if (commitBtn) {
    commitBtn.addEventListener('click', () => {
      post({ type: 'commit', ...getComposerPayload() });
    });
  }
  if (commitDropdownBtn && commitPushMenu) {
    commitDropdownBtn.addEventListener('click', () => {
      commitPushMenu.hidden = !commitPushMenu.hidden;
    });
  }
  if (commitAndPushBtn) {
    commitAndPushBtn.addEventListener('click', () => {
      post({ type: 'commitAndPush', ...getComposerPayload() });
      if (commitPushMenu) {
        commitPushMenu.hidden = true;
      }
    });
  }

  // Host → webview updates. `updateModel` swaps the two content subtrees in
  // place (composer untouched); `setComposerMessage` is the explicit prefill
  // write; the rest are fine-grained patches.
  window.addEventListener('message', (ev: MessageEvent) => {
    const m = ev.data as CommitToolWindowOutbound | undefined;
    if (!m || typeof m.type !== 'string') {
      return;
    }
    if (m.type === 'updateModel' && m.model) {
      applyModel(m.model);
    }
    if (m.type === 'setComposerMessage' && typeof m.message === 'string') {
      const field = document.querySelector<HTMLTextAreaElement>('.ctw-composer-msg');
      if (field) {
        // No updateComposerField echo: the host set its mirror before
        // posting, so both sides already agree.
        field.value = m.message;
      }
    }
    if (m.type === 'setGearState' && typeof m.noVerify === 'boolean') {
      const item = document.querySelector<HTMLButtonElement>(
        '.ctw-gear-item[data-gear-id="toggleNoVerify"]'
      );
      if (item) {
        item.setAttribute('aria-checked', String(m.noVerify));
        item.textContent = gearItemText(item.getAttribute('data-gear-label') ?? '', m.noVerify);
      }
    }
    if (m.type === 'updateFileCheckbox' && typeof m.path === 'string') {
      const box = document.querySelector<HTMLInputElement>(
        '.ctw-file-check[data-path="' + cssEscapeAttr(m.path) + '"]'
      );
      if (box) {
        box.checked = !!m.checked;
      }
    }
    if (m.type === 'updateDiffPreview') {
      const pane = document.querySelector('[data-diff-preview]');
      if (pane) {
        previewedPath = m.path;
        renderDiffPreview(pane, m.path, m.diff, m.error);
      }
    }
    if (m.type === 'commitDone' && m.success) {
      const doneField = document.querySelector<HTMLTextAreaElement>('.ctw-composer-msg');
      if (doneField) {
        doneField.value = '';
      }
      // Mirror the host's post-commit composer reset: the commit payload reads
      // this checkbox from the DOM, so a stuck box would silently amend the
      // commit that was just made. Sign-off is a sticky preference and stays.
      const amendChk = document.querySelector<HTMLInputElement>('.ctw-chk-amend');
      if (amendChk) {
        amendChk.checked = false;
      }
    }
  });
}

// Plain panels self-boot: the bundle runs this on load (no inline caller).
function boot(): void {
  const island = document.getElementById(INIT_ELEMENT_ID);
  const init = parseInitIsland<ICommitToolWindowInitModel>(island?.getAttribute('data-init'));
  previewedPath = undefined;
  render(init);
}

boot();
