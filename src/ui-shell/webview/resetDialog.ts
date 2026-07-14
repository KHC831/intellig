/// <reference lib="dom" />
// Webview entry for the Reset dialog (bundled into media/webview/resetDialog.js).
// Reads init from the host's `data-init` island, builds the reset-mode radios,
// and posts a protocol-typed reset/cancel.

import type { ResetMode } from '../../git-core/interfaces/resetMode';
import type { IResetDialogInit, ResetDialogInbound } from '../resetDialog.protocol';
import { INIT_ELEMENT_ID, parseInitIsland } from '../../utils/webviewInit';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscodeApi = acquireVsCodeApi();

function post(message: ResetDialogInbound): void {
  vscodeApi.postMessage(message);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Partial<HTMLElementTagNameMap[K]>
): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props ?? {});
}

interface IModeRow {
  mode: ResetMode;
  label: string;
  desc: string;
  warn: boolean;
}

const MODES: IModeRow[] = [
  { mode: 'soft', label: 'Soft', desc: 'Keep changes staged', warn: false },
  { mode: 'mixed', label: 'Mixed', desc: 'Keep changes unstaged (default)', warn: false },
  { mode: 'hard', label: 'Hard', desc: 'Discard all changes', warn: true },
  { mode: 'keep', label: 'Keep', desc: 'Discard committed, keep local', warn: true },
];

function render(init: IResetDialogInit): void {
  const root = document.getElementById('root');
  if (!root) {
    return;
  }

  const target = el('div', { className: 'target' });
  target.append(
    el('span', { className: 'hash', textContent: init.shortHash }),
    el('span', { className: 'subject', textContent: init.subject })
  );

  const modesBox = el('div', { className: 'modes' });
  modesBox.setAttribute('role', 'radiogroup');
  modesBox.setAttribute('aria-label', 'Reset mode');
  for (const m of MODES) {
    const disabled = init.disabledModes.includes(m.mode);
    const label = el('label', { className: 'mode' });
    label.setAttribute('data-mode', m.mode);
    if (disabled) {
      label.setAttribute('title', init.protectedTooltip);
    }
    const input = el('input', { type: 'radio', name: 'reset-mode', value: m.mode });
    input.checked = m.mode === init.effectiveDefault;
    input.disabled = disabled;
    const text = el('span', { className: 'label-text' });
    text.append(
      el('span', { className: 'title-line' + (m.warn ? ' warn' : ''), textContent: m.label }),
      el('span', { className: 'desc', textContent: m.desc })
    );
    label.append(input, text);
    modesBox.append(label);
  }

  const actions = el('div', { className: 'actions' });
  actions.append(
    el('button', {
      id: 'cancel-btn',
      type: 'button',
      className: 'secondary',
      textContent: 'Cancel',
    }),
    el('button', { id: 'reset-btn', type: 'button', textContent: 'Reset' })
  );

  root.append(target, modesBox, actions);

  const submit = (): void => {
    const checked = document.querySelector<HTMLInputElement>('input[name="reset-mode"]:checked');
    const mode = (checked ? checked.value : 'mixed') as ResetMode;
    post({ type: 'reset', mode });
  };
  const cancel = (): void => {
    post({ type: 'cancel' });
  };
  (document.getElementById('reset-btn') as HTMLButtonElement).addEventListener('click', submit);
  (document.getElementById('cancel-btn') as HTMLButtonElement).addEventListener('click', cancel);

  // Dialog keyboard contract (shared across all dialogs): Cmd/Ctrl+Enter →
  // Reset; Esc → Cancel. Destructive Hard/Keep still routes through the modal
  // confirm in the host handler, so Cmd+Enter never bypasses the safety prompt.
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
  const init = parseInitIsland<IResetDialogInit>(island?.getAttribute('data-init'));
  render(init);
}

boot();
