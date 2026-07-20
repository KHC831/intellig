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

  /**
   * Paint a row from the status map. Both statuses run through here, so an
   * 'unresolved' patch restores the row's actions instead of stranding it
   * behind a stale "resolved" label.
   */
  /**
   * Which file's row currently owns keyboard focus, including focus sitting on
   * a control INSIDE the row. Any rebuild of that row's contents destroys the
   * focused element, so callers capture before and restore after.
   */
  const focusedRowPath = (): string | null | undefined =>
    document.activeElement instanceof HTMLElement
      ? document.activeElement.closest('[data-row-path]')?.getAttribute('data-row-path')
      : undefined;

  const refocusRow = (rowPath: string | null | undefined): void => {
    if (rowPath === undefined || rowPath === null) {
      return;
    }
    const next = fileList.querySelector(`[data-row-path="${CSS.escape(rowPath)}"]`);
    if (next instanceof HTMLElement) {
      next.focus();
    }
  };

  const paintRow = (row: HTMLElement, path: string): void => {
    // Rebuilding .file-actions below destroys a focused button in this row.
    const hadFocus = focusedRowPath() === path;
    const status = statuses.get(path) ?? 'unresolved';
    const statusEl = row.querySelector('.file-status');
    if (statusEl) {
      statusEl.className = 'file-status ' + status;
      statusEl.textContent = status === 'resolved' ? '✓' : '⚠';
    }
    const actions = row.querySelector('.file-actions');
    if (!actions) {
      return;
    }
    actions.textContent = '';
    if (status === 'resolved') {
      actions.append(el('span', { className: 'resolved-label', textContent: 'resolved' }));
      if (hadFocus) {
        row.focus();
      }
      return;
    }
    const btn = (cls: string, action: string, text: string): HTMLButtonElement => {
      const b = el('button', { className: 'btn' + (cls ? ' ' + cls : ''), textContent: text });
      b.setAttribute('data-action', action);
      b.setAttribute('data-path', path);
      return b;
    };
    actions.append(
      btn('secondary', 'acceptYours', init.yoursLabel),
      btn('secondary', 'acceptTheirs', init.theirsLabel),
      btn('', 'openMergeView', 'Merge…')
    );
    if (hadFocus) {
      row.focus();
    }
  };

  const buildRow = (path: string, displayName: string): HTMLDivElement => {
    const row = el('div', { className: 'file-row' });
    row.setAttribute('data-row-path', path);
    row.tabIndex = 0;
    row.addEventListener('dblclick', () => {
      if (statuses.get(path) !== 'resolved') {
        send({ type: 'openMergeView', path });
      }
    });
    row.append(
      el('span', { className: 'file-status' }),
      el('span', { className: 'file-path', textContent: displayName }),
      el('span', { className: 'file-actions' })
    );
    paintRow(row, path);
    return row;
  };

  const rebuildList = (): void => {
    // Every row element is replaced below, so the focused one dies and focus
    // falls to <body>; remember which file had it and hand it back after.
    const focusedPath = focusedRowPath();
    fileList.textContent = '';
    const restoreFocus = (): void => refocusRow(focusedPath);
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
      restoreFocus();
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
    restoreFocus();
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
    bulkBtn('acceptAllTheirs', init.theirsLabel, 'Take the incoming side for every unresolved file')
  );
  const hasUnresolved = (): boolean => [...statuses.values()].some((s) => s !== 'resolved');

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

  /** Offering "for all remaining files" with nothing remaining reads as breakage. */
  const syncBulkVisibility = (): void => {
    if (hasUnresolved()) {
      if (!bulkActions.isConnected) {
        root.insertBefore(bulkActions, footer);
      }
      return;
    }
    // The button that resolves the LAST file lives in this row, so removing it
    // destroys the element the user just pressed. Hand focus to Continue rather
    // than letting it fall to <body>: everything is resolved, so that is where
    // they are going next.
    const losingFocus =
      document.activeElement instanceof HTMLElement && bulkActions.contains(document.activeElement);
    bulkActions.remove();
    if (losingFocus) {
      // Continue first; it is where a user who just resolved everything is
      // going. It may be absent (an operation that cannot continue), so fall
      // back to whatever the footer does offer rather than leaving <body>.
      const target =
        footer.querySelector('[data-action="continue"]:not([disabled])') ??
        footer.querySelector('button:not([disabled])');
      if (target instanceof HTMLElement) {
        target.focus();
      }
    }
  };
  syncBulkVisibility();

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
      const row = fileList.querySelector('[data-row-path="' + CSS.escape(msg.path) + '"]');
      if (row instanceof HTMLElement) {
        paintRow(row, msg.path);
      }
      // Settle Continue's enabled state BEFORE the bulk row may hand focus to
      // it: a disabled button cannot take focus, and the handoff would silently
      // drop to <body>.
      // The status map is authoritative; re-reading DOM classes to answer the
      // same question is a second source of truth waiting to drift.
      const continueBtn = document.querySelector('[data-action="continue"]');
      if (continueBtn) {
        if (statuses.size > 0 && !hasUnresolved()) {
          continueBtn.removeAttribute('disabled');
        } else {
          continueBtn.setAttribute('disabled', 'disabled');
        }
      }
      syncBulkVisibility();
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
