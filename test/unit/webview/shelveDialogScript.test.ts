/**
 * jsdom client-script test for the Shelve Changes dialog (ShelveDialog.ts).
 *
 * The dialog builds its DOM in the webview renderer via createElement from a
 * JSON init island; this runs that script under jsdom (via the shared webview
 * harness) and asserts the structure + message wiring an invisible-to-e2e
 * renderer would otherwise hide. Files exercised: ShelveDialog.ts.
 */

import '../../setup';
import * as assert from 'assert';
import { ShelveDialog, IShelveDialogOptions } from '../../../src/shelf/ShelveDialog';
import { IFileStatus, IRepository } from '../../../src/git-core/interfaces/IGitService';
import { IShelfItem } from '../../../src/shelf/interfaces/IShelfService';
import { runWebviewScript, IWebviewHarness } from '../../helpers/webviewHarness';
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

describe('webview: ShelveDialog script (jsdom)', () => {
  let h: IWebviewHarness;

  afterEach(() => {
    if (h) {
      h.dispose();
    }
  });

  it('loads without throwing and builds the name field + a checkbox per file + Shelve button', () => {
    const { script, bodyHtml } = extractWebviewScript(buildHtml());
    h = runWebviewScript(script, { bodyHtml });
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
    const { script, bodyHtml } = extractWebviewScript(buildHtml());
    h = runWebviewScript(script, { bodyHtml });
    const checked = Array.from(h.document.querySelectorAll('input.shelve-file-checkbox')).filter(
      (b) => (b as HTMLInputElement).checked
    );
    assert.strictEqual(checked.length, 3);
  });

  it('checks ONLY the preselected file when a subset is given', () => {
    const { script, bodyHtml } = extractWebviewScript(
      buildHtml({ preSelectedPaths: ['src/b.ts'] })
    );
    h = runWebviewScript(script, { bodyHtml });
    const checked = Array.from(h.document.querySelectorAll('input.shelve-file-checkbox')).filter(
      (b) => (b as HTMLInputElement).checked
    ) as HTMLInputElement[];
    assert.strictEqual(checked.length, 1);
    assert.strictEqual(checked[0].getAttribute('data-path'), 'src/b.ts');
  });

  it('disables Shelve on an empty name and enables it once a name is typed', () => {
    const { script, bodyHtml } = extractWebviewScript(buildHtml({ defaultName: '' }));
    h = runWebviewScript(script, { bodyHtml });
    const btn = h.document.getElementById('shelve-btn') as HTMLButtonElement;
    assert.strictEqual(btn.disabled, true);
    const name = h.document.getElementById('shelve-name') as HTMLInputElement;
    name.value = 'WIP';
    name.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    assert.strictEqual(btn.disabled, false);
  });

  it('Cancel posts a cancel message', () => {
    const { script, bodyHtml } = extractWebviewScript(buildHtml());
    h = runWebviewScript(script, { bodyHtml });
    (h.document.getElementById('shelve-cancel-btn') as HTMLButtonElement).click();
    assert.deepEqual(h.posted.at(-1), { type: 'cancel' });
  });

  it('Shelve posts the name and the checked file paths', () => {
    const { script, bodyHtml } = extractWebviewScript(
      buildHtml({ defaultName: 'My WIP', preSelectedPaths: ['src/a.ts'] })
    );
    h = runWebviewScript(script, { bodyHtml });
    (h.document.getElementById('shelve-btn') as HTMLButtonElement).click();
    assert.deepEqual(h.posted.at(-1), { type: 'shelve', name: 'My WIP', files: ['src/a.ts'] });
  });

  it('tolerates garbage extension→webview messages without throwing', () => {
    const { script, bodyHtml } = extractWebviewScript(buildHtml());
    h = runWebviewScript(script, { bodyHtml });
    for (const msg of GARBAGE_MESSAGES) {
      h.post(msg);
    }
    assert.deepStrictEqual(
      h.errors.map((e) => e.message),
      []
    );
  });
});
