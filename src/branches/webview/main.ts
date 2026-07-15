/// <reference lib="dom" />
// Webview entry for the New Branch dialog (bundled into
// media/webview/newBranchDialog.js). Reads init from the host's `data-init`
// island, live-validates the name via branchNameValidator (the same validator
// the host uses), and refines its state from the host's `conflicts` message.

import type {
  INewBranchDialogInit,
  NewBranchDialogInbound,
  NewBranchDialogOutbound,
} from '../newBranchDialog.protocol';
import { INIT_ELEMENT_ID, parseInitIsland } from '../../utils/webviewInit';
import { validateBranchName } from '../branchNameValidator';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscodeApi = acquireVsCodeApi();

function post(message: NewBranchDialogInbound): void {
  vscodeApi.postMessage(message);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Partial<HTMLElementTagNameMap[K]>
): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props ?? {});
}

interface IConflictSources {
  localBranches: string[];
  remoteBranches: string[];
  currentBranch: string;
}

function render(init: INewBranchDialogInit): void {
  const root = document.getElementById('root');
  if (!root) {
    return;
  }

  const summary = el('div', { className: 'summary' });
  summary.append(
    el('span', { className: 'label', textContent: 'Start point:' }),
    init.startPointLabel
  );

  const field = el('div', { className: 'field' });
  const nameLabel = el('label', {
    className: 'top',
    htmlFor: 'branch-name',
    textContent: 'New branch name:',
  });
  const nameInput = el('input', {
    type: 'text',
    id: 'branch-name',
    placeholder: 'feature/my-new-branch',
    value: init.defaultName,
  });
  const nameErr = el('div', { id: 'name-error', className: 'error' });
  field.append(nameLabel, nameInput, nameErr);

  const flagsBox = el('div', { className: 'flags' });
  const flagRow = (id: string, checked: boolean, parts: (string | Node)[]): HTMLLabelElement => {
    const label = el('label', { className: 'flag' });
    const input = el('input', { type: 'checkbox', id });
    input.checked = checked;
    label.append(input, ...parts);
    return label;
  };
  const trackRow = flagRow('flag-track', init.defaultTrack, [
    'Track remote (',
    el('code', { textContent: '--track' }),
    ')',
  ]);
  trackRow.id = 'track-row';
  trackRow.hidden = !init.trackVisible;
  flagsBox.append(
    trackRow,
    flagRow('flag-overwrite', false, [
      'Overwrite if exists (',
      el('code', { textContent: '-f' }),
      ' / ',
      el('code', { textContent: '-B' }),
      ')',
    ]),
    flagRow('flag-checkout', true, ['Checkout after create'])
  );

  const actions = el('div', { className: 'actions' });
  actions.append(
    el('button', {
      id: 'cancel-btn',
      type: 'button',
      className: 'secondary',
      textContent: 'Cancel',
    }),
    el('button', { id: 'create-btn', type: 'button', textContent: 'Create' })
  );

  root.append(summary, field, flagsBox, actions);
  nameInput.focus();

  const nameEl = document.getElementById('branch-name') as HTMLInputElement;
  const errorEl = document.getElementById('name-error') as HTMLDivElement;
  const createBtn = document.getElementById('create-btn') as HTMLButtonElement;
  const overwriteEl = document.getElementById('flag-overwrite') as HTMLInputElement;

  // Existing-branch conflict sources, pushed from the host once the branch list
  // loads (NewBranchDialog._postConflictContext).
  let conflicts: IConflictSources = { localBranches: [], remoteBranches: [], currentBranch: '' };

  // Same validator the host uses — no client-side mirror to drift. Overwrite
  // maps to `git branch -f`, which bypasses only the local-branch conflict.
  const validate = (): string =>
    validateBranchName(nameEl.value, conflicts, { allowExistingLocal: overwriteEl.checked }) ?? '';

  const refresh = (): void => {
    const err = validate();
    errorEl.textContent = err;
    createBtn.disabled = !!err;
  };

  nameEl.addEventListener('input', refresh);
  overwriteEl.addEventListener('change', refresh);

  window.addEventListener('message', (e: MessageEvent) => {
    const m = e.data as NewBranchDialogOutbound | undefined;
    if (m && m.type === 'conflicts') {
      conflicts = {
        localBranches: m.localBranches || [],
        remoteBranches: m.remoteBranches || [],
        currentBranch: m.currentBranch || '',
      };
      if (m.startPointTrackable === false) {
        (document.getElementById('track-row') as HTMLElement).hidden = true;
        (document.getElementById('flag-track') as HTMLInputElement).checked = false;
      } else if (m.startPointTrackable === true) {
        (document.getElementById('track-row') as HTMLElement).hidden = false;
      }
      refresh();
    }
  });

  createBtn.addEventListener('click', () => {
    const err = validate();
    if (err) {
      errorEl.textContent = err;
      createBtn.disabled = true;
      nameEl.focus();
      return;
    }
    post({
      type: 'create',
      name: nameEl.value.trim(),
      track: (document.getElementById('flag-track') as HTMLInputElement).checked,
      overwrite: overwriteEl.checked,
      checkout: (document.getElementById('flag-checkout') as HTMLInputElement).checked,
    });
  });
  (document.getElementById('cancel-btn') as HTMLButtonElement).addEventListener('click', () => {
    post({ type: 'cancel' });
  });
  nameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      createBtn.click();
    }
  });

  // Dialog keyboard contract (shared across all dialogs):
  //   Cmd/Ctrl+Enter → primary (Create); Esc → Cancel.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      (document.getElementById('create-btn') as HTMLButtonElement).click();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      (document.getElementById('cancel-btn') as HTMLButtonElement).click();
    }
  });

  refresh();
}

// Plain panels self-boot: the bundle runs this on load (no inline caller).
function boot(): void {
  const island = document.getElementById(INIT_ELEMENT_ID);
  const init = parseInitIsland<INewBranchDialogInit>(island?.getAttribute('data-init'));
  render(init);
}

boot();
