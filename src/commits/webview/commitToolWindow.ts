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
import type { ICommitToolWindowInitModel, ICtwChangelistModel } from '../commitToolWindow.types';
import { buttonMenuTrigger, closeButtonMenus, createButtonMenuPanel } from './ctwButtonMenus';
import { buildDiffPreviewPane, renderDiffPreview, resetPreviewPane } from './ctwDiffPreview';
import { INIT_ELEMENT_ID, parseInitIsland } from '../../utils/webviewInit';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

import { cssEscapeAttr, el, setAttrs } from './ctwDom';
import { buildLocalTreeContent } from './ctwLocalTree';
import { CtwContextMenu } from './ctwContextMenu';

const vscodeApi = acquireVsCodeApi();

/**
 * Every outbound message carries the repo its rows were rendered from. Stamped
 * here rather than per call site: the host drops a repo-scoped action whose
 * stamp is stale, and a call site that forgot the field would silently opt out
 * of that guard.
 */
function post(message: CommitToolWindowInbound): void {
  postFrom(message, renderedRepoRoot);
}

/**
 * Post stamped with an explicit root. A context-menu pick is a SECOND message,
 * sent after the host answered the right-click, and the view can retarget in
 * between — so a pick carries the root captured at the gesture rather than the
 * one the view has drifted to.
 */
function postFrom(message: CommitToolWindowInbound, repoRoot: string | undefined): void {
  vscodeApi.postMessage({ ...message, repoRoot });
}

/**
 * Repo root the rendered rows belong to. Echoed on every file action so the
 * host can drop a click that lands after the selector retargeted the view.
 */
let renderedRepoRoot: string | undefined;

/**
 * The Commit window's context menu. Drawn here under the pointer; WHAT it
 * contains still comes from the host, so the label helpers keep one home.
 */
const contextMenu = new CtwContextMenu({
  onPick: (target, action): void => {
    // The row the menu was opened on decides which channel answers, and which
    // repo the action is stamped with.
    if (target.rowKind) {
      postFrom(
        {
          type: 'shelfTabContextAction',
          action,
          rowKind: target.rowKind,
          shelfId: target.shelfId,
          stashIndex: target.stashIndex,
          stashSha: target.stashSha,
        },
        target.repoRoot
      );
      return;
    }
    postFrom(
      {
        type: 'changelistContextAction',
        action,
        changelistId: target.changelistId,
        path: target.path,
      },
      target.repoRoot
    );
  },
});

/** Path currently shown in the diff preview pane (undefined = placeholder). */
let previewedPath: string | undefined;

// ─── Pure builders (shared by boot and applyModel) ───────────────────────────

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
  const menu = createButtonMenuPanel('ctw-primary-menu');
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
  setAttrs(row, { tabindex: -1 });
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
    if (entry.hash) {
      // The index names a SLOT; popping a stash elsewhere renumbers the stack
      // and hands that slot to a different stash. The sha is what says which
      // stash a row is, so a menu opened on one can tell it has moved.
      setAttrs(row, { 'data-stash-sha': entry.hash });
    }
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
    if (cl.conflicts && cl.conflicts.files.some((f) => f.path === path)) {
      return true;
    }
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
  // A menu anchored to a row from another repo must not stay up. Only on an
  // actual retarget: a routine refresh redraws the same rows, and closing the
  // menu under the user on every watcher tick would be its own bug.
  if (renderedRepoRoot !== model.repoRoot) {
    contextMenu.hide();
    contextMenu.cancelPending();
  }
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

  // The rows an open menu points at have just been replaced. Same row redrawn:
  // the menu stays, so a background tick does not close it under the user.
  // After applyChrome, not before: it owns which panel is showing, and a row
  // in the hidden one is not on screen either.
  contextMenu.revalidate();

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
      post({ type: 'selectFile', path: previewedPath });
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
    const gearMenu = createButtonMenuPanel('ctw-gear-menu');
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
 * The row's own controls are excluded here once rather than at each gesture.
 */
