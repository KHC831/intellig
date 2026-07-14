/// <reference lib="dom" />
// Webview entry for the Apply Patch dialog (bundled into
// media/webview/applyPatchDialog.js). Reads init from the host's `data-init`
// island, builds the source/strip/base-dir form, posts protocol-typed messages,
// and applies host→webview patches (chosen path, preview, error).

import type {
  IApplyPatchDialogInit,
  ApplyPatchDialogInbound,
  ApplyPatchDialogOutbound,
} from '../applyPatchDialog.protocol';
import { INIT_ELEMENT_ID, parseInitIsland } from '../../utils/webviewInit';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscodeApi = acquireVsCodeApi();

function post(message: ApplyPatchDialogInbound): void {
  vscodeApi.postMessage(message);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Partial<HTMLElementTagNameMap[K]>
): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props ?? {});
}

function render(init: IApplyPatchDialogInit): void {
  const root = document.getElementById('root');
  if (!root) {
    return;
  }

  const radioLabel = (value: string, text: string, checked: boolean): HTMLLabelElement => {
    const label = el('label');
    const input = el('input', { type: 'radio', name: 'source', value });
    input.checked = checked;
    label.append(input, ' ' + text);
    return label;
  };
  const row = (children: (string | Node)[], cls?: string): HTMLDivElement => {
    const div = el('div', { className: cls ?? 'row' });
    div.append(...children);
    return div;
  };

  root.append(el('h3', { textContent: 'Apply Patch' }));

  root.append(
    row(
      [radioLabel('file', 'From file', true), radioLabel('clipboard', 'From clipboard', false)],
      'source-row'
    )
  );

  const fileRow = el('div', { className: 'row' });
  fileRow.setAttribute('data-row', 'file');
  const patchPathInput = el('input', {
    type: 'text',
    id: 'patchPath',
    readOnly: true,
    placeholder: '(none selected)',
    value: init.patchPath,
  });
  fileRow.append(
    el('label', { className: 'block', textContent: 'Patch file:' }),
    patchPathInput,
    el('button', {
      id: 'browseBtn',
      className: 'secondary',
      type: 'button',
      textContent: 'Browse…',
    })
  );
  root.append(fileRow);

  const stripInput = el('input', {
    type: 'number',
    id: 'stripLevel',
    min: '0',
    max: '10',
    value: '1',
  });
  root.append(
    row([
      el('label', { className: 'block', htmlFor: 'stripLevel', textContent: 'Strip level (-p):' }),
      stripInput,
      el('span', { className: 'hint', textContent: 'Leading path components to strip.' }),
    ])
  );

  root.append(
    row([
      el('label', { className: 'block', htmlFor: 'baseDir', textContent: 'Base directory:' }),
      el('input', { type: 'text', id: 'baseDir', placeholder: '(repository root)' }),
    ])
  );

  const amLabel = el('label');
  const amInput = el('input', { type: 'checkbox', id: 'useAm' });
  amLabel.append(amInput, ' Use ', el('code', { textContent: 'git am' }), ' (preserve author)');
  root.append(row([amLabel]));

  root.append(
    row([
      el('button', {
        id: 'previewBtn',
        className: 'secondary',
        type: 'button',
        textContent: 'Preview…',
      }),
      el('span', {
        className: 'hint',
        textContent: 'Shows the first ' + init.previewLineCap + ' lines of the patch.',
      }),
    ])
  );

  const previewPane = el('div', { className: 'preview', id: 'preview' });
  previewPane.append(
    el('span', {
      className: 'placeholder',
      textContent: 'No preview yet. Click “Preview…” to inspect the patch body.',
    })
  );
  root.append(previewPane);

  root.append(
    row(
      [
        el('button', {
          id: 'cancelBtn',
          className: 'secondary',
          type: 'button',
          textContent: 'Cancel',
        }),
        el('button', { id: 'applyBtn', type: 'button', textContent: 'Apply' }),
      ],
      'actions'
    )
  );

  const source = (): string => {
    const sel = document.querySelector<HTMLInputElement>('input[name="source"]:checked');
    return sel ? sel.value : 'file';
  };
  const patchPath = (): string | undefined => {
    const input = document.getElementById('patchPath') as HTMLInputElement | null;
    return input && input.value ? input.value : undefined;
  };
  const basePayload = (): { patchPath?: string; useClipboard: boolean } => {
    const src = source();
    return {
      patchPath: src === 'file' ? patchPath() : undefined,
      useClipboard: src === 'clipboard',
    };
  };

  (document.getElementById('browseBtn') as HTMLButtonElement).addEventListener('click', () => {
    post({ type: 'browse' });
  });

  const cancel = (): void => {
    post({ type: 'cancel' });
  };
  const apply = (): void => {
    const stripLevelEl = document.getElementById('stripLevel') as HTMLInputElement | null;
    const baseDirEl = document.getElementById('baseDir') as HTMLInputElement | null;
    const useAmEl = document.getElementById('useAm') as HTMLInputElement | null;
    post({
      type: 'apply',
      ...basePayload(),
      useAm: !!(useAmEl && useAmEl.checked),
      stripLevel: stripLevelEl && stripLevelEl.value ? parseInt(stripLevelEl.value, 10) : 1,
      baseDir: baseDirEl && baseDirEl.value ? baseDirEl.value : undefined,
    });
  };

  (document.getElementById('cancelBtn') as HTMLButtonElement).addEventListener('click', cancel);
  (document.getElementById('previewBtn') as HTMLButtonElement).addEventListener('click', () => {
    post({ type: 'preview', ...basePayload() });
  });
  (document.getElementById('applyBtn') as HTMLButtonElement).addEventListener('click', apply);

  // Dialog keyboard contract: Cmd/Ctrl+Enter → Apply; Esc → Cancel.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      apply();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });

  // Source radio toggles the file row's enabled state.
  document.querySelectorAll<HTMLInputElement>('input[name="source"]').forEach((r) => {
    r.addEventListener('change', () => {
      const fr = document.querySelector('[data-row="file"]');
      if (!fr) {
        return;
      }
      const input = fr.querySelector<HTMLInputElement>('input[type="text"]');
      const browse = document.getElementById('browseBtn') as HTMLButtonElement | null;
      const disabled = source() !== 'file';
      if (input) {
        input.disabled = disabled;
      }
      if (browse) {
        browse.disabled = disabled;
      }
    });
  });

  // Host → webview messages.
  window.addEventListener('message', (ev: MessageEvent) => {
    const msg = ev.data as ApplyPatchDialogOutbound | undefined;
    if (!msg) {
      return;
    }
    if (msg.type === 'patchPathChosen') {
      const input = document.getElementById('patchPath') as HTMLInputElement | null;
      if (input) {
        input.value = msg.patchPath;
      }
    } else if (msg.type === 'preview') {
      const pane = document.getElementById('preview');
      if (pane) {
        pane.textContent = msg.content;
      }
    } else if (msg.type === 'error') {
      const pane = document.getElementById('preview');
      if (pane) {
        pane.textContent = '⚠ ' + msg.message;
      }
    }
  });
}

// Plain panels self-boot: the bundle runs this on load (no inline caller).
function boot(): void {
  const island = document.getElementById(INIT_ELEMENT_ID);
  const init = parseInitIsland<IApplyPatchDialogInit>(island?.getAttribute('data-init'));
  render(init);
}

boot();
