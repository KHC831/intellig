/**
 * Webview client-script test for the Commit Tool Window (CommitToolWindow.ts).
 *
 * The host ships an empty `#ctw-root` plus an INIT island; the inline script
 * (`commitToolWindowBehaviorScript`) builds every panel via createElement. We
 * run that real script under jsdom for both the localChanges and shelf tabs and
 * assert it loads, builds the root, and tolerates messages — the renderer-only
 * regression class no other lane sees.
 */

import '../../setup';
import * as assert from 'assert';
import { buildCommitToolWindowBodyParts } from '../../../src/commits/CommitToolWindow';
import type {
  IChangelist,
  IFileChange,
} from '../../../src/changelists/interfaces/IChangelistService';
import { runWebviewScript, IWebviewHarness } from '../../helpers/webviewHarness';

const GARBAGE_MESSAGES: unknown[] = [
  { type: 'totally-unknown-message' },
  { type: undefined },
  { foo: 'bar' },
  {},
];

function makeFile(path: string): IFileChange {
  return { path, status: 'modified', staged: false };
}

function makeChangelist(): IChangelist {
  return {
    id: 'default',
    name: 'Changes',
    isDefault: true,
    isActive: true,
    files: [makeFile('src/a.ts'), makeFile('src/dir/b.ts')],
  };
}

describe('webview: Commit Tool Window inline script (jsdom)', () => {
  let h: IWebviewHarness;

  afterEach(() => {
    if (h) {
      h.dispose();
    }
  });

  it('loads the localChanges tab without throwing and builds the root', () => {
    const { body, script } = buildCommitToolWindowBodyParts({
      activeTab: 'localChanges',
      changelists: [makeChangelist()],
      shelfItems: [],
      composer: { message: 'wip', amend: false, signOff: false },
      activeChangelistId: 'default',
    });
    h = runWebviewScript(script, { bodyHtml: body });
    assert.deepStrictEqual(
      h.errors.map((e) => e.message),
      []
    );
    assert.ok(h.document.getElementById('ctw-root'), 'ctw-root present');
    assert.ok(h.document.getElementById('ctw-root')?.childElementCount, 'root has built children');
  });

  it('loads the shelf tab without throwing', () => {
    const { body, script } = buildCommitToolWindowBodyParts({
      activeTab: 'shelf',
      changelists: [],
      shelfItems: [],
      composer: { message: '', amend: false, signOff: false },
    });
    h = runWebviewScript(script, { bodyHtml: body });
    assert.deepStrictEqual(
      h.errors.map((e) => e.message),
      []
    );
  });

  it('syncs the checkbox for a path containing a backslash (POSIX-legal filename)', () => {
    const weird = 'weird\\name.txt'; // a single backslash — legal on POSIX
    const { body, script } = buildCommitToolWindowBodyParts({
      activeTab: 'localChanges',
      changelists: [
        {
          id: 'default',
          name: 'Changes',
          isDefault: true,
          isActive: true,
          files: [makeFile(weird), makeFile('src/plain.ts')],
        },
      ],
      shelfItems: [],
      composer: { message: '', amend: false, signOff: false },
      activeChangelistId: 'default',
    });
    h = runWebviewScript(script, { bodyHtml: body });

    const box = Array.from(h.document.querySelectorAll('.ctw-file-check')).find(
      (c) => c.getAttribute('data-path') === weird
    ) as HTMLInputElement | undefined;
    assert.ok(box, 'a checkbox for the backslash path must render');
    assert.strictEqual(box.checked, false, 'starts unchecked');

    h.post({ type: 'updateFileCheckbox', path: weird, checked: true });

    // Old code escaped only `"`, leaving the backslash to form an invalid /
    // mis-parsed selector: querySelector threw or matched nothing, so the box
    // never synced. The shared cssEscapeAttr escape fixes both.
    assert.deepStrictEqual(
      h.errors.map((e) => e.message),
      [],
      'the message handler must not throw on a backslash path'
    );
    assert.strictEqual(box.checked, true, 'the backslash-path checkbox must sync');
  });

  it('syncs the checkbox for a plain path (unchanged behavior)', () => {
    const { body, script } = buildCommitToolWindowBodyParts({
      activeTab: 'localChanges',
      changelists: [makeChangelist()],
      shelfItems: [],
      composer: { message: '', amend: false, signOff: false },
      activeChangelistId: 'default',
    });
    h = runWebviewScript(script, { bodyHtml: body });

    const box = Array.from(h.document.querySelectorAll('.ctw-file-check')).find(
      (c) => c.getAttribute('data-path') === 'src/a.ts'
    ) as HTMLInputElement | undefined;
    assert.ok(box, 'a checkbox for the plain path must render');

    h.post({ type: 'updateFileCheckbox', path: 'src/a.ts', checked: true });
    assert.strictEqual(box.checked, true, 'the plain-path checkbox syncs');
  });

  it('tolerates representative and garbage messages without throwing', () => {
    const { body, script } = buildCommitToolWindowBodyParts({
      activeTab: 'localChanges',
      changelists: [makeChangelist()],
      shelfItems: [],
      composer: { message: '', amend: false, signOff: false },
    });
    h = runWebviewScript(script, { bodyHtml: body });
    h.post({ type: 'update', changelists: [], shelfItems: [] });
    for (const msg of GARBAGE_MESSAGES) {
      h.post(msg);
    }
    assert.deepStrictEqual(
      h.errors.map((e) => e.message),
      []
    );
  });
});
