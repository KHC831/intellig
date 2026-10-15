/**
 * Webview client-entry test for the Commit Tool Window.
 *
 * The host ships an empty `#ctw-root` plus a `#intellig-init` island; the
 * bundled entry (`src/commits/webview/commitToolWindow.ts`) builds every panel
 * via createElement. We boot that real entry under jsdom for both the
 * localChanges and shelf tabs and assert it loads, builds the root, and
 * tolerates messages — the renderer-only regression class no other lane sees.
 */

import '../../setup';
import * as assert from 'assert';
import { buildCommitToolWindowBodyParts } from '../../../src/commits/CommitToolWindow';
import type {
  IChangelist,
  IFileChange,
} from '../../../src/changelists/interfaces/IChangelistService';
import { bootWebviewEntry, IWebviewEntryHarness } from '../../helpers/bootWebviewEntry';

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

describe('webview: Commit Tool Window entry (jsdom)', () => {
  let h: IWebviewEntryHarness;

  afterEach(() => {
    if (h) {
      h.dispose();
    }
  });

  it('loads the localChanges tab without throwing and builds the root', () => {
    const { body } = buildCommitToolWindowBodyParts({
      activeTab: 'localChanges',
      changelists: [makeChangelist()],
      shelfItems: [],
      composer: { message: 'wip', amend: false, signOff: false },
      activeChangelistId: 'default',
    });
    h = bootWebviewEntry('commits/webview/commitToolWindow', { bodyHtml: body });
    assert.deepStrictEqual(
      h.errors.map((e) => e.message),
      []
    );
    assert.ok(h.document.getElementById('ctw-root'), 'ctw-root present');
    assert.ok(h.document.getElementById('ctw-root')?.childElementCount, 'root has built children');
  });

  it('loads the shelf tab without throwing', () => {
    const { body } = buildCommitToolWindowBodyParts({
      activeTab: 'shelf',
      changelists: [],
      shelfItems: [],
      composer: { message: '', amend: false, signOff: false },
    });
    h = bootWebviewEntry('commits/webview/commitToolWindow', { bodyHtml: body });
    assert.deepStrictEqual(
      h.errors.map((e) => e.message),
      []
    );
  });

  it('syncs the checkbox for a path containing a backslash (POSIX-legal filename)', () => {
    const weird = 'weird\\name.txt'; // a single backslash — legal on POSIX
    const { body } = buildCommitToolWindowBodyParts({
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
    h = bootWebviewEntry('commits/webview/commitToolWindow', { bodyHtml: body });

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
    const { body } = buildCommitToolWindowBodyParts({
      activeTab: 'localChanges',
      changelists: [makeChangelist()],
      shelfItems: [],
      composer: { message: '', amend: false, signOff: false },
      activeChangelistId: 'default',
    });
    h = bootWebviewEntry('commits/webview/commitToolWindow', { bodyHtml: body });

    const box = Array.from(h.document.querySelectorAll('.ctw-file-check')).find(
      (c) => c.getAttribute('data-path') === 'src/a.ts'
    ) as HTMLInputElement | undefined;
    assert.ok(box, 'a checkbox for the plain path must render');

    h.post({ type: 'updateFileCheckbox', path: 'src/a.ts', checked: true });
    assert.strictEqual(box.checked, true, 'the plain-path checkbox syncs');
  });

  it('double-clicking a file row asks the host to open the diff', () => {
    const { body } = buildCommitToolWindowBodyParts({
      activeTab: 'localChanges',
      changelists: [makeChangelist()],
      shelfItems: [],
      composer: { message: '', amend: false, signOff: false },
      activeChangelistId: 'default',
    });
    h = bootWebviewEntry('commits/webview/commitToolWindow', { bodyHtml: body });

    const row = Array.from(h.document.querySelectorAll('.ctw-file-row')).find(
      (r) => r.getAttribute('data-path') === 'src/dir/b.ts'
    );
    assert.ok(row, 'a row for the path must render');
    row.dispatchEvent(new h.window.MouseEvent('dblclick', { bubbles: true }));

    assert.ok(
      h.posted.some(
        (m) =>
          (m as { type?: string; path?: string }).type === 'openFileDiff' &&
          (m as { path?: string }).path === 'src/dir/b.ts'
      ),
      `expected an openFileDiff post; got: ${JSON.stringify(h.posted)}`
    );
    assert.deepStrictEqual(
      h.errors.map((e) => e.message),
      [],
      'the dblclick listener must not throw after posting'
    );
  });

  // Every outbound message is stamped in post() so the host can drop an action
  // aimed at a repo the view no longer targets. An UNSTAMPED message is always
  // allowed by design, so deleting the stamp disables the guard silently — this
  // is the assertion that notices.
  it('stamps outbound messages with the repo the rows were rendered from', () => {
    const { body } = buildCommitToolWindowBodyParts({
      activeTab: 'localChanges',
      changelists: [makeChangelist()],
      shelfItems: [],
      composer: { message: '', amend: false, signOff: false },
      activeChangelistId: 'default',
      repoRoot: '/repo/rendered',
    });
    h = bootWebviewEntry('commits/webview/commitToolWindow', { bodyHtml: body });

    const row = h.document.querySelector('.ctw-file-row');
    assert.ok(row, 'a row must render');
    row.dispatchEvent(new h.window.MouseEvent('dblclick', { bubbles: true }));

    const opened = h.posted.find((m) => (m as { type?: string }).type === 'openFileDiff') as
      { repoRoot?: string } | undefined;
    assert.ok(opened, `expected an openFileDiff post; got: ${JSON.stringify(h.posted)}`);
    assert.strictEqual(
      opened.repoRoot,
      '/repo/rendered',
      'the post must carry the rendered repo, or the host guard is inert'
    );
  });

  it('double-clicking a file checkbox does not ask for a diff', () => {
    const { body } = buildCommitToolWindowBodyParts({
      activeTab: 'localChanges',
      changelists: [makeChangelist()],
      shelfItems: [],
      composer: { message: '', amend: false, signOff: false },
      activeChangelistId: 'default',
    });
    h = bootWebviewEntry('commits/webview/commitToolWindow', { bodyHtml: body });

    const box = h.document.querySelector('.ctw-file-check');
    assert.ok(box, 'a checkbox must render');
    // Two fast clicks on the checkbox are an include/exclude toggle, not a
    // request to open the file — the diff must not hijack that gesture.
    box.dispatchEvent(new h.window.MouseEvent('dblclick', { bubbles: true }));

    assert.deepStrictEqual(
      h.posted.filter((m) => (m as { type?: string }).type === 'openFileDiff'),
      []
    );
    assert.deepStrictEqual(
      h.errors.map((e) => e.message),
      [],
      'the checkbox guard must not throw'
    );
  });

  it('tolerates representative and garbage messages without throwing', () => {
    const { body } = buildCommitToolWindowBodyParts({
      activeTab: 'localChanges',
      changelists: [makeChangelist()],
      shelfItems: [],
      composer: { message: '', amend: false, signOff: false },
    });
    h = bootWebviewEntry('commits/webview/commitToolWindow', { bodyHtml: body });
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
