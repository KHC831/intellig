/// <reference lib="dom" />
// Webview entry for the Rebase dialog (bundled into media/webview/rebaseDialog.js).
// Reads init from the host's `data-init` island, builds the onto/newbase selects
// + option checkboxes, and posts a protocol-typed rebase/cancel.

import type { IRebaseDialogInit, RebaseDialogInbound } from '../rebaseDialog.protocol';
import { INIT_ELEMENT_ID, parseInitIsland } from '../../utils/webviewInit';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscodeApi = acquireVsCodeApi();

function post(message: RebaseDialogInbound): void {
  vscodeApi.postMessage(message);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Partial<HTMLElementTagNameMap[K]>
): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props ?? {});
}

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function render(init: IRebaseDialogInit): void {
  const root = document.getElementById('root');
  if (!root) {
    return;
  }
  const optionIds = init.optionCheckboxes.map((o) => o.id);

  const summary = el('div', { className: 'summary' });
  const summaryRow = el('div');
  summaryRow.append(
    el('span', { className: 'label', textContent: 'Branch:' }),
    init.currentBranch + ' (current)'
  );
  summary.append(summaryRow);

  const ontoField = el('div', { className: 'field' });
  const ontoLabel = el('label', {
    className: 'field-label',
    htmlFor: 'onto-select',
    textContent: 'Rebase onto:',
  });
  const ontoSelectEl = el('select', { id: 'onto-select' });
  ontoSelectEl.disabled = init.rootDisablesOnto;
  for (const name of init.branchChoices) {
    const opt = el('option', { value: name, textContent: name });
    opt.selected = name === init.onto;
    ontoSelectEl.append(opt);
  }
  ontoField.append(ontoLabel, ontoSelectEl);

  const newbaseField = el('div', { className: 'field' });
  const newbaseLabel = el('label', {
    className: 'field-label',
    htmlFor: 'newbase-select',
    textContent: 'New base (--onto):',
  });
  const newbaseSelectEl = el('select', { id: 'newbase-select' });
  newbaseSelectEl.append(el('option', { value: '', textContent: '(none — rebase onto upstream)' }));
  for (const name of init.branchChoices) {
    newbaseSelectEl.append(el('option', { value: name, textContent: name }));
  }
  newbaseField.append(newbaseLabel, newbaseSelectEl);

  const interactiveLabel = el('label', { className: 'flag' });
  interactiveLabel.setAttribute('data-flag', 'interactive');
  const interactiveInput = el('input', { type: 'checkbox', id: 'flag-interactive' });
  interactiveInput.checked = init.interactiveDefault;
  const interactiveText = el('span', { className: 'label-text' });
  interactiveText.append(
    el('span', { className: 'title-line', textContent: 'Interactive' }),
    el('span', {
      className: 'desc',
      textContent: 'Open the rebase todo editor to reorder, squash, edit, or drop commits.',
    })
  );
  interactiveLabel.append(interactiveInput, interactiveText);

  const fieldset = el('fieldset', { id: 'rebase-options', className: 'rebase-options' });
  fieldset.append(el('legend', { className: 'rebase-options-legend', textContent: 'Options' }));
  for (const o of init.optionCheckboxes) {
    const label = el('label', { className: 'flag' });
    label.setAttribute('data-flag', o.id);
    const input = el('input', { type: 'checkbox', id: 'flag-' + o.id });
    input.checked = o.checked;
    const text = el('span', { className: 'label-text' });
    const titleLine = el('span', { className: 'title-line', textContent: o.title + ' ' });
    titleLine.append(el('code', { textContent: o.flag }));
    text.append(titleLine, el('span', { className: 'desc', textContent: o.desc }));
    label.append(input, text);
    fieldset.append(label);
  }

  const actions = el('div', { className: 'actions' });
  actions.append(
    el('button', {
      id: 'cancel-btn',
      type: 'button',
      className: 'secondary',
      textContent: 'Cancel',
    }),
    el('button', { id: 'rebase-btn', type: 'button', textContent: 'Rebase' })
  );

  root.append(summary, ontoField, newbaseField, interactiveLabel, fieldset, actions);

  const interactiveBox = byId<HTMLInputElement>('flag-interactive');
  const optionsFieldset = byId<HTMLFieldSetElement>('rebase-options');
  const ontoSelect = byId<HTMLSelectElement>('onto-select');
  const newbaseSelect = byId<HTMLSelectElement>('newbase-select');
  const rootBox = byId<HTMLInputElement>('flag-root');

  // Flag options + the --onto newbase apply to the non-interactive rebase only;
  // the interactive path hands off to the todo editor. Disable them while
  // Interactive is checked so the UI never implies they'd take effect.
  const syncOptionsEnabled = (): void => {
    const disabled = interactiveBox.checked;
    optionsFieldset.classList.toggle('disabled', disabled);
    newbaseSelect.disabled = disabled;
    for (const id of optionIds) {
      byId<HTMLInputElement>('flag-' + id).disabled = disabled;
    }
    syncOntoEnabled();
  };
  // When --root is checked the onto target is irrelevant; disable the selector.
  const syncOntoEnabled = (): void => {
    ontoSelect.disabled = rootBox.checked && !interactiveBox.checked;
  };
  rootBox.addEventListener('change', syncOntoEnabled);
  interactiveBox.addEventListener('change', syncOptionsEnabled);
  syncOptionsEnabled();

  const submit = (): void => {
    const msg: RebaseDialogInbound = {
      type: 'rebase',
      onto: ontoSelect.value,
      newBase: newbaseSelect.value,
      interactive: interactiveBox.checked,
    };
    for (const id of optionIds) {
      (msg as Record<string, unknown>)[id] = byId<HTMLInputElement>('flag-' + id).checked;
    }
    post(msg);
  };
  const cancel = (): void => {
    post({ type: 'cancel' });
  };
  byId<HTMLButtonElement>('rebase-btn').addEventListener('click', submit);
  byId<HTMLButtonElement>('cancel-btn').addEventListener('click', cancel);

  // Dialog keyboard contract: Cmd/Ctrl+Enter → Rebase; Esc → Cancel.
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
  const init = parseInitIsland<IRebaseDialogInit>(island?.getAttribute('data-init'));
  render(init);
}

boot();
