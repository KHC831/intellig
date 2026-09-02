/**
 * Layer-1 (ADR-010) snapshot + unit tests for the Local Changes grouping,
 * Unversioned Files node, and diff-preview pane (workstream A item 4).
 *
 * These pin the rendered HTML shape for the changes-grouping surface so an
 * algorithm change shows up as a deliberate diff. Parity reference:
 * docs/parity/commit-tool-window-changes.md.
 */

import '../../setup';
import * as assert from 'assert';
import {
  groupFilesByDirectory,
  partitionUnversionedFiles,
  isChangesGroupingMode,
  buildCommitToolWindowBodyParts,
} from '../../../src/commits/CommitToolWindow';
import type { IRenderInput } from '../../../src/commits/CommitToolWindow';
import type {
  IChangelist,
  IFileChange,
} from '../../../src/changelists/interfaces/IChangelistService';
import { bootWebviewEntry, IWebviewEntryHarness } from '../../helpers/bootWebviewEntry';

function file(path: string, status: IFileChange['status'] = 'modified'): IFileChange {
  return { path, status, staged: false };
}

/**
 * Boot the bundled Commit Tool Window entry against the host body and return
 * the built document. The Local Changes tree is built client-side via
 * createElement from the `#intellig-init` island, so the DOM is the assertion
 * surface. Harnesses are disposed after each test so jsdom globals don't leak.
 */
const _ctwHarnesses: IWebviewEntryHarness[] = [];
afterEach(() => {
  while (_ctwHarnesses.length > 0) {
    _ctwHarnesses.pop()?.dispose();
  }
});

function buildCtwDoc(input: IRenderInput): Document {
  const { body } = buildCommitToolWindowBodyParts(input);
  const h = bootWebviewEntry('commits/webview/commitToolWindow', { bodyHtml: body });
  _ctwHarnesses.push(h);
  return h.document;
}

describe('groupFilesByDirectory', () => {
  it('buckets files by their directory, sorted by dir then basename', () => {
    const nodes = groupFilesByDirectory([
      file('src/b.ts'),
      file('src/a.ts'),
      file('README.md'),
      file('docs/x.md'),
    ]);
    // snapshot-A4-1: frozen literal of the grouped structure.
    assert.deepStrictEqual(
      nodes.map((n) => ({ dir: n.dir, files: n.files.map((f) => f.path) })),
      [
        { dir: '', files: ['README.md'] },
        { dir: 'docs', files: ['docs/x.md'] },
        { dir: 'src', files: ['src/a.ts', 'src/b.ts'] },
      ]
    );
  });

  it('keeps repo-root files under the empty-dir bucket', () => {
    const nodes = groupFilesByDirectory([file('top.ts')]);
    assert.strictEqual(nodes.length, 1);
    assert.strictEqual(nodes[0].dir, '');
  });
});

describe('partitionUnversionedFiles', () => {
  it('moves untracked files into the unversioned bucket and out of changelists', () => {
    const changelists: IChangelist[] = [
      {
        id: 'def',
        name: 'Default',
        isDefault: true,
        isActive: true,
        files: [file('src/a.ts', 'modified'), file('new.ts', 'untracked')],
      },
    ];
    const { changelists: tracked, unversioned } = partitionUnversionedFiles(changelists);
    assert.deepStrictEqual(
      tracked[0].files.map((f) => f.path),
      ['src/a.ts']
    );
    assert.deepStrictEqual(
      unversioned.map((f) => f.path),
      ['new.ts']
    );
  });

  it('returns an empty unversioned bucket when nothing is untracked', () => {
    const { unversioned } = partitionUnversionedFiles([
      { id: 'def', name: 'Default', isDefault: true, isActive: true, files: [file('a.ts')] },
    ]);
    assert.deepStrictEqual(unversioned, []);
  });
});

