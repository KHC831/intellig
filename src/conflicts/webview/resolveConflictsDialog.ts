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

  const fileList = el('div', { className: 'file-list' });
  fileList.setAttribute('data-role', 'file-list');
  const buildRow = (path: string, status: ConflictFileStatus): HTMLDivElement => {
    const row = el('div', { className: 'file-row' });
    row.setAttribute('data-row-path', path);
    row.append(
      el('span', {
        className: 'file-status ' + status,
        textContent: status === 'resolved' ? '✓' : '⚠',
      }),
      el('span', { className: 'file-path', textContent: path })
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
  if (init.files.length > 0) {
    for (const f of init.files) {
      fileList.append(buildRow(f.path, f.status));
    }
  } else {
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
  }
  root.append(fileList);

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
