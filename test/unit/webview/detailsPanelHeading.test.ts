/**
 * Details Panel — changed-files heading + section height caps.
 *
 * Heading: the plain "Changed Files (N)" is replaced by
 * "<project> (<n> files) <path>" when the owning repository is known, with the
 * path shown in a dimmed span. Falls back to "Changed Files (N)" otherwise.
 *
 * Heights: the changed-files list and the commit-message box cap at a taller
 * default via max-height and hug shorter content (no fixed height, no resize).
 */

import '../../setup';
import * as assert from 'assert';
import { renderDetailsPanel } from '../../helpers/detailsPanelDom';
import { buildInlineStyles } from '../../../src/git-core/gitToolWindow/provider/stylesBuilder';
import type { DetailsPanelModel } from '../../../src/git-core/gitToolWindow/provider/detailsPanelModel';

function singleModel(over: Partial<DetailsPanelModel> = {}): DetailsPanelModel {
  return {
    kind: 'single',
    messageTokens: [{ t: 'text', v: 'Fix the thing' }],
    bodyTokens: null,
    hash: 'abc1234567890abcdef1234567890abcdef123456',
    authorName: 'Alice',
    authorEmail: 'alice@example.com',
    dateStr: '2024-01-01',
    parents: [],
    changedFilesCount: 3,
    fileTree: [],
    containingBranches: null,
    branchCollapseThreshold: 3,
    refBranches: [],
    refTags: [],
    groupBy: 'tree' as const,
    ...over,
  } as DetailsPanelModel;
}

function heading(model: DetailsPanelModel): HTMLElement {
  const panel = renderDetailsPanel(model);
  return panel.querySelector('.details-changed-files h4') as HTMLElement;
}

describe('Details Panel — changed-files heading', () => {
  it('shows "<project> (<n> files) <path>" when the project is known', () => {
    const h4 = heading(
      singleModel({ projectName: 'intellig', projectPath: '~/ws/intellig', changedFilesCount: 3 })
    );
    assert.strictEqual(h4.textContent, 'intellig (3 files) ~/ws/intellig');
    const pathSpan = h4.querySelector('.details-project-path') as HTMLElement;
    assert.ok(pathSpan, 'path is in its own span for dimmed styling');
    assert.strictEqual(pathSpan.textContent, '~/ws/intellig');
    assert.strictEqual(pathSpan.getAttribute('title'), '~/ws/intellig');
  });

  it('uses the singular "file" for a single changed file', () => {
    const h4 = heading(singleModel({ projectName: 'intellig', changedFilesCount: 1 }));
    assert.strictEqual(h4.textContent, 'intellig (1 file)');
  });

  it('omits the path segment when only the name is known', () => {
    const h4 = heading(singleModel({ projectName: 'intellig', changedFilesCount: 2 }));
    assert.strictEqual(h4.textContent, 'intellig (2 files)');
    assert.strictEqual(h4.querySelector('.details-project-path'), null);
  });

  it('falls back to "Changed Files (N)" when the project is unknown', () => {
    const h4 = heading(singleModel({ changedFilesCount: 5 }));
    assert.strictEqual(h4.textContent, 'Changed Files (5)');
  });

  it('applies to the multi-commit panel too', () => {
    const model: DetailsPanelModel = {
      kind: 'multi',
      count: 2,
      commits: [
        { shortHash: 'aaaaaaa', summary: 'one' },
        { shortHash: 'bbbbbbb', summary: 'two' },
      ],
      changedFilesCount: 4,
      fileTree: [],
      projectName: 'intellig',
      projectPath: '~/ws/intellig',
    };
    const panel = renderDetailsPanel(model);
    const h4 = panel.querySelector('.details-changed-files h4') as HTMLElement;
    assert.strictEqual(h4.textContent, 'intellig (4 files) ~/ws/intellig');
  });
});

describe('Details Panel — section height caps', () => {
  const css = buildInlineStyles();

  it('caps the changed-files list with max-height and hugs shorter content', () => {
    assert.match(css, /\.changed-files-list\s*\{[^}]*max-height:\s*250px/);
    // No fixed height and no resize handle — the list hugs its content up to the cap.
    assert.doesNotMatch(css, /\.changed-files-list\s*\{[^}]*[^-]height:\s*\d+px/);
    assert.doesNotMatch(css, /\.changed-files-list\s*\{[^}]*resize:/);
  });

  it('caps the commit-message box with max-height and hugs shorter content', () => {
    assert.match(css, /\.commit-full-message\s*\{[^}]*max-height:\s*225px/);
    assert.doesNotMatch(css, /\.commit-full-message\s*\{[^}]*[^-]height:\s*\d+px/);
    assert.doesNotMatch(css, /\.commit-full-message\s*\{[^}]*resize:/);
  });
});
