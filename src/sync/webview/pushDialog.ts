/// <reference lib="dom" />
// Webview entry for the Push dialog (bundled into media/webview/pushDialog.js).
// Reads init from the host's `data-init` island, builds the repo table + overflow
// options + action bar, posts protocol-typed messages, and applies the host's
// incremental patchRow/patchOverflow patches (a full re-render would steal focus).

import type {
  IPushDialogInit,
  PushDialogInbound,
  PushDialogOutbound,
} from '../pushDialog.protocol';
import { INIT_ELEMENT_ID, parseInitIsland } from '../../utils/webviewInit';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscodeApi = acquireVsCodeApi();

function post(message: PushDialogInbound): void {
  vscodeApi.postMessage(message);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Partial<HTMLElementTagNameMap[K]>
): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props ?? {});
}

const HINTS = {
  noVerify: 'Skip the pre-push git hook (--no-verify).',
  all: 'All tags: pushes every local tag to the remote — both lightweight tags (plain "git tag") and annotated ones — no matter which branch they sit on.',
  follow:
    'Follow tags: pushes only annotated tags (made with a message, like release tags) that sit on the commits you are pushing. Plain lightweight tags are left behind — use "All tags" to include them.',
};

function applyPrimary(
  primary: { label: string; action: string; anyProtected: boolean; canSubmit: boolean } | undefined
): void {
  if (!primary) {
    return;
  }
  const btn = document.getElementById('push-btn') as HTMLButtonElement | null;
  if (btn) {
    btn.textContent = primary.label;
    btn.disabled = !primary.canSubmit;
  }
  const sel = document.getElementById('action-select') as HTMLSelectElement | null;
  if (sel) {
    if (sel.value !== primary.action) {
      sel.value = primary.action;
    }
    for (let i = 0; i < sel.options.length; i++) {
      const opt = sel.options[i];
      // Protected targets prohibit ALL force pushes — both flavors.
      if (opt.value === 'force' || opt.value === 'forceWithLease') {
        opt.disabled = !!primary.anyProtected;
      }
    }
  }
}

