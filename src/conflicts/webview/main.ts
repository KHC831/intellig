/// <reference lib="dom" />
// Webview entry for the Merge dialog (bundled into media/webview/mergeDialog.js).
// Reads init from the host's `data-init` island, builds the CLI-option form, and
// posts a protocol-typed `merge`/`cancel` message back.

import type { IMergeDialogInit, MergeDialogInbound } from '../mergeDialog.protocol';
import { INIT_ELEMENT_ID, parseInitIsland } from '../../utils/webviewInit';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscodeApi = acquireVsCodeApi();

function post(message: MergeDialogInbound): void {
  vscodeApi.postMessage(message);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Partial<HTMLElementTagNameMap[K]>
): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props ?? {});
}

const FLAGS = [
  {
    id: 'ffOnly',
    title: '--ff-only',
    desc: 'Require a fast-forward merge; abort if not possible.',
  },
  {
    id: 'noFf',
    title: '--no-ff',
    desc: 'Always create a merge commit (even when fast-forward is possible).',
  },
  {
    id: 'squash',
    title: '--squash',
    desc: 'Stage changes from the merge without creating a commit.',
  },
  {
    id: 'noCommit',
    title: '--no-commit',
    desc: 'Stop before committing so the merge can be reviewed.',
  },
  { id: 'noVerify', title: '--no-verify', desc: 'Bypass the pre-merge and commit-message hooks.' },
  {
    id: 'allowUnrelatedHistories',
    title: '--allow-unrelated-histories',
    desc: 'Merge two branches that share no common history.',
  },
];

function checkbox(id: string): HTMLInputElement {
  return document.getElementById('flag-' + id) as HTMLInputElement;
}

function render(init: IMergeDialogInit): void {
  const root = document.getElementById('root');
  if (!root) {
    return;
  }

  const summary = el('div', { className: 'summary' });
  const summaryRow = (label: string, value: string): HTMLDivElement => {
    const row = el('div');
    row.append(el('span', { className: 'label', textContent: label }), value);
    return row;
  };
  summary.append(
    summaryRow('Source:', init.sourceBranch),
    summaryRow('Target:', init.targetBranch)
  );

  const flagsBox = el('div', { className: 'flags' });
  for (const f of FLAGS) {
    const label = el('label', { className: 'flag' });
    label.setAttribute('data-flag', f.id);
    const input = el('input', { type: 'checkbox', id: 'flag-' + f.id });
    const text = el('span', { className: 'label-text' });
    text.append(
      el('span', { className: 'title-line', textContent: f.title }),
      el('span', { className: 'desc', textContent: f.desc })
    );
    label.append(input, text);
    flagsBox.append(label);
  }

  const messageArea = el('div', { className: 'message-area' });
  const messageLabel = el('label', { htmlFor: 'merge-message' });
  messageLabel.append(
    'Merge commit message (optional, maps to ',
    el('code', { textContent: '-m' }),
    '):'
  );
  const messageEl = el('textarea', {
    id: 'merge-message',
    placeholder: 'Enter a merge commit message, or leave blank for git default',
  });
  messageArea.append(messageLabel, messageEl);

  const actions = el('div', { className: 'actions' });
  const cancelBtn = el('button', {
    id: 'cancel-btn',
    type: 'button',
    className: 'secondary',
    textContent: 'Cancel',
  });
  const mergeBtn = el('button', { id: 'merge-btn', type: 'button', textContent: 'Merge' });
  actions.append(cancelBtn, mergeBtn);

  root.append(summary, flagsBox, messageArea, actions);

  const strategyFlags = ['ffOnly', 'noFf', 'squash'];
  const readFlags = (): { ffOnly: boolean; noFf: boolean; squash: boolean; noCommit: boolean } => ({
    ffOnly: checkbox('ffOnly').checked,
    noFf: checkbox('noFf').checked,
    squash: checkbox('squash').checked,
    noCommit: checkbox('noCommit').checked,
  });
  const applyMutex = (lastToggled: string): void => {
    if (!strategyFlags.includes(lastToggled)) {
      return;
    }
    const box = checkbox(lastToggled);
    if (!box || !box.checked) {
      return;
    }
    for (const other of strategyFlags) {
      if (other !== lastToggled) {
        checkbox(other).checked = false;
      }
    }
  };
  for (const flag of strategyFlags) {
    checkbox(flag).addEventListener('change', () => {
      applyMutex(flag);
    });
  }

  const submit = (): void => {
    post({
      type: 'merge',
      flags: readFlags(),
      noVerify: checkbox('noVerify').checked,
      allowUnrelatedHistories: checkbox('allowUnrelatedHistories').checked,
      message: (document.getElementById('merge-message') as HTMLTextAreaElement).value,
    });
  };
  const cancel = (): void => {
    post({ type: 'cancel' });
  };
  mergeBtn.addEventListener('click', submit);
  cancelBtn.addEventListener('click', cancel);

  // Dialog keyboard contract (shared across all dialogs):
  //   Cmd/Ctrl+Enter → primary (Merge); Esc → Cancel.
  // Plain Enter inside the message textarea inserts a newline.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });
}

// Plain panels self-boot: the bundle runs this on load (no inline caller).
function boot(): void {
  const island = document.getElementById(INIT_ELEMENT_ID);
  const init = parseInitIsland<IMergeDialogInit>(island?.getAttribute('data-init'));
  render(init);
}

boot();
