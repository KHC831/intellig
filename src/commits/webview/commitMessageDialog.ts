/// <reference lib="dom" />
// Webview entry for the Commit Message dialog (bundled into
// media/webview/commitMessageDialog.js). Reads init from the host's `data-init`
// island and posts protocol-typed submit/cancel.

import type {
  ICommitMessageDialogInit,
  CommitMessageDialogInbound,
} from '../commitMessageDialog.protocol';
import { INIT_ELEMENT_ID, parseInitIsland } from '../../utils/webviewInit';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscodeApi = acquireVsCodeApi();

function post(message: CommitMessageDialogInbound): void {
  vscodeApi.postMessage(message);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Partial<HTMLElementTagNameMap[K]>
): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props ?? {});
}

function render(init: ICommitMessageDialogInit): void {
  const root = document.getElementById('root');
  if (!root) {
    return;
  }

  const heading = el('h2', { textContent: init.heading });

  const helper = el('p', { className: 'helper' });
  helper.append(
    'Edit the commit message below. Press ',
    el('kbd', { textContent: (init.isMac ? 'Cmd' : 'Ctrl') + '+Enter' }),
    ' to ' + init.submitVerb + ', or ',
    el('kbd', { textContent: 'Esc' }),
    ' to cancel.'
  );

  const msgEl = el('textarea', { id: 'msg', spellcheck: false });
  msgEl.value = init.seedMessage;

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

  root.append(heading, helper, msgEl, actions);

  // Place caret at the end of the seed so the user can keep typing.
  msgEl.setSelectionRange(msgEl.value.length, msgEl.value.length);
  msgEl.focus();

  const submit = (): void => {
    post({ type: 'submit', message: msgEl.value });
  };
  const cancel = (): void => {
    post({ type: 'cancel' });
  };

  submitBtn.addEventListener('click', submit);
  cancelBtn.addEventListener('click', cancel);

  // Keyboard: Cmd/Ctrl+Enter → submit; Esc → cancel. Plain Enter inserts a
  // newline (textarea default) so multi-line composition works naturally.
  msgEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.activeElement !== msgEl) {
      e.preventDefault();
      cancel();
    }
  });
}

// Plain panels self-boot: the bundle runs this on load (no inline caller).
function boot(): void {
  const island = document.getElementById(INIT_ELEMENT_ID);
  const init = parseInitIsland<ICommitMessageDialogInit>(island?.getAttribute('data-init'));
  render(init);
}

boot();
