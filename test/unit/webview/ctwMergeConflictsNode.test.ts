/**
 * The Merge Conflicts node as the webview actually renders it (issue #5).
 *
 * The model test next door proves the lift; this proves a user sees it: a
 * header row naming the thing, a file count, a Resolve link that posts, and
 * the conflicted rows underneath carrying their own marking. Mirrors
 * IntelliJ's `ChangesBrowserConflictsNode`, which renders bold title + count +
 * a clickable Resolve.
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
    repoRoot: '/repo',
  });
  return bootWebviewEntry('commits/webview/commitToolWindow', { bodyHtml: body });
}

const CONFLICTED = [
  file('pom.xml', 'modified'),
  file('src/net/Service.java', 'conflicted'),
  file('config.yaml', 'conflicted'),
];

describe('webview: Merge Conflicts node (jsdom)', () => {
  let h: IWebviewEntryHarness;

  afterEach(() => {
    if (h) {
      h.dispose();
    }
  });

  it('renders no conflicts header when nothing is unmerged', () => {
    h = boot([file('pom.xml', 'modified')]);
    assert.strictEqual(h.document.querySelector('.ctw-conflicts-row'), null);
  });

  it('renders the header with its name and file count', () => {
    h = boot(CONFLICTED);
    const header = h.document.querySelector('.ctw-conflicts-row');
    assert.ok(header, 'conflicts header must render');
    assert.ok(
      (header.textContent ?? '').includes('Merge Conflicts'),
      `header should name the node; got: ${header.textContent}`
    );
    assert.ok(
      (header.textContent ?? '').includes('2 files'),
      `header should carry the count; got: ${header.textContent}`
    );
  });

  it('nests the conflicts node INSIDE its changelist, above that list files', () => {
    // IntelliJ inserts the conflicts group under the changelist subtree, so the
    // list keeps its header. Hoisting it above every changelist made a
    // conflicts-only list disappear along with its actions.
    h = boot(CONFLICTED);
    const block = h.document.querySelector('.ctw-changelist-block');
    assert.ok(block, 'the changelist block must still render');
    const kids = Array.from(block.children);
    const headerIdx = kids.findIndex((k) => k.classList.contains('ctw-changelist-row'));
    const conflictsIdx = kids.findIndex((k) => k.classList.contains('ctw-conflicts-block'));
    const fileIdx = kids.findIndex((k) => k.classList.contains('ctw-file-row'));
    assert.ok(headerIdx >= 0, 'the changelist header survives');
    assert.ok(conflictsIdx > headerIdx, 'conflicts sit under that header');
    assert.ok(fileIdx === -1 || conflictsIdx < fileIdx, 'and ahead of the list ordinary files');
  });

  it('keeps a conflicts-only changelist visible, header and all', () => {
    h = boot([file('a.java', 'conflicted')]);
    const header = h.document.querySelector('.ctw-changelist-block .ctw-changelist-row');
    assert.ok(header, 'a list holding nothing but conflicts must not vanish');
    assert.ok((header.textContent ?? '').includes('Changes'));
    assert.ok(
      h.document.querySelector('.ctw-changelist-block .ctw-conflicts-row'),
      'with its conflicts node inside it'
    );
  });

  it('renders a Resolve link that posts to the host', () => {
    h = boot(CONFLICTED);
    const link = h.document.querySelector<HTMLElement>('.ctw-conflicts-resolve');
    assert.ok(link, 'Resolve link must render');
    assert.strictEqual(link.textContent, 'Resolve');

    h.posted.length = 0;
    link.click();
    const sent = h.posted.filter(
      (m) => (m as { type?: string }).type === 'resolveConflicts'
    ) as Array<{ repoRoot?: string }>;
    assert.strictEqual(
      sent.length,
      1,
      'clicking Resolve asks the host to open the Resolve Conflicts dialog'
    );
    assert.strictEqual(
      sent[0].repoRoot,
      '/repo',
      'the message carries the repo-root stamp, so the host drops it if the view retargeted mid-flight'
    );
  });

  it('does not fire Resolve when an ordinary row is clicked', () => {
    h = boot(CONFLICTED);
    h.posted.length = 0;
    // Direct child: a descendant selector reaches into the nested conflicts
    // node, and this would then be clicking a conflicted row.
    const ordinary = h.document.querySelector<HTMLElement>('.ctw-changelist-block > .ctw-file-row');
    assert.strictEqual(ordinary?.getAttribute('data-path'), 'pom.xml');
    ordinary.click();
    assert.deepStrictEqual(
      h.posted.filter((m) => (m as { type?: string }).type === 'resolveConflicts'),
      []
    );
  });

  it('lists the conflicted files under the header, and only those', () => {
    h = boot(CONFLICTED);
    const block = h.document.querySelector('.ctw-conflicts-block');
    assert.ok(block);
    const paths = Array.from(block.querySelectorAll('.ctw-file-row')).map((r) =>
      r.getAttribute('data-path')
    );
    assert.deepStrictEqual(paths, ['config.yaml', 'src/net/Service.java']);
  });

  it('marks a conflicted row so it can be styled apart from an ordinary change', () => {
    h = boot(CONFLICTED);
    const row = h.document.querySelector('.ctw-conflicts-block .ctw-file-row');
    assert.ok(row);
    assert.ok(
      row.classList.contains('ctw-file-conflicted'),
      `conflicted rows need their own class; got: ${row.className}`
    );
  });

  it('renders the conflict-region count on a row, pluralised', () => {
    const { body } = buildCommitToolWindowBodyParts({
      activeTab: 'localChanges',
      changelists: [changelistWith(CONFLICTED)],
      shelfItems: [],
      composer: { message: '', amend: false, signOff: false },
      activeChangelistId: 'default',
      conflictRegionCounts: new Map([
        ['src/net/Service.java', 3],
        ['config.yaml', 1],
      ]),
    });
    h = bootWebviewEntry('commits/webview/commitToolWindow', { bodyHtml: body });

    const counts = Array.from(
      h.document.querySelectorAll('.ctw-conflicts-block .ctw-file-conflict-count')
    ).map((n) => n.textContent);
    assert.deepStrictEqual(counts, ['1 conflict', '3 conflicts']);
  });

  it('renders no count element when the host supplied none', () => {
    h = boot(CONFLICTED);
    assert.strictEqual(h.document.querySelector('.ctw-file-conflict-count'), null);
  });

  it('does not leave a conflicted file rendered inside its changelist as well', () => {
    h = boot(CONFLICTED);
    // Rows outside the conflicts node — the changelist's ordinary bucket.
    const ordinary = Array.from(
      h.document.querySelectorAll('.ctw-changelist-block > .ctw-file-row')
    ).map((r) => r.getAttribute('data-path'));
    assert.deepStrictEqual(ordinary, ['pom.xml']);
    const all = Array.from(h.document.querySelectorAll('.ctw-file-row[data-path]')).map((r) =>
      r.getAttribute('data-path')
    );
    assert.strictEqual(
      all.filter((p) => p === 'src/net/Service.java').length,
      1,
      'a conflicted file renders exactly once'
    );
  });
});
