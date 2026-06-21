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
  renderCommitToolWindowHtml,
} from '../../../src/commits/CommitToolWindow';
import type {
  IChangelist,
  IFileChange,
} from '../../../src/changelists/interfaces/IChangelistService';

function file(path: string, status: IFileChange['status'] = 'modified'): IFileChange {
  return { path, status, staged: false };
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

describe('renderCommitToolWindowHtml — grouping + unversioned + diff pane', () => {
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

  it('renders the grouping segmented control with the active mode pressed', () => {
    const html = renderCommitToolWindowHtml({
      cspSource: 'vscode-webview://mock',
      activeTab: 'localChanges',
      changelists,
      shelfItems: [],
      composer: { message: '', amend: false, signOff: false },
      grouping: 'directory',
    });
    assert.ok(html.includes('data-grouping="directory"'));
    assert.ok(html.includes('data-grouping="flat"'));
    assert.ok(html.includes('data-grouping="directory" aria-pressed="true"'));
    assert.ok(html.includes('data-grouping="flat" aria-pressed="false"'));
  });

  it('renders directory nodes in directory mode (basename file rows)', () => {
    const html = renderCommitToolWindowHtml({
      cspSource: 'vscode-webview://mock',
      activeTab: 'localChanges',
      changelists,
      shelfItems: [],
      composer: { message: '', amend: false, signOff: false },
      grouping: 'directory',
    });
    // Directory header rows present.
    assert.ok(html.includes('class="ctw-dir-row" data-dir="src"'));
    assert.ok(html.includes('class="ctw-dir-row" data-dir="src/sub"'));
    // File row carries the full path in data-path but shows the basename.
    assert.ok(html.includes('data-path="src/a.ts"'));
    assert.ok(html.includes('>a.ts</span>'));
  });

  it('renders full paths (no directory nodes) in flat mode', () => {
    const html = renderCommitToolWindowHtml({
      cspSource: 'vscode-webview://mock',
      activeTab: 'localChanges',
      changelists,
      shelfItems: [],
      composer: { message: '', amend: false, signOff: false },
      grouping: 'flat',
    });
    assert.ok(!html.includes('class="ctw-dir-row"'));
    assert.ok(html.includes('>src/a.ts</span>'));
  });

  it('renders an Unversioned Files node for untracked files', () => {
    const html = renderCommitToolWindowHtml({
      cspSource: 'vscode-webview://mock',
      activeTab: 'localChanges',
      changelists,
      shelfItems: [],
      composer: { message: '', amend: false, signOff: false },
      grouping: 'flat',
    });
    assert.ok(html.includes('ctw-unversioned-row'));
    assert.ok(html.includes('Unversioned Files'));
    assert.ok(html.includes('data-changelist="_unversioned"'));
    // The untracked file lives under the unversioned node, not the default CL.
    assert.ok(html.includes('data-path="new.ts"'));
  });

  it('renders the diff-preview pane surface', () => {
    const html = renderCommitToolWindowHtml({
      cspSource: 'vscode-webview://mock',
      activeTab: 'localChanges',
      changelists,
      shelfItems: [],
      composer: { message: '', amend: false, signOff: false },
    });
    assert.ok(html.includes('data-diff-preview'));
    assert.ok(html.includes('Select a file to preview changes'));
  });
});