describe('isChangesGroupingMode', () => {
  it('accepts the two valid modes and rejects others', () => {
    assert.strictEqual(isChangesGroupingMode('flat'), true);
    assert.strictEqual(isChangesGroupingMode('directory'), true);
    assert.strictEqual(isChangesGroupingMode('module'), false);
    assert.strictEqual(isChangesGroupingMode(undefined), false);
  });
});

describe('CommitToolWindow Local Changes — grouping + unversioned + diff pane (built via script)', () => {
  const changelists: IChangelist[] = [
    {
      id: 'def',
      name: 'Default',
      isDefault: true,
      isActive: true,
      files: [
        file('src/a.ts', 'modified'),
        file('src/sub/b.ts', 'modified'),
        file('new.ts', 'untracked'),
      ],
    },
  ];

  function buildLocalDoc(grouping?: 'flat' | 'directory'): Document {
    return buildCtwDoc({
      activeTab: 'localChanges',
      changelists,
      shelfItems: [],
      composer: { message: '', amend: false, signOff: false },
      grouping,
    });
  }

  it('renders the grouping segmented control with the active mode pressed', () => {
    const doc = buildLocalDoc('directory');
    const dir = doc.querySelector('.ctw-grouping-btn[data-grouping="directory"]');
    const flat = doc.querySelector('.ctw-grouping-btn[data-grouping="flat"]');
    assert.ok(dir && flat, 'both grouping buttons should render');
    assert.strictEqual(dir?.getAttribute('aria-pressed'), 'true');
    assert.strictEqual(flat?.getAttribute('aria-pressed'), 'false');
  });

  it('renders directory nodes in directory mode (basename file rows)', () => {
    const doc = buildLocalDoc('directory');
    // Directory header rows present.
    assert.ok(doc.querySelector('.ctw-dir-row[data-dir="src"]'));
    assert.ok(doc.querySelector('.ctw-dir-row[data-dir="src/sub"]'));
    // File row carries the full path in data-path but shows the basename.
    const aRow = doc.querySelector('.ctw-file-row[data-path="src/a.ts"]');
    assert.ok(aRow, 'file row should carry the full path in data-path');
    assert.strictEqual(aRow?.querySelector('.ctw-file-path')?.textContent, 'a.ts');
  });

  it('renders full paths (no directory nodes) in flat mode', () => {
    const doc = buildLocalDoc('flat');
    assert.strictEqual(doc.querySelector('.ctw-dir-row'), null);
    assert.strictEqual(
      doc.querySelector('.ctw-file-row[data-path="src/a.ts"] .ctw-file-path')?.textContent,
      'src/a.ts'
    );
  });

  it('renders an Unversioned Files node for untracked files', () => {
    const doc = buildLocalDoc('flat');
    const node = doc.querySelector('.ctw-unversioned-row[data-changelist="_unversioned"]');
    assert.ok(node, 'unversioned node should render');
    assert.ok(node?.textContent?.includes('Unversioned Files'));
    // The untracked file lives under the unversioned node, not the default CL.
    const block = node?.closest('.ctw-unversioned-block');
    assert.ok(block?.querySelector('.ctw-file-row[data-path="new.ts"]'));
  });

  it('marks an untracked file row with ctw-file-untracked, driven from a real untracked IFileChange', () => {
    // Drives the row from a real `status: 'untracked'` IFileChange rather
    // than hand-setting `untracked` on an already-built model, so
    // buildCtwFileEntry's `entry.untracked = true` line (the render-model
    // builder, not the DOM) stays covered.
    const doc = buildLocalDoc('flat');
    const row = doc.querySelector('.ctw-file-row[data-path="new.ts"]');
    assert.ok(row?.classList.contains('ctw-file-untracked'), 'untracked row must carry the class');
  });

  it('renders the diff-preview pane surface', () => {
    const doc = buildLocalDoc();
    const pane = doc.querySelector('[data-diff-preview]');
    assert.ok(pane, 'diff-preview pane should render');
    assert.strictEqual(
      pane?.querySelector('.ctw-diff-preview-empty')?.textContent,
      'Select a file to preview changes'
    );
  });
});
