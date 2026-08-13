/**
 * Details Panel — Tree view indentation of the changed-files list.
 *
 * Directory rows carry an 18px twistie column (16px chevron + 2px margin)
 * before their name; file rows must reserve the SAME column via a spacer.
 * Without it a child file at depth N starts at N*16+4 while its parent
 * directory's NAME starts at (N-1)*16+22 — the child renders 2px LEFT of the
 * parent's label and the tree reads as not indented at all.
 *
 * Flat view (and a tree whose commit touches only root-level files) has no
 * directories, so no column is reserved and rows stay flush.
 */

import '../../setup';
import * as assert from 'assert';
import { renderDetailsPanel } from '../../helpers/detailsPanelDom';
import type {
  DetailsPanelModel,
  DetailsTreeNode,
} from '../../../src/git-core/gitToolWindow/provider/detailsPanelModel';

function modelWith(fileTree: DetailsTreeNode[]): DetailsPanelModel {
  return {
    kind: 'single',
    messageTokens: [{ t: 'text', v: 'msg' }],
    bodyTokens: null,
    hash: 'abc1234567890abcdef1234567890abcdef123456',
    authorName: 'Alice',
    authorEmail: 'alice@example.com',
    dateStr: '2024-01-01',
    parents: [],
    changedFilesCount: 1,
    fileTree,
    containingBranches: null,
    branchCollapseThreshold: 3,
    refBranches: [],
    refTags: [],
    groupBy: 'tree' as const,
  } as DetailsPanelModel;
}

function fileNode(path: string): DetailsTreeNode {
  return {
    kind: 'file',
    path,
    status: 'modified',
    statusColor: '#fff',
    fileName: path.split('/').pop() as string,
  };
}

/** Numeric padding-left (px) from the row's inline style. */
function paddingOf(el: Element): number {
  const m = /padding-left:\s*(\d+)px/.exec(el.getAttribute('style') ?? '');
  assert.ok(m, `row must carry an inline padding-left; style=${el.getAttribute('style')}`);
  return Number(m[1]);
}

describe('Details Panel — tree view indentation', () => {
  it('indents a nested file past its parent directory NAME (twistie column reserved)', () => {
    const panel = renderDetailsPanel(
      modelWith([{ kind: 'directory', name: 'src', children: [fileNode('src/a.ts')] }])
    );
    const dir = panel.querySelector('.changed-dir-item') as HTMLElement;
    const file = panel.querySelector('.changed-file-item') as HTMLElement;
    assert.ok(dir && file, 'both rows render');

    // The directory's visible NAME starts after its twistie column.
    const TWISTIE = 18; // 16px chevron + 2px margin (see .dir-chevron CSS)
    const dirNameStart = paddingOf(dir) + TWISTIE;

    // The file row reserves the same column: a spacer sized like the chevron.
    const spacer = file.querySelector('.dir-chevron-spacer');
    assert.ok(spacer, 'file rows in a tree reserve the twistie column with a spacer');
    const fileNameStart = paddingOf(file) + TWISTIE;

    assert.ok(
      fileNameStart > dirNameStart,
      `a child's name (${fileNameStart}px) must start RIGHT of its parent dir's name (${dirNameStart}px)`
    );
  });

  it('aligns a root file with a sibling root directory name', () => {
    const panel = renderDetailsPanel(
      modelWith([
        { kind: 'directory', name: 'src', children: [fileNode('src/a.ts')] },
        fileNode('README.md'),
      ])
    );
    const rootFile = panel.querySelector(
      '.changed-file-item[data-path="README.md"]'
    ) as HTMLElement;
    assert.ok(rootFile.querySelector('.dir-chevron-spacer'), 'sibling-of-dir file gets the spacer');
  });

  it('keeps a directory-free list flush (no spacer, flat/tree alike)', () => {
    const panel = renderDetailsPanel(modelWith([fileNode('a.ts'), fileNode('b.ts')]));
    const rows = [...panel.querySelectorAll('.changed-file-item')];
    assert.strictEqual(rows.length, 2);
    for (const row of rows) {
      assert.strictEqual(
        row.querySelector('.dir-chevron-spacer'),
        null,
        'no directories → no reserved twistie column'
      );
    }
  });
});
