/**
 * jsdom test for the Shelve Changes dialog's bundled webview entry
 * (src/shelf/webview/main.ts, shipped as media/webview/shelveDialog.js).
 *
 * Boots the REAL TS entry under jsdom (Phase-5 successor to the string-eval
 * harness): the host serializes the dialog's init into a `data-init` island in
 * the body, the entry reads it on boot and builds the DOM via createElement.
 * The behavioral assertions (DOM structure + message wiring) are identical to
 * the pre-port string-script test; only the boot mechanism changed. Files
 * exercised: ShelveDialog.ts + src/shelf/webview/main.ts.
 */

import '../../setup';
import * as assert from 'assert';
import { ShelveDialog, IShelveDialogOptions } from '../../../src/shelf/ShelveDialog';
import { IFileStatus, IRepository } from '../../../src/git-core/interfaces/IGitService';
import { IShelfItem } from '../../../src/shelf/interfaces/IShelfService';
import { bootWebviewEntry, IWebviewEntryHarness } from '../../helpers/bootWebviewEntry';
import { extractWebviewScript } from '../../helpers/webviewHtml';
import { makeExtensionContext, panelHtml } from '../../helpers/mockWebviewContext';
import { Uri } from '../../mocks/vscode';

const GARBAGE_MESSAGES: unknown[] = [{ type: 'totally-unknown' }, { type: undefined }, {}, null];

function fileStatus(path: string, indexStatus: string, workTreeStatus: string): IFileStatus {
  return { path, indexStatus, workTreeStatus } as IFileStatus;
}

function makeRepo(): IRepository {
  return { rootUri: Uri.file('/test/repo') } as unknown as IRepository;
}

const noopShelfService: IShelveDialogOptions['shelfService'] = {
  shelve: async (): Promise<IShelfItem> => ({
    id: 'x',
    name: 'x',
    timestamp: new Date(),
    files: [],
  }),
};

const CHANGED = [
  fileStatus('src/a.ts', 'M', ' '),
  fileStatus('src/b.ts', ' ', 'M'),
  fileStatus('src/c.ts', '?', '?'),
];

function buildHtml(overrides: Partial<IShelveDialogOptions> = {}): string {
  const dialog = new ShelveDialog(makeExtensionContext(), {
    repo: makeRepo(),
    shelfService: noopShelfService,
    changedFiles: overrides.changedFiles ?? CHANGED,
    preSelectedPaths: overrides.preSelectedPaths,
    defaultName: overrides.defaultName,
  });
  return panelHtml(dialog);
}

/** Boot the real entry against the host body (incl. the data-init island). */
function boot(overrides: Partial<IShelveDialogOptions> = {}): IWebviewEntryHarness {
  const bodyHtml = extractWebviewScript(buildHtml(overrides)).bodyHtml;
  return bootWebviewEntry('shelf/webview/main', { bodyHtml });
}

describe('webview: ShelveDialog entry (jsdom)', () => {
  let h: IWebviewEntryHarness;

  afterEach(() => {
    if (h) {
      h.dispose();
    }
  });

  it('loads without throwing and builds the name field + a checkbox per file + Shelve button', () => {
    h = boot();
    assert.deepStrictEqual(
      h.errors.map((e) => e.message),
      []
    );
    assert.ok(h.document.getElementById('shelve-name'), 'name input built');
    assert.ok(h.document.getElementById('shelve-btn'), 'Shelve button built');
    assert.strictEqual(
      h.document.querySelectorAll('input.shelve-file-checkbox').length,
      3,
      'one checkbox per changed file'
    );
  });

  it('checks ALL files by default', () => {
    h = boot();
    const checked = Array.from(h.document.querySelectorAll('input.shelve-file-checkbox')).filter(
      (b) => (b as HTMLInputElement).checked
    );
    assert.strictEqual(checked.length, 3);
  });

  it('checks ONLY the preselected file when a subset is given', () => {
    h = boot({ preSelectedPaths: ['src/b.ts'] });
    const checked = Array.from(h.document.querySelectorAll('input.shelve-file-checkbox')).filter(
      (b) => (b as HTMLInputElement).checked
    ) as HTMLInputElement[];
    assert.strictEqual(checked.length, 1);
    assert.strictEqual(checked[0].getAttribute('data-path'), 'src/b.ts');
  });

  it('disables Shelve on an empty name and enables it once a name is typed', () => {
    h = boot({ defaultName: '' });
    const btn = h.document.getElementById('shelve-btn') as HTMLButtonElement;
    assert.strictEqual(btn.disabled, true);
    const name = h.document.getElementById('shelve-name') as HTMLInputElement;
    name.value = 'WIP';
    name.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    assert.strictEqual(btn.disabled, false);
  });

  it('Cancel posts a cancel message', () => {
    h = boot();
    (h.document.getElementById('shelve-cancel-btn') as HTMLButtonElement).click();
    assert.deepEqual(h.posted.at(-1), { type: 'cancel' });
  });

  it('Shelve posts the name and the checked file paths', () => {
    h = boot({ defaultName: 'My WIP', preSelectedPaths: ['src/a.ts'] });
    (h.document.getElementById('shelve-btn') as HTMLButtonElement).click();
    assert.deepEqual(h.posted.at(-1), { type: 'shelve', name: 'My WIP', files: ['src/a.ts'] });
  });

  it('tolerates garbage extension→webview messages without throwing', () => {
    h = boot();
    for (const msg of GARBAGE_MESSAGES) {
      h.post(msg);
    }
    assert.deepStrictEqual(
      h.errors.map((e) => e.message),
      []
    );
  });
});
