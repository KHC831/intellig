/// <reference lib="dom" />
// Webview entry for the Define Remote dialog (bundled into
// media/webview/defineRemoteDialog.js). Reads init from the host's `data-init`
// island, builds the name + URL form, validates on every keystroke, and posts
// protocol-typed submit/cancel. The host answers with `busy` (the ls-remote
// probe) and `error` (probe or git failure), neither of which closes the form.

import type {
  IDefineRemoteDialogInit,
  DefineRemoteDialogInbound,
  DefineRemoteDialogOutbound,
} from '../defineRemoteDialog.protocol';
import { validateRemoteName, validateRemoteUrl } from '../remoteValidation';
import { INIT_ELEMENT_ID, parseInitIsland } from '../../utils/webviewInit';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscodeApi = acquireVsCodeApi();

function post(message: DefineRemoteDialogInbound): void {
  vscodeApi.postMessage(message);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Partial<HTMLElementTagNameMap[K]>
): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props ?? {});
}

/** One labelled text field plus the error line that sits under it. */
function field(
  id: string,
  labelText: string,
  value: string
): { row: HTMLDivElement; input: HTMLInputElement; error: HTMLDivElement } {
  const row = el('div', { className: 'row' });
  const label = el('label', { className: 'block', htmlFor: id, textContent: labelText });
  const input = el('input', { type: 'text', id, value, spellcheck: false });
  const error = el('div', { className: 'field-error', id: id + '-error' });
  row.append(label, input);
  const wrapper = el('div');
  wrapper.append(row, error);
  return { row: wrapper, input, error };
}

function render(init: IDefineRemoteDialogInit): void {
  const root = document.getElementById('root');
  if (!root) {
    return;
  }

  const name = field('remote-name', 'Name:', init.name);
  const url = field('remote-url', 'URL:', init.url);

  const fetchAfter = el('input', { type: 'checkbox', id: 'fetch-after' });
  fetchAfter.checked = init.fetch;
  const fetchLabel = el('label', { className: 'checkbox' });
  fetchLabel.append(fetchAfter, 'Fetch the remote after defining it');

  const formError = el('div', { className: 'form-error', id: 'form-error' });

  const actions = el('div', { className: 'actions' });
  const cancelBtn = el('button', {
    id: 'cancel-btn',
    type: 'button',
    className: 'secondary',
    textContent: 'Cancel',
  });
  const submitBtn = el('button', {
    id: 'submit-btn',
    type: 'button',
    textContent: init.submitLabel,
  });
  actions.append(cancelBtn, submitBtn);

  root.append(name.row, url.row, fetchLabel, formError, actions);

  let busy = false;

  /** Re-run validation and gate the submit button on it. */
  const validate = (): boolean => {
    const nameError = validateRemoteName(
      name.input.value.trim(),
      init.existingNames,
      init.originalName ?? undefined
    );
    const urlError = validateRemoteUrl(url.input.value.trim());
    name.error.textContent = nameError ?? '';
    url.error.textContent = urlError ?? '';
    const valid = !nameError && !urlError;
    submitBtn.disabled = busy || !valid;
    return valid;
  };

  const setBusy = (next: boolean): void => {
    busy = next;
    name.input.disabled = next;
    url.input.disabled = next;
    validate();
  };

  const submit = (): void => {
    if (busy || !validate()) {
      return;
    }
    formError.textContent = '';
    post({
      type: 'submit',
      name: name.input.value.trim(),
      url: url.input.value.trim(),
      fetch: fetchAfter.checked,
    });
  };
  const cancel = (): void => {
    post({ type: 'cancel' });
  };

  name.input.addEventListener('input', validate);
  // Editing the URL clears the host's last verdict on it, mirroring
  // GitDefineRemoteDialog's clearUrlAccessErrorOnTextChanged.
  url.input.addEventListener('input', () => {
    formError.textContent = '';
    validate();
  });
  submitBtn.addEventListener('click', submit);
  cancelBtn.addEventListener('click', cancel);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });

  window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data as DefineRemoteDialogOutbound | undefined;
    if (!msg || typeof msg.type !== 'string') {
      return;
    }
    if (msg.type === 'busy') {
      setBusy(Boolean(msg.busy));
      return;
    }
    if (msg.type === 'error') {
      formError.textContent = typeof msg.message === 'string' ? msg.message : '';
      setBusy(false);
      return;
    }
  });

  validate();
  (init.name.length === 0 ? name.input : url.input).focus();
}

// Plain panels self-boot: the bundle runs this on load (no inline caller).
function boot(): void {
  const island = document.getElementById(INIT_ELEMENT_ID);
  const init = parseInitIsland<IDefineRemoteDialogInit>(island?.getAttribute('data-init'));
  render(init);
}

boot();
