/**
 * Webview-entry live-update tests for the Commit Tool Window.
 *
 * Boots the REAL bundled entry (src/commits/webview/commitToolWindow.ts)
 * under jsdom and dispatches host→webview `updateModel` / `setComposerMessage`
 * messages. The core invariant (I1): an incremental update rebuilds the two
 * content subtrees only — composer text, focus, checkbox selection, and the
 * tab strip survive untouched.
 */

import '../../setup';
import * as assert from 'assert';
import {
  buildCommitToolWindowBodyParts,
  buildCommitToolWindowInitModel,
  sortChangelistsForDisplay,
  buildShelfTabEntries,
} from '../../../src/commits/CommitToolWindow';
import type { IRenderInput } from '../../../src/commits/CommitToolWindow';
import type {
  IChangelist,
  IFileChange,
} from '../../../src/changelists/interfaces/IChangelistService';
import { bootWebviewEntry, IWebviewEntryHarness } from '../../helpers/bootWebviewEntry';

function makeFile(path: string): IFileChange {
  return { path, status: 'modified', staged: false };
}

function makeChangelist(files: string[]): IChangelist {
  return {
    id: 'default',
    name: 'Changes',
    isDefault: true,
    isActive: true,
    files: files.map(makeFile),
  };
}

function renderInput(files: string[]): IRenderInput {
  const cl = makeChangelist(files);
  return {
    activeTab: 'localChanges',
    changelists: sortChangelistsForDisplay([cl]),
    shelfItems: [],
    shelfTabEntries: buildShelfTabEntries([], [], 'both'),
    shelfTabFilter: 'both',
    composer: { message: '', amend: false, signOff: false },
    activeChangelistId: 'default',
    grouping: 'flat',
  };
}

/** The updateModel payload for the given files + checked paths. */
function updateModelMessage(files: string[], selectedFiles: string[]): unknown {
  const model = {
    ...buildCommitToolWindowInitModel(renderInput(files)),
    selectedFiles,
  };
  return { type: 'updateModel', model };
}

