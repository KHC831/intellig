/// <reference lib="dom" />
// Webview entry for the Resolve Conflicts dialog (bundled into
// media/webview/resolveConflictsDialog.js). Reads init from the host's
// `data-init` island, builds the per-file rows + bulk/footer actions, posts
// protocol-typed accept/abort/continue/skip, and applies host→webview
// updateFileStatus patches.

import type {
  IResolveConflictsDialogInit,
  ResolveConflictsDialogInbound,
  ResolveConflictsDialogOutbound,
  ConflictFileStatus,
} from '../resolveConflictsDialog.protocol';
import { INIT_ELEMENT_ID, parseInitIsland } from '../../utils/webviewInit';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscodeApi = acquireVsCodeApi();

function send(message: ResolveConflictsDialogInbound): void {
  vscodeApi.postMessage(message);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Partial<HTMLElementTagNameMap[K]>
): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props ?? {});
}

const PER_PATH_ACTIONS = ['acceptYours', 'acceptTheirs', 'openMergeView'];
const BULK_ACTIONS = ['acceptAllYours', 'acceptAllTheirs', 'abort', 'continue', 'skip'];

function render(init: IResolveConflictsDialogInit): void {
  const root = document.getElementById('root');
  if (!root) {
    return;
  }

  root.append(el('div', { className: 'header', textContent: init.headerText }));

  // Statuses live in this map (updated by updateFileStatus) so the list can
  // re-render on a grouping toggle without losing later resolutions.
  const statuses = new Map<string, ConflictFileStatus>(init.files.map((f) => [f.path, f.status]));
  let grouped = init.groupByDirectory === true;

  const fileList = el('div', { className: 'file-list' });
  fileList.setAttribute('data-role', 'file-list');
  const buildRow = (path: string, displayName: string): HTMLDivElement => {
    const status = statuses.get(path) ?? 'unresolved';
    const row = el('div', { className: 'file-row' });
    row.setAttribute('data-row-path', path);
    row.tabIndex = 0;
    row.addEventListener('dblclick', () => {
      if (statuses.get(path) !== 'resolved') {
        send({ type: 'openMergeView', path });
      }
    });
    row.append(
      el('span', {
        className: 'file-status ' + status,
        textContent: status === 'resolved' ? '✓' : '⚠',
      }),
      el('span', { className: 'file-path', textContent: displayName })
    );
    const actions = el('span', { className: 'file-actions' });
    if (status === 'resolved') {
      actions.append(el('span', { className: 'resolved-label', textContent: 'resolved' }));
    } else {
      const btn = (
        cls: string,
        action: string,
        text: string,
        title?: string
      ): HTMLButtonElement => {
        const b = el('button', { className: 'btn' + (cls ? ' ' + cls : ''), textContent: text });
        b.setAttribute('data-action', action);
        b.setAttribute('data-path', path);
        if (title) {
          b.setAttribute('title', title);
        }
        return b;
      };
      actions.append(
        btn('secondary', 'acceptYours', init.yoursLabel),
        btn('secondary', 'acceptTheirs', init.theirsLabel),
        btn('', 'openMergeView', 'Merge…')
      );
    }
    row.append(actions);
    return row;
  };

  const rebuildList = (): void => {
    fileList.textContent = '';
    if (init.files.length === 0) {
      const empty = el('div', { className: 'file-row' });
      empty.append(
        el('span', {
          className: 'file-path',
          textContent: init.continueVisible
            ? 'All conflicts resolved — click Continue to finish.'
            : 'No conflicted files.',
        })
      );
      fileList.append(empty);
      return;
    }
    if (!grouped) {
      for (const f of init.files) {
        fileList.append(buildRow(f.path, f.path));
      }
      return;
    }
    // Group by directory, first-seen order; root-level files carry no header.
    const dirOf = (p: string): string => {
      const i = p.lastIndexOf('/');
      return i < 0 ? '' : p.slice(0, i);
    };
    const byDir = new Map<string, string[]>();
    for (const f of init.files) {
      const dir = dirOf(f.path);
      const bucket = byDir.get(dir) ?? [];
      bucket.push(f.path);
      byDir.set(dir, bucket);
    }
    for (const [dir, paths] of byDir) {
      if (dir !== '') {
        fileList.append(el('div', { className: 'dir-header', textContent: dir }));
      }
      for (const p of paths) {
        fileList.append(buildRow(p, p.slice(dir === '' ? 0 : dir.length + 1)));
      }
    }
  };
  rebuildList();

  // Roving keyboard access: arrows walk the rows, Enter merges the focused one.
  fileList.addEventListener('keydown', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    // Keys aimed at an in-row control belong to that control — the browser
    // already turns Enter on a button into a click, and resolving the row here
    // too would fire the action twice.
    if (target.closest('button, a, input, select, textarea, [contenteditable]')) {
      return;
    }
    const row = target.closest('[data-row-path]');
    if (!(row instanceof HTMLElement)) {
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const rows = Array.from(fileList.querySelectorAll('[data-row-path]'));
      const next = rows[rows.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1)];
      if (next instanceof HTMLElement) {
        next.focus();
      }
      e.preventDefault();
    } else if (e.key === 'Enter') {
      const path = row.getAttribute('data-row-path');
      if (path && statuses.get(path) !== 'resolved') {
        send({ type: 'openMergeView', path });
      }
    }
  });

  // IntelliJ's persisted "Group files by directory" list option.
  const toggle = el('input', { id: 'group-by-dir', type: 'checkbox' });
  toggle.checked = grouped;
  toggle.addEventListener('change', () => {
    grouped = toggle.checked;
    send({ type: 'setGroupByDirectory', value: grouped });
    rebuildList();
  });
  const toggleLabel = el('label', { className: 'group-toggle' });
  toggleLabel.append(toggle, document.createTextNode('Group files by directory'));
  root.append(toggleLabel, fileList);

  if (init.hasUnresolved) {
    const bulkActions = el('div', { className: 'bulk-actions' });
    const bulkBtn = (action: string, text: string, title: string): HTMLButtonElement => {
      const b = el('button', { className: 'btn secondary', textContent: text });
      b.setAttribute('data-action', action);
      b.setAttribute('title', title);
      return b;
    };
    bulkActions.append(
      el('span', { textContent: 'For all remaining files:' }),
      bulkBtn('acceptAllYours', init.yoursLabel, 'Take your side for every unresolved file'),
      bulkBtn(
        'acceptAllTheirs',
        init.theirsLabel,
        'Take the incoming side for every unresolved file'
      )
    );
    root.append(bulkActions);
  }

  const footer = el('div', { className: 'footer' });
  if (init.canAbort) {
    const b = el('button', { className: 'btn secondary', textContent: 'Abort ' + init.opLabel });
    b.setAttribute('data-action', 'abort');
    footer.append(b);
  }
  if (init.skipVisible) {
    const b = el('button', { className: 'btn secondary', textContent: 'Skip This Commit' });
    b.setAttribute('data-action', 'skip');
    b.setAttribute(
      'title',
      "Drop the current commit and move on to the next one in the rebase sequence. The commit's changes will NOT be applied."
    );
    footer.append(b);
  }
  if (init.continueVisible) {
    const b = el('button', { className: 'btn', textContent: 'Continue' });
    b.setAttribute('data-action', 'continue');
    if (!init.allResolved) {
      b.setAttribute('disabled', 'disabled');
    }
    footer.append(b);
  }
  root.append(footer);

  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) {
      return;
    }
    const action = t.getAttribute('data-action');
    if (!action) {
      return;
    }
    const path = t.getAttribute('data-path') || undefined;
    if (PER_PATH_ACTIONS.includes(action)) {
      if (path) {
        send({ type: action, path } as ResolveConflictsDialogInbound);
      }
    } else if (BULK_ACTIONS.includes(action)) {
      send({ type: action } as ResolveConflictsDialogInbound);
    }
  });

  window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data as ResolveConflictsDialogOutbound | undefined;
    if (!msg) {
      return;
    }
    if (msg.type === 'updateFileStatus') {
      statuses.set(msg.path, msg.status);
      const row = document.querySelector('[data-row-path="' + CSS.escape(msg.path) + '"]');
      if (!row) {
        return;
      }
      const statusEl = row.querySelector('.file-status');
      if (statusEl) {
        statusEl.classList.remove('unresolved', 'resolved');
        statusEl.classList.add(msg.status);
        statusEl.textContent = msg.status === 'resolved' ? '✓' : '⚠';
      }
      const actionsEl = row.querySelector('.file-actions');
      if (actionsEl && msg.status === 'resolved') {
        actionsEl.textContent = '';
        const lbl = document.createElement('span');
        lbl.className = 'resolved-label';
        lbl.textContent = 'resolved';
        actionsEl.appendChild(lbl);
      }
      const rows = document.querySelectorAll('[data-row-path]');
      let allResolved = rows.length > 0;
      rows.forEach((r) => {
        const s = r.querySelector('.file-status');
        if (!s || !s.classList.contains('resolved')) {
          allResolved = false;
        }
      });
      const continueBtn = document.querySelector('[data-action="continue"]');
      if (continueBtn) {
        if (allResolved) {
          continueBtn.removeAttribute('disabled');
        } else {
          continueBtn.setAttribute('disabled', 'disabled');
        }
      }
    }
  });
}

// Plain panels self-boot: the bundle runs this on load (no inline caller).
function boot(): void {
  const island = document.getElementById(INIT_ELEMENT_ID);
  const init = parseInitIsland<IResolveConflictsDialogInit>(island?.getAttribute('data-init'));
  render(init);
}

boot();
