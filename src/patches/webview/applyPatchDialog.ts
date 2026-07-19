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
import { applyBlockedReason } from '../applyPatchValidation';

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
    value: String(init.stripLevel),
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
      el('input', {
        type: 'text',
        id: 'baseDir',
        placeholder: '(repository root)',
        value: init.baseDir,
      }),
    ])
  );

  const amLabel = el('label');
  const amInput = el('input', { type: 'checkbox', id: 'useAm' });
  amInput.checked = init.useAm;
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
        textContent:
          'Checks each file and shows the first ' + init.previewLineCap + ' lines of the patch.',
      }),
    ])
  );

  // Per-file dry-run verdicts, above the raw body.
  root.append(el('div', { className: 'check-list', id: 'checkList' }));

  const previewPane = el('div', { className: 'preview', id: 'preview' });
  previewPane.append(
    el('span', {
      className: 'placeholder',
      textContent: 'No preview yet. Click “Preview…” to inspect the patch body.',
    })
  );
  root.append(previewPane);

  root.append(el('div', { className: 'validation', id: 'validation' }));

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
  const stripLevel = (): number => {
    const input = document.getElementById('stripLevel') as HTMLInputElement | null;
    return input && input.value ? parseInt(input.value, 10) : 1;
  };
  const baseDir = (): string | undefined => {
    const input = document.getElementById('baseDir') as HTMLInputElement | null;
    return input && input.value ? input.value : undefined;
  };
  const useAm = (): boolean => {
    const input = document.getElementById('useAm') as HTMLInputElement | null;
    return !!(input && input.checked);
  };
  const optionsPayload = (): {
    patchPath?: string;
    useClipboard: boolean;
    useAm: boolean;
    stripLevel: number;
    baseDir?: string;
  } => ({ ...basePayload(), useAm: useAm(), stripLevel: stripLevel(), baseDir: baseDir() });

  // Apply stays disabled while the form carries a reason not to run, shown
  // inline rather than as a toast after the fact.
  const refreshValidation = (): void => {
    const reason = applyBlockedReason({
      useClipboard: source() === 'clipboard',
      patchPath: patchPath(),
      stripLevel: stripLevel(),
    });
    const banner = document.getElementById('validation');
    if (banner) {
      banner.textContent = reason ?? '';
    }
    const applyBtn = document.getElementById('applyBtn') as HTMLButtonElement | null;
    if (applyBtn) {
      applyBtn.disabled = reason !== undefined;
    }
  };

  // A preview describes the tree as it was when it ran; any change to the
  // inputs (or to the tree itself) can invalidate it, so say so rather than
  // letting a stale verdict look current.
  const markPreviewStale = (
    reason = 'Inputs changed since this preview — run Preview again to re-check.'
  ): void => {
    const list = document.getElementById('checkList');
    if (list && list.childElementCount > 0) {
      list.setAttribute('data-stale', 'true');
      const note = document.getElementById('staleNote');
      if (note) {
        note.textContent = reason;
        return;
      }
      list.prepend(el('div', { id: 'staleNote', className: 'stale', textContent: reason }));
    }
  };

  (document.getElementById('browseBtn') as HTMLButtonElement).addEventListener('click', () => {
    post({ type: 'browse' });
  });

  const cancel = (): void => {
    post({ type: 'cancel' });
  };
  const apply = (): void => {
    if (
      applyBlockedReason({
        useClipboard: source() === 'clipboard',
        patchPath: patchPath(),
        stripLevel: stripLevel(),
      })
    ) {
      return;
    }
    post({ type: 'apply', ...optionsPayload() });
  };

  (document.getElementById('cancelBtn') as HTMLButtonElement).addEventListener('click', cancel);
  (document.getElementById('previewBtn') as HTMLButtonElement).addEventListener('click', () => {
    post({ type: 'preview', ...optionsPayload() });
  });
  (document.getElementById('applyBtn') as HTMLButtonElement).addEventListener('click', apply);

  // Any form change re-gates Apply and retires a now-stale preview verdict.
  ['stripLevel', 'baseDir', 'useAm', 'patchPath'].forEach((id) => {
    const input = document.getElementById(id);
    if (input) {
      input.addEventListener('input', () => {
        refreshValidation();
        markPreviewStale();
      });
      input.addEventListener('change', () => {
        refreshValidation();
        markPreviewStale();
      });
    }
  });

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
      refreshValidation();
      markPreviewStale();
    });
  });

  refreshValidation();

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
      refreshValidation();
      markPreviewStale();
    } else if (msg.type === 'preview') {
      const pane = document.getElementById('preview');
      if (pane) {
        pane.textContent = msg.content;
      }
      const list = document.getElementById('checkList');
      if (list) {
        list.textContent = '';
        list.removeAttribute('data-stale');
        msg.files.forEach((file) => {
          const rowEl = el('div', { className: file.ok ? 'check ok' : 'check bad' });
          rowEl.append(
            el('span', { className: 'check-icon', textContent: file.ok ? '✓' : '✗' }),
            el('span', { className: 'check-path', textContent: file.path })
          );
          if (file.message) {
            rowEl.append(el('span', { className: 'check-msg', textContent: file.message }));
          }
          list.append(rowEl);
        });
      }
    } else if (msg.type === 'error') {
      const pane = document.getElementById('preview');
      if (pane) {
        pane.textContent = '⚠ ' + msg.message;
      }
      // The run that would have refreshed them failed, so the verdicts still
      // on screen describe an older state — stale them rather than leaving
      // full-opacity ✓ rows next to an error.
      markPreviewStale('This preview did not run — the verdicts below are from an earlier run.');
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