describe('webview: Commit Tool Window live updates (jsdom)', () => {
  let h: IWebviewEntryHarness;

  afterEach(() => {
    if (h) {
      h.dispose();
    }
  });

  function boot(files: string[]): IWebviewEntryHarness {
    const { body } = buildCommitToolWindowBodyParts(renderInput(files));
    h = bootWebviewEntry('commits/webview/commitToolWindow', { bodyHtml: body });
    return h;
  }

  function fileRow(doc: Document, path: string): HTMLElement | null {
    return doc.querySelector<HTMLElement>(`.ctw-file-row[data-path="${path}"]`);
  }

  function fileCheck(doc: Document, path: string): HTMLInputElement | null {
    return doc.querySelector<HTMLInputElement>(`.ctw-file-check[data-path="${path}"]`);
  }

  it('T8: updateModel rebuilds the tree but preserves composer text, focus, and checkbox state', () => {
    boot(['src/a.ts', 'src/b.ts']);
    const doc = h.document;

    // User is mid-composition: file A checked, half-typed message, caret in
    // the textarea.
    const checkA = fileCheck(doc, 'src/a.ts');
    assert.ok(checkA, 'file A checkbox present after boot');
    checkA.checked = true;
    const ta = doc.querySelector<HTMLTextAreaElement>('.ctw-composer-msg');
    assert.ok(ta, 'composer textarea present after boot');
    ta.value = 'wip';
    ta.focus();
    assert.strictEqual(doc.activeElement, ta, 'precondition: textarea focused');

    // Background update: a third file appeared; host says A is still checked.
    h.post(updateModelMessage(['src/a.ts', 'src/b.ts', 'src/c.ts'], ['src/a.ts']));

    assert.ok(
      fileRow(doc, 'src/c.ts'),
      'the new file row must appear after updateModel (incremental apply, not a dead post)'
    );
    assert.strictEqual(ta.value, 'wip', 'composer text must survive a live update');
    assert.strictEqual(doc.activeElement, ta, 'composer focus must survive a live update');
    const checkAAfter = fileCheck(doc, 'src/a.ts');
    assert.ok(checkAAfter, 'file A row still present');
    assert.strictEqual(
      checkAAfter.checked,
      true,
      "file A's checkbox must be re-applied from model.selectedFiles"
    );
    assert.deepStrictEqual(
      h.errors.map((e) => e.message),
      [],
      'no jsdom errors during the update'
    );
  });

  it('T9: rows and controls that arrive via updateModel still post (delegation survives the swap)', () => {
    boot(['src/a.ts']);
    const doc = h.document;
    h.post(updateModelMessage(['src/a.ts', 'src/c.ts'], []));

    const newRow = fileRow(doc, 'src/c.ts');
    assert.ok(newRow, 'new row present after update');
    newRow.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    assert.ok(
      h.posted.some(
        (m) =>
          (m as { type?: string; path?: string }).type === 'selectFile' &&
          (m as { path?: string }).path === 'src/c.ts'
      ),
      'clicking a row born from updateModel must post selectFile (no orphaned listeners)'
    );

    const newCheck = fileCheck(doc, 'src/c.ts');
    assert.ok(newCheck, 'new checkbox present after update');
    newCheck.checked = true;
    newCheck.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    assert.ok(
      h.posted.some(
        (m) =>
          (m as { type?: string; path?: string }).type === 'toggleFile' &&
          (m as { path?: string }).path === 'src/c.ts'
      ),
      'toggling a checkbox born from updateModel must post toggleFile'
    );

    const groupingBtn = doc.querySelector<HTMLElement>(
      '.ctw-grouping-btn[data-grouping="directory"]'
    );
    assert.ok(groupingBtn, 'grouping button present after update');
    groupingBtn.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    assert.ok(
      h.posted.some((m) => (m as { type?: string }).type === 'changesGroupingChange'),
      'the rebuilt grouping control must still post'
    );
  });

  it('T10: the diff preview re-requests a surviving path and resets when the path vanishes', () => {
    boot(['src/a.ts', 'src/b.ts']);
    const doc = h.document;

    const rowA = fileRow(doc, 'src/a.ts');
    assert.ok(rowA);
    rowA.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    assert.ok(
      h.posted.some((m) => (m as { type?: string }).type === 'selectFile'),
      'precondition: row click posts selectFile'
    );
    // Host reply: the pane now previews src/a.ts.
    h.post({
      type: 'updateDiffPreview',
      path: 'src/a.ts',
      diff: {
        path: 'src/a.ts',
        status: 'modified',
        binary: false,
        hunks: [{ header: '@@ -1 +1 @@', lines: [{ type: 'add', content: 'x' }] }],
      },
    });
    const pane = doc.querySelector('[data-diff-preview]');
    assert.ok(pane, 'preview pane present');
    assert.ok(
      pane.textContent?.includes('src/a.ts'),
      'precondition: pane shows the previewed path'
    );

    // Update keeping the path → a fresh selectFile re-request refreshes it.
    const before = h.posted.length;
    h.post(updateModelMessage(['src/a.ts', 'src/b.ts', 'src/c.ts'], []));
    assert.ok(
      h.posted
        .slice(before)
        .some(
          (m) =>
            (m as { type?: string; path?: string }).type === 'selectFile' &&
            (m as { path?: string }).path === 'src/a.ts'
        ),
      'a surviving previewed path must be re-requested after updateModel'
    );

    // Update dropping the path → placeholder, no error.
    h.post(updateModelMessage(['src/b.ts'], []));
    assert.ok(
      pane.textContent?.includes('Select a file to preview changes'),
      'a vanished previewed path must reset the pane to the placeholder'
    );
    assert.deepStrictEqual(
      h.errors.map((e) => e.message),
      []
    );
  });

  it('T11: panel scroll position is captured and restored around the swap', () => {
    boot(['src/a.ts', 'src/b.ts']);
    const doc = h.document;
    const localPanel = doc.querySelector<HTMLElement>('[data-panel="localChanges"]');
    assert.ok(localPanel);

    // jsdom performs no layout, so instrument scrollTop and assert the
    // capture/restore pair (real pixels are covered manually in F5 step 5).
    const writes: number[] = [];
    Object.defineProperty(localPanel, 'scrollTop', {
      get: () => 42,
      set: (v: number) => {
        writes.push(v);
      },
      configurable: true,
    });

    h.post(updateModelMessage(['src/a.ts', 'src/b.ts', 'src/c.ts'], []));

    assert.deepStrictEqual(
      writes,
      [42],
      'applyModel must restore the scrollTop it captured before the swap'
    );
    assert.strictEqual(
      doc.querySelector('[data-panel="localChanges"]'),
      localPanel,
      'the panel node itself must persist (only its tree content is replaced)'
    );
  });

  it('T12: activeTab arriving via updateModel toggles panels + tab strip without a reboot', () => {
    boot(['src/a.ts']);
    const doc = h.document;
    const tabStrip = doc.querySelector('.ctw-tab-strip');
    const composer = doc.querySelector('.ctw-composer');
    assert.ok(tabStrip && composer);

    const model = {
      ...buildCommitToolWindowInitModel({ ...renderInput(['src/a.ts']), activeTab: 'shelf' }),
      selectedFiles: [] as string[],
    };
    h.post({ type: 'updateModel', model });

    const localPanel = doc.querySelector<HTMLElement>('[data-panel="localChanges"]');
    const shelfPanel = doc.querySelector<HTMLElement>('[data-panel="shelf"]');
    assert.strictEqual(localPanel?.style.display, 'none', 'local panel hidden');
    assert.strictEqual(shelfPanel?.style.display, 'flex', 'shelf panel shown');
    const shelfTab = doc.querySelector('.ctw-tab[data-tab="shelf"]');
    assert.ok(shelfTab?.classList.contains('ctw-tab-active'), 'shelf tab marked active');
    const localTab = doc.querySelector('.ctw-tab[data-tab="localChanges"]');
    assert.ok(!localTab?.classList.contains('ctw-tab-active'), 'local tab unmarked');

    assert.strictEqual(
      doc.querySelector('.ctw-tab-strip'),
      tabStrip,
      'the tab strip node must persist (no reboot)'
    );
    assert.strictEqual(
      doc.querySelector('.ctw-composer'),
      composer,
      'the composer node must persist (no reboot)'
    );
  });

  it('T16b: setComposerMessage populates the textarea and later live updates never stomp it', () => {
    boot(['src/a.ts']);
    const doc = h.document;
    const ta = doc.querySelector<HTMLTextAreaElement>('.ctw-composer-msg');
    assert.ok(ta);

    h.post({ type: 'setComposerMessage', message: 'undone msg' });
    assert.strictEqual(ta.value, 'undone msg', 'prefill must reach the textarea');

    h.post(updateModelMessage(['src/a.ts', 'src/b.ts'], []));
    assert.strictEqual(ta.value, 'undone msg', 'a live update must never write the composer (I7)');
  });

  it('T17: a successful commitDone clears the amend checkbox but keeps sign-off', () => {
    boot(['src/a.ts']);
    const doc = h.document;
    const ta = doc.querySelector<HTMLTextAreaElement>('.ctw-composer-msg');
    const amend = doc.querySelector<HTMLInputElement>('.ctw-chk-amend');
    const signOff = doc.querySelector<HTMLInputElement>('.ctw-chk-signoff');
    assert.ok(ta && amend && signOff, 'composer controls present after boot');
    ta.value = 'amended msg';
    amend.checked = true;
    signOff.checked = true;

    h.post({ type: 'commitDone', success: true });

    assert.strictEqual(ta.value, '', 'message clears after a successful commit');
    assert.strictEqual(
      amend.checked,
      false,
      'amend clears after every successful commit (the host reset must reach the DOM the payload reads — a stuck box silently amends the commit just made)'
    );
    assert.strictEqual(signOff.checked, true, 'sign-off is a sticky preference and persists');
  });

  it('T17b: a failed commitDone leaves the composer state untouched', () => {
    boot(['src/a.ts']);
    const doc = h.document;
    const ta = doc.querySelector<HTMLTextAreaElement>('.ctw-composer-msg');
    const amend = doc.querySelector<HTMLInputElement>('.ctw-chk-amend');
    assert.ok(ta && amend);
    ta.value = 'still mine';
    amend.checked = true;

    h.post({ type: 'commitDone', success: false });

    assert.strictEqual(ta.value, 'still mine', 'a failed commit must not clear the message');
    assert.strictEqual(amend.checked, true, 'a failed commit must not reset amend');
  });
});