function render(init: IPushDialogInit): void {
  const root = document.getElementById('root');
  if (!root) {
    return;
  }

  if (init.empty) {
    root.append(el('div', { textContent: 'Nothing to push — no repositories are available.' }));
    const emptyActions = el('div', { className: 'actions' });
    const closeBtn = el('button', {
      id: 'cancel-btn',
      type: 'button',
      textContent: 'Cancel',
    });
    closeBtn.addEventListener('click', () => {
      post({ type: 'cancel' });
    });
    emptyActions.append(closeBtn);
    root.append(emptyActions);
    return;
  }

  const table = el('table');
  const thead = el('thead');
  const headRow = el('tr');
  const th0 = el('th');
  th0.setAttribute('style', 'width:30px');
  // Revision rows render a commit hash in the source cell, so the label follows
  // the rows rather than claiming they are all branches.
  const anyRevisionRow = init.rows.some((r) => r.sourceHash);
  headRow.append(
    th0,
    el('th', { textContent: 'Repository' }),
    el('th', { textContent: anyRevisionRow ? 'Source' : 'Branch' }),
    el('th', { textContent: 'Target' }),
    el('th', { textContent: 'Commits' })
  );
  thead.append(headRow);
  const tbody = el('tbody', { id: 'rows' });
  for (const r of init.rows) {
    const tr = el('tr');
    tr.setAttribute('data-row-id', r.id);
    if (r.protected) {
      tr.setAttribute('data-protected', '1');
    }
    const c0 = el('td');
    const cb = el('input', { type: 'checkbox', className: 'row-select' });
    cb.checked = r.selected;
    cb.setAttribute('data-row-id', r.id);
    c0.append(cb);
    const c3 = el('td');
    const ti = el('input', { type: 'text', className: 'row-target', value: r.targetBranch });
    ti.setAttribute('data-row-id', r.id);
    c3.append(ti);
    const c4 = el('td');
    c4.append(
      el('span', {
        className: 'badge',
        textContent: r.ahead === 0 ? 'up to date' : String(r.ahead),
      })
    );
    // A revision row shows the pushed commit's short hash as the source —
    // the GitPushSource.OnRevision/DetachedHead presentation — never the
    // branch tip it does not push.
    const sourceCell = r.sourceHash
      ? el('td', { textContent: r.sourceHash.slice(0, 7), title: r.sourceHash })
      : el('td', { textContent: r.localBranch });
    tr.append(c0, el('td', { textContent: r.repoLabel }), sourceCell, c3, c4);
    tbody.append(tr);
    if (r.error) {
      const er = el('tr', { className: 'row-error' });
      er.setAttribute('data-row-id', r.id);
      const td = el('td');
      td.setAttribute('colspan', '5');
      td.append('⚠ ' + r.error.message + ' ');
      if (r.error.kind === 'rejected-non-ff') {
        // No update/retry affordance on a revision row: pulling moves the
        // branch tip but the row's hash is fixed, so a retry cannot become
        // pushable.
        if (!r.sourceHash) {
          const b1 = el('button', { textContent: 'Pull and Retry…' });
          b1.setAttribute('data-action', 'pullAndRetry');
          b1.setAttribute('data-row-id', r.id);
          td.append(b1);
        }
        // No force escape hatch on a protected target — all force pushes
        // are prohibited there.
        if (!r.protected) {
          const b2 = el('button', { textContent: 'Force with Lease' });
          b2.setAttribute('data-action', 'forceWithLease-row');
          b2.setAttribute('data-row-id', r.id);
          td.append(' ', b2);
        }
      } else if (r.error.kind === 'rejected-stale-lease' && !r.protected) {
        // The lease refused because the remote moved after the last fetch;
        // the explicit follow-up re-pushes this row with plain force.
        td.append(
          el('span', {
            textContent: 'The remote was updated after your last fetch. ',
          })
        );
        const b = el('button', { textContent: 'Force Push (Anyway)' });
        b.setAttribute('data-action', 'forceAnyway-row');
        b.setAttribute('data-row-id', r.id);
        td.append(b);
      }
      er.append(td);
      tbody.append(er);
    }
  }
  table.append(thead, tbody);
  root.append(table);

  root.append(el('a', { className: 'edit-all', id: 'edit-all', textContent: 'Edit all targets' }));

  const overflow = el('div', { className: 'overflow' });
  const labelled = (input: HTMLElement, text: string): HTMLLabelElement => {
    const l = el('label');
    l.append(input, text);
    return l;
  };
  const noVerify = el('input', { type: 'checkbox', id: 'no-verify' });
  noVerify.checked = init.overflow.noVerify;
  const pushTags = el('input', { type: 'checkbox', id: 'push-tags' });
  pushTags.checked = init.overflow.pushTags;
  const tagScope = el('select', { id: 'tag-scope' });
  tagScope.setAttribute('aria-label', 'Tag scope');
  const tagAll = el('option', { value: 'all', textContent: 'All tags' });
  tagAll.selected = init.overflow.tagScope === 'all';
  const tagFollow = el('option', { value: 'follow', textContent: 'Follow tags' });
  tagFollow.selected = init.overflow.tagScope === 'follow';
  tagScope.append(tagAll, tagFollow);
  tagScope.disabled = !init.overflow.pushTags;
  const tagsGroup = el('span', { className: 'tags-group' });
  tagsGroup.append(labelled(pushTags, 'Push tags'), tagScope);
  overflow.append(labelled(noVerify, '--no-verify'), tagsGroup);
  root.append(overflow);
  const tagHint = el('div', { id: 'tag-hint', className: 'hint' });
  root.append(tagHint);
  const updateHint = (): void => {
    const parts: string[] = [];
    if (noVerify.checked) {
      parts.push(HINTS.noVerify);
    }
    if (pushTags.checked) {
      parts.push(tagScope.value === 'follow' ? HINTS.follow : HINTS.all);
    }
    tagHint.textContent = parts.join(' ');
  };
  updateHint();

  const actionsBar = el('div', { className: 'actions' });
  const cancelBtn = el('button', {
    id: 'cancel-btn',
    className: 'secondary',
    type: 'button',
    textContent: 'Cancel',
  });
  const actionSelect = el('select', { id: 'action-select' });
  actionSelect.setAttribute('aria-label', 'Push action');
  const optPush = el('option', { value: 'push', textContent: 'Push' });
  optPush.selected = init.primaryAction === 'push';
  const optLease = el('option', { value: 'forceWithLease', textContent: 'Force Push with Lease' });
  optLease.selected = init.primaryAction === 'forceWithLease';
  optLease.disabled = init.anyProtected;
  const optForce = el('option', { value: 'force', textContent: 'Force Push (Anyway)…' });
  optForce.selected = init.primaryAction === 'force';
  optForce.disabled = init.anyProtected;
  actionSelect.append(optPush, optLease, optForce);
  const pushBtn = el('button', {
    id: 'push-btn',
    type: 'button',
    textContent: init.primaryLabel,
  });
  pushBtn.disabled = !init.canSubmit;
  actionsBar.append(cancelBtn, actionSelect, pushBtn);
  root.append(actionsBar);

  const postRowPatch = (
    rowId: string,
    patch: { selected?: boolean; targetBranch?: string }
  ): void => {
    post({ type: 'updateRow', rowId, rowPatch: patch });
  };
  (document.getElementById('rows') as HTMLElement).addEventListener('change', (e) => {
    const target = e.target as HTMLInputElement;
    const rowId = target.getAttribute('data-row-id');
    if (!rowId) {
      return;
    }
    if (target.classList.contains('row-select')) {
      postRowPatch(rowId, { selected: target.checked });
    } else if (target.classList.contains('row-target')) {
      postRowPatch(rowId, { targetBranch: target.value });
    }
  });
  (document.getElementById('rows') as HTMLElement).addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const action = target.getAttribute('data-action');
    const rowId = target.getAttribute('data-row-id');
    if (action && rowId) {
      post({ type: action, rowId } as PushDialogInbound);
    }
  });
  (document.getElementById('edit-all') as HTMLElement).addEventListener('click', () => {
    document.querySelectorAll<HTMLInputElement>('input.row-target').forEach((inp) => {
      inp.focus();
      inp.select();
    });
  });
  const readOverflow = (): {
    noVerify: boolean;
    pushTags: boolean;
    tagScope: 'all' | 'follow';
  } => ({
    noVerify: (document.getElementById('no-verify') as HTMLInputElement).checked,
    pushTags: (document.getElementById('push-tags') as HTMLInputElement).checked,
    tagScope:
      (document.getElementById('tag-scope') as HTMLSelectElement).value === 'all'
        ? 'all'
        : 'follow',
  });
  const syncTagScopeEnabled = (): void => {
    (document.getElementById('tag-scope') as HTMLSelectElement).disabled = !(
      document.getElementById('push-tags') as HTMLInputElement
    ).checked;
  };
  document.querySelectorAll('.overflow input, .overflow select').forEach((inp) => {
    inp.addEventListener('change', () => {
      syncTagScopeEnabled();
      updateHint();
      post({ type: 'updateOverflow', overflow: readOverflow() });
    });
  });
  (document.getElementById('action-select') as HTMLSelectElement).addEventListener(
    'change',
    (e) => {
      post({ type: 'updateOverflow', action: (e.target as HTMLSelectElement).value as never });
    }
  );
  const submit = (): void => {
    const action = (document.getElementById('action-select') as HTMLSelectElement).value;
    post({ type: 'submit', action: action as never });
  };
  const cancel = (): void => {
    post({ type: 'cancel' });
  };
  (document.getElementById('push-btn') as HTMLButtonElement).addEventListener('click', submit);
  (document.getElementById('cancel-btn') as HTMLButtonElement).addEventListener('click', cancel);

  // Dialog keyboard contract: Cmd/Ctrl+Enter → Push; Esc → Cancel. Plain Enter
  // in a row's target input is left to the browser default (no submit mid-edit).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });

  // Apply incremental host→webview patches. Only derived display state is
  // touched; the user's checkbox / text-input value is left alone so the caret
  // doesn't bounce.
  window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data as PushDialogOutbound | undefined;
    if (!msg || typeof msg.type !== 'string') {
      return;
    }
    if (msg.type === 'patchRow' && typeof msg.rowId === 'string') {
      const row = document.querySelector('tr[data-row-id="' + CSS.escape(msg.rowId) + '"]');
      if (row) {
        if (msg.protected) {
          row.setAttribute('data-protected', '1');
        } else {
          row.removeAttribute('data-protected');
        }
      }
      applyPrimary(msg.primary);
      return;
    }
    if (msg.type === 'patchOverflow') {
      applyPrimary(msg.primary);
      return;
    }
  });
}

// Plain panels self-boot: the bundle runs this on load (no inline caller).
function boot(): void {
  const island = document.getElementById(INIT_ELEMENT_ID);
  const init = parseInitIsland<IPushDialogInit>(island?.getAttribute('data-init'));
  render(init);
}

boot();
