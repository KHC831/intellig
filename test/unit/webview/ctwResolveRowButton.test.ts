/**
 * The per-row Resolve button (issue #5, route 2).
 *
 * Always visible rather than revealed on hover: the whole complaint is that
 * nothing tells you a conflict is actionable, and a control you must find with
 * the cursor does not fix that. Only conflicted rows carry one, so it stays
 * rare. Opens the merge window for that one file, where the header's Resolve
 * link opens the multi-file dialog for all of them.
 */

import '../../setup';
import * as assert from 'assert';
import { buildCommitToolWindowBodyParts } from '../../../src/commits/CommitToolWindow';
import type {
  IChangelist,
  IFileChange,
} from '../../../src/changelists/interfaces/IChangelistService';
import { bootWebviewEntry, IWebviewEntryHarness } from '../../helpers/bootWebviewEntry';

function file(path: string, status: IFileChange['status']): IFileChange {
  return { path, status, staged: false };
}

function changelistWith(files: IFileChange[]): IChangelist {
  return { id: 'default', name: 'Changes', isDefault: true, isActive: true, files };
}

function boot(files: IFileChange[]): IWebviewEntryHarness {
  const { body } = buildCommitToolWindowBodyParts({
    activeTab: 'localChanges',
    changelists: [changelistWith(files)],
    shelfItems: [],
    composer: { message: '', amend: false, signOff: false },
    activeChangelistId: 'default',
  });
  return bootWebviewEntry('commits/webview/commitToolWindow', { bodyHtml: body });
}

const MIXED = [file('pom.xml', 'modified'), file('src/net/Service.java', 'conflicted')];

describe('webview: per-row Resolve button (jsdom)', () => {
  let h: IWebviewEntryHarness;

  afterEach(() => {
    if (h) {
      h.dispose();
    }
  });

  it('renders a Resolve button on a conflicted row', () => {
    h = boot(MIXED);
    const row = h.document.querySelector('.ctw-conflicts-block .ctw-file-row');
    assert.ok(row);
    const btn = row.querySelector('.ctw-file-resolve');
    assert.ok(btn, 'a conflicted row carries its own Resolve');
    assert.strictEqual(btn.textContent, 'Resolve');
  });

  it('renders no Resolve button on an ordinary changed row', () => {
    h = boot(MIXED);
    // Direct child: the conflicts node nests INSIDE the changelist block, so a
    // descendant selector would reach the conflicted row and this would assert
    // nothing about ordinary rows.
    const row = h.document.querySelector('.ctw-changelist-block > .ctw-file-row');
    assert.ok(row, 'the ordinary bucket must still hold a row');
    assert.strictEqual(row.getAttribute('data-path'), 'pom.xml');
    assert.strictEqual(row.querySelector('.ctw-file-resolve'), null);
  });

  it('asks the host to open the merge window for that one file', () => {
    h = boot(MIXED);
    h.posted.length = 0;
    h.document.querySelector<HTMLElement>('.ctw-file-resolve')?.click();

    const sent = h.posted.filter(
      (m) => (m as { type?: string }).type === 'resolveConflictFile'
    ) as Array<{ path?: string }>;
    assert.strictEqual(sent.length, 1, 'exactly one request');
    assert.strictEqual(sent[0].path, 'src/net/Service.java');
  });

  it('does not also fire the row-level open-diff or select messages', () => {
    // The button sits inside the row, so a click bubbles into the row handlers
    // unless it stops. Firing both would open two surfaces for one click.
    h = boot(MIXED);
    h.posted.length = 0;
    h.document.querySelector<HTMLElement>('.ctw-file-resolve')?.click();

    const types = h.posted.map((m) => (m as { type?: string }).type);
    assert.deepStrictEqual(
      types.filter((t) => t === 'selectFile' || t === 'openFileDiff'),
      [],
      `only the resolve request should be sent; got: ${types.join(',')}`
    );
  });

  it('opens ONE surface when Resolve is double-clicked', () => {
    // The button sits inside the row, so a dblclick on it also reaches the
    // row's dblclick handler unless the button is excluded the way the
    // checkbox already is. Two fast clicks would otherwise post two
    // resolveConflictFile AND an openFileDiff — the merge window three times.
    h = boot(MIXED);
    h.posted.length = 0;
    const btn = h.document.querySelector<HTMLElement>('.ctw-file-resolve');
    assert.ok(btn);
    btn.click();
    btn.click();
    btn.dispatchEvent(new h.window.MouseEvent('dblclick', { bubbles: true, cancelable: true }));

    const types = h.posted.map((m) => (m as { type?: string }).type);
    assert.deepStrictEqual(
      types.filter((t) => t === 'openFileDiff'),
      [],
      `a dblclick on Resolve must not also open the row's diff; got: ${types.join(',')}`
    );
  });
});
