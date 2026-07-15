/// <reference lib="dom" />
// Webview entry for the Commit Tool Window (bundled into
// media/webview/commitToolWindow.js). Reads its render model from the host's
// `data-init` island, builds every panel (tab strip, Local Changes tree, diff
// preview, composer, Shelf list) via createElement, and posts protocol-typed
// messages. A typed host→webview listener syncs file checkboxes, the diff
// preview, and the post-commit message reset.

import type {
  CommitToolWindowInbound,
  CommitToolWindowOutbound,
} from '../commitToolWindow.protocol';
import type {
  ICommitToolWindowInitModel,
  ICtwChangelistModel,
  ICtwFileEntry,
} from '../commitToolWindow.types';
import type { IDiff, IHunk, IDiffLine } from '../../git-core/interfaces/gitModels';
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

function render(INIT: ICommitToolWindowInitModel): void {
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
        disabled: true,
        textContent: i.label,
      });
      setAttrs(item, { title: i.tooltip });
      gearMenu.appendChild(item);
    });
    gearWrap.appendChild(gearMenu);
    strip.appendChild(gearWrap);
    return strip;
  }

  function buildFileRow(f: ICtwFileEntry, changelistId: string): HTMLDivElement {
    const row = el('div', { className: 'ctw-file-row' });
    setAttrs(row, { 'data-path': f.path, 'data-changelist': changelistId });
    const chk = el('input', { type: 'checkbox', className: 'ctw-file-check' });
    setAttrs(chk, { 'data-path': f.path });
    row.appendChild(chk);
    row.appendChild(el('span', { className: 'ctw-file-status', textContent: f.statusChar }));
    row.appendChild(el('span', { className: 'ctw-file-path', textContent: f.displayName }));
    return row;
  }

  // Append a changelist's files into its block, honoring grouping. Flat mode
  // appends file rows directly; directory mode wraps each bucket in a
  // .ctw-dir-group (with an optional .ctw-dir-row header).
  function appendChangelistFiles(block: HTMLElement, cl: ICtwChangelistModel): void {
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
          group.appendChild(buildFileRow(f, cl.id));
        });
        block.appendChild(group);
      });
    } else {
      (cl.files || []).forEach((f) => {
        block.appendChild(buildFileRow(f, cl.id));
      });
    }
  }

  function buildChangelistBlock(
    cl: ICtwChangelistModel,
    opts?: { unversioned?: boolean }
  ): HTMLDivElement {
    const block = el('div', {
      className:
        'ctw-changelist-block' + (opts && opts.unversioned ? ' ctw-unversioned-block' : ''),
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
    appendChangelistFiles(block, cl);
    return block;
  }

  function buildGroupingToggle(): HTMLDivElement {
    const wrap = el('div', { className: 'ctw-grouping' });
    setAttrs(wrap, { role: 'radiogroup', 'aria-label': 'Group by' });
    wrap.appendChild(el('span', { className: 'ctw-grouping-label', textContent: 'Group by:' }));
    const btn = (value: string, label: string): HTMLButtonElement => {
      const b = el('button', {
        className: 'ctw-grouping-btn' + (INIT.grouping === value ? ' ctw-grouping-active' : ''),
        textContent: label,
      });
      setAttrs(b, { 'data-grouping': value, 'aria-pressed': INIT.grouping === value });
      return b;
    };
    wrap.appendChild(btn('directory', 'Directory'));
    wrap.appendChild(btn('flat', 'Flat'));
    return wrap;
  }

  function buildLocalChangesPanel(): DocumentFragment {
    const frag = document.createDocumentFragment();
    frag.appendChild(buildGroupingToggle());
    if (INIT.local.empty) {
      frag.appendChild(
        el('div', { className: 'ctw-empty', textContent: 'No uncommitted changes.' })
      );
      return frag;
    }
    const tree = el('div', { className: 'ctw-changelist-tree' });
    setAttrs(tree, { role: 'tree' });
    INIT.local.changelists.forEach((cl) => {
      tree.appendChild(buildChangelistBlock(cl));
    });
    if (INIT.local.unversioned) {
      tree.appendChild(buildChangelistBlock(INIT.local.unversioned, { unversioned: true }));
    }
    frag.appendChild(tree);
    const pane = el('div', { className: 'ctw-diff-preview' });
    setAttrs(pane, { 'data-diff-preview': '' });
    pane.appendChild(
      el('div', {
        className: 'ctw-diff-preview-empty',
        textContent: 'Select a file to preview changes',
      })
    );
    frag.appendChild(pane);
    return frag;
  }

  function buildComposerPanel(): HTMLDivElement {
    const c = INIT.composer;
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

  function buildShelfFilterHeader(): HTMLDivElement {
    const wrap = el('div', { className: 'ctw-shelf-filter' });
    setAttrs(wrap, { role: 'radiogroup', 'aria-label': 'Show' });
    wrap.appendChild(el('span', { className: 'ctw-shelf-filter-label', textContent: 'Show:' }));
    const btn = (value: string, label: string): HTMLButtonElement => {
      const b = el('button', {
        className:
          'ctw-shelf-filter-btn' + (INIT.shelf.filter === value ? ' ctw-shelf-filter-active' : ''),
        textContent: label,
      });
      setAttrs(b, { 'data-shelf-filter': value, 'aria-pressed': INIT.shelf.filter === value });
      return b;
    };
    wrap.appendChild(btn('shelves', 'Shelves'));
    wrap.appendChild(btn('stashes', 'Stashes'));
    wrap.appendChild(btn('both', 'Both'));
    return wrap;
  }

  function buildShelfRow(
    entry: ICommitToolWindowInitModel['shelf']['rows'][number]
  ): HTMLDivElement {
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

  function buildShelfPanel(): DocumentFragment {
    const frag = document.createDocumentFragment();
    frag.appendChild(buildShelfFilterHeader());
    if (INIT.shelf.empty) {
      frag.appendChild(el('div', { className: 'ctw-empty', textContent: INIT.shelf.emptyCopy }));
      return frag;
    }
    const list = el('div', { className: 'ctw-shelf-list' });
    setAttrs(list, { role: 'list' });
    INIT.shelf.rows.forEach((r) => {
      list.appendChild(buildShelfRow(r));
    });
    frag.appendChild(list);
    return frag;
  }

  // Assemble the tool window into #ctw-root before wiring listeners.
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
  localPanel.appendChild(buildLocalChangesPanel());
  localPanel.appendChild(buildComposerPanel());
  bodyEl.appendChild(localPanel);
  const shelfPanel = el('div', { className: 'ctw-panel' });
  setAttrs(shelfPanel, {
    'data-panel': 'shelf',
    style: 'display:' + (INIT.showLocal ? 'none' : 'flex') + ';',
  });
  shelfPanel.appendChild(buildShelfPanel());
  bodyEl.appendChild(shelfPanel);
  root.appendChild(bodyEl);

  wireControls();
}

// Render a diff into the preview pane. Builds DOM nodes (no innerHTML with
// interpolated content) so a hostile path/line can't inject markup.
function renderDiffPreview(
  pane: Element,
  path: string | undefined,
  diff: IDiff | undefined,
  error: string | undefined
): void {
  while (pane.firstChild) {
    pane.removeChild(pane.firstChild);
  }
  const head = document.createElement('div');
  head.className = 'ctw-diff-preview-head';
  head.textContent = path || '';
  pane.appendChild(head);
  if (error) {
    const err = document.createElement('div');
    err.className = 'ctw-diff-preview-empty';
    err.textContent = 'Failed to load diff: ' + error;
    pane.appendChild(err);
    return;
  }
  if (!diff || diff.binary || !diff.hunks || diff.hunks.length === 0) {
    const note = document.createElement('div');
    note.className = 'ctw-diff-preview-empty';
    note.textContent = diff && diff.binary ? 'Binary file' : 'No changes';
    pane.appendChild(note);
    return;
  }
  const body = document.createElement('pre');
  body.className = 'ctw-diff-preview-body';
  (diff.hunks || []).forEach((hunk: IHunk) => {
    const h = document.createElement('div');
    h.className = 'ctw-diff-hunk-header';
    h.textContent = hunk.header || '';
    body.appendChild(h);
    (hunk.lines || []).forEach((line: IDiffLine) => {
      const rowDiv = document.createElement('div');
      const t = line.type === 'add' ? 'add' : line.type === 'delete' ? 'del' : 'ctx';
      rowDiv.className = 'ctw-diff-line ctw-diff-' + t;
      const prefix = t === 'add' ? '+' : t === 'del' ? '-' : ' ';
      rowDiv.textContent = prefix + (line.content ?? '');
      body.appendChild(rowDiv);
    });
  });
  pane.appendChild(body);
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

function wireControls(): void {
  // Tab click
  document.querySelectorAll('.ctw-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      if (tab === 'localChanges' || tab === 'shelf') {
        post({ type: 'tabChange', tab });
      }
    });
  });

  // Gear toggle
  const gear = document.querySelector('.ctw-gear');
  const gearMenu = document.querySelector<HTMLElement>('.ctw-gear-menu');
  if (gear && gearMenu) {
    gear.addEventListener('click', () => {
      gearMenu.hidden = !gearMenu.hidden;
    });
  }

  // File row click → selectFile, checkbox change → toggleFile
  document.querySelectorAll('.ctw-file-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target && (e.target as HTMLElement).tagName === 'INPUT') {
        return; // checkbox handled below
      }
      const path = row.getAttribute('data-path');
      if (path) {
        post({ type: 'selectFile', path });
      }
    });
  });
  document.querySelectorAll('.ctw-file-check').forEach((chk) => {
    chk.addEventListener('change', () => {
      const path = chk.getAttribute('data-path');
      if (path) {
        post({ type: 'toggleFile', path });
      }
    });
  });

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
      action: 'contextOpen',
      changelistId: changelistId ?? undefined,
      path: path ?? undefined,
    });
  });

  // Shelf-tab filter segmented control.
  document.querySelectorAll('.ctw-shelf-filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const f = btn.getAttribute('data-shelf-filter');
      if (f === 'shelves' || f === 'stashes' || f === 'both') {
        post({ type: 'shelfTabFilterChange', filter: f });
      }
    });
  });

  // Local Changes grouping segmented control (Directory / Flat).
  document.querySelectorAll('.ctw-grouping-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const g = btn.getAttribute('data-grouping');
      if (g === 'flat' || g === 'directory') {
        post({ type: 'changesGroupingChange', grouping: g });
      }
    });
  });

  // Plain click on a shelf-tab row is reserved — the host doesn't currently act
  // on row clicks, but the listener keeps the hook point discoverable.
  document.querySelectorAll('.ctw-shelf-row').forEach((row) => {
    row.addEventListener('click', () => {
      // Reserved — host doesn't currently act on row clicks.
    });
  });

  // Composer fields
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

  // Primary commit button + Commit-and-Push dropdown
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

  // Host → webview updates. The view consumes incremental checkbox + diff-preview
  // patches and the post-commit message reset; structural changes arrive as a
  // full HTML re-render from the host, not through this listener.
  window.addEventListener('message', (ev: MessageEvent) => {
    const m = ev.data as CommitToolWindowOutbound | undefined;
    if (!m || typeof m.type !== 'string') {
      return;
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
        renderDiffPreview(pane, m.path, m.diff, m.error);
      }
    }
    if (m.type === 'commitDone' && m.success) {
      const msgField = document.querySelector<HTMLTextAreaElement>('.ctw-composer-msg');
      if (msgField) {
        msgField.value = '';
      }
    }
  });
}

// Plain panels self-boot: the bundle runs this on load (no inline caller).
function boot(): void {
  const island = document.getElementById(INIT_ELEMENT_ID);
  const init = parseInitIsland<ICommitToolWindowInitModel>(island?.getAttribute('data-init'));
  render(init);
}

boot();
