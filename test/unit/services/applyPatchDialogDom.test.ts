/**
 * Rendered-DOM tests for the Apply Patch dialog (string→DOM migration).
 *
 * Post-migration contract: the dialog's inline nonce'd script BUILDS the body
 * via document.createElement — the host markup ships an empty root, not
 * pre-baked controls. We run the script in jsdom and assert the resulting DOM.
 */

import '../../setup';
import * as assert from 'assert';
import { JSDOM } from 'jsdom';
import * as vscode from 'vscode';
import { ApplyPatchDialog } from '../../../src/patches/ApplyPatchDialog';
import { IPatchService } from '../../../src/patches/interfaces/IPatchService';

function makeContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    extensionUri: vscode.Uri.file('/tmp/ext'),
    asAbsolutePath: (rel: string): string => `/tmp/ext/${rel}`,
  } as unknown as vscode.ExtensionContext;
}

function makeDialog(initialPatchPath?: string): ApplyPatchDialog {
  return new ApplyPatchDialog(makeContext(), {
    repo: { rootUri: vscode.Uri.file('/repo') } as never,
    patchService: {} as IPatchService,
    initialPatchPath,
  });
}

/**
 * Run the dialog's inline nonce'd script in jsdom and return the built DOM.
 * Asserts the pre-eval host markup does NOT pre-bake the controls.
 */
function renderDoc(dialog: ApplyPatchDialog): { document: Document; posted: unknown[] } {
  const html = (dialog as unknown as { _panel: { webview: { html: string } } })._panel.webview.html;
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const window = dom.window;
  const posted: unknown[] = [];
  (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: (m: unknown): void => {
      posted.push(m);
    },
    getState: (): void => {},
    setState: (): void => {},
  });
  assert.strictEqual(
    window.document.querySelector('#patchPath'),
    null,
    'controls must not be pre-baked in host markup — the script builds the DOM'
  );
  const scriptEl = window.document.querySelector('script[nonce]');
  assert.ok(scriptEl, 'a nonce-tagged inline script must be present');
  window.eval(scriptEl.textContent ?? '');
  return { document: window.document as unknown as Document, posted };
}

describe('ApplyPatchDialog — rendered DOM (script-built)', () => {
  it('builds the source radios, file/strip/base inputs, am checkbox, and buttons', () => {
    const dialog = makeDialog();
    try {
      const { document } = renderDoc(dialog);
      assert.strictEqual(
        document.querySelectorAll('input[name="source"]').length,
        2,
        'two source radios (file/clipboard)'
      );
      assert.ok(document.querySelector('#patchPath'), 'patch-path input built');
      assert.ok(document.querySelector('#stripLevel'), 'strip-level input built');
      assert.ok(document.querySelector('#baseDir'), 'base-dir input built');
      assert.ok(document.querySelector('#useAm'), 'use-am checkbox built');
      assert.ok(document.querySelector('#preview'), 'preview pane built');
      for (const id of ['browseBtn', 'previewBtn', 'cancelBtn', 'applyBtn']) {
        assert.ok(document.querySelector('#' + id), id + ' built');
      }
    } finally {
      dialog.dispose();
    }
  });

  it('seeds the patch-path input from initialPatchPath via .value (not markup)', () => {
    const dialog = makeDialog('/tmp/fix.patch');
    try {
      const { document } = renderDoc(dialog);
      assert.strictEqual(
        (document.querySelector('#patchPath') as HTMLInputElement).value,
        '/tmp/fix.patch',
        'initial patch path seeds the input value'
      );
    } finally {
      dialog.dispose();
    }
  });

  it('defaults the file radio checked and strip level to 1', () => {
    const dialog = makeDialog();
    try {
      const { document } = renderDoc(dialog);
      const fileRadio = document.querySelector(
        'input[name="source"][value="file"]'
      ) as HTMLInputElement;
      assert.strictEqual(fileRadio.checked, true, 'file source is the default');
      assert.strictEqual(
        (document.querySelector('#stripLevel') as HTMLInputElement).value,
        '1',
        'strip level defaults to 1'
      );
    } finally {
      dialog.dispose();
    }
  });

  it('Cancel posts a cancel message; Apply posts an apply message', () => {
    const dialog = makeDialog('/tmp/x.patch');
    try {
      const { document, posted } = renderDoc(dialog);
      (document.querySelector('#cancelBtn') as HTMLButtonElement).click();
      assert.deepEqual(posted.at(-1), { type: 'cancel' }, 'Cancel posts cancel');
      (document.querySelector('#applyBtn') as HTMLButtonElement).click();
      assert.strictEqual(
        (posted.at(-1) as { type: string }).type,
        'apply',
        'Apply posts an apply message'
      );
    } finally {
      dialog.dispose();
    }
  });
});