function fileRowPathFrom(e: Event): string | undefined {
  if (!(e.target instanceof Element)) {
    return undefined;
  }
  // The row's own controls are not the row: a gesture on the checkbox is an
  // include/exclude toggle, and one on Resolve already opens the merge window.
  // Without this a double-click on Resolve opens that window twice AND the
  // row's diff on top.
  if ((e.target as HTMLElement).tagName === 'INPUT' || e.target.closest('.ctw-file-resolve')) {
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
      // Resolve on the Merge Conflicts header: the host dialog over every
      // unmerged file, the same surface the status-bar badge reaches.
      if (e.target.closest('.ctw-conflicts-resolve')) {
        e.preventDefault();
        post({ type: 'resolveConflicts' });
        return;
      }
      // Per-row Resolve: the merge window for that one file. Handled in this
      // same listener rather than a second one, because two listeners on this
      // node both run regardless of stopPropagation — the row would get
      // selected as well and open a second surface for one press.
      const rowResolve = e.target.closest('.ctw-file-resolve');
      if (rowResolve) {
        e.preventDefault();
        const path = rowResolve.getAttribute('data-path');
        if (path) {
          post({ type: 'resolveConflictFile', path });
        }
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
        post({ type: 'selectFile', path });
      }
    });
    // Double-click opens the file's diff in an editor tab (single click only
    // fills the inline preview pane). The checkbox is excluded: two fast
    // clicks there are an include/exclude toggle, not a request to open.
    localTree.addEventListener('dblclick', (e) => {
      const path = fileRowPathFrom(e);
      if (path) {
        post({ type: 'openFileDiff', path });
      }
    });
    localTree.addEventListener('change', (e) => {
      if (!(e.target instanceof Element) || !e.target.classList.contains('ctw-file-check')) {
        return;
      }
      const path = e.target.getAttribute('data-path');
      if (path) {
        post({ type: 'toggleFile', path });
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
    // The gear/commit-dropdown panels are plain divs outside the ContextMenu
    // widget registry, so rememberClick's own hide() cannot reach them — this
    // is the one call that can.
    closeButtonMenus();
    // The pointer is gone by the time the host answers with the item list, so
    // hold the position now and draw there when the reply lands.
    const me = e as MouseEvent;
    // Shelf/stash rows answer on their own channel — same menu, same drawing.
    if (row.classList.contains('ctw-shelf-row')) {
      const rowKind = row.getAttribute('data-row-kind');
      const shelfId = row.getAttribute('data-shelf-id');
      const stashIdxAttr = row.getAttribute('data-stash-index');
      const kind = rowKind === 'shelf' || rowKind === 'stash' ? rowKind : undefined;
      const stashIndex = stashIdxAttr === null ? undefined : Number(stashIdxAttr);
      const stashSha = row.getAttribute('data-stash-sha') || undefined;
      contextMenu.rememberClick(
        me.clientX || 0,
        me.clientY || 0,
        {
          rowKind: kind,
          shelfId: shelfId || undefined,
          stashIndex,
          stashSha,
          repoRoot: renderedRepoRoot,
        },
        row as HTMLElement
      );
      post({
        type: 'shelfTabContextAction',
        action: 'contextOpen',
        rowKind: kind,
        shelfId: shelfId || undefined,
        stashIndex,
      });
      return;
    }
    const path = row.getAttribute('data-path');
    const changelistId = row.getAttribute('data-changelist');
    contextMenu.rememberClick(
      me.clientX || 0,
      me.clientY || 0,
      {
        path: path ?? undefined,
        changelistId: changelistId ?? undefined,
        repoRoot: renderedRepoRoot,
      },
      row as HTMLElement
    );
    post({
      type: 'changelistContextAction',
      action: 'contextOpen',
      changelistId: changelistId ?? undefined,
      path: path ?? undefined,
    });
  });

  // Dismissal: a click anywhere outside, or Escape. Capture phase so a click
  // that also lands on a row still closes the menu first.
  document.addEventListener(
    'click',
    (e) => {
      const clicked = e.target instanceof Node ? e.target : null;
      closeButtonMenus(clicked, buttonMenuTrigger(clicked));
      if (clicked && contextMenu.isOpen && contextMenu.contains(clicked)) {
        return;
      }
      // Also drops an unanswered right-click: a reply arriving after the user
      // clicked away would otherwise open the menu where the pointer used to be.
      contextMenu.hide();
    },
    true
  );

  // Losing the window dismisses too. VS Code delivers no click to a webview
  // document when focus moves to the editor or another view, so without this
  // the menu stays painted over the Commit view until the user clicks back in.
  window.addEventListener('blur', () => {
    closeButtonMenus();
    contextMenu.hide();
  });

  // The shared key router answers Escape only while a menu is OPEN. A
  // right-click whose reply is still in flight has drawn nothing yet, and that
  // pending gesture is this window's own state. Escape is a global dismiss
  // key, so it answers every menu this window has, the same as losing the
  // window does.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeButtonMenus();
      contextMenu.hide();
    }
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
    if (m.type === 'showRowContextMenu' && Array.isArray(m.items)) {
      contextMenu.show(
        {
          path: m.path,
          changelistId: m.changelistId,
          rowKind: m.rowKind,
          shelfId: m.shelfId,
          stashIndex: m.stashIndex,
        },
        m.items
      );
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
