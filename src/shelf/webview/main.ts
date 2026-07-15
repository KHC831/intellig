/// <reference lib="dom" />
// Webview entry for the Shelve Changes dialog (bundled by esbuild into
// media/webview/shelveDialog.js). Reads its initial state from the host's
// `data-init` island and posts protocol-typed messages back — the same DOM and
// wire behavior the inline string script had, now compiled against
// shelveDialog.protocol.ts so a field drift is a compile error.

import type { IShelveDialogInit, ShelveDialogInbound } from '../shelveDialog.protocol';
import { INIT_ELEMENT_ID, parseInitIsland } from '../../utils/webviewInit';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscodeApi = acquireVsCodeApi();

function post(message: ShelveDialogInbound): void {
  vscodeApi.postMessage(message);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Partial<HTMLElementTagNameMap[K]>
): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props ?? {});
}

function render(init: IShelveDialogInit): void {
  const root = document.getElementById('root');
  if (!root) {
    return;
  }

  const field = el('div', { className: 'field' });
  field.append(el('label', { className: 'top', htmlFor: 'shelve-name', textContent: 'Name:' }));
  const nameInput = el('input', {
    type: 'text',
    id: 'shelve-name',
    placeholder: 'Shelf name',
    value: init.defaultName,
  });
  field.append(nameInput);

  const filesHeader = el('div', { className: 'files-header' });
  const masterLabel = el('label');
  masterLabel.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;';
  const masterCb = el('input', { type: 'checkbox', id: 'shelve-master' });
  masterLabel.append(masterCb, el('span', { textContent: 'Changes' }));
  const countSpan = el('span', { id: 'shelve-count' });
  filesHeader.append(masterLabel, countSpan);

  const filesBox = el('div', { className: 'files' });
  if (init.files.length === 0) {
    filesBox.append(el('div', { className: 'empty', textContent: 'No changes to shelve' }));
  }
  for (const f of init.files) {
    const row = el('div', { className: 'file-row' });
    const cb = el('input', { type: 'checkbox', className: 'shelve-file-checkbox' });
    cb.checked = f.selected;
    cb.setAttribute('data-path', f.path);
    const status = el('span', {
      className: 'file-status',
      textContent: f.statusChar,
      title: f.statusLabel,
    });
    status.style.color = f.statusColor;
    row.append(
      cb,
      status,
      el('span', { className: 'file-name', textContent: f.fileName }),
      el('span', { className: 'file-dir', textContent: f.fileDir })
    );
    row.addEventListener('click', (e) => {
      if (e.target !== cb) {
        cb.checked = !cb.checked;
        refresh();
      }
    });
    cb.addEventListener('change', refresh);
    filesBox.append(row);
  }

  const actions = el('div', { className: 'actions' });
  const cancelBtn = el('button', {
    id: 'shelve-cancel-btn',
    type: 'button',
    className: 'secondary',
    textContent: 'Cancel',
  });
  const shelveBtn = el('button', {
    id: 'shelve-btn',
    type: 'button',
    textContent: 'Shelve Changes',
  });
  actions.append(cancelBtn, shelveBtn);

  root.append(field, filesHeader, filesBox, actions);
  nameInput.focus();

  function checkedBoxes(): HTMLInputElement[] {
    return Array.from(
      document.querySelectorAll<HTMLInputElement>('input.shelve-file-checkbox')
    ).filter((b) => b.checked);
  }

  function refresh(): void {
    const all = document.querySelectorAll('input.shelve-file-checkbox');
    const checked = checkedBoxes();
    countSpan.textContent = `${checked.length} of ${all.length} selected`;
    masterCb.checked = all.length > 0 && checked.length === all.length;
    masterCb.indeterminate = checked.length > 0 && checked.length < all.length;
    shelveBtn.disabled = nameInput.value.trim().length === 0 || checked.length === 0;
  }

  masterCb.addEventListener('change', () => {
    const target = masterCb.checked;
    document.querySelectorAll<HTMLInputElement>('input.shelve-file-checkbox').forEach((b) => {
      b.checked = target;
    });
    refresh();
  });
  nameInput.addEventListener('input', refresh);

  function submit(): void {
    if (shelveBtn.disabled) {
      return;
    }
    post({
      type: 'shelve',
      name: nameInput.value.trim(),
      files: checkedBoxes().map((b) => b.getAttribute('data-path') ?? ''),
    });
  }

  shelveBtn.addEventListener('click', submit);
  cancelBtn.addEventListener('click', () => post({ type: 'cancel' }));

  // Dialog keyboard contract (shared across IntelliG dialogs):
  //   Cmd/Ctrl+Enter → primary (Shelve); Esc → Cancel.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelBtn.click();
    }
  });

  refresh();
}

// Plain panels self-boot: the bundle runs this on load (no inline caller, which
// check:no-string-scripts bans). The jsdom harness re-runs it via a cache-busted
// require after seeding the DOM globals + init island.
function boot(): void {
  const island = document.getElementById(INIT_ELEMENT_ID);
  const init = parseInitIsland<IShelveDialogInit>(island?.getAttribute('data-init'));
  render(init);
}

boot();
